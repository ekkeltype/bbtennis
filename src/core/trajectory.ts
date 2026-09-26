import { COURT, endSign } from './court';
import { TUNING } from './tuning';
import type { BallFlight, PlayerId, ShotOutcome, Tier, Vec2, Vec3 } from './types';
import { add2, clamp, easeOutQuad, lerp, norm2, scale2, sub2 } from './util';

const TR = TUNING.trajectory;

/** Mid-bounce hump of the post-bounce height curve `u·contactZ + 2.4·u·(1 − u)` (spec §3.4). */
const POST_BOUNCE_HUMP = 2.4;

/** How far a NET ball rebounds back toward the striker while it drops (spec §3.4). */
const NET_REBOUND_M = 0.3;

/** `t / span` clamped to [0, 1]; an empty span counts as already complete. */
const frac = (t: number, span: number): number => (span > 0 ? clamp(t / span, 0, 1) : 1);

/** Pre-bounce height at path fraction `u` (spec §3.4). */
const arcZ = (z0: number, h: number, u: number): number => z0 * (1 - u) + 4 * h * u * (1 - u);

/** The arc parameter h that puts the pre-bounce arc at height `z` at path fraction `u` ∈ (0, 1). */
const arcHThrough = (z0: number, u: number, z: number): number => (z - z0 * (1 - u)) / (4 * u * (1 - u));

/** Fraction of the straight path p0 → landing at which it crosses the net plane y = 0, or null. */
function netCrossFrac(p0: Vec3, landing: Vec2): number | null {
  if (p0.y * landing.y >= 0) return null;
  const u = p0.y / (p0.y - landing.y);
  return u > 0 && u < 1 ? u : null;
}

/**
 * Analytic flight of a struck ball (spec §3.4): arc to `landing` over bounceFrac·T, then 3 m on
 * to the contact point C by T. Non-NET arcs are raised to clear netClearZ at the net plane; a NET
 * arc is shaped to meet the net plane at netHitZ. `callT` is when an OUT/NET call is made.
 */
export function buildFlight(a: {
  isServe: boolean;
  tier: Tier;
  p0: Vec3;
  landing: Vec2;
  outcome: ShotOutcome;
  T: number;
  grace: number;
  destEnd: PlayerId;
}): BallFlight {
  const { isServe, tier, p0, landing, outcome, T, grace, destEnd } = a;
  const tBounce = TR.bounceFrac * T;
  const u = netCrossFrac(p0, landing);

  let h: number = isServe ? TR.serveArcH : TR.arcH[tier];
  if (u !== null && outcome === 'net') h = arcHThrough(p0.z, u, TR.netHitZ);
  else if (u !== null) h = Math.max(h, arcHThrough(p0.z, u, TR.netClearZ));

  const reach = add2(landing, scale2(norm2(sub2(landing, p0)), TR.postBounceDist));
  const maxY = COURT.halfLength + TR.maxBehindBaseline;
  const contact = { x: clamp(reach.x, -TR.maxAbsX, TR.maxAbsX), y: clamp(reach.y, -maxY, maxY) };

  // A NET ball must always be called; one whose path never crosses the net plane is called at the bounce.
  const netT = u !== null ? u * tBounce : outcome === 'net' ? tBounce : null;
  const callT = outcome === 'net' ? netT : outcome === 'out' ? tBounce : null;

  return {
    isServe,
    tier,
    p0: { x: p0.x, y: p0.y, z: p0.z },
    landing: { x: landing.x, y: landing.y },
    outcome,
    T,
    tBounce,
    grace,
    h,
    contact,
    netT,
    callT,
    destEnd,
  };
}

function preBounce(f: BallFlight, t: number): Vec3 {
  const u = frac(t, f.tBounce);
  return { x: lerp(f.p0.x, f.landing.x, u), y: lerp(f.p0.y, f.landing.y, u), z: arcZ(f.p0.z, f.h, u) };
}

function postBounce(f: BallFlight, t: number): Vec3 {
  const u = frac(t - f.tBounce, f.T - f.tBounce);
  return {
    x: lerp(f.landing.x, f.contact.x, u),
    y: lerp(f.landing.y, f.contact.y, u),
    z: u * TR.contactZ + POST_BOUNCE_HUMP * u * (1 - u),
  };
}

/** Past C: same horizontal velocity; z falls linearly contactZ → stretchEndZ over grace, then to the ground. */
function pastContact(f: BallFlight, dt: number): Vec3 {
  const span = f.T - f.tBounce;
  const v = span > 0 ? scale2(sub2(f.contact, f.landing), 1 / span) : { x: 0, y: 0 };
  const z = lerp(TR.contactZ, TR.stretchEndZ, f.grace > 0 ? dt / f.grace : 1);
  return { x: f.contact.x + v.x * dt, y: f.contact.y + v.y * dt, z: Math.max(0, z) };
}

/** A NET ball after reaching the net plane: drops to the ground over netDropMs, moving back toward the striker. */
function netDrop(f: BallFlight, netT: number, dt: number): Vec3 {
  const atNet = preBounce(f, netT);
  const k = frac(dt, TR.netDropMs);
  const back = scale2(norm2(sub2(f.p0, f.landing)), NET_REBOUND_M * k);
  return { x: atNet.x + back.x, y: atNet.y + back.y, z: atNet.z * (1 - k) };
}

/**
 * Ball position `t` ms after the strike. Valid for 0..T + grace (and through the drop of a NET
 * ball); earlier times give p0, later times keep the ball moving and never below the ground.
 */
export function ballAt(f: BallFlight, t: number): Vec3 {
  const time = Math.max(0, t);
  if (f.outcome === 'net' && f.netT !== null && time >= f.netT) return netDrop(f, f.netT, time - f.netT);
  if (time <= f.tBounce) return preBounce(f, time);
  if (time <= f.T) return postBounce(f, time);
  return pastContact(f, time - f.T);
}

/**
 * Height of a tossed ball `tSinceToss` ms after the toss (spec §3.2.3): 1.8 m in hand, 3.2 m at the
 * apex `apexMs`, back to 1.8 m at 2·apexMs; an uncaught ball keeps falling to the ground.
 */
export function tossZ(tSinceToss: number, apexMs: number): number {
  const x = (Math.max(0, tSinceToss) - apexMs) / apexMs;
  return Math.max(0, TUNING.toss.baseZ + TUNING.toss.riseZ * (1 - x * x));
}

/**
 * Stroke and stance for meeting the ball at `contact` (spec §3.4): forehand if contact is to the
 * player's right of `from` (their position at CHASE start); feet 0.7 m beside the contact point,
 * kept within |x| ≤ maxAbsX (spec §3.0).
 */
export function stanceFor(contact: Vec2, player: PlayerId, from: Vec2): { feet: Vec2; forehand: boolean } {
  const right = endSign(player);
  const forehand = right * (contact.x - from.x) > 0;
  const offset = (forehand ? -right : right) * TUNING.movement.stanceOffset;
  return { feet: { x: clamp(contact.x + offset, -TR.maxAbsX, TR.maxAbsX), y: contact.y }, forehand };
}

/** Chase target for the feet at typing `progress` ∈ [0, 1]: eased-out from `from` to `stance` (spec §3.3.2). */
export function chaseFeet(from: Vec2, stance: Vec2, progress: number): Vec2 {
  const k = easeOutQuad(clamp(progress, 0, 1));
  return { x: lerp(from.x, stance.x, k), y: lerp(from.y, stance.y, k) };
}
