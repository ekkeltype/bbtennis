import { COURT, endSign } from '../../core/court';
import { ARCADE, DT } from './tuning';
import type { PlayerId, PlayerInput, PlayerState, Side, Vec2 } from './types';

function sideSign(side: Side): 1 | -1 {
  return side === 'deuce' ? 1 : -1;
}

/** Where the server stands at set-up (spec §4.8): x = sideSign·endSign·startX, behindBaseline behind the baseline. */
export function serveSpot(server: PlayerId, side: Side): Vec2 {
  const s = endSign(server);
  return { x: sideSign(side) * s * ARCADE.serve.startX, y: -s * (COURT.halfLength + ARCADE.serve.behindBaseline) };
}

/** Where the receiver stands at set-up: x = sideSign·endSign(receiver)·receive.x on the diagonal side, receive.behindBaseline behind its baseline. */
export function receiveSpot(receiver: PlayerId, side: Side): Vec2 {
  const s = endSign(receiver);
  return { x: sideSign(side) * s * ARCADE.receive.x, y: -s * (COURT.halfLength + ARCADE.receive.behindBaseline) };
}

/** Movement mode: free play, the server's set-up rail (x only), or no input (walking/locked). */
export type MoveMode = { kind: 'free' } | { kind: 'rail'; side: Side } | { kind: 'locked' };

/** Clamps a position to the player's bounds (own half, netGap, maxBehind, maxAbsX). */
export function clampToBounds(pos: Vec2, player: PlayerId): Vec2 {
  const s = endSign(player);
  const depth = Math.min(Math.max(s * pos.y, -(COURT.halfLength + ARCADE.move.maxBehind)), -ARCADE.move.netGap);
  return { x: Math.min(Math.max(pos.x, -ARCADE.move.maxAbsX), ARCADE.move.maxAbsX), y: s * depth };
}

/**
 * Integrates one tick of input (spec §4.2): acceleration, top speed (× chargeSpeedMult while committed), bounds.
 * Rail mode uses the x input only, keeps y and holds x on the serving side of the centre. Locked mode ignores
 * input and brakes. A clamped axis zeroes that velocity component. Mutates p.
 */
export function stepMove(p: PlayerState, player: PlayerId, input: PlayerInput, mode: MoveMode): void {
  const s = endSign(player);
  const m = ARCADE.move;
  let ix = mode.kind === 'locked' ? 0 : input.mx * s;
  let iy = mode.kind === 'free' ? input.my * s : 0;
  const len = Math.sqrt(ix * ix + iy * iy);
  if (len > 0) {
    ix /= len;
    iy /= len;
  }
  const top = m.topSpeed * (p.commit !== null ? m.chargeSpeedMult : 1);
  const wx = ix * top;
  const wy = iy * top;
  const maxDelta = (len > 0 ? m.topSpeed / m.accelTime : m.topSpeed / m.stopTime) * DT;
  const dx = wx - p.vel.x;
  const dy = wy - p.vel.y;
  const dl = Math.sqrt(dx * dx + dy * dy);
  if (dl <= maxDelta) {
    p.vel.x = wx;
    p.vel.y = wy;
  } else {
    p.vel.x += (dx / dl) * maxDelta;
    p.vel.y += (dy / dl) * maxDelta;
  }
  const nx = p.pos.x + p.vel.x * DT;
  const ny = p.pos.y + p.vel.y * DT;
  if (mode.kind === 'rail') {
    const sx = sideSign(mode.side) * s;
    const lo = Math.min(sx * m.setupCentreGap, sx * COURT.singlesHalfWidth);
    const hi = Math.max(sx * m.setupCentreGap, sx * COURT.singlesHalfWidth);
    const cx = Math.min(Math.max(nx, lo), hi);
    if (cx !== nx) p.vel.x = 0;
    p.pos.x = cx;
    p.vel.y = 0;
    return;
  }
  const c = clampToBounds({ x: nx, y: ny }, player);
  if (c.x !== nx) p.vel.x = 0;
  if (c.y !== ny) p.vel.y = 0;
  p.pos.x = c.x;
  p.pos.y = c.y;
}

/** Walks toward `target` at walkSpeed for one tick (dead phase); snaps when within one step. Mutates p (vel set accordingly). */
export function walkToward(p: PlayerState, target: Vec2): void {
  const dx = target.x - p.pos.x;
  const dy = target.y - p.pos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = ARCADE.move.walkSpeed * DT;
  if (dist <= step) {
    p.vel.x = dx / DT;
    p.vel.y = dy / DT;
    p.pos.x = target.x;
    p.pos.y = target.y;
    if (dist === 0) {
      p.vel.x = 0;
      p.vel.y = 0;
    }
    return;
  }
  p.vel.x = (dx / dist) * ARCADE.move.walkSpeed;
  p.vel.y = (dy / dist) * ARCADE.move.walkSpeed;
  p.pos.x += (dx / dist) * step;
  p.pos.y += (dy / dist) * step;
}
