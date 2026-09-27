import { intBelow, shuffleInPlace } from '../rng';
import { TUNING } from '../tuning';
import { ALL_TIERS, TIERS, type PickerState, type RngState, type WordOption, type WordPackId } from '../types';
import { packWords, tierOfLength } from './lists';

/** Rejection-sampling attempts with every rule enforced before the history rule is relaxed. */
const MAX_ATTEMPTS = 200;

const QWERTY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/**
 * US QWERTY neighbours of each letter: left/right in its row plus the two keys it touches in each
 * staggered row (key i touches keys i and i+1 of the row above and keys i−1 and i of the row below).
 */
export const QWERTY_ADJ: Record<string, string> = buildAdjacency();

function buildAdjacency(): Record<string, string> {
  const adj: Record<string, string> = {};
  QWERTY_ROWS.forEach((row, r) => {
    const above = QWERTY_ROWS[r - 1] ?? '';
    const below = QWERTY_ROWS[r + 1] ?? '';
    [...row].forEach((key, i) => {
      adj[key] = [row[i - 1], row[i + 1], above[i], above[i + 1], below[i - 1], below[i]].filter(Boolean).join('');
    });
  });
  return adj;
}

/** True when the words' initials are pairwise distinct and never adjacent on US QWERTY (spec §1.2). */
export function initialsOk(words: readonly string[]): boolean {
  const initials = words.map((w) => w.charAt(0));
  return initials.every((a, i) =>
    initials.slice(i + 1).every((b) => a !== b && !(QWERTY_ADJ[a] ?? '').includes(b)),
  );
}

/** A fresh picker: no offered-word history, training cursors at the start of their lists. */
export function createPicker(): PickerState {
  return { history: [], fixedServe: 0, fixedChoice: 0 };
}

/**
 * One word per tier satisfying all rules: easy, medium and hard, plus insane when `insane` (a full
 * power meter, power-meter spec §4.2); records every word in history. `avoid` = words that must not
 * appear (previous toss). Rejection-samples up to MAX_ATTEMPTS sets with every rule; if none passes,
 * relaxes the history rule for this pick only (the initials and `avoid` rules always hold) and
 * searches exhaustively, so it never loops unboundedly. With `insane` off the draws are exactly
 * those of a 3-word pick. Throws only if no set can satisfy those two rules.
 */
export function pickSet(
  rng: RngState,
  picker: PickerState,
  pack: WordPackId,
  avoid: readonly string[] = [],
  insane = false,
): WordOption[] {
  const lists = (insane ? ALL_TIERS : TIERS).map((tier) => packWords(pack, tier));
  const words =
    sampleSet(rng, lists, new Set([...picker.history, ...avoid])) ??
    searchSet(rng, lists.map((list) => list.filter((w) => !avoid.includes(w))));
  if (words === null) throw new Error(`pickSet: no ${pack} set satisfies the avoid and initials rules`);
  picker.history.push(...words);
  picker.history.splice(0, Math.max(0, picker.history.length - TUNING.words.historySize));
  return words.map(toOption);
}

/** Up to MAX_ATTEMPTS uniform draws of one word per list; the first with valid initials and no blocked word wins. */
function sampleSet(rng: RngState, lists: readonly (readonly string[])[], blocked: ReadonlySet<string>): string[] | null {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const words = lists.map((list) => list[intBelow(rng, list.length)] as string);
    if (initialsOk(words) && !words.some((w) => blocked.has(w))) return words;
  }
  return null;
}

/** Randomised depth-first search over initials for one word per pool with valid initials; null if none exists. */
function searchSet(rng: RngState, pools: readonly (readonly string[])[]): string[] | null {
  const groups = pools.map(groupByInitial);
  const extend = (chosen: string[]): string[] | null => {
    const group = groups[chosen.length];
    if (group === undefined) return chosen;
    for (const initial of shuffleInPlace(rng, Object.keys(group))) {
      if (!initialsOk([...chosen, initial])) continue;
      const candidates = group[initial] as string[];
      const found = extend([...chosen, candidates[intBelow(rng, candidates.length)] as string]);
      if (found !== null) return found;
    }
    return null;
  };
  return extend([]);
}

function groupByInitial(words: readonly string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const w of words) (groups[w.charAt(0)] ??= []).push(w);
  return groups;
}

/** Training: next fixed triple (cycled). Each kind keeps its own cursor; the random-pick history is untouched. */
export function pickFixed(picker: PickerState, list: string[][], which: 'serve' | 'choice'): WordOption[] {
  const cursorKey = which === 'serve' ? 'fixedServe' : 'fixedChoice';
  const cursor = picker[cursorKey] % list.length;
  const triple = list[cursor];
  if (triple === undefined) throw new Error('pickFixed: the fixed word list is empty');
  picker[cursorKey] = (cursor + 1) % list.length;
  return triple.map(toOption);
}

/** Wraps a word as a WordOption with its length and tier; throws unless it is lowercase a–z of a tier length (2–15 letters). */
export function toOption(word: string): WordOption {
  const tier = /^[a-z]+$/.test(word) ? tierOfLength(word.length) : null;
  if (tier === null) throw new Error(`toOption: invalid word ${JSON.stringify(word)}`);
  return { word, len: word.length, tier };
}
