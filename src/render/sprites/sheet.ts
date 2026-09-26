import type { Look } from '../../core/types';
import { hex } from '../color';
import { OUTLINE, PAL, RAMPS, type Ramp } from '../palette';
import { ANIMS, ANIM_NAMES, CELL, VIEWS, frameIndex, type AnimName, type View } from './animations';
import { RAMP_GROUPS, SLOT, type RampGroup, type RampSource } from './parts';
import { composeFrame } from './rig';

/** Fixed neutral ramp for shoes and strings, light → dark. */
const NEUTRAL: readonly string[] = [PAL.white, PAL.mist, PAL.silver, PAL.grey];

/** Sheet grid: one row per (animation, view), one 48×48 column per frame. */
export const SHEET = (() => {
  const cols = Math.max(...ANIM_NAMES.map((a) => ANIMS[a].frames));
  const rows = ANIM_NAMES.length * VIEWS.length;
  return { cols, rows, w: cols * CELL.w, h: rows * CELL.h };
})();

/** Top-left of a frame's cell in the sheet; the frame number is mapped by `frameIndex`. */
export function cellOrigin(anim: AnimName, view: View, i: number): { sx: number; sy: number } {
  const row = ANIM_NAMES.indexOf(anim) * VIEWS.length + VIEWS.indexOf(view);
  return { sx: frameIndex(anim, i) * CELL.w, sy: row * CELL.h };
}

function rampOf(look: Look, source: RampSource): readonly string[] | null {
  const pick = (table: Ramp[], i: number, field: keyof Look): Ramp => {
    const ramp = table[i];
    if (!ramp) throw new RangeError(`look.${field} ${i} is not a valid ramp index`);
    return ramp;
  };
  switch (source) {
    case 'skin':
      return pick(RAMPS.skin, look.skin, 'skin');
    case 'hair':
      return pick(RAMPS.hair, look.hair, 'hair');
    case 'shirt':
      return pick(RAMPS.cloth, look.shirt, 'shirt');
    case 'shorts':
      return pick(RAMPS.cloth, look.shorts, 'shorts');
    case 'headband':
      return look.headband === null ? null : pick(RAMPS.cloth, look.headband, 'headband');
    case 'racket':
      return pick(RAMPS.racket, look.racket, 'racket');
    case 'neutral':
      return NEUTRAL;
  }
}

/**
 * Colour of every slot for a look (index = slot id); null for clear and see-through pixels.
 * Throws a `RangeError` for a shade beyond its ramp rather than leaving that slot transparent.
 */
export function slotColors(look: Look, groups: readonly RampGroup[] = RAMP_GROUPS): (string | null)[] {
  const colors: (string | null)[] = Array(Math.max(...Object.values(SLOT)) + 1).fill(null);
  colors[SLOT.outline] = OUTLINE;
  for (const g of groups) {
    const ramp = rampOf(look, g.source);
    if (!ramp) continue;
    g.slots.forEach((slot, i) => {
      const shade = g.shades[i];
      const color = shade === undefined ? undefined : ramp[shade];
      if (color === undefined) throw new RangeError(`slot ${slot}: shade ${shade} is beyond its ${g.source} ramp`);
      colors[slot] = color;
    });
  }
  return colors;
}

/** A look's composed sprite sheet and the cell of any frame in it. */
export interface SpriteSheet {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  frame(anim: AnimName, view: View, i: number): { sx: number; sy: number };
}

/** One sheet cell: the frame it holds and its top-left in the sheet. */
interface SheetCell {
  anim: AnimName;
  view: View;
  i: number;
  sx: number;
  sy: number;
}

/** A composed frame (48×48 slot buffer) together with the cell it goes in. */
export interface SheetFrame extends SheetCell {
  buf: Uint8Array;
}

/** Every cell of the sheet in one fixed order: composing and placing frames both walk this list. */
const SHEET_CELLS: readonly SheetCell[] = ANIM_NAMES.flatMap((anim) =>
  VIEWS.flatMap((view) =>
    Array.from({ length: ANIMS[anim].frames }, (_, i) => ({ anim, view, i, ...cellOrigin(anim, view, i) })),
  ),
);

/** Composed frames per head (hair style × headband), shared by every look using it. */
const frameCache = new Map<string, readonly SheetFrame[]>();

/** Every frame of the sheet for one head, each composed for its own cell (cached per head). */
export function sheetFrames(hairStyle: number, headband: boolean): readonly SheetFrame[] {
  const key = `${hairStyle}:${headband}`;
  let frames = frameCache.get(key);
  if (!frames) {
    frames = SHEET_CELLS.map((cell) => ({ ...cell, buf: composeFrame(cell.anim, cell.view, cell.i, hairStyle, headband) }));
    frameCache.set(key, frames);
  }
  return frames;
}

/** Sheets kept at once: the Customize live preview steps through many looks, ~1.2 MB of canvas each. */
const SHEET_CACHE_LOOKS = 8;

/**
 * Memoises `build` per distinct look (property order does not matter), keeping the
 * `SHEET_CACHE_LOOKS` most recently used results and evicting the least recently used first.
 */
export function lookCache<T>(build: (look: Look) => T): (look: Look) => T {
  const cache = new Map<string, T>();
  return (look) => {
    const key = JSON.stringify([look.skin, look.hairStyle, look.hair, look.shirt, look.shorts, look.headband, look.racket]);
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const value = build(look);
    cache.set(key, value);
    if (cache.size > SHEET_CACHE_LOOKS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return value;
  };
}

function newCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  return new OffscreenCanvas(w, h);
}

/** Paints a look's sheet onto a new canvas (browser only). */
function renderSheet(look: Look): SpriteSheet {
  const colors = slotColors(look).map((c) => (c === null ? null : hex(c)));
  const canvas = newCanvas(SHEET.w, SHEET.h);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('buildSheet: no 2D context');
  const image = ctx.createImageData(SHEET.w, SHEET.h);
  for (const { sx, sy, buf } of sheetFrames(look.hairStyle, look.headband !== null)) {
    buf.forEach((slot, p) => {
      const rgb = colors[slot];
      if (!rgb) return;
      const o = ((sy + Math.floor(p / CELL.w)) * SHEET.w + sx + (p % CELL.w)) * 4;
      image.data[o] = rgb[0];
      image.data[o + 1] = rgb[1];
      image.data[o + 2] = rgb[2];
      image.data[o + 3] = 255;
    });
  }
  ctx.putImageData(image, 0, 0);
  return { canvas, frame: cellOrigin };
}

const cachedSheet = lookCache(renderSheet);

/**
 * Builds a look's sheet (80 frames: 40 per view, `runRight` included) in the browser; the sheets
 * of the most recently used looks are kept and returned again (see `lookCache`).
 */
export function buildSheet(look: Look): SpriteSheet {
  return cachedSheet(look);
}

/**
 * Draws a player frame with its feet anchor at (`feetX`, `feetY`) (rounded to whole pixels);
 * `flip` mirrors the cell in place, so the feet stay on the anchor and the racket changes hands.
 * Out-of-range frame numbers wrap or hold as in `frameIndex`.
 */
export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  sheet: SpriteSheet,
  anim: AnimName,
  view: View,
  frame: number,
  feetX: number,
  feetY: number,
  flip = false,
): void {
  const { sx, sy } = sheet.frame(anim, view, frame);
  const x = Math.round(feetX);
  const y = Math.round(feetY) - CELL.anchorY;
  if (!flip) {
    ctx.drawImage(sheet.canvas, sx, sy, CELL.w, CELL.h, x - CELL.anchorX, y, CELL.w, CELL.h);
    return;
  }
  ctx.save();
  ctx.translate(x - CELL.anchorX + CELL.w, y);
  ctx.scale(-1, 1);
  ctx.drawImage(sheet.canvas, sx, sy, CELL.w, CELL.h, 0, 0, CELL.w, CELL.h);
  ctx.restore();
}
