# Power Meter, Insane Words and Rally Pacing — Design Spec

Date: 2026-09-27 · Amends `2026-09-26-black-belt-tennis-design.md` (the "main spec") · Agreed in chat.

## 1. Intent

Three playtest changes:

1. **Gentler rally speed-up.** The ball speeds up too quickly during a rally. Rallies should last
   longer, and players should still be able to pick harder words deep into a rally.
2. **Shorter words per tier.** Every tier's base difficulty is a little too high.
3. **Power meter and insane words.** Typing flawlessly fills a per-player power meter. While the
   meter is full, the player gets a fourth, **insane** option on every serve and rally shot. The
   meter empties as soon as the player mistypes or loses a point.

Success criteria:
- Equal players get longer rallies: median 5–8 shots, p90 ≤ 16 (was 3–6 and ≤ 12).
- Tiers by length are easy 2–4, medium 5–7, hard 8–11 and insane 12–15 letters.
- A flawless insane shot is a near-winner, and a sloppy one is very likely an error.
- Insane helps a player without dominating the game (§7 targets).
- Works the same vs CPU, online and in attract mode. Online stays deterministic: the host and
  guest never disagree about the meter.

### 1.1 Decisions agreed with the user
| Topic | Decision |
|---|---|
| Insane shot | **Near-winner**: lands in a corner, 0.15 m inside both lines, and gives the receiver much less time than a hard shot. Flawless ⇒ always in; one slip ⇒ ~70 % error. |
| Insane words | Hard is capped at 8–11 letters; insane words are **12–15 letters**. |
| Meter fill | **+1 per flawless serve or choice word** (zero wrong keys), max **4**. Chase words never fill it. |
| Meter drop | **Empties to 0** on any wrong key, chase words included, and on any point lost. |
| Insane use | Available on every serve or choice prompt that appears while the meter is full. Hitting the insane word does **not** use up the meter. |
| Rally length | Median 5–8 shots, p90 ≤ 16, via a gentler pressure factor with a floor. |

## 2. Rally pacing (amends main spec §3.4, §6)

- The pressure factor becomes `P(n) = max(pressureFloor, pressure^⌊n/2⌋)`, computed by repeated
  multiplication as now. Starting values: `pressure = 0.93` (was 0.85), `pressureFloor = 0.65`.
  The balance simulation (§7) sets the final values.
- `T = pace × (2.2 s + 0.10 s × len(chaseWord)) / v × place[d] × P(n)` (+ the serve reading
  allowance, unchanged). Rally shots and easy/medium/hard serves keep the main-spec place rules
  (serves at place 1). An **insane serve** uses `place.insane` instead of place 1; the reading
  allowance is still the same for every serve. There is no pace-specific pressure curve: pressure
  only ever takes time away from a rally.
- Displayed km/h divides by `P(n)` instead of `0.85^⌊n/2⌋`.
- `tossApexMs` is re-tuned (§7). The new hard tier (8–11 letters) and the insane tier change which
  serve words "fit" the toss window, and so the double-fault rate. A **full-meter serve** only
  (meter level 4 / `insaneOffered`) stretches the toss further: the engine writes
  `tossApexMs = TUNING.tossApexMs × TUNING.power.tossMult` into that serve turn's start data
  (`tossMult` starts at 1.2). Training and any serve whose meter is not full keep the global
  `tossApexMs`.

## 3. Word tiers (amends main spec §3.10)

- `tierOfLength`: easy **2–4**, medium **5–7**, hard **8–11**, insane **12–15**; any other length ⇒ null.
- Packs (`PACKS`) gain an `insane` list. Existing words are re-bucketed by the new lengths.
- New words are written so that **every pack** has ≥ 120 easy, ≥ 120 medium, ≥ 80 hard and ≥ 60
  insane words (target ≥ 70 insane). Mixed is still the union.
  - Today's counts under the new bands: easy 141 / 105 / 109, hard 151 / 164 / 137, insane 26 / 27 /
    30 (Everyday / Sports / Dojo). Sports and Dojo need more short words; every pack needs more
    insane words.
  - A handful of safe 2-letter words are added where natural (e.g. *ox*, *go*, *hi*). Most 2-letter
    words are directions (*up*, *in*, *on*) and stay out.
  - The misleading-word blocklist and every other pack rule (lowercase a–z, no duplicates, nothing
    offensive) apply to the new words.
- The typing-speed formula `cps = (n − 1)/Δt` now also applies to 2-letter words (a single
  interval). Top WPM still counts only words with n ≥ 5.
- Training's fixed word triples are updated to the new bands (e.g. *thunderstorm* is now insane).
  `validateTraining` checks triples against the new bands.

## 4. Power meter

### 4.1 Rules (single source: `core/power.ts`)
- Each player has a meter level 0–4 (`TUNING.power.max = 4`), stored in `MatchState.power`. It starts
  at 0 in every match.
- **Fill**: when a player **strikes** with a serve or choice word that had **zero wrong keys**, their
  level becomes `min(4, level + 1)`. Stretch shots count. The fill happens at the strike τ: for a
  queued return, at T.
- **Empty on a wrong key**: any wrong key the player types, in a serve, chase or choice word, sets
  their level to 0 at that key's τ.
- **Empty on a lost point**: when a point is scored, the loser's level becomes 0. This covers every
  point reason: ace, winner, out, net and double fault.
- **Cancelled turns**: a return turn cancelled by an OUT or NET call on the incoming ball has no
  strike, so it never fills the meter. A wrong key typed before the call still empties it.
- Levels carry over between points, games and sets. Winning a point does not itself change the
  winner's level.
- **Training**: the meter is always 0 and never shown (`config.training !== null`).

### 4.2 Insane option
- **Serve turn**: if the server's level is 4 when the turn is created, every serve word set of the
  turn (the current set, the spare and any appended spares) has 4 options, easy / medium / hard /
  insane. The level cannot rise within a serve turn, and a wrong key only follows a lock (after
  which no re-toss happens), so the option set never has to change mid-turn.
- **Return turn**: if the receiver's level is 4 when the turn is created, the pre-picked choice has 4
  options. The runner shows the insane option only if the level is still 4 when the choice prompt
  appears, meaning no wrong key in the chase word. Otherwise the choice prompt shows the first 3
  options. The unused insane word still counts as offered for the picker history.
- The level can only reach 4 at a strike, which ends that turn's typing, so the level when a turn is
  created is the only thing that decides whether the insane word is pre-picked.
- Option indices keep the tier order easy 0, medium 1, hard 2, insane 3 everywhere (prompt
  options, targets, lock events).

### 4.3 The insane shot (amends main spec §3.2.6, §3.3.3, §3.5)
- **Rally target**, half coordinates as in main spec §3.3.3 (`m` = medium's side): insane
  `(m·3.965, 11.735)`, the deep corner on medium's side, 0.15 m inside the sideline and the
  baseline. Easy stays in the centre, medium on one side and hard in the opposite corner.
- **Serve target**, box coordinates as in main spec §3.2.6: on medium's half of the box, 0.15 m inside
  the sideline or centre line and 0.15 m inside the service line: `(3.965, 6.25)` when hard is T,
  `(0.15, 6.25)` when hard is wide.
- **Tuning** (starting values; `place.insane` is set by the balance simulation):

  | Constant | easy | medium | hard | **insane** |
  |---|---|---|---|---|
  | `flight.place` | 1.00 | 0.85 | 0.70 | **0.55** |
  | `accuracy.sigma0` (m) | 0.10 | 0.12 | 0.10 | **0.04** |
  | `accuracy.sigmaE` (m) | 0.25 | 0.35 | 0.50 | **0.80** |
  | `accuracy.netRate` | 0.01 | 0.03 | 0.06 | **0.10** |
  | `trajectory.arcH` (m) | 2.0 | 1.7 | 1.4 | **1.2** |
  | `kmh.tierBonus` | 1.00 | 1.05 | 1.10 | **1.20** |

- **Insane serve flight**: uses `place.insane` (not place 1). Easy/medium/hard serves stay at
  place 1. The serve reading allowance is unchanged for every serve, including insane. The same
  `place.insane` also scales insane rally shots; split only if balance cannot hit the 15–40 %
  clean-insane return target on both serves and rallies with one value.
- **Power toss**: a serve turn whose owner's meter is full at creation
  (`insaneOffered(power)` / level 4) gets `tossApexMs = TUNING.tossApexMs × TUNING.power.tossMult`
  in its start data (`tossMult` starts at **1.2**). Training (`meterFor` returns null) and any
  serve whose meter is not full keep the global `tossApexMs`. The global toss and the serve
  reading allowance remain the double-fault / server-win knobs; there is no pace-specific
  pressure curve for insane.
- **Guarantee** (unit-tested, as for every tier): with e = 0 and no stretch, an insane shot is never
  out or net (3.46 × 0.04 = 0.139 m < 0.15 m margin).
- **Expected** (unit-tested): an insane rally shot with e = 1 fails (out + net) 60–85 % of the time.
  The analytic estimate is ≈ 71 %.
- The receiver's chase word is the insane word itself (12–15 letters), as for any shot.

### 4.4 Events
- New event `{ type: 'power'; player; from; to }`, emitted by the runner at the wrong key or strike
  that changes a level, and by the engine at a point that empties the loser's meter. It is public:
  levels are never secret, and wrong-key events are already public.

## 5. Architecture changes

- **`core/types.ts`**:
  - `Tier` adds `'insane'`. `TIERS` stays `['easy', 'medium', 'hard']` (the tiers always offered), and
    a new `INSANE: Tier = 'insane'` constant is added. Every `Record<Tier, …>` gains an insane entry,
    and the compiler flags any that are missing.
  - `MatchState.power: [number, number]`; `MatchState.v` goes to `2`.
  - `ServeTurnData.power` and `ReturnTurnData.power` hold the owner's level when the turn is created.
  - `ServeWordSet.options/targets` and `ReturnTurnData.choice.options/targets` have 3 or 4 entries.
  - `GameEvent` gains `power`.
- **`core/power.ts`** (new, pure): `insaneOffered(level)`, `levelAfterKey(level, result)`,
  `levelAfterStrike(level, prompt)`, and `powerAt(turn, τ)`, which gives the owner's level at τ from
  the start data and the turn log. `powerAt` works on redacted turns because it reads only
  'bad'/'done' entries and the outcome, never the letters.
- **`core/words`**:
  - `tierOfLength` gets the new bands; the packs are re-bucketed and extended.
  - `pickTriple` becomes `pickSet(rng, picker, pack, avoid, withInsane)`, returning 3 or 4 words with
    the same rules. Initials are pairwise distinct and never adjacent on QWERTY across all 4 words;
    words come from the 20-word history; `avoid` still applies. When `withInsane` is false, the
    match-RNG draw order is the same as today.
- **`core/court.ts`**: `serveTargets` and `rallyTargets` return 4 targets (the insane target last).
  Callers slice to 3 when the insane option is not offered.
- **`core/shot.ts`**: `pressureFactor` gets the floor.
- **Turn runner (`turn.ts`, `turnServe.ts`, `turnReturn.ts`)**:
  - Serve prompts show a word set's options as picked (3 or 4).
  - The choice prompt drops the insane option when `powerAt` is below 4 at the moment the prompt is
    shown.
  - The runner emits `power` events.
- **`core/turnView.ts`**: `TurnView.power`, the owner's level at the view's τ, via `powerAt`.
- **`core/engine.ts`**:
  - When creating a turn, it asks the picker for 4 words if the owner's level is 4 (and training is
    off), and records the level in the start data.
  - At turn end it commits `powerAt(turn, endτ)` to `state.power[owner]`.
  - `point()` empties the loser's level and emits `power` if it changed.
- **`core/redact.ts`**: unchanged logic. It already hides every option of the other player's serve
  word sets, whatever the count. Tests confirm that the insane serve word never leaks.
- **`core/cpu.ts`, `core/sim.ts`**: choose from 3 or 4 options. Insane is the hardest option, so it
  falls under the existing "hardest feasible option with probability = aggression" rule, and its
  feasibility estimate uses its length as for any word.
- **`net/protocol.ts`**: `PROTO` goes 1 → 2. `parseState` accepts `v === 2` and requires `power` to be
  two finite numbers, clamped to 0–4.
- **`game/guestSession.ts`**: its placeholder state gets `v: 2` and `power: [0, 0]`.
- **`game/onlineLink.ts`**: the `Scoreboards` snapshot of each displayed turn also copies `power`.

## 6. Presentation and audio (amends main spec §4.2–§4.4)

- **Colour**: insane uses Okabe–Ito reddish purple `#CC79A7`; its typed shade is the crowd purple,
  re-tinted to `#B06FA0` (the palette's 48-colour cap). Tests: ≥ 4.5:1 on the fill, typed shade ≤ 1/1.8
  of the remaining letters' luminance, and CIEDE2000 ≥ 20 from every other tier in normal vision and
  ≥ 12 under each colour-vision deficiency. Measured: 14.1 from sky under protan, 15.5 under deutan,
  14.0 from vermillion under tritan. Only near-white or grey reach ≥ 20 there, and they vanish on the
  court lines the insane rings sit beside. Insane is never shown by colour alone.
- **Pips and ring**: insane plates carry 4 pips. Its ground ring is an 8-point burst (13×7 bitmap,
  distinct from the circle, diamond and 4-point star).
- **Plate width**: `6n + 11` px as now, but the maximum grows to **101 px** (15 letters). A locked
  insane word at 2× (Large words) is 202 px, still clamped to x 4–476.
- **Choice layout**:
  - With 3 options, slots stay at 90 / 240 / 390.
  - With 4 options, slots are at **60 / 180 / 300 / 420**, assigned by target screen x from left to
    right. Insane is always outermost, on medium's side, and hard is outermost on the other side.
  - Leaders and rings work as now.
- **Serve layout**: a near server gets a 4-plate vertical stack (easy, medium, hard, insane from top
  to bottom). A far server gets a 4-plate row. Both keep the existing rules: clear of the toss
  column, and Large-words plates grow away from it.
- **Layout test** (extends the main spec §4.2 test): for every length in each tier's band, both target
  sides and both 3 and 4 options, no two plates intersect and every plate lies within x 4–476,
  y 22–266. The serve stacks never cover the toss column.
- **HUD meter**: four 3×5 px segments (1 px gap) to the right of each scoreboard row, inside the HUD
  band, x ≤ 170:
  - Lit segments use the insane colour; unlit ones are dim grey outlines.
  - At level 4 the segments pulse (2 frames, 400 ms), or stay steadily lit with Reduce effects.
  - Hidden in training.
  - The level shown is `pub.power` for a player not on turn and `TurnView.power` (at the displayed
    τ) for the turn's owner, so a slip empties the meter on screen at the moment it happens, during
    passive playback too.
  - Online, `pub.power` comes from the per-turn `Scoreboards` snapshot, as the score does, so an
    emptying at a lost point shows when the playback reaches that point, never earlier.
- **Effects**: an insane strike leaves a short trail in the insane colour (off with Reduce effects).
- **Audio**:
  - A `power` event reaching 4 plays a rising 3-note cue.
  - A `power` event from 4 to 0 plays a soft down-sweep.
  - An insane strike uses a heavier hit and triggers the crowd "ooh" swell.
  - No new umpire speech.
- **How to Play**: a Power Meter section explains the rules. The illustrations use words that fit
  the new bands (their current words already do).

## 7. Balance targets (replaces main spec §6 balance targets)

For each pace at its reference WPM (Relaxed 30, Normal 50, Fast 70, Lightning 90), equal
human-model players, ≥ 5,000 points per cell, with the human model's "hardest option that fits"
policy (insane included):

| Target | Value |
|---|---|
| Median rally | 5–8 shots |
| p90 rally | ≤ 16 shots |
| Longest point | ≤ 60 shots |
| Median time per point | ≤ 50 s |
| Aces | ≤ 15 % |
| Double faults | 1–6 % |
| Server wins | 55–65 % |
| Clean insane shots returned by the equal opponent | 15–40 % (over ≥ 200 clean insane shots per preset; run more points if needed) |
| Never-insane policy vs adaptive | wins 40–50 % of points |

These are unchanged: always-easy, always-hard and never-hard each win ≤ 53 % against adaptive; CPU
aggression 0.8 vs 0.2 at equal speed wins ≥ 50 %; at Normal, CPU levels ≥ 2 apart ⇒ the higher
level wins ≥ 90 % of short sets, and adjacent levels ⇒ ≥ 65 %.

The balance simulation also reports, for each preset, the share of points in which each player
reaches a full meter. This is information only, with no target.

Tuning knobs, in order of preference: `flight.pressure`, `flight.pressureFloor`, `flight.place.insane`,
`tossApexMs`, then the serve reading allowance. Measured tables go into the header comment of
`tests/sim/balance.test.ts` and the comments in `tuning.ts`. **If the targets cannot all be met at
once, implementation stops and the trade-off goes to the user.** No target is loosened quietly.

## 8. Testing

- **Unit**:
  - `tierOfLength` bands; pack counts per tier and per pack; blocklist on the new words.
  - `pickSet`: 3 and 4 words, initials rule across all 4 words, history, avoid, draw order without
    insane.
  - `power.ts`: fill on a flawless strike (stretch included), no fill on a slip; empty on a wrong key
    in serve, chase and choice words; empty on a lost point for every point reason; a cancelled turn
    (a wrong key empties the meter, no fill); training stays 0; the level is capped at 4.
  - Turn runner: a serve at level 4 shows 4 options; a return at level 4 shows 4 options unless the
    chase had a wrong key; `power` events at the right τ.
  - `turnView.power` matches the live runner at every τ, on unredacted and redacted turns.
  - `shot`: insane guarantee at e = 0; e = 1 fails 60–85 %; hard e = 1 still 35–55 %; pressure floor
    holds; km/h uses `P(n)`.
  - `redact`: across 1,000 simulated serves at level 4, no frame sent to the guest contains a
    not-yet-struck serve word, insane included.
  - `protocol`: `parseState` accepts v2 with `power` and clamps it; rejects v1.
  - Layout and palette tests per §6; HUD meter states (tools/hudStates).
- **Net**: the existing latency-invariance, no-desync, playback and redaction tests pass unchanged.
  The scripted match must contain at least one insane shot (asserted), so the path is exercised
  online.
- **Balance** (`npm run test:sim`): §7.
- **E2E**: the existing automated vs-CPU match, plus a devshot of a 4-plate choice and a full HUD meter.
- `npm run typecheck`, `npm test`, `npm run build` pass.

## 9. Docs to update on completion

- Main spec §3.2.6, §3.3.3, §3.4, §3.5, §3.10, §4.2, §4.3, §4.4, §5.3 (`PROTO`) and §6 (balance
  targets), each pointing to this spec.
- README how-to-play: new word lengths and the power meter.

## 10. Out of scope

- An option to turn the meter off.
- Insane-shot counts in Results or career stats.
- New umpire calls.
- Meter-specific training steps (Training keeps the meter off).
