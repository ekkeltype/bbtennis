import { TUNING } from '../core/tuning';
import type { GameEvent, MatchState, Overlay, PlayerId, PublicState } from '../core/types';
import { LobbyLink as Lobby, PeerLink as Link, TransportSwitch as Switch } from '../net/link';
import type { NetMsg } from '../net/protocol';
import type { Transport } from '../net/transport';
import type { Scheduler } from './clock';
import type { DisplayEntry, DisplayQueue } from './displayQueue';

export type { Departure } from '../net/link';

/** Calls `fn` every `ms` until the returned stop() (the shape of `workerTicker` and `Scheduler.every`). */
export type Ticker = (ms: number, fn: () => void) => () => void;

/** Why an online match ended: played out, a forfeit, a lost link, or a player who left. */
export type EndReason = 'finished' | 'forfeit' | 'disconnect' | 'left';

/** Period of an online session's tick: clocks, frames, heartbeat (spec §5.2 Worker ticker). */
export const TICK_MS = 50;
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

/** The link to the other player (net/link PeerLink, spec §5.3 heartbeat) for the typing game's messages, shared by both online sessions. */
export class PeerLink extends Link<NetMsg> {}

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

/** Hands one typing-game transport from the lobby to the match session (net/link TransportSwitch, spec §5.3). */
export class TransportSwitch extends Switch<NetMsg> {}

/** The link to the other player in the lobby (net/link LobbyLink) for the typing game's messages. */
export class LobbyLink extends Lobby<NetMsg> {}
