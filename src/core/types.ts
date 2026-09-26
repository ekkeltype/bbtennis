/** Player index; player 0 always plays from end 0 (y < 0), player 1 from end 1. */
export type PlayerId = 0 | 1;
/** The other player. */
export const other = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0);

/** Word difficulty tier by length: easy 3–5, medium 6–9, hard 10–14 letters (spec §3.10). */
export type Tier = 'easy' | 'medium' | 'hard';
/** All tiers, easiest first (the order of serve and choice options). */
export const TIERS: readonly Tier[] = ['easy', 'medium', 'hard'];
/** Service side: deuce when the game (or tiebreak) point count is even, ad when odd (spec §3.2). */
export type Side = 'deuce' | 'ad';
/** Court surface; cosmetic only, never affects outcomes (spec §3.0). */
export type Surface = 'hard' | 'clay' | 'grass' | 'dojo';
/** Pace preset: relaxed ×1.5, normal ×1.0, fast ×0.75, lightning ×0.6 (spec §3.9). */
export type PaceId = 'relaxed' | 'normal' | 'fast' | 'lightning';
/** Match format: a single tiebreak, a short set, a full set or best of three short sets (spec §3.6). */
export type FormatId = 'tiebreak' | 'short' | 'full' | 'bo3';
/** Deuce handling: advantage points, or one deciding golden point (spec §3.6). */
export type DeuceRule = 'advantage' | 'golden';
/** Word pack: Everyday (default), Sports, Dojo or Mixed, the union of the three (spec §3.10). */
export type WordPackId = 'everyday' | 'sports' | 'dojo' | 'mixed';

/** Point or vector on the ground plane, in metres (spec §3.0 axes). */
export interface Vec2 { x: number; y: number }
/** Point in world space, in metres; z is up (spec §3.0). */
export interface Vec3 { x: number; y: number; z: number }

/** Engine flags used only by Training (spec §3.12). */
export interface TrainingFlags {
  serveClock: boolean;
  freezeUntilFirstKey: boolean;
  /** Fixed word triples [easy, medium, hard], cycled in order; null = normal picker. */
  fixedWords: { serve: string[][]; choice: string[][] } | null;
}

/** Options a match is played with, fixed when it starts. */
export interface MatchConfig {
  format: FormatId;
  pace: PaceId;
  surface: Surface;
  wordPack: WordPackId;
  deuceRule: DeuceRule;
  training: TrainingFlags | null;
}

/** Character appearance; every field is an index into a ramp/style table (spec §4.1). */
export interface Look {
  skin: number;       // 0..5
  hairStyle: number;  // 0..4
  hair: number;       // 0..7
  shirt: number;      // 0..11
  shorts: number;     // 0..11
  headband: number | null; // 0..11 or null = none
  racket: number;     // 0..5
}

/** A player in a match: name, look, and who controls them (local human, CPU or remote peer). */
export interface PlayerInfo {
  name: string;
  look: Look;
  kind: 'human' | 'cpu' | 'remote';
  /** CPU level index 0..14 (spec §3.8) or null. */
  cpuLevel: number | null;
}

/** One word on a plate. `hidden` + empty `word` when redacted for this viewer. */
export interface WordOption {
  word: string;
  len: number;
  tier: Tier;
  hidden?: true;
}

/** Prompt type: serve (3 words), chase (the striker's single word) or choice (3 words) (spec §2). */
export type PromptKind = 'serve' | 'chase' | 'choice';

/** Typing state of one prompt (spec §2, §4.2). Mutated in place by core/typing. */
export interface PromptState {
  id: number;
  kind: PromptKind;
  options: WordOption[];      // chase: 1; serve/choice: 3 in tier order easy, medium, hard
  locked: number | null;      // chase: 0 from creation
  typed: number;              // correct letters typed in the locked option
  correctKeys: number;
  wrongKeys: number;
  slips: number;              // maximal runs of consecutive wrong keys
  inSlip: boolean;
  tFirst: number | null;      // τ of first correct key (lock key for choices)
  tLast: number | null;       // τ of last correct key
  shownAt: number;            // τ when shown
  completedAt: number | null;
  lastWrongAt: number | null; // τ of last wrong key (for flash/shake)
}

/** Nine uniforms in [0,1) pre-drawn for one shot: rNet, then 4 for zx, then 4 for zy. */
export type ShotRandoms = [number, number, number, number, number, number, number, number, number];

/** How a shot resolves: in, out (outside the court or service box) or net (spec §3.5). */
export type ShotOutcome = 'in' | 'out' | 'net';

/** A shot resolved at the strike instant: outcome, landing point, and the σ and pNet used (spec §3.5). */
export interface ShotResult {
  outcome: ShotOutcome;
  landing: Vec2;   // where it lands (for net: where it would have landed)
  sigma: number;
  pNet: number;
}

/** Analytic ball flight from a strike (spec §3.4). Times are ms after the strike. */
export interface BallFlight {
  isServe: boolean;
  tier: Tier;
  p0: Vec3;             // strike point
  landing: Vec2;
  outcome: ShotOutcome;
  T: number;            // contact time at the receiver
  tBounce: number;      // bounceFrac × T
  grace: number;        // grace window length
  h: number;            // arc apex parameter (m), after net-clearance raise
  contact: Vec2;        // contact point C (z = contactZ)
  netT: number | null;  // time the ball reaches the net plane (null if it never does)
  callT: number | null; // time of the OUT/NET call (null for 'in')
  destEnd: PlayerId;    // end of the receiving player
}

/** One toss's three pre-picked serve words with their service-box targets (spec §3.2). */
export interface ServeWordSet {
  options: WordOption[];   // [easy, medium, hard]
  targets: Vec2[];         // world coords, same order
  variant: 'T' | 'wide';
}

/** Banner period that opens a serve turn: coin-toss intro, fault call, point call or none (spec §3.1). */
export interface LeadIn {
  kind: 'intro' | 'fault' | 'point' | 'none';
  ms: number;
  /** Banner lines to show during the lead-in, e.g. ['FAULT', 'BALL DROPPED'] or ['GAME', 'ALEX']. */
  text: string[];
}

/** Start data of a serve turn, owned by the server (spec §5.1 TurnRunner). */
export interface ServeTurnData {
  kind: 'serve';
  turnId: number;
  promptBase: number;       // prompt ids in this turn are promptBase, promptBase+1, ...
  owner: PlayerId;          // server
  receiver: PlayerId;
  serveNo: 1 | 2;
  side: Side;
  leadIn: LeadIn;
  serveClockMs: number | null;
  tossApexMs: number;       // a = tossApex × pace
  catchMs: number;
  pace: number;             // numeric multiplier
  wordSets: ServeWordSet[]; // [current, spare, ...]; engine appends on catch
  randoms: ShotRandoms;
  freezeFirst: boolean;     // training: freeze until first key
}

/** Start data of a return turn, owned by the receiver: incoming ball, chase word and choice prompt (spec §3.3). */
export interface ReturnTurnData {
  kind: 'return';
  turnId: number;
  promptBase: number;
  owner: PlayerId;          // receiver
  striker: PlayerId;
  incoming: BallFlight;
  chase: WordOption;        // the striker's exact word
  isServeReturn: boolean;
  n: number;                // rally depth used for incoming T (spec §3.4)
  choice: { options: WordOption[]; targets: Vec2[]; m: 1 | -1 };
  pace: number;
  randoms: ShotRandoms;
  freezeFirst: boolean;
}

/** Start data of either kind of turn. */
export type TurnData = ServeTurnData | ReturnTurnData;

/** Phase of a turn: serve states of spec §3.1 and receiver sub-states of spec §3.3. */
export type TurnPhase = 'leadIn' | 'preServe' | 'toss' | 'catch' | 'chase' | 'choice' | 'queued' | 'ended';

/** Everything about a completed strike; `flight` is the outgoing ball. */
export interface StrikeInfo {
  τ: number;
  player: PlayerId;
  word: WordOption;
  option: number;
  slips: number;
  cps: number;
  wpm: number;
  v: number;
  stretch: boolean;
  isServe: boolean;
  forehand: boolean;
  kmh: number;
  target: Vec2;
  shot: ShotResult;
  flight: BallFlight;
}

/** How a turn ended: a strike, a serve fault, a miss (ace or winner) or an OUT/NET call. */
export type TurnOutcome =
  | { kind: 'strike'; endτ: number; strike: StrikeInfo }
  | { kind: 'fault'; endτ: number; reason: 'ballDropped' | 'timeViolation' }
  | { kind: 'miss'; endτ: number; ace: boolean }
  | { kind: 'call'; endτ: number; call: 'out' | 'net' };

/** Result log of a turn, used for passive playback (spec §5.2). `ch` is '*' when redacted. */
export type TurnLogEntry =
  | { τ: number; k: 'show'; prompt: number }
  | { τ: number; k: 'toss' }
  | { τ: number; k: 'catch' }
  | { τ: number; k: 'lock'; prompt: number; option: number; ch: string }
  | { τ: number; k: 'ok'; prompt: number; ch: string }
  | { τ: number; k: 'bad'; prompt: number; ch: string }
  | { τ: number; k: 'done'; prompt: number }
  | { τ: number; k: 'freeze'; on: boolean };

/** Live state of one turn on its turn clock τ, including its playback log. */
export interface TurnState {
  data: TurnData;
  started: boolean;
  τ: number;                 // latest processed τ
  phase: TurnPhase;
  prompts: PromptState[];
  active: number | null;     // index into prompts
  tossAt: number | null;
  catchAt: number | null;
  setIndex: number;          // current serve word set
  frozenMs: number;          // training freeze accumulated
  freezeSince: number | null;
  seenKinds: PromptKind[];   // training: kinds already shown (for freezeFirst)
  log: TurnLogEntry[];
  outcome: TurnOutcome | null; // may be decided before endτ (queued strike)
  ended: boolean;
}

/** Match score: completed sets, current set and game (or tiebreak), servers and winner (spec §3.6). */
export interface ScoreState {
  format: FormatId;
  deuceRule: DeuceRule;
  setGames: [number, number][];   // completed sets
  setTiebreaks?: ([number, number] | null)[]; // parallel to setGames: each set's tiebreak points or null (createScore sets it)
  games: [number, number];        // current set
  points: [number, number];       // current game or tiebreak points
  inTiebreak: boolean;
  setsWon: [number, number];
  firstServerOfMatch: PlayerId;
  gameServer: PlayerId;           // server of the current game (tiebreak: first server)
  winner: PlayerId | null;
}

/** One player's statistics for the current match (spec §3.11). */
export interface PlayerStats {
  pointsWon: number;
  aces: number;
  doubleFaults: number;
  winners: number;
  errors: number;
  wordsCompleted: number;
  intervalSum: number;   // Σ(n−1)
  typingMs: number;      // ΣΔt
  topWpm: number;
  correctKeys: number;
  wrongKeys: number;
  fastestServeKmh: number;
}

/** Why a point ended. */
export type PointReason = 'ace' | 'winner' | 'out' | 'net' | 'doubleFault' | 'forfeit';

/** Serializable state of the seeded match RNG (four uint32 words). */
export interface RngState { a: number; b: number; c: number; d: number }

/** Word-picker memory: recently offered words and training cursors (spec §3.10). */
export interface PickerState {
  history: string[];      // last offered words, newest last
  fixedServe: number;     // training cursors
  fixedChoice: number;
}

/** Complete authoritative match state; plain JSON-safe data. */
export interface MatchState {
  v: 1;
  config: MatchConfig;
  players: [PlayerInfo, PlayerInfo];
  score: ScoreState;
  stats: [PlayerStats, PlayerStats];
  turn: TurnState | null;
  lastTurn: TurnState | null;   // previous turn (renderers finish its visuals)
  rallyStrikes: number;         // in-play strikes in the current point (serve included)
  longestRally: number;
  pointNo: number;
  status: 'playing' | 'over';
  winner: PlayerId | null;
  forfeitBy: PlayerId | null;
  nextTurnId: number;
  nextPromptBase: number;
  seenKinds?: [PromptKind[], PromptKind[]]; // per player: prompt kinds shown in its own turns (training freezes)
  rng: RngState | null;         // null in PublicState
  picker: PickerState | null;   // null in PublicState
}

/** MatchState as seen by a viewer (secrets removed by core/redact). */
export type PublicState = MatchState;

/** Umpire call or banner shown when a serve, shot or point is decided. */
export type CallKind = 'fault' | 'out' | 'net' | 'ace' | 'winner' | 'doubleFault' | 'timeViolation' | 'ballDropped';

/** Events emitted by the engine, stamped with the turn and τ they happened at. */
export type GameEvent = { turn: number; τ: number } & (
  | { type: 'turnStart'; owner: PlayerId; kind: 'serve' | 'return' }
  | { type: 'turnEnd'; endτ: number }
  | { type: 'coinToss'; winner: PlayerId }
  | { type: 'preServe'; server: PlayerId; serveNo: 1 | 2; side: Side }
  | { type: 'toss'; player: PlayerId }
  | { type: 'catch'; player: PlayerId }
  | { type: 'promptShown'; player: PlayerId; prompt: number; kind: PromptKind }
  | { type: 'lock'; player: PlayerId; prompt: number; option: number }
  | { type: 'keyOk'; player: PlayerId; prompt: number }
  | { type: 'keyBad'; player: PlayerId; prompt: number }
  | { type: 'wordDone'; player: PlayerId; prompt: number; wpm: number }
  | { type: 'strike'; player: PlayerId; word: string; tier: Tier; kmh: number; isServe: boolean; stretch: boolean; forehand: boolean }
  | { type: 'bounce'; at: Vec2; inCourt: boolean }
  | { type: 'netHit' }
  | { type: 'call'; call: CallKind; player: PlayerId }
  | { type: 'point'; winner: PlayerId; reason: PointReason }
  | { type: 'game'; winner: PlayerId }
  | { type: 'set'; winner: PlayerId }
  | { type: 'match'; winner: PlayerId }
  | { type: 'situation'; text: string }   // 'MATCH POINT', 'SET POINT', 'BREAK POINT', 'DEUCE', ...
);

/** A player's persistent identity (name + look), shared by UI settings and the net protocol. */
export interface Profile { name: string; look: Look }

/** Local display preferences that affect rendering only. */
export interface DisplayPrefs { largeWords: boolean; reduceEffects: boolean; showWpm: boolean }

/** Non-simulation overlay flags a session hands to the renderer. */
export interface Overlay {
  paused: boolean;
  countdown: number | null;   // 3,2,1 during resume countdown
  coach: string | null;       // training coach text
  wait: boolean;              // "WAIT" tag above own player (off-turn key)
  unstable: boolean;          // "Connection unstable…"
  hintSpace: boolean;         // SPACE keycap hint above human server
  hintFirstLetter: boolean;   // "type a first letter" hint
  focusLost: boolean;         // "Click to focus" overlay
  rttMs: number | null;       // online round-trip time, for the HUD corner
}

/** Everything the renderer needs for one frame (spec §5.2 passive playback). */
export interface ViewModel {
  pub: PublicState;                    // redacted for `viewer`
  viewer: PlayerId | 'spectator';
  turnτ: number;                       // τ at which to render the current turn
  liveTurn: TurnState | null;          // viewer-owned live turn state (e.g. guest runner), else null
  events: GameEvent[];                 // events that became visible since the previous frame
  overlay: Overlay;
}
