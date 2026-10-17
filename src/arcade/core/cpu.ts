import { BELTS } from '../../core/belts';
import { COURT, endSign } from '../../core/court';
import { forkSeed, normalIH, seedRng, uniform } from '../../core/rng';
import { currentServer, serveSide } from '../../core/scoring';
import { other } from '../../core/types';
import type { PaceId, RngState } from '../../core/types';
import { flightPos, flightVel } from './flight';
import { clampToBounds } from './movement';
import { tossZ } from './shot';
import { ARCADE, ARCADE_CPU_MILESTONES, DT, TICK_HZ } from './tuning';
import type { ArcadeState, Controller, Flight, PlayerId, PlayerInput, ShotKey, Vec2 } from './types';

/** One CPU level's skill (spec §5): seconds, metres, a speed factor and an aggression share. */
export interface ArcadeCpuProfile { reaction: number; readError: number; speed: number; pressSigma: number; aggression: number }

type Axis = -1 | 0 | 1;
type Keys = { topspin: boolean; slice: boolean; lob: boolean };
type Dir = { mx: Axis; my: Axis };
type Row = (typeof ARCADE_CPU_MILESTONES)[number];

/** Belt-independent CPU behaviour (spec §5), in seconds, metres and probabilities. */
const CPU = {
  tossWait: { min: 0.6, max: 1.2 },
  /** Height band of a groundstroke contact after the bounce. */
  band: { minZ: 0.5, maxZ: 1.4 },
  /** Volleys are planned when the CPU is this close to the net. */
  volleyNetDist: 4.0,
  /** The contact spot is this far beside the ball, on the forehand or backhand side. */
  sideOffset: 0.7,
  /** The read error shrinks linearly to 0 over this many seconds before the predicted contact. */
  errorFade: 0.5,
  deadband: 0.15,
  /** Aim is held on this many ticks before the (predicted) contact, and on it. */
  aimTicks: 2,
  /** Distance short of a 0.7 m spot that still counts as reachable (the reach zone is wider; 0 for a stretch spot). */
  reachSlack: 0.3,
  /** A clamped spot must leave the ball this far inside the reach radius. */
  reachMargin: 0.2,
  lob: { oppNetDist: 4.0, base: 0.3, perAggression: 0.5 },
  corner: { base: 0.25, perAggression: 0.6 },
  deepChance: 0.5,
  netShort: { dist: 4.0, chance: 0.3 },
  /** Home: behind the centre of the baseline, shifted toward the side of the CPU's own shot. */
  home: { behind: 0.8, shift: 0.6 },
  /** Net approach after a contact more than `inside` m inside the baseline, at aggression > `aggression`. */
  approach: { inside: 4.0, aggression: 0.5, fromNet: 2.5 },
} as const;

function profileOf(r: Row): ArcadeCpuProfile {
  return { reaction: r.reaction, readError: r.readError, speed: r.speed, pressSigma: r.pressSigma, aggression: r.aggression };
}

/** Level 0..14 → profile, interpolated linearly between milestone rows; RangeError otherwise. */
export function arcadeCpuProfile(level: number): ArcadeCpuProfile {
  const max = BELTS.length - 1;
  if (!Number.isInteger(level) || level < 0 || level > max) throw new RangeError(`arcadeCpuProfile: level must be an integer 0..${max}, got ${level}`);
  const rows = ARCADE_CPU_MILESTONES;
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]!;
    if (a.level === level) return profileOf(a);
    const b = rows[i + 1];
    if (b !== undefined && level > a.level && level < b.level) {
      const t = (level - a.level) / (b.level - a.level);
      const l = (x: number, y: number): number => x + (y - x) * t;
      return { reaction: l(a.reaction, b.reaction), readError: l(a.readError, b.readError), speed: l(a.speed, b.speed), pressSigma: l(a.pressSigma, b.pressSigma), aggression: l(a.aggression, b.aggression) };
    }
  }
  throw new RangeError(`arcadeCpuProfile: no milestone rows cover level ${level}`);
}

/** The CPU's home spot: behind the centre of `player`'s baseline (where it recovers to, before the 0.6 m shift). */
export function arcadeCpuHome(player: PlayerId): Vec2 {
  return { x: 0, y: -endSign(player) * (COURT.halfLength + CPU.home.behind) };
}

/** The serve being prepared: set-up it belongs to, toss wait and hit delay (ticks), key and aim. */
interface ServePlan { since: number; wait: number; hitAfter: number; key: ShotKey; mx: Axis }

/** A predicted meeting with the ball: the tick, the ball's ground point, and the spot to stand on (in bounds). */
interface PlannedContact { tick: number; ball: Vec2; spot: Vec2 }

/** What a prediction may use: volleys, the late re-read (any height, all charging), the commit lead (s), the serve-bounce rule. */
interface ScanOpts { volley: boolean; late: boolean; lead: number; serveUnbounced: boolean }

/** One prediction pass: a contact height range, and comfortable (0.7 m beside) or stretch spots. */
type Pass = { lo: number; hi: number; stretch: boolean };
/** A candidate contact and how far (m) the CPU expects to be short of its spot (≤ 0: reachable). */
type Scored = { c: PlannedContact; lateBy: number };

/** The answer to one incoming flight, with its randoms drawn up front. */
interface ShotPlan {
  /** hit.tick of the flight it answers. */
  flightTick: number;
  contact: PlannedContact | null;
  /** Read error at full strength (world metres). */
  err: Vec2;
  /** Commit lead before the predicted contact, in ticks. */
  lead: number;
  /** True when a volley was allowed at planning (near the net, not a serve return). */
  volley: boolean;
  u: { lob: number; corner: number; cornerSide: number; deep: number; short: number };
}

/** Everything an ArcadeCpu remembers between ticks: plain JSON-safe data, so it can be snapshotted. */
export interface ArcadeCpuMemory {
  rng: RngState;
  /** Speed-factor accumulator. */
  acc: number;
  /** Where it is steering (world), or null to stand still. */
  target: Vec2 | null;
  /** Tick the previous output applied to, and its shot keys (a key must be up for a tick between presses). */
  lastTick: number;
  lastKeys: Keys;
  serve: ServePlan | null;
  shot: ShotPlan | null;
}

const idle = (): PlayerInput => ({ mx: 0, my: 0, topspin: false, slice: false, lob: false });
const move = (d: Dir): PlayerInput => ({ mx: d.mx, my: d.my, topspin: false, slice: false, lob: false });
const axisOf = (d: number): Axis => (d > CPU.deadband ? 1 : d < -CPU.deadband ? -1 : 0);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** The last tick count after the toss at which the toss is still at or above the drop height. */
function lastHitTicks(pace: PaceId): number {
  let n = 0;
  while (tossZ(n + 1, pace) >= ARCADE.serve.dropZ) n++;
  return n;
}

/**
 * A CPU player: a Controller that sees only public state and its own RNG. `seed` is the match
 * seed; the CPU's stream is seedRng(forkSeed(seed, 20 + player)) (spec §5). It never reads `s.rng`.
 */
export class ArcadeCpu implements Controller {
  private readonly player: PlayerId;
  private readonly profile: ArcadeCpuProfile;
  private readonly reactTicks: number;
  private readonly m: ArcadeCpuMemory;

  /** `player` it controls, belt `level` 0..14 (RangeError otherwise), match `seed`. */
  constructor(player: PlayerId, level: number, seed: number) {
    this.player = player;
    this.profile = arcadeCpuProfile(level);
    this.reactTicks = Math.round(this.profile.reaction * TICK_HZ);
    this.m = {
      rng: seedRng(forkSeed(seed, 20 + player)), acc: 0, target: null, lastTick: -1,
      lastKeys: { topspin: false, slice: false, lob: false }, serve: null, shot: null,
    };
  }

  /** The planning state (live, read-only view). */
  get memory(): Readonly<ArcadeCpuMemory> {
    return this.m;
  }

  /** This player's input for the next tick (s.tick + 1). */
  input(s: Readonly<ArcadeState>): PlayerInput {
    const now = s.tick + 1;
    const out = this.decide(s, now);
    this.m.lastTick = now;
    this.m.lastKeys = { topspin: out.topspin, slice: out.slice, lob: out.lob };
    return out;
  }

  private decide(s: Readonly<ArcadeState>, now: number): PlayerInput {
    const phase = s.phase;
    if (phase.kind === 'rally') return this.rally(s, now);
    this.m.shot = null;
    this.m.target = null;
    if (phase.kind !== 'setup' && phase.kind !== 'toss') {
      this.m.serve = null;
      return idle();
    }
    if (currentServer(s.score) !== this.player) return idle();
    return phase.kind === 'setup' ? this.setup(s, phase.since, now) : this.toss(s, now);
  }

  /** One tick down on `key` (with direction `d`), unless it was down on the previous tick. */
  private tap(key: ShotKey, d: Dir, now: number): PlayerInput {
    const ok = !(this.m.lastTick === now - 1 && this.m.lastKeys[key]);
    return { mx: d.mx, my: d.my, topspin: ok && key === 'topspin', slice: ok && key === 'slice', lob: ok && key === 'lob' };
  }

  private setup(s: Readonly<ArcadeState>, since: number, now: number): PlayerInput {
    let plan = this.m.serve;
    if (plan === null || plan.since !== since) plan = this.m.serve = this.planServe(s, since);
    return now - since >= plan.wait ? this.tap(plan.key, { mx: 0, my: 0 }, now) : idle();
  }

  private toss(s: Readonly<ArcadeState>, now: number): PlayerInput {
    const toss = s.toss;
    if (toss === null || toss.player !== this.player) return idle();
    const plan = this.m.serve ?? (this.m.serve = this.planServe(s, toss.tick));
    const hitTick = toss.tick + plan.hitAfter;
    const d: Dir = { mx: now >= hitTick - CPU.aimTicks ? plan.mx : 0, my: 0 };
    return now >= hitTick ? this.tap(plan.key, d, now) : move(d);
  }

  /** Draws the serve: toss wait U(0.6, 1.2) s, flat/slice (kick on serve 2), wide/T/body aim, hit timing. */
  private planServe(s: Readonly<ArcadeState>, since: number): ServePlan {
    const r = this.m.rng;
    const a = this.profile.aggression;
    const uWait = uniform(r);
    const uFlat = uniform(r);
    const uCorner = uniform(r);
    const uWide = uniform(r);
    const n = normalIH(r);
    const wait = Math.round((CPU.tossWait.min + (CPU.tossWait.max - CPU.tossWait.min) * uWait) * TICK_HZ);
    const key: ShotKey = s.point.serveNo === 2 ? 'lob' : uFlat < a ? 'topspin' : 'slice';
    const pace = s.config.pace;
    const ideal = ARCADE.serve.apexTime / ARCADE.pace[pace] + ARCADE.serve.perfectAfterApex / 2 + n * this.profile.pressSigma;
    const hitAfter = Math.min(Math.max(Math.round(ideal * TICK_HZ), 2), lastHitTicks(pace));
    // Serve aim (shot.ts): d = mx·endSign(server); d = boxSign → wide, −boxSign → T, 0 → body.
    const boxSign = endSign(other(this.player)) * (serveSide(s.score) === 'deuce' ? 1 : -1);
    const wide: Axis = boxSign * endSign(this.player) > 0 ? 1 : -1;
    let mx: Axis = 0;
    if (uCorner < CPU.corner.base + CPU.corner.perAggression * a) mx = uWide < 0.5 ? wide : wide === 1 ? -1 : 1;
    return { since, wait, hitAfter, key, mx };
  }

  private rally(s: Readonly<ArcadeState>, now: number): PlayerInput {
    this.m.serve = null;
    const f = s.flight;
    if (f === null) return idle();
    const me = this.player;
    const pos = s.p[me].pos;
    if (f.hit.player === me) {
      this.m.shot = null;
      this.m.target = this.recoverySpot(f);
      return move(this.steer(pos, this.m.target));
    }
    if (now - f.hit.tick < this.reactTicks) return move(this.steer(pos, this.m.target));
    let plan = this.m.shot;
    if (plan === null || plan.flightTick !== f.hit.tick) plan = this.m.shot = this.planShot(s, f, now);
    let c = plan.contact;
    if (c !== null && now > c.tick) {
      // Late (no contact on the predicted tick): re-read the ball from here, without the read error.
      c = plan.contact = this.predict(f, pos, now, { volley: plan.volley, late: true, lead: 0, serveUnbounced: s.point.serveUnbounced });
      plan.err = { x: 0, y: 0 };
    }
    if (c === null) return move(this.steer(pos, this.m.target));
    const fade = clamp01(((c.tick - now) * DT) / CPU.errorFade);
    const target = clampToBounds({ x: c.spot.x + plan.err.x * fade, y: c.spot.y + plan.err.y * fade }, me);
    this.m.target = target;
    const d = now >= c.tick - CPU.aimTicks ? this.aim(s, plan, pos) : this.steer(pos, target);
    const live = (now - f.hit.tick) * DT < f.tEnd;
    if (s.p[me].commit === null && live && now >= c.tick - plan.lead) return this.tap(this.shotKey(s, plan, c, pos, target, now), d, now);
    return move(d);
  }

  /** Draws the shot's randoms (read error x, y; press noise; lob, corner, side, depth, short) and predicts the contact. */
  private planShot(s: Readonly<ArcadeState>, f: Flight, now: number): ShotPlan {
    const r = this.m.rng;
    const p = this.profile;
    const err = { x: normalIH(r) * p.readError, y: normalIH(r) * p.readError };
    const press = normalIH(r);
    const u = { lob: uniform(r), corner: uniform(r), cornerSide: uniform(r), deep: uniform(r), short: uniform(r) };
    const { chargeTime, perfectWindow } = ARCADE.swing;
    const lead = Math.max(0, Math.round((chargeTime + perfectWindow / 2 + press * p.pressSigma) * TICK_HZ));
    const pos = s.p[this.player].pos;
    const volley = !s.point.serveUnbounced && Math.abs(pos.y) <= CPU.volleyNetDist;
    const contact = this.predict(f, pos, now, { volley, late: false, lead: lead * DT, serveUnbounced: s.point.serveUnbounced });
    return { flightTick: f.hit.tick, contact, err, lead, volley, u };
  }

  /**
   * The predicted contact from tick `from` on (spec §5 Prediction): the first tick at which the ball
   * is on the CPU's half, coming toward it, at 0.5–1.4 m after the bounce (any in-zone height for a
   * volley or when late) and its spot, 0.7 m beside the ball, is reachable in time. Fallbacks, in
   * order: any in-zone height (a slice can bounce lower than 0.5 m); a stretch spot at the edge of
   * reach; the least-late stretch. Null when the ball never comes within reach.
   */
  private predict(f: Flight, pos: Vec2, from: number, o: ScanOpts): PlannedContact | null {
    const first = f.bounces[0];
    if (f.net || first === undefined) return null;
    const zone = { lo: ARCADE.reach.minZ, hi: ARCADE.reach.maxZ };
    const passes: Pass[] = [{ ...zone, stretch: false }, { ...zone, stretch: true }];
    if (!o.volley && !o.late) passes.unshift({ lo: CPU.band.minZ, hi: CPU.band.maxZ, stretch: false });
    let last: Scored | null = null;
    for (const p of passes) {
      last = this.scan(f, pos, from, o, first.t, p);
      if (last !== null && last.lateBy <= 0) return last.c;
    }
    return last?.c ?? null;
  }

  /** The first reachable candidate tick of one pass, else the least-late one. */
  private scan(f: Flight, pos: Vec2, from: number, o: ScanOpts, bounceT: number, p: Pass): Scored | null {
    const s = endSign(this.player);
    let best: Scored | null = null;
    for (let n = from; (n - f.hit.tick) * DT < f.tEnd; n++) {
      const t = (n - f.hit.tick) * DT;
      if (t < bounceT && (!o.volley || o.serveUnbounced)) continue;
      const b = flightPos(f, t);
      if (b.z < p.lo || b.z > p.hi || s * b.y >= 0 || s * flightVel(f, t).y >= 0) continue;
      const spot = p.stretch ? this.stretchSpot(b, pos) : this.spotFor(b, pos);
      if (spot === null) continue;
      const dx = spot.x - pos.x;
      const dy = spot.y - pos.y;
      const avail = (n - from + 1) * DT;
      const slack = p.stretch ? 0 : CPU.reachSlack;
      const lateBy = Math.sqrt(dx * dx + dy * dy) - slack - this.coverable(avail, o.late ? avail : Math.min(avail, o.lead));
      const c = { tick: n, ball: { x: b.x, y: b.y }, spot };
      if (lateBy <= 0) return { c, lateBy };
      if (best === null || lateBy < best.lateBy) best = { c, lateBy };
    }
    return best;
  }

  /** True when a spot leaves the ball at `b` inside the reach radius (less the margin). */
  private reaches(spot: Vec2, b: Vec2): boolean {
    const dx = b.x - spot.x;
    const dy = b.y - spot.y;
    return Math.sqrt(dx * dx + dy * dy) <= ARCADE.reach.radius - CPU.reachMargin;
  }

  /**
   * The contact spot for a ball at `b`: 0.7 m beside it on the side nearer the CPU's x, clamped to
   * the CPU's bounds; the other side if the clamp leaves the ball out of reach; null if neither works.
   */
  private spotFor(b: Vec2, pos: Vec2): Vec2 | null {
    const o = CPU.sideOffset;
    const pref = Math.abs(b.x + o - pos.x) <= Math.abs(b.x - o - pos.x) ? o : -o;
    for (const side of [pref, -pref]) {
      const spot = clampToBounds({ x: b.x + side, y: b.y }, this.player);
      if (this.reaches(spot, b)) return spot;
    }
    return null;
  }

  /** A stretch: the point at the edge of reach from the ball toward the CPU, clamped to its bounds; null if that leaves the ball out of reach. */
  private stretchSpot(b: Vec2, pos: Vec2): Vec2 | null {
    const dx = pos.x - b.x;
    const dy = pos.y - b.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const r = ARCADE.reach.radius - CPU.reachMargin;
    const k = d > r ? r / d : 1;
    const spot = clampToBounds({ x: b.x + dx * k, y: b.y + dy * k }, this.player);
    return this.reaches(spot, b) ? spot : null;
  }

  /** The CPU's own estimate of how far it can run from rest in `avail` s, the last `charging` s of them committed. */
  private coverable(avail: number, charging: number): number {
    const mv = ARCADE.move;
    const v = mv.topSpeed * this.profile.speed;
    const chg = Math.min(avail, Math.max(0, charging));
    const free = avail - chg;
    const v0 = free > 0 ? v : v * mv.chargeSpeedMult;
    const startLoss = (v0 * v0 * mv.accelTime) / (2 * mv.topSpeed);
    return Math.max(0, v * free + v * mv.chargeSpeedMult * chg - startLoss);
  }

  /** Stretched (predicted lateral > stretchDist) → slice; opponent near the net → lob (by aggression); else topspin. */
  private shotKey(s: Readonly<ArcadeState>, plan: ShotPlan, c: PlannedContact, pos: Vec2, target: Vec2, now: number): ShotKey {
    const remain = Math.max(0, (c.tick - now) * DT);
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const bx = c.ball.x - c.spot.x;
    const by = c.ball.y - c.spot.y;
    const lateral = Math.sqrt(bx * bx + by * by) + Math.max(0, Math.sqrt(dx * dx + dy * dy) - this.coverable(remain, remain));
    if (lateral > ARCADE.swing.stretchDist) return 'slice';
    const opp = s.p[other(this.player)].pos;
    if (Math.abs(opp.y) <= CPU.lob.oppNetDist && plan.u.lob < CPU.lob.base + CPU.lob.perAggression * this.profile.aggression) return 'lob';
    return 'topspin';
  }

  /** Rally aim: corner away from the opponent (by aggression), deep or neutral, short from near the net. */
  private aim(s: Readonly<ArcadeState>, plan: ShotPlan, pos: Vec2): Dir {
    const me = this.player;
    const opp = s.p[other(me)].pos;
    let mx: Axis = 0;
    if (plan.u.corner < CPU.corner.base + CPU.corner.perAggression * this.profile.aggression) {
      const away = opp.x > 0 ? -1 : opp.x < 0 ? 1 : plan.u.cornerSide < 0.5 ? -1 : 1; // world x sign
      mx = away * endSign(me) > 0 ? 1 : -1; // target world x = mx·endSign(me)·…
    }
    let my: Axis = plan.u.deep < CPU.deepChance ? 1 : 0;
    if (Math.abs(pos.y) <= CPU.netShort.dist && plan.u.short < CPU.netShort.chance) my = -1;
    return { mx, my };
  }

  /** After its own hit: home behind the baseline centre shifted 0.6 m toward the shot, or the net after an approach. */
  private recoverySpot(f: Flight): Vec2 {
    const s = endSign(this.player);
    const tx = f.hit.target.x;
    const x = tx > 0 ? CPU.home.shift : tx < 0 ? -CPU.home.shift : 0;
    const inside = COURT.halfLength + s * f.hit.contact.y;
    if (inside > CPU.approach.inside && this.profile.aggression > CPU.approach.aggression) return { x, y: -s * CPU.approach.fromNet };
    return { x, y: -s * (COURT.halfLength + CPU.home.behind) };
  }

  /** Direction toward `target` in the CPU's court frame (deadband), held only on the speed factor's share of ticks. */
  private steer(pos: Vec2, target: Vec2 | null): Dir {
    this.m.acc += this.profile.speed;
    const go = this.m.acc >= 1;
    if (go) this.m.acc = Math.min(this.m.acc - 1, 1);
    if (!go || target === null) return { mx: 0, my: 0 };
    const s = endSign(this.player);
    return { mx: axisOf((target.x - pos.x) * s), my: axisOf((target.y - pos.y) * s) };
  }
}
