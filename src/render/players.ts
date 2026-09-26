import { receiverSpot, restSpot, serverSpot } from '../core/court';
import { chaseFeet, stanceFor } from '../core/trajectory';
import { TUNING } from '../core/tuning';
import { turnViewAt, type TurnView } from '../core/turnView';
import type { PlayerId, ReturnTurnData, ServeTurnData, StrikeInfo, TurnState, Vec2, ViewModel } from '../core/types';
import { dist2 } from '../core/util';
import { ANIMS, type AnimName, type View } from './sprites/animations';
import { worldFrame, type WorldFrame } from './world';

/** A player as drawn this frame: feet on the ground (metres), animation, frame number, view and mirroring. */
export interface PlayerPose { feet: Vec2; anim: AnimName; frame: number; view: View; flip: boolean }

/** Swing a player is making or finishing: a groundstroke side, the serve, or the forehand-side stretch. */
type Stroke = 'forehand' | 'backhand' | 'serve' | 'stretch';

/** An animation frame forced by the rules (a swing, the serve, a celebration), overriding locomotion. */
interface Action { anim: AnimName; frame: number }

/** A player's plan for one frame: an optional forced frame and where to go at what speed (snap = be there now). */
interface Plan { action: Action | null; target: Vec2 | null; speed: number; snap: boolean }

/** Cosmetic state of one player between frames. */
interface Actor { feet: Vec2; anim: AnimName; animMs: number; stroke: Stroke | null }

const CHASE_SPEED = TUNING.movement.chaseMaxSpeed;
const JOG_SPEED = TUNING.movement.jogSpeed;
/** Groundstroke frame time; contact is frame 2, so the swing starts two frames before the strike. */
const SWING_MS = ANIMS.forehand.msPerFrame;
const CONTACT_FRAME = 2;
/** How long a groundstroke or stretch follow-through holds after contact before running on. */
const FOLLOW_MS = 400;
/** Serve after contact: the strike frame, then the follow-through until `SERVE_DONE_MS`. */
const SERVE_STRIKE_MS = 120;
const SERVE_DONE_MS = 500;
/** Share of the toss apex after which the server leaves the toss frame for the trophy pose. */
const TROPHY_AT = 0.45;
/** Movement per frame below which a player counts as standing still. */
const STILL_M = 1e-4;

const STAY: Plan = { action: null, target: null, speed: 0, snap: false };

const act = (anim: AnimName, frame: number): Action => ({ anim, frame });

/** Frame of a looping animation `ms` into it. */
const loopFrame = (anim: AnimName, ms: number): number => Math.floor(Math.max(0, ms) / ANIMS[anim].msPerFrame);

/** `from` moved toward `to` by at most `step` metres. */
function moveToward(from: Vec2, to: Vec2, step: number): Vec2 {
  const d = dist2(from, to);
  if (d <= step) return { x: to.x, y: to.y };
  const k = step / d;
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
}

/** Frames of a stroke `ms` after its contact, or null once it is over. */
function followThrough(stroke: Stroke, ms: number): Action | null {
  if (stroke === 'serve') {
    if (ms < SERVE_STRIKE_MS) return act('serve', 2);
    return ms < SERVE_DONE_MS ? act('serve', 3) : null;
  }
  if (ms >= FOLLOW_MS) return null;
  if (stroke === 'stretch') return act('stretch', 1);
  return act(stroke, Math.min(3, CONTACT_FRAME + Math.floor(ms / SWING_MS)));
}

/** The stroke a strike was made with: the serve, a forehand-side stretch, else the side the player set up for. */
function strokeOf(strike: StrikeInfo, planned: Stroke | null): Stroke {
  if (strike.isServe) return 'serve';
  const side: Stroke = planned === 'forehand' || planned === 'backhand' ? planned : strike.forehand ? 'forehand' : 'backhand';
  return strike.stretch && side === 'forehand' ? 'stretch' : side;
}

/** Who won the point that ended the previous turn: the striker on a miss, else the ball's receiver. */
function pointWinner(f: WorldFrame): PlayerId | null {
  const last = f.last?.turn;
  const o = last?.outcome;
  if (!last || !o) return null;
  if (last.data.kind === 'return') return o.kind === 'miss' ? last.data.striker : last.data.owner;
  return last.data.receiver;
}

function spotsOf(d: ServeTurnData): [Vec2, Vec2] {
  const spots: [Vec2, Vec2] = [restSpot(0), restSpot(1)];
  spots[d.owner] = serverSpot(d.owner, d.side);
  spots[d.receiver] = receiverSpot(d.receiver, d.side);
  return spots;
}

function initialFeet(f: WorldFrame): [Vec2, Vec2] {
  const d = f.turn?.data;
  if (d?.kind === 'serve') return spotsOf(d);
  const feet: [Vec2, Vec2] = [restSpot(0), restSpot(1)];
  if (d?.kind === 'return') feet[d.striker] = { x: d.incoming.p0.x, y: d.incoming.p0.y };
  return feet;
}

/**
 * Cosmetic player positions and animations derived from the turn the viewer sees (spec §3.0, §3.3.2,
 * §3.4): serve and receive spots at PRE_SERVE; the receiver's feet chase `chaseFeet(start, stance,
 * progress)` at up to 7 m/s and set up for the forehand or backhand `stanceFor` picks; swings put
 * their contact frame on the strike; the striker follows through and jogs back to the centre at
 * 4 m/s; point winners celebrate and losers hang their heads during point lead-ins and at match end.
 */
export class PlayerAnimator {
  private actors: [Actor, Actor] | null = null;
  private turnId: number | null = null;
  private start: [Vec2, Vec2] = [restSpot(0), restSpot(1)];
  private stance: { feet: Vec2; forehand: boolean } | null = null;
  private overMs = 0;

  /** Advances by `dtMs` to the frame of `vm` and returns both players' poses. */
  update(vm: ViewModel, dtMs: number): [PlayerPose, PlayerPose] {
    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    this.overMs = vm.liveTurn === null && vm.pub.turn === null ? this.overMs + dt : 0;
    return this.step(worldFrame(vm, this.overMs), dt);
  }

  /** Advances by `dtMs` to frame `f` (as `update`, for a caller that already built the frame). */
  step(f: WorldFrame, dtMs: number): [PlayerPose, PlayerPose] {
    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    if (!this.actors) {
      const feet = initialFeet(f);
      this.actors = [0, 1].map((p) => ({ feet: feet[p]!, anim: 'idle', animMs: 0, stroke: null })) as [Actor, Actor];
    }
    const id = f.turn?.data.turnId ?? null;
    if (id !== this.turnId) {
      this.beginTurn(f, this.actors);
      this.turnId = id;
    }
    return [this.pose(f, 0, dt), this.pose(f, 1, dt)];
  }

  /** Where player `p` stood when the current turn began (chase plates stay above it). */
  turnStartFeet(p: PlayerId): Vec2 {
    return { ...this.start[p] };
  }

  private beginTurn(f: WorldFrame, actors: [Actor, Actor]): void {
    this.start = [{ ...actors[0].feet }, { ...actors[1].feet }];
    this.stance = null;
    const d = f.turn?.data;
    if (d?.kind !== 'return') return;
    this.stance = stanceFor(d.incoming.contact, d.owner, actors[d.owner].feet);
    const striker = actors[d.striker];
    const o = f.last?.turn.outcome;
    if (o?.kind === 'strike') striker.stroke = strokeOf(o.strike, striker.stroke);
    actors[d.owner].stroke = this.stance.forehand ? 'forehand' : 'backhand';
  }

  private pose(f: WorldFrame, p: PlayerId, dt: number): PlayerPose {
    const a = this.actors![p];
    const plan = this.plan(f, p);
    const before = a.feet;
    if (plan.target && plan.snap) a.feet = { x: plan.target.x, y: plan.target.y };
    else if (plan.target) a.feet = moveToward(a.feet, plan.target, (plan.speed * dt) / 1000);
    const view: View = p === f.near ? 'near' : 'far';
    if (plan.action) {
      a.anim = plan.action.anim;
      a.animMs = 0;
      return { feet: { ...a.feet }, anim: plan.action.anim, frame: plan.action.frame, view, flip: false };
    }
    const moved = !plan.snap && dist2(before, a.feet) > STILL_M;
    const anim = moved ? runAnim(before, a.feet, f.near) : 'idle';
    a.animMs = anim === a.anim ? a.animMs + dt : 0;
    a.anim = anim;
    return { feet: { ...a.feet }, anim, frame: loopFrame(anim, a.animMs), view, flip: false };
  }

  private plan(f: WorldFrame, p: PlayerId): Plan {
    const { turn, view } = f;
    if (!turn || !view) {
      const winner = f.pub.winner;
      if (winner === null) return STAY;
      const anim = winner === p ? 'celebrate' : 'dejected';
      return { ...STAY, action: act(anim, loopFrame(anim, f.overMs)) };
    }
    const d = turn.data;
    return d.kind === 'serve' ? this.planServe(f, turn, d, view, p) : this.planReturn(f, d, view, p);
  }

  private planServe(f: WorldFrame, t: TurnState, d: ServeTurnData, v: TurnView, p: PlayerId): Plan {
    const spot = spotsOf(d)[p];
    if (v.phase === 'leadIn') {
      if (d.leadIn.kind === 'fault') return { action: null, target: spot, speed: JOG_SPEED, snap: false };
      if (d.leadIn.kind === 'point') {
        const winner = pointWinner(f);
        if (winner === null) return STAY;
        const anim = winner === p ? 'celebrate' : 'dejected';
        return { ...STAY, action: act(anim, loopFrame(anim, f.τ)) };
      }
    }
    const plan: Plan = { action: null, target: spot, speed: 0, snap: true };
    if (p !== d.owner) return plan;
    if (v.strike) plan.action = followThrough('serve', f.τ - v.strike.τ);
    else if (v.phase === 'toss' && v.tossAt !== null) {
      const since = v.simτ - turnViewAt(t, v.tossAt).simτ;
      plan.action = act('serve', since < TROPHY_AT * d.tossApexMs * d.pace ? 0 : 1);
    }
    return plan;
  }

  private planReturn(f: WorldFrame, d: ReturnTurnData, v: TurnView, p: PlayerId): Plan {
    const actor = this.actors![p];
    if (p === d.striker) {
      const follow = actor.stroke ? followThrough(actor.stroke, f.τ) : null;
      return follow ? { ...STAY, action: follow } : { action: null, target: restSpot(p), speed: JOG_SPEED, snap: false };
    }
    const stance = (this.stance ??= stanceFor(d.incoming.contact, p, actor.feet));
    const stroke: Stroke = stance.forehand ? 'forehand' : 'backhand';
    if (v.strike) return { ...STAY, action: followThrough(strokeOf(v.strike, stroke), f.τ - v.strike.τ) };
    if (v.outcome) return STAY;
    const target = v.phase === 'chase' ? chaseFeet(this.start[p], stance.feet, v.chaseProgress) : stance.feet;
    const plan: Plan = { action: null, target, speed: CHASE_SPEED, snap: false };
    const T = d.incoming.T;
    const swingFrom = T - CONTACT_FRAME * SWING_MS;
    if (v.phase === 'queued' && v.simτ >= swingFrom) {
      plan.action = act(stroke, Math.min(CONTACT_FRAME, Math.floor((v.simτ - swingFrom) / SWING_MS)));
    } else if (v.phase !== 'queued' && v.simτ > T) {
      // Reaching for a ball past the contact point: the stretch pose exists on the forehand side only.
      plan.action = stance.forehand ? act('stretch', 0) : act('backhand', 1);
    }
    return plan;
  }
}

/** Locomotion animation for a move from `from` to `to`: sideways runs are screen directions, the others net-relative. */
function runAnim(from: Vec2, to: Vec2, near: PlayerId): AnimName {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return (near === 0 ? dx : -dx) > 0 ? 'runRight' : 'runLeft';
  return Math.abs(to.y) < Math.abs(from.y) ? 'runToward' : 'runAway';
}
