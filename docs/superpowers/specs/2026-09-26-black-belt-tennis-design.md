# Black Belt Tennis — Design Spec (v2)

Date: 2026-09-26 · Source: `design.txt` + decisions agreed in chat · v2 incorporates a 5-lens
adversarial review (fidelity, balance simulation, netcode, implementer gaps, art/UX).

## 1. Intent

A browser game where a tennis match is decided by keyboard typing skill. Retro, high-fidelity pixel
art (16-bit console feel). Play vs a CPU opponent or an online friend (host shares a game code,
friend joins). Static site deployable to both GitHub Pages and itch.io.

Success criteria:
- A full tennis match (real scoring) is playable start-to-finish vs CPU and online.
- Serve and rally loops behave as in §3; difficulty → placement, typing speed → ball speed,
  typos → error risk, harder placement → harder to return.
- Points feel like tennis: equal players get short rallies (median 3–6 shots, 10–35 s per point).
- Looks like a polished retro console game: animated pixel-art players, court, crowd, umpire,
  effects, crisp bitmap text. Readable for colour-blind players.
- Current desktop Chrome, Edge, Firefox with a physical keyboard. Mobile is out of scope.

### 1.1 Decisions agreed with the user
| Topic | Decision |
|---|---|
| Chase word | The returner types the **exact word the striker just hit with**. |
| Typos | **Strict cursor**: a wrong key does not advance, counts against accuracy and costs time; no backspace. |
| Stack | **TypeScript + Vite + Vitest**, static build. |
| Modes | **vs CPU** and **online host/join** (+ Training, an onboarding mode vs a scripted CPU). No same-keyboard 2P. |
| Hosting | One build works on GitHub Pages (auto-deploy) and itch.io (zip). Trade-offs in §8. |
| Online timing | **Turn-based, no lag compensation.** Every turn is timed on the acting player's own machine, starting when the turn's state is on their screen. The passive player watches a slightly delayed playback, with the hand-off gap hidden by a subtle slow-motion as the ball leaves the racket (§5.3). |

### 1.2 Assumptions (ours, not in design.txt)
- Exactly one player types at any moment; turns alternate.
- The three offered words (four with the insane word at a full power meter) start with **different
  letters that are not adjacent on US QWERTY**; the first matching keystroke **locks** that option.
  (amended: power-meter spec 2026-09-27)
- Only letters a–z are game keys; everything else is ignored without penalty (Space tosses in
  PRE_SERVE). Input is case-insensitive.
- Players never change ends. Each client renders its own player at the bottom (near side).
- All art is produced in code. No external images/audio. Fonts are bundled OFL fonts via npm.
  The only runtime third-party dependency is the PeerJS broker (online play only).

## 2. Glossary
- **Striker / receiver**: player hitting the current shot / player the ball travels to.
- **Prompt**: words shown to the active typist, with a monotonically increasing `promptId`.
  **Single prompt** = 1 word (chase word). **Choice prompt** = 3 words (easy/medium/hard), plus a
  4th, insane, word while the owner's power meter is full (amended: power-meter spec 2026-09-27).
- **Lock**: typing the first letter of one option of a choice prompt.
- **Slip**: a maximal run of consecutive wrong keys (one blocked cursor event).
- **Pace**: global time multiplier (§3.9). **cps**: chars/s; WPM = cps × 12.
- **Tier / d**: easy, medium, hard, insane (amended: power-meter spec 2026-09-27).
- **Power meter**: per player, 0–4. Each serve or choice word struck with no wrong key adds 1; any
  wrong key, or a lost point, empties it; at 4 the insane word is offered. Always 0 and hidden in
  Training (power-meter spec 2026-09-27 §4).

## 3. Gameplay

### 3.0 Geometry (metres; all positions cosmetic unless stated)
- Origin at the net centre on the ground; **+x** is to the right as seen from end 0; **end 0**
  baseline at y = −11.885, **end 1** baseline at y = +11.885; z up.
- Singles half-width 4.115, doubles half-width 5.485, service lines y = ±6.40, net height 0.914 at
  the centre and 1.07 at the posts (x = ±6.40).
- A player at end e has sign `s = +1` (end 0) or `−1` (end 1); the player's "right" is `s·x`; their
  baseline is `y = −s·11.885`. Deuce side = the player's right half.
- Server stands at `(σ·s·0.8, −s·12.3)` with σ = +1 on the deuce side, −1 on the ad side.
  Receiver stands at `(σ·s_r·3.0, −s_r·12.5)` (s_r = receiver sign, σ as the server's side).
- Nothing about positions/distances/surface affects outcomes; gameplay depends only on §3.4–3.6.
- No position is ever more than 1.2 m behind a baseline or beyond |x| = 5.8.

### 3.1 Turns and state machine
A **turn** is a span in which exactly one player (the **owner**) can act, and all of its times are
measured on a single **turn clock τ** (ms, starting at 0) that belongs to the owner (§5.3):
- **Serve turn** (owner = server): lead-in (INTRO coin toss, or the preceding FAULT_CALL /
  POINT_CALL banner) → PRE_SERVE → TOSS (→ CATCH → PRE_SERVE …) until the serve is struck or a
  fault is decided in the server's turn (ball dropped, time violation).
- **Return turn** (owner = receiver): from the strike (τ = 0 when the ball leaves the opponent's
  racket) until the receiver's own strike, the ball passing (miss), or an OUT/NET call.
- The next turn begins, for its owner, at the end moment of the previous turn. Every deadline in
  this spec (serve clock, tooLow, contact T, grace, call times) is expressed in the turn's τ.

| State | Entry / behaviour | Exits |
|---|---|---|
| INTRO | Coin toss, 2.5 s, not skippable (§3.7). | → PRE_SERVE(serveNo=1) |
| PRE_SERVE | Players placed at serve/receive spots. Serve words + targets for the next toss are **pre-picked** (hidden). Serve clock runs. CPU server tosses after 0.6–1.2 s. Human: Space. | Space → TOSS; clock hits 0 → FAULT_CALL("Time violation") |
| TOSS | Ball tossed; serve prompt revealed to the server. Space ignored. | word completed at t ≤ tooLow → RALLY (serve struck at completion t); at tooLow: a word locked → FAULT_CALL("Ball dropped"), nothing locked → CATCH |
| CATCH | Server catches the ball, 0.5 s. New serve words pre-picked (never any of the previous toss's three). | → PRE_SERVE (same serveNo; clock keeps running) |
| RALLY | Ball in flight; receiver sub-state `NONE → CHASE → CHOICE → QUEUED` runs concurrently with the flight (§3.3). | shot resolves → next RALLY leg; out/net/miss → POINT_CALL; serve out/net → FAULT_CALL |
| FAULT_CALL | "FAULT" (+reason) shown 1.5 s. | serveNo 1 → PRE_SERVE(2), clock reset to 30 s; serveNo 2 → POINT_CALL("DOUBLE FAULT") |
| POINT_CALL | Call banner; score updates. 2.0 s (+1.5 s if a game ended, +1.0 s if a set ended). | → PRE_SERVE(1) or MATCH_OVER |
| MATCH_OVER | 3.0 s celebration. | → Results screen |

In INTRO, CATCH, FAULT_CALL, POINT_CALL and MATCH_OVER all letter/toss inputs are dropped.
Keys from a player who is not the active typist are always dropped: never errors, never buffered
(the client shows a small "WAIT" tag above its own player for 300 ms, at most once per second).

### 3.2 Serve
1. Server stands on the deuce side when the point count of the current game (or tiebreak) is
   even, ad side when odd. The **serve clock** (30.0 s) runs during PRE_SERVE, TOSS and CATCH and
   is visible to both players. It resets to 30.0 s for the second serve and for every new point.
2. Server presses **Space** (only in PRE_SERVE) to toss. The three pre-picked serve words appear
   above the server; small tier-coded target markers appear in the service box. **In every mode
   the serve words and markers are visible only to a local human server** (§4.2 describes what the
   opponent sees). Attract mode shows everything.
3. Toss timeline: `a = 1.93 s × pace` (apex; tuned by the balance simulation), tooLow = `2a`. Ball height
   `z(t) = 1.8 + 1.4·(1 − ((t − a)/a)²)`. A serve turn whose server's power meter is full when it is
   created uses `a = 1.93 s × 1.2 × pace` (the power toss, so the 12–15-letter insane word can fit),
   carried in the turn's start data (amended: power-meter spec 2026-09-27).
4. Outcomes:
   - Word completed at `t ≤ 2a` → strike at t. **Contact factor** = 1.0 if `t ≤ a`, falling
     linearly to 0.85 at `2a`. The serve's launch height z0 = z(t).
   - A word locked but not completed by `2a` → FAULT ("Ball dropped").
   - No word locked by `2a` → CATCH (re-toss allowed with new words).
   - Serve clock reaches 0 in PRE_SERVE/CATCH → FAULT ("Time violation"). If it reaches 0 during
     TOSS, the toss plays out: a completed word strikes normally; a catch becomes FAULT
     ("Time violation"); a locked unfinished word → FAULT ("Ball dropped").
   - Strike resolved as OUT or NET (§3.5) → FAULT, called per §3.3 timing.
5. Two faults on the same point → DOUBLE FAULT, point to the receiver.
6. **Serve targets** in the correct diagonal service box, in box coordinates `(a, b)` =
   (distance from the centre service line toward the box's sideline, distance from the net);
   box width 4.115, depth 6.40:
   - easy: `(2.06, 4.20)`
   - hard: T `(0.40, 6.00)` or wide `(3.715, 6.00)`, 50/50
   - medium: on the opposite half of the box from hard: `(3.115, 5.40)` if hard is T,
     `(1.00, 5.40)` if hard is wide.
   - insane (full power meter only): the corner of medium's half, 0.15 m inside the lines:
     `(3.965, 6.25)` if hard is T, `(0.15, 6.25)` if hard is wide (amended: power-meter spec
     2026-09-27).
   World mapping for receiver sign `s_r` and side σ: `x = s_r·σ·a`, `y = −s_r·b`.

### 3.3 Return turn (τ = 0 when the ball leaves the striker's racket)
1. Every strike — including one already resolved as OUT or NET — immediately starts the
   receiver's **CHASE** prompt (single prompt = the striker's exact word), so outcomes are never
   revealed early. For a serve, the chase word becomes visible to the receiver only at this moment.
2. Typing the chase word moves the receiver: `feetTarget = lerp(start, inPosition,
   easeOutQuad(correctKeys/len))`; the sprite moves toward it at up to 7 m/s (§3.4 geometry).
3. When the chase word completes, the **CHOICE** prompt appears (its words and targets were
   pre-picked with the return turn's start data): three words (a fourth, insane, one while the
   receiver's power meter is still full: pre-picked at a full meter, dropped if a wrong key in the
   chase emptied it) on the **opponent's half**, visible to both players with live
   typing progress (§4.2 layout). Targets are on the destination half, with `a` = lateral offset
   positive toward the destination player's right and `b` = distance from the net; world
   `x = s_dest·a`, `y = −s_dest·b`; `m = ±1` random:
   - easy `(0, 8.885)` (3.0 m inside the baseline)
   - medium `(m·2.865, 9.385)` (1.25 m inside the sideline, 2.5 m inside the baseline)
   - hard `(−m·3.615, 11.385)` (0.5 m inside the sideline and the baseline; opposite side to medium)
   - insane `(m·3.965, 11.735)` (0.15 m inside the sideline and the baseline, medium's side; amended:
     power-meter spec 2026-09-27)
4. The ball reaches the receiver's contact point at `τ = T` (§3.4).
   - Both words completed before `T` → **QUEUED**: the shot is resolved immediately (§3.5); the
     strike (and the end of the turn) happens at `τ = T` when the ball arrives (no volleys, no
     early swings).
   - Completed in `(T, T + grace]` → **stretch shot**, struck at completion time.
   - Not completed by `T + grace` → the ball passes → point to the striker: **ACE** if the
     chased shot was a serve and the chase word was never completed, otherwise **WINNER**.
5. **OUT / NET timing**: a NET ball flies to the net plane and drops; the call ("NET", or "FAULT"
   on a serve) is made when it reaches the net plane. An OUT ball is called at its bounce
   (`τ = 0.6T`). At the call, the active prompt is cleared and the receiver's typing so far is
   discarded (not counted in stats). A rally OUT/NET is a point to the receiver and an **error**
   for the striker.

### 3.4 Timing and trajectory
Pace multiplies exactly: toss apex/tooLow, T and grace. It does **not** scale the serve clock,
CPU toss delay, reaction/key intervals, call/banner durations, lag compensation, v or km/h.

- **Typing speed** for a completed word of n letters (n ≥ 2; amended: power-meter spec 2026-09-27):
  `cps = (n − 1) / max(0.05 s, tLast − tFirst)`, tFirst = first correct key (the lock key for a
  choice), tLast = final correct key; wrong-key/correction time inside the word is included.
- **Speed factor** `v = clamp(0.875 + 0.025·(cps − 3), 0.80, 1.30)` (tuned by the balance
  simulation; a playtest knob), clamped once; then serves ×
  contact factor, stretch shots × 0.9 (no re-clamp).
- **Flight to contact**:
  `T = pace × (2.2 s + 0.10 s × len(chaseWord)) / v × place[d] × P(n)`
  plus `(0.25 s + 0.75 s × pace)` when the chased shot is a serve (reading allowance: the receiver
  has never seen a serve word).
  - **Rally pressure** `P(n) = max(0.65, 0.93^⌊n/2⌋)` (was `0.85^⌊n/2⌋` with no floor; amended:
    power-meter spec 2026-09-27), computed by repeated multiplication.
  - `place` = easy 1.00, medium 0.85, hard 0.70, insane 0.55 for rally shots; 1.00 for easy, medium
    and hard serves, 0.75 for an insane serve (amended: power-meter spec 2026-09-27).
  - `n` = number of rally strikes after the serve before the chased one (return of serve n = 0,
    server's first chase n = 1, then 2, 3 …), so both players face the same pressure at each
    exchange depth.
- **Grace** = `0.4 s × pace`.
- **Displayed speed** (flavour): `km/h = round(95 × v × {1.00, 1.05, 1.10, 1.20}[d] / P(n))`,
  × 1.25 for serves (amended: power-meter spec 2026-09-27).
- **Ball path** (analytic; renderers evaluate it, never integrate):
  - Pre-bounce: horizontal linear from strike point P0 to landing L over `0.6T`;
    `z(u) = z0·(1 − u) + 4h·u·(1 − u)`, `u = t/(0.6T)`, h = 2.0/1.7/1.4/1.2 m for easy/medium/hard/insane
    rally shots and 0.9 m for serves, raised if needed so z ≥ 1.3 m at the net plane for non-NET
    shots. Rally z0 = 1.0 m.
  - Post-bounce: continues in the same horizontal direction for 3.0 m over `0.4T`,
    `z(u) = u + 2.4·u·(1 − u)`, ending at contact point **C** at z = 1.0 m. C is clamped to ≤ 1.2 m
    behind the baseline and |x| ≤ 5.8.
  - NET shot: follows its arc to the net plane at z = 0.6 m, then drops back on the striker's side
    over 0.4 s.
  - Stretch: the ball keeps its post-bounce horizontal velocity past C; z falls linearly from 1.0 to
    0.3 m across the grace window; the strike point is the ball position at completion.
- **Positioning**: all players are right-handed. Forehand if C is on the player's right of their
  position at CHASE start, otherwise backhand. "In position" = feet at `C − 0.7·right`
  (forehand) or `C + 0.7·right` (backhand). After striking, the striker jogs toward
  `(0, −s·12.2)` at 4 m/s.

### 3.5 Shot resolution (accuracy) — computed at the strike instant
Inputs: tier d, slips e (on the **shot** word only, capped at 3; chase-word slips only cost time),
stretch flag. Draw order from the match RNG:
1. `pNet = min(0.9, netRate[d] × e + (stretch ? 0.05 : 0))`, netRate = easy 0.01, medium 0.03,
   hard 0.06, insane 0.10. Draw r_net; if `r_net < pNet` → NET.
2. Otherwise draw zx then zy, each `z = (u1 + u2 + u3 + u4 − 2) × √3` (unit variance,
   |z| ≤ 3.46). Landing = target + σ·(zx, zy) with
   `σ = σ0[d] + σe[d] × e + (stretch ? 0.5 : 0)`,
   σ0 = easy 0.10, medium 0.12, hard 0.10, insane 0.04 m; σe = easy 0.25, medium 0.35, hard 0.50,
   insane 0.80 m (insane values: power-meter spec 2026-09-27).
3. OUT if the landing point is outside the singles court (outside the target service box for
   serves). Lines are in.
- Guarantee (unit-tested): with e = 0 and no stretch, no shot of any tier is ever out or net.
- Expected (tested): hard rally shot with e = 1 fails (out+net) 35–55 %; medium with e = 1 ≤ 5 %;
  insane with e = 1 fails 60–85 % (amended: power-meter spec 2026-09-27).

### 3.6 Scoring
Real scoring: 0/15/30/40, deuce/advantage or **golden point** (option; golden point is served from
the side given by the parity rule, receiver has no choice, never applies inside tiebreaks),
games, sets, tiebreak (first to 7, win by 2). Server alternates each game; a tiebreak counts as one
game for alternation (whoever served first in a tiebreak receives first in the next set). In a
tiebreak the first point is served by the player due, then serve alternates every two points;
side parity uses the tiebreak point count.
| Format | Rule |
|---|---|
| Tiebreak | a single tiebreak to 7, win by 2 |
| Short set (default) | first to 4 games, win by 2, tiebreak at 4–4 |
| Full set | first to 6 games, win by 2, tiebreak at 6–6 |
| Best of 3 | best of three short sets; ends as soon as a player wins 2 sets; no match tiebreak |
"MATCH POINT" / "SET POINT" / "BREAK POINT" / "GOLDEN POINT" (40–40 under the golden-point rule)
banners show in PRE_SERVE when applicable.

### 3.7 Coin toss
INTRO: the umpire flips a coin (1.5 s spin above the net), then "<NAME> TO SERVE" (1.0 s). No call,
no choice: winner = player 0 if the first match-RNG draw < 0.5. Repeated on every new match,
restart and rematch.

### 3.8 CPU opponent (belts & stripes)
The CPU is an input source emitting timestamped keystrokes into the same engine as a human.
Levels (15), displayed as a belt with 0–2 stripes; parameters interpolate linearly in WPM between
milestone rows:
| Milestone | WPM | Per-key error | Reaction (s) | Aggression |
|---|---|---|---|---|
| White | 25 | 7 % | 0.90 | 0.20 |
| Yellow | 35 | 5.5 % | 0.80 | 0.35 |
| Green | 45 | 4.5 % | 0.70 | 0.50 |
| Brown | 65 | 3 % | 0.55 | 0.65 |
| Black | 90 | 2 % | 0.45 | 0.80 |
| Black II (dan) | 105 | 1.6 % | 0.40 | 0.85 |
| Black III (dan) | 120 | 1.3 % | 0.35 | 0.90 |
Level WPMs: 25, 28, 31 · 35, 38, 41 · 45, 51, 58 · 65, 72, 81 · 90 · 105 · 120.
- Mean interval `I = 12/WPM` s. Per word, a factor `f = clamp(1 + 0.15·z, 0.7, 1.4)` (z as §3.5).
  Each interval = `I·f·(1 + 0.35·(u1 + u2 − 1))`. On hard words each key after the first has a 10 %
  chance of an extra 250–500 ms hesitation.
- Errors: never on the first key of any prompt. Otherwise with the per-key error rate the CPU emits
  a random letter ≠ the expected one, then waits 150–300 ms before the correct key.
- Reaction before the first key: full reaction for serve words, choice prompts and the chase of a
  serve; 0.5 × reaction for a rally chase word (it watched it being typed).
- Choice: `est_i = reaction + len_i·I·(1 + err/(1 − err)) + err·len_i·0.225`. Option i is feasible if
  `est_i ≤ (deadline − now) − 0.25 s` (deadline = T for returns, tooLow for serves; both in turn clock τ). With
  probability = aggression choose the hardest feasible option, otherwise uniform among the other
  feasible options; if none are feasible choose easy. Second serve uses aggression × 0.4. The CPU
  never deliberately re-tosses.
- CPU randomness uses its own RNG seeded from (matchSeed, playerId), never the engine RNG.
- CPU typing is rendered like a human's, except its serve words are hidden from the human (§3.2).

### 3.9 Pace presets
Relaxed ×1.5 (~30 WPM), **Normal ×1.0** (~50 WPM, default), Fast ×0.75 (~70 WPM),
Lightning ×0.6 (~90 WPM).

### 3.10 Words
- Lowercase a–z only. Tiers by length: easy 2–4, medium 5–7, hard 8–11, insane 12–15 (amended:
  power-meter spec 2026-09-27; was easy 3–5, medium 6–9, hard 10–14). Each pack is one word pool,
  split into tiers by length.
- Packs (selectable in Options, vs-CPU setup and the host lobby): **Everyday** (default; common
  English words), **Sports** (vocabulary from many sports), **Dojo** (martial arts), **Mixed**
  (union). Each pack ≥ 120 easy, ≥ 120 medium, ≥ 80 hard, ≥ 60 insane words; no duplicates; no
  offensive words.
- **No misleading words**: no pack contains a word that names a shot, stroke, spin, shot outcome or
  direction (e.g. forehand, backhand, lob, volley, smash, slice, topspin, dropshot, crosscourt, ace,
  left, right, wide, short, deep, long, high, low, middle, corner, line), because a word must never
  contradict where the ball actually goes. A shared blocklist enforces this in tests.
- Picker: one word per tier (insane included at a full power meter) from the seeded match RNG;
  pairwise-distinct initials that are not
  adjacent on US QWERTY (no shared edge or diagonal); none of the last 20 **offered** words (every
  word ever shown or pre-picked, including unchosen options and dropped tosses); a re-toss never
  repeats any of the previous toss's three words.

### 3.11 Stats & progression
Per player per match: points won, aces, double faults, winners, errors (rally OUT/NET; serve faults
excluded), average WPM = `12·Σ(n − 1)/ΣΔt` over completed words, top WPM = max per-word WPM over
words with n ≥ 5, accuracy = correct / (correct + wrong) keys (ignored keys excluded), fastest serve
(km/h), longest rally (in-play strikes incl. the serve).
Career (local only, vs CPU only): matches played/won per level, best WPM. Beating any level earns
its belt colour, stripes and dan grades included (amended 2026-09-27: it was milestone levels only;
wins stored before the change earn their colour on the next load). The vs-CPU belt strip ticks every
beaten level, and Results announce a new belt or else a first win at a striped or dan level ("NEW
STRIPE EARNED: …" / "NEW DAN EARNED: …"). The highest earned belt colours the default headband. All
levels always selectable.

### 3.12 Training (onboarding)
First main-menu item until completed once; offered on first launch. A LocalSession vs a scripted
White-belt CPU with engine flags `{serveClock: false, pace: 1.5, freezeUntilFirstKey: true for the
first prompt of each new kind, fixedWords}`:
1. Serve: "SPACE to toss", type any word; re-toss and fault explained when they happen.
2. Return: "type the word to run to the ball", then "type a first letter to pick a shot —
   harder = wider and riskier".
3. A 3-shot rally with no freezes; stretch shot explained if it occurs.
4. One real point.
Coach text replaces the scoreboard in the HUD band. For a player's first 3 matches: a "SPACE"
keycap above the human server in PRE_SERVE and a "type a first letter" label under the first choice
row of each point. The first vs-CPU setup defaults to White belt, Relaxed pace, Tiebreak format.

## 4. Presentation

### 4.1 Rendering
- Canvas 2D, fixed internal buffer **480 × 270**. Scale computed in **device pixels**:
  `k = floor(min(innerWidth·dpr/480, innerHeight·dpr/270))`. The visible canvas backing store is
  `480k × 270k` device px, CSS size `(480k/dpr) × (270k/dpr)`, placed at whole-device-pixel
  offsets, blitted with `imageSmoothingEnabled = false`. Recompute on resize and on
  `matchMedia('(resolution: <dpr>dppx)')` changes. If `k < 2`, **Fit mode**: nearest-neighbour
  upscale to `ceil(scale)` offscreen, then smooth downscale; show once "Use fullscreen for a
  sharper view". Options → Display: Pixel-perfect (default) / Fit.
- Loop: rAF render; simulation stepping per §5.3.
- **Projection** (after the end-1 viewer rotation `(x, y) → (−x, −y)`, a 180° rotation):
  `d = 1 + (y + 11.885)/23.77`; `screenX = 240 + x·27.35/d`; `screenY = −80 + 320/d − z·27.35/d`.
  (Near doubles baseline 300 px wide at y = 240, far baseline 150 px at y = 80, net at y ≈ 133.)
- **Screen zones**: HUD band y 0–21; far prompt band y 22–38; near-half choice band tops at
  netY + 6; near player's chase plate 4 px above its head.
- **Layers**: backdrop → court → net (mesh as 50 % checker dither, opaque tape/posts) → shadows →
  players/ball and ground rings (depth-sorted together) → effects → court-space UI (leaders, markers;
  always above the net) → plates → HUD → banners.
- **Ball**: 3×3 core + 1 px dark outline (5×5), ground shadow 3×1 dark dash, motion trail when
  fast, bounce puff, clay marks.
- **Players** (rig-built pixel art):
  - Hand-authored palette-indexed part grids: head front/back with hair styles as overlays, torso
    front/back in 3 twist states, shoes, racket at 8 angles.
  - A pose table per frame: root offset, 10 joint points, part variants, racket angle. Limbs drawn
    procedurally as 3 px (upper) / 2 px (lower) segments with a 2-tone ramp, then an automatic 1 px
    silhouette outline pass.
  - Frames composed per look at load into a cached sheet: 48×48 cells, feet anchor (24, 46).
  - Frames per view (near = back view, far = front view): idle 2, run-lateral 6 (other direction
    mirrored while keeping the racket hand), run-toward 4, run-away 4, forehand 4, backhand 4,
    serve 4 (toss, trophy, strike, follow-through), stretch 2, celebrate 2, dejected 2 = 34
    (68 total). Same pixel size near and far (retro convention).
  - Data format: string rows + per-sheet legend mapping characters to semantic slots (outline,
    skin_hi/mid/lo, hair_hi/lo, cloth_hi/mid/lo, …), resolved at load.
- **Scene**: stadium backdrop with procedural crowd (8 body templates × palette swaps × 2-frame
  bob/clap; cheer on points), ad boards with in-game names only, umpire on a chair at the net post
  (3 head-turn frames following the ball), net, court surface.
- **Surfaces** (cosmetic): Hard (blue with green surround), Clay (orange, slide dust + ball marks),
  Grass (mowing stripes), Dojo (wooden planks, tatami surround, lanterns).
- **Palette**: scene/UI master palette ≤ 48 colours with 3–5 shade ramps and dithering for large
  gradients. Characters use a separate ramp table: skin 6, hair 8, cloth 12 (shirt/shorts/
  headband), racket 6; each ramp hi/mid/lo + shared outline.
- **Text**: custom bitmap font at native resolution. Lowercase a–z: 5 px glyph width, x-height 5,
  ascenders to 7, descenders 2 px (g j p q y), 1 px letter gap, cell 6×10. Capitals, digits and
  punctuation share cap height 7. Titles use the same glyphs at 2×. `i`, `l`, `j` differ in ≥ 2
  columns.

### 4.2 Word plates and turn signalling
- **Tier colours** (Okabe–Ito, snapped to palette): easy sky `#56B4E9`, medium yellow `#F0E442`,
  hard vermillion `#D55E00`, insane reddish purple `#CC79A7` (typed shade `#B06FA0`, the re-tinted
  crowd purple). Tier is never shown by colour alone: plates carry 1/2/3 pips (2×2 px) at the left
  edge, or 4 bars (2×1 px) for insane; ground rings are shaped (circle / diamond / 4-point star /
  8-point burst for insane). The insane colour clears CIEDE2000 ≥ 20 from every other tier in
  normal vision but only ≥ 12 under colour-vision deficiency, which only near-white or grey could
  beat (and they would vanish on the court lines). Every court-space UI mark has a 1 px near-black
  outline; plates get a 1 px dark stroke outside the tier outline. (Insane: amended: power-meter
  spec 2026-09-27.)
- **Plate**: dark fill; width `6n + 11` px (incl. pips), height 16; max 101 px (15 letters; was 95).
  Remaining letters near-white (≥ 12:1 vs fill); typed letters in the tier's **typed shade** (a
  muted/darker shade of the tier colour, ≥ 4.5:1 vs fill and clearly darker than the remaining
  letters: luminance ratio remaining/typed ≥ 1.8); next
  letter as an inverse block (fill-coloured glyph on a near-white 6×10 block), no blinking. In
  unlocked options the first letter is an inverse block in the tier colour. After lock, the other
  options fade out.
- **Layout**:
  - Choice plates use three fixed slots in the band of the targeted half, slot centres
    x = 90 / 240 / 390; easy always in the centre slot, medium and hard in the left/right slot on
    their target's side. With the insane option (4 plates) the slot centres are x = 60 / 180 / 300 /
    420, handed out in the order of the targets' screen x, so insane is outermost on medium's side
    (amended: power-meter spec 2026-09-27). Each plate joins its ground ring with a 1 px
    tier-coloured leader (1 px dark outline).
  - Serve plates never cover the toss column (the ball rises above the server's head): near server →
    vertical stack (easy, medium, hard[, insane] top to bottom, 3 px gaps) beside the head on the side toward
    the screen centre; far server → horizontal row in the far band centred on the server's x with a
    ≥ 12 px gap over the server, clamped to x 4–476.
  - Chase plates appear 4 px above the owner's head where it stood when the turn began (they don't follow).
  - **Large words** option: 2× applies only to single prompts and to a locked word (redrawn at 2× in
    place, clamped to x 4–476). Unlocked options stay 1×.
  - Unit test: for every word length of each tier's band (2–15), 3 and 4 options and both target
    sides, no two plates intersect and every plate lies within x 4–476, y 22–266.
- **Timing bar**: 2 px, white, under the slot row until lock then under the locked plate; shows the
  remaining time to tooLow / contact; switches to a 2 px checker pattern in the grace window.
- **Feedback**: red is never used for feedback. Wrong key: plate fill flashes light grey for 80 ms,
  2 px shake (off with Reduce effects) and a buzz.
- **Turn signalling**: local-active plates have the tier outline with a dark halo, inverse cursor
  and timing bar; when the local player becomes the active typist: 2-frame white border pop + a
  "your turn" tick; a pulsing ring under the local player's feet while active. Remote plates: grey
  outline, 70 % fill opacity, no cursor, no timing bar, a 3-letter name chip in the opponent's belt
  colour, typed letters in the tier's typed shade (belt colours are unreadable on the plate).
- **Opponent serve plates** (vs CPU and online alike): true word width (length is public), tier
  colour + pips, one dim dot per letter; each typed letter becomes a 3×5 block in the tier colour;
  wrong-key shake shown; after lock the other two fade. At the strike frame the locked plate
  reveals its word with a 4-frame flip, on the same frame the receiver's chase prompt appears.

### 4.3 HUD
TV-style scoreboard (top-left, x 2–150): names, belt colour, sets, games, points, serve dot. Serve
clock top-centre during serves. Shot speed / last-word WPM (option) on the right. Call banners:
FAULT, DOUBLE FAULT, OUT, NET, ACE!, WINNER, DEUCE, ADVANTAGE, GAME, SET, MATCH POINT, etc.
On-screen pause icon (clickable). **Power meters** (amended: power-meter spec 2026-09-27): four 3×5
segments right of each scoreboard row (x ≤ 170), lit in the insane colour, pulsing every 400 ms at
a full meter (steady with Reduce effects), hidden in Training; the turn owner's meter follows its
typing live, so a wrong key empties it on screen at once. An insane shot leaves a short purple
trail (off with Reduce effects).

### 4.4 Audio (WebAudio, synthesized; no files)
Racket hit, bounce (surface-dependent), net cord, key click, error buzz, lock tick, word-complete
chime, "your turn" tick, crowd murmur loop + applause / "ooh" swells, procedural chiptune title
theme. Power meter (amended: power-meter spec 2026-09-27): a rising 3-note cue when a meter fills,
a soft falling sweep when a full one empties (the opponent's quieter); an insane strike plays the
hard hit and the crowd "ooh". Volumes: master / music / sfx. The AudioContext is created/resumed on the start-gate click.
**Umpire voice** via `speechSynthesis` (toggle): choose a voice after `voiceschanged`, preferring
`lang` en* with `localService === true` (none → option disabled); `cancel()` before every
`speak()`; drop calls whose event is > 800 ms old; speak words, not digits ("Fifteen love",
"Deuce", "Advantage <name>", "Game, <name>", "Fault", "Double fault", "Out"); volume = master × sfx;
never in attract mode or before the start gate.

### 4.5 Keyboard rules
During a match, `keydown` is handled on `window` in the capture phase:
- F1–F12 are never captured or prevented (browser reload, fullscreen and dev tools keep working).
- Ignored (no effect, no error): `event.repeat`; `isComposing` or key ∈ {Process, Dead,
  Unidentified}; any Ctrl/Meta/Alt combination; keys with `key.length !== 1` except Space;
  every non-letter printable key; any key while a DOM text input is focused or a menu is open.
- Letter: `event.key.toLowerCase()` if it is a–z; else, if `event.key` is a letter of another script
  (`/\p{L}/u`) and `event.code` matches `/^Key([A-Z])$/`, use that code letter (hint "Non-Latin
  layout detected" once per match).
- Space: toss in PRE_SERVE (local human server); ignored otherwise.
- `preventDefault()` on every handled or ignored non-Ctrl/Meta keydown (stops page scroll,
  Firefox quick-find on ' and /, and the Windows Alt menu); never on Ctrl/Meta combinations.
- Timestamp = `event.timeStamp` converted to the owner's turn clock τ (§5.2).
- On match start and whenever a menu closes: blur `document.activeElement`, focus the game root
  (`tabindex=-1`), so Space never re-activates a button.
- Esc, Tab or the pause icon open the in-match menu (in fullscreen, the first Esc exits fullscreen).

### 4.6 Screens (HTML/CSS overlay, pixel-styled; keyboard + mouse)
- The DOM overlay defines `--u = cssW / 480` CSS px (one game pixel; equals k/dpr in pixel mode and
  stays correct in fit mode); overlay sizes are multiples of
  `--u`; the pixel font uses `font-size: calc(8 * var(--u))`, titles 16u. `document.fonts.ready` is
  awaited before the first screen.
- **Start gate**: "Click to start" (on top-level pages also "or press any key"). The gesture
  focuses the window, creates the AudioContext and unlocks speech.
- **Title**: logo; attract-mode demo match behind the menu (CPU vs CPU, two random levels from
  Green–Black, random surface, Tiebreak format, Normal pace, new seed each run; restarts 2 s after
  MATCH_OVER; runs only behind Title and Main menu; its sfx/crowd/voice are always muted; never
  reads keys or writes stats).
- **Main menu**: Training (first until completed), Play vs CPU, Play Online (Host / Join),
  Customize, Options, How to Play. Fullscreen button.
- **vs CPU setup**: level (belt + stripes, showing WPM), format, pace, surface, word pack, deuce
  rule → Start. Remembers the last choices with Start focused.
- **Host lobby**: 5-char code (alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, 31 chars) shown at 2×,
  Copy code, Copy invite link (§8); the joined opponent (name, look preview); host edits match
  config (format, pace, surface, word pack, deuce rule), guest sees it read-only; any config change
  clears both Ready flags; start when both are Ready.
- **Join**: code field (trim, uppercase, validate against the alphabet), Connect; status and errors
  (§5.4). `?join=CODE` opens Join with the code filled in and one Connect button; after joining,
  `history.replaceState` removes the parameter.
- **Customize**: name (≤ 12 chars from the bitmap font glyph set), skin ramp, hair style (5) + hair
  ramp, shirt / shorts / headband cloth ramps (headband default = highest earned belt; can be
  turned off), racket ramp; live animated preview in near and far views.
- **Options**: default pace, word pack, deuce rule; volumes; umpire voice; show WPM; large words;
  reduce effects (no shake/flash); display mode.
- **How to Play**: illustrated rules summary + OFL font credits.
- **In-match menu**: vs CPU pauses (Resume / Restart / Quit): while paused, plates, markers and chase
  words are hidden and timers frozen; Resume runs a 3-2-1 countdown (1.5 s, prompts hidden) then
  continues. Restart = new seed and coin toss, same config. Online does not pause (Resume /
  Forfeit). vs CPU also auto-pauses on tab hide and on window blur.
- **Results**: winner banner, score line, stat table, belt earned, Rematch / Menu.

## 5. Architecture

### 5.1 Layers
```
ui/ (DOM screens) ── game/ (sessions, controllers, loop, keyboard) ── core/ (pure, deterministic)
                           │                                              ▲ read-only via redact()
                    render/ + audio/ (consume PublicState + events) ──────┘
                           │
                        net/ (transport, protocol)
```
- **core/** — no DOM, no timers, no `Math.random`, no `Date`. Modules: `rng`, `words`
  (lists + picker), `typing` (prompt, lock, strict cursor, slips, stats, key classification),
  `court` (geometry, in/out, targets), `trajectory`, `shot`, `scoring`, `cpu` (keystroke planner),
  `turn` (TurnRunner), `engine` (match orchestration), `redact`, `tuning` (all constants, with the
  balance targets of §6 in comments), `types`.
- **TurnRunner** (`core/turn`): a pure, self-contained simulator of one turn. It is created from
  the turn's **start data**, which holds everything the turn needs, so it never touches the RNG:
  owner, kind, prompt words (serve words plus one spare re-toss set; or chase word + pre-picked
  choice words and targets), all deadlines in τ, and the **pre-drawn randomness** for the owner's
  upcoming shot (r_net, zx, zy). It consumes `key(k, τ)` / `toss(τ)` inputs and `clock(τ)`
  confirmations, applying inputs and deadlines in τ order (an input with τ ≤ deadline is applied
  before that deadline). It reports typing progress and the outcome (strike {word, tier, slips,
  cps, stretch, τ} → resolved shot via the pure `shot` module; or fault/catch/miss/call at τ).
  The engine uses it for the active turn; an online guest runs its own copy for its own turns.
- **Engine API**: `input(player, key, τ)` (key = letter or `toss`; dropped unless `player` owns the
  current turn; a τ below the turn's latest τ is clamped to it) and `clock(player, τ)` (the owner confirms its turn
  clock reached τ; deadlines ≤ τ are processed). A new turn's τ starts at the owner's first
  `clock(owner, 0)`. The engine owns everything between turns: word picking, drawing a turn's
  randomness, scoring, creating the next turn's start data. It emits events stamped with
  `(turnId, τ)`. Same config + seed + input/clock log ⇒ identical result (replayable).
- **State** is a plain JSON-safe object: only finite numbers, strings, booleans, null, arrays and
  plain objects (`null` for "no deadline"; no Infinity/NaN/undefined/Map/Set/Date/classes).
- `redact(state, viewer)` → `PublicState` and `redactEvents(events, viewer)`: remove RNG state,
  picker history and CPU planner state; for a serve prompt whose server is not the viewer, replace
  words with `{tier, len}`, typed letters with a count and strip `char` from that prompt's
  key/lock/complete events until the strike event (which carries the struck word). Renderers only
  ever consume PublicState (viewer = local player; attract mode uses an unredacted "spectator" view).
- **game/**: loop, `LocalSession` (engine + keyboard controller + CPU controller), `HostSession`,
  `GuestSession`, keyboard capture (§4.5).
- **render/**: projection, palette, font, plates/layout, sprite rig + look cache, court/scene
  painters, player animator (pose derived from state), ball, effects, HUD, banners.
- **audio/**: synth voices, event→sound mapping, crowd, speech, music.
- **net/**: `Transport` interface with PeerJS and in-memory loopback (latency/jitter injectable)
  implementations, `protocol` (types + guards), code generation.
- **ui/**: screens, settings/profile/career storage.

### 5.2 Session loops and turn clocks
- A local owner's turn clock is `τ = performance.now() − turnStartLocal` (key inputs use
  `event.timeStamp − turnStartLocal`). `Date.now()` is never used for game timing.
- **Passive playback**: whenever the local viewer does not own the current turn (CPU turn, remote
  turn), the renderer shows the turn at a **playback clock τ_play**. τ_play starts at 0 when the
  turn begins on this machine and advances each frame at rate
  `r = clamp(1 + (τ_c − margin − τ_play) / 500 ms, 0, 1.1)`, but never beyond τ_c, where τ_c is the
  owner's latest confirmed τ and margin = 60 ms (0 for local CPU turns, where τ_c is simply the
  local clock). Everything drawn at τ_play is therefore already known: no prediction, no jumps.
  Remote typing events are shown when τ_play reaches their τ. The local owner's next turn begins
  when τ_play reaches the previous turn's end.
- **LocalSession** (vs CPU, training, attract): both players on one machine; CPU turns are
  clocked from the local clock. Catch-up capped at 250 ms; pauses on visibility hidden or window
  blur (the turn clock is frozen while paused).
- **Online sessions**: the host's engine and both sides' clock confirmations are driven from rAF
  and from a Worker ticker created from a Blob URL (`setInterval(() => postMessage(0), 50)`) for
  the whole online match, so a hidden or throttled tab keeps confirming its clock and processing
  messages. Incoming messages are applied immediately in their handler.
- On returning from hidden/offscreen, a client applies the latest state and drops one-shot FX,
  audio and speech events more than 300 ms old.

### 5.3 Online multiplayer (host-authoritative)
- **Transport**: PeerJS (npm, bundled). Host peer id `bbtennis-<CODE>`. Guest connects with
  `peer.connect(id, { reliable: true, serialization: 'raw' })` with manual `JSON.stringify` /
  validated parse on both ends (PeerJS 'json' mode hard-fails at ~16 KB; default `reliable: false`
  is unordered). Messages over 32 000 UTF-8 bytes are never sent (dropped with a warning). Nobody sends before `conn.on('open')`. ICE servers:
  `[{urls:'stun:stun.l.google.com:19302'}, {urls:['turn:eu-0.turn.peerjs.com:3478',
  'turn:us-0.turn.peerjs.com:3478'], username:'peerjs', credential:'peerjsp'}]`. Broker host/port/
  path/key and ICE list overridable via `VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH`,
  `VITE_PEER_KEY`, `VITE_ICE_SERVERS` (JSON). On `unavailable-id` the host silently regenerates the
  code (≤ 5 tries). On peer `disconnected`: `peer.reconnect()` while in the lobby; ignored in a
  match.
- **Roles**: host = player 0 at end 0; guest = player 1 at end 1. The host runs the only
  **engine** (rules, RNG, word picking, scoring); **the seed never leaves the host**, and the guest
  uses a local RNG for cosmetics only.
- **Turn-based timing (no lag compensation, no clock sync)**: each turn is timed only on its
  owner's machine (§3.1, §5.2). The owner's turn clock starts when the turn's start state is on the
  owner's screen, i.e. when the owner's playback of the previous turn reaches its end. Latency never
  shortens anyone's window, and hosting gives no timing advantage. Each client is trusted for its
  own turn timing (acceptable among friends; inherent to server-less P2P).
- **Guest-owned turns**: the host sends the turn's start data (§5.1 TurnRunner) as soon as the
  previous turn ends. The guest runs the turn locally in its own TurnRunner: instant feedback,
  its own deadlines, and its own strike resolved immediately (pure `shot` + the pre-drawn
  randomness), so its ball leaves the racket with no network wait. It streams its inputs and clock
  confirmations to the host, whose engine replays them through the same TurnRunner; the host never
  judges a guest deadline with its own clock. Same inputs + same τ ⇒ same outcome on both machines.
  If the host's result ever differs from the guest's local result, the host's wins (logged as a
  desync; covered by tests so it doesn't happen).
- **Host-owned turns**: the host's engine runs the turn from the host's local clock; the guest
  watches the playback.
- **Re-toss words**: serve start data holds the current serve words and one spare re-toss set.
  When a CATCH consumes the spare, the host appends a new spare immediately. If a spare hasn't
  arrived when the guest presses Space (only possible with > 4 s latency), the toss waits for it.
- **Passive playback (the illusion)**: the non-owner sees the owner's turn at τ_play (§5.2), about
  half a round trip behind. After the viewer's own strike, the opponent's first confirmation
  arrives one round trip later, so τ_play starts at 0 and runs slower than real time until it
  settles just behind the confirmed τ. The ball leaves the racket in a subtle slow-motion that
  absorbs 50–200 ms over a 2–5 s flight. If confirmations stall, τ_play holds (ball frozen) and
  after 1 s "Connection unstable…" is shown.
- **Messages** (all validated by type guards in `net/protocol.ts`; unknown/invalid/> 32 KB dropped;
  names clamped to 12 font glyphs, others → `?`; look indices clamped; rendered only via bitmap
  font or `textContent`; guest inputs beyond 30/s ignored):
  - `hello{proto, app, name, look}` → `welcome{proto, hostProfile, config}` or
    `reject{reason: 'version'|'full'|'in-match', proto, app}` (then close with flush / after 500 ms).
  - `lobby{config, ready: [host, guest]}` (host → guest on any change); `ready{on}` (guest).
  - `start{config, hostProfile, guestProfile}`.
  - `input{seq, turn, k, τ}` (guest → host, own turns only; k = letter | `toss`) and
    `clock{turn, τ}` (guest → host every 50 ms during its own turn, and immediately at a deadline).
  - `frame{turn, τ, ev?, s?}` (host → guest): `s = redact(state, guest)`; `ev = redactEvents(…)`
    stamped with (turn, τ). `s` is included only when the state changed (events, a new turn, spare
    re-toss words); otherwise the frame is a tiny confirmation carrying just `turn` and `τ`. During
    host-owned turns τ is the host's confirmed turn clock (a frame every 50 ms and with every event);
    during guest-owned turns frames carry host-side updates and the host's echo of the guest's outcome.
    State-carrying frames without events are skipped while `bufferedAmount > 16 KB`; confirmations
    are never skipped.
  - `ping{id}` / `pong{id}` (every 2 s; RTT shown in the lobby and HUD corner); `rematch{want}`;
    `forfeit`; `leave`.
  - `proto` is an integer checked in hello/welcome only; bumped on any change to protocol,
    PublicState, TurnRunner or key classification. Mismatch text: "Versions differ (host vA,
    you vB) — reload with Ctrl+Shift+R". It is **2** since the power meter (PublicState `v: 2`
    carries `power: [number, number]`, each clamped to 0–4 on receipt; the guest's scoreboard
    snapshot per displayed turn includes it; amended: power-meter spec 2026-09-27).
- **Secrecy**: `redact` sends serve words (and the spare set) and a turn's pre-drawn randomness only
  to that turn's owner; choice words are public. Stale inputs (turn ≠ current turn) are dropped
  silently.
- **Heartbeat**: any message counts as liveness. 3 s silence → "Connection unstable…" banner (host
  keeps simulating); 8 s → end the match "Opponent disconnected" (not recorded). `pagehide` sends
  `leave`; `beforeunload` confirmation during an online match. conn `close`/`error` → immediate
  disconnect.
- **Rematch**: each side's button sends `rematch{want:true}` and shows "Waiting for opponent…";
  when the host has both, it starts a new match with a fresh seed and coin toss. Menu sends
  `leave`; the other side's Rematch becomes disabled ("Opponent left"). Forfeit → both see Results
  with "<NAME> FORFEITS". Online matches never touch career stats.

### 5.4 Error handling
- Storage: all keys prefixed `bbtennis:v1:`, versioned, try/catch; failures fall back to defaults
  and show once "Progress can't be saved in this browser mode".
- Audio/speech failures mute silently.
- Network errors (peer.on('error') types): `peer-unavailable` → "No game with code X";
  `network`/`socket-error`/`socket-closed`/`server-error` → "Can't reach the connection server";
  `browser-incompatible`/`webrtc` → "Your browser has WebRTC disabled"; broker reachable but no
  `open` within 20 s → "Couldn't connect directly (firewall/NAT) — try another network"; status
  "Still connecting…" after 5 s. Every error has Retry/Back.
- Window blur during online play → "Click to focus — your keys aren't reaching the game" overlay.

## 6. Quality & testing
- **Unit (Vitest)** for every core module: scoring (all formats, deuce/advantage/golden point,
  tiebreak rotation and sides, set/match ends, banner flags), typing (lock, strict cursor, slips,
  cps, key classification), picker (tiers, initials distinct + non-adjacent, 20-word history,
  re-toss), shot (σ, draw order, e = 0 always in, net/out rates, lines in), trajectory (continuity,
  net clearance, clamps), T formula, engine flows with scripted timestamped inputs (fault reasons,
  re-toss/CATCH, serve clock incl. during TOSS, double fault, ace, winner, stretch, queued, OUT/NET
  call timing, dropped off-turn keys, training flags), redact (no serve words leak: across 1,000
  simulated serves, JSON of every guest frame contains none of the not-yet-struck serve words),
  JSON round-trip of state and PublicState, plate layout, palette contrast/CVD checks.
- **Balance simulation** (≥ 5,000 points per cell; human model: interval 12/WPM ± 35 %, 12 %
  per-word variation, error rate 7 % @ 25 → 1.5 % @ 120 WPM, reaction 0.9 → 0.4 s, chase reaction
  0.25 s, "hardest option that fits" policy, insane included). For each preset at its reference WPM
  (Relaxed 30, Normal 50, Fast 70, Lightning 90), equal players: median rally Relaxed 10–14,
  Normal 7–11, Fast 4–7, Lightning 3–5 shots, p90 ≤ 22, no point > 60 shots; aces ≤ 15 % (between
  equal players aces are rare by design; a ≥ 5 % floor proved unreachable under the rules); double
  faults 1–8 %; server wins 55–65 %; ≤ 65 s per point; the equal opponent returns 15–40 % of clean
  insane shots; never-insane wins 40–51 % vs adaptive (amended: power-meter spec 2026-09-27 §7, the
  measured result accepted by the user; was median 3–6, p90 ≤ 12, max 40, DF 1–6 %, ≤ 35 s). Always-easy,
  always-hard and never-hard each win ≤ 53 % of points vs adaptive. CPU aggression 0.8 vs 0.2 at
  equal speed wins ≥ 50 %. At Normal: CPU levels ≥ 2 apart — higher wins ≥ 90 % of short sets;
  adjacent — higher wins ≥ 65 %. Constants in `tuning.ts` may be retuned to meet these; the spec's
  numbers are the starting point.
- **Net tests**: Host/Guest over the loopback transport play full matches driven by scripted
  typists (CPU planners feeding each side's keyboard path):
  - **Latency invariance**: the same seed and the same scripted typists (fixed per-turn timings)
    give an identical point-by-point outcome at 0 ms, 150 ms and 400 ms one-way latency with jitter.
  - The guest's local TurnRunner outcome equals the host's for every guest turn (no desyncs).
  - Passive playback never runs ahead of the confirmed τ and never jumps backwards; after a strike
    it settles within 1.5 s.
  - Redaction: no serve word, spare set or pre-drawn randomness of the other player's turn ever
    appears in a frame sent to the guest.
  - Suspend the host's rAF for 5 s during a guest-owned turn: the turn still resolves on time.
- **Art QA**: `tools/art.html` (dev-only Vite entry) renders at 4× on a checkerboard: every animation
  for 4 look presets (anchor crosshair, frame labels, onion-skin composite), the font atlas with
  "ball", "backhand", "counterpuncher", every plate state, each surface scene at 1× and 3×.
  `npm run art:export` saves PNGs via Playwright (local Chrome) to `artifacts/art/`; they are
  inspected after every art change. Art lint (Vitest): equal row lengths, legend-only characters,
  feet anchor within ±1 px across locomotion frames, outline on every opaque edge pixel, monotonic
  ramps.
- **E2E (Playwright + local Chrome)**: screenshots of every screen and key match moments; an
  automated vs-CPU match typed via a debug hook; a two-page online match via the real PeerJS broker
  (best effort).
- `npm run typecheck`, `npm test`, `npm run build` must pass.

## 7. Delivery
- Scripts: `dev`, `build`, `preview`, `test`, `typecheck`, `art:export`, `e2e`, `package:itch`
  (zips the **contents** of `dist/` so `index.html` is at the zip root).
- Vite `base: './'`.
- `.github/workflows/deploy.yml`: typecheck + test + build on push to `main`, deploy to Pages.
- OFL font licences shipped as `public/licenses/<font>-OFL.txt`.
- README: how to play, dev setup, deploy to Pages and itch.io (incl. `butler push`, itch settings:
  Kind = HTML, embed 960×540, fullscreen button on), hosting trade-offs (§8).

## 8. Hosting trade-offs (answer to design.txt)
| | GitHub Pages | itch.io |
|---|---|---|
| Cost | Free | Free (optional pay-what-you-want) |
| Deploy | Automatic from GitHub Actions on push | Zip upload or `butler push` (versioned channels) |
| Discovery | None — you share the URL | Browse pages, tags, jams, devlogs, comments, ratings |
| Analytics / payments | None | Built-in views/plays analytics; payments/donations |
| Page | Top-level page: focus, fullscreen, clipboard, invite links just work | Cross-origin iframe on your game page: click to focus, Space would scroll the page, clipboard may be blocked, page query strings (invite links) don't reach the game, localStorage shared with other itch games' origin |
| Repo | Free plan requires a public repo | Source can stay private |
Online play works the same on both (browser-to-browser via the PeerJS broker; no game server), and a
Pages player can join an itch host (same protocol and id namespace).
Consequences built into the game: storage key prefix, start gate, `preventDefault` rules, clipboard
fallback (`navigator.clipboard` → `execCommand('copy')` → select + "Press Ctrl+C"), fullscreen
button (no letter hotkeys), and invite links that always point to the Pages build:
`${VITE_PUBLIC_URL}?join=CODE` (button hidden if unset; labelled "Copy browser invite link" inside
an iframe). Recommendation: publish on both — Pages as the canonical link for invites, itch.io for
discovery.

## 9. Out of scope
Mobile/touch, accounts/leaderboards, matchmaking with strangers, spectators, doubles, reconnecting
an interrupted online match, localisation (UI and words are English).
