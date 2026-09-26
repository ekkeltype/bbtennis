import { drawText, textWidth } from '../render/font';
import { OUTLINE, PAL, RAMPS } from '../render/palette';

/** Logo canvas size in logo pixels (CSS shows each at 2 game pixels, see styles.css). */
const W = 132;
const H = 63;
const LINE1 = 'BLACK BELT';
const LINE2 = 'TENNIS';
const BLACK = RAMPS.cloth[4]!;

function rect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string): void {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}

/** Text at 2× with a 1 px outline all round and a 1 px drop shadow under it. */
function outlined(g: CanvasRenderingContext2D, s: string, y: number, fill: string, shadow: string): void {
  const x = Math.round((W - textWidth(s, 2)) / 2);
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1], [0, 2], [1, 2], [-1, 2]] as const) {
    drawText(g, s, x + dx, y + dy, OUTLINE, 2);
  }
  drawText(g, s, x, y + 1, shadow, 2);
  drawText(g, s, x, y, fill, 2);
}

/** A belt tail hanging from the knot: 5 px wide, slanting one pixel outward every two rows, with a gold rank bar near its end. */
function tail(g: CanvasRenderingContext2D, x0: number, y0: number, dir: 1 | -1, len: number): void {
  const at = (i: number): number => x0 + dir * Math.floor(i / 2);
  for (let i = 0; i <= len; i++) rect(g, at(i) - 1, y0 + i, 7, 1, OUTLINE);
  for (let i = 0; i < len; i++) {
    const bar = i === len - 3 || i === len - 4;
    rect(g, at(i), y0 + i, 5, 1, bar ? PAL.gold : BLACK[1]);
    rect(g, dir > 0 ? at(i) : at(i) + 4, y0 + i, 1, 1, bar ? PAL.cream : BLACK[0]);
  }
}

/** The belt across the logo: a black band tied in a square knot in the middle, its two tails splayed below. */
function belt(g: CanvasRenderingContext2D, y: number): void {
  rect(g, 3, y - 1, W - 6, 7, OUTLINE);
  rect(g, 4, y, W - 8, 5, BLACK[1]);
  rect(g, 4, y, W - 8, 1, BLACK[0]);
  rect(g, 4, y + 4, W - 8, 1, BLACK[2]);
  const cx = Math.round(W / 2);
  tail(g, cx - 6, y + 6, -1, 9);
  tail(g, cx + 1, y + 6, 1, 9);
  rect(g, cx - 7, y - 3, 14, 11, OUTLINE);
  rect(g, cx - 6, y - 2, 12, 9, BLACK[1]);
  rect(g, cx - 6, y - 2, 12, 1, BLACK[0]);
  rect(g, cx - 6, y + 6, 12, 1, BLACK[2]);
  for (let i = 0; i < 7; i++) {
    rect(g, cx + 2 - i, y - 1 + i, 1, 1, BLACK[2]);
    rect(g, cx + 3 - i, y - 1 + i, 1, 1, BLACK[0]);
  }
}

/** A tennis ball, 8 px across: outline, felt, shade and the white seam. */
const BALL = ['..####..', '.#sooo#.', '#osoooo#', '#oosooo#', '#oosood#', '#osoodd#', '.#sddd#.', '..####..'];
const BALL_INK: Record<string, string> = { '#': OUTLINE, o: PAL.ball, d: PAL.ballShade, s: PAL.white };

function ball(g: CanvasRenderingContext2D, x: number, y: number): void {
  BALL.forEach((row, dy) => {
    [...row].forEach((ch, dx) => {
      const c = BALL_INK[ch];
      if (c) rect(g, x + dx, y + dy, 1, 1, c);
    });
  });
}

/** The title logo: "BLACK BELT" over a knotted black belt, "TENNIS" in ball yellow beside a tennis ball. */
export function logoCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.className = 'logo';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Black Belt Tennis');
  const g = canvas.getContext('2d');
  if (!g) return canvas;
  g.imageSmoothingEnabled = false;
  outlined(g, LINE1, 3, PAL.cream, PAL.silver);
  belt(g, 23);
  outlined(g, LINE2, 39, PAL.ball, PAL.ballShade);
  ball(g, Math.round((W + textWidth(LINE2, 2)) / 2) + 6, 43);
  return canvas;
}
