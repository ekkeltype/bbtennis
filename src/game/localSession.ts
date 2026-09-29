import { CpuBrain, cpuProfile } from '../core/cpu';
import { EarlyChase, withoutEarlyEvents } from '../core/early';
import { Engine } from '../core/engine';
import { redact, redactEvents } from '../core/redact';
import { TUNING } from '../core/tuning';
import type { KeyClass } from '../core/typing';
import { other, type EarlyKey, type GameEvent, type MatchConfig, type MatchState, type PlayerId, type PlayerInfo, type TurnState, type ViewModel } from '../core/types';
import { jsonCopy } from '../core/util';
import type { Scheduler } from './clock';
import { WaitTag } from './onlineLink';
import type { Session } from './session';
import type { TrainingScript } from './training';

export { TRAINING } from './training';
export type { Lesson, TrainingScript } from './training';

/** Most game time one frame may catch up (spec §5.2); a later frame costs the excess as a micro-pause. */
const MAX_CATCH_UP_MS = 250;
/** The resume countdown: 3-2-1 over 1.5 s (spec §4.6). */
const COUNTDOWN_MS = 1500;
const COUNTDOWN_STEPS = 3;
/** Guard against a turn chain that never catches up in one step (turns last far longer than a frame). */
const MAX_TURNS_PER_STEP = 16;

/** How to set up a LocalSession: vs CPU (one human), training (with a script) or attract (no human). */
export interface LocalSessionOptions {
  config: MatchConfig;
  /** Every player but `human` is played by a CpuBrain at its `cpuLevel` (White belt when null). */
  players: [PlayerInfo, PlayerInfo];
  seed: number;
  /** The player typing on this keyboard, or null for attract mode (CPU vs CPU, seen as a spectator). */
  human: PlayerId | null;
  scheduler: Scheduler;
  /** Training lessons: their coach text shows in the HUD and they advance as each is done. */
  training?: TrainingScript | null;
  /** A player's first matches: the SPACE keycap in PRE_SERVE and the first-letter hint (spec §3.12). */
  hints?: boolean;
}

/**
 * A match on this machine (spec §5.2): vs CPU, training or attract. The engine runs every turn on the
 * local clock: a turn's τ is `now − turnStartLocal`, and the next turn starts at the previous one's
 * start + its endτ. Every frame feeds the CPUs' planned keys whose τ has come and confirms the owner's
 * clock. Human keys go to the engine at once at `timeStamp − turnStartLocal`. While the striker's
 * return turn runs after its choice lock, the receiver's letters (a human's keys, a CPU's planned early
 * keys) type the chase early, and the next turn starts with them (early-typing spec §2). Pausing freezes
 * game time (and hides prompts); resuming runs a 1.5 s 3-2-1 countdown, then time goes on where it stopped.
 */
export class LocalSession implements Session {
  private readonly engine: Engine;
  private readonly scheduler: Scheduler;
  private readonly human: PlayerId | null;
  private readonly viewer: PlayerId | 'spectator';
  private readonly brains: readonly [CpuBrain | null, CpuBrain | null];
  private readonly script: TrainingScript | null;
  private readonly hints: boolean;
  /** Local time at which the current turn's τ was 0; once the match is over, when it ended. */
  private turnStartLocal: number;
  /** Local time game time has reached: frames and keys move it on, a pause holds it. */
  private gameTime: number;
  private paused = false;
  /** Local time the resume countdown began, while it runs. */
  private countdownFrom: number | null = null;
  /** Events not yet handed to a view. */
  private pending: GameEvent[] = [];
  private readonly wait = new WaitTag();
  /** The receiver's early chase while the striker's return turn runs (early-typing spec §2), or null. */
  private early: EarlyChase | null = null;
  /** How many of a CPU receiver's planned early keys have been pressed into `early`. */
  private earlyFed = 0;
  /** The human's first choice prompt of the current point (for the first-letter hint). */
  private firstChoice: { point: number; prompt: number } | null = null;
  private lessonIndex = 0;
  private lastView: ViewModel | null = null;
  private final: MatchState | null = null;
  private disposed = false;

  constructor(opts: LocalSessionOptions) {
    this.engine = new Engine({ config: opts.config, players: opts.players, seed: opts.seed });
    this.scheduler = opts.scheduler;
    this.human = opts.human;
    this.viewer = opts.human ?? 'spectator';
    const brain = (p: PlayerId): CpuBrain | null =>
      p === opts.human ? null : new CpuBrain(p, cpuProfile(opts.players[p].cpuLevel ?? 0), opts.seed);
    this.brains = [brain(0), brain(1)];
    this.script = opts.training ?? null;
    this.hints = opts.hints === true;
    const now = this.scheduler.now();
    this.turnStartLocal = now;
    this.gameTime = now;
    const owner = this.engine.owner();
    if (owner !== null) this.absorb(this.engine.start(owner));
  }

  /** True once the match is over and its MATCH_OVER celebration (3 s of game time) has played. */
  get over(): boolean {
    return this.engine.state.status === 'over' && this.gameTime - this.turnStartLocal >= TUNING.leadIn.matchOverMs;
  }

  /** The final state (as the viewer sees it) once `over`, else null. */
  get result(): MatchState | null {
    if (!this.over) return null;
    this.final ??= redact(this.engine.state, this.viewer);
    return this.final;
  }

  /** The latest frame's view model, or null before the first frame. */
  get view(): ViewModel | null {
    return this.lastView;
  }

  /** Training: index of the current lesson (the lesson count once all are done); null without a script. */
  get lesson(): number | null {
    return this.script === null ? null : this.lessonIndex;
  }

  /** True once every training lesson is done. */
  get trainingDone(): boolean {
    return this.script !== null && this.lessonIndex >= this.script.lessons.length;
  }

  frame(_dtMs: number): ViewModel {
    const now = this.scheduler.now();
    if (!this.disposed) {
      this.endCountdown(now);
      if (!this.paused) {
        this.advanceTo(now);
        this.run(true);
      }
    }
    return this.buildView(now);
  }

  /**
   * A human key: game time first catches up to the key (so a turn that ended just before it has
   * handed over), then a letter goes to the engine if the human owns the turn, else it is dropped
   * with a WAIT tag; Space goes to the human's serve turn as a toss. Keys during a pause or its
   * countdown, and keys stamped before the current turn began, are dropped; a future or non-finite
   * timeStamp counts as now.
   */
  key(k: KeyClass, timeStamp: number): void {
    const human = this.human;
    if (human === null || this.disposed || k.kind === 'ignore') return;
    const now = this.scheduler.now();
    this.endCountdown(now);
    if (this.paused) return;
    const t = Number.isFinite(timeStamp) ? Math.min(timeStamp, now) : now;
    this.advanceTo(t);
    this.run(false);
    this.apply(human, k, t, now);
    this.run(true);
  }

  pause(): void {
    if (this.disposed || this.over) return;
    const now = this.scheduler.now();
    this.endCountdown(now);
    if (!this.paused) {
      this.advanceTo(now);
      this.run(true);
    }
    this.paused = true;
    this.countdownFrom = null;
  }

  resume(): void {
    if (this.disposed || !this.paused || this.countdownFrom !== null) return;
    this.countdownFrom = this.scheduler.now();
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Ends a finished resume countdown: game time goes on from where the pause froze it. */
  private endCountdown(now: number): void {
    if (this.countdownFrom === null) return;
    const end = this.countdownFrom + COUNTDOWN_MS;
    if (now < end) return;
    this.turnStartLocal += end - this.gameTime;
    this.gameTime = end;
    this.countdownFrom = null;
    this.paused = false;
  }

  /** A human key at local time `t` (game time has reached it): to the engine, or dropped. */
  private apply(human: PlayerId, k: KeyClass, t: number, now: number): void {
    if (t < this.turnStartLocal) return;
    const owner = this.engine.owner();
    const τ = t - this.turnStartLocal;
    if (k.kind === 'letter') {
      if (owner === human) this.absorb(this.engine.input(human, k.letter, τ));
      else if (this.early?.player === human) this.pending.push(...this.early.press(k.letter, τ));
      else if (owner !== null) this.wait.show(now);
    } else if (k.kind === 'toss' && owner === human && this.engine.state.turn?.data.kind === 'serve') {
      this.absorb(this.engine.input(human, 'toss', τ));
    }
  }

  /** Moves game time on to local time `t` (never back), catching up at most MAX_CATCH_UP_MS. */
  private advanceTo(t: number): void {
    if (t <= this.gameTime) return;
    const late = t - this.gameTime - MAX_CATCH_UP_MS;
    if (late > 0) this.turnStartLocal += late;
    this.gameTime = t;
  }

  /**
   * Runs the match up to game time: the CPUs' planned keys, the owner's clock and every turn that
   * ends on the way. With `confirmHuman` false the human's own turn is left for a key about to be
   * applied at game time, so that the key beats a deadline at the same τ.
   */
  private run(confirmHuman: boolean): void {
    for (let turns = 0; turns < MAX_TURNS_PER_STEP; turns++) {
      const turn = this.engine.state.turn;
      const owner = this.engine.owner();
      if (turn === null || owner === null) return;
      const τ = this.gameTime - this.turnStartLocal;
      const brain = this.brains[owner];
      if (brain !== null) this.feedCpu(brain, owner, turn, τ);
      if (this.engine.state.turn === turn && (brain !== null || confirmHuman)) this.absorb(this.engine.clock(owner, τ));
      if (this.engine.state.turn === turn) {
        this.runEarly(turn, τ);
        return;
      }
    }
  }

  /** Feeds the CPU's planned inputs with τ up to `τ`, in order, each at its planned τ. */
  private feedCpu(brain: CpuBrain, owner: PlayerId, turn: TurnState, τ: number): void {
    for (;;) {
      const next = brain.plan(turn)[0];
      if (next === undefined || next.τ > τ) return;
      const events = this.engine.input(owner, next.key, next.τ);
      this.absorb(events);
      if (events.length === 0 || this.engine.state.turn !== turn) return;
    }
  }

  /** Opens the receiver's early chase once the running return turn's choice word is locked, and feeds a CPU receiver's planned early keys up to τ. */
  private runEarly(turn: TurnState, τ: number): void {
    if (this.early !== null && this.early.turnId !== turn.data.turnId) this.early = null;
    if (this.early === null) {
      const opened = EarlyChase.open(turn, τ, this.meterOf(other(turn.data.owner)));
      if (opened === null) return;
      this.early = opened.chase;
      this.earlyFed = 0;
      this.pending.push(...opened.events);
    }
    this.feedEarly(this.early, turn, τ);
  }

  /** Presses a CPU receiver's planned early keys with τ up to `τ` (none for a human receiver). */
  private feedEarly(early: EarlyChase, turn: TurnState, τ: number): void {
    const brain = this.brains[early.player];
    if (brain === null) return;
    const planned = brain.planEarly(turn);
    for (let k = planned[this.earlyFed]; k !== undefined && k.τ <= τ; k = planned[this.earlyFed]) {
      this.pending.push(...early.press(k.key, k.τ));
      this.earlyFed++;
    }
  }

  /**
   * The early keys for the turn about to start after `ended` ended at endτ (early-typing spec §2): the
   * chase typed while it ran, re-based to its strike; none unless it ended with a strike. The early
   * chase is first brought up to endτ (opened, and a CPU receiver's planned keys pressed), so a frame gap
   * never skips it, then closed either way.
   */
  private takeEarly(ended: TurnState | null, endτ: number): EarlyKey[] {
    if (ended !== null) this.runEarly(ended, endτ);
    const early = this.early;
    this.early = null;
    if (early === null || ended === null || early.turnId !== ended.data.turnId || ended.outcome?.kind !== 'strike') return [];
    return early.keysAt(endτ);
  }

  /** A player's meter level for early feedback, or null in training (meter off). */
  private meterOf(p: PlayerId): number | null {
    const s = this.engine.state;
    return s.config.training !== null ? null : s.power[p];
  }

  /** Queues engine events for the next view; a turn's end starts the next turn at start + endτ, with the receiver's early keys. */
  private absorb(events: GameEvent[]): void {
    let endτ: number | null = null;
    for (const e of events) {
      this.pending.push(e);
      if (e.type === 'turnEnd') endτ = e.endτ;
      else if (e.type === 'promptShown' && e.kind === 'choice' && e.player === this.human) this.noteChoice(e.prompt);
    }
    if (endτ === null) return;
    const ended = this.engine.state.lastTurn;
    this.turnStartLocal += endτ;
    // Taken even when the match is over, so the early chase is brought up to the end at any frame rate.
    const early = this.takeEarly(ended, endτ);
    const next = this.engine.owner();
    if (next !== null) this.absorb(this.engine.start(next, early));
  }

  private noteChoice(prompt: number): void {
    const point = this.engine.state.pointNo;
    if (this.firstChoice?.point !== point) this.firstChoice = { point, prompt };
  }

  private buildView(now: number): ViewModel {
    const state = this.engine.state;
    // In (turn, τ) order: an early chase's keys, pressed as frames reach them, interleave with the striker's own events.
    const events = redactEvents(withoutEarlyEvents(this.pending).sort(byTurnTime), state, this.viewer);
    this.pending = [];
    const counting = this.countdownFrom !== null;
    const hints = this.hints && !this.paused;
    const vm: ViewModel = {
      pub: redact(state, this.viewer),
      viewer: this.viewer,
      turnτ: this.gameTime - this.turnStartLocal,
      liveTurn: null,
      early: this.early === null ? null : { player: this.early.player, prompt: jsonCopy(this.early.prompt) },
      events,
      overlay: {
        paused: this.paused && !counting,
        countdown: counting ? this.countdown(now) : null,
        coach: null,
        wait: this.wait.on(now),
        unstable: false,
        hintSpace: hints && this.hintSpace(),
        hintFirstLetter: hints && this.hintFirstLetter(),
        focusLost: false,
        rttMs: null,
      },
    };
    if (this.script !== null) vm.overlay.coach = this.coach(this.script, vm);
    this.lastView = vm;
    return vm;
  }

  /** 3, 2, 1 across the countdown. */
  private countdown(now: number): number {
    const left = (this.countdownFrom ?? now) + COUNTDOWN_MS - now;
    return Math.max(1, Math.ceil((left * COUNTDOWN_STEPS) / COUNTDOWN_MS));
  }

  /** The human owns a serve turn in PRE_SERVE. */
  private hintSpace(): boolean {
    const t = this.engine.state.turn;
    return this.human !== null && t !== null && t.data.owner === this.human && t.data.kind === 'serve' && t.phase === 'preServe';
  }

  /** The human's active prompt is the point's first choice prompt, not locked yet. */
  private hintFirstLetter(): boolean {
    const t = this.engine.state.turn;
    if (this.human === null || t === null || t.data.owner !== this.human || t.active === null) return false;
    const p = t.prompts[t.active];
    return p?.kind === 'choice' && p.locked === null && this.firstChoice?.prompt === p.id;
  }

  /** Advances past the current lesson when this frame completes it, then asks the current lesson for coach text. */
  private coach(script: TrainingScript, vm: ViewModel): string | null {
    const current = script.lessons[this.lessonIndex];
    if (current?.done(vm) === true) this.lessonIndex++;
    return script.lessons[this.lessonIndex]?.coach(vm) ?? null;
  }
}

/** Events in the order they happened: by turn, then by τ (a stable sort keeps same-τ events in emission order). */
function byTurnTime(a: GameEvent, b: GameEvent): number {
  return a.turn - b.turn || a.τ - b.τ;
}
