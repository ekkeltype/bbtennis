import { netScreenY } from './projection';

/** Screen rectangle of one word plate, in 480×270 buffer pixels; `option` indexes the prompt's options. */
export interface PlateBox { x: number; y: number; w: number; h: number; option: number }

/** Fixed screen bands (spec §4.1): HUD y 0–21, far prompt band y 22–38 (inclusive). */
export const BANDS: { hud: [0, 21]; far: [22, 38] } = { hud: [0, 21], far: [22, 38] };

/** Area every plate must stay inside (spec §4.2): x 4–476, y 22–266. */
const AREA = { left: 4, right: 476, top: BANDS.far[0], bottom: 266 };
const PLATE_H = 16;
const SLOT_X = { left: 90, centre: 240, right: 390 };
const HEAD_GAP = 4;
const NEAR_BAND_GAP = 6;
const STACK_GAP = 2;
const ROW_GAP = 4;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Left x that puts a `w`-wide box's centre column on `cx`, kept inside x 4–476. */
function centredX(cx: number, w: number): number {
  return clamp(Math.round(cx - (w - 1) / 2), AREA.left, AREA.right - w);
}

/** Top y that ends an `h`-tall box `HEAD_GAP` px above `headY`, kept inside y 22–266. */
function aboveHead(headY: number, h: number): number {
  return clamp(Math.round(headY) - HEAD_GAP - h, AREA.top, AREA.bottom - h);
}

/** Plate width in pixels for a word of `len` letters: `6n + 11` at 1× (pips included), doubled at 2×. */
export function plateWidth(len: number, scale: 1 | 2 = 1): number {
  return (6 * len + 11) * scale;
}

/**
 * Choice plates (spec §4.2) for `lens` = [easy, medium, hard]: one 1× row in the band of the targeted
 * half (far: the far prompt band; near: 6 px below the net line), slot centres x 90 / 240 / 390.
 * Easy takes the centre slot; medium takes the outer slot on its target's side of the hard target
 * (`targetsScreenX` in the same option order) and hard the other one.
 */
export function layoutChoice(lens: number[], targetsScreenX: number[], band: 'far' | 'near'): PlateBox[] {
  const y = band === 'far' ? BANDS.far[0] : Math.round(netScreenY() + NEAR_BAND_GAP);
  const mediumLeft = (targetsScreenX[1] ?? 0) <= (targetsScreenX[2] ?? 0);
  const slots = [SLOT_X.centre, mediumLeft ? SLOT_X.left : SLOT_X.right, mediumLeft ? SLOT_X.right : SLOT_X.left];
  return lens.map((len, option) => {
    const w = plateWidth(len);
    return { x: centredX(slots[option] ?? SLOT_X.centre, w), y, w, h: PLATE_H, option };
  });
}

/**
 * Serve plates of the near server (spec §4.2): a vertical stack, easy on top, 2 px gaps, its bottom
 * 4 px above the head top (`headX`, `headY`). The plates share one left edge, placed so the widest
 * is centred over the head; the stack is kept inside x 4–476 and below the HUD band.
 */
export function layoutServeNear(lens: number[], headX: number, headY: number): PlateBox[] {
  const widest = Math.max(...lens.map((len) => plateWidth(len)));
  const x = centredX(headX, widest);
  const stackH = lens.length * PLATE_H + (lens.length - 1) * STACK_GAP;
  const top = aboveHead(headY, stackH);
  return lens.map((len, option) => ({
    x,
    y: top + option * (PLATE_H + STACK_GAP),
    w: plateWidth(len),
    h: PLATE_H,
    option,
  }));
}

/**
 * Serve plates of the far server (spec §4.2): one row in the far prompt band, easy on the left,
 * 4 px gaps, centred on the server's screen x and clamped to x 4–476.
 */
export function layoutServeFar(lens: number[], serverX: number): PlateBox[] {
  const widths = lens.map((len) => plateWidth(len));
  const rowW = widths.reduce((sum, w) => sum + w, 0) + (lens.length - 1) * ROW_GAP;
  let x = centredX(serverX, rowW);
  return widths.map((w, option) => {
    const box = { x, y: BANDS.far[0], w, h: PLATE_H, option };
    x += w + ROW_GAP;
    return box;
  });
}

/**
 * A single plate (chase prompt, or a locked word redrawn at 2×) centred on `headX` with its bottom
 * 4 px above `headY`, clamped to x 4–476 and y 22–266.
 */
export function layoutSingle(len: number, headX: number, headY: number, scale: 1 | 2): PlateBox {
  const w = plateWidth(len, scale);
  const h = PLATE_H * scale;
  return { x: centredX(headX, w), y: aboveHead(headY, h), w, h, option: 0 };
}
