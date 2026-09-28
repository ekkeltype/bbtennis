# Early Typing, Rally Flight and a Human-Like CPU — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The receiver may type the striker's word from the striker's lock, rally flights leave time for attacking with long words, and every CPU types with human pauses and error rates on a 25 → 140 WPM ladder.

**Architecture:** The TurnRunner takes the receiver's early keys at the start of a return turn (at their own negative τ). A new pure `EarlyChase` is what each session keeps while the striker's turn is shown, and its keys are re-based to the strike. `CpuBrain` plans the early chase as one key stream that continues into its turn. The balance simulation plays the same rules, and the constants are tuned against the spec's targets.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest, Vite; PeerJS online play; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-28-early-typing-and-human-cpu-design.md` (read it first; section numbers below are the spec's).

## Global Constraints

- Early typing is for rally shots only: it opens at the striker's choice lock and closes at the strike. Serve words stay hidden until the strike (spec §2).
- Early keys: letters `a–z`, finite non-decreasing τ within `[earlyFrom, 0]` on the receiver's clock, at most 40 (`MAX_EARLY_KEYS`); an invalid list is ignored whole (spec §6.1).
- Choice words are never shown before τ 0 of the receiver's turn (spec §2).
- Serve flight formula unchanged: `pace × (2200 + 100·len)/v × place + 250 + 750·pace` (spec §3).
- Rally flight: `pace × rallyBaseMs / v × place[tier] × P(n)`, no per-letter term; starting values `rallyBaseMs 4500`, place `1.0 / 0.70 / 0.45 / 0.30`, `pressure 0.88`, `pressureFloor 0` (spec §3).
- Typist model (spec §5): error 7 % → 4 %; word pause 950 → 600 ms; serve-return chase pause 600 → 400 ms; early pause 500 → 300 ms; all linear in label WPM from 25 to 140, held outside; wrong-key pause uniform 200–400 ms. These are **not** tuning knobs.
- Ladder WPM: `25, 28, 32, 36, 41, 46, 52, 59, 67, 76, 86, 97, 110, 124, 140`; aggression rows white 0.20, yellow 0.35, green 0.50, brown 0.65, black 0.80, 2nd dan 0.85, 3rd dan 0.90.
- `PROTO` 2 → 3. `MatchState.v` stays 2.
- Core (`src/core`) stays pure and deterministic; every gameplay constant lives in `src/core/tuning.ts`.
- If the balance targets cannot all be met, stop and take the trade-off to the user (spec §4). No target is loosened quietly.
- Match the code around each change: JSDoc summary lines that cite spec sections as `(early-typing spec §N)`, and conventional commits `feat(core): …` / `test(sim): …` / `docs: …`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
  ```

## Deviations from the spec found while planning (tell the user)

1. **km/h with no pressure floor.** `displayKmh` divides by `P(n)`, which has no floor now, so deep rallies would read thousands of km/h. The display divisor is capped at `1 / kmh.maxPressureBoost` (2, i.e. at most double). Flavour only (Task 1).
2. **Online latency invariance and early keys.** An early key is timed on the receiver's *playback* of the striker's turn, whose rate depends on latency (main spec §5.2). So no scripted typist can press it at the same τ at every latency. Latency invariance is therefore checked with typists that don't type early (as today). Early typing online is checked for no desync and for both sides typing early (Task 10). Task 10 amends spec §7 to say so.
3. **`early` message field names** are `{ key, τ }` (the `EarlyKey` type), not `{ k, τ }`.

## Review Focus

1. A human mashing keys in the early window: more than 40 keys, wrong letters, keys after the word is complete. None of it may break the turn: extra keys are ignored, and the list is never rejected by the engine. **Test: Task 4** (cap and completion) **and Task 3** (engine rejects only invalid lists).
2. A striker who never strikes (ball passes, or an OUT/NET call on the ball coming to them) after the receiver typed early. The early keys vanish: the next serve turn is unaffected and no stats change. **Test: Task 7.**
3. The receiver finishes the chase early and keeps typing before the strike. Those keys must never lock a choice word; the choice shows at τ 0 untouched. **Test: Task 3.**
4. Pausing a local match during the early window. The plate survives, and keys after the countdown are stamped on game time (the pause excluded). **Test: Task 7.**
5. An `early` message for a guest turn the host has already started, or for another turn. It is ignored, and the engine's `start` stays idempotent. **Test: Task 3** (engine) **and Task 9** (protocol validation).

---

### Task 1: Rally flight formula

**Files:**
- Modify: `src/core/tuning.ts` (the `flight` and `kmh` blocks)
- Modify: `src/core/shot.ts` (`flightTimeMs`, `displayKmh`, doc comments)
- Test: `tests/core/shot.test.ts`

**Interfaces:**
- Produces: `TUNING.flight.rallyBaseMs: number`, `TUNING.kmh.maxPressureBoost: number`; `flightTimeMs` signature unchanged (serves still use `chaseLen`).

- [ ] **Step 1: Write the failing tests.** In `tests/core/shot.test.ts`, replace these tests inside `describe('flightTimeMs')`: 'rally: pace·(2200 + 100·len)/v · place · P(n)', 'applies pressure once per two rally strikes…', 'keeps the pressure constants sane…' and 'insane rally: still uses place.insane'. The new versions are:

```ts
  it('rally: pace·rallyBase/v · place · P(n), whatever the chase word\'s length (early-typing spec §3)', () => {
    const { rallyBaseMs: b, place, pressure: p } = TUNING.flight;
    expect(flightTimeMs({ pace: 1, chaseLen: 8, v: 1, tier: 'medium', isServe: false, n: 3 })).toBeCloseTo(b * place.medium * p, 9);
    expect(flightTimeMs({ pace: 0.6, chaseLen: 5, v: 1.25, tier: 'hard', isServe: false, n: 0 })).toBeCloseTo(((0.6 * b) / 1.25) * place.hard, 9);
    for (const chaseLen of [2, 9, 15]) {
      expect(flightTimeMs({ pace: 1, chaseLen, v: 1, tier: 'easy', isServe: false, n: 0 })).toBeCloseTo(b, 9);
    }
  });

  it('applies pressure once per two rally strikes (⌊n/2⌋) and never below the floor', () => {
    const { rallyBaseMs: b, pressure: p, pressureFloor: floor } = TUNING.flight;
    const at = (n: number): number => flightTimeMs({ pace: 1, chaseLen: 3, v: 1, tier: 'easy', isServe: false, n });
    expect(at(0)).toBeCloseTo(b, 9);
    expect(at(1)).toBeCloseTo(b, 9);
    expect(at(2)).toBeCloseTo(b * p, 9);
    expect(at(4)).toBeCloseTo(b * p * p, 9);
    expect(at(5)).toBeCloseTo(b * p * p, 9);
    expect(at(200)).toBeGreaterThanOrEqual(b * floor);
    expect(at(200)).toBeLessThan(at(40));
    for (let n = 0; n <= 60; n++) expect(at(n + 1)).toBeLessThanOrEqual(at(n));
  });

  it('keeps the pressure constants sane: 0 ≤ floor < pressure < 1', () => {
    const { pressure, pressureFloor } = TUNING.flight;
    expect(pressureFloor).toBeGreaterThanOrEqual(0);
    expect(pressureFloor).toBeLessThan(pressure);
    expect(pressure).toBeLessThan(1);
  });

  it('insane rally: still uses place.insane', () => {
    const { place, rallyBaseMs, pressure } = TUNING.flight;
    expect(flightTimeMs({ pace: 1, chaseLen: 14, v: 1, tier: 'insane', isServe: false, n: 2 })).toBeCloseTo(rallyBaseMs * place.insane * pressure, 9);
  });
```

  In `describe('displayKmh')`, replace 'divides by P(n) so deeper rallies read faster, up to the floor' with:

```ts
  it('divides by P(n) so deeper rallies read faster, but never by less than 1/maxPressureBoost', () => {
    const { pressure: p } = TUNING.flight;
    const { maxPressureBoost } = TUNING.kmh;
    expect(displayKmh(1, 'easy', 1, false)).toBe(95);
    expect(displayKmh(1, 'easy', 2, false)).toBe(Math.round(95 / p));
    expect(displayKmh(1, 'easy', 4, false)).toBe(Math.round(95 / (p * p)));
    expect(displayKmh(1, 'easy', 200, false)).toBe(Math.round(95 * maxPressureBoost));
  });
```

  The serve tests ('serve: place 1 for every tier…' and 'insane serve…') stay as they are: they pin the unchanged serve formula.

- [ ] **Step 2: Run the tests to see them fail.**
  Run: `npx vitest run tests/core/shot.test.ts`
  Expected: FAIL (`rallyBaseMs` and `maxPressureBoost` are undefined, so values are NaN).

- [ ] **Step 3: Implement.** In `src/core/tuning.ts`, replace the `flight` block's `baseMs`/`perCharMs` lines, `place`, `pressure` and `pressureFloor` (keep `placeServeInsane` and the serve reading allowance with their comments):

```ts
  flight: {
    // Serves only (early-typing spec §3): T = pace·(baseMs + perCharMs·len)/v · place + the reading allowance.
    baseMs: 2200,
    perCharMs: 100,
    // Rally shots (early-typing spec §3): T = pace·rallyBaseMs/v · place[tier] · P(n), with no per-letter
    // term, since the receiver types the chase word early, during the striker's own typing. A harder
    // shot cuts the flight more (the attack). Starting values from the 2026-09-28 probe; the balance
    // simulation sets the final ones (tests/sim/balance.test.ts).
    rallyBaseMs: 4500,
    place: { easy: 1.0, medium: 0.7, hard: 0.45, insane: 0.3 } as Record<Tier, number>,
    // (keep the placeServeInsane comment and value here)
    placeServeInsane: 0.75,
    // Rally pressure P(n) = max(pressureFloor, pressure^⌊n/2⌋) (early-typing spec §3; was 0.93 with a
    // 0.65 floor): with early typing and long rally flights, rallies end only because the ball keeps
    // speeding up until someone breaks, so there is no floor. Final values: the balance simulation.
    pressure: 0.88,
    pressureFloor: 0,
    // (keep the serve reading allowance comment and both values here)
    serveReturnBonusMs: 250,
    serveReturnBonusPaceMs: 750,
  },
```

  In the same file, give `kmh` a cap:

```ts
  // maxPressureBoost: displayed km/h divides by P(n), but never by less than 1/maxPressureBoost (P(n) has no floor now).
  kmh: { base: 95, tierBonus: { easy: 1.0, medium: 1.05, hard: 1.1, insane: 1.2 } as Record<Tier, number>, serveMult: 1.25, maxPressureBoost: 2 },
```

  In `src/core/shot.ts`, replace `flightTimeMs`'s doc comment and body:

```ts
/**
 * Flight time T (ms) from a strike to the receiver's contact point (early-typing spec §3). A serve:
 * pace·(baseMs + perCharMs·len)/v · place + the reading allowance, `chaseLen` being the struck word's
 * length. A rally shot: pace·rallyBaseMs/v · place[tier] · P(n), where `n` is the number of rally
 * strikes after the serve before this one; the struck word's length does not matter.
 */
export function flightTimeMs(a: {
  pace: number;
  chaseLen: number;
  v: number;
  tier: Tier;
  isServe: boolean;
  n: number;
}): number {
  const f = TUNING.flight;
  if (a.isServe) {
    // Easy/medium/hard serves stay at place 1; an insane serve uses placeServeInsane (may exceed place.hard).
    const place = a.tier === 'insane' ? f.placeServeInsane : 1;
    return ((a.pace * (f.baseMs + f.perCharMs * a.chaseLen)) / a.v) * place + f.serveReturnBonusMs + f.serveReturnBonusPaceMs * a.pace;
  }
  return ((a.pace * f.rallyBaseMs) / a.v) * f.place[a.tier] * pressureFactor(a.n);
}
```

  Then `displayKmh`:

```ts
/**
 * Displayed ball speed in whole km/h (flavour only, spec §3.4): divides by P(n), but never by less than
 * 1/maxPressureBoost; the serve ×1.25 is applied before rounding.
 */
export function displayKmh(v: number, tier: Tier, n: number, isServe: boolean): number {
  const k = TUNING.kmh;
  const serveMult = isServe ? k.serveMult : 1;
  return Math.round((k.base * v * k.tierBonus[tier] * serveMult) / Math.max(pressureFactor(n), 1 / k.maxPressureBoost));
}
```

- [ ] **Step 4: Run the tests to see them pass.**
  Run: `npx vitest run tests/core/shot.test.ts`
  Expected: PASS.

- [ ] **Step 5: Run the whole suite and typecheck.**
  Run: `npm run typecheck && npm test`
  - A test that pinned a *rally* flight time or a rally outcome built on the old formula: recompute its expectation through `flightTimeMs` or the new formula. Don't loosen it.
  - If `tests/sim/balance.test.ts`'s smoke median band (2–10 at Normal / 50 WPM) fails, don't change it here. Note the measured median in the commit body; Task 11 re-sets the smoke band with the real targets.
  - Everything else must pass.

- [ ] **Step 6: Commit.**

```bash
git add src/core/tuning.ts src/core/shot.ts tests/core/shot.test.ts
git commit -m "feat(core): rally shots fly for choosing, with no per-letter term and no pressure floor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb"
```
(Include any test files fixed in Step 5 in the `git add`.)

---

### Task 2: Typist model, belt ladder and simulation players

**Files:**
- Modify: `src/core/tuning.ts` (new `typist` block; `CPU_MILESTONES`, `CPU_LEVEL_WPM`, new `CPU_NOMINAL_WPM`)
- Modify: `src/core/cpu.ts` (`CpuProfile`, `typistProfile`, `nominalWpmFor`, `aggressionAt`, `cpuProfile`, `CpuBrain` pauses and key timing, `CpuBrainOptions`)
- Modify: `src/core/sim.ts` (`simTypist` replaces `humanProfile` / `humanTypist` / `HUMAN_CHASE_REACTION_MS`; `SimTypist` loses `chaseReactionMs`)
- Test: `tests/core/cpu.test.ts`, `tests/sim/sim.test.ts`, `tests/sim/balance.test.ts` (mechanical rename only)

**Interfaces:**
- Produces:
  - `interface CpuProfile { wpm; nominalWpm; err; wordPauseMs; serveChasePauseMs; earlyPauseMs; aggression }` (all `number`).
  - `typistProfile(wpm: number, aggression: number, nominalWpm?: number): CpuProfile`
  - `nominalWpmFor(wpm: number): number`
  - `aggressionAt(wpm: number): number`
  - `cpuProfile(level: number): CpuProfile` (same name, new shape)
  - `CpuBrainOptions = { policy?: CpuPolicy }`
  - `simTypist(wpm: number, policy?: CpuPolicy): SimTypist`, with `SimTypist = { profile: CpuProfile; policy?: CpuPolicy }`.
  - `TUNING.typist = { wpmRange, err, wordPauseMs, serveChasePauseMs, earlyPauseMs, wrongPauseRangeMs: { min, max } }`
  - `CPU_NOMINAL_WPM: readonly number[]` (15 entries).

- [ ] **Step 1: Write the failing tests (cpu).** In `tests/core/cpu.test.ts`:
  - Import `typistProfile, nominalWpmFor, aggressionAt` from `../../src/core/cpu`, and `CPU_NOMINAL_WPM, TUNING` from `../../src/core/tuning`.
  - Replace `PROFILE` and `CLEAN`:

```ts
/** A mid-table typist used where the exact profile does not matter. */
const PROFILE: CpuProfile = { wpm: 60, nominalWpm: 60, err: 0.03, wordPauseMs: 600, serveChasePauseMs: 500, earlyPauseMs: 300, aggression: 0.5 };
/** No typing errors, so choice estimates are exact: est(len) = 500 + 200·len ms. */
const CLEAN: CpuProfile = { wpm: 60, nominalWpm: 60, err: 0, wordPauseMs: 500, serveChasePauseMs: 500, earlyPauseMs: 500, aggression: 1 };
```

  - In `describe('CPU_LEVELS')`, add to the first test: `expect([...CPU_LEVEL_WPM]).toEqual([25, 28, 32, 36, 41, 46, 52, 59, 67, 76, 86, 97, 110, 124, 140]);`
  - Replace the whole `describe('cpuProfile', …)` with:

```ts
describe('typistProfile (early-typing spec §5)', () => {
  it('uses the model end points at 25 and 140 WPM', () => {
    expect(typistProfile(25, 0.2, 27)).toEqual({ wpm: 25, nominalWpm: 27, err: 0.07, wordPauseMs: 950, serveChasePauseMs: 600, earlyPauseMs: 500, aggression: 0.2 });
    const top = typistProfile(140, 0.9, 198);
    expect(top.err).toBeCloseTo(0.04, 12);
    expect([top.wordPauseMs, top.serveChasePauseMs, top.earlyPauseMs]).toEqual([600, 400, 300]);
  });

  it('interpolates linearly in WPM between 25 and 140 (98 WPM: about 5 % errors and a 0.73 s word pause)', () => {
    const p = typistProfile(98, 0.5, 120);
    const f = (98 - 25) / 115;
    expect(p.err).toBeCloseTo(0.07 - 0.03 * f, 12);
    expect(p.wordPauseMs).toBeCloseTo(950 - 350 * f, 9);
    expect(p.serveChasePauseMs).toBeCloseTo(600 - 200 * f, 9);
    expect(p.earlyPauseMs).toBeCloseTo(500 - 200 * f, 9);
    expect(p.err).toBeCloseTo(0.051, 3);
    expect(p.wordPauseMs).toBeCloseTo(728, 0);
  });

  it('holds the rates and pauses outside 25–140 WPM but keeps the speeds', () => {
    expect(typistProfile(15, 0.2, 16)).toMatchObject({ wpm: 15, nominalWpm: 16, err: 0.07, wordPauseMs: 950 });
    expect(typistProfile(170, 0.9, 240)).toMatchObject({ wpm: 170, nominalWpm: 240, wordPauseMs: 600, earlyPauseMs: 300 });
  });

  it('defaults the nominal speed to the calibrated table', () => {
    expect(typistProfile(CPU_LEVEL_WPM[6], 0.5).nominalWpm).toBe(CPU_NOMINAL_WPM[6]);
  });

  it('rejects a speed that is not finite and positive', () => {
    for (const wpm of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => typistProfile(wpm, 0.5)).toThrow(RangeError);
  });
});

describe('nominalWpmFor', () => {
  it('is the table at each level, linear between levels, and the end ratio beyond the ladder', () => {
    CPU_LEVEL_WPM.forEach((wpm, level) => expect(nominalWpmFor(wpm)).toBe(CPU_NOMINAL_WPM[level]));
    const mid = (CPU_LEVEL_WPM[6] + CPU_LEVEL_WPM[7]) / 2;
    expect(nominalWpmFor(mid)).toBeCloseTo((CPU_NOMINAL_WPM[6]! + CPU_NOMINAL_WPM[7]!) / 2, 9);
    expect(nominalWpmFor(12.5)).toBeCloseTo((12.5 * CPU_NOMINAL_WPM[0]!) / 25, 9);
    expect(nominalWpmFor(280)).toBeCloseTo((280 * CPU_NOMINAL_WPM[14]!) / 140, 9);
  });

  it('always types faster underneath than the label', () => {
    CPU_LEVEL_WPM.forEach((wpm, level) => expect(CPU_NOMINAL_WPM[level]).toBeGreaterThan(wpm));
  });
});

describe('aggressionAt', () => {
  it('is each milestone row\'s value at its WPM, linear between rows, held beyond them', () => {
    for (const row of CPU_MILESTONES) expect(aggressionAt(row.wpm)).toBeCloseTo(row.aggression, 12);
    expect(aggressionAt(30.5)).toBeCloseTo(0.2 + 0.15 * (5.5 / 11), 12);
    expect(aggressionAt(10)).toBe(0.2);
    expect(aggressionAt(200)).toBe(0.9);
  });
});

describe('cpuProfile', () => {
  it('is the typist model at the level\'s WPM, with its calibrated nominal speed and its belt aggression', () => {
    CPU_LEVELS.forEach(({ level, wpm }) => {
      expect(cpuProfile(level)).toEqual(typistProfile(wpm, aggressionAt(wpm), CPU_NOMINAL_WPM[level]));
    });
  });

  it('gets strictly faster, more accurate, quicker and more aggressive with every level', () => {
    const profiles = CPU_LEVELS.map((l) => cpuProfile(l.level));
    for (let i = 1; i < profiles.length; i++) {
      const [prev, cur] = [profiles[i - 1]!, profiles[i]!];
      expect(cur.wpm).toBeGreaterThan(prev.wpm);
      expect(cur.nominalWpm).toBeGreaterThan(prev.nominalWpm);
      expect(cur.err).toBeLessThan(prev.err);
      expect(cur.wordPauseMs).toBeLessThan(prev.wordPauseMs);
      expect(cur.earlyPauseMs).toBeLessThan(prev.earlyPauseMs);
      expect(cur.aggression).toBeGreaterThan(prev.aggression);
    }
  });

  it('rejects levels that do not exist', () => {
    for (const level of [-1, 15, 1.5, Number.NaN]) expect(() => cpuProfile(level)).toThrow(RangeError);
  });
});
```

  - In the serve-turn tests, replace every `PROFILE.reactionMs` with `PROFILE.wordPauseMs`. In 'counts expected error time in the estimate', change the comment to `// err 0.1: est(medium 7) = 500 + 7·200·(1 + 0.1/0.9) + 0.1·7·300 ≈ 2266 ms > 2400 − 250.`
  - In `describe('CpuBrain — return turns')`, replace the first test:

```ts
  it('starts a rally chase earlyPauseMs after it is shown and a serve-return chase serveChasePauseMs after', () => {
    expect(new CpuBrain(0, PROFILE, 1).plan(returnTurn())[0]?.τ).toBe(PROFILE.earlyPauseMs);
    expect(new CpuBrain(0, PROFILE, 1).plan(returnTurn({ isServeReturn: true }))[0]?.τ).toBe(PROFILE.serveChasePauseMs);
  });
```
    In 'plans the choice with the chase…', replace `PROFILE.reactionMs` with `PROFILE.wordPauseMs` and rename it to '…its first key comes a word pause after the chase completes'.
  - Delete `describe('CpuBrain — chase reaction override (opts.chaseReactionMs)', …)` and add:

```ts
describe('CpuBrain — profile checks', () => {
  it('rejects a profile whose speeds, error rate or pauses would produce NaN or negative times', () => {
    const bad: Partial<CpuProfile>[] = [
      { nominalWpm: 0 }, { wpm: Number.NaN }, { err: 1 }, { err: -0.1 },
      { wordPauseMs: -1 }, { serveChasePauseMs: Number.POSITIVE_INFINITY }, { earlyPauseMs: Number.NaN }, { aggression: Number.NaN },
    ];
    for (const b of bad) expect(() => new CpuBrain(0, { ...PROFILE, ...b }, 1)).toThrow(RangeError);
  });
});
```
  - 'skipped keys': replace `SLOPPY.reactionMs` with `SLOPPY.wordPauseMs`; rename '…a full reaction after…' to '…a word pause after…'.
  - 'turn ids': replace `PROFILE.reactionMs * 0.5` with `PROFILE.earlyPauseMs`.
  - 'key timing':
    - Replace the ±10 % test:

```ts
  it.each([0, 6, 9, 12, 14])("types 1,000 easy/medium words within ±10 %% of level %i's nominal speed slowed by its error pauses", (level) => {
    const profile = cpuProfile(level);
    const { min, max } = TUNING.typist.wrongPauseRangeMs;
    const expected = 12000 / (12000 / profile.nominalWpm + profile.err * ((min + max) / 2));
    const words = typeWords(profile, 100 + level, EASY_MEDIUM).filter((w) => w.word.tier !== 'hard');
    expect(words.length).toBeGreaterThanOrEqual(1000);
    expect(words.some((w) => w.prompt.wrongKeys > 0)).toBe(true);
    expect(averageWpm(words) / expected).toBeGreaterThan(0.9);
    expect(averageWpm(words) / expected).toBeLessThan(1.1);
  });
```
    - Rename 'follows each wrong key with the right letter 150–300 ms later' to '…200–400 ms later', with bounds `toBeGreaterThanOrEqual(200)` and `toBeLessThan(400)`.
    - In 'spaces keys by I·f·…' and 'hesitates 250–500 ms…', build the profile as `{ ...PROFILE, wpm: 120, nominalWpm: 120, err: 0 }` and use `12000 / profile.nominalWpm` for the interval.

- [ ] **Step 2: Write the failing tests (sim).** In `tests/sim/sim.test.ts`:
  - Imports: replace `HUMAN_CHASE_REACTION_MS, humanProfile, humanTypist` with `simTypist`. Import `aggressionAt, typistProfile` from `../../src/core/cpu`.
  - `const HUMAN_50 = simTypist(50);`
  - Delete `humanServeLock`, `describe('humanProfile …')`, `describe('the human model\'s serve choice …')` and `describe('humanTypist')`. Add:

```ts
describe('simTypist (early-typing spec §4, §5)', () => {
  it("is the typist model at that speed with the ladder's aggression and the adaptive policy by default", () => {
    expect(simTypist(70)).toEqual({ profile: typistProfile(70, aggressionAt(70)), policy: 'adaptive' });
    expect(simTypist(70, 'neverHard').policy).toBe('neverHard');
  });
});
```
  - 'never stalls…': use `[simTypist(15), simTypist(160)]`.
  - Replace the chase-reaction test:

```ts
  it("passes each typist's profile to its brain: a receiver who pauses a minute before a serve's chase word is aced by every serve that lands", () => {
    const asleep: SimTypist = { profile: { ...typistProfile(50, 0.5), serveChasePauseMs: 60000 } };
    const points = simulatePoints({ config: CONFIG, typists: [HUMAN_50, asleep], seed: 9, points: 60 });
    const received = points.filter((p) => serverOf(p) === 0);
    expect(received.length).toBeGreaterThan(10);
    for (const p of received) expect(['ace', 'doubleFault']).toContain(p.reason);
    expect(received.some((p) => p.reason === 'ace')).toBe(true);
  });
```
  - In 'fast, accurate equal players reach full meters…', use `simTypist(140)` for both.
  - In `tests/sim/balance.test.ts`, replace the import of `humanTypist` with `simTypist`, and every `humanTypist(` with `simTypist(`. (The targets change in Task 11.)

- [ ] **Step 3: Run to see the failures.**
  Run: `npx vitest run tests/core/cpu.test.ts tests/sim/sim.test.ts`
  Expected: FAIL (missing exports, and the profile shape differs).

- [ ] **Step 4: Implement `tuning.ts`.** After the `power` entry in `TUNING`, add:

```ts
  // Typist model (early-typing spec §5): every CPU and both balance-simulation players. Each
  // [at 25 WPM, at 140 WPM] pair is linear in the label WPM between those two and held outside.
  // These are the agreed human estimates, not tuning knobs.
  typist: {
    wpmRange: [25, 140],
    err: [0.07, 0.04],
    /** Before a serve word (after the toss) and before choice words. */
    wordPauseMs: [950, 600],
    /** Before the chase word of a serve return (never seen before). */
    serveChasePauseMs: [600, 400],
    /** Before an early chase word, from the striker's lock (its word was already in their stack). */
    earlyPauseMs: [500, 300],
    /** After a wrong key, before the right letter: uniform in this range. */
    wrongPauseRangeMs: { min: 200, max: 400 },
  },
```

  Replace `CPU_MILESTONES` and `CPU_LEVEL_WPM`, and add `CPU_NOMINAL_WPM`:

```ts
/** CPU milestone rows (early-typing spec §5): each belt's WPM and aggression; stripes interpolate aggression linearly in WPM between rows. */
export const CPU_MILESTONES = [
  { belt: 'white', wpm: 25, aggression: 0.2 },
  { belt: 'yellow', wpm: 36, aggression: 0.35 },
  { belt: 'green', wpm: 52, aggression: 0.5 },
  { belt: 'brown', wpm: 76, aggression: 0.65 },
  { belt: 'black', wpm: 110, aggression: 0.8 },
  { belt: 'black2', wpm: 124, aggression: 0.85 },
  { belt: 'black3', wpm: 140, aggression: 0.9 },
] as const;

/** The 15 CPU levels' label WPM (index = level): about 13 % apart; what each level's Results screen shows (early-typing spec §5). */
export const CPU_LEVEL_WPM = [25, 28, 32, 36, 41, 46, 52, 59, 67, 76, 86, 97, 110, 124, 140] as const;

/**
 * The speed each level types at underneath (index = level): hesitations on hard words and error pauses
 * slow it to its label WPM. First estimate: 12000 / (12000/label − 13 ms − err·300 ms); the balance
 * simulation's honest-labels check calibrates it (tests/sim/balance.test.ts).
 */
export const CPU_NOMINAL_WPM = [27, 30, 35, 40, 46, 53, 60, 70, 81, 94, 109, 126, 147, 170, 198] as const;
```

- [ ] **Step 5: Implement `cpu.ts`.**
  - Imports: `CPU_LEVEL_WPM, CPU_MILESTONES, CPU_NOMINAL_WPM, TUNING` from `./tuning`.
  - Replace `CpuProfile` and `cpuProfile`, and add the model functions:

```ts
/** A typist's parameters (early-typing spec §5): label and nominal speed, per-key error rate, pauses before a prompt's first key, aggression. */
export interface CpuProfile {
  /** Label WPM: the average its Results screen shows. */
  wpm: number;
  /** The speed it types at underneath: mean key interval 12/nominalWpm s. */
  nominalWpm: number;
  err: number;
  /** Before a serve word (after the toss) and before choice words. */
  wordPauseMs: number;
  /** Before the chase word of a serve return. */
  serveChasePauseMs: number;
  /** Before a rally chase word, from when it is shown: the striker's lock (early typing). */
  earlyPauseMs: number;
  aggression: number;
}

/** Share of the way from the model's slowest row (25 WPM) to its fastest (140 WPM), held at the ends. */
function modelShare(wpm: number): number {
  const [lo, hi] = TUNING.typist.wpmRange;
  return clamp((wpm - lo) / (hi - lo), 0, 1);
}

/**
 * The typist model at label speed `wpm` (early-typing spec §5): error rate and pauses linear in WPM from
 * 25 to 140 and held outside; `nominalWpm` defaults to the calibrated speed for that label. Throws a
 * RangeError for a speed that is not finite and positive.
 */
export function typistProfile(wpm: number, aggression: number, nominalWpm: number = nominalWpmFor(wpm)): CpuProfile {
  if (!Number.isFinite(wpm) || wpm <= 0) throw new RangeError(`typistProfile: WPM must be finite and positive, got ${wpm}`);
  const m = TUNING.typist;
  const f = modelShare(wpm);
  return {
    wpm,
    nominalWpm,
    err: lerp(m.err[0], m.err[1], f),
    wordPauseMs: lerp(m.wordPauseMs[0], m.wordPauseMs[1], f),
    serveChasePauseMs: lerp(m.serveChasePauseMs[0], m.serveChasePauseMs[1], f),
    earlyPauseMs: lerp(m.earlyPauseMs[0], m.earlyPauseMs[1], f),
    aggression,
  };
}

/** Nominal speed for label `wpm`: CPU_NOMINAL_WPM, linear in label WPM between levels, and the end levels' ratio beyond them. */
export function nominalWpmFor(wpm: number): number {
  const labels: readonly number[] = CPU_LEVEL_WPM;
  const nominal: readonly number[] = CPU_NOMINAL_WPM;
  const last = labels.length - 1;
  if (wpm <= labels[0]!) return (wpm * nominal[0]!) / labels[0]!;
  if (wpm >= labels[last]!) return (wpm * nominal[last]!) / labels[last]!;
  const hi = labels.findIndex((l) => l >= wpm);
  return lerp(nominal[hi - 1]!, nominal[hi]!, (wpm - labels[hi - 1]!) / (labels[hi]! - labels[hi - 1]!));
}

/** Aggression at label `wpm` (early-typing spec §5): the milestone rows' values, linear in WPM between rows, held beyond them. */
export function aggressionAt(wpm: number): number {
  const rows = CPU_MILESTONES;
  const first = rows[0];
  const last = rows[rows.length - 1]!;
  if (wpm <= first.wpm) return first.aggression;
  if (wpm >= last.wpm) return last.aggression;
  const hi = rows.findIndex((r) => r.wpm >= wpm);
  const lo = rows[hi - 1]!;
  const top = rows[hi]!;
  return lerp(lo.aggression, top.aggression, (wpm - lo.wpm) / (top.wpm - lo.wpm));
}

/** Profile of a level: the typist model at its label WPM, with its calibrated nominal speed and its belt's aggression. */
export function cpuProfile(level: number): CpuProfile {
  const wpm = levelWpm(level);
  return typistProfile(wpm, aggressionAt(wpm), CPU_NOMINAL_WPM[level]!);
}
```

  - `CpuBrainOptions`: `export interface CpuBrainOptions { policy?: CpuPolicy }` (doc: "Optional CpuBrain settings: `policy` defaults to 'adaptive'.").
  - The constructor: drop the `chaseReactionMs` field, its validation and its assignment.
  - `CPU` constants: remove `rallyChaseReaction`, `errorPause` and `errorEstimateMs`.
  - `planServe`: pass `this.profile.wordPauseMs` to `newPlan` (was `reactionMs`).
  - `planReturn`: the chase pause is `const chasePause = d.isServeReturn ? this.profile.serveChasePauseMs : this.profile.earlyPauseMs;`, and the choice uses `this.profile.wordPauseMs`. Update its doc comment: "Chase keys a serve-return pause (serve return) or an early pause (rally) after the chase is shown, then the choice keys a word pause after the chase completes, judged against T from now."
  - `estimateMs`:

```ts
  /** est = word pause + len·I·(1 + err/(1 − err)) + err·len·mean wrong-key pause (early-typing spec §5). */
  private estimateMs(len: number): number {
    const { err, wordPauseMs } = this.profile;
    const { min, max } = TUNING.typist.wrongPauseRangeMs;
    return wordPauseMs + len * this.intervalMs() * (1 + err / (1 - err)) + err * len * ((min + max) / 2);
  }

  /** Mean key interval I = 12/nominal WPM s, in ms. */
  private intervalMs(): number {
    return 12000 / this.profile.nominalWpm;
  }
```
  - `typeWord`'s error pause: `τ += uniformIn(rng, TUNING.typist.wrongPauseRangeMs.min, TUNING.typist.wrongPauseRangeMs.max);`
  - `isValidProfile`:

```ts
/** Finite positive speeds, 0 ≤ err < 1, finite non-negative pauses, finite aggression: no NaN or negative times. */
function isValidProfile(p: CpuProfile): boolean {
  return (
    Number.isFinite(p.wpm) && p.wpm > 0 &&
    Number.isFinite(p.nominalWpm) && p.nominalWpm > 0 &&
    p.err >= 0 && p.err < 1 &&
    isDelayMs(p.wordPauseMs) && isDelayMs(p.serveChasePauseMs) && isDelayMs(p.earlyPauseMs) &&
    Number.isFinite(p.aggression)
  );
}
```

- [ ] **Step 6: Implement `sim.ts`.**
  - Delete `HUMAN`, `HUMAN_AGGRESSION`, `HUMAN_CHASE_REACTION_MS`, `humanProfile` and `humanTypist`, and remove the imports that become unused (`clamp`, `lerp`).
  - Import `aggressionAt, typistProfile` from `./cpu`.
  - Replace `SimTypist` and add `simTypist`:

```ts
/** A simulated typist: a CpuBrain with this profile and choice policy (default 'adaptive'). */
export interface SimTypist { profile: CpuProfile; policy?: CpuPolicy }

/**
 * A balance-simulation player at `wpm` (early-typing spec §4, §5): the typist model's pauses and errors
 * at that speed, the calibrated nominal speed, and the aggression the belt ladder gives that speed.
 */
export function simTypist(wpm: number, policy: CpuPolicy = 'adaptive'): SimTypist {
  return { profile: typistProfile(wpm, aggressionAt(wpm)), policy };
}
```
  - `brainFor`: `return new CpuBrain(player, t.profile, seed, { policy: t.policy });`

- [ ] **Step 7: Run the tests, typecheck and the whole suite.**
  Run: `npx vitest run tests/core/cpu.test.ts tests/sim/sim.test.ts && npm run typecheck && npm test`
  Expected: PASS. Any other test that builds a `CpuProfile` literal or passes `chaseReactionMs` fails to typecheck; give it the new shape (use `typistProfile(...)` or the literal fields above). The balance smoke band follows the Task 1 rule.

- [ ] **Step 8: Commit.**

```bash
git add src/core/tuning.ts src/core/cpu.ts src/core/sim.ts tests/core/cpu.test.ts tests/sim/sim.test.ts tests/sim/balance.test.ts
git commit -m "feat(core): one human-like typist model for every CPU and the balance sim, on a 25-140 WPM ladder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb"
```

---

### Task 3: The TurnRunner and the Engine take early keys

**Files:**
- Modify: `src/core/types.ts` (`EarlyKey`, `ReturnTurnData.earlyFrom`)
- Modify: `src/core/turn.ts` (`MAX_EARLY_KEYS`, `startTurn(t, early)`, `validEarly`, `showPrompt` freeze clamp, `completed` choice at τ ≥ 0)
- Modify: `src/core/engine.ts` (`earlyFrom` in `returnTurn`, `start(player, early)`)
- Test: `tests/core/turnFixtures.ts` (default `earlyFrom: null`), `tests/core/turn.test.ts`, `tests/core/engine.test.ts`, `tests/core/cpu.test.ts` (fixture field)

**Interfaces:**
- Produces:
  - `interface EarlyKey { key: string; τ: number }` (in `types.ts`)
  - `ReturnTurnData.earlyFrom: number | null`
  - `MAX_EARLY_KEYS = 40` (exported from `turn.ts`)
  - `startTurn(t: TurnState, early?: readonly EarlyKey[]): GameEvent[]`
  - `Engine.start(player: PlayerId, early?: readonly EarlyKey[]): GameEvent[]`

- [ ] **Step 1: Add the type fields, so the tests can compile.** In `src/core/types.ts`, before `ReturnTurnData`:

```ts
/** A key the receiver typed before the strike (early-typing spec §2): a letter at receiver-clock τ ≤ 0. */
export interface EarlyKey { key: string; τ: number }
```
  In `ReturnTurnData`, after `isServeReturn`:

```ts
  earlyFrom: number | null; // receiver-clock τ (≤ 0) at which early typing opened: the striker's lock − the strike; null on a serve return (early-typing spec §2)
```
  - `tests/core/turnFixtures.ts` `returnData`: add `earlyFrom: null,` before `...over`.
  - `tests/core/cpu.test.ts` `returnTurn`: add `earlyFrom?: number | null` to `ReturnOpts`. Build the data with `earlyFrom: o.earlyFrom === undefined ? (isServeReturn ? null : 0) : o.earlyFrom`. Show the chase at `const shownAt = data.earlyFrom ?? 0;` (`createPrompt(data.promptBase, 'chase', [chase], shownAt)` and the `'show'` log entry at `shownAt`).
  - Add `earlyFrom: null` to any other `ReturnTurnData` literal that `npm run typecheck` then flags.

- [ ] **Step 2: Write the failing TurnRunner tests.** Append to `tests/core/turn.test.ts`:

```ts
describe('early typing (early-typing spec §2)', () => {
  const EARLY = (): ReturnTurnData => returnData({ earlyFrom: -1000 }); // chase 'ball', choice drop / volley / crosscourt

  it('shows the chase at earlyFrom and applies early keys at their own τ before τ 0', () => {
    const t = createTurn(EARLY());
    const events = startTurn(t, [{ key: 'b', τ: -600 }, { key: 'a', τ: -500 }]);
    const chase = t.prompts[0]!;
    expect(chase.shownAt).toBe(-1000);
    expect([chase.typed, chase.tFirst, chase.tLast]).toEqual([2, -600, -500]);
    expect(tags(events)).toEqual(['turnStart@0', 'promptShown@-1000', 'keyOk@-600', 'keyOk@-500']);
    expect(t.phase).toBe('chase');
    type(t, 'll', 100);
    expect(chase.completedAt).toBe(200);
    expect(t.prompts[1]?.shownAt).toBe(200);
  });

  it('a chase finished before the strike shows the choice at τ 0, and later early keys never reach it', () => {
    const t = createTurn(EARLY());
    startTurn(t, [...'balldr'].map((key, i) => ({ key, τ: -900 + 100 * i })));
    const [chase, choice] = t.prompts;
    expect(chase?.completedAt).toBe(-600);
    expect(choice?.shownAt).toBe(0);
    expect([choice?.locked, choice?.typed]).toEqual([null, 0]);
    expect(t.phase).toBe('choice');
  });

  it('an early wrong key is a slip that empties the meter at its τ', () => {
    const t = createTurn(returnData({ earlyFrom: -1000, power: 3 }));
    const events = startTurn(t, [{ key: 'b', τ: -800 }, { key: 'x', τ: -700 }, { key: 'a', τ: -600 }]);
    expect(t.prompts[0]).toMatchObject({ slips: 1, wrongKeys: 1, typed: 2 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'power', from: 3, to: 0, τ: -700 }));
  });

  it.each([
    ['a key before earlyFrom', [{ key: 'b', τ: -1001 }]],
    ['a key after the strike', [{ key: 'b', τ: 1 }]],
    ['keys out of order', [{ key: 'b', τ: -500 }, { key: 'a', τ: -600 }]],
    ['a non-letter', [{ key: 'toss', τ: -500 }]],
    ['a non-finite τ', [{ key: 'b', τ: Number.NaN }]],
    ['more than MAX_EARLY_KEYS keys', Array.from({ length: MAX_EARLY_KEYS + 1 }, (_, i) => ({ key: 'z', τ: -900 + i }))],
  ])('ignores the whole list with %s', (_name, early) => {
    const t = createTurn(EARLY());
    startTurn(t, early);
    expect(t.prompts[0]).toMatchObject({ typed: 0, wrongKeys: 0, shownAt: -1000 });
  });

  it('takes no early keys on a serve return', () => {
    const t = createTurn(returnData({ isServeReturn: true, earlyFrom: null, n: 0 }));
    startTurn(t, [{ key: 'b', τ: -100 }]);
    expect(t.prompts[0]).toMatchObject({ typed: 0, shownAt: 0 });
  });

  it('training: a chase shown early freezes from τ 0, and not at all once early keys came', () => {
    const frozen = createTurn(returnData({ earlyFrom: -1000, freezeFirst: true }));
    startTurn(frozen);
    expect(frozen.freezeSince).toBe(0);
    const typed = createTurn(returnData({ earlyFrom: -1000, freezeFirst: true }));
    startTurn(typed, [{ key: 'b', τ: -500 }]);
    expect(typed.freezeSince).toBeNull();
    expect(typed.seenKinds).toContain('chase');
  });
});
```
  Add `MAX_EARLY_KEYS` to the `../../src/core/turn` import.

- [ ] **Step 3: Write the failing Engine tests.** Append to `tests/core/engine.test.ts` (reusing its `newEngine`, `byRole`, `scripted`, `Driver` and `strikeOf` helpers):

```ts
describe('Engine: early typing (early-typing spec §2)', () => {
  const returnDataOf = (t: TurnState | null): ReturnTurnData => {
    if (t?.data.kind !== 'return') throw new Error('expected a return turn');
    return t.data;
  };

  /** Plays the serve and the receiver's return (easy choice); the server's rally chase turn is next. */
  function toServersChase(seed = 17) {
    const e = newEngine(seed);
    const server = e.owner() as PlayerId;
    const d = new Driver(e, byRole(server, scripted({ choice: null }), scripted({ choice: 0 })));
    d.playTurn();
    const serveReturn = e.state.turn as TurnState;
    d.playTurn();
    return { e, server, serveReturn };
  }

  it("a serve return has no early window; the next rally turn's opens at the striker's lock", () => {
    const { e, server, serveReturn } = toServersChase();
    expect(returnDataOf(serveReturn).earlyFrom).toBeNull();
    const striker = e.state.lastTurn as TurnState;
    const lock = striker.log.find((x) => x.k === 'lock');
    const next = returnDataOf(e.state.turn);
    expect(next.owner).toBe(server);
    expect(next.earlyFrom).toBe((lock?.τ ?? Number.NaN) - strikeOf(striker).τ);
    expect(next.earlyFrom).toBeLessThan(0);
  });

  it('start takes early keys: the chase is typed before τ 0 and the choice waits for τ 0', () => {
    const { e, server } = toServersChase();
    const d = returnDataOf(e.state.turn);
    const from = d.earlyFrom as number;
    const step = -from / (d.chase.len + 1);
    const events = e.start(server, [...d.chase.word].map((key, i) => ({ key, τ: from + step * (i + 1) })));
    const [chase, choice] = (e.state.turn as TurnState).prompts;
    expect(chase?.completedAt).toBeLessThan(0);
    expect(choice?.shownAt).toBe(0);
    expect(events.filter((x) => x.type === 'keyOk').every((x) => x.τ < 0)).toBe(true);
  });

  it('start on a started turn does nothing, early keys or not', () => {
    const { e, server } = toServersChase();
    e.start(server);
    const before = JSON.stringify(e.state);
    expect(e.start(server, [{ key: 'z', τ: -1 }])).toEqual([]);
    expect(JSON.stringify(e.state)).toBe(before);
  });
});
```
  Add `ReturnTurnData` to the test's type imports if it is missing.

- [ ] **Step 4: Run to see the failures.**
  Run: `npx vitest run tests/core/turn.test.ts tests/core/engine.test.ts`
  Expected: FAIL (`startTurn` ignores the early keys and `earlyFrom` is undefined on engine turns).

- [ ] **Step 5: Implement `turn.ts`.**
  - Import `EarlyKey` (type) from `./types`.
  - Add, after `LETTER`:

```ts
/** Most early keys a return turn takes (early-typing spec §6.1). */
export const MAX_EARLY_KEYS = 40;
```
  - Replace `startTurn`:

```ts
/**
 * Starts the owner's clock at τ=0 (idempotent). Returns events (turnStart, preServe or promptShown...).
 * A rally return turn (earlyFrom set) shows its chase prompt at earlyFrom, the striker's lock, and
 * first applies `early`: the keys its owner typed before the strike, each at its own τ ≤ 0, until the
 * chase word is complete (early-typing spec §2). An invalid list is ignored whole (`validEarly`).
 */
export function startTurn(t: TurnState, early: readonly EarlyKey[] = []): GameEvent[] {
  if (t.started) return [];
  const d = t.data;
  const out: GameEvent[] = [];
  t.started = true;
  t.τ = 0;
  emit(t, out, 0, { type: 'turnStart', owner: d.owner, kind: d.kind });
  if (d.kind === 'return') {
    const keys = validEarly(d, early) ? early : [];
    showPrompt(t, 'chase', [d.chase], d.earlyFrom ?? 0, out, keys.length === 0);
    const chase = t.prompts[0];
    for (const k of keys) {
      if (chase === undefined || isComplete(chase)) break;
      letter(t, k.key, k.τ, out);
    }
  }
  advance(t, 0, true, out);
  return out;
}

/**
 * True when `early` may start `d` (early-typing spec §6.1): a rally return turn, and at most
 * MAX_EARLY_KEYS letters a–z at finite, non-decreasing τ within [earlyFrom, 0].
 */
function validEarly(d: ReturnTurnData, early: readonly EarlyKey[]): boolean {
  const from = d.earlyFrom;
  if (from === null || d.isServeReturn || early.length > MAX_EARLY_KEYS) return false;
  let last = from;
  for (const k of early) {
    if (!LETTER.test(k.key) || !Number.isFinite(k.τ) || k.τ < last || k.τ > 0) return false;
    last = k.τ;
  }
  return true;
}
```
  - `showPrompt` gains a last parameter `mayFreeze = true`. Its freeze block becomes:

```ts
  if (mayFreeze && t.data.freezeFirst && t.freezeSince === null) {
    // A chase shown before the strike (early typing) freezes from τ 0, when this turn's clock starts.
    const at = Math.max(τ, 0);
    t.freezeSince = at;
    t.log.push({ τ: at, k: 'freeze', on: true });
  }
```
    Update its doc comment: "…the first prompt of a kind freezes the simulation until its first correct key (from τ 0 at the earliest), unless `mayFreeze` is false (early keys came)."
  - In `completed`, the chase branch becomes:

```ts
  if (p.kind === 'chase') {
    // Choice words never show before the strike (early-typing spec §2): an early chase shows them at τ 0.
    const at = Math.max(τ, 0);
    t.phase = 'choice';
    showPrompt(t, 'choice', choiceOptions(t, d, at), at, out);
    return;
  }
```

- [ ] **Step 6: Implement `engine.ts`.**
  - Import `EarlyKey` (type).
  - `start`:

```ts
  /** Starts the current turn's clock (owner's τ = 0) with its owner's early keys, if any (early-typing spec §2); the match's first start also emits the coin toss. */
  start(player: PlayerId, early: readonly EarlyKey[] = []): GameEvent[] {
    const t = this.turnOwnedBy(player);
    if (t === null || t.started) return [];
    const opening = t.data.kind === 'serve' && t.data.leadIn.kind === 'intro';
    return this.run(t, () => {
      const events = startTurn(t, early);
      return opening ? [stamp(t, 0, { type: 'coinToss', winner: t.data.owner }), ...events] : events;
    });
  }
```
  - In `returnTurn`, add `earlyFrom: earlyFromOf(prev, strike),` after `isServeReturn: strike.isServe,`.
  - Add near the other module functions:

```ts
/** Receiver-clock τ at which early typing opened for the turn after `strike` (early-typing spec §2): the striker's choice lock minus the strike; null after a serve. */
function earlyFromOf(prev: TurnState, strike: StrikeInfo): number | null {
  if (strike.isServe) return null;
  const lock = prev.log.find((e) => e.k === 'lock');
  return lock === undefined ? null : lock.τ - strike.τ;
}
```

- [ ] **Step 7: Run the tests, the typecheck and the suite.**
  Run: `npx vitest run tests/core/turn.test.ts tests/core/engine.test.ts && npm run typecheck && npm test`
  Expected: PASS. A rally chase is now shown at a negative τ, so a test typist that starts at "shown + keyMs" starts at τ 0 instead. Fix any test that pinned such a time by recomputing it; don't loosen it.

- [ ] **Step 8: Commit.**

```bash
git add src/core/types.ts src/core/turn.ts src/core/engine.ts tests/core
git commit -m "feat(core): a rally return turn starts with the chase keys its owner typed before the strike

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb"
```

---

### Task 4: `EarlyChase`, the early window a session keeps

**Files:**
- Create: `src/core/early.ts`
- Test: `tests/core/early.test.ts`

**Interfaces:**
- Consumes: `MAX_EARLY_KEYS` and `EarlyKey` (Task 3); `applyLetter`, `createPrompt`, `isComplete`, `wordCps`, `wpmOf` (`typing.ts`).
- Produces:
  - `EARLY_PROMPT = -1`
  - `class EarlyChase` with:
    - fields `player: PlayerId`, `turnId: number`, `lockτ: number`, `prompt: PromptState`, and getter `count: number`;
    - `static open(t, τ, power): { chase: EarlyChase; events: GameEvent[] } | null`;
    - `press(letter: string, τ: number): GameEvent[]`;
    - `keysAt(strikeτ: number): EarlyKey[]`.
  - `withoutEarlyEvents(events: readonly GameEvent[]): GameEvent[]`

- [ ] **Step 1: Write the failing tests.** Create `tests/core/early.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EARLY_PROMPT, EarlyChase, withoutEarlyEvents } from '../../src/core/early';
import { createTurn, MAX_EARLY_KEYS, startTurn, turnInput } from '../../src/core/turn';
import type { GameEvent, TurnState } from '../../src/core/types';
import { returnData, serveData } from './turnFixtures';

/** Player 1's return turn (turn 8): its chase 'ball' typed at 100..400, then 'drop' (choice) locked at `lockAt`. */
function locked(lockAt = 600): TurnState {
  const t = createTurn(returnData());
  startTurn(t);
  [...'ball'].forEach((ch, i) => turnInput(t, ch, 100 * (i + 1)));
  turnInput(t, 'd', lockAt);
  return t;
}

const opened = (t: TurnState, τ: number, power: number | null = 0): EarlyChase => {
  const o = EarlyChase.open(t, τ, power);
  if (o === null) throw new Error('expected an early chase');
  return o.chase;
};

describe('EarlyChase (early-typing spec §2)', () => {
  it("opens for the striker's opponent once the choice word is locked, not before", () => {
    const t = locked(600);
    expect(EarlyChase.open(t, 599, 0)).toBeNull();
    const o = EarlyChase.open(t, 600, 0);
    expect(o?.chase).toMatchObject({ player: 0, turnId: 8, lockτ: 600 });
    expect(o?.chase.prompt).toMatchObject({ kind: 'chase', options: [{ word: 'drop' }], locked: 0, shownAt: 600, typed: 0 });
    expect(o?.events).toEqual([{ turn: 8, τ: 600, type: 'promptShown', player: 0, prompt: EARLY_PROMPT, kind: 'chase' }]);
  });

  it('never opens on a serve turn or an unlocked return turn', () => {
    const serve = createTurn(serveData());
    startTurn(serve);
    expect(EarlyChase.open(serve, 1e6, 0)).toBeNull();
    const ret = createTurn(returnData());
    startTurn(ret);
    expect(EarlyChase.open(ret, 1e6, 0)).toBeNull();
  });

  it("types with the chase rules and gives feedback events on the striker's clock", () => {
    const early = opened(locked(), 600, 2);
    expect(early.press('d', 900)).toEqual([{ turn: 8, τ: 900, type: 'keyOk', player: 0, prompt: EARLY_PROMPT }]);
    expect(early.press('x', 1000).map((e) => e.type)).toEqual(['keyBad', 'power']);
    expect(early.press('y', 1050).map((e) => e.type)).toEqual(['keyBad']); // the meter is empty already
    early.press('r', 1100);
    early.press('o', 1200);
    expect(early.press('p', 1300).map((e) => e.type)).toEqual(['keyOk', 'wordDone']);
    expect(early.prompt).toMatchObject({ typed: 4, wrongKeys: 2, slips: 1, completedAt: 1300 });
  });

  it('ignores keys once the word is complete and after MAX_EARLY_KEYS keys', () => {
    const done = opened(locked(), 600);
    [...'drop'].forEach((ch, i) => done.press(ch, 700 + i));
    expect(done.press('d', 800)).toEqual([]);
    expect(done.count).toBe(4);
    const mash = opened(locked(), 600);
    mash.press('d', 700);
    for (let i = 0; i < 100; i++) mash.press('z', 701 + i);
    expect(mash.count).toBe(MAX_EARLY_KEYS);
    expect(mash.prompt.completedAt).toBeNull();
  });

  it('keeps its keys in time order and never before the lock', () => {
    const early = opened(locked(600), 600);
    early.press('d', 500);
    early.press('r', 450);
    expect(early.keysAt(2000)).toEqual([{ key: 'd', τ: -1400 }, { key: 'r', τ: -1400 }]);
  });

  it("re-bases its keys to the receiver's clock for a strike, leaving out keys after it", () => {
    const early = opened(locked(600), 600);
    early.press('d', 700);
    early.press('r', 800);
    early.press('o', 950);
    expect(early.keysAt(900)).toEqual([{ key: 'd', τ: -200 }, { key: 'r', τ: -100 }]);
  });
});

describe('withoutEarlyEvents', () => {
  it('drops events stamped before τ 0 and keeps the rest in order', () => {
    const ev = (τ: number): GameEvent => ({ turn: 1, τ, type: 'keyOk', player: 0, prompt: 1 });
    expect(withoutEarlyEvents([ev(-5), ev(0), ev(-1), ev(3)])).toEqual([ev(0), ev(3)]);
  });
});
```

- [ ] **Step 2: Run to see the failure.**
  Run: `npx vitest run tests/core/early.test.ts`
  Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `src/core/early.ts`:

```ts
import { MAX_EARLY_KEYS } from './turn';
import { other, type EarlyKey, type EventBody, type GameEvent, type PlayerId, type PromptState, type TurnState } from './types';
import { applyLetter, createPrompt, isComplete, wordCps, wpmOf } from './typing';

/** Prompt id of an early chase's feedback events: the receiver's real chase prompt does not exist before the strike. */
export const EARLY_PROMPT = -1;

const LETTER = /^[a-z]$/;

/**
 * A chase word typed early (early-typing spec §2): what a session keeps for the receiver while the
 * striker's return turn is shown, from its choice lock to its strike. Times are on the striker's turn
 * clock; `keysAt` re-bases them to the receiver's for `Engine.start`.
 */
export class EarlyChase {
  private readonly keys: EarlyKey[] = [];

  private constructor(
    /** The receiver: the player who will chase the word. */
    readonly player: PlayerId,
    /** The striker's turn, whose choice lock opened the window. */
    readonly turnId: number,
    /** The lock's τ on the striker's clock. */
    readonly lockτ: number,
    /** The chase prompt: the locked word, shown at the lock. */
    readonly prompt: PromptState,
    /** The receiver's meter level (null = meter off), for the feedback of a first wrong key. */
    private level: number | null,
  ) {}

  /**
   * The early chase of return turn `t` for its receiver once `t`'s choice word is locked at or before τ
   * (t's clock), with the event that shows it; null for any other turn. `power` is the receiver's meter
   * level (null = meter off).
   */
  static open(t: TurnState, τ: number, power: number | null): { chase: EarlyChase; events: GameEvent[] } | null {
    if (t.data.kind !== 'return') return null;
    const lock = t.log.find((e) => e.k === 'lock');
    if (lock?.k !== 'lock' || lock.τ > τ) return null;
    const word = t.prompts.find((p) => p.id === lock.prompt)?.options[lock.option];
    if (word === undefined || word.hidden === true) return null;
    const player = other(t.data.owner);
    const prompt = createPrompt(EARLY_PROMPT, 'chase', [{ ...word }], lock.τ);
    const chase = new EarlyChase(player, t.data.turnId, lock.τ, prompt, power);
    return { chase, events: [chase.event(lock.τ, { type: 'promptShown', player, prompt: EARLY_PROMPT, kind: 'chase' })] };
  }

  /** How many keys it has taken (at most MAX_EARLY_KEYS). */
  get count(): number {
    return this.keys.length;
  }

  /**
   * A letter at τ on the striker's clock, taken no earlier than the lock or the previous key: applied
   * with the chase rules; returns the feedback events for the typist's own view. Ignored once the word
   * is complete or MAX_EARLY_KEYS keys were taken.
   */
  press(letter: string, τ: number): GameEvent[] {
    if (!LETTER.test(letter) || isComplete(this.prompt) || this.keys.length >= MAX_EARLY_KEYS) return [];
    const at = Math.max(τ, this.keys.at(-1)?.τ ?? this.lockτ, this.lockτ);
    const result = applyLetter(this.prompt, letter, at);
    if (result === 'ignored') return [];
    this.keys.push({ key: letter, τ: at });
    const { player } = this;
    const prompt = EARLY_PROMPT;
    if (result === 'wrong') {
      const out = [this.event(at, { type: 'keyBad', player, prompt })];
      if (this.level !== null && this.level > 0) {
        out.push(this.event(at, { type: 'power', player, from: this.level, to: 0 }));
        this.level = 0;
      }
      return out;
    }
    const out = [this.event(at, { type: 'keyOk', player, prompt })];
    if (result === 'completed') out.push(this.event(at, { type: 'wordDone', player, prompt, wpm: wpmOf(wordCps(this.prompt)) }));
    return out;
  }

  /** The keys on the receiver's clock for a strike at `strikeτ` (striker's clock): τ − strikeτ; keys after the strike are left out. */
  keysAt(strikeτ: number): EarlyKey[] {
    return this.keys.filter((k) => k.τ <= strikeτ).map((k) => ({ key: k.key, τ: k.τ - strikeτ }));
  }

  private event(τ: number, body: EventBody): GameEvent {
    return { turn: this.turnId, τ, ...body };
  }
}

/**
 * The events a view shows (early-typing spec §6.4): a turn's events stamped before τ 0 are early keys
 * applied at its start, which their typist already saw live, or which a remote viewer skips.
 */
export function withoutEarlyEvents(events: readonly GameEvent[]): GameEvent[] {
  return events.filter((e) => e.τ >= 0);
}
```

- [ ] **Step 4: Run to see it pass.**
  Run: `npx vitest run tests/core/early.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/core/early.ts tests/core/early.test.ts
git commit -m "feat(core): EarlyChase keeps the chase word typed between the striker's lock and strike

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb"
```

---

### Task 5: The CPU types early

**Files:**
- Modify: `src/core/cpu.ts` (`CpuBrain.planEarly`, and the chase plan continuing the early stream)
- Test: `tests/core/cpu.test.ts`

**Interfaces:**
- Consumes: `ReturnTurnData.earlyFrom` (Task 3), `CpuProfile.earlyPauseMs` (Task 2).
- Produces: `CpuBrain.planEarly(t: TurnState): PlannedKey[]`. This gives the keys on `t`'s clock for the opponent's return turn `t` with a locked choice word. It is stable per lock, and empty otherwise.

- [ ] **Step 1: Write the failing tests.** Append to `tests/core/cpu.test.ts`:

```ts
describe('CpuBrain — early typing (early-typing spec §2, §5)', () => {
  /** Player 1's return turn 5 (the striker): chase 'rally' fed at 100..500, then 'drop' locked at 900. */
  function striker(): TurnState {
    const t = returnTurn({ owner: 1, turnId: 5 });
    [...'rally'].forEach((key, i) => feed(t, { key, τ: 100 * (i + 1) }));
    feed(t, { key: 'd', τ: 900 });
    t.log.push({ τ: 900, k: 'lock', prompt: t.prompts[1]!.id, option: 0, ch: 'd' });
    return t;
  }

  it('plans the locked word from the lock + earlyPauseMs, the same on every call', () => {
    const brain = new CpuBrain(0, CLEAN, 3);
    const t = striker();
    const keys = brain.planEarly(t);
    expect(keys.map((k) => k.key).join('')).toBe('drop');
    expect(keys[0]?.τ).toBe(900 + CLEAN.earlyPauseMs);
    expect(brain.planEarly(t)).toEqual(keys);
  });

  it('plans nothing for its own turn, a serve turn, or before a lock', () => {
    expect(new CpuBrain(1, CLEAN, 3).planEarly(striker())).toEqual([]);
    expect(new CpuBrain(0, CLEAN, 3).planEarly(serveTurn())).toEqual([]);
    expect(new CpuBrain(0, CLEAN, 3).planEarly(returnTurn({ owner: 1 }))).toEqual([]);
  });

  it('carries on the same key stream in the return turn that starts with the early keys', () => {
    const brain = new CpuBrain(0, CLEAN, 4);
    const early = brain.planEarly(striker());
    const strikeτ = early[1]!.τ + 1; // two keys come before the strike
    const t = returnTurn({ owner: 0, turnId: 6, chase: 'drop', earlyFrom: 900 - strikeτ });
    const chase = t.prompts[0]!;
    for (const k of early.slice(0, 2)) applyLetter(chase, k.key, k.τ - strikeτ);
    const rest = brain.plan(t);
    expect(rest.slice(0, 2)).toEqual(early.slice(2).map((k) => ({ key: k.key, τ: k.τ - strikeτ })));
  });

  it('a pause that ends after the strike starts the chase in the turn, with no second pause', () => {
    const brain = new CpuBrain(0, PROFILE, 4);
    const lockToStrike = 100;
    const t = returnTurn({ owner: 0, turnId: 6, chase: 'drop', earlyFrom: -lockToStrike });
    expect(brain.plan(t)[0]?.τ).toBe(PROFILE.earlyPauseMs - lockToStrike);
  });
});
```

- [ ] **Step 2: Run to see the failures.**
  Run: `npx vitest run tests/core/cpu.test.ts`
  Expected: FAIL (`planEarly` is not a function).

- [ ] **Step 3: Implement.** In `CpuBrain`, add a field:

```ts
  /** The early chase plan: the striker's turn and lock it was made for, the word, and its keys as offsets from the lock. */
  private early: { turnId: number; lockτ: number; word: string; offsets: PlannedKey[] } | null = null;
```
  Add the public method after `plan`:

```ts
  /**
   * The early chase (early-typing spec §2, §5) for the opponent's return turn `t` once its choice word
   * is locked: the locked word, typed from the lock + the early pause, on t's clock. Drawn once per lock
   * and then stable; the return turn that follows the strike carries on this same key stream. Empty for
   * this brain's own turn, a serve turn, or before a lock.
   */
  planEarly(t: TurnState): PlannedKey[] {
    if (t.data.kind !== 'return' || t.data.owner === this.player) return [];
    const lock = t.log.find((e) => e.k === 'lock');
    if (lock?.k !== 'lock') return [];
    const word = t.prompts.find((p) => p.id === lock.prompt)?.options[lock.option];
    if (word === undefined) return [];
    let e = this.early;
    if (e?.turnId !== t.data.turnId || e.lockτ !== lock.τ) {
      e = { turnId: t.data.turnId, lockτ: lock.τ, word: word.word, offsets: this.typeWord(word, 0, this.profile.earlyPauseMs) };
      this.early = e;
    }
    const from = e.lockτ;
    return e.offsets.map((k) => ({ key: k.key, τ: from + k.τ }));
  }
```
  In `planReturn`, replace the chase plan's `make` callback:

```ts
    const chasePause = d.isServeReturn ? this.profile.serveChasePauseMs : this.profile.earlyPauseMs;
    const chasePlan = this.promptPlan(t, chase?.id ?? d.promptBase, chaseShownAt, 1, () => {
      const early = d.earlyFrom === null ? null : this.takeEarly(d.chase);
      // A rally chase is shown at the striker's lock (earlyFrom): the early stream's offsets count from there.
      return early === null
        ? this.newPlan([d.chase], 0, chaseShownAt, chasePause, t.τ)
        : { shownAt: chaseShownAt, option: 0, from: 0, keys: early.map((k) => ({ key: k.key, τ: chaseShownAt + k.τ })) };
    });
```
  Add the private helper:

```ts
  /** The early plan's offsets for `word` (consumed), or a fresh early stream when none was planned for it. */
  private takeEarly(word: WordOption): PlannedKey[] {
    const e = this.early;
    this.early = null;
    return e?.word === word.word ? e.offsets : this.typeWord(word, 0, this.profile.earlyPauseMs);
  }
```

- [ ] **Step 4: Run to see it pass.**
  Run: `npx vitest run tests/core/cpu.test.ts && npm run typecheck && npm test`
  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/core/cpu.ts tests/core/cpu.test.ts
git commit -m "feat(core): the CPU types the striker's word from their lock and carries on into its turn

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb"
```

---

### Task 6: The balance simulation plays early typing and reports the tier mix

**Files:**
- Modify: `src/core/sim.ts` (early keys at each rally return turn's start; new `PointRecord` and `SimSummary` fields; `simulateMatch` returns stats)
- Test: `tests/sim/sim.test.ts`

**Interfaces:**
- Consumes: `CpuBrain.planEarly` (Task 5), `Engine.start(player, early)` (Task 3).
- Produces:
  - `PointRecord` gains `rallyTiers: Record<Tier, number>`, `rallyReturns: number`, `earlyStarts: number`, `earlyDone: number`.
  - `SimSummary` gains `rallyEasy`, `rallyMedium`, `rallyHard`, `rallyInsane`, `earlyStartShare`, `earlyDoneShare` (all numbers).
  - `simulateMatch` returns `{ winner, points, stats: [PlayerStats, PlayerStats] }`.

- [ ] **Step 1: Write the failing tests.** In `tests/sim/sim.test.ts`:
  - `rec()` defaults gain `rallyTiers: { easy: 0, medium: 0, hard: 0, insane: 0 }, rallyReturns: 0, earlyStarts: 0, earlyDone: 0`. The `base` object in the insane-metrics test needs the same four fields.
  - Add to `describe('summarize')`:

```ts
  it('gives the rally tier mix over all rally strikes and the early-typing shares of rally returns', () => {
    const s = summarize([
      rec({ rallyTiers: { easy: 3, medium: 1, hard: 0, insane: 0 }, rallyReturns: 4, earlyStarts: 3, earlyDone: 1 }),
      rec({ rallyTiers: { easy: 1, medium: 1, hard: 1, insane: 1 }, rallyReturns: 4, earlyStarts: 1, earlyDone: 1 }),
    ]);
    expect([s.rallyEasy, s.rallyMedium, s.rallyHard, s.rallyInsane]).toEqual([0.5, 0.25, 0.125, 0.125]);
    expect([s.earlyStartShare, s.earlyDoneShare]).toEqual([0.5, 0.25]);
    const none = summarize([rec()]);
    expect([none.rallyEasy, none.earlyStartShare, none.earlyDoneShare]).toEqual([0, 0, 0]);
  });
```
  - Add to `describe('simulatePoints')`:

```ts
  it('plays early typing: most rally returns get chase keys before the strike', () => {
    const s = summarize(simulatePoints({ config: CONFIG, typists: [HUMAN_50, HUMAN_50], seed: 13, points: 200 }));
    expect(s.earlyStartShare).toBeGreaterThan(0.5);
    expect(s.earlyDoneShare).toBeGreaterThan(0);
    expect(s.rallyEasy + s.rallyMedium + s.rallyHard + s.rallyInsane).toBeCloseTo(1, 9);
  });
```
  - Add to `describe('simulateMatch')`:

```ts
  it("returns both players' match stats", () => {
    const { stats } = simulateMatch({ config: config({ format: 'tiebreak' }), typists: [HUMAN_50, HUMAN_50], seed: 21 });
    expect(stats[0].wordsCompleted + stats[1].wordsCompleted).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run to see the failures.**
  Run: `npx vitest run tests/sim/sim.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement `sim.ts`.**
  - Import `ALL_TIERS`, and the types `EarlyKey`, `PlayerStats`, `Tier`.
  - `PointRecord` gains (with JSDoc):

```ts
  /** Rally strikes (every strike but a serve) of the point, by tier. */
  rallyTiers: Record<Tier, number>;
  /** Rally return turns (not serve returns) of the point. */
  rallyReturns: number;
  /** Of those, the ones whose chase got a key before the strike. */
  earlyStarts: number;
  /** Of those, the ones whose chase was done by the strike. */
  earlyDone: number;
```
  - `SimSummary` gains `rallyEasy: number; rallyMedium: number; rallyHard: number; rallyInsane: number; earlyStartShare: number; earlyDoneShare: number;`. Its doc adds: "rallyEasy…rallyInsane = shares of all rally strikes; earlyStartShare / earlyDoneShare = shares of rally returns (0 with none)".
  - In `summarize`, before the return:

```ts
  const tiers = { easy: 0, medium: 0, hard: 0, insane: 0 } as Record<Tier, number>;
  for (const p of points) for (const k of ALL_TIERS) tiers[k] += p.rallyTiers[k];
  const strikes = ALL_TIERS.reduce((sum, k) => sum + tiers[k], 0);
  const tierShare = (k: Tier): number => (strikes === 0 ? 0 : tiers[k] / strikes);
  const returns = points.reduce((sum, p) => sum + p.rallyReturns, 0);
  const returnShare = (count: number): number => (returns === 0 ? 0 : count / returns);
```
    and add to the returned object:

```ts
    rallyEasy: tierShare('easy'),
    rallyMedium: tierShare('medium'),
    rallyHard: tierShare('hard'),
    rallyInsane: tierShare('insane'),
    earlyStartShare: returnShare(points.reduce((sum, p) => sum + p.earlyStarts, 0)),
    earlyDoneShare: returnShare(points.reduce((sum, p) => sum + p.earlyDone, 0)),
```
  - `matchPoints`:
    - Change its generator return type to `Generator<PointRecord, { winner: PlayerId; stats: [PlayerStats, PlayerStats] }, void>` and return `{ winner, stats: jsonCopy(engine.state.stats) }` (import `jsonCopy` from `./util`).
    - Keep a per-point tally beside `insane`: `let rally = { tiers: { easy: 0, medium: 0, hard: 0, insane: 0 } as Record<Tier, number>, returns: 0, early: 0, done: 0 };` and reset it with the others at each point.
    - After a turn ends (`ended !== null`), add:

```ts
      const o = ended.outcome;
      if (o?.kind === 'strike' && !o.strike.isServe) rally.tiers[o.strike.word.tier]++;
      if (ended.data.kind === 'return' && !ended.data.isServeReturn) {
        rally.returns++;
        if (ended.log.some((e) => (e.k === 'ok' || e.k === 'bad') && e.τ < 0)) rally.early++;
        const done = ended.prompts[0]?.completedAt ?? null;
        if (done !== null && done <= 0) rally.done++;
      }
```
    (Reuse the existing `const o = ended.outcome;` if one is already declared there.)
    - Yield the new fields: `rallyTiers: { ...rally.tiers }, rallyReturns: rally.returns, earlyStarts: rally.early, earlyDone: rally.done`.
  - `simulateMatch` returns `{ winner: r.value.winner, points, stats: r.value.stats }`; its doc says "…and both players' match stats". `simulatePoints` is unaffected (it ignores the return value).
  - `playTurn` starts the turn with the owner's early keys:

```ts
function playTurn(engine: Engine, brain: CpuBrain, owner: PlayerId): GameEvent[] {
  const id = engine.state.turn?.data.turnId;
  let events = engine.start(owner, earlyKeys(engine, brain));
  // …(rest unchanged)
}

/**
 * The keys `brain` typed early (early-typing spec §2) for the rally return turn it now owns: its early
 * plan for the striker's turn (engine.state.lastTurn) up to the strike, re-based to the strike.
 */
function earlyKeys(engine: Engine, brain: CpuBrain): EarlyKey[] {
  const t = engine.state.turn;
  const striker = engine.state.lastTurn;
  const o = striker?.outcome;
  if (t?.data.kind !== 'return' || t.data.earlyFrom === null || striker === null || o?.kind !== 'strike') return [];
  const strikeτ = o.strike.τ;
  return brain.planEarly(striker).filter((k) => k.τ <= strikeτ).map((k) => ({ key: k.key, τ: k.τ - strikeτ }));
}
```

- [ ] **Step 4: Run to see it pass.**
  Run: `npx vitest run tests/sim/sim.test.ts && npm run typecheck && npm test`
  Expected: PASS (the balance smoke band follows the Task 1 rule).

- [ ] **Step 5: Commit.**

```bash
git add src/core/sim.ts tests/sim/sim.test.ts
git commit -m "feat(sim): simulated rallies type early and report the rally tier mix

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb"
```

---

### Task 7: Early typing in local matches (vs CPU, Training, attract)

**Files:**
- Modify: `src/core/types.ts` (`EarlyView`, `ViewModel.early`)
- Modify: `src/game/localSession.ts`
- Modify: `src/game/hostSession.ts`, `src/game/guestSession.ts` (`early: null` in their view models, until Task 10)
- Modify: every other `ViewModel` literal that `npm run typecheck` flags (`tests/render/*.test.ts` view helpers, `tests/e2e/typist.test.ts`, `tools/art/hudStates.ts`, …): add `early: null`
- Modify: `tests/game/sessionHelpers.ts` (`drive` gets an `early` option)
- Test: `tests/game/localSession.test.ts`

**Interfaces:**
- Consumes: `EarlyChase`, `withoutEarlyEvents` (Task 4); `CpuBrain.planEarly` (Task 5); `Engine.start(player, early)` (Task 3).
- Produces: `interface EarlyView { player: PlayerId; prompt: PromptState }` and `ViewModel.early: EarlyView | null`. For local sessions this is always the open early chase, whoever types it.

- [ ] **Step 1: Add the view type.** In `src/core/types.ts`, before `ViewModel`:

```ts
/** An early chase a view shows (early-typing spec §6.4): its typist and chase prompt, times on the striker's turn clock. */
export interface EarlyView { player: PlayerId; prompt: PromptState }
```
  and in `ViewModel`, after `liveTurn`:

```ts
  early: EarlyView | null;             // the open early chase the viewer may see (its own, or a local CPU's)
```
  Run `npm run typecheck` and add `early: null` to every `ViewModel` literal it flags, including `hostSession.buildView` and `guestSession.buildView`.

- [ ] **Step 2: Give `drive` an early typist.** In `tests/game/sessionHelpers.ts`, add an option `early?: boolean` ("also type the typist's early chase keys, on the displayed striker turn's clock"). In the loop, before the own-turn branch:

```ts
    const e = vm.early;
    if (!pressed && opts.early === true && opts.typist !== null && turn !== null && e !== null && e.player === opts.me) {
      const next = opts.typist.planEarly(turn)[e.prompt.correctKeys + e.prompt.wrongKeys];
      const at = next === undefined ? null : turnStart(s, vm) + next.τ;
      if (next !== undefined && at !== null && at <= s.now() + step) {
        if (at > s.now()) s.advance(at - s.now());
        session.key(keyOf(next.key), s.now());
        pressed = true;
      }
    }
```
  (Declare `let pressed = false;` before this block and leave the own-turn branch as `if (!pressed && …)`.)

- [ ] **Step 3: Write the failing tests.** Append to `tests/game/localSession.test.ts`:

```ts
describe('LocalSession: early typing (early-typing spec §2, §6.2)', () => {
  /** Plays with a scripted human until `stop`, returning the view. */
  function until(seed: number, stop: (vm: ViewModel) => boolean, early = false) {
    const { s, session: x } = session({ seed });
    const human = new CpuBrain(0, cpuProfile(6), 99);
    const vm = drive(s, x, { me: 0, typist: human, limitMs: 20 * 60 * 1000, stop, early });
    return { s, x, human, vm };
  }

  it("shows WAIT for the human's letters in the CPU's turn before its lock, and none after it", () => {
    const { s, x, vm } = until(7, (v) => v.pub.turn?.data.kind === 'return' && v.pub.turn.data.owner === 1 && v.early === null);
    x.key(keyOf('q'), s.now());
    expect(x.frame(FRAME).overlay.wait).toBe(true);
    s.advance(1100); // past the WAIT tag's once-per-second limit
    const open = frameUntil(s, x, (v) => v.early?.player === 0);
    x.key(keyOf(open.early!.prompt.options[0]!.word[0]!), s.now());
    const after = x.frame(FRAME);
    expect(after.overlay.wait).toBe(false);
    expect(after.early?.prompt.typed).toBe(1);
    expect(after.events.some((e) => e.type === 'keyOk' && e.player === 0)).toBe(true);
  });

  it('carries the early keys into the return turn when the CPU strikes, and drops them when it does not', () => {
    let carried = 0;
    for (let seed = 1; seed <= 12 && carried === 0; seed++) {
      const { s, x } = until(seed, (v) => v.early?.player === 0);
      const cpuTurn = x.view!.pub.turn!.data.turnId;
      const word = x.view!.early!.prompt.options[0]!.word;
      x.key(keyOf(word[0]!), s.now());
      const next = frameUntil(s, x, (v) => v.pub.turn !== null && v.pub.turn.data.turnId !== cpuTurn);
      expect(next.early).toBeNull();
      expect(next.events.every((e) => e.τ >= 0)).toBe(true);
      const t = next.pub.turn!;
      if (t.data.kind === 'return' && t.data.owner === 0) {
        expect(t.prompts[0]).toMatchObject({ typed: 1 });
        expect(t.prompts[0]!.tFirst).toBeLessThan(0);
        carried++;
      } else {
        expect(next.pub.stats[0].correctKeys).toBe(x.view!.pub.stats[0].correctKeys); // nothing counted
      }
    }
    expect(carried).toBeGreaterThan(0);
  });

  it("a CPU receiver's early chase fills live and reaches the engine at the strike", () => {
    const { s, x } = until(5, (v) => v.early?.player === 1 && v.early.prompt.typed > 0);
    const humanTurn = x.view!.pub.turn!.data.turnId;
    const next = frameUntil(s, x, (v) => v.pub.turn !== null && v.pub.turn.data.turnId !== humanTurn);
    const t = next.pub.turn!;
    if (t.data.kind === 'return') expect(t.prompts[0]!.tFirst).toBeLessThan(0);
  });

  it('a pause during the early window keeps the chase and stamps later keys on game time', () => {
    const { s, x } = until(7, (v) => v.early?.player === 0);
    const word = x.view!.early!.prompt.options[0]!.word;
    x.key(keyOf(word[0]!), s.now());
    const first = x.frame(FRAME).early!.prompt.tFirst!;
    x.pause();
    s.advance(5000);
    x.resume();
    s.advance(1600); // the 3-2-1 countdown
    x.frame(FRAME);
    x.key(keyOf(word[1]!), s.now());
    const vm = x.frame(FRAME);
    if (vm.early !== null) expect(vm.early.prompt.tLast! - first).toBeLessThan(2000);
  });

  it('a whole match with a human who types early plays to the end', () => {
    const { x } = until(3, () => false, true);
    expect(x.over).toBe(true);
  });
});
```
  The third test's `if` allows for the human's shot being called OUT/NET, which makes the next turn a serve turn. Seed 5 is expected to give a rally return. If it doesn't, try seeds upward until one does, and hard-code that seed with a comment.

- [ ] **Step 4: Run to see the failures.**
  Run: `npx vitest run tests/game/localSession.test.ts`
  Expected: FAIL (the view never has `early`).

- [ ] **Step 5: Implement `localSession.ts`.**
  - Imports: `EarlyChase, withoutEarlyEvents` from `../core/early`; `other` and the types `EarlyKey`, `EarlyView` from `../core/types`; `jsonCopy` from `../core/util`.
  - Fields:

```ts
  /** The receiver's early chase while the striker's return turn runs (early-typing spec §2), or null. */
  private early: EarlyChase | null = null;
  /** How many of a CPU receiver's planned early keys have been pressed into `early`. */
  private earlyFed = 0;
```
  - `apply`, the letter branch:

```ts
    if (k.kind === 'letter') {
      if (owner === human) this.absorb(this.engine.input(human, k.letter, τ));
      else if (this.early?.player === human) this.pending.push(...this.early.press(k.letter, τ));
      else if (owner !== null) this.wait.show(now);
    }
```
  - `run`: in place of the final `if (this.engine.state.turn === turn) return;`:

```ts
      if (this.engine.state.turn === turn) {
        this.runEarly(turn, τ);
        return;
      }
```
  - New methods:

```ts
  /** Opens the receiver's early chase once the running return turn's choice word is locked, and feeds a CPU receiver's planned early keys up to τ. */
  private runEarly(turn: TurnState, τ: number): void {
    if (this.early !== null && this.early.turnId !== turn.data.turnId) this.early = null;
    if (this.early === null) {
      const opened = EarlyChase.open(turn, τ, this.meterOf(other(turn.data.owner)));
      if (opened === null) return;
      this.early = opened.chase;
      this.earlyFed = 0;
      this.pending.push(...opened.events);
    }
    this.feedEarly(this.early, turn, τ);
  }

  /** Presses a CPU receiver's planned early keys with τ up to `τ` (none for a human receiver). */
  private feedEarly(early: EarlyChase, turn: TurnState, τ: number): void {
    const brain = this.brains[early.player];
    if (brain === null) return;
    const planned = brain.planEarly(turn);
    while (this.earlyFed < planned.length && planned[this.earlyFed]!.τ <= τ) {
      this.pending.push(...early.press(planned[this.earlyFed]!.key, planned[this.earlyFed]!.τ));
      this.earlyFed++;
    }
  }

  /**
   * The early keys for the turn about to start after `ended` ended at endτ (early-typing spec §2): the
   * chase typed while it ran, re-based to its strike; none unless it ended with a strike. The early
   * chase is closed either way. A CPU receiver gets every planned key up to the strike, even ones a frame
   * gap skipped.
   */
  private takeEarly(ended: TurnState | null, endτ: number): EarlyKey[] {
    let early = this.early;
    this.early = null;
    if (ended === null || ended.outcome?.kind !== 'strike') return [];
    if (early?.turnId !== ended.data.turnId) {
      const opened = EarlyChase.open(ended, endτ, this.meterOf(other(ended.data.owner)));
      if (opened === null) return [];
      early = opened.chase;
      this.earlyFed = 0;
    }
    this.feedEarly(early, ended, endτ);
    return early.keysAt(endτ);
  }

  /** A player's meter level for early feedback, or null in training (meter off). */
  private meterOf(p: PlayerId): number | null {
    const s = this.engine.state;
    return s.config.training !== null ? null : s.power[p];
  }
```
  - `absorb`, the turn change:

```ts
    if (endτ === null) return;
    const ended = this.engine.state.lastTurn;
    this.turnStartLocal += endτ;
    const next = this.engine.owner();
    if (next !== null) this.absorb(this.engine.start(next, this.takeEarly(ended, endτ)));
```
    If the match ended (`next === null`), clear the chase: `else this.early = null;`.
  - `buildView`: `const events = redactEvents(withoutEarlyEvents(this.pending), state, this.viewer);` and add to the view model:

```ts
      early: this.early === null ? null : ({ player: this.early.player, prompt: jsonCopy(this.early.prompt) } satisfies EarlyView),
```
  - Update the class doc comment with one sentence: "While the striker's return turn runs after its choice lock, the receiver's letters (a human's keys, a CPU's planned early keys) type the chase early; the next turn starts with them (early-typing spec §2)."

- [ ] **Step 6: Run to see it pass.**
  Run: `npx vitest run tests/game && npm run typecheck && npm test`
  Expected: PASS. Existing local-session and training tests must pass unchanged.

- [ ] **Step 7: Commit.**

```bash
git add src/core/types.ts src/game tests tools/art
git commit -m "feat(game): type the striker's word early in local matches, human and CPU alike

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb"
```

---

### Task 8: The early chase plate, its pop and the meter

**Files:**
- Modify: `src/render/prompts.ts` (`earlyPlate`)
- Modify: `src/render/renderer.ts` (export `popKey`; `popNow` uses it)
- Modify: `src/render/hud.ts` (`meterLevels`)
- Test: `tests/render/prompts.test.ts`, `tests/render/hud.test.ts`, `tests/render/renderer.test.ts`

**Interfaces:**
- Consumes: `ViewModel.early` (Task 7), `EarlyChase` (tests only).
- Produces: `popKey(f: WorldFrame): string | null` (exported from `renderer.ts`).

- [ ] **Step 1: Write the failing tests.**
  - `tests/render/prompts.test.ts` (import `EarlyChase` from `../../src/core/early` and `groundAt` from `../../src/render/world` if the file doesn't already):

```ts
describe('early chase plate (early-typing spec §6.4)', () => {
  /** Player 1's return turn with 'drop' locked at 600, and player 0's early chase with 'dr' typed. */
  function earlyView(viewer: PlayerId | 'spectator' = 0): { vm: ViewModel } {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnInput(t, 'd', 600);
    const early = EarlyChase.open(t, 600, 0)!.chase;
    early.press('d', 700);
    early.press('r', 800);
    return { vm: view(matchState(t), 900, viewer, { early: { player: 0, prompt: early.prompt } }) };
  }

  it("draws the receiver's chase plate above their head, typed so far, with no timing bar", () => {
    const { vm } = earlyView(0);
    const f = worldFrame(vm);
    const animator = new PlayerAnimator();
    const poses = animator.step(f, 16);
    const s = promptScene(f, poses, { prefs: PREFS, looks: [LOOK, LOOK], turnStart: [animator.turnStartFeet(0), animator.turnStartFeet(1)], pop: false });
    const plate = s.plates.find((p) => p.opt.word === 'drop' && p.style === 'localActive');
    expect(plate).toMatchObject({ typed: 2, locked: true, isNextCursor: true });
    const feetX = groundAt(f, poses[0].feet).x;
    expect(Math.abs(plate!.box.x + plate!.box.w / 2 - feetX)).toBeLessThanOrEqual(1);
    expect(s.bar).toBeNull();
  });

  it("shows another viewer's early chase as a remote plate with the typist's name chip", () => {
    const s = scene(earlyView(1).vm);
    expect(s.plates.find((p) => p.opt.word === 'drop' && p.locked)).toMatchObject({ style: 'remote', nameChip: 'Alex', typed: 2 });
  });

  it('draws no early plate without an early chase', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnInput(t, 'd', 600);
    expect(scene(view(matchState(t), 900, 0)).plates.filter((p) => p.locked && p.opt.word === 'drop' && p.style === 'localActive')).toEqual([]);
  });
});
```
    Adjust the chip expectation to how `chipOf` names player 0 in `matchState` ('Alex').
  - `tests/render/hud.test.ts`: in the power-meter `frame` helper, add `early?: EarlyView | null` to `over`, and add `vm: { early: over.early ?? null }` to the cast object. Then:

```ts
  it("empties the early typist's meter as soon as their early chase has a wrong key", () => {
    const prompt = (wrongKeys: number): PromptState => ({ wrongKeys }) as PromptState;
    expect(meterLevels(frame({ power: [4, 2], early: { player: 0, prompt: prompt(0) } }))).toEqual([4, 2]);
    expect(meterLevels(frame({ power: [4, 2], early: { player: 0, prompt: prompt(1) } }))).toEqual([0, 2]);
  });
```
  - `tests/render/renderer.test.ts`:

```ts
describe('popKey (early-typing spec §6.4)', () => {
  const frameOf = (over: Partial<{ local: 0 | 1 | null; early: EarlyView | null; turn: unknown; view: unknown }>): WorldFrame =>
    ({ local: 0, turn: null, view: null, vm: { early: null }, ...over, ...(over.early !== undefined ? { vm: { early: over.early } } : {}) }) as unknown as WorldFrame;

  it("pops the local player's early chase once per striker turn", () => {
    const early = { player: 0, prompt: {} } as EarlyView;
    expect(popKey(frameOf({ early, turn: { data: { turnId: 9, owner: 1 } } }))).toBe('early:9');
    expect(popKey(frameOf({ early: { ...early, player: 1 }, turn: { data: { turnId: 9, owner: 1 } } }))).toBeNull();
  });

  it('does not pop a chase that was shown early, but does pop one shown at τ 0 or later', () => {
    const chase = (shownAt: number) => ({ turn: { data: { turnId: 10, owner: 0 } }, view: { active: 0, prompts: [{ id: 50, kind: 'chase', shownAt }] } });
    expect(popKey(frameOf(chase(-800)))).toBeNull();
    expect(popKey(frameOf(chase(0)))).toBe('prompt:50');
  });
});
```

- [ ] **Step 2: Run to see the failures.**
  Run: `npx vitest run tests/render`
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `src/render/prompts.ts`, a new function after `returnPrompts`:

```ts
/**
 * The receiver's early chase (early-typing spec §6.4): the chase plate above their head while the
 * striker's return turn is shown, typed so far, with no timing bar (the ball is not struck yet). At the
 * strike the turn's own chase plate takes over in the same place with the same progress.
 */
function earlyPlate(c: Ctx): void {
  const early = c.f.vm.early;
  const opt = early?.prompt.options[0];
  if (early === null || opt === undefined) return;
  const p = early.player;
  const style: PlateStyle = c.f.local === p ? 'localActive' : 'remote';
  const head = headAt(c, p, c.poses[p].feet);
  const scale = c.o.prefs.largeWords ? 2 : 1;
  const box = layoutSingle(opt.len, head.x, head.y, scale);
  const chip = chipOf(c, p, style);
  const { prompt } = early;
  c.s.plates.push(
    plate(c, box, opt, style, {
      typed: prompt.typed,
      locked: true,
      lastWrongAgeMs: prompt.lastWrongAt === null ? null : c.f.τ - prompt.lastWrongAt,
      isNextCursor: style === 'localActive' && prompt.completedAt === null,
      nameChip: chip?.name ?? null,
      oppColor: chip?.color ?? null,
      scale,
    }),
  );
  if (c.o.pop && style === 'localActive') c.s.pops.push(box);
}
```
    In `promptScene`, call `earlyPlate(c);` after the serve/return prompts and before `playerTags(c)`. Add "the receiver's early chase plate" to its doc comment's list.
  - `src/render/renderer.ts`: `pop` becomes `private pop: { key: string | null; frames: number } = { key: null, frames: 0 };` and:

```ts
  /** True on the first two frames of each serve or chase word the local player can type, early chases included. */
  private popNow(f: WorldFrame): boolean {
    const key = popKey(f);
    if (key !== null && key !== this.pop.key) this.pop = { key, frames: POP_FRAMES };
    if (this.pop.frames <= 0) return false;
    this.pop.frames--;
    return true;
  }
```
    Then, as a module function:

```ts
/**
 * What the local player can newly type, for the 2-frame border pop (early-typing spec §6.4):
 * `early:<striker turn>` while their early chase is open, else `prompt:<id>` for their active serve or
 * chase prompt. A chase first shown before the strike already popped as an early chase, so it gives null.
 */
export function popKey(f: WorldFrame): string | null {
  const early = f.vm.early;
  if (early !== null && early.player === f.local) return `early:${f.turn?.data.turnId ?? -1}`;
  const v = f.view;
  const prompt = v && v.active !== null ? v.prompts[v.active] : undefined;
  if (!prompt || f.local === null || f.turn?.data.owner !== f.local || prompt.kind === 'choice' || prompt.shownAt < 0) return null;
  return `prompt:${prompt.id}`;
}
```
  - `src/render/hud.ts` `meterLevels`, after the live-owner line:

```ts
  // The early typist's meter empties with their first wrong key, before their turn starts (early-typing spec §2).
  const early = f.vm.early;
  if (early !== null && early.prompt.wrongKeys > 0) levels[early.player] = 0;
```
    Extend its doc comment: "…and the early typist's level 0 once their early chase has a wrong key."

- [ ] **Step 4: Run to see it pass.**
  Run: `npx vitest run tests/render && npm run typecheck && npm test`
  Expected: PASS.

- [ ] **Step 5: Check it visually.** Run the art QA or a devshot of a live vs-CPU match:
  - Use `node scripts/devshot.mjs` (read its header for the arguments), or play locally with `npm run dev`.
  - Look at the early plate while the CPU types its shot word, and at the handover at the strike.
  - Confirm the plate sits above your player, never covers the CPU's stack, and turns into the chase plate without a jump. If it overlaps anything, stop and report.

- [ ] **Step 6: Commit.**

```bash
git add src/render tests/render
git commit -m "feat(render): the early chase plate above the receiver, its pop, and the meter's early emptying

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb"
```

---

### Task 9: The `early` message and `PROTO` 3

**Files:**
- Modify: `src/net/protocol.ts`
- Test: `tests/net/protocol.test.ts`

**Interfaces:**
- Consumes: `EarlyKey`, `MAX_EARLY_KEYS` (Task 3).
- Produces: the `NetMsg` variant `{ type: 'early'; turn: number; keys: EarlyKey[] }`, and `PROTO = 3`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/net/protocol.test.ts` (adapt the parse helper name to the file's own, `parseMsg`):

```ts
describe('early (early-typing spec §6.3)', () => {
  const keys = [{ key: 'd', τ: -300 }, { key: 'r', τ: -120.5 }];

  it('passes a valid list, copied clean', () => {
    expect(parseMsg({ type: 'early', turn: 12, keys: keys.map((k) => ({ ...k, extra: 1 })), junk: true })).toEqual({ type: 'early', turn: 12, keys });
    expect(parseMsg({ type: 'early', turn: 12, keys: [] })).toEqual({ type: 'early', turn: 12, keys: [] });
  });

  it.each([
    ['a non-integer turn', { turn: 1.5, keys }],
    ['a key after τ 0', { turn: 1, keys: [{ key: 'd', τ: 1 }] }],
    ['a non-finite τ', { turn: 1, keys: [{ key: 'd', τ: null }] }],
    ['a non-letter', { turn: 1, keys: [{ key: 'toss', τ: -1 }] }],
    ['an upper-case letter', { turn: 1, keys: [{ key: 'D', τ: -1 }] }],
    ['more than MAX_EARLY_KEYS keys', { turn: 1, keys: Array.from({ length: MAX_EARLY_KEYS + 1 }, () => ({ key: 'z', τ: -1 })) }],
    ['keys that are not a list', { turn: 1, keys: 'dr' }],
  ])('drops a message with %s', (_name, m) => {
    expect(parseMsg({ type: 'early', ...m })).toBeNull();
  });

  it('is protocol version 3', () => {
    expect(PROTO).toBe(3);
  });
});
```
  Update any existing test that pins `PROTO` to 2.

- [ ] **Step 2: Run to see the failures.**
  Run: `npx vitest run tests/net/protocol.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement.** In `src/net/protocol.ts`:
  - Import `MAX_EARLY_KEYS` from `../core/turn` and `EarlyKey` (type) from `../core/types`.
  - Set `export const PROTO = 3;` and add to its doc: "3 since early typing (early-typing spec §6.3)."
  - Add to `NetMsg`, after `clock`:

```ts
  | { type: 'early'; turn: number; keys: EarlyKey[] }
```
  - Add a parser:

```ts
/** A guest's early keys (early-typing spec §6.3): at most MAX_EARLY_KEYS letters a–z at finite τ ≤ 0, copied clean; null if any is not. */
function parseEarlyKeys(v: unknown): EarlyKey[] | null {
  if (!Array.isArray(v) || v.length > MAX_EARLY_KEYS) return null;
  const keys: EarlyKey[] = [];
  for (const k of v) {
    if (!isRec(k) || !isStr(k.key) || !/^[a-z]$/.test(k.key) || !isNum(k.τ) || k.τ > 0) return null;
    keys.push({ key: k.key, τ: k.τ });
  }
  return keys;
}
```
  - In `parseFields`, after `'clock'`:

```ts
    case 'early': {
      const keys = parseEarlyKeys(m.keys);
      return isInt(m.turn) && keys ? { type: 'early', turn: m.turn, keys } : null;
    }
```

- [ ] **Step 4: Run to see it pass.**
  Run: `npx vitest run tests/net/protocol.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/net/protocol.ts tests/net/protocol.test.ts
git commit -m "feat(net): the guest's early keys travel in an early message (protocol 3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb"
```

---

### Task 10: Early typing online

**Files:**
- Modify: `src/game/hostSession.ts`, `src/game/guestSession.ts`
- Modify: `src/game/onlineLink.ts` (`FreshEvents.release` drops events before τ 0)
- Modify: `tests/net/sessionHarness.ts` (`TypistOptions.early`, `ScriptedTypist.nextEarly`, `Rig.nextKey`)
- Test: `tests/net/sessions.test.ts`
- Modify: `docs/superpowers/specs/2026-09-28-early-typing-and-human-cpu-design.md` (§7 Net bullet, per deviation 2)

**Interfaces:**
- Consumes: `EarlyChase`, `withoutEarlyEvents` (Task 4), the `early` message (Task 9), `startTurn(runner, early)` and `Engine.start(player, early)` (Task 3), `ViewModel.early` (Task 7).

- [ ] **Step 1: Write the failing tests.**
  - In `tests/net/sessionHarness.ts`:
    - Add `early: boolean` to `TypistOptions` ("type the chase word early, from the opponent's lock, on the displayed striker turn's clock"), with default `false`.
    - Extract `keys()`'s letter loop into `private typeOut(r: RngState, word: string, from: number): PlannedKey[]` (the `for` loop over `word`, starting at `τ = from`, unchanged).
    - Add:

```ts
  /**
   * The next key of this player's early chase while `vm` shows it (early-typing spec §2), on the
   * displayed striker turn's clock, or null: the word from the lock after a 250–400 ms pause.
   */
  nextEarly(vm: ViewModel): PlannedKey | null {
    const e = vm.early;
    if (!this.opts.early || e === null || e.player !== this.me || e.prompt.completedAt !== null) return null;
    const word = e.prompt.options[0]?.word ?? '';
    const r = this.rng('early', word, e.prompt.shownAt);
    const keys = this.typeOut(r, word, e.prompt.shownAt + 250 + 150 * uniform(r));
    return keys[e.prompt.correctKeys + e.prompt.wrongKeys] ?? null;
  }
```
    - In `Rig.nextKey`, replace the key lookup:

```ts
      const t = vm.liveTurn ?? vm.pub.turn;
      const own = t === null ? null : side.typist.next(t);
      const early = own === null ? side.typist.nextEarly(vm) : null;
      const k = own ?? early;
      if (k === null) continue;
      // An early key is timed on the playback of the striker's turn, which need not run at wall-clock rate.
      const at = early !== null ? Math.max(this.s.now(), side.viewAt - vm.turnτ + k.τ) : side.viewAt - vm.turnτ + k.τ;
```
    (Keep the "fell behind" check after this, unchanged.)
  - Append to `tests/net/sessions.test.ts`:

```ts
describe('online early typing (early-typing spec §6.2)', () => {
  it('both sides type chase words early, and the host and the guest never disagree', { timeout: 120000 }, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rig = new Rig({ config: config('tiebreak'), seed: 31, latencyMs: 150, jitterSeed: 5, hostTypist: { early: true }, guestTypist: { early: true } });
      const early = new Set<number>();
      rig.play({
        limitMs: 2 * 60 * 60 * 1000,
        onFrame: (side, vm) => {
          if (side !== 'host') return;
          for (const t of [vm.pub.turn, vm.pub.lastTurn]) {
            if (t?.data.kind === 'return' && (t.prompts[0]?.tFirst ?? 0) < 0) early.add(t.data.owner);
          }
        },
      });
      expect(rig.host.over && rig.guest.over).toBe(true);
      expect([...early].sort()).toEqual([0, 1]);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('desync'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
```
    Import `Rig` from `./sessionHarness` and `vi` from vitest if they aren't already.

- [ ] **Step 2: Run to see the failure.**
  Run: `npx vitest run tests/net/sessions.test.ts -t "online early typing"`
  Expected: FAIL (the views have no `early`, so no early keys are typed).

- [ ] **Step 3: Implement the shared filter.** In `src/game/onlineLink.ts`, `FreshEvents.release` returns `withoutEarlyEvents(queue.release())` (import from `../core/early`). Its doc gains: "…without the events stamped before τ 0 (early keys applied at a turn's start, early-typing spec §6.4)."

- [ ] **Step 4: Implement the host.** In `src/game/hostSession.ts`:
  - Imports: `EarlyChase` from `../core/early`, `jsonCopy` from `../core/util`, and the `EarlyKey` type.
  - Field: `/** The host's early chase while a guest return turn is displayed (early-typing spec §6.2), or null. */ private early: EarlyChase | null = null;`. Clear it in `newMatch`.
  - `key()`, the off-turn branch: `if (k.kind === 'letter' && !this.pressEarly(k.letter)) this.wait.show(now);`
  - `step(now)`: after the `advance` loop, call `this.watchEarly();`.
  - `startOwn(entry)`: `if (this.engine.state.turn === entry.turn) this.absorb(this.engine.start(HOST, this.takeEarly()));`
  - `onMessage`: add `case 'early': this.onGuestEarly(m); return;`.
  - `buildView`: add `early: this.early === null ? null : { player: HOST, prompt: jsonCopy(this.early.prompt) },`.
  - New methods:

```ts
  /** Opens the host's early chase when the displayed guest return turn reaches its choice lock; drops it once another turn is displayed. */
  private watchEarly(): void {
    const f = this.queue.front;
    if (this.early !== null && f?.turn.data.turnId !== this.early.turnId) this.early = null;
    if (this.early !== null || f === null || f.local || f.turn.data.owner !== GUEST) return;
    const opened = EarlyChase.open(f.turn, f.τ, this.meterOf(HOST));
    if (opened === null) return;
    this.early = opened.chase;
    this.queue.hold(opened.events);
  }

  /** A host letter while the guest's turn is displayed: typed into the open early chase at the displayed τ; false when none is open. */
  private pressEarly(letter: string): boolean {
    const early = this.early;
    const f = this.queue.front;
    if (early === null || f === null || f.turn.data.turnId !== early.turnId) return false;
    this.queue.hold(early.press(letter, f.τ));
    return true;
  }

  /** The early keys for the host's turn now starting (early-typing spec §6.2): the chase of the turn just displayed, re-based to its strike. */
  private takeEarly(): EarlyKey[] {
    const early = this.early;
    this.early = null;
    const p = this.queue.previous;
    const o = p?.turn.outcome;
    if (early === null || p === null || p.turn.data.turnId !== early.turnId || o?.kind !== 'strike') return [];
    return early.keysAt(o.strike.τ);
  }

  /** The guest's early keys (early-typing spec §6.2): they start its return turn, before any clock or input of it. */
  private onGuestEarly(m: Extract<NetMsg, { type: 'early' }>): void {
    const t = this.engine.state.turn;
    if (!this.life.playing || t === null || t.data.turnId !== m.turn || t.data.owner !== GUEST || t.started) return;
    this.absorb(this.engine.start(GUEST, m.keys));
  }

  /** A player's meter level for early feedback, or null in training. */
  private meterOf(p: PlayerId): number | null {
    const s = this.engine.state;
    return s.config.training !== null ? null : s.power[p];
  }
```
  - Class doc comment: add "The host types its chase early while the guest's return turn plays back past its choice lock, and its own turn starts with those keys; a guest turn may start from the guest's `early` message (early-typing spec §6.2)."

- [ ] **Step 5: Implement the guest.** In `src/game/guestSession.ts`:
  - The same `early` field, cleared in `restart`, with `watchEarly` (host-owned return turn: `f.turn.data.owner !== GUEST`), `pressEarly` and `takeEarly`, and `meterOf(GUEST)` reading `this.latest`:

```ts
  /** The guest's meter level for early feedback, or null in training. */
  private meterOf(): number | null {
    return this.latest.config.training !== null ? null : this.latest.power[GUEST];
  }
```
  - `key()`: `if (own === null) { if (k.kind === 'letter' && !this.pressEarly(k.letter)) this.wait.show(now); return; }`
  - `step(now)`: call `this.watchEarly();` after the `advance` loop.
  - `startOwn(entry)`:

```ts
  /** The guest's turn is displayed: a local runner starts from its start data now (τ 0) with the guest's early keys; the host hears them, then clock 0. */
  private startOwn(entry: DisplayEntry): void {
    const runner = createTurn(entry.turn.data);
    runner.seenKinds = [...entry.turn.seenKinds];
    const early = this.takeEarly();
    const events = startTurn(runner, early);
    entry.turn = runner;
    const own: OwnTurn = { entry, runner, start: entry.startedAt ?? this.scheduler.now(), sent: 0, outcome: null, checked: false, tossHeld: false };
    this.own = own;
    const turn = runner.data.turnId;
    if (early.length > 0) this.link.send({ type: 'early', turn, keys: early });
    this.link.send({ type: 'clock', turn, τ: 0 });
    this.onOwnEvents(own, events);
  }
```
  - `buildView`: `early: this.early === null ? null : { player: GUEST, prompt: copy(this.early.prompt) },`.
  - Class doc: the same one-sentence addition, from the guest's side.

- [ ] **Step 6: Amend the spec (deviation 2).** In the spec's §7, replace the Net bullet's latency-invariance line with:
  > Latency invariance holds for typists that don't type early (as before). An early key is timed on the receiver's playback of the striker's turn, whose rate depends on latency (main spec §5.2), so no scripted typist can press it at the same τ at every latency. With early typing, the scripted match checks that both sides typed early and that there is no desync.

- [ ] **Step 7: Run everything online.**
  Run: `npx vitest run tests/net tests/game && npm run typecheck && npm test`
  Expected: PASS, including the unchanged latency-invariance tests (typists with `early: false`).

- [ ] **Step 8: Commit.**

```bash
git add src/game tests/net docs/superpowers/specs/2026-09-28-early-typing-and-human-cpu-design.md
git commit -m "feat(game): type the striker's word early online, timed on your own playback of their turn

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb"
```

---

### Task 11: Balance: targets, calibration and tuning

**Files:**
- Modify: `tests/sim/balance.test.ts` (header, cells, new targets)
- Modify: `src/core/tuning.ts` (knobs, `CPU_NOMINAL_WPM`, comments with measured values)
- Modify: the spec §4 (a measured-result paragraph)
- Probe files (not committed): `tools/scratch/early-balance/*.probe.ts` (the directory is gitignored and excluded from the typecheck)

**Interfaces:**
- Consumes: `simTypist`, `simulatePoints`, `simulateMatch` (with `stats`) and `summarize` (with the tier mix) from Tasks 2 and 6; `averageWpm` from `src/core/engine.ts`.

- [ ] **Step 1: Rewrite the balance targets.** In `tests/sim/balance.test.ts`:
  - Header comment: replace the target paragraph with spec §4's table, keeping the old measured tables below a line "Before early typing (2026-09-27): …" until Step 6 replaces them.
  - Equal-player cells (existing `describe.each(PRESETS…)`), two new `it`s:

```ts
      it('rally shots are at most 65 % easy', ({ expect }) => {
        expect(s().rallyEasy).toBeLessThanOrEqual(0.65);
      });
      it('at least 15 % of rally shots are hard or insane', ({ expect }) => {
        expect(s().rallyHard + s().rallyInsane).toBeGreaterThanOrEqual(0.15);
      });
```
  - New cell, faster wins:

```ts
  describe.each(PRESETS.map((p, i) => ({ ...p, seed: 6000 + i })))(
    '$pace at $wpm WPM, a typist 20 % faster',
    ({ pace, wpm, seed }) => {
      it('wins ≥ 65 % of points', ({ expect }) => {
        const typists: [SimTypist, SimTypist] = [simTypist(wpm * 1.2), simTypist(wpm)];
        const points = simulatePoints({ config: config(pace), typists, seed, points: CELL_POINTS });
        expect(winShare(points, 0)).toBeGreaterThanOrEqual(0.65);
      });
    },
  );
```
  - New cell, honest labels (import `averageWpm` from `../../src/core/engine`, `CPU_LEVEL_WPM` from `../../src/core/tuning`):

```ts
  /** Both players' average WPM (the Results formula) over `sets` short sets at Normal between two copies of `level`. */
  function measuredWpm(level: number, seed: number, sets: number): number {
    const typists: [SimTypist, SimTypist] = [{ profile: cpuProfile(level) }, { profile: cpuProfile(level) }];
    let intervals = 0;
    let ms = 0;
    for (let i = 0; i < sets; i++) {
      for (const st of simulateMatch({ config: config('normal', 'short'), typists, seed: seed + i }).stats) {
        intervals += st.intervalSum;
        ms += st.typingMs;
      }
    }
    return averageWpm({ intervalSum: intervals, typingMs: ms } as PlayerStats);
  }

  it.for(CPU_LEVEL_WPM.map((wpm, level) => ({ level, wpm, seed: 700_000 + 1000 * level })))(
    'Normal, CPU level $level: its average WPM on Results is within 5 % of $wpm',
    ({ level, wpm, seed }, { expect }) => {
      const measured = measuredWpm(level, seed, HONEST_SETS);
      expect(measured / wpm).toBeGreaterThanOrEqual(0.95);
      expect(measured / wpm).toBeLessThanOrEqual(1.05);
    },
  );
```
    with `const HONEST_SETS = 40;` beside the other cell sizes, and `PlayerStats` imported as a type.
  - `AGGRESSION_CELLS`: levels near each reference speed on the new ladder: `relaxed 2 (32)`, `normal 6 (52)`, `fast 8 (67)`, `lightning 10 (86)`.
  - Smoke test: keep '300 points at Normal / 50 WPM all end…' with the band set to the new Normal target band (7–11) widened by 3 on each side for 300 points: `medianShots` in `[4, 14]`. Also assert `rallyEasy < 1`.

- [ ] **Step 2: Calibrate `CPU_NOMINAL_WPM`.** Create `tools/scratch/early-balance/nominal.probe.ts`, a Vitest file run with `npx vitest run --root . tools/scratch/early-balance/nominal.probe.ts --config vitest.config.ts --dir tools/scratch`. If the default config's `include` blocks it, copy it to `tests/zz_nominal_tmp.test.ts`, run it, and delete it before committing.
  - For each level: measure the average WPM as in `measuredWpm` over 40 short sets.
  - Set `nominal ← nominal × label / measured`.
  - Repeat until every level is within ±2 %.
  - Print the final table and paste it into `CPU_NOMINAL_WPM`. Update its comment to "calibrated 2026-09-28 by the balance simulation (40 short sets per level at Normal)".
  - Re-run `npx vitest run tests/core/cpu.test.ts` (the ordering and "nominal > label" checks must still hold).

- [ ] **Step 3: Run the full balance simulation.**
  Run: `npm run test:sim` (it takes several minutes; run it in the background).
  Record every failing target with its measured value.

- [ ] **Step 4: Tune, in the spec's knob order, with a fast probe.** Write `tools/scratch/early-balance/knobs.probe.ts`. For each knob set, it runs `summarize(simulatePoints(...))` for the four equal-player presets (1,500 points each) plus the four faster-wins cells, and prints median / p90 / max / s per point / aces / DF / server % / tier mix / faster-wins %. Override the knobs by assigning to `(TUNING.flight as any)` in the probe (never in `src`).
  - Knob order: `flight.rallyBaseMs` → `flight.place` (rally) → `flight.pressure` → `flight.pressureFloor`; for serve targets only: `tossApexMs`, then `flight.serveReturnBonusMs` / `serveReturnBonusPaceMs`.
  - The typist model (`TUNING.typist`) and `CPU_NOMINAL_WPM` are **not** knobs.
  - When a probe set meets every target, put its values in `tuning.ts` and re-run `npm run test:sim`.
  - **If no set meets every target** (the probe already showed p90 23–27 and server wins 46–57 % at Normal): stop. Write down the best set and every target it misses, with the numbers, and take the trade-off to the user. Don't commit tuning that fails a target, and don't loosen a target.

- [ ] **Step 5: Re-calibrate labels if the flight knobs moved.** Repeat Step 2 if the tier mix changed noticeably (hesitations depend on the share of hard words), then run `npm run test:sim` once more.

- [ ] **Step 6: Record the results.**
  - Put the measured tables (every cell) in `tests/sim/balance.test.ts`'s header, replacing the pre-early-typing tables, in the existing table style.
  - Update the comments in `tuning.ts` on `rallyBaseMs`, `place`, `pressure` and `pressureFloor` with the final values and "measured: tests/sim/balance.test.ts".
  - Add a "Measured result (2026-09-28)" paragraph to spec §4 with the headline numbers.

- [ ] **Step 7: Verify and commit.**
  Run: `npm run typecheck && npm test && npm run test:sim`
  Expected: all PASS.

```bash
git add tests/sim/balance.test.ts src/core/tuning.ts docs/superpowers/specs/2026-09-28-early-typing-and-human-cpu-design.md
git commit -m "test(sim): balance targets for early typing (tier mix, faster wins, honest labels) and the tuned constants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb"
```

---

### Task 12: Words on screen, E2E and docs

**Files:**
- Modify: `src/ui/screens/howTo.ts` (the CHASE step text)
- Modify: `src/game/training.ts` (`COACH.watch`)
- Modify: `src/game/debug.ts` (`activeWords` returns the viewer's early chase)
- Modify: `tests/e2e/typist.mjs` (+ `.d.mts`) and `tests/e2e/typist.test.ts` (type early)
- Modify: `README.md` (Return paragraph; belt WPMs if listed)
- Modify: `docs/superpowers/specs/2026-09-26-black-belt-tennis-design.md` (§3.1, §3.3, §3.4, §3.8, §4.2, §4.4, §5.2, §5.3, §6: a pointer sentence each)
- Modify: `docs/superpowers/specs/2026-09-27-power-meter-and-rally-pacing-design.md` (§2, §7: pointers)
- Test: `tests/game/training.test.ts`, `tests/game/debug.test.ts`, `tests/e2e/typist.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `tests/game/debug.test.ts`: while the viewer's early chase is open, `activeWords()` returns `{ words: [word], locked: 0, typed, kind: 'early' }`. Build the view model as the file's other tests do, with `early: { player: 0, prompt }`.
  - `tests/e2e/typist.test.ts`: `pageSnapshot` carries `early: { word, typed } | null` for the viewer's early chase, and `nextKey` returns its next letter, even when the viewer doesn't own the turn:

```ts
  it("types the viewer's early chase in the opponent's turn", () => {
    const s = { status: 'choice', me: 0, owner: 1, words: null, points: 0, coach: null, early: { word: 'drop', typed: 1 } };
    expect(nextKey(s)).toBe('r');
    expect(nextKey({ ...s, early: { word: 'drop', typed: 4 } })).toBeNull();
  });
```
  - `tests/game/training.test.ts`: the `watch` coach text is `'WHEN THEY PICK A WORD, START TYPING IT: YOU CAN CHASE EARLY'`, if the file pins coach texts. Keep its two-HUD-lines check.

- [ ] **Step 2: Run to see the failures.**
  Run: `npx vitest run tests/game/debug.test.ts tests/e2e/typist.test.ts tests/game/training.test.ts`

- [ ] **Step 3: Implement.**
  - `debug.ts` `activeWords`: first check `const e = vm?.early; if (e && e.player === vm.viewer) return { words: [e.prompt.options[0]?.word ?? ''], locked: 0, typed: e.prompt.typed, kind: 'early' };`
  - `typist.mjs`:
    - `pageSnapshot` adds `early: vm.early !== null && vm.early.player === vm.viewer ? { word: vm.early.prompt.options[0].word, typed: vm.early.prompt.typed } : null` (and `early: null` in the no-view return).
    - `nextKey` starts with `if (s.me !== null && s.early && s.early.typed < s.early.word.length) return s.early.word.charAt(s.early.typed);`.
    - Update `typist.d.mts`.
  - `training.ts`: `watch: 'WHEN THEY PICK A WORD, START TYPING IT: YOU CAN CHASE EARLY',`
  - `howTo.ts` chase step: `text: 'Type the word your opponent hits to run to the ball. In a rally you can start as soon as they pick it. Then pick your shot.'`. Check that the How to Play panel still fits 960×540 (the e2e screenshot, or `npm run dev`). If it doesn't, shorten the text, keeping "as soon as they pick it".
  - `README.md`, the Return paragraph: after the sentence about typing the opponent's word, add "In a rally you may start as soon as your opponent picks their word (types its first letter), so a fast typist finishes the chase before the ball is even struck and has the whole flight for an attack." Update any belt-WPM list to the new ladder.
  - Main spec and power-meter spec: at each section listed above, add one sentence pointing to the early-typing spec, in the style of the existing "(amended: … spec 2026-09-27)" notes. For example, §3.1: "Exception: the receiver may type the striker's word early, from the striker's choice lock to the strike (amended: early-typing spec 2026-09-28 §2)."

- [ ] **Step 4: Run the whole thing.**
  Run: `npm run typecheck && npm test && npm run build`
  Then: `npm run e2e` (local Chrome; the online part is best effort). Look at `4-match-chase.png` and the How to Play screenshot.

- [ ] **Step 5: Commit.**

```bash
git add src/ui src/game tests README.md docs
git commit -m "docs: How to Play, Training, README and the specs describe early typing and the new belts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb"
```

---

## Finishing

- [ ] `npm run typecheck && npm test && npm run build && npm run test:sim` all pass; `npm run e2e` passes (online part best effort).
- [ ] Whole-branch review (superpowers:requesting-code-review) and fixes.
- [ ] Merge to `main` and push (the user's standing rule: a verified major feature is merged and deployed without asking).
