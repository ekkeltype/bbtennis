import { averageWpm } from '../core/engine';
import type { MatchState } from '../core/types';
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
}

/** True while a player with `matchesPlayed` vs-CPU matches behind them still gets the hints. */
export function hintsOn(matchesPlayed: number): boolean {
  return matchesPlayed < FIRST_MATCHES_WITH_HINTS;
}

/**
 * True when the in-match menu may open over `m` now: a match still being played (not finished or
 * over) on its play screen `screen`. An `auto` pause (window blur, hidden tab, leaving fullscreen)
 * is for local matches only: online play never pauses.
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

/** A finished vs-CPU match's effect on the player's progress, plus the belt it earned (or null). */
export interface CpuMatchRecord { career: Career; matchesPlayed: number; headband: number | null; newBelt: Belt | null }

/**
 * A finished vs-CPU match at `level`, the player being player 0 (spec §3.11): into the career (played,
 * won, best average WPM, a beaten milestone's belt), one more match played (the hints count), and the
 * highest earned belt as the headband unless the player chose one. Never changes `s`.
 */
export function recordCpuMatch(s: CareerState, level: number, result: MatchState): CpuMatchRecord {
  const career = recordCareer(s.career, level, result.winner === 0, averageWpm(result.stats[0]));
  const best = highestBelt(career);
  const newBelt = (career.earned.find((b) => !s.career.earned.includes(b)) as Belt | undefined) ?? null;
  return {
    career,
    matchesPlayed: s.matchesPlayed + 1,
    headband: !s.headbandChosen && best !== null ? BELT_COLOR[best] : s.headband,
    newBelt,
  };
}

/**
 * Online Results already showing (`shown`) once the rematch is no longer open (the opponent has left
 * or dropped): the params to show them again with, Rematch disabled and "OPPONENT LEFT"; null when
 * they stay as they are (a rematch is still open, they already say so, or not an online match).
 */
export function resultsAfterLeave(shown: ResultsParams, rematchOpen: boolean): ResultsParams | null {
  if (shown.kind !== 'online' || rematchOpen || shown.opponentLeft === true) return null;
  return { ...shown, opponentLeft: true };
}
