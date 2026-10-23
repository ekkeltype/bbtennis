import { describe, expect, it } from 'vitest';
import { buildFlight, flightPos, MAX_FLIGHT_S, scanEnd } from '../../src/arcade/core/flight';
import { contactAt, inZone, stepSpot } from '../../src/arcade/core/reach';
import type { Contact } from '../../src/arcade/core/reach';
import { ARCADE, DT } from '../../src/arcade/core/tuning';
import type { Flight, HitEvent, Vec2 } from '../../src/arcade/core/types';

function hit(over: Partial<HitEvent> & { contact: HitEvent['contact']; target: HitEvent['target']; T: number }): HitEvent {
  return { tick: 0, player: 0, type: 'topspin', grade: 'clean', stretch: false, volley: false, power: 1, ...over };
}

/** Deep rally ball hit by player 0: lands at (0, 9) after 1 s. */
const rally = buildFlight(hit({ contact: { x: 0, y: -12, z: 1 }, target: { x: 0, y: 9 }, T: 1.0 }));

/** Player 1's position so the ball at tick n passes `lateral` m to its right (player 1's right is world -x). */
function beside(f: Flight, n: number, lateral: number): Vec2 {
  const b = flightPos(f, n * DT);
  return { x: b.x + lateral, y: b.y };
}
function ticksOf(f: Flight, pos: Vec2, serveUnbounced = false): { n: number; c: Contact }[] {
  const out: { n: number; c: Contact }[] = [];
  for (let n = 0; n * DT < f.tEnd + 0.1; n++) {
    const c = contactAt(1, pos, f, n, serveUnbounced);
    if (c) out.push({ n, c });
  }
  return out;
}
function dist(f: Flight, pos: Vec2, n: number): number {
  const b = flightPos(f, n * DT);
  return Math.sqrt((b.x - pos.x) ** 2 + (b.y - pos.y) ** 2);
}

describe('inZone', () => {
  const pos = { x: 0, y: 11 };
  it('accepts a ball on the half, incoming, near and at a reachable height', () => {
    expect(inZone(1, pos, { x: 0.5, y: 11, z: 1 }, { x: 0, y: 5, z: 0 })).toBe(true);
  });
  it('rejects wrong half, direction, distance and height', () => {
    expect(inZone(1, pos, { x: 0.5, y: -1, z: 1 }, { x: 0, y: 5, z: 0 })).toBe(false);
    expect(inZone(1, pos, { x: 0.5, y: 11, z: 1 }, { x: 0, y: -5, z: 0 })).toBe(false);
    expect(inZone(1, pos, { x: 1.5, y: 11, z: 1 }, { x: 0, y: 5, z: 0 })).toBe(false);
    expect(inZone(1, pos, { x: 0.5, y: 11, z: 0.1 }, { x: 0, y: 5, z: 0 })).toBe(false);
    expect(inZone(1, pos, { x: 0.5, y: 11, z: 2.8 }, { x: 0, y: 5, z: 0 })).toBe(false);
  });
  it('mirrors for player 0', () => {
    expect(inZone(0, { x: 0, y: -11 }, { x: 0.5, y: -11, z: 1 }, { x: 0, y: -5, z: 0 })).toBe(true);
    expect(inZone(0, { x: 0, y: -11 }, { x: 0.5, y: -11, z: 1 }, { x: 0, y: 5, z: 0 })).toBe(false);
  });
});

describe('contactAt', () => {
  it('meets a ball 0.7 m to the right at the closest approach (forehand, groundstroke, no stretch)', () => {
    const pos = beside(rally, 73, 0.7);
    const hits = ticksOf(rally, pos);
    expect(hits.length).toBeGreaterThan(0);
    const first = hits[0]!;
    // approaching before, not closer after
    expect(dist(rally, pos, first.n + 1)).toBeGreaterThanOrEqual(dist(rally, pos, first.n));
    expect(dist(rally, pos, first.n - 1)).toBeGreaterThan(dist(rally, pos, first.n));
    expect(first.c.lateral).toBeCloseTo(dist(rally, pos, first.n), 12);
    expect(first.c.lateral).toBeLessThan(1.0);
    expect(first.c.forehand).toBe(true);
    expect(first.c.volley).toBe(false);
    expect(first.c.stretch).toBe(false);
    expect(first.c.smash).toBe(false);
    expect(first.n).toBeGreaterThanOrEqual(72);
    expect(first.n).toBeLessThanOrEqual(74);
  });

  it('a ball to the left is a backhand', () => {
    const pos = beside(rally, 73, -0.7);
    expect(ticksOf(rally, pos)[0]!.c.forehand).toBe(false);
  });

  it('1.2 m is a stretch', () => {
    const c = ticksOf(rally, beside(rally, 73, 1.2))[0]!.c;
    expect(c.stretch).toBe(true);
    expect(c.lateral).toBeLessThanOrEqual(ARCADE.reach.radius);
  });

  it('1.5 m is never a contact', () => {
    expect(ticksOf(rally, beside(rally, 73, 1.5))).toEqual([]);
  });

  it('a ball above 2.7 m is never met', () => {
    const lob = buildFlight(hit({ type: 'lob', contact: { x: 0, y: -8, z: 1 }, target: { x: 0, y: 10.5 }, T: 2.4 }));
    expect(ticksOf(lob, { x: 0, y: 3.5 })).toEqual([]);
  });

  it('smash needs z > 2 and a position within 8 m of the net', () => {
    const lob = buildFlight(hit({ type: 'lob', contact: { x: 0, y: -8, z: 1 }, target: { x: 0, y: 4.5 }, T: 2.2 }));
    const near = ticksOf(lob, { x: 0, y: 3 });
    expect(near.length).toBeGreaterThan(0);
    expect(near[0]!.c.ball.z).toBeGreaterThan(ARCADE.reach.smashZ);
    expect(near[0]!.c.smash).toBe(true);
    const far = buildFlight(hit({ type: 'lob', contact: { x: 0, y: -8, z: 1 }, target: { x: 0, y: 10.5 }, T: 2.4 }));
    const deep = ticksOf(far, { x: 0, y: 9 });
    expect(deep.length).toBeGreaterThan(0);
    expect(deep[0]!.c.ball.z).toBeGreaterThan(ARCADE.reach.smashZ);
    expect(deep[0]!.c.smash).toBe(false);
  });

  it('a ball before its bounce is a volley, after is not', () => {
    const bounceT = rally.bounces[0]!.t;
    const early = ticksOf(rally, beside(rally, 50, 0.5))[0]!;
    expect(early.n * DT).toBeLessThan(bounceT);
    expect(early.c.volley).toBe(true);
    const late = ticksOf(rally, beside(rally, 73, 0.5))[0]!;
    expect(late.c.volley).toBe(false);
  });

  it('serveUnbounced gives no contact until the bounce', () => {
    const pos = beside(rally, 50, 0.5);
    expect(ticksOf(rally, pos).length).toBeGreaterThan(0);
    expect(ticksOf(rally, pos, true)).toEqual([]);
    const after = beside(rally, 73, 0.5);
    expect(ticksOf(rally, after, true).length).toBeGreaterThan(0);
  });

  it('own hit, net ball, and times at or after tEnd give null', () => {
    const pos = beside(rally, 73, 0.5);
    expect(contactAt(0, pos, rally, 73, false)).toBeNull();
    const net = buildFlight(hit({ contact: { x: 0, y: -11, z: 0.3 }, target: { x: 0, y: 6 }, T: 0.35 }));
    expect(net.net).toBe(true);
    for (let n = 0; n < 60; n++) expect(contactAt(1, { x: 0, y: 3 }, net, n, false)).toBeNull();
    const end = Math.ceil(rally.tEnd / DT);
    expect(contactAt(1, beside(rally, end - 1, 0.5), rally, end, false)).toBeNull();
    expect(contactAt(1, pos, rally, -3, false)).toBeNull();
  });

  it('a ball that bounces twice inside the zone is met before tEnd', () => {
    const slow = buildFlight(hit({ contact: { x: 0, y: -0.5, z: 1 }, target: { x: 0, y: 1 }, T: 1.0 }));
    const pos = { x: 0.3, y: 1.8 };
    expect(slow.bounces.length).toBeGreaterThanOrEqual(2);
    const b0 = flightPos(slow, slow.bounces[0]!.t);
    const b1 = flightPos(slow, slow.bounces[1]!.t);
    for (const b of [b0, b1]) expect(Math.sqrt((b.x - pos.x) ** 2 + (b.y - pos.y) ** 2)).toBeLessThan(ARCADE.reach.radius);
    const hits = ticksOf(slow, pos);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.n * DT).toBeLessThan(slow.tEnd);
  });
});

describe('stepSpot', () => {
  /** The ball's nearest point to `pos` among ticks from `from` at a reachable height on player 1's half. */
  function nearest(f: Flight, pos: Vec2, from = 0): { x: number; y: number; d: number } {
    let best = { x: 0, y: 0, d: Infinity };
    for (let n = from; n * DT < f.tEnd; n++) {
      const b = flightPos(f, n * DT);
      if (b.y <= 0 || b.z < ARCADE.reach.minZ || b.z > ARCADE.reach.maxZ) continue;
      const d = Math.sqrt((b.x - pos.x) ** 2 + (b.y - pos.y) ** 2);
      if (d < best.d) best = { x: b.x, y: b.y, d };
    }
    return best;
  }
  const len = (a: Vec2, b: Vec2): number => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

  it('leads 0.7 m beside the path, on the side the player is on', () => {
    const pos = beside(rally, 73, 1.3);
    const to = stepSpot(1, pos, rally, 0, false)!;
    const near = nearest(rally, pos);
    expect(len(to, near)).toBeCloseTo(ARCADE.plant.sideOffset, 6);
    expect(to.x).toBeGreaterThan(near.x);
    expect(len(to, pos)).toBeCloseTo(0.6, 1);

    const left = beside(rally, 73, -1.3);
    expect(stepSpot(1, left, rally, 0, false)!.x).toBeLessThan(near.x);
  });

  it('steps back out of the path to make room, and picks the forehand side when on it', () => {
    const on = beside(rally, 73, 0);
    const to = stepSpot(1, on, rally, 0, false)!;
    // Player 1's forehand is world −x of the player: the ball passes at to.x − 0.7.
    expect(to.x).toBeCloseTo(nearest(rally, on).x + ARCADE.plant.sideOffset, 6);
    const close = beside(rally, 73, 0.3);
    expect(stepSpot(1, close, rally, 0, false)!.x).toBeGreaterThan(close.x);
  });

  it('steps at most stepMax toward a ball that passes far away', () => {
    const pos = beside(rally, 73, 4);
    const to = stepSpot(1, pos, rally, 0, false)!;
    expect(len(to, pos)).toBeCloseTo(ARCADE.plant.stepMax, 9);
    expect(to.x).toBeLessThan(pos.x);
  });

  it('only uses the ball after the bounce while the serve is unbounced, and from the given tick on', () => {
    const pos = beside(rally, 50, 0.3);
    const bounceTick = Math.ceil(rally.bounces[0]!.t / DT);
    const any = stepSpot(1, pos, rally, 0, false)!;
    const after = stepSpot(1, pos, rally, 0, true)!;
    expect(len(any, nearest(rally, pos))).toBeCloseTo(ARCADE.plant.sideOffset, 6);
    expect(after).toEqual(stepSpot(1, pos, rally, bounceTick, false));
    expect(after).not.toEqual(any);
  });

  it('is null for a net ball, the player\'s own ball, and a ball that never reaches a hittable height on the half', () => {
    const net = buildFlight(hit({ contact: { x: 0, y: -11, z: 0.3 }, target: { x: 0, y: 6 }, T: 0.35 }));
    expect(stepSpot(1, { x: 0, y: 3 }, net, 0, false)).toBeNull();
    expect(stepSpot(0, { x: 0, y: -11 }, rally, 0, false)).toBeNull();
    const end = Math.ceil(rally.tEnd / DT);
    expect(stepSpot(1, { x: 0, y: 11 }, rally, end, false)).toBeNull();
  });

  it('stays inside the bounds', () => {
    const wide = buildFlight(hit({ contact: { x: 0, y: -10, z: 1 }, target: { x: 5.6, y: 9 }, T: 1.0 }));
    const pos = { x: ARCADE.move.maxAbsX, y: 11 };
    const near = nearest(wide, pos);
    expect(near.x + ARCADE.plant.sideOffset).toBeGreaterThan(ARCADE.move.maxAbsX); // unclamped, the spot is out of bounds
    expect(stepSpot(1, pos, wide, 0, false)!.x).toBe(ARCADE.move.maxAbsX);
  });
});

describe('scans over a flight stop at MAX_FLIGHT_S (online spec §3.6)', () => {
  it('a flight that says it lasts a billion seconds is scanned for 10 s at most, with the same result', () => {
    const f = buildFlight({
      tick: 0, player: 1, type: 'topspin', grade: 'clean', stretch: false, volley: false, power: 1,
      contact: { x: 0, y: 10, z: 1 }, target: { x: 0, y: -8 }, T: 1.2,
    });
    const long = { ...f, tEnd: 1e9 };
    const t0 = performance.now();
    const spot = stepSpot(0, { x: 1.5, y: -10 }, long, 0, false);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(spot).toEqual(stepSpot(0, { x: 1.5, y: -10 }, f, 0, false));
    expect(scanEnd(long)).toBe(MAX_FLIGHT_S);
    expect(scanEnd(f)).toBe(f.tEnd);
  });
});
