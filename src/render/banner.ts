import { clamp, easeOutQuad } from '../core/util';
import { drawText, textWidth } from './font';
import { OUTLINE, PAL } from './palette';
import { W } from './projection';
import { rect } from './scoreboard';

/** A banner line and the time since it appeared (a line can join a banner that is already up). */
export interface BannerLine { text: string; ageMs: number }

/** A banner: its lines, time since it appeared, time left (null = stays) and whether it is the small kind. */
export interface Banner { lines: BannerLine[]; ageMs: number; leftMs: number | null; small: boolean }

/** Banner slide-in (the banner and each line joining it) and fade-out. */
const BANNER_IN_MS = 180;
const BANNER_OUT_MS = 250;
/** Top row of the call banners: a one-line banner is centred on y 96; longer ones grow downward from here. */
const BANNER_TOP = 83;
const BANNER_LINE_H = 18;

/** Text with a one-glyph-pixel dark drop shadow. */
export function shadowText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color: string, scale: 1 | 2 = 1): void {
  drawText(ctx, s, x + scale, y + scale, OUTLINE, scale);
  drawText(ctx, s, x, y, color, scale);
}

/** Share of the screen width that something `ageMs` into its slide-in still lies to the left. */
const slideLeft = (ageMs: number): number => 1 - easeOutQuad(clamp(ageMs / BANNER_IN_MS, 0, 1));

/** Draws a call or situation banner: sliding in from the left, fading out over its last 250 ms. */
export function drawBanner(ctx: CanvasRenderingContext2D, b: Banner): void {
  const alpha = b.leftMs === null ? 1 : clamp(b.leftMs / BANNER_OUT_MS, 0, 1);
  if (alpha <= 0) return;
  const h = b.lines.length * BANNER_LINE_H + 8;
  const widest = Math.max(...b.lines.map((l) => textWidth(l.text, 2)));
  const w = b.small ? widest + 24 : W;
  const x = Math.round((W - w) / 2 - slideLeft(b.ageMs) * W);
  ctx.save();
  ctx.globalAlpha = alpha;
  rect(ctx, x, BANNER_TOP, w, h, OUTLINE);
  rect(ctx, x, BANNER_TOP + 1, w, 1, PAL.gold);
  rect(ctx, x, BANNER_TOP + 2, w, h - 4, PAL.night);
  rect(ctx, x, BANNER_TOP + h - 2, w, 1, PAL.gold);
  b.lines.forEach((line, i) => {
    const tx = Math.round((W - textWidth(line.text, 2)) / 2 - slideLeft(line.ageMs) * W);
    shadowText(ctx, line.text, tx, BANNER_TOP + 3 + i * BANNER_LINE_H, i === 0 ? PAL.white : PAL.gold, 2);
  });
  ctx.restore();
}
