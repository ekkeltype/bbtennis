import { describe, expect, it } from 'vitest';
import type { RngState } from '../../src/core/types';
import {
  chance,
  drawShotRandoms,
  forkSeed,
  intBelow,
  nextU32,
  normalFromUniforms,
  normalIH,
  pickIndex,
  seedRng,
  shuffleInPlace,
  uniform,
} from '../../src/core/rng';

function draws(s: RngState, n: number): number[] {
  return Array.from({ length: n }, () => nextU32(s));
}

describe('seedRng / nextU32', () => {
  it('matches the reference splitmix32-seeded sfc32 sequence', () => {
    // Known answers from an independent reference implementation (bryc's public-domain JS PRNGs).
    expect(seedRng(0)).toEqual({ a: 1684164658, b: 3653269916, c: 2939563536, d: 2141751570 });
    expect(draws(seedRng(0), 5)).toEqual([3184218848, 2185019715, 663190848, 1825547549, 1776237715]);
    expect(draws(seedRng(1), 5)).toEqual([647275419, 720736219, 2935747679, 3959590554, 1760388915]);
    expect(draws(seedRng(12345), 5)).toEqual([117767067, 1829215253, 2431464636, 3884647136, 377219090]);
  });

  it('gives identical first 1,000 values for the same seed', () => {
    expect(draws(seedRng(42), 1000)).toEqual(draws(seedRng(42), 1000));
  });

  it('gives different values for different seeds within the first 10', () => {
    expect(draws(seedRng(1), 10)).not.toEqual(draws(seedRng(2), 10));
  });

  it('returns uint32 integers and keeps the state as uint32 numbers', () => {
    const isU32 = (v: number): boolean => Number.isInteger(v) && v >= 0 && v < 2 ** 32;
    const s = seedRng(7);
    expect(draws(s, 10_000).filter((x) => !isU32(x))).toEqual([]);
    expect([s.a, s.b, s.c, s.d].every(isU32)).toBe(true);
  });

  it('reduces any seed to uint32 (fractional, negative, above 2^32)', () => {
    expect(seedRng(3.9)).toEqual(seedRng(3));
    expect(seedRng(-1)).toEqual(seedRng(2 ** 32 - 1));
    expect(seedRng(2 ** 32 + 5)).toEqual(seedRng(5));
  });

  it('survives a JSON round trip and continues the same sequence', () => {
    const s = seedRng(5);
    draws(s, 3);
    const copy = JSON.parse(JSON.stringify(s)) as RngState;
    expect(draws(copy, 100)).toEqual(draws(s, 100));
  });
});

describe('uniform', () => {
  it('stays in [0, 1) with mean 0.5 ± 0.005 over 100,000 draws', () => {
    const s = seedRng(123);
    let sum = 0;
    let outside = 0;
    for (let i = 0; i < 100_000; i++) {
      const u = uniform(s);
      if (!(u >= 0 && u < 1)) outside++;
      sum += u;
    }
    expect(outside).toBe(0);
    expect(Math.abs(sum / 100_000 - 0.5)).toBeLessThanOrEqual(0.005);
  });

  it('equals nextU32 / 2^32', () => {
    expect(uniform(seedRng(9))).toBe(nextU32(seedRng(9)) / 2 ** 32);
  });
});

describe('intBelow', () => {
  it('hits every value 0..6 and never 7 over 10,000 draws', () => {
    const s = seedRng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) seen.add(intBelow(s, 7));
    expect([...seen].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('always returns 0 for n = 1', () => {
    const s = seedRng(3);
    for (let i = 0; i < 100; i++) expect(intBelow(s, 1)).toBe(0);
  });

  it('rejects n that is not a positive integer', () => {
    const s = seedRng(3);
    expect(() => intBelow(s, 0)).toThrow(RangeError);
    expect(() => intBelow(s, 2.5)).toThrow(RangeError);
    expect(() => intBelow(s, Number.NaN)).toThrow(RangeError);
  });
});

describe('chance', () => {
  it('is never true for p = 0 and always true for p = 1', () => {
    const s = seedRng(11);
    let wrong = 0;
    for (let i = 0; i < 1000; i++) {
      if (chance(s, 0)) wrong++;
      if (!chance(s, 1)) wrong++;
    }
    expect(wrong).toBe(0);
  });

  it('is true about p of the time', () => {
    const s = seedRng(12);
    let hits = 0;
    for (let i = 0; i < 100_000; i++) if (chance(s, 0.3)) hits++;
    expect(Math.abs(hits / 100_000 - 0.3)).toBeLessThanOrEqual(0.01);
  });

  it('consumes exactly one draw whatever p is', () => {
    const a = seedRng(13);
    const b = seedRng(13);
    chance(a, 0);
    chance(a, 1);
    chance(a, 0.5);
    draws(b, 3);
    expect(a).toEqual(b);
  });
});

describe('Irwin–Hall normals', () => {
  it('normalFromUniforms maps the extremes to ±2√3 and all-halves to 0', () => {
    expect(normalFromUniforms([0, 0, 0, 0])).toBe(-2 * Math.sqrt(3));
    expect(normalFromUniforms([1, 1, 1, 1])).toBe(2 * Math.sqrt(3));
    expect(normalFromUniforms([0.5, 0.5, 0.5, 0.5])).toBe(0);
  });

  it('normalFromUniforms applies (u1+u2+u3+u4−2)·√3', () => {
    expect(normalFromUniforms([0.1, 0.2, 0.3, 0.9])).toBeCloseTo((0.1 + 0.2 + 0.3 + 0.9 - 2) * Math.sqrt(3), 12);
  });

  it('normalFromUniforms requires exactly 4 uniforms', () => {
    expect(() => normalFromUniforms([0.5, 0.5, 0.5])).toThrow(RangeError);
    expect(() => normalFromUniforms([0.5, 0.5, 0.5, 0.5, 0.5])).toThrow(RangeError);
  });

  it('normalIH is bounded by 3.4642 with variance 1 ± 0.02 over 100,000 draws', () => {
    const s = seedRng(2024);
    const n = 100_000;
    let sum = 0;
    let sumSq = 0;
    let maxAbs = 0;
    for (let i = 0; i < n; i++) {
      const z = normalIH(s);
      maxAbs = Math.max(maxAbs, Math.abs(z));
      sum += z;
      sumSq += z * z;
    }
    expect(maxAbs).toBeLessThanOrEqual(3.4642);
    const mean = sum / n;
    const variance = (sumSq - n * mean * mean) / (n - 1);
    expect(Math.abs(variance - 1)).toBeLessThanOrEqual(0.02);
  });

  it('normalIH uses four successive uniforms', () => {
    const a = seedRng(77);
    const b = seedRng(77);
    const z = normalIH(a);
    expect(z).toBe(normalFromUniforms([uniform(b), uniform(b), uniform(b), uniform(b)]));
    expect(a).toEqual(b);
  });
});

describe('pickIndex', () => {
  it('returns a valid index and covers the whole array', () => {
    const s = seedRng(5);
    const arr = ['a', 'b', 'c'];
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(pickIndex(s, arr));
    expect([...seen].sort((x, y) => x - y)).toEqual([0, 1, 2]);
  });

  it('rejects an empty array', () => {
    expect(() => pickIndex(seedRng(5), [])).toThrow(RangeError);
  });
});

describe('shuffleInPlace', () => {
  it('returns the same array holding a permutation of its items', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i);
    const out = shuffleInPlace(seedRng(8), arr);
    expect(out).toBe(arr);
    expect([...out].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(out).not.toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('is deterministic for a seed', () => {
    const mk = (): number[] => Array.from({ length: 20 }, (_, i) => i);
    expect(shuffleInPlace(seedRng(8), mk())).toEqual(shuffleInPlace(seedRng(8), mk()));
    expect(shuffleInPlace(seedRng(8), mk())).not.toEqual(shuffleInPlace(seedRng(9), mk()));
  });

  it('handles empty and single-item arrays', () => {
    expect(shuffleInPlace(seedRng(1), [])).toEqual([]);
    expect(shuffleInPlace(seedRng(1), ['x'])).toEqual(['x']);
  });
});

describe('forkSeed', () => {
  it('gives different seeds for different streams, deterministically', () => {
    expect(forkSeed(1, 1)).not.toBe(forkSeed(1, 2));
    expect(forkSeed(1, 1)).toBe(forkSeed(1, 1));
    expect(forkSeed(1, 2)).toBe(forkSeed(1, 2));
  });

  it('returns a uint32 usable as a seed, giving a stream unlike the parent', () => {
    const f = forkSeed(1, 1);
    expect(Number.isInteger(f) && f >= 0 && f < 2 ** 32).toBe(true);
    expect(draws(seedRng(f), 10)).not.toEqual(draws(seedRng(1), 10));
  });

  it('depends on the parent seed', () => {
    expect(forkSeed(1, 1)).not.toBe(forkSeed(2, 1));
  });
});

describe('drawShotRandoms', () => {
  it('returns the next 9 uniforms in draw order', () => {
    const a = seedRng(31);
    const b = seedRng(31);
    const r = drawShotRandoms(a);
    expect(r).toHaveLength(9);
    expect(r).toEqual(Array.from({ length: 9 }, () => uniform(b)));
    for (const u of r) expect(u >= 0 && u < 1).toBe(true);
    expect(a).toEqual(b);
  });
});
