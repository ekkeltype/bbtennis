import { emptyStats } from '../core/engine';
import { createScore } from '../core/scoring';
import { appendWordSet, createTurn, startTurn, turnClock, turnInput } from '../core/turn';
import { TUNING } from '../core/tuning';
import type { KeyClass } from '../core/typing';
import {
  other,
  type GameEvent,
  type MatchConfig,
  type MatchState,
  type PlayerId,
  type PlayerInfo,
  type PublicState,
  type TurnOutcome,
  type TurnState,
  type ViewModel,
} from '../core/types';
import type { NetMsg } from '../net/protocol';
import type { Transport } from '../net/transport';
import type { Scheduler } from './clock';
import { DisplayQueue, type DisplayEntry } from './displayQueue';
import { KeyRate, onlineOverlay, PeerLink, TICK_MS, WaitTag, type Departure, type EndReason, type Ticker } from './hostSession';
import { workerTicker } from './loop';
import type { Session } from './session';

const GUEST: PlayerId = 1;

type FrameMsg = Extract<NetMsg, { type: 'frame' }>;
type StartMsg = Extract<NetMsg, { type: 'start' }>;

/** The match options shown until the host's `start` or first state arrives. */
const WAITING_CONFIG: MatchConfig = {
  format: 'tiebreak',
  pace: 'normal',
  surface: 'hard',
  wordPack: 'everyday',
  deuceRule: 'advantage',
  training: null,
};

/** What the guest compares with the host's result of the guest's own turn (brief: desync check). */
interface OutcomeSummary {
  kind: TurnOutcome['kind'];
  endτ: number;
  word: string | null;
  option: number | null;
  landing: { x: number; y: number } | null;
}

/** The guest's own turn, run by a local TurnRunner (spec §5.3 guest-owned turns). */
interface OwnTurn {
  entry: DisplayEntry;
  runner: TurnState;
  /** Local time of the turn's τ 0 (when it became the display front). */
  start: number;
  /** Highest τ the host has been sent (clock or input) for this turn. */
  sent: number;
  /** The runner's outcome once it has ended. */
  outcome: OutcomeSummary | null;
  /** True once the host's result for the turn has been compared. */
  checked: boolean;
}

/** How to set up the guest's side of an online match. */
export interface GuestSessionOptions {
  transport: Transport;
  scheduler: Scheduler;
  /** The guest's own player, shown until the host's first state arrives. */
  me: PlayerInfo;
  /** Runs the 50 ms tick; defaults to `workerTicker`, which keeps going in a hidden tab. */
  ticker?: Ticker;
}

/**
 * The guest's side of an online match (spec §5.3). The guest has no engine: it shows the host's
 * `frame`s, queuing each new turn for display. A host-owned turn plays back behind the host's
 * confirmed τ. A guest-owned turn starts when it becomes the display front (the previous turn has
 * finished playing here): the guest runs it in a local TurnRunner from the turn's start data, with its
 * own clock and instant feedback, and streams `input`s and `clock`s to the host, whose engine replays
 * them. The host's result of each own turn is compared with the local one; a mismatch is logged as a
 * desync and the host's version is shown. A `start` from the host begins a new match. Online play
 * never pauses.
 */
export class GuestSession implements Session {
  private readonly scheduler: Scheduler;
  private readonly link: PeerLink;
  private readonly wait = new WaitTag();
  private readonly stopTicker: () => void;
  private queue: DisplayQueue;
  private rate = new KeyRate();
  /** The latest state from the host; the placeholder until the first one arrives. */
  private latest: PublicState;
  /** Highest turn id pushed to the display queue. */
  private lastPushed = 0;
  private own: OwnTurn | null = null;
  private seq = 0;
  private reason: EndReason | null = null;
  private final: MatchState | null = null;
  private wantsRematch = false;
  private lastView: ViewModel | null = null;
  private disposed = false;

  constructor(opts: GuestSessionOptions) {
    this.scheduler = opts.scheduler;
    this.queue = new DisplayQueue(opts.scheduler.now());
    this.latest = waitingState(WAITING_CONFIG, [{ ...opts.me, name: '', kind: 'remote' }, opts.me]);
    this.link = new PeerLink(opts.transport, opts.scheduler, {
      message: (m) => this.onMessage(m),
      gone: (why) => this.onGone(why),
    });
    this.stopTicker = (opts.ticker ?? workerTicker)(TICK_MS, () => this.tick());
  }

  /** Why the match ended, or null while it is played. */
  get endReason(): EndReason | null {
    return this.reason;
  }

  /** How the host went away, or null while connected. */
  get opponentGone(): Departure | null {
    return this.link.gone;
  }

  /** True once the match has ended: at once for a forfeit, disconnect or leave; after the MATCH_OVER celebration otherwise. */
  get over(): boolean {
    const r = this.reason;
    if (r === null) return false;
    if (r !== 'finished') return true;
    const at = this.queue.finishedAt;
    return at !== null && this.scheduler.now() - at >= TUNING.leadIn.matchOverMs;
  }

  /** The final state (as the guest sees it) once `over`, else null. */
  get result(): MatchState | null {
    if (!this.over) return null;
    this.final ??= copy(this.latest);
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
   * A guest key at `timeStamp` (a future or non-finite one counts as now): while the guest's own turn
   * is displayed and running, a letter or toss goes to the local runner at τ = timeStamp − the turn's
   * local start and then to the host as an `input` (after a `clock` with the runner's latest τ, so the
   * host clamps it the same way). Keys beyond 30 per second, keys stamped before the turn's start and
   * a toss whose word set has not arrived yet are dropped; an off-turn letter shows WAIT.
   */
  key(k: KeyClass, timeStamp: number): void {
    if (this.disposed || this.reason !== null || k.kind === 'ignore') return;
    const now = this.scheduler.now();
    const own = this.running();
    if (own === null) {
      if (k.kind === 'letter') this.wait.show(now);
      return;
    }
    const t = Number.isFinite(timeStamp) ? Math.min(timeStamp, now) : now;
    if (t < own.start) return;
    const r = own.runner;
    if (k.kind === 'toss' && (r.data.kind !== 'serve' || (r.phase === 'preServe' && r.data.wordSets[r.setIndex] === undefined))) return;
    const key = k.kind === 'toss' ? 'toss' : k.letter;
    const turn = r.data.turnId;
    const τ = t - own.start;
    if (!this.rate.allow(turn, τ)) return;
    this.sendClock(own, now);
    this.onOwnEvents(own, turnInput(r, key, τ));
    this.link.send({ type: 'input', seq: this.seq++, turn, k: key, τ });
    own.sent = Math.max(own.sent, r.τ);
    this.step(now);
  }

  /** Online play never pauses: the menu opens over a running match. */
  pause(): void {}

  /** Online play never pauses, so there is nothing to resume. */
  resume(): void {}

  /** The guest gives up: the match ends at once, won by the host, who is told. */
  forfeit(): void {
    if (this.disposed || this.reason !== null) return;
    this.link.send({ type: 'forfeit' });
    this.concede(GUEST);
  }

  /** Asks the host for a rematch once the match is over; the host starts it when it wants one too. */
  rematch(): void {
    if (this.disposed || this.wantsRematch || !this.over || this.link.gone !== null) return;
    if (this.reason !== 'finished' && this.reason !== 'forfeit') return;
    this.wantsRematch = true;
    this.link.send({ type: 'rematch', want: true });
  }

  /** Leaves the match (Menu, page hide): the host is told, and a match still being played ends as 'left'. */
  leave(): void {
    if (this.disposed) return;
    this.link.leave();
    this.reason ??= 'left';
  }

  /** Leaves (if not yet), stops the ticker and closes the transport. */
  dispose(): void {
    if (this.disposed) return;
    this.leave();
    this.disposed = true;
    this.stopTicker();
    this.link.close();
  }

  private tick(): void {
    if (this.disposed) return;
    const now = this.scheduler.now();
    this.link.tick(now);
    this.step(now);
    if (this.own !== null && !this.own.checked && this.reason === null) this.sendClock(this.own, now);
  }

  /** Moves the match to `now`: the guest's own turn is clocked, the display advances, and an own turn it reaches starts. */
  private step(now: number): void {
    if (this.disposed || (this.reason !== null && this.reason !== 'finished')) return;
    const own = this.running();
    if (own !== null) {
      const events = turnClock(own.runner, now - own.start);
      if (events.length > 0) {
        this.onOwnEvents(own, events);
        this.sendClock(own, now);
      }
    }
    for (const entry of this.queue.advance(now)) if (entry.local) this.startOwn(entry);
  }

  /** The guest's own turn that is displayed and still running locally, if any. */
  private running(): OwnTurn | null {
    const own = this.own;
    if (own === null || this.queue.front !== own.entry || own.entry.turn !== own.runner || own.runner.ended) return null;
    return own;
  }

  /** The guest's turn is displayed: a local runner starts from its start data now (τ 0), and the host hears clock 0. */
  private startOwn(entry: DisplayEntry): void {
    const runner = createTurn(entry.turn.data);
    runner.seenKinds = [...entry.turn.seenKinds];
    const events = startTurn(runner);
    entry.turn = runner;
    const own: OwnTurn = { entry, runner, start: entry.startedAt ?? this.scheduler.now(), sent: 0, outcome: null, checked: false };
    this.own = own;
    this.link.send({ type: 'clock', turn: runner.data.turnId, τ: 0 });
    this.onOwnEvents(own, events);
  }

  /** Events of the local runner: shown at once; its end is recorded for the desync check and ends the entry. */
  private onOwnEvents(own: OwnTurn, events: GameEvent[]): void {
    this.queue.hold(events);
    const outcome = own.runner.outcome;
    if (!own.runner.ended || own.outcome !== null || outcome === null) return;
    own.outcome = summary(outcome);
    this.queue.update(own.runner);
  }

  /**
   * Tells the host the own turn's clock: the runner's τ while it runs (every τ the runner was clocked
   * to reaches the host before the next input), then the live τ until the host's result arrives, so a
   * host that has not ended the turn yet still gets there.
   */
  private sendClock(own: OwnTurn, now: number): void {
    const τ = own.runner.ended ? now - own.start : own.runner.τ;
    if (τ <= own.sent) return;
    own.sent = τ;
    this.link.send({ type: 'clock', turn: own.runner.data.turnId, τ });
  }

  private onMessage(m: NetMsg): void {
    if (this.disposed) return;
    switch (m.type) {
      case 'frame':
        this.onFrame(m);
        return;
      case 'start':
        this.restart(m);
        return;
      case 'forfeit':
        if (this.reason === null) this.concede(other(GUEST));
        return;
      default:
        return;
    }
  }

  /**
   * A frame from the host: its state becomes the latest one; each new turn in it is queued for display
   * and known ones refreshed; its (turn, τ) confirms the playback of a host-owned turn; its events are
   * held for the display, except those the guest's own runner already showed.
   */
  private onFrame(m: FrameMsg): void {
    if (this.reason !== null && this.reason !== 'finished') return;
    const s = m.s;
    if (s !== undefined) {
      this.latest = s;
      if (s.lastTurn !== null) this.offer(s.lastTurn);
      if (s.turn !== null) this.offer(s.turn);
      if (s.status === 'over' && this.reason === null) {
        this.reason = s.forfeitBy === null ? 'finished' : 'forfeit';
        this.queue.end();
      }
    }
    this.queue.confirm(m.turn, m.τ);
    if (m.ev !== undefined) this.queue.hold(m.ev.filter((e) => !this.shownLocally(e)));
  }

  /** A turn from the host's state: queued if new; otherwise its display entry follows it (the guest's running own turn only takes new serve word sets). */
  private offer(t: TurnState): void {
    const id = t.data.turnId;
    if (id > this.lastPushed) {
      this.lastPushed = id;
      this.queue.push(t, t.data.owner === GUEST);
      return;
    }
    const own = this.own;
    if (own === null || own.entry.turn.data.turnId !== id || own.entry.turn !== own.runner) {
      this.queue.update(t);
      return;
    }
    appendSets(own.runner, t);
    if (t.ended && !own.checked) this.check(own, t);
  }

  /** Compares the host's result of the guest's own turn with the local one; on a mismatch the host's version is shown. */
  private check(own: OwnTurn, host: TurnState): void {
    own.checked = true;
    const theirs = host.outcome === null ? null : summary(host.outcome);
    if (JSON.stringify(own.outcome) === JSON.stringify(theirs)) return;
    console.warn('[bbt] desync', { turn: host.data.turnId, guest: own.outcome, host: theirs });
    this.queue.update(host);
  }

  /** True for a host event of a guest-owned turn that the guest's runner emitted itself (only engine events are new). */
  private shownLocally(e: GameEvent): boolean {
    return this.queue.get(e.turn)?.local === true && !isEngineEvent(e);
  }

  /** A new match from the host: everything of the previous one is dropped. */
  private restart(m: StartMsg): void {
    const now = this.scheduler.now();
    this.queue = new DisplayQueue(now);
    this.rate = new KeyRate();
    this.lastPushed = 0;
    this.own = null;
    this.reason = null;
    this.final = null;
    this.wantsRematch = false;
    const [host, guest] = this.latest.players;
    this.latest = waitingState(m.config, [
      { ...host, ...m.hostProfile },
      { ...guest, ...m.guestProfile },
    ]);
  }

  private onGone(why: Departure): void {
    this.reason ??= why === 'left' ? 'left' : 'disconnect';
  }

  /** `player` forfeits: the latest state ends there, won by the other player (as the host's engine does). */
  private concede(player: PlayerId): void {
    this.latest = { ...this.latest, status: 'over', winner: other(player), forfeitBy: player };
    this.reason = 'forfeit';
    this.queue.end();
  }

  private buildView(now: number): ViewModel {
    const pub: PublicState = copy({ ...this.latest, turn: null, lastTurn: null });
    const f = this.queue.front;
    const p = this.queue.previous;
    pub.turn = f === null ? null : copy(f.turn);
    pub.lastTurn = p === null ? null : copy(p.turn);
    const own = this.own;
    const live = own !== null && f === own.entry && f.turn === own.runner;
    const vm: ViewModel = {
      pub,
      viewer: GUEST,
      turnτ: this.queue.τ,
      liveTurn: live ? pub.turn : null,
      events: this.queue.release(),
      overlay: onlineOverlay(this.link, this.wait, now),
    };
    this.lastView = vm;
    return vm;
  }
}

/** A state with no turn yet, for the view until the host's first frame. */
function waitingState(config: MatchConfig, players: [PlayerInfo, PlayerInfo]): PublicState {
  return {
    v: 1,
    config,
    players,
    score: createScore(config.format, config.deuceRule, 0),
    stats: [emptyStats(), emptyStats()],
    turn: null,
    lastTurn: null,
    rallyStrikes: 0,
    longestRally: 0,
    pointNo: 0,
    status: 'playing',
    winner: null,
    forfeitBy: null,
    nextTurnId: 1,
    nextPromptBase: 1,
    rng: null,
    picker: null,
  };
}

function summary(o: TurnOutcome): OutcomeSummary {
  const strike = o.kind === 'strike' ? o.strike : null;
  return {
    kind: o.kind,
    endτ: o.endτ,
    word: strike?.word.word ?? null,
    option: strike?.option ?? null,
    landing: strike === null ? null : { x: strike.shot.landing.x, y: strike.shot.landing.y },
  };
}

/** Appends the serve word sets the host has added (after catches) that the local runner lacks. */
function appendSets(runner: TurnState, host: TurnState): void {
  if (runner.data.kind !== 'serve' || host.data.kind !== 'serve') return;
  for (let i = runner.data.wordSets.length; i < host.data.wordSets.length; i++) {
    const set = host.data.wordSets[i];
    if (set !== undefined) appendWordSet(runner, set);
  }
}

/**
 * Events only the engine emits, between a turn's runner calls: the coin toss, the situation banner,
 * point/game/set/match, and the ACE / WINNER / DOUBLE FAULT calls. A turn's runner emits every other kind.
 */
function isEngineEvent(e: GameEvent): boolean {
  switch (e.type) {
    case 'coinToss':
    case 'situation':
    case 'point':
    case 'game':
    case 'set':
    case 'match':
      return true;
    case 'call':
      return e.call === 'ace' || e.call === 'winner' || e.call === 'doubleFault';
    default:
      return false;
  }
}

function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
