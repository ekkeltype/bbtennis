# Black Belt Tennis Arcade — Online Play (design)

Status: started 2026-10-23 on the user's request "Re-introduce the multiplayer part", with two answers
from the user (below); the rest are our calls, made to keep the work moving ("work independently").
Builds on the Arcade spec (`2026-10-17-arcade-design.md`, §8 "Online later") and the typing game's
online play (`2026-09-26-black-belt-tennis-design.md` §5.3, §5.4).

## 1. Intent

Two friends play an Arcade match against each other, each in their own browser, the way the typing
game's online mode works: one hosts and gets a 5-character code (or an invite link), the other joins
with it, both press READY, and the match starts. Controls must feel like the vs-CPU game.

### 1.1 Decided by the user (2026-10-23)

| Question | Answer |
|---|---|
| Which multiplayer | **Online with a code**, like the typing game (not same-keyboard) |
| Feel when the connection lags | **Instant controls**: your own moves and shots react at once; the opponent (or a ball they just hit) may jump a little when a late packet corrects it (rollback netcode) |

### 1.2 Our calls (the user may revise after playing)

- **Rollback on the deterministic sim.** Both machines run the same `step()` from the same seed and
  exchange only inputs. The Arcade core was built for this (pure maths, per-player RNG streams; Arcade
  spec §3, §4.7). Spec §8's earlier idea, each machine authoritative for its own player with hits sent
  as `HitEvent`s, is dropped: rollback reuses the stepper as it is, and both machines always agree on
  the score.
- **Input delay 2 ticks (33 ms)** on both sides. That is below what people notice, and on a typical
  connection (round trip under ~70 ms) it hides most of the opponent's corrections.
- **Prediction window 15 ticks (250 ms).** Past that the sim waits for the opponent's inputs.
- No visual smoothing of corrections in this version (fighting-game rollback snaps too); add it if
  playtesting shows ugly jumps.
- **Host = player 0, guest = player 1.** Each sees their own player at the bottom (the guest's court is
  rotated 180°, as in the typing game). The coin toss from the seed decides who serves.
- **Same build only.** The app id in the hello carries the build id (`bbtennis-arcade@<git hash>`); a
  different build is rejected as "Versions differ — both players reload with Ctrl+Shift+R" (the stale
  tab may be the host's), because the two sims must be the same code.
- **No pausing online.** Esc opens a menu (Resume / Forfeit / Fullscreen) while the match goes on, as
  in the typing game.
- **Lobby options**: format, deuce rule, court and pace (the vs-CPU options without the belt); the
  host's lobby starts from the last vs-CPU setup and edits are not stored.
- **Separate codes.** Arcade hosts register as `bbtennis-arcade-<CODE>`, so a typing-game code never
  reaches an Arcade lobby (and the other way round): "No game with code X".
- **Debug lag.** `?debug&lag=<ms>` adds that one-way delay (±25 % jitter) to everything this page
  sends, to try rollback on one machine.

## 2. Goals, non-goals, anti-goals

- **Goal**: a full online match plays smoothly between two browsers on ordinary home connections;
  each player's own controls feel the same as vs CPU; both always see the same score.
- **Goal**: the typing game behaves exactly as before (its full suite stays green).
- **Non-goals (this version)**: spectators, matchmaking or a lobby list, reconnecting after a
  disconnect, chat, same-keyboard play, online stats, smoothing of corrections.
- **Anti-goals**: a match whose two sides disagree on a point (a desync that goes unnoticed); a guest
  whose keys feel laggier than the host's (hosting must give no advantage).

## 3. Netcode

### 3.1 Ticks and inputs

- Ticks are the Arcade's 60 Hz sim ticks (`TICK_HZ`). Each side samples its keyboard once per new
  tick `n` it simulates and records it as its input for tick `n + D` (`D` = input delay, 2); ticks
  `1..D` use no input. The input goes to the other side at once (batched per pump).
- An input packs into an integer 0..71: `(mx+1) + 3·(my+1) + 9·topspin + 18·slice + 36·lob`.
- For a tick whose remote input has not arrived, the sim **predicts** the remote's last received
  input (no input before the first). Held shot keys stay held; a press is an edge, so a prediction
  never invents a press.

### 3.2 Rollback

- Before simulating tick `n` the side keeps a snapshot of the state (`structuredClone`; the state is
  JSON-safe) and the remote input it used.
- When remote inputs for ticks `a..b` arrive (contiguous; the data channel is reliable and ordered),
  the side finds the first simulated tick whose used remote input differs from the true one (ticks
  ≤ b) or from the new prediction (ticks > b), restores the snapshot before it, and re-simulates up
  to its current tick. As a safety net, ticks already known are skipped and inputs past a gap wait
  for it to fill: one late or reordered message must never stop a match. *(Added during the build:
  the debug lag first reordered messages, and strict contiguity froze the match for good.)*
- **Confirmed** tick = min(last remote input tick, current tick): everything up to it is final.
  Snapshots at or before it are dropped.
- **Events** (sounds, effects, banners) are shown when a tick is first simulated. A re-simulation
  shows only events not shown before for that tick: a hit is the same event at the same tick by the
  same hitter (a late change of aim moves the ball but does not sound twice), a bounce or net cord the
  same at the same tick, anything else by its content. An event a correction removes stays heard; the
  state (score, banners, which read the state) corrects itself.
- The sim may run at most `MAX_PREDICT` = 15 ticks past the last remote input. Beyond that it
  **stalls** (the picture holds). After 1 s of stall the HUD says "CONNECTION UNSTABLE...".

### 3.3 Time sync

- Each side sends with its inputs its advantage `adv = currentTick − (lastRemoteInputTick − D)`.
  With latency `L` ticks and this side `X` ticks ahead, `adv_local = X + L` and `adv_remote = −X + L`,
  so `ahead = (adv_local − adv_remote)/2 = X` without knowing `L`.
- Each side averages its last 10 estimates of `ahead` and, beyond half a tick ahead, runs its clock
  slower in proportion: 6 % slower per tick of lead, never below 0.85×. The side behind never speeds
  up. So the two clocks meet without overshooting, and neither side's predictions run longer than the
  other's. *(The first rule, 0.9× until under half a tick, overshot and settled 2 ticks apart at 120 ms;
  the proportional one settles within a tick at every latency tested.)*
- The host's clock starts when it sends `start`, the guest's on receiving it. The host is therefore
  about half a round trip ahead at first, and time sync closes that during the 2 s intro.

### 3.4 Desync detection and recovery

- Every 60 ticks (1 s) each side hashes the confirmed state after that tick (FNV-1a over its JSON) and
  sends `sum{tick, hash}`. Each side compares the other's hash with its own for the same tick.
- On a mismatch, both log `[bbt] desync at tick N`. The host sends its confirmed state
  (`state{tick, s}`; at most once per second); the guest adopts it, re-simulates to its current tick
  with the inputs it has, and play goes on. Tests make sure this never happens in normal play.

### 3.5 Pumping and hidden tabs

- The sim advances by wall time (the scheduler's clock), at most 15 ticks per pump; time beyond that
  is dropped (the other side then waits, and time sync evens things out). It is pumped on every
  animation frame and by a Worker ticker every 16 ms, so a hidden tab keeps playing (its player
  stands still: held keys clear when the page is hidden) and the opponent is not stalled. Back from a
  hidden spell, events more than 300 ms old are not shown (except the current call's, for its banner),
  so the backlog's sparks and cheers are not replayed.
- Messages are handled as they arrive.

### 3.6 The match on both sides

- `start{m, config, seed, players}` (host → guest): match number `m` (1, then +1 per rematch), the
  options, the seed and both players' name and look (`kind` 'human' on both, so the two states are
  identical). Both create the match with `createMatch(config, players, seed)`.
- Inputs, sums and states carry `m`; a message of another match is ignored.
- A played-out match is over 3 s after its last point, as vs CPU (`overHold`). The Results show the
  winner, score and stats.
- **Results show one state on both screens.** A played-out match shows its final state. A forfeit
  (menu) sends `forfeit` with the state after the forfeiting side's confirmed tick; both go to Results
  at once with that state, headed "<NAME> FORFEITS", showing the score so far (the set it stopped in
  too). A forfeit once the match is decided does nothing (its Results are coming). *(Added after the
  final review: Results read each side's own predicted state, and 5 % of forfeits at 120 ms showed
  different scores.)*
- **Rematch**: each Results' REMATCH sends `rematch{want: true}` ("WAITING FOR OPPONENT..."); when the
  host has both, it starts match `m + 1` with a new seed. Menu leaves; the other side's Rematch is
  disabled with "OPPONENT LEFT".
- **Leaving and disconnects** (the typing game's heartbeat, §5.3): a ping every 2 s; 3 s of silence
  shows "CONNECTION UNSTABLE..."; 8 s of silence or a closed connection ends the match ("OPPONENT
  DISCONNECTED"); `leave` ends it ("OPPONENT LEFT"). Results of a match cut short say so in the
  heading, show the player still there as the winner, and show the state after the last tick both
  had confirmed. A match already decided when the opponent goes stays a played-out match ("YOU WIN!"
  with the departure as a note). Page `pagehide` sends `leave`; closing the page during a match asks
  first.
- **A broken or modified opponent** must not wedge the page: every state from the other side is
  checked field by field (§4); adopting one is all or nothing, with a dry run of the next tick; every
  step and receive puts the live state back if the sim throws; and anything the sim cannot run ends
  the match on that side as a lost link (`[bbt] online: the match failed`), telling the opponent.

## 4. Protocol (`src/arcade/net/protocol.ts`)

App id `bbtennis-arcade@<build>` (the build's short git hash, `dev` in tests), protocol version 1,
peer id prefix `bbtennis-arcade-`. Every message is
JSON, validated on receipt (unknown, malformed or > 32 000-byte messages are dropped; names
sanitized, look indices clamped):

| Message | Direction | Fields |
|---|---|---|
| `hello` | guest → host | `proto, app, name, look` |
| `welcome` | host → guest | `proto, hostProfile, config` |
| `reject` | host → guest | `reason: 'version' \| 'full' \| 'in-match', proto, app` |
| `lobby` | host → guest | `config, ready: [host, guest]` |
| `ready` | guest → host | `on` |
| `start` | host → guest | `m, config, seed, players: [host, guest]` (name + look) |
| `in` | both | `m, t` (first tick), `i` (packed inputs, 1..64), `adv` |
| `sum` | both | `m, t, h` (uint32) |
| `state` | host → guest | `m, t, s` (ArcadeState, structurally checked) |
| `ping` / `pong` | both | `id` |
| `rematch` | both | `want` |
| `forfeit` | both | `m, t, s` (the forfeiting side's confirmed state after tick `t`) |
| `leave` | both | — |

`config` is `{ format, deuceRule, surface, pace }`. A state (in `state` and `forfeit`) must be for
the tick its message names, and passes a field-by-field check: every number finite, every player
index 0 or 1, every enum known, every list bounded. Inputs normally continue the sender's sequence
(`t` = last tick + 1); ticks the receiver already has are skipped, inputs past a gap wait for it, and
inputs more than 600 ticks past the receiver's tick are dropped.

## 5. Screens

- **Main menu**: PLAY VS CPU, **PLAY ONLINE** (opens HOST GAME / JOIN GAME, as in the typing game),
  CUSTOMIZE, OPTIONS, HOW TO PLAY, FULLSCREEN.
- **Host lobby / Join** look and behave like the typing game's (code at 2×, Copy code, Copy invite
  link, opponent card with look and READY state, round trip, errors with Retry/Back), with the four
  Arcade options. The invite link is `<VITE_PUBLIC_URL>arcade/?join=CODE`; opening it goes through
  the start gate to Join with the code filled in.
- **Match HUD** adds, online: the round trip (`RTT n MS`, bottom left; the serve speed keeps the
  bottom right), "CONNECTION UNSTABLE..." (bottom centre), and "CLICK TO FOCUS / YOUR KEYS AREN'T
  REACHING THE GAME" after the window loses focus, until a click or the window gets the focus back.
- **How to Play** gets a short ONLINE paragraph (host, send the code or invite link, both play from
  the bottom of their own screen, the match never pauses).
- **Menu** (Esc, Tab, the pause icon): MENU with RESUME / FORFEIT / FULLSCREEN and "THE MATCH GOES ON
  WHILE THIS MENU IS OPEN". Window blur, a hidden tab or leaving fullscreen do not open it online.
- **Results**: as vs CPU, plus the online cases above (forfeit heading, "OPPONENT LEFT" /
  "OPPONENT DISCONNECTED" heading or note, Rematch waiting/disabled).

## 6. Shared code (the typing game behaves the same; its tests stay green)

The typing game's online code is split into game-neutral modules the Arcade can use, and typing
specializations that keep their current exports:

- `net/codec.ts`: `Codec<M>` (encode with byte size, decode with validation), `jsonCodec`, the 32 000-
  byte cap.
- `net/channel.ts`: `Transport<M>`, `TransportListeners<M>`, `loopbackPair<M>` (from `net/transport`).
- `net/rtc.ts`: `hostGame`/`joinGame` over PeerJS for any codec and peer id prefix (from `net/peer`).
- `net/link.ts`: `PeerLink`, `TransportSwitch`, `LobbyLink` for any message type that has ping, pong
  and leave (from `game/onlineLink`).
- `net/lobby.ts`: the host and guest lobby logic (hello / welcome / reject / lobby / ready, hand-over
  at start) for any match config and session type (from `ui/screens/lobby` and `join`).
- `ui/lobbyScreens.ts`: the host lobby and join screens built from a game descriptor (its option
  spinners, read-only rows and session factories), the shared lobby pieces (opponent card, Ready,
  ping, clipboard) and the page guards of an online match (from `ui/screens/lobby`, `join`, `online`).

`net/transport`, `net/peer`, `game/onlineLink` and `ui/screens/online` keep their exports for the
typing game; `ui/screens/lobby` is now the typing game's lobby descriptor, and `ui/screens/join` is
gone (nothing imported its internals). The Arcade boundary test also bans `net/protocol`, `net/transport`,
`net/peer` and `ui/screens/{lobby,join,online}` from the Arcade.

## 7. Testing and verification

- **Protocol**: every message round-trips through the codec; malformed fields, bad input codes and
  oversize messages are dropped; names and looks are sanitized.
- **Rollback engine** (`game/rollback.ts`): with remote inputs delivered late (and in odd batches),
  the final state equals a plain `step()` run with the true inputs, tick for tick; predictions never
  invent a press; the window stalls at 15; snapshots and logs stay bounded; event de-duplication;
  checkpoint hashes; adopting a state.
- **Time sync**: two sides started 20 ticks apart converge to within 1 tick; equal sides never slow.
- **Sessions** over `loopbackPair` with a virtual clock, at 0, 40 and 120 ms one-way latency with
  jitter, two scripted players (the Arcade CPU as each side's "keyboard"): a full match ends with
  both sides' states identical and equal to a plain replay of the confirmed inputs; no desync; a
  stalled link stalls and recovers; forfeit, leave, disconnect (8 s), rematch (new seed, both sides
  restart) and the build check; a deliberately corrupted guest state is detected and repaired.
- **Screens**: the shared lobby tests keep passing for the typing game; the Arcade's host and join
  screens get their own checks (options rows, invite link, hand-off to an Arcade session).
- **Browser** (`node scripts/arcadeOnline.mjs`, best effort over the real PeerJS broker): two Chrome
  pages host and join through the UI (invite link), play scripted points from both ends with
  `?lag=60` on both, and check no console errors, no desync, the same score on both pages, and
  screenshots of both views.
- **Typing game unchanged**: full suite, typecheck, build, `npm run e2e`.
