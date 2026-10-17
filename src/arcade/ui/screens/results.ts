import { setLine } from '../../../core/scoring';
import { button, panel } from '../../../ui/controls';
import { h } from '../../../ui/dom';
import type { ScreenFactory } from '../../../ui/router';
import type { ArcadeState, ArcadeStats, PlayerId } from '../../core/types';
import type { ArcadeContext } from '../context';

/** Params of the Results screen: the finished match and whose results these are. */
export interface ResultsParams { result: Readonly<ArcadeState>; viewer: PlayerId }

const NONE = '-';
const PLAYERS = [0, 1] as const;

/** The per-player rows of spec §6.3 (points won first), each cell from one player's stats. */
const STATS: readonly { label: string; cell(s: ArcadeStats): string }[] = [
  { label: 'POINTS WON', cell: (s) => String(s.pointsWon) },
  { label: 'ACES', cell: (s) => String(s.aces) },
  { label: 'DOUBLE FAULTS', cell: (s) => String(s.doubleFaults) },
  { label: 'WINNERS', cell: (s) => String(s.winners) },
  { label: 'ERRORS', cell: (s) => String(s.errors) },
  { label: 'PERFECT HITS', cell: (s) => String(s.perfectHits) },
  { label: 'FASTEST SERVE', cell: (s) => (s.fastestServeKmh > 0 ? `${Math.round(s.fastestServeKmh)} KM/H` : NONE) },
];

const nameOf = (r: Readonly<ArcadeState>, p: PlayerId): string => r.players[p].name.toUpperCase();

/** "YOU WIN!" for the viewer, else "<WINNER> WINS". */
function headline(r: Readonly<ArcadeState>, viewer: PlayerId): string {
  if (r.winner === null) return 'MATCH OVER';
  return r.winner === viewer ? 'YOU WIN!' : `${nameOf(r, r.winner)} WINS`;
}

/**
 * The final score, as the scoreboard shows it: a row per player with each set's games (the
 * tiebreak loser's points as a superscript beside the winner's games), or the points of a
 * Tiebreak-format match.
 */
function scoreTable(r: Readonly<ArcadeState>): HTMLElement {
  const line = setLine(r.score);
  const head = r.score.format === 'tiebreak' ? ['POINTS'] : line[0].map((_, i) => `SET ${i + 1}`);
  const row = (p: PlayerId): HTMLElement =>
    h(
      'tr',
      { class: r.winner === p ? 'won' : '' },
      h('th', {}, nameOf(r, p)),
      ...line[p].map((c) => h('td', {}, String(c.value), c.sup === null ? null : h('sup', {}, String(c.sup)))),
    );
  return h('table', { class: 'score' }, h('thead', {}, h('tr', {}, h('th', {}), ...head.map((t) => h('th', {}, t)))), h('tbody', {}, ...PLAYERS.map(row)));
}

/** The stats table (spec §6.3): a column per player; the longest rally spans both. */
function statTable(r: Readonly<ArcadeState>): HTMLElement {
  const rally = `${r.longestRally} ${r.longestRally === 1 ? 'SHOT' : 'SHOTS'}`;
  return h(
    'table',
    { class: 'stats' },
    h('thead', {}, h('tr', {}, h('th', {}), ...PLAYERS.map((p) => h('th', {}, nameOf(r, p))))),
    h(
      'tbody',
      {},
      ...STATS.map((s) => h('tr', {}, h('th', {}, s.label), ...PLAYERS.map((p) => h('td', {}, s.cell(r.stats[p]))))),
      h('tr', {}, h('th', {}, 'LONGEST RALLY'), h('td', { colspan: 2 }, rally)),
    ),
  );
}

/** Results (spec §6.3): the winner, the final score and the stats; Rematch (same setup, new seed) or Menu (also Esc). */
export function resultsScreen(ctx: Pick<ArcadeContext, 'rematch' | 'quitMatch'>): ScreenFactory {
  return (params) => {
    const { result, viewer } = params as ResultsParams;
    const el = h(
      'div',
      { class: 'screen dim' },
      panel(
        headline(result, viewer),
        `results ${result.winner === viewer ? 'win' : 'loss'}`,
        scoreTable(result),
        statTable(result),
        h('div', { class: 'actions' }, button('REMATCH', () => ctx.rematch(), 'primary'), button('MENU', () => ctx.quitMatch())),
      ),
    );
    return { el, onBack: () => ctx.quitMatch() };
  };
}
