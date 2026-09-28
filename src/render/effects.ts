import { seedRng, uniform } from '../core/rng';
import type { GameEvent, PlayerId, RngState, Surface, TurnState, Vec2 } from '../core/types';
import { checker } from './court';
import { OUTLINE, PAL } from './palette';
import type { PlayerPose } from './players';
import { H, W, project } from './projection';
import type { AnimName } from './sprites/animations';
import type { WorldFrame } from './world';

/** Kinds of world particle: a racket-contact spark, a bounce puff, a footstep dust puff. */
type Kind = 'spark' | 'puff' | 'dust';

/** A pooled world-space particle (metres; z up), alive while `age < life`. */
interface Particle { kind: Kind; x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; color: string }

/** A pooled screen-space confetti piece: thrown at (x0, y0) px, drifting at (vx, vy) px/ms, swaying by `phase`. */
interface Confetto { x0: number; y0: number; vx: number; vy: number; age: number; life: number; color: string; phase: number }

const PARTICLES = 160;
const CONFETTI = 160;
const CONFETTI_REDUCED = 40;
/** Confetti life cap: longer than the slowest piece (thrown 270 px above the top, 0.05 px/ms) needs to fall out of view. */
const CONFETTI_MS = 12000;
/** Confetti sway (px, ms per radian) and flutter: the piece turns through these w×h shapes. */
const SWAY = { px: 3, ms: 260 };
const FLUTTER_MS = 110;
const FLUTTER: readonly [number, number][] = [
  [2, 2],
  [3, 1],
  [2, 2],
  [1, 3],
];
const SPARK_MS = 160;
const PUFF_MS = 320;
const DUST_MS = 360;
/** Run dust: one puff per this many ms of running (twice as far apart with reduced effects). */
const DUST_EVERY_MS = 110;
/** Clay slide: dust puffs thrown up when a runner stops to swing. */
const SLIDE_PUFFS = 5;
const MAX_MARKS = 24;
/** Screen shake on ACE/WINNER: 2 px for 300 ms, a new offset every 40 ms. */
const SHAKE_MS = 300;
const SHAKE_STEP_MS = 40;
const SHAKE: readonly { x: number; y: number }[] = [
  { x: 2, y: 0 },
  { x: -2, y: 1 },
  { x: 1, y: -2 },
  { x: -1, y: 2 },
];
/** Crowd excitement: event peaks, the per-second decay, and the long-rally floor. */
const EXCITE = { point: 0.7, great: 0.95, match: 1, decayPerS: 0.3, rallyFrom: 4, rallyStep: 0.08, rallyMax: 0.45 };

const DUST_COLOR: Record<Surface, string> = { hard: PAL.mist, clay: PAL.clayDust, grass: PAL.grassWorn, dojo: PAL.woodHi };
const CONFETTI_COLORS = [PAL.gold, PAL.tierSky, PAL.crowdRed, PAL.white, PAL.grassHi, PAL.crowdPurple, PAL.tierYellow];
const RUNS: readonly AnimName[] = ['runLeft', 'runRight', 'runToward', 'runAway'];
const SWINGS: readonly AnimName[] = ['forehand', 'backhand', 'stretch'];

/** The turn of `pub` (current or previous) with id `id`. */
function turnById(f: WorldFrame, id: number): TurnState | null {
  if (f.turn?.data.turnId === id) return f.turn;
  if (f.pub.turn?.data.turnId === id) return f.pub.turn;
  return f.pub.lastTurn?.data.turnId === id ? f.pub.lastTurn : null;
}

/**
 * Cosmetic effects (spec §4.1, Task 18 ruling 6), driven by the frame's events and the players'
 * animations: hit sparks, bounce puffs, clay ball marks (kept until the next point), run dust and
 * clay slide dust, crowd excitement (points, aces, long rallies, insane returns), confetti on the
 * match win and a 2 px screen shake on an ACE or WINNER. `reduce` (Reduce effects) drops the shake,
 * thins the dust and confetti and shortens the sparks. Particles live in fixed pools; nothing is
 * allocated per frame.
 */
export class Effects {
  private readonly parts: Particle[] = Array.from({ length: PARTICLES }, () => ({
    kind: 'dust', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 0, color: PAL.white,
  }));
  private readonly flakes: Confetto[] = Array.from({ length: CONFETTI }, () => ({
    x0: 0, y0: 0, vx: 0, vy: 0, age: 0, life: 0, color: PAL.white, phase: 0,
  }));
  private readonly marks: Vec2[] = [];
  private readonly rng: RngState = seedRng(0xf00d);
  private readonly dustMs: [number, number] = [0, 0];
  private readonly lastAnim: [AnimName | null, AnimName | null] = [null, null];
  private excite = 0;
  private shakeLeft = 0;
  private shakeAge = 0;
  private pointNo: number | null = null;
  private surface: Surface = 'hard';

  /** Share of the crowd cheering, 0–1 (scene `crowdExcite`). */
  get crowdExcite(): number {
    return this.excite;
  }

  /** Ball marks on clay since the point began (world ground points). */
  get clayMarks(): readonly Vec2[] {
    return this.marks;
  }

  /** Confetti pieces still falling. */
  get confetti(): number {
    return this.flakes.reduce((n, c) => n + (c.age < c.life ? 1 : 0), 0);
  }

  /** Screen offset for the world layers this frame (0, 0 unless shaking). */
  shake(): { x: number; y: number } {
    if (this.shakeLeft <= 0) return { x: 0, y: 0 };
    return { ...SHAKE[Math.floor(this.shakeAge / SHAKE_STEP_MS) % SHAKE.length]! };
  }

  /** Consumes the frame's events and the players' poses, then advances everything by `dtMs`. */
  update(f: WorldFrame, poses: readonly [PlayerPose, PlayerPose], dtMs: number, reduce: boolean): void {
    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    this.surface = f.pub.config.surface;
    if (this.pointNo !== f.pub.pointNo) {
      this.pointNo = f.pub.pointNo;
      this.marks.length = 0;
    }
    for (const e of f.vm.events) this.onEvent(f, e, reduce);
    for (const p of [0, 1] as const) this.footwork(p, poses[p], dt, reduce);
    const floor = Math.min(EXCITE.rallyMax, Math.max(0, (f.pub.rallyStrikes - EXCITE.rallyFrom) * EXCITE.rallyStep));
    this.excite = Math.max(floor, this.excite - (EXCITE.decayPerS * dt) / 1000);
    this.shakeLeft -= dt;
    this.shakeAge += dt;
    for (const q of this.parts) {
      if (q.age >= q.life) continue;
      q.age += dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.z = Math.max(0, q.z + q.vz * dt);
    }
    for (const c of this.flakes) {
      if (c.age >= c.life) continue;
      c.age += dt;
      if (c.y0 + c.vy * c.age > H) c.age = c.life;
    }
  }

  private onEvent(f: WorldFrame, e: GameEvent, reduce: boolean): void {
    switch (e.type) {
      case 'strike': {
        const t = turnById(f, e.turn);
        // Returning an insane shot draws a cheer, whatever the return's own outcome (choice-stack spec §4).
        if (t?.data.kind === 'return' && t.data.chase.tier === 'insane') this.excite = Math.max(this.excite, EXCITE.point);
        const o = t?.outcome;
        if (o?.kind !== 'strike') return;
        const p = o.strike.flight.p0;
        this.spawn('spark', p.x, p.y, p.z, 0, 0, 0, reduce ? SPARK_MS / 2 : SPARK_MS, PAL.white);
        return;
      }
      case 'bounce':
        this.spawn('puff', e.at.x, e.at.y, 0, 0, 0, 0, PUFF_MS, DUST_COLOR[this.surface]);
        if (this.surface === 'clay') {
          if (this.marks.length >= MAX_MARKS) this.marks.shift();
          this.marks.push({ x: e.at.x, y: e.at.y });
        }
        return;
      case 'point': {
        const great = e.reason === 'ace' || e.reason === 'winner';
        this.excite = Math.max(this.excite, great ? EXCITE.great : EXCITE.point);
        if (great && !reduce) {
          this.shakeLeft = SHAKE_MS;
          this.shakeAge = 0;
        }
        return;
      }
      case 'match':
        this.excite = EXCITE.match;
        this.throwConfetti(reduce ? CONFETTI_REDUCED : CONFETTI);
        return;
      default:
        return;
    }
  }

  /** Run dust behind a running player's feet, and a clay slide when a runner stops to swing. */
  private footwork(p: PlayerId, pose: PlayerPose, dt: number, reduce: boolean): void {
    const color = DUST_COLOR[this.surface];
    const running = RUNS.includes(pose.anim);
    const prev = this.lastAnim[p];
    this.lastAnim[p] = pose.anim;
    if (this.surface === 'clay' && prev !== null && RUNS.includes(prev) && SWINGS.includes(pose.anim)) {
      for (let i = 0; i < (reduce ? 2 : SLIDE_PUFFS); i++) this.dust(pose.feet, color, 0.0015);
    }
    if (!running || this.surface === 'dojo') {
      this.dustMs[p] = 0;
      return;
    }
    this.dustMs[p] += dt;
    const every = reduce ? DUST_EVERY_MS * 2 : DUST_EVERY_MS;
    if (this.dustMs[p] >= every) {
      this.dustMs[p] -= every;
      this.dust(pose.feet, color, 0.0006);
    }
  }

  private dust(at: Vec2, color: string, spread: number): void {
    const vx = (uniform(this.rng) - 0.5) * spread;
    const vy = (uniform(this.rng) - 0.5) * spread;
    this.spawn('dust', at.x, at.y, 0.05, vx, vy, 0.0008, DUST_MS, color);
  }

  private spawn(kind: Kind, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, color: string): void {
    const q = this.parts.find((p) => p.age >= p.life);
    if (!q) return;
    Object.assign(q, { kind, x, y, z, vx, vy, vz, age: 0, life, color });
  }

  private throwConfetti(n: number): void {
    let left = n;
    for (const c of this.flakes) {
      if (left <= 0) return;
      if (c.age < c.life) continue;
      left--;
      c.x0 = uniform(this.rng) * W;
      c.y0 = -uniform(this.rng) * H;
      c.vx = (uniform(this.rng) - 0.5) * 0.02;
      c.vy = 0.05 + uniform(this.rng) * 0.05;
      c.age = 0;
      c.life = CONFETTI_MS;
      c.phase = uniform(this.rng) * 1000;
      c.color = CONFETTI_COLORS[Math.floor(uniform(this.rng) * CONFETTI_COLORS.length)]!;
    }
  }

  /** Draws the clay ball marks on the ground (below players and shadows). */
  drawGround(ctx: CanvasRenderingContext2D, viewer: PlayerId | 'spectator'): void {
    for (const m of this.marks) {
      const s = project({ x: m.x, y: m.y, z: 0 }, viewer);
      const x = Math.round(s.x);
      const y = Math.round(s.y);
      ctx.fillStyle = PAL.clayDeep;
      ctx.fillRect(x - 1, y - 1, 3, 1);
      ctx.fillRect(x - 2, y, 5, 1);
      ctx.fillStyle = PAL.clayLo;
      ctx.fillRect(x - 1, y + 1, 3, 1);
    }
  }

  /** Draws the world particles (sparks, puffs, dust) above the players, then the confetti. */
  draw(ctx: CanvasRenderingContext2D, viewer: PlayerId | 'spectator'): void {
    ctx.save();
    for (const q of this.parts) {
      if (q.age >= q.life) continue;
      const s = project({ x: q.x, y: q.y, z: q.z }, viewer);
      const x = Math.round(s.x);
      const y = Math.round(s.y);
      const k = q.age / q.life;
      ctx.globalAlpha = 1 - k;
      if (q.kind === 'spark') drawSpark(ctx, x, y, q.age);
      else if (q.kind === 'puff') drawPuff(ctx, x, y, k, q.color);
      else {
        ctx.fillStyle = q.color;
        ctx.fillRect(x, y, k < 0.5 ? 2 : 1, 1);
      }
    }
    ctx.globalAlpha = 1;
    for (const c of this.flakes) {
      if (c.age >= c.life) continue;
      const x = c.x0 + c.vx * c.age + SWAY.px * Math.sin((c.age + c.phase) / SWAY.ms);
      const [w, h] = FLUTTER[Math.floor((c.age + c.phase) / FLUTTER_MS) % FLUTTER.length]!;
      ctx.fillStyle = c.color;
      ctx.fillRect(Math.round(x), Math.round(c.y0 + c.vy * c.age), w, h);
    }
    ctx.restore();
  }
}

/** A racket-contact star: a white cross growing outwards, gold diagonals, a white core at first. */
function drawSpark(ctx: CanvasRenderingContext2D, x: number, y: number, age: number): void {
  const r = 1 + Math.floor(age / 40);
  ctx.fillStyle = PAL.white;
  if (age < 50) ctx.fillRect(x, y, 1, 1);
  ctx.fillRect(x - r, y, 1, 1);
  ctx.fillRect(x + r, y, 1, 1);
  ctx.fillRect(x, y - r, 1, 1);
  ctx.fillRect(x, y + r, 1, 1);
  if (r < 2) return;
  ctx.fillStyle = PAL.gold;
  const d = r - 1;
  ctx.fillRect(x - d, y - d, 1, 1);
  ctx.fillRect(x + d, y - d, 1, 1);
  ctx.fillRect(x - d, y + d, 1, 1);
  ctx.fillRect(x + d, y + d, 1, 1);
}

/** A bounce puff: dust kicked out sideways along the ground, with a dithered dark spot at first. */
function drawPuff(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, color: string): void {
  const spread = 1 + Math.round(k * 5);
  ctx.fillStyle = color;
  ctx.fillRect(x - spread - 1, y, 2, 1);
  ctx.fillRect(x + spread, y, 2, 1);
  ctx.fillRect(x - Math.round(spread / 2), y - 1 - Math.round(k * 2), 1, 1);
  ctx.fillRect(x + Math.round(spread / 2), y - 1 - Math.round(k * 2), 1, 1);
  if (k < 0.3) {
    ctx.fillStyle = OUTLINE;
    if (checker(x, y)) ctx.fillRect(x, y, 1, 1);
  }
}
