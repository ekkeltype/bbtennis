import { accuracy, averageWpm } from '../core/engine';
import type { MatchState, PlayerId, PlayerStats } from '../core/types';

/** One results-table row: a label and one cell per player, or one cell for a match-wide value. */
export interface StatRow { label: string; cells: string[] }

const NONE = '-';
const name = (r: MatchState, p: PlayerId): string => r.players[p].name.toUpperCase();

/** The winner banner: "YOU WIN!" for the viewer, "<NAME> WINS" otherwise, "<NAME> FORFEITS" after a forfeit. */
export function headline(r: MatchState, viewer: PlayerId | 'spectator'): string {
  if (r.forfeitBy !== null) return `${name(r, r.forfeitBy)} FORFEITS`;
  if (r.winner === null) return 'MATCH OVER';
  return r.winner === viewer ? 'YOU WIN!' : `${name(r, r.winner)} WINS`;
}

/**
 * The score line per player: points won in a single-tiebreak match (the tiebreak counts as one game,
 * so the score keeps no points), else games per set, including a set cut short by a forfeit.
 */
export function setScores(r: MatchState): { head: string[]; rows: [number[], number[]] } {
  if (r.score.format === 'tiebreak') return { head: ['POINTS'], rows: [[r.stats[0].pointsWon], [r.stats[1].pointsWon]] };
  const sets = [...r.score.setGames];
  const [g0, g1] = r.score.games;
  if (g0 + g1 > 0) sets.push([g0, g1]);
  return { head: sets.map((_, i) => `SET ${i + 1}`), rows: [sets.map((s) => s[0]), sets.map((s) => s[1])] };
}

const whole = (n: number): string => String(Math.round(n));
const wpm = (n: number): string => (n > 0 ? whole(n) : NONE);

/** Per-player stats of spec §3.11, as shown on the results screen. */
const PER_PLAYER: readonly { label: string; cell(s: PlayerStats): string }[] = [
  { label: 'POINTS WON', cell: (s) => whole(s.pointsWon) },
  { label: 'ACES', cell: (s) => whole(s.aces) },
  { label: 'DOUBLE FAULTS', cell: (s) => whole(s.doubleFaults) },
  { label: 'WINNERS', cell: (s) => whole(s.winners) },
  { label: 'ERRORS', cell: (s) => whole(s.errors) },
  { label: 'AVG WPM', cell: (s) => wpm(averageWpm(s)) },
  { label: 'TOP WPM', cell: (s) => wpm(s.topWpm) },
  { label: 'ACCURACY', cell: (s) => (s.correctKeys + s.wrongKeys > 0 ? `${Math.round(accuracy(s) * 100)}%` : NONE) },
  { label: 'FASTEST SERVE', cell: (s) => (s.fastestServeKmh > 0 ? `${whole(s.fastestServeKmh)} KM/H` : NONE) },
];

/** The results stat table: every per-player stat, then the match's longest rally. */
export function statRows(r: MatchState): StatRow[] {
  const rows = PER_PLAYER.map(({ label, cell }) => ({ label, cells: [cell(r.stats[0]), cell(r.stats[1])] }));
  rows.push({ label: 'LONGEST RALLY', cells: [`${r.longestRally} ${r.longestRally === 1 ? 'SHOT' : 'SHOTS'}`] });
  return rows;
}
