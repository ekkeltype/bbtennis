import { TUNING } from '../core/tuning';
import type { GameEvent, MatchState, Overlay, PlayerId, PublicState } from '../core/types';
import type { NetMsg } from '../net/protocol';
import { TransportListeners, type Transport } from '../net/transport';
import type { Scheduler } from './clock';
import type { DisplayEntry, DisplayQueue } from './displayQueue';

/** Calls `fn` every `ms` until the returned stop() (the shape of `workerTicker` and `Scheduler.every`). */
export type Ticker = (ms: number, fn: () => void) => () => void;

/** Why an online match ended: played out, a forfeit, a lost link, or a player who left. */
export type EndReason = 'finished' | 'forfeit' | 'disconnect' | 'left';

/** How the opponent went away: a `leave` message, or a closed or silent link. */
export type Departure = 'left' | 'disconnect';

/** Period of an online session's tick: clocks, frames, heartbeat (spec §5.2 Worker ticker). */
export const TICK_MS = 50;
/** Heartbeat (spec §5.3): a ping every 2 s; 3 s of silence is unstable, 8 s a disconnect. */
const PING_MS = 2000;
const UNSTABLE_MS = 3000;
const DISCONNECT_MS = 8000;
/** Most keys (inputs) per second of a turn's clock (spec §5.3). */
const MAX_KEYS = 30;
const KEY_WINDOW_MS = 1000;
/** The WAIT tag after an off-turn letter: shown 300 ms, at most once per second (spec §3.1). */
const WAIT_MS = 300;
const WAIT_EVERY_MS = 1000;
/** Spec §5.2: back from a hidden or offscreen spell, one-shot events more than 300 ms old are dropped. */
export const STALE_EVENT_MS = 300;
/** Spec §5.3: playback held at the confirmed τ with no new confirmation for 1 s shows "Connection unstable…". */
export const STALL_MS = 1000;
/** The round trip assumed before the first pong has measured one (the most latency the game is tested with, rounded up). */
const UNKNOWN_RTT_MS = 1000;

/**
 * The link to the other player, shared by both online sessions (spec §5.3 heartbeat). It takes
 * nothing from the transport until `listen`. Any message counts as liveness: 3 s of silence make the
 * link unstable, and 8 s of silence, a transport close or error, or a `leave` lose the opponent
 * (reported once through `gone`). It pings every 2 s, answers pings and keeps the latest round trip.
 * Every other message goes to `message`. After a local `leave` or `close` it sends and reports
 * nothing more.
 */
export class PeerLink {
  private lastHeard: number;
  private lastPingAt: number;
  private nextPingId = 0;
  private pendingPing: { id: number; at: number } | null = null;
  private rtt: number | null = null;
  private lost: Departure | null = null;
  private quiet = false;
  private listening = false;

  constructor(
    private readonly transport: Transport,
    private readonly scheduler: Scheduler,
    private readonly handlers: { message(m: NetMsg): void; gone(why: Departure): void },
  ) {
    const now = scheduler.now();
    this.lastHeard = now;
    this.lastPingAt = now;
  }

  /**
   * Starts taking the transport's messages and its close (once). A transport hands over what arrived
   * before its first listener synchronously, here, so the handlers must be ready for it.
   */
  listen(): void {
    if (this.listening) return;
    this.listening = true;
    const now = this.scheduler.now();
    this.lastHeard = now;
    this.lastPingAt = now;
    this.transport.onMessage((m) => this.receive(m));
    this.transport.onClose(() => this.lose('disconnect'));
  }

  /** How the opponent went away, or null while the link is up. */
  get gone(): Departure | null {
    return this.lost;
  }

  /** Latest ping round trip (ms), or null before the first pong. */
  get rttMs(): number | null {
    return this.rtt;
  }

  /** Bytes sent that have not left yet. */
  get bufferedAmount(): number {
    return this.transport.bufferedAmount;
  }

  /** True after 3 s without a message while the opponent is still there. */
  unstable(now: number): boolean {
    return this.lost === null && now - this.lastHeard >= UNSTABLE_MS;
  }

  /** Sends `m` unless the opponent has gone or this side has left. */
  send(m: NetMsg): void {
    if (this.lost === null && !this.quiet) this.transport.send(m);
  }

  /** Heartbeat: a disconnect after 8 s of silence, otherwise a ping every 2 s. */
  tick(now: number): void {
    if (this.lost !== null || this.quiet) return;
    if (now - this.lastHeard >= DISCONNECT_MS) {
      this.lose('disconnect');
      return;
    }
    if (now - this.lastPingAt < PING_MS) return;
    this.lastPingAt = now;
    this.pendingPing = { id: this.nextPingId++, at: now };
    this.send({ type: 'ping', id: this.pendingPing.id });
  }

  /** Tells the opponent this side leaves (once, if it is still there); the link then stays quiet. */
  leave(): void {
    this.send({ type: 'leave' });
    this.quiet = true;
  }

  /** Closes the transport after the messages already sent. */
  close(): void {
    this.quiet = true;
    this.transport.close();
  }

  private receive(m: NetMsg): void {
    if (this.lost !== null || this.quiet) return;
    const now = this.scheduler.now();
    this.lastHeard = now;
    switch (m.type) {
      case 'ping':
        this.send({ type: 'pong', id: m.id });
        return;
      case 'pong':
        if (this.pendingPing?.id === m.id) {
          this.rtt = now - this.pendingPing.at;
          this.pendingPing = null;
        }
        return;
      case 'leave':
        this.lose('left');
        return;
      default:
        this.handlers.message(m);
    }
  }

  private lose(why: Departure): void {
    if (this.lost !== null || this.quiet) return;
    this.lost = why;
    this.handlers.gone(why);
  }
}

/**
 * At most 30 keys per second of a turn's clock (spec §5.3). A key counts at τ, or at the highest τ
 * counted so far this turn when its own τ is lower, and is allowed while fewer than 30 counted keys of
 * the turn lie in the second before that. The guest limits the keys it applies and the host the guest
 * inputs it receives by this same rule on the same (turn, τ) stream, so the host never drops an input
 * the guest applied, and a guest sending ever lower τ cannot slip past the limit.
 */
export class KeyRate {
  private turn: number | null = null;
  /** The counted keys' τ that are still inside the window, oldest first. */
  private times: number[] = [];

  /** Whether a key of turn `turn` at τ is allowed; an allowed one counts against later keys. */
  allow(turn: number, τ: number): boolean {
    if (turn !== this.turn) {
      this.turn = turn;
      this.times = [];
    }
    const at = Math.max(τ, this.times.at(-1) ?? τ);
    while (this.times.length > 0 && this.times[0]! <= at - KEY_WINDOW_MS) this.times.shift();
    if (this.times.length >= MAX_KEYS) return false;
    this.times.push(at);
    return true;
  }
}

/** The WAIT tag above the viewer's player after an off-turn letter: 300 ms, at most once per second (spec §3.1). */
export class WaitTag {
  private until: number | null = null;
  private lastAt: number | null = null;

  /** An off-turn letter at local time `now`. */
  show(now: number): void {
    if (this.lastAt !== null && now - this.lastAt < WAIT_EVERY_MS) return;
    this.lastAt = now;
    this.until = now + WAIT_MS;
  }

  /** Whether the tag shows at `now`. */
  on(now: number): boolean {
    return this.until !== null && now < this.until;
  }
}

/**
 * The events a frame shows (spec §5.2). The display moves on without frames (the tick advances it in a
 * hidden tab), so once more than 300 ms have passed since the last frame, the events the display passed
 * more than 300 ms ago are dropped: on each tick of that spell, so none pile up, and in the first frame
 * back. What they changed is in the view's state already; only their one-shot sounds, effects and calls
 * are lost.
 */
export class FreshEvents {
  private lastFrame: number | null = null;

  /** The 50 ms tick at `now`: while frames have stopped, `queue` drops its stale events. */
  tick(queue: DisplayQueue, now: number): void {
    if (this.late(now)) queue.dropStale(STALE_EVENT_MS);
  }

  /** A frame at `now`: the events `queue` has reached, without the stale ones when frames had stopped. */
  release(queue: DisplayQueue, now: number): GameEvent[] {
    if (this.late(now)) queue.dropStale(STALE_EVENT_MS);
    this.lastFrame = now;
    return queue.release();
  }

  /** True when no frame has been drawn for more than 300 ms (false before the first). */
  private late(now: number): boolean {
    return this.lastFrame !== null && now - this.lastFrame > STALE_EVENT_MS;
  }
}

/**
 * Stalled confirmations (spec §5.3): a remote-owned turn on display that has not ended, whose playback
 * has caught up with the owner's confirmed τ and holds there, is stalled once no new confirmation has
 * come for 1 s. The second counts from the latest rise of the confirmed τ; for a turn with no
 * confirmation yet, from one round trip after it became the front, as the owner's first confirmation
 * cannot come sooner (the hand-off freeze of spec §5.3 is normal, not a stall). The watch follows the
 * front on every tick as well as every frame, so it notes each rise within a tick, hidden tab or not.
 */
export class StallWatch {
  private front: DisplayEntry | null = null;
  private confirmed = 0;
  private since = 0;

  /** Follows the displayed `front` at `now`, given the latest round trip; returns whether it is stalled. */
  update(front: DisplayEntry | null, rttMs: number | null, now: number): boolean {
    const clock = front?.clock ?? null;
    if (front === null || clock === null || front.endτ !== null) {
      this.front = null;
      return false;
    }
    if (front !== this.front) {
      this.front = front;
      this.confirmed = clock.confirmedτ;
      const wait = this.confirmed > 0 ? 0 : rttMs ?? UNKNOWN_RTT_MS;
      this.since = (front.startedAt ?? now) + wait;
    } else if (clock.confirmedτ > this.confirmed) {
      this.confirmed = clock.confirmedτ;
      this.since = now;
    }
    return clock.τ >= this.confirmed && now - this.since >= STALL_MS;
  }
}

/**
 * The overlay of an online session: never paused, no hints; WAIT, the RTT, and "Connection unstable…"
 * after 3 s of silence or while the display is `stalled` (StallWatch).
 */
export function onlineOverlay(link: PeerLink, wait: WaitTag, now: number, stalled: boolean): Overlay {
  return {
    paused: false,
    countdown: null,
    coach: null,
    wait: wait.on(now),
    unstable: link.unstable(now) || stalled,
    hintSpace: false,
    hintFirstLetter: false,
    focusLost: false,
    rttMs: link.rttMs,
  };
}

/** What an online session hands its lifecycle. */
export interface OnlineLifecycleOptions {
  transport: Transport;
  scheduler: Scheduler;
  /** Takes each message of the opponent other than the link's own (ping, pong, leave). */
  message(m: NetMsg): void;
  /** The display queue of the current match (a new match replaces it). */
  display(): DisplayQueue;
}

/**
 * The start and end of an online match, one set of rules for both sessions. It owns the link, which
 * `open` starts (with the 50 ms tick) once the session is ready, because a transport hands over
 * messages and a close that arrived earlier at once. A match ends for its first reason: played out or
 * forfeited on court (`settle`), the opponent gone (the link), or this side leaving. A forfeit, a lost
 * opponent or a leave is `over` at once; a played-out match once the display has shown its last turn
 * and the MATCH_OVER celebration has played. A new match (`reset`) never revives a session whose
 * opponent is gone or that has left.
 */
export class OnlineLifecycle {
  /** The link to the opponent. */
  readonly link: PeerLink;
  private readonly scheduler: Scheduler;
  private readonly display: () => DisplayQueue;
  private why: EndReason | null = null;
  private left = false;
  private closed = false;
  private stopTicker: (() => void) | null = null;

  constructor(opts: OnlineLifecycleOptions) {
    this.scheduler = opts.scheduler;
    this.display = opts.display;
    this.link = new PeerLink(opts.transport, opts.scheduler, {
      message: opts.message,
      gone: (why) => {
        this.why ??= why;
      },
    });
  }

  /** Starts taking messages (any that came earlier arrive now) and runs `tick` every 50 ms, when the session is ready; later calls do nothing. */
  open(ticker: Ticker, tick: () => void): void {
    if (this.stopTicker !== null || this.closed) return;
    this.link.listen();
    this.stopTicker = ticker(TICK_MS, tick);
  }

  /** Why the match ended, or null while it is played. */
  get reason(): EndReason | null {
    return this.why;
  }

  /** True once disposed: the session does nothing more. */
  get disposed(): boolean {
    return this.closed;
  }

  /** True while the match is being played (it has not ended and the session is not disposed). */
  get playing(): boolean {
    return !this.closed && this.why === null;
  }

  /** True while the display moves on: the match is played, or it was played out and its end is still showing. */
  get showing(): boolean {
    return !this.closed && (this.why === null || this.why === 'finished');
  }

  /** True once the match has ended: at once for a forfeit, disconnect or leave; after the MATCH_OVER celebration otherwise. */
  get over(): boolean {
    const r = this.why;
    if (r === null) return false;
    if (r !== 'finished') return true;
    const at = this.display().finishedAt;
    return at !== null && this.scheduler.now() - at >= TUNING.leadIn.matchOverMs;
  }

  /** True when a rematch may be asked for or begin: the match is over, played out or forfeited, the opponent is there and this side has not left. */
  get mayRematch(): boolean {
    return !this.left && this.link.gone === null && (this.why === 'finished' || this.why === 'forfeit') && this.over;
  }

  /** The match's state says it is over: played out, or forfeited by `forfeitBy`. No turn follows the ones queued. Ignored once ended. */
  settle(forfeitBy: PlayerId | null): void {
    if (this.why !== null) return;
    this.why = forfeitBy === null ? 'finished' : 'forfeit';
    this.display().end();
  }

  /** A new match begins (with a new display queue): no reason yet, unless the opponent is gone or this side has left. */
  reset(): void {
    this.why = this.link.gone ?? (this.left ? 'left' : null);
  }

  /** Leaves the match (Menu, page hide): the opponent is told once, and a match still being played ends as 'left'. */
  leave(): void {
    if (this.closed) return;
    this.link.leave();
    this.left = true;
    this.why ??= 'left';
  }

  /** Leaves (if not yet), stops the tick and closes the transport. */
  dispose(): void {
    if (this.closed) return;
    this.leave();
    this.closed = true;
    this.stopTicker?.();
    this.link.close();
  }
}

/** What the scoreboard shows: the match's score, stats and status, the point's number, rally strikes and meters. */
type Scoreboard = Pick<MatchState, 'score' | 'stats' | 'status' | 'pointNo' | 'rallyStrikes' | 'power'>;

/**
 * The scoreboard each display entry carries: the match's score, stats, status, point number and rally
 * count when its turn was created. A view shows the displayed turn's scoreboard, so a viewer sees a
 * point's new score (and the court's ball marks clear with the new point number) as the display
 * reaches the next serve, whose lead-in is the point call (spec §3.1), and the rally count grow as it
 * reaches each return; not earlier, when the owner's machine decided them. With no turn displayed the
 * view keeps the latest state's.
 */
export class Scoreboards {
  private readonly of = new WeakMap<DisplayEntry, Scoreboard>();

  /** `entry`'s turn was created in `state`: its scoreboard (score, stats, status, point, rally, meters) as it is now. */
  note(entry: DisplayEntry, state: MatchState): void {
    const { score, stats, status, pointNo, rallyStrikes, power } = state;
    this.of.set(entry, structuredClone({ score, stats, status, pointNo, rallyStrikes, power }));
  }

  /** Puts the scoreboard of the displayed entry `front` into `pub` (a copy); without a front `pub` keeps its own. */
  show(pub: PublicState, front: DisplayEntry | null): void {
    const board = front === null ? undefined : this.of.get(front);
    if (board !== undefined) Object.assign(pub, structuredClone(board));
  }
}

/** One owner's view of a switched transport: it hears the transport only while it is the switch's current channel. */
class Channel implements Transport {
  readonly listeners = new TransportListeners();
  current = true;

  constructor(private readonly inner: Transport) {}

  get bufferedAmount(): number {
    return this.inner.bufferedAmount;
  }

  send(msg: NetMsg): void {
    if (this.current) this.inner.send(msg);
  }

  onMessage(cb: (m: NetMsg) => void): void {
    this.listeners.onMessage(cb);
  }

  onClose(cb: (reason: string) => void): void {
    this.listeners.onClose(cb);
  }

  close(): void {
    if (this.current) this.inner.close();
  }
}

/**
 * Hands one transport from owner to owner: from the lobby to the match session (spec §5.3). A
 * Transport cannot drop a listener, so the switch listens to it once and passes each message and the
 * close to its current channel only. Once `next()` makes a new channel current, the old one hears
 * nothing more and its `send` and `close` do nothing, so the lobby can neither answer nor close what
 * the match now owns. A channel holds what it is passed until it has listeners, like any transport.
 */
export class TransportSwitch {
  private channel: Channel;
  private closedWith: string | null = null;

  constructor(private readonly inner: Transport) {
    this.channel = new Channel(inner);
    inner.onMessage((m) => this.channel.listeners.message(m));
    inner.onClose((reason) => {
      this.closedWith = reason;
      this.channel.listeners.close(reason);
    });
  }

  /** The channel that hears the transport now. */
  get current(): Transport {
    return this.channel;
  }

  /** Makes a new channel current and returns it; it hears `first` before anything else, then the transport (and a close that already happened). */
  next(first: readonly NetMsg[] = []): Transport {
    this.channel.current = false;
    const ch = new Channel(this.inner);
    this.channel = ch;
    for (const m of first) ch.listeners.message(m);
    if (this.closedWith !== null) ch.listeners.close(this.closedWith);
    return ch;
  }
}

/** How often the lobby's heartbeat runs. */
const LOBBY_TICK_MS = 250;

/**
 * The link to the other player in the lobby: a PeerLink (spec §5.3 heartbeat: pings, the round trip,
 * the other side leaving, closing or going silent) on a TransportSwitch's first channel, ticking every
 * 250 ms from `open` until `handOver` gives the transport to the match. Its handlers take the other
 * side's lobby messages and hear once that it has gone.
 */
export class LobbyLink {
  private readonly switch: TransportSwitch;
  private readonly link: PeerLink;
  private readonly scheduler: Scheduler;
  private stopTick: (() => void) | null = null;

  constructor(transport: Transport, scheduler: Scheduler, handlers: { message(m: NetMsg): void; gone(why: Departure): void }) {
    this.scheduler = scheduler;
    this.switch = new TransportSwitch(transport);
    this.link = new PeerLink(this.switch.current, scheduler, handlers);
  }

  /** Starts hearing the other side (what arrived earlier comes now, so the handlers must be ready) and the heartbeat; once. */
  open(): void {
    if (this.stopTick !== null) return;
    this.link.listen();
    this.stopTick = this.scheduler.every(LOBBY_TICK_MS, () => this.link.tick(this.scheduler.now()));
  }

  /** Latest ping round trip (ms), or null before the first pong. */
  get rttMs(): number | null {
    return this.link.rttMs;
  }

  /** Sends `m` while the other side is there and the lobby has the transport. */
  send(m: NetMsg): void {
    this.link.send(m);
  }

  /** The match takes the transport over: the lobby's heartbeat stops and hears nothing more; the match's channel hears `first` first. */
  handOver(first: readonly NetMsg[] = []): Transport {
    this.stop();
    return this.switch.next(first);
  }

  /** Leaves the lobby: the other side is told (once) and the transport closes after it. */
  close(): void {
    this.stop();
    this.link.leave();
    this.link.close();
  }

  private stop(): void {
    this.stopTick?.();
    this.stopTick = () => {};
  }
}
