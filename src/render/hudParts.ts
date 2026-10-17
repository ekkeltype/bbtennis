import { shadowText } from './banner';
import { drawText, textWidth } from './font';
import { PAL } from './palette';
import { W } from './projection';
import { panel, rect } from './scoreboard';

/** The on-screen pause button (spec §4.3), top-right in the HUD band, in 480×270 buffer pixels. */
export const PAUSE_ICON_RECT: Readonly<{ x: number; y: number; w: number; h: number }> = { x: 462, y: 3, w: 15, h: 15 };

/** The serve clock turns yellow (never red) for its last seconds. */
const CLOCK_WARN_S = 5;

/** The serve clock's whole seconds at 2× on a panel at the top centre; yellow for the last 5 s. */
export function drawServeClock(ctx: CanvasRenderingContext2D, seconds: number): void {
  const text = String(seconds);
  const w = Math.max(28, textWidth(text, 2) + 10);
  const x = Math.round((W - w) / 2);
  panel(ctx, x, 1, w, 20);
  rect(ctx, x + 1, 2, w - 2, 1, PAL.shadow);
  shadowText(ctx, text, x + Math.floor((w - textWidth(text, 2)) / 2), 2, seconds <= CLOCK_WARN_S ? PAL.tierYellow : PAL.cream, 2);
}

/** The pause button in `PAUSE_ICON_RECT`: two cream bars on a panel. */
export function drawPauseIcon(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, h } = PAUSE_ICON_RECT;
  panel(ctx, x, y, w, h);
  rect(ctx, x + 4, y + 4, 2, h - 8, PAL.cream);
  rect(ctx, x + w - 6, y + 4, 2, h - 8, PAL.cream);
}

/** A right-aligned readout on a small panel ending at x `right`. */
export function readout(ctx: CanvasRenderingContext2D, text: string, right: number, y: number, alpha: number): void {
  const w = textWidth(text) + 6;
  ctx.save();
  ctx.globalAlpha = alpha;
  panel(ctx, right - w, y, w, 10);
  drawText(ctx, text, right - w + 3, y, PAL.cream);
  ctx.restore();
}

/** A centred message box with a 2× title and optional 1× line. */
export function message(ctx: CanvasRenderingContext2D, title: string, line: string | null, cy: number): void {
  const w = Math.max(textWidth(title, 2), line ? textWidth(line) : 0) + 20;
  const h = line ? 36 : 24;
  const x = Math.round((W - w) / 2);
  const y = Math.round(cy - h / 2);
  panel(ctx, x, y, w, h);
  rect(ctx, x + 1, y + 1, w - 2, 1, PAL.gold);
  shadowText(ctx, title, x + Math.round((w - textWidth(title, 2)) / 2), y + 4, PAL.white, 2);
  if (line) drawText(ctx, line, x + Math.round((w - textWidth(line)) / 2), y + 22, PAL.cream);
}
