import type { Look } from '../core/types';
import { OUTLINE, PAL } from '../render/palette';
import { ANIMS, CELL, type AnimName, type View } from '../render/sprites/animations';
import { buildSheet, drawPlayer, sheetFrames, slotColors } from '../render/sprites/sheet';

/** Preview canvas in sprite pixels: the 48×48 cell cropped to the player (CSS shows it at 3×). */
const W = 40;
const H = 48;
const FEET = { x: 20, y: 45 };

/** The preview's show reel: each animation with how long it stays (one-shots then hold their last frame). */
const REEL: readonly { anim: AnimName; ms: number }[] = [
  { anim: 'idle', ms: 1400 },
  { anim: 'forehand', ms: 700 },
  { anim: 'idle', ms: 900 },
  { anim: 'backhand', ms: 700 },
  { anim: 'idle', ms: 900 },
  { anim: 'serve', ms: 1400 },
  { anim: 'celebrate', ms: 1500 },
];
const REEL_MS = REEL.reduce((t, r) => t + r.ms, 0);

/** The reel's animation and frame number at `t` ms. */
function reelAt(t: number): { anim: AnimName; frame: number } {
  let at = ((t % REEL_MS) + REEL_MS) % REEL_MS;
  for (const r of REEL) {
    if (at < r.ms) return { anim: r.anim, frame: Math.floor(at / ANIMS[r.anim].msPerFrame) };
    at -= r.ms;
  }
  return { anim: 'idle', frame: 0 };
}

/** A 50 % checker-dithered contact shadow under the feet. */
function shadow(g: CanvasRenderingContext2D): void {
  g.fillStyle = OUTLINE;
  for (let dy = -1; dy <= 1; dy++) {
    const half = dy === 0 ? 9 : 6;
    for (let dx = -half; dx <= half; dx++) if (((dx + dy) & 1) === 0) g.fillRect(FEET.x + dx, FEET.y + dy, 1, 1);
  }
}

/**
 * A live animated preview of a look in the near (back) and far (front) views (spec §4.6 Customize):
 * two small canvases drawn with the real sprite sheet, stepping through a reel of animations while
 * started.
 */
export class LookPreview {
  /** The near-view and far-view canvases, in that order. */
  readonly canvases: [HTMLCanvasElement, HTMLCanvasElement];
  private look: Look;
  private raf = 0;
  private startedAt = 0;

  constructor(look: Look) {
    this.look = { ...look };
    this.canvases = [this.canvas('near'), this.canvas('far')];
  }

  /** Shows `look` from the next frame on. */
  setLook(look: Look): void {
    this.look = { ...look };
    this.draw(performance.now());
  }

  /** Starts animating (call when the screen shows). */
  start(): void {
    this.stop();
    this.startedAt = performance.now();
    const tick = (now: number): void => {
      this.draw(now);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Stops animating (call when the screen hides). */
  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private canvas(view: View): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    c.className = `preview ${view}`;
    c.dataset['view'] = view;
    return c;
  }

  private draw(now: number): void {
    let sheet;
    try {
      sheet = buildSheet(this.look);
    } catch {
      return;
    }
    const { anim, frame } = reelAt(now - this.startedAt);
    this.canvases.forEach((c, i) => {
      const g = c.getContext('2d');
      if (!g) return;
      g.imageSmoothingEnabled = false;
      g.fillStyle = PAL.night;
      g.fillRect(0, 0, W, H);
      shadow(g);
      drawPlayer(g, sheet, anim, i === 0 ? 'near' : 'far', frame, FEET.x, FEET.y);
    });
  }
}

/** Hair-style icon size in sprite pixels: the far-view head, cropped from the idle frame. */
const HEAD = { w: 16, h: 14 };

/**
 * Paints `look` wearing hair style `style` as a small head portrait (far view, idle) into `canvas`
 * (HEAD.w × HEAD.h), straight from the composed frame, so no sprite sheet is built for it.
 */
export function paintHead(canvas: HTMLCanvasElement, look: Look, style: number): void {
  canvas.width = HEAD.w;
  canvas.height = HEAD.h;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, HEAD.w, HEAD.h);
  const frame = sheetFrames(style, look.headband !== null).find((f) => f.anim === 'idle' && f.view === 'far' && f.i === 0);
  if (!frame) return;
  let colors: (string | null)[];
  try {
    colors = slotColors({ ...look, hairStyle: style });
  } catch {
    return;
  }
  const colorAt = (x: number, y: number): string | null => colors[frame.buf[y * CELL.w + x] ?? 0] ?? null;
  let top = 0;
  const rowEmpty = (y: number): boolean => Array.from({ length: CELL.w }, (_, x) => colorAt(x, y)).every((c) => c === null);
  while (top < CELL.h && rowEmpty(top)) top++;
  const x0 = Math.round(CELL.anchorX - HEAD.w / 2);
  for (let y = 0; y < HEAD.h; y++) {
    for (let x = 0; x < HEAD.w; x++) {
      const c = colorAt(x0 + x, top + y);
      if (c === null) continue;
      g.fillStyle = c;
      g.fillRect(x, y, 1, 1);
    }
  }
}
