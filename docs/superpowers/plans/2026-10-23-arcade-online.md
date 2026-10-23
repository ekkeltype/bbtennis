# Arcade Online Play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two friends play a Black Belt Tennis Arcade match online (host code / invite link, as in the typing game) with instant local controls (rollback netcode).

**Architecture:** Both browsers run the Arcade's deterministic `step()` from the same seed and exchange only per-tick inputs over the typing game's PeerJS data channel; each side predicts the opponent's input and rolls back and re-simulates when the true input arrives. The typing game's online plumbing (transport, PeerJS host/join, heartbeat link, lobby logic and lobby screens) is split into game-neutral modules both games use; the typing game keeps its exports and behaviour.

**Tech Stack:** TypeScript (strict), Vite, Vitest (node + jsdom), PeerJS 1.5, playwright-core for browser scripts.

**Spec:** `docs/superpowers/specs/2026-10-23-arcade-online-design.md` (builds on `2026-10-17-arcade-design.md` and the typing game's `2026-09-26-black-belt-tennis-design.md` §5.3–5.4).

## Global Constraints

- `src/arcade/core/` stays pure and deterministic (`tests/arcade/boundary.test.ts` (c)); the netcode lives in `src/arcade/game/` and `src/arcade/net/`.
- No file outside `src/arcade/` imports `src/arcade/` (boundary (a)); the Arcade never reaches a typing-only module at runtime (boundary (b)). Add `net/protocol`, `net/transport`, `net/peer`, `ui/screens/lobby`, `ui/screens/join`, `ui/screens/online` to `TYPING_ONLY`.
- The typing game behaves exactly as before: `npm test` (all suites), `npm run typecheck`, `npm run build`, `npm run e2e` stay green. Existing exports of `net/transport`, `net/peer`, `net/protocol`, `game/onlineLink`, `ui/screens/online` keep their names and shapes.
- Messages are JSON over a reliable, ordered PeerJS DataConnection with `serialization: 'raw'`; nothing over 32 000 UTF-8 bytes is sent.
- Comments and naming follow the surrounding code: a one-line doc comment per export, spec section references, `[bbt]` log prefix.
- Files use LF line endings (`.gitattributes`); Python or other tools on Windows must not write CRLF.
- Commits end with the attribution lines from the session reminder.

## Review Focus

1. A remote input that arrives after the local side has already simulated past it must change nothing but the opponent's actions: final states must equal a plain run with the true inputs (rollback test, Task 4).
2. A tab that is hidden mid-match must keep both sides moving (Worker pump), and its player must stand still (Task 6 session test: a side whose frames stop still advances on its ticker).
3. A guest on another build must be turned away with "Versions differ" before any match starts (Task 6/7).
4. Forfeit, leave and disconnect during a match, and the opponent leaving after Results, must end in the right Results text with Rematch disabled (Task 6/7).
5. A rematch must restart both sides on a new seed with match number +1, and stale messages of the old match must be ignored (Task 6).

---

### Task 1: Generic codec and transport

**Files:**
- Create: `src/net/codec.ts`, `src/net/channel.ts`
- Modify: `src/net/protocol.ts` (codec via `jsonCodec`), `src/net/transport.ts` (typing specialization + re-exports)
- Test: `tests/net/channel.test.ts` (a toy protocol through `loopbackPair` and `jsonCodec`); existing `tests/net/*` stay green

**Interfaces (produces):**

```ts
// net/codec.ts
export const MAX_SEND_BYTES = 32000;
export interface EncodedMsg { json: string; bytes: number }
export interface Codec<M> {
  encode(m: M): EncodedMsg | null; // null + `[bbt] frame too big` warning over MAX_SEND_BYTES
  decode(data: unknown): M | null; // JSON string ≤ MAX_SEND_BYTES chars that `parse` accepts
  bytes(m: M): number;             // UTF-8 bytes of its JSON
}
export function jsonCodec<M>(parse: (raw: unknown) => M | null): Codec<M>;

// net/channel.ts
export interface Transport<M> { send(msg: M): void; onMessage(cb: (m: M) => void): void; onClose(cb: (reason: string) => void): void; close(): void; readonly bufferedAmount: number }
export const REMOTE_CLOSED = 'closed';
export const MAX_HELD_MESSAGES = 64;
export const MAX_HELD_BYTES = 64 * 1024;
export class TransportListeners<M> { constructor(bytes: (m: M) => number) /* same methods as today */ }
export interface LoopbackOptions { latencyMs: number; jitterMs: number; seed: number }
export function loopbackPair<M>(s: Scheduler, opts: LoopbackOptions, codec: Codec<M>): [Transport<M>, Transport<M>];

// net/protocol.ts adds
export const NET_CODEC: Codec<NetMsg>;
// net/transport.ts keeps: Transport (= Transport<NetMsg>), TransportListeners (no-arg constructor), loopbackPair(s, opts), REMOTE_CLOSED, MAX_HELD_*, LoopbackOptions
```

- [ ] Move the code, keeping doc comments; `protocol.ts`'s `msgBytes`, `encodeWithBytes`, `encodeMsg`, `decodeMsg` delegate to `NET_CODEC`.
- [ ] Toy-protocol test: round trip, oversize drop, malformed drop, held-message caps.
- [ ] `npm test`, `npm run typecheck`; commit.

### Task 2: Game-neutral PeerJS, link, lobby logic and lobby screens (shared refactor)

**Files:**
- Create: `src/net/rtc.ts` (from `net/peer.ts`), `src/net/link.ts` (from `game/onlineLink.ts`: `PeerLink`, `TransportSwitch`, its `Channel`, `LobbyLink`, `Departure`), `src/net/lobby.ts` (from `ui/screens/lobby.ts` `HostLobby` and `ui/screens/join.ts` `GuestLobby`), `src/ui/lobbyScreens.ts` (from `ui/screens/lobby.ts`, `join.ts`, `online.ts`: the screens, the shared lobby pieces, `inFrame`, the page guards)
- Modify: `src/net/peer.ts`, `src/game/onlineLink.ts`, `src/ui/screens/lobby.ts`, `src/ui/screens/join.ts`, `src/ui/screens/online.ts` (thin typing specializations), `tests/arcade/boundary.test.ts` (TYPING_ONLY additions)
- Test: existing `tests/net/*`, `tests/game/onlineSmoke.test.ts`, `tests/ui/online.test.ts` unchanged and green; add `tests/net/lobby.test.ts` (generic lobby with a toy config and protocol over `loopbackPair`: hello → welcome, version reject, config change clears Ready, start hands over the transport to the factory's session)

**Interfaces (produces):**

```ts
// net/rtc.ts — everything net/peer.ts has today, for any codec and peer id prefix
export interface RtcProtocol<M> { codec: Codec<M>; prefix: string }
export interface HostHandle<M> { code: string; onGuest(cb: (t: Transport<M>) => void): void; close(): void }
export function hostRtc<M>(p: RtcProtocol<M>, opts?: PeerEnv): Promise<HostHandle<M>>;
export function joinRtc<M>(p: RtcProtocol<M>, code: string, opts?: PeerEnv): Promise<Transport<M>>;
// plus HOST_CODE_TRIES, JOIN_TIMEOUT_MS, GUEST_OPEN_TIMEOUT_MS, SLOW_STATUS_MS, CLOSE_FLUSH_MS, RECONNECT_DELAY_MS, STILL_CONNECTING, PeerErrorLike, ConnLike, PeerLike, PeerFactory, PeerEnv
// net/peer.ts keeps PEER_ID_PREFIX = 'bbtennis-', HostHandle (= HostHandle<NetMsg>), hostGame(opts), joinGame(code, opts) and its re-exports

// net/link.ts
export type LinkMsg = { type: 'ping'; id: number } | { type: 'pong'; id: number } | { type: 'leave' };
export type Departure = 'left' | 'disconnect';
export class PeerLink<M extends { type: string }>   // M's union must include LinkMsg's three
export class TransportSwitch<M>
export class LobbyLink<M extends { type: string }>
// game/onlineLink.ts re-exports PeerLink, TransportSwitch, LobbyLink, Departure

// net/lobby.ts
export interface LobbyProto { proto: number; app: string }
export type LobbyMsg<C> =
  | { type: 'hello'; proto: number; app: string; name: string; look: Look }
  | { type: 'welcome'; proto: number; hostProfile: Profile; config: C }
  | { type: 'reject'; reason: 'version' | 'full' | 'in-match'; proto: number; app: string }
  | { type: 'lobby'; config: C; ready: [boolean, boolean] }
  | { type: 'ready'; on: boolean };
export type HostPhase = 'opening' | 'waiting' | 'joined' | 'failed' | 'started';
export type JoinPhase = 'idle' | 'connecting' | 'joined' | 'failed' | 'started';
export interface HostStart<C> { config: C; me: Profile; guest: Profile; seed: number }
export class HostLobby<C, M extends { type: string }, S> {
  constructor(o: {
    proto: LobbyProto; host(opts: PeerEnv): Promise<HostHandle<M>>; scheduler: Scheduler; seed(): number;
    me: Profile; config: C; onChange(): void;
    session(t: Transport<M>, start: HostStart<C>): S; onStart(session: S, release: () => void): void;
  });
  // phase, code, error, guest, config, ready, rttMs, open(), setConfig(patch), toggleReady(), cancel() — as today
}
export class GuestLobby<C, M extends { type: string }, S> {
  constructor(o: {
    proto: LobbyProto; join(code: string, opts: PeerEnv): Promise<Transport<M>>; scheduler: Scheduler;
    me: Profile; onChange(): void; session(t: Transport<M>): S; onStart(session: S): void;
  });
  // phase, status, error, host, config (C | null), ready, rttMs, connect(code), toggleReady(), cancel() — as today
}
// A version reject or welcome carries host/you versions only when the protocol numbers differ;
// with equal numbers (another app id or build) the text is "Versions differ — reload with Ctrl+Shift+R".

// ui/lobbyScreens.ts
export interface LobbyEnv<M> { hostGame(opts: PeerEnv): Promise<HostHandle<M>>; joinGame(code: string, opts: PeerEnv): Promise<Transport<M>>; scheduler: Scheduler; seed(): number; publicUrl: string | null; framed: boolean }
export interface LobbyGame<C, M extends { type: string }, S> {
  proto: LobbyProto;
  /** The host's option spinners. */
  optionRows(get: () => C, set: (patch: Partial<C>) => void): HTMLElement[];
  /** Read-only option labels, and their values for a config, for the guest. */
  optionLabels: readonly string[];
  optionValues(c: C): string[];
  hostSession(t: Transport<M>, start: HostStart<C>): S;
  guestSession(t: Transport<M>, me: Profile): S;
}
export interface LobbyContext<C, M, S> { router: Router; profile(): Profile; config(): C; env: LobbyEnv<M>; begin(session: S, release: () => void): void }
export interface JoinParams { code: string | null }
export function hostLobbyScreen<C, M extends { type: string }, S>(ctx: LobbyContext<C, M, S>, game: LobbyGame<C, M, S>): ScreenFactory;
export function joinScreen<C, M extends { type: string }, S>(ctx: LobbyContext<C, M, S>, game: LobbyGame<C, M, S>): ScreenFactory;
export function inFrame(): boolean;
/** Closing the page asks first while `session.over` is false; pagehide calls `session.leave()`. Returns remove(). */
export function guardOnlineMatch(session: { readonly over: boolean; leave(): void }): () => void;
// plus the shared pieces: PING_REFRESH_MS, OpponentCard, readyButton, showReady, readyStatus, pingText, keepFocus
```

- [ ] Move code, not rewrite it: same DOM, classes, texts, focus rules, timers. The typing screens become a typing `LobbyGame` plus the generic builders; `registerOnlineScreens`, `browserEnv`, `OnlineEnv`, `OnlineDeps`, `OnlineControls`, `OnlineSession`, `JoinParams` keep their exports from `ui/screens/online.ts`.
- [ ] Generic code reaches no typing-only module at runtime (type-only imports are fine).
- [ ] Add the TYPING_ONLY entries; all tests, typecheck, build green; commit.

### Task 3: Arcade protocol

**Files:** Create `src/arcade/net/protocol.ts`; Test `tests/arcade/net/protocol.test.ts`.

**Interfaces (produces):**

```ts
export const PROTO = 1;
export const BUILD: string;            // import.meta.env.VITE_BUILD_ID, else 'dev'
export const APP_ID: string;           // `bbtennis-arcade@${BUILD}`
export const PEER_PREFIX = 'bbtennis-arcade-';
export interface OnlineConfig { format: FormatId; deuceRule: DeuceRule; surface: Surface; pace: PaceId } // = ArcadeConfig
export type ArcadeMsg = LobbyMsg<ArcadeConfig> | LinkMsg
  | { type: 'start'; m: number; config: ArcadeConfig; seed: number; players: [Profile, Profile] }
  | { type: 'in'; m: number; t: number; i: number[]; adv: number }
  | { type: 'sum'; m: number; t: number; h: number }
  | { type: 'state'; m: number; t: number; s: ArcadeState }
  | { type: 'rematch'; want: boolean }
  | { type: 'forfeit' };
export const MAX_INPUTS_PER_MSG = 64;
export function packInput(i: PlayerInput): number;     // 0..71
export function unpackInput(n: number): PlayerInput;
export function parseArcadeMsg(raw: unknown): ArcadeMsg | null;
export const ARCADE_CODEC: Codec<ArcadeMsg>;
export const ARCADE_RTC: RtcProtocol<ArcadeMsg>;
```

- [ ] `vite.config.ts` sets `process.env.VITE_BUILD_ID ??=` the short git hash (else 'dev').
- [ ] Tests: each message round-trips; bad codes/ticks/lengths/configs dropped; names sanitized; look clamped; a structurally bad state dropped.

### Task 4: Rollback engine

**Files:** Create `src/arcade/game/rollback.ts`; Test `tests/arcade/rollback.test.ts`.

**Interfaces (produces):**

```ts
export const NET = { inputDelay: 2, maxPredict: 15, sumEvery: 60, keepTicks: 600 } as const;
export class Rollback {
  constructor(state: ArcadeState, local: PlayerId);
  readonly state: ArcadeState;            // the live (predicted) state
  get tick(): number;
  get lastRemote(): number;               // 0 before any remote input
  get confirmed(): number;                // min(lastRemote, tick)
  canStep(): boolean;                     // tick + 1 − lastRemote ≤ maxPredict, and the match is not finished
  step(local: PlayerInput): ArcadeEvent[];             // simulates tick+1; `local` is this side's input for tick+1+inputDelay
  takeLocal(): { first: number; inputs: PlayerInput[] } | null; // local inputs not yet sent
  receive(first: number, inputs: PlayerInput[]): ArcadeEvent[] | null; // null: not contiguous (ignored)
  takeSums(): { tick: number; hash: number }[];        // confirmed checkpoint hashes not yet taken
  checkSum(tick: number, hash: number): boolean | null; // false on mismatch; null when ours is not known yet
  confirmedState(): { tick: number; state: ArcadeState };
  adopt(tick: number, state: ArcadeState): ArcadeEvent[];
  readonly stats: { rollbacks: number; maxDepth: number; resimTicks: number };
}
export function stateHash(s: Readonly<ArcadeState>): number; // FNV-1a 32 over JSON
```

- [ ] Tests (Review Focus 1): late/odd-batch remote inputs → identical to plain `step()`; no invented press; stall at 15; bounded snapshots; event dedup; hashes; adopt.

### Task 5: Time sync

**Files:** Create `src/arcade/game/timeSync.ts`; Test `tests/arcade/timeSync.test.ts`.

```ts
export class TimeSync {
  /** This side's advantage now, to send: tick − (lastRemote − inputDelay). */
  static advantage(tick: number, lastRemote: number): number;
  /** Notes both advantages (on each received input message). */
  note(local: number, remote: number): void;
  /** The clock rate to run at: 0.9 while more than 1 tick ahead (until under 0.5), else 1. */
  rate(): number;
  get ahead(): number;
}
```

### Task 6: Online session

**Files:** Create `src/arcade/game/onlineSession.ts`, `src/arcade/game/lag.ts`; Modify `src/arcade/game/session.ts` (ArcadeOverlay gains `net?`); Test `tests/arcade/onlineSession.test.ts`.

- `ArcadeOnlineSession` (host or guest) on a `Transport<ArcadeMsg>`: `frame(dt)`, `pump()` (also on its ticker), `view`, `over`, `result`, `pause()`/`resume()` (no-ops), `forfeit()`, `rematch()`, `leave()`, `dispose()`, `endReason`, `opponentGone`, `forfeitBy`, `viewer`, `netStats()`.
- Tests at 0/40/120 ms one way with jitter, two CPU-driven sides: identical final states equal to a replay of the confirmed inputs; Review Focus 2, 4, 5; desync repair.

### Task 7: Arcade UI

**Files:** Create `src/arcade/ui/online.ts`; Modify `src/arcade/ui/app.ts`, `context.ts`, `screens/mainMenu.ts`, `screens/pause.ts`, `screens/results.ts`, `src/arcade/render/hud.ts`, `src/arcade/audio/director.ts` (viewer), `src/arcade/game/debug.ts` (`net()`, `?lag=`); Tests in `tests/arcade/ui/`.

### Task 8: Browser run

**Files:** Create `scripts/arcadeOnline.mjs` (two pages, host + invite-link join, Ready, scripted play from both ends with `?lag=60`, no console errors, no desync, same score, screenshots of both views in `artifacts/arcade-online/`).

### Task 9: Docs, verification, release

- README (Arcade: online), arcade spec §1.1/§8 pointer to the online spec, How to Play line, memory.
- Full verification: typecheck, `npm test`, build, `npm run e2e`, `node scripts/arcadeRun.mjs`, `node scripts/arcadeOnline.mjs`, `BBT_SIM=1` balance unaffected.
- Final whole-branch review on the most capable model; fix; merge to main; push; check the live page.
