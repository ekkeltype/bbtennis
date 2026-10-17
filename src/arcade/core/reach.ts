import { endSign } from '../../core/court';
import { flightPos, flightVel } from './flight';
import { ARCADE, DT } from './tuning';
import type { Flight, PlayerId, Vec2, Vec3 } from './types';

/** A meeting of player and ball (spec §4.3, §4.4): where the ball is and how the player reaches it. */
export interface Contact {
  ball: Vec3;
  ballVel: Vec3;
  /** Horizontal distance between player and ball. */
  lateral: number;
  forehand: boolean;
  volley: boolean;
  smash: boolean;
  stretch: boolean;
}

function horizontal(pos: Vec2, ball: Vec3): number {
  const dx = ball.x - pos.x;
  const dy = ball.y - pos.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** True when the ball at `ball` (velocity `vel`) is reachable by `player` at `pos` (spec §4.4, without the serve rule). */
export function inZone(player: PlayerId, pos: Vec2, ball: Vec3, vel: Vec3): boolean {
  const s = endSign(player);
  return (
    s * ball.y < 0 &&
    s * vel.y < 0 &&
    horizontal(pos, ball) <= ARCADE.reach.radius &&
    ball.z >= ARCADE.reach.minZ &&
    ball.z <= ARCADE.reach.maxZ
  );
}

/**
 * The contact if `player` at `pos` meets flight `f` on this tick (spec §4.3 closest approach): at
 * t = (tick − f.hit.tick)·DT the ball is in the zone, and at t + DT it would be no closer
 * horizontally, out of the zone, or t + DT ≥ f.tEnd. Null when `f` is a net ball, was hit by
 * `player`, has t < 0 or t ≥ tEnd, or `serveUnbounced` is true and the ball has not bounced.
 */
export function contactAt(player: PlayerId, pos: Vec2, f: Flight, tick: number, serveUnbounced: boolean): Contact | null {
  const first = f.bounces[0];
  if (f.net || first === undefined || f.hit.player === player) return null;
  const t = (tick - f.hit.tick) * DT;
  if (t < 0 || t >= f.tEnd) return null;
  if (serveUnbounced && t < first.t) return null;
  const ball = flightPos(f, t);
  const ballVel = flightVel(f, t);
  if (!inZone(player, pos, ball, ballVel)) return null;
  const lateral = horizontal(pos, ball);
  const tn = t + DT;
  if (tn < f.tEnd) {
    const nb = flightPos(f, tn);
    if (inZone(player, pos, nb, flightVel(f, tn)) && horizontal(pos, nb) < lateral) return null;
  }
  const s = endSign(player);
  return {
    ball,
    ballVel,
    lateral,
    forehand: (ball.x - pos.x) * s > 0,
    volley: t < first.t,
    smash: ball.z > ARCADE.reach.smashZ && Math.abs(pos.y) <= ARCADE.reach.smashMaxNetDist,
    stretch: lateral > ARCADE.swing.stretchDist,
  };
}
