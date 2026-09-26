import { COURT } from '../core/court';
import type { PlayerId, Surface } from '../core/types';
import { hex } from './color';
import { PAL, SURFACE_PAL } from './palette';
import { H, W, project, scaleAt, unprojectGround } from './projection';
import { createLayer, layersPerEnd, type Layer } from './screen';

/**
 * The stadium floor the court layer paints (screen space, the same for every viewer): rows from
 * `top` (the foot of the back walls) down; row y spans columns `edge − y … W − 1 − edge + y`. The
 * side walls (world |x| = 320/27.35 ≈ 11.7 m) run through the vanishing point (240, −80) at 45°.
 */
export const FLOOR = { top: 70, edge: 160 } as const;

/** 0–255 red, green and blue channels of a palette colour. */
export type Rgb = readonly [number, number, number];
/** Palette colour of the floor pixel (sx, sy), which shows world ground point (x, y) (metres, viewer-rotated). */
type Shader = (x: number, y: number, sx: number, sy: number) => string;

const { doublesHalfWidth: DX, singlesHalfWidth: SX, halfLength: HL, serviceLine: SL } = COURT;

const rgbCache = new Map<string, Rgb>();
/** Channels of the `#RRGGBB` palette colour `c`, parsed once and memoised for the per-pixel painters. */
export function rgb(c: string): Rgb {
  let v = rgbCache.get(c);
  if (!v) rgbCache.set(c, (v = hex(c)));
  return v;
}

/** A palette colour as one opaque pixel of a little-endian `Uint32Array` view of ImageData. */
export function packed(c: string): number {
  const [r, g, b] = rgb(c);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Paints pixel-art `rows` with its top-left at (x0, y0): one pixel per character in `legend`'s colour; '.' is clear. */
export function paintGrid(
  g: CanvasRenderingContext2D,
  rows: readonly string[],
  legend: Record<string, string>,
  x0: number,
  y0: number,
): void {
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row[c]!;
      if (ch === '.') continue;
      g.fillStyle = legend[ch]!;
      g.fillRect(x0 + c, y0 + r, 1, 1);
    }
  });
}

/** Deterministic hash of two integers into [0, 1). */
function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e3779b9, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** True where the 2×2 checker (50 % dither) is on at screen pixel (sx, sy). */
export const checker = (sx: number, sy: number): boolean => ((sx + sy) & 1) === 0;

/** Screen-space speckle: `lo` or `hi` on a small share of pixels, `mid` elsewhere. */
function speckle(ramp: readonly string[], sx: number, sy: number, share: number): string {
  const n = hash(sx, sy);
  if (n < share) return ramp[0]!;
  if (n > 1 - share) return ramp[ramp.length - 1]!;
  return ramp[1] ?? ramp[0]!;
}

const inDoubles = (x: number, y: number): boolean => Math.abs(x) <= DX && Math.abs(y) <= HL;

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** Smooth value noise in [0, 1): hashed lattice values every (cx, cy) metres, blended with smoothstep. */
function valueNoise(x: number, y: number, cx: number, cy: number, seed: number): number {
  const gx = x / cx;
  const gy = y / cy;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const u = smoothstep(gx - ix);
  const v = smoothstep(gy - iy);
  const at = (i: number, j: number): number => hash(i, j * 131 + seed);
  const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * u;
  const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * u;
  return top + (bottom - top) * v;
}

/** Radii (metres) of a baseline wear ellipse. */
interface WearShape { rx: number; ry: number }

/**
 * Wear behind a baseline: about 1 just behind the centre mark, falling to about 0 on an ellipse of
 * radii (rx, ry) metres. Smooth noise (±0.3) stretched along the baseline, the way players slide,
 * makes the rim wobble in soft, coherent curves, different at each end.
 */
function wear(x: number, y: number, { rx, ry }: WearShape): number {
  const dy = Math.abs(y) - HL - 0.35;
  const r = Math.sqrt((x / rx) ** 2 + (dy / ry) ** 2);
  return 1 - r + (valueNoise(x, dy, 0.8, 0.3, y > 0 ? 1 : 2) - 0.5) * 0.6;
}

/** True when a pixel with wear `w` shows the worn colour (a noisy dither of the wear amount). */
const worn = (w: number, sx: number, sy: number): boolean => w > 0.08 + hash(sy, sx) * 0.72;

const HARD_WEAR: WearShape = { rx: 2.4, ry: 1.2 };

/**
 * Worn baseline patches on clay and grass: the wear ellipse and two solid tones, the fringe (wear
 * above `FRINGE`) and the core (above `CORE`), so each patch reads as one soft, coherent shape.
 */
const PATCH: Record<'clay' | 'grass', WearShape & { fringe: string; core: string }> = {
  clay: { rx: 2.2, ry: 0.9, fringe: PAL.clayHi, core: SURFACE_PAL.clay.accent[0]! },
  grass: { rx: 2.0, ry: 0.85, fringe: PAL.tatamiLo, core: SURFACE_PAL.grass.accent[0]! },
};
const FRINGE = 0.15;
const CORE = 0.55;

/** The worn-patch tone at world point (x, y), or null where the surface is unworn. */
function patchTone(surface: 'clay' | 'grass', x: number, y: number): string | null {
  const patch = PATCH[surface];
  const w = wear(x, y, patch);
  if (w > CORE) return patch.core;
  return w > FRINGE ? patch.fringe : null;
}

const SHADERS: Record<Surface, Shader> = {
  hard(x, y, sx, sy) {
    const { court, surround } = SURFACE_PAL.hard;
    if (!inDoubles(x, y)) return speckle(surround, sx, sy, 0.04);
    if (worn(wear(x, y, HARD_WEAR) * 0.6, sx, sy)) return court[0]!;
    return speckle(court, sx, sy, 0.035);
  },
  clay(x, y) {
    const { court, surround } = SURFACE_PAL.clay;
    const grain = hash(Math.floor(x / 0.07), Math.floor(y / 0.07));
    if (!inDoubles(x, y) && (Math.abs(x) > DX + 0.6 || Math.abs(y) > HL + 3.2)) {
      return grain < 0.2 ? surround[1]! : surround[0]!;
    }
    const tone = patchTone('clay', x, y);
    if (tone) return tone;
    if (grain < 0.16) return court[2]!;
    if (grain > 0.9) return court[0]!;
    return court[1]!;
  },
  grass(x, y, sx, sy) {
    const { court, surround } = SURFACE_PAL.grass;
    const tone = patchTone('grass', x, y);
    if (tone) return tone;
    const stripe = Math.floor((y + HL) / (HL / 6)) & 1;
    const inside = inDoubles(x, y) || (Math.abs(x) <= DX + 1 && Math.abs(y) <= HL + 3);
    if (hash(sx, sy) < 0.05) return inside ? court[2]! : surround[1]!;
    return inside ? court[stripe]! : surround[stripe]!;
  },
  dojo: dojoShader,
};

const PLANK = 0.62;
const JOINT = 4.6;
const MAT_W = 1.8;
const MAT_D = 0.9;
const WOOD_X = DX + 1.3;
const WOOD_Y = HL + 2.2;

/** Index of the world cell of size `size` containing `v`, for the pixel's two edges (straddle test). */
function cells(v0: number, v1: number, size: number): [number, number] {
  return [Math.floor(v0 / size), Math.floor(v1 / size)];
}

function dojoShader(x: number, y: number, sx: number, sy: number): string {
  const { court, surround, accent } = SURFACE_PAL.dojo;
  // World size of this pixel across and along the court (for 1 px seams); equal for both ends.
  const a = unprojectGround(sx, sy + 0.5, 0);
  const b = unprojectGround(sx + 1, sy + 0.5, 0);
  const dxPx = Math.abs(b.x - a.x);
  const top = unprojectGround(sx + 0.5, sy, 0).y;
  const bottom = unprojectGround(sx + 0.5, sy + 1, 0).y;
  const dyPx = Math.abs(top - bottom);
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax <= WOOD_X && ay <= WOOD_Y) {
    if (ax > WOOD_X - dxPx || ay > WOOD_Y - dyPx) return court[2]!;
    const [p0, p1] = cells(x - dxPx / 2, x + dxPx / 2, PLANK);
    if (p0 !== p1) return court[2]!;
    const shift = hash(p0, 7) * JOINT;
    const [j0, j1] = cells(y - dyPx / 2 + shift, y + dyPx / 2 + shift, JOINT);
    if (j0 !== j1) return court[2]!;
    // Plank tones, each solid: mostly plain wood with sparse grain streaks, some light planks.
    if (hash(p0, j0) < 0.2) return court[0]!;
    const streak = hash(Math.floor(x / 0.05), Math.floor((y + shift) / 0.7) * 31 + p0) < 0.04;
    return streak ? court[2]! : court[1]!;
  }
  // Tatami: mats 1.8 m across the court, bound along their long edges with dark cloth.
  const [r0, r1] = cells(y - dyPx / 2 + MAT_D / 2, y + dyPx / 2 + MAT_D / 2, MAT_D);
  if (r0 !== r1) return accent[0]!;
  const [c0, c1] = cells(x - dxPx / 2 + (r0 & 1) * (MAT_W / 2), x + dxPx / 2 + (r0 & 1) * (MAT_W / 2), MAT_W);
  if (c0 !== c1) return surround[2]!;
  if ((sy & 1) === 0) return surround[0]!;
  return hash(sx, sy) < 0.1 ? surround[2]! : surround[1]!;
}

/** The 1 px court lines for `end` as a W×H mask (1 = line pixel), crisp and unaliased (spec §4.1). */
function lineMask(end: PlayerId): Uint8Array {
  const mask = new Uint8Array(W * H);
  const set = (x: number, y: number): void => {
    if (x >= 0 && x < W && y >= 0 && y < H) mask[y * W + x] = 1;
  };
  // Across the court at world depth y, from world x0 to x1.
  const across = (y: number, x0: number, x1: number): void => {
    const a = project({ x: x0, y, z: 0 }, end);
    const b = project({ x: x1, y, z: 0 }, end);
    const row = Math.floor(a.y);
    for (let x = Math.floor(Math.min(a.x, b.x)); x <= Math.floor(Math.max(a.x, b.x)); x++) set(x, row);
  };
  // Along the court at world x, from depth y0 to y1: one pixel per row.
  const along = (x: number, y0: number, y1: number): void => {
    const r0 = Math.floor(project({ x, y: y0, z: 0 }, end).y);
    const r1 = Math.floor(project({ x, y: y1, z: 0 }, end).y);
    for (let row = Math.min(r0, r1); row <= Math.max(r0, r1); row++) {
      const wy = unprojectGround(W / 2, row + 0.5, end).y;
      set(Math.floor(project({ x, y: wy, z: 0 }, end).x), row);
    }
  };
  for (const s of [-1, 1]) {
    across(s * HL, -DX, DX);
    across(s * SL, -SX, SX);
    along(s * DX, -HL, HL);
    along(s * SX, -HL, HL);
    along(0, s * HL, s * (HL - 0.15));
  }
  along(0, -SL, SL);
  return mask;
}

/** True when `mask` has a pixel set inside the screen rectangle x0…x1 × y0…y1 (clipped to the screen). */
function anyIn(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number): boolean {
  for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) if (mask[y * W + x]) return true;
  }
  return false;
}

/**
 * Shoe scuffs on the hard court, fixed in the world: [x, metres inside the baseline] for the
 * baseline at y < 0 and the one at y > 0. Each lies deep enough to clear the baseline at both scales.
 */
const SCUFFS: Record<-1 | 1, readonly (readonly [number, number])[]> = {
  [-1]: [[-1.5, 1.0], [0.8, 1.3], [2.1, 1.05]],
  [1]: [[-2.0, 1.1], [-0.6, 1.4], [1.4, 1.0]],
};

/** Paints the scuffs as 1 px dashes 0.15 m long (at least 2 px), skipping any within 2 px of a line. */
function paintScuffs(px: Uint32Array, lines: Uint8Array, end: PlayerId): void {
  const scuff = packed(SURFACE_PAL.hard.accent[0]!);
  for (const side of [-1, 1] as const) {
    for (const [x, inside] of SCUFFS[side]) {
      const y = side * (HL - inside);
      const at = project({ x, y, z: 0 }, end);
      const len = Math.max(2, Math.round(0.15 * scaleAt(y, end)));
      const x0 = Math.round(at.x - len / 2);
      const row = Math.floor(at.y);
      if (anyIn(lines, x0 - 2, row - 2, x0 + len + 1, row + 2)) continue;
      px.fill(scuff, row * W + x0, row * W + x0 + len);
    }
  }
}

function paintCourt(surface: Surface, end: PlayerId): Layer {
  const layer = createLayer(W, H);
  const img = layer.g.createImageData(W, H);
  const px = new Uint32Array(img.data.buffer);
  const shade = SHADERS[surface];
  const surround = SURFACE_PAL[surface].surround;
  const contact = packed(surround[surround.length - 1]!);
  for (let sy = FLOOR.top; sy < H; sy++) {
    const left = FLOOR.edge - sy;
    const right = W - 1 - left;
    for (let sx = Math.max(0, left); sx <= Math.min(W - 1, right); sx++) {
      // Contact shadow where the floor meets the walls: a solid 2 px band.
      const wall = Math.min(sy - FLOOR.top, sx - left, right - sx);
      const p = unprojectGround(sx + 0.5, sy + 0.5, end);
      px[sy * W + sx] = wall <= 1 ? contact : packed(shade(p.x, p.y, sx, sy));
    }
  }
  const lines = lineMask(end);
  if (surface === 'hard') paintScuffs(px, lines, end);
  const line = packed(SURFACE_PAL[surface].lines);
  lines.forEach((on, i) => {
    if (on) px[i] = line;
  });
  layer.g.putImageData(img, 0, 0);
  return layer;
}

const courtLayer = layersPerEnd(paintCourt);

/**
 * Paints the stadium floor for `surface` as `viewer` sees it: surround, court surface texture and
 * crisp 1 px lines (spec §4.1). Painted once per (surface, viewer end) into an offscreen layer;
 * later calls are a single blit. Rows above `FLOOR.top` and the side stands stay untouched.
 */
export function drawCourt(ctx: CanvasRenderingContext2D, surface: Surface, viewer: PlayerId | 'spectator'): void {
  ctx.drawImage(courtLayer(surface, viewer).canvas, 0, 0);
}
