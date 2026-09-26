import { describe, expect, it } from 'vitest';
import { COURT } from '../../src/core/court';
import type { PlayerId, Vec3 } from '../../src/core/types';
import { FLOOR } from '../../src/render/court';
import { H, W, netScreenY, project, scaleAt, unprojectGround } from '../../src/render/projection';

const VIEWERS: (PlayerId | 'spectator')[] = [0, 1, 'spectator'];
const { doublesHalfWidth: DX, halfLength: HL } = COURT;

describe('buffer size', () => {
  it('is 480×270', () => {
    expect([W, H]).toEqual([480, 270]);
  });
});

describe('project (spec §4.1)', () => {
  it('puts the near doubles baseline corners at (90, 240) and (390, 240)', () => {
    const left = project({ x: -DX, y: -HL, z: 0 }, 0);
    const right = project({ x: DX, y: -HL, z: 0 }, 0);
    expect(left.x).toBeCloseTo(90, 1);
    expect(left.y).toBeCloseTo(240, 6);
    expect(right.x).toBeCloseTo(390, 1);
    expect(right.y).toBeCloseTo(240, 6);
    expect(left.d).toBeCloseTo(1, 9);
  });

  it('draws the far doubles baseline 150 px wide at y = 80', () => {
    const left = project({ x: -DX, y: HL, z: 0 }, 0);
    const right = project({ x: DX, y: HL, z: 0 }, 0);
    expect(right.x - left.x).toBeCloseTo(150, 1);
    expect(left.y).toBeCloseTo(80, 6);
    expect(right.y).toBeCloseTo(80, 6);
    expect(left.d).toBeCloseTo(2, 9);
  });

  it('puts the net line at y ≈ 133.3 for every viewer', () => {
    for (const v of VIEWERS) expect(project({ x: 3, y: 0, z: 0 }, v).y).toBeCloseTo(133.333, 2);
    expect(netScreenY()).toBeCloseTo(133.333, 2);
  });

  it('keeps a point 1.2 m behind the near baseline on pixel row ≤ 257', () => {
    const p = project({ x: 0, y: -HL - 1.2, z: 0 }, 0);
    expect(Math.round(p.y)).toBeLessThanOrEqual(257);
    expect(p.y).toBeLessThan(H);
  });

  it('lifts a point by z·27.35/d pixels', () => {
    const ground = project({ x: 1, y: 4, z: 0 }, 0);
    const up = project({ x: 1, y: 4, z: 2 }, 0);
    expect(up.x).toBeCloseTo(ground.x, 9);
    expect(ground.y - up.y).toBeCloseTo((2 * 27.35) / ground.d, 9);
  });

  it('rotates court geometry 180° for viewer 1: (x, y) → (−x, −y)', () => {
    const pts: Vec3[] = [
      { x: -DX, y: -HL, z: 0 },
      { x: 2.5, y: 7.1, z: 1.3 },
      { x: -4.115, y: 6.4, z: 0.5 },
    ];
    for (const p of pts) {
      const seen = project(p, 1);
      const rotated = project({ x: -p.x, y: -p.y, z: p.z }, 0);
      expect(seen.x).toBeCloseTo(rotated.x, 9);
      expect(seen.y).toBeCloseTo(rotated.y, 9);
      expect(seen.d).toBeCloseTo(rotated.d, 9);
    }
    const nearForViewer1 = project({ x: DX, y: HL, z: 0 }, 1);
    expect(nearForViewer1.x).toBeCloseTo(90, 1);
    expect(nearForViewer1.y).toBeCloseTo(240, 6);
  });

  it('shows the spectator the end-0 view', () => {
    const p = { x: 1.7, y: -3.2, z: 0.8 };
    expect(project(p, 'spectator')).toEqual(project(p, 0));
  });
});

describe('unprojectGround', () => {
  it('inverts project on the ground for every viewer', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: -DX, y: -HL },
      { x: DX, y: HL },
      { x: 3.1, y: -8.7 },
      { x: -5.8, y: 13.085 },
      { x: 4.4, y: -13.085 },
    ];
    for (const v of VIEWERS) {
      for (const p of pts) {
        const s = project({ ...p, z: 0 }, v);
        const back = unprojectGround(s.x, s.y, v);
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
      }
    }
  });

  it('maps the screen centre column onto the court centre line', () => {
    expect(unprojectGround(240, 200, 0).x).toBeCloseTo(0, 12);
    expect(unprojectGround(240, 200, 1).x).toBeCloseTo(0, 12);
  });
});

describe('scaleAt', () => {
  it('is 27.35 px/m at the near baseline and half that at the far one', () => {
    expect(scaleAt(-HL, 0)).toBeCloseTo(27.35, 9);
    expect(scaleAt(HL, 0)).toBeCloseTo(13.675, 9);
    expect(scaleAt(0, 'spectator')).toBeCloseTo(27.35 / 1.5, 9);
  });

  it('follows the viewer rotation', () => {
    expect(scaleAt(HL, 1)).toBeCloseTo(27.35, 9);
    expect(scaleAt(-HL, 1)).toBeCloseTo(13.675, 9);
  });

  it('matches the horizontal spread of project', () => {
    for (const v of VIEWERS) {
      const a = project({ x: 0, y: 5.2, z: 0 }, v);
      const b = project({ x: 1, y: 5.2, z: 0 }, v);
      expect(Math.abs(b.x - a.x)).toBeCloseTo(scaleAt(5.2, v), 9);
    }
  });
});

describe('stadium floor (court layer extent)', () => {
  it('has side edges that are straight walls parallel to the court, mirrored left/right', () => {
    const walls = [FLOOR.top, 100, 160, 200].map((sy) => ({
      left: unprojectGround(FLOOR.edge - sy, sy, 0).x,
      right: unprojectGround(W - FLOOR.edge + sy, sy, 0).x,
    }));
    for (const w of walls) {
      expect(w.left).toBeCloseTo(walls[0]!.left, 9);
      expect(w.right).toBeCloseTo(-w.left, 9);
    }
  });

  it('holds every player position of spec §3.0 (≤ 1.2 m behind a baseline, |x| ≤ 5.8)', () => {
    expect(unprojectGround(W / 2, FLOOR.top, 0).y).toBeGreaterThan(HL + 1.2);
    expect(-unprojectGround(FLOOR.edge - FLOOR.top, FLOOR.top, 0).x).toBeGreaterThan(5.8);
    for (const v of [0, 1] as const) {
      const far = project({ x: 5.8, y: v === 0 ? HL + 1.2 : -HL - 1.2, z: 0 }, v);
      expect(far.y).toBeGreaterThan(FLOOR.top);
      expect(far.x).toBeLessThan(W - 1 - FLOOR.edge + far.y);
    }
  });
});
