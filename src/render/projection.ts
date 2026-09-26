import { COURT } from '../core/court';
import type { PlayerId, Vec2, Vec3 } from '../core/types';

/** Internal render buffer width in pixels (spec §4.1). */
export const W = 480;
/** Internal render buffer height in pixels (spec §4.1). */
export const H = 270;

/** Pixels per metre at the near baseline (d = 1). */
const FOCAL = 27.35;
const HORIZON = -80;
const DEPTH = 320;
const CENTER_X = W / 2;
const LENGTH = 2 * COURT.halfLength;

/** −1 when `viewer` sees the court rotated 180° (end 1), else +1; spectators watch from end 0. */
function turn(viewer: PlayerId | 'spectator'): 1 | -1 {
  return viewer === 1 ? -1 : 1;
}

function depth(viewY: number): number {
  return 1 + (viewY + COURT.halfLength) / LENGTH;
}

/**
 * Screen position of world point `p` for `viewer` (spec §4.1): `d = 1 + (y + 11.885)/23.77`,
 * `x = 240 + x·27.35/d`, `y = −80 + 320/d − z·27.35/d`, after the end-1 rotation (x, y) → (−x, −y).
 * `d` is the depth factor (1 at the viewer's baseline, 2 at the far one). Unrounded pixels.
 */
export function project(p: Vec3, viewer: PlayerId | 'spectator'): { x: number; y: number; d: number } {
  const s = turn(viewer);
  const d = depth(s * p.y);
  return { x: CENTER_X + (s * p.x * FOCAL) / d, y: HORIZON + DEPTH / d - (p.z * FOCAL) / d, d };
}

/** Ground point (z = 0) seen at screen pixel (sx, sy) by `viewer`; valid below the horizon (sy > −80). */
export function unprojectGround(sx: number, sy: number, viewer: PlayerId | 'spectator'): Vec2 {
  const s = turn(viewer);
  const d = DEPTH / (sy - HORIZON);
  const x = ((sx - CENTER_X) * d) / FOCAL;
  const y = (d - 1) * LENGTH - COURT.halfLength;
  return { x: s * x, y: s * y };
}

/** Pixels per metre (horizontally, and vertically for heights) at world court depth `y` for `viewer`. */
export function scaleAt(y: number, viewer: PlayerId | 'spectator'): number {
  return FOCAL / depth(turn(viewer) * y);
}

/** Screen y of the net's foot line (world y = 0); the same for every viewer (≈ 133.3). */
export function netScreenY(): number {
  return HORIZON + DEPTH / depth(0);
}
