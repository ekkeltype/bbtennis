import { checker } from './court';
import { OUTLINE } from './palette';

/** Contact shadow under the feet (rows from the anchor row − 1), 50 % checker-dithered: [dx from, dx to]. */
const SHADOW: readonly [number, number][] = [
  [-6, 6],
  [-8, 8],
  [-6, 6],
];

/** Paints the contact shadow under a player's feet at screen point `at`. */
export function drawContactShadow(ctx: CanvasRenderingContext2D, at: { x: number; y: number }): void {
  const x = Math.round(at.x);
  const y = Math.round(at.y);
  ctx.fillStyle = OUTLINE;
  SHADOW.forEach(([from, to], r) => {
    for (let dx = from; dx <= to; dx++) if (checker(x + dx, y + r - 1)) ctx.fillRect(x + dx, y + r - 1, 1, 1);
  });
}
