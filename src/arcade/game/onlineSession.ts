import type { Profile } from '../../core/types';
import type { Scheduler } from '../../game/clock';
import { workerTicker } from '../../game/loop';
import type { Transport } from '../../net/channel';
import { parseProfile } from '../../net/fields';
import { PeerLink, type Departure } from '../../net/link';
import { createMatch, finished } from '../core/match';
import { DT, TICK_HZ } from '../core/tuning';
import type { ArcadeConfig, ArcadeEvent, ArcadeState, Controller, PlayerId, PlayerInfo } from '../core/types';
import { MAX_INPUTS_PER_MSG, packInput, unpackInput, type ArcadeMsg } from '../net/protocol';
import { cloneState, Rollback } from './rollback';
import type { ArcadeView } from './session';
import { TimeSync } from './timeSync';

export type { Departure };

/** Calls `fn` every `ms` until the returned stop() (a Worker ticker in the browser). */
export type Ticker = (ms: number, fn: () => void) => () => void;

/** Why an online match ended: played out, a forfeit, a lost link, or a player who left (online spec §3.6). */
export type OnlineEnd = 'finished' | 'forfeit' | 'disconnect' | 'left';

/** How often the session pumps on its ticker besides every animation frame (online spec §3.5). */
export const PUMP_MS = 16;
/** A stall this long shows "CONNECTION UNSTABLE..." (online spec §3.2). */
export const STALL_MS = 1000;
/**
 * A stall this long ends the match as a lost connection, though the link is up (online spec §3.6): the
 * opponent's side has stopped playing (a silent link ends after 8 s already).
 */
export const STALL_END_MS = 20_000;
/** At most this many ticks per pump; time beyond that is dropped (online spec §3.5). */
const MAX_TICKS_PER_PUMP = 15;
/** A host sends its state for a resync at most this often (online spec §3.4). */
const RESYNC_EVERY_MS = 1000;
/** The opponent's inputs may run at most this far past this side's tick; further ones are dropped (online spec §4). */
const MAX_REMOTE_LEAD = 600;
const TICK_MS = 1000 / TICK_HZ;
/** Events more than this far behind the sim (300 ms) are not shown when frames come back after a hidden spell (online spec §3.5). */
const STALE_TICKS = Math.round(0.3 * TICK_HZ);
/** While no frame takes the events (a hidden tab), at most about this many wait before the stale ones go. */
const MAX_BACKLOG = 256;

/** The match a host starts: options, seed and both players (host first). */
export interface MatchStart { config: ArcadeConfig; seed: number; players: [Profile, Profile] }

/** Options of an online session. */
export interface OnlineSessionOptions {
  transport: Transport<ArcadeMsg>;
  scheduler: Scheduler;
  /** This side's input each tick: the keyboard, or a test's CPU playing this side's player. */
  controller: Controller;
  /** Host: the first match, and a fresh seed for each rematch. Guest: null (the host's `start` says it all). */
  host: { first: MatchStart; seed(): number } | null;
  /** Runs `pump` every PUMP_MS; the Worker ticker by default, so a hidden tab keeps playing. */
  ticker?: Ticker;
}

/** What the debug hooks and the browser run read of the netcode. */
export interface NetStats {
  tick: number;
  confirmed: number;
  rollbacks: number;
  maxDepth: number;
  resimTicks: number;
  stalls: number;
  desyncs: number;
  /** Hashes this side sent, by checkpoint tick. */
  sums: Record<number, number>;
  rttMs: number | null;
  ahead: number;
}

/**
 * Both players as the sim keeps them: clean copies (a sanitized name and a clamped look in a fixed key
 * order, as the guest receives them), the same on both sides, so their states hash the same.
 */
function playersOf(start: MatchStart): [PlayerInfo, PlayerInfo] {
  const info = (p: Profile): PlayerInfo => {
    const clean = parseProfile(p) ?? p;
    return { name: clean.name, look: { ...clean.look }, kind: 'human', cpuLevel: null };
  };
  return [info(start.players[0]), info(start.players[1])];
}

/**
 * One side of an online Arcade match (online spec §3): the host plays player 0 and starts each match,
 * the guest plays player 1. A Rollback runs the shared sim; this session pumps it by the scheduler's
 * clock (every animation frame and every PUMP_MS on its ticker), sends this side's inputs, hashes and
 * (host, after a mismatch) its confirmed state, applies what the opponent sends, keeps the clocks
 * together (TimeSync), and runs the end of a match: played out, forfeit, the opponent leaving or
 * dropping (the PeerLink heartbeat), rematch. It never pauses.
 */
export class ArcadeOnlineSession {
  readonly viewer: PlayerId;
  private readonly o: OnlineSessionOptions;
  private readonly link: PeerLink<ArcadeMsg>;
  private readonly stopTicker: () => void;
  private rb: Rollback | null = null;
  private sync = new TimeSync();
  private matchNo = 0;
  private start: MatchStart | null = null;
  private acc = 0;
  private lastNow: number;
  private events: ArcadeEvent[] = [];
  private stalledSince: number | null = null;
  private stalls = 0;
  private desyncs = 0;
  private sentSums: Record<number, number> = {};
  private lastResyncAt = Number.NEGATIVE_INFINITY;
  private why: OnlineEnd | null = null;
  /** The state an ended match's Results show: the same on both sides (online spec §3.6). */
  private final: ArcadeState | null = null;
  private loser: PlayerId | null = null;
  private wantRematch = false;
  private theyWantRematch = false;
  private left = false;
  private disposed = false;
  private last: ArcadeView | null = null;

  constructor(o: OnlineSessionOptions) {
    this.o = o;
    this.viewer = o.host === null ? 1 : 0;
    this.lastNow = o.scheduler.now();
    this.link = new PeerLink<ArcadeMsg>(o.transport, o.scheduler, {
      message: (m) => this.receive(m),
      gone: (why) => this.gone(why),
    });
    if (o.host !== null) this.begin(1, o.host.first, true);
    // The guest's transport holds the host's `start` first: listening hands it over now.
    this.link.listen();
    if (this.rb === null) {
      console.warn('[bbt] online: no start from the host');
      this.why = 'disconnect';
    }
    this.stopTicker = (o.ticker ?? workerTicker)(PUMP_MS, () => this.pump());
  }

  /** Why the match ended, or null while it is played. */
  get endReason(): OnlineEnd | null {
    return this.why;
  }

  /** How the opponent went away, or null while connected. */
  get opponentGone(): Departure | null {
    return this.link.gone;
  }

  /** Who forfeited, when a forfeit ended the match. */
  get forfeitBy(): PlayerId | null {
    return this.loser;
  }

  /** True once the match has ended: at once for a forfeit, a lost opponent or a leave; played out, 3 s after its last point once confirmed. */
  get over(): boolean {
    return this.why !== null;
  }

  /**
   * The state of an ended match, or null while it is played: played out, its final state; cut short, the
   * state after the last tick both sides had confirmed (a forfeit's comes with it), so the two screens
   * show the same Results.
   */
  get result(): ArcadeState | null {
    return this.over ? (this.final ?? this.rb?.state ?? null) : null;
  }

  get view(): ArcadeView | null {
    return this.last;
  }

  /** True while Results may ask for a rematch: the match is over, played out or forfeited, and the opponent is still there. */
  get mayRematch(): boolean {
    return !this.left && this.link.gone === null && (this.why === 'finished' || this.why === 'forfeit');
  }

  /** The netcode's numbers (debug hooks, browser run). */
  netStats(): NetStats {
    const rb = this.rb;
    return {
      tick: rb?.tick ?? 0,
      confirmed: rb?.confirmed ?? 0,
      rollbacks: rb?.stats.rollbacks ?? 0,
      maxDepth: rb?.stats.maxDepth ?? 0,
      resimTicks: rb?.stats.resimTicks ?? 0,
      stalls: this.stalls,
      desyncs: this.desyncs,
      sums: { ...this.sentSums },
      rttMs: this.link.rttMs,
      ahead: this.sync.ahead,
    };
  }

  /** Online play never pauses (online spec §5). */
  pause(): void {}

  resume(): void {}

  /** Pumps (by the scheduler's clock, not `dtMs`) and returns the view with the events since the last frame. */
  frame(_dtMs: number): ArcadeView {
    this.pump();
    const now = this.o.scheduler.now();
    const rb = this.rb ?? this.placeholder();
    const unstable = this.link.unstable(now) || (this.stalledSince !== null && now - this.stalledSince >= STALL_MS);
    const events = this.fresh(this.events, rb);
    this.events = [];
    this.last = {
      state: rb.state,
      t: rb.tick * DT + Math.min(this.acc, TICK_MS) / 1000,
      events,
      viewer: this.viewer,
      overlay: { paused: false, countdown: null, net: { rttMs: this.link.rttMs, unstable } },
    };
    return this.last;
  }

  /**
   * Advances the sim to the scheduler's time (at this side's TimeSync rate, at most 15 ticks, waiting
   * while 15 ticks are predicted), then sends this side's new inputs and hashes; a host that has found
   * a mismatch sends its confirmed state. Also runs the heartbeat. Safe to call any time.
   */
  pump(): void {
    if (this.disposed) return;
    const now = this.o.scheduler.now();
    this.link.tick(now);
    const dt = now - this.lastNow;
    this.lastNow = now;
    const rb = this.rb;
    if (rb === null || this.why !== null) return;
    try {
      this.advance(rb, dt, now);
    } catch (err) {
      this.fail(err);
    }
  }

  /** pump's work: the ticks due, the messages to send, and the end of a played-out match. */
  private advance(rb: Rollback, dt: number, now: number): void {
    this.acc += Math.max(0, dt) * this.sync.rate();
    let n = 0;
    while (this.acc >= TICK_MS && n < MAX_TICKS_PER_PUMP) {
      if (!rb.canStep()) {
        if (!finished(rb.state)) this.stall(now);
        this.acc = Math.min(this.acc, TICK_MS);
        break;
      }
      this.stalledSince = null;
      this.events.push(...rb.step(this.o.controller.input(rb.state)));
      this.acc -= TICK_MS;
      n++;
    }
    if (n === MAX_TICKS_PER_PUMP && this.acc >= TICK_MS) this.acc = 0;
    if (this.events.length > MAX_BACKLOG) this.events = this.fresh(this.events, rb);
    this.flush(rb, now);
    if (finished(rb.state) && rb.confirmed === rb.tick) this.end('finished', cloneState(rb.state));
    else if (this.stalledSince !== null && now - this.stalledSince >= STALL_END_MS) this.lose('[bbt] online: no inputs from the opponent for 20 s');
  }

  /**
   * Gives the match up (online spec §3.6): the opponent gets the state after this side's confirmed tick,
   * which both Results then show. Nothing happens once the match is decided: its Results are coming.
   */
  forfeit(): void {
    const rb = this.rb;
    if (this.why !== null || rb === null || rb.state.status === 'over') return;
    const { tick, state } = rb.confirmedState();
    this.link.send({ type: 'forfeit', m: this.matchNo, t: tick, s: state });
    this.loser = this.viewer;
    this.end('forfeit', state);
  }

  /** Results' Rematch: asks the opponent; the host starts the next match once both have asked. */
  rematch(): void {
    if (!this.mayRematch || this.wantRematch) return;
    this.wantRematch = true;
    this.link.send({ type: 'rematch', want: true });
    this.maybeRematch();
  }

  /** Leaves (Menu, page hide): the opponent is told once, and a match still being played ends as 'left'. */
  leave(): void {
    if (this.disposed) return;
    this.link.leave();
    this.left = true;
    this.end('left', this.agreed());
  }

  /** Leaves (if not yet), stops the ticker and closes the transport. */
  dispose(): void {
    if (this.disposed) return;
    this.leave();
    this.disposed = true;
    this.stopTicker();
    this.link.close();
  }

  /** Sends this side's new inputs (with its advantage) and confirmed hashes; reports and (host) repairs mismatches. */
  private flush(rb: Rollback, now: number): void {
    const mine = rb.takeLocal();
    if (mine !== null) {
      const adv = TimeSync.advantage(rb.tick, rb.lastRemote);
      for (let i = 0; i < mine.inputs.length; i += MAX_INPUTS_PER_MSG) {
        const chunk = mine.inputs.slice(i, i + MAX_INPUTS_PER_MSG).map(packInput);
        this.link.send({ type: 'in', m: this.matchNo, t: mine.first + i, i: chunk, adv });
      }
    }
    for (const { tick, hash } of rb.takeSums()) {
      this.sentSums[tick] = hash;
      this.link.send({ type: 'sum', m: this.matchNo, t: tick, h: hash });
    }
    const bad = rb.takeMismatches();
    if (bad.length === 0) return;
    this.desyncs += bad.length;
    console.warn('[bbt] desync at tick', bad.join(', '));
    if (this.o.host === null || now - this.lastResyncAt < RESYNC_EVERY_MS) return;
    this.lastResyncAt = now;
    const { tick, state } = rb.confirmedState();
    this.link.send({ type: 'state', m: this.matchNo, t: tick, s: state });
  }

  private stall(now: number): void {
    if (this.stalledSince !== null) return;
    this.stalledSince = now;
    this.stalls++;
  }

  /** A message of the opponent; one the sim cannot run ends the match (fail). */
  private receive(m: ArcadeMsg): void {
    if (this.disposed) return;
    try {
      this.apply(m);
    } catch (err) {
      this.fail(err);
    }
  }

  private apply(m: ArcadeMsg): void {
    const rb = this.rb;
    switch (m.type) {
      case 'start':
        if (this.o.host === null && m.m > this.matchNo) this.begin(m.m, { config: m.config, seed: m.seed, players: m.players }, false);
        return;
      case 'rematch':
        this.theyWantRematch = m.want;
        this.maybeRematch();
        return;
      case 'forfeit': {
        if (this.why !== null || rb === null || m.m !== this.matchNo) return;
        // A match this side has seen decided ends as played out, whatever the other side clicked (its inputs decided it first).
        const agreed = this.agreed();
        if (agreed?.status === 'over') {
          this.end('finished', agreed);
          return;
        }
        this.loser = this.viewer === 0 ? 1 : 0;
        this.end('forfeit', m.s);
        return;
      }
      default:
        break;
    }
    // Inputs, hashes and resyncs count only while their match is played.
    if (rb === null || this.why !== null) return;
    switch (m.type) {
      case 'in':
        if (m.m !== this.matchNo || m.t > rb.tick + MAX_REMOTE_LEAD) return;
        this.events.push(...rb.receive(m.t, m.i.map(unpackInput)));
        this.sync.note(TimeSync.advantage(rb.tick, rb.lastRemote), m.adv);
        return;
      case 'sum':
        if (m.m === this.matchNo) rb.noteRemoteSum(m.t, m.h);
        return;
      case 'state':
        // Online spec §3.4: the host's confirmed state. Adopting is all or nothing; one the sim cannot run throws, and the match ends.
        if (this.o.host === null && m.m === this.matchNo) this.events.push(...rb.adopt(m.t, m.s));
        return;
      default:
        return;
    }
  }

  /**
   * The opponent left or dropped: a match already decided (its last point confirmed here) ends as played
   * out, the departure a note on its Results; any other ends cut short (online spec §3.6).
   */
  private gone(why: Departure): void {
    if (this.why !== null) return;
    const agreed = this.agreed();
    this.end(agreed?.status === 'over' ? 'finished' : why, agreed);
  }

  /** Ends the match for `why`, its Results showing `final`; a match already ended keeps its end. */
  private end(why: OnlineEnd, final: ArcadeState | null): void {
    if (this.why !== null) return;
    this.why = why;
    this.final = final;
  }

  /** A copy of the state after the last tick both sides have confirmed, or null without a match. */
  private agreed(): ArcadeState | null {
    return this.rb?.confirmedState().state ?? null;
  }

  /**
   * Something the sim cannot run (a broken or modified opponent's message, or a bug): the match ends
   * here as a lost link, and the opponent is told, so its side ends too instead of waiting.
   */
  private fail(err: unknown): void {
    console.error('[bbt] online: the match failed', err);
    this.lose(null);
  }

  /** Ends the match as a lost connection (`note` logged), Results showing the last agreed state, and tells the opponent. */
  private lose(note: string | null): void {
    if (this.why !== null) return;
    if (note !== null) console.warn(note);
    let final: ArcadeState | null = null;
    try {
      final = this.agreed();
    } catch {
      // The state itself is broken: Results show the live one.
    }
    this.end('disconnect', final);
    this.link.leave();
  }

  /**
   * `events` without those more than 300 ms behind the sim, except the current call's (its banner needs
   * them): after a hidden spell the backlog's sparks and cheers are not replayed (online spec §3.5).
   */
  private fresh(events: ArcadeEvent[], rb: Rollback): ArcadeEvent[] {
    const from = rb.tick - STALE_TICKS;
    const call = rb.state.point.call?.tick;
    return events.filter((e) => e.tick > from || e.tick === call);
  }

  /** The host starts the next match (a new seed) once both sides asked for it after a played-out or forfeited match. */
  private maybeRematch(): void {
    const host = this.o.host;
    if (host === null || !this.wantRematch || !this.theyWantRematch || !this.mayRematch || this.start === null) return;
    this.begin(this.matchNo + 1, { ...this.start, seed: host.seed() }, true);
  }

  /** Starts match `m` on this side (the host also sends `start`): a fresh sim, clock and end. */
  private begin(m: number, start: MatchStart, announce: boolean): void {
    this.matchNo = m;
    this.start = start;
    this.rb = new Rollback(createMatch(start.config, playersOf(start), start.seed), this.viewer);
    this.sync = new TimeSync();
    this.acc = 0;
    this.lastNow = this.o.scheduler.now();
    this.events = [];
    this.stalledSince = null;
    this.why = null;
    this.final = null;
    this.loser = null;
    this.wantRematch = false;
    this.theyWantRematch = false;
    this.sentSums = {};
    if (announce) this.link.send({ type: 'start', m, config: start.config, seed: start.seed, players: start.players });
  }

  /** A blank match to draw when the host's start never came (the session has already ended). */
  private placeholder(): Rollback {
    const me: Profile = { name: '?', look: { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 } };
    const config: ArcadeConfig = { format: 'tiebreak', deuceRule: 'advantage', surface: 'hard', pace: 'normal' };
    this.rb = new Rollback(createMatch(config, playersOf({ config, seed: 0, players: [me, me] }), 0), this.viewer);
    return this.rb;
  }
}

