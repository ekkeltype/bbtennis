import { describe, expect, it } from 'vitest';
import { aggressionAt, cpuProfile, typistProfile } from '../../src/core/cpu';
import {
  simTypist,
  simulateMatch,
  simulatePoints,
  summarize,
  type PointRecord,
  type SimTypist,
} from '../../src/core/sim';
import type { MatchConfig, PlayerId } from '../../src/core/types';

const CONFIG: MatchConfig = {
  format: 'short',
  pace: 'normal',
  surface: 'hard',
  wordPack: 'everyday',
  deuceRule: 'advantage',
  training: null,
};

const config = (over: Partial<MatchConfig> = {}): MatchConfig => ({ ...CONFIG, ...over });

const HUMAN_50 = simTypist(50);

/** A record with defaults for the fields a summarize test does not care about. */
function rec(over: Partial<PointRecord> = {}): PointRecord {
  return { shots: 3, ms: 10000, reason: 'winner', serverWon: true, winner: 0, insaneClean: 0, insaneReturned: 0, insaneOffered: false, ...over };
}

/**
 * Throws unless the record is self-consistent: an ace is the serve alone and won by the server, a
 * double fault has no shot in play, a winner is won by the last striker and an OUT/NET is lost by
 * the last striker (strike k is the server's when k is odd).
 */
function expectConsistent(p: PointRecord): void {
  expect(Number.isInteger(p.shots) && p.shots >= 0).toBe(true);
  expect(Number.isFinite(p.ms) && p.ms > 0).toBe(true);
  expect([0, 1]).toContain(p.winner);
  const lastStrikeByServer = p.shots % 2 === 1;
  switch (p.reason) {
    case 'ace':
      expect([p.shots, p.serverWon]).toEqual([1, true]);
      break;
    case 'doubleFault':
      expect([p.shots, p.serverWon]).toEqual([0, false]);
      break;
    case 'winner':
      expect(p.serverWon).toBe(lastStrikeByServer);
      break;
    case 'out':
    case 'net':
      expect(p.shots).toBeGreaterThanOrEqual(2);
      expect(p.serverWon).toBe(!lastStrikeByServer);
      break;
    default:
      throw new Error(`unexpected point reason ${p.reason}`);
  }
}

describe('simTypist (early-typing spec §4, §5)', () => {
  it("is the typist model at that speed with the ladder's aggression and the adaptive policy by default", () => {
    expect(simTypist(70)).toEqual({ profile: typistProfile(70, aggressionAt(70)), policy: 'adaptive' });
    expect(simTypist(70, 'neverHard').policy).toBe('neverHard');
  });
});

describe('summarize', () => {
  it('takes the median and nearest-rank 90th percentile of rally length, and the longest rally', () => {
    const points = [0, 1, 2, 3, 4, 5, 6, 7, 8, 40].map((shots) => rec({ shots }));
    const s = summarize(points);
    expect(s.medianShots).toBe(4.5);
    expect(s.p90Shots).toBe(8);
    expect(s.maxShots).toBe(40);
  });

  it('uses the middle value for an odd count, whatever the input order', () => {
    const s = summarize([7, 1, 3].map((shots) => rec({ shots })));
    expect(s.medianShots).toBe(3);
    expect(s.p90Shots).toBe(7);
  });

  it('gives the share of points that were aces, double faults and won by the server', () => {
    const points = [
      rec({ reason: 'ace', shots: 1, serverWon: true }),
      rec({ reason: 'doubleFault', shots: 0, serverWon: false }),
      rec({ reason: 'winner', serverWon: true }),
      rec({ reason: 'out', serverWon: false }),
    ];
    const s = summarize(points);
    expect(s.aceRate).toBe(0.25);
    expect(s.dfRate).toBe(0.25);
    expect(s.serverWinRate).toBe(0.5);
  });

  it('gives the median point duration in seconds', () => {
    const s = summarize([rec({ ms: 9000 }), rec({ ms: 30000 }), rec({ ms: 12500 })]);
    expect(s.medianSecPerPoint).toBe(12.5);
  });

  it('rejects an empty list instead of returning NaN', () => {
    expect(() => summarize([])).toThrow(RangeError);
  });
});

describe('simulatePoints', () => {
  it('returns exactly the number of points asked for, across as many matches as needed', () => {
    const points = simulatePoints({ config: config({ format: 'tiebreak' }), typists: [HUMAN_50, HUMAN_50], seed: 7, points: 60 });
    expect(points).toHaveLength(60);
  });

  it('records self-consistent points: shots, duration, reason, winner and whether the server won', () => {
    const points = simulatePoints({ config: CONFIG, typists: [HUMAN_50, HUMAN_50], seed: 11, points: 150 });
    points.forEach(expectConsistent);
    const reasons = new Set(points.map((p) => p.reason));
    expect(reasons.has('winner')).toBe(true);
  });

  it('is deterministic for a seed and differs between seeds', () => {
    const run = (seed: number): PointRecord[] => simulatePoints({ config: CONFIG, typists: [HUMAN_50, HUMAN_50], seed, points: 40 });
    expect(run(3)).toEqual(run(3));
    expect(run(3)).not.toEqual(run(4));
  });

  it('never stalls or produces NaN with extreme typists (15 and 160 WPM)', () => {
    const points = simulatePoints({ config: CONFIG, typists: [simTypist(15), simTypist(160)], seed: 5, points: 80 });
    expect(points).toHaveLength(80);
    points.forEach(expectConsistent);
  });

  it("passes each typist's policy to its brain: a 25 WPM 'alwaysHard' server can never serve before the ball drops at Lightning pace", () => {
    const hard: SimTypist = { profile: cpuProfile(0), policy: 'alwaysHard' };
    const points = simulatePoints({ config: config({ pace: 'lightning' }), typists: [hard, HUMAN_50], seed: 2, points: 60 });
    const served = points.filter((p) => serverOf(p) === 0);
    expect(served.length).toBeGreaterThan(10);
    for (const p of served) expect(p.reason).toBe('doubleFault');
  });

  it("passes each typist's profile to its brain: a receiver who pauses a minute before a serve's chase word is aced by every serve that lands", () => {
    const asleep: SimTypist = { profile: { ...typistProfile(50, 0.5), serveChasePauseMs: 60000 } };
    const points = simulatePoints({ config: CONFIG, typists: [HUMAN_50, asleep], seed: 9, points: 60 });
    const received = points.filter((p) => serverOf(p) === 0);
    expect(received.length).toBeGreaterThan(10);
    for (const p of received) expect(['ace', 'doubleFault']).toContain(p.reason);
    expect(received.some((p) => p.reason === 'ace')).toBe(true);
  });
});

describe('simulateMatch', () => {
  it('plays one tiebreak to its end: the winner reaches 7 points with a 2-point lead', () => {
    const { winner, points } = simulateMatch({ config: config({ format: 'tiebreak' }), typists: [HUMAN_50, HUMAN_50], seed: 21 });
    const won = [0, 1].map((p) => points.filter((r) => r.winner === p).length);
    const w = won[winner] ?? 0;
    const l = won[1 - winner] ?? 0;
    expect(w).toBeGreaterThanOrEqual(7);
    expect(w - l).toBeGreaterThanOrEqual(2);
    expect(points[points.length - 1]?.winner).toBe(winner);
    points.forEach(expectConsistent);
  });

  it('is won by a black belt 3rd dan against a white belt', () => {
    const typists: [SimTypist, SimTypist] = [{ profile: cpuProfile(0) }, { profile: cpuProfile(14) }];
    expect(simulateMatch({ config: CONFIG, typists, seed: 1 }).winner).toBe(1);
  });
});

/** The server of a point, from who won it and whether the server did. */
function serverOf(p: PointRecord): PlayerId {
  return p.serverWon ? p.winner : p.winner === 0 ? 1 : 0;
}

describe('insane metrics (power-meter spec §7)', () => {
  it('summarize: clean insane shots, the share returned, and the share of points offering insane', () => {
    const base = { shots: 3, ms: 1000, reason: 'winner' as const, serverWon: true, winner: 0 as const };
    const s = summarize([
      { ...base, insaneClean: 2, insaneReturned: 1, insaneOffered: true },
      { ...base, insaneClean: 1, insaneReturned: 0, insaneOffered: true },
      { ...base, insaneClean: 0, insaneReturned: 0, insaneOffered: false },
      { ...base, insaneClean: 0, insaneReturned: 0, insaneOffered: false },
    ]);
    expect(s.insaneShotsClean).toBe(3);
    expect(s.insaneReturnRate).toBeCloseTo(1 / 3, 12);
    expect(s.fullMeterRate).toBe(0.5);
    expect(summarize([{ ...base, insaneClean: 0, insaneReturned: 0, insaneOffered: false }]).insaneReturnRate).toBe(0);
  });

  it('fast, accurate equal players reach full meters and hit clean insane shots', { timeout: 30000 }, () => {
    const CONFIG_NORMAL: MatchConfig = { format: 'full', pace: 'normal', surface: 'hard', wordPack: 'everyday', deuceRule: 'advantage', training: null };
    const points = simulatePoints({ config: CONFIG_NORMAL, typists: [simTypist(140), simTypist(140)], seed: 7, points: 400 });
    const s = summarize(points);
    expect(s.fullMeterRate).toBeGreaterThan(0);
    expect(s.insaneShotsClean).toBeGreaterThan(0);
  });
});
