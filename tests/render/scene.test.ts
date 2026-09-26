import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlayerId, Surface } from '../../src/core/types';
import { relativeLuminance } from '../../src/render/color';
import { FLOOR, drawCourt } from '../../src/render/court';
import { OUTLINE, PAL, SURFACE_PAL } from '../../src/render/palette';
import { H, W } from '../../src/render/projection';
import { drawNet, drawUmpire } from '../../src/render/scene';

/** Opaque-or-clear software canvas: `#RRGGBB` strings per pixel, '' where nothing was drawn. */
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

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

class PixelContext {
  fillStyle = '#000000';
  imageSmoothingEnabled = true;
  constructor(readonly canvas: PixelCanvas) {}
  fillRect(x: number, y: number, w: number, h: number): void {
    if (![x, y, w, h].every(Number.isInteger)) throw new Error(`fillRect off the pixel grid: ${x},${y},${w},${h}`);
    if (!/^#[0-9A-F]{6}$/i.test(this.fillStyle)) throw new Error(`fillStyle must be #RRGGBB, got ${this.fillStyle}`);
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) this.set(px, py, this.fillStyle.toUpperCase());
  }
  drawImage(src: PixelCanvas, dx: number, dy: number): void {
    if (arguments.length !== 3 || !Number.isInteger(dx) || !Number.isInteger(dy)) throw new Error('drawImage must blit 1:1 at whole pixels');
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const c = src.px[y * src.width + x]!;
        if (c !== '') this.set(dx + x, dy + y, c);
      }
    }
  }
  createImageData(w: number, h: number): ImageData {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as unknown as ImageData;
  }
  putImageData(img: ImageData, dx: number, dy: number): void {
    const d = img.data;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        this.set(dx + x, dy + y, d[i + 3] === 0 ? '' : toHex(d[i]!, d[i + 1]!, d[i + 2]!));
      }
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

const SURFACES: readonly Surface[] = ['hard', 'clay', 'grass', 'dojo'];
const ENDS: readonly PlayerId[] = [0, 1];

/** A full-screen canvas after `paint` has drawn into it. */
function frame(paint: (g: CanvasRenderingContext2D) => void): PixelCanvas {
  const canvas = new PixelCanvas(W, H);
  paint(canvas.getContext() as unknown as CanvasRenderingContext2D);
  return canvas;
}

const court = (surface: Surface, end: PlayerId): PixelCanvas => frame((g) => drawCourt(g, surface, end));
const at = (c: PixelCanvas, x: number, y: number): string => (x < 0 || y < 0 || x >= W || y >= H ? '' : c.px[y * W + x]!);
const up = (c: string): string => c.toUpperCase();

/** Every (x, y) whose pixel satisfies `test`. */
function where(c: PixelCanvas, test: (color: string) => boolean): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (test(at(c, x, y))) out.push({ x, y });
  return out;
}

/** Wall distance of floor pixel (x, y) as the court painter measures it; −1 off the floor. */
function wallDistance(x: number, y: number): number {
  const left = FLOOR.edge - y;
  const right = W - 1 - left;
  if (y < FLOOR.top || x < left || x > right) return -1;
  return Math.min(y - FLOOR.top, x - left, right - x);
}

describe('drawCourt surface art', () => {
  it.each(ENDS)('hard-court scuffs keep at least 2 px of court between them and every line (viewer %i)', (end) => {
    const c = court('hard', end);
    const lines = where(c, (p) => p === up(SURFACE_PAL.hard.lines));
    const scuffs = where(c, (p) => p === up(SURFACE_PAL.hard.accent[0]!));
    // Both baselines keep their scuffs: the near one (screen rows ≥ 200) and the far one (rows < 100).
    expect(scuffs.filter((p) => p.y >= 200).length).toBeGreaterThan(0);
    expect(scuffs.filter((p) => p.y < 100).length).toBeGreaterThan(0);
    for (const s of scuffs) {
      const nearest = Math.min(...lines.map((l) => Math.max(Math.abs(l.x - s.x), Math.abs(l.y - s.y))));
      expect(nearest, `scuff pixel (${s.x}, ${s.y})`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(ENDS)('dojo floor has no checker dither: no 3×3 two-colour checker anywhere (viewer %i)', (end) => {
    const c = court('dojo', end);
    const checkers: string[] = [];
    for (let y = FLOOR.top; y < H - 2; y++) {
      for (let x = 0; x < W - 2; x++) {
        const [even, odd] = [at(c, x, y), at(c, x + 1, y)];
        if (even === '' || odd === '' || even === odd) continue;
        let dither = true;
        for (let j = 0; j < 3 && dither; j++) {
          for (let i = 0; i < 3 && dither; i++) dither = at(c, x + i, y + j) === ((i + j) % 2 === 0 ? even : odd);
        }
        if (dither) checkers.push(`(${x}, ${y})`);
      }
    }
    expect(checkers.slice(0, 10)).toEqual([]);
  });

  it.each(SURFACES.flatMap((s) => ENDS.map((e) => [s, e] as const)))(
    'the %s floor meets the walls with a solid 2 px contact shadow (viewer %i)',
    (surface, end) => {
      const c = court(surface, end);
      const surround = SURFACE_PAL[surface].surround;
      const contact = up(surround[surround.length - 1]!);
      const off: string[] = [];
      for (let y = FLOOR.top; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const d = wallDistance(x, y);
          if (d >= 0 && d <= 1 && at(c, x, y) !== contact) off.push(`(${x}, ${y}) ${at(c, x, y)}`);
        }
      }
      expect(off.slice(0, 10)).toEqual([]);
    },
  );

  /** Colours of the surface's base texture: court and surround ramps and the lines. */
  const baseColours = (surface: Surface): Set<string> =>
    new Set([...SURFACE_PAL[surface].court, ...SURFACE_PAL[surface].surround, SURFACE_PAL[surface].lines].map(up));
  /** The art's worn-patch tones, fringe then core: scuffed-light clay; dry turf around bare earth. */
  const PATCH_TONES = { clay: [PAL.clayHi, PAL.clayDust], grass: [PAL.tatamiLo, PAL.grassWorn] } as const;
  const neighbours = (c: PixelCanvas, x: number, y: number): string[] => [
    at(c, x - 1, y),
    at(c, x + 1, y),
    at(c, x, y - 1),
    at(c, x, y + 1),
  ];

  describe.each(['clay', 'grass'] as const)('%s worn baseline patches', (surface) => {
    it.each(ENDS)('are soft, coherent two-tone shapes, not speckle (viewer %i)', (end) => {
      const c = court(surface, end);
      const base = baseColours(surface);
      const line = up(SURFACE_PAL[surface].lines);
      const [fringe, core] = PATCH_TONES[surface].map(up) as [string, string];
      // No speckle: every pixel of a patch tone the surface does not otherwise use touches another of its tone.
      const exclusive = [fringe, core].filter((t) => !base.has(t));
      const isolated = where(c, (p) => exclusive.includes(p)).filter(({ x, y }) =>
        neighbours(c, x, y).every((n) => n !== at(c, x, y)),
      );
      expect(isolated.slice(0, 10)).toEqual([]);
      // The patches add only their two tones to the surface.
      expect(where(c, (p) => p !== '' && !base.has(p) && p !== fringe && p !== core).slice(0, 10)).toEqual([]);
      // Both baselines are worn: the near one (screen rows ≥ 200) and the far one (rows < 100).
      const cores = where(c, (p) => p === core);
      expect(cores.filter((p) => p.y >= 200).length).toBeGreaterThan(100);
      expect(cores.filter((p) => p.y < 100).length).toBeGreaterThan(20);
      // Soft: the core sits inside its fringe, never straight on the unworn surface.
      const bare = cores.filter(({ x, y }) => neighbours(c, x, y).some((n) => n !== core && n !== fringe && n !== line));
      expect(bare.slice(0, 10)).toEqual([]);
      // Coherent: a few solid shapes per court.
      expect(regions(c, cores)).toBeLessThanOrEqual(8);
    });
  });
});

/** Number of 4-connected same-colour regions among `pixels`. */
function regions(c: PixelCanvas, pixels: { x: number; y: number }[]): number {
  const keys = new Set(pixels.map(({ x, y }) => y * W + x));
  const seen = new Set<number>();
  let count = 0;
  for (const k of keys) {
    if (seen.has(k)) continue;
    count++;
    const tone = c.px[k];
    const stack = [k];
    seen.add(k);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const x = cur % W;
      for (const n of [cur - 1, cur + 1, cur - W, cur + W]) {
        if ((n === cur - 1 && x === 0) || (n === cur + 1 && x === W - 1)) continue;
        if (keys.has(n) && !seen.has(n) && c.px[n] === tone) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
  }
  return count;
}

describe('umpire chair', () => {
  const umpire = (look: -1 | 0 | 1): PixelCanvas => frame((g) => drawUmpire(g, { crowdExcite: 0, umpireLook: look, t: 0 }));
  const greens = new Set([PAL.boardGreenHi, PAL.boardGreen].map(up));

  it.each([-1, 0, 1] as const)("seats the umpire's shoes on the footrest (look %i)", (look) => {
    const c = umpire(look);
    const shoes = where(c, (p) => p === up(PAL.shadow));
    expect(shoes.length).toBeGreaterThanOrEqual(6);
    for (const x of new Set(shoes.map((p) => p.x))) {
      const sole = Math.max(...shoes.filter((p) => p.x === x).map((p) => p.y));
      expect(at(c, x, sole + 1), `below the shoe in column ${x}`).toBe(up(OUTLINE));
      expect(greens.has(at(c, x, sole + 2)), `footrest under the shoe in column ${x}`).toBe(true);
    }
  });

  it.each(SURFACES.flatMap((s) => ENDS.map((e) => [s, e] as const)))(
    'casts a solid, visible ground contact shadow on the %s floor (viewer %i)',
    (surface, end) => {
      const chair = umpire(0);
      const drawn = where(chair, (p) => p !== '');
      const foot = Math.max(...drawn.map((p) => p.y));
      const feet = drawn.filter((p) => p.y === foot).map((p) => p.x);
      const [l, r] = [Math.min(...feet) - 1, Math.max(...feet) + 1];
      const floor = court(surface, end);
      const scene = frame((g) => {
        drawCourt(g, surface, end);
        drawNet(g, surface, end);
        drawUmpire(g, { crowdExcite: 0, umpireLook: 0, t: 0 });
      });
      const shadow = new Set<string>();
      let darker = 0;
      for (let x = l; x <= r; x++) {
        const s = at(scene, x, foot + 1);
        shadow.add(s);
        if (relativeLuminance(s) < relativeLuminance(at(floor, x, foot + 1))) darker++;
      }
      expect([...shadow]).toHaveLength(1);
      expect(darker / (r - l + 1)).toBeGreaterThanOrEqual(0.7);
    },
  );
});
