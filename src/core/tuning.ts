import type { PaceId, Tier } from './types';

/** Pace multipliers (spec §3.9). */
export const PACE_MULT: Record<PaceId, number> = { relaxed: 1.5, normal: 1.0, fast: 0.75, lightning: 0.6 };

/**
 * All gameplay constants (spec §3). Balance targets: early-typing spec §4 with the result the user
 * accepted on 2026-09-28, for equal typist-model players at each pace's reference WPM (Relaxed 30,
 * Normal 50, Fast 70, Lightning 90). The full list and the measured values are in the header of
 * tests/sim/balance.test.ts; these constants meet all of them.
 */
export const TUNING = {
  serveClockMs: 30000,
  // Toss apex a = 1.93 s × pace (spec §3.2; the original draft's 2.0 s → 1.93 s, amended ac7c81b).
  // The toss window 2a decides the longest hard serve word that "fits" (spec §3.8 estimate), and a
  // word that only just fits is often dropped. At 2.0 s an 11-letter word just fit at Normal and
  // Fast, so double faults reached 6.3 % and 8.5 %; at 1.93 s each preset's reference typist fits
  // 10-letter words with room and no 11-letter ones (spec §6 balance simulation; numbers in
  // tests/sim/balance.test.ts).
  tossApexMs: 1930,
  catchMs: 500,
  contactFactorMin: 0.85,
  flight: {
    // Serves only (early-typing spec §3): T = pace·(baseMs + perCharMs·len)/v · place + the reading allowance.
    baseMs: 2200,
    perCharMs: 100,
    // Rally shots (early-typing spec §3): T = pace·rallyBaseMs/v · place[tier] · P(n), with no per-letter
    // term, since the receiver types the chase word early, during the striker's own typing. A harder
    // shot cuts the flight more (the attack). Tuned 2026-09-28 (probe start 4500 and 1 / 0.7 / 0.45 /
    // 0.3): a long easy ball leaves time to answer with a long word, and an attack strong enough to pay
    // for the out-of-court risk of a slip (at 0.45 for hard, always-easy beat the adaptive player 60 %
    // of points and aggression 0.8 lost to 0.2).
    rallyBaseMs: 7300,
    place: { easy: 1.0, medium: 0.45, hard: 0.22, insane: 0.19 } as Record<Tier, number>,
    // Insane serve flight place (power-meter spec §4.3): above place.hard so Fast/Lightning clean-insane
    // serve returns can reach 15–40 %; rally insane stays on place.insane (< hard). Balance sets the value.
    placeServeInsane: 0.75,
    // Rally pressure P(n) = max(pressureFloor, pressure^⌊n/2⌋) (early-typing spec §3; was 0.93 with a
    // 0.65 floor): with early typing and long rally flights, rallies end only because the ball keeps
    // speeding up until someone breaks, so there is no floor (a floor of 0.4–0.5 let rallies run past
    // 40 shots). 0.78 also keeps the top belts apart at Normal (0.79 let 12 v 14 fall to 75 % of short sets).
    pressure: 0.78,
    pressureFloor: 0,
    // Serve reading allowance 500 + 350·pace ms (early-typing spec §4 tuning; was 250 + 750·pace): with
    // rallies that favour the attacker, a smaller allowance at the slow paces keeps the server's share of
    // points at 55 % or more, and the larger fixed part softens Lightning, where the first attack decides.
    serveReturnBonusMs: 500,
    serveReturnBonusPaceMs: 350,
  },
  graceMs: 400,
  // Speed factor v = 0.875 + 0.025·(cps − 3) (spec §3.4; the original draft's 0.85 + 0.05·(cps − 3)
  // → 0.875 + 0.025·(cps − 3), amended ac7c81b; both give v ≈ 0.91 at 50 WPM). The gentler slope
  // kept Relaxed/30 WPM points ≤ 35 s (at the original pressure 0.85) and keeps Lightning/90 WPM
  // rallies at 3+ shots with the spec's pace multipliers (balance simulation, spec §6).
  speed: { base: 0.875, perCps: 0.025, cpsRef: 3, min: 0.8, max: 1.3, stretchMult: 0.9, minSpanS: 0.05 },
  // maxPressureBoost: displayed km/h divides by P(n), but never by less than 1/maxPressureBoost (P(n) has no floor now).
  kmh: { base: 95, tierBonus: { easy: 1.0, medium: 1.05, hard: 1.1, insane: 1.2 } as Record<Tier, number>, serveMult: 1.25, maxPressureBoost: 2 },
  // Insane (power-meter spec §4.3): σ0 0.04 m keeps a flawless insane shot 0.139 m < its 0.15 m margin inside the lines.
  accuracy: {
    sigma0: { easy: 0.10, medium: 0.12, hard: 0.10, insane: 0.04 } as Record<Tier, number>,
    sigmaE: { easy: 0.25, medium: 0.35, hard: 0.5, insane: 0.8 } as Record<Tier, number>,
    stretchSigma: 0.5,
    netRate: { easy: 0.01, medium: 0.03, hard: 0.06, insane: 0.10 } as Record<Tier, number>,
    stretchNet: 0.05,
    pNetMax: 0.9,
    maxSlips: 3,
  },
  trajectory: {
    bounceFrac: 0.6,
    arcH: { easy: 2.0, medium: 1.7, hard: 1.4, insane: 1.2 } as Record<Tier, number>,
    serveArcH: 0.9,
    netClearZ: 1.3,
    postBounceDist: 3.0,
    // Height of the contact point C (spec §3.4); a rally shot struck at C launches from there, so this
    // is also the spec's rally z0 = 1.0 m.
    contactZ: 1.0,
    maxBehindBaseline: 1.2,
    maxAbsX: 5.8,
    netHitZ: 0.6,
    netDropMs: 400,
    stretchEndZ: 0.3,
  },
  toss: { baseZ: 1.8, riseZ: 1.4 },
  leadIn: { introMs: 2500, faultMs: 1500, pointMs: 2000, gameExtraMs: 1500, setExtraMs: 1000, matchOverMs: 3000 },
  words: { historySize: 20 },
  // Power meter (power-meter spec §4.1): flawless serve/choice strikes fill it to `max`; a full meter offers the insane word.
  // tossMult: a full-meter serve only stretches the toss apex (power-meter spec §4.3); training / non-full keep tossApexMs.
  power: { max: 4, tossMult: 1.2 },
  // Typist model (early-typing spec §5): every CPU and both balance-simulation players. Each
  // [at 25 WPM, at 140 WPM] pair is linear in the label WPM between those two and held outside.
  // These are the agreed human estimates, not tuning knobs.
  typist: {
    wpmRange: [25, 140],
    err: [0.07, 0.04],
    /** Before a serve word (after the toss) and before choice words. */
    wordPauseMs: [950, 600],
    /** Before the chase word of a serve return (never seen before). */
    serveChasePauseMs: [600, 400],
    /** Before an early chase word, from the striker's lock (its word was already in their stack). */
    earlyPauseMs: [500, 300],
    /** After a wrong key, before the right letter: uniform in this range. */
    wrongPauseRangeMs: { min: 200, max: 400 },
  },
  movement: { chaseMaxSpeed: 7, jogSpeed: 4, stanceOffset: 0.7 },
  positions: { serverX: 0.8, serverY: 12.3, receiverX: 3.0, receiverY: 12.5, restY: 12.2 },
} as const;

/** CPU milestone rows (early-typing spec §5): each belt's WPM and aggression; stripes interpolate aggression linearly in WPM between rows. */
export const CPU_MILESTONES = [
  { belt: 'white', wpm: 25, aggression: 0.2 },
  { belt: 'yellow', wpm: 36, aggression: 0.35 },
  { belt: 'green', wpm: 52, aggression: 0.5 },
  { belt: 'brown', wpm: 76, aggression: 0.65 },
  { belt: 'black', wpm: 110, aggression: 0.8 },
  { belt: 'black2', wpm: 124, aggression: 0.85 },
  { belt: 'black3', wpm: 140, aggression: 0.9 },
] as const;

/** The 15 CPU levels' label WPM (index = level): about 13 % apart; what each level's Results screen shows (early-typing spec §5). */
export const CPU_LEVEL_WPM = [25, 28, 32, 36, 41, 46, 52, 59, 67, 76, 86, 97, 110, 124, 140] as const;

/**
 * The speed each level types at underneath (index = level): hesitations on hard words and error pauses
 * slow it to its label WPM. Calibrated 2026-09-28 by the balance simulation (40 short sets per level at
 * Normal, level against itself, until every level's average is within 1 % of its label); the honest-labels
 * check in tests/sim/balance.test.ts guards it.
 */
export const CPU_NOMINAL_WPM = [26, 30, 34, 39, 46, 52, 61, 72, 85, 101, 119, 142, 173, 211, 264] as const;
