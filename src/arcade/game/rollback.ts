import { finished, step } from '../core/match';
import { NO_INPUT, type ArcadeEvent, type ArcadeState, type PlayerId, type PlayerInput } from '../core/types';

/** Netcode numbers (online spec §3), in ticks. */
export const NET = {
  /** A side's own input applies this many ticks after it is sampled (33 ms). */
  inputDelay: 2,
  /** The sim runs at most this many ticks past the opponent's last input, then waits. */
  maxPredict: 15,
  /** Confirmed states are hashed after every tick that is a multiple of this (1 s). */
  sumEvery: 60,
  /** Inputs and hashes are kept this long behind the confirmed tick (10 s), for a resync. */
  keepTicks: 600,
} as const;

/**
 * A copy of a match state. The state is plain data (objects, arrays, numbers, strings, booleans,
 * null), so a plain recursive copy is exact, keeping key order and the sign of zero, and it is
 * several times faster than structuredClone: rollback copies the state every predicted tick.
 */
export function cloneState<T>(v: T): T {
  if (typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) return v.map(cloneState) as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) out[k] = cloneState((v as Record<string, unknown>)[k]);
  return out as T;
}

/** FNV-1a (32 bits) of a state's JSON: the same on every machine for the same state (online spec §3.4). */
export function stateHash(s: Readonly<ArcadeState>): number {
  const json = JSON.stringify(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * What makes two events the same event for showing it once (online spec §3.2): a hit by its tick and
 * hitter, a bounce or net cord by its tick (a correction that only moves the ball, say a late change of
 * aim, does not sound or spark twice); any other event by its whole content.
 */
export function eventKey(e: ArcadeEvent): string {
  switch (e.type) {
    case 'hit':
      return `${e.tick}:hit:${e.hit.player}`;
    case 'bounce':
    case 'netHit':
      return `${e.tick}:${e.type}`;
    default:
      return JSON.stringify(e);
  }
}

const sameInput = (a: PlayerInput, b: PlayerInput): boolean =>
  a.mx === b.mx && a.my === b.my && a.topspin === b.topspin && a.slice === b.slice && a.lob === b.lob;

/** Deletes the keys of `m` at or below `upTo`. */
function dropUpTo<V>(m: Map<number, V>, upTo: number): void {
  for (const k of m.keys()) if (k <= upTo) m.delete(k);
}

/** Moves `from`'s fields into the live state `to`, which keeps its identity (renderers key on it). */
function assign(to: ArcadeState, from: ArcadeState): void {
  Object.assign(to, from);
}

/**
 * One side's rollback sim of an online match (online spec §3). It owns the live state and steps it
 * with this side's inputs (applied `inputDelay` ticks after they are sampled) and the opponent's
 * (their true input once it has arrived, else a prediction: their last true input). A true input
 * that differs from what a tick used rolls the state back to before that tick and re-simulates.
 * Events reach the caller once per tick and content (online spec §3.2). Confirmed states are hashed
 * at checkpoints so the two sides can compare them (§3.4). It reads no clock and sends nothing.
 */
export class Rollback {
  /** The live state: confirmed up to `confirmed`, predicted after it. Its identity never changes. */
  readonly state: ArcadeState;
  readonly stats = { rollbacks: 0, maxDepth: 0, resimTicks: 0 };
  private readonly local: PlayerId;
  /** This side's inputs by the tick they apply on (ticks 1..inputDelay have none: no input). */
  private readonly localIn = new Map<number, PlayerInput>();
  /** The opponent's true inputs by tick (also past a gap, while the link catches up). */
  private readonly remoteIn = new Map<number, PlayerInput>();
  private lastLocal: number = NET.inputDelay;
  private sentLocal: number = NET.inputDelay;
  private lastRemoteTick: number = NET.inputDelay;
  /** Per predicted tick: the state before it and the opponent input it used. */
  private readonly snaps = new Map<number, ArcadeState>();
  private readonly used = new Map<number, PlayerInput>();
  /** Per predicted tick: the events already shown (by eventKey). */
  private readonly shown = new Map<number, Set<string>>();
  /** Hashes of the state after checkpoint ticks (the latest simulation of each), ours and the opponent's. */
  private readonly sums = new Map<number, number>();
  private readonly remoteSums = new Map<number, number>();
  private takenSums = 0;
  private mismatches: number[] = [];
  /** A resync state for a tick this side has not reached yet. */
  private pendingAdopt: { tick: number; state: ArcadeState } | null = null;
  /** The latest tick adopted from the host: final, though the opponent's inputs up to it may still be on their way. */
  private adopted = 0;

  constructor(state: ArcadeState, local: PlayerId) {
    this.state = state;
    this.local = local;
  }

  get tick(): number {
    return this.state.tick;
  }

  /** The last tick up to which every opponent input is known (ticks 1..inputDelay have no input on either side). */
  get lastRemote(): number {
    return this.lastRemoteTick;
  }

  /** Every tick up to this one is final: simulated with both sides' true inputs, or adopted from the host. */
  get confirmed(): number {
    return Math.max(this.adopted, Math.min(this.lastRemoteTick, this.state.tick));
  }

  /** True while the next tick may be simulated: the match still steps and fewer than maxPredict ticks would be predicted. */
  canStep(): boolean {
    return !finished(this.state) && this.state.tick + 1 - this.lastRemoteTick <= NET.maxPredict;
  }

  /**
   * Simulates the next tick; `local` is this side's input sampled now, for tick + 1 + inputDelay. Returns
   * the new events. If the sim throws (only a broken state from the other side can make it), the live
   * state is put back as it was and the error is rethrown.
   */
  step(local: PlayerInput): ArcadeEvent[] {
    return this.guarded(() => {
      const n = this.state.tick + 1;
      this.lastLocal = n + NET.inputDelay;
      this.localIn.set(this.lastLocal, local);
      const events = this.simulate(n);
      const pending = this.pendingAdopt;
      if (pending !== null && pending.tick <= this.state.tick) {
        this.pendingAdopt = null;
        events.push(...this.adopt(pending.tick, pending.state));
      }
      this.settle();
      return events;
    });
  }

  /** This side's inputs not handed out yet, from tick `first` on; null when there are none. */
  takeLocal(): { first: number; inputs: PlayerInput[] } | null {
    if (this.lastLocal <= this.sentLocal) return null;
    const first = this.sentLocal + 1;
    const inputs: PlayerInput[] = [];
    for (let t = first; t <= this.lastLocal; t++) inputs.push(this.localIn.get(t) ?? NO_INPUT);
    this.sentLocal = this.lastLocal;
    return { first, inputs };
  }

  /**
   * The opponent's true inputs from tick `first` on. Ticks it already knows are skipped (a tick's input
   * never changes), and inputs past a gap are kept until the gap fills: the link delivers in order, so
   * that is only a safety net, but one late message must never stop the match. Rolls back to the first
   * simulated tick whose opponent input was wrong (or whose prediction changes) and re-simulates to the
   * current tick. Returns the events not shown before.
   */
  receive(first: number, inputs: readonly PlayerInput[]): ArcadeEvent[] {
    return this.guarded(() => this.take(first, inputs));
  }

  /** receive's work. */
  private take(first: number, inputs: readonly PlayerInput[]): ArcadeEvent[] {
    const oldLast = this.lastRemoteTick;
    inputs.forEach((input, i) => {
      const t = first + i;
      if (t > oldLast && t <= oldLast + NET.keepTicks && !this.remoteIn.has(t)) this.remoteIn.set(t, input);
    });
    while (this.remoteIn.has(this.lastRemoteTick + 1)) this.lastRemoteTick++;
    let from: number | null = null;
    for (let n = oldLast + 1; n <= this.state.tick; n++) {
      const used = this.used.get(n);
      if (used !== undefined && !sameInput(used, this.remoteFor(n))) {
        from = n;
        break;
      }
    }
    const events = from === null ? [] : this.rollBack(from);
    this.settle();
    return events;
  }

  /** Hashes of confirmed checkpoint ticks not handed out yet, oldest first. */
  takeSums(): { tick: number; hash: number }[] {
    const out: { tick: number; hash: number }[] = [];
    const c = this.confirmed;
    for (let t = this.takenSums + NET.sumEvery; t <= c; t += NET.sumEvery) {
      const hash = this.sums.get(t);
      if (hash !== undefined) out.push({ tick: t, hash });
      this.takenSums = t;
    }
    return out;
  }

  /** The opponent's hash of its state after `tick`; it is compared with ours once both are final. Ticks far from ours are ignored. */
  noteRemoteSum(tick: number, hash: number): void {
    if (tick % NET.sumEvery !== 0 || tick < this.confirmed - NET.keepTicks || tick > this.state.tick + NET.keepTicks) return;
    this.remoteSums.set(tick, hash);
    this.compare();
  }

  /** Checkpoint ticks whose two hashes differed, found since the last call (online spec §3.4). */
  takeMismatches(): number[] {
    const out = this.mismatches;
    this.mismatches = [];
    return out;
  }

  /** A copy of the state after the confirmed tick, for the opponent to adopt (online spec §3.4). */
  confirmedState(): { tick: number; state: ArcadeState } {
    const c = this.confirmed;
    const after = c === this.state.tick ? this.state : this.snaps.get(c + 1);
    return { tick: c, state: cloneState(after ?? this.state) };
  }

  /**
   * Adopts the host's state after its confirmed tick `tick` (online spec §3.4) and re-simulates to the
   * current tick with the inputs this side has; a tick not reached yet is adopted on reaching it.
   * Events of ticks this side had confirmed are not shown again. Returns the new events, or [] when
   * `tick` is older than the kept inputs (nothing changes then). All or nothing: if the sim throws on
   * the adopted state, this side is put back exactly as it was and the error is rethrown.
   */
  adopt(tick: number, state: ArcadeState): ArcadeEvent[] {
    const now = this.state.tick;
    if (tick > now) {
      this.pendingAdopt = { tick, state };
      return [];
    }
    if (tick < this.confirmed - NET.keepTicks) return [];
    const oldConfirmed = this.confirmed;
    const before = {
      state: cloneState(this.state),
      snaps: new Map(this.snaps),
      used: new Map(this.used),
      shown: new Map([...this.shown].map(([t, keys]) => [t, new Set(keys)] as const)),
      sums: new Map(this.sums),
    };
    try {
      assign(this.state, cloneState(state));
      this.snaps.clear();
      this.used.clear();
      const events: ArcadeEvent[] = [];
      for (let n = tick + 1; n <= now && !finished(this.state); n++) {
        const produced = this.simulate(n);
        if (n > oldConfirmed) events.push(...produced);
      }
      // A dry run of the next tick, so a state that would throw there is refused now, not adopted.
      if (!finished(this.state)) step(cloneState(this.state), [NO_INPUT, NO_INPUT]);
      for (const t of this.sums.keys()) if (t <= tick) this.sums.delete(t);
      this.adopted = Math.max(this.adopted, tick);
      this.settle();
      return events;
    } catch (err) {
      assign(this.state, before.state);
      for (const [mine, saved] of [
        [this.snaps, before.snaps],
        [this.used, before.used],
        [this.shown, before.shown],
        [this.sums, before.sums],
      ] as [Map<number, unknown>, Map<number, unknown>][]) {
        mine.clear();
        for (const [k, v] of saved) mine.set(k, v);
      }
      throw err;
    }
  }

  /** Runs `work` on the live state; if it throws, the live state is put back as it was, and the error is rethrown. */
  private guarded<T>(work: () => T): T {
    const before = cloneState(this.state);
    try {
      return work();
    } catch (err) {
      assign(this.state, before);
      throw err;
    }
  }

  /** Re-simulates from `from` (a predicted tick) to the current tick. */
  private rollBack(from: number): ArcadeEvent[] {
    const to = this.state.tick;
    const snap = this.snaps.get(from);
    if (snap === undefined) return [];
    assign(this.state, snap);
    const events: ArcadeEvent[] = [];
    for (let n = from; n <= to && !finished(this.state); n++) events.push(...this.simulate(n));
    const depth = to - from + 1;
    this.stats.rollbacks += 1;
    this.stats.resimTicks += depth;
    this.stats.maxDepth = Math.max(this.stats.maxDepth, depth);
    return events;
  }

  /**
   * Steps tick `n` (= state.tick + 1). A tick past the opponent's last true input is predicted: the state
   * before it and the opponent input it used are kept, and its events are noted so a re-simulation shows
   * each only once.
   */
  private simulate(n: number): ArcadeEvent[] {
    const remote = this.remoteFor(n);
    const predicted = n > this.lastRemoteTick;
    if (predicted) {
      this.snaps.set(n, cloneState(this.state));
      this.used.set(n, remote);
    }
    const local = this.localIn.get(n) ?? NO_INPUT;
    const events = step(this.state, this.local === 0 ? [local, remote] : [remote, local]);
    if (n % NET.sumEvery === 0) this.sums.set(n, stateHash(this.state));
    const seen = this.shown.get(n);
    const fresh = seen === undefined ? events : events.filter((e) => !seen.has(eventKey(e)));
    if (predicted) {
      const set = seen ?? new Set<string>();
      for (const e of fresh) set.add(eventKey(e));
      this.shown.set(n, set);
    }
    return fresh;
  }

  /** The opponent's input for tick `n`: the true one, else their last known one (no input before any). */
  private remoteFor(n: number): PlayerInput {
    const known = this.remoteIn.get(n);
    if (known !== undefined) return known;
    if (n <= this.lastRemoteTick) return NO_INPUT;
    return this.remoteIn.get(this.lastRemoteTick) ?? NO_INPUT;
  }

  /** After a step or a receive: drops what confirmed ticks no longer need and compares hashes. */
  private settle(): void {
    const c = this.confirmed;
    dropUpTo(this.snaps, c);
    dropUpTo(this.used, c);
    dropUpTo(this.shown, c);
    const keepFrom = c - NET.keepTicks;
    dropUpTo(this.localIn, keepFrom);
    dropUpTo(this.remoteIn, Math.min(keepFrom, this.lastRemoteTick - 1));
    dropUpTo(this.sums, keepFrom);
    this.compare();
  }

  /** Compares the opponent's hashes with ours for every checkpoint now final on this side. */
  private compare(): void {
    const c = this.confirmed;
    for (const [t, theirs] of this.remoteSums) {
      if (t > c) continue;
      this.remoteSums.delete(t);
      const ours = this.sums.get(t);
      if (ours !== undefined && ours !== theirs) this.mismatches.push(t);
    }
  }
}
