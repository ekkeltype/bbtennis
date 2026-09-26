import { Engine } from '../core/engine';
import type { MatchConfig, MatchState, PlayerStats, Profile } from '../core/types';
import type { ResultsParams } from './context';
import { cpuPlayer, humanPlayer } from './players';

const SAMPLE_CONFIG: MatchConfig = { format: 'bo3', pace: 'normal', surface: 'clay', wordPack: 'everyday', deuceRule: 'advantage', training: null };

function stats(s: Partial<PlayerStats>): PlayerStats {
  return {
    pointsWon: 0,
    aces: 0,
    doubleFaults: 0,
    winners: 0,
    errors: 0,
    wordsCompleted: 0,
    intervalSum: 0,
    typingMs: 0,
    topWpm: 0,
    correctKeys: 0,
    wrongKeys: 0,
    fastestServeKmh: 0,
    ...s,
  };
}

/**
 * A finished best-of-three vs a Green belt, won by the player with the third set decided in a tiebreak
 * (so the score line shows its superscript), for the dev `?screen=results` preview.
 */
function sampleMatch(profile: Profile): MatchState {
  const s = new Engine({ config: SAMPLE_CONFIG, players: [humanPlayer(profile), cpuPlayer(6)], seed: 7 }).state;
  s.status = 'over';
  s.turn = null;
  s.winner = 0;
  s.score.winner = 0;
  s.score.setGames = [
    [4, 2],
    [3, 5],
    [5, 4],
  ];
  s.score.setTiebreaks = [null, null, [7, 3]];
  s.score.games = [0, 0];
  s.score.setsWon = [2, 1];
  s.longestRally = 11;
  s.stats = [
    stats({ pointsWon: 71, aces: 3, doubleFaults: 2, winners: 14, errors: 9, intervalSum: 610, typingMs: 172_000, topWpm: 68.2, correctKeys: 812, wrongKeys: 41, fastestServeKmh: 162.4 }),
    stats({ pointsWon: 64, aces: 1, doubleFaults: 4, winners: 10, errors: 12, intervalSum: 540, typingMs: 150_000, topWpm: 57.9, correctKeys: 700, wrongKeys: 38, fastestServeKmh: 148.9 }),
  ];
  return s;
}

/** The sample match cut short in its third set, the way a dropped connection leaves it. */
function sampleCutShort(profile: Profile): MatchState {
  const s = sampleMatch(profile);
  s.status = 'playing';
  s.winner = null;
  s.score.winner = null;
  s.score.setGames = s.score.setGames.slice(0, 2);
  s.score.setTiebreaks = s.score.setTiebreaks.slice(0, 2);
  s.score.games = [2, 1];
  s.score.setsWon = [1, 1];
  return s;
}

/**
 * Results params for the dev `?screen=results[&sample=training|retry|left|disconnect]` preview
 * (`left`: online, the opponent gone after the match; `disconnect`: online, cut short by a drop).
 */
export function sampleResults(profile: Profile, sample: string | null): ResultsParams {
  if (sample === 'training') return { kind: 'training', done: true };
  if (sample === 'retry') return { kind: 'training', done: false };
  if (sample === 'left') return { kind: 'online', result: sampleMatch(profile), viewer: 0, newBelt: null, canRematch: true, opponentGone: 'left' };
  if (sample === 'disconnect') {
    return { kind: 'online', result: sampleCutShort(profile), viewer: 0, newBelt: null, canRematch: false, opponentGone: 'disconnect', endedBy: 'disconnect' };
  }
  return { kind: 'cpu', result: sampleMatch(profile), viewer: 0, newBelt: 'green', canRematch: true };
}
