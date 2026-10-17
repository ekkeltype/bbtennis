import { describe, expect, it } from 'vitest';
import { arcApex, buildFlight, clampTForApex, flightPos, flightVel, inBoxFor, inCourtFor, physicsOf } from '../../src/arcade/core/flight';
import { ARCADE } from '../../src/arcade/core/tuning';
import { inServiceBox } from '../../src/core/court';
import type { HitEvent, ShotType } from '../../src/arcade/core/types';

function hit(over: Partial<HitEvent> & { contact: HitEvent['contact']; target: HitEvent['target']; T: number }): HitEvent {
  return { tick: 0, player: 0, type: 'topspin', grade: 'clean', stretch: false, volley: false, power: 1, ...over };
}

const topspin = hit({ contact: { x: 0, y: -12, z: 1.0 }, target: { x: 2, y: 9 }, T: 1.0 });

describe('buildFlight', () => {
  it('lands a topspin at the target', () => {
    const f = buildFlight(topspin);
    const p = flightPos(f, 1.0);
    expect(p.x).toBeCloseTo(2, 9);
    expect(p.y).toBeCloseTo(9, 9);
    expect(p.z).toBeCloseTo(0, 9);
    expect(f.bounces[0]!.t).toBeCloseTo(1, 12);
    expect(f.bounces[0]!.at).toEqual({ x: 2, y: 9 });
    expect(f.net).toBe(false);
  });

  it('is continuous at segment boundaries and reflects velocity', () => {
    const f = buildFlight(hit({ type: 'lob', contact: { x: 0, y: -10, z: 1 }, target: { x: 1, y: 3 }, T: 1.8 }));
    expect(f.segments.length).toBe(4);
    for (let i = 1; i < f.segments.length; i++) {
      const prev = f.segments[i - 1]!;
      const s = f.segments[i]!;
      const dt = s.t0 - prev.t0;
      const pe = { x: prev.p0.x + prev.v0.x * dt + 0.5 * prev.a.x * dt * dt, y: prev.p0.y + prev.v0.y * dt, z: prev.p0.z + prev.v0.z * dt + 0.5 * prev.a.z * dt * dt };
      expect(pe.x).toBeCloseTo(s.p0.x, 9);
      expect(pe.y).toBeCloseTo(s.p0.y, 9);
      expect(pe.z).toBeCloseTo(s.p0.z, 9);
      expect(s.p0.z).toBeCloseTo(0, 9);
      const ve = { x: prev.v0.x + prev.a.x * dt, y: prev.v0.y, z: prev.v0.z + prev.a.z * dt };
      const ph = i === 1 ? physicsOf('lob') : ARCADE.laterBounce;
      expect(s.v0.x).toBeCloseTo(ph.keep * ve.x, 9);
      expect(s.v0.y).toBeCloseTo(ph.keep * ve.y, 9);
      expect(s.v0.z).toBeCloseTo(-ph.rest * ve.z, 9);
    }
  });

  it('flightVel matches segment velocity', () => {
    const f = buildFlight(topspin);
    const v = flightVel(f, 0.5);
    expect(v.y).toBeCloseTo(21 / 1.0, 9);
    expect(v.z).toBeCloseTo(f.segments[0]!.v0.z + f.segments[0]!.a.z * 0.5, 9);
  });

  it('builds a net ball for a flat low fast hit', () => {
    const f = buildFlight(hit({ contact: { x: 0, y: -11, z: 0.3 }, target: { x: 0, y: 6 }, T: 0.35 }));
    expect(f.net).toBe(true);
    expect(f.netT).not.toBeNull();
    expect(f.netT!).toBeGreaterThan(0);
    expect(f.netT!).toBeLessThan(0.35);
    expect(f.bounces).toEqual([]);
    expect(flightPos(f, f.tEnd).z).toBeCloseTo(0, 9);
    expect(f.tGone).toBe(f.tEnd);
    for (let t = 0; t <= f.tEnd; t += 0.005) {
      const p = flightPos(f, t);
      expect(p.z).toBeGreaterThanOrEqual(-1e-9);
      if (t > f.netT!) expect(p.y).toBeLessThanOrEqual(1e-9);
    }
  });

  it('uses the post height beyond the post', () => {
    // Crossing the net (y = 0) at t = 0.5 of T = 1 at x = 7; z there set by contact/g.
    const mk = (zNet: number): HitEvent => {
      const k = ARCADE.shots.topspin.k;
      const g = ARCADE.g * k;
      // z(t) = z0 + vz t - g t²/2 with landing at T: vz = -z0/T + g T/2. At t=T/2: z0/2 + g T²/8.
      const T = 1;
      const z0 = 2 * (zNet - (g * T * T) / 8);
      return hit({ contact: { x: 7, y: -5, z: z0 }, target: { x: 7, y: 5 }, T });
    };
    const r = ARCADE.ballRadius;
    expect(buildFlight(mk(1.08 + r)).net).toBe(false);
    expect(buildFlight(mk(1.06 + r)).net).toBe(true);
  });

  it('ends at the second bounce for a short ball', () => {
    const f = buildFlight(hit({ contact: { x: 0, y: -10, z: 1 }, target: { x: 1, y: 3 }, T: 0.9 }));
    expect(f.bounces.length).toBeGreaterThanOrEqual(2);
    expect(f.tEnd).toBeCloseTo(f.bounces[1]!.t, 12);
  });

  it('ends when a deep fast ball leaves the surround', () => {
    const f = buildFlight(hit({ contact: { x: 0, y: -10, z: 1 }, target: { x: 0, y: 11 }, T: 0.7 }));
    const second = f.segments[1]!.t0 + (2 * f.segments[1]!.v0.z) / ARCADE.g;
    expect(f.tEnd).toBeLessThan(second);
    expect(Math.abs(flightPos(f, f.tEnd).y)).toBeCloseTo(18, 9);
    expect(f.tGone).toBeLessThanOrEqual(f.tEnd + 3);
  });

  it('curves a slice serve late toward the target side', () => {
    const t = hit({ type: 'serveSlice', contact: { x: 1, y: -12, z: 2.5 }, target: { x: -2, y: 5 }, T: 0.8 });
    const f = buildFlight(t);
    const p = flightPos(f, 0.8);
    expect(p.x).toBeCloseTo(-2, 9);
    expect(p.y).toBeCloseTo(5, 9);
    const mid = flightPos(f, 0.4);
    expect(mid.x).toBeGreaterThan(1 + (-2 - 1) * 0.5);
    expect(f.segments[0]!.a.x).toBeCloseTo(-ARCADE.serveSliceCurve, 12);
  });

  it('is deterministic and JSON-safe', () => {
    expect(buildFlight(topspin)).toEqual(buildFlight(topspin));
    const f = buildFlight(topspin);
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });
});

describe('arc helpers', () => {
  it('arcApex matches a dense sample and clampTForApex caps at maxApex', () => {
    for (const [z0, k, T] of [[1, 1.45, 1], [2.4, 1, 2.5], [0.5, 0.8, 0.6]] as const) {
      const g = ARCADE.g * k;
      const vz = -z0 / T + 0.5 * g * T;
      let max = 0;
      for (let i = 0; i <= 20000; i++) { const t = (T * i) / 20000; max = Math.max(max, z0 + vz * t - 0.5 * g * t * t); }
      expect(arcApex(z0, k, T)).toBeCloseTo(max, 6);
    }
    const T2 = clampTForApex(1, 1, 6);
    expect(T2).toBeLessThan(6);
    expect(arcApex(1, 1, T2)).toBeLessThanOrEqual(ARCADE.maxApex);
    expect(clampTForApex(1, 1.45, 1)).toBe(1);
  });

  it('physicsOf returns the tuning row', () => {
    for (const ty of Object.keys(ARCADE.shots) as ShotType[]) expect(physicsOf(ty)).toBe(ARCADE.shots[ty]);
  });
});

describe('line calls', () => {
  it('counts the ball radius for inCourtFor', () => {
    expect(inCourtFor({ x: 4.115 + 0.03, y: 5 }, 1)).toBe(true);
    expect(inCourtFor({ x: 4.115 + 0.04, y: 5 }, 1)).toBe(false);
    expect(inCourtFor({ x: 0, y: 5 }, 0)).toBe(false);
    expect(inCourtFor({ x: 0, y: -11.885 - 0.03 }, 0)).toBe(true);
  });

  it('follows inServiceBox with the radius added', () => {
    for (const receiver of [0, 1] as const) for (const side of ['deuce', 'ad'] as const) {
      for (let x = -4.5; x <= 4.5; x += 0.25) for (let y = -7; y <= 7; y += 0.25) {
        if (inServiceBox({ x, y }, receiver, side)) expect(inBoxFor({ x, y }, receiver, side)).toBe(true);
      }
    }
    // Receiver 1 (s = -1), deuce: a = -x, b = y.
    expect(inBoxFor({ x: -2, y: 3 }, 1, 'deuce')).toBe(true);
    expect(inBoxFor({ x: 2, y: 3 }, 1, 'deuce')).toBe(false);
    expect(inBoxFor({ x: -2, y: 6.4 + 0.03 }, 1, 'deuce')).toBe(true);
    expect(inBoxFor({ x: -2, y: 6.4 + 0.04 }, 1, 'deuce')).toBe(false);
  });
});
