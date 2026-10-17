import { describe, expect, it } from 'vitest';
import { clampToBounds, receiveSpot, serveSpot, stepMove, walkToward } from '../../src/arcade/core/movement';
import type { MoveMode } from '../../src/arcade/core/movement';
import { ARCADE, DT } from '../../src/arcade/core/tuning';
import type { PlayerId, PlayerInput, PlayerState } from '../../src/arcade/core/types';
import { COURT } from '../../src/core/court';

const FREE: MoveMode = { kind: 'free' };

function pl(x = 0, y = -8, commit: PlayerState['commit'] = null): PlayerState {
  return { pos: { x, y }, vel: { x: 0, y: 0 }, commit, held: { topspin: false, slice: false, lob: false }, lastSwing: null };
}
function inp(mx: -1 | 0 | 1, my: -1 | 0 | 1): PlayerInput {
  return { mx, my, topspin: false, slice: false, lob: false };
}
function speed(p: PlayerState): number {
  return Math.sqrt(p.vel.x * p.vel.x + p.vel.y * p.vel.y);
}
function run(p: PlayerState, player: PlayerId, input: PlayerInput, mode: MoveMode, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepMove(p, player, input, mode);
}

describe('stepMove', () => {
  it('reaches top speed after 0.15 s and never exceeds it', () => {
    const p = pl(0, -8);
    let max = 0;
    for (let i = 0; i < 60; i++) {
      stepMove(p, 0, inp(1, 0), FREE);
      max = Math.max(max, speed(p));
      if (i < 8) expect(speed(p)).toBeLessThan(ARCADE.move.topSpeed - 1e-6);
      if (i === 8) expect(speed(p)).toBeCloseTo(6.0, 9);
    }
    expect(max).toBeLessThanOrEqual(ARCADE.move.topSpeed + 1e-9);
    expect(p.vel.x).toBeCloseTo(6.0, 9);
  });

  it('moves along the player-relative axes (player 1 is mirrored)', () => {
    const a = pl(0, -8);
    const b = pl(0, 8);
    run(a, 0, inp(1, 1), FREE, 5);
    run(b, 1, inp(1, 1), FREE, 5);
    expect(a.vel.x).toBeGreaterThan(0);
    expect(a.vel.y).toBeGreaterThan(0);
    expect(b.vel.x).toBeCloseTo(-a.vel.x, 9);
    expect(b.vel.y).toBeCloseTo(-a.vel.y, 9);
  });

  it('diagonal speed equals straight speed', () => {
    const p = pl(0, -8);
    run(p, 0, inp(1, 1), FREE, 30);
    expect(speed(p)).toBeCloseTo(6.0, 9);
  });

  it('committed top speed is 3.6 m/s', () => {
    const p = pl(0, -8, { shot: 'topspin', tick: 0 });
    run(p, 0, inp(1, 0), FREE, 60);
    expect(speed(p)).toBeCloseTo(3.6, 9);
  });

  it('stops within 0.1 s plus one tick', () => {
    const p = pl(0, -8);
    run(p, 0, inp(1, 0), FREE, 30);
    run(p, 0, inp(0, 0), FREE, Math.round(0.1 / DT) + 1);
    expect(speed(p)).toBeCloseTo(0, 9);
  });

  it('locked mode ignores input and decelerates to a stop', () => {
    const p = pl(0, -8);
    run(p, 0, inp(1, 0), FREE, 30);
    run(p, 0, inp(-1, 1), { kind: 'locked' }, 7);
    expect(speed(p)).toBeCloseTo(0, 9);
    expect(p.pos.x).toBeGreaterThan(0);
  });

  it('keeps player 0 inside its bounds and zeroes the clamped velocity', () => {
    const p = pl(0, -8);
    run(p, 0, inp(0, 1), FREE, 200);
    expect(p.pos.y).toBeCloseTo(-ARCADE.move.netGap, 9);
    expect(p.vel.y).toBeCloseTo(0, 9);
    run(p, 0, inp(0, -1), FREE, 400);
    expect(p.pos.y).toBeCloseTo(-(COURT.halfLength + ARCADE.move.maxBehind), 9);
    run(p, 0, inp(1, 0), FREE, 400);
    expect(p.pos.x).toBeCloseTo(ARCADE.move.maxAbsX, 9);
    expect(p.vel.x).toBeCloseTo(0, 9);
    run(p, 0, inp(-1, 0), FREE, 400);
    expect(p.pos.x).toBeCloseTo(-ARCADE.move.maxAbsX, 9);
  });

  it('keeps player 1 inside its mirrored bounds', () => {
    const p = pl(0, 8);
    run(p, 1, inp(0, 1), FREE, 200);
    expect(p.pos.y).toBeCloseTo(ARCADE.move.netGap, 9);
    run(p, 1, inp(0, -1), FREE, 400);
    expect(p.pos.y).toBeCloseTo(COURT.halfLength + ARCADE.move.maxBehind, 9);
    run(p, 1, inp(-1, 0), FREE, 400);
    expect(p.pos.x).toBeCloseTo(ARCADE.move.maxAbsX, 9);
  });

  it('rail mode ignores my and holds x on the serving side (deuce, player 0)', () => {
    const p = pl(2, -12.185);
    run(p, 0, inp(1, 1), { kind: 'rail', side: 'deuce' }, 300);
    expect(p.pos.y).toBe(-12.185);
    expect(p.pos.x).toBeCloseTo(COURT.singlesHalfWidth, 9);
    run(p, 0, inp(-1, -1), { kind: 'rail', side: 'deuce' }, 300);
    expect(p.pos.x).toBeCloseTo(ARCADE.move.setupCentreGap, 9);
    expect(p.pos.y).toBe(-12.185);
  });

  it('rail mode on the ad side (player 0) stays in [-4.115, -0.3]', () => {
    const p = pl(-2, -12.185);
    run(p, 0, inp(-1, 0), { kind: 'rail', side: 'ad' }, 300);
    expect(p.pos.x).toBeCloseTo(-COURT.singlesHalfWidth, 9);
    run(p, 0, inp(1, 0), { kind: 'rail', side: 'ad' }, 300);
    expect(p.pos.x).toBeCloseTo(-ARCADE.move.setupCentreGap, 9);
  });

  it('rail mode mirrors for player 1', () => {
    const p = pl(-2, 12.185);
    run(p, 1, inp(1, 1), { kind: 'rail', side: 'deuce' }, 300);
    expect(p.pos.x).toBeCloseTo(-COURT.singlesHalfWidth, 9);
    expect(p.pos.y).toBe(12.185);
    run(p, 1, inp(-1, 0), { kind: 'rail', side: 'deuce' }, 300);
    expect(p.pos.x).toBeCloseTo(-ARCADE.move.setupCentreGap, 9);
  });
});

describe('clampToBounds', () => {
  it('clamps both players', () => {
    expect(clampToBounds({ x: 9, y: 0 }, 0)).toEqual({ x: 6.5, y: -0.4 });
    expect(clampToBounds({ x: -9, y: -20 }, 0)).toEqual({ x: -6.5, y: -(COURT.halfLength + 2) });
    expect(clampToBounds({ x: 1, y: 0 }, 1)).toEqual({ x: 1, y: 0.4 });
    expect(clampToBounds({ x: 1, y: 20 }, 1)).toEqual({ x: 1, y: COURT.halfLength + 2 });
  });
});

describe('walkToward', () => {
  it('reaches its target and stops', () => {
    const p = pl(0, -5);
    const target = { x: 2, y: -12 };
    let ticks = 0;
    while ((p.pos.x !== target.x || p.pos.y !== target.y) && ticks < 1000) {
      const before = { ...p.pos };
      walkToward(p, target);
      const step = Math.sqrt((p.pos.x - before.x) ** 2 + (p.pos.y - before.y) ** 2);
      expect(step).toBeLessThanOrEqual(ARCADE.move.walkSpeed * DT + 1e-9);
      ticks++;
    }
    expect(p.pos).toEqual(target);
    const dist = Math.sqrt(4 + 49);
    expect(ticks).toBe(Math.ceil(dist / (ARCADE.move.walkSpeed * DT)));
    walkToward(p, target);
    expect(p.pos).toEqual(target);
    expect(p.vel.x).toBeCloseTo(0, 12);
    expect(p.vel.y).toBeCloseTo(0, 12);
  });

  it('sets the walking velocity while moving', () => {
    const p = pl(0, -5);
    walkToward(p, { x: 0, y: -12 });
    expect(p.vel.x).toBeCloseTo(0, 12);
    expect(p.vel.y).toBeCloseTo(-ARCADE.move.walkSpeed, 9);
  });
});

describe('spots', () => {
  it('serveSpot', () => {
    expect(serveSpot(0, 'deuce').x).toBeGreaterThan(0);
    expect(serveSpot(0, 'ad').x).toBeLessThan(0);
    expect(serveSpot(1, 'deuce').x).toBeLessThan(0);
    expect(serveSpot(0, 'deuce').x).toBeCloseTo(ARCADE.serve.startX, 12);
    expect(serveSpot(0, 'deuce').y).toBeCloseTo(-(COURT.halfLength + ARCADE.serve.behindBaseline), 12);
    expect(serveSpot(1, 'ad').y).toBeCloseTo(COURT.halfLength + ARCADE.serve.behindBaseline, 12);
  });
  it('receiveSpot', () => {
    const r = receiveSpot(1, 'deuce');
    expect(r.x).toBeLessThan(0);
    expect(r.y).toBeGreaterThan(COURT.halfLength);
    expect(r.x).toBeCloseTo(-ARCADE.receive.x, 12);
    expect(r.y).toBeCloseTo(COURT.halfLength + ARCADE.receive.behindBaseline, 12);
    expect(receiveSpot(0, 'deuce').x).toBeCloseTo(ARCADE.receive.x, 12);
    expect(receiveSpot(0, 'deuce').y).toBeLessThan(-COURT.halfLength);
  });
});
