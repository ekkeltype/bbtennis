/*
 * Balance simulation (early-typing spec §4 of 2026-09-28, with the result the user accepted). The full
 * suite runs only with BBT_SIM=1 (`npm run test:sim`); `npm test` runs the smoke subset.
 *
 * Players: two copies of the typist model (src/core/cpu.ts typistProfile, via simTypist) at each
 * preset's reference WPM, with the aggression the belt ladder gives that speed, typing early from the
 * striker's lock as the game allows. Targets per preset are in PRESETS below: Relaxed is judged apart
 * (the user's choice: median ≤ 20 shots, ≤ 100 s per point, no tier-mix or faster-wins target), and the
 * accepted result re-set six targets to what the chosen tuning measures (Lightning server wins ≤ 76 %,
 * clean insane returns 3–50 %, no double-fault floor at Relaxed and Normal, Relaxed aggression ≥ 45 %,
 * faster wins ≥ 63 % at Normal and Fast, CPU levels 2 apart ≥ 78 %) and Normal's median band to 6–11.
 *
 * Tuning (src/core/tuning.ts, 2026-09-28): rally flight pace·7300/v · place[tier] · 0.78^⌊n/2⌋ with
 * place 1 / 0.45 / 0.22 / 0.19 and no floor; serve reading allowance 500 + 350·pace ms; the calibrated
 * CPU_NOMINAL_WPM. Why: a gentler attack (hard 0.35–0.45) let always-easy beat the adaptive player
 * (60 % of points) and aggression 0.8 lose to 0.2 (38 %), since a slipped hard word goes out about half
 * the time; a longer rally base gave more long words but a smaller edge to the faster typist.
 *
 * Measured with those constants and the seeds below:
 *
 * Equal players, 5,000 points per preset, full sets:
 *   preset     WPM  median  p90  max  aces    DF     server  s/point  rally easy/medium/hard/insane  early start/done
 *   Relaxed     30     9     18   21   0.1 %  0.2 %  56.2 %   63.8    71.2 / 18.5 /  9.7 / 0.5 %     99.9 / 80.4 %
 *   Normal      50     6     15   18   0.2 %  1.1 %  58.2 %   32.9    60.8 / 18.0 / 20.2 / 1.0 %     97.6 / 74.7 %
 *   Fast        70     5      8   17   0.2 %  2.1 %  64.2 %   20.9    56.6 / 14.4 / 27.3 / 1.7 %     87.6 / 70.0 %
 *   Lightning   90     3      6   15   0.9 %  3.6 %  72.6 %   14.3    55.3 / 10.6 / 32.0 / 2.0 %     83.6 / 63.8 %
 *   (early start/done: rally returns whose chase got a key, and was complete, before the strike)
 *
 * The insane option between equal players, 20,000 points per preset:
 *   preset     clean insane shots  returned by the opponent  points offering insane
 *   Relaxed            680               48.8 %                    50.6 %
 *   Normal            1019               31.7 %                    33.2 %
 *   Fast              1096               17.2 %                    25.0 %
 *   Lightning          995                6.8 %                    19.0 %
 *
 * Share of points won against the adaptive player, 5,000 points:
 *   preset     alwaysEasy  alwaysHard  neverHard  neverInsane  20 % faster
 *   Relaxed      48.6 %      31.0 %      48.4 %     50.3 %        —
 *   Normal       40.5 %      37.6 %      43.2 %     50.4 %      66.3 %
 *   Fast         32.3 %      42.3 %      40.1 %     49.6 %      64.2 %
 *   Lightning    27.6 %      44.0 %      41.4 %     49.8 %      66.2 %
 *
 * CPU aggression 0.8 vs 0.2 at equal speed, share won by 0.8, 5,000 points:
 *   Relaxed L2 47.7 %, Normal L6 56.6 %, Fast L8 60.5 %, Lightning L10 61.4 %.
 *
 * Honest labels, each level against itself, 40 short sets at Normal (label: Results average WPM):
 *   25: 24.8  28: 28.2  32: 31.6  36: 35.7  41: 41.2  46: 45.8  52: 51.8  59: 59.1
 *   67: 67.2  76: 76.2  86: 85.6  97: 96.7  110: 109.8  124: 124.2  140: 140.0
 *
 * CPU levels at Normal, 200 short sets per pair, share won by the higher level:
 *   adjacent  sets      2 apart  sets
 *   0v1       99.0 %    0v2     100.0 %
 *   1v2       99.0 %    1v3     100.0 %
 *   2v3       98.5 %    2v4     100.0 %
 *   3v4       99.0 %    3v5      99.5 %
 *   4v5       93.5 %    4v6     100.0 %
 *   5v6       98.0 %    5v7      99.5 %
 *   6v7       94.5 %    6v8      99.5 %
 *   7v8       91.0 %    7v9      98.5 %
 *   8v9       90.5 %    8v10     98.0 %
 *   9v10      77.5 %    9v11     90.0 %
 *   10v11     75.0 %    10v12    93.0 %
 *   11v12     80.0 %    11v13    91.0 %
 *   12v13     77.5 %    12v14    81.5 %
 *   13v14     72.0 %
 */
import { describe, expect, it } from 'vitest';
import { cpuProfile, type CpuPolicy } from '../../src/core/cpu';
import { averageWpm } from '../../src/core/engine';
import { simTypist, simulateMatch, simulatePoints, summarize, type PointRecord, type SimTypist } from '../../src/core/sim';
import { CPU_LEVEL_WPM } from '../../src/core/tuning';
import type { MatchConfig, PaceId, PlayerId, PlayerStats } from '../../src/core/types';

const FULL = import.meta.env.BBT_SIM === '1';
const TEN_MINUTES = 600_000;
/** Points per rally-shape, policy and aggression cell. */
const CELL_POINTS = 5000;
/** Points per equal-player insane-option cell (need ≥ 200 clean insane shots). */
const INSANE_POINTS = 20_000;
/** Short sets per belt-vs-belt cell. */
const CELL_SETS = 200;
/** Short sets per honest-labels cell (both players' average WPM). */
const HONEST_SETS = 40;

/** A pace's targets (early-typing spec §4, with the result the user accepted on 2026-09-28). */
interface Preset {
  pace: PaceId;
  /** The pace's reference WPM (spec §3.9). */
  wpm: number;
  median: [number, number];
  maxSecPerPoint: number;
  /** Whether the rally tier-mix target applies (easy ≤ 65 %, hard + insane ≥ 15 %). */
  tierMix: boolean;
  /** Least share of points a typist 20 % faster wins, or null when there is no such target. */
  fasterMin: number | null;
  doubleFaults: [number, number];
  serverWins: [number, number];
  /** Least share of points CPU aggression 0.8 wins against 0.2 at equal speed. */
  aggressionMin: number;
}

/**
 * Each pace preset at its reference WPM with its targets. Relaxed is judged apart (the user's choice,
 * 2026-09-28): its easy balls float for seconds and its 30-WPM belts rarely attack, so it keeps only a
 * median of at most 20 shots and at most 100 s per point, with no tier-mix or faster-wins target. The
 * rest guard the accepted tuning: no double-fault floor at Relaxed and Normal (human-like players pick
 * serve words with care), Lightning's server may win up to 76 % (there the first attack decides),
 * the faster typist at Normal and Fast at least 63 %, Relaxed's aggressive player at least 45 %, and
 * Normal's median rally 6–11 (it measures 6 with the tuning kept for the top belts).
 */
const PRESETS: Preset[] = [
  { pace: 'relaxed', wpm: 30, median: [0, 20], maxSecPerPoint: 100, tierMix: false, fasterMin: null, doubleFaults: [0, 0.08], serverWins: [0.55, 0.65], aggressionMin: 0.45 },
  { pace: 'normal', wpm: 50, median: [6, 11], maxSecPerPoint: 65, tierMix: true, fasterMin: 0.63, doubleFaults: [0, 0.08], serverWins: [0.55, 0.65], aggressionMin: 0.5 },
  { pace: 'fast', wpm: 70, median: [4, 7], maxSecPerPoint: 65, tierMix: true, fasterMin: 0.63, doubleFaults: [0.01, 0.08], serverWins: [0.55, 0.65], aggressionMin: 0.5 },
  { pace: 'lightning', wpm: 90, median: [3, 5], maxSecPerPoint: 65, tierMix: true, fasterMin: 0.65, doubleFaults: [0.01, 0.08], serverWins: [0.55, 0.76], aggressionMin: 0.5 },
];

/** Share of clean insane shots the equal opponent returns, at every pace (accepted 2026-09-28: Relaxed returns many, Lightning few). */
const INSANE_RETURNS: [number, number] = [0.03, 0.5];

/** The fixed strategies checked against the adaptive human model. */
const FIXED_POLICIES: CpuPolicy[] = ['alwaysEasy', 'alwaysHard', 'neverHard'];

/** A CPU level near each preset's reference WPM, for the aggression check at equal speed. */
const AGGRESSION_CELLS: { pace: PaceId; level: number; min: number }[] = [
  { pace: 'relaxed', level: 2, min: 0.45 },
  { pace: 'normal', level: 6, min: 0.5 },
  { pace: 'fast', level: 8, min: 0.5 },
  { pace: 'lightning', level: 10, min: 0.5 },
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

/** Both players' average WPM (the Results formula) over `sets` short sets at Normal between two copies of `level`. */
function measuredWpm(level: number, seed: number, sets: number): number {
  const typists: [SimTypist, SimTypist] = [{ profile: cpuProfile(level) }, { profile: cpuProfile(level) }];
  let intervalSum = 0;
  let typingMs = 0;
  for (let i = 0; i < sets; i++) {
    for (const st of simulateMatch({ config: config('normal', 'short'), typists, seed: seed + i }).stats) {
      intervalSum += st.intervalSum;
      typingMs += st.typingMs;
    }
  }
  return averageWpm({ intervalSum, typingMs } as PlayerStats);
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
  it('300 points at Normal / 50 WPM all end, with finite times, a median rally of 4–14 shots and not only easy words', () => {
    const points = simulatePoints({ config: config('normal'), typists: [simTypist(50), simTypist(50)], seed: 42, points: 300 });
    expect(points).toHaveLength(300);
    for (const p of points) {
      expect(Number.isFinite(p.ms) && p.ms > 0).toBe(true);
      expect(Number.isInteger(p.shots) && p.shots >= 0).toBe(true);
    }
    const s = summarize(points);
    for (const v of Object.values(s)) expect(Number.isFinite(v)).toBe(true);
    expect(s.medianShots).toBeGreaterThanOrEqual(4);
    expect(s.medianShots).toBeLessThanOrEqual(14);
    expect(s.rallyEasy).toBeLessThan(1);
  });
});

describe.skipIf(!FULL).concurrent('balance simulation (early-typing spec §4)', { timeout: TEN_MINUTES }, () => {
  describe.each(PRESETS.map((p, i) => ({ ...p, seed: 1000 + i })))(
    '$pace at $wpm WPM, equal human-model players',
    ({ pace, wpm, median: [lo, hi], maxSecPerPoint, tierMix, doubleFaults: [dfLo, dfHi], serverWins: [srvLo, srvHi], seed }) => {
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
      // Human-like players pick serve words with care, so double faults are rare at the slower paces.
      it(`double faults are ${100 * dfLo}–${100 * dfHi} % of points`, ({ expect }) => {
        expect(s().dfRate).toBeGreaterThanOrEqual(dfLo);
        expect(s().dfRate).toBeLessThanOrEqual(dfHi);
      });
      it(`the server wins ${100 * srvLo}–${100 * srvHi} % of points`, ({ expect }) => {
        expect(s().serverWinRate).toBeGreaterThanOrEqual(srvLo);
        expect(s().serverWinRate).toBeLessThanOrEqual(srvHi);
      });
      it(`a point takes ≤ ${maxSecPerPoint} s (median)`, ({ expect }) => {
        expect(s().medianSecPerPoint).toBeLessThanOrEqual(maxSecPerPoint);
      });
      it.skipIf(!tierMix)('rally shots are at most 65 % easy (early-typing spec §4)', ({ expect }) => {
        expect(s().rallyEasy).toBeLessThanOrEqual(0.65);
      });
      it.skipIf(!tierMix)('at least 15 % of rally shots are hard or insane (early-typing spec §4)', ({ expect }) => {
        expect(s().rallyHard + s().rallyInsane).toBeGreaterThanOrEqual(0.15);
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
      it(`the equal opponent returns ${100 * INSANE_RETURNS[0]}–${100 * INSANE_RETURNS[1]} % of clean insane shots`, ({ expect }) => {
        expect(s().insaneReturnRate).toBeGreaterThanOrEqual(INSANE_RETURNS[0]);
        expect(s().insaneReturnRate).toBeLessThanOrEqual(INSANE_RETURNS[1]);
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

  describe.each(PRESETS.filter((p) => p.fasterMin !== null).map((p, i) => ({ ...p, min: p.fasterMin ?? 0, seed: 6000 + i })))(
    '$pace at $wpm WPM, a typist 20 % faster',
    ({ pace, wpm, min, seed }) => {
      it(`wins ≥ ${100 * min} % of points (early-typing spec §4)`, ({ expect }) => {
        const typists: [SimTypist, SimTypist] = [simTypist(wpm * 1.2), simTypist(wpm)];
        const points = simulatePoints({ config: config(pace), typists, seed, points: CELL_POINTS });
        expect(winShare(points, 0)).toBeGreaterThanOrEqual(min);
      });
    },
  );

  it.for(CPU_LEVEL_WPM.map((wpm, level) => ({ level, wpm, seed: 700_000 + 1000 * level })))(
    'Normal, CPU level $level: its average WPM on Results is within 5 % of $wpm (early-typing spec §4)',
    ({ level, wpm, seed }, { expect }) => {
      const measured = measuredWpm(level, seed, HONEST_SETS);
      expect(measured / wpm).toBeGreaterThanOrEqual(0.95);
      expect(measured / wpm).toBeLessThanOrEqual(1.05);
    },
  );

  it.for(AGGRESSION_CELLS.map((c, i) => ({ ...c, seed: 3000 + i })))(
    '$pace, CPU level $level: aggression 0.8 wins ≥ $min of the points against 0.2 at equal speed',
    ({ pace, level, min, seed }, { expect }) => {
      const base = cpuProfile(level);
      const typists: [SimTypist, SimTypist] = [
        { profile: { ...base, aggression: 0.8 } },
        { profile: { ...base, aggression: 0.2 } },
      ];
      const points = simulatePoints({ config: config(pace), typists, seed, points: CELL_POINTS });
      expect(winShare(points, 0)).toBeGreaterThanOrEqual(min);
    },
  );

  it.for(levelPairs(1).map(([lo, hi]) => ({ lo, hi, seed: 10_000 * (lo + 1) })))(
    'Normal, adjacent CPU levels $lo vs $hi: the higher wins ≥ 65 % of short sets',
    ({ lo, hi, seed }, { expect }) => {
      expect(higherLevelSetShare(lo, hi, seed, CELL_SETS)).toBeGreaterThanOrEqual(0.65);
    },
  );

  it.for(levelPairs(2).map(([lo, hi]) => ({ lo, hi, seed: 500_000 + 10_000 * (lo + 1) })))(
    'Normal, CPU levels $lo vs $hi (2 apart): the higher wins ≥ 78 % of short sets',
    ({ lo, hi, seed }, { expect }) => {
      // Accepted 2026-09-28 (was 90 %): Normal pace leaves the 110–140 WPM belts room, so the top pairs land near 80 %.
      expect(higherLevelSetShare(lo, hi, seed, CELL_SETS)).toBeGreaterThanOrEqual(0.78);
    },
  );
});
