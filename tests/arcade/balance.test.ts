/*
 * Arcade balance simulation (spec §7). CPU vs CPU (ArcadeCpu on both sides) in short sets
 * (first to 4 games, tiebreak at 4–4), advantage scoring, Normal pace. The full run happens only
 * with BBT_SIM=1 (`BBT_SIM=1 npx vitest run tests/arcade/balance.test.ts`); `npm test` runs the
 * smoke subset (3 short sets at Green).
 *
 * Definitions. A point's hits are ArcadeState.point.hits at its end: the serve it was played on plus
 * every rally hit, so an ace is 1. Its duration runs from the set-up of its first serve to the
 * point's end (a second serve's fault pause and set-up included). Perfect hits are rally hits only
 * (ArcadeStats.perfectHits / .hits). Equal belts play seeds seed .. seed + 39; in a belt pair the
 * higher belt is player 1 on even set indices and player 0 on odd ones.
 *
 * Measured with the constants below and the seeds of this file (2026-10-17):
 *
 *   equal belts  points  median  p90  ≤ 3 hits  server  aces    DF     longest  perfect
 *   Green         1692      4     11   37.8 %   58.6 %  11.8 %  3.8 %  43.2 s   35.9 %
 *   Brown         1779      4     10   41.8 %   58.8 %  13.6 %  3.7 %  42.0 s   42.5 %
 *   Black         1790      4     10   42.5 %   59.2 %  13.6 %  4.2 %  41.8 s   46.9 %
 *
 *   higher belt wins (100 short sets each, share of sets / of points):
 *   Yellow v White 100 % / 67.5 %   Green v Yellow 100 % / 69.3 %   Brown v Green 86 % / 57.4 %
 *   Black v Brown   97 % / 60.3 %   3rd dan v Black 99 % / 64.5 %   3rd dan v White 100 % / 89.4 %
 *
 * Before tuning (the spec's starting values), same seeds: Green / Brown / Black median 4 / 4 / 5,
 * server 53.4 / 56.0 / 54.5 %, aces 12.6 / 12.5 / 8.4 %, double faults 0.5 / 0.1 / 0.0 %, longest
 * point 34.2 / 45.0 / 54.9 s, Black perfect 75.8 %; every pair 99–100 % of sets. Failing: server
 * (Green, Black), double faults (all three) and Black's perfect share. Rallies ended mostly in
 * balls the receiver ran for and missed, and returns were as dangerous as rally balls (return
 * winners 8–12 % of points), so the serve gave almost no edge.
 *
 * What changed (src/arcade/core/tuning.ts, old → new):
 * - CPU milestones:
 *               reaction s    read error m  speed ×       press σ s       aggression
 *     White     0.42          1.2           0.78          0.16 → 0.2      0.15
 *     Yellow    0.34 → 0.32   0.9 → 0.8     0.84 → 0.85   0.12 → 0.15     0.3
 *     Green     0.26 → 0.24   0.6 → 0.5     0.9 → 0.92    0.085 → 0.12    0.45 → 0.6
 *     Brown     0.19 → 0.21   0.35 → 0.42   0.95 → 0.96   0.055 → 0.095   0.6 → 0.68
 *     Black     0.14 → 0.2    0.2 → 0.35    1.0           0.035 → 0.078   0.75 → 0.8
 *     3rd dan   0.1 → 0.16    0.1 → 0.25    1.0           0.02 → 0.05     0.85 → 0.95
 *   A wider press σ brings Black's perfect share into 15–60 %. Green to Black now differ less in
 *   defence (reaction, read error) and more in attack (aggression, timing), so equal-belt rallies
 *   have a similar shape at every belt.
 * - Scatter: sigma 0.35 → 0.26, incomingWeight 0.5 → 2.6 (a fast serve's return scatters far more
 *   than a rally ball: return errors give the server its edge).
 * - Grades: perfect power 1.1 → 1.15, margin 0.5 → 0.6, scatter 0.6 → 0.55; clean powerBase
 *   0.8 → 0.65 (clean = 0.65 + 0.2 × charge), so perfect timing matters more.
 * - Serves: speeds flat 40 → 41, slice 34 → 37.5, kick 27 → 28.5; margins flat 0.25 → 0.13,
 *   slice 0.45 → 0.2, kick 0.6 → 0.25 (first serves fault 26–29 % of the time, second serves
 *   13–15 %).
 * - Receiving spot: receive.x 2.6 → 3.1.
 * Unchanged: the rally shot speeds, tSigma, the slice-serve curve and every rule. CPU behaviour (cpu.ts, spec §7):
 * a serve return goes to a corner with probability 0.3 × aggression (rally balls keep
 * 0.25 + 0.6 × aggression); depth follows the rally choice (deep with deepChance, otherwise neutral).
 */
import { describe, expect, it } from 'vitest';
import { simulateMatch } from '../../src/arcade/core/sim';
import type { PointRecord, SimResult } from '../../src/arcade/core/sim';
import { TICK_HZ } from '../../src/arcade/core/tuning';
import type { ArcadeConfig, PlayerId } from '../../src/arcade/core/types';

const FULL = import.meta.env.BBT_SIM === '1';
const TEN_MINUTES = 600_000;
const SHORT: ArcadeConfig = { format: 'short', deuceRule: 'advantage', surface: 'hard', pace: 'normal' };

/** Short sets per equal-belt cell (at least 30). */
const EQUAL_SETS = 40;
/** Short sets per belt-vs-belt cell (at least 40). */
const PAIR_SETS = 100;

const GREEN = 6;
const BROWN = 9;
const BLACK = 12;
/** The milestone rows of spec §5, White to Black 3rd dan. */
const MILESTONES = [0, 3, 6, 9, 12, 14] as const;
const WHITE = MILESTONES[0];
const THIRD_DAN = MILESTONES[5];

/** Computes `make()` once, on first use, so the tests of one cell share a simulation. */
function once<T>(make: () => T): () => T {
  let cached: { value: T } | null = null;
  return () => (cached ??= { value: make() }).value;
}

function median(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor((v.length - 1) / 2)]!;
}

/** The spec §7 figures of a batch of matches. */
interface Summary {
  sets: number;
  points: number;
  /** Median hits per point, the serve included. */
  medianHits: number;
  serverWinRate: number;
  aceRate: number;
  dfRate: number;
  /** Longest point, set-up of its first serve to its end, in seconds. */
  maxPointSec: number;
  /** Perfect rally hits / rally hits (serves excluded), both players. */
  perfectRate: number;
}

/** `sets` short sets between equal belts, seeds seed .. seed + sets − 1. */
function equalSets(level: number, seed: number, sets: number): SimResult[] {
  return Array.from({ length: sets }, (_, i) => simulateMatch(SHORT, [level, level], seed + i));
}

/** The spec §7 figures of finished matches. */
function summarize(results: readonly SimResult[]): Summary {
  const unfinished = results.filter((r) => r.state.status !== 'over').length;
  if (unfinished > 0) throw new Error(`${unfinished} simulated matches did not finish`);
  const points = results.flatMap((r) => r.points);
  const hits = results.reduce((n, r) => n + r.state.stats[0].hits + r.state.stats[1].hits, 0);
  const perfect = results.reduce((n, r) => n + r.state.stats[0].perfectHits + r.state.stats[1].perfectHits, 0);
  const share = (pred: (p: PointRecord) => boolean): number => points.filter(pred).length / points.length;
  return {
    sets: results.length,
    points: points.length,
    medianHits: median(points.map((p) => p.hits)),
    serverWinRate: share((p) => p.winner === p.server),
    aceRate: share((p) => p.reason === 'ace'),
    dfRate: share((p) => p.reason === 'doubleFault'),
    maxPointSec: Math.max(...points.map((p) => p.ticks)) / TICK_HZ,
    perfectRate: perfect / hits,
  };
}

/**
 * Share of `sets` short sets won by belt `hi` against belt `lo`. The higher belt plays as player 1
 * on even set indices and as player 0 on odd ones, so neither end is favoured.
 */
function higherBeltSetShare(lo: number, hi: number, seed: number, sets: number): number {
  let won = 0;
  for (let i = 0; i < sets; i++) {
    const higher: PlayerId = i % 2 === 0 ? 1 : 0;
    const levels: [number, number] = higher === 1 ? [lo, hi] : [hi, lo];
    if (simulateMatch(SHORT, levels, seed + i).state.winner === higher) won++;
  }
  return won / sets;
}

describe('arcade balance smoke (3 short sets at Green)', () => {
  const results = once(() => equalSets(GREEN, 900, 3));

  it('every set ends with a winner, and every point is a sane record', () => {
    for (const r of results()) {
      expect(r.state.status).toBe('over');
      expect(r.state.winner === 0 || r.state.winner === 1).toBe(true);
      expect(r.points.length).toBeGreaterThanOrEqual(16);
      for (const p of r.points) {
        expect(Number.isInteger(p.hits) && p.hits >= 0).toBe(true);
        expect(Number.isInteger(p.ticks) && p.ticks > 0).toBe(true);
      }
    }
  });

  it('the figures are finite and roughly in shape: median rally 3–10 hits, no point over 60 s', () => {
    const s = summarize(results());
    for (const x of Object.values(s)) expect(Number.isFinite(x)).toBe(true);
    expect(s.medianHits).toBeGreaterThanOrEqual(3);
    expect(s.medianHits).toBeLessThanOrEqual(10);
    expect(s.maxPointSec).toBeLessThanOrEqual(60);
  });
});

describe.skipIf(!FULL).concurrent('arcade balance simulation (spec §7)', { timeout: TEN_MINUTES }, () => {
  describe.each([
    { name: 'Green', level: GREEN, seed: 10_000 },
    { name: 'Brown', level: BROWN, seed: 20_000 },
    { name: 'Black', level: BLACK, seed: 30_000 },
  ])('equal belts, $name', ({ level, seed }) => {
    const s = once(() => summarize(equalSets(level, seed, EQUAL_SETS)));
    it('median rally is 4–10 hits', ({ expect }) => {
      expect(s().medianHits).toBeGreaterThanOrEqual(4);
      expect(s().medianHits).toBeLessThanOrEqual(10);
    });
    it('the server wins 55–70 % of points', ({ expect }) => {
      expect(s().serverWinRate).toBeGreaterThanOrEqual(0.55);
      expect(s().serverWinRate).toBeLessThanOrEqual(0.7);
    });
    it('aces are 3–15 % of points', ({ expect }) => {
      expect(s().aceRate).toBeGreaterThanOrEqual(0.03);
      expect(s().aceRate).toBeLessThanOrEqual(0.15);
    });
    it('double faults are 2–10 % of points', ({ expect }) => {
      expect(s().dfRate).toBeGreaterThanOrEqual(0.02);
      expect(s().dfRate).toBeLessThanOrEqual(0.1);
    });
    it('no point lasts over 60 s', ({ expect }) => {
      expect(s().maxPointSec).toBeLessThanOrEqual(60);
    });
    if (level === BLACK) {
      it('perfect hits are 15–60 % of rally hits', ({ expect }) => {
        expect(s().perfectRate).toBeGreaterThanOrEqual(0.15);
        expect(s().perfectRate).toBeLessThanOrEqual(0.6);
      });
    }
  });

  it.for(MILESTONES.slice(1).map((hi, i) => ({ lo: MILESTONES[i]!, hi, seed: 40_000 + 1000 * i })))(
    'belt $hi beats belt $lo in ≥ 75 % of short sets',
    ({ lo, hi, seed }, { expect }) => {
      expect(higherBeltSetShare(lo, hi, seed, PAIR_SETS)).toBeGreaterThanOrEqual(0.75);
    },
  );

  it('Black belt 3rd dan beats White belt in ≥ 99 % of short sets', ({ expect }) => {
    expect(higherBeltSetShare(WHITE, THIRD_DAN, 50_000, PAIR_SETS)).toBeGreaterThanOrEqual(0.99);
  });
});
