import { emptyStats } from '../core/engine';
import { createScore } from '../core/scoring';
import { appendWordSet, createTurn, startTurn, turnClock, turnInput } from '../core/turn';
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
import {
  FreshEvents,
  KeyRate,
  OnlineLifecycle,
  onlineOverlay,
  Scoreboards,
  StallWatch,
  WaitTag,
  type Departure,
  type EndReason,
  type PeerLink,
  type Ticker,
} from './onlineLink';
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
  /** A toss pressed before its serve word set arrived, waiting for it (spec §5.3). */
  tossHeld: boolean;
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
 * desync and the host's version is shown. A `start` from the host begins a new match. The rules of
 * a match's end (forfeit, leave, rematch, a lost host) are the shared OnlineLifecycle's. Online play
 * never pauses.
 */
export class GuestSession implements Session {
  private readonly scheduler: Scheduler;
  private readonly life: OnlineLifecycle;
  private readonly link: PeerLink;
  private readonly wait = new WaitTag();
  private readonly boards = new Scoreboards();
  private readonly fresh = new FreshEvents();
  private readonly stall = new StallWatch();
  private queue: DisplayQueue;
  private rate = new KeyRate();
  /** The latest state from the host; the placeholder until the first one arrives. */
  private latest: PublicState;
  /** Highest turn id pushed to the display queue. */
  private lastPushed = 0;
  private own: OwnTurn | null = null;
  private seq = 0;
  private final: MatchState | null = null;
  private wantsRematch = false;
  private lastView: ViewModel | null = null;
  private malformedWarned = false;
  /** Power events the local runner already held, so host frame copies of them are dropped (engine-only power is kept). */
  private localPower = new Set<string>();

  /** Sets up the waiting view; only then takes the host's messages (earlier ones included). */
  constructor(opts: GuestSessionOptions) {
    this.scheduler = opts.scheduler;
    this.life = new OnlineLifecycle({
      transport: opts.transport,
      scheduler: opts.scheduler,
      message: (m) => this.onMessage(m),
      display: () => this.queue,
    });
    this.link = this.life.link;
    this.queue = new DisplayQueue(opts.scheduler.now());
    this.latest = waitingState(WAITING_CONFIG, [{ ...opts.me, name: '', kind: 'remote' }, opts.me]);
    this.life.open(opts.ticker ?? workerTicker, () => this.tick());
  }

  /** Why the match ended, or null while it is played. */
  get endReason(): EndReason | null {
    return this.life.reason;
  }

  /** How the host went away, or null while connected. */
  get opponentGone(): Departure | null {
    return this.link.gone;
  }

  /** True once the match has ended: at once for a forfeit, disconnect or leave; after the MATCH_OVER celebration otherwise. */
  get over(): boolean {
    return this.life.over;
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
   * is displayed and running, a letter or toss is pressed at τ = timeStamp − the turn's local start.
   * Keys stamped before the turn's start and tosses in a return turn are dropped; a toss whose serve
   * word set has not arrived yet waits for it (spec §5.3); an off-turn letter shows WAIT.
   */
  key(k: KeyClass, timeStamp: number): void {
    if (!this.life.playing || k.kind === 'ignore') return;
    const now = this.scheduler.now();
    const own = this.running();
    if (own === null) {
      if (k.kind === 'letter') this.wait.show(now);
      return;
    }
    const t = Number.isFinite(timeStamp) ? Math.min(timeStamp, now) : now;
    if (t < own.start) return;
    const r = own.runner;
    if (k.kind === 'toss') {
      if (r.data.kind !== 'serve') return;
      if (tossWaits(r, t - own.start)) {
        own.tossHeld = true;
        return;
      }
    }
    this.press(own, k.kind === 'toss' ? 'toss' : k.letter, t - own.start, now);
    this.step(now);
  }

  /** Online play never pauses: the menu opens over a running match. */
  pause(): void {}

  /** Online play never pauses, so there is nothing to resume. */
  resume(): void {}

  /** The guest gives up: the match ends at once, won by the host, who is told. */
  forfeit(): void {
    if (!this.life.playing) return;
    this.link.send({ type: 'forfeit' });
    this.concede(GUEST);
  }

  /** Asks the host for a rematch once the match is over; the host starts it when it wants one too. */
  rematch(): void {
    if (this.wantsRematch || !this.life.mayRematch) return;
    this.wantsRematch = true;
    this.link.send({ type: 'rematch', want: true });
  }

  /** Leaves the match (Menu, page hide): the host is told, and a match still being played ends as 'left'. */
  leave(): void {
    this.life.leave();
  }

  /** Leaves (if not yet), stops the ticker and closes the transport. */
  dispose(): void {
    this.life.dispose();
  }

  private tick(): void {
    if (this.life.disposed) return;
    const now = this.scheduler.now();
    this.link.tick(now);
    this.step(now);
    this.fresh.tick(this.queue, now);
    this.stall.update(this.queue.front, this.link.rttMs, now);
    if (this.own !== null && !this.own.checked && this.life.playing) this.sendClock(this.own, now);
  }

  /** Moves the match to `now`: the guest's own turn is clocked, the display advances, and an own turn it reaches starts. */
  private step(now: number): void {
    if (!this.life.showing) return;
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

  /**
   * Presses `key` at τ in the guest's own running turn: the local runner applies it, and the host gets
   * it as an `input`, after a `clock` with the runner's latest τ so that it clamps the key the same way.
   * Keys beyond 30 per second are dropped.
   */
  private press(own: OwnTurn, key: string, τ: number, now: number): void {
    const r = own.runner;
    const turn = r.data.turnId;
    if (!this.rate.allow(turn, τ)) return;
    this.sendClock(own, now);
    this.onOwnEvents(own, turnInput(r, key, τ));
    this.link.send({ type: 'input', seq: this.seq++, turn, k: key, τ });
    own.sent = Math.max(own.sent, r.τ);
  }

  /** A toss that waited for its word set is pressed now, if its turn still runs and the set has arrived (else it goes on waiting). */
  private releaseToss(own: OwnTurn): void {
    if (!own.tossHeld) return;
    if (this.running() !== own) {
      own.tossHeld = false;
      return;
    }
    const now = this.scheduler.now();
    if (tossWaits(own.runner, now - own.start)) return;
    own.tossHeld = false;
    this.press(own, 'toss', now - own.start, now);
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
    const own: OwnTurn = { entry, runner, start: entry.startedAt ?? this.scheduler.now(), sent: 0, outcome: null, checked: false, tossHeld: false };
    this.own = own;
    this.link.send({ type: 'clock', turn: runner.data.turnId, τ: 0 });
    this.onOwnEvents(own, events);
  }

  /** Events of the local runner: shown at once; its end is recorded for the desync check and ends the entry. */
  private onOwnEvents(own: OwnTurn, events: GameEvent[]): void {
    this.queue.hold(events);
    for (const e of events) {
      if (e.type === 'power') this.localPower.add(powerKey(e));
    }
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
    if (this.life.disposed) return;
    switch (m.type) {
      case 'frame':
        this.onFrame(m);
        return;
      case 'start':
        this.restart(m);
        return;
      case 'forfeit':
        if (this.life.playing) this.concede(other(GUEST));
        return;
      default:
        return;
    }
  }

  /**
   * A frame from the host. Without a state it is a clock confirmation only (spec §5.3): its (turn, τ)
   * confirms the playback of a host-owned turn. With one, that state becomes the latest; each new turn
   * in it is queued for display and known ones refreshed; its (turn, τ) confirms; its events are held
   * for the display, except those the guest's own runner already showed. A frame whose turn or last
   * turn is malformed is dropped (with one warning per session).
   */
  private onFrame(m: FrameMsg): void {
    if (!this.life.showing) return;
    const s = m.s;
    if (s === undefined) {
      this.queue.confirm(m.turn, m.τ);
      return;
    }
    if (!(isTurnShaped(s.turn) && isTurnShaped(s.lastTurn))) {
      if (!this.malformedWarned) console.warn('[bbt] dropped a frame with a malformed turn from the host', m.turn);
      this.malformedWarned = true;
      return;
    }
    this.latest = s;
    if (s.lastTurn !== null) this.offer(s.lastTurn);
    if (s.turn !== null) this.offer(s.turn);
    if (s.status === 'over') this.life.settle(s.forfeitBy);
    this.queue.confirm(m.turn, m.τ);
    if (m.ev !== undefined) this.queue.hold(m.ev.filter((e) => !this.shownLocally(e)));
  }

  /**
   * A turn from the host's latest state: queued if new, with the scoreboard of that state; otherwise its
   * display entry follows it (the guest's running own turn only takes new serve word sets, which may
   * release a waiting toss).
   */
  private offer(t: TurnState): void {
    const id = t.data.turnId;
    if (id > this.lastPushed) {
      this.lastPushed = id;
      this.boards.note(this.queue.push(t, t.data.owner === GUEST), this.latest);
      return;
    }
    const own = this.own;
    if (own === null || own.entry.turn.data.turnId !== id || own.entry.turn !== own.runner) {
      this.queue.update(t);
      return;
    }
    appendSets(own.runner, t);
    this.releaseToss(own);
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
    if (this.queue.get(e.turn)?.local !== true) return false;
    // Runner power was held locally; engine power (emptying a point's loser) was not.
    if (e.type === 'power') return this.localPower.has(powerKey(e));
    return !isEngineEvent(e);
  }

  /** A new match from the host: everything of the previous one is dropped. */
  private restart(m: StartMsg): void {
    const now = this.scheduler.now();
    this.queue = new DisplayQueue(now);
    this.rate = new KeyRate();
    this.lastPushed = 0;
    this.own = null;
    this.localPower.clear();
    this.life.reset();
    this.final = null;
    this.wantsRematch = false;
    const [host, guest] = this.latest.players;
    this.latest = waitingState(m.config, [
      { ...host, ...m.hostProfile },
      { ...guest, ...m.guestProfile },
    ]);
  }

  /** `player` forfeits: the latest state ends there, won by the other player (as the host's engine does). */
  private concede(player: PlayerId): void {
    this.latest = { ...this.latest, status: 'over', winner: other(player), forfeitBy: player };
    this.life.settle(player);
  }

  private buildView(now: number): ViewModel {
    const pub: PublicState = copy({ ...this.latest, turn: null, lastTurn: null });
    const f = this.queue.front;
    const p = this.queue.previous;
    pub.turn = f === null ? null : copy(f.turn);
    pub.lastTurn = p === null ? null : copy(p.turn);
    this.boards.show(pub, f);
    const own = this.own;
    const live = own !== null && f === own.entry && f.turn === own.runner;
    const vm: ViewModel = {
      pub,
      viewer: GUEST,
      turnτ: this.queue.τ,
      liveTurn: live ? pub.turn : null,
      early: null,
      events: this.fresh.release(this.queue, now),
      overlay: onlineOverlay(this.link, this.wait, now, this.stall.update(f, this.link.rttMs, now)),
    };
    this.lastView = vm;
    return vm;
  }
}

/** A state with no turn yet, for the view until the host's first frame. */
function waitingState(config: MatchConfig, players: [PlayerInfo, PlayerInfo]): PublicState {
  return {
    v: 2,
    config,
    players,
    score: createScore(config.format, config.deuceRule, 0),
    stats: [emptyStats(), emptyStats()],
    turn: null,
    lastTurn: null,
    rallyStrikes: 0,
    longestRally: 0,
    power: [0, 0],
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

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * True for null or a turn whose parts the guest reads have the right shape: the start data's kind,
 * owner and id (and a serve's word sets), the prompts, log and seen kinds, the ended flag and the
 * outcome (with a strike's word and landing). The protocol checks a frame's state at the top level
 * only, so this keeps a broken host from throwing in the guest's message handler.
 */
function isTurnShaped(t: unknown): boolean {
  if (t === null) return true;
  if (!isRec(t) || !isRec(t.data)) return false;
  const d = t.data;
  return (
    (d.kind === 'return' || (d.kind === 'serve' && Array.isArray(d.wordSets))) &&
    (d.owner === 0 || d.owner === 1) &&
    Number.isSafeInteger(d.turnId) &&
    Array.isArray(t.prompts) &&
    Array.isArray(t.log) &&
    Array.isArray(t.seenKinds) &&
    typeof t.ended === 'boolean' &&
    isOutcomeShaped(t.outcome)
  );
}

/** True for null or an outcome with a kind and a finite endτ (a strike's word and landing included). */
function isOutcomeShaped(o: unknown): boolean {
  if (o === null) return true;
  if (!isRec(o) || typeof o.kind !== 'string' || typeof o.endτ !== 'number' || !Number.isFinite(o.endτ)) return false;
  if (o.kind !== 'strike') return true;
  const s = o.strike;
  return isRec(s) && isRec(s.word) && isRec(s.shot) && isRec(s.shot.landing);
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

/**
 * True when a toss at τ would find the serve in PRE_SERVE without its word set (the host's new spare
 * has not arrived; spec §5.3: the toss waits for it). It is tried on a copy of the runner, so a catch
 * that ends before τ counts even when no tick or frame has clocked the runner past it yet, and ties
 * are decided as the runner (and the host's engine) will decide them.
 */
function tossWaits(runner: TurnState, τ: number): boolean {
  if (runner.data.kind !== 'serve') return false;
  const probe = copy(runner);
  turnInput(probe, 'toss', τ);
  return probe.phase === 'preServe' && probe.data.kind === 'serve' && probe.data.wordSets[probe.setIndex] === undefined;
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
 * point/game/set/match, and the ACE / WINNER / DOUBLE FAULT calls. A turn's runner emits every other
 * kind (including in-turn power changes); emptying a point's loser is engine-only and is kept via
 * `shownLocally`'s localPower set rather than this list.
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

/** Identity of a power event for dropping the host's copy of one the local runner already held. */
function powerKey(e: Extract<GameEvent, { type: 'power' }>): string {
  return `${e.turn}:${e.τ}:${e.player}:${e.from}:${e.to}`;
}

function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
