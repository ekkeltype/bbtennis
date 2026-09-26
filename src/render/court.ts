import { COURT } from '../core/court';
import type { PlayerId, Surface } from '../core/types';
import { hex } from './color';
import { PAL, SURFACE_PAL } from './palette';
import { H, W, project, unprojectGround } from './projection';
import { createLayer, layersPerEnd, type Layer } from './screen';

/**
 * The stadium floor the court layer paints (screen space, the same for every viewer): rows from
 * `top` (the foot of the back walls) down; row y spans columns `edge − y … W − 1 − edge + y`. The
 * side walls (world |x| = 320/27.35 ≈ 11.7 m) run through the vanishing point (240, −80) at 45°.
 */
export const FLOOR = { top: 70, edge: 160 } as const;

/** 0–255 red, green and blue channels of a palette colour. */
export type Rgb = readonly [number, number, number];
/** Colour of the floor pixel (sx, sy), which shows world ground point (x, y) (metres, viewer-rotated). */
type Shader = (x: number, y: number, sx: number, sy: number) => Rgb;

const { doublesHalfWidth: DX, singlesHalfWidth: SX, halfLength: HL, serviceLine: SL } = COURT;

const rgbCache = new Map<string, Rgb>();
/** Channels of the `#RRGGBB` palette colour `c`, parsed once and memoised for the per-pixel painters. */
export function rgb(c: string): Rgb {
  let v = rgbCache.get(c);
  if (!v) rgbCache.set(c, (v = hex(c)));
  return v;
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
function speckle(ramp: readonly string[], sx: number, sy: number, share: number): Rgb {
  const n = hash(sx, sy);
  if (n < share) return rgb(ramp[0]!);
  if (n > 1 - share) return rgb(ramp[ramp.length - 1]!);
  return rgb(ramp[1] ?? ramp[0]!);
}

const inDoubles = (x: number, y: number): boolean => Math.abs(x) <= DX && Math.abs(y) <= HL;

/**
 * Wear behind a baseline, 0–1: strongest just behind the centre mark, fading out over an ellipse of
 * radii (rx, ry) metres with a ragged edge.
 */
function wear(x: number, y: number, sx: number, sy: number, rx: number, ry: number): number {
  const dy = Math.abs(y) - HL - 0.35;
  const r = Math.sqrt((x / rx) ** 2 + (dy / ry) ** 2);
  return Math.min(1, Math.max(0, 1 - r + (hash(sx >> 1, sy) - 0.5) * 0.3));
}

/** True when a pixel with wear `w` shows the worn colour (a noisy dither of the wear amount). */
const worn = (w: number, sx: number, sy: number): boolean => w > 0.08 + hash(sy, sx) * 0.72;

const SHADERS: Record<Surface, Shader> = {
  hard(x, y, sx, sy) {
    const { court, surround, accent } = SURFACE_PAL.hard;
    if (!inDoubles(x, y)) return speckle(surround, sx, sy, 0.04);
    const w = wear(x, y, sx, sy, 2.4, 1.2);
    if (w > 0.3 && hash(sx >> 2, sy * 7) < 0.035) return rgb(accent[0]!);
    if (worn(w * 0.6, sx, sy)) return rgb(court[0]!);
    return speckle(court, sx, sy, 0.035);
  },
  clay(x, y, sx, sy) {
    const { court, surround, accent } = SURFACE_PAL.clay;
    const grain = hash(Math.floor(x / 0.07), Math.floor(y / 0.07));
    if (!inDoubles(x, y) && (Math.abs(x) > DX + 0.6 || Math.abs(y) > HL + 3.2)) {
      return rgb(grain < 0.2 ? surround[1]! : surround[0]!);
    }
    const w = wear(x, y, sx, sy, 3.2, 1.6);
    if (worn(w, sx, sy)) return rgb(w > 0.55 && grain < 0.3 ? accent[0]! : court[0]!);
    if (grain < 0.16) return rgb(court[2]!);
    if (grain > 0.9) return rgb(court[0]!);
    return rgb(court[1]!);
  },
  grass(x, y, sx, sy) {
    const { court, surround, accent } = SURFACE_PAL.grass;
    const stripe = Math.floor((y + HL) / (HL / 6)) & 1;
    const inside = inDoubles(x, y) || (Math.abs(x) <= DX + 1 && Math.abs(y) <= HL + 3);
    if (worn(wear(x, y, sx, sy, 2.8, 1.35) * 0.8, sx, sy)) return rgb(accent[0]!);
    if (hash(sx, sy) < 0.05) return rgb(inside ? court[2]! : surround[1]!);
    return rgb(inside ? court[stripe]! : surround[stripe]!);
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

function dojoShader(x: number, y: number, sx: number, sy: number): Rgb {
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
    if (ax > WOOD_X - dxPx || ay > WOOD_Y - dyPx) return rgb(court[2]!);
    const [p0, p1] = cells(x - dxPx / 2, x + dxPx / 2, PLANK);
    if (p0 !== p1) return rgb(court[2]!);
    const shift = hash(p0, 7) * JOINT;
    const [j0, j1] = cells(y - dyPx / 2 + shift, y + dyPx / 2 + shift, JOINT);
    if (j0 !== j1) return rgb(court[2]!);
    // Plank tones: mostly plain, some a 50 % dither towards the highlight, a few fully light.
    const tone = hash(p0, j0);
    if (tone < 0.1) return rgb(court[0]!);
    if (tone < 0.35) return rgb(checker(sx, sy) ? court[0]! : court[1]!);
    const streak = hash(Math.floor(x / 0.05), Math.floor((y + shift) / 0.7) * 31 + p0) < 0.04;
    return rgb(streak ? court[2]! : court[1]!);
  }
  // Tatami: mats 1.8 m across the court, bound along their long edges with dark cloth.
  const [r0, r1] = cells(y - dyPx / 2 + MAT_D / 2, y + dyPx / 2 + MAT_D / 2, MAT_D);
  if (r0 !== r1) return rgb(accent[0]!);
  const [c0, c1] = cells(x - dxPx / 2 + (r0 & 1) * (MAT_W / 2), x + dxPx / 2 + (r0 & 1) * (MAT_W / 2), MAT_W);
  if (c0 !== c1) return rgb(surround[2]!);
  if ((sy & 1) === 0) return rgb(surround[0]!);
  return rgb(hash(sx, sy) < 0.1 ? surround[2]! : surround[1]!);
}

/** A 1 px court line across the court at world depth `y`, from world x0 to x1. */
function lineAcross(g: CanvasRenderingContext2D, y: number, x0: number, x1: number, end: PlayerId): void {
  const a = project({ x: x0, y, z: 0 }, end);
  const b = project({ x: x1, y, z: 0 }, end);
  const l = Math.floor(Math.min(a.x, b.x));
  const r = Math.floor(Math.max(a.x, b.x));
  g.fillRect(l, Math.floor(a.y), r - l + 1, 1);
}

/** A 1 px court line along the court at world x, from world depth y0 to y1: one pixel per row. */
function lineAlong(g: CanvasRenderingContext2D, x: number, y0: number, y1: number, end: PlayerId): void {
  const r0 = Math.floor(project({ x, y: y0, z: 0 }, end).y);
  const r1 = Math.floor(project({ x, y: y1, z: 0 }, end).y);
  for (let row = Math.min(r0, r1); row <= Math.max(r0, r1); row++) {
    const wy = unprojectGround(W / 2, row + 0.5, end).y;
    g.fillRect(Math.floor(project({ x, y: wy, z: 0 }, end).x), row, 1, 1);
  }
}

function drawLines(g: CanvasRenderingContext2D, color: string, end: PlayerId): void {
  g.fillStyle = color;
  for (const s of [-1, 1]) {
    lineAcross(g, s * HL, -DX, DX, end);
    lineAcross(g, s * SL, -SX, SX, end);
    lineAlong(g, s * DX, -HL, HL, end);
    lineAlong(g, s * SX, -HL, HL, end);
    lineAlong(g, 0, s * HL, s * (HL - 0.15), end);
  }
  lineAlong(g, 0, -SL, SL, end);
}

function paintCourt(surface: Surface, end: PlayerId): Layer {
  const layer = createLayer(W, H);
  const img = layer.g.createImageData(W, H);
  const shade = SHADERS[surface];
  const surround = SURFACE_PAL[surface].surround;
  const contact = rgb(surround[surround.length - 1]!);
  for (let sy = FLOOR.top; sy < H; sy++) {
    const left = FLOOR.edge - sy;
    const right = W - 1 - left;
    for (let sx = Math.max(0, left); sx <= Math.min(W - 1, right); sx++) {
      // Contact shadow where the floor meets the walls: 1 px solid, then 1 px dithered.
      const wall = Math.min(sy - FLOOR.top, sx - left, right - sx);
      const p = unprojectGround(sx + 0.5, sy + 0.5, end);
      const c = wall === 0 || (wall === 1 && checker(sx, sy)) ? contact : shade(p.x, p.y, sx, sy);
      const i = (sy * W + sx) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  }
  layer.g.putImageData(img, 0, 0);
  drawLines(layer.g, SURFACE_PAL[surface].lines, end);
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
