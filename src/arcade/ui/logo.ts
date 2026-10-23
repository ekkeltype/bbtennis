import { FONT, GLYPHS } from '../../render/font';
import { RAMPS } from '../../render/palette';
import { LOGO_H, LOGO_W, paintLogo } from '../../ui/logo';
import { rect } from '../../ui/paint';

/** Logo pixels added right of the game's logo for the stamp to hang into (arcade.css widens the canvas to match). */
export const STAMP_ROOM = 10;

/**
 * The rubber stamp (spec §6.3): its word; frame and padding (logo pixels); tilt (degrees, negative
 * rises to the right); centre on the logo, on the right end of the belt, clear of "BELT" and
 * "TENNIS"; and the wear of its frame (`stampPixels`).
 */
const STAMP = { word: 'ARCADE', frame: 2, pad: 2, tilt: -10, x: 116, y: 29, wear: 0.3 } as const;

/** Stamp ink from the red cloth ramp: full, and faint where the stamp pressed lightly. */
const INK = { full: RAMPS.cloth[5]![1], faint: RAMPS.cloth[5]![2] } as const;

/** One pixel of the stamp on the Arcade's logo canvas. */
export interface StampPixel {
  x: number;
  y: number;
  faint: boolean;
}

/** A fixed pseudo-random value in [0, 1) for pixel (x, y) of the flat stamp: the grain of its ink. */
function grain(x: number, y: number): number {
  let h = Math.imul(x + 1, 0x27d4eb2d) ^ Math.imul(y + 1, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 2 ** 32;
}

type Px = [x: number, y: number];

/** The flat stamp, w×h: a frame with clipped corners around the word's letters, bold capitals (strokes 1 px wider, 1 px apart). */
function flatStamp(): { w: number; h: number; frame: Px[]; letters: Px[] } {
  const glyphs = [...STAMP.word].map((ch) => GLYPHS[ch]!);
  const inset = STAMP.frame + STAMP.pad;
  const w = glyphs.reduce((sum, g) => sum + g.w + 2, -1) + 2 * inset;
  const h = FONT.capHeight + 2 * inset;
  const frame: Px[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const corner = (x === 0 || x === w - 1) && (y === 0 || y === h - 1);
      if (!corner && Math.min(x, y, w - 1 - x, h - 1 - y) < STAMP.frame) frame.push([x, y]);
    }
  }
  const letters: Px[] = [];
  let left = inset;
  for (const g of glyphs) {
    // Capitals fill glyph rows 1..capHeight (row 0 is headroom).
    for (let r = 0; r < FONT.capHeight; r++) {
      const row = g.rows[r + 1]!;
      for (let x = 0; x <= g.w; x++) {
        if (row[x] === '#' || row[x - 1] === '#') letters.push([left + x, inset + r]);
      }
    }
    left += g.w + 2;
  }
  return { w, h, frame, letters };
}

/**
 * Turns pixel (x, y) of a w×h image by `deg` about its centre with three shears, each moving whole
 * rows or columns by whole pixels: no pixel is lost or doubled, so the letters stay crisp. Returns
 * the pixel's offset from the centre.
 */
function turn(x: number, y: number, w: number, h: number, deg: number): [dx: number, dy: number] {
  const t = (deg * Math.PI) / 180;
  const shearX = -Math.tan(t / 2);
  const shearY = Math.sin(t);
  let u = x + 0.5 - w / 2;
  let v = y + 0.5 - h / 2;
  u += Math.round(shearX * v);
  v += Math.round(shearY * u);
  u += Math.round(shearX * v);
  return [Math.floor(u), Math.floor(v)];
}

/**
 * The stamp's pixels on the Arcade's logo canvas, tilted and placed. About `wear` of the frame's
 * ink is faint, more towards the lower left where the stamp pressed lightest, and a little under
 * half of that is missing; the letters stay whole.
 */
export function stampPixels(): StampPixel[] {
  const { w, h, frame, letters } = flatStamp();
  const out: StampPixel[] = [];
  const put = (x: number, y: number, faint: boolean): void => {
    const [dx, dy] = turn(x, y, w, h, STAMP.tilt);
    out.push({ x: STAMP.x + dx, y: STAMP.y + dy, faint });
  };
  for (const [x, y] of frame) {
    const light = STAMP.wear * (0.6 + 0.8 * (1 - x / w) * (y / h));
    const r = grain(x, y);
    if (r >= 0.45 * light) put(x, y, r < light);
  }
  for (const [x, y] of letters) put(x, y, false);
  return out;
}

/** The Arcade's logo (gate, title, main menu): the game's logo with a red ARCADE stamp, on a canvas `STAMP_ROOM` wider. */
export function arcadeLogoCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = LOGO_W + STAMP_ROOM;
  canvas.height = LOGO_H;
  canvas.className = 'logo stamped';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Black Belt Tennis Arcade');
  const g = canvas.getContext('2d');
  if (!g) return canvas;
  paintLogo(g);
  for (const p of stampPixels()) rect(g, p.x, p.y, 1, 1, p.faint ? INK.faint : INK.full);
  return canvas;
}
