import type { GameEvent, TurnState } from '../core/types';
import { PlaybackClock, type PlaybackOptions } from './playback';

/** Passive playback of a remote-owned turn online (spec §5.2): 60 ms behind the owner, at most 10 % fast. */
export const ONLINE_PLAYBACK: PlaybackOptions = { margin: 60, maxRate: 1.1, relaxMs: 500 };

/** One turn in the display queue: queued, being shown (the front) or just shown (previous). */
export interface DisplayEntry {
  /** The turn's latest snapshot. */
  turn: TurnState;
  /** True when this machine owns the turn and clocks it itself. */
  readonly local: boolean;
  /** Playback clock of a remote-owned turn; null for a local one. */
  readonly clock: PlaybackClock | null;
  /** The turn's end τ, once it has ended. */
  endτ: number | null;
  /** Local time the entry became the front (a local turn's τ = 0 there); null while it is queued. */
  startedAt: number | null;
  /** τ at which the turn is displayed; never decreases. */
  τ: number;
}

/**
 * The turns to show, in order (spec §5.2, §5.3 turn-based timing). The front entry is displayed: a
 * local-owned front at its live τ (now − the time it became the front), a remote-owned one at its
 * playback clock's τ_play, which never passes the owner's confirmed τ. Neither passes the turn's endτ.
 * Once an ended front has been shown to its endτ it pops (becoming `previous`) and the next entry
 * becomes the front at τ 0; until a next entry exists the front holds at endτ, so the ball never
 * jumps back. After `end()` the last turn leaves the front the same way, with no successor.
 * Events are held until the display reaches their (turn, τ); `dropStale` drops long-passed ones after a hidden spell.
 */
export class DisplayQueue {
  private readonly queued: DisplayEntry[] = [];
  private cur: DisplayEntry | null = null;
  private prev: DisplayEntry | null = null;
  private lastId = Number.NEGATIVE_INFINITY;
  private last: number;
  private ended = false;
  private doneAt: number | null = null;
  private held: GameEvent[] = [];

  constructor(now: number) {
    this.last = now;
  }

  /** The entry being displayed, or null before the first turn and once the last one has been shown. */
  get front(): DisplayEntry | null {
    return this.cur;
  }

  /** The entry displayed before the front (the renderer finishes its visuals). */
  get previous(): DisplayEntry | null {
    return this.prev;
  }

  /** The front's displayed τ; 0 without a front. */
  get τ(): number {
    return this.cur?.τ ?? 0;
  }

  /** Local time the last turn was shown to its end after `end()`, else null. */
  get finishedAt(): number | null {
    return this.doneAt;
  }

  /** Queues a turn to show after the ones already queued (its id must be higher); a turn that has ended keeps its endτ. */
  push(turn: TurnState, local: boolean): DisplayEntry {
    const turnId = turn.data.turnId;
    if (turnId <= this.lastId) throw new Error(`DisplayQueue: turn ${turnId} pushed after turn ${this.lastId}`);
    this.lastId = turnId;
    const entry: DisplayEntry = { turn, local, clock: local ? null : new PlaybackClock(ONLINE_PLAYBACK), endτ: null, startedAt: null, τ: 0 };
    this.queued.push(entry);
    this.noteEnd(entry);
    return entry;
  }

  /** The entry of turn `turnId` (front, previous or queued), or null. */
  get(turnId: number): DisplayEntry | null {
    const is = (e: DisplayEntry | null): e is DisplayEntry => e !== null && e.turn.data.turnId === turnId;
    if (is(this.cur)) return this.cur;
    if (is(this.prev)) return this.prev;
    return this.queued.find(is) ?? null;
  }

  /** A newer snapshot of a turn in the queue: replaces its entry's snapshot and, once the turn has ended, sets its endτ. */
  update(turn: TurnState): void {
    const entry = this.get(turn.data.turnId);
    if (entry === null) return;
    entry.turn = turn;
    this.noteEnd(entry);
  }

  /** The owner confirmed that a remote-owned turn's clock reached τ. */
  confirm(turnId: number, τ: number): void {
    this.get(turnId)?.clock?.confirm(τ);
  }

  /** No turn follows the ones queued (the match is over): the last one leaves the front once shown to its end. */
  end(): void {
    this.ended = true;
  }

  /**
   * Moves the display on to local time `now`: the front's τ advances, and each ended front that has
   * been shown to its end pops. Returns the entries that became the front, in order (the caller
   * starts the local ones: their τ is 0 at `now`).
   */
  advance(now: number): DisplayEntry[] {
    let dt = Math.max(0, now - this.last);
    this.last = Math.max(this.last, now);
    const fronted: DisplayEntry[] = [];
    for (;;) {
      const f = this.cur;
      if (f === null) {
        if (this.doneAt !== null) break;
        const next = this.queued.shift();
        if (next === undefined) break;
        this.begin(next, now, fronted);
        continue;
      }
      const raw = f.clock === null ? now - (f.startedAt ?? now) : f.clock.tick(dt);
      dt = 0;
      f.τ = Math.max(f.τ, f.endτ === null ? raw : Math.min(raw, f.endτ));
      if (f.endτ === null || f.τ < f.endτ) break;
      const next = this.queued.shift();
      if (next === undefined && !this.ended) break;
      this.prev = f;
      this.cur = null;
      if (next === undefined) {
        this.doneAt = now;
        break;
      }
      this.begin(next, now, fronted);
    }
    return fronted;
  }

  /** Holds events until the display reaches them. */
  hold(events: readonly GameEvent[]): void {
    this.held.push(...events);
  }

  /**
   * The held events the display has reached, in order: those of turns already shown, and the front's
   * up to its displayed τ. The first event not yet reached holds back every later one.
   */
  release(): GameEvent[] {
    return this.held.splice(0, this.reachedCount());
  }

  /**
   * Drops the held events the display passed more than `maxAgeMs` of display time ago (spec §5.2, back
   * from a hidden tab): a front event's age is the front's τ − its τ, the previous turn's is that turn's
   * shown end − its τ + the front's τ (or + the time since the last turn was shown, after the end), and
   * an older turn's is unbounded. Events the display has not reached stay held.
   */
  dropStale(maxAgeMs: number): void {
    const n = this.reachedCount();
    const fresh = this.held.slice(0, n).filter((e) => this.age(e) <= maxAgeMs);
    this.held.splice(0, n, ...fresh);
  }

  /** How many held events, from the first, the display has reached. */
  private reachedCount(): number {
    let n = 0;
    while (n < this.held.length && this.reached(this.held[n]!)) n++;
    return n;
  }

  /** How far (ms of display time) the display has moved past a reached event. */
  private age(e: GameEvent): number {
    const f = this.cur;
    const p = this.prev;
    if (f !== null && e.turn === f.turn.data.turnId) return f.τ - e.τ;
    if (p === null || e.turn !== p.turn.data.turnId) return Number.POSITIVE_INFINITY;
    const since = f !== null ? f.τ : this.last - (this.doneAt ?? this.last);
    return p.τ - e.τ + since;
  }

  private reached(e: GameEvent): boolean {
    const f = this.cur;
    if (f === null) return this.prev !== null && e.turn <= this.prev.turn.data.turnId;
    const id = f.turn.data.turnId;
    return e.turn < id || (e.turn === id && e.τ <= f.τ);
  }

  private begin(entry: DisplayEntry, now: number, fronted: DisplayEntry[]): void {
    entry.startedAt = now;
    entry.τ = 0;
    entry.clock?.begin();
    this.cur = entry;
    fronted.push(entry);
  }

  /** Sets the entry's endτ from its snapshot once ended; everything up to endτ is then known, so playback may reach it. */
  private noteEnd(entry: DisplayEntry): void {
    const { ended, outcome } = entry.turn;
    if (!ended || outcome === null) return;
    entry.endτ = outcome.endτ;
    entry.clock?.confirm(outcome.endτ);
  }
}
