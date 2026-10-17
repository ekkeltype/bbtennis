import { createMatch, step } from '../core/match';
import { DT, ARCADE, TICK_HZ } from '../core/tuning';
import type { ArcadeConfig, ArcadeEvent, ArcadeState, Controller, PlayerId, PlayerInput } from '../core/types';
import type { PlayerInfo } from '../../core/types';

export interface ArcadeOverlay { paused: boolean; countdown: number | null }

export interface ArcadeView {
  state: Readonly<ArcadeState>;
  /** Absolute sim time (s) for drawing: tick·DT + the time accumulated toward the next tick. */
  t: number;
  /** Events produced since the previous frame. */
  events: ArcadeEvent[];
  viewer: PlayerId | 'spectator';
  overlay: ArcadeOverlay;
}

export interface ArcadeSessionOptions {
  config: ArcadeConfig;
  players: [PlayerInfo, PlayerInfo];
  seed: number;
  controllers: [Controller, Controller];
  viewer: PlayerId | 'spectator';
}

/** At most this many catch-up ticks per frame; time beyond that is dropped (Review Focus 5). */
const MAX_TICKS_PER_FRAME = 15;
const TICK_MS = 1000 / TICK_HZ;
/** Absorbs float error when frames add up to a whole number of ticks. */
const EPS_MS = 1e-6;
const COUNTDOWN_MS = 3000;

/**
 * The local match loop (spec §6.1, §6.3): fixed 60 Hz steps from the frame times given to
 * `frame`, one controller call per player per tick, pause and a 3-2-1 countdown on resume. It
 * reads no clock itself. Held keys are the owner's to clear on pause (`HeldKeys.clear`).
 */
export class ArcadeSession {
  private readonly state: ArcadeState;
  private readonly controllers: [Controller, Controller];
  private readonly viewer: PlayerId | 'spectator';
  private accMs = 0;
  private paused = false;
  private countdownMs = 0;
  private disposed = false;
  private last: ArcadeView | null = null;

  constructor(o: ArcadeSessionOptions) {
    this.state = createMatch(o.config, o.players, o.seed);
    this.controllers = o.controllers;
    this.viewer = o.viewer;
  }

  /** Status 'over' and the over phase has lasted flow.overHold. */
  get over(): boolean {
    const s = this.state;
    return s.phase.kind === 'over' && s.tick - s.phase.since >= Math.round(ARCADE.flow.overHold * TICK_HZ);
  }

  get result(): ArcadeState | null {
    return this.over ? this.state : null;
  }

  get view(): ArcadeView | null {
    return this.last;
  }

  /** Freezes the sim. */
  pause(): void {
    this.paused = true;
    this.countdownMs = 0;
    this.accMs = 0;
  }

  /** Starts the 3-2-1 countdown (sim frozen), then the sim runs. */
  resume(): void {
    this.paused = false;
    this.countdownMs = COUNTDOWN_MS;
    this.accMs = 0;
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Advances by dtMs (fixed 60 Hz steps; at most 15 per frame; the rest is dropped) and returns the view. */
  frame(dtMs: number): ArcadeView {
    const events: ArcadeEvent[] = [];
    if (!this.disposed && !this.paused && !this.over) {
      if (this.countdownMs > 0) {
        this.countdownMs = Math.max(0, this.countdownMs - Math.max(0, dtMs));
      } else {
        this.run(Math.max(0, dtMs), events);
      }
    }
    const countdown = this.countdownMs > 0 ? Math.ceil(this.countdownMs / 1000) : null;
    this.last = {
      state: this.state,
      t: this.state.tick * DT + this.accMs / 1000,
      events,
      viewer: this.viewer,
      overlay: { paused: this.paused, countdown },
    };
    return this.last;
  }

  private run(dtMs: number, events: ArcadeEvent[]): void {
    this.accMs += dtMs;
    let n = 0;
    while (this.accMs >= TICK_MS - EPS_MS && n < MAX_TICKS_PER_FRAME && !this.over) {
      const inputs: [PlayerInput, PlayerInput] = [this.controllers[0].input(this.state), this.controllers[1].input(this.state)];
      events.push(...step(this.state, inputs));
      this.accMs -= TICK_MS;
      n++;
    }
    if (this.accMs >= TICK_MS - EPS_MS || this.over) this.accMs = 0;
    else if (this.accMs < 0) this.accMs = 0;
  }
}
