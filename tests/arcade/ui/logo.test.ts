// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { arcadeLogoCanvas, STAMP_ROOM, stampPixels } from '../../../src/arcade/ui/logo';
import { LOGO_H, LOGO_W } from '../../../src/ui/logo';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the ARCADE stamp on the logo (spec §6.3)', () => {
  it('lies on the canvas, hanging off the right of the game logo by at most STAMP_ROOM', () => {
    const px = stampPixels();
    expect(px.length).toBeGreaterThan(0);
    for (const p of px) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(LOGO_W + STAMP_ROOM);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(LOGO_H);
    }
    expect(Math.max(...px.map((p) => p.x))).toBeGreaterThanOrEqual(LOGO_W);
  });

  it('is tilted without doubling a pixel, and the same every time', () => {
    const px = stampPixels();
    expect(new Set(px.map((p) => `${p.x},${p.y}`)).size).toBe(px.length);
    expect(stampPixels()).toEqual(px);
  });

  it('is a labelled canvas STAMP_ROOM wider than the game logo', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const c = arcadeLogoCanvas();
    expect([c.width, c.height]).toEqual([LOGO_W + STAMP_ROOM, LOGO_H]);
    expect(c.className).toBe('logo stamped');
    expect(c.getAttribute('role')).toBe('img');
    expect(c.getAttribute('aria-label')).toBe('Black Belt Tennis Arcade');
  });
});
