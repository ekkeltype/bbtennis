import { Engine } from '../core/engine';
import { redact, redactEvents, redactTurn } from '../core/redact';
import { forkSeed } from '../core/rng';
import { TUNING } from '../core/tuning';
import type { KeyClass } from '../core/typing';
import type { GameEvent, MatchConfig, MatchState, Overlay, PlayerId, PlayerInfo, ViewModel } from '../core/types';
import { MAX_SEND_BYTES, msgBytes, type NetMsg } from '../net/protocol';
import type { Transport } from '../net/transport';
import type { Scheduler } from './clock';
import { DisplayQueue, type DisplayEntry } from './displayQueue';
import { workerTicker } from './loop';
import type { Session } from './session';

/** Calls `fn` every `ms` until the returned stop() (the shape of `workerTicker` and `Scheduler.every`). */
export type Ticker = (ms: number, fn: () => void) => () => void;

/** Why an online match ended: played out, a forfeit, a lost link, or a player who left. */
export type EndReason = 'finished' | 'forfeit' | 'disconnect' | 'left';

/** How the opponent went away: a `leave` message, or a closed or silent link. */
export type Departure = 'left' | 'disconnect';

/** Period of an online session's tick: clocks, frames, heartbeat (spec §5.2 Worker ticker). */
export const TICK_MS = 50;
/** Frames during a turn the host does not clock: host-side updates only (brief: every 250 ms). */
const IDLE_FRAME_MS = 250;
/** Frames without events are skipped while this many bytes wait to be sent (spec §5.3). */
const FRAME_BACKLOG_BYTES = 16 * 1024;
/** A frame over the size cap keeps only this many of lastTurn's log entries. */
const KEEP_LOG = 200;
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

const HOST: PlayerId = 0;
const GUEST: PlayerId = 1;

type FrameMsg = Extract<NetMsg, { type: 'frame' }>;
type GuestTurnMsg = Extract<NetMsg, { type: 'input' } | { type: 'clock' }>;

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
 * At most 30 keys per second of a turn's clock (spec §5.3): a key at τ is allowed while fewer than 30
 * allowed keys of the same turn lie in (τ − 1 s, τ]. The guest limits the keys it applies and the
 * host the guest inputs it receives by this same rule on the same (turn, τ) stream, so the host never
 * drops an input the guest applied.
 */
export class KeyRate {
  private turn: number | null = null;
  private times: number[] = [];

  /** Whether a key of turn `turn` at τ is allowed; an allowed one counts against later keys. */
  allow(turn: number, τ: number): boolean {
    if (turn !== this.turn) {
      this.turn = turn;
      this.times = [];
    }
    const recent = this.times.filter((t) => t > τ - KEY_WINDOW_MS && t <= τ).length;
    if (recent >= MAX_KEYS) return false;
    this.times.push(τ);
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

/** The overlay of an online session: never paused, no hints; WAIT, "Connection unstable…" and the RTT. */
export function onlineOverlay(link: PeerLink, wait: WaitTag, now: number): Overlay {
  return {
    paused: false,
    countdown: null,
    coach: null,
    wait: wait.on(now),
    unstable: link.unstable(now),
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
  private stopTicker: () => void = () => {};

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

  /** Starts taking messages (any that came earlier arrive now) and runs `tick` every 50 ms; once, when the session is ready. */
  open(ticker: Ticker, tick: () => void): void {
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
    this.stopTicker();
    this.link.close();
  }
}

/** How to set up the host's side of an online match. */
export interface HostSessionOptions {
  transport: Transport;
  config: MatchConfig;
  /** The host: player 0 at end 0. */
  host: PlayerInfo;
  /** The guest: player 1 at end 1. */
  guest: PlayerInfo;
  /** Seed of the first match (a rematch derives a fresh one); it never leaves the host. */
  seed: number;
  scheduler: Scheduler;
  /** Runs the 50 ms tick; defaults to `workerTicker`, which keeps going in a hidden tab. */
  ticker?: Ticker;
}

/**
 * The host's side of an online match (spec §5.3): it runs the only Engine. Each turn is clocked on its
 * owner's machine: a host-owned turn starts when the host's display reaches it (the previous turn has
 * finished playing here) and runs on the local clock, streaming `frame`s every 50 ms and on every
 * event; a guest-owned turn is never clocked here: the engine starts it on the guest's first `clock`
 * or `input` and applies them in arrival order, and the host watches it in passive playback. The
 * display queue decides what the host sees; `pub` is the host's redacted state with the displayed
 * turn and the one before it. Each match opens with `start`; `rematch`, `forfeit` and `leave` end or
 * renew it (their rules are the shared OnlineLifecycle's). Online play never pauses.
 */
export class HostSession implements Session {
  private readonly config: MatchConfig;
  private readonly players: [PlayerInfo, PlayerInfo];
  private readonly seed: number;
  private readonly scheduler: Scheduler;
  private readonly life: OnlineLifecycle;
  private readonly link: PeerLink;
  private readonly wait = new WaitTag();
  private engine!: Engine;
  private queue!: DisplayQueue;
  private rate = new KeyRate();
  private matchNo = 0;
  /** Highest turn id pushed to the display queue. */
  private lastPushed = 0;
  private lastFrameAt = Number.NEGATIVE_INFINITY;
  private trimWarned = false;
  private final: MatchState | null = null;
  private wants: [boolean, boolean] = [false, false];
  private lastView: ViewModel | null = null;

  /** Sets up the first match and tells the guest; only then takes the guest's messages (earlier ones included). */
  constructor(opts: HostSessionOptions) {
    this.config = opts.config;
    this.players = [opts.host, opts.guest];
    this.seed = opts.seed;
    this.scheduler = opts.scheduler;
    this.life = new OnlineLifecycle({
      transport: opts.transport,
      scheduler: opts.scheduler,
      message: (m) => this.onMessage(m),
      display: () => this.queue,
    });
    this.link = this.life.link;
    this.newMatch(opts.seed);
    this.life.open(opts.ticker ?? workerTicker, () => this.tick());
  }

  /** Why the match ended, or null while it is played. */
  get endReason(): EndReason | null {
    return this.life.reason;
  }

  /** How the guest went away, or null while connected. */
  get opponentGone(): Departure | null {
    return this.link.gone;
  }

  /** True once the match has ended: at once for a forfeit, disconnect or leave; after the MATCH_OVER celebration otherwise. */
  get over(): boolean {
    return this.life.over;
  }

  /** The final state (as the host sees it) once `over`, else null. */
  get result(): MatchState | null {
    if (!this.over) return null;
    this.final ??= redact(this.engine.state, HOST);
    return this.final;
  }

  /** The latest frame's view model, or null before the first frame. */
  get view(): ViewModel | null {
    return this.lastView;
  }

  frame(_dtMs: number): ViewModel {
    const now = this.scheduler.now();
    this.step(now);
    return this.buildView(now);
  }

  /**
   * A host key at `timeStamp` (a future or non-finite one counts as now): a letter or toss goes to the
   * engine at τ = timeStamp − the turn's local start while the host's own turn is displayed and
   * running; keys stamped before that start are dropped, and an off-turn letter shows WAIT.
   */
  key(k: KeyClass, timeStamp: number): void {
    if (!this.life.playing || k.kind === 'ignore') return;
    const now = this.scheduler.now();
    const f = this.queue.front;
    const turn = this.engine.state.turn;
    if (f === null || !f.local || f.startedAt === null || turn !== f.turn || !turn.started || turn.ended) {
      if (k.kind === 'letter') this.wait.show(now);
      return;
    }
    const t = Number.isFinite(timeStamp) ? Math.min(timeStamp, now) : now;
    if (t < f.startedAt) return;
    if (k.kind === 'toss' && turn.data.kind !== 'serve') return;
    this.absorb(this.engine.input(HOST, k.kind === 'toss' ? 'toss' : k.letter, t - f.startedAt));
    this.step(now);
  }

  /** Online play never pauses: the menu opens over a running match. */
  pause(): void {}

  /** Online play never pauses, so there is nothing to resume. */
  resume(): void {}

  /** The host gives up: the match ends at once, won by the guest, who is told. */
  forfeit(): void {
    if (!this.life.playing) return;
    this.concede(HOST);
    this.link.send({ type: 'forfeit' });
  }

  /** Asks for a rematch once the match is over; a new match starts when the guest wants one too. */
  rematch(): void {
    if (this.wants[HOST] || !this.life.mayRematch) return;
    this.wants[HOST] = true;
    this.link.send({ type: 'rematch', want: true });
    this.maybeRematch();
  }

  /** Leaves the match (Menu, page hide): the guest is told, and a match still being played ends as 'left'. */
  leave(): void {
    this.life.leave();
  }

  /** Leaves (if not yet), stops the ticker and closes the transport. */
  dispose(): void {
    this.life.dispose();
  }

  /** A fresh engine, display and bookkeeping; the guest hears `start`, then the first frame. */
  private newMatch(seed: number): void {
    const [host, guest] = this.players;
    this.engine = new Engine({ config: this.config, players: this.players, seed });
    this.queue = new DisplayQueue(this.scheduler.now());
    this.rate = new KeyRate();
    this.lastPushed = 0;
    this.life.reset();
    this.final = null;
    this.wants = [false, false];
    this.link.send({
      type: 'start',
      config: this.config,
      hostProfile: { name: host.name, look: host.look },
      guestProfile: { name: guest.name, look: guest.look },
    });
    this.track();
    this.sendFrame([]);
    this.step(this.scheduler.now());
  }

  private tick(): void {
    if (this.life.disposed) return;
    const now = this.scheduler.now();
    this.link.tick(now);
    this.step(now);
    if (!this.life.playing) return;
    const t = this.engine.state.turn;
    const clocking = t !== null && t.started && t.data.owner === HOST;
    if (clocking || now - this.lastFrameAt >= IDLE_FRAME_MS) this.sendFrame([]);
  }

  /** Moves the match to `now`: the host's own turn is clocked, the display advances, and a host turn it reaches starts. */
  private step(now: number): void {
    if (!this.life.showing) return;
    const f = this.queue.front;
    const turn = this.engine.state.turn;
    if (f !== null && f.local && f.startedAt !== null && turn === f.turn && turn.started) {
      this.absorb(this.engine.clock(HOST, now - f.startedAt));
    }
    for (const entry of this.queue.advance(now)) if (entry.local) this.startOwn(entry);
  }

  /** The host's turn is displayed: its clock starts now (τ 0). */
  private startOwn(entry: DisplayEntry): void {
    if (this.engine.state.turn === entry.turn) this.absorb(this.engine.start(HOST));
  }

  private onMessage(m: NetMsg): void {
    if (this.life.disposed) return;
    switch (m.type) {
      case 'input':
      case 'clock':
        this.onGuestTurn(m);
        return;
      case 'rematch':
        this.wants[GUEST] = m.want;
        this.maybeRematch();
        return;
      case 'forfeit':
        if (this.life.playing) this.concede(GUEST);
        return;
      default:
        return;
    }
  }

  /**
   * The guest's input or clock for its current turn, applied in arrival order (the first one starts
   * the turn); anything for another turn id or a turn the guest does not own is stale and dropped,
   * as are inputs beyond 30 per second. An applied clock confirms the host's playback of the turn.
   */
  private onGuestTurn(m: GuestTurnMsg): void {
    const t = this.engine.state.turn;
    if (!this.life.playing || t === null || t.data.turnId !== m.turn || t.data.owner !== GUEST) return;
    if (!t.started) this.absorb(this.engine.start(GUEST));
    if (m.type === 'input') {
      if (this.rate.allow(m.turn, m.τ)) this.absorb(this.engine.input(GUEST, m.k, m.τ));
      return;
    }
    this.absorb(this.engine.clock(GUEST, m.τ));
    this.queue.confirm(m.turn, m.τ);
  }

  /** `player` forfeits: the engine ends the match and the guest gets the final frame. */
  private concede(player: PlayerId): void {
    this.absorb(this.engine.forfeit(player));
  }

  private maybeRematch(): void {
    if (!this.wants[HOST] || !this.wants[GUEST] || !this.life.mayRematch) return;
    this.matchNo++;
    this.newMatch(forkSeed(this.seed, this.matchNo));
  }

  /** Engine events: held for the display, turns tracked, and sent to the guest at once. */
  private absorb(events: GameEvent[]): void {
    if (events.length === 0) return;
    this.queue.hold(events);
    this.track();
    this.sendFrame(events);
  }

  /** Queues each new engine turn for display, refreshes ended ones, and notes the match's end. */
  private track(): void {
    const s = this.engine.state;
    for (const t of [s.lastTurn, s.turn]) {
      if (t === null) continue;
      if (t.data.turnId > this.lastPushed) {
        this.queue.push(t, t.data.owner === HOST);
        this.lastPushed = t.data.turnId;
      } else {
        this.queue.update(t);
      }
    }
    if (s.status === 'over') this.life.settle(s.forfeitBy);
  }

  /**
   * Sends `frame{turn, τ, ev?, s}`: s = the state redacted for the guest, ev = these events, and
   * (turn, τ) the host's latest confirmed turn clock (the started current turn, else the last one).
   * A frame without events is skipped while the send backlog is over 16 KB.
   */
  private sendFrame(events: GameEvent[]): void {
    if (events.length === 0 && this.link.bufferedAmount > FRAME_BACKLOG_BYTES) return;
    const state = this.engine.state;
    const t = state.turn?.started === true ? state.turn : state.lastTurn ?? state.turn;
    const frame: FrameMsg = { type: 'frame', turn: t?.data.turnId ?? 0, τ: t?.τ ?? 0, s: redact(state, GUEST) };
    if (events.length > 0) frame.ev = redactEvents(events, state, GUEST);
    this.fit(frame);
    this.link.send(frame);
    this.lastFrameAt = this.scheduler.now();
  }

  /** A frame over MAX_SEND_BYTES keeps only the last 200 entries of lastTurn's log (warned once). */
  private fit(frame: FrameMsg): void {
    const last = frame.s?.lastTurn;
    if (last === null || last === undefined || last.log.length <= KEEP_LOG) return;
    const bytes = msgBytes(frame);
    if (bytes <= MAX_SEND_BYTES) return;
    last.log = last.log.slice(-KEEP_LOG);
    if (this.trimWarned) return;
    this.trimWarned = true;
    console.warn('[bbt] frame over the size cap: trimmed the last turn\'s log', bytes);
  }

  private buildView(now: number): ViewModel {
    const state = this.engine.state;
    const pub = redact({ ...state, turn: null, lastTurn: null }, HOST);
    const f = this.queue.front;
    const p = this.queue.previous;
    pub.turn = f === null ? null : redactTurn(f.turn, HOST);
    pub.lastTurn = p === null ? null : redactTurn(p.turn, HOST);
    const vm: ViewModel = {
      pub,
      viewer: HOST,
      turnτ: this.queue.τ,
      liveTurn: null,
      events: redactEvents(this.queue.release(), state, HOST),
      overlay: onlineOverlay(this.link, this.wait, now),
    };
    this.lastView = vm;
    return vm;
  }
}
