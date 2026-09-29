/**
 * The E2E typist (scripts/e2e.mjs): what a page's match looks like through `window.__bbt`, which key
 * to press next, and which screenshot moment the match is at.
 */

/** Turn phases in which the owner types a word. */
const TYPING = new Set(['toss', 'chase', 'choice']);

/**
 * The page's match as the typist sees it; runs inside the page (Playwright serializes it, so it uses
 * nothing from this module). `owner` and `words` come from the same turn as `status`: the viewer's
 * live turn (a guest's own turn) before the displayed one. `points` counts the points played.
 */
export function pageSnapshot(w = window) {
  const b = w.__bbt;
  const vm = b === undefined ? null : b.view();
  if (b === undefined || vm === null) return { status: 'none', me: null, owner: null, words: null, points: 0, coach: null };
  const turn = vm.liveTurn ?? vm.pub.turn;
  return {
    status: b.status(),
    me: vm.viewer === 'spectator' ? null : vm.viewer,
    owner: turn === null || vm.pub.status !== 'playing' ? null : turn.data.owner,
    words: b.activeWords(),
    points: vm.pub.stats[0].pointsWon + vm.pub.stats[1].pointsWon,
    coach: vm.overlay.coach,
  };
}

/** The medium option of three or four (serve, choice), else the first (chase). */
export function mediumOption(words) {
  return words.length >= 3 ? 1 : 0;
}

/** The hardest option (options come in tier order): the widest, riskiest shot, so rallies end sooner. */
export function hardestOption(words) {
  return words.length - 1;
}

/**
 * The Playwright key the typist presses next for `s`, or null to wait: Space in its own PRE_SERVE;
 * in its own toss, chase or choice the next letter of the locked word, or the first letter of the
 * option `choose` picks while nothing is locked.
 */
export function nextKey(s, choose = mediumOption) {
  if (s.me === null || s.owner !== s.me) return null;
  if (s.status === 'preServe') return 'Space';
  const w = s.words;
  if (!TYPING.has(s.status) || w === null) return null;
  const word = w.words[w.locked ?? choose(w.words)] ?? '';
  const typed = w.locked === null ? 0 : w.typed;
  return typed < word.length ? word.charAt(typed) : null;
}

/**
 * The match moment `s` shows, for a screenshot: 'pointCall' (either side's point call banner), or in
 * its own turn 'preServe', and 'toss' / 'chase' / 'choice' while a word is part typed; else null.
 */
export function momentOf(s) {
  if (s.status === 'leadIn:point') return 'pointCall';
  if (s.me === null || s.owner !== s.me) return null;
  if (s.status === 'preServe') return 'preServe';
  const w = s.words;
  if (!TYPING.has(s.status) || w === null || w.locked === null) return null;
  const len = w.words[w.locked]?.length ?? 0;
  return w.typed >= 1 && w.typed < len ? s.status : null;
}
