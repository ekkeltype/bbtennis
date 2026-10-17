import { BELTS } from '../../core/belts';
import type { Look } from '../../core/types';
import { ArcadeCpu } from './cpu';
import { createMatch, step } from './match';
import { TICK_HZ } from './tuning';
import type { ArcadeConfig, ArcadeEvent, ArcadeState, PlayerId, PlayerInfo, PlayerInput, PointReason } from './types';

/** One finished point of a simulated match (spec §7 balance figures). */
export interface PointRecord {
  winner: PlayerId;
  reason: PointReason;
  /**
   * Hits of the point, as ArcadeState.point.hits at its end: the serve it was played on and every
   * rally hit (a double fault counts its second serve; one by time violation counts 0).
   */
  hits: number;
  /** Ticks from the set-up of the point's first serve to the point's end. */
  ticks: number;
  server: PlayerId;
  /** The serve the point was played (or double-faulted) on. */
  serveNo: 1 | 2;
}

/** A simulated match: its final state, every event, a record per point and (when recorded) both inputs per tick. */
export interface SimResult { state: ArcadeState; events: ArcadeEvent[]; points: PointRecord[]; inputs: [PlayerInput, PlayerInput][] }

/** One hour of match time. */
const DEFAULT_MAX_TICKS = 60 * 60 * TICK_HZ;

/** Any valid look will do for a simulated player. */
const SIM_LOOK: Look = { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 };

function simPlayer(level: number): PlayerInfo {
  return { name: `CPU ${BELTS[level]?.label ?? level}`, look: { ...SIM_LOOK }, kind: 'cpu', cpuLevel: level };
}

/** Builds point records from the events of one tick at a time (set-up → hits → point). */
class PointTracker {
  readonly points: PointRecord[] = [];
  private server: PlayerId = 0;
  private serveNo: 1 | 2 = 1;
  private start = 0;
  private hits = 0;

  add(e: ArcadeEvent): void {
    if (e.type === 'setup') {
      this.server = e.server;
      this.serveNo = e.serveNo;
      this.hits = 0;
      if (e.serveNo === 1) this.start = e.tick;
    } else if (e.type === 'hit') {
      this.hits += 1;
    } else if (e.type === 'point') {
      this.points.push({ winner: e.winner, reason: e.reason, hits: this.hits, ticks: e.tick - this.start, server: this.server, serveNo: this.serveNo });
    }
  }
}

/**
 * Plays CPU vs CPU (belt levels 0..14; `new ArcadeCpu(p, level, seed)` with the match seed) until
 * the match is decided (status 'over', on the tick of its match event) or `maxTicks` ticks have
 * been stepped (default one hour, 60·60·60). `record` keeps both inputs of every tick for `replay`.
 */
export function simulateMatch(
  config: ArcadeConfig,
  levels: [number, number],
  seed: number,
  opts: { maxTicks?: number; record?: boolean } = {},
): SimResult {
  const maxTicks = opts.maxTicks ?? DEFAULT_MAX_TICKS;
  const record = opts.record ?? false;
  const cpus = [new ArcadeCpu(0, levels[0], seed), new ArcadeCpu(1, levels[1], seed)] as const;
  const state = createMatch(config, [simPlayer(levels[0]), simPlayer(levels[1])], seed);
  const events: ArcadeEvent[] = [];
  const inputs: [PlayerInput, PlayerInput][] = [];
  const tracker = new PointTracker();
  for (let n = 0; n < maxTicks && state.status !== 'over'; n++) {
    const inp: [PlayerInput, PlayerInput] = [cpus[0].input(state), cpus[1].input(state)];
    if (record) inputs.push(inp);
    for (const e of step(state, inp)) {
      events.push(e);
      tracker.add(e);
    }
  }
  return { state, events, points: tracker.points, inputs };
}

/** Replays recorded inputs (one pair per tick) on a new match from the same seed: the same events and final state. */
export function replay(
  config: ArcadeConfig,
  players: [PlayerInfo, PlayerInfo],
  seed: number,
  inputs: readonly [PlayerInput, PlayerInput][],
): { state: ArcadeState; events: ArcadeEvent[] } {
  const state = createMatch(config, players, seed);
  const events: ArcadeEvent[] = [];
  for (const inp of inputs) events.push(...step(state, inp));
  return { state, events };
}
