# Black Belt Tennis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the browser typing-tennis game described in the spec: full tennis match vs CPU and online (PeerJS), retro pixel art rendered in code, static build for GitHub Pages and itch.io.

**Architecture:** A pure deterministic TypeScript core (`src/core`) — words, typing, geometry, trajectories, shot resolution, scoring, a per-turn `TurnRunner`, and a match `Engine` — driven by timestamped inputs on per-turn owner clocks. Sessions (`src/game`) feed it from the keyboard, CPU planners or the network and play back non-owned turns on a playback clock. A canvas renderer (`src/render`) draws a 480×270 pixel buffer from redacted `PublicState`; audio is synthesized (`src/audio`); menus are DOM (`src/ui`); networking is PeerJS behind a `Transport` interface (`src/net`).

**Tech Stack:** TypeScript 7, Vite 8, Vitest 5, PeerJS 1.5, @fontsource (Press Start 2P, Pixelify Sans), playwright-core (driving the locally installed Chrome) for art export and E2E. No other runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-26-black-belt-tennis-design.md` (v2 + turn-based timing). Every executor reads the spec sections named in their task. Where this plan and the spec disagree, the spec wins, except for names/signatures, where this plan wins.

## Global Constraints

- `src/core/**` never imports from DOM/game/render/audio/net/ui, never uses `Math.random`, `Date`, `performance`, timers, or transcendental math whose result affects state (`Math.sqrt`, `Math.abs`, `Math.min/max/floor/round` are fine).
- State objects are plain JSON-safe data: finite numbers, strings, booleans, null, arrays, plain objects. No `Infinity`, `NaN`, `undefined` values, `Map`, `Set`, `Date`, class instances. Absent optional properties are allowed.
- All times inside the core are **milliseconds** (floats allowed) on a turn clock `τ` (spec §3.1). The only exceptions are cps and speeds, which are per second.
- Words: lowercase `a–z` only; tiers by length easy 3–5, medium 6–9, hard 10–14 (spec §3.10).
- Internal render resolution 480×270; integer device-pixel scaling (spec §4.1).
- Tier colours `#56B4E9` / `#F0E442` / `#D55E00`; red is never feedback (spec §4.2).
- Storage keys prefixed `bbtennis:v1:` (spec §5.4).
- Protocol version constant `PROTO = 1` (bump rules spec §5.3). PeerJS id prefix `bbtennis-`.
- Code alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, 5 chars.
- No runtime network access except PeerJS broker/ICE. No CDN scripts. Fonts bundled via @fontsource.
- Commands that must pass at the end of every task: `npx tsc --noEmit -p .` (no errors in the files the task owns), `npx vitest run <task test files>`.
- Style: 2-space indent, single quotes, no semicolon-free style (use semicolons), named exports, no default exports, `camelCase` functions, `PascalCase` types, file names `camelCase.ts`. Short doc comment on every exported symbol. No comments narrating obvious code.
- Executors **do not commit** and **do not edit files owned by other tasks** (the File ownership table below). If a needed change lies in another task's file, report it instead of editing (exception: `src/core/types.ts` and `src/core/tuning.ts` may gain **additive** fields only, listed in the report).

## Review Focus

1. **Stray/modified keys at any moment** (Space on a focused button, Ctrl+R/Ctrl+W, AltGr letters, key repeat, Caps Lock, non-Latin layouts) must never type into the game, never count as errors, and never break a turn → tests in Task 4 (`classifyKey`) and Task 17 (keyboard capture).
2. **Extreme typists** (15 WPM beginner, 160 WPM expert, a typist who never types) must never stall the state machine or produce NaN/negative times → engine property tests in Task 10 and sim tests in Task 12.
3. **Window resize / zoom / moving to another monitor mid-match** must keep integer scaling crisp and the game running → `computeScale` tests in Task 13.
4. **Tab hidden or window blurred mid-turn** (vs CPU pauses cleanly and resumes with a countdown; online keeps the clock and connection alive) → tests in Task 17 (LocalSession pause) and Task 22 (host rAF suspended).
5. **Hostile or broken environments**: blocked localStorage, no `speechSynthesis`, suspended AudioContext, malformed peer messages, a peer name full of emoji/HTML → tests in Task 19 (storage), Task 16 (audio/speech guards), Task 20 (protocol guards and name clamping).

## File ownership

| Task | Owns (creates) |
|---|---|
| 1 | `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `.gitignore`, `src/main.ts` (stub), `src/core/types.ts`, `src/core/tuning.ts`, `src/core/util.ts`, `tests/core/util.test.ts` |
| 2 | `src/core/rng.ts`, `tests/core/rng.test.ts` |
| 3 | `src/core/words/lists.ts`, `src/core/words/picker.ts`, `tests/core/words.test.ts` |
| 4 | `src/core/typing.ts`, `tests/core/typing.test.ts` |
| 5 | `src/core/court.ts`, `src/core/trajectory.ts`, `tests/core/court.test.ts`, `tests/core/trajectory.test.ts` |
| 6 | `src/core/shot.ts`, `tests/core/shot.test.ts` |
| 7 | `src/core/scoring.ts`, `tests/core/scoring.test.ts` |
| 8 | `src/core/turn.ts`, `src/core/turnView.ts`, `tests/core/turn.test.ts`, `tests/core/turnView.test.ts` |
| 9 | `src/core/cpu.ts`, `tests/core/cpu.test.ts` |
| 10 | `src/core/engine.ts`, `src/core/redact.ts`, `tests/core/engine.test.ts`, `tests/core/redact.test.ts` |
| 11 | `src/core/sim.ts`, `tests/sim/balance.test.ts`, tuning adjustments in `src/core/tuning.ts` |
| 12 | `src/render/palette.ts`, `src/render/font.ts`, `src/render/color.ts`, `tests/render/palette.test.ts`, `tests/render/font.test.ts` |
| 13 | `src/render/screen.ts`, `src/render/projection.ts`, `src/render/court.ts`, `src/render/scene.ts`, `tests/render/screen.test.ts`, `tests/render/projection.test.ts` |
| 14 | `src/render/sprites/*.ts`, `tests/render/sprites.test.ts` |
| 15 | `src/render/plates.ts`, `src/render/layout.ts`, `tests/render/layout.test.ts` |
| 16 | `src/audio/*.ts`, `tests/audio/*.test.ts` |
| 17 | `src/game/*.ts`, `tests/game/*.test.ts` |
| 18 | `src/render/world.ts`, `src/render/ball.ts`, `src/render/players.ts`, `src/render/hud.ts`, `src/render/effects.ts`, `src/render/renderer.ts`, `tests/render/players.test.ts` |
| 19 | `src/ui/**`, `src/app.ts`, `src/main.ts` (replace stub), `src/styles.css`, `tests/ui/*.test.ts` |
| 20 | `src/net/*.ts`, `tests/net/protocol.test.ts`, `tests/net/codes.test.ts` |
| 21 | `src/game/hostSession.ts`, `src/game/guestSession.ts`, `src/ui/screens/lobby.ts`, `src/ui/screens/join.ts` |
| 22 | `tests/net/sessions.test.ts` |
| 23 | `tools/art.html`, `tools/art.ts`, `scripts/artExport.mjs`, `scripts/e2e.mjs`, `tests/e2e/*` |
| 24 | `README.md`, `.github/workflows/deploy.yml`, `scripts/packageItch.mjs`, `public/licenses/*` |

## Execution waves

- **Wave 1:** Task 1 (contracts + scaffold; done by the controller).
- **Wave 2 (parallel):** Tasks 2, 3, 4, 5, 6, 7, 12, 16, 20.
- **Wave 3 (parallel):** Tasks 8, 9, 13, 14, 15.
- **Wave 4 (parallel):** Tasks 10, 18, 23 (art tool part).
- **Wave 5 (parallel):** Tasks 11, 17, 19.
- **Wave 6 (parallel):** Tasks 21, 22, 23 (E2E part), 24.
- **Wave 7:** visual QA loop, whole-branch review, fixes.

---

### Task 1: Scaffold and shared contracts

**Files:** as in the ownership table.

**Interfaces:**
- Produces: every type in `src/core/types.ts`, constants in `src/core/tuning.ts`, helpers in `src/core/util.ts`. All later tasks import from these.

- [ ] **Step 1: Initialise the project**

```bash
npm init -y
npm install peerjs@^1.5.5 @fontsource/press-start-2p@^5.3.0 @fontsource/pixelify-sans@^5.3.0
npm install -D vite@^8.3.1 typescript@^7.0.2 vitest@^5.0.2 @types/node playwright-core@^1.63.0
```

`package.json` scripts:

```json
{
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit -p . && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p .",
    "art:export": "node scripts/artExport.mjs",
    "e2e": "node scripts/e2e.mjs",
    "package:itch": "node scripts/packageItch.mjs"
  }
}
```

`tsconfig.json`: `target ES2022`, `module ESNext`, `moduleResolution Bundler`, `strict true`, `noUncheckedIndexedAccess true`, `noImplicitOverride true`, `lib ["ES2022","DOM","DOM.Iterable","WebWorker"]`, `types ["vite/client"]`, `include ["src","tests","tools"]`, `noEmit true`, `allowImportingTsExtensions false`, `isolatedModules true`, `verbatimModuleSyntax true`.

`vite.config.ts`: `base: './'`, `build.rollupOptions.input = { main: 'index.html' }` (the art tool is served by `vite` in dev at `/tools/art.html`, not built), `build.target 'es2022'`, `server.port 5173`.

`vitest.config.ts`: `test.include ['tests/**/*.test.ts']`, `environment 'node'` (DOM-dependent tests opt in with `// @vitest-environment jsdom` — add `jsdom` as a devDependency).

`index.html`: `<div id="app"><canvas id="game"></canvas><div id="ui"></div></div>` + `<script type="module" src="/src/main.ts">`, `lang="en"`, `<title>Black Belt Tennis</title>`, viewport meta, dark background `#0b0b12`.

`.gitignore`: `node_modules`, `dist`, `artifacts`, `*.zip`, `.vite`, `test-results`.

- [ ] **Step 2: Write `src/core/types.ts`** exactly as below (the shared contract).

```ts
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
```

Note: `bounce` and `netHit` events are emitted by the turn when τ passes `incoming.tBounce` / `incoming.netT` (presentation only).

- [ ] **Step 3: Write `src/core/tuning.ts`**

```ts
import type { PaceId, Tier } from './types';

/** Pace multipliers (spec §3.9). */
export const PACE_MULT: Record<PaceId, number> = { relaxed: 1.5, normal: 1.0, fast: 0.75, lightning: 0.6 };

/**
 * All gameplay constants (spec §3). Balance targets (spec §6), for equal players at each pace's
 * reference WPM (Relaxed 30, Normal 50, Fast 70, Lightning 90): median rally 3–6 shots, p90 ≤ 12,
 * max 40; aces 5–15 %; double faults 1–6 %; server wins 55–65 %; ≤ 35 s per point.
 */
export const TUNING = {
  serveClockMs: 30000,
  tossApexMs: 2000,
  catchMs: 500,
  contactFactorMin: 0.85,
  flight: {
    baseMs: 2200,
    perCharMs: 100,
    place: { easy: 1.0, medium: 0.85, hard: 0.7 } as Record<Tier, number>,
    pressure: 0.85,
    serveReturnBonusMs: 500,
    serveReturnBonusPaceMs: 500,
  },
  graceMs: 400,
  speed: { base: 0.85, perCps: 0.05, cpsRef: 3, min: 0.8, max: 1.3, stretchMult: 0.9, minSpanS: 0.05 },
  kmh: { base: 95, tierBonus: { easy: 1.0, medium: 1.05, hard: 1.1 } as Record<Tier, number>, serveMult: 1.25 },
  accuracy: {
    sigma0: { easy: 0.10, medium: 0.12, hard: 0.10 } as Record<Tier, number>,
    sigmaE: { easy: 0.25, medium: 0.35, hard: 0.5 } as Record<Tier, number>,
    stretchSigma: 0.5,
    netRate: { easy: 0.01, medium: 0.03, hard: 0.06 } as Record<Tier, number>,
    stretchNet: 0.05,
    pNetMax: 0.9,
    maxSlips: 3,
  },
  trajectory: {
    bounceFrac: 0.6,
    arcH: { easy: 2.0, medium: 1.7, hard: 1.4 } as Record<Tier, number>,
    serveArcH: 0.9,
    netClearZ: 1.3,
    postBounceDist: 3.0,
    contactZ: 1.0,
    rallyZ0: 1.0,
    maxBehindBaseline: 1.2,
    maxAbsX: 5.8,
    netHitZ: 0.6,
    netDropMs: 400,
    stretchEndZ: 0.3,
  },
  toss: { baseZ: 1.8, riseZ: 1.4 },
  leadIn: { introMs: 2500, faultMs: 1500, pointMs: 2000, gameExtraMs: 1500, setExtraMs: 1000, matchOverMs: 3000 },
  words: { historySize: 20 },
  movement: { chaseMaxSpeed: 7, jogSpeed: 4, stanceOffset: 0.7 },
  positions: { serverX: 0.8, serverY: 12.3, receiverX: 3.0, receiverY: 12.5, restY: 12.2 },
} as const;

/** CPU milestone rows (spec §3.8); stripes interpolate linearly in WPM between rows. */
export const CPU_MILESTONES = [
  { belt: 'white', wpm: 25, err: 0.07, reactionMs: 900, aggression: 0.2 },
  { belt: 'yellow', wpm: 35, err: 0.055, reactionMs: 800, aggression: 0.35 },
  { belt: 'green', wpm: 45, err: 0.045, reactionMs: 700, aggression: 0.5 },
  { belt: 'brown', wpm: 65, err: 0.03, reactionMs: 550, aggression: 0.65 },
  { belt: 'black', wpm: 90, err: 0.02, reactionMs: 450, aggression: 0.8 },
  { belt: 'black2', wpm: 105, err: 0.016, reactionMs: 400, aggression: 0.85 },
  { belt: 'black3', wpm: 120, err: 0.013, reactionMs: 350, aggression: 0.9 },
] as const;

/** The 15 CPU levels' WPM (index = level). */
export const CPU_LEVEL_WPM = [25, 28, 31, 35, 38, 41, 45, 51, 58, 65, 72, 81, 90, 105, 120] as const;
```

- [ ] **Step 4: Write `src/core/util.ts`** with `clamp(v, lo, hi)`, `lerp(a, b, t)`, `easeOutQuad(t)`, `dist2(a, b)`, `len2(v)`, `sub2`, `add2`, `scale2`, `norm2` (returns {0,0} for zero vectors), `deepFreeze` is NOT needed. Test `tests/core/util.test.ts`: clamp bounds, lerp endpoints, easeOutQuad(0)=0, (1)=1, (0.5)=0.75, norm2 of zero vector.

- [ ] **Step 5: Stub `src/main.ts`** (`console.info('Black Belt Tennis')`) and verify:

Run: `npx tsc --noEmit -p . && npx vitest run && npx vite build`
Expected: all pass; `dist/index.html` exists and references `./assets/...` (relative).

- [ ] **Step 6: Commit** `chore: scaffold project and shared core contracts`.

---

### Task 2: Seeded RNG (`src/core/rng.ts`)

Spec: §3.5 (Irwin–Hall), §5.1 (determinism).

**Interfaces:**
- Consumes: `RngState` (types).
- Produces:
```ts
export function seedRng(seed: number): RngState;            // sfc32 seeded via splitmix32 of seed
export function nextU32(s: RngState): number;               // mutates s
export function uniform(s: RngState): number;               // [0,1), = nextU32/2^32
export function intBelow(s: RngState, n: number): number;   // 0..n-1 (n ≥ 1)
export function chance(s: RngState, p: number): boolean;
export function normalIH(s: RngState): number;              // (u1+u2+u3+u4−2)·√3
export function normalFromUniforms(u: readonly number[]): number; // same formula on 4 given uniforms
export function pickIndex<T>(s: RngState, arr: readonly T[]): number;
export function shuffleInPlace<T>(s: RngState, arr: T[]): T[];
export function forkSeed(seed: number, stream: number): number; // independent stream seed (e.g. CPU)
export function drawShotRandoms(s: RngState): ShotRandoms;  // 9 uniforms
```

- [ ] **Step 1: Failing tests** `tests/core/rng.test.ts`:
  - Same seed ⇒ identical first 1,000 `nextU32` values; different seeds differ in the first 10.
  - `uniform` ∈ [0,1) over 100,000 draws; mean within 0.5 ± 0.005.
  - `intBelow(s, 7)` hits all 0..6 over 10,000 draws; never 7.
  - `normalIH`: |z| ≤ 3.4642 always; sample variance of 100,000 draws within 1 ± 0.02.
  - `normalFromUniforms([0,0,0,0]) === -2*Math.sqrt(3)`, `([1,1,1,1]) === 2*Math.sqrt(3)` (boundary formula check).
  - JSON round trip: `seedRng(5)` survives `JSON.parse(JSON.stringify())` and continues the same sequence.
  - `forkSeed(1, 1) !== forkSeed(1, 2)`, both deterministic.
- [ ] **Step 2:** run, see failures. **Step 3:** implement (use `Math.imul`, `>>> 0`; state fields are uint32 numbers). **Step 4:** tests pass.

---

### Task 3: Word lists and picker (`src/core/words/*`)

Spec: §3.10, §1.2 (initials rule).

**Interfaces:**
- Consumes: `rng.ts`, `WordOption`, `Tier`, `WordPackId`, `PickerState`, `TUNING.words`.
- Produces:
```ts
// lists.ts
export const PACKS: Record<'tennis' | 'everyday', Record<Tier, readonly string[]>>;
export function packWords(pack: WordPackId, tier: Tier): readonly string[]; // mixed = union, deduped
export function tierOfLength(len: number): Tier | null;
// picker.ts
export const QWERTY_ADJ: Record<string, string>; // letter -> adjacent letters (edges + diagonals)
export function initialsOk(words: readonly string[]): boolean; // distinct + pairwise non-adjacent
export function createPicker(): PickerState;
/** One word per tier satisfying all rules; records all three in history. `avoid` = words that must not appear (previous toss). */
export function pickTriple(rng: RngState, picker: PickerState, pack: WordPackId, avoid?: readonly string[]): WordOption[];
/** Training: next fixed triple (cycled). */
export function pickFixed(picker: PickerState, list: string[][], which: 'serve' | 'choice'): WordOption[];
export function toOption(word: string): WordOption; // computes len + tier; throws if invalid
```

Word list requirements: `tennis` pack = tennis + martial-arts/dojo vocabulary, real words or established compounds only (e.g. easy: ball, net, ace, lob, set, love, game, spin, dojo, kata, bow, belt, kick; medium: backhand, forehand, baseline, volley, topspin, sensei, tiebreak, racquet, dropshot, umpire, overhead, sweetspot, blackbelt; hard: counterpuncher, championship, breakpoint, doublefault, passingshot, groundstroke, tournament, grandmaster, serveandvolley). `everyday` pack = common English words. Every pack: ≥ 120 easy, ≥ 120 medium, ≥ 80 hard; lowercase a–z only; no duplicates within a tier; all lengths match the tier; no offensive words; each tier has ≥ 12 distinct initials (so the initials rule is satisfiable).

- [ ] **Step 1: Failing tests** `tests/core/words.test.ts`:
  - For each pack and tier: size minimums, regex `/^[a-z]+$/`, length bounds, no duplicates, ≥ 12 distinct initials.
  - `QWERTY_ADJ` is symmetric (`b ∈ adj[a] ⇔ a ∈ adj[b]`); `adj.s` contains a,w,e,d,x,z; `adj.q` contains w,a.
  - `initialsOk(['sun','dart','xylophones'])` false (s/d adjacent); `initialsOk(['ball','net','counterpunch'])`... use valid examples: `['ball','network','xenophobic']` → b/n adjacent → false; `['ball','topspin','quarterfinal']` true.
  - `pickTriple`: over 2,000 picks from a fixed seed: tiers are [easy, medium, hard]; initials always OK; no word repeats any of the previous 20 offered words; history length capped at 20; `avoid` words never returned.
  - Determinism: same seed + same picker ⇒ same sequence.
  - `pickFixed` cycles its list; `toOption('ball')` → `{word:'ball', len:4, tier:'easy'}`; `toOption('Ball')` throws.
- [ ] Implement: `pickTriple` rejection-samples (max 200 attempts per tier combination, then relaxes only the history rule for that pick — never the initials rule).

---

### Task 4: Typing (`src/core/typing.ts`)

Spec: §1.1 (strict cursor), §1.2, §2 (slip), §3.4 (cps), §4.5 (key classification).

**Interfaces:**
- Consumes: `PromptState`, `WordOption`, `PromptKind`, `TUNING.speed`.
- Produces:
```ts
export interface RawKey { key: string; code: string; repeat: boolean; isComposing: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }
export type KeyClass = { kind: 'letter'; letter: string; viaCode: boolean } | { kind: 'toss' } | { kind: 'ignore' };
export function classifyKey(e: RawKey): KeyClass;
export function createPrompt(id: number, kind: PromptKind, options: WordOption[], shownAt: number): PromptState;
export type KeyResult = 'ignored' | 'locked' | 'correct' | 'wrong' | 'completed';
/** Applies one letter at τ (mutates p). Lock on first matching initial; strict cursor after. */
export function applyLetter(p: PromptState, letter: string, τ: number): KeyResult;
export function isComplete(p: PromptState): boolean;
export function lockedWord(p: PromptState): WordOption | null;
/** cps = (n−1)/max(minSpanS, (tLast−tFirst)/1000) for a completed prompt. */
export function wordCps(p: PromptState): number;
export function wpmOf(cps: number): number; // cps × 12
/** Progress 0..1 of the locked word (0 if unlocked). */
export function progress(p: PromptState): number;
```
Rules: letters are compared lowercase. Unlocked choice/serve prompt: a letter equal to an option's initial locks it (`locked`, `typed=1`, `tFirst=tLast=τ`, result `'locked'` — or `'completed'` if impossible since len ≥ 3); a letter matching no initial → `'ignored'` (no counters change). Locked: expected letter → `'correct'` (`typed++`, `correctKeys++`, `tLast=τ`, `inSlip=false`) or `'completed'` when `typed === len` (`completedAt=τ`); wrong letter → `'wrong'` (`wrongKeys++`, `lastWrongAt=τ`, and if `!inSlip` then `slips++`, `inSlip=true`). Chase prompts are created with `locked=0`, `typed=0`, `tFirst=null` (the first correct key sets `tFirst`). Keys after completion → `'ignored'`.

`classifyKey`: ignore when `repeat`, `isComposing`, key ∈ {Process, Dead, Unidentified}, `ctrlKey || metaKey || altKey`; `key === ' '` → toss; single-char `key` matching `/^[a-z]$/i` → letter lowercased; single-char `/\p{L}/u` letter not a–z with `code` matching `/^Key([A-Z])$/` → letter from code, `viaCode: true`; everything else ignore.

- [ ] **Step 1: Failing tests** `tests/core/typing.test.ts` including:
```ts
it('locks by initial and types strictly', () => {
  const p = createPrompt(1, 'choice', [opt('ball'), opt('topspin'), opt('quarterfinal')], 0);
  expect(applyLetter(p, 'z', 10)).toBe('ignored');
  expect(p.wrongKeys).toBe(0);
  expect(applyLetter(p, 't', 100)).toBe('locked');
  expect(p.locked).toBe(1);
  expect(applyLetter(p, 'x', 150)).toBe('wrong');
  expect(applyLetter(p, 'y', 160)).toBe('wrong');
  expect(p.slips).toBe(1); expect(p.wrongKeys).toBe(2);
  expect(applyLetter(p, 'o', 300)).toBe('correct');
  expect(applyLetter(p, 'q', 310)).toBe('wrong');
  expect(p.slips).toBe(2);
  for (const [i, ch] of [...'pspin'].entries()) applyLetter(p, ch, 400 + i * 100);
  expect(isComplete(p)).toBe(true); expect(p.completedAt).toBe(800);
  expect(wordCps(p)).toBeCloseTo(6 / 0.7, 5);
});
```
  plus: chase prompt first key sets `tFirst`; uppercase letters accepted; `wordCps` uses `minSpanS` floor (all keys at the same τ ⇒ (n−1)/0.05); keys after completion ignored; `classifyKey` table test covering repeat, IME, Dead, Ctrl+R, Alt+x, AltGr (`ctrlKey && altKey`), Space, 'A', 'é' with code KeyE → letter 'e' viaCode, Cyrillic 'ф' with code KeyA → 'a', '1' → ignore, Enter → ignore, Tab → ignore.

---

### Task 5: Court geometry and trajectories (`src/core/court.ts`, `src/core/trajectory.ts`)

Spec: §3.0, §3.2.6, §3.3.3, §3.4 (ball path, positioning).

**Interfaces:**
- Consumes: types, `TUNING`, util.
- Produces:
```ts
// court.ts
export const COURT: { singlesHalfWidth: 4.115; doublesHalfWidth: 5.485; halfLength: 11.885; serviceLine: 6.4; netCenterH: 0.914; netPostH: 1.07; postX: 6.4 };
export function endSign(end: PlayerId): 1 | -1;          // end 0 → +1, end 1 → −1
export function serverSpot(server: PlayerId, side: Side): Vec2;
export function receiverSpot(receiver: PlayerId, side: Side): Vec2;
export function restSpot(player: PlayerId): Vec2;
export function serveTargets(receiver: PlayerId, side: Side, variant: 'T' | 'wide'): Vec2[]; // [easy, medium, hard]
export function rallyTargets(dest: PlayerId, m: 1 | -1): Vec2[];                             // [easy, medium, hard]
export function inSinglesHalf(p: Vec2, dest: PlayerId): boolean;   // lines in
export function inServiceBox(p: Vec2, receiver: PlayerId, side: Side): boolean; // lines in
export function netHeightAt(x: number): number;                    // linear centre→post
// trajectory.ts
export function buildFlight(a: { isServe: boolean; tier: Tier; p0: Vec3; landing: Vec2; outcome: ShotOutcome; T: number; grace: number; destEnd: PlayerId }): BallFlight;
export function ballAt(f: BallFlight, t: number): Vec3;             // t = ms since strike; valid for 0..T+grace (+ net drop)
export function tossZ(tSinceToss: number, apexMs: number): number;  // spec §3.2.3
export function stanceFor(contact: Vec2, player: PlayerId, from: Vec2): { feet: Vec2; forehand: boolean };
export function chaseFeet(from: Vec2, stance: Vec2, progress: number): Vec2; // lerp with easeOutQuad
```
`buildFlight` computes: `tBounce = bounceFrac·T`; `h` = tier arc (or serveArcH), raised until the pre-bounce arc is ≥ `netClearZ` at the net plane (only for outcome ≠ 'net'); contact point C = landing + unit(landing − p0 horizontal)·postBounceDist, clamped to `|y| ≤ halfLength + maxBehindBaseline` and `|x| ≤ maxAbsX`; for `'net'`: `netT` = time the horizontal path crosses y = 0 (fraction of pre-bounce time × distance ratio), `callT = netT`; for `'out'`: `callT = tBounce`; `'in'`: `callT = null`, `netT` = crossing time (for the net-plane sound) or null. `ballAt` for `'net'` after `netT`: drops from `netHitZ` to 0 over `netDropMs` moving 0.3 m back toward the striker; post-bounce `z(u) = u·contactZ + 2.4u(1−u)` — (spec formula `u + 2.4u(1−u)` with contactZ 1.0); beyond T (stretch window): continue horizontal velocity, z linear from contactZ to stretchEndZ at T+grace.

- [ ] **Step 1: Failing tests** `tests/core/court.test.ts`, `tests/core/trajectory.test.ts`:
  - Positions: `serverSpot(0,'deuce')` = (0.8, −12.3); `serverSpot(1,'deuce')` = (−0.8, 12.3); `receiverSpot(1,'deuce')` = (−3.0, 12.5); all spots within 1.2 m of their baseline.
  - Serve targets are inside the correct diagonal box (server 0 deuce → receiver 1's deuce box: x ∈ [−4.115, 0], y ∈ [0, 6.4]); hard target margin to the nearest box line = 0.40 m (T and wide); medium on the opposite half from hard.
  - Rally targets inside `inSinglesHalf`; hard margin 0.5 m to sideline and baseline; medium opposite side to hard; `m` flips x.
  - `inSinglesHalf` lines in: point exactly on the sideline/baseline = in; 1 mm outside = out; wrong half = out.
  - Flight continuity: `ballAt(f, 0)` = p0; at `tBounce` z = 0 and xy = landing; at T xy = contact and z = contactZ; no NaN for T in [500, 20000].
  - Net clearance: for every tier and random p0/landing pairs across the court (200 samples), `outcome !== 'net'` ⇒ z at the net plane ≥ 1.3.
  - Contact clamp: a landing 0.2 m inside the baseline gives contact ≤ 1.2 m behind it.
  - NET flight: `callT = netT` < `tBounce`; `ballAt(f, netT)` has y ≈ 0 and z ≈ 0.6; after `netT + netDropMs`, z = 0 and the ball is on the striker's side.
  - `tossZ(0,a)=1.8`, `tossZ(a,a)=3.2`, `tossZ(2a,a)=1.8`.
  - `stanceFor`: contact on the player's right ⇒ forehand, feet = C − 0.7·right; player 1's right is −x.

---

### Task 6: Timing and shot resolution (`src/core/shot.ts`)

Spec: §3.2.4 (contact factor), §3.4, §3.5.

**Interfaces:**
- Consumes: types, `TUNING`, `PACE_MULT`, `rng.normalFromUniforms`, court (`inSinglesHalf`, `inServiceBox` passed as predicate by callers).
- Produces:
```ts
export function speedFactor(cps: number): number;                          // clamp(0.85+0.05(cps−3), 0.8, 1.3)
export function contactFactor(tSinceToss: number, apexMs: number): number; // 1 → 0.85 linearly from a to 2a
export function strikeV(cps: number, opts: { contactFactor?: number; stretch?: boolean }): number;
export function flightTimeMs(a: { pace: number; chaseLen: number; v: number; tier: Tier; isServe: boolean; n: number }): number;
export function graceMs(pace: number): number;
export function displayKmh(v: number, tier: Tier, n: number, isServe: boolean): number;
export function effectiveSlips(slips: number): number;                     // min(slips, maxSlips)
export function resolveShot(a: { tier: Tier; slips: number; stretch: boolean; target: Vec2; randoms: ShotRandoms; isIn: (p: Vec2) => boolean }): ShotResult;
```
`flightTimeMs = pace·(baseMs + perCharMs·chaseLen)/v · place[tier](1 for serves) · pressure^⌊n/2⌋ + (isServe ? serveReturnBonusMs + serveReturnBonusPaceMs·pace : 0)`.

- [ ] **Step 1: Failing tests** `tests/core/shot.test.ts`:
  - `speedFactor(3)=0.85`, `(0)=0.8`, `(20)=1.3`, `(5)=0.95`.
  - `contactFactor(a/2,a)=1`, `(a,a)=1`, `(1.5a,a)=0.925`, `(2a,a)=0.85`.
  - `flightTimeMs({pace:1,chaseLen:8,v:1,tier:'medium',isServe:false,n:3})` = (2200+800)·0.85·0.85 = 2167.5.
  - Serve: `flightTimeMs({pace:1.5,chaseLen:4,v:1,tier:'hard',isServe:true,n:0})` = 1.5·2600 + 500 + 750 = 5150.
  - Harder placement never leaves more time: for chaseLen fixed, T(hard) < T(medium) < T(easy).
  - **e = 0 guarantee:** for every tier, 100,000 random `randoms` (seeded), serve targets and rally targets from Task 5, `slips=0, stretch=false` ⇒ zero outs and zero nets.
  - Hard rally shot with 1 slip: failure rate (out+net) in [0.35, 0.55] over 20,000 samples; medium with 1 slip ≤ 0.05.
  - `pNet` capped at 0.9; slips capped at 3 (5 slips ≡ 3 slips result).
  - Lines in: a landing exactly on the line is `'in'` (use a predicate test with `isIn`).

---

### Task 7: Scoring (`src/core/scoring.ts`)

Spec: §3.6.

**Interfaces:**
- Consumes: `ScoreState`, `FormatId`, `DeuceRule`, `PlayerId`, `Side`.
- Produces:
```ts
export function createScore(format: FormatId, deuceRule: DeuceRule, firstServer: PlayerId): ScoreState;
export interface AwardResult { game: PlayerId | null; set: PlayerId | null; match: PlayerId | null }
export function awardPoint(s: ScoreState, winner: PlayerId): AwardResult; // mutates
export function currentServer(s: ScoreState): PlayerId;
export function serveSide(s: ScoreState): Side;
export function pointsDisplay(s: ScoreState): [string, string];    // ['15','40'], ['AD',''], tiebreak digits
export function situation(s: ScoreState): string | null;           // 'MATCH POINT' | 'SET POINT' | 'BREAK POINT' | 'DEUCE' | null
export function umpireCall(s: ScoreState, names: [string, string], lastWinner: PlayerId): string; // words, not digits
export function gamesToWinSet(format: FormatId): number;           // 4 short/bo3, 6 full, 0 tiebreak-only
```
Rules (all from spec §3.6): tiebreak format = one tiebreak to 7 by 2 (coin-toss winner serves first); short = to 4 by 2, TB at 4–4; full = to 6 by 2, TB at 6–6; bo3 = best of three short sets, ends at 2 sets. Server alternates each game; a tiebreak counts as one game for alternation; in a tiebreak the first point is served by the player due, then alternation every two points. Side: deuce when (points played in the current game / tiebreak) is even. Golden point: at 3–3 in a normal game the next point wins; never in tiebreaks. Situation priority: MATCH POINT > SET POINT > BREAK POINT (receiver one point from winning the game) > DEUCE.

- [ ] **Step 1: Failing tests** `tests/core/scoring.test.ts` covering: love game; deuce → advantage → deuce → game; golden point at 40–40; tiebreak at 4–4 in short sets with serve rotation `A, B, B, A, A, B, …` and sides; set won 4–2, 5–3 (by two), 5–4 impossible before tiebreak; full set tiebreak at 6–6; bo3 ends at 2–0 and 2–1; tiebreak-only format ends at 7–5 and 9–7; the next set's first server after a tiebreak; `pointsDisplay` strings ('0','15','30','40','AD'); `situation` for match/set/break points; `umpireCall` examples: 'Fifteen love', 'Thirty all', 'Deuce', 'Advantage Alex', 'Game, Alex'. Also a property test: random point sequences (1,000 matches per format) always terminate with a winner and never throw.

---

### Task 8: TurnRunner and turn playback view (`src/core/turn.ts`, `src/core/turnView.ts`)

Spec: §3.1–§3.5, §3.12 (freeze), §5.1 (TurnRunner), §5.2.

**Interfaces:**
- Consumes: Tasks 4, 5, 6 exports; types.
- Produces:
```ts
// turn.ts
export function createTurn(data: TurnData): TurnState;
/** Starts the owner's clock at τ=0 (idempotent). Returns events (turnStart, preServe or promptShown...). */
export function startTurn(t: TurnState): GameEvent[];
/** Owner input at τ ('toss' or a letter). Processes deadlines < τ first, then the input. Stale or non-owner inputs are the caller's job. */
export function turnInput(t: TurnState, key: string, τ: number): GameEvent[];
/** Owner confirms its clock reached τ: processes deadlines ≤ τ in order. */
export function turnClock(t: TurnState, τ: number): GameEvent[];
/** Engine appends a spare serve word set (after a catch). */
export function appendWordSet(t: TurnState, set: ServeWordSet): void;
/** The τ at which the next deadline fires (for schedulers/tests), or null. */
export function nextDeadline(t: TurnState): number | null;
/** Effective simulation time (τ minus training freeze). */
export function simTime(t: TurnState, τ: number): number;
// turnView.ts
export interface PromptView { id: number; kind: PromptKind; options: WordOption[]; locked: number | null; typed: number; lastWrongAt: number | null; completedAt: number | null; shownAt: number }
export interface TurnView {
  phase: TurnPhase; τ: number; simτ: number;
  prompts: PromptView[]; active: number | null;
  tossAt: number | null; catchAt: number | null;
  chaseProgress: number;          // 0..1 for return turns
  strike: StrikeInfo | null;      // if τ ≥ strike τ
  outcome: TurnOutcome | null;    // only if τ ≥ endτ (or strike τ for queued strikes)
}
/** Derives what a viewer sees at τ from start data + result log (works on redacted turns). */
export function turnViewAt(t: TurnState, τ: number): TurnView;
```
Serve-turn timeline (τ from turn start): `leadIn` for `leadIn.ms`; then `preServe` (serve clock deadline = leadIn.ms + serveClockMs when not null); `toss` input only in preServe (ignored otherwise; also ignored if `setIndex ≥ wordSets.length`) → `toss` phase at τ, serve prompt created from `wordSets[setIndex]` (log `toss`, `show`); letters go to the serve prompt; completion at τc ≤ tossAt+2a → outcome strike at endτ = τc; at tossAt+2a: locked & incomplete → fault `ballDropped`; nothing locked → `catch` phase (log `catch`) for `catchMs`, then `setIndex++` and `preServe` again (or, if the serve clock expired, fault `timeViolation` at the catch end); serve clock expiry in preServe/catch → fault `timeViolation` at that τ. Strike: `cps = wordCps`, `v = strikeV(cps, {contactFactor})`, target from the word set, `resolveShot` with `inServiceBox`, outgoing `flight = buildFlight({... T: flightTimeMs({pace, chaseLen: len, v, tier, isServe: true, n: 0}), grace: graceMs(pace), destEnd: receiver})`, `p0 = {x: server spot x, y: server spot y, z: tossZ}`.

Return-turn timeline: τ = 0 strike moment; chase prompt shown at 0 (id `promptBase`), `locked = 0`; completion at τc → choice prompt shown at τc (id `promptBase + 1`); choice completion at τd: τd ≤ T → outcome strike decided now with `endτ = T`, phase `queued`, p0 = contact (z = contactZ), stretch false; T < τd ≤ T + grace → strike at τd, stretch true, p0 = `ballAt(incoming, τd)`; τ reaches T + grace unfinished → miss (`ace = isServeReturn && chase incomplete`). If `incoming.outcome !== 'in'`: at `incoming.callT` → outcome call (`'out'` or `'net'`), endτ = callT; the typing so far is discarded (engine excludes it from stats). Presentation events: `bounce` when τ passes `tBounce` (inCourt = outcome === 'in'), `netHit` when τ passes `netT` for net balls. Outgoing flight for a rally strike: `T = flightTimeMs({pace, chaseLen: word.len, v, tier, isServe: false, n: data.n + 1})`, destEnd = striker. Training freeze (`freezeFirst`): when a prompt of a kind not in `seenKinds` is shown, set `freezeSince`; the first `ok/lock` key on it ends the freeze, adding to `frozenMs`; all deadlines compare against `simTime`.

- [ ] **Step 1: Failing tests** `tests/core/turn.test.ts` (scripted, no RNG: build `TurnData` fixtures by hand with fixed `randoms` = 0.5s):
  - Serve happy path: toss at 3000 (leadIn 2500), type 'ball' keys at 3400..3700 ⇒ strike endτ 3700, flight T per formula with contact factor 1.
  - Serve after apex: completion at tossAt + 1.5a ⇒ contact factor 0.925 in `v`.
  - Ball dropped: lock then stop ⇒ fault at tossAt + 2a.
  - Catch/re-toss: no key ⇒ catch at tossAt + 2a, preServe at +catchMs, second toss uses `wordSets[1]`; a third toss without a spare is ignored until `appendWordSet`.
  - Serve clock: expiry in preServe ⇒ `timeViolation` at leadIn + 30000; expiry during toss with a completed word ⇒ normal strike; with a catch ⇒ `timeViolation` at catch end.
  - Space ignored during toss; letters ignored in leadIn/preServe.
  - Return queued: chase + choice done before T ⇒ phase `queued`, `outcome.endτ === T`, `ended` only after `turnClock(T)`.
  - Stretch: completion in (T, T+grace] ⇒ stretch strike, v × 0.9, σ + 0.5 (check via `shot.sigma`).
  - Miss: nothing ⇒ miss at T + grace, `ace` true only for serve returns with incomplete chase.
  - OUT call: incoming out ⇒ call at tBounce even if the receiver completed both words earlier.
  - NET call at netT.
  - Deadline ordering: a key at τ exactly equal to a deadline counts (applied before the deadline).
  - Freeze: with `freezeFirst`, a 5 s pause before the first key shifts all deadlines by 5 s.
  - Idempotence: calling `turnClock` twice with the same τ emits nothing new.
- [ ] `tests/core/turnView.test.ts`: for a scripted turn, `turnViewAt(t, τ)` at several τ matches the live state captured at that τ during the script (typed counts, locked option, phase, chaseProgress); works after replacing all `ch` with '*' and serve words with hidden options.

---

### Task 9: CPU typist (`src/core/cpu.ts`)

Spec: §3.8.

**Interfaces:**
- Consumes: rng, typing, shot (`flightTimeMs` not needed), turn (`TurnState`), tuning (`CPU_MILESTONES`, `CPU_LEVEL_WPM`).
- Produces:
```ts
export interface CpuProfile { wpm: number; err: number; reactionMs: number; aggression: number }
export interface CpuLevelInfo { level: number; belt: 'white'|'yellow'|'green'|'brown'|'black'; stripes: 0|1|2; dan: 0|2|3; wpm: number; label: string }
export const CPU_LEVELS: CpuLevelInfo[];                  // 15 entries; labels like 'GREEN BELT ★★' / 'BLACK BELT 2ND DAN'
export function cpuProfile(level: number): CpuProfile;    // interpolated
export function isMilestone(level: number): boolean;
export interface PlannedKey { key: string; τ: number }    // key = letter or 'toss'
/** Planner for one CPU player. Deterministic given (seed, the turn states it sees). */
export class CpuBrain {
  constructor(player: PlayerId, profile: CpuProfile, seed: number);
  /** Inputs the CPU will make for the current turn state, in τ order, from its current position on. Stable across calls for the same prompt. */
  plan(t: TurnState): PlannedKey[];
}
```
`plan` behaviour: serve turn in preServe ⇒ `toss` at `max(τ_preServeStart + U(600,1200), now)`; after a toss (prompt shown) ⇒ choose a word by the feasibility/aggression rule against deadline `tossAt + 2a` (second serve: aggression × 0.4), then emit reaction + keys; return turn ⇒ chase keys after reaction (0.5× for rally chases, 1× for serve returns), then choice keys after a full reaction, deadline T. Key timing: per-word factor `f = clamp(1 + 0.15·z, 0.7, 1.4)`, each interval `I·f·(1 + 0.35(u1+u2−1))`, hard words: 10 % chance +250–500 ms per key after the first. Errors never on a prompt's first key; otherwise with probability `err` emit a random wrong letter then the right one 150–300 ms later. Plans are cached per prompt id; the plan for a prompt is fixed once made. The brain never plans past its turn's deadlines (keys scheduled after the miss deadline are simply never used).

- [ ] **Step 1: Failing tests** `tests/core/cpu.test.ts`:
  - `CPU_LEVELS.length === 15`; WPMs match `CPU_LEVEL_WPM`; milestones at levels 0, 3, 6, 9, 12, 13, 14.
  - `cpuProfile(1)` interpolates between white and yellow (wpm 28 → err between 0.07 and 0.055).
  - Measured average WPM of planned words (1,000 words) within ±10 % of the profile WPM (includes error delays).
  - First key of every prompt is correct; overall wrong-key rate within ±25 % relative of `err`.
  - Determinism: same seed + same turn ⇒ same plan; `plan` called twice ⇒ identical.
  - Feasibility: with a tiny deadline the brain picks easy; with a huge deadline and aggression 1.0 picks hard.
  - Second serve: over 2,000 serves, P(hard) on serve 2 < P(hard) on serve 1.

---

### Task 10: Engine and redaction (`src/core/engine.ts`, `src/core/redact.ts`)

Spec: §3.1, §3.2, §3.6, §3.7, §3.11, §3.12, §5.1, §5.3 (secrecy).

**Interfaces:**
- Consumes: everything in core.
- Produces:
```ts
export interface EngineOptions { config: MatchConfig; players: [PlayerInfo, PlayerInfo]; seed: number }
export class Engine {
  constructor(opts: EngineOptions);
  readonly state: MatchState;
  /** Owner of the current turn, or null when the match is over. */
  owner(): PlayerId | null;
  /** Starts the current turn's clock (owner's τ = 0). */
  start(player: PlayerId): GameEvent[];
  input(player: PlayerId, key: string, τ: number): GameEvent[];
  clock(player: PlayerId, τ: number): GameEvent[];
  forfeit(player: PlayerId): GameEvent[];
  /** Restores an engine from a full (unredacted) state, e.g. for tests. */
  static fromState(state: MatchState): Engine;
}
export function emptyStats(): PlayerStats;
export function averageWpm(s: PlayerStats): number;
export function accuracy(s: PlayerStats): number;
// redact.ts
export function redact(state: MatchState, viewer: PlayerId | 'spectator'): PublicState;
export function redactEvents(events: GameEvent[], state: MatchState, viewer: PlayerId | 'spectator'): GameEvent[];
export function redactTurn(t: TurnState, viewer: PlayerId | 'spectator'): TurnState;
```
Engine rules: constructor seeds the RNG, draws the coin toss (first draw < 0.5 ⇒ player 0 serves), creates score, and creates the first serve turn with `leadIn {kind:'intro', ms: introMs, text: ['<NAME> TO SERVE']}` and a `coinToss` event queued for the first `start`. Inputs/clocks from a non-owner or for an unstarted turn are ignored (return []). When `turn.ended`, the engine finalises: updates stats (typing stats of completed words — excluding a return turn's typing discarded by an OUT/NET call — lock/correct/wrong keys, aces, double faults, winners, errors, fastest serve, longest rally), scores the point when the point is over (`awardPoint`), emits `call`, `point`, `game`, `set`, `match`, `situation` events, sets `lastTurn`, and creates the next turn with the right lead-in: after a serve strike → return turn (owner = receiver, `n = 0`, `isServeReturn`), after a return strike → return turn for the other player (`n + 1`), after fault 1 → serve turn serveNo 2 with lead-in fault (text ['FAULT', reason]), after double fault/miss/call → next point's serve turn with lead-in point (ms = pointMs + gameExtra/setExtra as applicable; text e.g. ['ACE!'] / ['OUT'] / ['GAME', NAME]). Word sets: serve turns get `wordSets = [current, spare]`; on a `catch` event the engine appends a new spare (never repeating the previous set's words). Choice words and targets for a return turn are picked when the turn is created (m random). Each turn gets fresh `randoms` from the match RNG. Training flags: `serveClockMs = null` when `serveClock:false`; `freezeFirst` = flag; `fixedWords` via `pickFixed`. `forfeit` ends the match (winner = other, `forfeitBy`). The match status becomes 'over' after the final point; no next turn.

Redaction: `rng` and `picker` → null. For every serve turn (current and last) not owned by the viewer (and viewer ≠ 'spectator'): each option of every word set and every serve prompt → `{word:'', len, tier, hidden:true}`, targets → `[]` (markers are owner-only), log `ch` → '*'; the owner's `randoms` → zeros for turns not owned by the viewer. Exception: once a serve turn has a `strike` outcome, the struck word (only) is revealed in its prompt. `redactEvents` strips nothing else (events carry no letters except `strike.word`, which is public).

- [ ] **Step 1: Failing tests** `tests/core/engine.test.ts` using a helper that drives the engine with scripted typists (`CpuBrain` with fixed seeds) on virtual time:
  - A full short-set CPU-vs-CPU match terminates for 50 seeds; `status === 'over'`; winner has won the set; no exception; every event τ is finite.
  - Determinism: same seed + same scripted inputs ⇒ `JSON.stringify(state)` identical.
  - JSON round trip of `state` and of `redact(state, 0)` at 200 sampled moments ⇒ deepEqual.
  - Fault flow: fault 1 → serve turn serveNo 2 with FAULT lead-in; fault 2 → point to receiver with reason doubleFault, stats.doubleFaults++.
  - Ace: receiver never types ⇒ point reason ace; stats.aces++.
  - Rally OUT: forced by fixed randoms + slips ⇒ point to the receiver, striker errors++; the receiver's discarded typing is not in wordsCompleted.
  - Off-turn/unstarted inputs are ignored and produce no events.
  - Training: `serveClock:false` ⇒ no timeViolation after 60 s idle; fixedWords used in order.
  - Extreme typists (Review Focus 2): a typist that never types ⇒ the match still terminates (all points ace/faults); a 160 WPM scripted typist ⇒ no NaN, all T > 0.
  - Catch appends a spare set; re-toss words never repeat the previous toss.
- [ ] `tests/core/redact.test.ts`: across 1,000 simulated serves by player 0, `JSON.stringify(redact(state, 1))` sampled every 50 ms of the serve turn never contains any not-yet-struck serve word of player 0; after the strike it contains the struck word only; `redact(state, 0)` contains its own words; spectator sees all; `rng`/`picker` null.

---

### Task 11: Balance simulation (`src/core/sim.ts`, `tests/sim/balance.test.ts`)

Spec: §6 balance simulation, §3.4/3.5/3.8 constants.

**Interfaces:**
- Consumes: Engine, CpuBrain, cpuProfile.
- Produces:
```ts
export interface SimTypist { profile: CpuProfile; policy?: 'adaptive' | 'alwaysEasy' | 'alwaysHard' | 'neverHard' }
export interface PointRecord { shots: number; ms: number; reason: PointReason; serverWon: boolean; winner: PlayerId }
export function humanProfile(wpm: number): CpuProfile; // spec §6 human model (err 7%@25 → 1.5%@120, reaction 900 → 400 ms, aggression 1 = "hardest that fits")
export function simulatePoints(a: { config: MatchConfig; typists: [SimTypist, SimTypist]; seed: number; points: number }): PointRecord[];
export function simulateMatch(a: { config: MatchConfig; typists: [SimTypist, SimTypist]; seed: number }): { winner: PlayerId; points: PointRecord[] };
export function summarize(points: PointRecord[]): { medianShots: number; p90Shots: number; maxShots: number; aceRate: number; dfRate: number; serverWinRate: number; medianSecPerPoint: number };
```
`CpuBrain` gains a `policy` option (additive; add it in Task 11 if Task 9 didn't) that overrides choice selection for the fixed-strategy checks. Chase reaction for the human model = 250 ms.

- [ ] **Step 1: Write `tests/sim/balance.test.ts`** asserting every spec §6 balance target (≥ 5,000 points per cell for the rally-shape cells; ≥ 200 short sets for belt-vs-belt cells; mark the file `describe.concurrent` and give it a 10-minute timeout).
- [ ] **Step 2:** run; if targets fail, retune **only** `src/core/tuning.ts` constants (keep spec semantics), re-run until green; record the final constants and the summary table in the task report. If a target is impossible without changing semantics, report it with data instead of changing semantics.

---

### Task 12: Palette, colour math, bitmap font (`src/render/palette.ts`, `src/render/color.ts`, `src/render/font.ts`)

Spec: §4.1 (palette, text), §4.2 (colours, contrast).

**Interfaces:**
- Produces:
```ts
// color.ts
export function hex(rgb: string): [number, number, number];
export function contrastRatio(a: string, b: string): number;          // WCAG
export function ciede2000(a: string, b: string): number;
export function simulateCvd(rgb: string, kind: 'protan' | 'deutan' | 'tritan'): string; // Machado 2009, severity 1
// palette.ts
export const PAL: Record<string, string>;           // named scene/UI colours (≤ 48 unique)
export const TIER_COLOR: Record<Tier, string>;      // '#56B4E9', '#F0E442', '#D55E00' (snapped)
export const PLATE: { fill: string; text: string; outline: string; dim: string; flash: string; halo: string };
export const RAMPS: { skin: string[][]; hair: string[][]; cloth: string[][]; racket: string[][] }; // each ramp [hi, mid, lo]; sizes 6/8/12/6
export const OUTLINE: string;
export const BELT_COLOR: Record<'white'|'yellow'|'green'|'brown'|'black', number>; // cloth ramp index per belt
export const SURFACE_PAL: Record<Surface, { court: string[]; surround: string[]; lines: string; accent: string[] }>;
// font.ts
export interface Glyph { w: number; rows: string[] }                  // rows of '#'/'.' in a 6×10 cell (w=5 for letters)
export const GLYPHS: Record<string, Glyph>;                           // a–z, A–Z, 0–9, and .,:;!?'"-+/()%&*#@<>=_[] and space, ★
export const FONT: { cellW: 6; cellH: 10; baseline: 7; xHeight: 5; capHeight: 7 };
export function textWidth(s: string, scale?: 1 | 2): number;
export function drawText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color: string, scale?: 1 | 2): void; // cached glyph bitmaps per colour
export function sanitizeName(s: string): string;                      // keep glyph-set chars, others → '?', max 12
```
- [ ] **Step 1: Failing tests** `tests/render/palette.test.ts` and `tests/render/font.test.ts`:
  - Palette ≤ 48 unique scene/UI colours; ramp sizes 6/8/12/6; every ramp is monotonic in luminance hi > mid > lo.
  - Plate text vs fill ≥ 12:1; each tier colour vs plate fill ≥ 4.5:1.
  - Tier colours pairwise CIEDE2000 ≥ 20 under normal vision and each simulated CVD.
  - Glyph metrics: every lowercase glyph is 5 wide and 10 rows; descenders only in g, j, p, q, y (rows 8–9 non-empty only for those); `i`, `l`, `j` differ in ≥ 2 columns; digits and capitals have cap height 7.
  - `textWidth('ball') === 23` (4·6 − 1); `sanitizeName('<b>Zoë😀</b>')` has no '<' and length ≤ 12.

---

### Task 13: Screen scaling, projection, court and scene painters (`src/render/screen.ts`, `projection.ts`, `court.ts`, `scene.ts`)

Spec: §4.1 (scaling, projection, layers, scene, surfaces), §4.6 (`--u`), art quality bar.

**Interfaces:**
- Produces:
```ts
// screen.ts
export interface ScaleInfo { k: number; dpr: number; cssW: number; cssH: number; mode: 'pixel' | 'fit'; offsetX: number; offsetY: number }
export function computeScale(innerW: number, innerH: number, dpr: number, mode: 'pixel' | 'fit'): ScaleInfo;
export class Screen { constructor(canvas: HTMLCanvasElement); readonly buf: CanvasRenderingContext2D /* 480×270 */; info: ScaleInfo; resize(): void; present(): void; onChange(cb: (i: ScaleInfo) => void): void }
// projection.ts
export const W = 480, H = 270;
export function project(p: Vec3, viewer: PlayerId | 'spectator'): { x: number; y: number; d: number }; // spec §4.1 formula, end-1 viewer rotated 180°
export function unprojectGround(sx: number, sy: number, viewer: PlayerId | 'spectator'): Vec2;
export function scaleAt(y: number, viewer: PlayerId | 'spectator'): number; // px per metre at court depth y
export function netScreenY(): number;
// court.ts
export function drawCourt(ctx: CanvasRenderingContext2D, surface: Surface, viewer: PlayerId | 'spectator'): void; // cached per (surface, viewer-end)
// scene.ts
export interface SceneState { crowdExcite: number; umpireLook: -1 | 0 | 1; t: number }
export function drawBackdrop(ctx: CanvasRenderingContext2D, surface: Surface, s: SceneState): void;
export function drawNet(ctx: CanvasRenderingContext2D, surface: Surface, viewer: PlayerId | 'spectator'): void;
export function drawUmpire(ctx: CanvasRenderingContext2D, s: SceneState): void;
```
Art bar: 16-bit console quality — shaded stands with a procedural crowd (8 body templates, palette-swapped, 2-frame bob; cheering raises arms), ad boards with in-game names ("BLACK BELT", "TYPE FAST", "DOJO CUP"), dithered sky/roof, court surface textures (hard: subtle noise; clay: two-tone grain + worn baseline patches; grass: mowing stripes + worn baseline; dojo: planks with grain and tatami surround, paper lanterns), crisp 1 px court lines, net with posts, tape, 50 % checker-dither mesh, net shadow; umpire chair with 3 head-turn frames. Everything is pixel-exact (integer coordinates, no anti-aliasing: draw lines with `fillRect` spans, not `stroke`).

- [ ] **Step 1: Failing tests** `tests/render/screen.test.ts`, `tests/render/projection.test.ts`:
  - `computeScale(1920,1080,1,'pixel')` → k 4, cssW 1920. `computeScale(1536,760,1.25,'pixel')` → k = floor(min(1920/480, 950/270)) = 3, cssW = 480·3/1.25 = 1152. `computeScale(900,500,1,'pixel')` → k 1 ⇒ mode 'fit'. `k` is never 0 (a 300×200 window still returns k ≥ 1 in fit mode).
  - Offsets are whole device pixels.
  - Projection: near doubles baseline corners at (90,240)/(390,240); far baseline 150 px wide at y=80; net y ≈ 133.3; a point 1.2 m behind the near baseline has screen y ≤ 257; viewer 1 maps (x,y) → (−x,−y); `unprojectGround(project(p))` ≈ p.
- [ ] **Step 2:** implement; then visually verify via a temporary scratch script (or Task 23's art page once available) and iterate on the art until it meets the bar.

---

### Task 14: Player sprite rig (`src/render/sprites/*`)

Spec: §4.1 Players, §4.6 Customize, §6 Art QA.

**Files:** `src/render/sprites/parts.ts` (hand-authored part grids + legend), `poses.ts` (pose tables), `rig.ts` (compositor: parts + procedural limbs + outline pass), `sheet.ts` (cache per look), `animations.ts` (animation names, frame counts, timing).

**Interfaces:**
- Consumes: palette `RAMPS`, `OUTLINE`, `Look`.
- Produces:
```ts
export type AnimName = 'idle' | 'runLeft' | 'runRight' | 'runToward' | 'runAway' | 'forehand' | 'backhand' | 'serve' | 'stretch' | 'celebrate' | 'dejected';
export type View = 'near' | 'far';           // near = back view, far = front view
export const ANIMS: Record<AnimName, { frames: number; msPerFrame: number; loop: boolean }>;
export const CELL = { w: 48, h: 48, anchorX: 24, anchorY: 46 };
export interface SpriteSheet { canvas: HTMLCanvasElement | OffscreenCanvas; frame(anim: AnimName, view: View, i: number): { sx: number; sy: number } }
export function buildSheet(look: Look): SpriteSheet;          // cached by JSON(look)
export function drawPlayer(ctx: CanvasRenderingContext2D, sheet: SpriteSheet, anim: AnimName, view: View, frame: number, feetX: number, feetY: number, flip?: boolean): void;
export function lintParts(): string[];                         // art-lint problems (empty = OK)
export const HAIR_STYLES: string[];                            // 5 names
```
Frames per view as spec §4.1 (idle 2, run-lateral 6, run-toward 4, run-away 4, forehand 4, backhand 4, serve 4, stretch 2, celebrate 2, dejected 2). Character ~40 px tall, readable silhouette, 3-shade ramps on skin/hair/cloth, shoes, visible racket; far (front) view shows face (eyes 1 px, headband band). Racket hand = right.

- [ ] **Step 1: Failing tests** `tests/render/sprites.test.ts` (jsdom + `canvas` not available → test pure data): `lintParts()` returns `[]` (equal row lengths, legend-only chars, outline on every opaque edge pixel, monotonic ramps); pose tables have the frame counts above; feet anchor offsets within ±1 px across locomotion frames; `buildSheet` is not called in node tests.
- [ ] **Step 2:** implement; then export and **look at** the sprite sheets (Task 23's art page, or a scratch Playwright screenshot) for 4 looks in both views; iterate until they read clearly as tennis players at 1× and look good at 4×.

---

### Task 15: Plates and overlay layout (`src/render/plates.ts`, `src/render/layout.ts`)

Spec: §4.1 (screen zones), §4.2 (everything).

**Interfaces:**
- Consumes: font, palette, projection (`project`, `netScreenY`), types.
- Produces:
```ts
// layout.ts
export interface PlateBox { x: number; y: number; w: number; h: number; option: number }
export function plateWidth(len: number, scale?: 1 | 2): number;          // 6n+11 at 1×
export function layoutChoice(lens: number[], targetsScreenX: number[], band: 'far' | 'near'): PlateBox[]; // slots 90/240/390; easy centre; medium/hard by target side
export function layoutServeNear(lens: number[], headX: number, headY: number): PlateBox[]; // vertical stack
export function layoutServeFar(lens: number[], serverX: number): PlateBox[];               // horizontal row in far band
export function layoutSingle(len: number, headX: number, headY: number, scale: 1 | 2): PlateBox;
export const BANDS: { hud: [0, 21]; far: [22, 38] };
// plates.ts
export type PlateStyle = 'localActive' | 'remote' | 'hiddenRemote';
export interface PlateDraw { box: PlateBox; opt: WordOption; typed: number; locked: boolean; faded: number; style: PlateStyle; lastWrongAgeMs: number | null; isNextCursor: boolean; showInitialBlock: boolean; nameChip: string | null; oppColor: string | null; scale: 1 | 2; reduceEffects: boolean }
export function drawPlate(ctx: CanvasRenderingContext2D, p: PlateDraw): void;
export function drawTierRing(ctx: CanvasRenderingContext2D, tier: Tier, sx: number, sy: number): void; // circle/diamond/star, outlined
export function drawLeader(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, tier: Tier): void;
export function drawTimingBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, frac: number, grace: boolean): void;
```
- [ ] **Step 1: Failing tests** `tests/render/layout.test.ts`: for all lengths 3–14 (all combos of three lengths within tiers) and both target sides, `layoutChoice` boxes don't intersect and lie within x 4–476, y 22–266; easy in the centre slot; `plateWidth(14) === 95`; serve stacks don't exceed bounds for heads near both edges; `layoutSingle(14, 470, 200, 2)` is clamped inside x ≤ 476.
- [ ] **Step 2:** implement and inspect every plate state on the art page (Task 23).

---

### Task 16: Audio (`src/audio/*`)

Spec: §4.4.

**Files:** `src/audio/engine.ts` (AudioContext, buses master/music/sfx, unlock), `sfx.ts` (synth voices: hit, bounce per surface, netHit, key click, error buzz, lock tick, word chime, your-turn tick, crowd murmur loop, applause, ooh), `music.ts` (procedural chiptune title loop), `speech.ts` (umpire voice), `director.ts` (event → sound mapping).

**Interfaces:**
```ts
export class AudioEngine {
  unlock(): Promise<void>;                          // create/resume context on a user gesture; never throws
  setVolumes(v: { master: number; music: number; sfx: number }): void;
  play(name: SfxName, opts?: { pan?: number; gain?: number; surface?: Surface }): void; // no-op if locked/failed
  crowd(level: number): void;                       // 0..1 murmur intensity
  music(on: boolean): void;
  readonly ok: boolean;
}
export type SfxName = 'hit' | 'hitHard' | 'bounce' | 'netHit' | 'key' | 'bad' | 'lock' | 'done' | 'yourTurn' | 'applause' | 'ooh' | 'coin';
export class Umpire { constructor(getVolume: () => number); readonly available: boolean; enabled: boolean; say(text: string, eventAgeMs: number): void; } // spec §4.4 rules
export class AudioDirector { constructor(a: AudioEngine, u: Umpire); onEvents(events: GameEvent[], ctx: { viewer: PlayerId | 'spectator'; muted: boolean; state: PublicState; surface: Surface }): void; onLocalKey(result: KeyResult): void }
```
- [ ] **Step 1: Failing tests** `tests/audio/director.test.ts` with fake `AudioEngine`/`Umpire`: strike → 'hit' (hard tier → 'hitHard'); bounce → 'bounce' with surface; point won by viewer → 'applause'; muted → nothing; remote `keyOk` events → 'key' at lower gain, but own keys only via `onLocalKey`. `tests/audio/speech.test.ts`: `Umpire` with `speechSynthesis` undefined → `available=false`, `say` no-op; with a fake synthesis: calls `cancel()` before `speak()`, drops calls older than 800 ms, prefers a `localService` en voice, disabled if none.

---

### Task 17: Sessions, keyboard, playback, loop (`src/game/*`)

Spec: §4.5, §5.2, §3.1 (dropping off-turn keys), §4.6 (pause, countdown), §3.12 (training).

**Files:** `src/game/clock.ts` (Scheduler interface + real and virtual implementations), `src/game/keyboard.ts`, `src/game/playback.ts`, `src/game/localSession.ts`, `src/game/session.ts` (shared `Session` interface + `ViewModel`), `src/game/loop.ts` (rAF + worker ticker), `src/game/debug.ts` (window.__bbt hooks for E2E).

**Interfaces:**
```ts
// clock.ts
export interface Scheduler { now(): number; every(ms: number, fn: () => void): () => void; after(ms: number, fn: () => void): () => void }
export class RealScheduler implements Scheduler { /* performance.now, setInterval; plus a Worker-based ticker for every() when opts.worker */ }
export class VirtualScheduler implements Scheduler { advance(ms: number): void /* runs due callbacks in order */ }
// playback.ts
export class PlaybackClock {
  constructor(opts: { margin: number; maxRate: number; relaxMs: number });   // 60, 1.1, 500 (local CPU: margin 0)
  begin(): void;                  // τ_play = 0
  confirm(τc: number): void;      // latest owner-confirmed τ
  tick(dtMs: number): number;     // advances and returns τ_play (never > τc, never decreasing)
  get τ(): number;
}
// keyboard.ts
export class KeyboardCapture { constructor(target: Window, onKey: (k: KeyClass, timeStamp: number) => void); enable(): void; disable(): void; setBlocked(b: boolean): void /* menus/inputs */ ; dispose(): void }
// session.ts
export interface ViewModel {
  pub: PublicState; viewer: PlayerId | 'spectator';
  turnτ: number;                        // τ to render the current turn at
  liveTurn: TurnState | null;           // viewer-owned live turn (unredacted for viewer)
  events: GameEvent[];                  // events that became visible since the last frame
  overlay: { paused: boolean; countdown: number | null; coach: string | null; wait: boolean; unstable: boolean; hintSpace: boolean; hintFirstLetter: boolean; focusLost: boolean };
}
export interface Session { frame(dtMs: number): ViewModel; key(k: KeyClass, timeStamp: number): void; pause(): void; resume(): void; dispose(): void; readonly over: boolean; readonly result: MatchState | null }
// localSession.ts
export interface LocalSessionOptions { config: MatchConfig; players: [PlayerInfo, PlayerInfo]; seed: number; human: PlayerId | null /* null = attract */; scheduler: Scheduler; training?: TrainingScript | null }
export class LocalSession implements Session { /* engine + CpuBrains for CPU players; human keys → engine.input with τ = timeStamp − turnStartLocal; next turn starts at turnStartLocal + endτ; pause freezes the turn clock (shifts turnStartLocal on resume) and hides prompts; resume runs a 1.5 s 3-2-1 countdown */ }
export interface TrainingScript { lessons: { id: string; coach: (v: ViewModel) => string | null; done: (v: ViewModel) => boolean }[] }
export const TRAINING: TrainingScript;
```
Rules: off-turn keys are dropped and set `overlay.wait` for 300 ms (max once/s); the human's Space in PRE_SERVE sends `'toss'`; CPU inputs are scheduled from `CpuBrain.plan` and fed with their planned τ when local time passes them; catch-up capped at 250 ms per frame; the session calls `engine.clock(owner, τ)` every frame for local/CPU owners. Passive CPU turns render with `PlaybackClock` margin 0 (τ_play = τ). The attract session has `human = null`, mutes nothing itself (the audio director is told `muted`).

- [ ] **Step 1: Failing tests** `tests/game/playback.test.ts`: τ_play never exceeds confirmed τ, never decreases; with confirmations arriving 150 ms late at 20 Hz the lag settles to margin ±20 ms within 1.5 s; with no confirmations it holds. `tests/game/localSession.test.ts` (VirtualScheduler): a human-vs-CPU match where a scripted "human" presses keys via `session.key` completes; pausing for 10 s mid-turn does not trigger any deadline and resume shows a countdown before the clock restarts; off-turn keys set `wait` and change nothing. `tests/game/keyboard.test.ts` (jsdom): preventDefault rules per spec §4.5; Ctrl combos not prevented; disabled while an `<input>` is focused.

---

### Task 18: World renderer (`src/render/world.ts`, `ball.ts`, `players.ts`, `hud.ts`, `effects.ts`, `renderer.ts`)

Spec: §4.1–§4.3, §3.3.2 (movement), §3.4 (positioning), §5.3 (passive playback).

**Interfaces:**
```ts
// players.ts
export interface PlayerPose { feet: Vec2; anim: AnimName; frame: number; view: View; flip: boolean }
export class PlayerAnimator { update(vm: ViewModel, dtMs: number): [PlayerPose, PlayerPose] } // cosmetic positions from turn view (spec §3.0/§3.4 rules), max speeds 7 m/s chase / 4 m/s jog
// renderer.ts
export interface DisplayPrefs { largeWords: boolean; reduceEffects: boolean; showWpm: boolean }
export class Renderer {
  constructor(screen: Screen);
  draw(vm: ViewModel, prefs: DisplayPrefs, dtMs: number): void;  // full frame into screen.buf, then present()
  setLooks(looks: [Look, Look]): void;
}
```
Composition order per spec §4.1 layers. Ball: current turn's incoming flight at `turnτ` (serve turn: toss ball from `tossAt`); lastTurn visuals are finished through the lead-in (ball bounce/roll-out). Plates: local-active vs remote styles, hidden serve plates (dots → blocks), serve reveal flip at strike, choice slots with leaders to rings, timing bar with grace checker, chase plate above the owner's head where it stood at turn start, WAIT tag, SPACE keycap hint, first-letter hint. HUD: scoreboard (names, belt swatch, sets/games/points, serve dot), serve clock, speed readout (km/h after each strike), WPM (pref), banners (lead-in text, situation), pause icon, "Connection unstable…", pause overlay (prompts hidden). Effects: hit spark, bounce puff, clay mark, dust on run/slide, crowd excitement, confetti on match win; screen shake on ace/winner only when `!reduceEffects`.

- [ ] **Step 1: Failing tests** `tests/render/players.test.ts`: `PlayerAnimator` positions: server/receiver at their spots in PRE_SERVE; receiver feet move monotonically toward the stance as chase progress rises; speed never exceeds 7 m/s; forehand/backhand anim chosen per `stanceFor`; celebrate/dejected after a point.
- [ ] **Step 2:** implement; verify visually with the art page scene snapshots and a live dev session; iterate.

---

### Task 19: UI shell, screens, storage, app (`src/ui/**`, `src/app.ts`, `src/main.ts`, `src/styles.css`)

Spec: §4.6, §3.11, §3.12, §5.4, §8 (itch/Pages behaviours).

**Files:** `src/ui/dom.ts` (`h()` helper, focus utils), `src/ui/storage.ts`, `src/ui/settings.ts` (Settings, Profile, Career types + defaults + validation), `src/ui/screens/{gate,title,mainMenu,cpuSetup,customize,options,howTo,pause,results,training}.ts`, `src/ui/router.ts`, `src/app.ts` (owns Screen, Renderer, AudioEngine, current Session, attract session, routes), `src/styles.css` (pixel UI using `--u`), `src/main.ts`.

**Interfaces:**
```ts
// router.ts
export type ScreenFactory = (params: unknown) => { el: HTMLElement; onShow?(): void; onHide?(): void };
export class Router { register(name: string, f: ScreenFactory): void; go(name: string, params?: unknown): void; back(): void; readonly current: string }
// storage.ts
export function load<T>(key: string, fallback: T, validate: (v: unknown) => v is T): T; // prefix bbtennis:v1:, try/catch
export function save(key: string, v: unknown): boolean;                                 // false if storage unavailable
export const storageOk: () => boolean;
// settings.ts
export interface Settings { pace: PaceId; wordPack: WordPackId; deuceRule: DeuceRule; surface: Surface; format: FormatId; cpuLevel: number; volumes: { master: number; music: number; sfx: number }; umpireVoice: boolean; showWpm: boolean; largeWords: boolean; reduceEffects: boolean; display: 'pixel' | 'fit'; trainingDone: boolean; matchesPlayed: number }
export interface Profile { name: string; look: Look }
export interface Career { perLevel: { played: number; won: number }[]; bestWpm: number; earned: string[] }
export const DEFAULT_SETTINGS: Settings; export const DEFAULT_PROFILE: Profile; export const DEFAULT_CAREER: Career;
export function isSettings(v: unknown): v is Settings; export function isProfile(v: unknown): v is Profile; export function isCareer(v: unknown): v is Career;
export function recordCareer(c: Career, level: number, won: boolean, wpm: number): Career; // milestone wins add belts
export function highestBelt(c: Career): 'white'|'yellow'|'green'|'brown'|'black'|null;
```
Screens per spec §4.6 (start gate, title with attract demo, main menu incl. Training first until done, vs CPU setup remembering last choices with Start focused, Customize with live near+far preview, Options, How to Play with OFL credits, in-match menu, Results with stat table, Training coach). First vs-CPU setup defaults: White belt, Relaxed, Tiebreak. Fullscreen button. Blur/visibility: vs CPU auto-pause; online focus-lost overlay. Online entries route to Task 21 screens (placeholders until then that show "Coming in the online task" are NOT allowed — Task 19 exports `registerOnlineScreens(router)` hook; Task 21 fills it).

- [ ] **Step 1: Failing tests** `tests/ui/storage.test.ts` (jsdom): throwing `localStorage` ⇒ `load` returns fallback, `save` returns false, `storageOk()` false; invalid stored JSON ⇒ fallback; keys prefixed. `tests/ui/settings.test.ts`: validators reject wrong shapes; `recordCareer` earns 'green' when beating level 6, not level 7; `highestBelt`.
- [ ] **Step 2:** implement screens; run `npm run dev` and click through every screen (Playwright screenshots via Task 23 scripts or manual scratch script); fix layout at 960×540 and 1920×1080.

---

### Task 20: Networking primitives (`src/net/*`)

Spec: §5.3 (transport, messages, validation), §5.4 (errors).

**Files:** `src/net/transport.ts` (interface + `LoopbackPair` with injectable latency/jitter on a `Scheduler`), `src/net/peer.ts` (PeerJS host/join with ICE config, env overrides, error mapping, code retries), `src/net/protocol.ts` (message types + guards + `PROTO`), `src/net/codes.ts`.

**Interfaces:**
```ts
export interface Transport { send(msg: NetMsg): void; onMessage(cb: (m: NetMsg) => void): void; onClose(cb: (reason: string) => void): void; close(): void; readonly bufferedAmount: number }
export function loopbackPair(s: Scheduler, opts: { latencyMs: number; jitterMs: number; seed: number }): [Transport, Transport]; // ordered delivery
export const PROTO = 1;
export interface Profile { name: string; look: Look }
export type NetMsg =
  | { type: 'hello'; proto: number; app: string; name: string; look: Look }
  | { type: 'welcome'; proto: number; hostProfile: Profile; config: MatchConfig }
  | { type: 'reject'; reason: 'version' | 'full' | 'in-match'; proto: number; app: string }
  | { type: 'lobby'; config: MatchConfig; ready: [boolean, boolean] }
  | { type: 'ready'; on: boolean }
  | { type: 'start'; config: MatchConfig; hostProfile: Profile; guestProfile: Profile }
  | { type: 'input'; seq: number; turn: number; k: string; τ: number }
  | { type: 'clock'; turn: number; τ: number }
  | { type: 'frame'; turn: number; τ: number; ev?: GameEvent[]; s?: PublicState }
  | { type: 'ping'; id: number } | { type: 'pong'; id: number }
  | { type: 'rematch'; want: boolean } | { type: 'forfeit' } | { type: 'leave' };
export function parseMsg(raw: unknown): NetMsg | null; // type guards; > 32 KB (JSON length) → null
export function genCode(rand: () => number): string;   // 5 chars from ALPHABET
export function normalizeCode(s: string): string | null;
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export interface HostHandle { code: string; onGuest(cb: (t: Transport) => void): void; close(): void }
export function hostGame(opts?: PeerEnv): Promise<HostHandle>;   // retries unavailable-id ≤ 5
export function joinGame(code: string, opts?: PeerEnv): Promise<Transport>; // 20 s timeout, status callback
export type NetErrorKind = 'notFound' | 'broker' | 'webrtc' | 'nat' | 'version' | 'full' | 'timeout';
export class NetError extends Error { kind: NetErrorKind }
export function errorText(e: NetError, code?: string): string; // spec §5.4 texts
```
- [ ] **Step 1: Failing tests** `tests/net/protocol.test.ts`: every message type round-trips through `parseMsg`; wrong types/missing fields/oversized → null; names are clamped with `sanitizeName`; look indices clamped; unknown `type` → null. `tests/net/codes.test.ts`: `genCode` uses only the alphabet, length 5; `normalizeCode(' k7tqm ')` → 'K7TQM'; codes with 0/O/1/I/L → null. Loopback: messages arrive in order with latency ≥ configured, close propagates.

---

### Task 21: Host/Guest sessions and lobby UI (`src/game/hostSession.ts`, `guestSession.ts`, `src/ui/screens/lobby.ts`, `join.ts`)

Spec: §5.2, §5.3 (all), §4.6 Host lobby/Join, §8 (invite links, clipboard).

**Interfaces:**
```ts
export class HostSession implements Session { constructor(opts: { transport: Transport; config: MatchConfig; host: PlayerInfo; guest: PlayerInfo; seed: number; scheduler: Scheduler }) }
export class GuestSession implements Session { constructor(opts: { transport: Transport; scheduler: Scheduler; me: PlayerInfo }) }
export function registerOnlineScreens(router: Router): void; // Host lobby + Join screens
```
Behaviour (spec §5.3): host engine; guest-owned turns run in a guest-local TurnRunner from `pub.turn.data` (owner's data is unredacted for the owner) and stream `input`/`clock`; the host applies them in order (drops stale turn ids and non-owner turns), never judging guest deadlines by its own clock; host-owned turns stream `frame` every 50 ms and on events; both sides render passive turns with `PlaybackClock` (margin 60 ms); the owner's next turn starts when its playback of the previous turn reaches `endτ`; guest local outcome vs host outcome compared — host wins, desync logged via `console.warn('[bbt] desync', …)`; heartbeat (3 s unstable, 8 s disconnect); ping/pong RTT display; rematch/forfeit/leave; `beforeunload` guard during a match; `pagehide` sends leave; Worker ticker keeps clocks flowing when hidden. Lobby: code at 2×, copy code, copy invite link (`VITE_PUBLIC_URL`, hidden if unset, "Copy browser invite link" in iframes), clipboard fallback chain, config editing (host) / read-only (guest), Ready toggles, errors with Retry/Back. Join: code field validation, `?join=CODE` prefill + `history.replaceState`.

- [ ] Implement; covered by Task 22 tests plus a manual two-tab smoke test (`npm run dev`, host in one tab, join in another).

---

### Task 22: Network session tests (`tests/net/sessions.test.ts`)

Spec: §6 Net tests.

- [ ] Write tests with `VirtualScheduler` + `loopbackPair` driving `HostSession`/`GuestSession` headlessly (no DOM; sessions must not touch DOM — if they do, report it to Task 21's owner): scripted typists feed each side's `session.key` at fixed per-turn offsets.
  - Latency invariance: identical point-by-point outcomes (winner, reason, strike words, landing points) at 0/150/400 ms one-way latency with ±30 ms jitter.
  - No desync warnings over 3 full short-set matches.
  - Guest `ViewModel.turnτ` never exceeds the host-confirmed τ for host-owned turns and never decreases within a turn.
  - Redaction: frames sent to the guest never contain the host's unstruck serve words, spare sets or randoms (scan `JSON.stringify` of every frame).
  - Host rAF suspended (no `frame()` calls on the host for 5 s of virtual time) during a guest-owned turn: the turn still resolves at the right τ via messages/ticker.
  - Disconnect: closing the guest transport ends the host's match with the disconnect reason; 8 s silence does the same.

---

### Task 23: Art tool, art export, E2E (`tools/*`, `scripts/*`, `tests/e2e/*`)

Spec: §6 Art QA and E2E.

- [ ] **Art page** `tools/art.html` + `tools/art.ts` (dev-only Vite entry, not in the build): 4× checkerboard; sections: sprite animations for 4 look presets × 2 views (anchor crosshair, labels, onion-skin), font atlas + sample words, every plate state (idle, typed, next, error flash, locked, remote, hidden-remote, 2×), rings/leaders/timing bars, each surface full scene at 1× and 3× with both players and a ball mid-flight, HUD with sample scores and banners.
- [ ] **`scripts/artExport.mjs`**: starts `vite` (programmatic API) on a free port, opens `tools/art.html` in Chrome via `playwright-core` (`chromium.launch({ channel: 'chrome' })`, fallback to `executablePath` `C:/Program Files/Google/Chrome/Application/chrome.exe`), screenshots each `[data-shot]` element to `artifacts/art/<name>.png`, prints the list.
- [ ] **`scripts/e2e.mjs`**: builds (`vite build`) and serves `dist/` with `vite preview`; runs scenarios: (1) boot → gate → title renders (screenshot); (2) every menu screen (screenshots at 960×540 and 1920×1080); (3) Training lesson 1 via keyboard; (4) a full vs-CPU tiebreak match typed through `window.__bbt` hooks (reads the active prompt, types the word with 90 ms per key) until Results; screenshots at PRE_SERVE, toss, chase, choice, point call, results; (5) best-effort online: two pages, host → code → join → play 2 points; skipped with a warning if the broker is unreachable. Screenshots to `artifacts/e2e/`. Exit non-zero on failures (except the online scenario when the broker is unreachable).

---

### Task 24: Delivery (`README.md`, `.github/workflows/deploy.yml`, `scripts/packageItch.mjs`, `public/licenses/*`)

Spec: §7, §8.

- [ ] `deploy.yml`: on push to `main` + workflow_dispatch: checkout, setup-node 24, `npm ci`, `npm run typecheck`, `npm test`, `npm run build` (env `VITE_PUBLIC_URL: https://<owner>.github.io/<repo>/` derived from `github.repository_owner` and repo name), upload-pages-artifact `dist`, deploy-pages.
- [ ] `scripts/packageItch.mjs`: zip the **contents** of `dist/` (use Node's `zlib` + a tiny zip writer, or `tar -a -cf` on Windows 10+ / `zip` if present) into `black-belt-tennis-itch.zip`; verify `index.html` at the root.
- [ ] Copy OFL licence files from `node_modules/@fontsource/*/LICENSE` into `public/licenses/<font>-OFL.txt`.
- [ ] README: pitch, how to play, controls, modes, dev commands, deploy to Pages (enable Pages → GitHub Actions), itch.io (Kind HTML, embed 960×540, fullscreen button, `butler push black-belt-tennis-itch.zip user/game:html5`), hosting trade-offs table (spec §8), online-play notes (PeerJS broker, NAT caveats, env overrides), credits.

---

### Task 25: Visual QA loop and whole-branch review (controller)

- [ ] Run `npm run art:export` and `npm run e2e`; review every PNG against spec §4 and the art bar; file concrete fix tasks; loop until no major visual issues remain.
- [ ] Whole-branch review (correctness, spec coverage, security of peer input, performance: 60 fps at 1920×1080 in Chrome with < 4 ms/frame render on a desktop).
- [ ] Final: `npm run typecheck && npm test && npm run build && npm run e2e` green; commit.
