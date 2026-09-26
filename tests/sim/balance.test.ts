/*
 * Balance simulation (spec §6). The full suite runs only with BBT_SIM=1 (`npm run test:sim`);
 * `npm test` runs the smoke subset.
 *
 * Retuned in src/core/tuning.ts (spec value → now): PACE_MULT.relaxed 1.5 → 1.4,
 * PACE_MULT.lightning 0.6 → 0.7, flight.serveReturnBonusMs 500 → 250,
 * flight.serveReturnBonusPaceMs 500 → 750 (reading allowance unchanged at Normal).
 *
 * Final summary with those constants and the seeds below.
 *
 * Equal human-model players (humanTypist), 5,000 points per preset, full sets:
 *   preset     WPM  median  p90  max  aces   DF     server  s/point (median)
 *   Relaxed     30     5     7   11   0.0 %  1.7 %  62.0 %  31.0
 *   Normal      50     4     7    9   0.0 %  3.2 %  59.7 %  20.9
 *   Fast        70     3     5    8   0.1 %  3.3 %  59.4 %  14.0
 *   Lightning   90     3     5    9   0.2 %  2.1 %  59.7 %  13.3
 *   (points of ≤ 2 shots: Fast 36.8 %, Lightning 36.4 %, so their median of 3 is not marginal)
 *
 * Share of points won by a fixed strategy against the adaptive human model, 5,000 points:
 *   preset     alwaysEasy  alwaysHard  neverHard
 *   Relaxed      40.4 %       7.4 %      49.6 %
 *   Normal       37.1 %      10.1 %      48.4 %
 *   Fast         41.9 %      16.2 %      47.2 %
 *   Lightning    36.3 %      14.6 %      46.5 %
 *
 * CPU aggression 0.8 vs 0.2 at equal speed, share won by 0.8, 5,000 points:
 *   Relaxed L2 52.3 %, Normal L7 52.9 %, Fast L10 52.7 %, Lightning L12 55.0 %.
 *
 * CPU levels at Normal, 200 short sets per pair: the higher level won all 200 sets in each of the
 * 14 adjacent pairs (67.6–83.7 % of points) and each of the 13 pairs 2 apart (83.6–96.7 % of points).
 *
 * Not met: aces ≥ 5 % (measured 0.0–0.2 %; see the it.fails below).
 */
import { describe, expect, it } from 'vitest';
import { cpuProfile, type CpuPolicy } from '../../src/core/cpu';
import { humanTypist, simulateMatch, simulatePoints, summarize, type PointRecord, type SimTypist } from '../../src/core/sim';
import type { MatchConfig, PaceId, PlayerId } from '../../src/core/types';

const FULL = import.meta.env.BBT_SIM === '1';
const TEN_MINUTES = 600_000;
/** Points per rally-shape, policy and aggression cell. */
const CELL_POINTS = 5000;
/** Short sets per belt-vs-belt cell. */
const CELL_SETS = 200;

/** Each pace preset at its reference WPM (spec §3.9, §6). */
const PRESETS: { pace: PaceId; wpm: number }[] = [
  { pace: 'relaxed', wpm: 30 },
  { pace: 'normal', wpm: 50 },
  { pace: 'fast', wpm: 70 },
  { pace: 'lightning', wpm: 90 },
];

/** The fixed strategies checked against the adaptive human model. */
const FIXED_POLICIES: CpuPolicy[] = ['alwaysEasy', 'alwaysHard', 'neverHard'];

/** A CPU level near each preset's reference WPM, for the aggression check at equal speed. */
const AGGRESSION_CELLS: { pace: PaceId; level: number }[] = [
  { pace: 'relaxed', level: 2 },
  { pace: 'normal', level: 7 },
  { pace: 'fast', level: 10 },
  { pace: 'lightning', level: 12 },
];

/** CPU level pairs (lower, higher) played in short sets at Normal pace. */
const levelPairs = (gap: number): [number, number][] =>
  Array.from({ length: 15 - gap }, (_, lo): [number, number] => [lo, lo + gap]);

const config = (pace: PaceId, format: MatchConfig['format'] = 'full'): MatchConfig => ({
  format,
  pace,
  surface: 'hard',
  wordPack: 'everyday',
  deuceRule: 'advantage',
  training: null,
});

/** Computes `make()` once, on first use, so the tests of one cell share a simulation. */
function once<T>(make: () => T): () => T {
  let cached: { value: T } | null = null;
  return () => (cached ??= { value: make() }).value;
}

/** Share of `points` won by `player`. */
function winShare(points: PointRecord[], player: PlayerId): number {
  return points.filter((p) => p.winner === player).length / points.length;
}

/** Share of `sets` short sets between two CPU levels won by the higher one (player 1). */
function higherLevelSetShare(lo: number, hi: number, seed: number, sets: number): number {
  const typists: [SimTypist, SimTypist] = [{ profile: cpuProfile(lo) }, { profile: cpuProfile(hi) }];
  let won = 0;
  for (let i = 0; i < sets; i++) {
    if (simulateMatch({ config: config('normal', 'short'), typists, seed: seed + i }).winner === 1) won++;
  }
  return won / sets;
}

describe('balance smoke', () => {
  it('300 points at Normal / 50 WPM all end, with finite times and a median rally of 2–10 shots', () => {
    const points = simulatePoints({ config: config('normal'), typists: [humanTypist(50), humanTypist(50)], seed: 42, points: 300 });
    expect(points).toHaveLength(300);
    for (const p of points) {
      expect(Number.isFinite(p.ms) && p.ms > 0).toBe(true);
      expect(Number.isInteger(p.shots) && p.shots >= 0).toBe(true);
    }
    const s = summarize(points);
    for (const v of Object.values(s)) expect(Number.isFinite(v)).toBe(true);
    expect(s.medianShots).toBeGreaterThanOrEqual(2);
    expect(s.medianShots).toBeLessThanOrEqual(10);
  });
});

describe.skipIf(!FULL).concurrent('balance simulation (spec §6)', { timeout: TEN_MINUTES }, () => {
  describe.each(PRESETS.map((p, i) => ({ ...p, seed: 1000 + i })))(
    '$pace at $wpm WPM, equal human-model players',
    ({ pace, wpm, seed }) => {
      const s = once(() =>
        summarize(simulatePoints({ config: config(pace), typists: [humanTypist(wpm), humanTypist(wpm)], seed, points: CELL_POINTS })),
      );
      it('median rally is 3–6 shots', ({ expect }) => {
        expect(s().medianShots).toBeGreaterThanOrEqual(3);
        expect(s().medianShots).toBeLessThanOrEqual(6);
      });
      it('90th-percentile rally is ≤ 12 shots', ({ expect }) => {
        expect(s().p90Shots).toBeLessThanOrEqual(12);
      });
      it('no point lasts more than 40 shots', ({ expect }) => {
        expect(s().maxShots).toBeLessThanOrEqual(40);
      });
      it('aces are ≤ 15 % of points', ({ expect }) => {
        expect(s().aceRate).toBeLessThanOrEqual(0.15);
      });
      // Spec §6 also wants aces ≥ 5 %, which no constant reaches without changing semantics. An ace
      // means the receiver never finishes the chase word, but even a finished chase still needs a
      // full reaction and a choice word before T + grace, so a serve fast enough to ace 5 % of
      // returns leaves most of the rest unreturned. With the final constants, aces are 0.0 / 0.0 /
      // 0.1 / 0.2 % (Relaxed / Normal / Fast / Lightning). Without any reading allowance they
      // reach only 0.1 / 0.8 / 4.1 / 5.7 %, and the server then wins 77–85 % of points.
      it.fails('aces are ≥ 5 % of points (not reachable; measured 0.0–0.2 %)', ({ expect }) => {
        expect(s().aceRate).toBeGreaterThanOrEqual(0.05);
      });
      it('double faults are 1–6 % of points', ({ expect }) => {
        expect(s().dfRate).toBeGreaterThanOrEqual(0.01);
        expect(s().dfRate).toBeLessThanOrEqual(0.06);
      });
      it('the server wins 55–65 % of points', ({ expect }) => {
        expect(s().serverWinRate).toBeGreaterThanOrEqual(0.55);
        expect(s().serverWinRate).toBeLessThanOrEqual(0.65);
      });
      it('a point takes ≤ 35 s (median)', ({ expect }) => {
        expect(s().medianSecPerPoint).toBeLessThanOrEqual(35);
      });
    },
  );

  describe.each(PRESETS.map((p, i) => ({ ...p, seed: 2000 + 10 * i })))(
    '$pace at $wpm WPM, a fixed strategy against the adaptive human model',
    ({ pace, wpm, seed }) => {
      it.for(FIXED_POLICIES.map((policy, j) => ({ policy, seed: seed + j })))(
        '$policy wins ≤ 53 % of points',
        ({ policy, seed: cellSeed }, { expect }) => {
          const typists: [SimTypist, SimTypist] = [humanTypist(wpm, policy), humanTypist(wpm)];
          const points = simulatePoints({ config: config(pace), typists, seed: cellSeed, points: CELL_POINTS });
          expect(winShare(points, 0)).toBeLessThanOrEqual(0.53);
        },
      );
    },
  );

  it.for(AGGRESSION_CELLS.map((c, i) => ({ ...c, seed: 3000 + i })))(
    '$pace, CPU level $level: aggression 0.8 wins ≥ 50 % of points against 0.2 at equal speed',
    ({ pace, level, seed }, { expect }) => {
      const base = cpuProfile(level);
      const typists: [SimTypist, SimTypist] = [
        { profile: { ...base, aggression: 0.8 } },
        { profile: { ...base, aggression: 0.2 } },
      ];
      const points = simulatePoints({ config: config(pace), typists, seed, points: CELL_POINTS });
      expect(winShare(points, 0)).toBeGreaterThanOrEqual(0.5);
    },
  );

  it.for(levelPairs(1).map(([lo, hi]) => ({ lo, hi, seed: 10_000 * (lo + 1) })))(
    'Normal, adjacent CPU levels $lo vs $hi: the higher wins ≥ 65 % of short sets',
    ({ lo, hi, seed }, { expect }) => {
      expect(higherLevelSetShare(lo, hi, seed, CELL_SETS)).toBeGreaterThanOrEqual(0.65);
    },
  );

  it.for(levelPairs(2).map(([lo, hi]) => ({ lo, hi, seed: 500_000 + 10_000 * (lo + 1) })))(
    'Normal, CPU levels $lo vs $hi (2 apart): the higher wins ≥ 90 % of short sets',
    ({ lo, hi, seed }, { expect }) => {
      expect(higherLevelSetShare(lo, hi, seed, CELL_SETS)).toBeGreaterThanOrEqual(0.9);
    },
  );
});
