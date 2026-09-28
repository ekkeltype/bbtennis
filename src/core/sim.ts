import { aggressionAt, CpuBrain, typistProfile, type CpuPolicy, type CpuProfile } from './cpu';
import { Engine } from './engine';
import { forkSeed } from './rng';
import { nextDeadline } from './turn';
import type { GameEvent, Look, MatchConfig, PlayerId, PlayerInfo, PointReason } from './types';
import { TIERS } from './types';

/** A simulated typist: a CpuBrain with this profile and choice policy (default 'adaptive'). */
export interface SimTypist { profile: CpuProfile; policy?: CpuPolicy }

/**
 * One simulated point: in-play strikes (serve included, as the engine counts a rally), duration in
 * ms (every turn of the point, the lead-in banner that opens it included), how it ended and who won.
 */
export interface PointRecord {
  shots: number;
  ms: number;
  reason: PointReason;
  serverWon: boolean;
  winner: PlayerId;
  /** Clean insane strikes (no slip, landing in) in the point. */
  insaneClean: number;
  /** How many of those the receiver struck back in. */
  insaneReturned: number;
  /** Whether any serve or choice prompt of the point offered the insane word. */
  insaneOffered: boolean;
}

/** Balance figures of a run of points (spec §6); rates are shares of all points. insaneReturnRate = returned / clean (0 with none); fullMeterRate = share of points offering insane. */
export interface SimSummary {
  medianShots: number;
  p90Shots: number;
  maxShots: number;
  aceRate: number;
  dfRate: number;
  serverWinRate: number;
  medianSecPerPoint: number;
  insaneShotsClean: number;
  insaneReturnRate: number;
  fullMeterRate: number;
}

/** Guards against a turn or match that never ends (the engine should make both impossible). */
const MAX_CALLS_PER_TURN = 10_000;
const MAX_TURNS_PER_MATCH = 100_000;

const LOOK: Look = { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 };
const PLAYERS: [PlayerInfo, PlayerInfo] = [
  { name: 'Sim A', look: LOOK, kind: 'cpu', cpuLevel: null },
  { name: 'Sim B', look: LOOK, kind: 'cpu', cpuLevel: null },
];

/**
 * A balance-simulation player at `wpm` (early-typing spec §4, §5): the typist model's pauses and errors
 * at that speed, the calibrated nominal speed, and the aggression the belt ladder gives that speed.
 */
export function simTypist(wpm: number, policy: CpuPolicy = 'adaptive'): SimTypist {
  return { profile: typistProfile(wpm, aggressionAt(wpm)), policy };
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
  const clean = points.reduce((sum, p) => sum + p.insaneClean, 0);
  const returned = points.reduce((sum, p) => sum + p.insaneReturned, 0);
  return {
    medianShots: median(shots),
    p90Shots: item(shots, Math.ceil((9 * n) / 10) - 1),
    maxShots: item(shots, n - 1),
    aceRate: share((p) => p.reason === 'ace'),
    dfRate: share((p) => p.reason === 'doubleFault'),
    serverWinRate: share((p) => p.serverWon),
    medianSecPerPoint: median(ms) / 1000,
    insaneShotsClean: clean,
    insaneReturnRate: clean === 0 ? 0 : returned / clean,
    fullMeterRate: share((p) => p.insaneOffered),
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
  let insane = { clean: 0, returned: 0, offered: false, pending: false };
  for (let turns = 0; ; turns++) {
    const owner = engine.owner();
    if (owner === null) break;
    if (turns >= MAX_TURNS_PER_MATCH) throw new Error(`simulation: match not over after ${MAX_TURNS_PER_MATCH} turns`);
    // A point's first turn is its serve turn, owned by the server; the rally count only changes when a turn ends.
    server ??= owner;
    const shots = engine.state.rallyStrikes;
    const events = playTurn(engine, brains[owner], owner);
    const ended = engine.state.lastTurn;
    if (ended !== null) {
      insane.offered ||= ended.prompts.some((p) => p.options.length > TIERS.length);
      const o = ended.outcome;
      if (insane.pending) {
        if (o?.kind === 'strike' && o.strike.shot.outcome === 'in') insane.returned++;
        insane.pending = false;
      }
      if (o?.kind === 'strike' && o.strike.word.tier === 'insane' && o.strike.slips === 0 && o.strike.shot.outcome === 'in') {
        insane.clean++;
        insane.pending = true;
      }
    }
    for (const e of events) {
      if (e.type === 'turnEnd') {
        ms += e.endτ;
      } else if (e.type === 'point') {
        yield { shots, ms, reason: e.reason, serverWon: e.winner === server, winner: e.winner,
          insaneClean: insane.clean, insaneReturned: insane.returned, insaneOffered: insane.offered };
        server = null;
        ms = 0;
        insane = { clean: 0, returned: 0, offered: false, pending: false };
      }
    }
  }
  const winner = engine.state.winner;
  if (winner === null) throw new Error('simulation: the match ended without a winner');
  return winner;
}

function brainFor(player: PlayerId, t: SimTypist, seed: number): CpuBrain {
  return new CpuBrain(player, t.profile, seed, { policy: t.policy });
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
