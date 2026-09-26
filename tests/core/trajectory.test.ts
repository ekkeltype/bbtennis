import { describe, expect, it } from 'vitest';
import { seedRng, uniform } from '../../src/core/rng';
import { ballAt, buildFlight, chaseFeet, stanceFor, tossZ } from '../../src/core/trajectory';
import type { BallFlight, PlayerId, ShotOutcome, Tier, Vec2, Vec3 } from '../../src/core/types';

type FlightArgs = Parameters<typeof buildFlight>[0];

const TIER_ARC: Record<Tier, number> = { easy: 2.0, medium: 1.7, hard: 1.4 };
const SERVE_ARC = 0.9;

/** A rally shot from player 0's baseline to player 1's half. */
const rally = (over: Partial<FlightArgs> = {}): BallFlight =>
  buildFlight({
    isServe: false,
    tier: 'medium',
    p0: { x: 1, y: -12, z: 1 },
    landing: { x: -2, y: 9 },
    outcome: 'in',
    T: 2800,
    grace: 400,
    destEnd: 1,
    ...over,
  });

/** Time the straight horizontal path p0 → landing crosses y = 0, computed independently. */
const crossingT = (p0: Vec3, landing: Vec2, T: number): number => (p0.y / (p0.y - landing.y)) * 0.6 * T;

const dist3 = (a: Vec3, b: Vec3): number => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);

const expectVec3Close = (actual: Vec3, expected: Vec3, digits = 9): void => {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
};

describe('buildFlight', () => {
  it('copies its inputs and derives tBounce = 0.6 T', () => {
    const f = rally({ tier: 'hard', outcome: 'out', T: 3000, grace: 250, destEnd: 1 });
    expect(f.isServe).toBe(false);
    expect(f.tier).toBe('hard');
    expect(f.outcome).toBe('out');
    expect(f.T).toBe(3000);
    expect(f.grace).toBe(250);
    expect(f.destEnd).toBe(1);
    expect(f.p0).toEqual({ x: 1, y: -12, z: 1 });
    expect(f.landing).toEqual({ x: -2, y: 9 });
    expect(f.tBounce).toBeCloseTo(1800, 9);
  });

  it('does not alias the caller\'s p0 and landing objects', () => {
    const p0 = { x: 1, y: -12, z: 1 };
    const landing = { x: -2, y: 9 };
    const f = rally({ p0, landing });
    p0.x = 99;
    landing.y = 99;
    expect(f.p0.x).toBe(1);
    expect(f.landing.y).toBe(9);
  });

  it('is plain JSON-safe data', () => {
    for (const outcome of ['in', 'out', 'net'] as ShotOutcome[]) {
      const f = rally({ outcome });
      expect(JSON.parse(JSON.stringify(f))).toStrictEqual(f);
    }
  });

  it('keeps the tier arc when the ball already clears the net', () => {
    for (const tier of ['easy', 'medium', 'hard'] as Tier[]) {
      expect(rally({ tier }).h).toBe(TIER_ARC[tier]);
    }
  });

  it('uses the serve arc for serves', () => {
    const f = buildFlight({
      isServe: true,
      tier: 'hard',
      p0: { x: 0.8, y: -12.3, z: 3.0 },
      landing: { x: -2.06, y: 4.2 },
      outcome: 'in',
      T: 3400,
      grace: 400,
      destEnd: 1,
    });
    expect(f.h).toBe(SERVE_ARC);
  });

  it('raises a low serve just enough to be 1.3 m high at the net plane', () => {
    const p0 = { x: 0.8, y: -12.3, z: 1.8 };
    const landing = { x: -2.06, y: 4.2 };
    const f = buildFlight({ isServe: true, tier: 'easy', p0, landing, outcome: 'in', T: 3400, grace: 400, destEnd: 1 });
    expect(f.h).toBeGreaterThan(SERVE_ARC);
    expect(ballAt(f, crossingT(p0, landing, 3400)).z).toBeCloseTo(1.3, 9);
  });

  it('continues 3 m past the landing in the same horizontal direction to reach contact', () => {
    expect(rally({ p0: { x: 0, y: -12, z: 1 }, landing: { x: 0, y: 8 } }).contact).toEqual({ x: 0, y: 11 });
    const f = rally({ p0: { x: -3, y: -12, z: 1 }, landing: { x: 1, y: 4 } });
    const d = Math.sqrt(4 * 4 + 16 * 16);
    expect(f.contact.x).toBeCloseTo(1 + (3 * 4) / d, 9);
    expect(f.contact.y).toBeCloseTo(4 + (3 * 16) / d, 9);
  });

  it('clamps contact to at most 1.2 m behind the baseline (landing 0.2 m inside it)', () => {
    const toEnd1 = rally({ p0: { x: 0, y: -12, z: 1 }, landing: { x: 0, y: 11.685 }, destEnd: 1 });
    expect(toEnd1.contact.y - 11.885).toBeLessThanOrEqual(1.2 + 1e-12);
    expect(toEnd1.contact.y - 11.885).toBeCloseTo(1.2, 9);
    const toEnd0 = rally({ p0: { x: 0, y: 12, z: 1 }, landing: { x: 0, y: -11.685 }, destEnd: 0 });
    expect(-toEnd0.contact.y - 11.885).toBeCloseTo(1.2, 9);
  });

  it('clamps contact to |x| <= 5.8', () => {
    const f = rally({ p0: { x: -5.8, y: -3, z: 1 }, landing: { x: 4, y: 1 } });
    expect(f.contact.x).toBeCloseTo(5.8, 12);
    const g = rally({ p0: { x: 5.8, y: -3, z: 1 }, landing: { x: -4, y: 1 } });
    expect(g.contact.x).toBeCloseTo(-5.8, 12);
  });

  it('gives an IN ball no call and the net-plane crossing time', () => {
    const f = rally({ outcome: 'in' });
    expect(f.callT).toBeNull();
    expect(f.netT).toBeCloseTo(crossingT(f.p0, f.landing, f.T), 9);
  });

  it('gives an OUT ball a call at the bounce', () => {
    const f = rally({ outcome: 'out' });
    expect(f.callT).toBe(f.tBounce);
    expect(f.netT).toBeCloseTo(crossingT(f.p0, f.landing, f.T), 9);
  });

  it('gives a NET ball a call when it reaches the net plane, before the bounce', () => {
    const f = rally({ outcome: 'net' });
    expect(f.netT).toBeCloseTo(crossingT(f.p0, f.landing, f.T), 9);
    expect(f.callT).toBe(f.netT);
    expect(f.callT!).toBeLessThan(f.tBounce);
  });

  it('gives netT = null when the path never crosses the net plane', () => {
    const f = rally({ p0: { x: 0, y: 3, z: 1 }, landing: { x: 0, y: 9 } });
    expect(f.netT).toBeNull();
    expect(f.callT).toBeNull();
  });

  it('keeps every non-NET ball at least 1.3 m high at the net plane (200 random shots per tier)', () => {
    const rng = seedRng(20260926);
    const r = (lo: number, hi: number): number => lo + (hi - lo) * uniform(rng);
    const kinds: { isServe: boolean; tier: Tier }[] = [
      { isServe: false, tier: 'easy' },
      { isServe: false, tier: 'medium' },
      { isServe: false, tier: 'hard' },
      { isServe: true, tier: 'medium' },
    ];
    let raised = 0;
    for (const { isServe, tier } of kinds) {
      const base = isServe ? SERVE_ARC : TIER_ARC[tier];
      for (let i = 0; i < 200; i++) {
        const striker: PlayerId = uniform(rng) < 0.5 ? 0 : 1;
        const s = striker === 0 ? 1 : -1;
        const p0 = { x: r(-5.8, 5.8), y: -s * r(3, 13.085), z: r(0.3, 3.2) };
        const landing = { x: r(-5, 5), y: s * r(0.3, 12.5) };
        const outcome: ShotOutcome = uniform(rng) < 0.5 ? 'in' : 'out';
        const T = r(500, 20000);
        const f = buildFlight({ isServe, tier, p0, landing, outcome, T, grace: 400, destEnd: striker === 0 ? 1 : 0 });
        const tNet = crossingT(p0, landing, T);
        const atNet = ballAt(f, tNet);
        expect(Math.abs(atNet.y)).toBeLessThan(1e-9);
        expect(atNet.z).toBeGreaterThanOrEqual(1.3 - 1e-9);
        expect(f.netT).toBeCloseTo(tNet, 6);
        expect(f.h).toBeGreaterThanOrEqual(base);
        if (f.h > base) {
          raised++;
          expect(atNet.z).toBeCloseTo(1.3, 9);
        }
      }
    }
    expect(raised).toBeGreaterThan(0);
  });
});

describe('ballAt', () => {
  it('starts at p0, bounces at the landing and reaches contact at T (z = 1.0)', () => {
    for (const f of [rally(), rally({ tier: 'hard', p0: { x: -4, y: 12.5, z: 0.7 }, landing: { x: 3, y: -10 }, destEnd: 0 })]) {
      expectVec3Close(ballAt(f, 0), f.p0);
      expectVec3Close(ballAt(f, f.tBounce), { ...f.landing, z: 0 });
      expectVec3Close(ballAt(f, f.T), { ...f.contact, z: 1.0 });
    }
  });

  it('follows z0(1-u) + 4h u(1-u) before the bounce with a straight horizontal path', () => {
    const f = rally();
    for (const u of [0.25, 0.5, 0.8]) {
      const b = ballAt(f, u * f.tBounce);
      expect(b.z).toBeCloseTo(1 * (1 - u) + 4 * f.h * u * (1 - u), 9);
      expect(b.x).toBeCloseTo(1 + (-2 - 1) * u, 9);
      expect(b.y).toBeCloseTo(-12 + (9 + 12) * u, 9);
    }
  });

  it('follows u + 2.4 u(1-u) after the bounce', () => {
    const f = rally();
    for (const u of [0.25, 0.5, 0.75]) {
      const b = ballAt(f, f.tBounce + u * (f.T - f.tBounce));
      expect(b.z).toBeCloseTo(u + 2.4 * u * (1 - u), 9);
      expect(b.x).toBeCloseTo(f.landing.x + (f.contact.x - f.landing.x) * u, 9);
      expect(b.y).toBeCloseTo(f.landing.y + (f.contact.y - f.landing.y) * u, 9);
    }
  });

  it('is continuous across the bounce and the contact instant', () => {
    const f = rally();
    for (const t of [f.tBounce, f.T]) {
      expect(dist3(ballAt(f, t - 1e-6), ballAt(f, t + 1e-6))).toBeLessThan(1e-4);
    }
  });

  it('keeps the post-bounce horizontal velocity through the stretch window while z falls 1.0 -> 0.3', () => {
    const f = rally();
    const vx = (f.contact.x - f.landing.x) / (f.T - f.tBounce);
    const vy = (f.contact.y - f.landing.y) / (f.T - f.tBounce);
    const half = ballAt(f, f.T + f.grace / 2);
    expect(half.z).toBeCloseTo(0.65, 9);
    const end = ballAt(f, f.T + f.grace);
    expect(end.z).toBeCloseTo(0.3, 9);
    expect(end.x).toBeCloseTo(f.contact.x + vx * f.grace, 9);
    expect(end.y).toBeCloseTo(f.contact.y + vy * f.grace, 9);
  });

  it('lets a passed ball keep falling after the stretch window but never below the ground', () => {
    const f = rally();
    expect(ballAt(f, f.T + 1.2 * f.grace).z).toBeLessThan(0.3);
    expect(ballAt(f, f.T + 10 * f.grace).z).toBe(0);
  });

  it('treats negative times as the strike instant', () => {
    const f = rally();
    expect(ballAt(f, -50)).toEqual(ballAt(f, 0));
  });

  it('never yields NaN or a negative height for T in [500, 20000]', () => {
    const shots: Partial<FlightArgs>[] = [
      {},
      { outcome: 'out', tier: 'easy' },
      { outcome: 'net', tier: 'hard' },
      { isServe: true, p0: { x: 0.8, y: -12.3, z: 3.2 }, landing: { x: -0.4, y: 6 }, outcome: 'net' },
      { p0: { x: 2, y: -10, z: 1 }, landing: { x: 2, y: -10 } },
      { p0: { x: 0, y: 3, z: 1 }, landing: { x: 0, y: 9 }, outcome: 'net' },
    ];
    for (const T of [500, 501, 1234.5, 2800, 7777, 20000]) {
      for (const over of shots) {
        const f = rally({ ...over, T });
        const end = T + f.grace + 2000;
        for (let i = 0; i <= 200; i++) {
          const b = ballAt(f, (end * i) / 200);
          expect(Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z)).toBe(true);
          expect(b.z).toBeGreaterThanOrEqual(0);
        }
        for (const v of [f.tBounce, f.h, f.contact.x, f.contact.y]) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  describe('NET ball', () => {
    const netShot = (): { f: BallFlight; netT: number } => {
      const f = rally({ outcome: 'net', tier: 'hard' });
      return { f, netT: f.netT! };
    };

    it('reaches the net plane at 0.6 m', () => {
      const { f, netT } = netShot();
      const b = ballAt(f, netT);
      expect(Math.abs(b.y)).toBeLessThan(1e-9);
      expect(b.z).toBeCloseTo(0.6, 9);
    });

    it('stays above the ground on the way to the net', () => {
      const { f, netT } = netShot();
      for (let i = 0; i < 50; i++) expect(ballAt(f, (netT * i) / 50).z).toBeGreaterThan(0);
    });

    it('drops to the ground over 400 ms, moving 0.3 m back onto the striker\'s side', () => {
      const { f, netT } = netShot();
      const atNet = ballAt(f, netT);
      const mid = ballAt(f, netT + 200);
      const down = ballAt(f, netT + 400);
      expect(mid.z).toBeLessThan(atNet.z);
      expect(mid.z).toBeGreaterThan(0);
      expect(down.z).toBe(0);
      expect(Math.sign(down.y)).toBe(Math.sign(f.p0.y));
      expect(Math.hypot(down.x - atNet.x, down.y - atNet.y)).toBeCloseTo(0.3, 9);
      const back = { x: f.p0.x - f.landing.x, y: f.p0.y - f.landing.y };
      const moved = { x: down.x - atNet.x, y: down.y - atNet.y };
      expect(back.x * moved.y - back.y * moved.x).toBeCloseTo(0, 9);
      expect(back.x * moved.x + back.y * moved.y).toBeGreaterThan(0);
    });

    it('rests where it dropped and never reaches the other half', () => {
      const { f, netT } = netShot();
      const down = ballAt(f, netT + 400);
      expect(ballAt(f, netT + 5000)).toEqual(down);
      for (let t = netT + 1; t <= f.T + f.grace; t += 50) expect(Math.sign(ballAt(f, t).y)).not.toBe(Math.sign(f.landing.y));
    });

    it('hits the net at 0.6 m even for a serve struck high (a downward drive)', () => {
      const p0 = { x: 0.8, y: -12.3, z: 3.2 };
      const landing = { x: -0.4, y: 6 };
      const s = buildFlight({ isServe: true, tier: 'hard', p0, landing, outcome: 'net', T: 3400, grace: 400, destEnd: 1 });
      expect(ballAt(s, s.netT!).z).toBeCloseTo(0.6, 9);
      for (let i = 0; i < 50; i++) expect(ballAt(s, (s.netT! * i) / 50).z).toBeGreaterThan(0);
    });

    it('drops back onto player 1\'s side when player 1 strikes', () => {
      const g = rally({ outcome: 'net', p0: { x: -1, y: 12, z: 1 }, landing: { x: 2, y: -9 }, destEnd: 0 });
      expect(ballAt(g, g.netT! + 400).y).toBeGreaterThan(0);
    });
  });
});

describe('tossZ', () => {
  it('rises from 1.8 m to 3.2 m at the apex and is back at 1.8 m at 2a', () => {
    for (const a of [2000, 1200]) {
      expect(tossZ(0, a)).toBeCloseTo(1.8, 12);
      expect(tossZ(a, a)).toBeCloseTo(3.2, 12);
      expect(tossZ(2 * a, a)).toBeCloseTo(1.8, 12);
      expect(tossZ(a / 2, a)).toBeCloseTo(1.8 + 1.4 * 0.75, 12);
    }
  });

  it('holds the ball in hand before the toss', () => {
    expect(tossZ(-100, 2000)).toBeCloseTo(1.8, 12);
  });

  it('keeps falling after 2a (a dropped ball) but never below the ground', () => {
    expect(tossZ(4400, 2000)).toBeLessThan(1.8);
    expect(tossZ(4400, 2000)).toBeGreaterThan(0);
    expect(tossZ(20000, 2000)).toBe(0);
  });
});

describe('stanceFor', () => {
  it('plays a forehand for contact on the player\'s right, feet 0.7 m to the left of it', () => {
    expect(stanceFor({ x: 2, y: -11 }, 0, { x: 0, y: -12.3 })).toEqual({ feet: { x: 1.3, y: -11 }, forehand: true });
  });

  it('plays a backhand for contact on the player\'s left, feet 0.7 m to the right of it', () => {
    expect(stanceFor({ x: -2, y: -11 }, 0, { x: 0, y: -12.3 })).toEqual({ feet: { x: -1.3, y: -11 }, forehand: false });
  });

  it('uses -x as player 1\'s right', () => {
    const fh = stanceFor({ x: -2, y: 11 }, 1, { x: 0, y: 12.3 });
    expect(fh.forehand).toBe(true);
    expect(fh.feet.x).toBeCloseTo(-1.3, 12);
    expect(fh.feet.y).toBe(11);
    const bh = stanceFor({ x: 2, y: 11 }, 1, { x: 0, y: 12.3 });
    expect(bh.forehand).toBe(false);
    expect(bh.feet.x).toBeCloseTo(1.3, 12);
  });

  it('judges the side relative to the player\'s position, not the centre line', () => {
    const st = stanceFor({ x: 2, y: -11 }, 0, { x: 3, y: -12 });
    expect(st.forehand).toBe(false);
    expect(st.feet.x).toBeCloseTo(2.7, 12);
  });

  it('plays a backhand for contact straight ahead (forehand needs contact strictly to the right)', () => {
    expect(stanceFor({ x: 1, y: -11 }, 0, { x: 1, y: -12 }).forehand).toBe(false);
  });

  it('keeps the feet within |x| <= 5.8', () => {
    expect(stanceFor({ x: 5.5, y: -12.5 }, 0, { x: 5.8, y: -12 }).feet.x).toBe(5.8);
    expect(stanceFor({ x: -5.5, y: -12.5 }, 0, { x: -5.8, y: -12 }).feet.x).toBe(-5.8);
  });
});

describe('chaseFeet', () => {
  const from = { x: 3, y: 12.5 };
  const stance = { x: -1, y: 11.5 };

  it('starts at `from` and ends at the stance', () => {
    expect(chaseFeet(from, stance, 0)).toEqual(from);
    expect(chaseFeet(from, stance, 1)).toEqual(stance);
  });

  it('eases out: 75 % of the way at half progress', () => {
    const p = chaseFeet(from, stance, 0.5);
    expect(p.x).toBeCloseTo(3 - 4 * 0.75, 12);
    expect(p.y).toBeCloseTo(12.5 - 1 * 0.75, 12);
  });

  it('moves monotonically toward the stance as progress rises', () => {
    let last = Infinity;
    for (let i = 0; i <= 20; i++) {
      const p = chaseFeet(from, stance, i / 20);
      const d = Math.hypot(p.x - stance.x, p.y - stance.y);
      expect(d).toBeLessThanOrEqual(last);
      last = d;
    }
  });

  it('clamps progress to [0, 1]', () => {
    expect(chaseFeet(from, stance, -0.5)).toEqual(from);
    expect(chaseFeet(from, stance, 1.5)).toEqual(stance);
  });
});
