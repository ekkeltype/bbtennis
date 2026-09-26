import type { RngState, ShotRandoms } from './types';

const GOLDEN = 0x9e3779b9;
const TWO_POW_32 = 4294967296;
const SQRT3 = Math.sqrt(3);

/** splitmix32 output finaliser: a bijection on uint32 with good avalanche. */
function mix32(x: number): number {
  let t = x ^ (x >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  t ^= t >>> 15;
  return t >>> 0;
}

/** sfc32 state seeded with four splitmix32 outputs; `seed` is reduced to uint32 first. */
export function seedRng(seed: number): RngState {
  let x = seed >>> 0;
  const next = (): number => {
    x = (x + GOLDEN) >>> 0;
    return mix32(x);
  };
  const a = next();
  const b = next();
  const c = next();
  const d = next();
  return { a, b, c, d };
}

/** Next sfc32 output as a uint32; mutates `s` (its fields stay uint32). */
export function nextU32(s: RngState): number {
  const t = (((s.a + s.b) | 0) + s.d) | 0;
  s.d = (s.d + 1) >>> 0;
  s.a = (s.b ^ (s.b >>> 9)) >>> 0;
  s.b = (s.c + (s.c << 3)) >>> 0;
  s.c = (((s.c << 21) | (s.c >>> 11)) + t) >>> 0;
  return t >>> 0;
}

/** Uniform in [0, 1): nextU32 / 2^32. */
export function uniform(s: RngState): number {
  return nextU32(s) / TWO_POW_32;
}

/** Uniform integer in 0..n−1; `n` must be a positive integer. One draw. */
export function intBelow(s: RngState, n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`intBelow: n must be a positive integer, got ${n}`);
  return Math.floor(uniform(s) * n);
}

/** True with probability `p` (p ≤ 0 never, p ≥ 1 always). Always consumes exactly one draw. */
export function chance(s: RngState, p: number): boolean {
  return uniform(s) < p;
}

/** Irwin–Hall approximate standard normal (u1+u2+u3+u4−2)·√3 from four draws; |z| < 2√3 (spec §3.5). */
export function normalIH(s: RngState): number {
  return normalFromUniforms([uniform(s), uniform(s), uniform(s), uniform(s)]);
}

/** Same formula as normalIH on exactly four given uniforms (e.g. pre-drawn ShotRandoms). */
export function normalFromUniforms(u: readonly number[]): number {
  const [u1, u2, u3, u4] = u;
  if (u.length !== 4 || u1 === undefined || u2 === undefined || u3 === undefined || u4 === undefined) {
    throw new RangeError(`normalFromUniforms: expected 4 uniforms, got ${u.length}`);
  }
  return (u1 + u2 + u3 + u4 - 2) * SQRT3;
}

/** Uniform random index into a non-empty array. */
export function pickIndex<T>(s: RngState, arr: readonly T[]): number {
  return intBelow(s, arr.length);
}

/** Fisher–Yates shuffle of `arr` in place; returns `arr`. */
export function shuffleInPlace<T>(s: RngState, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = intBelow(s, i + 1);
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}

/** Seed for an independent stream (e.g. a CPU typist) derived from `seed`; distinct uint32 streams give distinct seeds. */
export function forkSeed(seed: number, stream: number): number {
  return mix32((seed >>> 0) ^ mix32(((stream >>> 0) + GOLDEN) >>> 0));
}

/** The nine uniforms for one shot, in draw order: rNet, then 4 for zx, then 4 for zy. */
export function drawShotRandoms(s: RngState): ShotRandoms {
  return [uniform(s), uniform(s), uniform(s), uniform(s), uniform(s), uniform(s), uniform(s), uniform(s), uniform(s)];
}
