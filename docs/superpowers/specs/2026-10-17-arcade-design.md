# Black Belt Tennis Arcade — Design Spec (v1)

Status: agreed with the user 2026-10-17 (Parts 1–2 section by section; Parts 3–5 written on the
user's instruction to "write out the remaining designs, then move on to implementation", to be
revisited after playtesting). Working name **Arcade**.

## 1. Intent

A separate browser game, built from this repo's code, in which tennis is played with arcade
controls instead of typing. It shares Black Belt Tennis's pixel art, sound, scoring, menus and (later)
networking, and is published from the same repo at `https://ekkeltype.github.io/bbtennis/arcade/`.

### 1.1 Decisions agreed with the user

| Topic | Decision |
|---|---|
| Product | A separate game; may live under the same URL. Name: **Arcade** (working name) |
| Hosting | Same repo, second Vite entry, served at `/bbtennis/arcade/` |
| Controls | Arcade (Mario Tennis / Virtua Tennis family), keyboard only, desktop browser |
| Swing | Press early, automatic swing; the press-to-contact time nudges angle and cleanness (option C) |
| Modes | v1: vs CPU. Online with a friend comes next; v1 must not block it. *(Online added 2026-10-23: `2026-10-23-arcade-online-design.md`.)* |
| Engine | Shot resolved at contact into a closed-form flight; the player the ball flies toward decides the next hit (approach 1) |
| Carried over | Karate theme and 15-belt CPU ladder; character customization; formats, deuce rules, surfaces, pace presets |
| Later | Career stats/progression, guided Training, online, gamepad, touch |

### 1.2 Assumptions (ours; the user may revise after playtesting)

- Singles only. The human always plays from the near end (bottom of the screen); there are no end
  changes, as in the typing game.
- Same pixel-art camera (480×270 buffer, `render/projection`), same synth sounds, crowd and umpire.
- A How to Play screen in v1 instead of Training.
- Arcade has its own saved data (profile, settings, last CPU setup), separate from the typing game.
- Surfaces stay cosmetic in v1 (as in the typing game).
- No lets, no net-cord balls, no doubles.
- All 15 belts are selectable from the start (progression comes with career stats later).
- **v1 succeeds when** a full match against any belt plays smoothly with responsive controls, a
  newcomer can beat the low belts, Black belt is hard for a good player, and it holds 60 fps on a
  typical laptop.

## 2. Glossary

- **Tick** — one fixed simulation step, 1/60 s. Match time is `tick × 1000 / 60` ms.
- **Flight** — the closed-form path of the ball from a hit (or serve) until it is hit again or dies:
  a list of parabolic segments separated by bounces.
- **Reach zone** — the space around a player in which a committed swing meets the ball.
- **Charge** — 0..1, the time since the shot key was pressed divided by the charge time.
- **Perfect / clean / rushed** — the timing grade of a hit (§4.3).

## 3. Code layout (Part 1)

```
arcade/index.html        second page, built to dist/arcade/
src/arcade/
  core/    pure and deterministic, no DOM/timers/Math.random/Date: tuning, types, flight, shot,
           reach, serve, rules, match (the tick stepper), cpu, belts profile table, stats
  game/    held-key input, LocalSession (vs CPU, attract CPU-vs-CPU), the debug hooks
  render/  ArcadeRenderer (shared painters + its own player animator, HUD bits, effects)
  audio/   ArcadeDirector: arcade events → shared sfx, umpire speech and crowd
  ui/      ArcadeApp, screens: title, main menu, CPU setup, options, How to Play, match, pause,
           results; reuses the shared customize screen
  main.ts
```

**Reused in place (no file moves):** `render/` sprites (rig, parts, poses, animations, sheet), court,
scene (backdrop, net, umpire, crowd), ball painter, projection, palette, color, font, screen;
`audio/` engine, synth, sfx, speech, music; `core/` scoring, court geometry (`COURT`, `endSign`),
rng, util; `ui/` router, dom, controls, icons, preview, boot, overlay, the customize screen;
`game/` loop and clock. Later: `net/`.

**Small shared refactors (the typing game behaves identically; its tests stay green).** A painter
or helper that Arcade needs but that lives in a module that also holds typing logic moves to its
own module; the old module re-exports it, so typing-game imports do not change.
1. `ui/storage`: `createStore(prefix)` returns `{ load, save, storageOk }` for a key prefix; the
   existing exports stay bound to `bbtennis:v1:`. Arcade uses `bbtennis-arcade:v1:`.
2. `core/belts.ts` (new): the 15 ranks (belt, stripes, dan) and their labels move out of
   `core/cpu.ts`. `core/cpu.ts` adds its WPMs on top; `ui/settings.ts` and `render/hud.ts` import the
   ranks from `core/belts` (today `ui/settings` pulls the whole typing CPU in through `CPU_LEVELS`).
3. `render/scoreboard.ts` and `render/banner.ts` (new): the scoreboard painter (over a score and two
   player rows) and the banner painter, extracted from `render/hud.ts`.
4. `render/shadow.ts` (new): the player contact-shadow painter, extracted from `render/world.ts`.
5. `render/ballPaint.ts` (new): `BallView`, `drawBall`, `drawBallShadow`, extracted from
   `render/ball.ts` (which imports the typing turn view).
6. `vite.config.ts`: a second build input `arcade/index.html`. The deploy workflow is unchanged.
7. The customize screen's context needs are met by Arcade's app (a narrow interface if needed).
8. `render/effects`: `Effects` gains public triggers (hit spark, bounce puff + clay mark, run dust,
   shake, crowd cheer, confetti, clear marks) and `advance(dtMs, reduce)`; its typing-driven
   `update(f, poses, dt, reduce)` becomes a thin caller of those. Arcade drives the same triggers from
   its own events.

**Guard test** (`tests/arcade/boundary.test.ts`): no file outside `src/arcade/` imports from
`src/arcade/`; and following runtime imports transitively from every file in `src/arcade/` never
reaches a typing-only module: `core/typing`, `core/words/*`, `core/power`, `core/turn*`,
`core/engine`, `core/cpu`, `core/sim`, `core/redact`, `render/prompts`, `render/plates`,
`render/layout`, `render/leaders`, `render/renderer`, `render/players`, `render/world`,
`render/hud`, `render/ball`, `game/keyboard`, `game/*Session`, `game/training`, `game/onlineLink`,
`ui/keySounds`, `ui/settings` (until refactor 2 lands it is typing-coupled; afterwards it may be
removed from the list), `app`. Type-only imports (`import type`, `{ type X }`) are ignored, so
shared types (`Vec2`, `PlayerId`, `Look`, `PlayerInfo`, `ScoreState`, `FormatId`, …) from
`core/types` are fine.
A second check scans `src/arcade/core/` for `Math.random`, `Date`, `performance`, and the maths
functions that are not correctly rounded across browsers (`sin cos tan asin acos atan atan2 sinh
cosh tanh exp expm1 log log1p log2 log10 pow cbrt hypot`, and `**`): the core uses only `+ − × ÷`,
`Math.sqrt`, `abs min max floor ceil round sign trunc`, so the same inputs give bit-identical results
in every browser (needed for online play).

**Branching:** work happens on the `arcade` branch and merges to main (and so deploys) once a match
vs CPU is playable.

## 4. Gameplay (Part 2)

Coordinates are the typing game's (spec 2026-09-26 §3.0): metres, origin at the net centre, x across,
y along the court, z up; player 0 at end 0 (y < 0), player 1 at end 1 (y > 0). All numbers below are
starting values in `src/arcade/core/tuning.ts`; the balance sim (§7) checks them.

### 4.1 Controls

Both layouts are always active (physical keys, `KeyboardEvent.code`, so WASD works on any layout):

| Action | Left + right hand | Arrows + letters |
|---|---|---|
| Move (8 directions) | `KeyW KeyA KeyS KeyD` | arrow keys |
| Topspin | `KeyJ` | `KeyZ` |
| Slice | `KeyK` | `KeyX` |
| Lob | `KeyL` | `KeyC` |
| Pause | `Escape` | `Escape` |

Directions are screen-relative for the near player: up = toward the net. Held keys are cleared on
window blur and when the match pauses. Every other key is ignored. F-keys and Ctrl/Meta combinations
are never prevented.

**Player input per tick** (the only thing the sim reads from a controller, human or CPU):
`{ mx: −1|0|1, my: −1|0|1, topspin: boolean, slice: boolean, lob: boolean }` — the held state at that
tick, in court-relative terms for the input's player (my = +1 is toward the net). Presses are the
false→true edges, detected by the sim.

### 4.2 Movement

- Top speed 6.0 m/s; acceleration to top speed in 0.15 s; stopping in 0.1 s. Diagonals are normalized.
- While a shot is committed the player is planted (§4.3): the direction keys do not move them.
- Bounds: a player stays on their own half, at least 0.4 m from the net, at most 2.0 m behind the
  baseline (further back, the near player's feet would leave the 270 px screen), and |x| ≤ 6.5 m.
- During the serve set-up the server moves only along x, behind the baseline, between the centre
  mark (0.3 m from it) and the singles sideline on the serving side. The receiver moves freely in its
  half until the serve is struck.

### 4.3 Committing, charging and the automatic swing

- A press of a shot key while the ball is flying toward the player **commits** that shot. A press
  made before that (after the player's own last hit, or during the set-up and toss by the receiver)
  **waits**: the latest one commits on the first tick the ball flies toward the player. Waiting
  presses are forgotten at the player's own hit and when the point or serve ends. Pressing another
  shot key before contact switches the shot type and keeps the charge. *(Revised 2026-10-22 after
  playtesting: early presses were dropped, so a Top Spin player who pressed during the toss never
  swung.)*
- **A commit plants the player** (as in Top Spin): the direction keys no longer move them, only aim
  (§4.5), and they brake at the stopping rate. On the commit tick the sim picks a **step target**:
  the ball's point nearest the player at a reachable height on their half (after the bounce on a
  serve return), then the spot 0.7 m beside it on the player's side of the path (the forehand side
  when on it), at most 1.0 m from where the player stands, inside their bounds. The player takes
  automatic steps toward it at up to 2.5 m/s (slowing over the last 0.25 m). So a press from a good
  spot connects cleanly, and a press from a bad one lets the ball pass: get into position, then
  press. *(Revised 2026-10-22; v1 slowed a committed player to 60 % instead.)*
- The charge grows from the commit: `charge = min(1, (t − tCommit) / chargeMs)`, `chargeMs = 500`.
- **The swing is automatic**: a committed player hits the ball at its closest approach inside their
  reach zone (§4.4): the first tick on which the ball is in the zone and, one tick later, it would be
  no closer (horizontally), out of the zone, or past its second bounce. A player who has not
  committed does not swing; the ball goes by.
- **Timing grade** at contact, from `d = tContact − tCommit`:
  - `d < rushedMs (150)` → **rushed**: power × 0.75, aim pulled 50 % toward the court centre, scatter
    × 1.8.
  - `chargeMs ≤ d ≤ chargeMs + perfectWindowMs (120)` → **perfect**: full power × 1.1, full aim range
    (margin 0.5 m from the lines), scatter × 0.6, a "PERFECT" pop and sound.
  - otherwise → **clean**: power per the charge `0.65 + 0.2 × charge`, normal aim (margin 1.0 m),
    scatter × `1 + 0.5 × (1 − charge)` (a late press is weaker and wilder; revised 2026-10-22).
- **Stretch**: a contact more than 1.0 m sideways from the player's centre → power × 0.85, scatter
  × 1.4, the stretch pose.
- A commit happens only while the ball is flying toward the player (after the opponent's hit or
  serve, until the ball dies). After the hit, the commitment clears.

### 4.4 Reach zone, volleys and smashes

- The ball is reachable by a player when it is on that player's side of the net, moving toward them
  (its y-velocity points to their end), horizontally within **1.4 m** of the player's centre, and at a
  height between **0.15 m** and **2.7 m**.
- Before the bounce the hit is a **volley** — except on the serve return, where the ball must bounce
  first (the receiver's reach is off until the serve bounces).
- A ball higher than **2.0 m** at contact, by a player within 8 m of the net, is an **overhead
  smash** (§4.6 table; aim margin 0.8 m), played with any shot key (the shot type is ignored).
  Further back a high ball is played as the committed shot.
- After its first bounce in the court a ball is reachable until its second bounce.

### 4.5 Aim

The direction held at contact (court-relative) sets the target on the opponent's half:

- x: left/right → toward that sideline, at `singlesHalfWidth − margin`; none → `x = 0`.
- depth (distance from the net, b): up → `halfLength − margin` (deep); none → `halfLength − 2.5 m`;
  down → `serviceLine − 1.0 m` (short). A short slice is the drop shot.
- `margin` comes from the timing grade (§4.3); a rushed hit pulls the target 50 % toward
  `(0, halfLength − 3.5 m)`.
- The lob ignores "down" and aims `halfLength − margin − 0.5 m` deep.

### 4.6 Shots and the flight model

A flight is computed at contact from: contact point `p0` (ball position at contact), the target
landing point `L` (aim + scatter), a flight time to the first bounce `T`, and a shot type that sets
the effective gravity before the bounce and the bounce behaviour. Every segment is a parabola
`p(t) = p0 + v0·t + ½·a·t²` with `a = (0, 0, −g·k)`; `v0` follows from `p0`, `L` and `T`:
`v0 = (L − p0)/T + ½·g·k·T·ẑ` (with `L.z = 0`).

| Shot | Base speed (ground, m/s) | Gravity factor k | Bounce: keep horizontal | Bounce: vertical restitution |
|---|---|---|---|---|
| Topspin | 22 | 1.45 | 0.78 | 0.72 |
| Slice | 17 | 0.80 | 0.62 | 0.48 |
| Lob | 12 | 1.00 | 0.70 | 0.65 |
| Smash | 30 | 1.30 | 0.75 | 0.70 |

- `T = |L − p0|ground / (baseSpeed × power × paceSpeed)`, then clamped so the arc's apex is ≤ 9 m.
  A lob's T is at least 2.0 s at Normal pace (÷ paceSpeed at other paces).
- After a bounce the ball continues with gravity factor 1 and the shot's bounce factors; further
  bounces repeat with restitution 0.6 / keep 0.8; a ball that has bounced twice, or left the court
  surround (|x| > 9 m or |y| > 18 m), is dead.
- Bounce times solve the quadratic `z(t) = 0` (needs only `Math.sqrt`).
- The ball's display height is capped by the painter (as today); the flight itself is not.
- Pace presets scale ball speed (`paceSpeed`): Relaxed 0.75, Normal 1.0, Fast 1.15, Lightning 1.3.
  Player speed does not change.
- km/h shown for serves is the launch speed `|v0| × 3.6`.

### 4.7 Accuracy and errors

- Scatter: `L += σ·(n1, n2)`, with `n1, n2` standard normal from the hitter's RNG (`normalIH`) and
  `σ = 0.35 m × grade factor × stretch factor × (1 + 0.5 × incomingSpeed/30)`, × 1.6 on a serve
  return (added 2026-10-22: return errors give the server its edge). The balance sim tuned these
  numbers; the current ones are in `tuning.ts` (`scatter`).
- `T` also gets `× (1 + 0.10·g·n3)`, g = grade factor × stretch factor: a shorter T is a faster,
  flatter ball (the landing point does not move), so rushed and stretched shots from low contact
  points risk the net.
- In/out and net are not rolled separately: they follow from the flight. **Out** — the first bounce
  lands outside the opponent's singles court (lines count as in; the ball's radius 0.033 m is added).
  **Net** — at the net plane (y = 0) the ball is below the net height there (0.914 m at the centre,
  rising linearly to 1.07 m at the posts) plus the ball radius; the ball then drops on the hitter's side.
- Each player's hits and serves draw from that player's own RNG stream (`forkSeed(seed, 10 + player)`),
  so online play can later let each machine draw for its own hits.

### 4.8 Serve

- **Set-up**: the server stands behind the baseline on the serving side (deuce: x on the right of
  the server, as in the typing game's `serverSpot`); the receiver at its receiving spot. During the
  set-up the server can move along x (§4.2).
- **Toss**: a shot-key press tosses the ball: it leaves the hand at 1.8 m, rises to 3.2 m at
  `tossApexMs = 650` (× 1/paceSpeed) and falls back.
- **Hit**: a second shot-key press swings; contact is immediate at the ball's current height.
  Timing grade: within 120 ms after the apex → **perfect**; from 200 ms before the apex until
  350 ms after it → **clean**; else **rushed**. Below 1.4 m the toss is dropped instead: no fault,
  toss again.
- **Serve type** by the key of the second press:

| Key | Serve | Base speed (m/s) | k | Target margin | Bounce keep / restitution |
|---|---|---|---|---|---|
| Topspin key | Flat | 40 | 1.10 | 0.25 m | 0.80 / 0.62 |
| Slice key | Slice | 34 | 1.00 | 0.45 m | 0.72 / 0.50, curves: lateral acceleration 3 m/s² toward the wide side |
| Lob key | Kick | 27 | 1.60 | 0.60 m | 0.70 / 0.85 |

  (A slice serve's lateral acceleration is part of the segment's `a`; still closed form.) The tuned
  speeds are in `tuning.ts`; after playtesting (2026-10-22) they are 37 / 34 / 27 m/s, so that a
  human's reaction (about 0.3 s) can return most serves.
- **Aim**: left/right held at contact → toward that side of the service box: wide or T, depending
  on the side; none → body (box centre line). The depth target is `serviceLine − margin`.
- **Faults**: the serve's first bounce outside the diagonal service box, or a net ball → fault. Two
  faults → double fault, the receiver wins the point. **Serve clock**: 25 s from the start of the
  set-up until the hit (the toss does not stop it); running out is a fault.
- Ace: a serve that bounces in and is not touched by the receiver before its second bounce.

### 4.9 Rally rules and point flow

- After a hit, the ball must bounce first inside the opponent's singles court. Out or net → the
  hitter loses (`out` / `net`). A ball that bounces twice on the receiver's side → the hitter wins
  (`winner`, or `ace` on a serve).
- A volleyed ball is in play wherever it would have landed.
- When a point ends: the call (banner + umpire voice) shows for 1.2 s, then the score call and any
  situation (BREAK POINT, SET POINT, MATCH POINT, DEUCE, GOLDEN POINT, via `core/scoring.situation`)
  for 1.6 s; the players walk to the next set-up spots during it (the sim moves them; inputs are
  ignored). A game/set/match win shows its banner for 2 s.
- Scoring, formats, tiebreak servers, deuce rule and the coin toss are the typing game's
  (`core/scoring`). The match starts with a 2 s intro (names and the coin-toss winner, who serves).

## 5. CPU and belts (Part 3)

- The CPU is a **controller**: each tick it produces the same per-tick input a human does (§4.1). It
  sees the public state (positions, the current flight) and has its own RNG stream
  (`forkSeed(seed, 20 + player)`); it never reads the opponent's RNG.
- **15 levels** with the typing game's ranks and labels (`core/belts`), White belt to Black belt 3rd
  dan. Each level's profile is interpolated between five milestone rows (the starting values below;
  the balance sim tuned them, and the current rows are `ARCADE_CPU_MILESTONES` in `tuning.ts`):

| Milestone | Reaction (ms) | Read error (m) | Speed × | Press timing σ (ms) | Aggression |
|---|---|---|---|---|---|
| White (0) | 420 | 1.2 | 0.78 | 160 | 0.15 |
| Yellow (3) | 340 | 0.9 | 0.84 | 120 | 0.3 |
| Green (6) | 260 | 0.6 | 0.90 | 85 | 0.45 |
| Brown (9) | 190 | 0.35 | 0.95 | 55 | 0.6 |
| Black (12) | 140 | 0.2 | 1.0 | 35 | 0.75 |
| Black 3rd dan (14) | 100 | 0.1 | 1.0 | 20 | 0.85 |

  - **Reaction**: after the opponent's hit, the CPU keeps its previous plan for this long.
  - **Read error**: its predicted contact point is off by this much (a fixed offset drawn per shot),
    shrinking linearly to 0 over the last 0.5 s of the ball's approach; so low belts arrive late or
    misplaced and stretch.
  - **Movement**: it steers (8 directions, like a human) toward a contact spot 0.7 m beside the
    predicted contact point; a speed factor below 1 is applied by holding the direction on only that
    share of ticks (a deterministic accumulator), since inputs carry no speed.
  - **Commit**: it commits so that contact falls `chargeMs + perfectWindowMs/2` after the commit,
    plus normal noise with the level's σ; low belts are often rushed or merely clean. Since a commit
    plants it (§4.3), it commits on that lead only within 0.6 m of its spot; further off it keeps
    running and commits 0.2 s before the predicted contact at the latest. While committed it holds
    its aim direction.
  - **Shot choice**: by aggression: attack a corner (topspin, aiming away from the opponent) vs
    rally deep through the middle; slice when stretched; lob when the opponent is within 4 m of the
    net (more often at higher aggression); approach the net after a short opponent ball at high
    aggression.
  - **Aim**: through the same direction keys, held only for the last 2 ticks before the predicted
    contact (so aiming barely moves it). Corner aim with probability `0.25 + 0.6 × aggression`, else
    neutral (deep middle).
  - **Serve**: by the belt's serve columns (added 2026-10-22): a first serve is flat with
    probability `serveFlat`, kick with `serveKick`, else slice; a second serve is kick. It aims wide
    or down the T with probability `serveAim` (either at random), else at the body. White serves
    kick and slice at the body (0 / 0.6 / 0.1); the shares rise to 0.75 / 0 / 0.7 at Black 3rd dan.
    It tosses 0.6–1.2 s after the set-up starts and presses with its timing σ around the perfect
    window.
  - **Recovery**: after hitting, it moves to a spot behind the centre of its baseline, shifted 0.6 m
    toward the side its shot went to (covering the angle); after a short ball approach, it stays at
    the net (~2.5 m from it).
- The attract demo is CPU vs CPU, two random belts between Green and Black, spectator view.

## 6. Presentation (Part 4)

### 6.1 Rendering

- `ArcadeRenderer` draws into the shared 480×270 `Screen`: backdrop (stadium + crowd + umpire,
  `render/scene`), court, net, player and ball shadows, players and ball depth-sorted far to near,
  effects, HUD, banners. The near end is the human's (spectators: player 0).
- **Players**: sprite sheets from `buildSheet(look)` (cached per look), drawn at their sim positions.
  Animation from the sim state: `idle` when still; `runLeft`/`runRight`/`runToward`/`runAway` by the
  dominant velocity axis (screen-relative); swings play `forehand` or `backhand` (by the contact side)
  so that the contact frame (2) lands on the contact tick: the swing anim starts 2 frames before the
  predicted contact once committed and the ball is ≤ 180 ms away; volleys use the same frames; a
  stretch contact plays `stretch`; a smash plays `serve` frames 2–3; the serve plays `serve` 0–1
  (toss), 1 (trophy, while waiting) and 2–3 (strike, follow-through). `celebrate`/`dejected` after a
  game, set or match is won, during its banner.
- **Ball**: `BallView` `air` at the flight position evaluated at the frame's exact time (smooth on any
  refresh rate), with the existing short motion trail; `held` while the server holds it; tossed
  ball as `air`. Shadow on the ground.
- **Charge bar**: while the local player is committed, a 12×2 px bar above their head fills with the
  charge; it flashes white in the perfect window. "PERFECT" pops above the player on a perfect hit.
- **Effects**: bounce puffs (clay marks on clay), screen shake on aces/winners and smashes, crowd
  excitement after long rallies (the shared crowd painter takes `crowdExcite`). Reduce effects (an
  option) turns off shake and trails.
- **HUD**: the shared scoreboard (names, belt swatch, sets, games, points, serving ball), serve
  speed in km/h for 2 s after a serve, the serve clock in its last 5 s, the pause icon, banners
  (FAULT, OUT, NET, ACE, WINNER, DOUBLE FAULT, TIME VIOLATION, GAME/SET/MATCH + name, situations),
  "3-2-1" resume countdown.

### 6.2 Audio

`ArcadeDirector` maps sim events to the shared `AudioEngine` sounds and `Umpire` speech: hit /
hitHard (power ≥ 0.9 or smash), bounce (with the surface), netHit, crowd reactions, the umpire's
calls (FAULT, OUT, NET, the score via `core/scoring.umpireCall`), and the title music on the title
and menu screens. Events older than 300 ms when played are dropped (as today).

### 6.3 Screens and flow

`gate` (click/press to start, unlocks audio) → `title` (logo "BLACK BELT TENNIS ARCADE", attract demo
behind) → `mainMenu`: **Play vs CPU**, **Customize**, **Options**, **How to Play**. **CPU setup**: belt (15 levels), format, deuce rule, surface, pace; remembered.
**Match** → **Pause** (Esc, Tab or the pause icon: Resume, Restart, Quit to menu; also on window
blur or tab hidden; resume with 3-2-1) → **Results**: final score, winner, per player aces, double
faults, winners, errors, perfect hits, fastest serve, longest rally; Rematch / Menu.
**Options**: master / music / effects volume, Reduce effects, fullscreen. **How to Play**: the
controls table, the swing timing (commit early, perfect window), aim, serve, shot types.
Screens reuse the typing game's DOM controls and CSS; the HTML page has its own title and meta.

### 6.4 Storage

Keys under `bbtennis-arcade:v1:`: `profile` (name + look; defaults like the typing game's),
`settings` (volumes, reduce effects), `cpuSetup` (last setup). Failures fall back to defaults and show
once "Progress can't be saved in this browser mode".

## 7. Testing and verification (Part 5)

- **Unit tests** (`tests/arcade/**`, vitest, node): flight (bounce times and points, continuity at
  bounces, apex, net clearance, in/out with the ball radius, slice-serve curve), shot (aim per
  direction and grade, power, scatter scaling, rushed pull), timing grades at their boundaries,
  reach zone (height limits, side, serve-return bounce rule, volley, smash), serve (toss, drop and
  re-toss, faults, double fault, serve clock), rules (out, net, second bounce, ace, winner), movement
  (speed, acceleration, bounds, set-up rails), match flow (point → game → set → match, banners
  timing, set-up reset), CPU (reaches neutral balls at Black belt; level order), input edges.
- **Determinism**: the same seed and the same input sequence give an identical event log and final
  state; a test records a CPU-vs-CPU match's inputs and replays them.
- **Guard tests**: the boundary and maths checks of §3.
- **Balance sim** (`tests/arcade/balance.test.ts`; full run with `BBT_SIM=1`, a smoke subset in
  `npm test`): CPU vs CPU at Normal pace. Targets for equal belts (Green, Brown, Black): median
  rally 4–10 shots, server wins 53–70 % of points, aces at most 15 %, double faults 2–10 %, 99 % of
  points within 45 s and none over 90 s, perfect hits 15–60 % at Black. Across belts: each milestone
  beats the one below in ≥ 75 % of short sets; Black 3rd dan beats White in ≥ 99 %. Against a
  **seasoned-human stand-in** (a CPU profile with 0.28 s reaction, 0.45 m read error, 70 ms timing σ;
  an assumption): it beats White and Yellow in ≥ 90 % of short sets and Green in ≥ 60 %, wins 30–70 %
  against Brown and 5–35 % against Black, and Black 3rd dan beats it in ≥ 90 %; White and Yellow ace
  it on ≤ 2 % of their service points, every belt on ≤ 15 %. *(Targets revised 2026-10-22: the first
  tuning was against CPUs only, and a seasoned player found White hard and many serves
  unreturnable.)*
- **Typing game unchanged**: the full existing suite, typecheck and build stay green;
  `dist/index.html` is unchanged in behaviour and `dist/arcade/index.html` exists.
- **In the browser**: `scripts/devshot.mjs` screenshots of `arcade/index.html` (title, a match in
  progress via a debug hook that starts a CPU-vs-CPU match), and a short scripted run that drives
  the keyboard through a serve and a rally against White belt; no console errors.

## 8. Online later (not in v1; constraints only)

*(2026-10-23: online play is designed and built in `2026-10-23-arcade-online-design.md`. It uses
rollback on the shared deterministic sim instead of the per-player authority below; the constraints
below kept the core ready for either.)*

- The sim must allow each machine to be authoritative for its own player: movement and hits are
  computed from that player's inputs and RNG stream only; a hit is fully described by a `HitEvent`
  (tick, player, shot, grade, power, aim target after scatter, T, contact point) from which both
  machines build the same flight.
- No v1 code may assume both players' inputs are known at the same tick for anything other than
  rendering the opponent.

## 9. Out of scope for v1

Online play, career stats and unlocks, Training, gamepad, touch/phones, doubles, lets and net
cords, surface-dependent physics, end changes, replays, a separate logo/art set beyond the title text.
