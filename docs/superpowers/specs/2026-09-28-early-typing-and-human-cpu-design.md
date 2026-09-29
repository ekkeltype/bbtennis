# Early Typing, Rally Flight and a Human-Like CPU — Design Spec

Date: 2026-09-28 · Amends `2026-09-26-black-belt-tennis-design.md` (the "main spec"),
`2026-09-27-power-meter-and-rally-pacing-design.md` (the "power-meter spec") and
`2026-09-28-choice-stack-design.md` (the "choice-stack spec") · Agreed in chat.

## 1. Intent

Playtest: a 98-WPM player lost 2–7 to Master Lin (level 13, labelled 105 WPM, shown as 85 WPM on
Results). The cause was not typing speed:

- **The CPU's pauses are superhuman.** WPM counts only first key → last key. The time before the
  first key is not in it, and it comes twice per return (chase word, then choice word). Lin waits a
  fixed 0.40 s before a choice word and 0.20 s before a rally chase word. A person reading a new word
  and picking from a stack needs about 0.6–0.9 s. Given Lin's own pauses and accuracy, a 98-WPM
  typist wins 95 % of matches against him; with human pauses (0.7 s / 0.4 s) and 5 % key errors, 0 %
  (throwaway simulation at Normal, 400 tiebreaks per row).
- **Rallies are all easy words.** With human pauses, rally shots at each pace's reference speed are
  97–100 % easy. The chase word eats the flight time, so the switch from the chase word to the
  choice word decides most points and there is never time to attack with a longer word.

Three changes:

1. **Early typing.** Once the striker locks their choice word, the receiver may start typing it as
   their chase word. The chase then happens during the striker's own typing, and the flight time is
   left for choosing and typing an attack.
2. **A rally flight built for choosing.** Rally shots get their own flight formula (the chase is
   typed early, so the flight no longer pays for it), and harder shots cut the flight more.
3. **A human-like CPU.** One typist model with human pauses and error rates drives every CPU and
   the balance simulation. The belt ladder moves up (black belt 110, 3rd dan 140 WPM) so black belts
   stay hard, and a level's WPM is what its Results screen shows.

Success criteria:
- Rally shots between equal players at a pace's reference speed are at most 65 % easy and at least
  15 % hard or insane (today about 98 % easy).
- A typist 20 % faster wins at least 65 % of points at every pace.
- CPU pauses and error rates are human-like. Each CPU level's average WPM on Results is within 5 %
  of its label.
- Early typing works the same vs CPU, online, in attract mode and in Training. Online stays
  deterministic, and latency never shortens anyone's window.
- The existing balance targets still hold (§4), or the trade-off goes to the user.

### 1.1 Decisions agreed with the user
| Topic | Decision |
|---|---|
| Early window | **Free until the strike.** From the striker's lock the receiver may type the whole word at their own pace, even ahead of the striker's cursor. The typing carries straight into their turn at the strike. |
| Serves | **Rally shots only.** Serve words stay hidden until the strike; the reading allowance stays. |
| Choice words | **Unchanged timing:** they appear when the chase word is done, but never before the strike. No preview. |
| Rebalance | **Keep the time for attacking.** The user rejected shorter flights: early typing exists to give the receiver time to choose a longer word. Rally flights get a larger base with no per-letter term, harder shots cut the flight more, and rallies end by pressure and risk. |
| Tier mix target | Rally shots: easy ≤ 65 %, hard + insane ≥ 15 %. |
| CPU numbers | **Estimates** (typing-research ballparks), tuned by feel in playtests. No new Results stat. |
| Ladder | 25 → 140 WPM in 15 steps of about 13 %: black belt 110, 2nd dan 124, 3rd dan 140. |

### 1.2 Evidence (throwaway simulation, 2026-09-28)
Human-like model (0.7 s before a choice word, 0.4 s before a chase word, 4 % key errors), equal
players at each pace's reference speed:

| Variant | Normal median rally | Rally tiers e/m/h (Normal) | 98 vs 85 WPM at Normal |
|---|---|---|---|
| Today | 7 | 98 / 2 / 0 % | faster wins 77 % of points |
| Early typing, today's flights | 96 (Relaxed 462) | 99 / 1 / 0 % | faster wins **35 %** |
| Early typing, today's flights, no pressure floor | 19 | 86 / 14 / 0 % | 55 % |
| Early typing, rally base 4.5 s, place 1 / 0.7 / 0.45 / 0.3, pressure 0.88, no floor | 6–7 | 67–71 / 16–17 / 12–17 % | 48–56 % (60 vs 50: 64–72 %) |

A striker who finishes early waits for the ball, and early typing turns that wait into the
receiver's time. With today's flights the game never ends, and the faster typist loses. At 98 vs 85
WPM on Normal, Normal pace is slow for both players, so points come down to hard-word typos, not
speed. That is why "faster wins" is judged at each pace's reference speed (§4).

## 2. Early typing (amends main spec §3.1, §3.3)

- **Opens** when the striker's choice prompt is locked (its first letter typed) in a return turn.
  Serve turns never open it: a serve word stays hidden until the strike (§3.2), and the serve
  return keeps its reading allowance.
- **Word:** the locked word, shown in full.
- **Typing:** the receiver types it at their own pace, even ahead of the striker's cursor. The
  strict cursor, slips and accuracy rules are those of any chase word.
- **Closes** at the strike, at contact for a queued shot or at completion for a stretch shot. The
  receiver's return turn then starts with the early keys already applied, and typing carries on with
  no break.
- **Before the lock:** the receiver's keys are dropped with the WAIT tag, as today.
- **Discarded early keys** (not counted in any stat):
  - The striker never strikes: the ball passes them, or an OUT/NET call on the ball coming to them
    ends their turn. The point ends and no return turn follows.
  - The striker's shot is called OUT or NET. The main spec §3.3.5 already discards the receiver's
    typing at the call; early keys go with it.
- **Timing:** early keys keep their real times on the receiver's turn clock, i.e. before τ 0 (the
  strike). The chase prompt's `shownAt` is the lock's time on that clock. WPM stats stay honest:
  `cps = (n − 1)/(tLast − tFirst)` as now.
- **Power meter:** an early wrong key empties the receiver's meter, like any chase slip. On screen it
  empties when the key is pressed for the local typist, and at the start of the receiver's turn for
  anyone else (the key event's τ is before 0, see §6).
- **Choice words:** shown when the chase word is complete, never before the strike. A chase finished
  early shows the stack at τ 0.
- **Movement:** the receiver's player does not move before the strike. From τ 0 they run with the
  progress already made (`feetTarget` uses `correctKeys/len` as now).
- **Modes:** vs CPU, online, attract and Training (§6.4).

## 3. Rally flight (amends main spec §3.4; replaces power-meter spec §2's rally formula)

- **Serves:** `T = pace × (2.2 s + 0.10 s × len)/v × place` (place 1, insane serve
  `placeServeInsane`) `+ the reading allowance`. The formula is unchanged; the allowance, a §4 knob,
  is now `0.5 s + 0.35 s × pace` (was `0.25 s + 0.75 s × pace`; tuned 2026-09-28).
- **Rally shots:** `T = pace × rallyBase / v × place[tier] × P(n)`. There is no per-letter term:
  the receiver types the chase word during the striker's typing.
  - `P(n) = max(pressureFloor, pressure^⌊n/2⌋)`, computed by repeated multiplication as now.
  - Final values (tuned 2026-09-28; the probe started at 4.5 s, 1 / 0.7 / 0.45 / 0.3 and 0.88):
    `rallyBase = 7.3 s`, `place = { easy 1.0, medium 0.45, hard 0.22, insane 0.19 }`,
    `pressure = 0.78`, `pressureFloor = 0` (no floor). The attack had to be this strong for
    attacking to pay against the out-of-court risk of a slipped long word.
- **Unchanged:** grace, the speed factor v, contact factor, stretch rules, km/h (still divides by
  `P(n)`), accuracy and OUT/NET rules, and the ball path's shape (bounce at 0.6T and so on).
- **What players see:** easy rally balls float much slower than before (about 7–8 s at Normal early
  in a rally, instead of about 2.7 s), like a defensive lob, which leaves time to answer with a long
  word. Hard shots are fast attacks (about 1.8 s). Everything keeps speeding up (0.78 every two
  strikes) until someone breaks.

## 4. Balance targets (replaces power-meter spec §7)

For each pace at its reference WPM (Relaxed 30, Normal 50, Fast 70, Lightning 90), two equal
players of the typist model (§5) with that level's aggression rule at that WPM, ≥ 5,000 points per
cell, early typing on:

| Target | Value |
|---|---|
| Median rally | Relaxed 10–14, Normal 7–11, Fast 4–7, Lightning 3–5 shots |
| p90 rally | ≤ 22 shots |
| Longest point | ≤ 60 shots |
| Median time per point | ≤ 65 s |
| Aces | ≤ 15 % |
| Double faults | 1–8 % |
| Server wins | 55–65 % |
| Clean insane shots returned by the equal opponent | 15–40 % (over ≥ 200 clean insane shots per preset) |
| Never-insane policy vs adaptive | wins 40–51 % of points |
| **Rally tier mix** (new) | rally strikes (serves excluded): easy ≤ 65 %, hard + insane ≥ 15 % |
| **Faster wins** (new) | at each pace, reference × 1.2 WPM vs reference WPM (same model otherwise) wins ≥ 65 % of points |
| **Honest labels** (new) | every CPU level's average WPM (the Results formula) in short sets vs the same level at Normal is within 5 % of its label |

Unchanged: always-easy, always-hard and never-hard each win ≤ 53 % against adaptive; CPU aggression
0.8 vs 0.2 at equal speed wins ≥ 50 %; at Normal, CPU levels ≥ 2 apart ⇒ the higher level wins
≥ 90 % of short sets, adjacent levels ⇒ ≥ 65 %.

The simulation also reports, per preset: the share of rally returns with early keys and with the
chase finished before the strike, and the share of points reaching a full meter (information only).

**Tuning knobs**, in order of preference: `flight.rallyBaseMs`, `flight.place` (rally), `flight.pressure`,
`flight.pressureFloor`; for the serve targets only, `tossApexMs` and the serve reading allowance. The
typist model's pauses and error rates (§5) are **not** knobs: they are the agreed human estimates,
and tuning must not quietly weaken the CPU. The calibrated speed table (§5) is not a knob either: it
only makes labels honest.

Measured tables go into the header comment of `tests/sim/balance.test.ts` and the comments in
`tuning.ts`. **If the targets cannot all be met at once, implementation stops and the trade-off goes
to the user.** No target is loosened quietly.

**Accepted result (2026-09-28).** The targets above could not all be met at once. The knobs traded
more long words against the faster typist's edge, and Relaxed's floating lobs and passive 30-WPM belts
kept its rallies long. The user chose:

- **Relaxed is judged apart:** median ≤ 20 shots, ≤ 100 s per point, and no tier-mix or faster-wins
  target.
- **Six targets are re-set to guard the chosen tuning:** Lightning server wins ≤ 76 %; clean insane
  returns 3–50 %; no double-fault floor at Relaxed and Normal; Relaxed aggression 0.8-vs-0.2 ≥ 45 %;
  faster wins ≥ 63 % at Normal and Fast; CPU levels 2 apart ≥ 78 %.
- **Normal's median band becomes 6–11.** A 0.79 speed-up gave 7, but let the top belts drift together.

Measured, per preset (Relaxed / Normal / Fast / Lightning):

- **Rallies:** median 9 / 6 / 5 / 3 shots; p90 18 / 15 / 8 / 6; 64 / 33 / 21 / 14 s per point.
- **Rally shots:** easy 71 / 61 / 57 / 55 %; hard + insane 10 / 21 / 29 / 34 %.
- **Serve:** server wins 56 / 58 / 64 / 73 %; double faults 0.2 / 1.1 / 2.1 / 3.6 %.
- **Insane:** clean insane shots returned 49 / 32 / 17 / 7 %.
- **Speed and strategy:**
  - a 20 % faster typist wins — / 66 / 64 / 66 % of points;
  - always-easy wins 49 / 41 / 32 / 28 % against the adaptive player;
  - aggression 0.8 beats 0.2 in 48 / 57 / 61 / 61 %.
- **Belts:** every level's Results WPM is within 1 % of its label; levels 2 apart win 81–100 % of short
  sets.

Full tables: `tests/sim/balance.test.ts`.

## 5. Typist model and belt ladder (replaces main spec §3.8 table and parameters, and the §6 human model)

One model, a function of WPM `w` plus an aggression value, drives every CPU and both simulation
players. Every "25 → 140" value below is linear in `w` between 25 and 140 WPM and held outside.

- **Key errors:** per key after a prompt's first key, 7 % → 4 % (about 5 % at 98 WPM). A wrong key is
  a random other letter, then a pause of 200–400 ms (was 150–300 ms) before the right letter.
- **Pauses before a prompt's first key:**

  | Prompt | 25 WPM | 140 WPM |
  |---|---|---|
  | Serve words (after the toss) and choice words | 0.95 s | 0.60 s |
  | Chase word of a serve return | 0.60 s | 0.40 s |
  | Early chase: after the striker's lock | 0.50 s | 0.30 s |

  The early chase starts that long after the lock. If that is after the strike, it starts then, in
  the return turn, with no further pause.
- **Rhythm, unchanged:** mean interval `I = 12/w_nominal` s, per-word factor
  `f = clamp(1 + 0.15·z, 0.7, 1.4)`, each interval `I·f·(1 + 0.35·(u1 + u2 − 1))`, and a 10 % chance
  per key after the first of a 250–500 ms hesitation on hard and insane words. Toss delay 0.6–1.2 s.
- **Honest WPM:** a level's label `w` is the average WPM its Results screen shows. The model types at
  a nominal speed `w_nominal ≥ w` that makes up for hesitations and error pauses. `w_nominal` per
  level is a table in `tuning.ts`, calibrated once by the simulation and checked by the "honest
  labels" target (§4). The error rate and pauses use the label `w`, not the nominal speed.
- **Word choice, unchanged rule:** an option is feasible if `est ≤ (deadline − now) − 0.25 s`, with
  `est = pause + len·I·(1 + err/(1 − err)) + err·len·0.30 s` (0.30 s = the mean error pause). With
  probability = aggression the hardest feasible option is chosen, otherwise a uniform pick among the
  other feasible ones; easy if none is feasible; second serves use aggression × 0.4. For a return,
  "now" is when the chase word completes (the choice prompt appears).
- **Ladder** (15 levels; names, belts, stripes, dans and career records unchanged):

  | Level | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
  | Belt | Wh | Wh★ | Wh★★ | Ye | Ye★ | Ye★★ | Gr | Gr★ | Gr★★ | Br | Br★ | Br★★ | Black | 2nd dan | 3rd dan |
  | WPM | 25 | 28 | 32 | 36 | 41 | 46 | 52 | 59 | 67 | 76 | 86 | 97 | 110 | 124 | 140 |

  Aggression per milestone row as today (white 0.20, yellow 0.35, green 0.50, brown 0.65, black 0.80,
  2nd dan 0.85, 3rd dan 0.90), linear in WPM across the stripes between two rows.
- **Simulation players** (§4) are this model at the reference WPM, with the aggression the ladder
  gives at that WPM. `humanProfile` / `humanTypist` and `HUMAN_CHASE_REACTION_MS` are replaced by
  the model.
- CPU randomness keeps its own RNG seeded from (matchSeed, playerId).

## 6. Architecture

### 6.1 Core (pure, deterministic)
- **`core/types.ts`:** `ReturnTurnData.earlyFrom: number | null`: the receiver-clock τ (≤ 0) at which
  early typing opened (the striker's lock τ − strike τ); null for a serve return. `PublicState`
  carries it, so `PROTO` changes (§6.3).
- **`core/engine.ts`:**
  - `returnTurn` sets `earlyFrom` from the striker's turn: its choice prompt's lock entry and its
    strike τ.
  - `Engine.start(player, early: EarlyKey[] = [])` passes early keys to `startTurn`.
    `EarlyKey = { key: string; τ: number }`, τ on the receiver's clock.
- **`core/turn.ts`:** `startTurn(t, early)`.
  - For a return turn with `earlyFrom !== null`, the chase prompt is shown at `earlyFrom`.
  - Each early key is applied in order at its own τ, before anything at τ 0.
  - Early keys are rejected (whole list; the turn starts as if none came) unless: every key is
    `a–z`, τ is finite, τ values are non-decreasing, `earlyFrom ≤ τ ≤ 0`, there are at most 40 keys,
    and the turn is a rally return turn.
  - Keys after the chase word is complete are ignored, as any key on a completed prompt.
  - Training's first-prompt freeze does not start when early keys exist (their first key already
    came).
  - Prompt fields, the turn log, `levelFromKeys`, `powerAt`, stats (`addTyping`) and `turnView`
    already work on time values; tests cover negative τ (§7).
- **`core/early.ts` (new):** `EarlyChase`, what a session keeps during the striker's turn.
  - `EarlyChase.open(strikerTurn, receiver)` returns one when that turn is a return turn whose choice
    prompt is locked and not ended, else null.
  - It holds a chase `PromptState` for the locked word, shown at the lock's τ on the striker's clock.
  - `press(letter, τStriker)` applies a key (strict cursor, slips) and returns feedback events for
    the local view (`keyOk`, `keyBad`, and `power` for the first slip at a non-empty meter).
  - `keysAt(strikeτ)` re-bases the keys to the receiver's clock (τ − strikeτ).
- **`core/shot.ts`, `core/tuning.ts`:**
  - `flightTimeMs` branches on `isServe` (§3).
  - `TUNING.flight` gains `rallyBaseMs` and gets the new rally `place`, `pressure`,
    `pressureFloor`. `baseMs`/`perCharMs` are used by serves only.
  - `TUNING.typist` holds the §5 model constants. `CPU_LEVEL_WPM` becomes the new ladder, with
    `CPU_NOMINAL_WPM` beside it.
  - `CPU_MILESTONES` keeps only belt and aggression.
- **`core/cpu.ts`:**
  - `typistProfile(wpm, aggression)` returns the model's parameters; `cpuProfile(level)` uses it.
  - `CpuBrain.planEarly(strikerTurn)` plans the early chase keys on the striker's clock (start = lock
    τ + early pause), drawn from the brain's RNG once per lock and cached.
  - When the return turn starts, the brain's chase plan continues that same key stream, so the keys
    before and after the strike are one word typed once.
  - `CpuBrainOptions.chaseReactionMs` is removed; the model sets every pause.
- **`core/sim.ts`:** each rally return turn starts with the receiver brain's early keys (those with
  τ ≤ strike τ, re-based), so the balance simulation plays the real rules. `summarize` adds the
  rally tier mix and the early-typing shares.

### 6.2 Sessions
- **`LocalSession`:**
  - While the current turn is a rally return turn with a locked choice word, an `EarlyChase` is open
    for the other player.
  - A human receiver's letters go to it (no WAIT tag) at `τ = timeStamp − turnStartLocal`.
  - A CPU receiver's `planEarly` keys are fed to it as game time reaches them, so its plate fills
    live.
  - At the turn change, `engine.start(receiver, early.keysAt(strikeτ))`. With no strike, the
    `EarlyChase` is dropped.
  - Pausing freezes it with game time.
- **`HostSession` / `GuestSession`:**
  - The receiver's window follows their own **playback** of the striker's turn: it opens when the
    displayed τ reaches the lock, and a key is stamped with the displayed τ at that moment.
  - The window closes when the playback reaches the strike, which is exactly when the receiver's
    own turn starts today. Latency never shortens it (main spec §5.3 principle).
  - Host as receiver: `engine.start(HOST, early)`.
  - Guest as receiver: its local runner starts with `startTurn(runner, early)`, and it sends
    `early{turn, keys}` before its `clock 0`. The host starts the guest's turn with those keys on
    receipt. An input or clock for that turn without a preceding `early` starts it with none (as
    today).
  - The opponent's early typing is not streamed: it appears with their turn, the chase plate already
    partly typed.
  - The 30-inputs-per-second limit does not apply to the `early` list (bounded at 40 keys).

### 6.3 Protocol (amends main spec §5.3)
- New guest → host message `early{turn, keys: {k, τ}[]}`: `k` a letter, τ finite and ≤ 0, at most
  40 entries. Anything else is invalid and dropped.
- `PROTO` goes 2 → 3 (`ReturnTurnData.earlyFrom`, the new message).

### 6.4 Presentation and audio (amends main spec §4.2, §4.4)
- **`ViewModel.early: { player: PlayerId; prompt: PromptState } | null`:** the open early chase that
  the viewer may see (their own, or a local CPU's).
- **`render/prompts.ts`:**
  - Draws the early chase as the chase plate above that player's head, same style and pop, but with
    no timing bar before the strike.
  - At the strike, the turn's own chase plate takes over in the same place with the same progress,
    with no flash or fade between them.
- **`render/players.ts`:** no receiver movement before the strike.
- **Audio and effects:** key sounds and flashes of the local early typing play when the key is
  pressed (from the `EarlyChase` feedback events). Turn events with τ < 0 (early keys applied at a
  turn start) play no sound or effect, so there is no burst at the strike. The power-drop cue follows
  the same rule.
- **Training:**
  - The "watch" tip becomes `WHEN THEY PICK A WORD, START TYPING IT: YOU CAN CHASE EARLY`.
  - Training keeps its White-belt CPU (now on the new model) and its Relaxed pace.
- **How to Play:** the return section explains early typing (rally shots only, from the opponent's
  first letter).
- **CPU setup screen:** shows the new WPMs; nothing else changes.

## 7. Testing

- **Unit:**
  - Turn runner with early keys:
    - applied at negative τ, with the chase prompt shown at `earlyFrom`;
    - rejected when out of window, unordered, over 40 keys, non-letters, or on a serve return;
    - keys after completion ignored; the training freeze skipped;
    - an early wrong key empties the meter;
    - early keys counted in stats, and discarded with an OUT/NET call.
  - `EarlyChase`: opens at the lock, not before; closes at the strike; `keysAt` re-bases; returns
    null for a serve turn; feedback events per key.
  - Engine: `earlyFrom` for queued and stretch strikes; null on serve returns.
  - `flightTimeMs`: the serve formula is unchanged (golden values); the rally formula and `P(n)`
    with and without a floor.
  - Typist model: interpolation at 25, 98 and 140 WPM and outside; ladder labels and WPMs;
    aggression.
  - `CpuBrain.planEarly`:
    - deterministic per seed;
    - keys before and after the strike form one stream;
    - a start after the strike begins in the turn with no second pause;
    - the choice decision uses the chase completion time.
  - `turnView` at τ 0 includes early progress.
- **Sessions:**
  - Local: a human's letters before the lock show WAIT, after it they feed the early chase; a CPU's
    early plate fills live; the engine receives the keys at the strike; no strike drops them;
    attract mode plays early typing on both sides.
- **Net** (loopback):
  - `early` parse and validation; `PROTO` 3.
  - Latency invariance holds for typists that don't type early (as before). An early key is timed on
    the receiver's playback of the striker's turn, whose rate depends on latency (main spec §5.2), so
    no scripted typist can press it at the same τ at every latency. With early typing, the scripted
    match checks that both sides typed early and that there is no desync.
  - The guest's early keys give the same outcome on both machines.
  - Redaction unchanged (serve words still never leak).
- **Render:**
  - The early chase plate sits above the receiver's head, with no timing bar before the strike and
    a seamless handover.
  - No sound burst at a turn start with early keys.
- **Balance** (`npm run test:sim`): §4, including the new targets and the calibrated `CPU_NOMINAL_WPM`
  check.
- **E2E:** the automated vs-CPU match types early at least once; a devshot of an early chase plate
  while the CPU types its word.
- `npm run typecheck`, `npm test`, `npm run build` and `npm run e2e` pass.

## 8. Docs to update on completion

- Main spec:
  - §3.1 (the one-typist rule gets the early-typing exception) and §3.3 (early typing).
  - §3.4 (rally flight), §3.8 (typist model, ladder), §4.2 (early chase plate) and §4.4 (audio).
  - §5.2/§5.3 (early window in playback, `early` message, `PROTO` 3) and §6 (balance, human model).

  Each points to this spec.
- Power-meter spec §2 and §7: pointers to this spec.
- README: early typing in the Return paragraph, the new belt WPMs.
- How to Play and the Training tip (§6.4).

## 9. Out of scope

- **Take it early:** a striker who has finished hitting the ball on the rise. It is the next lever
  if early typing still leaves too little reward for speed.
- Early typing on serve returns.
- A choice-word preview before the chase word is done.
- Streaming the opponent's early typing online.
- A reaction-time stat on Results.
- CPU misjudging its time budget.
