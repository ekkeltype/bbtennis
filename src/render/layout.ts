import { clamp } from '../core/util';
import { netScreenY } from './projection';

/** Screen rectangle of one word plate, in 480×270 buffer pixels; `option` indexes the prompt's options. */
export interface PlateBox { x: number; y: number; w: number; h: number; option: number }

/** Fixed screen bands (spec §4.1): HUD y 0–21, far prompt band y 22–38 (inclusive). */
export const BANDS: { hud: [0, 21]; far: [22, 38] } = { hud: [0, 21], far: [22, 38] };

/** Area every plate must stay inside (spec §4.2): x 4–476, y 22–266. */
const AREA = { left: 4, right: 476, top: BANDS.far[0], bottom: 266 };
const CENTRE_X = (AREA.left + AREA.right) / 2;
const PLATE_H = 16;
const SLOT_X = { left: 90, centre: 240, right: 390 };
/** Slot centres of a 4-plate choice row (power-meter spec §6), left to right. */
const SLOTS_4 = [60, 180, 300, 420] as const;
const HEAD_GAP = 4;
const NEAR_BAND_GAP = 6;
/** Gap between serve-stack plates: 3 px, so a pixel of court shows between two 1 px halos. */
const STACK_GAP = 3;
const ROW_GAP = 4;
/**
 * Serve plates keep clear of the tossed ball (R34). `ball.ts` draws it over the tossing hand, not
 * over the feet: 6.5 px screen-left of the feet for the near server (seen from behind), 6.5 px
 * screen-right for the far one (seen from the front), a 5 px sprite (3 px core, 1 px outline). For a
 * head (feet) at x h it covers x ⌊h⌋ − 8 … ⌊h⌋ − 4 near and ⌊h⌋ + 5 … ⌊h⌋ + 9 far. A near stack's
 * inner edge ≥ 10 px from the head and a far row clear ≥ 12 px either side of the server leave a
 * court pixel between a plate's 1 px halo and the ball, so a 2 px wrong-key shake reaches at most
 * the ball's outline.
 */
const TOSS_CLEAR_NEAR = 10;
const TOSS_CLEAR_FAR = 12;

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
 * Choice plates (spec §4.2, power-meter spec §6) for `lens` in option order, [easy, medium, hard] or
 * [easy, medium, hard, insane]: one 1× row in the band of the targeted half (far: the far prompt band;
 * near: 6 px below the net line). Three plates: slot centres x 90 / 240 / 390, easy in the centre,
 * medium in the outer slot on its target's side of the hard target, hard in the other. Four plates:
 * slot centres x 60 / 180 / 300 / 420, taken in the order of the targets' screen x, so insane is
 * outermost on medium's side. Throws unless both arrays hold 3 or 4 entries, the same number.
 */
export function layoutChoice(lens: number[], targetsScreenX: number[], band: 'far' | 'near'): PlateBox[] {
  const n = lens.length;
  if ((n !== 3 && n !== 4) || targetsScreenX.length !== n) {
    throw new Error(
      `layoutChoice needs 3 or 4 word lengths and as many target x values, got ${lens.length} and ${targetsScreenX.length}`,
    );
  }
  const y = band === 'far' ? BANDS.far[0] : Math.round(netScreenY() + NEAR_BAND_GAP);
  const slots = n === 3 ? threeSlots(targetsScreenX) : fourSlots(targetsScreenX);
  return lens.map((len, option) => {
    const w = plateWidth(len);
    return { x: centredX(slots[option]!, w), y, w, h: PLATE_H, option };
  });
}

/** Slot centres for [easy, medium, hard]: easy central, medium on its target's side of hard. */
function threeSlots(targetsScreenX: number[]): number[] {
  const [, mediumX, hardX] = targetsScreenX as [number, number, number];
  const mediumLeft = mediumX <= hardX;
  return [SLOT_X.centre, mediumLeft ? SLOT_X.left : SLOT_X.right, mediumLeft ? SLOT_X.right : SLOT_X.left];
}

/** Slot centres for four options: `SLOTS_4` handed out left to right in the order of their targets' screen x. */
function fourSlots(targetsScreenX: number[]): number[] {
  const order = targetsScreenX.map((x, option) => ({ x, option })).sort((a, b) => a.x - b.x || a.option - b.option);
  const slots: number[] = [];
  order.forEach(({ option }, k) => {
    slots[option] = SLOTS_4[k]!;
  });
  return slots;
}

/**
 * Serve plates of the near server (spec §4.2, R34): a vertical stack, easy on top, 3 px gaps, beside
 * the head (top at `headX`, `headY`) on the side toward the screen centre, which always has the more
 * room; at exactly the centre it goes right. The plates share their inner edge, ≥ 10 px from `headX`
 * so the tossed ball stays clear, and the stack's bottom is level with the head top. Option `large`
 * (a locked word with Large words) is redrawn at 2× grown away from the head: its inner edge and
 * bottom stay, so the ball stays as clear as at 1×. Kept inside x 4–476 and y 22–266. Throws on an
 * empty `lens`.
 */
export function layoutServeNear(lens: number[], headX: number, headY: number, large: number | null = null): PlateBox[] {
  if (lens.length === 0) throw new Error('layoutServeNear needs at least one word length');
  const stackH = lens.length * PLATE_H + (lens.length - 1) * STACK_GAP;
  const top = clamp(Math.round(headY) - stackH, AREA.top, AREA.bottom - stackH);
  const right = headX <= CENTRE_X;
  const inner = right ? Math.ceil(headX + TOSS_CLEAR_NEAR) : Math.floor(headX - TOSS_CLEAR_NEAR);
  return lens.map((len, option) => {
    const scale = option === large ? 2 : 1;
    const w = plateWidth(len, scale);
    const h = PLATE_H * scale;
    const bottom = top + option * (PLATE_H + STACK_GAP) + PLATE_H;
    return {
      x: clamp(right ? inner : inner - w, AREA.left, AREA.right - w),
      y: clamp(bottom - h, AREA.top, AREA.bottom - h),
      w,
      h,
      option,
    };
  });
}

/** Width of plates `widths` laid side by side `ROW_GAP` px apart (0 for none). */
function rowWidth(widths: number[]): number {
  return widths.length === 0 ? 0 : widths.reduce((sum, w) => sum + w, 0) + (widths.length - 1) * ROW_GAP;
}

/**
 * Serve plates of the far server (spec §4.2, R34): one row in the far prompt band, easy to hard left
 * to right, 4 px apart except for a gap over the server: the row splits so the plates before the
 * split end ≥ 12 px left of `serverX` and the rest start ≥ 12 px right of it, a ≥ 24 px gap that keeps
 * the tossed ball (over the hand, right of the feet) clear. Of the splits that fit x 4–476, the one
 * whose two sides are closest in width wins (the row best centred on the server); when none fits (a
 * server off screen), the one needing the smallest shift is moved inside x 4–476. Option `large` (a
 * locked word with Large words) is redrawn at 2× (`largeFar`). Throws on an empty `lens`.
 */
export function layoutServeFar(lens: number[], serverX: number, large: number | null = null): PlateBox[] {
  if (lens.length === 0) throw new Error('layoutServeFar needs at least one word length');
  const widths = lens.map((len) => plateWidth(len));
  const gapLeft = Math.floor(serverX - TOSS_CLEAR_FAR);
  const gapRight = Math.ceil(serverX + TOSS_CLEAR_FAR);
  let best = { xs: [] as number[], dx: Infinity, imbalance: Infinity };
  for (let split = 0; split <= widths.length; split++) {
    const leftW = rowWidth(widths.slice(0, split));
    const xs: number[] = [];
    let x = gapLeft - leftW;
    widths.forEach((w, i) => {
      if (i === split) x = gapRight;
      xs.push(x);
      x += w + ROW_GAP;
    });
    const lo = xs[0]!;
    const rowW = xs.at(-1)! + widths.at(-1)! - lo;
    const dx = clamp(lo, AREA.left, AREA.right - rowW) - lo;
    const imbalance = Math.abs(leftW - rowWidth(widths.slice(split)));
    const shift = Math.abs(dx);
    const bestShift = Math.abs(best.dx);
    if (shift < bestShift || (shift === bestShift && imbalance < best.imbalance)) best = { xs, dx, imbalance };
  }
  return best.xs.map((x, option) => {
    const box = { x: x + best.dx, y: BANDS.far[0], w: widths[option]!, h: PLATE_H, option };
    return option === large ? largeFar(box, serverX, gapLeft, gapRight) : box;
  });
}

/**
 * A far-row plate redrawn at 2×, grown away from the toss gap (`gapLeft`–`gapRight`) instead of
 * around its centre: its top stays, and so does the edge facing the gap (the right edge of a plate
 * left of the server, the left edge of one right of it). Kept inside x 4–476 on its side of the gap;
 * when that side has no room for it (a server near a screen edge), it sits next to the gap on the
 * other side, which then always has room.
 */
function largeFar(box: PlateBox, serverX: number, gapLeft: number, gapRight: number): PlateBox {
  const w = box.w * 2;
  const leftSide = { lo: AREA.left, hi: Math.min(gapLeft, AREA.right) - w };
  const rightSide = { lo: Math.max(gapRight, AREA.left), hi: AREA.right - w };
  const left = box.x + box.w / 2 < serverX;
  const own = left ? leftSide : rightSide;
  const side = own.lo <= own.hi ? own : left ? rightSide : leftSide;
  const x = clamp(left ? box.x + box.w - w : box.x, side.lo, side.hi);
  return { x, y: box.y, w, h: box.h * 2, option: box.option };
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
