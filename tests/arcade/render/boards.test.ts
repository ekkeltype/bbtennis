import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcadeRenderer } from '../../../src/arcade/render/renderer';
import { drawBackdrop } from '../../../src/render/scene';
import type { Screen } from '../../../src/render/screen';
import { matchInSetup } from '../matchHelpers';

vi.mock('../../../src/render/scene', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/render/scene')>()), drawBackdrop: vi.fn() }));

/** A canvas whose 2D context accepts and ignores every call. */
class NullCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): CanvasRenderingContext2D {
    const state: Record<string, unknown> = {
      canvas: this,
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    };
    return new Proxy(state, {
      get: (t, key: string) => (key in t ? t[key] : () => {}),
      set: (t, key: string, value) => {
        t[key] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  }
}

beforeEach(() => vi.stubGlobal('OffscreenCanvas', NullCanvas));
afterEach(() => vi.unstubAllGlobals());

describe('ArcadeRenderer backdrop', () => {
  it('paints the Arcade\'s own ad boards (HIT HARD, not the typing game\'s TYPE FAST)', () => {
    const screen = { buf: new NullCanvas(480, 270).getContext(), present: () => {} } as unknown as Screen;
    const { s } = matchInSetup(0);
    new ArcadeRenderer(screen).draw({ state: s, t: 0, events: [], viewer: 0, overlay: { paused: false, countdown: null } }, { reduceEffects: false }, 16);
    expect(vi.mocked(drawBackdrop)).toHaveBeenCalledWith(expect.anything(), s.config.surface, expect.anything(), 'arcade');
  });
});
