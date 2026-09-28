/*
 * Balance simulation (spec §6, as amended in ac7c81b by rulings R35/R36 and by the power-meter spec
 * of 2026-09-27). The full suite runs only with BBT_SIM=1 (`npm run test:sim`); `npm test` runs the
 * smoke subset.
 *
 * Targets, equal players at each preset's reference WPM. The power-meter change aimed at a median
 * rally of 5–8 at every pace; the measured result was accepted by the user on 2026-09-27 instead
 * ("the majority of games will be played on Normal"), and the targets guard that shape: median rally
 * Relaxed 10–14, Normal 7–11, Fast 4–7, Lightning 3–5 shots; p90 ≤ 22; no point over 60 shots;
 * aces ≤ 15 % (R36: no lower bound, an ace needs a failed chase); double faults 1–8 % (hard serve
 * words are now 8–11 letters); server wins 55–65 %; ≤ 65 s per point. Insane (power-meter spec §7):
 * ≥ 200 clean insane shots per cell, the equal opponent returns 15–40 % of them, and a never-insane
 * player wins 40–51 % against the adaptive one. Plus the fixed-strategy, aggression and CPU-level
 * checks below (unchanged).
 *
 * Human model (humanTypist, src/core/sim.ts): spec §6's "hardest option that fits" on every serve
 * and choice, insane included, second serves included. CpuBrain's second-serve aggression × 0.4 is
 * a CPU rule (spec §3.8), so humanProfile's aggression is 2.5 (2.5 × 0.4 = 1); sim.test.ts checks the
 * choice. Task 11 fix round 1: the first tuning ran the human with the CPU's × 0.4, and with the
 * true policy it gave 6.3 % (Normal) and 8.5 % (Fast) double faults, so it was retuned.
 * Recorded deviation: the human model types through CpuBrain, so its per-word variation is the
 * CPU's 1 + 0.15·z (spec §3.8), not the 12 % spec §6 names; every figure below was measured so.
 *
 * Constants in src/core/tuning.ts. Amended ac7c81b / R35 (draft → value): tossApexMs 2000 → 1930,
 * speed.base 0.85 → 0.875, speed.perCps 0.05 → 0.025, flight.serveReturnBonusMs 500 → 250,
 * flight.serveReturnBonusPaceMs 500 → 750. Power-meter spec 2026-09-27: flight.pressure 0.85 →
 * 0.93 with a new flight.pressureFloor 0.65 (P(n) = max(floor, pressure^⌊n/2⌋)); new insane values
 * flight.place.insane 0.55 (rally), flight.placeServeInsane 0.75 (serve) and power.tossMult 1.2 (a
 * full-meter serve's toss apex). PACE_MULT keeps the spec's ×1.5 / 1.0 / 0.75 / 0.6 (never changed).
 * Double faults step with the toss window 2a: a hard serve word "fits" (spec §3.8 estimate) up to
 * a length set by 2a, and one that only just fits is often dropped. Hard words are now 8–11
 * letters, so more of them sit at that edge than the 10–14-letter hard words of the original
 * tuning did, which is why double faults rose from 3.2–4.2 % to 5.6–7.4 %.
 *
 * Final summary with those constants and the seeds below (measured 2026-09-27).
 *
 * Equal human-model players (humanTypist), 5,000 points per preset, full sets:
 *   preset     WPM  median  p90  max  aces   DF     server  s/point (median)  points ≤ 2 shots
 *   Relaxed     30    12     19   39   0.4 %  5.6 %  56.3 %  58.8              17.5 %
 *   Normal      50     9     13   23   0.6 %  6.0 %  57.1 %  32.1              24.9 %
 *   Fast        70     5     10   16   1.4 %  6.9 %  59.0 %  18.6              33.9 %
 *   Lightning   90     3      8   14   2.4 %  7.4 %  59.7 %  13.1              40.2 %
 *   (Lightning's points are mostly decided at the serve return, before rally pressure starts; its
 *   median was 3 before the change too.)
 *
 * The insane option between equal players, 20,000 points per preset:
 *   preset     clean insane shots  returned by the opponent  points offering insane
 *   Relaxed           1374               33.2 %                    67.0 %
 *   Normal            2100               24.6 %                    65.0 %
 *   Fast              2424               18.4 %                    60.3 %
 *   Lightning         2610               15.6 %                    54.7 %
 *
 * Share of points won by a fixed strategy against the adaptive human model, 5,000 points
 * (neverHard never picks hard or insane; neverInsane never picks insane):
 *   preset     alwaysEasy  alwaysHard  neverHard  neverInsane
 *   Relaxed      43.6 %      12.9 %      48.2 %     50.0 %
 *   Normal       38.9 %      12.9 %      46.7 %     48.8 %
 *   Fast         36.0 %      12.6 %      46.8 %     48.8 %
 *   Lightning    37.7 %      17.3 %      45.4 %     48.5 %
 *
 * CPU aggression 0.8 vs 0.2 at equal speed, share won by 0.8, 5,000 points:
 *   Relaxed L2 53.8 %, Normal L7 53.6 %, Fast L10 55.3 %, Lightning L12 54.1 %.
 *
 * CPU levels at Normal, 200 short sets per pair: the higher level won all 200 sets in every pair
 * below (longer rallies leave less to luck than the original tuning's 64.7–83.2 % of points for
 * adjacent levels); the share of points it won:
 *   adjacent  points      2 apart  points
 *   0v1       72.1 %      0v2      91.0 %
 *   1v2       75.8 %      1v3      93.9 %
 *   2v3       81.9 %      2v4      95.0 %
 *   3v4       75.0 %      3v5      91.3 %
 *   4v5       74.3 %      4v6      93.5 %
 *   5v6       81.4 %      5v7      97.4 %
 *   6v7       88.5 %      6v8      98.4 %
 *   7v8       90.2 %      7v9      96.7 %
 *   8v9       90.2 %      8v10     94.0 %
 *   9v10      84.5 %      9v11     90.8 %
 *   10v11     84.2 %      10v12    86.3 %
 *   11v12     79.8 %      11v13    81.6 %
 *   12v13     78.6 %      12v14    80.0 %
 *   13v14     73.0 %
 */
import { describe, expect, it } from 'vitest';
import { cpuProfile, type CpuPolicy } from '../../src/core/cpu';
import { simTypist, simulateMatch, simulatePoints, summarize, type PointRecord, type SimTypist } from '../../src/core/sim';
import type { MatchConfig, PaceId, PlayerId } from '../../src/core/types';

const FULL = import.meta.env.BBT_SIM === '1';
const TEN_MINUTES = 600_000;
/** Points per rally-shape, policy and aggression cell. */
const CELL_POINTS = 5000;
/** Points per equal-player insane-option cell (need ≥ 200 clean insane shots). */
const INSANE_POINTS = 20_000;
/** Short sets per belt-vs-belt cell. */
const CELL_SETS = 200;

/**
 * Each pace preset at its reference WPM (spec §3.9, §6) with its accepted median-rally band. The
 * power-meter change (2026-09-27) aimed at a median of 5–8 at every pace; the user accepted the
 * measured result instead: longer rallies at Relaxed and Normal, Lightning still decided mostly at
 * the serve return (its median was 3 before the change too). The bands guard that shape.
 */
const PRESETS: { pace: PaceId; wpm: number; median: [number, number] }[] = [
  { pace: 'relaxed', wpm: 30, median: [10, 14] },
  { pace: 'normal', wpm: 50, median: [7, 11] },
  { pace: 'fast', wpm: 70, median: [4, 7] },
  { pace: 'lightning', wpm: 90, median: [3, 5] },
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
    const points = simulatePoints({ config: config('normal'), typists: [simTypist(50), simTypist(50)], seed: 42, points: 300 });
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
    ({ pace, wpm, median: [lo, hi], seed }) => {
      const s = once(() =>
        summarize(simulatePoints({ config: config(pace), typists: [simTypist(wpm), simTypist(wpm)], seed, points: CELL_POINTS })),
      );
      it(`median rally is ${lo}–${hi} shots`, ({ expect }) => {
        expect(s().medianShots).toBeGreaterThanOrEqual(lo);
        expect(s().medianShots).toBeLessThanOrEqual(hi);
      });
      it('90th-percentile rally is ≤ 22 shots', ({ expect }) => {
        expect(s().p90Shots).toBeLessThanOrEqual(22);
      });
      it('no point lasts more than 60 shots', ({ expect }) => {
        expect(s().maxShots).toBeLessThanOrEqual(60);
      });
      // No lower bound on aces (R36 dropped the draft's ≥ 5 %, which no constant reaches without
      // changing semantics). An ace means the receiver never finishes the chase word, but even a
      // finished chase still needs a full reaction and a choice word before T + grace, so a serve
      // fast enough to ace 5 % of returns leaves most of the rest unreturned. With the final
      // constants, aces are 0.0 / 0.0 / 0.0 / 0.3 % (Relaxed / Normal / Fast / Lightning). Without
      // any reading allowance they reach only 0.0 / 0.2 / 1.4 / 4.4 %, and the server then wins
      // 77–86 % of points.
      it('aces are ≤ 15 % of points', ({ expect }) => {
        expect(s().aceRate).toBeLessThanOrEqual(0.15);
      });
      // Hard serve words are now 8–11 letters, and one that only just fits the toss is often dropped:
      // up to 7.4 % (Lightning), accepted with the rally bands above.
      it('double faults are 1–8 % of points', ({ expect }) => {
        expect(s().dfRate).toBeGreaterThanOrEqual(0.01);
        expect(s().dfRate).toBeLessThanOrEqual(0.08);
      });
      it('the server wins 55–65 % of points', ({ expect }) => {
        expect(s().serverWinRate).toBeGreaterThanOrEqual(0.55);
        expect(s().serverWinRate).toBeLessThanOrEqual(0.65);
      });
      it('a point takes ≤ 65 s (median)', ({ expect }) => {
        expect(s().medianSecPerPoint).toBeLessThanOrEqual(65);
      });
    },
  );

  describe.each(PRESETS.map((p, i) => ({ ...p, seed: 4000 + i })))(
    '$pace at $wpm WPM, the insane option between equal players',
    ({ pace, wpm, seed }) => {
      const s = once(() =>
        summarize(simulatePoints({ config: config(pace), typists: [simTypist(wpm), simTypist(wpm)], seed, points: INSANE_POINTS })),
      );
      it('sees at least 200 clean insane shots (raise INSANE_POINTS if not)', ({ expect }) => {
        expect(s().insaneShotsClean).toBeGreaterThanOrEqual(200);
      });
      it('the equal opponent returns 15–40 % of clean insane shots', ({ expect }) => {
        expect(s().insaneReturnRate).toBeGreaterThanOrEqual(0.15);
        expect(s().insaneReturnRate).toBeLessThanOrEqual(0.4);
      });
    },
  );

  describe.each(PRESETS.map((p, i) => ({ ...p, seed: 5000 + i })))(
    '$pace at $wpm WPM, never-insane against the adaptive human model',
    ({ pace, wpm, seed }) => {
      // Accepted 2026-09-27: at Relaxed insane is a wash (never-insane wins 50.04 %: 2 points in
      // 5,000 over an even split), so the cap is 51 %; the other paces sit at 48.5–48.8 %.
      it('wins 40–51 % of points: insane never dominates', ({ expect }) => {
        const typists: [SimTypist, SimTypist] = [simTypist(wpm, 'neverInsane'), simTypist(wpm)];
        const points = simulatePoints({ config: config(pace), typists, seed, points: CELL_POINTS });
        expect(winShare(points, 0)).toBeGreaterThanOrEqual(0.4);
        expect(winShare(points, 0)).toBeLessThanOrEqual(0.51);
      });
    },
  );

  describe.each(PRESETS.map((p, i) => ({ ...p, seed: 2000 + 10 * i })))(
    '$pace at $wpm WPM, a fixed strategy against the adaptive human model',
    ({ pace, wpm, seed }) => {
      it.for(FIXED_POLICIES.map((policy, j) => ({ policy, seed: seed + j })))(
        '$policy wins ≤ 53 % of points',
        ({ policy, seed: cellSeed }, { expect }) => {
          const typists: [SimTypist, SimTypist] = [simTypist(wpm, policy), simTypist(wpm)];
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
