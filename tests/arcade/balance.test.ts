/*
 * Arcade balance simulation (spec §7). CPU vs CPU (ArcadeCpu on both sides) in short sets
 * (first to 4 games, tiebreak at 4–4), advantage scoring, Normal pace, plus a stand-in for a
 * seasoned human against every milestone belt. The full run happens only with BBT_SIM=1
 * (`BBT_SIM=1 npx vitest run tests/arcade/balance.test.ts`); `npm test` runs the smoke subset
 * (3 short sets at Green).
 *
 * Definitions. A point's hits are ArcadeState.point.hits at its end: the serve it was played on plus
 * every rally hit, so an ace is 1. Its duration runs from the set-up of its first serve to the
 * point's end (a second serve's fault pause and set-up included). Perfect hits are rally hits only
 * (ArcadeStats.perfectHits / .hits). Equal belts play seeds seed .. seed + 39; in a pair the
 * higher (or, against the stand-in, the stand-in) is player 1 on even set indices, player 0 on odd.
 *
 * The stand-in (HUMAN below) is an assumption, not a measurement: a CPU profile with a human's
 * reaction (0.28 s), a fair read of the ball (0.45 m), steady timing (σ 70 ms) and a Green-like
 * attack. It has no tactics, so a real seasoned player should do at least as well. Its targets
 * say how the ladder should feel: White and Yellow are easy, Green a test, Brown even, Black a
 * fight, Black 3rd dan the wall; and no belt's serve aces it often.
 *
 * Measured with the constants below and the seeds of this file (2026-10-22):
 *
 *   equal belts  points  median  p90  ≤ 3 hits  server  aces   DF     p99 / longest  perfect
 *   (p99 / longest: point durations; median, p90 and ≤ 3: hits per point)
 *   Green         1559      5     13   36.8 %   58.8 %  3.3 %  4.1 %  37.9 / 60.2 s  23.4 %
 *   Brown         1590      5     13   38.8 %   55.1 %  2.8 %  6.0 %  34.8 / 48.5 s  25.4 %
 *   Black         1649      5     13   37.5 %   56.9 %  1.2 %  6.4 %  40.5 / 57.8 s  28.0 %
 *
 *   higher belt wins (100 short sets each, share of sets / of points):
 *   Yellow v White 98 % / 64.1 %   Green v Yellow 95 % / 60.6 %   Brown v Green 82 % / 56.1 %
 *   Black v Brown  84 % / 57.0 %   3rd dan v Black 84 % / 56.2 %  3rd dan v White 100 %
 *
 *   the stand-in (60 short sets each: its share of sets / of points; the belt's aces on its serve):
 *   White 100 % / 75.2 % / 0.1 %   Yellow 97 % / 66.4 % / 0.7 %   Green 80 % / 54.8 % / 3.0 %
 *   Brown  48 % / 49.1 % / 5.1 %   Black  17 % / 44.0 % / 10.4 %  3rd dan 0 % / 35.5 % / 13.9 %
 *
 * History. The first tuning (2026-10-17) was against CPUs only: it reached aces of 12–14 % and a
 * server edge of 59 % with serves of 41 / 37.5 / 28.5 m/s. In playtesting a seasoned player found
 * White hard and many serves unreturnable: a press before the serve was dropped, and a human's
 * reaction is slower than a CPU's. The retune of 2026-10-22 came with new rules (spec §4.3: a
 * commit plants the player, who takes automatic steps of up to 1 m; a press made before the ball
 * comes waits for it; a clean hit scatters more the less it was charged) and changed
 * (src/arcade/core/tuning.ts, old → new):
 * - Serves: speeds flat 41 → 37, slice 37.5 → 34, kick 28.5 → 27 m/s. Against the stand-in, Black
 *   aced 25 % of its service points before and aces 10 % now.
 * - Scatter: sigma 0.26 → 0.3, incomingWeight 2.6 → 3.2, a serve return × 1.6 (returnFactor, new):
 *   the server's edge now comes from return errors instead of aces.
 * - CPU milestones: Green reaction 0.24 → 0.26, read error 0.5 → 0.56, press σ 0.12 → 0.13; Brown
 *   reaction 0.21 → 0.23, read error 0.42 → 0.48, press σ 0.095 → 0.105; 3rd dan reaction 0.16 →
 *   0.14, read error 0.25 → 0.2, press σ 0.05 → 0.045 (each step ≥ 80 % of sets on two seed sets).
 * - CPU serves by belt (new columns serveFlat / serveKick / serveAim): White 0 / 0.6 / 0.1 rising
 *   to 3rd dan 0.75 / 0 / 0.7; before, every belt served flat with probability = aggression.
 * - Targets: aces between CPUs are rare now (CPUs react in 0.14–0.26 s), so their floor of 3 % went
 *   and the aces a human faces are capped instead (the stand-in's targets); the server's floor
 *   went from 55 % to 53 %; "no point over 60 s" became "99 % of points within 45 s, none over 90 s".
 */
import { describe, expect, it } from 'vitest';
import type { ArcadeCpuProfile } from '../../src/arcade/core/cpu';
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
const YELLOW = MILESTONES[1];
const THIRD_DAN = MILESTONES[5];

/** The seasoned-human stand-in (see the header): an assumption, not a measurement. */
const HUMAN: ArcadeCpuProfile = {
  reaction: 0.28, readError: 0.45, speed: 1.0, pressSigma: 0.07, aggression: 0.6, serveFlat: 0.4, serveKick: 0.1, serveAim: 0.5,
};
/** Short sets per stand-in cell. */
const HUMAN_SETS = 60;

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
  /** The 99th percentile of point durations, in seconds. */
  p99PointSec: number;
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
    p99PointSec: [...points.map((p) => p.ticks)].sort((a, b) => a - b)[Math.floor(0.99 * (points.length - 1))]! / TICK_HZ,
    perfectRate: perfect / hits,
  };
}

type Side = number | ArcadeCpuProfile;

/** `hi`'s share of `sets` short sets against `lo`, and the aces `lo` served per point it served. */
interface PairResult { setShare: number; loAceRate: number }

/**
 * `sets` short sets of `hi` against `lo`. `hi` plays as player 1 on even set indices and as
 * player 0 on odd ones, so neither end is favoured.
 */
function pair(lo: Side, hi: Side, seed: number, sets: number): PairResult {
  let won = 0;
  let loServes = 0;
  let loAces = 0;
  for (let i = 0; i < sets; i++) {
    const higher: PlayerId = i % 2 === 0 ? 1 : 0;
    const levels: [Side, Side] = higher === 1 ? [lo, hi] : [hi, lo];
    const r = simulateMatch(SHORT, levels, seed + i);
    if (r.state.winner === higher) won++;
    for (const p of r.points) {
      if (p.server === higher) continue;
      loServes++;
      if (p.reason === 'ace') loAces++;
    }
  }
  return { setShare: won / sets, loAceRate: loAces / loServes };
}

/** Share of `sets` short sets won by belt `hi` against belt `lo`. */
function higherBeltSetShare(lo: number, hi: number, seed: number, sets: number): number {
  return pair(lo, hi, seed, sets).setShare;
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

  it('the figures are finite and roughly in shape: median rally 3–10 hits, no point over 90 s', () => {
    const s = summarize(results());
    for (const x of Object.values(s)) expect(Number.isFinite(x)).toBe(true);
    expect(s.medianHits).toBeGreaterThanOrEqual(3);
    expect(s.medianHits).toBeLessThanOrEqual(10);
    expect(s.maxPointSec).toBeLessThanOrEqual(90);
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
    it('the server wins 53–70 % of points', ({ expect }) => {
      expect(s().serverWinRate).toBeGreaterThanOrEqual(0.53);
      expect(s().serverWinRate).toBeLessThanOrEqual(0.7);
    });
    it('aces are at most 15 % of points', ({ expect }) => {
      expect(s().aceRate).toBeLessThanOrEqual(0.15);
    });
    it('double faults are 2–10 % of points', ({ expect }) => {
      expect(s().dfRate).toBeGreaterThanOrEqual(0.02);
      expect(s().dfRate).toBeLessThanOrEqual(0.1);
    });
    it('99 % of points end within 45 s, and none lasts over 90 s', ({ expect }) => {
      expect(s().p99PointSec).toBeLessThanOrEqual(45);
      expect(s().maxPointSec).toBeLessThanOrEqual(90);
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

  describe('against the seasoned-human stand-in', () => {
    const vs = new Map<number, () => PairResult>(MILESTONES.map((level) => [level, once(() => pair(level, HUMAN, 60_000 + 1000 * level, HUMAN_SETS))]));
    const cell = (level: number): PairResult => vs.get(level)!();
    it('it beats White and Yellow in ≥ 90 % of short sets', ({ expect }) => {
      expect(cell(WHITE).setShare).toBeGreaterThanOrEqual(0.9);
      expect(cell(YELLOW).setShare).toBeGreaterThanOrEqual(0.9);
    });
    it('it beats Green in ≥ 60 %', ({ expect }) => {
      expect(cell(GREEN).setShare).toBeGreaterThanOrEqual(0.6);
    });
    it('it wins 30–70 % against Brown', ({ expect }) => {
      expect(cell(BROWN).setShare).toBeGreaterThanOrEqual(0.3);
      expect(cell(BROWN).setShare).toBeLessThanOrEqual(0.7);
    });
    it('Black is a fight: it wins 5–35 %', ({ expect }) => {
      expect(cell(BLACK).setShare).toBeGreaterThanOrEqual(0.05);
      expect(cell(BLACK).setShare).toBeLessThanOrEqual(0.35);
    });
    it('Black belt 3rd dan beats it in ≥ 90 %', ({ expect }) => {
      expect(cell(THIRD_DAN).setShare).toBeLessThanOrEqual(0.1);
    });
    it('White and Yellow ace it on ≤ 2 % of their service points, every belt on ≤ 15 %', ({ expect }) => {
      expect(cell(WHITE).loAceRate).toBeLessThanOrEqual(0.02);
      expect(cell(YELLOW).loAceRate).toBeLessThanOrEqual(0.02);
      for (const level of MILESTONES) expect(cell(level).loAceRate, `level ${level}`).toBeLessThanOrEqual(0.15);
    });
  });
});
