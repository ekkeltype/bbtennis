import { CpuBrain, type CpuPolicy, type CpuProfile } from './cpu';
import { Engine } from './engine';
import { forkSeed } from './rng';
import { nextDeadline } from './turn';
import type { GameEvent, Look, MatchConfig, PlayerId, PlayerInfo, PointReason } from './types';
import { clamp, lerp } from './util';

/**
 * A simulated typist: a CpuBrain with this profile, choice policy (default 'adaptive') and chase
 * reaction (ms; default: the CPU's own rule of spec §3.8).
 */
export interface SimTypist { profile: CpuProfile; policy?: CpuPolicy; chaseReactionMs?: number }

/**
 * One simulated point: in-play strikes (serve included, as the engine counts a rally), duration in
 * ms (every turn of the point, the lead-in banner that opens it included), how it ended and who won.
 */
export interface PointRecord { shots: number; ms: number; reason: PointReason; serverWon: boolean; winner: PlayerId }

/** Balance figures of a run of points (spec §6); rates are shares of all points. */
export interface SimSummary {
  medianShots: number;
  p90Shots: number;
  maxShots: number;
  aceRate: number;
  dfRate: number;
  serverWinRate: number;
  medianSecPerPoint: number;
}

/** Spec §6 human model: error rate and reaction interpolate linearly in WPM between these rows. */
const HUMAN = {
  slow: { wpm: 25, err: 0.07, reactionMs: 900 },
  fast: { wpm: 120, err: 0.015, reactionMs: 400 },
} as const;

/**
 * Aggression of the spec §6 human model, whose policy is "hardest option that fits" on every serve
 * and choice. CpuBrain takes the hardest fitting option with probability `aggression`, scaled by 0.4
 * on a second serve (the CPU's caution of spec §3.8, not part of the human model); 1 / 0.4 keeps
 * that probability at 1 on second serves too. tests/sim/sim.test.ts checks this against CpuBrain.
 */
const HUMAN_AGGRESSION = 2.5;

/** Reaction before a chase word's first key in the spec §6 human model (ms). */
export const HUMAN_CHASE_REACTION_MS = 250;

/** Guards against a turn or match that never ends (the engine should make both impossible). */
const MAX_CALLS_PER_TURN = 10_000;
const MAX_TURNS_PER_MATCH = 100_000;

const LOOK: Look = { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 };
const PLAYERS: [PlayerInfo, PlayerInfo] = [
  { name: 'Sim A', look: LOOK, kind: 'cpu', cpuLevel: null },
  { name: 'Sim B', look: LOOK, kind: 'cpu', cpuLevel: null },
];

/**
 * The spec §6 human model's CpuBrain profile at `wpm`: per-key error 7 % at 25 WPM → 1.5 % at
 * 120 WPM and reaction 900 → 400 ms, linear in WPM and held at the end rows outside that range;
 * aggression HUMAN_AGGRESSION, so the adaptive policy always takes the hardest option that fits,
 * second serves included. The full model adds the 250 ms chase reaction: use humanTypist.
 */
export function humanProfile(wpm: number): CpuProfile {
  if (!Number.isFinite(wpm) || wpm <= 0) throw new RangeError(`humanProfile: WPM must be finite and positive, got ${wpm}`);
  const { slow, fast } = HUMAN;
  const f = clamp((wpm - slow.wpm) / (fast.wpm - slow.wpm), 0, 1);
  return {
    wpm,
    err: lerp(slow.err, fast.err, f),
    reactionMs: lerp(slow.reactionMs, fast.reactionMs, f),
    aggression: HUMAN_AGGRESSION,
  };
}

/** The full spec §6 human model at `wpm`: humanProfile with the 250 ms chase reaction. */
export function humanTypist(wpm: number, policy: CpuPolicy = 'adaptive'): SimTypist {
  return { profile: humanProfile(wpm), chaseReactionMs: HUMAN_CHASE_REACTION_MS, policy };
}

/**
 * Plays matches back to back (match i seeded with forkSeed(seed, i)) until `points` points are
 * recorded; the last match is cut short once enough points are in.
 */
export function simulatePoints(a: {
  config: MatchConfig;
  typists: [SimTypist, SimTypist];
  seed: number;
  points: number;
}): PointRecord[] {
  if (!Number.isInteger(a.points) || a.points < 0) {
    throw new RangeError(`simulatePoints: points must be a non-negative integer, got ${a.points}`);
  }
  const out: PointRecord[] = [];
  for (let match = 0; out.length < a.points; match++) {
    for (const p of matchPoints(a.config, a.typists, forkSeed(a.seed, match))) {
      out.push(p);
      if (out.length === a.points) break;
    }
  }
  return out;
}

/** Plays one whole match with the match seed `seed` (engine and both brains). */
export function simulateMatch(a: {
  config: MatchConfig;
  typists: [SimTypist, SimTypist];
  seed: number;
}): { winner: PlayerId; points: PointRecord[] } {
  const points: PointRecord[] = [];
  const match = matchPoints(a.config, a.typists, a.seed);
  for (let r = match.next(); ; r = match.next()) {
    if (r.done === true) return { winner: r.value, points };
    points.push(r.value);
  }
}

/**
 * Median and nearest-rank 90th percentile of rally length, the longest rally, the shares of points
 * that were aces, double faults and won by the server, and the median point duration in seconds.
 */
export function summarize(points: readonly PointRecord[]): SimSummary {
  const n = points.length;
  if (n === 0) throw new RangeError('summarize: no points to summarize');
  const shots = points.map((p) => p.shots).sort(ascending);
  const ms = points.map((p) => p.ms).sort(ascending);
  const share = (pred: (p: PointRecord) => boolean): number => points.filter(pred).length / n;
  return {
    medianShots: median(shots),
    p90Shots: item(shots, Math.ceil((9 * n) / 10) - 1),
    maxShots: item(shots, n - 1),
    aceRate: share((p) => p.reason === 'ace'),
    dfRate: share((p) => p.reason === 'doubleFault'),
    serverWinRate: share((p) => p.serverWon),
    medianSecPerPoint: median(ms) / 1000,
  };
}

/**
 * Plays one match on virtual time with a CpuBrain per typist, yielding each point as it is scored
 * and returning the match winner.
 */
function* matchPoints(config: MatchConfig, typists: [SimTypist, SimTypist], seed: number): Generator<PointRecord, PlayerId, void> {
  const engine = new Engine({ config, players: PLAYERS, seed });
  const brains: [CpuBrain, CpuBrain] = [brainFor(0, typists[0], seed), brainFor(1, typists[1], seed)];
  let server: PlayerId | null = null;
  let ms = 0;
  for (let turns = 0; ; turns++) {
    const owner = engine.owner();
    if (owner === null) break;
    if (turns >= MAX_TURNS_PER_MATCH) throw new Error(`simulation: match not over after ${MAX_TURNS_PER_MATCH} turns`);
    // A point's first turn is its serve turn, owned by the server; the rally count only changes when a turn ends.
    server ??= owner;
    const shots = engine.state.rallyStrikes;
    for (const e of playTurn(engine, brains[owner], owner)) {
      if (e.type === 'turnEnd') {
        ms += e.endτ;
      } else if (e.type === 'point') {
        yield { shots, ms, reason: e.reason, serverWon: e.winner === server, winner: e.winner };
        server = null;
        ms = 0;
      }
    }
  }
  const winner = engine.state.winner;
  if (winner === null) throw new Error('simulation: the match ended without a winner');
  return winner;
}

function brainFor(player: PlayerId, t: SimTypist, seed: number): CpuBrain {
  return new CpuBrain(player, t.profile, seed, { policy: t.policy, chaseReactionMs: t.chaseReactionMs });
}

/**
 * Plays the current turn to its end, jumping straight to the owner's next planned key or the turn's
 * next deadline, whichever comes first (a key at a deadline's τ beats it, as in a live session).
 * Returns the events of the call that ended the turn.
 */
function playTurn(engine: Engine, brain: CpuBrain, owner: PlayerId): GameEvent[] {
  const id = engine.state.turn?.data.turnId;
  let events = engine.start(owner);
  for (let calls = 0; calls < MAX_CALLS_PER_TURN; calls++) {
    const t = engine.state.turn;
    if (t === null || t.data.turnId !== id) return events;
    const key = brain.plan(t)[0];
    const deadline = nextDeadline(t);
    if (key !== undefined && (deadline === null || key.τ <= deadline)) events = engine.input(owner, key.key, key.τ);
    else if (deadline !== null) events = engine.clock(owner, deadline);
    else throw new Error(`simulation: turn ${id} stalled with no planned key and no deadline`);
  }
  throw new Error(`simulation: turn ${id} did not end within ${MAX_CALLS_PER_TURN} calls`);
}

function ascending(a: number, b: number): number {
  return a - b;
}

/** Median of an ascending, non-empty list: the middle value, or the mean of the two middle values. */
function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? item(sorted, mid) : (item(sorted, mid - 1) + item(sorted, mid)) / 2;
}

function item(list: readonly number[], i: number): number {
  const v = list[i];
  if (v === undefined) throw new RangeError(`simulation: index ${i} outside a list of ${list.length}`);
  return v;
}
