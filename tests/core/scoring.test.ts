import { describe, expect, it } from 'vitest';
import { chance, seedRng, uniform } from '../../src/core/rng';
import {
  awardPoint,
  createScore,
  currentServer,
  gamesToWinSet,
  pointsDisplay,
  serveSide,
  setLine,
  situation,
  umpireCall,
  type AwardResult,
} from '../../src/core/scoring';
import { other, type DeuceRule, type FormatId, type PlayerId, type ScoreState, type Side } from '../../src/core/types';

const NAMES: [string, string] = ['Alex', 'Bo'];
const NO_CHANGE: AwardResult = { game: null, set: null, match: null };

/** Awards one point per character of `seq` ('0' or '1'); returns the last result. */
function play(s: ScoreState, seq: string): AwardResult {
  let last = NO_CHANGE;
  for (const ch of seq) last = awardPoint(s, ch === '0' ? 0 : 1);
  return last;
}

/** Plays whole games (or a tiebreak) won by `p`; returns the result of the game-winning point. */
function winGame(s: ScoreState, p: PlayerId): AwardResult {
  for (let i = 0; i < 20; i++) {
    const r = awardPoint(s, p);
    if (r.game !== null) return r;
  }
  throw new Error('game did not end after 20 straight points');
}

/** Plays one game per character of `seq`, each won by that player; returns the last result. */
function playGames(s: ScoreState, seq: string): AwardResult {
  let last = NO_CHANGE;
  for (const ch of seq) last = winGame(s, ch === '0' ? 0 : 1);
  return last;
}

describe('createScore', () => {
  it('starts a set format at love-all in games and points with the coin-toss winner serving', () => {
    const s = createScore('short', 'advantage', 1);
    expect(s).toStrictEqual({
      format: 'short',
      deuceRule: 'advantage',
      setGames: [],
      setTiebreaks: [],
      games: [0, 0],
      points: [0, 0],
      inTiebreak: false,
      setsWon: [0, 0],
      firstServerOfMatch: 1,
      gameServer: 1,
      winner: null,
    });
    expect(currentServer(s)).toBe(1);
  });

  it('starts the tiebreak format inside its single tiebreak, served first by the coin-toss winner', () => {
    const s = createScore('tiebreak', 'golden', 1);
    expect(s.inTiebreak).toBe(true);
    expect(currentServer(s)).toBe(1);
    expect(serveSide(s)).toBe('deuce');
  });
});

describe('gamesToWinSet', () => {
  it('is 4 for short sets and best of three, 6 for a full set, 0 for the tiebreak format', () => {
    expect(gamesToWinSet('short')).toBe(4);
    expect(gamesToWinSet('bo3')).toBe(4);
    expect(gamesToWinSet('full')).toBe(6);
    expect(gamesToWinSet('tiebreak')).toBe(0);
  });
});

describe('games', () => {
  it('love game: four straight points win the game and the serve passes over', () => {
    const s = createScore('short', 'advantage', 0);
    expect(play(s, '000')).toStrictEqual(NO_CHANGE);
    expect(pointsDisplay(s)).toStrictEqual(['40', '0']);
    expect(awardPoint(s, 0)).toStrictEqual({ game: 0, set: null, match: null });
    expect(s.games).toStrictEqual([1, 0]);
    expect(s.points).toStrictEqual([0, 0]);
    expect(currentServer(s)).toBe(1);
  });

  it('deuce -> advantage -> deuce -> advantage -> game', () => {
    const s = createScore('short', 'advantage', 0);
    play(s, '000111');
    expect(pointsDisplay(s)).toStrictEqual(['40', '40']);
    expect(awardPoint(s, 0)).toStrictEqual(NO_CHANGE);
    expect(pointsDisplay(s)).toStrictEqual(['AD', '']);
    expect(awardPoint(s, 1)).toStrictEqual(NO_CHANGE);
    expect(pointsDisplay(s)).toStrictEqual(['40', '40']);
    expect(awardPoint(s, 1)).toStrictEqual(NO_CHANGE);
    expect(pointsDisplay(s)).toStrictEqual(['', 'AD']);
    expect(awardPoint(s, 1)).toStrictEqual({ game: 1, set: null, match: null });
    expect(s.games).toStrictEqual([0, 1]);
  });

  it('golden point: at 40-40 the next point wins the game', () => {
    const s = createScore('short', 'golden', 0);
    play(s, '000111');
    expect(pointsDisplay(s)).toStrictEqual(['40', '40']);
    expect(awardPoint(s, 1)).toStrictEqual({ game: 1, set: null, match: null });
    expect(s.games).toStrictEqual([0, 1]);
  });

  it('golden point never applies inside a tiebreak', () => {
    const s = createScore('short', 'golden', 0);
    playGames(s, '01010101');
    expect(s.inTiebreak).toBe(true);
    play(s, '010101010101');
    expect(s.points).toStrictEqual([6, 6]);
    expect(awardPoint(s, 0)).toStrictEqual(NO_CHANGE);
    expect(awardPoint(s, 0)).toStrictEqual({ game: 0, set: 0, match: 0 });
  });

  it('the server alternates every game, straight across a set boundary', () => {
    const s = createScore('bo3', 'advantage', 0);
    const servers: PlayerId[] = [];
    for (const ch of '00001') {
      servers.push(currentServer(s));
      winGame(s, ch === '0' ? 0 : 1);
    }
    expect(s.setGames).toStrictEqual([[4, 0]]);
    expect(servers).toStrictEqual([0, 1, 0, 1, 0]);
    expect(currentServer(s)).toBe(1);
  });
});

describe('serveSide', () => {
  it('is the deuce side when the points played in the game are even, ad side when odd', () => {
    const s = createScore('short', 'advantage', 0);
    const sides: Side[] = [];
    for (const ch of '00011101') {
      sides.push(serveSide(s));
      play(s, ch);
    }
    // 0-0, 15-0, 30-0, 40-0, 40-15, 40-30, deuce, AD server, deuce
    expect(sides).toStrictEqual(['deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad']);
    expect(pointsDisplay(s)).toStrictEqual(['40', '40']);
    expect(serveSide(s)).toBe('deuce');
  });

  it('serves the golden point from the deuce side (6 points played)', () => {
    const s = createScore('short', 'golden', 0);
    play(s, '000111');
    expect(serveSide(s)).toBe('deuce');
  });
});

describe('sets', () => {
  it('a short set is won 4-2', () => {
    const s = createScore('bo3', 'advantage', 0);
    expect(playGames(s, '00110')).toStrictEqual({ game: 0, set: null, match: null });
    expect(s.games).toStrictEqual([3, 2]);
    expect(playGames(s, '0')).toStrictEqual({ game: 0, set: 0, match: null });
    expect(s.setGames).toStrictEqual([[4, 2]]);
    expect(s.setsWon).toStrictEqual([1, 0]);
    expect(s.games).toStrictEqual([0, 0]);
    expect(s.points).toStrictEqual([0, 0]);
  });

  it('4-3 is not enough: a short set needs a two-game lead, so 5-3 wins it', () => {
    const s = createScore('bo3', 'advantage', 0);
    expect(playGames(s, '0101010')).toStrictEqual({ game: 0, set: null, match: null });
    expect(s.games).toStrictEqual([4, 3]);
    expect(playGames(s, '0')).toStrictEqual({ game: 0, set: 0, match: null });
    expect(s.setGames).toStrictEqual([[5, 3]]);
  });

  it('5-4 cannot be reached by a normal game: 4-4 goes to a tiebreak to 7, recorded as 5-4', () => {
    const s = createScore('bo3', 'advantage', 0);
    playGames(s, '01010101');
    expect(s.games).toStrictEqual([4, 4]);
    expect(s.inTiebreak).toBe(true);
    expect(play(s, '0000')).toStrictEqual(NO_CHANGE);
    expect(pointsDisplay(s)).toStrictEqual(['4', '0']);
    expect(play(s, '00')).toStrictEqual(NO_CHANGE);
    expect(awardPoint(s, 0)).toStrictEqual({ game: 0, set: 0, match: null });
    expect(s.setGames).toStrictEqual([[5, 4]]);
    expect(s.setTiebreaks).toStrictEqual([[7, 0]]);
    expect(s.inTiebreak).toBe(false);
  });

  it('a full set is won 6-4 and 7-5, and 5-5 is not a tiebreak', () => {
    const a = createScore('full', 'advantage', 0);
    expect(playGames(a, '010101010')).toStrictEqual({ game: 0, set: null, match: null });
    expect(playGames(a, '0')).toStrictEqual({ game: 0, set: 0, match: 0 });
    expect(a.setGames).toStrictEqual([[6, 4]]);

    const b = createScore('full', 'advantage', 0);
    playGames(b, '0101010101');
    expect(b.games).toStrictEqual([5, 5]);
    expect(b.inTiebreak).toBe(false);
    expect(playGames(b, '0')).toStrictEqual({ game: 0, set: null, match: null });
    expect(playGames(b, '0')).toStrictEqual({ game: 0, set: 0, match: 0 });
    expect(b.setGames).toStrictEqual([[7, 5]]);
  });

  it('a full set goes to a tiebreak at 6-6, recorded as 7-6', () => {
    const s = createScore('full', 'advantage', 0);
    playGames(s, '010101010101');
    expect(s.games).toStrictEqual([6, 6]);
    expect(s.inTiebreak).toBe(true);
    expect(winGame(s, 1)).toStrictEqual({ game: 1, set: 1, match: 1 });
    expect(s.setGames).toStrictEqual([[6, 7]]);
    expect(s.setTiebreaks).toStrictEqual([[0, 7]]);
  });
});

describe('tiebreak serving', () => {
  it('at 4-4 the player due serves one point, then serve alternates every two points (A, B, B, A, A, B, ...)', () => {
    const s = createScore('short', 'advantage', 1);
    playGames(s, '01010101');
    expect(s.inTiebreak).toBe(true);
    const servers: PlayerId[] = [];
    const sides: Side[] = [];
    for (let i = 0; i < 12; i++) {
      servers.push(currentServer(s));
      sides.push(serveSide(s));
      awardPoint(s, i % 2 === 0 ? 0 : 1);
    }
    expect(servers).toStrictEqual([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
    expect(sides).toStrictEqual(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 'deuce' : 'ad')));
    expect(s.points).toStrictEqual([6, 6]);
  });

  it('the tiebreak format rotates the same way from the coin-toss winner', () => {
    const s = createScore('tiebreak', 'advantage', 0);
    const servers: PlayerId[] = [];
    for (let i = 0; i < 6; i++) {
      servers.push(currentServer(s));
      awardPoint(s, i % 2 === 0 ? 1 : 0);
    }
    expect(servers).toStrictEqual([0, 1, 1, 0, 0, 1]);
  });

  it('whoever served first in a tiebreak receives first in the next set', () => {
    const s = createScore('bo3', 'advantage', 0);
    playGames(s, '01010101');
    expect(currentServer(s)).toBe(0);
    expect(winGame(s, 1)).toStrictEqual({ game: 1, set: 1, match: null });
    expect(s.setGames).toStrictEqual([[4, 5]]);
    expect(currentServer(s)).toBe(1);

    // ... and a tiebreak in that next set is opened by the player due, now player 1.
    playGames(s, '01010101');
    expect(s.inTiebreak).toBe(true);
    expect(currentServer(s)).toBe(1);
  });
});

describe('match end', () => {
  it('best of three ends at 2-0 in sets', () => {
    const s = createScore('bo3', 'advantage', 0);
    expect(playGames(s, '0000')).toStrictEqual({ game: 0, set: 0, match: null });
    expect(s.winner).toBeNull();
    expect(playGames(s, '0000')).toStrictEqual({ game: 0, set: 0, match: 0 });
    expect(s.winner).toBe(0);
    expect(s.setsWon).toStrictEqual([2, 0]);
    expect(s.setGames).toStrictEqual([[4, 0], [4, 0]]);
  });

  it('best of three ends at 2-1 in sets, with no match tiebreak', () => {
    const s = createScore('bo3', 'advantage', 1);
    expect(playGames(s, '1111')).toStrictEqual({ game: 1, set: 1, match: null });
    expect(playGames(s, '0000')).toStrictEqual({ game: 0, set: 0, match: null });
    expect(s.setsWon).toStrictEqual([1, 1]);
    expect(s.inTiebreak).toBe(false);
    expect(playGames(s, '111')).toStrictEqual({ game: 1, set: null, match: null });
    expect(playGames(s, '1')).toStrictEqual({ game: 1, set: 1, match: 1 });
    expect(s.winner).toBe(1);
    expect(s.setsWon).toStrictEqual([1, 2]);
    expect(s.setGames).toStrictEqual([[0, 4], [4, 0], [0, 4]]);
    expect(s.setTiebreaks).toStrictEqual([null, null, null]);
  });

  it('a single short set is the whole match', () => {
    const s = createScore('short', 'advantage', 0);
    expect(playGames(s, '0000')).toStrictEqual({ game: 0, set: 0, match: 0 });
    expect(s.winner).toBe(0);
  });

  it('the tiebreak format ends at 7-5', () => {
    const s = createScore('tiebreak', 'advantage', 0);
    play(s, '01010101010');
    expect(s.points).toStrictEqual([6, 5]);
    expect(awardPoint(s, 0)).toStrictEqual({ game: 0, set: 0, match: 0 });
    expect(s.winner).toBe(0);
    expect(s.setsWon).toStrictEqual([1, 0]);
    expect(s.setGames).toStrictEqual([[1, 0]]);
    expect(s.setTiebreaks).toStrictEqual([[7, 5]]);
    expect(s.inTiebreak).toBe(false);
    expect(JSON.parse(JSON.stringify(s))).toStrictEqual(s);
  });

  it('the tiebreak format needs two clear points: 8-7 plays on, 9-7 ends it', () => {
    const s = createScore('tiebreak', 'advantage', 0);
    play(s, '01010101010101');
    expect(s.points).toStrictEqual([7, 7]);
    expect(awardPoint(s, 1)).toStrictEqual(NO_CHANGE);
    expect(pointsDisplay(s)).toStrictEqual(['7', '8']);
    expect(awardPoint(s, 1)).toStrictEqual({ game: 1, set: 1, match: 1 });
    expect(s.winner).toBe(1);
  });

  it('points awarded after the match is over change nothing', () => {
    const s = createScore('short', 'advantage', 0);
    playGames(s, '0000');
    const before = structuredClone(s);
    expect(awardPoint(s, 1)).toStrictEqual(NO_CHANGE);
    expect(s).toStrictEqual(before);
  });
});

describe('pointsDisplay', () => {
  it('shows 0, 15, 30, 40 for each player', () => {
    const s = createScore('short', 'advantage', 0);
    const shown: [string, string][] = [pointsDisplay(s)];
    for (const ch of '010011') {
      play(s, ch);
      shown.push(pointsDisplay(s));
    }
    expect(shown).toStrictEqual([
      ['0', '0'],
      ['15', '0'],
      ['15', '15'],
      ['30', '15'],
      ['40', '15'],
      ['40', '30'],
      ['40', '40'],
    ]);
  });

  it('shows plain digits in a tiebreak', () => {
    const s = createScore('tiebreak', 'advantage', 0);
    play(s, '00100');
    expect(pointsDisplay(s)).toStrictEqual(['4', '1']);
  });
});

describe('setLine', () => {
  it('shows nothing before a set is complete', () => {
    const s = createScore('bo3', 'advantage', 0);
    playGames(s, '010');
    expect(setLine(s)).toStrictEqual([[], []]);
    expect(setLine(createScore('tiebreak', 'advantage', 0))).toStrictEqual([[], []]);
  });

  it("shows each completed set's games, and the tiebreak loser's points as a superscript beside the set winner's games", () => {
    const s = createScore('bo3', 'advantage', 0);
    playGames(s, '0000');
    playGames(s, '10101010');
    play(s, '11111000000111');
    expect(s.setGames).toStrictEqual([[4, 0], [4, 5]]);
    expect(s.setTiebreaks).toStrictEqual([null, [6, 8]]);
    expect(setLine(s)).toStrictEqual([
      [{ value: 4, sup: null }, { value: 4, sup: null }],
      [{ value: 0, sup: null }, { value: 5, sup: 6 }],
    ]);
  });

  it('shows a full set won 7-6 in a 7-5 tiebreak as 7⁵ over 6', () => {
    const s = createScore('full', 'advantage', 1);
    playGames(s, '010101010101');
    play(s, '01010101010' + '0');
    expect(setLine(s)).toStrictEqual([[{ value: 7, sup: 5 }], [{ value: 6, sup: null }]]);
  });

  it('shows the Tiebreak format by its final tiebreak points instead of a 1-0 set', () => {
    const s = createScore('tiebreak', 'advantage', 0);
    play(s, '0101010101011');
    play(s, '1111');
    expect(s.winner).toBe(1);
    expect(setLine(s)).toStrictEqual([[{ value: 6, sup: null }], [{ value: 8, sup: null }]]);
  });

  it('shows plain games for sets without a recorded tiebreak (a score built without setTiebreaks)', () => {
    const s: ScoreState = { ...createScore('bo3', 'advantage', 0), setGames: [[4, 2], [5, 4]], setsWon: [2, 0], winner: 0 };
    delete (s as Partial<ScoreState>).setTiebreaks;
    expect(setLine(s)).toStrictEqual([
      [{ value: 4, sup: null }, { value: 5, sup: null }],
      [{ value: 2, sup: null }, { value: 4, sup: null }],
    ]);
    const tb: ScoreState = { ...createScore('tiebreak', 'advantage', 0), setGames: [[1, 0]], setTiebreaks: [], setsWon: [1, 0], winner: 0 };
    expect(setLine(tb)).toStrictEqual([[{ value: 1, sup: null }], [{ value: 0, sup: null }]]);
  });
});

describe('situation', () => {
  it('is null on an ordinary point and on a server game point', () => {
    const s = createScore('short', 'advantage', 0);
    expect(situation(s)).toBeNull();
    play(s, '000');
    expect(situation(s)).toBeNull();
    play(s, '111');
    play(s, '0');
    expect(pointsDisplay(s)).toStrictEqual(['AD', '']);
    expect(situation(s)).toBeNull();
  });

  it('is DEUCE at 40-40 under the advantage rule', () => {
    const s = createScore('short', 'advantage', 0);
    play(s, '000111');
    expect(situation(s)).toBe('DEUCE');
    play(s, '01');
    expect(situation(s)).toBe('DEUCE');
  });

  it('is BREAK POINT when the receiver is one point from the game', () => {
    const s = createScore('short', 'advantage', 0);
    play(s, '111');
    expect(situation(s)).toBe('BREAK POINT');

    const ad = createScore('short', 'advantage', 0);
    play(ad, '0001111');
    expect(pointsDisplay(ad)).toStrictEqual(['', 'AD']);
    expect(situation(ad)).toBe('BREAK POINT');

    const golden = createScore('short', 'golden', 0);
    play(golden, '111');
    expect(situation(golden)).toBe('BREAK POINT');
  });

  it('is GOLDEN POINT at 40-40 under the golden rule (the umpire calls Deuce), above BREAK POINT', () => {
    const s = createScore('short', 'golden', 0);
    play(s, '000111');
    expect(pointsDisplay(s)).toStrictEqual(['40', '40']);
    expect(situation(s)).toBe('GOLDEN POINT');
    expect(umpireCall(s, NAMES, 1)).toBe('Deuce');
  });

  it('keeps SET POINT and MATCH POINT above GOLDEN POINT, and has no golden point in a tiebreak', () => {
    const set = createScore('bo3', 'golden', 0);
    playGames(set, '000');
    play(set, '000111');
    expect(situation(set)).toBe('SET POINT');

    const match = createScore('short', 'golden', 0);
    playGames(match, '000');
    play(match, '000111');
    expect(situation(match)).toBe('MATCH POINT');

    const tiebreak = createScore('bo3', 'golden', 0);
    playGames(tiebreak, '01010101');
    expect(tiebreak.inTiebreak).toBe(true);
    play(tiebreak, '000111');
    expect(situation(tiebreak)).toBeNull();
  });

  it('is SET POINT when the next point can win a set that is not the last, above BREAK POINT', () => {
    const serving = createScore('bo3', 'advantage', 0);
    playGames(serving, '0001');
    expect(currentServer(serving)).toBe(0);
    play(serving, '000');
    expect(situation(serving)).toBe('SET POINT');

    const receiving = createScore('bo3', 'advantage', 0);
    playGames(receiving, '000');
    expect(currentServer(receiving)).toBe(1);
    play(receiving, '000');
    expect(situation(receiving)).toBe('SET POINT');

    const tiebreak = createScore('bo3', 'advantage', 0);
    playGames(tiebreak, '01010101');
    play(tiebreak, '01010101011');
    expect(tiebreak.points).toStrictEqual([5, 6]);
    expect(situation(tiebreak)).toBe('SET POINT');
  });

  it('is MATCH POINT when the next point can win the match, above SET and BREAK POINT', () => {
    const short = createScore('short', 'advantage', 0);
    playGames(short, '000');
    expect(currentServer(short)).toBe(1);
    play(short, '000');
    expect(situation(short)).toBe('MATCH POINT');

    const bo3 = createScore('bo3', 'advantage', 0);
    playGames(bo3, '0000');
    playGames(bo3, '000');
    play(bo3, '000');
    expect(situation(bo3)).toBe('MATCH POINT');

    const tiebreak = createScore('tiebreak', 'advantage', 0);
    play(tiebreak, '01010101010');
    expect(situation(tiebreak)).toBe('MATCH POINT');
  });

  it('in best of three, the player without a set has SET POINT while the set winner would have MATCH POINT', () => {
    const s = createScore('bo3', 'advantage', 0);
    playGames(s, '0000');
    playGames(s, '111');
    expect(currentServer(s)).toBe(1);
    play(s, '111');
    expect(situation(s)).toBe('SET POINT');
  });

  it('is null at level scores inside a tiebreak (no DEUCE there)', () => {
    const s = createScore('tiebreak', 'advantage', 0);
    play(s, '0101010101');
    expect(situation(s)).toBeNull();
    play(s, '01');
    expect(s.points).toStrictEqual([6, 6]);
    expect(situation(s)).toBeNull();
  });

  it('is null once the match is over', () => {
    const s = createScore('short', 'advantage', 0);
    playGames(s, '0000');
    expect(situation(s)).toBeNull();
  });
});

describe('umpireCall', () => {
  it('calls the server score first, in words', () => {
    const s = createScore('short', 'advantage', 0);
    play(s, '0');
    expect(umpireCall(s, NAMES, 0)).toBe('Fifteen love');
    play(s, '1');
    expect(umpireCall(s, NAMES, 1)).toBe('Fifteen all');
    play(s, '1');
    expect(umpireCall(s, NAMES, 1)).toBe('Fifteen thirty');
    play(s, '0');
    expect(umpireCall(s, NAMES, 0)).toBe('Thirty all');
    play(s, '0');
    expect(umpireCall(s, NAMES, 0)).toBe('Forty thirty');

    const receiverFirst = createScore('short', 'advantage', 0);
    play(receiverFirst, '1');
    expect(umpireCall(receiverFirst, NAMES, 1)).toBe('Love fifteen');
  });

  it('uses the current server when player 1 serves', () => {
    const s = createScore('short', 'advantage', 0);
    playGames(s, '0');
    play(s, '1');
    expect(umpireCall(s, NAMES, 1)).toBe('Fifteen love');
  });

  it('calls Deuce, Advantage <name> and Game, <name>', () => {
    const s = createScore('short', 'advantage', 0);
    play(s, '000111');
    expect(umpireCall(s, NAMES, 1)).toBe('Deuce');
    play(s, '0');
    expect(umpireCall(s, NAMES, 0)).toBe('Advantage Alex');
    play(s, '1');
    expect(umpireCall(s, NAMES, 1)).toBe('Deuce');
    play(s, '1');
    expect(umpireCall(s, NAMES, 1)).toBe('Advantage Bo');
    play(s, '0');
    play(s, '0');
    expect(umpireCall(s, NAMES, 0)).toBe('Advantage Alex');
    play(s, '0');
    expect(umpireCall(s, NAMES, 0)).toBe('Game, Alex');
  });

  it('calls Deuce at the golden point and Game, <name> after it', () => {
    const s = createScore('short', 'golden', 0);
    play(s, '000111');
    expect(umpireCall(s, NAMES, 1)).toBe('Deuce');
    play(s, '1');
    expect(umpireCall(s, NAMES, 1)).toBe('Game, Bo');
  });

  it('calls a tiebreak score in words, leader first with the leader named', () => {
    const s = createScore('tiebreak', 'advantage', 0);
    play(s, '0');
    expect(umpireCall(s, NAMES, 0)).toBe('One zero, Alex');
    play(s, '1');
    expect(umpireCall(s, NAMES, 1)).toBe('One all');
    play(s, '11');
    expect(umpireCall(s, NAMES, 1)).toBe('Three one, Bo');
    play(s, '00' + '01'.repeat(9) + '0');
    expect(s.points).toStrictEqual([13, 12]);
    expect(umpireCall(s, NAMES, 0)).toBe('Thirteen twelve, Alex');
    play(s, '1' + '10'.repeat(4) + '1');
    expect(s.points).toStrictEqual([17, 18]);
    expect(umpireCall(s, NAMES, 1)).toBe('Eighteen seventeen, Bo');
    play(s, '0' + '01'.repeat(2) + '0');
    expect(s.points).toStrictEqual([21, 20]);
    expect(umpireCall(s, NAMES, 0)).toBe('Twenty-one twenty, Alex');
    play(s, '0');
    expect(umpireCall(s, NAMES, 0)).toBe('Game, Alex');
  });

  it('calls Game, <name> when a game completes the set and the match', () => {
    const s = createScore('short', 'advantage', 0);
    playGames(s, '1111');
    expect(umpireCall(s, NAMES, 1)).toBe('Game, Bo');
  });
});

describe('random matches (property)', () => {
  const FORMATS: FormatId[] = ['tiebreak', 'short', 'full', 'bo3'];
  const GAMES: Record<FormatId, number> = { tiebreak: 0, short: 4, full: 6, bo3: 4 };
  const SETS: Record<FormatId, number> = { tiebreak: 1, short: 1, full: 1, bo3: 2 };

  /** Independent statement of a legal completed-set score. */
  function legalSet(format: FormatId, [a, b]: [number, number]): boolean {
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    if (format === 'tiebreak') return hi === 1 && lo === 0;
    const n = GAMES[format];
    return (hi === n && lo <= n - 2) || (hi === n + 1 && (lo === n - 1 || lo === n));
  }

  /** Independent statement of a set decided by a tiebreak: the Tiebreak format's one set, else n+1 to n games. */
  function legalTiebreakSet(format: FormatId, [a, b]: [number, number]): boolean {
    if (format === 'tiebreak') return true;
    return Math.max(a, b) === GAMES[format] + 1 && Math.min(a, b) === GAMES[format];
  }

  /** Independent statement of a final tiebreak score, `w` points to the set winner, `l` to the loser: 7 to at most 5, or won by exactly 2 beyond. */
  function legalTiebreak(w: number, l: number): boolean {
    return (w === 7 && l <= 5) || (w > 7 && w - l === 2);
  }

  /** Independent statement of when a game ends: `w` and `l` are the scores after the point. */
  function gameShouldEnd(tiebreak: boolean, rule: DeuceRule, w: number, l: number): boolean {
    if (tiebreak) return w >= 7 && w - l >= 2;
    if (rule === 'golden') return w >= 4;
    return w >= 4 && w - l >= 2;
  }

  it.each(FORMATS)('%s: 1,000 random matches all end with one legal winner and never throw', (format) => {
    const rng = seedRng(0x5c0 + FORMATS.indexOf(format));
    const problems: string[] = [];
    for (let m = 0; m < 1000 && problems.length < 5; m++) {
      const rule: DeuceRule = m % 2 === 0 ? 'advantage' : 'golden';
      const first: PlayerId = m % 4 < 2 ? 0 : 1;
      const s = createScore(format, rule, first);
      const bias = 0.2 + 0.6 * uniform(rng);
      const where = `${format}/${rule} match ${m}`;
      let dueToServeGame = first;
      let matchResults = 0;
      let played = 0;
      while (s.winner === null) {
        if (++played > 10_000) {
          problems.push(`${where}: no winner after 10,000 points`);
          break;
        }
        if (s.points[0] + s.points[1] === 0) {
          if (currentServer(s) !== dueToServeGame) problems.push(`${where}: game opened by the wrong server`);
          dueToServeGame = other(dueToServeGame);
        }
        // Every query must be safe at every score.
        serveSide(s);
        situation(s);
        pointsDisplay(s);
        const wasTiebreak = s.inTiebreak;
        const w: PlayerId = chance(rng, bias) ? 0 : 1;
        const wPts = s.points[w] + 1;
        const lPts = s.points[other(w)];
        const r = awardPoint(s, w);
        if ((r.game !== null) !== gameShouldEnd(wasTiebreak, rule, wPts, lPts)) {
          problems.push(`${where}: game end wrong at ${wPts}-${lPts} (tiebreak ${wasTiebreak})`);
        }
        if ((r.game ?? w) !== w || (r.set ?? w) !== w || (r.match ?? w) !== w) {
          problems.push(`${where}: result names the loser`);
        }
        if ((r.set !== null && r.game === null) || (r.match !== null && r.set === null)) {
          problems.push(`${where}: incoherent result`);
        }
        if (r.match !== null) matchResults++;
        if (/[0-9]/.test(umpireCall(s, NAMES, w))) problems.push(`${where}: umpire call has digits`);
      }
      const winner = s.winner;
      if (winner === null) continue;
      if (matchResults !== 1) problems.push(`${where}: ${matchResults} match results`);
      if (s.setsWon[winner] !== SETS[format] || s.setsWon[other(winner)] >= SETS[format]) {
        problems.push(`${where}: sets ${s.setsWon.join('-')}`);
      }
      if (!s.setGames.every((g) => legalSet(format, g))) {
        problems.push(`${where}: illegal set ${JSON.stringify(s.setGames)}`);
      }
      const tiebreaks = s.setTiebreaks ?? [];
      if (tiebreaks.length !== s.setGames.length) problems.push(`${where}: ${tiebreaks.length} tiebreaks for ${s.setGames.length} sets`);
      const line = setLine(s);
      s.setGames.forEach((g, i) => {
        const tb = tiebreaks[i] ?? null;
        const setWinner = g[0] > g[1] ? 0 : 1;
        if ((tb !== null) !== legalTiebreakSet(format, g)) problems.push(`${where}: set ${i} tiebreak ${JSON.stringify(tb)} for ${g.join('-')}`);
        if (tb !== null && !legalTiebreak(tb[setWinner], tb[other(setWinner)])) problems.push(`${where}: illegal tiebreak ${tb.join('-')}`);
        // Only a tiebreak set outside the Tiebreak format carries a superscript: the loser's points, beside the winner's games.
        const wantSup = tb !== null && format !== 'tiebreak' ? tb[other(setWinner)] : null;
        const sups = [line[setWinner][i]?.sup, line[other(setWinner)][i]?.sup];
        if (sups[0] !== wantSup || sups[1] !== null) problems.push(`${where}: set ${i} superscripts ${JSON.stringify(sups)}, want [${wantSup}, null]`);
      });
      const setsTakenByWinner = s.setGames.filter(([a, b]) => (a > b ? 0 : 1) === winner).length;
      if (setsTakenByWinner !== s.setsWon[winner]) problems.push(`${where}: setGames disagree with setsWon`);
      if (situation(s) !== null) problems.push(`${where}: situation after the match`);
      expect(JSON.parse(JSON.stringify(s))).toStrictEqual(s);
    }
    expect(problems).toStrictEqual([]);
  });
});
