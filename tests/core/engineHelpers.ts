import { CpuBrain, type CpuBrainOptions, type CpuProfile, type PlannedKey } from '../../src/core/cpu';
import { endSign } from '../../src/core/court';
import type { Engine } from '../../src/core/engine';
import { nextDeadline } from '../../src/core/turn';
import type {
  GameEvent,
  MatchConfig,
  MatchState,
  PlayerId,
  PlayerInfo,
  PromptState,
  ShotRandoms,
  TurnState,
} from '../../src/core/types';

/** A normal short-set match on the Everyday pack. */
export const CONFIG: MatchConfig = {
  format: 'short',
  pace: 'normal',
  surface: 'hard',
  wordPack: 'everyday',
  deuceRule: 'advantage',
  training: null,
};

const LOOK = { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 };

/** Upper-case names, so they can never be mistaken for a (lower-case) word in a JSON search. */
export const PLAYERS: [PlayerInfo, PlayerInfo] = [
  { name: 'Alex', look: LOOK, kind: 'cpu', cpuLevel: 0 },
  { name: 'Bo', look: LOOK, kind: 'cpu', cpuLevel: 0 },
];

/** CONFIG with some options changed. */
export const config = (over: Partial<MatchConfig> = {}): MatchConfig => ({ ...CONFIG, ...over });

/** The inputs a typist wants to make in the current turn, in τ order (only the first is used). */
export type Typist = (t: TurnState) => PlannedKey[];

/** A typist who never presses anything. */
export const idle: Typist = () => [];

/** A CpuBrain as a typist. */
export function cpuTypist(player: PlayerId, profile: CpuProfile, seed: number, opts?: CpuBrainOptions): Typist {
  const brain = new CpuBrain(player, profile, seed, opts);
  return (t) => brain.plan(t);
}

/** Wraps a typist so that it lets the first toss of every `every`-th turn drop (forcing a catch and a re-toss). */
export function withRetosses(typist: Typist, every: number): Typist {
  return (t) => {
    const firstToss = t.phase === 'toss' && t.prompts.length === 1;
    if (firstToss && t.data.turnId % every === 0) return [];
    return typist(t);
  };
}

/** A deterministic scripted typist (see `scripted`). */
export interface Script {
  /** Press Space in PRE_SERVE (as soon as it begins). */
  toss: boolean;
  /** Serve option to type (0 easy, 1 medium, 2 hard), or null to type nothing after the toss. */
  serve: number | null;
  /** Letters of the shot word (serve or choice) to type before stopping; default all. */
  letters: number;
  /** Type the chase word. */
  chase: boolean;
  /** Choice option to type, or null to type nothing. */
  choice: number | null;
  /** Wrong keys to press on the shot word, one before each correct key after its lock. */
  slips: number;
  /** Interval between keys (ms); the first key comes `keyMs` after the prompt is shown. */
  keyMs: number;
}

const SCRIPT: Script = { toss: true, serve: 0, letters: 99, chase: true, choice: 0, slips: 0, keyMs: 150 };

/** A typist that follows a fixed script, one key at a time, `keyMs` apart. */
export function scripted(over: Partial<Script> = {}): Typist {
  const s = { ...SCRIPT, ...over };
  return (t) => {
    if (t.phase === 'preServe') return s.toss ? [{ key: 'toss', τ: t.τ }] : [];
    const p = t.active === null ? undefined : t.prompts[t.active];
    if (p === undefined || p.completedAt !== null) return [];
    const option = p.kind === 'serve' ? s.serve : p.kind === 'choice' ? s.choice : s.chase ? 0 : null;
    const word = option === null ? undefined : p.options[option]?.word;
    if (word === undefined) return [];
    const shot = p.kind !== 'chase';
    if (shot && p.typed >= s.letters) return [];
    const τ = Math.max(t.τ, lastKeyτ(p) + s.keyMs);
    const expected = word.charAt(p.typed);
    const slip = shot && p.locked !== null && p.wrongKeys < s.slips && p.wrongKeys < p.typed;
    return [{ key: slip ? (expected === 'z' ? 'y' : 'z') : expected, τ }];
  };
}

function lastKeyτ(p: PromptState): number {
  return Math.max(p.shownAt, p.tLast ?? -Infinity, p.lastWrongAt ?? -Infinity);
}

/** One recorded engine call, for replays. */
export type EngineCall =
  | { op: 'start'; player: PlayerId }
  | { op: 'input'; player: PlayerId; key: string; τ: number }
  | { op: 'clock'; player: PlayerId; τ: number };

/** Applies one recorded call. */
export function apply(engine: Engine, c: EngineCall): GameEvent[] {
  if (c.op === 'start') return engine.start(c.player);
  if (c.op === 'input') return engine.input(c.player, c.key, c.τ);
  return engine.clock(c.player, c.τ);
}

/** How a turn drive ended. */
export type TurnEnd = 'ended' | 'stalled' | 'over';

/** Options for driving turns. */
export interface DriveOptions {
  /** Confirm the clock every `stepMs` instead of jumping from input to deadline. */
  stepMs?: number;
  /** Which turns to step through with `stepMs` (default all). */
  stepIf?: (t: TurnState) => boolean;
  /** Called after every engine call. */
  onCall?: (engine: Engine, call: EngineCall, events: GameEvent[]) => void;
  /** Called after each fixed clock step (with `stepMs`). */
  onStep?: (engine: Engine, τ: number) => void;
}

const MAX_CALLS_PER_TURN = 50000;

/**
 * Drives an Engine with scripted typists on virtual time. Each turn starts at its owner's τ 0; planned
 * inputs with τ ≤ the next deadline are fed before that deadline is confirmed (as a session would).
 */
export class Driver {
  readonly events: GameEvent[] = [];
  readonly calls: EngineCall[] = [];
  turns = 0;

  constructor(
    readonly engine: Engine,
    readonly typists: [Typist, Typist],
    readonly opts: DriveOptions = {},
  ) {}

  /** Plays the current turn from its start until it ends, the match is over, or nobody can act. */
  playTurn(): TurnEnd {
    const owner = this.engine.owner();
    const first = this.engine.state.turn;
    if (owner === null || first === null) return 'over';
    const id = first.data.turnId;
    const live = (): TurnState | null => {
      const t = this.engine.state.turn;
      return t !== null && t.data.turnId === id ? t : null;
    };
    this.turns++;
    const { stepMs, stepIf } = this.opts;
    const step = stepMs !== undefined && (stepIf === undefined || stepIf(first)) ? stepMs : null;
    this.call({ op: 'start', player: owner });
    const typist = this.typists[owner];
    for (let n = 0; n < MAX_CALLS_PER_TURN; n++) {
      const t = live();
      if (t === null) return 'ended';
      const key = typist(t)[0];
      const deadline = nextDeadline(t);
      if (key === undefined && deadline === null) return 'stalled';
      if (step !== null) {
        const τ = Math.floor(t.τ / step) * step + step;
        if (key !== undefined && key.τ <= τ) {
          this.call({ op: 'input', player: owner, key: key.key, τ: key.τ });
        } else {
          this.call({ op: 'clock', player: owner, τ });
          this.opts.onStep?.(this.engine, τ);
        }
        continue;
      }
      if (key !== undefined && (deadline === null || key.τ <= deadline)) {
        this.call({ op: 'input', player: owner, key: key.key, τ: key.τ });
      } else if (deadline !== null) {
        this.call({ op: 'clock', player: owner, τ: deadline });
      }
    }
    throw new Error(`Driver: turn ${id} did not end within ${MAX_CALLS_PER_TURN} calls`);
  }

  /** Plays turns until the match is over; throws if a turn stalls or the match runs too long. */
  playMatch(maxTurns = 20000): void {
    while (this.engine.state.status === 'playing') {
      if (this.turns >= maxTurns) throw new Error(`Driver: match not over after ${maxTurns} turns`);
      const end = this.playTurn();
      if (end === 'stalled') throw new Error('Driver: a turn stalled');
    }
  }

  /** Plays turns until `stop` holds (checked before each turn) or the match is over. */
  playUntil(stop: (s: MatchState) => boolean, maxTurns = 20000): void {
    for (let i = 0; i < maxTurns && this.engine.state.status === 'playing' && !stop(this.engine.state); i++) {
      if (this.playTurn() === 'stalled') throw new Error('Driver: a turn stalled');
    }
  }

  private call(c: EngineCall): GameEvent[] {
    const events = apply(this.engine, c);
    this.calls.push(c);
    this.events.push(...events);
    this.opts.onCall?.(this.engine, c, events);
    return events;
  }
}

/** Nine fixed uniforms: rNet, then 4 for zx, then 4 for zy. */
export function randoms(rNet: number, ux: number, uy: number): ShotRandoms {
  return [rNet, ux, ux, ux, ux, uy, uy, uy, uy];
}

/**
 * Randoms that send a hard rally shot with ≥ 1 slip long (zy = ±2√3 away from the net on `dest`'s
 * half) and never into the net (rNet ≥ pNet).
 */
export function longRandoms(dest: PlayerId): ShotRandoms {
  return randoms(0.999, 0.5, endSign(dest) === 1 ? 0 : 0.99999);
}

/** Every word that appears in a serve turn's word sets. */
export function serveWords(t: TurnState): string[] {
  return t.data.kind === 'serve' ? t.data.wordSets.flatMap((s) => s.options.map((o) => o.word)) : [];
}

/**
 * Throws unless `v` is plain JSON data: finite numbers, strings, booleans, null, arrays and plain
 * objects with no undefined values.
 */
export function assertJsonSafe(v: unknown, path = '$'): void {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${path} is not finite: ${v}`);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertJsonSafe(x, `${path}[${i}]`));
    return;
  }
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) throw new Error(`${path}.${k} is undefined`);
      assertJsonSafe(x, `${path}.${k}`);
    }
    return;
  }
  throw new Error(`${path} is not JSON data: ${String(v)}`);
}
