import { TUNING } from './tuning';
import type { PromptKind, PromptState, WordOption } from './types';

/** The fields of a DOM `KeyboardEvent` that key classification needs (spec §4.5). */
export interface RawKey { key: string; code: string; repeat: boolean; isComposing: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }

/** What a keydown means to the game: a lowercase a–z letter, a toss (Space), or nothing. */
export type KeyClass = { kind: 'letter'; letter: string; viaCode: boolean } | { kind: 'toss' } | { kind: 'ignore' };

/** Effect of one letter on a prompt. */
export type KeyResult = 'ignored' | 'locked' | 'correct' | 'wrong' | 'completed';

const IGNORED_KEYS = new Set(['Process', 'Dead', 'Unidentified']);
// No `u` flag: with it, /i case-folds non-ASCII letters such as 'ſ' into [a-z].
const LATIN_LETTER = /^[a-z]$/i;
const ANY_LETTER = /\p{L}/u;
const LETTER_CODE = /^Key([A-Z])$/;

/**
 * Classifies a keydown per spec §4.5. Repeats, IME input and any Ctrl/Meta/Alt combination
 * (including AltGr) are ignored; a letter of another script maps to its physical `code` letter.
 */
export function classifyKey(e: RawKey): KeyClass {
  if (e.repeat || e.isComposing || IGNORED_KEYS.has(e.key)) return { kind: 'ignore' };
  if (e.ctrlKey || e.metaKey || e.altKey) return { kind: 'ignore' };
  if (e.key === ' ') return { kind: 'toss' };
  if (e.key.length !== 1) return { kind: 'ignore' };
  if (LATIN_LETTER.test(e.key)) return { kind: 'letter', letter: e.key.toLowerCase(), viaCode: false };
  const codeLetter = LETTER_CODE.exec(e.code)?.[1];
  if (codeLetter === undefined || !ANY_LETTER.test(e.key)) return { kind: 'ignore' };
  return { kind: 'letter', letter: codeLetter.toLowerCase(), viaCode: true };
}

/** A fresh prompt shown at τ = `shownAt`; a chase prompt is locked on its only option from the start. */
export function createPrompt(id: number, kind: PromptKind, options: WordOption[], shownAt: number): PromptState {
  return {
    id,
    kind,
    options: [...options],
    locked: kind === 'chase' ? 0 : null,
    typed: 0,
    correctKeys: 0,
    wrongKeys: 0,
    slips: 0,
    inSlip: false,
    tFirst: null,
    tLast: null,
    shownAt,
    completedAt: null,
    lastWrongAt: null,
  };
}

/** Moves the cursor one letter on after a correct key (the lock key included) at τ. */
function advance(p: PromptState, τ: number, len: number): KeyResult {
  p.typed++;
  p.correctKeys++;
  p.tFirst ??= τ;
  p.tLast = τ;
  p.inSlip = false;
  if (p.typed < len) return 'correct';
  p.completedAt = τ;
  return 'completed';
}

/**
 * Applies one letter at τ (mutates p). Lock on first matching initial; strict cursor after.
 * Every correct key, the lock key included, counts in `correctKeys`, so it always equals `typed`.
 */
export function applyLetter(p: PromptState, letter: string, τ: number): KeyResult {
  if (isComplete(p)) return 'ignored';
  const ch = letter.toLowerCase();
  if (p.locked === null) {
    const i = p.options.findIndex((o) => o.word[0] === ch);
    const option = p.options[i];
    if (option === undefined) return 'ignored';
    p.locked = i;
    const result = advance(p, τ, option.len);
    return result === 'correct' ? 'locked' : result;
  }
  const word = lockedWord(p);
  if (word === null) return 'ignored';
  if (word.word[p.typed] === ch) return advance(p, τ, word.len);
  p.wrongKeys++;
  p.lastWrongAt = τ;
  if (!p.inSlip) {
    p.slips++;
    p.inSlip = true;
  }
  return 'wrong';
}

/** True once the locked word has been typed in full. */
export function isComplete(p: PromptState): boolean {
  return p.completedAt !== null;
}

/** The option the prompt is locked on, or null while unlocked. */
export function lockedWord(p: PromptState): WordOption | null {
  return p.locked === null ? null : p.options[p.locked] ?? null;
}

/**
 * cps = (n−1)/max(minSpanS, (tLast−tFirst)/1000) for a completed prompt (spec §3.4);
 * 0 for a prompt that is not complete.
 */
export function wordCps(p: PromptState): number {
  if (!isComplete(p) || p.tFirst === null || p.tLast === null) return 0;
  const spanS = Math.max(TUNING.speed.minSpanS, (p.tLast - p.tFirst) / 1000);
  return (p.typed - 1) / spanS;
}

/** Words per minute for a typing speed in chars/s (WPM = cps × 12). */
export function wpmOf(cps: number): number {
  return cps * 12;
}

/** Progress 0..1 of the locked word (0 if unlocked). */
export function progress(p: PromptState): number {
  const word = lockedWord(p);
  return word === null ? 0 : p.typed / word.len;
}
