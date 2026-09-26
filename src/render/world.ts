import { turnViewAt, type TurnView } from '../core/turnView';
import type { PlayerId, PublicState, TurnState, Vec2, ViewModel } from '../core/types';
import { drawBall, drawBallShadow, type BallView } from './ball';
import { checker, drawCourt } from './court';
import type { Effects } from './effects';
import { OUTLINE, PAL } from './palette';
import { drawTierRing } from './plates';
import type { PlayerPose } from './players';
import { netScreenY, project, viewerEnd } from './projection';
import type { RingMark } from './prompts';
import { drawBackdrop, drawNet, drawUmpire, type SceneState } from './scene';
import { drawPlayer, type SpriteSheet } from './sprites/sheet';

// ---------------------------------------------------------------------------------------------
// The frame: which turn the viewer sees, at which τ.

/**
 * What the viewer sees this frame (spec §5.2): the turn to draw at τ and its view, the previous turn
 * carried on past its end by the same amount (the next turn starts at the previous one's end), the
 * time since the match ended (`overMs`, while there is no turn), the near player (the viewer's end,
 * player 0 for spectators) and the viewer's own player (null for spectators).
 */
export interface WorldFrame {
  vm: ViewModel;
  pub: PublicState;
  turn: TurnState | null;
  τ: number;
  view: TurnView | null;
  last: { turn: TurnState; view: TurnView } | null;
  overMs: number;
  near: PlayerId;
  local: PlayerId | null;
}

/**
 * The frame for `vm`: the viewer's live turn at its own τ when it runs one, otherwise the public
 * turn at `vm.turnτ` (Task 18 ruling 1). `overMs` is how long the match has been over.
 */
export function worldFrame(vm: ViewModel, overMs = 0): WorldFrame {
  const turn = vm.liveTurn ?? vm.pub.turn;
  const τ = vm.liveTurn ? vm.liveTurn.τ : vm.turnτ;
  const lt = vm.pub.lastTurn;
  const endτ = lt?.ended && lt.outcome ? lt.outcome.endτ : null;
  return {
    vm,
    pub: vm.pub,
    turn,
    τ,
    view: turn ? turnViewAt(turn, τ) : null,
    last: lt && endτ !== null ? { turn: lt, view: turnViewAt(lt, endτ + (turn ? τ : overMs)) } : null,
    overMs,
    near: viewerEnd(vm.viewer),
    local: vm.viewer === 'spectator' ? null : vm.viewer,
  };
}

/** True while the viewer owns the current turn and has a prompt to type (and the game is not paused). */
export function localActive(f: WorldFrame): boolean {
  const { overlay } = f.vm;
  if (overlay.paused || overlay.countdown !== null) return false;
  return f.local !== null && f.turn?.data.owner === f.local && f.view?.active !== null && f.view?.active !== undefined;
}

/** Screen point of the ground under `p` for the frame's viewer. */
export function groundAt(f: WorldFrame, p: Vec2): { x: number; y: number } {
  return project({ x: p.x, y: p.y, z: 0 }, f.vm.viewer);
}

// ---------------------------------------------------------------------------------------------
// Scene and actors: backdrop → court → net → shadows → players/ball and ground rings → effects (spec §4.1).

/**
 * What `drawWorld` paints on top of the scene: poses, ball, the prompt layer's ground rings (depth-sorted
 * with the players, R33), the players' sheets, effects and the scene clock.
 */
export interface WorldActors {
  poses: readonly [PlayerPose, PlayerPose];
  ball: BallView | null;
  rings: readonly RingMark[];
  sheets: readonly [SpriteSheet, SpriteSheet];
  effects: Effects;
  clockMs: number;
}

/** Screen rows above/below the net line inside which the umpire looks across the court. */
const UMPIRE_ACROSS_PX = 12;

/** Where the umpire looks (spec §4.1 scene): at the ball's end of the court, across while it is near the net. */
export function umpireLook(ball: BallView | null, poses: readonly [PlayerPose, PlayerPose], f: WorldFrame): -1 | 0 | 1 {
  if (ball === null) return 0;
  const y = groundAt(f, ball.kind === 'held' ? poses[ball.player].feet : ball.pos).y;
  const net = netScreenY();
  if (y < net - UMPIRE_ACROSS_PX) return -1;
  return y > net + UMPIRE_ACROSS_PX ? 1 : 0;
}

/** Contact shadow under the feet (rows from the anchor row − 1), 50 % checker-dithered: [dx from, dx to]. */
const SHADOW: readonly [number, number][] = [
  [-6, 6],
  [-8, 8],
  [-6, 6],
];

/** The pulsing ring under the local player's feet (two sizes), as rows of '#' centred on the feet. */
const ACTIVE_RING: readonly (readonly string[])[] = [
  ['....#######....', '.##.........##.', '#.............#', '.##.........##.', '....#######....'],
  ['......#######......', '...###.......###...', '.##.............##.', '#.................#', '.##.............##.', '...###.......###...', '......#######......'],
];
const RING_PULSE_MS = 260;

function paintRows(ctx: CanvasRenderingContext2D, rows: readonly string[], cx: number, cy: number, color: string): void {
  const x0 = cx - (rows[0]!.length - 1) / 2;
  const y0 = cy - (rows.length - 1) / 2;
  ctx.fillStyle = color;
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) if (row[c] === '#') ctx.fillRect(x0 + c, y0 + r, 1, 1);
  });
}

function drawShadow(ctx: CanvasRenderingContext2D, at: { x: number; y: number }): void {
  const x = Math.round(at.x);
  const y = Math.round(at.y);
  ctx.fillStyle = OUTLINE;
  SHADOW.forEach(([from, to], r) => {
    for (let dx = from; dx <= to; dx++) if (checker(x + dx, y + r - 1)) ctx.fillRect(x + dx, y + r - 1, 1, 1);
  });
}

/** Something in the depth-sorted pass: its ground row on screen, its rank on a tie and how to draw it. */
interface DepthItem { y: number; rank: number; draw: () => void }

/** Tie order on the same ground row: a ring lies under a player standing on it; the ball passes over both. */
const RANK = { ring: 0, player: 1, ball: 2 } as const;
const PLAYERS = [0, 1] as const;

function drawRing(ctx: CanvasRenderingContext2D, r: RingMark): void {
  ctx.save();
  ctx.globalAlpha = r.alpha;
  drawTierRing(ctx, r.tier, r.x, r.y);
  ctx.restore();
}

/**
 * Players, the ball and the ground rings, far to near by their ground row (spec §4.1, R33): a player
 * whose feet are nearer the camera than a ring occludes it. A held ball goes on its holder.
 */
function drawActors(ctx: CanvasRenderingContext2D, f: WorldFrame, a: WorldActors): void {
  const viewer = f.vm.viewer;
  const ball = a.ball;
  const items: DepthItem[] = [];
  for (const r of a.rings) if (r.alpha > 0) items.push({ y: r.y, rank: RANK.ring, draw: () => drawRing(ctx, r) });
  for (const p of PLAYERS) {
    const pose = a.poses[p];
    const at = groundAt(f, pose.feet);
    const draw = (): void => {
      drawPlayer(ctx, a.sheets[p], pose.anim, pose.view, pose.frame, at.x, at.y, pose.flip);
      if (ball?.kind === 'held' && ball.player === p) drawBall(ctx, ball, viewer, a.poses);
    };
    items.push({ y: at.y, rank: RANK.player, draw });
  }
  if (ball?.kind === 'air') items.push({ y: groundAt(f, ball.pos).y, rank: RANK.ball, draw: () => drawBall(ctx, ball, viewer, a.poses) });
  items.sort((i, j) => i.y - j.y || i.rank - j.rank);
  for (const item of items) item.draw();
}

/**
 * Paints the world layers (spec §4.1): stadium, court, net and the umpire's chair, then shadows (clay
 * marks, the local player's pulsing ring, player and ball shadows), the players, the ball and the
 * ground rings depth-sorted far to near, and the effects.
 */
export function drawWorld(ctx: CanvasRenderingContext2D, f: WorldFrame, a: WorldActors): void {
  const viewer = f.vm.viewer;
  const surface = f.pub.config.surface;
  const scene: SceneState = { crowdExcite: a.effects.crowdExcite, umpireLook: umpireLook(a.ball, a.poses, f), t: a.clockMs };
  drawBackdrop(ctx, surface, scene);
  drawCourt(ctx, surface, viewer);
  drawNet(ctx, surface, viewer);
  // The umpire's chair stands on the court surround, so it goes on top of the court and net layers.
  drawUmpire(ctx, scene);
  a.effects.drawGround(ctx, viewer);
  if (localActive(f) && f.local !== null) {
    const at = groundAt(f, a.poses[f.local].feet);
    const ring = ACTIVE_RING[Math.floor(a.clockMs / RING_PULSE_MS) % 2]!;
    paintRows(ctx, ring, Math.round(at.x), Math.round(at.y), PAL.white);
  }
  for (const p of a.poses) drawShadow(ctx, groundAt(f, p.feet));
  if (a.ball) drawBallShadow(ctx, a.ball, viewer);
  drawActors(ctx, f, a);
  a.effects.draw(ctx, viewer);
}
