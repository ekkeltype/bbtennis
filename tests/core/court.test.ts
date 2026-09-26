import { describe, expect, it } from 'vitest';
import {
  COURT,
  endSign,
  inServiceBox,
  inSinglesHalf,
  netHeightAt,
  rallyTargets,
  receiverSpot,
  restSpot,
  serveTargets,
  serverSpot,
} from '../../src/core/court';
import type { PlayerId, Side, Vec2 } from '../../src/core/types';

const PLAYERS: PlayerId[] = [0, 1];
const SIDES: Side[] = ['deuce', 'ad'];
const VARIANTS: ('T' | 'wide')[] = ['T', 'wide'];
const MS: (1 | -1)[] = [1, -1];

/** Spec §3.0 sign of an end, written out independently of the implementation. */
const sign = (p: PlayerId): number => (p === 0 ? 1 : -1);
/** Spec §3.2.6 box coordinates (a = from the centre service line, b = from the net). */
const boxCoords = (p: Vec2, receiver: PlayerId, side: Side): { a: number; b: number } => {
  const sigma = side === 'deuce' ? 1 : -1;
  return { a: sign(receiver) * sigma * p.x, b: -sign(receiver) * p.y };
};

describe('COURT', () => {
  it('holds the spec §3.0 dimensions', () => {
    expect(COURT).toEqual({
      singlesHalfWidth: 4.115,
      doublesHalfWidth: 5.485,
      halfLength: 11.885,
      serviceLine: 6.4,
      netCenterH: 0.914,
      netPostH: 1.07,
      postX: 6.4,
    });
  });
});

describe('endSign', () => {
  it('is +1 for end 0 and -1 for end 1', () => {
    expect(endSign(0)).toBe(1);
    expect(endSign(1)).toBe(-1);
  });
});

describe('player spots', () => {
  it('places the server per spec §3.0', () => {
    expect(serverSpot(0, 'deuce')).toEqual({ x: 0.8, y: -12.3 });
    expect(serverSpot(1, 'deuce')).toEqual({ x: -0.8, y: 12.3 });
    expect(serverSpot(0, 'ad')).toEqual({ x: -0.8, y: -12.3 });
    expect(serverSpot(1, 'ad')).toEqual({ x: 0.8, y: 12.3 });
  });

  it('places the receiver per spec §3.0', () => {
    expect(receiverSpot(1, 'deuce')).toEqual({ x: -3.0, y: 12.5 });
    expect(receiverSpot(0, 'deuce')).toEqual({ x: 3.0, y: -12.5 });
    expect(receiverSpot(1, 'ad')).toEqual({ x: 3.0, y: 12.5 });
  });

  it('puts server and receiver on the same diagonal half (cross-court)', () => {
    for (const side of SIDES) {
      for (const server of PLAYERS) {
        const receiver: PlayerId = server === 0 ? 1 : 0;
        expect(Math.sign(serverSpot(server, side).x)).toBe(-Math.sign(receiverSpot(receiver, side).x));
      }
    }
  });

  it('rests the striker at the centre of their own baseline', () => {
    expect(restSpot(0)).toEqual({ x: 0, y: -12.2 });
    expect(restSpot(1)).toEqual({ x: 0, y: 12.2 });
  });

  it('keeps every spot behind its own baseline by at most 1.2 m and within |x| <= 5.8', () => {
    for (const p of PLAYERS) {
      const spots = [serverSpot(p, 'deuce'), serverSpot(p, 'ad'), receiverSpot(p, 'deuce'), receiverSpot(p, 'ad'), restSpot(p)];
      for (const spot of spots) {
        const behind = -sign(p) * spot.y - 11.885;
        expect(behind).toBeGreaterThanOrEqual(0);
        expect(behind).toBeLessThanOrEqual(1.2);
        expect(Math.abs(spot.x)).toBeLessThanOrEqual(5.8);
      }
    }
  });
});

describe('serveTargets', () => {
  it('maps the spec §3.2.6 box coordinates for server 0 deuce -> receiver 1 deuce box', () => {
    expect(serveTargets(1, 'deuce', 'T')).toEqual([
      { x: -2.06, y: 4.2 },
      { x: -3.115, y: 5.4 },
      { x: -0.4, y: 6.0 },
    ]);
    expect(serveTargets(1, 'deuce', 'wide')).toEqual([
      { x: -2.06, y: 4.2 },
      { x: -1.0, y: 5.4 },
      { x: -3.715, y: 6.0 },
    ]);
    for (const variant of VARIANTS) {
      for (const t of serveTargets(1, 'deuce', variant)) {
        expect(t.x).toBeGreaterThanOrEqual(-4.115);
        expect(t.x).toBeLessThanOrEqual(0);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeLessThanOrEqual(6.4);
      }
    }
  });

  it('puts every target inside the receiver\'s diagonal box and outside the other box', () => {
    for (const receiver of PLAYERS) {
      for (const side of SIDES) {
        const otherSide: Side = side === 'deuce' ? 'ad' : 'deuce';
        for (const variant of VARIANTS) {
          for (const t of serveTargets(receiver, side, variant)) {
            const { a, b } = boxCoords(t, receiver, side);
            expect(a).toBeGreaterThanOrEqual(0);
            expect(a).toBeLessThanOrEqual(4.115);
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThanOrEqual(6.4);
            expect(inServiceBox(t, receiver, side)).toBe(true);
            expect(inServiceBox(t, receiver, otherSide)).toBe(false);
          }
        }
      }
    }
  });

  it('keeps the hard target exactly 0.40 m from the nearest box line (T and wide)', () => {
    for (const receiver of PLAYERS) {
      for (const side of SIDES) {
        for (const variant of VARIANTS) {
          const hard = serveTargets(receiver, side, variant)[2]!;
          const { a, b } = boxCoords(hard, receiver, side);
          const margin = Math.min(a, 4.115 - a, b, 6.4 - b);
          expect(margin).toBeCloseTo(0.4, 9);
        }
      }
    }
  });

  it('puts medium on the opposite half of the box from hard', () => {
    const mid = 4.115 / 2;
    for (const receiver of PLAYERS) {
      for (const side of SIDES) {
        for (const variant of VARIANTS) {
          const [, medium, hard] = serveTargets(receiver, side, variant);
          const am = boxCoords(medium!, receiver, side).a;
          const ah = boxCoords(hard!, receiver, side).a;
          expect((am - mid) * (ah - mid)).toBeLessThan(0);
        }
      }
    }
  });
});

describe('rallyTargets', () => {
  it('maps the spec §3.3.3 coordinates onto the destination half', () => {
    expect(rallyTargets(1, 1)).toEqual([
      { x: 0, y: 8.885 },
      { x: -2.865, y: 9.385 },
      { x: 3.615, y: 11.385 },
    ]);
    expect(rallyTargets(0, 1)).toEqual([
      { x: 0, y: -8.885 },
      { x: 2.865, y: -9.385 },
      { x: -3.615, y: -11.385 },
    ]);
  });

  it('never produces a negative zero', () => {
    for (const dest of PLAYERS) {
      for (const m of MS) {
        for (const t of rallyTargets(dest, m)) {
          expect(Object.is(t.x, -0)).toBe(false);
          expect(Object.is(t.y, -0)).toBe(false);
        }
      }
    }
  });

  it('keeps every target inside the destination singles half', () => {
    for (const dest of PLAYERS) {
      for (const m of MS) {
        for (const t of rallyTargets(dest, m)) {
          expect(inSinglesHalf(t, dest)).toBe(true);
          expect(inSinglesHalf(t, dest === 0 ? 1 : 0)).toBe(false);
        }
      }
    }
  });

  it('keeps the hard target 0.5 m inside the sideline and the baseline', () => {
    for (const dest of PLAYERS) {
      for (const m of MS) {
        const hard = rallyTargets(dest, m)[2]!;
        expect(4.115 - Math.abs(hard.x)).toBeCloseTo(0.5, 9);
        expect(11.885 - Math.abs(hard.y)).toBeCloseTo(0.5, 9);
      }
    }
  });

  it('puts medium on the opposite side of the centre from hard', () => {
    for (const dest of PLAYERS) {
      for (const m of MS) {
        const [, medium, hard] = rallyTargets(dest, m);
        expect(medium!.x * hard!.x).toBeLessThan(0);
      }
    }
  });

  it('puts medium on the destination player\'s right when m = +1', () => {
    for (const dest of PLAYERS) {
      expect(sign(dest) * rallyTargets(dest, 1)[1]!.x).toBeGreaterThan(0);
    }
  });

  it('flips x when m flips and leaves y unchanged', () => {
    for (const dest of PLAYERS) {
      const plus = rallyTargets(dest, 1);
      const minus = rallyTargets(dest, -1);
      for (let i = 0; i < 3; i++) {
        expect(minus[i]!.x).toBeCloseTo(-plus[i]!.x, 12);
        expect(minus[i]!.y).toBe(plus[i]!.y);
      }
    }
  });
});

describe('inSinglesHalf', () => {
  it('counts points exactly on the sideline, baseline and corner as in', () => {
    expect(inSinglesHalf({ x: 4.115, y: -5 }, 0)).toBe(true);
    expect(inSinglesHalf({ x: -4.115, y: -5 }, 0)).toBe(true);
    expect(inSinglesHalf({ x: 0, y: -11.885 }, 0)).toBe(true);
    expect(inSinglesHalf({ x: -4.115, y: 11.885 }, 1)).toBe(true);
  });

  it('counts points 1 mm outside the sideline or baseline as out', () => {
    expect(inSinglesHalf({ x: 4.116, y: -5 }, 0)).toBe(false);
    expect(inSinglesHalf({ x: -4.116, y: 5 }, 1)).toBe(false);
    expect(inSinglesHalf({ x: 0, y: -11.886 }, 0)).toBe(false);
    expect(inSinglesHalf({ x: 0, y: 11.886 }, 1)).toBe(false);
  });

  it('counts a point in the other half as out', () => {
    expect(inSinglesHalf({ x: 0, y: 5 }, 0)).toBe(false);
    expect(inSinglesHalf({ x: 0, y: -5 }, 1)).toBe(false);
  });

  it('counts the doubles alley as out', () => {
    expect(inSinglesHalf({ x: 5.0, y: -5 }, 0)).toBe(false);
  });
});

describe('inServiceBox', () => {
  it('counts the service line, sideline and centre service line as in', () => {
    // receiver 1, deuce: x in [-4.115, 0], y in [0, 6.4]
    expect(inServiceBox({ x: -2, y: 6.4 }, 1, 'deuce')).toBe(true);
    expect(inServiceBox({ x: -4.115, y: 3 }, 1, 'deuce')).toBe(true);
    expect(inServiceBox({ x: 0, y: 3 }, 1, 'deuce')).toBe(true);
    // receiver 0, ad (their left = -x): x in [-4.115, 0], y in [-6.4, 0]
    expect(inServiceBox({ x: -4.115, y: -6.4 }, 0, 'ad')).toBe(true);
  });

  it('counts points 1 mm past a box line as out', () => {
    expect(inServiceBox({ x: -2, y: 6.401 }, 1, 'deuce')).toBe(false);
    expect(inServiceBox({ x: -4.116, y: 3 }, 1, 'deuce')).toBe(false);
    expect(inServiceBox({ x: 0.001, y: 3 }, 1, 'deuce')).toBe(false);
  });

  it('counts the other box and the other half as out', () => {
    expect(inServiceBox({ x: 2, y: 3 }, 1, 'deuce')).toBe(false);
    expect(inServiceBox({ x: -2, y: -3 }, 1, 'deuce')).toBe(false);
  });

  it('uses each receiver\'s own right for the deuce box', () => {
    expect(inServiceBox({ x: 2, y: -3 }, 0, 'deuce')).toBe(true);
    expect(inServiceBox({ x: -2, y: 3 }, 1, 'deuce')).toBe(true);
    expect(inServiceBox({ x: -2, y: -3 }, 0, 'ad')).toBe(true);
    expect(inServiceBox({ x: 2, y: 3 }, 1, 'ad')).toBe(true);
  });
});

describe('netHeightAt', () => {
  it('is 0.914 m at the centre and 1.07 m at the posts', () => {
    expect(netHeightAt(0)).toBe(0.914);
    expect(netHeightAt(6.4)).toBeCloseTo(1.07, 12);
    expect(netHeightAt(-6.4)).toBeCloseTo(1.07, 12);
  });

  it('rises linearly between centre and post', () => {
    expect(netHeightAt(3.2)).toBeCloseTo(0.992, 12);
    expect(netHeightAt(-1.6)).toBeCloseTo(0.953, 12);
  });

  it('stays at post height beyond the posts', () => {
    expect(netHeightAt(8)).toBeCloseTo(1.07, 12);
    expect(netHeightAt(-10)).toBeCloseTo(1.07, 12);
  });
});
