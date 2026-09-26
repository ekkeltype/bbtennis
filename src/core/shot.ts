import { normalFromUniforms } from './rng';
import { TUNING } from './tuning';
import type { ShotOutcome, ShotRandoms, ShotResult, Tier, Vec2 } from './types';
import { clamp, lerp } from './util';

/** pressure^⌊n/2⌋ by repeated multiplication (not Math.pow), so every JS engine gets identical bits. */
function pressureFactor(n: number): number {
  const steps = Math.floor(n / 2);
  let f = 1;
  for (let i = 0; i < steps; i++) f *= TUNING.flight.pressure;
  return f;
}

/** Speed factor for a word typed at `cps`: clamp(0.85 + 0.05·(cps − 3), 0.80, 1.30) (spec §3.4). */
export function speedFactor(cps: number): number {
  const { base, perCps, cpsRef, min, max } = TUNING.speed;
  return clamp(base + perCps * (cps - cpsRef), min, max);
}

/** Serve contact factor: 1 up to the toss apex `a`, then linearly down to 0.85 at 2a and no lower (spec §3.2.4). */
export function contactFactor(tSinceToss: number, apexMs: number): number {
  return lerp(1, TUNING.contactFactorMin, clamp((tSinceToss - apexMs) / apexMs, 0, 1));
}

/** Strike speed v: the clamped speed factor × serve contact factor × 0.9 for a stretch, not re-clamped (spec §3.4). */
export function strikeV(cps: number, opts: { contactFactor?: number; stretch?: boolean }): number {
  const stretchMult = opts.stretch ? TUNING.speed.stretchMult : 1;
  return speedFactor(cps) * (opts.contactFactor ?? 1) * stretchMult;
}

/**
 * Flight time T (ms) from a strike to the receiver's contact point (spec §3.4). `chaseLen` is the
 * struck word's length; `n` is the number of rally strikes after the serve before this one.
 */
export function flightTimeMs(a: {
  pace: number;
  chaseLen: number;
  v: number;
  tier: Tier;
  isServe: boolean;
  n: number;
}): number {
  const f = TUNING.flight;
  const place = a.isServe ? 1 : f.place[a.tier];
  const readingAllowance = a.isServe ? f.serveReturnBonusMs + f.serveReturnBonusPaceMs * a.pace : 0;
  return ((a.pace * (f.baseMs + f.perCharMs * a.chaseLen)) / a.v) * place * pressureFactor(a.n) + readingAllowance;
}

/** Stretch-shot window after T: 400 ms × pace (spec §3.4). */
export function graceMs(pace: number): number {
  return TUNING.graceMs * pace;
}

/** Displayed ball speed in whole km/h (flavour only, spec §3.4); the serve ×1.25 is applied before rounding. */
export function displayKmh(v: number, tier: Tier, n: number, isServe: boolean): number {
  const k = TUNING.kmh;
  const serveMult = isServe ? k.serveMult : 1;
  return Math.round((k.base * v * k.tierBonus[tier] * serveMult) / pressureFactor(n));
}

/** Slips on the shot word that count toward accuracy: min(slips, 3) (spec §3.5). */
export function effectiveSlips(slips: number): number {
  return Math.min(slips, TUNING.accuracy.maxSlips);
}

/**
 * Resolves a shot at the strike instant (spec §3.5): NET when `randoms[0] < pNet`, otherwise the
 * landing is `target + σ·(zx, zy)` (zx from `randoms[1..4]`, zy from `randoms[5..8]`) and is IN
 * when `isIn(landing)` — the caller's court predicate, which must count the lines as in.
 * A NET result still carries the landing the ball would have had.
 */
export function resolveShot(a: {
  tier: Tier;
  slips: number;
  stretch: boolean;
  target: Vec2;
  randoms: ShotRandoms;
  isIn: (p: Vec2) => boolean;
}): ShotResult {
  const acc = TUNING.accuracy;
  const e = effectiveSlips(a.slips);
  const pNet = Math.min(acc.pNetMax, acc.netRate[a.tier] * e + (a.stretch ? acc.stretchNet : 0));
  const sigma = acc.sigma0[a.tier] + acc.sigmaE[a.tier] * e + (a.stretch ? acc.stretchSigma : 0);
  const zx = normalFromUniforms(a.randoms.slice(1, 5));
  const zy = normalFromUniforms(a.randoms.slice(5, 9));
  const landing = { x: a.target.x + sigma * zx, y: a.target.y + sigma * zy };
  const outcome: ShotOutcome = a.randoms[0] < pNet ? 'net' : a.isIn(landing) ? 'in' : 'out';
  return { outcome, landing, sigma, pNet };
}
