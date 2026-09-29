import type { ActiveWords, DebugHooks } from '../../src/game/debug';

/** A page's match as the E2E typist sees it through `window.__bbt`. */
export interface Snapshot {
  /** `__bbt.status()`, 'none' without hooks or a match. */
  status: string;
  /** The page's player, null without a match or for a spectator. */
  me: 0 | 1 | null;
  /** Owner of the turn `status` describes while the match is played, else null. */
  owner: 0 | 1 | null;
  /** `__bbt.activeWords()`. */
  words: ActiveWords | null;
  /** Points played so far. */
  points: number;
  /** Training coach text, or null. */
  coach: string | null;
  /** The viewer's open early chase: the word and the letters typed, or null. */
  early: { word: string; typed: number } | null;
}

/** A screenshot moment of a match. */
export type Moment = 'pointCall' | 'preServe' | 'toss' | 'chase' | 'choice';

/** Runs in the page: reads `w.__bbt` (default `window.__bbt`). */
export function pageSnapshot(w?: { __bbt?: DebugHooks }): Snapshot;

/** The medium option of three, else the first. */
export function mediumOption(words: readonly string[]): number;

/** The last (hardest) option. */
export function hardestOption(words: readonly string[]): number;

/** The Playwright key to press next ('Space' or a letter), or null to wait. */
export function nextKey(s: Snapshot, choose?: (words: readonly string[]) => number): string | null;

/** The match moment `s` shows, or null. */
export function momentOf(s: Snapshot): Moment | null;
