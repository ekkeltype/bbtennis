import { COURT, endSign } from '../../core/court';
import { normalIH } from '../../core/rng';
import type { PaceId, RngState } from '../../core/types';
import { clampTForApex, physicsOf } from './flight';
import { ARCADE, DT } from './tuning';
import type { Flight, Grade, HitEvent, PlayerId, ShotType, Side, Vec2, Vec3 } from './types';

/** Slack for tick-boundary comparisons that float rounding would otherwise break (seconds). */
const EPS = 1e-9;

type Axis = -1 | 0 | 1;

const sideSign = (side: Side): 1 | -1 => (side === 'deuce' ? 1 : -1);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const noNegZero = (v: number): number => (v === 0 ? 0 : v);

function isServe(type: ShotType): type is 'serveFlat' | 'serveSlice' | 'serveKick' {
  return type === 'serveFlat' || type === 'serveSlice' || type === 'serveKick';
}

/** Rally timing grade from commit and contact ticks (spec §4.3). */
export function rallyGrade(commitTick: number, contactTick: number): Grade {
  const t = (contactTick - commitTick) * DT;
  const { chargeTime, rushedTime, perfectWindow } = ARCADE.swing;
  if (t < rushedTime - EPS) return 'rushed';
  if (t >= chargeTime - EPS && t <= chargeTime + perfectWindow + EPS) return 'perfect';
  return 'clean';
}

/** Charge 0..1 at contact. */
export function chargeAt(commitTick: number, contactTick: number): number {
  return Math.max(0, Math.min(1, ((contactTick - commitTick) * DT) / ARCADE.swing.chargeTime));
}

function apexSeconds(pace: PaceId): number {
  return ARCADE.serve.apexTime / ARCADE.pace[pace];
}

/** Serve timing grade from toss and hit ticks at a pace (spec §4.8); apex at serve.apexTime / paceSpeed. */
export function serveGrade(tossTick: number, hitTick: number, pace: PaceId): Grade {
  const rel = (hitTick - tossTick) * DT - apexSeconds(pace);
  const s = ARCADE.serve;
  if (rel >= -EPS && rel <= s.perfectAfterApex + EPS) return 'perfect';
  if (rel < 0 ? rel >= -s.cleanBeforeApex - EPS : rel <= s.cleanAfterApex + EPS) return 'clean';
  return 'rushed';
}

/** Toss height `ticks` after the toss at a pace: handZ → apexZ at the apex time → falling (parabola in time). */
export function tossZ(ticksSinceToss: number, pace: PaceId): number {
  const ta = apexSeconds(pace);
  const u = (ticksSinceToss * DT - ta) / ta;
  return ARCADE.serve.apexZ - (ARCADE.serve.apexZ - ARCADE.serve.handZ) * u * u;
}

function rallyAim(hitter: PlayerId, type: ShotType, grade: Grade, mx: Axis, my: Axis): Vec2 {
  const { aim } = ARCADE;
  const margin = type === 'smash' ? aim.smashMargin : ARCADE.grade[grade].margin;
  const s = -endSign(hitter); // receiver's end sign
  const x = mx * endSign(hitter) * (COURT.singlesHalfWidth - margin);
  const deep = COURT.halfLength - margin;
  let b: number;
  if (type === 'lob') b = deep - aim.lobExtraMargin;
  else if (my > 0) b = deep;
  else if (my === 0) b = COURT.halfLength - aim.neutralFromBaseline;
  else b = COURT.serviceLine - aim.shortBeforeServiceLine;
  let t = { x, y: -s * b };
  if (grade === 'rushed') {
    const pull = ARCADE.grade.rushed.pull;
    t = { x: lerp(t.x, 0, pull), y: lerp(t.y, -s * (COURT.halfLength - aim.pullFromBaseline), pull) };
  }
  return { x: noNegZero(t.x), y: noNegZero(t.y) };
}

function serveAim(hitter: PlayerId, type: 'serveFlat' | 'serveSlice' | 'serveKick', grade: Grade, mx: Axis, side: Side): Vec2 {
  const receiver: PlayerId = hitter === 0 ? 1 : 0;
  const s = endSign(receiver);
  const boxSign = s * sideSign(side);
  const d = mx * endSign(hitter);
  const margin = ARCADE.serveMargin[type];
  const halfW = COURT.singlesHalfWidth;
  let a = halfW / 2;
  if (d === boxSign) a = halfW - margin;
  else if (d === -boxSign) a = margin;
  let b = COURT.serviceLine - margin;
  if (grade === 'rushed') {
    const pull = ARCADE.serveGrade.rushed.pull;
    a = lerp(a, halfW / 2, pull);
    b = lerp(b, COURT.serviceLine / 2, pull);
  }
  return { x: noNegZero(boxSign * a), y: noNegZero(-s * b) };
}

/** Aim target before scatter (spec §4.5 rally, §4.8 serve). */
export function aimTarget(a: { hitter: PlayerId; type: ShotType; grade: Grade; mx: -1 | 0 | 1; my: -1 | 0 | 1; serveSide: Side | null }): Vec2 {
  if (isServe(a.type)) return serveAim(a.hitter, a.type, a.grade, a.mx, a.serveSide ?? 'deuce');
  return rallyAim(a.hitter, a.type, a.grade, a.mx, a.my);
}

function rallyPower(grade: Grade, charge: number, stretch: boolean): number {
  const g = ARCADE.grade;
  const base = grade === 'perfect' ? g.perfect.power : grade === 'rushed' ? g.rushed.power : g.clean.powerBase + g.clean.powerPerCharge * charge;
  return stretch ? base * ARCADE.stretch.power : base;
}

/** Scatter factor of the grade; a clean rally hit scatters more the less it was charged (spec §4.3). */
function gradeScatter(type: ShotType, grade: Grade, charge: number): number {
  if (isServe(type)) return ARCADE.serveGrade[grade].scatter;
  const g = ARCADE.grade;
  return grade === 'clean' ? g.clean.scatter + g.clean.scatterPerMissingCharge * (1 - charge) : g[grade].scatter;
}

/** Resolves a hit: power, aim, scatter (drawn in the order n1 → x, n2 → y, n3 → T), T, the apex clamp. Draws exactly 3 normals from `rng`. */
export function resolveHit(a: {
  tick: number; player: PlayerId; type: ShotType; grade: Grade; stretch: boolean; volley: boolean;
  charge: number; contact: Vec3; incomingSpeed: number; mx: -1 | 0 | 1; my: -1 | 0 | 1;
  pace: PaceId; serveSide: Side | null;
  /** True when this hit returns a serve: its scatter is × scatter.returnFactor (spec §4.7). */
  serveReturn: boolean;
}, rng: RngState): HitEvent {
  const n1 = normalIH(rng);
  const n2 = normalIH(rng);
  const n3 = normalIH(rng);
  const sc = ARCADE.scatter;
  const power = isServe(a.type) ? ARCADE.serveGrade[a.grade].power : rallyPower(a.grade, a.charge, a.stretch);
  const gs = gradeScatter(a.type, a.grade, a.charge);
  const stretchScatter = a.stretch ? ARCADE.stretch.scatter : 1;
  const sigma = sc.sigma * gs * stretchScatter * (1 + (sc.incomingWeight * a.incomingSpeed) / sc.incomingRef) * (a.serveReturn ? sc.returnFactor : 1);

  const aim = aimTarget({ hitter: a.player, type: a.type, grade: a.grade, mx: a.mx, my: a.my, serveSide: a.serveSide });
  const receiverSign = a.player === 0 ? -1 : 1;
  const x = aim.x + sigma * n1;
  let y = aim.y + sigma * n2;
  if (-receiverSign * y < ARCADE.aim.minDepth) y = -receiverSign * ARCADE.aim.minDepth;
  const target = { x: noNegZero(x), y: noNegZero(y) };

  const paceSpeed = ARCADE.pace[a.pace];
  const ph = physicsOf(a.type);
  const dx = target.x - a.contact.x;
  const dy = target.y - a.contact.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  let T = dist / (ph.speed * power * paceSpeed);
  const lobFloor = ARCADE.lobMinT / paceSpeed;
  if (a.type === 'lob') T = Math.max(T, lobFloor);
  T *= 1 + sc.tSigma * gs * stretchScatter * n3;
  if (a.type === 'lob') T = Math.max(T, lobFloor);
  T = Math.max(ARCADE.minT, T);
  T = clampTForApex(a.contact.z, ph.k, T);

  return {
    tick: a.tick, player: a.player, type: a.type, grade: a.grade, stretch: a.stretch, volley: a.volley,
    power, contact: { x: a.contact.x, y: a.contact.y, z: a.contact.z }, target, T,
  };
}

/** Launch speed of a flight in km/h (|segments[0].v0| × 3.6). */
export function kmhOf(f: Flight): number {
  const v = f.segments[0]!.v0;
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * 3.6;
}
