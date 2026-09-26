import type {
  GameEvent,
  PromptKind,
  PromptState,
  ReturnTurnData,
  ServeTurnData,
  ServeWordSet,
  StrikeInfo,
  TurnData,
  TurnOutcome,
  TurnState,
  WordOption,
} from './types';
import { applyLetter, createPrompt, isComplete, wordCps, wpmOf } from './typing';
import { type ReturnDeadline, returnDeadlines, returnStrike } from './turnReturn';
import { type ServeDeadline, serveClockτ, serveDeadlines, serveStrike } from './turnServe';

/** A GameEvent without its (turn, τ) stamp. */
type EventBody = GameEvent extends infer E ? (E extends GameEvent ? Omit<E, 'turn' | 'τ'> : never) : never;

type Deadline = ServeDeadline | ReturnDeadline;

/** Cues change no state, so they fire at any τ reached, including an input's own τ. */
const CUES: readonly Deadline['kind'][] = ['netHit', 'bounce'];

const LETTER = /^[a-z]$/;

/**
 * Creates an unstarted turn from its start data (copied). `seenKinds` starts empty: for match-wide
 * training freezes the engine carries it over from the previous turn before `startTurn`.
 */
export function createTurn(data: TurnData): TurnState {
  return {
    data: copy(data),
    started: false,
    τ: 0,
    phase: data.kind === 'serve' ? 'leadIn' : 'chase',
    prompts: [],
    active: null,
    tossAt: null,
    catchAt: null,
    setIndex: 0,
    frozenMs: 0,
    freezeSince: null,
    seenKinds: [],
    log: [],
    outcome: null,
    ended: false,
  };
}

/** Starts the owner's clock at τ=0 (idempotent). Returns events (turnStart, preServe or promptShown...). */
export function startTurn(t: TurnState): GameEvent[] {
  if (t.started) return [];
  const d = t.data;
  const out: GameEvent[] = [];
  t.started = true;
  t.τ = 0;
  emit(t, out, 0, { type: 'turnStart', owner: d.owner, kind: d.kind });
  if (d.kind === 'return') showPrompt(t, 'chase', [d.chase], 0, out);
  advance(t, 0, true, out);
  return out;
}

/**
 * Owner input at τ ('toss' or a letter a–z). Processes deadlines < τ first, then the input, so an
 * input at exactly a deadline's τ beats it. A τ before the latest processed τ is applied at that τ.
 * Inputs before the start or after the end are ignored; stale or non-owner inputs are the caller's job.
 */
export function turnInput(t: TurnState, key: string, τ: number): GameEvent[] {
  if (!t.started || t.ended || !Number.isFinite(τ)) return [];
  const at = Math.max(τ, t.τ);
  const out: GameEvent[] = [];
  advance(t, at, false, out);
  t.τ = at;
  if (t.ended) return out;
  if (key === 'toss') toss(t, at, out);
  else if (LETTER.test(key)) letter(t, key, at, out);
  return out;
}

/** Owner confirms its clock reached τ: processes deadlines ≤ τ in order. */
export function turnClock(t: TurnState, τ: number): GameEvent[] {
  if (!t.started || t.ended || !Number.isFinite(τ) || τ < t.τ) return [];
  const out: GameEvent[] = [];
  advance(t, τ, true, out);
  t.τ = τ;
  return out;
}

/** Engine appends a spare serve word set (after a catch); ignored for return turns. */
export function appendWordSet(t: TurnState, set: ServeWordSet): void {
  if (t.data.kind === 'serve') t.data.wordSets.push(copy(set));
}

/**
 * The τ at which the next deadline fires (for schedulers/tests), or null before the start, while frozen or once ended.
 * Never before the latest processed τ, which a deadline shifted by a freeze can round just below.
 */
export function nextDeadline(t: TurnState): number | null {
  if (!t.started || t.ended || t.freezeSince !== null) return null;
  const next = pendingDeadlines(t)[0];
  return next === undefined ? null : Math.max(t.τ, next.τ);
}

/** Effective simulation time (τ minus training freeze). */
export function simTime(t: TurnState, τ: number): number {
  return τ - t.frozenMs - (t.freezeSince !== null ? τ - t.freezeSince : 0);
}

// ---------------------------------------------------------------------------------------------
// Deadlines

/** Fires the deadlines due by τ in order: all before τ, plus those at τ when `inclusive` (cues always). */
function advance(t: TurnState, τ: number, inclusive: boolean, out: GameEvent[]): void {
  while (!t.ended && t.freezeSince === null) {
    const next = pendingDeadlines(t)[0];
    if (next === undefined) return;
    const due = next.τ < τ || (next.τ === τ && (inclusive || CUES.includes(next.kind)));
    if (!due) return;
    t.τ = Math.max(t.τ, next.τ);
    const d = t.data;
    if (d.kind === 'serve') fireServe(t, d, next.kind, t.τ, out);
    else fireReturn(t, d, next.kind, t.τ, out);
  }
}

/** Pending deadlines, earliest first; the stable sort keeps each kind's tie order. */
function pendingDeadlines(t: TurnState): Deadline[] {
  const list: Deadline[] = t.data.kind === 'serve' ? serveDeadlines(t, t.data) : returnDeadlines(t, t.data);
  return list.sort((a, b) => a.τ - b.τ);
}

function fireServe(t: TurnState, d: ServeTurnData, kind: Deadline['kind'], τ: number, out: GameEvent[]): void {
  switch (kind) {
    case 'preServe':
      enterPreServe(t, d, τ, out);
      return;
    case 'serveClock':
      fault(t, 'timeViolation', τ, out);
      return;
    case 'tooLow': {
      const p = activePrompt(t);
      if (p !== null && p.locked !== null) {
        fault(t, 'ballDropped', τ, out);
        return;
      }
      t.phase = 'catch';
      t.catchAt = τ;
      t.active = null;
      t.log.push({ τ, k: 'catch' });
      emit(t, out, τ, { type: 'catch', player: d.owner });
      return;
    }
    case 'catchEnd': {
      const clockτ = serveClockτ(t, d);
      if (clockτ !== null && clockτ <= τ) {
        fault(t, 'timeViolation', τ, out);
        return;
      }
      t.setIndex++;
      enterPreServe(t, d, τ, out);
      return;
    }
    default:
      return;
  }
}

function fireReturn(t: TurnState, d: ReturnTurnData, kind: Deadline['kind'], τ: number, out: GameEvent[]): void {
  const f = d.incoming;
  switch (kind) {
    case 'netHit':
      emit(t, out, τ, { type: 'netHit' });
      return;
    case 'bounce':
      emit(t, out, τ, { type: 'bounce', at: { x: f.landing.x, y: f.landing.y }, inCourt: f.outcome === 'in' });
      return;
    case 'call': {
      // Replaces a queued strike; the engine discards the receiver's typing (spec §3.3.5).
      const call = f.outcome === 'net' ? 'net' : 'out';
      emit(t, out, τ, { type: 'call', call: f.isServe ? 'fault' : call, player: d.striker });
      endTurn(t, { kind: 'call', endτ: τ, call }, out);
      return;
    }
    case 'contact':
      if (t.outcome?.kind === 'strike') playStrike(t, t.outcome.strike, out);
      return;
    case 'pass': {
      const chase = t.prompts[0];
      const ace = d.isServeReturn && (chase === undefined || !isComplete(chase));
      endTurn(t, { kind: 'miss', endτ: τ, ace }, out);
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Inputs

function toss(t: TurnState, τ: number, out: GameEvent[]): void {
  const d = t.data;
  if (d.kind !== 'serve' || t.phase !== 'preServe') return;
  const set = d.wordSets[t.setIndex];
  if (set === undefined) return;
  t.phase = 'toss';
  t.tossAt = τ;
  t.catchAt = null;
  t.log.push({ τ, k: 'toss' });
  emit(t, out, τ, { type: 'toss', player: d.owner });
  showPrompt(t, 'serve', set.options, τ, out);
}

function letter(t: TurnState, ch: string, τ: number, out: GameEvent[]): void {
  const p = activePrompt(t);
  if (p === null) return;
  const player = t.data.owner;
  const wasLocked = p.locked !== null;
  const result = applyLetter(p, ch, τ);
  if (result === 'ignored') return;
  if (result === 'wrong') {
    t.log.push({ τ, k: 'bad', prompt: p.id, ch });
    emit(t, out, τ, { type: 'keyBad', player, prompt: p.id });
    return;
  }
  if (!wasLocked && p.locked !== null) {
    t.log.push({ τ, k: 'lock', prompt: p.id, option: p.locked, ch });
    emit(t, out, τ, { type: 'lock', player, prompt: p.id, option: p.locked });
  } else {
    t.log.push({ τ, k: 'ok', prompt: p.id, ch });
    emit(t, out, τ, { type: 'keyOk', player, prompt: p.id });
  }
  endFreeze(t, τ);
  if (result !== 'completed') return;
  t.log.push({ τ, k: 'done', prompt: p.id });
  emit(t, out, τ, { type: 'wordDone', player, prompt: p.id, wpm: wpmOf(wordCps(p)) });
  completed(t, p, τ, out);
}

/** A prompt's word was completed at τ: serve strike, choice prompt after the chase, or queued/stretch strike. */
function completed(t: TurnState, p: PromptState, τ: number, out: GameEvent[]): void {
  const d = t.data;
  if (d.kind === 'serve') {
    playStrike(t, serveStrike(t, d, p, τ), out);
    return;
  }
  if (p.kind === 'chase') {
    t.phase = 'choice';
    showPrompt(t, 'choice', d.choice.options, τ, out);
    return;
  }
  const contactτ = d.incoming.T + t.frozenMs;
  if (τ > contactτ) {
    playStrike(t, returnStrike(t, d, p, τ, true), out);
    return;
  }
  t.phase = 'queued';
  t.outcome = { kind: 'strike', endτ: contactτ, strike: returnStrike(t, d, p, contactτ, false) };
}

// ---------------------------------------------------------------------------------------------
// Transitions

/** Shows a prompt; with `freezeFirst`, the first prompt of a kind freezes the simulation until its first correct key. */
function showPrompt(t: TurnState, kind: PromptKind, options: WordOption[], τ: number, out: GameEvent[]): void {
  const p = createPrompt(t.data.promptBase + t.prompts.length, kind, options.map((o) => ({ ...o })), τ);
  t.prompts.push(p);
  t.active = t.prompts.length - 1;
  t.log.push({ τ, k: 'show', prompt: p.id });
  emit(t, out, τ, { type: 'promptShown', player: t.data.owner, prompt: p.id, kind });
  if (t.seenKinds.includes(kind)) return;
  t.seenKinds.push(kind);
  if (t.data.freezeFirst && t.freezeSince === null) {
    t.freezeSince = τ;
    t.log.push({ τ, k: 'freeze', on: true });
  }
}

function endFreeze(t: TurnState, τ: number): void {
  if (t.freezeSince === null) return;
  t.frozenMs += τ - t.freezeSince;
  t.freezeSince = null;
  t.log.push({ τ, k: 'freeze', on: false });
}

function enterPreServe(t: TurnState, d: ServeTurnData, τ: number, out: GameEvent[]): void {
  t.phase = 'preServe';
  t.tossAt = null;
  t.catchAt = null;
  emit(t, out, τ, { type: 'preServe', server: d.owner, serveNo: d.serveNo, side: d.side });
}

function fault(t: TurnState, reason: 'ballDropped' | 'timeViolation', τ: number, out: GameEvent[]): void {
  emit(t, out, τ, { type: 'call', call: reason, player: t.data.owner });
  endTurn(t, { kind: 'fault', endτ: τ, reason }, out);
}

function playStrike(t: TurnState, s: StrikeInfo, out: GameEvent[]): void {
  const { player, word, kmh, isServe, stretch, forehand } = s;
  emit(t, out, s.τ, { type: 'strike', player, word: word.word, tier: word.tier, kmh, isServe, stretch, forehand });
  endTurn(t, { kind: 'strike', endτ: s.τ, strike: s }, out);
}

function endTurn(t: TurnState, outcome: TurnOutcome, out: GameEvent[]): void {
  t.outcome = outcome;
  t.ended = true;
  t.phase = 'ended';
  t.active = null;
  emit(t, out, outcome.endτ, { type: 'turnEnd', endτ: outcome.endτ });
}

// ---------------------------------------------------------------------------------------------
// Helpers

function emit(t: TurnState, out: GameEvent[], τ: number, body: EventBody): void {
  out.push({ turn: t.data.turnId, τ, ...body });
}

function activePrompt(t: TurnState): PromptState | null {
  return t.active === null ? null : t.prompts[t.active] ?? null;
}

function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
