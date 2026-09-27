import { ballAt, tossZ } from '../core/trajectory';
import { turnViewAt, type TurnView } from '../core/turnView';
import type { BallFlight, PlayerId, ServeTurnData, TurnState, Vec3 } from '../core/types';
import { OUTLINE, PAL, TIER_COLOR } from './palette';
import type { PlayerPose } from './players';
import { project, scaleAt, viewerEnd } from './projection';
import { CELL, frameIndex } from './sprites/animations';
import { posesFor } from './sprites/poses';
import type { WorldFrame } from './world';

/** Highest drawn ball height (R21): extreme net-clearance arcs are flattened at 6 m. */
export const BALL_MAX_Z = 6;
/** A ball that has been called, has passed or was dropped fades out over this long (R21). */
export const BALL_FADE_MS = 300;
/** Motion trail: positions this many ms apart behind the ball. */
const TRAIL_STEP_MS = 16;
const TRAIL_SAMPLES = 2;
/** The insane trail: more samples, drawn in the insane colour at falling opacity (power-meter spec §6). */
const HOT_TRAIL_SAMPLES = 4;
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

const held = (player: PlayerId): BallView => ({ kind: 'held', player });

const capped = (p: Vec3): Vec3 => (p.z > BALL_MAX_Z ? { x: p.x, y: p.y, z: BALL_MAX_Z } : p);

/** The ball `t` ms along `flight` (height capped), with its trail: 4 hot samples for an insane shot, else 2. */
export function flightBall(flight: BallFlight, t: number, alpha: number): BallView {
  const hot = flight.tier === 'insane';
  const trail: Vec3[] = [];
  for (let i = 1; i <= (hot ? HOT_TRAIL_SAMPLES : TRAIL_SAMPLES); i++) trail.push(capped(ballAt(flight, t - i * TRAIL_STEP_MS)));
  return { kind: 'air', pos: capped(ballAt(flight, t)), alpha, trail, hot };
}

/** Opacity `sinceEnd` ms after a call, pass or drop; null once faded out. */
function fading(sinceEnd: number): number | null {
  const alpha = 1 - Math.max(0, sinceEnd) / BALL_FADE_MS;
  return alpha > 0 ? alpha : null;
}

/** Pixel offset from the feet anchor to the centre of the tossing (left) hand in serve frame `i`. */
function tossHandDx(pose: PlayerPose, i: number): number {
  const hand = posesFor('serve', pose.view)[i]!.handL;
  return hand.x + 0.5 - CELL.anchorX;
}

/** The tossed ball above the server's tossing hand, `tossZ` high (spec §3.2.3). */
function tossBall(
  d: ServeTurnData,
  t: TurnState,
  v: TurnView,
  pose: PlayerPose,
  f: WorldFrame,
  alpha: number,
): BallView {
  if (v.tossAt === null) return held(d.owner);
  const since = v.simτ - turnViewAt(t, v.tossAt).simτ;
  const viewer = f.vm.viewer;
  const rot = viewerEnd(viewer) === 0 ? 1 : -1;
  const dx = (rot * tossHandDx(pose, 0)) / scaleAt(pose.feet.y, viewer);
  const z = Math.min(BALL_MAX_Z, tossZ(since, d.tossApexMs * d.pace));
  return { kind: 'air', pos: { x: pose.feet.x + dx, y: pose.feet.y, z }, alpha, trail: [], hot: false };
}

/** The previous turn's ball carried on past its end and fading out (serve lead-ins, match end). */
function lastBall(f: WorldFrame, poses: readonly [PlayerPose, PlayerPose]): BallView | null {
  const last = f.last;
  const o = last?.view.outcome;
  if (!last || !o) return null;
  const alpha = fading(last.view.τ - o.endτ);
  if (alpha === null) return null;
  const d = last.turn.data;
  if (d.kind === 'return') return flightBall(d.incoming, last.view.simτ, alpha);
  if (o.kind === 'fault' && o.reason === 'ballDropped') return tossBall(d, last.turn, last.view, poses[d.owner], f, alpha);
  return null;
}

/**
 * Where the ball is this frame (Task 18 ruling 2). Serve turn: in the server's hand before the toss
 * and while catching, on the toss arc during the toss, dropping (and fading) on a ball-dropped fault;
 * during a lead-in the previous turn's ball continues and fades out 300 ms after its call or pass
 * (the first serve of the match starts in hand). Return turn: the incoming flight at the turn's
 * simulation time, fading after its call or pass. After any strike: the outgoing flight at
 * τ − strike τ. Heights are capped at 6 m.
 */
export function ballView(f: WorldFrame, poses: readonly [PlayerPose, PlayerPose]): BallView | null {
  const { turn, view } = f;
  if (!turn || !view) return lastBall(f, poses);
  if (view.strike) return flightBall(view.strike.flight, f.τ - view.strike.τ, 1);
  const d = turn.data;
  if (d.kind === 'return') {
    const alpha = view.outcome ? fading(f.τ - view.outcome.endτ) : 1;
    return alpha === null ? null : flightBall(d.incoming, view.simτ, alpha);
  }
  switch (view.phase) {
    case 'leadIn': {
      const lt = f.last?.turn;
      if (d.leadIn.kind === 'intro' || d.leadIn.kind === 'none' || !lt) return held(d.owner);
      const o = lt.outcome;
      const keptInHand = lt.data.kind === 'serve' && o?.kind === 'fault' && o.reason === 'timeViolation';
      return keptInHand && lt.data.owner === d.owner ? held(d.owner) : lastBall(f, poses);
    }
    case 'toss':
      return tossBall(d, turn, view, poses[d.owner], f, 1);
    case 'ended': {
      const o = view.outcome;
      if (o?.kind !== 'fault' || o.reason !== 'ballDropped') return held(d.owner);
      const alpha = fading(f.τ - o.endτ);
      return alpha === null ? null : tossBall(d, turn, view, poses[d.owner], f, alpha);
    }
    default:
      return held(d.owner);
  }
}

/** Ball sprite (spec §4.1): a 3×3 core with a highlight and a shade pixel inside a 1 px dark outline. */
const BALL_ART = ['.ooo.', 'oHbbo', 'obbbo', 'obbso', '.ooo.'];
const BALL_INK: Record<string, string> = { o: OUTLINE, H: PAL.cream, b: PAL.ball, s: PAL.ballShade };

/** Screen centre of the ball: the air position projected, or just above the holder's tossing hand. */
function ballScreen(ball: BallView, viewer: PlayerId | 'spectator', poses: readonly [PlayerPose, PlayerPose]): { x: number; y: number } {
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
  poses: readonly [PlayerPose, PlayerPose],
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
