import { TUNING } from './tuning';
import type { PlayerId, Side, Vec2 } from './types';

/** Court dimensions in metres (spec §3.0); origin at the net centre, y along the court. */
export const COURT = {
  singlesHalfWidth: 4.115,
  doublesHalfWidth: 5.485,
  halfLength: 11.885,
  serviceLine: 6.4,
  netCenterH: 0.914,
  netPostH: 1.07,
  postX: 6.4,
} as const;

/** Box coordinates (a, b) of the serve targets (spec §3.2.6). */
const SERVE_EASY = { a: 2.06, b: 4.2 };
const SERVE_HARD = { T: { a: 0.4, b: 6.0 }, wide: { a: 3.715, b: 6.0 } };
const SERVE_MEDIUM = { T: { a: 3.115, b: 5.4 }, wide: { a: 1.0, b: 5.4 } };

/** Half coordinates (a, b) of the rally targets for m = +1 (spec §3.3.3). */
const RALLY_EASY = { a: 0, b: 8.885 };
const RALLY_MEDIUM = { a: 2.865, b: 9.385 };
const RALLY_HARD = { a: -3.615, b: 11.385 };

/** Court sign of an end (spec §3.0): end 0 → +1, end 1 → −1. */
export function endSign(end: PlayerId): 1 | -1 {
  return end === 0 ? 1 : -1;
}

const sideSign = (side: Side): 1 | -1 => (side === 'deuce' ? 1 : -1);

const noNegZero = (v: number): number => (v === 0 ? 0 : v);

/** World point on end `s`'s half at lateral offset `a` (world x = aSign·a) and distance `b` from the net. */
function halfPoint(s: number, aSign: number, a: number, b: number): Vec2 {
  return { x: noNegZero(aSign * a), y: noNegZero(-s * b) };
}

/** Where `server` stands to serve from `side` (spec §3.0). */
export function serverSpot(server: PlayerId, side: Side): Vec2 {
  const s = endSign(server);
  return { x: sideSign(side) * s * TUNING.positions.serverX, y: -s * TUNING.positions.serverY };
}

/** Where `receiver` stands to receive a serve from `side` (the server's side, spec §3.0). */
export function receiverSpot(receiver: PlayerId, side: Side): Vec2 {
  const s = endSign(receiver);
  return { x: sideSign(side) * s * TUNING.positions.receiverX, y: -s * TUNING.positions.receiverY };
}

/** The centre spot behind `player`'s baseline that a striker jogs back to (spec §3.4). */
export function restSpot(player: PlayerId): Vec2 {
  return { x: 0, y: -endSign(player) * TUNING.positions.restY };
}

/** Serve targets [easy, medium, hard] in `receiver`'s diagonal box for `side` (spec §3.2.6). */
export function serveTargets(receiver: PlayerId, side: Side, variant: 'T' | 'wide'): Vec2[] {
  const s = endSign(receiver);
  const aSign = s * sideSign(side);
  const boxPoints = [SERVE_EASY, SERVE_MEDIUM[variant], SERVE_HARD[variant]];
  return boxPoints.map(({ a, b }) => halfPoint(s, aSign, a, b));
}

/** Rally targets [easy, medium, hard] on `dest`'s half; `m` picks medium's side (spec §3.3.3). */
export function rallyTargets(dest: PlayerId, m: 1 | -1): Vec2[] {
  const s = endSign(dest);
  return [RALLY_EASY, RALLY_MEDIUM, RALLY_HARD].map(({ a, b }) => halfPoint(s, s, m * a, b));
}

/** True if `p` lies in `dest`'s singles half, lines included. */
export function inSinglesHalf(p: Vec2, dest: PlayerId): boolean {
  const depth = -endSign(dest) * p.y;
  return Math.abs(p.x) <= COURT.singlesHalfWidth && depth >= 0 && depth <= COURT.halfLength;
}

/** True if `p` lies in `receiver`'s service box for a serve from `side`, lines included. */
export function inServiceBox(p: Vec2, receiver: PlayerId, side: Side): boolean {
  const s = endSign(receiver);
  const a = s * sideSign(side) * p.x;
  const b = -s * p.y;
  return a >= 0 && a <= COURT.singlesHalfWidth && b >= 0 && b <= COURT.serviceLine;
}

/** Net height at lateral position `x`: linear from the centre strap to the posts, flat beyond. */
export function netHeightAt(x: number): number {
  const k = Math.min(Math.abs(x), COURT.postX) / COURT.postX;
  return COURT.netCenterH + (COURT.netPostH - COURT.netCenterH) * k;
}
