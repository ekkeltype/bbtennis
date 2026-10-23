import { forkSeed, intBelow, seedRng } from '../../core/rng';
import { awardPoint, createScore, currentServer, serveSide, situation } from '../../core/scoring';
import { other } from '../../core/types';
import type { DistributiveOmit, ScoreState } from '../../core/types';
import { buildFlight, flightPos, inBoxFor, inCourtFor } from './flight';
import { receiveSpot, serveSpot, stepMove, walkToward } from './movement';
import type { MoveMode } from './movement';
import { contactAt, stepSpot } from './reach';
import type { Contact } from './reach';
import { chargeAt, kmhOf, rallyGrade, resolveHit, serveGrade, tossZ } from './shot';
import { ARCADE, DT, TICK_HZ } from './tuning';
import type {
  ArcadeConfig, ArcadeEvent, ArcadeState, ArcadeStats, CallKind, Flight, Phase, PlayerId, PlayerInfo, PlayerInput, PlayerState,
  ShotKey, ShotType, Vec2, Vec3,
} from './types';
import { NO_INPUT } from './types';

const FREE: MoveMode = { kind: 'free' };
const LOCKED: MoveMode = { kind: 'locked' };

/** The serve each shot key plays (spec §4.8). */
const SERVE_OF: Record<ShotKey, ShotType> = { topspin: 'serveFlat', slice: 'serveSlice', lob: 'serveKick' };

/** How a point can end in the stepper; each is also the umpire's call. */
type PointEnd = 'ace' | 'winner' | 'out' | 'net' | 'doubleFault';

/** One tick in progress: the state, the inputs, each player's press and the events so far. */
interface StepCtx {
  s: ArcadeState;
  inputs: readonly [PlayerInput, PlayerInput];
  presses: [ShotKey | null, ShotKey | null];
  out: ArcadeEvent[];
}

/** Seconds → whole ticks (phase durations). */
function ticksOf(seconds: number): number {
  return Math.round(seconds * TICK_HZ);
}

/** Appends an event stamped with the current tick. */
function emit(c: StepCtx, body: DistributiveOmit<ArcadeEvent, 'tick'>): void {
  c.out.push({ tick: c.s.tick, ...body });
}

function emptyStats(): ArcadeStats {
  return { pointsWon: 0, aces: 0, doubleFaults: 0, winners: 0, errors: 0, hits: 0, perfectHits: 0, fastestServeKmh: 0 };
}

/** Each player's set-up spot for the next serve (server's spot or receiving spot), by player index. */
function setupSpots(score: ScoreState): [Vec2, Vec2] {
  const server = currentServer(score);
  const side = serveSide(score);
  const spot = (p: PlayerId): Vec2 => (p === server ? serveSpot(p, side) : receiveSpot(p, side));
  return [spot(0), spot(1)];
}

function playerAt(pos: Vec2): PlayerState {
  return { pos: { x: pos.x, y: pos.y }, vel: { x: 0, y: 0 }, commit: null, pending: null, held: { topspin: false, slice: false, lob: false }, lastSwing: null };
}

/** A new match: coin toss from the match stream (forkSeed(seed, 1)), hit streams forkSeed(seed, 10 + p), phase intro until tick = intro·60. */
export function createMatch(config: ArcadeConfig, players: [PlayerInfo, PlayerInfo], seed: number): ArcadeState {
  const match = seedRng(forkSeed(seed, 1));
  const first: PlayerId = intBelow(match, 2) === 0 ? 0 : 1;
  const score = createScore(config.format, config.deuceRule, first);
  const spots = setupSpots(score);
  const info = (p: PlayerInfo): PlayerInfo => ({ ...p, look: { ...p.look } });
  return {
    v: 1,
    config: { ...config },
    players: [info(players[0]), info(players[1])],
    tick: 0,
    phase: { kind: 'intro', until: ticksOf(ARCADE.flow.intro) },
    score,
    p: [playerAt(spots[0]), playerAt(spots[1])],
    flight: null,
    toss: null,
    point: { serveNo: 1, hits: 0, serveUnbounced: false, call: null },
    serveClockFrom: null,
    stats: [emptyStats(), emptyStats()],
    longestRally: 0,
    pointNo: 0,
    status: 'playing',
    winner: null,
    rng: { hits: [seedRng(forkSeed(seed, 10)), seedRng(forkSeed(seed, 11))], match },
  };
}

/** True once the over phase has lasted flow.overHold: the match no longer steps. */
export function finished(s: Readonly<ArcadeState>): boolean {
  return s.phase.kind === 'over' && s.tick - s.phase.since >= ticksOf(ARCADE.flow.overHold);
}

/** The shot key pressed this tick (held now, not before; topspin > slice > lob), then records the held keys. */
function pressOf(p: PlayerState, input: PlayerInput): ShotKey | null {
  const h = p.held;
  const key: ShotKey | null = input.topspin && !h.topspin ? 'topspin' : input.slice && !h.slice ? 'slice' : input.lob && !h.lob ? 'lob' : null;
  p.held = { topspin: input.topspin, slice: input.slice, lob: input.lob };
  return key;
}

/** Advances one tick (s.tick += 1) with both players' inputs; mutates s; returns that tick's events in order. No-op returning [] when status is 'over' and the over phase has lasted overHold. */
export function step(s: ArcadeState, inputs: readonly [PlayerInput, PlayerInput]): ArcadeEvent[] {
  if (finished(s)) return [];
  s.tick += 1;
  const c: StepCtx = { s, inputs, out: [], presses: [pressOf(s.p[0], inputs[0]), pressOf(s.p[1], inputs[1])] };
  if (s.tick === 1) emit(c, { type: 'coinToss', winner: s.score.firstServerOfMatch });
  const phase: Phase = s.phase;
  switch (phase.kind) {
    case 'intro':
      if (s.tick >= phase.until) startSetup(c);
      break;
    case 'setup':
      stepSetup(c);
      break;
    case 'toss':
      stepToss(c);
      break;
    case 'rally':
      stepRally(c);
      break;
    case 'dead':
      stepDead(c, phase);
      break;
    case 'over':
      break;
  }
  return c.out;
}

function placeAt(p: PlayerState, at: Vec2): void {
  p.pos = { x: at.x, y: at.y };
  p.vel = { x: 0, y: 0 };
  p.commit = null;
  p.pending = null;
}

/** Starts the next serve's set-up: players on their spots, serve clock from now. */
function startSetup(c: StepCtx): void {
  const { s } = c;
  const server = currentServer(s.score);
  const spots = setupSpots(s.score);
  placeAt(s.p[0], spots[0]);
  placeAt(s.p[1], spots[1]);
  s.flight = null;
  s.toss = null;
  s.point.hits = 0;
  s.point.serveUnbounced = false;
  s.serveClockFrom = s.tick;
  s.phase = { kind: 'setup', since: s.tick };
  emit(c, { type: 'setup', server, serveNo: s.point.serveNo, side: serveSide(s.score) });
}

function clockExpired(s: Readonly<ArcadeState>): boolean {
  return s.serveClockFrom !== null && s.tick - s.serveClockFrom >= ticksOf(ARCADE.serve.clock);
}

/** Set-up: the server on its rail, the receiver free; serve clock; a server press tosses. */
function stepSetup(c: StepCtx): void {
  const { s, inputs } = c;
  const server = currentServer(s.score);
  const receiver = other(server);
  stepMove(s.p[server], server, inputs[server], { kind: 'rail', side: serveSide(s.score) });
  stepMove(s.p[receiver], receiver, inputs[receiver], FREE);
  remember(c, receiver);
  if (clockExpired(s)) {
    fault(c, 'timeViolation');
    return;
  }
  if (c.presses[server] === null) return;
  s.toss = { tick: s.tick, player: server };
  s.p[server].vel = { x: 0, y: 0 };
  s.phase = { kind: 'toss', at: s.tick };
  emit(c, { type: 'toss', player: server });
}

/** Toss in the air: the receiver free, the server still; clock, then the drop, then a server press hits. */
function stepToss(c: StepCtx): void {
  const { s, inputs } = c;
  const toss = s.toss;
  if (toss === null) return;
  const server = toss.player;
  const receiver = other(server);
  stepMove(s.p[receiver], receiver, inputs[receiver], FREE);
  remember(c, receiver);
  if (clockExpired(s)) {
    fault(c, 'timeViolation');
    return;
  }
  const z = tossZ(s.tick - toss.tick, s.config.pace);
  if (z < ARCADE.serve.dropZ) {
    s.toss = null;
    s.phase = { kind: 'setup', since: s.tick };
    emit(c, { type: 'tossDropped', player: server });
    return;
  }
  const key = c.presses[server];
  if (key !== null) serveHit(c, toss.tick, server, key, z);
}

/** The serve: contact at the toss height `z`, graded by toss timing, aimed by the server's input this tick. */
function serveHit(c: StepCtx, tossTick: number, server: PlayerId, key: ShotKey, z: number): void {
  const { s, inputs } = c;
  const p = s.p[server];
  const hit = resolveHit({
    tick: s.tick, player: server, type: SERVE_OF[key], grade: serveGrade(tossTick, s.tick, s.config.pace),
    stretch: false, volley: false, charge: 1, contact: { x: p.pos.x, y: p.pos.y, z }, incomingSpeed: 0,
    mx: inputs[server].mx, my: inputs[server].my, pace: s.config.pace, serveSide: serveSide(s.score), serveReturn: false,
  }, s.rng.hits[server]);
  const flight = buildFlight(hit);
  s.flight = flight;
  s.toss = null;
  s.serveClockFrom = null;
  s.phase = { kind: 'rally' };
  s.point.hits = 1;
  s.point.serveUnbounced = true;
  p.lastSwing = { tick: s.tick, stroke: 'serve', stretch: false };
  p.pending = null;
  const kmh = kmhOf(flight);
  s.stats[server].fastestServeKmh = Math.max(s.stats[server].fastestServeKmh, kmh);
  emit(c, { type: 'hit', hit, kmh });
}

/** Seconds after the flight's hit at tick n. */
function flightT(f: Flight, n: number): number {
  return (n - f.hit.tick) * DT;
}

/** A player's press this tick, kept until a ball comes their way (spec §4.3); the latest press wins. */
function remember(c: StepCtx, player: PlayerId): void {
  const key = c.presses[player];
  if (key !== null) c.s.p[player].pending = key;
}

/** Free running, or planted and stepping toward the commit's target (spec §4.3). */
function moveMode(p: PlayerState): MoveMode {
  return p.commit === null ? FREE : { kind: 'planted', to: p.commit.step };
}

/**
 * Ball in play: both players move (a committed player planted); the hitter's presses wait; the
 * receiver commits (this tick's press, else a waiting one) or switches; the flight's rule events
 * this tick crossed (net, first bounce, end); then a committed receiver's contact.
 */
function stepRally(c: StepCtx): void {
  const { s, inputs } = c;
  const f = s.flight;
  if (f === null) return;
  const receiver = other(f.hit.player);
  stepMove(s.p[0], 0, inputs[0], moveMode(s.p[0]));
  stepMove(s.p[1], 1, inputs[1], moveMode(s.p[1]));
  remember(c, f.hit.player);
  const rp = s.p[receiver];
  const key = c.presses[receiver] ?? (rp.commit === null ? rp.pending : null);
  if (key !== null && flightT(f, s.tick) < f.tEnd) {
    if (rp.commit === null) {
      rp.commit = { shot: key, tick: s.tick, step: stepSpot(receiver, rp.pos, f, s.tick, s.point.serveUnbounced) };
      rp.pending = null;
      emit(c, { type: 'commit', player: receiver, shot: key });
    } else {
      rp.commit = { ...rp.commit, shot: key };
    }
  }
  if (!flightEvents(c, f)) return;
  if (rp.commit === null) return;
  const contact = contactAt(receiver, rp.pos, f, s.tick, s.point.serveUnbounced);
  if (contact !== null) rallyHit(c, receiver, contact);
}

/**
 * The flight's rule events crossed on this tick, in time order: the net (net ball), the first
 * bounce (in/out, or the service box on a serve), the end (second bounce or the surround). Stops
 * at the first that ends the point or faults; returns true while the ball is still in play.
 */
function flightEvents(c: StepCtx, f: Flight): boolean {
  const { s } = c;
  const t = flightT(f, s.tick);
  const prev = flightT(f, s.tick - 1);
  const crossed = (te: number): boolean => te > prev && te <= t;
  const hitter = f.hit.player;
  const receiver = other(hitter);
  const serve = s.point.hits === 1;
  if (f.net && f.netT !== null && crossed(f.netT)) {
    emit(c, { type: 'netHit', at: flightPos(f, f.netT) });
    if (serve) fault(c, 'fault');
    else pointTo(c, receiver, 'net');
    return false;
  }
  const first = f.bounces[0];
  if (first !== undefined && crossed(first.t)) {
    const inCourt = serve ? inBoxFor(first.at, receiver, serveSide(s.score)) : inCourtFor(first.at, receiver);
    emit(c, { type: 'bounce', at: { x: first.at.x, y: first.at.y }, inCourt });
    if (!inCourt) {
      if (serve) fault(c, 'fault');
      else pointTo(c, receiver, 'out');
      return false;
    }
    s.point.serveUnbounced = false;
  }
  if (t >= f.tEnd) {
    pointTo(c, hitter, serve ? 'ace' : 'winner');
    return false;
  }
  return true;
}

/** A committed receiver meets the ball: the committed shot (or a smash), graded by commit timing, aimed by this tick's input. */
function rallyHit(c: StepCtx, player: PlayerId, contact: Contact): void {
  const { s, inputs } = c;
  const p = s.p[player];
  const commit = p.commit;
  if (commit === null) return;
  const v = contact.ballVel;
  const grade = rallyGrade(commit.tick, s.tick);
  const hit = resolveHit({
    tick: s.tick, player, type: contact.smash ? 'smash' : commit.shot, grade, stretch: contact.stretch, volley: contact.volley,
    charge: chargeAt(commit.tick, s.tick), contact: contact.ball, incomingSpeed: Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z),
    mx: inputs[player].mx, my: inputs[player].my, pace: s.config.pace, serveSide: null, serveReturn: s.point.hits === 1,
  }, s.rng.hits[player]);
  const flight = buildFlight(hit);
  s.flight = flight;
  p.lastSwing = { tick: s.tick, stroke: contact.smash ? 'smash' : contact.forehand ? 'forehand' : 'backhand', stretch: contact.stretch };
  p.commit = null;
  p.pending = null;
  s.point.hits += 1;
  s.point.serveUnbounced = false;
  s.stats[player].hits += 1;
  if (grade === 'perfect') s.stats[player].perfectHits += 1;
  emit(c, { type: 'hit', hit, kmh: kmhOf(flight) });
}

/** Dead time: players walk to the next set-up spots (inputs ignored); at `until`, the next set-up or the end. */
function stepDead(c: StepCtx, phase: Extract<Phase, { kind: 'dead' }>): void {
  const { s } = c;
  if (phase.next === 'setup') {
    const spots = setupSpots(s.score);
    walkToward(s.p[0], spots[0]);
    walkToward(s.p[1], spots[1]);
  } else {
    stepMove(s.p[0], 0, NO_INPUT, LOCKED);
    stepMove(s.p[1], 1, NO_INPUT, LOCKED);
  }
  if (s.tick < phase.until) return;
  if (phase.next === 'setup') startSetup(c);
  else s.phase = { kind: 'over', since: s.tick };
}

/** Ends the rally or serve: dead time of `ticks`, then `next`. Commits, waiting presses, toss and serve clock are cleared. */
function enterDead(s: ArcadeState, ticks: number, next: 'setup' | 'over'): void {
  s.phase = { kind: 'dead', until: s.tick + ticks, next };
  s.toss = null;
  s.serveClockFrom = null;
  for (const p of s.p) {
    p.commit = null;
    p.pending = null;
  }
}

/** Records and emits a call against `player`. */
function call(c: StepCtx, kind: CallKind, player: PlayerId): void {
  c.s.point.call = { call: kind, player, tick: c.s.tick };
  emit(c, { type: 'call', call: kind, player });
}

/** A serve fault (net, out of the box, or the serve clock): serve 2 after faultPause, or a double fault. */
function fault(c: StepCtx, kind: 'fault' | 'timeViolation'): void {
  const { s } = c;
  const server = currentServer(s.score);
  call(c, kind, server);
  if (s.point.serveNo === 2) {
    pointTo(c, other(server), 'doubleFault');
    return;
  }
  s.point.serveNo = 2;
  enterDead(s, ticksOf(ARCADE.flow.faultPause), 'setup');
}

/**
 * Point to `winner`: the call (against the loser), stats, the score (point, game, set, match
 * events), the situation banner, then dead time for the call, the score and any game banner.
 */
function pointTo(c: StepCtx, winner: PlayerId, reason: PointEnd): void {
  const { s } = c;
  const loser = other(winner);
  const server = currentServer(s.score);
  call(c, reason, loser);
  const st = s.stats;
  st[winner].pointsWon += 1;
  if (reason === 'ace') st[server].aces += 1;
  if (reason === 'doubleFault') st[server].doubleFaults += 1;
  if (reason === 'winner') st[winner].winners += 1; // the hitter won
  if (reason === 'out' || reason === 'net') st[loser].errors += 1; // the hitter lost
  s.longestRally = Math.max(s.longestRally, s.point.hits);
  s.pointNo += 1;
  s.point.serveNo = 1;
  const won = awardPoint(s.score, winner);
  emit(c, { type: 'point', winner, reason });
  if (won.game !== null) emit(c, { type: 'game', winner: won.game });
  if (won.set !== null) emit(c, { type: 'set', winner: won.set });
  if (won.match !== null) {
    emit(c, { type: 'match', winner: won.match });
    s.status = 'over';
    s.winner = won.match;
  } else {
    const text = situation(s.score);
    if (text !== null) emit(c, { type: 'situation', text });
  }
  const { flow } = ARCADE;
  const secs = flow.call + flow.score + (won.game !== null ? flow.gameBanner : 0);
  enterDead(s, ticksOf(secs), won.match !== null ? 'over' : 'setup');
}

/** The ball to draw at absolute time `t` (s, may be between ticks): flight position, toss position above the server, or null (held / no ball). */
export function ballAt(s: Readonly<ArcadeState>, t: number): Vec3 | null {
  const kind = s.phase.kind;
  if (kind === 'toss' && s.toss !== null) {
    const pos = s.p[s.toss.player].pos;
    return { x: pos.x, y: pos.y, z: tossZ(Math.max(0, t * TICK_HZ - s.toss.tick), s.config.pace) };
  }
  if ((kind === 'rally' || kind === 'dead') && s.flight !== null) {
    const ft = t - s.flight.hit.tick * DT;
    return ft <= s.flight.tGone ? flightPos(s.flight, ft) : null;
  }
  return null;
}

/** Seconds since the current flight's hit at absolute time t, or null. */
export function flightTime(s: Readonly<ArcadeState>, t: number): number | null {
  return s.flight === null ? null : t - s.flight.hit.tick * DT;
}

/** Who the ball is flying toward (the player who may commit), or null. */
export function receiverOf(s: Readonly<ArcadeState>): PlayerId | null {
  const f = s.flight;
  if (s.phase.kind !== 'rally' || f === null || flightT(f, s.tick) >= f.tEnd) return null;
  return other(f.hit.player);
}

/** Seconds left on the serve clock at the current tick, or null. */
export function serveClockLeft(s: Readonly<ArcadeState>): number | null {
  if (s.serveClockFrom === null) return null;
  return Math.max(0, ARCADE.serve.clock - (s.tick - s.serveClockFrom) * DT);
}
