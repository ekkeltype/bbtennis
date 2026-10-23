import { setLine } from '../../../core/scoring';
import { button, panel } from '../../../ui/controls';
import { h } from '../../../ui/dom';
import type { ScreenFactory } from '../../../ui/router';
import type { ArcadeState, ArcadeStats, PlayerId } from '../../core/types';
import type { Departure } from '../../game/onlineSession';
import type { ArcadeContext } from '../context';

/**
 * Online Results (online spec §3.6, §5): whether Rematch can still be asked for, who forfeited, and how
 * the opponent went away (`opponentGone`) and whether that cut the match short (`endedBy`).
 */
export interface OnlineResults { canRematch: boolean; forfeitBy: PlayerId | null; opponentGone: Departure | null; endedBy: Departure | null }

/** Params of the Results screen: the finished match, whose results these are, and online how it ended. */
export interface ResultsParams { result: Readonly<ArcadeState>; viewer: PlayerId; online?: OnlineResults }

/** What Results say of an opponent who has gone (online spec §3.6). */
const GONE: Readonly<Record<Departure, string>> = { left: 'OPPONENT LEFT', disconnect: 'OPPONENT DISCONNECTED' };

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

/** The winner: the one who did not forfeit, the one still there when the opponent's going cut the match short, else the match's. */
function winnerOf(p: ResultsParams): PlayerId | null {
  const forfeitBy = p.online?.forfeitBy ?? null;
  if (forfeitBy !== null) return forfeitBy === 0 ? 1 : 0;
  if (p.online?.endedBy) return p.viewer;
  return p.result.winner;
}

/** "OPPONENT LEFT" / "OPPONENT DISCONNECTED" when that ended the match, "<NAME> FORFEITS", "YOU WIN!" for the viewer, else "<WINNER> WINS". */
function headline(p: ResultsParams): string {
  const { result: r, viewer, online } = p;
  if (online?.endedBy) return GONE[online.endedBy];
  if (online?.forfeitBy != null) return `${nameOf(r, online.forfeitBy)} FORFEITS`;
  if (r.winner === null) return 'MATCH OVER';
  return r.winner === viewer ? 'YOU WIN!' : `${nameOf(r, r.winner)} WINS`;
}

/**
 * The final score, as the scoreboard shows it: a row per player with each set's games (the
 * tiebreak loser's points as a superscript beside the winner's games), or the points of a
 * Tiebreak-format match. A match cut short online (a forfeit, a player gone) also shows the set it
 * stopped in: its games, or in the Tiebreak format the points so far.
 */
function scoreTable(r: Readonly<ArcadeState>, winner: PlayerId | null): HTMLElement {
  const line = setLine(r.score);
  if (r.status !== 'over') {
    const now = r.score.format === 'tiebreak' ? r.score.points : r.score.games;
    for (const p of PLAYERS) line[p].push({ value: now[p], sup: null });
  }
  const head = r.score.format === 'tiebreak' ? ['POINTS'] : line[0].map((_, i) => `SET ${i + 1}`);
  const row = (p: PlayerId): HTMLElement =>
    h(
      'tr',
      { class: winner === p ? 'won' : '' },
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

/** Rematch: vs CPU at once; online it asks the opponent and waits, and is disabled once the opponent has gone (online spec §3.6). */
function rematchButton(ctx: Pick<ArcadeContext, 'rematch'>, online: OnlineResults | undefined): HTMLButtonElement {
  const b = button(
    'REMATCH',
    () => {
      ctx.rematch();
      if (online === undefined) return;
      b.textContent = 'WAITING FOR OPPONENT...';
      b.disabled = true;
    },
    'primary',
  );
  b.disabled = online?.canRematch === false;
  return b;
}

/**
 * Results (spec §6.3): the winner, the final score and the stats; Rematch (vs CPU: same setup, new
 * seed; online: asks the opponent) or Menu (also Esc). Online (online spec §5) the heading says who
 * forfeited or that the opponent's going ended the match, a note says when they went afterwards, and
 * Rematch is disabled once they have gone.
 */
export function resultsScreen(ctx: Pick<ArcadeContext, 'rematch' | 'quitMatch'>): ScreenFactory {
  return (params) => {
    const p = params as ResultsParams;
    const { result, viewer, online } = p;
    const winner = winnerOf(p);
    const gone = online?.opponentGone ?? null;
    const el = h(
      'div',
      { class: 'screen dim' },
      panel(
        headline(p),
        `results ${winner === viewer ? 'win' : 'loss'}`,
        scoreTable(result, winner),
        statTable(result),
        gone !== null && gone !== online?.endedBy ? h('p', { class: 'note opponent-gone' }, GONE[gone]) : null,
        h(
          'div',
          { class: 'actions' },
          rematchButton(ctx, online),
          button('MENU', () => ctx.quitMatch(), online?.canRematch === false ? 'primary' : ''),
        ),
      ),
    );
    return { el, onBack: () => ctx.quitMatch() };
  };
}
