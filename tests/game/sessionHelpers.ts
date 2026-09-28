import type { CpuBrain } from '../../src/core/cpu';
import { Engine } from '../../src/core/engine';
import type { KeyClass } from '../../src/core/typing';
import type { MatchConfig, PlayerId, PlayerInfo, PromptState, TurnState, ViewModel } from '../../src/core/types';
import type { VirtualScheduler } from '../../src/game/clock';
import type { LocalSession } from '../../src/game/localSession';

const LOOK = { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 };

/** A human (player 0) against a White-belt CPU (player 1). */
export const PLAYERS: [PlayerInfo, PlayerInfo] = [
  { name: 'Ann', look: LOOK, kind: 'human', cpuLevel: null },
  { name: 'Cpu', look: LOOK, kind: 'cpu', cpuLevel: 0 },
];

/** Two CPUs, for attract-mode sessions. */
export const CPUS: [PlayerInfo, PlayerInfo] = [
  { name: 'Ann', look: LOOK, kind: 'cpu', cpuLevel: 6 },
  { name: 'Cpu', look: LOOK, kind: 'cpu', cpuLevel: 9 },
];

/** A Normal-pace single tiebreak. */
export const TIEBREAK: MatchConfig = {
  format: 'tiebreak',
  pace: 'normal',
  surface: 'hard',
  wordPack: 'everyday',
  deuceRule: 'advantage',
  training: null,
};

/** Milliseconds between test frames. */
export const FRAME = 16;

/** The KeyClass a planned input stands for. */
export function keyOf(key: string): KeyClass {
  return key === 'toss' ? { kind: 'toss' } : { kind: 'letter', letter: key, viaCode: false };
}

/** The first seed from 1 on whose coin toss makes `server` serve first. */
export function seedWhere(server: PlayerId, config: MatchConfig = TIEBREAK, players: [PlayerInfo, PlayerInfo] = PLAYERS): number {
  for (let seed = 1; ; seed++) {
    if (new Engine({ config, players, seed }).state.score.firstServerOfMatch === server) return seed;
  }
}

/** The active prompt of a turn, if any. */
export function activePrompt(t: TurnState | null): PromptState | null {
  return t === null || t.active === null ? null : t.prompts[t.active] ?? null;
}

/** Local time at which the current turn started, as the view model implies. */
export function turnStart(s: VirtualScheduler, vm: ViewModel): number {
  return s.now() - vm.turnτ;
}

/**
 * Drives a session frame by frame; when the human (`me`) owns the current turn, `typist` plans its
 * keys, which are pressed through `session.key` at their planned local time (or the current time if
 * that has passed). `onFrame` sees every view model. Stops when `stop` says so, the match is over, or at `limitMs`.
 */
export function drive(
  s: VirtualScheduler,
  session: LocalSession,
  opts: {
    me: PlayerId;
    typist: CpuBrain | null;
    limitMs: number;
    onFrame?: (vm: ViewModel) => void;
    stop?: (vm: ViewModel) => boolean;
    /** Time between frames (default FRAME); keys are still pressed at their own times. */
    frameMs?: number;
    /** Also type the typist's early chase keys (its `planEarly`), on the displayed striker turn's clock (early-typing spec §2). */
    early?: boolean;
  },
): ViewModel {
  const step = opts.frameMs ?? FRAME;
  const end = s.now() + opts.limitMs;
  let vm = session.frame(step);
  opts.onFrame?.(vm);
  while (!session.over && !(opts.stop?.(vm) ?? false) && s.now() < end) {
    const turn = vm.pub.turn;
    let pressed = false;
    const e = vm.early;
    if (opts.early === true && opts.typist !== null && turn !== null && e !== null && e.player === opts.me) {
      const next = opts.typist.planEarly(turn)[e.prompt.correctKeys + e.prompt.wrongKeys];
      const at = next === undefined ? null : turnStart(s, vm) + next.τ;
      if (next !== undefined && at !== null && at <= s.now() + step) {
        if (at > s.now()) s.advance(at - s.now());
        session.key(keyOf(next.key), s.now());
        pressed = true;
      }
    }
    if (!pressed && opts.typist !== null && turn !== null && turn.data.owner === opts.me) {
      const next = opts.typist.plan(turn)[0];
      const at = next === undefined ? null : turnStart(s, vm) + next.τ;
      if (next !== undefined && at !== null && at <= s.now() + step) {
        if (at > s.now()) s.advance(at - s.now());
        session.key(keyOf(next.key), s.now());
        pressed = true;
      }
    }
    if (!pressed) s.advance(step);
    vm = session.frame(step);
    opts.onFrame?.(vm);
  }
  return vm;
}
