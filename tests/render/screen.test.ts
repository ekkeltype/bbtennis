// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerId, Surface } from '../../src/core/types';
import { Screen, cachedLayer, computeScale, cssUnit, layersPerEnd, type Layer, type ScaleInfo } from '../../src/render/screen';

/** Device-pixel values must be whole numbers (within float noise). */
function expectWhole(v: number): void {
  expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-6);
}

function devicePlacement(i: ScaleInfo): { x: number; y: number; w: number; h: number } {
  return { x: i.offsetX * i.dpr, y: i.offsetY * i.dpr, w: i.cssW * i.dpr, h: i.cssH * i.dpr };
}

describe('computeScale (spec §4.1)', () => {
  it('uses the largest whole scale that fits: 1920×1080 @1 → k 4', () => {
    expect(computeScale(1920, 1080, 1, 'pixel')).toEqual({
      k: 4,
      dpr: 1,
      cssW: 1920,
      cssH: 1080,
      mode: 'pixel',
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('computes k in device pixels: 1536×760 @1.25 → k 3, 1152×648 CSS px', () => {
    const i = computeScale(1536, 760, 1.25, 'pixel');
    expect(i.k).toBe(3);
    expect(i.mode).toBe('pixel');
    expect(i.cssW).toBeCloseTo(1152, 9);
    expect(i.cssH).toBeCloseTo(648, 9);
    expect(devicePlacement(i).w).toBeCloseTo(1440, 9);
    expect(devicePlacement(i).h).toBeCloseTo(810, 9);
  });

  it('centres the canvas: 1536×760 @1.25 sits 240 device px from the left, 70 from the top', () => {
    const p = devicePlacement(computeScale(1536, 760, 1.25, 'pixel'));
    expect(p.x).toBeCloseTo(240, 9);
    expect(p.y).toBeCloseTo(70, 9);
  });

  it('keeps the whole scale when the float product lands just under it: 1350 px tall @1.4 → k 7', () => {
    expect(1350 * 1.4).toBeLessThan(1890);
    const i = computeScale(3000, 1350, 1.4, 'pixel');
    expect(i.k).toBe(7);
    expect(i.mode).toBe('pixel');
    const p = devicePlacement(i);
    expect(p.h).toBeCloseTo(1890, 9);
    expect(p.y).toBe(0);
  });

  it('switches to fit mode when k < 2: 900×500 @1 → k 1, filling the height without overflow', () => {
    const i = computeScale(900, 500, 1, 'pixel');
    expect(i.k).toBe(1);
    expect(i.mode).toBe('fit');
    expect(i.cssH).toBe(500);
    expect(i.cssW).toBe(888);
  });

  it('never returns k = 0 (300×200 still gets k 1 in fit mode)', () => {
    const i = computeScale(300, 200, 1, 'pixel');
    expect(i.k).toBe(1);
    expect(i.mode).toBe('fit');
    expect(i.cssW).toBe(300);
    expect(i.cssH).toBe(168);
  });

  it('honours an explicit fit request even when a whole scale fits', () => {
    const i = computeScale(1536, 760, 1.25, 'fit');
    expect(i.mode).toBe('fit');
    expect(i.k).toBe(3);
    expect(i.cssH).toBe(760);
    expectWhole(i.cssW * i.dpr);
  });

  it('gives a crisp whole scale in fit mode when the window is an exact multiple', () => {
    const i = computeScale(1920, 1080, 1, 'fit');
    expect(i).toMatchObject({ k: 4, cssW: 1920, cssH: 1080, offsetX: 0, offsetY: 0, mode: 'fit' });
  });

  it('survives degenerate windows and ratios (minimised, zoomed out, broken dpr)', () => {
    const cases: [number, number, number][] = [
      [0, 0, 1],
      [1, 1, 3],
      [5000, 2, 1],
      [800, 600, 0],
      [800, 600, Number.NaN],
      [Number.NaN, 600, 1],
    ];
    for (const [w, h, dpr] of cases) {
      const i = computeScale(w, h, dpr, 'pixel');
      expect(i.k).toBeGreaterThanOrEqual(1);
      expect(i.dpr).toBeGreaterThan(0);
      for (const v of Object.values(i)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
      const p = devicePlacement(i);
      expect(p.w).toBeGreaterThanOrEqual(1);
      expect(p.h).toBeGreaterThanOrEqual(1);
    }
  });

  it('places the canvas at whole device pixels and inside the window, whatever the size or zoom', () => {
    const dprs = [1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 3];
    for (const dpr of dprs) {
      for (let w = 301; w <= 3001; w += 97) {
        for (let h = 211; h <= 1711; h += 83) {
          for (const mode of ['pixel', 'fit'] as const) {
            const i = computeScale(w, h, dpr, mode);
            const p = devicePlacement(i);
            expectWhole(p.x);
            expectWhole(p.y);
            expectWhole(p.w);
            expectWhole(p.h);
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.x + p.w).toBeLessThanOrEqual(w * dpr + 1e-6);
            expect(p.y + p.h).toBeLessThanOrEqual(h * dpr + 1e-6);
            if (i.mode === 'pixel') {
              expect(i.k).toBeGreaterThanOrEqual(2);
              expect(p.w).toBeCloseTo(480 * i.k, 6);
              expect(p.h).toBeCloseTo(270 * i.k, 6);
              expect(i.k).toBe(Math.floor(Math.min((w * dpr) / 480, (h * dpr) / 270)));
            }
          }
        }
      }
    }
  });
});

describe('cssUnit: the overlay unit --u (spec §4.6)', () => {
  it('is k / dpr CSS px in pixel mode: 1536×760 @1.25 → 2.4', () => {
    const i = computeScale(1536, 760, 1.25, 'pixel');
    expect(cssUnit(i)).toBeCloseTo(2.4, 12);
    expect(cssUnit(i)).toBeCloseTo(i.k / i.dpr, 12);
  });

  it('follows the fitted canvas in fit mode, where k / dpr would be wrong: 900×500 @1 → 1.85', () => {
    const i = computeScale(900, 500, 1, 'pixel');
    expect(i).toMatchObject({ mode: 'fit', k: 1, dpr: 1 });
    expect(cssUnit(i)).toBeCloseTo(1.85, 12);
    expect(cssUnit(i) * 480).toBeCloseTo(i.cssW, 12);
    expect(cssUnit(i) * 270).toBeLessThanOrEqual(500);
  });
});

describe('offscreen layer caches', () => {
  const fakeLayer = (): Layer => ({ canvas: document.createElement('canvas'), g: {} as CanvasRenderingContext2D });

  it('cachedLayer paints each key once and returns the cached layer afterwards', () => {
    const cache = new Map<string, Layer>();
    const paint = vi.fn(fakeLayer);
    const a = cachedLayer(cache, 'a', paint);
    expect(cachedLayer(cache, 'a', paint)).toBe(a);
    expect(paint).toHaveBeenCalledTimes(1);
    expect(cachedLayer(cache, 'b', paint)).not.toBe(a);
    expect(paint).toHaveBeenCalledTimes(2);
    expect(cache.get('a')).toBe(a);
  });

  it('layersPerEnd paints once per (surface, viewer end), the spectator sharing end 0', () => {
    const painted: [Surface, PlayerId][] = [];
    const layerFor = layersPerEnd((surface, end) => {
      painted.push([surface, end]);
      return fakeLayer();
    });
    const hard0 = layerFor('hard', 0);
    expect(layerFor('hard', 'spectator')).toBe(hard0);
    expect(layerFor('hard', 0)).toBe(hard0);
    const hard1 = layerFor('hard', 1);
    expect(hard1).not.toBe(hard0);
    expect(layerFor('hard', 1)).toBe(hard1);
    const clay0 = layerFor('clay', 'spectator');
    expect(clay0).not.toBe(hard0);
    expect(painted).toEqual([
      ['hard', 0],
      ['hard', 1],
      ['clay', 0],
    ]);
  });

  it('gives each layersPerEnd lookup its own cache', () => {
    const courts = layersPerEnd(fakeLayer);
    const nets = layersPerEnd(fakeLayer);
    expect(nets('grass', 1)).not.toBe(courts('grass', 1));
  });
});

/** Minimal 2D context stand-in: jsdom has no canvas backend. */
interface FakeCtx {
  canvas: HTMLCanvasElement;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
  draws: { src: unknown; dw: number; dh: number; smooth: boolean; quality: ImageSmoothingQuality }[];
  drawImage(src: unknown, ...args: number[]): void;
}

interface FakeQuery {
  media: string;
  listeners: Set<() => void>;
}

describe('Screen', () => {
  const ctxs = new Map<HTMLCanvasElement, FakeCtx>();
  let queries: FakeQuery[] = [];

  function setWindow(w: number, h: number, dpr: number): void {
    for (const [key, value] of [['innerWidth', w], ['innerHeight', h], ['devicePixelRatio', dpr]] as const) {
      Object.defineProperty(window, key, { value, configurable: true, writable: true });
    }
  }

  function liveQueries(): FakeQuery[] {
    return queries.filter((q) => q.listeners.size > 0);
  }

  beforeEach(() => {
    ctxs.clear();
    queries = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      let ctx = ctxs.get(this);
      if (!ctx) {
        ctx = {
          canvas: this,
          imageSmoothingEnabled: true,
          imageSmoothingQuality: 'low',
          draws: [],
          drawImage(src: unknown, ...args: number[]) {
            const [dw, dh] = args.length === 4 ? args.slice(2) : args.slice(6);
            this.draws.push({ src, dw: dw!, dh: dh!, smooth: this.imageSmoothingEnabled, quality: this.imageSmoothingQuality });
          },
        };
        ctxs.set(this, ctx);
      }
      return ctx as unknown as CanvasRenderingContext2D;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (media: string) => {
        const q: FakeQuery = { media, listeners: new Set() };
        queries.push(q);
        return {
          media,
          matches: true,
          addEventListener: (_type: string, cb: () => void) => q.listeners.add(cb),
          removeEventListener: (_type: string, cb: () => void) => q.listeners.delete(cb),
        };
      },
    });
    setWindow(1536, 760, 1.25);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('owns a 480×270 back buffer with smoothing off', () => {
    const screen = new Screen(document.createElement('canvas'));
    expect([screen.buf.canvas.width, screen.buf.canvas.height]).toEqual([480, 270]);
    expect(screen.buf.imageSmoothingEnabled).toBe(false);
  });

  it('sizes and places the canvas in whole device pixels', () => {
    const canvas = document.createElement('canvas');
    const screen = new Screen(canvas);
    expect(screen.info).toEqual(computeScale(1536, 760, 1.25, 'pixel'));
    expect([canvas.width, canvas.height]).toEqual([1440, 810]);
    expect(canvas.style.width).toBe('1152px');
    expect(canvas.style.height).toBe('648px');
    expect(canvas.style.left).toBe('192px');
    expect(canvas.style.top).toBe('56px');
  });

  it('re-scales on window resize and reports each change once', () => {
    const canvas = document.createElement('canvas');
    const screen = new Screen(canvas);
    const seen: ScaleInfo[] = [];
    screen.onChange((i) => seen.push(i));
    setWindow(1920, 1080, 1);
    window.dispatchEvent(new Event('resize'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ k: 4, dpr: 1, cssW: 1920, mode: 'pixel' });
    expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
    screen.resize();
    expect(seen).toHaveLength(1);
  });

  it('follows a devicePixelRatio change (zoom or another monitor) and re-arms the dppx query', () => {
    const canvas = document.createElement('canvas');
    const screen = new Screen(canvas);
    const seen: ScaleInfo[] = [];
    screen.onChange((i) => seen.push(i));
    expect(liveQueries().map((q) => q.media)).toEqual(['(resolution: 1.25dppx)']);
    setWindow(1536, 760, 2);
    for (const cb of [...liveQueries()[0]!.listeners]) cb();
    expect(seen.at(-1)).toMatchObject({ dpr: 2, k: 5, mode: 'pixel' });
    expect([canvas.width, canvas.height]).toEqual([2400, 1350]);
    expect(liveQueries().map((q) => q.media)).toEqual(['(resolution: 2dppx)']);
  });

  it('falls back to fit mode in a small window and when fit is requested', () => {
    setWindow(900, 500, 1);
    const canvas = document.createElement('canvas');
    const screen = new Screen(canvas);
    expect(screen.info.mode).toBe('fit');
    expect([canvas.width, canvas.height]).toEqual([888, 500]);
    setWindow(1920, 1080, 1);
    screen.resize();
    expect(screen.info.mode).toBe('pixel');
    screen.mode = 'fit';
    expect(screen.mode).toBe('fit');
    expect(screen.info.mode).toBe('fit');
  });

  it('presents pixel mode as one nearest-neighbour blit of the whole buffer', () => {
    const canvas = document.createElement('canvas');
    const screen = new Screen(canvas);
    screen.present();
    const draws = ctxs.get(canvas)!.draws;
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ src: screen.buf.canvas, dw: 1440, dh: 810, smooth: false });
  });

  it('presents fit mode as a nearest-neighbour upscale to ceil(scale) then a smooth downscale', () => {
    setWindow(900, 500, 1);
    const canvas = document.createElement('canvas');
    const screen = new Screen(canvas);
    screen.present();
    const final = ctxs.get(canvas)!.draws;
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ dw: 888, dh: 500, smooth: true, quality: 'high' });
    const up = final[0]!.src as HTMLCanvasElement;
    expect([up.width, up.height]).toEqual([960, 540]);
    expect(ctxs.get(up)!.draws).toEqual([
      expect.objectContaining({ src: screen.buf.canvas, dw: 960, dh: 540, smooth: false }),
    ]);
  });
});
