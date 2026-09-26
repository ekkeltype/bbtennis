import { Engine } from '../core/engine';
import { redact, redactEvents, redactTurn } from '../core/redact';
import { forkSeed } from '../core/rng';
import type { KeyClass } from '../core/typing';
import type { GameEvent, MatchConfig, MatchState, PlayerId, PlayerInfo, ViewModel } from '../core/types';
import { MAX_SEND_BYTES, msgBytes, type NetMsg } from '../net/protocol';
import type { Transport } from '../net/transport';
import type { Scheduler } from './clock';
import { DisplayQueue, type DisplayEntry } from './displayQueue';
import { workerTicker } from './loop';
import {
  KeyRate,
  OnlineLifecycle,
  onlineOverlay,
  Scoreboards,
  WaitTag,
  type Departure,
  type EndReason,
  type PeerLink,
  type Ticker,
} from './onlineLink';
import type { Session } from './session';

/** Frames during a turn the host does not clock: host-side updates only (brief: every 250 ms). */
const IDLE_FRAME_MS = 250;
/** Frames without events are skipped while this many bytes wait to be sent (spec §5.3). */
const FRAME_BACKLOG_BYTES = 16 * 1024;
/** A frame over the size cap keeps only this many of lastTurn's log entries. */
const KEEP_LOG = 200;

const HOST: PlayerId = 0;
const GUEST: PlayerId = 1;

type FrameMsg = Extract<NetMsg, { type: 'frame' }>;
type GuestTurnMsg = Extract<NetMsg, { type: 'input' } | { type: 'clock' }>;

/** Keeps the host's frames within MAX_SEND_BYTES: a frame over it keeps only the last 200 entries of lastTurn's log (warned once). */
export class FrameFit {
  private warned = false;

  /** Trims `frame` in place when it is over the size cap. */
  fit(frame: FrameMsg): void {
    const last = frame.s?.lastTurn;
    if (last === null || last === undefined || last.log.length <= KEEP_LOG) return;
    const bytes = msgBytes(frame);
    if (bytes <= MAX_SEND_BYTES) return;
    last.log = last.log.slice(-KEEP_LOG);
    if (this.warned) return;
    this.warned = true;
    console.warn('[bbt] frame over the size cap: trimmed the last turn\'s log', bytes);
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
 * turn, the one before it and the displayed turn's scoreboard. Each match opens with `start`;
 * `rematch`, `forfeit` and `leave` end or renew it (their rules are the shared OnlineLifecycle's).
 * Online play never pauses.
 */
export class HostSession implements Session {
  private readonly config: MatchConfig;
  private readonly players: [PlayerInfo, PlayerInfo];
  private readonly seed: number;
  private readonly scheduler: Scheduler;
  private readonly life: OnlineLifecycle;
  private readonly link: PeerLink;
  private readonly wait = new WaitTag();
  private readonly boards = new Scoreboards();
  private engine!: Engine;
  private queue!: DisplayQueue;
  private rate = new KeyRate();
  private matchNo = 0;
  /** Highest turn id pushed to the display queue. */
  private lastPushed = 0;
  private lastFrameAt = Number.NEGATIVE_INFINITY;
  private readonly fitter = new FrameFit();
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

  /** The 50 ms tick: heartbeat, the match moved on, and a frame unless one has just gone out. */
  private tick(): void {
    if (this.life.disposed) return;
    const now = this.scheduler.now();
    this.link.tick(now);
    this.step(now);
    if (!this.life.playing || this.lastFrameAt >= now) return;
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

  /** Queues each new engine turn for display (with the scoreboard it was created with), refreshes ended ones, and notes the match's end. */
  private track(): void {
    const s = this.engine.state;
    for (const t of [s.lastTurn, s.turn]) {
      if (t === null) continue;
      if (t.data.turnId > this.lastPushed) {
        this.boards.note(this.queue.push(t, t.data.owner === HOST), s);
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
    this.fitter.fit(frame);
    this.link.send(frame);
    this.lastFrameAt = this.scheduler.now();
  }

  private buildView(now: number): ViewModel {
    const state = this.engine.state;
    const pub = redact({ ...state, turn: null, lastTurn: null }, HOST);
    const f = this.queue.front;
    const p = this.queue.previous;
    pub.turn = f === null ? null : redactTurn(f.turn, HOST);
    pub.lastTurn = p === null ? null : redactTurn(p.turn, HOST);
    this.boards.show(pub, f);
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
