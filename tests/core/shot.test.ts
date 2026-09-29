import { describe, expect, it } from 'vitest';
import { drawShotRandoms, seedRng } from '../../src/core/rng';
import {
  contactFactor,
  displayKmh,
  effectiveSlips,
  flightTimeMs,
  graceMs,
  resolveShot,
  speedFactor,
  strikeV,
} from '../../src/core/shot';
import { PACE_MULT, TUNING } from '../../src/core/tuning';
import { ALL_TIERS, TIERS } from '../../src/core/types';
import type { ShotRandoms, ShotResult, Tier, Vec2 } from '../../src/core/types';

// Local fixtures from the spec numbers (court.ts is built in parallel and is not imported here).
type IsIn = (p: Vec2) => boolean;

/** Inclusive box check: lines are in. */
const inBox = (minX: number, maxX: number, minY: number, maxY: number): IsIn => (p) =>
  p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;

/** Receiver 1's deuce service box (spec §3.2.6 with s_r = −1, σ = +1). */
const inServeBox = inBox(-4.115, 0, 0, 6.4);
/** Player 1's singles half (spec §3.0). */
const inRallyHalf = inBox(-4.115, 4.115, 0, 11.885);

/** Serve targets for receiver 1, deuce side: box (a, b) → world (−a, b) (spec §3.2.6). */
const SERVE_TARGETS: Record<Tier, Vec2[]> = {
  easy: [{ x: -2.06, y: 4.2 }],
  medium: [{ x: -3.115, y: 5.4 }, { x: -1.0, y: 5.4 }], // hard is T / hard is wide
  hard: [{ x: -0.4, y: 6.0 }, { x: -3.715, y: 6.0 }], // T / wide
  insane: [{ x: -3.965, y: 6.25 }, { x: -0.15, y: 6.25 }], // hard is T → wide corner / hard is wide → T corner
};

/** Rally targets for destination player 1, m = +1 then m = −1 (spec §3.3.3). */
const RALLY_TARGETS: Record<Tier, Vec2[]> = {
  easy: [{ x: 0, y: 8.885 }],
  medium: [{ x: -2.865, y: 9.385 }, { x: 2.865, y: 9.385 }],
  hard: [{ x: 3.615, y: 11.385 }, { x: -3.615, y: 11.385 }],
  insane: [{ x: -3.965, y: 11.735 }, { x: 3.965, y: 11.735 }], // medium's side, m = +1 then −1
};

/** Randoms with the given r_net and the same four uniforms for zx and for zy. */
const randomsOf = (rNet: number, ux: readonly number[], uy: readonly number[]): ShotRandoms =>
  [rNet, ...ux, ...uy] as ShotRandoms;
/** Randoms with zx = zy = 0 (no scatter). */
const noScatter = (rNet: number): ShotRandoms => randomsOf(rNet, [0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]);

describe('speedFactor', () => {
  it('is 0.875 + 0.025·(cps − 3) inside the clamp', () => {
    expect(speedFactor(3)).toBeCloseTo(0.875, 12);
    expect(speedFactor(5)).toBeCloseTo(0.925, 12);
  });

  it('clamps to [0.80, 1.30]', () => {
    expect(speedFactor(-10)).toBeCloseTo(0.8, 12); // unclamped 0.55
    expect(speedFactor(40)).toBeCloseTo(1.3, 12); // unclamped 1.80
  });
});

describe('contactFactor', () => {
  const a = TUNING.tossApexMs * PACE_MULT.relaxed; // toss apex at Relaxed pace

  it('is 1.0 up to and including the apex', () => {
    expect(contactFactor(0, a)).toBe(1);
    expect(contactFactor(a / 2, a)).toBe(1);
    expect(contactFactor(a, a)).toBe(1);
  });

  it('falls linearly to 0.85 at 2a', () => {
    expect(contactFactor(1.5 * a, a)).toBeCloseTo(0.925, 12);
    expect(contactFactor(2 * a, a)).toBeCloseTo(0.85, 12);
  });

  it('never drops below 0.85 after 2a', () => {
    expect(contactFactor(3 * a, a)).toBeCloseTo(0.85, 12);
  });
});

describe('strikeV', () => {
  it('is the speed factor when there is no contact factor and no stretch', () => {
    expect(strikeV(5, {})).toBeCloseTo(0.925, 12);
  });

  it('multiplies by the serve contact factor after the clamp, without re-clamping', () => {
    expect(strikeV(5, { contactFactor: 0.9 })).toBeCloseTo(0.8325, 12);
    expect(strikeV(3, { contactFactor: 0.85 })).toBeCloseTo(0.74375, 12);
  });

  it('multiplies a stretch shot by 0.9 after the clamp, without re-clamping', () => {
    expect(strikeV(40, { stretch: true })).toBeCloseTo(1.17, 12);
    expect(strikeV(-10, { stretch: true })).toBeCloseTo(0.72, 12);
    expect(strikeV(-10, { stretch: false })).toBeCloseTo(0.8, 12);
  });
});

describe('flightTimeMs', () => {
  it('rally: pace·rallyBase/v · place · P(n), whatever the chase word\'s length (early-typing spec §3)', () => {
    const { rallyBaseMs: b, place, pressure: p } = TUNING.flight;
    expect(flightTimeMs({ pace: 1, chaseLen: 8, v: 1, tier: 'medium', isServe: false, n: 3 })).toBeCloseTo(b * place.medium * p, 9);
    expect(flightTimeMs({ pace: 0.6, chaseLen: 5, v: 1.25, tier: 'hard', isServe: false, n: 0 })).toBeCloseTo(((0.6 * b) / 1.25) * place.hard, 9);
    for (const chaseLen of [2, 9, 15]) {
      expect(flightTimeMs({ pace: 1, chaseLen, v: 1, tier: 'easy', isServe: false, n: 0 })).toBeCloseTo(b, 9);
    }
  });

  it('applies pressure once per two rally strikes (⌊n/2⌋) and never below the floor', () => {
    const { rallyBaseMs: b, pressure: p, pressureFloor: floor } = TUNING.flight;
    const at = (n: number): number => flightTimeMs({ pace: 1, chaseLen: 3, v: 1, tier: 'easy', isServe: false, n });
    expect(at(0)).toBeCloseTo(b, 9);
    expect(at(1)).toBeCloseTo(b, 9);
    expect(at(2)).toBeCloseTo(b * p, 9);
    expect(at(4)).toBeCloseTo(b * p * p, 9);
    expect(at(5)).toBeCloseTo(b * p * p, 9);
    expect(at(200)).toBeGreaterThanOrEqual(b * floor);
    expect(at(200)).toBeLessThan(at(40));
    for (let n = 0; n <= 60; n++) expect(at(n + 1)).toBeLessThanOrEqual(at(n));
  });

  it('keeps the pressure constants sane: 0 ≤ floor < pressure < 1', () => {
    const { pressure, pressureFloor } = TUNING.flight;
    expect(pressureFloor).toBeGreaterThanOrEqual(0);
    expect(pressureFloor).toBeLessThan(pressure);
    expect(pressure).toBeLessThan(1);
  });

  it('serve: place 1 for every tier plus the 500 + 350·pace reading allowance', () => {
    expect(flightTimeMs({ pace: 1.5, chaseLen: 4, v: 1, tier: 'hard', isServe: true, n: 0 })).toBeCloseTo(4925, 9); // 3900 + 500 + 525
    for (const tier of TIERS) {
      expect(flightTimeMs({ pace: 1, chaseLen: 10, v: 0.8, tier, isServe: true, n: 0 })).toBeCloseTo(4850, 9); // 3200/0.8 + 500 + 350
    }
  });

  it('insane serve: placeServeInsane (not place.insane, not 1) plus the same reading allowance', () => {
    const { place, placeServeInsane, serveReturnBonusMs, serveReturnBonusPaceMs, baseMs, perCharMs } = TUNING.flight;
    const pace = 1;
    const chaseLen = 14;
    const v = 1;
    const base = (pace * (baseMs + perCharMs * chaseLen)) / v;
    const allowance = serveReturnBonusMs + serveReturnBonusPaceMs * pace;
    const T = flightTimeMs({ pace, chaseLen, v, tier: 'insane', isServe: true, n: 0 });
    expect(T).toBeCloseTo(base * placeServeInsane + allowance, 9);
    expect(T).not.toBeCloseTo(base * place.insane + allowance, 5);
    expect(T).not.toBeCloseTo(base * 1 + allowance, 5);
    expect(placeServeInsane).toBeGreaterThan(place.hard);
    expect(place.insane).toBeLessThan(place.hard);
  });

  it('insane rally: still uses place.insane', () => {
    const { place, rallyBaseMs, pressure } = TUNING.flight;
    expect(flightTimeMs({ pace: 1, chaseLen: 14, v: 1, tier: 'insane', isServe: false, n: 2 })).toBeCloseTo(rallyBaseMs * place.insane * pressure, 9);
  });

  it('never leaves more time for harder placement: T(insane) < T(hard) < T(medium) < T(easy)', () => {
    const violations: string[] = [];
    for (const pace of Object.values(PACE_MULT)) {
      for (let chaseLen = 2; chaseLen <= 15; chaseLen++) {
        for (const v of [0.612, 0.85, 1.0, 1.3]) {
          for (let n = 0; n <= 9; n++) {
            const t = (tier: Tier): number =>
              flightTimeMs({ pace, chaseLen, v, tier, isServe: false, n });
            if (!(t('insane') < t('hard') && t('hard') < t('medium') && t('medium') < t('easy'))) {
              violations.push(`pace ${pace} len ${chaseLen} v ${v} n ${n}`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('graceMs', () => {
  it('is 400 ms × pace', () => {
    expect(graceMs(1)).toBeCloseTo(400, 9);
    expect(graceMs(PACE_MULT.relaxed)).toBeCloseTo(600, 9);
    expect(graceMs(PACE_MULT.lightning)).toBeCloseTo(240, 9);
  });
});

describe('displayKmh', () => {
  it('is round(95 × v × tier bonus) at rally depth 0', () => {
    expect(displayKmh(1, 'easy', 0, false)).toBe(95);
    expect(displayKmh(1, 'medium', 0, false)).toBe(100); // 99.75
    expect(displayKmh(1, 'hard', 0, false)).toBe(105); // 104.5
    expect(displayKmh(1, 'insane', 0, false)).toBe(114); // 95 × 1.2
    expect(displayKmh(0.8, 'easy', 0, false)).toBe(76);
  });

  it('divides by P(n) so deeper rallies read faster, but never by less than 1/maxPressureBoost', () => {
    const { pressure: p } = TUNING.flight;
    const { maxPressureBoost } = TUNING.kmh;
    expect(displayKmh(1, 'easy', 1, false)).toBe(95);
    expect(displayKmh(1, 'easy', 2, false)).toBe(Math.round(95 / p));
    expect(displayKmh(1, 'easy', 4, false)).toBe(Math.round(95 / (p * p)));
    expect(displayKmh(1, 'easy', 200, false)).toBe(Math.round(95 * maxPressureBoost));
  });

  it('multiplies serves by 1.25 and still shows a whole number', () => {
    expect(displayKmh(1, 'medium', 0, true)).toBe(125); // 124.6875
    expect(displayKmh(1.3, 'hard', 0, true)).toBe(170); // 169.8125
    expect(displayKmh(1, 'easy', 0, true)).toBe(119); // 118.75
  });
});

describe('effectiveSlips', () => {
  it('counts at most 3 slips', () => {
    expect([0, 1, 2, 3, 4, 5, 12].map(effectiveSlips)).toEqual([0, 1, 2, 3, 3, 3, 3]);
  });
});

describe('resolveShot', () => {
  const centre: Vec2 = { x: 0, y: 5 };
  const everywhere: IsIn = () => true;

  it('derives sigma and pNet from tier, slips and stretch', () => {
    const cases: [tier: Tier, slips: number, stretch: boolean, sigma: number, pNet: number][] = [
      ['easy', 0, false, 0.1, 0],
      ['medium', 0, false, 0.12, 0],
      ['hard', 0, false, 0.1, 0],
      ['medium', 2, false, 0.82, 0.06],
      ['hard', 1, true, 1.1, 0.11],
      ['easy', 3, true, 1.35, 0.08],
    ];
    for (const [tier, slips, stretch, sigma, pNet] of cases) {
      const r = resolveShot({ tier, slips, stretch, target: centre, randoms: noScatter(0.99), isIn: everywhere });
      expect(r.sigma, `sigma ${tier}/${slips}/${stretch}`).toBeCloseTo(sigma, 12);
      expect(r.pNet, `pNet ${tier}/${slips}/${stretch}`).toBeCloseTo(pNet, 12);
    }
  });

  it('calls NET exactly when r_net < pNet', () => {
    // hard with 1 slip: pNet = 0.06
    const outcome = (rNet: number): string =>
      resolveShot({ tier: 'hard', slips: 1, stretch: false, target: centre, randoms: noScatter(rNet), isIn: everywhere })
        .outcome;
    expect(outcome(0)).toBe('net');
    expect(outcome(0.0599)).toBe('net');
    expect(outcome(0.06)).toBe('in');
    expect(outcome(0.5)).toBe('in');
  });

  it('scatters the landing by σ·zx from randoms[1..4] and σ·zy from randoms[5..8]', () => {
    // hard, 1 slip: σ = 0.6; zx = (0.9 + 0.8 + 0.7 + 0.6 − 2)·√3 = √3; zy = (0.1 + 0.2 + 0.3 + 0.1 − 2)·√3 = −1.3·√3
    const randoms = randomsOf(0.99, [0.9, 0.8, 0.7, 0.6], [0.1, 0.2, 0.3, 0.1]);
    const r = resolveShot({ tier: 'hard', slips: 1, stretch: false, target: centre, randoms, isIn: everywhere });
    expect(r.outcome).toBe('in');
    expect(r.landing.x).toBeCloseTo(1.0392304845, 9); // 0.6·√3
    expect(r.landing.y).toBeCloseTo(3.6490003701, 9); // 5 − 0.78·√3
  });

  it('reports where a NET ball would have landed', () => {
    const randoms = randomsOf(0, [0.9, 0.8, 0.7, 0.6], [0.1, 0.2, 0.3, 0.1]);
    const r = resolveShot({ tier: 'hard', slips: 1, stretch: false, target: centre, randoms, isIn: everywhere });
    expect(r.outcome).toBe('net');
    expect(r.landing.x).toBeCloseTo(1.0392304845, 9);
    expect(r.landing.y).toBeCloseTo(3.6490003701, 9);
  });

  it('judges in/out on the scattered landing, not on the target', () => {
    const rightHalf: IsIn = (p) => p.x >= 0; // the target x = 0 itself is in
    const outcome = (ux: number): string =>
      resolveShot({
        tier: 'easy',
        slips: 0,
        stretch: false,
        target: centre,
        randoms: randomsOf(0.99, [ux, ux, ux, ux], [0.5, 0.5, 0.5, 0.5]),
        isIn: rightHalf,
      }).outcome;
    expect(outcome(0.6)).toBe('in');
    expect(outcome(0.4)).toBe('out');
  });

  it('lines are in: a landing exactly on a line is in, 1 mm beyond it is out', () => {
    const land = (target: Vec2, isIn: IsIn): ShotResult =>
      resolveShot({ tier: 'hard', slips: 0, stretch: false, target, randoms: noScatter(0.99), isIn });
    const serveCorner = { x: -4.115, y: 6.4 }; // sideline × service line
    const rallyCorner = { x: 4.115, y: 11.885 }; // sideline × baseline
    expect(land(serveCorner, inServeBox)).toMatchObject({ outcome: 'in', landing: serveCorner });
    expect(land(rallyCorner, inRallyHalf)).toMatchObject({ outcome: 'in', landing: rallyCorner });
    expect(land({ x: -4.116, y: 6.4 }, inServeBox).outcome).toBe('out');
    expect(land({ x: 4.115, y: 11.886 }, inRallyHalf).outcome).toBe('out');
  });

  it('treats 5 slips exactly like 3', () => {
    const s = seedRng(99);
    for (let i = 0; i < 200; i++) {
      const randoms = drawShotRandoms(s);
      for (const tier of TIERS) {
        for (const stretch of [false, true]) {
          const shot = { tier, stretch, target: RALLY_TARGETS[tier][0] as Vec2, randoms, isIn: inRallyHalf };
          expect(resolveShot({ ...shot, slips: 5 })).toEqual(resolveShot({ ...shot, slips: 3 }));
        }
      }
    }
  });

  it('caps pNet at 0.9', () => {
    // Unreachable with the shipped rates (max 0.23), so raise one rate for this test only.
    const rates = TUNING.accuracy.netRate;
    const saved = rates.hard;
    rates.hard = 1;
    try {
      const shot = (rNet: number): ShotResult =>
        resolveShot({ tier: 'hard', slips: 3, stretch: true, target: centre, randoms: noScatter(rNet), isIn: everywhere });
      expect(shot(0).pNet).toBe(0.9);
      expect(shot(0.899).outcome).toBe('net');
      expect(shot(0.9).outcome).toBe('in');
    } finally {
      rates.hard = saved;
    }
  });
});

describe('resolveShot accuracy guarantees (spec §3.5)', () => {
  const KINDS = [
    { kind: 'serve', targets: SERVE_TARGETS, isIn: inServeBox },
    { kind: 'rally', targets: RALLY_TARGETS, isIn: inRallyHalf },
  ];

  /** Outcome counts over `samples` seeded ShotRandoms aimed at `target`, no stretch. */
  function tally(tier: Tier, slips: number, target: Vec2, isIn: IsIn, samples: number, seed: number) {
    const s = seedRng(seed);
    const counts = { in: 0, out: 0, net: 0 };
    for (let i = 0; i < samples; i++) {
      counts[resolveShot({ tier, slips, stretch: false, target, randoms: drawShotRandoms(s), isIn }).outcome]++;
    }
    return counts;
  }

  for (const [t, tier] of ALL_TIERS.entries()) {
    it(`e = 0, no stretch: ${tier} serve and rally shots are never out or net (100,000 seeded draws per target)`, () => {
      for (const [k, { kind, targets, isIn }] of KINDS.entries()) {
        for (const [i, target] of targets[tier].entries()) {
          const counts = tally(tier, 0, target, isIn, 100_000, 1000 + 100 * t + 10 * k + i);
          expect(counts, `${kind} ${tier} (${target.x}, ${target.y})`).toEqual({ in: 100_000, out: 0, net: 0 });
        }
      }
    });
  }

  it('e = 0, no stretch: never out or net even at the scatter extremes with r_net = 0', () => {
    const lo = [0, 0, 0, 0];
    const hi = [1, 1, 1, 1].map((u) => u - 2 ** -53); // largest uniform below 1
    const failures: string[] = [];
    for (const tier of ALL_TIERS) {
      for (const { kind, targets, isIn } of KINDS) {
        for (const target of targets[tier]) {
          for (const ux of [lo, hi]) {
            for (const uy of [lo, hi]) {
              const r = resolveShot({ tier, slips: 0, stretch: false, target, randoms: randomsOf(0, ux, uy), isIn });
              if (r.outcome !== 'in') failures.push(`${kind} ${tier} → ${r.outcome} at (${r.landing.x}, ${r.landing.y})`);
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('hard rally shot with 1 slip fails (out + net) 35–55 % of the time', () => {
    for (const [i, target] of RALLY_TARGETS.hard.entries()) {
      const c = tally('hard', 1, target, inRallyHalf, 20_000, 2000 + i);
      const failRate = (c.out + c.net) / 20_000;
      expect(failRate, `target (${target.x}, ${target.y})`).toBeGreaterThanOrEqual(0.35);
      expect(failRate, `target (${target.x}, ${target.y})`).toBeLessThanOrEqual(0.55);
    }
  });

  it('medium rally shot with 1 slip fails (out + net) at most 5 % of the time', () => {
    for (const [i, target] of RALLY_TARGETS.medium.entries()) {
      const c = tally('medium', 1, target, inRallyHalf, 20_000, 3000 + i);
      expect((c.out + c.net) / 20_000, `target (${target.x}, ${target.y})`).toBeLessThanOrEqual(0.05);
    }
  });

  it('insane rally shot with 1 slip fails (out + net) 60–85 % of the time', () => {
    for (const [i, target] of RALLY_TARGETS.insane.entries()) {
      const c = tally('insane', 1, target, inRallyHalf, 20_000, 4000 + i);
      const failRate = (c.out + c.net) / 20_000;
      expect(failRate, `target (${target.x}, ${target.y})`).toBeGreaterThanOrEqual(0.6);
      expect(failRate, `target (${target.x}, ${target.y})`).toBeLessThanOrEqual(0.85);
    }
  });
});
