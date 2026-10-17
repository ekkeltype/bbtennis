import { describe, expect, it } from 'vitest';
import { normalIH, seedRng } from '../../src/core/rng';
import { COURT } from '../../src/core/court';
import { ARCADE } from '../../src/arcade/core/tuning';
import { buildFlight } from '../../src/arcade/core/flight';
import { aimTarget, chargeAt, kmhOf, rallyGrade, resolveHit, serveGrade, tossZ } from '../../src/arcade/core/shot';
import type { Flight, Grade, HitEvent, PlayerId, ShotType } from '../../src/arcade/core/types';

describe('rallyGrade', () => {
  it.each([
    [8, 'rushed'], [9, 'clean'], [29, 'clean'], [30, 'perfect'], [37, 'perfect'], [38, 'clean'],
  ] as const)('%i ticks after commit is %s', (d, g) => {
    expect(rallyGrade(100, 100 + d)).toBe(g);
  });
  it('chargeAt is clamped to 0..1', () => {
    expect(chargeAt(0, 15)).toBeCloseTo(0.5, 9);
    expect(chargeAt(0, 90)).toBe(1);
    expect(chargeAt(10, 5)).toBe(0);
  });
});

describe('serveGrade and tossZ (Normal pace, apex at tick 39)', () => {
  it.each([
    [26, 'rushed'], [27, 'clean'], [38, 'clean'], [39, 'perfect'], [46, 'perfect'], [47, 'clean'], [60, 'clean'], [61, 'rushed'],
  ] as const)('hit at %i is %s', (h, g) => {
    expect(serveGrade(0, h, 'normal')).toBe(g);
  });
  it('apex scales with pace', () => {
    expect(serveGrade(0, 30, 'lightning')).toBe('perfect'); // apex at 30 ticks
  });
  it('tossZ peaks at the apex and is symmetric', () => {
    expect(tossZ(0, 'normal')).toBeCloseTo(1.8, 9);
    expect(tossZ(39, 'normal')).toBeCloseTo(3.2, 9);
    expect(tossZ(39 - 10, 'normal')).toBeCloseTo(tossZ(39 + 10, 'normal'), 9);
    expect(tossZ(78, 'normal')).toBeCloseTo(1.8, 9);
  });
});

const aim = (o: Partial<Parameters<typeof aimTarget>[0]>) =>
  aimTarget({ hitter: 0, type: 'topspin', grade: 'perfect', mx: 0, my: 0, serveSide: null, ...o });

describe('aimTarget rally', () => {
  // The perfect grade's margin from ARCADE (0.5 m at the spec's starting values).
  const pm = ARCADE.grade.perfect.margin;
  it('player 0, mx +1, perfect: deep to the right', () => {
    const t = aim({ mx: 1, my: 1 });
    expect(t.x).toBeCloseTo(COURT.singlesHalfWidth - pm, 9);
    expect(t.y).toBeCloseTo(COURT.halfLength - pm, 9);
  });
  it('player 1 mirrors', () => {
    const t = aim({ hitter: 1, mx: 1, my: 1 });
    expect(t.x).toBeCloseTo(-(COURT.singlesHalfWidth - pm), 9);
    expect(t.y).toBeCloseTo(-(COURT.halfLength - pm), 9);
  });
  it('neutral and short', () => {
    expect(aim({}).y).toBeCloseTo(9.385, 9);
    expect(aim({ hitter: 1 }).y).toBeCloseTo(-9.385, 9);
    expect(aim({ my: -1 }).y).toBeCloseTo(5.4, 9);
  });
  it('lob with my -1 is deep, not short', () => {
    const t = aim({ type: 'lob', my: -1 });
    expect(t.y).toBeCloseTo(COURT.halfLength - pm - ARCADE.aim.lobExtraMargin, 9);
  });
  it('smash uses smashMargin', () => {
    expect(aim({ type: 'smash', my: 1 }).y).toBeCloseTo(COURT.halfLength - ARCADE.aim.smashMargin, 9);
  });
  it('rushed is pulled 50 % toward (0, 8.385)', () => {
    const t = aim({ grade: 'rushed', mx: 1, my: 1 });
    expect(t.x).toBeCloseTo(0.5 * (COURT.singlesHalfWidth - 1.0), 9);
    expect(t.y).toBeCloseTo(0.5 * (COURT.halfLength - 1.0) + 0.5 * 8.385, 9);
  });
});

describe('aimTarget serve', () => {
  // The flat serve's margin from ARCADE (0.25 m at the spec's starting values): wide = singlesHalfWidth − margin.
  const m = ARCADE.serveMargin.serveFlat;
  const wide = COURT.singlesHalfWidth - m;
  const depth = COURT.serviceLine - m;
  it('player 0 deuce: box at x < 0; mx -1 wide, +1 T, 0 body', () => {
    const w = aim({ type: 'serveFlat', mx: -1, serveSide: 'deuce' });
    expect(w.x).toBeCloseTo(-wide, 9);
    expect(w.y).toBeCloseTo(depth, 9);
    expect(aim({ type: 'serveFlat', mx: 1, serveSide: 'deuce' }).x).toBeCloseTo(-m, 9);
    expect(aim({ type: 'serveFlat', mx: 0, serveSide: 'deuce' }).x).toBeCloseTo(-COURT.singlesHalfWidth / 2, 9);
  });
  it('mirrors for the ad side and for player 1', () => {
    expect(aim({ type: 'serveFlat', mx: 1, serveSide: 'ad' }).x).toBeCloseTo(wide, 9);
    const p1 = aim({ hitter: 1, type: 'serveFlat', mx: -1, serveSide: 'deuce' });
    expect(p1.x).toBeCloseTo(wide, 9);
    expect(p1.y).toBeCloseTo(-depth, 9);
  });
  it('rushed serves lerp toward the box centre', () => {
    const pull = ARCADE.serveGrade.rushed.pull;
    const t = aim({ type: 'serveFlat', grade: 'rushed', mx: -1, serveSide: 'deuce' });
    expect(t.x).toBeCloseTo(-((1 - pull) * wide + pull * COURT.singlesHalfWidth / 2), 9);
    expect(t.y).toBeCloseTo((1 - pull) * depth + pull * COURT.serviceLine / 2, 9);
  });
});

type Args = Parameters<typeof resolveHit>[0];
const base = (o: Partial<Args> = {}): Args => ({
  tick: 100, player: 0, type: 'topspin', grade: 'clean', stretch: false, volley: false, charge: 1,
  contact: { x: 0, y: -12, z: 1 }, incomingSpeed: 0, mx: 0, my: 0, pace: 'normal', serveSide: null, ...o,
});

describe('resolveHit', () => {
  it('draws exactly 3 normals', () => {
    for (const type of ['topspin', 'lob', 'smash', 'serveFlat'] as ShotType[]) {
      const a = seedRng(7);
      const b = seedRng(7);
      resolveHit(base({ type, serveSide: type === 'serveFlat' ? 'deuce' : null }), a);
      normalIH(b); normalIH(b); normalIH(b);
      expect(a).toEqual(b);
    }
  });
  it('is deterministic', () => {
    expect(resolveHit(base(), seedRng(3))).toEqual(resolveHit(base(), seedRng(3)));
  });
  it('powers: perfect, clean base + per charge, rushed, stretch factor, serve from serve grade (ARCADE.grade, .stretch, .serveGrade)', () => {
    const g = ARCADE.grade;
    expect(resolveHit(base({ grade: 'perfect' }), seedRng(1)).power).toBeCloseTo(g.perfect.power, 9);
    expect(resolveHit(base({ charge: 0.5 }), seedRng(1)).power).toBeCloseTo(g.clean.powerBase + 0.5 * g.clean.powerPerCharge, 9);
    expect(resolveHit(base({ grade: 'rushed' }), seedRng(1)).power).toBeCloseTo(g.rushed.power, 9);
    expect(resolveHit(base({ grade: 'perfect', stretch: true }), seedRng(1)).power).toBeCloseTo(g.perfect.power * ARCADE.stretch.power, 9);
    const s = base({ type: 'serveFlat', grade: 'clean', charge: 0, serveSide: 'deuce' });
    expect(resolveHit(s, seedRng(1)).power).toBeCloseTo(ARCADE.serveGrade.clean.power, 9);
  });
  it('T follows the drawn scatter normals', () => {
    const a = base({ grade: 'perfect' });
    const h = resolveHit(a, seedRng(11));
    const r = seedRng(11);
    const n1 = normalIH(r), n2 = normalIH(r), n3 = normalIH(r);
    const gs = ARCADE.grade.perfect.scatter;
    const sg = ARCADE.scatter.sigma * gs;
    const tx = sg * n1, ty = COURT.halfLength - ARCADE.aim.neutralFromBaseline + sg * n2;
    expect(h.target.x).toBeCloseTo(tx, 9);
    expect(h.target.y).toBeCloseTo(ty, 9);
    const dist = Math.sqrt(tx * tx + (ty + 12) * (ty + 12));
    const T = (dist / (ARCADE.shots.topspin.speed * ARCADE.grade.perfect.power)) * (1 + ARCADE.scatter.tSigma * gs * n3);
    expect(h.T).toBeCloseTo(T, 9);
  });
  it('lob T has a floor scaled by pace', () => {
    for (let s = 0; s < 200; s++) {
      expect(resolveHit(base({ type: 'lob', grade: 'rushed', stretch: true }), seedRng(s)).T).toBeGreaterThanOrEqual(2.0 - 1e-9);
      expect(resolveHit(base({ type: 'lob', pace: 'lightning' }), seedRng(s)).T).toBeGreaterThanOrEqual(2.0 / 1.3 - 1e-9);
    }
  });
  it('depth is clamped to minDepth', () => {
    for (let s = 0; s < 300; s++) {
      const h = resolveHit(base({ my: -1, grade: 'rushed', stretch: true, type: 'slice' }), seedRng(s));
      expect(h.target.y).toBeGreaterThanOrEqual(ARCADE.aim.minDepth - 1e-9); // receiver is player 1: depth = y
    }
  });
  it('incoming speed widens scatter', () => {
    const sd = (inc: number): number => {
      const r = seedRng(5);
      let s2 = 0;
      for (let i = 0; i < 1500; i++) { const x = resolveHit(base({ incomingSpeed: inc }), r).target.x; s2 += x * x; }
      return Math.sqrt(s2 / 1500);
    };
    expect(sd(30)).toBeGreaterThan(sd(0) * 1.3);
  });
});

describe('scatter statistics', () => {
  const sdX = (o: Partial<Args>, expected: number): void => {
    const r = seedRng(2024);
    let s = 0, s2 = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) { const x = resolveHit(base(o), r).target.x; s += x; s2 += x * x; }
    const m = s / n;
    const sd = Math.sqrt(s2 / n - m * m);
    expect(sd).toBeGreaterThan(expected * 0.9);
    expect(sd).toBeLessThan(expected * 1.1);
  };
  const { sigma } = ARCADE.scatter;
  it('clean neutral topspin SD is scatter.sigma × the clean factor', () => sdX({}, sigma * ARCADE.grade.clean.scatter));
  it('rushed + stretch SD is scatter.sigma × the rushed and stretch factors', () =>
    sdX({ grade: 'rushed' as Grade, stretch: true }, sigma * ARCADE.grade.rushed.scatter * ARCADE.stretch.scatter));
});

describe('kmhOf', () => {
  it('40 m/s flat serve is about 144 km/h including z', () => {
    const player: PlayerId = 0;
    const hit: HitEvent = { tick: 0, player, type: 'serveFlat', grade: 'clean', stretch: false, volley: false, power: 1, contact: { x: 0, y: -11.885, z: 2.8 }, target: { x: -2, y: 6 }, T: 0.5 };
    const f = buildFlight(hit);
    const v = f.segments[0]!.v0;
    expect(kmhOf(f)).toBeCloseTo(Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * 3.6, 9);
    expect(kmhOf(f)).toBeGreaterThan(100);
    const fake = { segments: [{ t0: 0, p0: { x: 0, y: 0, z: 0 }, v0: { x: 0, y: 24, z: 32 }, a: { x: 0, y: 0, z: 0 } }] } as unknown as Flight;
    expect(kmhOf(fake)).toBeCloseTo(144, 9);
  });
});
