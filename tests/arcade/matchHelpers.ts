/** Test helpers for the Arcade match stepper (not production code). */
import { createMatch, step } from '../../src/arcade/core/match';
import { NO_INPUT } from '../../src/arcade/core/types';
import type { ArcadeConfig, ArcadeEvent, ArcadeState, PlayerId, PlayerInfo, PlayerInput, ShotKey } from '../../src/arcade/core/types';
import { currentServer } from '../../src/core/scoring';

type Axis = -1 | 0 | 1;

/** Short set, advantage, Normal pace. */
export const CONFIG: ArcadeConfig = { format: 'short', deuceRule: 'advantage', surface: 'hard', pace: 'normal' };

const LOOK = { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 };

/** Two players: a human and a CPU (the stepper does not care who controls them). */
export const PLAYERS: [PlayerInfo, PlayerInfo] = [
  { name: 'ANA', look: LOOK, kind: 'human', cpuLevel: null },
  { name: 'BEN', look: LOOK, kind: 'cpu', cpuLevel: 3 },
];

/** Both players' inputs for one tick. */
export type Inputs = [PlayerInput, PlayerInput];
/** Inputs for the next tick, from the state before it. */
export type InputsFn = (s: Readonly<ArcadeState>) => Inputs;

/** Input with the given shot key(s) held, plus an optional direction. */
export function press(key: ShotKey | readonly ShotKey[], dir: { mx?: Axis; my?: Axis } = {}): PlayerInput {
  const keys: readonly ShotKey[] = typeof key === 'string' ? [key] : key;
  return {
    ...NO_INPUT,
    mx: dir.mx ?? 0,
    my: dir.my ?? 0,
    topspin: keys.includes('topspin'),
    slice: keys.includes('slice'),
    lob: keys.includes('lob'),
  };
}

/** Input with only a direction held. */
export function hold(dir: { mx?: Axis; my?: Axis }): PlayerInput {
  return { ...NO_INPUT, mx: dir.mx ?? 0, my: dir.my ?? 0 };
}

/** Inputs where `player` gives `input` and the other player `rest`. */
export function forPlayer(player: PlayerId, input: PlayerInput, rest: PlayerInput = NO_INPUT): Inputs {
  return player === 0 ? [input, rest] : [rest, input];
}

/** Nobody touches anything. */
export const IDLE: InputsFn = () => [NO_INPUT, NO_INPUT];

/** Predicate: this tick produced an event of `type`. */
export function untilType(type: ArcadeEvent['type']): (s: Readonly<ArcadeState>, ev: readonly ArcadeEvent[]) => boolean {
  return (_s, ev) => ev.some((e) => e.type === type);
}

/** The events of one type, narrowed. */
export function ofType<K extends ArcadeEvent['type']>(events: readonly ArcadeEvent[], type: K): Extract<ArcadeEvent, { type: K }>[] {
  return events.filter((e): e is Extract<ArcadeEvent, { type: K }> => e.type === type);
}

/** Steps `n` ticks; returns their events in order. */
export function runTicks(s: ArcadeState, n: number, inputsFn: InputsFn = IDLE): ArcadeEvent[] {
  const out: ArcadeEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...step(s, inputsFn(s)));
  return out;
}

/**
 * Steps until `pred(s, eventsOfThatTick)` is true (checked after each tick); returns all events.
 * Throws when it has not happened within `maxTicks`.
 */
export function runUntil(
  s: ArcadeState,
  pred: (s: Readonly<ArcadeState>, ev: readonly ArcadeEvent[]) => boolean,
  inputsFn: InputsFn = IDLE,
  maxTicks = 20000,
): ArcadeEvent[] {
  const out: ArcadeEvent[] = [];
  for (let i = 0; i < maxTicks; i++) {
    const ev = step(s, inputsFn(s));
    out.push(...ev);
    if (pred(s, ev)) return out;
  }
  throw new Error(`runUntil: condition not met within ${maxTicks} ticks (tick ${s.tick}, phase ${s.phase.kind})`);
}

/** A new match stepped through its intro: the state at its first set-up tick, and the events so far. */
export function matchInSetup(seed: number, config: ArcadeConfig = CONFIG): { s: ArcadeState; events: ArcadeEvent[] } {
  const s = createMatch(config, PLAYERS, seed);
  const events = runUntil(s, (st) => st.phase.kind === 'setup', IDLE, 1000);
  return { s, events };
}

/** The phase kind, read without type narrowing (step mutates it). */
function phaseOf(s: Readonly<ArcadeState>): ArcadeState['phase']['kind'] {
  return s.phase.kind;
}

/** Options of a scripted serve. */
export interface ServeScript {
  /** Key of the second press (the hit): topspin = flat, slice = slice, lob = kick. */
  key: ShotKey | readonly ShotKey[];
  /** Direction held on the hit tick (serve aim). */
  aimMx?: Axis;
  /** Ticks from the toss press to the hit press. */
  hitDelayTicks: number;
  /** Key of the toss press (default: the hit key). */
  tossKey?: ShotKey | readonly ShotKey[];
  /** The receiver's input each tick (default: idle). */
  receiver?: (s: Readonly<ArcadeState>) => PlayerInput;
}

/**
 * Drives the server from set-up: taps the toss key (one tick down, then up), then taps the hit key
 * `hitDelayTicks` after the toss with `aimMx` held. Stops after the hit tick, or as soon as the
 * phase leaves 'toss' early (drop, time violation). Returns the events.
 */
export function scriptedServe(s: ArcadeState, o: ServeScript): ArcadeEvent[] {
  if (phaseOf(s) !== 'setup') throw new Error(`scriptedServe: phase is ${phaseOf(s)}, not setup`);
  const tossKey = o.tossKey ?? o.key;
  if (o.hitDelayTicks < 1) throw new Error('scriptedServe: hitDelayTicks must be ≥ 1');
  if (o.hitDelayTicks === 1 && JSON.stringify(tossKey) === JSON.stringify(o.key)) {
    throw new Error('scriptedServe: the same key cannot be pressed on two consecutive ticks');
  }
  const server = currentServer(s.score);
  const receiverInput = o.receiver ?? (() => NO_INPUT);
  const out: ArcadeEvent[] = [];
  out.push(...step(s, forPlayer(server, press(tossKey), receiverInput(s))));
  if (phaseOf(s) !== 'toss') return out;
  for (let i = 1; i < o.hitDelayTicks; i++) {
    out.push(...step(s, forPlayer(server, NO_INPUT, receiverInput(s))));
    if (phaseOf(s) !== 'toss') return out;
  }
  out.push(...step(s, forPlayer(server, press(o.key, { mx: o.aimMx ?? 0 }), receiverInput(s))));
  return out;
}

/** Perfect kick serve to the body (robustly in), receiver idle, played out to the point. Returns the events. */
export function serveAce(s: ArcadeState): ArcadeEvent[] {
  const out = scriptedServe(s, { key: 'lob', tossKey: 'topspin', hitDelayTicks: 42 });
  out.push(...runUntil(s, untilType('point')));
  return out;
}
