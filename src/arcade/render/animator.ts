import { endSign } from '../../core/court';
import { currentServer } from '../../core/scoring';
import { other } from '../../core/types';
import { viewerEnd } from '../../render/projection';
import { ANIMS, frameIndex, type AnimName, type View } from '../../render/sprites/animations';
import { contactAt, type Contact } from '../core/reach';
import { ARCADE, DT } from '../core/tuning';
import type { ArcadeState, CallKind, PlayerId, PlayerState, Vec2 } from '../core/types';

/** A player as drawn: feet on the ground (metres), animation, frame, camera view and mirroring. */
export interface ArcadePose { feet: Vec2; anim: AnimName; frame: number; view: View; flip: boolean }

/** The animation part of a pose. */
interface Frame { anim: AnimName; frame: number; flip: boolean }

/** What a swing draws: a groundstroke side, the stretch reach, or the serve frames (serve and smash). */
type Swing = 'forehand' | 'backhand' | 'stretch' | 'serve';

/** Swing frame time; the contact frame (2) lands on the contact tick, so a swing starts 2 frames (180 ms) before it. */
const SWING_MS = ANIMS.forehand.msPerFrame;
const CONTACT_FRAME = 2;
/** A swing keeps showing this long after its contact (the follow-through). */
const FOLLOW_MS = 450;
/** Ticks ahead probed for a committed player's contact: 11 ticks cover the 180 ms backswing. */
const PROBE_TICKS = 11;
/** Below this speed (m/s) a player stands idle. */
const IDLE_SPEED = 0.2;
/** Share of the toss's rise after which the server leaves the toss frame for the trophy pose. */
const TROPHY_AT = 0.45;
/** Calls that end a point; the others (fault, time violation) only end a serve. */
const POINT_CALLS: ReadonlySet<CallKind> = new Set<CallKind>(['ace', 'winner', 'out', 'net', 'doubleFault']);

const pose = (anim: AnimName, frame: number, flip = false): Frame => ({ anim, frame, flip });

/** Frame of a looping animation at sim time `t` (s). */
const loopFrame = (anim: AnimName, t: number): number => frameIndex(anim, Math.floor((Math.max(0, t) * 1000) / ANIMS[anim].msPerFrame));

/**
 * Swing frame `n` (0–1 backswing, 2 contact, 3 follow-through). The stretch has two frames, reach
 * and contact, mirrored for a backhand-side reach. Serve and smash wind up in the trophy pose (1).
 */
function swingFrame(swing: Swing, n: number, forehand: boolean): Frame {
  switch (swing) {
    case 'stretch':
      return pose('stretch', n < CONTACT_FRAME ? 0 : 1, !forehand);
    case 'serve':
      return pose('serve', Math.min(3, Math.max(1, n)));
    default:
      return pose(swing, Math.min(3, Math.max(0, n)));
  }
}

/** Swing frame `n` for the time `ms` from the contact (negative before it). */
const swingStep = (ms: number): number => CONTACT_FRAME + Math.floor(ms / SWING_MS);

/** The follow-through of the player's latest contact, for FOLLOW_MS after it. */
function followThrough(p: PlayerState, t: number): Frame | null {
  const last = p.lastSwing;
  if (last === null) return null;
  const ms = (t - last.tick * DT) * 1000;
  if (ms < 0 || ms >= FOLLOW_MS) return null;
  const n = swingStep(ms);
  if (last.stroke === 'serve' || last.stroke === 'smash') return swingFrame('serve', n, true);
  return swingFrame(last.stretch ? 'stretch' : last.stroke, n, last.stroke === 'forehand');
}

/** The swing a contact plays. */
function swingOf(c: Contact): Swing {
  if (c.smash) return 'serve';
  if (c.stretch) return 'stretch';
  return c.forehand ? 'forehand' : 'backhand';
}

/** A committed player's backswing: the live flight's contact from the current spot within 11 ticks puts frame 2 on its tick. */
function backswing(s: Readonly<ArcadeState>, p: PlayerId, t: number): Frame | null {
  const ps = s.p[p];
  const f = s.flight;
  if (ps.commit === null || f === null || s.phase.kind !== 'rally') return null;
  for (let n = s.tick + 1; n <= s.tick + PROBE_TICKS; n++) {
    const c = contactAt(p, ps.pos, f, n, s.point.serveUnbounced);
    if (c === null) continue;
    const step = swingStep((t - n * DT) * 1000);
    return step < 0 ? null : swingFrame(swingOf(c), Math.min(CONTACT_FRAME, step), c.forehand);
  }
  return null;
}

/** The winner of the match, or of the game the dead time follows (a point call with the points back to 0–0). */
function justWon(s: Readonly<ArcadeState>): PlayerId | null {
  if (s.winner !== null) return s.winner;
  const call = s.point.call;
  if (call === null || !POINT_CALLS.has(call.call)) return null;
  return s.score.points[0] === 0 && s.score.points[1] === 0 ? other(call.player) : null;
}

/** After a game, set or match (dead time and the end): the winner celebrates, the loser hangs their head. */
function reaction(s: Readonly<ArcadeState>, p: PlayerId, t: number): Frame | null {
  if (s.phase.kind !== 'dead' && s.phase.kind !== 'over') return null;
  const winner = justWon(s);
  if (winner === null) return null;
  const anim: AnimName = winner === p ? 'celebrate' : 'dejected';
  return pose(anim, loopFrame(anim, t));
}

const speed = (v: Vec2): number => Math.sqrt(v.x * v.x + v.y * v.y);

/** The server at set-up (frame 0 while standing) and during the toss (frame 0, then the trophy pose as the ball rises). */
function serving(s: Readonly<ArcadeState>, p: PlayerId, t: number): Frame | null {
  const phase = s.phase;
  if (phase.kind === 'setup' && p === currentServer(s.score) && speed(s.p[p].vel) < IDLE_SPEED) return pose('serve', 0);
  if (phase.kind !== 'toss' || s.toss?.player !== p) return null;
  const rise = ARCADE.serve.apexTime / ARCADE.pace[s.config.pace];
  return pose('serve', t - s.toss.tick * DT < TROPHY_AT * rise ? 0 : 1);
}

/** Running by the dominant velocity axis: sideways in the viewer's screen directions, else toward or away from the net. */
function locomotion(v: Vec2, p: PlayerId, viewer: PlayerId | 'spectator', t: number): Frame {
  let anim: AnimName = 'idle';
  if (speed(v) >= IDLE_SPEED) {
    if (Math.abs(v.x) >= Math.abs(v.y)) anim = (viewerEnd(viewer) === 0 ? v.x : -v.x) > 0 ? 'runRight' : 'runLeft';
    else anim = v.y * endSign(p) > 0 ? 'runToward' : 'runAway';
  }
  return pose(anim, loopFrame(anim, t));
}

/**
 * Pose of player p at sim time t (s) for viewer (pure; uses state and t only). In order: the
 * follow-through of the latest contact (450 ms), celebrate/dejected after a game, set or match,
 * the serve frames, a committed player's backswing, then idle or running.
 */
export function poseAt(s: Readonly<ArcadeState>, p: PlayerId, t: number, viewer: PlayerId | 'spectator'): ArcadePose {
  const ps = s.p[p];
  const ahead = t - s.tick * DT;
  const feet = { x: ps.pos.x + ps.vel.x * ahead, y: ps.pos.y + ps.vel.y * ahead };
  const view: View = p === viewerEnd(viewer) ? 'near' : 'far';
  const f = followThrough(ps, t) ?? reaction(s, p, t) ?? serving(s, p, t) ?? backswing(s, p, t) ?? locomotion(ps.vel, p, viewer, t);
  return { feet, view, ...f };
}
