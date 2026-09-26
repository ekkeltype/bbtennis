import type { PlayerId, Surface } from '../core/types';
import { H, W, viewerEnd } from './projection';

/**
 * How the 480×270 buffer maps onto the window (spec §4.1). `k` is the whole device-pixel scale
 * (≥ 2 in pixel mode; in fit mode the floor of the fitted scale, at least 1). `cssW`/`cssH` and
 * `offsetX`/`offsetY` are CSS px whose device-pixel equivalents are whole numbers. One game pixel is
 * `cssW / 480` CSS px in both modes (`k / dpr` in pixel mode, the overlay's `--u`, spec §4.6).
 */
export interface ScaleInfo { k: number; dpr: number; cssW: number; cssH: number; mode: 'pixel' | 'fit'; offsetX: number; offsetY: number }

/** Float slack so an exactly-fitting fit-mode edge (e.g. 270 · 500/270) is not floored one pixel short. */
const EPS = 1e-6;

const positive = (v: number, fallback: number): number => (Number.isFinite(v) && v > 0 ? v : fallback);

/**
 * Scale for a `innerW`×`innerH` CSS px window at `dpr` (spec §4.1):
 * `k = floor(min(innerW·dpr/480, innerH·dpr/270))`. Pixel mode draws 480k×270k device px; when
 * `k < 2` or fit is requested it switches to fit mode, filling the window at the aspect ratio.
 * The result is centred at whole device pixels; broken inputs never yield k = 0 or a 0-px canvas.
 */
export function computeScale(innerW: number, innerH: number, dpr: number, mode: 'pixel' | 'fit'): ScaleInfo {
  const ratio = positive(dpr, 1);
  const devW = positive(innerW, 0) * ratio;
  const devH = positive(innerH, 0) * ratio;
  const fitted = Math.min(devW / W, devH / H);
  const whole = Math.floor(fitted);
  const pixel = mode === 'pixel' && whole >= 2;
  const w = pixel ? W * whole : Math.max(1, Math.floor(W * fitted + EPS));
  const h = pixel ? H * whole : Math.max(1, Math.floor(H * fitted + EPS));
  return {
    k: Math.max(1, whole),
    dpr: ratio,
    cssW: w / ratio,
    cssH: h / ratio,
    mode: pixel ? 'pixel' : 'fit',
    offsetX: Math.max(0, Math.floor((devW - w) / 2)) / ratio,
    offsetY: Math.max(0, Math.floor((devH - h) / 2)) / ratio,
  };
}

/** An offscreen drawing surface: its canvas (a `drawImage` source) and 2D context. */
export interface Layer { canvas: HTMLCanvasElement | OffscreenCanvas; g: CanvasRenderingContext2D }

/**
 * A `w`×`h` offscreen layer with image smoothing off: a detached `<canvas>` where the DOM exists,
 * otherwise an `OffscreenCanvas` (whose context offers the same drawing calls, typed as the DOM one).
 */
export function createLayer(w: number, h: number): Layer {
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  let g: CanvasRenderingContext2D | null;
  if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    g = canvas.getContext('2d');
  } else {
    canvas = new OffscreenCanvas(w, h);
    g = canvas.getContext('2d') as unknown as CanvasRenderingContext2D | null;
  }
  if (!g) throw new Error('2D canvas context unavailable');
  g.imageSmoothingEnabled = false;
  return { canvas, g };
}

/** The layer stored in `cache` under `key`, painted by `paint` and stored on first use. */
export function cachedLayer<K>(cache: Map<K, Layer>, key: K, paint: () => Layer): Layer {
  let layer = cache.get(key);
  if (!layer) cache.set(key, (layer = paint()));
  return layer;
}

/**
 * A lookup of static layers painted by `paint` once per (surface, viewer end), each lookup with its
 * own cache; `'spectator'` shares end 0's layer.
 */
export function layersPerEnd(
  paint: (surface: Surface, end: PlayerId) => Layer,
): (surface: Surface, viewer: PlayerId | 'spectator') => Layer {
  const cache = new Map<string, Layer>();
  return (surface, viewer) => {
    const end = viewerEnd(viewer);
    return cachedLayer(cache, `${surface}:${end}`, () => paint(surface, end));
  };
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas context unavailable');
  return g;
}

function sameInfo(a: ScaleInfo, b: ScaleInfo): boolean {
  return (Object.keys(a) as (keyof ScaleInfo)[]).every((key) => a[key] === b[key]);
}

/**
 * The visible canvas and its 480×270 back buffer (spec §4.1). Draw a frame into `buf`, then
 * `present()` it. Re-scales on window resize and on devicePixelRatio changes (zoom, another
 * monitor); `onChange` listeners hear every change of `info`.
 */
export class Screen {
  /** The 480×270 back buffer every painter draws into. */
  readonly buf: CanvasRenderingContext2D;
  /** Current scale and placement. */
  info: ScaleInfo;
  private readonly canvas: HTMLCanvasElement;
  private readonly out: CanvasRenderingContext2D;
  private readonly listeners: ((i: ScaleInfo) => void)[] = [];
  private requested: 'pixel' | 'fit' = 'pixel';
  private upscale: Layer | null = null;
  private dprQuery: MediaQueryList | null = null;
  private readonly onDprChange = (): void => this.resize();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.out = context2d(canvas);
    const buf = document.createElement('canvas');
    buf.width = W;
    buf.height = H;
    this.buf = context2d(buf);
    this.buf.imageSmoothingEnabled = false;
    this.info = this.measure();
    this.apply();
    window.addEventListener('resize', () => this.resize());
  }

  /** Requested display mode (Options → Display); `info.mode` is the effective one. Setting it re-scales. */
  get mode(): 'pixel' | 'fit' {
    return this.requested;
  }

  set mode(m: 'pixel' | 'fit') {
    this.requested = m;
    this.resize();
  }

  /** Re-measures the window; resizes and re-places the canvas and notifies listeners if anything changed. */
  resize(): void {
    const next = this.measure();
    if (sameInfo(next, this.info)) return;
    this.info = next;
    this.apply();
    for (const cb of this.listeners) cb(next);
  }

  /** Blits the back buffer to the visible canvas: nearest-neighbour, or in fit mode via a ceil(scale) upscale then smoothing. */
  present(): void {
    const { out, canvas } = this;
    if (this.info.mode === 'pixel') {
      out.imageSmoothingEnabled = false;
      out.drawImage(this.buf.canvas, 0, 0, canvas.width, canvas.height);
      return;
    }
    const u = Math.max(1, Math.ceil(canvas.width / W));
    if (this.upscale?.canvas.width !== W * u) this.upscale = createLayer(W * u, H * u);
    const up = this.upscale;
    up.g.imageSmoothingEnabled = false;
    up.g.drawImage(this.buf.canvas, 0, 0, W * u, H * u);
    out.imageSmoothingEnabled = true;
    out.imageSmoothingQuality = 'high';
    out.drawImage(up.canvas, 0, 0, canvas.width, canvas.height);
  }

  /** Registers `cb` for every later change of `info`. */
  onChange(cb: (i: ScaleInfo) => void): void {
    this.listeners.push(cb);
  }

  private measure(): ScaleInfo {
    return computeScale(window.innerWidth, window.innerHeight, window.devicePixelRatio, this.requested);
  }

  private apply(): void {
    const { canvas, info } = this;
    canvas.width = Math.round(info.cssW * info.dpr);
    canvas.height = Math.round(info.cssH * info.dpr);
    Object.assign(canvas.style, {
      position: 'fixed',
      left: `${info.offsetX}px`,
      top: `${info.offsetY}px`,
      width: `${info.cssW}px`,
      height: `${info.cssH}px`,
      imageRendering: 'pixelated',
    });
    this.watchDpr(info.dpr);
  }

  /** Listens for the window leaving the current resolution; re-armed after every change. */
  private watchDpr(dpr: number): void {
    if (typeof window.matchMedia !== 'function') return;
    const media = `(resolution: ${dpr}dppx)`;
    if (this.dprQuery?.media === media) return;
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = window.matchMedia(media);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }
}
