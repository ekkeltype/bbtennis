import { CPU_LEVELS } from '../core/cpu';
import { averageWpm } from '../core/engine';
import type { MatchState } from '../core/types';
import type { Departure, EndReason } from '../game/onlineLink';
import type { Session } from '../game/session';
import { BELT_COLOR } from '../render/palette';
import type { MatchKind, ResultsParams } from './context';
import type { OnlineControls } from './screens/online';
import { highestBelt, recordCareer, type Belt, type Career } from './settings';

/** A player's first matches show the SPACE keycap and first-letter hints (spec §3.12). */
export const FIRST_MATCHES_WITH_HINTS = 3;
/** Running time the last Training point's banner gets before the "complete" panel. */
export const TRAINING_END_MS = 2500;
/** Screens over a match being played: keys go to the game there, and only there. */
export const PLAY_SCREENS: ReadonlySet<string> = new Set(['match', 'training']);

/** The match being played: its session and what Results, Restart and Rematch need. */
export interface Match {
  kind: MatchKind;
  session: Session;
  /** A new session with the same config and players (Restart, vs-CPU Rematch); null online. */
  make: (() => Session) | null;
  /** vs CPU: the opponent's level, for the career. */
  level: number | null;
  controls: OnlineControls | null;
  /** Training: running time counted since every lesson was done (null before), see `trainingEnd`. */
  sinceDoneMs: number | null;
  /** The Results showing for this match; null while it is played. */
  results: ResultsParams | null;
  /** The session is no longer advanced or drawn (a Training session left running when complete). */
  frozen: boolean;
  /** vs CPU: the match is in the career (recorded once, as it was decided), with what it earned; null before. */
  recorded: CpuCredit | null;
}

/** True while a player with `matchesPlayed` vs-CPU matches behind them still gets the hints. */
export function hintsOn(matchesPlayed: number): boolean {
  return matchesPlayed < FIRST_MATCHES_WITH_HINTS;
}

/**
 * True once the match's result is known: its latest frame's state says it is over, from the frame
 * its final point is decided, through the MATCH_OVER celebration (after which `over` is true too).
 */
export function decided(session: Pick<Session, 'over' | 'view'>): boolean {
  return session.over || session.view?.pub.status === 'over';
}

/**
 * True when the in-match menu may open over `m` now: a match still being played (not finished, and
 * not `over`: pass `decided`, so no menu opens over the MATCH_OVER celebration, whose Quit or Restart
 * would drop a finished match) on its play screen `screen`. An `auto` pause (window blur, hidden tab,
 * leaving fullscreen) is for local matches only: online play never pauses.
 */
export function mayPause(m: { kind: MatchKind; finished: boolean; over: boolean }, screen: string, auto: boolean): boolean {
  if (m.finished || m.over || !PLAY_SCREENS.has(screen)) return false;
  return !auto || m.kind !== 'online';
}

/** A Training frame as its end check sees it. */
export interface TrainingFrame {
  /** Every lesson is done. */
  lessonsDone: boolean;
  /** The session's match is over. */
  over: boolean;
  /** The session runs on its play screen: no menu over it, not paused, no resume countdown. */
  running: boolean;
  /** Time since the previous frame. */
  dtMs: number;
}

/**
 * One frame of Training's end check (spec §3.12). `sinceDoneMs` is the running time counted since
 * every lesson was done (null before; 0 on the frame they are). Only running frames count, so a pause
 * right after the last lesson keeps the pause menu up. Shows "complete" once the count reaches
 * TRAINING_END_MS (the last point's banner has played), or "try again" if the match ended first.
 */
export function trainingEnd(sinceDoneMs: number | null, f: TrainingFrame): { sinceDoneMs: number | null; show: 'complete' | 'tryAgain' | null } {
  if (sinceDoneMs === null) {
    if (f.lessonsDone) return { sinceDoneMs: 0, show: null };
    return { sinceDoneMs: null, show: f.over ? 'tryAgain' : null };
  }
  const since = f.running ? sinceDoneMs + f.dtMs : sinceDoneMs;
  return { sinceDoneMs: since, show: since >= TRAINING_END_MS ? 'complete' : null };
}

/** The player's progress a finished vs-CPU match updates. */
export interface CareerState {
  career: Career;
  matchesPlayed: number;
  /** The profile's headband (a cloth index, or null for none). */
  headband: number | null;
  /** The player picked a headband in Customize: the earned belt no longer sets it. */
  headbandChosen: boolean;
}

/**
 * vs CPU: puts the match into the career through `record` (see PlayerStore.recordCpuMatch) the first
 * time its state `pub` says it is over, the frame its final point is decided, not 3 s later when the
 * celebration has played and Results show: whatever the player does meanwhile (a menu opened in the
 * same frame, a closed tab) keeps the result. Once per match; what it earned waits in `m.recorded`.
 */
export function recordWhenDecided(m: Match, pub: MatchState, record: (level: number, result: MatchState) => CpuCredit): void {
  if (m.kind !== 'cpu' || m.recorded !== null || pub.status !== 'over') return;
  m.recorded = record(m.level ?? 0, pub);
}

/**
 * What a finished vs-CPU match earned, for Results: a belt colour new to the career (or null), and
 * `newLevel`, a level with stripes or a dan grade won for the first time (absent otherwise).
 */
export interface CpuCredit { newBelt: Belt | null; newLevel?: number }

/** A finished vs-CPU match's effect on the player's progress, plus what it earned. */
export interface CpuMatchRecord extends CpuCredit { career: Career; matchesPlayed: number; headband: number | null }

/**
 * A finished vs-CPU match at `level`, the player being player 0 (spec §3.11): into the career (played,
 * won, best average WPM, the beaten level's belt colour), one more match played (the hints count), and
 * the highest earned belt as the headband unless the player chose one; a first win at a level with
 * stripes or a dan grade is reported as `newLevel`. Never changes `s`.
 */
export function recordCpuMatch(s: CareerState, level: number, result: MatchState): CpuMatchRecord {
  const career = recordCareer(s.career, level, result.winner === 0, averageWpm(result.stats[0]));
  const best = highestBelt(career);
  const newBelt = (career.earned.find((b) => !s.career.earned.includes(b)) as Belt | undefined) ?? null;
  const info = CPU_LEVELS[level];
  const graded = info !== undefined && (info.stripes > 0 || info.dan > 0);
  const firstWin = result.winner === 0 && s.career.perLevel[level]?.won === 0;
  return {
    career,
    matchesPlayed: s.matchesPlayed + 1,
    headband: !s.headbandChosen && best !== null ? BELT_COLOR[best] : s.headband,
    newBelt,
    ...(graded && firstWin ? { newLevel: level } : {}),
  };
}

/** Online Results' word on the opponent (see ResultsParams). */
export interface OnlineEnd { opponentGone?: Departure; endedBy?: Departure }

/**
 * What an online match's Results say about the opponent, from the session's `endReason` and
 * `opponentGone`: nothing while they are there; `opponentGone` once they have left or dropped; and
 * `endedBy` too when that is what ended the match (not a match this side left first), so the first
 * Results already read "OPPONENT DISCONNECTED" or "OPPONENT LEFT" (spec §5.3).
 */
export function onlineEnd(c: { endReason: EndReason | null; opponentGone: Departure | null }): OnlineEnd {
  const gone = c.opponentGone;
  if (gone === null) return {};
  return c.endReason === gone ? { opponentGone: gone, endedBy: gone } : { opponentGone: gone };
}

/**
 * Online Results already showing (`shown`) once the opponent has gone (`gone`: left or dropped after
 * the match ended): the params to show them again with, Rematch disabled and a note saying how; null
 * when they stay as they are (the opponent is there, they already say so, or not an online match).
 */
export function resultsAfterLeave(shown: ResultsParams, gone: Departure | null): ResultsParams | null {
  if (shown.kind !== 'online' || gone === null || shown.opponentGone !== undefined) return null;
  return { ...shown, opponentGone: gone };
}
