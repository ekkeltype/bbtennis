import type { PaceId, Tier } from './types';

/** Pace multipliers (spec §3.9). */
export const PACE_MULT: Record<PaceId, number> = { relaxed: 1.5, normal: 1.0, fast: 0.75, lightning: 0.6 };

/**
 * All gameplay constants (spec §3). Balance targets (spec §6), for equal players at each pace's
 * reference WPM (Relaxed 30, Normal 50, Fast 70, Lightning 90): median rally 3–6 shots, p90 ≤ 12,
 * max 40; aces 5–15 %; double faults 1–6 %; server wins 55–65 %; ≤ 35 s per point.
 */
export const TUNING = {
  serveClockMs: 30000,
  tossApexMs: 2000,
  catchMs: 500,
  contactFactorMin: 0.85,
  flight: {
    baseMs: 2200,
    perCharMs: 100,
    place: { easy: 1.0, medium: 0.85, hard: 0.7 } as Record<Tier, number>,
    pressure: 0.85,
    serveReturnBonusMs: 500,
    serveReturnBonusPaceMs: 500,
  },
  graceMs: 400,
  speed: { base: 0.85, perCps: 0.05, cpsRef: 3, min: 0.8, max: 1.3, stretchMult: 0.9, minSpanS: 0.05 },
  kmh: { base: 95, tierBonus: { easy: 1.0, medium: 1.05, hard: 1.1 } as Record<Tier, number>, serveMult: 1.25 },
  accuracy: {
    sigma0: { easy: 0.10, medium: 0.12, hard: 0.10 } as Record<Tier, number>,
    sigmaE: { easy: 0.25, medium: 0.35, hard: 0.5 } as Record<Tier, number>,
    stretchSigma: 0.5,
    netRate: { easy: 0.01, medium: 0.03, hard: 0.06 } as Record<Tier, number>,
    stretchNet: 0.05,
    pNetMax: 0.9,
    maxSlips: 3,
  },
  trajectory: {
    bounceFrac: 0.6,
    arcH: { easy: 2.0, medium: 1.7, hard: 1.4 } as Record<Tier, number>,
    serveArcH: 0.9,
    netClearZ: 1.3,
    postBounceDist: 3.0,
    contactZ: 1.0,
    rallyZ0: 1.0,
    maxBehindBaseline: 1.2,
    maxAbsX: 5.8,
    netHitZ: 0.6,
    netDropMs: 400,
    stretchEndZ: 0.3,
  },
  toss: { baseZ: 1.8, riseZ: 1.4 },
  leadIn: { introMs: 2500, faultMs: 1500, pointMs: 2000, gameExtraMs: 1500, setExtraMs: 1000, matchOverMs: 3000 },
  words: { historySize: 20 },
  movement: { chaseMaxSpeed: 7, jogSpeed: 4, stanceOffset: 0.7 },
  positions: { serverX: 0.8, serverY: 12.3, receiverX: 3.0, receiverY: 12.5, restY: 12.2 },
} as const;

/** CPU milestone rows (spec §3.8); stripes interpolate linearly in WPM between rows. */
export const CPU_MILESTONES = [
  { belt: 'white', wpm: 25, err: 0.07, reactionMs: 900, aggression: 0.2 },
  { belt: 'yellow', wpm: 35, err: 0.055, reactionMs: 800, aggression: 0.35 },
  { belt: 'green', wpm: 45, err: 0.045, reactionMs: 700, aggression: 0.5 },
  { belt: 'brown', wpm: 65, err: 0.03, reactionMs: 550, aggression: 0.65 },
  { belt: 'black', wpm: 90, err: 0.02, reactionMs: 450, aggression: 0.8 },
  { belt: 'black2', wpm: 105, err: 0.016, reactionMs: 400, aggression: 0.85 },
  { belt: 'black3', wpm: 120, err: 0.013, reactionMs: 350, aggression: 0.9 },
] as const;

/** The 15 CPU levels' WPM (index = level). */
export const CPU_LEVEL_WPM = [25, 28, 31, 35, 38, 41, 45, 51, 58, 65, 72, 81, 90, 105, 120] as const;
