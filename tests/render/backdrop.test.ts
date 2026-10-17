import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Surface } from '../../src/core/types';
import { FLOOR } from '../../src/render/court';
import { H, W } from '../../src/render/projection';
import { type BoardSet, drawBackdrop, type SceneState } from '../../src/render/scene';

/** Software canvas: one `#RRGGBB` string per pixel, '' where nothing was drawn. */
class PixelCanvas {
  readonly px: string[];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.px = new Array<string>(width * height).fill('');
  }
  getContext(): PixelContext {
    return new PixelContext(this);
  }
}

const hex = (r: number, g: number, b: number): string => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** The 2D calls the backdrop makes, whole pixels only: fills, 1:1 blits (whole or a source rectangle) and image data. */
class PixelContext {
  fillStyle = '#000000';
  imageSmoothingEnabled = true;
  constructor(readonly canvas: PixelCanvas) {}
  fillRect(x: number, y: number, w: number, h: number): void {
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) this.set(px, py, this.fillStyle.toUpperCase());
  }
  drawImage(src: PixelCanvas, ...a: number[]): void {
    const [sx, sy, sw, sh, dx, dy] = a.length === 2 ? [0, 0, src.width, src.height, a[0]!, a[1]!] : (a as [number, number, number, number, number, number]);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const c = src.px[(sy + y) * src.width + sx + x]!;
        if (c !== '') this.set(dx + x, dy + y, c);
      }
    }
  }
  createImageData(w: number, h: number): ImageData {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as unknown as ImageData;
  }
  putImageData(img: ImageData, dx: number, dy: number): void {
    const d = img.data;
    for (let i = 0; i < img.width * img.height; i++) {
      const p = i * 4;
      this.set(dx + (i % img.width), dy + Math.floor(i / img.width), d[p + 3] === 0 ? '' : hex(d[p]!, d[p + 1]!, d[p + 2]!));
    }
  }
  private set(x: number, y: number, c: string): void {
    const cv = this.canvas;
    if (x >= 0 && y >= 0 && x < cv.width && y < cv.height) cv.px[y * cv.width + x] = c;
  }
}

beforeAll(() => {
  vi.stubGlobal('OffscreenCanvas', PixelCanvas);
});

const SCENE: SceneState = { crowdExcite: 0, umpireLook: 0, t: 0 };

/** A full frame of the backdrop for `surface`, with board set `boards` (the default when omitted). */
function backdrop(surface: Surface, boards?: BoardSet): string[] {
  const c = new PixelCanvas(W, H);
  drawBackdrop(c.getContext() as unknown as CanvasRenderingContext2D, surface, SCENE, boards);
  return c.px;
}

/** Pixel indices where two frames differ. */
const diff = (a: readonly string[], b: readonly string[]): number[] => a.flatMap((c, i) => (c === b[i] ? [] : [i]));

describe('drawBackdrop ad boards', () => {
  it('draws the typing game\'s boards by default', () => {
    expect(diff(backdrop('hard'), backdrop('hard', 'typing'))).toEqual([]);
  });

  it.each(['hard', 'dojo'] as const)('the arcade set changes only the left board\'s lettering (%s)', (surface) => {
    const typing = backdrop(surface, 'typing');
    const changed = diff(typing, backdrop(surface, 'arcade'));
    expect(changed.length).toBeGreaterThan(0);
    // The back wall holds three equal boards from x0 to W − x0 above the floor; the left one is TYPE FAST / HIT HARD.
    const x0 = FLOOR.edge - FLOOR.top;
    const leftBoardEnd = x0 + (W - 2 * x0) / 3;
    const outside = changed.filter((i) => i % W < x0 || i % W >= leftBoardEnd || Math.floor(i / W) >= FLOOR.top);
    expect(outside).toEqual([]);
  });

  it('caches each surface and board set apart', () => {
    const first = backdrop('clay', 'typing');
    const arcade = backdrop('clay', 'arcade');
    expect(diff(first, arcade).length).toBeGreaterThan(0);
    expect(diff(backdrop('clay', 'typing'), first)).toEqual([]);
    expect(diff(backdrop('clay', 'arcade'), arcade)).toEqual([]);
  });
});
