import type { PlayerId, Vec2, Vec3 } from '../core/types';
import { OUTLINE, PAL, TIER_COLOR } from './palette';
import { project, scaleAt, viewerEnd } from './projection';
import { CELL, frameIndex, type AnimName, type View } from './sprites/animations';
import { posesFor } from './sprites/poses';

/** Highest drawn ball height (R21): extreme net-clearance arcs are flattened at 6 m. */
export const BALL_MAX_Z = 6;
/** Opacity of the insane trail samples, newest first (power-meter spec §6). */
const HOT_TRAIL_ALPHA = [0.7, 0.5, 0.3, 0.15];
/** Screen distance (px) beyond which a trail sample is drawn: the trail only shows on fast balls. */
const TRAIL_MIN_PX = 2.5;

/**
 * The ball this frame: held in a player's tossing hand, or in the air at a world position with an
 * opacity and a short trail of earlier positions (newest first).
 */
export type BallView =
  | { kind: 'held'; player: PlayerId }
  | { kind: 'air'; pos: Vec3; alpha: number; trail: Vec3[]; hot: boolean };

/** What the ball painter needs of a player pose to place a held ball in the server's hand (a `PlayerPose` fits). */
export interface HandPose { feet: Vec2; anim: AnimName; frame: number; view: View; flip: boolean }

/** Pixel offset from the feet anchor to the centre of the tossing (left) hand in serve frame `i`. */
export function tossHandDx(pose: Pick<HandPose, 'view'>, i: number): number {
  const hand = posesFor('serve', pose.view)[i]!.handL;
  return hand.x + 0.5 - CELL.anchorX;
}

/** `p` with its height capped at `BALL_MAX_Z` (R21). */
export function capBallZ(p: Vec3): Vec3 {
  return p.z > BALL_MAX_Z ? { x: p.x, y: p.y, z: BALL_MAX_Z } : p;
}

/**
 * The tossed ball `z` m high (capped at `BALL_MAX_Z`) above the tossing hand of a server standing
 * in `pose`, as `viewer` sees it, at opacity `alpha`; no trail.
 */
export function tossBallView(pose: Pick<HandPose, 'feet' | 'view'>, z: number, alpha: number, viewer: PlayerId | 'spectator'): BallView {
  const rot = viewerEnd(viewer) === 0 ? 1 : -1;
  const dx = (rot * tossHandDx(pose, 0)) / scaleAt(pose.feet.y, viewer);
  return { kind: 'air', pos: { x: pose.feet.x + dx, y: pose.feet.y, z: Math.min(BALL_MAX_Z, z) }, alpha, trail: [], hot: false };
}

/** Ball sprite (spec §4.1): a 3×3 core with a highlight and a shade pixel inside a 1 px dark outline. */
const BALL_ART = ['.ooo.', 'oHbbo', 'obbbo', 'obbso', '.ooo.'];
const BALL_INK: Record<string, string> = { o: OUTLINE, H: PAL.cream, b: PAL.ball, s: PAL.ballShade };

/** Screen centre of the ball: the air position projected, or just above the holder's tossing hand. */
function ballScreen(ball: BallView, viewer: PlayerId | 'spectator', poses: readonly [HandPose, HandPose]): { x: number; y: number } {
  if (ball.kind === 'air') return project(ball.pos, viewer);
  const pose = poses[ball.player];
  const feet = project({ x: pose.feet.x, y: pose.feet.y, z: 0 }, viewer);
  const hand = posesFor(pose.anim, pose.view)[frameIndex(pose.anim, pose.frame)]!.handL;
  const hx = pose.flip ? CELL.w - 1 - hand.x : hand.x;
  return { x: Math.round(feet.x) - CELL.anchorX + hx + 0.5, y: Math.round(feet.y) - CELL.anchorY + hand.y - 1.5 };
}

/** Draws the ball with its motion trail when fast, or a purple trail for an insane shot when `hotTrail` (Reduce effects off). */
export function drawBall(
  ctx: CanvasRenderingContext2D,
  ball: BallView,
  viewer: PlayerId | 'spectator',
  poses: readonly [HandPose, HandPose],
  hotTrail = false,
): void {
  const at = ballScreen(ball, viewer, poses);
  const cx = Math.round(at.x);
  const cy = Math.round(at.y);
  ctx.save();
  if (ball.kind === 'air') {
    const hot = ball.hot && hotTrail;
    ball.trail.forEach((p, i) => {
      const s = project(p, viewer);
      if (!hot && Math.hypot(s.x - at.x, s.y - at.y) < TRAIL_MIN_PX * (i + 1)) return;
      ctx.globalAlpha = ball.alpha * (hot ? (HOT_TRAIL_ALPHA[i] ?? 0.15) : i === 0 ? 0.5 : 0.25);
      ctx.fillStyle = hot ? TIER_COLOR.insane : i === 0 ? PAL.ball : PAL.ballShade;
      const size = hot ? 3 : 3 - i;
      ctx.fillRect(Math.round(s.x) - 1, Math.round(s.y) - 1, size, size);
    });
    ctx.globalAlpha = ball.alpha;
  }
  BALL_ART.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ink = BALL_INK[row[c]!];
      if (!ink) continue;
      ctx.fillStyle = ink;
      ctx.fillRect(cx - 2 + c, cy - 2 + r, 1, 1);
    }
  });
  ctx.restore();
}

/** Draws the ball's ground shadow, a 3×1 dark dash at z = 0 (spec §4.1); a held ball has none. */
export function drawBallShadow(ctx: CanvasRenderingContext2D, ball: BallView, viewer: PlayerId | 'spectator'): void {
  if (ball.kind !== 'air') return;
  const g = project({ x: ball.pos.x, y: ball.pos.y, z: 0 }, viewer);
  ctx.save();
  ctx.globalAlpha = ball.alpha;
  ctx.fillStyle = OUTLINE;
  ctx.fillRect(Math.round(g.x) - 1, Math.round(g.y), 3, 1);
  ctx.restore();
}
