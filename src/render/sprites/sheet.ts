import type { Look } from '../../core/types';
import { hex } from '../color';
import { OUTLINE, PAL, RAMPS, type Ramp } from '../palette';
import { ANIMS, ANIM_NAMES, CELL, VIEWS, frameIndex, type AnimName, type View } from './animations';
import { RAMP_GROUPS, SLOT, type RampSource } from './parts';
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

/** Colour of every slot for a look (index = slot id); null for clear and see-through pixels. */
export function slotColors(look: Look): (string | null)[] {
  const colors: (string | null)[] = Array(Math.max(...Object.values(SLOT)) + 1).fill(null);
  colors[SLOT.outline] = OUTLINE;
  for (const g of RAMP_GROUPS) {
    const ramp = rampOf(look, g.source);
    if (!ramp) continue;
    g.slots.forEach((slot, i) => (colors[slot] = ramp[g.shades[i] ?? 0] ?? null));
  }
  return colors;
}

/** A look's composed sprite sheet and the cell of any frame in it. */
export interface SpriteSheet {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  frame(anim: AnimName, view: View, i: number): { sx: number; sy: number };
}

/** Composed slot buffers per head (hair style × headband), shared by every look using it. */
const frameCache = new Map<string, Uint8Array[]>();
/** Built sheets keyed by the look's JSON. */
const sheetCache = new Map<string, SpriteSheet>();

function framesFor(hairStyle: number, headband: boolean): Uint8Array[] {
  const key = `${hairStyle}:${headband}`;
  let frames = frameCache.get(key);
  if (!frames) {
    frames = [];
    for (const anim of ANIM_NAMES) {
      for (const view of VIEWS) {
        for (let i = 0; i < ANIMS[anim].frames; i++) frames.push(composeFrame(anim, view, i, hairStyle, headband));
      }
    }
    frameCache.set(key, frames);
  }
  return frames;
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

/**
 * Builds a look's sheet (80 frames: 40 per view, `runRight` included) in the browser, once per
 * distinct look; later calls return the cached sheet.
 */
export function buildSheet(look: Look): SpriteSheet {
  const key = JSON.stringify([look.skin, look.hairStyle, look.hair, look.shirt, look.shorts, look.headband, look.racket]);
  const cached = sheetCache.get(key);
  if (cached) return cached;

  const colors = slotColors(look).map((c) => (c === null ? null : hex(c)));
  const canvas = newCanvas(SHEET.w, SHEET.h);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('buildSheet: no 2D context');
  const image = ctx.createImageData(SHEET.w, SHEET.h);
  const frames = framesFor(look.hairStyle, look.headband !== null);
  let n = 0;
  for (const anim of ANIM_NAMES) {
    for (const view of VIEWS) {
      for (let i = 0; i < ANIMS[anim].frames; i++) {
        const buf = frames[n++];
        if (!buf) throw new Error(`buildSheet: missing frame ${anim} ${view} ${i}`);
        const { sx, sy } = cellOrigin(anim, view, i);
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
    }
  }
  ctx.putImageData(image, 0, 0);
  const sheet: SpriteSheet = { canvas, frame: cellOrigin };
  sheetCache.set(key, sheet);
  return sheet;
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
