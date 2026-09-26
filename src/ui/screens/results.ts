import { setLine } from '../../core/scoring';
import type { Departure } from '../../game/onlineLink';
import { BELT_COLOR, RAMPS } from '../../render/palette';
import { button, panel, swatch } from '../controls';
import type { ResultsParams, UiContext } from '../context';
import { h } from '../dom';
import type { ScreenFactory } from '../router';
import { headline, setScores, statRows } from '../summary';

type MatchResults = Extract<ResultsParams, { kind: 'cpu' | 'online' }>;

/** What Results say of an opponent who has gone (spec §5.3). */
const GONE: Readonly<Record<Departure, string>> = { left: 'OPPONENT LEFT', disconnect: 'OPPONENT DISCONNECTED' };

/**
 * The score line, as the scoreboard shows it: one row per player with the games of each set (or the
 * points of a tiebreak), and a set won in a tiebreak carries the loser's tiebreak points as a superscript
 * beside the winner's games.
 */
function scoreTable(p: MatchResults): HTMLElement {
  const { head, rows } = setScores(p.result);
  const sups = setLine(p.result.score).map((cells) => cells.map((c) => c.sup));
  const winner = p.result.winner;
  const line = (i: 0 | 1): HTMLElement =>
    h(
      'tr',
      { class: winner === i ? 'won' : '' },
      h('th', {}, p.result.players[i].name.toUpperCase()),
      ...rows[i].map((n, k) => {
        const sup = sups[i]?.[k] ?? null;
        return h('td', {}, String(n), sup === null ? null : h('sup', {}, String(sup)));
      }),
    );
  return h('table', { class: 'score' }, h('thead', {}, h('tr', {}, h('th', {}), ...head.map((t) => h('th', {}, t)))), h('tbody', {}, line(0), line(1)));
}

/** The stat table (spec §3.11): a column per player; the longest rally spans both. */
function statTable(p: MatchResults): HTMLElement {
  const names = p.result.players.map((pl) => pl.name.toUpperCase());
  return h(
    'table',
    { class: 'stats' },
    h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, names[0] ?? ''), h('th', {}, names[1] ?? ''))),
    h(
      'tbody',
      {},
      ...statRows(p.result).map((r) =>
        h('tr', {}, h('th', {}, r.label), ...r.cells.map((c) => h('td', { colspan: r.cells.length === 1 ? 2 : null }, c))),
      ),
    ),
  );
}

/** Rematch: vs CPU starts at once; online asks the opponent and waits, and is disabled once the opponent has gone (spec §5.3). */
function rematchButton(ctx: UiContext, p: MatchResults, opponentGone: boolean): HTMLButtonElement {
  const b = button(
    'REMATCH',
    () => {
      ctx.rematch();
      if (p.kind !== 'online') return;
      b.textContent = 'WAITING FOR OPPONENT...';
      b.disabled = true;
    },
    'primary',
  );
  b.disabled = opponentGone;
  return b;
}

function matchResults(ctx: UiContext, p: MatchResults): HTMLElement {
  const won = p.result.winner === p.viewer;
  const belt = p.newBelt;
  const gone = p.kind === 'online' ? (p.opponentGone ?? null) : null;
  const endedBy = p.kind === 'online' ? (p.endedBy ?? null) : null;
  return panel(
    endedBy !== null ? GONE[endedBy] : headline(p.result, p.viewer),
    `results ${won ? 'win' : 'loss'}`,
    scoreTable(p),
    statTable(p),
    belt === null
      ? null
      : h('p', { class: 'belt-earned' }, swatch(RAMPS.cloth[BELT_COLOR[belt]]), `NEW BELT EARNED: ${belt.toUpperCase()}!`),
    gone !== null && gone !== endedBy ? h('p', { class: 'note opponent-gone' }, GONE[gone]) : null,
    h(
      'div',
      { class: 'actions' },
      p.canRematch ? rematchButton(ctx, p, gone !== null) : null,
      button('MENU', () => ctx.quitMatch(), p.canRematch && gone === null ? '' : 'primary'),
    ),
  );
}

/** Training's end: "complete" once all four lessons are done, else a friendly "try again" (no stat table). */
function trainingResults(ctx: UiContext, done: boolean): HTMLElement {
  return panel(
    done ? 'TRAINING COMPLETE!' : 'TRY AGAIN',
    'results training',
    h(
      'p',
      { class: 'message' },
      done
        ? "You know the serve, the chase, picking a shot and the rally. You're ready for your first match!"
        : 'That match ended before the lessons did. No problem: every lesson starts again from the serve.',
    ),
    h(
      'div',
      { class: 'actions' },
      done
        ? button(
            'PLAY VS CPU',
            () => {
              ctx.quitMatch();
              ctx.router.go('cpuSetup');
            },
            'primary',
          )
        : button('TRY AGAIN', () => ctx.startTraining(), 'primary'),
      button('MENU', () => ctx.quitMatch()),
    ),
  );
}

/**
 * Results (spec §4.6): winner banner, score line, stat table, belt earned, Rematch / Menu (online:
 * Rematch disabled with an "OPPONENT LEFT" / "OPPONENT DISCONNECTED" note once the opponent has gone,
 * or that as the banner when their going cut the match short); or the Training panel. Esc goes to
 * the menu.
 */
export function resultsScreen(ctx: UiContext): ScreenFactory {
  return (params) => {
    const p = params as ResultsParams;
    const el = h('div', { class: 'screen dim' }, p.kind === 'training' ? trainingResults(ctx, p.done) : matchResults(ctx, p));
    return { el, onBack: () => ctx.quitMatch() };
  };
}
