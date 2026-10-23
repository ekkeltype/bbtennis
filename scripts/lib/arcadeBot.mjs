/**
 * The keyboard player of the Arcade's browser scripts (scripts/arcadeRun.mjs, scripts/arcadeOnline.mjs):
 * it reads the page's match state (`window.__arcade.state()`) and plays one side by keyboard as the How
 * to Play screen says. It serves with a tap of J, then J again about 650 ms later (just after the top
 * of the toss) with D held; it returns with J pressed early, about 0.55 s before the predicted contact,
 * while moving toward the ball's predicted spot; the swing is automatic. A ball that will land out is
 * let go. It works in its own player's court frame (player 1's court is turned 180°), so the same keys
 * mean the same moves from either end, as they do for a person.
 */

export const TICK_HZ = 60;

/** Court and rules numbers the player needs (src/core/court.ts COURT, src/arcade/core/tuning.ts ARCADE). */
const HALF_WIDTH = 4.115;
const HALF_LENGTH = 11.885;
const BALL_R = 0.033;
const MAX_ABS_X = 6.5;
const MAX_BEHIND = 2.0;
const NET_GAP = 0.4;
/** Ticks from the toss to its top (serve.apexTime 0.65 s at Normal pace). */
const SERVE_TICKS = 39;
/**
 * Contact heights a groundstroke is planned for after the bounce: the CPU's band (src/arcade/core/cpu.ts),
 * then, for a slice that bounces lower, most of the reach zone's 0.15–2.7 m.
 */
const BANDS = [
  { lo: 0.5, hi: 1.4 },
  { lo: 0.2, hi: 2.5 },
];
/**
 * Contacts are planned at least this far past the bounce (more than the 1.4 m reach), so the ball
 * can't dip out of the reach zone just before bouncing, which swings at it as a half-volley.
 */
const PAST_BOUNCE = 1.6;
/** Stand this far beside the ball's track, on the forehand side. */
const SIDE = 0.7;
/** Running speed assumed when planning (top speed 6 m/s less the acceleration), and the slack allowed. */
const RUN = 5.0;
const SLACK = 0.3;
/** Commit this long before the predicted contact: the charge fills in 0.5 s, and PERFECT is the next 0.12 s. */
const LEAD_S = 0.56;
/** Held keys stop this close to the spot. */
const DEADBAND = 0.2;
/** Where the player waits between shots: behind the centre of the baseline (own court frame). */
const HOME = { x: 0, y: -(HALF_LENGTH + 0.8) };

/** Server of the current point (src/core/scoring.ts currentServer). */
export function serverOf(score) {
  if (!score.inTiebreak) return score.gameServer;
  const played = score.points[0] + score.points[1];
  return Math.floor((played + 1) / 2) % 2 === 0 ? score.gameServer : 1 - score.gameServer;
}

/** Ball position `t` s after the flight's hit (src/arcade/core/flight.ts flightPos). */
function flightPos(f, t) {
  const c = Math.min(Math.max(t, 0), f.tGone);
  let seg = f.segments[0];
  for (const s of f.segments) if (s.t0 <= c) seg = s;
  const d = c - seg.t0;
  const at = (k) => seg.p0[k] + seg.v0[k] * d + 0.5 * seg.a[k] * d * d;
  return { x: at('x'), y: at('y'), z: at('z') };
}

/** True when a ground point (own court frame) is in the player's singles half (lines in). */
const inOwnCourt = (p) => Math.abs(p.x) <= HALF_WIDTH + BALL_R && p.y <= BALL_R && p.y >= -(HALF_LENGTH + BALL_R);

const clampSpot = (p) => ({
  x: Math.min(MAX_ABS_X, Math.max(-MAX_ABS_X, p.x)),
  y: Math.min(-NET_GAP, Math.max(-(HALF_LENGTH + MAX_BEHIND), p.y)),
});

/** Movement keys toward `to` from `pos` (own court frame: screen right = +x, up = toward the net = +y). */
function keysToward(pos, to) {
  const keys = [];
  if (to.x > pos.x + DEADBAND) keys.push('KeyD');
  else if (to.x < pos.x - DEADBAND) keys.push('KeyA');
  if (to.y > pos.y + DEADBAND) keys.push('KeyW');
  else if (to.y < pos.y - DEADBAND) keys.push('KeyS');
  return keys;
}

/** The keyboard player of side `me` (0 or 1) on `page`: held keys and the presses made so far. */
export class ArcadeBot {
  constructor(page, me = 0) {
    this.page = page;
    this.me = me;
    this.held = new Set();
    /** Set-up (phase.since) already tossed in; toss (tick) already struck; flight (hit tick) already committed to. */
    this.tossedIn = null;
    this.struck = null;
    this.committedTo = null;
    /** The plan for the incoming flight, by its hit tick. */
    this.plan = null;
    this.serves = 0;
  }

  /** A world point in this player's court frame (player 1's court turned 180°: its half is y < 0 too). */
  own(p) {
    return this.me === 0 ? p : { x: -p.x, y: -p.y, z: p.z };
  }

  /**
   * Where and when this player meets the incoming flight `f` (it is now `ft` s after its hit, the player
   * at `pos`, own frame): the first tick, PAST_BOUNCE beyond the bounce, with the ball in a groundstroke
   * band (the first band, then the next) that the player can run to, else the one it misses by least;
   * null for a net ball, a ball landing out, or one that never comes into a band.
   */
  planFor(f, pos, ft) {
    const first = f.bounces[0];
    if (f.net || first === undefined) return null;
    const bounce = this.own(first.at);
    if (!inOwnCourt(bounce)) return null;
    let best = null;
    for (const band of BANDS) {
      for (let n = Math.floor(Math.max(ft, first.t) * TICK_HZ) + 1; n / TICK_HZ < f.tEnd; n++) {
        const t = n / TICK_HZ;
        const b = this.own(flightPos(f, t));
        if (b.z < band.lo || b.z > band.hi || b.y >= 0 || Math.hypot(b.x - bounce.x, b.y - bounce.y) < PAST_BOUNCE) continue;
        const spot = clampSpot({ x: b.x - SIDE, y: b.y });
        const lateBy = Math.hypot(spot.x - pos.x, spot.y - pos.y) - RUN * (t - ft) - SLACK;
        if (lateBy <= 0) return { t, spot };
        if (best === null || lateBy < best.lateBy) best = { t, spot, lateBy };
      }
    }
    return best;
  }

  /** Holds exactly `keys` (presses the new ones, releases the rest). */
  async hold(keys) {
    const want = new Set(keys);
    for (const k of [...this.held]) {
      if (!want.has(k)) {
        await this.page.keyboard.up(k);
        this.held.delete(k);
      }
    }
    for (const k of want) {
      if (!this.held.has(k)) {
        await this.page.keyboard.down(k);
        this.held.add(k);
      }
    }
  }

  /** A shot-key tap (the game latches a tap shorter than a tick). */
  async tap(code) {
    await this.page.keyboard.down(code);
    await this.page.keyboard.up(code);
  }

  /** One look at the state `s` and the keys for it. */
  async act(s) {
    const me = s.p[this.me];
    const pos = this.own(me.pos);
    const phase = s.phase.kind;
    if (phase === 'setup' && serverOf(s.score) === this.me) {
      await this.hold([]);
      if (this.tossedIn !== s.phase.since) {
        this.tossedIn = s.phase.since;
        await this.tap('KeyJ');
      }
      return;
    }
    if (phase === 'toss' && s.toss?.player === this.me) {
      await this.hold(['KeyD']);
      if (this.struck !== s.toss.tick && s.tick - s.toss.tick >= SERVE_TICKS) {
        this.struck = s.toss.tick;
        this.serves++;
        await this.tap('KeyJ');
      }
      return;
    }
    const f = s.flight;
    if (phase !== 'rally' || f === null) {
      await this.hold([]);
      return;
    }
    const ft = (s.tick - f.hit.tick) / TICK_HZ;
    if (f.hit.player === this.me || ft >= f.tEnd) {
      await this.hold(keysToward(pos, HOME));
      return;
    }
    if (this.plan?.flight !== f.hit.tick) this.plan = { flight: f.hit.tick, meet: this.planFor(f, pos, ft) };
    const meet = this.plan.meet;
    if (meet === null) {
      await this.hold([]);
      return;
    }
    await this.hold(keysToward(pos, meet.spot));
    if (me.commit === null && this.committedTo !== f.hit.tick && meet.t - ft <= LEAD_S) {
      this.committedTo = f.hit.tick;
      await this.tap('KeyJ');
    }
  }
}
