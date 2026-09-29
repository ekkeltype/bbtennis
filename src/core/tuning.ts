import type { PaceId, Tier } from './types';

/** Pace multipliers (spec §3.9). */
export const PACE_MULT: Record<PaceId, number> = { relaxed: 1.5, normal: 1.0, fast: 0.75, lightning: 0.6 };

/**
 * All gameplay constants (spec §3). Balance targets (spec §6 as amended in ac7c81b, rulings R35/R36,
 * and by the power-meter spec of 2026-09-27), for equal players at each pace's reference WPM
 * (Relaxed 30, Normal 50, Fast 70, Lightning 90): median rally Relaxed 10–14, Normal 7–11, Fast 4–7,
 * Lightning 3–5 shots (the measured result, accepted by the user), p90 ≤ 22, max 60; aces ≤ 15 %
 * (no lower bound); double faults 1–8 %; server wins 55–65 %; ≤ 65 s per point; clean insane shots
 * returned 15–40 %; never-insane wins 40–51 %. These constants meet all of them (measured values:
 * tests/sim/balance.test.ts).
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
    baseMs: 2200,
    perCharMs: 100,
    place: { easy: 1.0, medium: 0.85, hard: 0.7, insane: 0.55 } as Record<Tier, number>,
    // Insane serve flight place (power-meter spec §4.3): above place.hard so Fast/Lightning clean-insane
    // serve returns can reach 15–40 %; rally insane stays on place.insane (< hard). Balance sets the value.
    placeServeInsane: 0.75,
    // Rally pressure P(n) = max(pressureFloor, pressure^⌊n/2⌋) (power-meter spec §2; was 0.85 with no
    // floor): a gentler speed-up with a floor, so rallies run longer and hard words stay playable deep
    // into a rally. Final values: balance simulation (tests/sim/balance.test.ts).
    pressure: 0.93,
    pressureFloor: 0.65,
    // Serve reading allowance 250 + 750·pace ms (spec §3.4; the original draft's 500 + 500·pace →
    // 250 + 750·pace, amended ac7c81b; the same 1 s at Normal): keeps the server's share of points
    // near 60 % at every preset (balance simulation, spec §6).
    serveReturnBonusMs: 250,
    serveReturnBonusPaceMs: 750,
  },
  graceMs: 400,
  // Speed factor v = 0.875 + 0.025·(cps − 3) (spec §3.4; the original draft's 0.85 + 0.05·(cps − 3)
  // → 0.875 + 0.025·(cps − 3), amended ac7c81b; both give v ≈ 0.91 at 50 WPM). The gentler slope
  // kept Relaxed/30 WPM points ≤ 35 s (at the original pressure 0.85) and keeps Lightning/90 WPM
  // rallies at 3+ shots with the spec's pace multipliers (balance simulation, spec §6).
  speed: { base: 0.875, perCps: 0.025, cpsRef: 3, min: 0.8, max: 1.3, stretchMult: 0.9, minSpanS: 0.05 },
  kmh: { base: 95, tierBonus: { easy: 1.0, medium: 1.05, hard: 1.1, insane: 1.2 } as Record<Tier, number>, serveMult: 1.25 },
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
