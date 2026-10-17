import { describe, expect, it } from 'vitest';
import { Effects } from '../../src/render/effects';

/** A 2D context stand-in that counts the rectangles filled. */
function countingContext(): { ctx: CanvasRenderingContext2D; fills: () => number } {
  let fills = 0;
  const state: Record<string, unknown> = { fillStyle: '#000000', globalAlpha: 1, fillRect: () => fills++ };
  const ctx = new Proxy(state, {
    get: (t, key: string) => (key in t ? t[key] : () => undefined),
    set: (t, key: string, value) => {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, fills: () => fills };
}

describe('Effects public triggers', () => {
  it('bouncePuff on clay adds one clay mark, and clearMarks empties them', () => {
    const fx = new Effects();
    fx.bouncePuff({ x: 1, y: 2 }, 'clay', false);
    expect(fx.clayMarks).toEqual([{ x: 1, y: 2 }]);
    fx.clearMarks();
    expect(fx.clayMarks).toHaveLength(0);
  });

  it('bouncePuff on other surfaces leaves no mark but still draws a puff', () => {
    const fx = new Effects();
    fx.bouncePuff({ x: 0, y: 0 }, 'hard', false);
    expect(fx.clayMarks).toHaveLength(0);
    const { ctx, fills } = countingContext();
    fx.draw(ctx, 0);
    expect(fills()).toBeGreaterThan(0);
  });

  it('spark and runDust spawn drawable particles that age out', () => {
    const fx = new Effects();
    fx.spark({ x: 0, y: 0, z: 1 }, false);
    fx.runDust({ x: 1, y: 1 }, 'hard', false);
    const a = countingContext();
    fx.draw(a.ctx, 0);
    expect(a.fills()).toBeGreaterThan(0);
    fx.advance(1000, false);
    const b = countingContext();
    fx.draw(b.ctx, 0);
    expect(b.fills()).toBe(0);
  });

  it('cheer raises crowd excitement to at least the level, then it decays', () => {
    const fx = new Effects();
    fx.cheer(0.7);
    expect(fx.crowdExcite).toBeGreaterThanOrEqual(0.7);
    fx.cheer(0.2);
    expect(fx.crowdExcite).toBeGreaterThanOrEqual(0.7);
    fx.advance(1000, false);
    expect(fx.crowdExcite).toBeLessThan(0.7);
    expect(fx.crowdExcite).toBeGreaterThan(0);
  });

  it('startShake shakes for 300 ms, then stops', () => {
    const fx = new Effects();
    expect(fx.shake()).toEqual({ x: 0, y: 0 });
    fx.startShake();
    expect(fx.shake()).not.toEqual({ x: 0, y: 0 });
    fx.advance(299, false);
    expect(fx.shake()).not.toEqual({ x: 0, y: 0 });
    fx.advance(1, false);
    expect(fx.shake()).toEqual({ x: 0, y: 0 });
  });

  it('startShake does nothing once reduce effects was on at the last advance', () => {
    const fx = new Effects();
    fx.advance(16, true);
    fx.startShake();
    expect(fx.shake()).toEqual({ x: 0, y: 0 });
    fx.advance(16, false);
    fx.startShake();
    expect(fx.shake()).not.toEqual({ x: 0, y: 0 });
  });

  it('confettiBurst throws pieces (fewer with reduce effects) that fall out of view', () => {
    const full = new Effects();
    full.confettiBurst(false);
    const thin = new Effects();
    thin.confettiBurst(true);
    expect(full.confetti).toBeGreaterThan(thin.confetti);
    expect(thin.confetti).toBeGreaterThan(0);
    full.advance(20000, false);
    expect(full.confetti).toBe(0);
  });
});
