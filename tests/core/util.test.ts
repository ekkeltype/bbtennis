import { describe, expect, it } from 'vitest';
import { add2, clamp, dist2, easeOutQuad, len2, lerp, norm2, scale2, sub2 } from '../../src/core/util';

describe('clamp', () => {
  it('keeps values inside the range unchanged', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to the lower and upper bounds', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(12, 0, 10)).toBe(10);
  });

  it('treats the bounds as inclusive', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe('lerp', () => {
  it('returns the endpoints at t = 0 and t = 1', () => {
    expect(lerp(2, 8, 0)).toBe(2);
    expect(lerp(2, 8, 1)).toBe(8);
  });

  it('interpolates linearly in between', () => {
    expect(lerp(2, 8, 0.5)).toBe(5);
    expect(lerp(10, 0, 0.25)).toBe(7.5);
  });
});

describe('easeOutQuad', () => {
  it('maps 0 to 0, 1 to 1 and 0.5 to 0.75', () => {
    expect(easeOutQuad(0)).toBe(0);
    expect(easeOutQuad(1)).toBe(1);
    expect(easeOutQuad(0.5)).toBe(0.75);
  });
});

describe('2D vector helpers', () => {
  it('len2 is the Euclidean length', () => {
    expect(len2({ x: 3, y: 4 })).toBe(5);
    expect(len2({ x: 0, y: 0 })).toBe(0);
  });

  it('dist2 is the Euclidean distance between two points', () => {
    expect(dist2({ x: 1, y: 1 }, { x: 4, y: 5 })).toBe(5);
    expect(dist2({ x: 4, y: 5 }, { x: 1, y: 1 })).toBe(5);
  });

  it('add2, sub2 and scale2 work componentwise', () => {
    expect(add2({ x: 1, y: 2 }, { x: 3, y: -5 })).toEqual({ x: 4, y: -3 });
    expect(sub2({ x: 1, y: 2 }, { x: 3, y: -5 })).toEqual({ x: -2, y: 7 });
    expect(scale2({ x: 1.5, y: -2 }, 2)).toEqual({ x: 3, y: -4 });
  });

  it('returns new vectors without mutating the inputs', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 3, y: 4 };
    const sum = add2(a, b);
    expect(sum).not.toBe(a);
    expect(a).toEqual({ x: 1, y: 2 });
    expect(b).toEqual({ x: 3, y: 4 });
  });

  it('norm2 scales a vector to unit length', () => {
    const n = norm2({ x: 3, y: 4 });
    expect(n.x).toBeCloseTo(0.6, 12);
    expect(n.y).toBeCloseTo(0.8, 12);
  });

  it('norm2 of the zero vector is the zero vector', () => {
    const n = norm2({ x: 0, y: 0 });
    expect(n).toEqual({ x: 0, y: 0 });
    expect(Number.isNaN(n.x) || Number.isNaN(n.y)).toBe(false);
  });
});
