import type { CallKind, DeuceRule, FormatId, PaceId, PlayerId, PlayerInfo, PointReason, RngState, ScoreState, Side, Surface, Vec2, Vec3 } from '../../core/types';

export type { CallKind, PlayerId, PlayerInfo, PointReason, Side, Vec2, Vec3 };

/** A rally stroke chosen with a shot key (spec §4.1). */
export type ShotKey = 'topspin' | 'slice' | 'lob';
/** What actually flies: a rally stroke, the overhead smash or one of the three serves (spec §4.6, §4.8). */
export type ShotType = 'topspin' | 'slice' | 'lob' | 'smash' | 'serveFlat' | 'serveSlice' | 'serveKick';
/** Timing grade of a hit (spec §4.3, §4.8). */
export type Grade = 'perfect' | 'clean' | 'rushed';

/**
 * One player's controls on one tick (spec §4.1), court-relative for that player: mx +1 = the
 * player's right, my +1 = toward the net. Shot keys are held states; the sim detects presses.
 */
export interface PlayerInput { mx: -1 | 0 | 1; my: -1 | 0 | 1; topspin: boolean; slice: boolean; lob: boolean }

/** No keys held. */
export const NO_INPUT: Readonly<PlayerInput> = Object.freeze({ mx: 0, my: 0, topspin: false, slice: false, lob: false });

/** Produces a player's input each tick: the keyboard for a human, a planner for the CPU. */
export interface Controller { input(s: Readonly<ArcadeState>): PlayerInput }

/** Options a match is played with (spec §4.6 pace, §4.9 scoring). Surface is cosmetic. */
export interface ArcadeConfig { format: FormatId; deuceRule: DeuceRule; surface: Surface; pace: PaceId }

/** Everything that decides a hit's flight (spec §8: enough for both machines to build the same flight). */
export interface HitEvent {
  tick: number;
  player: PlayerId;
  type: ShotType;
  grade: Grade;
  stretch: boolean;
  volley: boolean;
  /** Power factor after grade and stretch (1 = base speed). */
  power: number;
  /** Ball position at contact. */
  contact: Vec3;
  /** Landing target after aim and scatter (ground point on the receiver's half). */
  target: Vec2;
  /** Seconds from contact to the first bounce, after scatter and the apex clamp. */
  T: number;
}

/** One parabolic piece of a flight, valid from `t0` (s after the hit) until the next segment's t0. */
export interface FlightSegment { t0: number; p0: Vec3; v0: Vec3; a: Vec3 }

/** A bounce: seconds after the hit and the ground point. */
export interface FlightBounce { t: number; at: Vec2 }

/** The closed-form path of a hit ball (spec §4.6). */
export interface Flight {
  hit: HitEvent;
  segments: FlightSegment[];
  /** In time order. Empty for a net ball. bounces[0] is the landing that decides in/out. */
  bounces: FlightBounce[];
  /** Seconds after the hit when the ball reaches the net plane y = 0, or null. */
  netT: number | null;
  /** True when the net stops the ball. */
  net: boolean;
  /** Seconds after the hit when the ball is dead for the rules: second bounce, left the surround, or (net) on the ground. */
  tEnd: number;
  /** Seconds after the hit when drawing stops (rolls on past tEnd). */
  tGone: number;
}

/** Swing drawn for a player's latest contact. */
export type Stroke = 'forehand' | 'backhand' | 'smash' | 'serve';

/** One player's moving state: position, velocity, shot commitment and the latest swing. */
export interface PlayerState {
  pos: Vec2;
  vel: Vec2;
  /**
   * Committed shot, the tick it was committed at and where the planted player's automatic steps
   * lead (null: none, the player stands) (spec §4.3); null when not committed.
   */
  commit: { shot: ShotKey; tick: number; step: Vec2 | null } | null;
  /** A shot key pressed before the ball came this player's way, waiting to commit (spec §4.3); null when none. */
  pending: ShotKey | null;
  /** Shot keys held on the previous tick (press = false → true). */
  held: { topspin: boolean; slice: boolean; lob: boolean };
  /** The player's latest contact, for animation. */
  lastSwing: { tick: number; stroke: Stroke; stretch: boolean } | null;
}

/** Match phase; ticks are absolute. */
export type Phase =
  | { kind: 'intro'; until: number }
  | { kind: 'setup'; since: number }
  | { kind: 'toss'; at: number }
  | { kind: 'rally' }
  | { kind: 'dead'; until: number; next: 'setup' | 'over' }
  | { kind: 'over'; since: number };

/** Per-player match statistics (spec §6.3 Results). */
export interface ArcadeStats {
  pointsWon: number;
  aces: number;
  doubleFaults: number;
  winners: number;
  errors: number;
  hits: number;
  perfectHits: number;
  fastestServeKmh: number;
}

/** Complete match state (JSON-safe). */
export interface ArcadeState {
  v: 1;
  config: ArcadeConfig;
  players: [PlayerInfo, PlayerInfo];
  tick: number;
  phase: Phase;
  score: ScoreState;
  p: [PlayerState, PlayerState];
  /** The live flight (rally, and the dead phase while it is drawn); null otherwise. */
  flight: Flight | null;
  /** The toss in the air (phase 'toss'). */
  toss: { tick: number; player: PlayerId } | null;
  point: {
    serveNo: 1 | 2;
    /** In-play hits this point, the serve included. */
    hits: number;
    /** True while the serve has not bounced yet (the receiver cannot reach it, spec §4.4). */
    serveUnbounced: boolean;
    /** The latest call, for banners: kind, who it is against, at which tick. */
    call: { call: CallKind; player: PlayerId; tick: number } | null;
  };
  /** Tick at which the current serve's clock started (setup start), or null outside a serve. */
  serveClockFrom: number | null;
  stats: [ArcadeStats, ArcadeStats];
  longestRally: number;
  pointNo: number;
  status: 'playing' | 'over';
  winner: PlayerId | null;
  /** Hit-scatter streams per player (spec §4.7) and the match stream (coin toss). */
  rng: { hits: [RngState, RngState]; match: RngState };
}

/** Events, stamped with the tick they happened on. */
export type ArcadeEvent = { tick: number } & (
  | { type: 'coinToss'; winner: PlayerId }
  | { type: 'setup'; server: PlayerId; serveNo: 1 | 2; side: Side }
  | { type: 'toss'; player: PlayerId }
  | { type: 'tossDropped'; player: PlayerId }
  | { type: 'commit'; player: PlayerId; shot: ShotKey }
  | { type: 'hit'; hit: HitEvent; kmh: number }
  | { type: 'bounce'; at: Vec2; inCourt: boolean }
  | { type: 'netHit'; at: Vec3 }
  | { type: 'call'; call: CallKind; player: PlayerId }
  | { type: 'point'; winner: PlayerId; reason: PointReason }
  | { type: 'game'; winner: PlayerId }
  | { type: 'set'; winner: PlayerId }
  | { type: 'match'; winner: PlayerId }
  | { type: 'situation'; text: string }
);
