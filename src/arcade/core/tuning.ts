import type { ShotType } from './types';
import type { PaceId } from '../../core/types';

/** Simulation ticks per second. */
export const TICK_HZ = 60;
/** Seconds per tick. */
export const DT = 1 / TICK_HZ;

/** Physics and feel of one shot type (spec §4.6, §4.8): base ground speed, gravity factor, bounce. */
export interface ShotPhysics { speed: number; k: number; keep: number; rest: number }

/** Every tuning number of the Arcade rules (spec §4–§5), in seconds, metres and m/s. */
export const ARCADE = {
  g: 9.81,
  ballRadius: 0.033,
  move: { topSpeed: 6.0, accelTime: 0.15, stopTime: 0.1, chargeSpeedMult: 0.6, walkSpeed: 4.0, netGap: 0.4, maxBehind: 2.0, maxAbsX: 6.5, setupCentreGap: 0.3 },
  swing: { chargeTime: 0.5, rushedTime: 0.15, perfectWindow: 0.12, stretchDist: 1.0 },
  reach: { radius: 1.4, minZ: 0.15, maxZ: 2.7, smashZ: 2.0, smashMaxNetDist: 8.0 },
  grade: {
    perfect: { power: 1.1, margin: 0.5, scatter: 0.6 },
    clean: { powerBase: 0.8, powerPerCharge: 0.2, margin: 1.0, scatter: 1.0 },
    rushed: { power: 0.75, margin: 1.0, scatter: 1.8, pull: 0.5 },
  },
  stretch: { power: 0.85, scatter: 1.4 },
  aim: { neutralFromBaseline: 2.5, shortBeforeServiceLine: 1.0, pullFromBaseline: 3.5, lobExtraMargin: 0.5, smashMargin: 0.8, minDepth: 0.5 },
  shots: {
    topspin: { speed: 22, k: 1.45, keep: 0.78, rest: 0.72 },
    slice: { speed: 17, k: 0.8, keep: 0.62, rest: 0.48 },
    lob: { speed: 12, k: 1.0, keep: 0.7, rest: 0.65 },
    smash: { speed: 30, k: 1.3, keep: 0.75, rest: 0.7 },
    serveFlat: { speed: 40, k: 1.1, keep: 0.8, rest: 0.62 },
    serveSlice: { speed: 34, k: 1.0, keep: 0.72, rest: 0.5 },
    serveKick: { speed: 27, k: 1.6, keep: 0.7, rest: 0.85 },
  } satisfies Record<ShotType, ShotPhysics>,
  lobMinT: 2.0,
  minT: 0.25,
  serveMargin: { serveFlat: 0.25, serveSlice: 0.45, serveKick: 0.6 },
  serveSliceCurve: 3.0,
  serveGrade: {
    perfect: { power: 1.1, scatter: 0.6 },
    clean: { power: 0.95, scatter: 1.0 },
    rushed: { power: 0.75, scatter: 1.8, pull: 0.5 },
  },
  laterBounce: { keep: 0.8, rest: 0.6, max: 2 },
  netDrop: { keepX: 0.1, backY: 0.15 },
  maxApex: 9.0,
  surround: { maxAbsX: 9.0, maxAbsY: 18.0 },
  scatter: { sigma: 0.35, incomingRef: 30, incomingWeight: 0.5, tSigma: 0.1 },
  pace: { relaxed: 0.75, normal: 1.0, fast: 1.15, lightning: 1.3 } satisfies Record<PaceId, number>,
  serve: { handZ: 1.8, apexZ: 3.2, apexTime: 0.65, perfectAfterApex: 0.12, cleanBeforeApex: 0.2, cleanAfterApex: 0.35, dropZ: 1.4, clock: 25, behindBaseline: 0.3, startX: 0.8 },
  receive: { x: 2.6, behindBaseline: 0.5 },
  flow: { intro: 2.0, call: 1.2, score: 1.6, gameBanner: 2.0, faultPause: 1.2, overHold: 3.0 },
} as const;

/** CPU milestone rows (spec §5): level index → profile; levels between rows interpolate linearly. */
export const ARCADE_CPU_MILESTONES = [
  { level: 0, reaction: 0.42, readError: 1.2, speed: 0.78, pressSigma: 0.16, aggression: 0.15 },
  { level: 3, reaction: 0.34, readError: 0.9, speed: 0.84, pressSigma: 0.12, aggression: 0.3 },
  { level: 6, reaction: 0.26, readError: 0.6, speed: 0.9, pressSigma: 0.085, aggression: 0.45 },
  { level: 9, reaction: 0.19, readError: 0.35, speed: 0.95, pressSigma: 0.055, aggression: 0.6 },
  { level: 12, reaction: 0.14, readError: 0.2, speed: 1.0, pressSigma: 0.035, aggression: 0.75 },
  { level: 14, reaction: 0.1, readError: 0.1, speed: 1.0, pressSigma: 0.02, aggression: 0.85 },
] as const;
