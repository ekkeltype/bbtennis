import type { Vec2 } from './types';

/** Limits `v` to the inclusive range [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A deep copy of plain JSON-safe data through JSON, the same bits a peer would receive on the wire
 * (undefined properties are dropped).
 */
export function jsonCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Linear interpolation from `a` (t = 0) to `b` (t = 1). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Quadratic ease-out: fast start, slow finish; maps 0 → 0 and 1 → 1. */
export function easeOutQuad(t: number): number {
  return t * (2 - t);
}

/** Euclidean length of a 2D vector. */
export function len2(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

/** Euclidean distance between two 2D points. */
export function dist2(a: Vec2, b: Vec2): number {
  return len2(sub2(a, b));
}

/** Componentwise sum a + b. */
export function add2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

/** Componentwise difference a − b. */
export function sub2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

/** Vector `v` scaled by `k`. */
export function scale2(v: Vec2, k: number): Vec2 {
  return { x: v.x * k, y: v.y * k };
}

/** Unit vector in the direction of `v`; the zero vector maps to {0, 0}. */
export function norm2(v: Vec2): Vec2 {
  const len = len2(v);
  return len === 0 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
}
