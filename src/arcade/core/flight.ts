import { COURT, endSign, netHeightAt } from '../../core/court';
import { ARCADE } from './tuning';
import type { ShotPhysics } from './tuning';
import type { Flight, FlightBounce, FlightSegment, HitEvent, PlayerId, ShotType, Side, Vec2, Vec3 } from './types';

/** Longest the ball keeps being drawn after the rules consider it dead. */
const EXTRA_DRAW = 3;

/** Physics of a shot type (ARCADE.shots[type]). */
export function physicsOf(type: ShotType): ShotPhysics {
  return ARCADE.shots[type];
}

function vzAt0(z0: number, k: number, T: number): number {
  return -z0 / T + 0.5 * ARCADE.g * k * T;
}

/** Initial vertical speed and apex of an arc from height z0 that lands (z = 0) after T s with gravity g·k. */
export function arcApex(z0: number, k: number, T: number): number {
  const vz = vzAt0(z0, k, T);
  return vz > 0 ? z0 + (vz * vz) / (2 * ARCADE.g * k) : z0;
}

/** The largest T' ≤ T whose apex is ≤ ARCADE.maxApex (T shrinks by 2 % steps, at most 60). */
export function clampTForApex(z0: number, k: number, T: number): number {
  let t = T;
  for (let i = 0; i < 60 && arcApex(z0, k, t) > ARCADE.maxApex; i++) t *= 0.98;
  return t;
}

/** True when a ground point is in `receiver`'s singles half, lines in, the ball radius added. */
export function inCourtFor(p: Vec2, receiver: PlayerId): boolean {
  const r = ARCADE.ballRadius;
  const depth = -endSign(receiver) * p.y;
  return Math.abs(p.x) <= COURT.singlesHalfWidth + r && depth >= -r && depth <= COURT.halfLength + r;
}

/** True when a ground point is in `receiver`'s service box for a serve from `side`, lines in, the ball radius added. */
export function inBoxFor(p: Vec2, receiver: PlayerId, side: Side): boolean {
  const r = ARCADE.ballRadius;
  const s = endSign(receiver);
  const a = s * (side === 'deuce' ? 1 : -1) * p.x;
  const b = -s * p.y;
  return a >= -r && a <= COURT.singlesHalfWidth + r && b >= -r && b <= COURT.serviceLine + r;
}

/** Seconds until a straight horizontal motion from `p` with velocity `v` first reaches the surround edge. */
function surroundExit(p: Vec3, v: Vec3): number {
  const lim = (pos: number, vel: number, max: number): number => (vel > 0 ? (max - pos) / vel : vel < 0 ? (-max - pos) / vel : Infinity);
  return Math.max(0, Math.min(lim(p.x, v.x, ARCADE.surround.maxAbsX), lim(p.y, v.y, ARCADE.surround.maxAbsY)));
}

function segmentAt(f: Flight, t: number): FlightSegment {
  let seg = f.segments[0]!;
  for (const s of f.segments) if (s.t0 <= t) seg = s;
  return seg;
}

function clampT(f: Flight, t: number): number {
  return Math.min(Math.max(t, 0), f.tGone);
}

/**
 * No real flight lasts this long (s): the longest end within about 5 s. Scans over a flight's ticks
 * stop here whatever state they are given, so a state from elsewhere cannot make them run on (online
 * spec §3.6).
 */
export const MAX_FLIGHT_S = 10;

/** Seconds a scan over `f`'s ticks covers: until the ball is dead (tEnd), and at most MAX_FLIGHT_S. */
export function scanEnd(f: Flight): number {
  return Math.min(f.tEnd, MAX_FLIGHT_S);
}

/** Ball position `t` s after the hit; t is clamped to [0, tGone]. */
export function flightPos(f: Flight, t: number): Vec3 {
  const c = clampT(f, t);
  const s = segmentAt(f, c);
  const d = c - s.t0;
  return {
    x: s.p0.x + s.v0.x * d + 0.5 * s.a.x * d * d,
    y: s.p0.y + s.v0.y * d + 0.5 * s.a.y * d * d,
    z: s.p0.z + s.v0.z * d + 0.5 * s.a.z * d * d,
  };
}

/** Ball velocity `t` s after the hit (the segment's v0 + a·(t − t0)). */
export function flightVel(f: Flight, t: number): Vec3 {
  const c = clampT(f, t);
  const s = segmentAt(f, c);
  const d = c - s.t0;
  return { x: s.v0.x + s.a.x * d, y: s.v0.y + s.a.y * d, z: s.v0.z + s.a.z * d };
}

/** Builds the flight of `hit` (spec §4.6). Pure: same HitEvent → identical Flight. */
export function buildFlight(hit: HitEvent): Flight {
  const { g } = ARCADE;
  const ph = physicsOf(hit.type);
  const p0 = hit.contact;
  const L = hit.target;
  const T = hit.T;
  const ax = hit.type === 'serveSlice' ? ARCADE.serveSliceCurve * (L.x < 0 ? -1 : 1) : 0;
  const seg0: FlightSegment = {
    t0: 0,
    p0: { x: p0.x, y: p0.y, z: p0.z },
    v0: { x: (L.x - p0.x) / T - 0.5 * ax * T, y: (L.y - p0.y) / T, z: vzAt0(p0.z, ph.k, T) },
    a: { x: ax, y: 0, z: -g * ph.k },
  };
  const segments: FlightSegment[] = [seg0];
  const bounces: FlightBounce[] = [];
  const grav = { x: 0, y: 0, z: -g };

  let netT: number | null = null;
  if (p0.y * L.y < 0) {
    netT = -p0.y / seg0.v0.y;
    const x = p0.x + seg0.v0.x * netT + 0.5 * ax * netT * netT;
    const z = p0.z + seg0.v0.z * netT + 0.5 * seg0.a.z * netT * netT;
    if (z < netHeightAt(x) + ARCADE.ballRadius) {
      const zn = Math.max(0, z);
      const vx = seg0.v0.x + ax * netT;
      segments.push({
        t0: netT,
        p0: { x, y: 0, z: zn },
        v0: { x: ARCADE.netDrop.keepX * vx, y: -ARCADE.netDrop.backY * seg0.v0.y, z: 0 },
        a: grav,
      });
      const tEnd = netT + Math.sqrt((2 * zn) / g);
      return { hit, segments, bounces, netT, net: true, tEnd, tGone: tEnd };
    }
  }

  // Landing at T, then ground-bounce segments.
  let t0 = T;
  let at: Vec3 = { x: L.x, y: L.y, z: 0 };
  let inV = { x: seg0.v0.x + ax * T, y: seg0.v0.y, z: seg0.v0.z + seg0.a.z * T };
  let tEnd = 0;
  let tGone = 0;
  const total = 1 + ARCADE.laterBounce.max;
  for (let i = 1; i <= total; i++) {
    const pp = i === 1 ? ph : ARCADE.laterBounce;
    bounces.push({ t: t0, at: { x: at.x, y: at.y } });
    const v0 = { x: pp.keep * inV.x, y: pp.keep * inV.y, z: -pp.rest * inV.z };
    segments.push({ t0, p0: at, v0, a: grav });
    const bounceT = t0 + (2 * v0.z) / g;
    const exitT = t0 + surroundExit(at, v0);
    const left = exitT <= bounceT;
    const end = left ? exitT : bounceT;
    if (i === 1) tEnd = end;
    tGone = end;
    if (left) break;
    if (i < total) {
      at = { x: at.x + v0.x * (bounceT - t0), y: at.y + v0.y * (bounceT - t0), z: 0 };
      inV = { x: v0.x, y: v0.y, z: v0.z - g * (bounceT - t0) };
      t0 = bounceT;
    }
  }
  return { hit, segments, bounces, netT, net: false, tEnd, tGone: Math.min(tGone, tEnd + EXTRA_DRAW) };
}
