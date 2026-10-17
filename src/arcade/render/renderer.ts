import { currentServer } from '../../core/scoring';
import type { Look } from '../../core/types';
import { drawBall, drawBallShadow, tossHandDx, type BallView } from '../../render/ballPaint';
import { shadowText } from '../../render/banner';
import { drawCourt } from '../../render/court';
import { Effects } from '../../render/effects';
import { FONT, textWidth } from '../../render/font';
import { OUTLINE, PAL } from '../../render/palette';
import { H, W, netScreenY, project, scaleAt, viewerEnd } from '../../render/projection';
import { drawBackdrop, drawNet, type SceneState } from '../../render/scene';
import { rect } from '../../render/scoreboard';
import type { Screen } from '../../render/screen';
import { drawContactShadow } from '../../render/shadow';
import { buildSheet, drawPlayer, type SpriteSheet } from '../../render/sprites/sheet';
import { drawUmpire } from '../../render/umpire';
import { ballAt } from '../core/match';
import { chargeAt, rallyGrade } from '../core/shot';
import { DT, TICK_HZ } from '../core/tuning';
import type { ArcadeEvent, ArcadeState, PlayerId, Vec2, Vec3 } from '../core/types';
import type { ArcadeView } from '../game/session';
import { poseAt, type ArcadePose } from './animator';
import { ArcadeFx } from './fx';
import { drawArcadeHud } from './hud';

/** A finished flight fades out over this long after tEnd (s). */
const FADE_S = 0.3;
/** Motion trail: samples this far apart behind the ball (s), as in the typing game. */
const TRAIL_STEP_S = 0.016;
const TRAIL_SAMPLES = 2;
/** Events are kept this long for the banners and readouts (longer than any of them lasts). */
const RECENT_TICKS = 10 * TICK_HZ;
/** Screen rows above/below the net line inside which the umpire looks across the court. */
const UMPIRE_ACROSS_PX = 12;
/** Tallest standing head above the feet anchor (px, hair included), and the gap above it to the charge bar. */
const HEAD_PX = 43;
const HEAD_GAP = 3;
const BAR = { w: 12, h: 2 };
/** The PERFECT pop: on screen this long (ms), rising this far (px). */
const POP_MS = 500;
const POP_RISE = 6;
const POP_TEXT = 'PERFECT';
const PLAYERS = [0, 1] as const;

const ground = (p: Vec2, viewer: PlayerId | 'spectator'): { x: number; y: number } => project({ x: p.x, y: p.y, z: 0 }, viewer);

/** The tossed ball above the server's tossing hand at the toss height `z` (as the typing game draws it). */
function tossBall(pose: ArcadePose, z: number, viewer: PlayerId | 'spectator'): BallView {
  const rot = viewerEnd(viewer) === 0 ? 1 : -1;
  const dx = (rot * tossHandDx(pose, 0)) / scaleAt(pose.feet.y, viewer);
  return { kind: 'air', pos: { x: pose.feet.x + dx, y: pose.feet.y, z }, alpha: 1, trail: [], hot: false };
}

/**
 * The ball at sim time `t` (spec §6.1): in the server's hand at the intro and set-up, on the toss
 * above the tossing hand, then `ballAt` on the flight with a two-sample trail (none when `trail` is
 * off) at full opacity until tEnd, fading out over 300 ms after it; null when there is none.
 */
export function ballViewAt(
  s: Readonly<ArcadeState>,
  t: number,
  poses: readonly [ArcadePose, ArcadePose],
  viewer: PlayerId | 'spectator',
  trail: boolean,
): BallView | null {
  const kind = s.phase.kind;
  if (kind === 'intro' || kind === 'setup') return { kind: 'held', player: currentServer(s.score) };
  const pos = ballAt(s, t);
  if (pos === null) return null;
  if (kind === 'toss' && s.toss !== null) return tossBall(poses[s.toss.player], pos.z, viewer);
  const f = s.flight;
  if (f === null) return null;
  const hitT = f.hit.tick * DT;
  const alpha = Math.min(1, 1 - (t - hitT - f.tEnd) / FADE_S);
  if (alpha <= 0) return null;
  const samples: Vec3[] = [];
  for (let i = 1; trail && i <= TRAIL_SAMPLES; i++) {
    const at = t - i * TRAIL_STEP_S;
    const q = at >= hitT ? ballAt(s, at) : null;
    if (q) samples.push(q);
  }
  return { kind: 'air', pos, alpha, trail: samples, hot: false };
}

/** The local player's charge bar while committed: the charge (0–1) and whether a contact now would be perfect. */
export function chargeBar(s: Readonly<ArcadeState>, viewer: PlayerId | 'spectator'): { charge: number; perfect: boolean } | null {
  if (viewer === 'spectator') return null;
  const commit = s.p[viewer].commit;
  if (commit === null) return null;
  return { charge: chargeAt(commit.tick, s.tick), perfect: rallyGrade(commit.tick, s.tick) === 'perfect' };
}

/** Where the umpire looks: at the ball's end of the court, across while it is near the net. */
function umpireLook(ball: BallView | null, poses: readonly [ArcadePose, ArcadePose], viewer: PlayerId | 'spectator'): -1 | 0 | 1 {
  if (ball === null) return 0;
  const y = ground(ball.kind === 'held' ? poses[ball.player].feet : ball.pos, viewer).y;
  const net = netScreenY();
  if (y < net - UMPIRE_ACROSS_PX) return -1;
  return y > net + UMPIRE_ACROSS_PX ? 1 : 0;
}

/** Top row of the charge bar over a player whose feet are at screen row `feetY`. */
const barTop = (feetY: number): number => Math.round(feetY) - HEAD_PX - HEAD_GAP - BAR.h;

function drawChargeBar(ctx: CanvasRenderingContext2D, at: { x: number; y: number }, bar: { charge: number; perfect: boolean }): void {
  const x = Math.round(at.x) - BAR.w / 2;
  const y = barTop(at.y);
  rect(ctx, x - 1, y - 1, BAR.w + 2, BAR.h + 2, OUTLINE);
  rect(ctx, x, y, BAR.w, BAR.h, PAL.slate);
  const fill = Math.round(BAR.w * bar.charge);
  if (fill > 0) rect(ctx, x, y, fill, BAR.h, bar.perfect ? PAL.white : PAL.gold);
}

function drawPop(ctx: CanvasRenderingContext2D, at: { x: number; y: number }, ageMs: number): void {
  const y = barTop(at.y) - 2 - FONT.cellH - Math.round((POP_RISE * ageMs) / POP_MS);
  shadowText(ctx, POP_TEXT, Math.round(at.x - textWidth(POP_TEXT) / 2), y, PAL.gold);
}

/** Something in the depth-sorted pass: its ground row on screen, its rank on a tie, and how to draw it. */
interface DepthItem { y: number; rank: number; draw: () => void }

/**
 * Draws a running Arcade match (spec §6.1) into the screen's 480×270 buffer and presents it.
 * Layers: backdrop (crowd excitement from the effects, the umpire watching the ball's end) →
 * court, net, umpire → clay marks, contact and ball shadows → players and ball depth-sorted far to
 * near → effects, the local player's charge bar and PERFECT pop → HUD. Everything but the HUD
 * shakes together. Players wear the looks given to `setLooks`, else their own.
 */
export class ArcadeRenderer {
  private readonly screen: Screen;
  private readonly effects = new Effects();
  private readonly fx = new ArcadeFx(this.effects);
  private looks: [Look, Look] | null = null;
  private clockMs = 0;
  private state: Readonly<ArcadeState> | null = null;
  private recent: ArcadeEvent[] = [];
  private popTick: number | null = null;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  /** Dresses players 0 and 1 in `looks` from the next frame on (their sheets are built now). */
  setLooks(looks: [Look, Look]): void {
    this.looks = [{ ...looks[0] }, { ...looks[1] }];
    for (const look of this.looks) buildSheet(look);
  }

  /** Draws the frame of `view`, `dtMs` after the previous one, then presents it. */
  draw(view: ArcadeView, prefs: { reduceEffects: boolean }, dtMs: number): void {
    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    this.clockMs += dt;
    this.remember(view);
    this.fx.consume(view, prefs.reduceEffects, dt);
    const s = view.state;
    const viewer = view.viewer;
    const poses: [ArcadePose, ArcadePose] = [poseAt(s, 0, view.t, viewer), poseAt(s, 1, view.t, viewer)];
    const ball = ballViewAt(s, view.t, poses, viewer, !prefs.reduceEffects);
    const looks = this.looks ?? [s.players[0].look, s.players[1].look];
    // buildSheet keeps the sheets of recent looks (lookCache), so this is a lookup after the first frame.
    const sheets: [SpriteSheet, SpriteSheet] = [buildSheet(looks[0]), buildSheet(looks[1])];

    const g = this.screen.buf;
    const surface = s.config.surface;
    const scene: SceneState = { crowdExcite: this.effects.crowdExcite, umpireLook: umpireLook(ball, poses, viewer), t: this.clockMs };
    const shake = this.effects.shake();
    g.save();
    if (shake.x !== 0 || shake.y !== 0) {
      g.fillStyle = OUTLINE;
      g.fillRect(0, 0, W, H);
      g.translate(shake.x, shake.y);
    }
    drawBackdrop(g, surface, scene);
    drawCourt(g, surface, viewer);
    drawNet(g, surface, viewer);
    drawUmpire(g, scene);
    this.effects.drawGround(g, viewer);
    for (const p of poses) drawContactShadow(g, ground(p.feet, viewer));
    if (ball) drawBallShadow(g, ball, viewer);
    drawActors(g, poses, sheets, ball, viewer);
    this.effects.draw(g, viewer);
    this.drawLocal(g, view, poses);
    g.restore();
    drawArcadeHud(g, view, this.recent, this.clockMs);
    this.screen.present();
  }

  /** Keeps the last 10 s of events (a new session starts afresh) and notes the local player's perfect hits. */
  private remember(view: ArcadeView): void {
    const s = view.state;
    if (s !== this.state) {
      this.state = s;
      this.recent = [];
      this.popTick = null;
    }
    const keepFrom = s.tick - RECENT_TICKS;
    while (this.recent.length > 0 && this.recent[0]!.tick <= keepFrom) this.recent.shift();
    this.recent.push(...view.events);
    for (const e of view.events) {
      if (e.type === 'hit' && e.hit.player === view.viewer && e.hit.grade === 'perfect') this.popTick = e.tick;
    }
  }

  /** The local player's charge bar while committed and the PERFECT pop after their perfect hit. */
  private drawLocal(g: CanvasRenderingContext2D, view: ArcadeView, poses: readonly [ArcadePose, ArcadePose]): void {
    const local = view.viewer;
    if (local === 'spectator') return;
    const at = ground(poses[local].feet, local);
    const bar = chargeBar(view.state, local);
    if (bar) drawChargeBar(g, at, bar);
    if (this.popTick === null) return;
    const age = (view.t - this.popTick * DT) * 1000;
    if (age >= 0 && age < POP_MS) drawPop(g, at, age);
  }
}

/** Players and the ball, far to near by their ground row; a held ball goes on its holder, a ball over a player on a tie. */
function drawActors(
  g: CanvasRenderingContext2D,
  poses: readonly [ArcadePose, ArcadePose],
  sheets: readonly [SpriteSheet, SpriteSheet],
  ball: BallView | null,
  viewer: PlayerId | 'spectator',
): void {
  const items: DepthItem[] = [];
  for (const p of PLAYERS) {
    const pose = poses[p];
    const at = ground(pose.feet, viewer);
    const draw = (): void => {
      drawPlayer(g, sheets[p], pose.anim, pose.view, pose.frame, at.x, at.y, pose.flip);
      if (ball?.kind === 'held' && ball.player === p) drawBall(g, ball, viewer, poses);
    };
    items.push({ y: at.y, rank: 0, draw });
  }
  if (ball?.kind === 'air') items.push({ y: ground(ball.pos, viewer).y, rank: 1, draw: () => drawBall(g, ball, viewer, poses) });
  items.sort((a, b) => a.y - b.y || a.rank - b.rank);
  for (const item of items) item.draw();
}
