import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/core/engine';
import type { FormatId, MatchState, PlayerInfo, PlayerStats } from '../../src/core/types';
import { headline, setScores, statRows } from '../../src/ui/summary';

const LOOK = { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 };
const PLAYERS: [PlayerInfo, PlayerInfo] = [
  { name: 'Alex', look: LOOK, kind: 'human', cpuLevel: null },
  { name: 'Kenji', look: LOOK, kind: 'cpu', cpuLevel: 6 },
];

function finished(format: FormatId, patch: (s: MatchState) => void): MatchState {
  const config = { format, pace: 'normal', surface: 'hard', wordPack: 'everyday', deuceRule: 'advantage', training: null } as const;
  const s = new Engine({ config, players: PLAYERS, seed: 3 }).state;
  s.status = 'over';
  s.turn = null;
  patch(s);
  return s;
}

const stats = (p: Partial<PlayerStats>): PlayerStats => ({
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
  ...p,
});

describe('headline', () => {
  it('congratulates the viewer on a win and names the winner otherwise', () => {
    const won = finished('tiebreak', (s) => (s.winner = 0));
    const lost = finished('tiebreak', (s) => (s.winner = 1));
    expect(headline(won, 0)).toBe('YOU WIN!');
    expect(headline(lost, 0)).toBe('KENJI WINS');
    expect(headline(won, 'spectator')).toBe('ALEX WINS');
  });

  it('says who forfeited', () => {
    const r = finished('short', (s) => {
      s.winner = 0;
      s.forfeitBy = 1;
    });
    expect(headline(r, 0)).toBe('KENJI FORFEITS');
  });
});

describe('setScores', () => {
  it('a single tiebreak shows the points won', () => {
    const r = finished('tiebreak', (s) => {
      s.winner = 0;
      s.score.setGames = [[1, 0]];
      s.stats = [stats({ pointsWon: 7 }), stats({ pointsWon: 5 })];
    });
    expect(setScores(r)).toEqual({ head: ['POINTS'], rows: [[7], [5]] });
  });

  it('sets show the games of each completed set', () => {
    const r = finished('bo3', (s) => {
      s.winner = 1;
      s.score.setGames = [
        [4, 2],
        [3, 5],
        [4, 5],
      ];
    });
    expect(setScores(r)).toEqual({ head: ['SET 1', 'SET 2', 'SET 3'], rows: [[4, 3, 4], [2, 5, 5]] });
  });

  it('a forfeit mid-set also shows the set in progress', () => {
    const r = finished('full', (s) => {
      s.winner = 0;
      s.forfeitBy = 1;
      s.score.setGames = [];
      s.score.games = [3, 1];
    });
    expect(setScores(r)).toEqual({ head: ['SET 1'], rows: [[3], [1]] });
  });
});

describe('statRows', () => {
  it('lists every spec §3.11 stat per player, formatted', () => {
    const r = finished('short', (s) => {
      s.winner = 0;
      s.longestRally = 9;
      s.stats = [
        stats({
          pointsWon: 20,
          aces: 2,
          doubleFaults: 1,
          winners: 6,
          errors: 4,
          intervalSum: 120,
          typingMs: 36_000,
          topWpm: 71.6,
          correctKeys: 190,
          wrongKeys: 10,
          fastestServeKmh: 151.4,
        }),
        stats({ pointsWon: 12 }),
      ];
    });
    const rows = statRows(r);
    expect(rows.map((row) => row.label)).toEqual([
      'POINTS WON',
      'ACES',
      'DOUBLE FAULTS',
      'WINNERS',
      'ERRORS',
      'AVG WPM',
      'TOP WPM',
      'ACCURACY',
      'FASTEST SERVE',
      'LONGEST RALLY',
    ]);
    const cells = Object.fromEntries(rows.map((row) => [row.label, row.cells]));
    expect(cells['POINTS WON']).toEqual(['20', '12']);
    expect(cells['ACES']).toEqual(['2', '0']);
    expect(cells['AVG WPM']).toEqual(['40', '-']);
    expect(cells['TOP WPM']).toEqual(['72', '-']);
    expect(cells['ACCURACY']).toEqual(['95%', '-']);
    expect(cells['FASTEST SERVE']).toEqual(['151 KM/H', '-']);
    expect(cells['LONGEST RALLY']).toEqual(['9 SHOTS']);
  });

  it('a one-shot longest rally is singular', () => {
    const r = finished('tiebreak', (s) => (s.longestRally = 1));
    expect(statRows(r).at(-1)?.cells).toEqual(['1 SHOT']);
  });
});
