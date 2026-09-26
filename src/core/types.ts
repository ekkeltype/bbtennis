/** Player index; player 0 always plays from end 0 (y < 0), player 1 from end 1. */
export type PlayerId = 0 | 1;
/** The other player. */
export const other = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0);

export type Tier = 'easy' | 'medium' | 'hard';
export const TIERS: readonly Tier[] = ['easy', 'medium', 'hard'];
export type Side = 'deuce' | 'ad';
export type Surface = 'hard' | 'clay' | 'grass' | 'dojo';
export type PaceId = 'relaxed' | 'normal' | 'fast' | 'lightning';
export type FormatId = 'tiebreak' | 'short' | 'full' | 'bo3';
export type DeuceRule = 'advantage' | 'golden';
export type WordPackId = 'tennis' | 'everyday' | 'mixed';

export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

/** Engine flags used only by Training (spec §3.12). */
export interface TrainingFlags {
  serveClock: boolean;
  freezeUntilFirstKey: boolean;
  /** Fixed word triples [easy, medium, hard], cycled in order; null = normal picker. */
  fixedWords: { serve: string[][]; choice: string[][] } | null;
}

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

export type ShotOutcome = 'in' | 'out' | 'net';

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

export interface ServeWordSet {
  options: WordOption[];   // [easy, medium, hard]
  targets: Vec2[];         // world coords, same order
  variant: 'T' | 'wide';
}

export interface LeadIn {
  kind: 'intro' | 'fault' | 'point' | 'none';
  ms: number;
  /** Banner lines to show during the lead-in, e.g. ['FAULT', 'BALL DROPPED'] or ['GAME', 'ALEX']. */
  text: string[];
}

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

export type TurnData = ServeTurnData | ReturnTurnData;

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

export interface ScoreState {
  format: FormatId;
  deuceRule: DeuceRule;
  setGames: [number, number][];   // completed sets
  games: [number, number];        // current set
  points: [number, number];       // current game or tiebreak points
  inTiebreak: boolean;
  setsWon: [number, number];
  firstServerOfMatch: PlayerId;
  gameServer: PlayerId;           // server of the current game (tiebreak: first server)
  winner: PlayerId | null;
}

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

export type PointReason = 'ace' | 'winner' | 'out' | 'net' | 'doubleFault' | 'forfeit';

export interface RngState { a: number; b: number; c: number; d: number }

export interface PickerState {
  history: string[];      // last offered words, newest last
  fixedServe: number;     // training cursors
  fixedChoice: number;
}

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
  rng: RngState | null;         // null in PublicState
  picker: PickerState | null;   // null in PublicState
}

/** MatchState as seen by a viewer (secrets removed by core/redact). */
export type PublicState = MatchState;

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
