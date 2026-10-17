import { ballAt, tossZ } from '../core/trajectory';
import { turnViewAt, type TurnView } from '../core/turnView';
import type { BallFlight, PlayerId, ServeTurnData, TurnState, Vec3 } from '../core/types';
import { capBallZ, tossBallView, type BallView } from './ballPaint';
import type { PlayerPose } from './players';
import type { WorldFrame } from './world';

export { BALL_MAX_Z, drawBall, drawBallShadow, type BallView } from './ballPaint';

/** A ball that has been called, has passed or was dropped fades out over this long (R21). */
export const BALL_FADE_MS = 300;
/** Motion trail: positions this many ms apart behind the ball. */
const TRAIL_STEP_MS = 16;
const TRAIL_SAMPLES = 2;
/** The insane trail: more samples (drawn in the insane colour at falling opacity, see ballPaint; power-meter spec §6). */
const HOT_TRAIL_SAMPLES = 4;

const held = (player: PlayerId): BallView => ({ kind: 'held', player });

/** The ball `t` ms along `flight` (height capped), with its trail: 4 hot samples for an insane shot, else 2. */
export function flightBall(flight: BallFlight, t: number, alpha: number): BallView {
  const hot = flight.tier === 'insane';
  const trail: Vec3[] = [];
  for (let i = 1; i <= (hot ? HOT_TRAIL_SAMPLES : TRAIL_SAMPLES); i++) trail.push(capBallZ(ballAt(flight, t - i * TRAIL_STEP_MS)));
  return { kind: 'air', pos: capBallZ(ballAt(flight, t)), alpha, trail, hot };
}

/** Opacity `sinceEnd` ms after a call, pass or drop; null once faded out. */
function fading(sinceEnd: number): number | null {
  const alpha = 1 - Math.max(0, sinceEnd) / BALL_FADE_MS;
  return alpha > 0 ? alpha : null;
}

/** The tossed ball above the server's tossing hand, `tossZ` high (spec §3.2.3). */
function tossBall(
  d: ServeTurnData,
  t: TurnState,
  v: TurnView,
  pose: PlayerPose,
  f: WorldFrame,
  alpha: number,
): BallView {
  if (v.tossAt === null) return held(d.owner);
  const since = v.simτ - turnViewAt(t, v.tossAt).simτ;
  return tossBallView(pose, tossZ(since, d.tossApexMs * d.pace), alpha, f.vm.viewer);
}

/** The previous turn's ball carried on past its end and fading out (serve lead-ins, match end). */
function lastBall(f: WorldFrame, poses: readonly [PlayerPose, PlayerPose]): BallView | null {
  const last = f.last;
  const o = last?.view.outcome;
  if (!last || !o) return null;
  const alpha = fading(last.view.τ - o.endτ);
  if (alpha === null) return null;
  const d = last.turn.data;
  if (d.kind === 'return') return flightBall(d.incoming, last.view.simτ, alpha);
  if (o.kind === 'fault' && o.reason === 'ballDropped') return tossBall(d, last.turn, last.view, poses[d.owner], f, alpha);
  return null;
}

/**
 * Where the ball is this frame (Task 18 ruling 2). Serve turn: in the server's hand before the toss
 * and while catching, on the toss arc during the toss, dropping (and fading) on a ball-dropped fault;
 * during a lead-in the previous turn's ball continues and fades out 300 ms after its call or pass
 * (the first serve of the match starts in hand). Return turn: the incoming flight at the turn's
 * simulation time, fading after its call or pass. After any strike: the outgoing flight at
 * τ − strike τ. Heights are capped at 6 m.
 */
export function ballView(f: WorldFrame, poses: readonly [PlayerPose, PlayerPose]): BallView | null {
  const { turn, view } = f;
  if (!turn || !view) return lastBall(f, poses);
  if (view.strike) return flightBall(view.strike.flight, f.τ - view.strike.τ, 1);
  const d = turn.data;
  if (d.kind === 'return') {
    const alpha = view.outcome ? fading(f.τ - view.outcome.endτ) : 1;
    return alpha === null ? null : flightBall(d.incoming, view.simτ, alpha);
  }
  switch (view.phase) {
    case 'leadIn': {
      const lt = f.last?.turn;
      if (d.leadIn.kind === 'intro' || d.leadIn.kind === 'none' || !lt) return held(d.owner);
      const o = lt.outcome;
      const keptInHand = lt.data.kind === 'serve' && o?.kind === 'fault' && o.reason === 'timeViolation';
      return keptInHand && lt.data.owner === d.owner ? held(d.owner) : lastBall(f, poses);
    }
    case 'toss':
      return tossBall(d, turn, view, poses[d.owner], f, 1);
    case 'ended': {
      const o = view.outcome;
      if (o?.kind !== 'fault' || o.reason !== 'ballDropped') return held(d.owner);
      const alpha = fading(f.τ - o.endτ);
      return alpha === null ? null : tossBall(d, turn, view, poses[d.owner], f, alpha);
    }
    default:
      return held(d.owner);
  }
}
