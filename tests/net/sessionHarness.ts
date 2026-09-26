import { vi } from 'vitest';
import { seedRng, uniform } from '../../src/core/rng';
import type {
  FormatId,
  MatchConfig,
  PlayerId,
  PlayerInfo,
  PointReason,
  PromptState,
  RngState,
  ServeTurnData,
  TurnState,
  Vec2,
  ViewModel,
  WordOption,
} from '../../src/core/types';
import { VirtualScheduler, type Scheduler } from '../../src/game/clock';
import { GuestSession } from '../../src/game/guestSession';
import { HostSession } from '../../src/game/hostSession';
import type { NetMsg } from '../../src/net/protocol';
import { loopbackPair, type LoopbackOptions, type Transport } from '../../src/net/transport';
import { keyOf } from '../game/sessionHelpers';

const LOOK = { skin: 1, hairStyle: 2, hair: 3, shirt: 4, shorts: 5, headband: null, racket: 1 };
const HOST_PLAYER: PlayerInfo = { name: 'Hana', look: LOOK, kind: 'human', cpuLevel: null };
const GUEST_PLAYER: PlayerInfo = { name: 'Gus', look: LOOK, kind: 'remote', cpuLevel: null };

/** Milliseconds between two frames of a side whose rAF runs. */
export const FRAME_MS = 16;
/** Half-width of the uniform jitter around each nominal one-way latency. */
export const JITTER_MS = 30;

/** A Normal-pace match of `format` on a hard court. */
export function config(format: FormatId): MatchConfig {
  return { format, pace: 'normal', surface: 'hard', wordPack: 'everyday', deuceRule: 'advantage', training: null };
}

/** Loopback delays uniform in [latency − 30, latency + 30] ms (never below 0), from a fixed jitter seed. */
function linkOptions(latencyMs: number, jitterSeed: number): LoopbackOptions {
  const low = Math.max(0, latencyMs - JITTER_MS);
  return { latencyMs: low, jitterMs: latencyMs + JITTER_MS - low, seed: jitterSeed };
}

/** The longest one-way delay at a nominal latency. */
export function maxOneWayMs(latencyMs: number): number {
  return latencyMs + JITTER_MS;
}

/** A message one side sent, with the local time and its JSON as it went out. */
export interface Sent { at: number; m: NetMsg; json: string }

/** A message one side received, with the local time it arrived. */
export interface Heard { at: number; m: NetMsg }

/** One side's transport, recording what it sends and hears; a muted wire sends nothing. */
export class Wire implements Transport {
  readonly sent: Sent[] = [];
  readonly received: Heard[] = [];
  /** While true, every message this side sends is lost (the side has gone silent). */
  mute = false;

  constructor(private readonly inner: Transport, private readonly s: Scheduler) {}

  get bufferedAmount(): number {
    return this.inner.bufferedAmount;
  }

  send(m: NetMsg): void {
    if (this.mute) return;
    this.sent.push({ at: this.s.now(), m, json: JSON.stringify(m) });
    this.inner.send(m);
  }

  onMessage(cb: (m: NetMsg) => void): void {
    this.inner.onMessage((m) => {
      this.received.push({ at: this.s.now(), m });
      cb(m);
    });
  }

  onClose(cb: (reason: string) => void): void {
    this.inner.onClose(cb);
  }

  close(): void {
    this.inner.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Scripted typists

/** How a scripted typist plays. */
export interface TypistOptions {
  wpm: number;
  /** Chance that a serve's first toss is left to be caught (no word typed). */
  catchChance: number;
  /** Chance of a wrong key before each letter but a prompt's first. */
  errorChance: number;
}

/** One key of a typist: a letter or 'toss', at turn-clock τ. */
interface PlannedKey { key: string; τ: number }

const DEFAULT_TYPIST: TypistOptions = { wpm: 55, catchChance: 0.25, errorChance: 0.04 };
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
/**
 * Planned key times are multiples of 1/256 ms. Session times stay on that grid too (frames, the
 * 50 ms tick, key times), so a key pressed at turn start + τ reaches the turn clock as exactly τ,
 * whenever the turn started.
 */
const GRID = 256;
const onGrid = (ms: number): number => Math.round(ms * GRID) / GRID;

/** FNV-1a of the parts, as a seed. */
function hashSeed(parts: readonly (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}

const wordsOf = (options: readonly WordOption[]): string => options.map((o) => o.word).join(',');

/**
 * A deterministic typist for one player. Each key's τ within a turn is a pure function of (seed, the
 * turn kind, the prompt kind and words) counted from the prompt's τ: the toss after a random 0.5–1.2 s in
 * PRE_SERVE, then a reaction and jittered key intervals at `wpm`, the hardest word that fits the
 * time left half the time (always the hardest one time in ten), an occasional wrong key, and
 * now and then a first toss left to be caught. Wall-clock time never enters, so a match played with
 * the same seed at any latency sees the same keys at the same τ.
 */
class ScriptedTypist {
  private readonly opts: TypistOptions;
  private readonly intervalMs: number;

  constructor(readonly me: PlayerId, private readonly seed: number, opts: Partial<TypistOptions> = {}) {
    this.opts = { ...DEFAULT_TYPIST, ...opts };
    this.intervalMs = 12000 / this.opts.wpm;
  }

  /** The next key for this player's running turn `t`, or null (not its turn, or nothing to type). */
  next(t: TurnState): PlannedKey | null {
    const d = t.data;
    if (d.owner !== this.me || !t.started || t.ended) return null;
    if (d.kind === 'serve' && t.phase === 'preServe') return this.toss(t, d);
    const p = t.active === null ? undefined : t.prompts[t.active];
    if (p === undefined || p.completedAt !== null) return null;
    return this.keys(t, p)[p.correctKeys + p.wrongKeys] ?? null;
  }

  private rng(...parts: (string | number)[]): RngState {
    return seedRng(hashSeed([this.seed, this.me, ...parts]));
  }

  private toss(t: TurnState, d: ServeTurnData): PlannedKey | null {
    const set = d.wordSets[t.setIndex];
    if (set === undefined) return null;
    const r = this.rng('toss', wordsOf(set.options));
    return { key: 'toss', τ: onGrid(preServeStart(t, d) + 500 + 700 * uniform(r)) };
  }

  /** Every key of prompt `p`, right and wrong, in order. */
  private keys(t: TurnState, p: PromptState): PlannedKey[] {
    const d = t.data;
    const r = this.rng(d.kind, p.kind, wordsOf(p.options));
    const leaveIt = uniform(r) < this.opts.catchChance;
    if (p.kind === 'serve' && t.setIndex === 0 && leaveIt) return [];
    const reaction = p.kind === 'chase' ? 250 + 150 * uniform(r) : 300 + 200 * uniform(r);
    const option = p.kind === 'chase' ? 0 : this.choose(p.options, deadline(t, p) - p.shownAt - reaction, r);
    const word = p.options[option]?.word ?? '';
    const wordFactor = 0.85 + 0.3 * uniform(r);
    const keys: PlannedKey[] = [];
    let τ = p.shownAt + reaction;
    for (let i = 0; i < word.length; i++) {
      const letter = word.charAt(i);
      if (i > 0) τ += this.intervalMs * wordFactor * (0.75 + 0.5 * uniform(r));
      if (i > 0 && uniform(r) < this.opts.errorChance) {
        keys.push({ key: wrongLetter(letter, r), τ: onGrid(τ) });
        τ += 150 + 150 * uniform(r);
      }
      keys.push({ key: letter, τ: onGrid(τ) });
    }
    return keys;
  }

  /** The option to type: the hardest that fits `budgetMs` half the time, else any that fits (easy if none); the hardest one time in ten. */
  private choose(options: readonly WordOption[], budgetMs: number, r: RngState): number {
    const [bold, hardest, any] = [uniform(r), uniform(r), uniform(r)];
    if (bold < 0.1) return options.length - 1;
    const fitting = options.flatMap((o, i) => (o.len * this.intervalMs * 1.15 <= budgetMs - 250 ? [i] : []));
    if (fitting.length === 0) return 0;
    return hardest < 0.5 ? fitting[fitting.length - 1]! : fitting[Math.floor(any * fitting.length)]!;
  }
}

/** τ at which the current PRE_SERVE began: the end of the last catch, else the end of the lead-in. */
function preServeStart(t: TurnState, d: ServeTurnData): number {
  for (let i = t.log.length - 1; i >= 0; i--) {
    const e = t.log[i]!;
    if (e.k === 'catch') return e.τ + d.catchMs;
  }
  return d.leadIn.ms;
}

/** The τ by which prompt `p` must be done: the ball too low to hit (serve), or the ball's arrival (choice). */
function deadline(t: TurnState, p: PromptState): number {
  const d = t.data;
  if (d.kind === 'serve') return (t.tossAt ?? p.shownAt) + 2 * d.tossApexMs * d.pace;
  return d.incoming.T;
}

function wrongLetter(right: string, r: RngState): string {
  const others = ALPHABET.replace(right, '');
  return others.charAt(Math.floor(uniform(r) * others.length));
}

// ---------------------------------------------------------------------------------------------
// Outcome records

/** A strike as the invariance check compares it. */
export interface StrikeRecord { word: string; option: number; landing: Vec2 }

/** How one turn ended: its outcome kind (with the fault reason, ace/winner or call) and its strike. */
export interface TurnRecord {
  turn: number;
  owner: PlayerId;
  kind: 'serve' | 'return';
  outcome: string;
  endτ: number;
  strike: StrikeRecord | null;
}

/** One point: who won it, why, and every turn played in it. */
export interface PointRecord { winner: PlayerId; reason: PointReason; turns: TurnRecord[] }

/** The record of an ended turn. */
export function turnRecord(t: TurnState): TurnRecord {
  const o = t.outcome;
  if (!t.ended || o === null) throw new Error(`turnRecord: turn ${t.data.turnId} has not ended`);
  const detail = o.kind === 'fault' ? `:${o.reason}` : o.kind === 'miss' ? `:${o.ace ? 'ace' : 'winner'}` : o.kind === 'call' ? `:${o.call}` : '';
  const strike = o.kind === 'strike' ? { word: o.strike.word.word, option: o.strike.option, landing: { ...o.strike.shot.landing } } : null;
  return { turn: t.data.turnId, owner: t.data.owner, kind: t.data.kind, outcome: o.kind + detail, endτ: o.endτ, strike };
}

/** Every ended turn and point one side's views have shown, in the order the display reached them. */
export class OutcomeLog {
  /** Each turn's record as first shown ended. */
  readonly turns = new Map<number, TurnRecord>();
  private readonly pointEvents: { turn: number; winner: PlayerId; reason: PointReason }[] = [];

  /** Notes the ended turns and the point events of one view. */
  observe(vm: ViewModel): void {
    for (const t of [vm.pub.lastTurn, vm.pub.turn]) {
      if (t !== null && t.ended && !this.turns.has(t.data.turnId)) this.turns.set(t.data.turnId, turnRecord(t));
    }
    for (const e of vm.events) if (e.type === 'point') this.pointEvents.push({ turn: e.turn, winner: e.winner, reason: e.reason });
  }

  /** The match point by point: each point's result and the turns played in it, in turn order. */
  points(): PointRecord[] {
    const turns = [...this.turns.values()].sort((a, b) => a.turn - b.turn);
    let from = 0;
    return this.pointEvents.map(({ turn, winner, reason }) => {
      const upTo = turns.findIndex((t) => t.turn > turn);
      const end = upTo < 0 ? turns.length : upTo;
      const played = turns.slice(from, end);
      from = end;
      return { winner, reason, turns: played };
    });
  }
}

const TOLERANCE = 1e-9;

/** How `b` differs from `a`: discrete fields exactly, endτ and the landing to 1e-9. */
export function diffTurn(a: TurnRecord, b: TurnRecord): string[] {
  const out: string[] = [];
  const at = `turn ${a.turn}`;
  const same = (what: string, x: unknown, y: unknown): void => {
    if (x !== y) out.push(`${at} ${what}: ${String(x)} vs ${String(y)}`);
  };
  const close = (what: string, x: number, y: number): void => {
    if (!(Math.abs(x - y) <= TOLERANCE)) out.push(`${at} ${what}: ${x} vs ${y}`);
  };
  same('id', a.turn, b.turn);
  same('owner', a.owner, b.owner);
  same('kind', a.kind, b.kind);
  same('outcome', a.outcome, b.outcome);
  close('endτ', a.endτ, b.endτ);
  if (a.strike === null || b.strike === null) {
    same('strike', a.strike === null, b.strike === null);
    return out;
  }
  same('strike word', a.strike.word, b.strike.word);
  same('strike option', a.strike.option, b.strike.option);
  close('landing x', a.strike.landing.x, b.strike.landing.x);
  close('landing y', a.strike.landing.y, b.strike.landing.y);
  return out;
}

/** How match `b` differs from match `a`, point by point (empty when they are the same). */
export function diffPoints(a: PointRecord[], b: PointRecord[]): string[] {
  const out: string[] = [];
  if (a.length !== b.length) out.push(`points: ${a.length} vs ${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [p, q] = [a[i]!, b[i]!];
    if (p.winner !== q.winner || p.reason !== q.reason) out.push(`point ${i + 1}: ${p.winner} ${p.reason} vs ${q.winner} ${q.reason}`);
    if (p.turns.length !== q.turns.length) out.push(`point ${i + 1} turns: ${p.turns.length} vs ${q.turns.length}`);
    for (let j = 0; j < Math.min(p.turns.length, q.turns.length); j++) out.push(...diffTurn(p.turns[j]!, q.turns[j]!));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Playback and redaction checks

/** A local time and a turn-clock τ. */
export interface TimedTau { at: number; τ: number }

/** The guest's playback of one host-owned turn: the host's confirmations as they arrived, and what the guest showed. */
export interface PlaybackTrace {
  turn: number;
  kind: 'serve' | 'return';
  /** Local time the first frame showing the turn ended arrived, or null. */
  endedAt: number | null;
  /** Each rise of the turn's confirmed τ, in arrival order (0 before the first). */
  confirmed: TimedTau[];
  /** Every guest view of the turn: its local time and displayed τ. */
  shown: TimedTau[];
}

/**
 * Watches the guest: the τ the host has confirmed for each turn (the highest frame τ of the turn,
 * or its endτ once a frame shows it ended), from what the guest has received so far; and each
 * guest view, whose τ must stay within that for a host-owned turn and never go back within a turn.
 * It keeps a trace of each host-owned turn, and the time of each guest strike, for `settleReport`.
 */
export class PlaybackMonitor {
  readonly violations: string[] = [];
  /** Guest views that showed a host-owned turn. */
  checked = 0;
  /** Of those, the views past τ 0 held exactly at the confirmed τ (playback caught up and waits). */
  atCap = 0;
  /** The trace of each host-owned turn, by turn id. */
  readonly traces = new Map<number, PlaybackTrace>();
  /** Local time of each of the guest's strikes, by the id of the guest turn it ended. */
  readonly strikes = new Map<number, number>();
  private readonly confirmed = new Map<number, number>();
  private readonly ownStarts = new Map<number, number>();
  private heard = 0;
  private last: { turn: number; τ: number } | null = null;

  constructor(private readonly received: readonly Heard[]) {}

  /** A guest view model, taken after every message received so far. */
  saw(vm: ViewModel, now: number): void {
    for (; this.heard < this.received.length; this.heard++) this.confirm(this.received[this.heard]!);
    const t = vm.pub.turn;
    if (t === null) {
      this.last = null;
      return;
    }
    const id = t.data.turnId;
    if (this.last !== null && this.last.turn === id && vm.turnτ < this.last.τ) {
      this.violations.push(`at ${now}: turn ${id} went back from τ ${this.last.τ} to ${vm.turnτ}`);
    }
    this.last = { turn: id, τ: vm.turnτ };
    if (t.data.owner !== 0) {
      this.noteOwn(t, vm.turnτ, now);
      return;
    }
    this.checked++;
    const c = this.confirmed.get(id) ?? 0;
    if (vm.turnτ > c) this.violations.push(`at ${now}: turn ${id} shown at τ ${vm.turnτ} beyond the host's confirmed ${c}`);
    if (vm.turnτ > 0 && vm.turnτ === c) this.atCap++;
    this.trace(t).shown.push({ at: now, τ: vm.turnτ });
  }

  private confirm({ at, m }: Heard): void {
    if (m.type !== 'frame') return;
    const turns = [m.s?.turn, m.s?.lastTurn].filter((t): t is TurnState => t !== null && t !== undefined);
    for (const t of turns) if (t.data.owner === 0) this.trace(t);
    this.raise(m.turn, m.τ, at);
    for (const t of turns) {
      if (!t.ended || t.outcome === null) continue;
      this.raise(t.data.turnId, t.outcome.endτ, at);
      const trace = this.traces.get(t.data.turnId);
      if (trace !== undefined) trace.endedAt ??= at;
    }
  }

  /** A guest-owned turn runs on the guest's clock (τ = now − its start), so its strike happened at start + endτ. */
  private noteOwn(t: TurnState, τ: number, now: number): void {
    const id = t.data.turnId;
    if (!this.ownStarts.has(id)) this.ownStarts.set(id, now - τ);
    if (t.outcome?.kind === 'strike' && !this.strikes.has(id)) this.strikes.set(id, this.ownStarts.get(id)! + t.outcome.endτ);
  }

  private raise(turn: number, τ: number, at: number): void {
    const was = this.confirmed.get(turn) ?? 0;
    if (τ <= was) return;
    this.confirmed.set(turn, τ);
    this.traces.get(turn)?.confirmed.push({ at, τ });
  }

  private trace(t: TurnState): PlaybackTrace {
    const id = t.data.turnId;
    let trace = this.traces.get(id);
    if (trace === undefined) {
      trace = { turn: id, kind: t.data.kind, endedAt: null, confirmed: [], shown: [] };
      this.traces.set(id, trace);
    }
    return trace;
  }
}

/** One period of a host return turn's playback on the guest: when it began after the guest's strike, and its mean lag. */
export interface LagPeriod { turn: number; afterStrikeMs: number; lag: number }

/** How the guest's playback of the host's return turns went after each guest strike. */
export interface SettleReport {
  /** Every period from `afterMs` after a guest strike until the host's return to it ended. */
  periods: LagPeriod[];
  /** Host return turns with at least one such period. */
  turns: number;
  /** The longest wait between two confirmations the guest received in those periods (ms). */
  maxGapMs: number;
}

/**
 * The guest's mean lag (confirmed τ − displayed τ) over each `periodMs` period of every host return
 * turn (the host's reply to a guest strike), from `afterMs` after the guest's strike (on the guest's
 * clock) until a frame showed the turn ended (the confirmations stop there). Both are exact step
 * functions of time: the confirmed τ changes as each frame arrives, the displayed τ at each view (the
 * screen shows a view until the next; 0 before the turn is first shown, as its playback starts at 0).
 * Averaging a whole period evens out the staircase of the 50 ms confirmations, as
 * `tests/game/playback.test.ts` does.
 */
export function settleReport(monitor: PlaybackMonitor, afterMs: number, periodMs: number): SettleReport {
  const report: SettleReport = { periods: [], turns: 0, maxGapMs: 0 };
  for (const trace of monitor.traces.values()) {
    const { shown, confirmed } = trace;
    if (trace.kind !== 'return' || shown.length === 0) continue;
    const strikeAt = monitor.strikes.get(trace.turn - 1);
    if (strikeAt === undefined) throw new Error(`settleReport: no guest strike recorded before host turn ${trace.turn}`);
    const [from, until] = [strikeAt + afterMs, Math.min(trace.endedAt ?? Number.POSITIVE_INFINITY, shown[shown.length - 1]!.at)];
    if (from + periodMs > until) continue;
    report.turns++;
    for (let a = from; a + periodMs <= until; a += periodMs) {
      report.periods.push({ turn: trace.turn, afterStrikeMs: a - strikeAt, lag: meanLag(trace, a, a + periodMs) });
    }
    const arrivals = confirmed.filter((c) => c.at >= from && c.at <= until).map((c) => c.at);
    for (let i = 1; i < arrivals.length; i++) report.maxGapMs = Math.max(report.maxGapMs, arrivals[i]! - arrivals[i - 1]!);
  }
  return report;
}

/** The exact mean of confirmed τ − displayed τ over [a, b]. */
function meanLag({ confirmed, shown }: PlaybackTrace, a: number, b: number): number {
  const inside = (xs: readonly TimedTau[]): number[] => xs.slice(lastAtOrBefore(xs, a) + 1, lastAtOrBefore(xs, b) + 1).map((x) => x.at);
  const cuts = [a, ...inside(confirmed), ...inside(shown), b].sort((x, y) => x - y);
  let area = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [x, y] = [cuts[i]!, cuts[i + 1]!];
    area += (valueAt(confirmed, x) - valueAt(shown, x)) * (y - x);
  }
  return area / (b - a);
}

/** Index of the last entry at or before `t` (entries sorted by time), or −1. */
function lastAtOrBefore(xs: readonly TimedTau[], t: number): number {
  let [lo, hi] = [0, xs.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]!.at <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The τ of the latest entry at or before `t` (the later one where two share a time), else 0. */
function valueAt(xs: readonly TimedTau[], t: number): number {
  return xs[lastAtOrBefore(xs, t)]?.τ ?? 0;
}

/** The host's secrets as its own views show them: every word of its serve turns and the randoms of all its turns. */
export class HostSecrets {
  readonly words = new Map<number, Set<string>>();
  readonly randoms = new Map<number, readonly number[]>();
  /** Most word sets one host serve turn had. */
  maxSets = 0;
  /** The latest host serve turn (current and spare sets), as the host sees it. */
  hostServeTurn: TurnState | null = null;

  /** Notes the secrets of the host-owned turns in one host view. */
  observe(vm: ViewModel): void {
    for (const t of [vm.pub.turn, vm.pub.lastTurn]) {
      if (t === null || t.data.owner !== 0) continue;
      const id = t.data.turnId;
      this.randoms.set(id, [...t.data.randoms]);
      if (t.data.kind !== 'serve') continue;
      const words = this.words.get(id) ?? new Set<string>();
      for (const set of t.data.wordSets) for (const o of set.options) words.add(o.word);
      this.words.set(id, words);
      this.maxSets = Math.max(this.maxSets, t.data.wordSets.length);
      this.hostServeTurn = t;
    }
  }
}

/** What a redaction scan found, and how much it looked at. */
export interface RedactionScan {
  leaks: string[];
  /** Frames scanned: every frame, in the order sent. */
  frames: number;
  /** Of those, the bare confirmations (no state). */
  confirmations: number;
  /** Of those, the ones whose state carried a host turn (its secrets redacted). */
  framesWithHostTurns: number;
  /** Frame × host serve word checks: each frame against every word not yet made public. */
  wordsChecked: number;
  /** Frame × host random checks: each frame against every random. */
  randomsChecked: number;
}

/**
 * String fields whose values come from fixed vocabularies (a player's kind "remote", a tier "hard",
 * phases, event types, calls…), never from a word list. The scan blanks them first, so a secret word
 * that happens to be such a value is no false alarm; every other string (words above all) is scanned.
 */
const VOCABULARY_FIELD = /"(kind|phase|tier|type|k|status|variant|call|reason|side|outcome|surface|pace|format|wordPack|deuceRule)":"[^"]*"/g;
const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

type FrameMsg = Extract<NetMsg, { type: 'frame' }>;

/** Each secret as JSON, with the host turns it belongs to; `skip` leaves a value out. */
function byJson<T>(of: ReadonlyMap<number, Iterable<T>>, skip: (v: T) => boolean): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [turn, values] of of) {
    for (const v of values) {
      if (skip(v)) continue;
      const key = JSON.stringify(v);
      out.set(key, [...(out.get(key) ?? []), turn]);
    }
  }
  return out;
}

/** The turns a frame's state carries. */
const carried = (m: FrameMsg): TurnState[] => [m.s?.turn, m.s?.lastTurn].filter((t): t is TurnState => t !== null && t !== undefined);

/** The words a frame shows in public: every word struck (in its state or events), and every return turn's chase word and choice options. */
function publicWords(m: FrameMsg): string[] {
  const words = (m.ev ?? []).flatMap((e) => (e.type === 'strike' ? [e.word] : []));
  for (const t of carried(m)) {
    if (t.outcome?.kind === 'strike') words.push(t.outcome.strike.word.word);
    if (t.data.kind === 'return') words.push(t.data.chase.word, ...t.data.choice.options.map((o) => o.word));
  }
  return words;
}

/** The serve words of the guest's own serve turns in a frame: the guest's to see, whatever the host's words. */
function guestServeWords(m: FrameMsg): string[] {
  return carried(m).flatMap((t) => (t.data.owner === 1 && t.data.kind === 'serve' ? t.data.wordSets.flatMap((set) => set.options.map((o) => o.word)) : []));
}

/**
 * Scans the JSON of every frame sent to the guest, in order, bare confirmations included, against all
 * the host's recorded secrets: each serve word of every host serve turn (current, spare and appended
 * sets) as a JSON string, and each random of every host turn as a JSON number. A word is exempt only
 * from the frame on which it is first struck or shown as a return turn's word (a choice option, or the
 * chase word, which is the word just struck), since it is public from then on. The picker may give the
 * guest's own serve a word that is (or will be) one of the host's; in a frame showing it in the guest's
 * serve turn it is the guest's and no leak.
 */
export function redactionLeaks(sent: readonly Sent[], secrets: HostSecrets): RedactionScan {
  const words = byJson(secrets.words, () => false);
  const randoms = byJson(secrets.randoms, (r) => r === 0);
  /** The host's serve words not yet made public. */
  const live = new Set(words.keys());
  const scan: RedactionScan = { leaks: [], frames: 0, confirmations: 0, framesWithHostTurns: 0, wordsChecked: 0, randomsChecked: 0 };
  for (const { at, m, json: raw } of sent) {
    if (m.type !== 'frame') continue;
    scan.frames++;
    if (m.s === undefined) scan.confirmations++;
    else if (carried(m).some((t) => t.data.owner === 0)) scan.framesWithHostTurns++;
    for (const w of publicWords(m)) live.delete(JSON.stringify(w));
    const own = new Set(guestServeWords(m).map((w) => JSON.stringify(w)));
    scan.wordsChecked += live.size - [...own].filter((w) => live.has(w)).length;
    scan.randomsChecked += randoms.size;
    const json = raw.replace(VOCABULARY_FIELD, '');
    for (const w of new Set(json.match(JSON_STRING))) {
      if (live.has(w) && !own.has(w)) scan.leaks.push(`at ${at}: turn ${words.get(w)!.join('/')} serve word ${w}`);
    }
    for (const r of new Set(json.replace(JSON_STRING, '""').match(JSON_NUMBER))) {
      const turns = randoms.get(r);
      if (turns !== undefined) scan.leaks.push(`at ${at}: turn ${turns.join('/')} random ${r}`);
    }
  }
  return scan;
}

// ---------------------------------------------------------------------------------------------
// The rig

/** Which side of the match. */
export type SideName = 'host' | 'guest';

/** How to set up an online match on a loopback link. */
export interface RigOptions {
  config: MatchConfig;
  seed: number;
  /** Nominal one-way latency; each message takes it ± 30 ms. */
  latencyMs: number;
  jitterSeed: number;
  /** Milliseconds between two frames of a running side (default FRAME_MS, 60 fps). */
  frameMs?: number;
  hostTypist?: Partial<TypistOptions>;
  guestTypist?: Partial<TypistOptions>;
}

/** How long to play, and what to watch. */
export interface PlayOptions {
  limitMs: number;
  /** Checked after every frame: true ends the play early. */
  stop?: () => boolean;
  /** Every view model of a side whose rAF runs. */
  onFrame?: (side: SideName, vm: ViewModel) => void;
  /** False: nobody types (default true). */
  typists?: boolean;
}

interface Side {
  name: SideName;
  session: HostSession | GuestSession;
  typist: ScriptedTypist;
  log: OutcomeLog;
  /** False while the side's rAF is suspended: no frame() calls and no keys. */
  frames: boolean;
  frameCount: number;
  /** Local time of the side's latest view. */
  viewAt: number;
}

/**
 * A HostSession and a GuestSession over a loopback pair on one VirtualScheduler, both ticking on it
 * (the Worker ticker), each with a scripted typist that presses its keys through `session.key` at
 * its turn start + the planned τ. Every view of each side is logged (outcomes); the guest's views
 * are checked against the host's confirmations, and the host's views give its secrets.
 */
export class Rig {
  readonly s = new VirtualScheduler(1000);
  readonly host: HostSession;
  readonly guest: GuestSession;
  readonly hostWire: Wire;
  readonly guestWire: Wire;
  readonly hostLog = new OutcomeLog();
  readonly guestLog = new OutcomeLog();
  readonly playback: PlaybackMonitor;
  readonly secrets = new HostSecrets();
  private readonly frameMs: number;
  private readonly sides: [Side, Side];

  constructor(opts: RigOptions) {
    this.frameMs = opts.frameMs ?? FRAME_MS;
    const [a, b] = loopbackPair(this.s, linkOptions(opts.latencyMs, opts.jitterSeed));
    this.hostWire = new Wire(a, this.s);
    this.guestWire = new Wire(b, this.s);
    const ticker = (ms: number, fn: () => void): (() => void) => this.s.every(ms, fn);
    this.host = new HostSession({
      transport: this.hostWire,
      config: opts.config,
      host: HOST_PLAYER,
      guest: GUEST_PLAYER,
      seed: opts.seed,
      scheduler: this.s,
      ticker,
    });
    this.guest = new GuestSession({ transport: this.guestWire, scheduler: this.s, me: { ...GUEST_PLAYER, kind: 'human' }, ticker });
    this.playback = new PlaybackMonitor(this.guestWire.received);
    const side = (name: SideName, session: HostSession | GuestSession, me: PlayerId, typist: Partial<TypistOptions> = {}): Side => ({
      name,
      session,
      typist: new ScriptedTypist(me, opts.seed * 2 + me, typist),
      log: name === 'host' ? this.hostLog : this.guestLog,
      frames: true,
      frameCount: 0,
      viewAt: Number.NaN,
    });
    this.sides = [side('host', this.host, 0, opts.hostTypist), side('guest', this.guest, 1, opts.guestTypist)];
    this.frameAll();
  }

  /** Suspends a side's rAF: no more frame() calls or keys until `resume`. Its ticker keeps running. */
  suspend(name: SideName): void {
    this.side(name).frames = false;
  }

  /** Resumes a side's rAF: it is framed again from the next step on. */
  resume(name: SideName): void {
    this.side(name).frames = true;
  }

  /** How many times a side's frame() has been called. */
  frameCount(name: SideName): number {
    return this.side(name).frameCount;
  }

  /**
   * Plays for `limitMs` (or until `stop`, or until both sides are over): each typist's next key is
   * pressed at exactly its time; otherwise time moves on a frame at a time; every running side is
   * framed after each step.
   */
  play(opts: PlayOptions): void {
    const end = this.s.now() + opts.limitMs;
    while (this.s.now() < end && !(this.host.over && this.guest.over)) {
      const key = opts.typists === false ? null : this.nextKey(Math.min(end, this.s.now() + this.frameMs));
      if (key !== null) {
        this.s.advance(key.at - this.s.now());
        key.side.session.key(keyOf(key.key), this.s.now());
      } else {
        this.s.advance(Math.min(this.frameMs, end - this.s.now()));
      }
      this.frameAll(opts.onFrame);
      if (opts.stop?.() === true) return;
    }
  }

  private side(name: SideName): Side {
    return name === 'host' ? this.sides[0] : this.sides[1];
  }

  /**
   * The earliest key due by `until` of a side whose rAF runs, with a view from this instant (its turn
   * began at now − turnτ), its own turn running and its match still on.
   */
  private nextKey(until: number): { side: Side; at: number; key: string } | null {
    let first: { side: Side; at: number; key: string } | null = null;
    for (const side of this.sides) {
      const vm = side.session.view;
      if (!side.frames || vm === null || side.viewAt !== this.s.now() || side.session.endReason !== null) continue;
      const t = vm.liveTurn ?? vm.pub.turn;
      const k = t === null ? null : side.typist.next(t);
      if (k === null) continue;
      const at = side.viewAt - vm.turnτ + k.τ;
      if (at < this.s.now()) throw new Error(`${side.name} typist fell behind: ${k.key} due at ${at}, now ${this.s.now()}`);
      if (at <= until && (first === null || at < first.at)) first = { side, at, key: k.key };
    }
    return first;
  }

  private frameAll(onFrame?: (side: SideName, vm: ViewModel) => void): void {
    for (const side of this.sides) {
      if (!side.frames) continue;
      const vm = side.session.frame(this.frameMs);
      side.frameCount++;
      side.viewAt = this.s.now();
      side.log.observe(vm);
      if (side.name === 'host') this.secrets.observe(vm);
      else this.playback.saw(vm, this.s.now());
      onFrame?.(side.name, vm);
    }
  }
}

/** A full match played on a rig, with every console.warn it caused. */
export interface MatchRun {
  seed: number;
  latencyMs: number;
  rig: Rig;
  hostLog: OutcomeLog;
  guestLog: OutcomeLog;
  playback: PlaybackMonitor;
  secrets: HostSecrets;
  warnings: unknown[][];
}

/** Plays a whole match (up to 2 h of match time) and collects what it showed. */
export function playMatch(opts: RigOptions): MatchRun {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const rig = new Rig(opts);
    rig.play({ limitMs: 2 * 60 * 60 * 1000 });
    const { hostLog, guestLog, playback, secrets } = rig;
    return { seed: opts.seed, latencyMs: opts.latencyMs, rig, hostLog, guestLog, playback, secrets, warnings: warn.mock.calls.map((c) => [...c]) };
  } finally {
    warn.mockRestore();
  }
}
