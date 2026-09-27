# Power Meter, Insane Words and Rally Pacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Soften the rally speed-up, shorten every word tier, and add a per-player power meter that unlocks a fourth "insane" word while full.

**Architecture:** `insane` becomes a fourth `Tier` with an entry in every tier table. A new pure module `src/core/power.ts` holds the meter rules. The per-turn simulator (`TurnRunner`), the engine and the playback view (`turnViewAt`) all derive the meter from a turn's start data and its log, so host, guest and replays agree. Renderers read the meter from `PublicState.power` and `TurnView.power`.

**Tech Stack:** TypeScript 7, Vite 8, Vitest 5 (Node + jsdom), Canvas 2D, WebAudio, PeerJS.

**Spec:** `docs/superpowers/specs/2026-09-27-power-meter-and-rally-pacing-design.md`. It amends `docs/superpowers/specs/2026-09-26-black-belt-tennis-design.md`, the "main spec".

## Global Constraints

- Tiers by length: easy **2–4**, medium **5–7**, hard **8–11**, insane **12–15** letters; any other length has no tier.
- Pack minimums per pack: ≥ 120 easy, ≥ 120 medium, ≥ 80 hard, ≥ 60 insane. Only lowercase a–z, no duplicates, no blocklisted word or stem.
- Meter: 0–4 per player (`TUNING.power.max = 4`), starts at 0.
  - +1 per flawless serve or choice word, counted at the strike.
  - Empties to 0 on any wrong key (serve, chase or choice) and on any lost point.
  - Always 0 and hidden in training.
- Insane is offered on a serve or choice prompt only while the owner's level is 4. It is option index **3**; tier order is easy 0, medium 1, hard 2, insane 3 everywhere.
- Insane targets sit 0.15 m inside the lines:
  - Rally, half coordinates: `(m·3.965, 11.735)`.
  - Serve, box coordinates: `(3.965, 6.25)` when hard is T, `(0.15, 6.25)` when hard is wide.
- Insane tuning (starting values): `place` 0.55, `sigma0` 0.04, `sigmaE` 0.80, `netRate` 0.10, `arcH` 1.2, `kmh.tierBonus` 1.20.
- Pressure: `P(n) = max(pressureFloor, pressure^⌊n/2⌋)`, computed by repeated multiplication. Start at `pressure = 0.93`, `pressureFloor = 0.65`.
- `PROTO` 1 → 2; `MatchState.v` 1 → 2.
- Plate width `6n + 11` px, max **101 px** (15 letters). Plates stay within x 4–476 and y 22–266.
- Choice slots: 3 options at x 90 / 240 / 390; 4 options at **60 / 180 / 300 / 420**, assigned by target screen x.
- The insane plate carries **4** pips; its ground ring is an 8-point burst.
- `core/` stays pure: no DOM, no timers, no `Math.random`, no `Date`. State stays JSON-safe.
- Balance targets (Task 14): median rally 5–8, p90 ≤ 16, max ≤ 60, median ≤ 50 s per point, aces ≤ 15 %, double faults 1–6 %, server wins 55–65 %, clean insane shots returned 15–40 %, never-insane vs adaptive 40–50 %. **If they cannot all be met at once, stop and report to the user. Never loosen a target quietly.**
- Every commit: `npm run typecheck` and `npm test` pass. `npm run build` passes at the end.
- Commit messages follow the repo's `type(scope): summary` style and end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
  ```

### Recorded deviation from the spec (needs the user's OK; see Task 1)

The spec picks Okabe–Ito reddish purple `#CC79A7` for insane and says the colour-blindness tests cover it. Measured against the existing tier colours, it clears CIEDE2000 ≥ 20 in normal vision (37.0 / 45.5 / 62.5). Under colour-vision deficiency it gets only 14.1 from sky blue (protan), 15.5 from sky blue (deutan) and 14.0 from vermillion (tritan). The existing test requires ≥ 20.

A grid search found that nothing but near-white or grey reaches ≥ 20 from all three tiers under all three deficiencies. Near-white would vanish on the white court lines, where the insane rings sit, 0.15 m inside them.

This plan therefore keeps `#CC79A7` and tests insane pairs at **≥ 20 in normal vision and ≥ 12 under each deficiency**. Tier is never shown by colour alone: insane also has 4 pips, its own ring shape, the outermost slot and the longest words. The palette is capped at 48 colours and already holds 47, so the typed shade reuses the crowd purple, re-tinted `#7E5AA6` → `#B06FA0`: 4.85:1 on the plate fill and a luminance ratio of 3.84.

### Recorded deviation: the 4-plate screenshot

Spec §8 asks for "a devshot of a 4-plate choice and a full HUD meter". The art page's live scenes come from a match with a fixed seed chosen so every existing moment appears early; adding a full-meter moment would mean re-choosing that seed. Instead:
- the 4-plate row is pinned by the layout and prompt tests (Task 10);
- the insane plates, the insane rings and the full and part-filled meters are checked visually on the art page via `npm run art:export` (Task 13).

## Review Focus

1. **A chase slip after the CPU pre-planned its choice.** The CPU plans the choice while the chase is still being typed. If a planned wrong key in the chase removes the insane option, a plan aimed at option 3 would stall the turn. The CPU must never aim at an option that won't be shown. Test in Task 9.
2. **Four pre-picked targets but three shown options.** After a chase slip, `d.choice.targets` has 4 entries while the prompt shows 3. The renderer must draw 3 rings and leaders and must not throw in `layoutChoice`. Test in Task 10.
3. **A peer sends a state with a missing, NaN or out-of-range `power`.** `parseState` must reject a missing or non-finite pair and clamp values to 0–4. Test in Task 5.
4. **A cancelled return turn while the meter is full.** The incoming ball is called OUT after the receiver finished a flawless choice. The meter must not fill (no strike happened), and a wrong key typed before the call must still empty it. Test in Task 6.
5. **Training.** No insane option, no `power` events, no meter in the HUD, and `TurnData.power` is null. Tests in Tasks 7 and 11.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/core/types.ts` | `Tier` + `INSANE` + `ALL_TIERS`; `MatchState.power`, `v: 2`; `TurnData.power`; `power` event | 1, 5 |
| `src/core/tuning.ts` | insane tier values, `pressureFloor`, `power.max` | 1, 2, 5, 14 |
| `src/core/words/lists.ts` | one word pool per pack, tiers derived by length | 1 |
| `src/core/words/picker.ts` | `pickSet` (3 or 4 words) | 4 |
| `src/core/court.ts` | `insaneServeTarget`, `insaneRallyTarget` | 3 |
| `src/core/shot.ts` | pressure floor | 2 |
| `src/core/power.ts` (new) | meter rules: `insaneOffered`, `levelFromKeys`, `levelAfterStrike`, `powerAt`, `choiceOptions` | 5 |
| `src/core/turn.ts`, `src/core/turnView.ts` | choice drops insane after a slip; `power` events; `TurnView.power` | 6 |
| `src/core/engine.ts` | picks insane sets, commits levels, empties the loser, `v: 2` | 5, 7 |
| `src/core/cpu.ts`, `src/core/sim.ts` | 4-option choice, `neverInsane`, insane metrics | 9 |
| `src/net/protocol.ts`, `src/game/guestSession.ts`, `src/game/onlineLink.ts` | `PROTO` 2, parse `power`, snapshot `power` | 5, 8 |
| `src/render/palette.ts`, `src/render/plates.ts` | insane colours, 4 pips, burst ring | 1 |
| `src/render/layout.ts`, `src/render/prompts.ts` | 4-slot choice row, targets sliced to shown options | 10 |
| `src/render/hud.ts`, `src/render/renderer.ts` | meter segments | 11 |
| `src/render/ball.ts`, `src/render/world.ts`, `src/audio/sfx.ts`, `src/audio/director.ts` | insane trail, meter and insane sounds | 12 |
| `src/ui/screens/howTo.ts`, `src/game/training.ts`, `README.md`, `tools/art/*`, `tests/e2e/typist.mjs` | docs, training words, art QA, e2e typist | 1, 13 |
| `tests/sim/balance.test.ts` | new targets, measured tables | 14 |
| main spec | amendments | 15 |

---

### Task 1: The insane tier, new length bands and word pools

**Files:**
- Modify: `src/core/types.ts:6-9` (Tier, TIERS)
- Modify: `src/core/tuning.ts:27,41,43-46,53`
- Modify: `src/core/words/lists.ts` (whole file structure)
- Modify: `src/game/training.ts:29`
- Modify: `src/render/palette.ts:3-5,21-23,29,65-82`
- Modify: `src/render/plates.ts:44,122-126,234-311`
- Modify: `tools/art/rings.ts:8,13`
- Modify: `docs/superpowers/specs/2026-09-27-power-meter-and-rally-pacing-design.md` §6 Colour bullet
- Test: `tests/core/words.test.ts`, `tests/core/shot.test.ts`, `tests/core/trajectory.test.ts`, `tests/render/palette.test.ts`, `tests/render/plates.test.ts`, `tests/core/turnFixtures.ts`

**Interfaces:**
- Produces:
  - `type Tier = 'easy' | 'medium' | 'hard' | 'insane'`
  - `TIERS: readonly Tier[]` (unchanged: the 3 always-offered tiers)
  - `INSANE: Tier`, `ALL_TIERS: readonly Tier[]`
  - `tierOfLength(len: number): Tier | null` (new bands)
  - `PACKS[pack].insane`, `packWords(pack, 'insane')`
  - `TIER_COLOR.insane`, `TIER_TYPED.insane`, `PAL.tierPurple`
  - `TUNING.flight.place.insane` and the other insane tuning values

- [ ] **Step 1: Write the failing word tests**

In `tests/core/words.test.ts`:
- Change the import to `import { ALL_TIERS, TIERS, type PickerState, type RngState, type Tier, type WordOption, type WordPackId } from '../../src/core/types';`.
- Replace lines 8–9 with:

```ts
const MIN_WORDS: Record<Tier, number> = { easy: 120, medium: 120, hard: 80, insane: 60 };
const LENGTHS: Record<Tier, [number, number]> = { easy: [2, 4], medium: [5, 7], hard: [8, 11], insane: [12, 15] };
```

Change `for (const tier of TIERS)` to `for (const tier of ALL_TIERS)` in the `word packs` describe (line 39), in `const words = TIERS.flatMap(...)` of `misleading words` (line 78), and in both `packWords` loops (lines 104 and 109). Leave the picker tests' `TIERS` alone.

Replace the `tierOfLength` test with:

```ts
describe('tierOfLength', () => {
  it('maps lengths to tiers by the bands (easy 2–4, medium 5–7, hard 8–11, insane 12–15)', () => {
    const lengths = [0, 1, 2, 4, 5, 7, 8, 11, 12, 15, 16];
    expect(lengths.map((n) => tierOfLength(n))).toEqual([
      null, null, 'easy', 'easy', 'medium', 'medium', 'hard', 'hard', 'insane', 'insane', null,
    ]);
  });
});
```

In the `pickFixed` describe, replace `'quarterfinal'` with `'tiebreaker'` in `list` and in the first expectation: `{ word: 'tiebreaker', len: 10, tier: 'hard' }`.

Replace the `toOption` describe with:

```ts
describe('toOption', () => {
  it('computes length and tier', () => {
    expect(toOption('ox')).toEqual({ word: 'ox', len: 2, tier: 'easy' });
    expect(toOption('topspin')).toEqual({ word: 'topspin', len: 7, tier: 'medium' });
    expect(toOption('tiebreaker')).toEqual({ word: 'tiebreaker', len: 10, tier: 'hard' });
    expect(toOption('serveandvolley')).toEqual({ word: 'serveandvolley', len: 14, tier: 'insane' });
  });

  it('throws on anything but a 2–15-letter lowercase a–z word', () => {
    for (const bad of ['Ball', '', 'a', 'abcdefghijklmnop', 'ball!', 'ba ll', 'café']) {
      expect(() => toOption(bad), bad).toThrow();
    }
  });
});
```

- [ ] **Step 2: Write the failing shot, trajectory, palette and plate tests**

In `tests/core/shot.test.ts`:
- Import `ALL_TIERS` next to `TIERS`.
- Add `insane` rows to the two target tables:

```ts
const SERVE_TARGETS: Record<Tier, Vec2[]> = {
  easy: [{ x: -2.06, y: 4.2 }],
  medium: [{ x: -3.115, y: 5.4 }, { x: -1.0, y: 5.4 }], // hard is T / hard is wide
  hard: [{ x: -0.4, y: 6.0 }, { x: -3.715, y: 6.0 }], // T / wide
  insane: [{ x: -3.965, y: 6.25 }, { x: -0.15, y: 6.25 }], // hard is T → wide corner / hard is wide → T corner
};

const RALLY_TARGETS: Record<Tier, Vec2[]> = {
  easy: [{ x: 0, y: 8.885 }],
  medium: [{ x: -2.865, y: 9.385 }, { x: 2.865, y: 9.385 }],
  hard: [{ x: 3.615, y: 11.385 }, { x: -3.615, y: 11.385 }],
  insane: [{ x: -3.965, y: 11.735 }, { x: 3.965, y: 11.735 }], // medium's side, m = +1 then −1
};
```

In `resolveShot accuracy guarantees`, change `for (const [t, tier] of TIERS.entries())` and the `for (const tier of TIERS)` in the extremes test to use `ALL_TIERS`. Then add:

```ts
  it('insane rally shot with 1 slip fails (out + net) 60–85 % of the time', () => {
    for (const [i, target] of RALLY_TARGETS.insane.entries()) {
      const c = tally('insane', 1, target, inRallyHalf, 20_000, 4000 + i);
      const failRate = (c.out + c.net) / 20_000;
      expect(failRate, `target (${target.x}, ${target.y})`).toBeGreaterThanOrEqual(0.6);
      expect(failRate, `target (${target.x}, ${target.y})`).toBeLessThanOrEqual(0.85);
    }
  });
```

In `flightTimeMs › never leaves more time for harder placement`, change the loop to `for (let chaseLen = 2; chaseLen <= 15; chaseLen++)`, the helper to `const t = (tier: Tier): number => flightTimeMs({ pace, chaseLen, v, tier, isServe: false, n });`, and the condition to `if (!(t('insane') < t('hard') && t('hard') < t('medium') && t('medium') < t('easy')))`. Rename the test to `'never leaves more time for harder placement: T(insane) < T(hard) < T(medium) < T(easy)'`.

In `displayKmh › is round(95 × v × tier bonus) at rally depth 0`, add `expect(displayKmh(1, 'insane', 0, false)).toBe(114); // 95 × 1.2`.

In `tests/core/trajectory.test.ts:8`: `const TIER_ARC: Record<Tier, number> = { easy: 2.0, medium: 1.7, hard: 1.4, insane: 1.2 };`

In `tests/render/palette.test.ts`:
- Import `ALL_TIERS` next to `TIERS`.
- Change the `TIER_COLOR` equality to `expect(TIER_COLOR).toEqual({ easy: '#56B4E9', medium: '#F0E442', hard: '#D55E00', insane: '#CC79A7' });`.
- Add at the end:

```ts
describe('insane tier colours (power-meter spec §6)', () => {
  it('is Okabe–Ito reddish purple, typed in the crowd purple re-tinted to #B06FA0', () => {
    expect(TIER_COLOR.insane).toBe('#CC79A7');
    expect(PAL.tierPurple).toBe('#CC79A7');
    expect(PAL.crowdPurple).toBe('#B06FA0');
    expect(TIER_TYPED.insane).toBe(PAL.crowdPurple);
  });

  // Recorded deviation (plan Task 1): ≥ 20 against every other tier is only reachable with
  // near-white or grey, which would vanish on the court lines under the insane rings. Tier is never
  // shown by colour alone (4 pips, burst ring, outermost slot, longest words).
  it('stays ≥ 20 CIEDE2000 from every other tier in normal vision and ≥ 12 under each colour-vision deficiency', () => {
    for (const t of TIERS) {
      expect(ciede2000(TIER_COLOR.insane, TIER_COLOR[t]), t).toBeGreaterThanOrEqual(20);
      for (const view of CVD_KINDS) {
        const d = ciede2000(simulateCvd(TIER_COLOR.insane, view), simulateCvd(TIER_COLOR[t], view));
        expect(d, `${view} insane/${t}`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('meets the typed-shade rules: ≥ 4.5:1 on the fill, ≤ 1/1.8 of the remaining letters, nearer its own tier', () => {
    expect(contrastRatio(TIER_COLOR.insane, PLATE.fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(TIER_TYPED.insane, PLATE.fill)).toBeGreaterThanOrEqual(4.5);
    expect(relativeLuminance(PLATE.text) / relativeLuminance(TIER_TYPED.insane)).toBeGreaterThanOrEqual(1.8);
    const own = ciede2000(TIER_TYPED.insane, TIER_COLOR.insane);
    for (const t of TIERS) expect(own, t).toBeLessThan(ciede2000(TIER_TYPED.insane, TIER_COLOR[t]));
  });

  it('keeps every tier table complete', () => {
    for (const t of ALL_TIERS) {
      expect(palValues, t).toContain(TIER_COLOR[t]);
      expect(palValues, t).toContain(TIER_TYPED[t]);
    }
  });
});
```

In `tests/render/plates.test.ts`, inside `describe('drawPlate — local active')`, add:

```ts
  it('carries 4 insane-coloured pips as 2×1 bars, one court row apart and clear of the tier outline', () => {
    const g = scene();
    const p = plate('photosynthesis', { opt: { word: 'photosynthesis', len: 14, tier: 'insane' } });
    drawPlate(as2d(g), p);
    const ink = TIER_COLOR.insane;
    const { x, y } = p.box;
    const rows: number[] = [];
    for (let py = y + 2; py < y + 14; py++) {
      if (at(g, x + 3, py) === ink) {
        expect(at(g, x + 4, py)).toBe(ink);
        rows.push(py - y);
      }
    }
    expect(rows).toEqual([4, 6, 8, 10]);
  });
```

Also add this test next to the other `drawTierRing` tests (find them with `grep -n "drawTierRing" tests/render/plates.test.ts`):

```ts
  it('draws the insane ring as an 8-point burst: ink on 8 rays around an open centre', () => {
    const g = scene(40, 20);
    drawTierRing(as2d(g), 'insane', 20, 10);
    const ink = TIER_COLOR.insane;
    expect(at(g, 20, 10)).not.toBe(ink);
    const rays = [[0, -3], [0, 3], [-6, 0], [6, 0], [-4, -3], [4, -3], [-4, 3], [4, 3]];
    for (const [dx, dy] of rays) expect(at(g, 20 + dx!, 10 + dy!), `${dx},${dy}`).toBe(ink);
  });
```

In `tests/core/turnFixtures.ts:20`: `export const tierOf = (len: number): Tier => (len <= 4 ? 'easy' : len <= 7 ? 'medium' : len <= 11 ? 'hard' : 'insane');` and update its doc line to `/** Tier of a word length (power-meter spec §3: easy 2–4, medium 5–7, hard 8–11, insane 12–15). */`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/core/words.test.ts tests/core/shot.test.ts tests/render/palette.test.ts tests/render/plates.test.ts`
Expected: FAIL. `tierOfLength` returns the old bands, `PACKS.everyday.insane` is undefined, `TUNING.accuracy.sigma0.insane` is undefined (NaN sigma), `TIER_COLOR.insane` is undefined.

- [ ] **Step 4: Add the tier to `types.ts` and `tuning.ts`**

`src/core/types.ts` lines 6–9 become:

```ts
/** Word difficulty tier by length: easy 2–4, medium 5–7, hard 8–11, insane 12–15 letters (power-meter spec §3). */
export type Tier = 'easy' | 'medium' | 'hard' | 'insane';
/** The tiers every serve and choice prompt offers, easiest first (options 0–2). */
export const TIERS: readonly Tier[] = ['easy', 'medium', 'hard'];
/** The fourth option (index 3), offered only while the owner's power meter is full (power-meter spec §4.2). */
export const INSANE: Tier = 'insane';
/** Every tier, easiest first. */
export const ALL_TIERS: readonly Tier[] = [...TIERS, INSANE];
```

`src/core/tuning.ts`: add `insane` to every tier table:

```ts
    place: { easy: 1.0, medium: 0.85, hard: 0.7, insane: 0.55 } as Record<Tier, number>,
```
```ts
  kmh: { base: 95, tierBonus: { easy: 1.0, medium: 1.05, hard: 1.1, insane: 1.2 } as Record<Tier, number>, serveMult: 1.25 },
```
```ts
    sigma0: { easy: 0.10, medium: 0.12, hard: 0.10, insane: 0.04 } as Record<Tier, number>,
    sigmaE: { easy: 0.25, medium: 0.35, hard: 0.5, insane: 0.8 } as Record<Tier, number>,
```
```ts
    netRate: { easy: 0.01, medium: 0.03, hard: 0.06, insane: 0.10 } as Record<Tier, number>,
```
```ts
    arcH: { easy: 2.0, medium: 1.7, hard: 1.4, insane: 1.2 } as Record<Tier, number>,
```

Above `accuracy`, add a comment line: `// Insane (power-meter spec §4.3): σ0 0.04 m keeps a flawless insane shot 0.139 m < its 0.15 m margin inside the lines.`

- [ ] **Step 5: Rebuild `lists.ts` as one pool per pack**

In `src/core/words/lists.ts`:

1. Change the import to `import { ALL_TIERS, type Tier, type WordPackId } from '../types';`.
2. Rename the `PACKS` object to `POOLS` and type it `Record<'everyday' | 'sports' | 'dojo', readonly string[]>`. In each pack, concatenate the existing `easy`, `medium` and `hard` template blocks, in that order, into one `words(\`...\`)` block. Move every existing word unchanged, then append the new words below.

Everyday, appended:

```
ox go hi
extraordinary communication understanding organization international architecture constellation
accommodation advertisement approximately breathtaking butterscotch chrysanthemum civilization
collaboration compassionate consideration disappointment embarrassment encouragement enthusiastic
establishment exhilarating headquarters illumination inconvenience independence intelligence
introduction knowledgeable manufacturer mathematician meteorologist misunderstand multiplication
nevertheless philosophical photosynthesis presentation professional recommendation rhododendron
satisfaction significance sophisticated subscription thanksgiving unbelievable weatherproof
accidentally affectionate agricultural alphabetical appreciation astronomical breakthrough
carbohydrate circumstance conservation contemporary disagreement entrepreneur extinguisher
housewarming incandescent indescribable installation instrumental invigorating irresistible
kaleidoscope lighthearted mountainside nutritionist oceanography paleontology preservation
storytelling thundercloud unforgettable unpredictable wholehearted
```

Sports, appended:

```
go par cue dart bowl pin mask sock cart spar jab hook duel foil epee rod bait kart pole ramp
rail wax fin keel mast helm hull tack jibe knot cox horn drum song rep core zone turf clay mud
bodybuilding cheerleading equestrianism motorcycling mountaineering trampolining horsemanship
marksmanship basketballcourt footballpitch baseballglove bowlingalley goldmedalist silvermedalist
bronzemedalist olympicflame olympictorch olympicstadium marathonrunner sprintfinish discusthrower
javelinthrow hammerthrower obstaclecourse trainingcamp personaltrainer physiotherapy
physiotherapist sportsmedicine assistantcoach threepointer curlingstone curlingbroom figureskater
pingpongpaddle squashracket lacrossestick cricketpitch trophycabinet medalceremony victoryparade
worldchampion recordbreaker recordbreaking sportsmanlike competitiveness fitnesstracker
qualification quarterfinalist footballplayer baseballplayer hockeyplayer cricketplayer
golfchampion boxingchampion chesstournament chesschampion cyclingjersey yellowjersey
racingbicycle formularacing
```

Dojo, appended:

```
gi ki bo jo qi om rei osu hai sai koi ashi kote tare bogu saya kama yari sumi carp pine moss pond
rock sand rake wood oak yew mist dew dawn dusk moon sky rain wind fire soul ease rest pure sage aim
selfimprovement selfconfidence selfawareness selfreliance selfsacrifice blackbeltexam beltceremony
dojoetiquette sparringpartner sparringmatch sparringgear trainingpartner trainingsession
morningpractice breathingdrill meditationhall meditationmat templegarden bamboogarden
lanternfestival cherryblossom karatechampion judochampion aikidomaster karatemaster taekwondokick
taekwondomaster shaolintemple warriorspirit fightingspirit invincibility contemplation
contemplative enlightenment respectfulness courteousness truthfulness faithfulness thoughtfulness
graciousness righteousness steadfastness perfectionist practitioner blackbeltholder seconddegree
choreography demonstrator tournamentring kickingdrill punchingdrill blockingdrill footworkdrill
strikingdrill strikingshield kickingshield kickingtarget brickbreaking dragonstance monkeystance
mantisstance leopardstance roundhousekick palmheelstrike tigerclawstrike
```

These lists were checked during planning against the current packs. None duplicates an existing word of its pack, none is blocklisted or contains a blocklisted stem, and all are 2–15 letters. Resulting counts (easy / medium / hard / insane): Everyday 144 / 328 / 151 / 108, Sports 145 / 200 / 164 / 88, Dojo 153 / 218 / 137 / 95.

3. Replace the pool doc comment and add the derived `PACKS`:

```ts
/**
 * Curated word pools, one per pack (spec §3.10, power-meter spec §3). A word's tier is its length
 * band (`tierOfLength`), so a pool is never split by hand: easy 2–4, medium 5–7, hard 8–11 and
 * insane 12–15 letters.
 */
const POOLS: Record<'everyday' | 'sports' | 'dojo', readonly string[]> = {
  // ... the three pools of step 2 ...
};

/** The pack lists by tier (spec §3.10): each pool split by word length. */
export const PACKS: Record<'everyday' | 'sports' | 'dojo', Record<Tier, readonly string[]>> = {
  everyday: byTier(POOLS.everyday),
  sports: byTier(POOLS.sports),
  dojo: byTier(POOLS.dojo),
};

/** `pool` split into tiers by word length, in pool order; throws at load on a word of no tier. */
function byTier(pool: readonly string[]): Record<Tier, readonly string[]> {
  const out: Record<Tier, string[]> = { easy: [], medium: [], hard: [], insane: [] };
  for (const w of pool) {
    const tier = tierOfLength(w.length);
    if (tier === null) throw new Error(`word pools: ${JSON.stringify(w)} has no tier (2–15 letters)`);
    out[tier].push(w);
  }
  return out;
}
```

4. Replace `MIXED`:

```ts
const MIXED = Object.fromEntries(ALL_TIERS.map((tier) => [tier, union(tier)])) as Record<Tier, readonly string[]>;
```

5. Replace `tierOfLength` and its comment:

```ts
/** Tier for a word length (easy 2–4, medium 5–7, hard 8–11, insane 12–15), or null when no tier fits. */
export function tierOfLength(len: number): Tier | null {
  if (len >= 2 && len <= 4) return 'easy';
  if (len >= 5 && len <= 7) return 'medium';
  if (len >= 8 && len <= 11) return 'hard';
  if (len >= 12 && len <= 15) return 'insane';
  return null;
}
```

`tierOfLength` and `byTier` are function declarations, so they are hoisted above the `PACKS` initialiser.

In `src/core/words/picker.ts`, update the `toOption` doc comment to "…of a tier length (2–15 letters)".

- [ ] **Step 6: Colour, pips and ring for insane**

`src/render/palette.ts`:
- Import `Surface, Tier` (unchanged).
- Change the header comment's "47 named colours" to "48 named colours".
- After `tierVermillion: '#D55E00',` add `tierPurple: '#CC79A7',`.
- Change `crowdPurple: '#7E5AA6',` to `crowdPurple: '#B06FA0', // also the insane tier's typed shade (TIER_TYPED)`.
- Make the two tier tables:

```ts
/** Word-tier colours (Okabe–Ito, spec §4.2): easy sky blue, medium yellow, hard vermillion, insane reddish purple. */
export const TIER_COLOR: Record<Tier, string> = {
  easy: PAL.tierSky,
  medium: PAL.tierYellow,
  hard: PAL.tierVermillion,
  insane: PAL.tierPurple,
};
```
```ts
export const TIER_TYPED: Record<Tier, string> = {
  easy: PAL.hardHi,
  medium: PAL.tierYellowTyped,
  hard: PAL.clay,
  insane: PAL.crowdPurple,
};
```

Extend the TIER_TYPED doc comment: "…clay for vermillion, the (re-tinted) crowd purple for insane."

`src/render/plates.ts`:
- `const PIPS: Record<Tier, number> = { easy: 1, medium: 2, hard: 3, insane: 4 };`
- Replace `drawPips`:

```ts
/**
 * The tier's pips in the 2 px pip column: 1–3 square 2×2 pips, or for insane 4 bars of 2×1 so the
 * column (7 px) stays clear of the tier outline; 1 px apart, centred on the letter cells.
 */
function drawPips(ctx: CanvasRenderingContext2D, tier: Tier, x: number, y: number, s: 1 | 2, color: string): void {
  const n = PIPS[tier];
  const pipH = n > 3 ? 1 : 2;
  const step = pipH + 1;
  const top = CELL_Y + Math.floor((FONT.cellH - (step * n - 1)) / 2);
  for (let i = 0; i < n; i++) rect(ctx, x + PIP_X * s, y + (top + step * i) * s, 2 * s, pipH * s, color);
}
```

- Add to `RING_ART` (and extend its doc comment with "insane 8-point burst"):

```ts
  // Eight separate rays (vertical, horizontal and diagonal) around an open centre: never the 4-point star.
  insane: [
    '..#...#...#..',
    '...#..#..#...',
    '.............',
    '###.......###',
    '.............',
    '...#..#..#...',
    '..#...#...#..',
  ],
```

- Add `insane: ringShape(RING_ART.insane),` to `RINGS`.
- Update the `drawPlate` doc comment "1/2/3 tier pips" → "1/2/3/4 tier pips".

`tools/art/rings.ts`: `const TIERS: readonly Tier[] = ['easy', 'medium', 'hard', 'insane'];` and `const LEADER_DX = [-6, 0, 6, 12];`. In `marksCanvas`, change `(t - 1) * RING_GAP` to `(t - 1.5) * RING_GAP` so four rings stay centred in the column.

- [ ] **Step 7: Update the Training word that became insane**

`src/game/training.ts:29`: `['lamp', 'cheese', 'thunderstorm'],` → `['lamp', 'cheese', 'typewriter'],`. *typewriter* is 10 letters, is in the Everyday pool, and its initial `t` is not adjacent to `l` or `c`.

- [ ] **Step 8: Record the colour deviation in the spec**

In `docs/superpowers/specs/2026-09-27-power-meter-and-rally-pacing-design.md` §6, replace the **Colour** bullet with:

```md
- **Colour**: insane uses Okabe–Ito reddish purple `#CC79A7`; its typed shade is the crowd purple,
  re-tinted to `#B06FA0` (the palette's 48-colour cap). Tests: ≥ 4.5:1 on the fill, typed shade ≤ 1/1.8
  of the remaining letters' luminance, and CIEDE2000 ≥ 20 from every other tier in normal vision and
  ≥ 12 under each colour-vision deficiency. Measured: 14.1 from sky under protan, 15.5 under deutan,
  14.0 from vermillion under tritan. Only near-white or grey reach ≥ 20 there, and they vanish on the
  court lines the insane rings sit beside. Insane is never shown by colour alone.
```

- [ ] **Step 9: Run the tests and the typecheck**

Run: `npx vitest run tests/core/words.test.ts tests/core/shot.test.ts tests/core/trajectory.test.ts tests/render/palette.test.ts tests/render/plates.test.ts tests/game/training.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS. Any remaining error is a `Record<Tier, …>` missing `insane`; add the entry with the values above.

- [ ] **Step 10: Run the full suite and fix the fallout**

Run: `npm test`
Expected: PASS. If a test fails only because a fixture word changed tier under the new bands (a 5-letter word is now medium, 8–9 letters now hard, 12+ now insane), replace the fixture word with one of the intended tier under the new bands. Change nothing else.

- [ ] **Step 11: Commit**

```bash
git add -A src/core src/game/training.ts src/render tools/art/rings.ts tests docs/superpowers/specs
git commit -F - <<'EOF'
feat(core): insane tier, 2–4 / 5–7 / 8–11 / 12–15 length bands and one word pool per pack

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 2: A gentler rally speed-up with a floor

**Files:**
- Modify: `src/core/tuning.ts:24-33` (flight)
- Modify: `src/core/shot.ts:6-12`
- Test: `tests/core/shot.test.ts:97-110,154-159`

**Interfaces:**
- Produces: `TUNING.flight.pressure` (0.93) and `TUNING.flight.pressureFloor` (0.65). `flightTimeMs` and `displayKmh` use `P(n) = max(floor, pressure^⌊n/2⌋)`.

- [ ] **Step 1: Write the failing tests**

Replace the two pressure tests in `tests/core/shot.test.ts` with versions that read the constants, so Task 14's retuning never breaks them:

```ts
  it('rally: pace·(2200 + 100·len)/v · place · P(n)', () => {
    const p = TUNING.flight.pressure;
    expect(flightTimeMs({ pace: 1, chaseLen: 8, v: 1, tier: 'medium', isServe: false, n: 3 })).toBeCloseTo(3000 * 0.85 * p, 9);
    expect(flightTimeMs({ pace: 0.6, chaseLen: 5, v: 1.25, tier: 'hard', isServe: false, n: 0 })).toBeCloseTo(907.2, 9);
  });

  it('applies pressure once per two rally strikes (⌊n/2⌋) and never below the floor', () => {
    const { pressure: p, pressureFloor: floor } = TUNING.flight;
    const at = (n: number): number => flightTimeMs({ pace: 1, chaseLen: 3, v: 1, tier: 'easy', isServe: false, n });
    expect(at(0)).toBeCloseTo(2500, 9);
    expect(at(1)).toBeCloseTo(2500, 9);
    expect(at(2)).toBeCloseTo(2500 * p, 9);
    expect(at(4)).toBeCloseTo(2500 * p * p, 9);
    expect(at(5)).toBeCloseTo(2500 * p * p, 9);
    expect(at(200)).toBeCloseTo(2500 * floor, 9);
    for (let n = 0; n <= 60; n++) expect(at(n + 1)).toBeLessThanOrEqual(at(n));
  });

  it('keeps the pressure constants sane: 0 < floor < 1, floor < pressure < 1', () => {
    const { pressure, pressureFloor } = TUNING.flight;
    expect(pressureFloor).toBeGreaterThan(0);
    expect(pressureFloor).toBeLessThan(pressure);
    expect(pressure).toBeLessThan(1);
  });
```

Replace `displayKmh › divides by 0.85^⌊n/2⌋`:

```ts
  it('divides by P(n) so deeper rallies read faster, up to the floor', () => {
    const { pressure: p, pressureFloor: floor } = TUNING.flight;
    expect(displayKmh(1, 'easy', 1, false)).toBe(95);
    expect(displayKmh(1, 'easy', 2, false)).toBe(Math.round(95 / p));
    expect(displayKmh(1, 'easy', 4, false)).toBe(Math.round(95 / (p * p)));
    expect(displayKmh(1, 'easy', 200, false)).toBe(Math.round(95 / floor));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/core/shot.test.ts`
Expected: FAIL (`TUNING.flight.pressureFloor` is undefined; `at(2)` is 2125, not 2325).

- [ ] **Step 3: Implement**

In `src/core/tuning.ts`, replace `pressure: 0.85,` with:

```ts
    // Rally pressure P(n) = max(pressureFloor, pressure^⌊n/2⌋) (power-meter spec §2; was 0.85 with no
    // floor): a gentler speed-up with a floor, so rallies run longer and hard words stay playable deep
    // into a rally. Final values: balance simulation (tests/sim/balance.test.ts).
    pressure: 0.93,
    pressureFloor: 0.65,
```

In `src/core/shot.ts`, replace `pressureFactor`:

```ts
/**
 * Rally pressure P(n) = max(pressureFloor, pressure^⌊n/2⌋) (power-meter spec §2), the power by repeated
 * multiplication (not Math.pow), so every JS engine gets identical bits.
 */
function pressureFactor(n: number): number {
  const { pressure, pressureFloor } = TUNING.flight;
  const steps = Math.floor(n / 2);
  let f = 1;
  for (let i = 0; i < steps && f > pressureFloor; i++) f *= pressure;
  return Math.max(pressureFloor, f);
}
```

Update the two doc comments that mention `0.85^⌊n/2⌋` (`flightTimeMs`, `displayKmh`) to say `P(n)`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/core/shot.test.ts && npm test`
Expected: PASS. If a core or net test pinned an exact outcome (a rally length or T) that the new pressure changes, update the pinned value and note it in the commit message. Invariants such as determinism and latency invariance must still hold unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/core/tuning.ts src/core/shot.ts tests
git commit -F - <<'EOF'
feat(core): gentler rally pressure (0.93 per two strikes) with a 0.65 floor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 3: Insane targets

**Files:**
- Modify: `src/core/court.ts` (after `rallyTargets`)
- Test: `tests/core/court.test.ts`

**Interfaces:**
- Produces:
  - `insaneServeTarget(receiver: PlayerId, side: Side, variant: 'T' | 'wide'): Vec2`
  - `insaneRallyTarget(dest: PlayerId, m: 1 | -1): Vec2`

- [ ] **Step 1: Write the failing tests**

Append to `tests/core/court.test.ts` (import `insaneRallyTarget, insaneServeTarget, inServiceBox, inSinglesHalf, COURT, endSign` as needed):

```ts
describe('insane targets (power-meter spec §4.3)', () => {
  it('serve: on medium\'s half of the box, 0.15 m inside the side or centre line and the service line', () => {
    expect(insaneServeTarget(1, 'deuce', 'T')).toEqual({ x: -3.965, y: 6.25 });
    expect(insaneServeTarget(1, 'deuce', 'wide')).toEqual({ x: -0.15, y: 6.25 });
    for (const receiver of [0, 1] as const) {
      for (const side of ['deuce', 'ad'] as const) {
        for (const variant of ['T', 'wide'] as const) {
          const t = insaneServeTarget(receiver, side, variant);
          const [, medium] = serveTargets(receiver, side, variant);
          expect(inServiceBox(t, receiver, side)).toBe(true);
          expect(Math.sign(t.x)).toBe(Math.sign(medium!.x));
          const a = Math.abs(t.x);
          expect(Math.min(a, COURT.singlesHalfWidth - a)).toBeCloseTo(0.15, 9);
          expect(COURT.serviceLine - Math.abs(t.y)).toBeCloseTo(0.15, 9);
        }
      }
    }
  });

  it('rally: the deep corner on medium\'s side, 0.15 m inside the sideline and the baseline', () => {
    expect(insaneRallyTarget(1, 1)).toEqual({ x: -3.965, y: 11.735 });
    for (const dest of [0, 1] as const) {
      for (const m of [1, -1] as const) {
        const t = insaneRallyTarget(dest, m);
        const [, medium, hard] = rallyTargets(dest, m);
        expect(inSinglesHalf(t, dest)).toBe(true);
        expect(Math.sign(t.x)).toBe(Math.sign(medium!.x));
        expect(Math.sign(t.x)).toBe(-Math.sign(hard!.x));
        expect(COURT.singlesHalfWidth - Math.abs(t.x)).toBeCloseTo(0.15, 9);
        expect(COURT.halfLength - Math.abs(t.y)).toBeCloseTo(0.15, 9);
      }
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/core/court.test.ts`
Expected: FAIL ("insaneServeTarget is not a function").

- [ ] **Step 3: Implement**

In `src/core/court.ts`, below `RALLY_HARD`:

```ts
/** Box coordinates of the insane serve target, keyed by the hard target's variant (power-meter spec §4.3). */
const SERVE_INSANE = { T: { a: 3.965, b: 6.25 }, wide: { a: 0.15, b: 6.25 } };
/** Half coordinates of the insane rally target for m = +1: medium's side, 0.15 m inside both lines. */
const RALLY_INSANE = { a: 3.965, b: 11.735 };
```

Below `rallyTargets`:

```ts
/** The insane serve target in `receiver`'s box for `side`: the corner on medium's half (power-meter spec §4.3). */
export function insaneServeTarget(receiver: PlayerId, side: Side, variant: 'T' | 'wide'): Vec2 {
  const s = endSign(receiver);
  const { a, b } = SERVE_INSANE[variant];
  return halfPoint(s, s * sideSign(side), a, b);
}

/** The insane rally target on `dest`'s half: the deep corner on medium's side `m` (power-meter spec §4.3). */
export function insaneRallyTarget(dest: PlayerId, m: 1 | -1): Vec2 {
  const s = endSign(dest);
  return halfPoint(s, s, m * RALLY_INSANE.a, RALLY_INSANE.b);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/core/court.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/court.ts tests/core/court.test.ts
git commit -F - <<'EOF'
feat(core): insane serve and rally targets, 0.15 m inside the lines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 4: The picker draws 3 or 4 words

**Files:**
- Modify: `src/core/words/picker.ts:40-87`
- Modify: `src/core/engine.ts:34,323,355` (rename call sites only)
- Test: `tests/core/words.test.ts`

**Interfaces:**
- Consumes: `ALL_TIERS`, `TIERS` (Task 1)
- Produces: `pickSet(rng: RngState, picker: PickerState, pack: WordPackId, avoid?: readonly string[], insane?: boolean): WordOption[]`. It returns 3 options, or 4 when `insane`, in tier order. `pickTriple` is removed.

- [ ] **Step 1: Rename in the tests and add the 4-word tests**

In `tests/core/words.test.ts`, replace every `pickTriple` with `pickSet` (import included). Then add, next to the other picker tests:

```ts
describe('pickSet with the insane option (power-meter spec §4.2)', () => {
  it('returns [easy, medium, hard, insane] with pairwise distinct, non-adjacent initials, recording all four', () => {
    for (const pack of PACK_IDS) {
      for (let seed = 1; seed <= 300; seed++) {
        const picker = createPicker();
        const options = pickSet(seedRng(seed), picker, pack, [], true);
        expect(options.map((o) => o.tier), `${pack} ${seed}`).toEqual(ALL_TIERS);
        expect(initialsClash(wordsOf(options)), `${pack} ${seed}`).toBe(false);
        expect(picker.history).toEqual(wordsOf(options));
      }
    }
  });

  it('keeps the avoid list and the 20-word history for all four words', () => {
    const rng = seedRng(9);
    const picker = createPicker();
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      const recent = seen.slice(-HISTORY);
      const words = wordsOf(pickSet(rng, picker, 'everyday', [], true));
      expect(words.filter((w) => recent.includes(w)), `pick ${i}`).toEqual([]);
      seen.push(...words);
    }
    const avoid = wordsOf(pickSet(seedRng(3), createPicker(), 'sports', [], true));
    for (let seed = 0; seed < 50; seed++) {
      const words = wordsOf(pickSet(seedRng(seed), createPicker(), 'sports', avoid, true));
      expect(words.filter((w) => avoid.includes(w))).toEqual([]);
    }
  });

  it('draws exactly as a 3-word pick when insane is off', () => {
    const a = pickSet(seedRng(77), createPicker(), 'mixed', ['cat']);
    const b = pickSet(seedRng(77), createPicker(), 'mixed', ['cat'], false);
    expect(b).toEqual(a);
    expect(a).toHaveLength(3);
  });
});
```

If the history test's 40 picks ever trigger the relaxation fallback, the assertion is still correct: the fallback relaxes the history rule only for that pick. If it fails for that reason, lower the loop to 20 picks and note why in a comment.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/core/words.test.ts`
Expected: FAIL ("pickSet is not exported").

- [ ] **Step 3: Implement**

In `src/core/words/picker.ts`:
- Import `ALL_TIERS, TIERS` from `'../types'`.
- Replace `pickTriple`, `sampleTriple` and `searchTriple`:

```ts
/**
 * One word per tier satisfying all rules: easy, medium and hard, plus insane when `insane` (a full
 * power meter, power-meter spec §4.2); records every word in history. `avoid` = words that must not
 * appear (previous toss). Rejection-samples up to MAX_ATTEMPTS sets with every rule; if none passes,
 * relaxes the history rule for this pick only (the initials and `avoid` rules always hold) and
 * searches exhaustively, so it never loops unboundedly. With `insane` off the draws are exactly
 * those of a 3-word pick. Throws only if no set can satisfy those two rules.
 */
export function pickSet(
  rng: RngState,
  picker: PickerState,
  pack: WordPackId,
  avoid: readonly string[] = [],
  insane = false,
): WordOption[] {
  const lists = (insane ? ALL_TIERS : TIERS).map((tier) => packWords(pack, tier));
  const words =
    sampleSet(rng, lists, new Set([...picker.history, ...avoid])) ??
    searchSet(rng, lists.map((list) => list.filter((w) => !avoid.includes(w))));
  if (words === null) throw new Error(`pickSet: no ${pack} set satisfies the avoid and initials rules`);
  picker.history.push(...words);
  picker.history.splice(0, Math.max(0, picker.history.length - TUNING.words.historySize));
  return words.map(toOption);
}
```

Rename `sampleTriple` → `sampleSet` and `searchTriple` → `searchSet` (bodies unchanged). Update their doc comments from "triple" to "set".

In `src/core/engine.ts`, update the import and both calls from `pickTriple` to `pickSet`. The arguments are unchanged for now; Task 7 passes `insane`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/core/words.test.ts && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/words/picker.ts src/core/engine.ts tests/core/words.test.ts
git commit -F - <<'EOF'
feat(core): pickSet draws an insane fourth word on request, same draws without it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 5: Meter rules, state fields and protocol v2

**Files:**
- Create: `src/core/power.ts`
- Modify: `src/core/types.ts` (ServeTurnData, ReturnTurnData, MatchState, GameEvent)
- Modify: `src/core/tuning.ts` (add `power`)
- Modify: `src/core/engine.ts:78-96` (state literal, `power` in both turn data literals)
- Modify: `src/game/guestSession.ts:443-462` (`waitingState`)
- Modify: `src/net/protocol.ts:6-7,129-137`
- Test: `tests/core/power.test.ts` (new), `tests/net/protocol.test.ts`, `tests/core/turnFixtures.ts`, and the state and turn-data literals the typecheck lists

**Interfaces:**
- Consumes: `TIERS` (Task 1)
- Produces:
  - `TUNING.power.max` (4); `POWER_MAX: number`
  - `insaneOffered(level: number | null): boolean`
  - `levelFromKeys(t: TurnState, τ: number): number | null`
  - `levelAfterStrike(level: number, slips: number): number`
  - `powerAt(t: TurnState, τ: number): number | null`
  - `choiceOptions(t: TurnState, d: ReturnTurnData, τ: number): WordOption[]`
  - `ServeTurnData.power: number | null`, `ReturnTurnData.power: number | null`
  - `MatchState.v: 2`, `MatchState.power: [number, number]`
  - `GameEvent` `{ type: 'power'; player: PlayerId; from: number; to: number }`
  - `PROTO = 2`
- Fixtures: `serveData()` and `returnData()` default `power: 0`

- [ ] **Step 1: Write the failing tests**

Create `tests/core/power.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { choiceOptions, insaneOffered, levelAfterStrike, levelFromKeys, POWER_MAX, powerAt } from '../../src/core/power';
import { createTurn } from '../../src/core/turn';
import { TUNING } from '../../src/core/tuning';
import type { StrikeInfo, TurnLogEntry, TurnState } from '../../src/core/types';
import { CHOICE, INSANE_WORD, opt, returnData } from './turnFixtures';

const bad = (τ: number): TurnLogEntry => ({ τ, k: 'bad', prompt: 48, ch: 'z' });

/** A return turn with meter level `power` at its start, log `log` and, optionally, a strike at τ with `slips`. */
function turn(power: number | null, log: TurnLogEntry[] = [], strike?: { τ: number; slips: number }): TurnState {
  const t = createTurn(returnData({ power }));
  t.log = log;
  if (strike) t.outcome = { kind: 'strike', endτ: strike.τ, strike: { τ: strike.τ, slips: strike.slips } as StrikeInfo };
  return t;
}

describe('power meter rules (power-meter spec §4.1)', () => {
  it('fills to 4', () => {
    expect(TUNING.power.max).toBe(4);
    expect(POWER_MAX).toBe(4);
  });

  it('offers insane only at a full, switched-on meter', () => {
    expect(insaneOffered(null)).toBe(false);
    expect(insaneOffered(3)).toBe(false);
    expect(insaneOffered(4)).toBe(true);
  });

  it('keeps the start level until the first wrong key, then 0; null when the meter is off', () => {
    const t = turn(3, [bad(500), bad(900)]);
    expect(levelFromKeys(t, 499)).toBe(3);
    expect(levelFromKeys(t, 500)).toBe(0);
    expect(levelFromKeys(t, 10_000)).toBe(0);
    expect(levelFromKeys(turn(null, [bad(1)]), 5)).toBeNull();
  });

  it('adds one for a flawless strike, capped at 4; a slipped strike adds nothing', () => {
    expect(levelAfterStrike(0, 0)).toBe(1);
    expect(levelAfterStrike(3, 0)).toBe(4);
    expect(levelAfterStrike(4, 0)).toBe(4);
    expect(levelAfterStrike(2, 1)).toBe(2);
  });

  it('powerAt: the fill lands at the strike τ; a chase slip then a flawless shot leaves 1', () => {
    const clean = turn(2, [], { τ: 3000, slips: 0 });
    expect(powerAt(clean, 2999)).toBe(2);
    expect(powerAt(clean, 3000)).toBe(3);
    const slipped = turn(4, [bad(200)], { τ: 3000, slips: 0 });
    expect(powerAt(slipped, 100)).toBe(4);
    expect(powerAt(slipped, 200)).toBe(0);
    expect(powerAt(slipped, 3000)).toBe(1);
    expect(powerAt(turn(null, [], { τ: 10, slips: 0 }), 20)).toBeNull();
  });

  it('choiceOptions: the insane word stays only while no wrong key has emptied the meter', () => {
    const d = returnData({ power: 4, choice: { options: [...CHOICE, INSANE_WORD].map(opt), targets: [], m: 1 } });
    const t = createTurn(d);
    expect(choiceOptions(t, t.data as typeof d, 400).map((o) => o.word)).toEqual([...CHOICE, INSANE_WORD]);
    t.log = [bad(150)];
    expect(choiceOptions(t, t.data as typeof d, 400).map((o) => o.word)).toEqual(CHOICE);
  });
});
```

In `tests/net/protocol.test.ts`, change the `publicState()` literal to `v: 2` and add `power: [1, 4],` after `longestRally`. Then add to the parse tests (next to the other `frame` validity tests):

```ts
describe('frame states and the power meter (PROTO 2)', () => {
  /** A frame carrying state `s`, as it arrives on the wire (JSON text, decoded by decodeMsg). */
  const frame = (s: unknown): string => JSON.stringify({ type: 'frame', turn: 11, τ: 900, s });

  it('accepts a v2 state and keeps its meter levels', () => {
    const m = decodeMsg(frame(publicState()));
    expect(m?.type === 'frame' && m.s?.power).toEqual([1, 4]);
  });

  it('clamps levels to 0–4 and rejects a missing, non-array or non-finite meter, and a v1 state', () => {
    const clamped = decodeMsg(frame({ ...publicState(), power: [-3, 9] }));
    expect(clamped?.type === 'frame' && clamped.s?.power).toEqual([0, 4]);
    for (const power of [undefined, null, 3, [1], [1, 'x'], [1, NaN]]) {
      expect(decodeMsg(frame({ ...publicState(), power })), JSON.stringify(power)).toBeNull();
    }
    expect(decodeMsg(frame({ ...publicState(), v: 1 }))).toBeNull();
  });

  it('is protocol version 2', () => {
    expect(PROTO).toBe(2);
  });
});
```

Import `decodeMsg` and `PROTO` from `'../../src/net/protocol'` if the file doesn't already. On the wire, `JSON.stringify` turns `NaN` into `null` and drops an `undefined` field, so those cases arrive as `[1, null]` and "missing".

In `tests/core/turnFixtures.ts`:
- Import `insaneRallyTarget, insaneServeTarget` from court.
- Replace `serveSet`:

```ts
export const serveSet = (
  words: string[],
  variant: 'T' | 'wide' = 'T',
  receiver: PlayerId = 1,
  side: Side = 'deuce',
): ServeWordSet => ({
  options: words.map(opt),
  targets: [...serveTargets(receiver, side, variant), insaneServeTarget(receiver, side, variant)].slice(0, words.length),
  variant,
});
```

- Add `power: 0,` to both `serveData` and `returnData` literals, before `...over`.
- Add:

```ts
/** An insane word (14 letters; initial p, clear of CHOICE's d, v, c) for 4-option prompts. */
export const INSANE_WORD = 'photosynthesis';

/** `returnData`'s choice with the insane option a full meter pre-picks (targets for m = +1 on player 0's half). */
export const CHOICE_4: ReturnTurnData['choice'] = {
  options: [...CHOICE, INSANE_WORD].map(opt),
  targets: [...rallyTargets(0, 1), insaneRallyTarget(0, 1)],
  m: 1,
};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/core/power.test.ts tests/net/protocol.test.ts`
Expected: FAIL ("Cannot find module '../../src/core/power'", PROTO is 1).

- [ ] **Step 3: Types and tuning**

In `src/core/tuning.ts`, after `words: { historySize: 20 },` add:

```ts
  // Power meter (power-meter spec §4.1): flawless serve/choice strikes fill it to `max`; a full meter offers the insane word.
  power: { max: 4 },
```

In `src/core/types.ts`:
- In `ServeTurnData`, after `freezeFirst`: `power: number | null;    // owner's meter level when the turn was created; null = meter off (training)`
- The same line in `ReturnTurnData`.
- Update `ServeWordSet.options` and `.targets` comments to `// [easy, medium, hard] or [easy, medium, hard, insane] at a full meter` and `// world coords, same order`.
- In `ReturnTurnData`, update `choice`'s comment line: `choice: { options: WordOption[]; targets: Vec2[]; m: 1 | -1 }; // 3 options, or 4 (insane last) at a full meter`.
- `MatchState`: `v: 2;` and, after `longestRally: number;`, add `power: [number, number];      // each player's meter level 0..max (power-meter spec §4.1)`.
- `GameEvent`: after the `strike` member add `| { type: 'power'; player: PlayerId; from: number; to: number }   // a meter level changed (power-meter spec §4.4)`.
- `PromptState.options` comment: `// chase: 1; serve/choice: 3 or 4 in tier order easy, medium, hard[, insane]`.

- [ ] **Step 4: Create `src/core/power.ts`**

```ts
import { TUNING } from './tuning';
import { TIERS, type ReturnTurnData, type TurnState, type WordOption } from './types';

/** A full power meter (power-meter spec §4.1). */
export const POWER_MAX: number = TUNING.power.max;

/** True when a meter level offers the insane option: the meter is on and full (power-meter spec §4.2). */
export function insaneOffered(level: number | null): boolean {
  return level !== null && level >= POWER_MAX;
}

/**
 * The turn owner's meter level at τ from its keys alone: the start level until the first wrong key
 * at or before τ, then 0 (power-meter spec §4.1). Null when the meter is off (training). Reads only
 * the log's 'bad' entries, never letters, so it works on redacted turns.
 */
export function levelFromKeys(t: TurnState, τ: number): number | null {
  const start = t.data.power;
  if (start === null) return null;
  for (const e of t.log) {
    if (e.τ > τ) break;
    if (e.k === 'bad') return 0;
  }
  return start;
}

/** The level after a strike whose word had `slips` slips: one more (capped) when flawless, else unchanged. */
export function levelAfterStrike(level: number, slips: number): number {
  return slips === 0 ? Math.min(POWER_MAX, level + 1) : level;
}

/**
 * The turn owner's meter level at τ (power-meter spec §4.1): `levelFromKeys`, plus one for a flawless
 * strike at or before τ. A turn that ends without a strike (a fault, a miss, a cancelling OUT/NET
 * call) never fills the meter. Null when the meter is off.
 */
export function powerAt(t: TurnState, τ: number): number | null {
  const level = levelFromKeys(t, τ);
  if (level === null) return null;
  const o = t.outcome;
  return o?.kind === 'strike' && o.strike.τ <= τ ? levelAfterStrike(level, o.strike.slips) : level;
}

/**
 * The choice prompt's options when it is shown at τ (power-meter spec §4.2): every pre-picked option
 * while the meter is still full, else the first three (a wrong key in the chase emptied it).
 */
export function choiceOptions(t: TurnState, d: ReturnTurnData, τ: number): WordOption[] {
  return insaneOffered(levelFromKeys(t, τ)) ? d.choice.options : d.choice.options.slice(0, TIERS.length);
}
```

- [ ] **Step 5: Fill in the literals the types now require**

In `src/core/engine.ts`:
- The constructor's state gets `v: 2,` and `power: [0, 0],` after `longestRally: 0,`.
- In `serveTurn` and `returnTurn`, add `power: this.meterFor(owner),` after `freezeFirst`.
- Add this method next to `freezes`:

```ts
  /** The owner's meter level for a new turn's start data, or null in training (meter off, power-meter spec §4.1). */
  private meterFor(owner: PlayerId): number | null {
    const { config, power } = this.state;
    return config.training !== null ? null : power[owner];
  }
```

In `src/game/guestSession.ts` `waitingState`: `v: 2,` and `power: [0, 0],` after `longestRally: 0,`.

Run `npm run typecheck`. Every remaining error is either a `MatchState` literal missing `power` or on `v: 1`, or a `ServeTurnData`/`ReturnTurnData` literal missing `power`. In tests (`tests/render/hud.test.ts`, `players.test.ts`, `prompts.test.ts`, `renderer.test.ts`, `tests/core/cpu.test.ts`, `engine.test.ts`, `turn.test.ts`, `turnView.test.ts`), set `v: 2` and add `power: [0, 0]` to state literals, and add `power: 0` to turn-data literals.

- [ ] **Step 6: Protocol v2**

In `src/net/protocol.ts`: `export const PROTO = 2;`. In `parseState`, change `v.v !== 1` to `v.v !== 2`. After the players check, add:

```ts
  const power = parsePower(v.power);
  if (power === null) return null;
  return { ...(v as unknown as PublicState), players: [p0, p1], power };
```

replacing the old `return`. Add:

```ts
/** Both meter levels: two finite numbers, clamped to 0..POWER_MAX (power-meter spec §5). */
function parsePower(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => isNum(n))) return null;
  const clampLevel = (n: number): number => Math.min(POWER_MAX, Math.max(0, n));
  return [clampLevel(v[0] as number), clampLevel(v[1] as number)];
}
```

Import `POWER_MAX` from `'../core/power'`. The file's `isNum` already requires a finite number.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/core/power.test.ts tests/net/protocol.test.ts && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A src tests
git commit -F - <<'EOF'
feat(core): power meter rules module, meter fields in state and turn data, protocol v2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 6: The turn runner offers insane, emits `power` events, and the view reports the level

**Files:**
- Modify: `src/core/turn.ts` (`letter`, `completed`, `playStrike`)
- Modify: `src/core/turnView.ts` (`TurnView.power`)
- Test: `tests/core/turn.test.ts`, `tests/core/turnView.test.ts`

**Interfaces:**
- Consumes: `levelFromKeys`, `levelAfterStrike`, `choiceOptions`, `powerAt` (Task 5); fixtures `CHOICE_4`, `INSANE_WORD`, `serveSet` (Task 5)
- Produces:
  - `power` events: at a wrong key that empties a non-empty meter, and at a strike that fills it. Event order at a strike: `strike`, `power`, `turnEnd`.
  - A choice prompt shows 4 options only while no wrong key has emptied the meter.
  - `TurnView.power: number | null`

- [ ] **Step 1: Write the failing tests**

Append to `tests/core/turn.test.ts` (imports: `createTurn, startTurn, turnInput, turnClock` from turn; `redactTurn` from redact; `returnData, serveData, serveSet, SET_A, SET_B, CHOICE_4, INSANE_WORD, RALLY_OUT` from fixtures; `GameEvent, TurnState` types):

```ts
describe('power meter in the turn runner (power-meter spec §4)', () => {
  const typeAt = (t: TurnState, word: string, from: number, gap = 100): GameEvent[] =>
    [...word].flatMap((ch, i) => turnInput(t, ch, from + i * gap));
  const powerEvents = (events: GameEvent[]) => events.filter((e) => e.type === 'power');

  it('a full meter and a clean chase: the choice shows 4 options, and the insane word strikes at its target', () => {
    const t = createTurn(returnData({ power: 4, choice: CHOICE_4 }));
    startTurn(t);
    typeAt(t, 'ball', 100);
    expect(t.prompts[1]!.options.map((o) => o.word)).toEqual(CHOICE_4.options.map((o) => o.word));
    const events = typeAt(t, INSANE_WORD, 600);
    events.push(...turnClock(t, 3000));
    expect(t.outcome?.kind).toBe('strike');
    if (t.outcome?.kind !== 'strike') return;
    expect(t.outcome.strike.word.tier).toBe('insane');
    expect(t.outcome.strike.target).toEqual(CHOICE_4.targets[3]);
    expect(powerEvents(events)).toEqual([]); // 4 stays 4
  });

  it('a wrong key in the chase empties the meter at once and the choice shows 3 options', () => {
    const t = createTurn(returnData({ power: 4, choice: CHOICE_4 }));
    startTurn(t);
    const events = typeAt(t, 'bzall', 100);
    expect(powerEvents(events)).toEqual([{ turn: 8, τ: 200, type: 'power', player: 1, from: 4, to: 0 }]);
    expect(t.prompts[1]!.options).toHaveLength(3);
  });

  it('a flawless queued choice fills the meter by one at contact, after the strike event', () => {
    const t = createTurn(returnData({ power: 2 }));
    startTurn(t);
    const events = [...typeAt(t, 'ball', 100), ...typeAt(t, 'drop', 600), ...turnClock(t, 3000)];
    const types = events.filter((e) => ['strike', 'power', 'turnEnd'].includes(e.type)).map((e) => e.type);
    expect(types).toEqual(['strike', 'power', 'turnEnd']);
    expect(powerEvents(events)).toEqual([{ turn: 8, τ: 3000, type: 'power', player: 1, from: 2, to: 3 }]);
  });

  it('an OUT call cancels the turn: no fill, but a wrong key before it still empties the meter', () => {
    const clean = createTurn(returnData({ power: 2, incoming: RALLY_OUT }));
    startTurn(clean);
    const cleanEvents = [...typeAt(clean, 'ball', 100), ...typeAt(clean, 'drop', 600), ...turnClock(clean, 3500)];
    expect(clean.outcome?.kind).toBe('call');
    expect(powerEvents(cleanEvents)).toEqual([]);
    const slipped = createTurn(returnData({ power: 2, incoming: RALLY_OUT }));
    startTurn(slipped);
    const slipEvents = [...typeAt(slipped, 'bzall', 100), ...turnClock(slipped, 3500)];
    expect(powerEvents(slipEvents)).toEqual([{ turn: 8, τ: 200, type: 'power', player: 1, from: 2, to: 0 }]);
  });

  it('a full-meter serve offers 4 words; the insane word strikes at the insane box target', () => {
    const t = createTurn(serveData({ power: 4, wordSets: [serveSet([...SET_A, 'quarterfinalist']), serveSet([...SET_B, INSANE_WORD], 'wide')] }));
    startTurn(t);
    turnInput(t, 'toss', 2600);
    expect(t.prompts[0]!.options).toHaveLength(4);
    typeAt(t, 'quarterfinalist', 2700);
    expect(t.outcome?.kind).toBe('strike');
    if (t.outcome?.kind !== 'strike') return;
    expect(t.outcome.strike.target).toEqual(t.data.kind === 'serve' ? t.data.wordSets[0]!.targets[3] : null);
  });

  it('a slip in a serve word empties the meter but the serve still strikes', () => {
    const t = createTurn(serveData({ power: 3 }));
    startTurn(t);
    turnInput(t, 'toss', 2600);
    const events = typeAt(t, 'bzall', 2700);
    expect(powerEvents(events)).toEqual([{ turn: 7, τ: 2800, type: 'power', player: 0, from: 3, to: 0 }]);
    expect(t.outcome?.kind).toBe('strike');
  });

  it('with the meter off (training) there are no power events', () => {
    const t = createTurn(returnData({ power: null }));
    startTurn(t);
    const events = [...typeAt(t, 'bzall', 100), ...typeAt(t, 'drop', 700), ...turnClock(t, 3000)];
    expect(powerEvents(events)).toEqual([]);
    expect(t.prompts[1]!.options).toHaveLength(3);
  });
});
```

*bzall* types `b`, then `z` (wrong, at 100 + 1·100 = 200), then `a l l`, so the chase completes at 500. *drop* is CHOICE option 0. `RALLY_OUT` is called at its bounce, 0.6 × 3000 = 1800.

Append to `tests/core/turnView.test.ts`:

```ts
describe('TurnView.power (power-meter spec §6)', () => {
  it('matches powerAt at every τ, on the owner\'s turn and on the redacted copy the other player sees', () => {
    const t = createTurn(returnData({ power: 3, choice: CHOICE_4 }));
    startTurn(t);
    [...'bzall'].forEach((ch, i) => turnInput(t, ch, 100 + 100 * i));
    [...'drop'].forEach((ch, i) => turnInput(t, ch, 700 + 100 * i));
    turnClock(t, 3000);
    const other = redactTurn(t, 0);
    for (const τ of [0, 199, 200, 1000, 2999, 3000]) {
      expect(turnViewAt(t, τ).power, `τ ${τ}`).toBe(powerAt(t, τ));
      expect(turnViewAt(other, τ).power, `redacted τ ${τ}`).toBe(powerAt(t, τ));
    }
    expect(turnViewAt(t, 3000).power).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/core/turn.test.ts tests/core/turnView.test.ts`
Expected: FAIL (the choice shows 4 options after a slip, there are no `power` events, and `TurnView.power` is undefined).

- [ ] **Step 3: Implement in `src/core/turn.ts`**

Import `choiceOptions, levelAfterStrike, levelFromKeys` from `'./power'`.

In `letter`, replace the `'wrong'` branch:

```ts
  if (result === 'wrong') {
    const before = levelFromKeys(t, τ);
    t.log.push({ τ, k: 'bad', prompt: p.id, ch });
    emit(t, out, τ, { type: 'keyBad', player, prompt: p.id });
    if (before !== null && before > 0) emit(t, out, τ, { type: 'power', player, from: before, to: 0 });
    return;
  }
```

In `completed`, change `showPrompt(t, 'choice', d.choice.options, τ, out);` to `showPrompt(t, 'choice', choiceOptions(t, d, τ), τ, out);`.

Replace `playStrike`:

```ts
function playStrike(t: TurnState, s: StrikeInfo, out: GameEvent[]): void {
  const { player, word, kmh, isServe, stretch, forehand } = s;
  emit(t, out, s.τ, { type: 'strike', player, word: word.word, tier: word.tier, kmh, isServe, stretch, forehand });
  const from = levelFromKeys(t, s.τ);
  const to = from === null ? null : levelAfterStrike(from, s.slips);
  if (from !== null && to !== null && to !== from) emit(t, out, s.τ, { type: 'power', player, from, to });
  endTurn(t, { kind: 'strike', endτ: s.τ, strike: s }, out);
}
```

- [ ] **Step 4: Implement in `src/core/turnView.ts`**

Import `powerAt` from `'./power'`. Add `power: number | null;  // the owner's meter level at τ (power-meter spec §6); null = meter off` to `TurnView`, and `power: powerAt(t, τ),` to the returned object in `turnViewAt`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/core/turn.test.ts tests/core/turnView.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/turn.ts src/core/turnView.ts tests/core
git commit -F - <<'EOF'
feat(core): the turn runner shows insane at a full meter and emits power events; TurnView.power

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 7: The engine picks insane words, commits levels and empties a point's loser

**Files:**
- Modify: `src/core/engine.ts` (`endTurn`, `point`, `serveTurn`, `returnTurn`, `addSpareSet`, `serveSet`)
- Test: `tests/core/engine.test.ts`

**Interfaces:**
- Consumes: `pickSet` (Task 4), `insaneServeTarget`, `insaneRallyTarget` (Task 3), `insaneOffered`, `powerAt` (Task 5), `meterFor` (Task 5)
- Produces:
  - `state.power[owner]` = `powerAt(turn, endτ)` at every turn end.
  - `point()` empties the loser's level and emits `power` (stamped at the ended turn's end τ) after the `point` event.
  - Turn start data at a full meter carries 4 options and 4 targets.

- [ ] **Step 1: Write the failing tests**

Append to `tests/core/engine.test.ts` (imports: `ALL_TIERS` from types; `initialsOk` from picker; `Driver, scripted, CONFIG, PLAYERS, config, type Typist` from engineHelpers; `Engine`):

```ts
describe('power meter in the engine (power-meter spec §4)', () => {
  it('commits the owner\'s level at each turn end: 1 after a flawless serve, 0 after a slipped one', () => {
    const clean = new Engine({ config: CONFIG, players: PLAYERS, seed: 3 });
    const server = clean.owner()!;
    new Driver(clean, [scripted(), scripted()]).playTurn();
    expect(clean.state.power[server]).toBe(1);
    const sloppy = new Engine({ config: CONFIG, players: PLAYERS, seed: 3 });
    new Driver(sloppy, [scripted({ slips: 1 }), scripted({ slips: 1 })]).playTurn();
    expect(sloppy.state.power[server]).toBe(0);
  });

  it('a player at a full meter gets a 4-word set: tiers in order, valid initials, a target each', () => {
    const engine = new Engine({ config: CONFIG, players: PLAYERS, seed: 5 });
    new Driver(engine, [scripted(), scripted()]).playUntil((s) => s.turn !== null && s.turn.data.power === 4);
    const d = engine.state.turn!.data;
    expect(engine.state.power[d.owner]).toBe(4);
    const sets = d.kind === 'serve' ? d.wordSets : [d.choice];
    for (const set of sets) {
      expect(set.options.map((o) => o.tier)).toEqual(ALL_TIERS);
      expect(set.targets).toHaveLength(4);
      expect(initialsOk(set.options.map((o) => o.word))).toBe(true);
    }
  });

  it('losing a point empties the loser\'s meter, with a power event after the point event', () => {
    const engine = new Engine({ config: CONFIG, players: PLAYERS, seed: 11 });
    const flawless = scripted();
    const quitsWhenFull: Typist = (t) => (engine.state.power[1] === 4 ? [] : flawless(t));
    const driver = new Driver(engine, [scripted(), quitsWhenFull]);
    driver.playUntil((s) => s.power[1] === 4);
    driver.playUntil((s) => s.power[1] === 0);
    const i = driver.events.findIndex((e) => e.type === 'power' && e.player === 1 && e.from === 4 && e.to === 0);
    expect(i).toBeGreaterThan(0);
    const point = driver.events[i - 1]!;
    expect(point.type).toBe('point');
    expect(point.type === 'point' && point.winner).toBe(0);
    expect(driver.events[i]!.τ).toBe(point.τ);
  });

  it('training: the meter stays off (null in turn data, [0, 0] in state), with no power events', () => {
    const training = { serveClock: false, freezeUntilFirstKey: false, fixedWords: null };
    const engine = new Engine({ config: config({ training }), players: PLAYERS, seed: 4 });
    const driver = new Driver(engine, [scripted(), scripted()]);
    for (let i = 0; i < 12; i++) {
      expect(engine.state.turn?.data.power).toBeNull();
      driver.playTurn();
    }
    expect(engine.state.power).toEqual([0, 0]);
    expect(driver.events.filter((e) => e.type === 'power')).toEqual([]);
  });
});
```

The default `scripted()` typist serves and returns flawless easy words 150 ms apart. That fits every flight time, even at the pressure floor, so the second test's rally runs until a turn starts at a full meter.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/core/engine.test.ts`
Expected: FAIL (`state.power` stays `[0, 0]` and no 4-word sets are drawn).

- [ ] **Step 3: Implement**

In `src/core/engine.ts`:
- Import `insaneRallyTarget, insaneServeTarget, rallyTargets, serveTargets` from court and `insaneOffered, powerAt` from `'./power'`.

In `endTurn`, after `this.seenKinds()[t.data.owner] = [...t.seenKinds];`:

```ts
    const level = powerAt(t, outcome.endτ);
    if (level !== null) s.power[t.data.owner] = level;
```

In `point`, after `const events = [at({ type: 'point', winner, reason })];`:

```ts
    const loser = other(winner);
    const lost = s.power[loser];
    if (s.config.training === null && lost > 0) {
      s.power[loser] = 0;
      events.push(at({ type: 'power', player: loser, from: lost, to: 0 }));
    }
```

`serveTurn`:

```ts
    const power = this.meterFor(owner);
    const insane = insaneOffered(power);
    const first = this.serveSet(receiver, side, [], insane);
    const spare = this.serveSet(receiver, side, words(first.options), insane);
```

Pass `power` in the data (it replaces the `this.meterFor(owner)` placeholder from Task 5).

`addSpareSet`: `appendWordSet(t, this.serveSet(d.receiver, d.side, avoid, insaneOffered(d.power)));`

`serveSet`:

```ts
  /** One toss's serve words (none of `avoid`) with their targets in the receiver's box; 4 words at a full meter. */
  private serveSet(receiver: PlayerId, side: Side, avoid: string[], insane: boolean): ServeWordSet {
    const { config } = this.state;
    const fixed = config.training?.fixedWords ?? null;
    const options =
      fixed !== null
        ? pickFixed(this.picker(), fixed.serve, 'serve')
        : pickSet(this.rng(), this.picker(), config.wordPack, avoid, insane);
    const variant = uniform(this.rng()) < 0.5 ? 'T' : 'wide';
    const targets = serveTargets(receiver, side, variant);
    if (options.length > TIERS.length) targets.push(insaneServeTarget(receiver, side, variant));
    return { options, targets, variant };
  }
```

`returnTurn`:

```ts
    const owner = other(strike.player);
    const power = this.meterFor(owner);
    const options =
      fixed !== null
        ? pickFixed(this.picker(), fixed.choice, 'choice')
        : pickSet(this.rng(), this.picker(), config.wordPack, [strike.word.word], insaneOffered(power));
    const m = uniform(this.rng()) < 0.5 ? 1 : -1;
    const targets = rallyTargets(strike.player, m);
    if (options.length > TIERS.length) targets.push(insaneRallyTarget(strike.player, m));
```

Move `const owner = other(strike.player);` above the pick, set `choice: { options, targets, m }`, and add `power` to the data.

Update the class doc's "Match-RNG draw order" line to: "…per serve turn its two word sets (3 words, or 4 at a full meter, then T/wide) and its randoms; per return turn its choice words (3 or 4), m and its randoms; per catch one spare set."

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/core/engine.test.ts && npm test`
Expected: PASS. The engine's replay-determinism tests must pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts tests/core/engine.test.ts
git commit -F - <<'EOF'
feat(core): the engine draws insane words at a full meter, commits levels, empties a point's loser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 8: Online — the scoreboard snapshot carries the meter; insane secrecy and play are exercised

**Files:**
- Modify: `src/game/onlineLink.ts:402-416` (`Scoreboards`)
- Test: `tests/game/onlineSmoke.test.ts:847-877`, `tests/core/redact.test.ts`, `tests/net/sessions.test.ts:156-173`

**Interfaces:**
- Consumes: `MatchState.power` (Task 5), 4-option sets (Task 7)
- Produces: `Scoreboards.note()` snapshots `power` with the score.

- [ ] **Step 1: Write the failing tests**

In `tests/game/onlineSmoke.test.ts`, in the `Scoreboards` test, after `state.rallyStrikes = 5;` add `state.power = [3, 4];`. After `expect(pub.rallyStrikes).toBe(0);` add:

```ts
    // The power meters wait for the display too, so a lost point never empties a meter early.
    expect(pub.power).toEqual([0, 0]);
```

After `expect(latest.status).toBe('over');` add `expect(latest.power).toEqual([3, 4]);`.

Append to `tests/core/redact.test.ts` (imports: `createTurn, startTurn, turnInput` from turn; `serveData, serveSet, SET_A, INSANE_WORD` from turnFixtures; `redactTurn`):

```ts
describe('redaction of a full-meter serve (power-meter spec §5)', () => {
  it('hides all four serve words and their targets from the receiver, keeps them for the server', () => {
    const t = createTurn(serveData({ power: 4, wordSets: [serveSet([...SET_A, INSANE_WORD])] }));
    startTurn(t);
    turnInput(t, 'toss', 2600);
    const seen = redactTurn(t, 1);
    expect(JSON.stringify(seen)).not.toContain(INSANE_WORD);
    if (seen.data.kind !== 'serve') throw new Error('expected a serve turn');
    expect(seen.data.wordSets[0]!.options.map((o) => ({ len: o.len, tier: o.tier, hidden: o.hidden }))).toEqual([
      { len: 4, tier: 'easy', hidden: true },
      { len: 6, tier: 'medium', hidden: true },
      { len: 10, tier: 'hard', hidden: true },
      { len: 14, tier: 'insane', hidden: true },
    ]);
    expect(seen.data.wordSets[0]!.targets).toEqual([]);
    expect(seen.prompts[0]!.options).toHaveLength(4);
    expect(JSON.stringify(redactTurn(t, 0))).toContain(INSANE_WORD);
  });
});
```

In `tests/core/redact.test.ts`, run the existing 1,000-serve secrecy test a second time with every meter full, as spec §8 asks ("across 1,000 simulated serves at level 4"):

1. Move the body of `it('across 1,000 serves by player 0, player 1 never sees a serve word before it is struck', …)` into `function checkServeSecrecy(fullMeter: boolean): void { … }`, placed inside the same `describe`.
2. At the top of the function, when `fullMeter` is true, force every new turn to start at a full meter:

```ts
    const spy = fullMeter
      ? vi.spyOn(Engine.prototype as unknown as { meterFor(owner: PlayerId): number | null }, 'meterFor').mockReturnValue(4)
      : null;
    let fourWordSets = 0;
```

3. Wrap the rest of the body in `try { … } finally { spy?.mockRestore(); }`.
4. In `check`, count sets: `for (const t of turns) if (t.data.kind === 'serve') fourWordSets += t.data.wordSets.filter((set) => set.options.length === 4).length;`.
5. At the end add `if (fullMeter) expect(fourWordSets).toBeGreaterThan(0);`.
6. Replace the test with two calls:

```ts
  it('across 1,000 serves by player 0, player 1 never sees a serve word before it is struck', { timeout: 600000 }, () =>
    checkServeSecrecy(false));
  it('the same across 1,000 serves at a full meter: all four words, insane included, stay hidden', { timeout: 600000 }, () =>
    checkServeSecrecy(true));
```

Import `vi` from vitest if the file doesn't already.

In `tests/net/sessions.test.ts`, in `three full short-set matches`, after the `for (const run of runs)` loop add:

```ts
    // The meter reaches 4 and the scripted typists hit insane words, so the 4-option path runs online.
    const insaneStrikes = runs.flatMap((run) => [...run.hostLog.turns.values()].filter((t) => t.strike?.option === 3));
    expect(insaneStrikes.length).toBeGreaterThan(0);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/game/onlineSmoke.test.ts tests/core/redact.test.ts`
Expected: FAIL: `pub.power` is `[3, 4]` because the snapshot doesn't hold it. The redact test already passes; it pins the behaviour.

- [ ] **Step 3: Implement**

In `src/game/onlineLink.ts` `Scoreboards.note`:

```ts
  /** `entry`'s turn was created in `state`: its scoreboard (score, stats, status, point, rally, meters) as it is now. */
  note(entry: DisplayEntry, state: MatchState): void {
    const { score, stats, status, pointNo, rallyStrikes, power } = state;
    this.of.set(entry, structuredClone({ score, stats, status, pointNo, rallyStrikes, power }));
  }
```

Update the `Scoreboard` type near the class (find it with `grep -n "type Scoreboard\|interface Scoreboard" src/game/onlineLink.ts`) to include `power: [number, number]`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/game/onlineSmoke.test.ts tests/core/redact.test.ts tests/net/sessions.test.ts`
Expected: PASS.

If `insaneStrikes` is 0, the default net typist (4 % errors per key) never kept four clean strikes long enough. Do not weaken the assertion. Add a fourth run with `hostTypist: { errorChance: 0.01 }, guestTypist: { errorChance: 0.01 }` to `shortSetRuns()` (the helper that builds the runs) and assert over all runs.

- [ ] **Step 5: Commit**

```bash
git add src/game/onlineLink.ts tests
git commit -F - <<'EOF'
feat(net): the displayed scoreboard snapshot carries the power meters; insane play and secrecy tested online

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 9: CPU and simulator choose among 3 or 4 options

**Files:**
- Modify: `src/core/cpu.ts:82,144-217,245-257,277-290`
- Modify: `src/core/sim.ts` (PointRecord, SimSummary, matchPoints, summarize)
- Test: `tests/core/cpu.test.ts`, `tests/sim/sim.test.ts`

**Interfaces:**
- Consumes: `levelFromKeys`, `insaneOffered` (Task 5); fixtures `CHOICE_4`, `INSANE_WORD`, `serveSet` (Task 5)
- Produces:
  - `CpuPolicy` adds `'neverInsane'`. `'neverHard'` now excludes hard and insane.
  - `PointRecord` adds `insaneClean: number`, `insaneReturned: number`, `insaneOffered: boolean`.
  - `SimSummary` adds `insaneShotsClean: number`, `insaneReturnRate: number` (0 with no clean shot), `fullMeterRate: number`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/core/cpu.test.ts` (imports: `CpuBrain`; `createTurn, startTurn, turnInput` from turn; `returnData, serveData, serveSet, SET_A, CHOICE_4, INSANE_WORD` from turnFixtures):

```ts
describe('CPU and the insane option (power-meter spec §5)', () => {
  const EXACT = { wpm: 120, err: 0, reactionMs: 300, aggression: 1 };

  /** The first key the plan types after the chase word's last correct letter: the chosen option's initial. */
  function choiceInitial(keys: { key: string }[], chase: string): string | undefined {
    let i = 0;
    let typed = 0;
    for (; i < keys.length && typed < chase.length; i++) if (keys[i]!.key === chase[typed]) typed++;
    return keys[i]?.key;
  }

  it('serves the insane word when it fits and aggression is 1', () => {
    const t = createTurn(serveData({ owner: 0, power: 4, wordSets: [serveSet([...SET_A, 'quarterfinalist'])] }));
    startTurn(t);
    turnInput(t, 'toss', 2600);
    const keys = new CpuBrain(0, EXACT, 1).plan(t);
    expect(keys.map((k) => k.key).join('')).toBe('quarterfinalist');
  });

  it('plans the insane word for a clean chase, and never after a planned wrong key in the chase', () => {
    const clean = createTurn(returnData({ power: 4, choice: CHOICE_4 }));
    startTurn(clean);
    expect(choiceInitial(new CpuBrain(1, EXACT, 1).plan(clean), 'ball')).toBe(INSANE_WORD[0]);
    for (let seed = 1; seed <= 20; seed++) {
      const t = createTurn(returnData({ power: 4, choice: CHOICE_4 }));
      startTurn(t);
      const keys = new CpuBrain(1, { ...EXACT, err: 0.99 }, seed).plan(t);
      expect(choiceInitial(keys, 'ball'), `seed ${seed}`).not.toBe(INSANE_WORD[0]);
    }
  });

  it('neverInsane never picks insane; neverHard picks neither hard nor insane', () => {
    for (const [policy, banned] of [['neverInsane', ['p']], ['neverHard', ['c', 'p']]] as const) {
      const t = createTurn(returnData({ power: 4, choice: CHOICE_4 }));
      startTurn(t);
      const initial = choiceInitial(new CpuBrain(1, EXACT, 1, { policy }).plan(t), 'ball');
      expect(banned, policy).not.toContain(initial);
    }
  });
});
```

CHOICE_4's initials are `d` (easy), `v` (medium), `c` (hard) and `p` (insane).

Append to `tests/sim/sim.test.ts`:

```ts
describe('insane metrics (power-meter spec §7)', () => {
  it('summarize: clean insane shots, the share returned, and the share of points offering insane', () => {
    const base = { shots: 3, ms: 1000, reason: 'winner' as const, serverWon: true, winner: 0 as const };
    const s = summarize([
      { ...base, insaneClean: 2, insaneReturned: 1, insaneOffered: true },
      { ...base, insaneClean: 1, insaneReturned: 0, insaneOffered: true },
      { ...base, insaneClean: 0, insaneReturned: 0, insaneOffered: false },
      { ...base, insaneClean: 0, insaneReturned: 0, insaneOffered: false },
    ]);
    expect(s.insaneShotsClean).toBe(3);
    expect(s.insaneReturnRate).toBeCloseTo(1 / 3, 12);
    expect(s.fullMeterRate).toBe(0.5);
    expect(summarize([{ ...base, insaneClean: 0, insaneReturned: 0, insaneOffered: false }]).insaneReturnRate).toBe(0);
  });

  it('fast, accurate equal players reach full meters and hit clean insane shots', () => {
    const points = simulatePoints({ config: CONFIG_NORMAL, typists: [humanTypist(120), humanTypist(120)], seed: 7, points: 400 });
    const s = summarize(points);
    expect(s.fullMeterRate).toBeGreaterThan(0);
    expect(s.insaneShotsClean).toBeGreaterThan(0);
  });
});
```

Use the file's existing Normal config constant, or define `const CONFIG_NORMAL: MatchConfig = { format: 'full', pace: 'normal', surface: 'hard', wordPack: 'everyday', deuceRule: 'advantage', training: null };`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/core/cpu.test.ts tests/sim/sim.test.ts`
Expected: FAIL (the CPU plans insane after a wrong key and stalls, `'neverInsane'` is not a policy, and the new summary fields are undefined).

- [ ] **Step 3: CPU**

In `src/core/cpu.ts`:
- Import `insaneOffered, levelFromKeys` from `'./power'` and `TIERS` from `'./types'`.
- `export type CpuPolicy = 'adaptive' | 'alwaysEasy' | 'alwaysHard' | 'neverHard' | 'neverInsane';` (doc line: "neverHard never picks hard or insane; neverInsane never picks insane").
- In `planReturn`, replace the choice-planning block:

```ts
    const choiceShownAt = choice?.shownAt ?? chaseKeys[chaseKeys.length - 1]?.τ;
    if (choiceShownAt === undefined) return chaseKeys;
    // A planned wrong key in the rest of the chase empties the meter, so the choice will show 3 options.
    const chaseClean = chaseKeys.length === d.chase.len - (chase?.typed ?? 0);
    const level = chaseClean ? levelFromKeys(t, t.τ) : 0;
    const options = choice?.options ?? (insaneOffered(level) ? d.choice.options : d.choice.options.slice(0, TIERS.length));
    const choicePlan = this.promptPlan(t, choice?.id ?? d.promptBase + 1, choiceShownAt, options.length, () => {
      const option = this.choose(options, d.incoming.T - Math.max(choiceShownAt, t.τ), this.profile.aggression);
      return this.newPlan(options, option, choiceShownAt, this.profile.reactionMs, t.τ);
    });
    return [...chaseKeys, ...this.rest(choicePlan, choice, t.τ)];
```

- `promptPlan` gains an `optionCount` parameter. A cached plan aimed past the shown options is replaced:

```ts
  private promptPlan(t: TurnState, id: number, shownAt: number, optionCount: number, make: () => PromptPlan): PromptPlan {
    const key = `${t.data.turnId}:${id}`;
    const cached = this.promptPlans.get(key);
    if (cached?.shownAt === shownAt && cached.option < optionCount) return cached;
    const plan = make();
    this.promptPlans.set(key, plan);
    return plan;
  }
```

Pass `prompt.options.length` from `planServe` and `1` for the chase plan. Update the doc comment: "…A plan made for another shownAt, or aimed at an option the prompt no longer offers, is replaced."

- In `choose`, replace the policy filter:

```ts
    const banned = (o: WordOption): boolean =>
      (this.policy === 'neverHard' && (o.tier === 'hard' || o.tier === 'insane')) ||
      (this.policy === 'neverInsane' && o.tier === 'insane');
    const fitting = options.flatMap((o, i) => (banned(o) || this.estimateMs(o.len) > budgetMs - CPU.safetyMs ? [] : [i]));
```

Update its doc comment: "options are in tier order easy, medium, hard[, insane]".

- In `typeWord`, hesitations: `if ((word.tier === 'hard' || word.tier === 'insane') && chance(rng, CPU.hesitation.chance))`.

- [ ] **Step 4: Simulator**

In `src/core/sim.ts`:
- Import `TIERS` from `'./types'`.
- Extend the interfaces:

```ts
export interface PointRecord {
  shots: number;
  ms: number;
  reason: PointReason;
  serverWon: boolean;
  winner: PlayerId;
  /** Clean insane strikes (no slip, landing in) in the point. */
  insaneClean: number;
  /** How many of those the receiver struck back in. */
  insaneReturned: number;
  /** Whether any serve or choice prompt of the point offered the insane word. */
  insaneOffered: boolean;
}
```

Add to `SimSummary`: `insaneShotsClean: number; insaneReturnRate: number; fullMeterRate: number;`, with the doc "insaneReturnRate = returned / clean (0 with none); fullMeterRate = share of points offering insane".

- In `matchPoints`, track the point's insane figures after each turn, before yielding:

```ts
  let insane = { clean: 0, returned: 0, offered: false, pending: false };
  // ... inside the turn loop, replacing the events loop:
    const events = playTurn(engine, brains[owner], owner);
    const ended = engine.state.lastTurn;
    if (ended !== null) {
      insane.offered ||= ended.prompts.some((p) => p.options.length > TIERS.length);
      const o = ended.outcome;
      if (insane.pending) {
        if (o?.kind === 'strike' && o.strike.shot.outcome === 'in') insane.returned++;
        insane.pending = false;
      }
      if (o?.kind === 'strike' && o.strike.word.tier === 'insane' && o.strike.slips === 0 && o.strike.shot.outcome === 'in') {
        insane.clean++;
        insane.pending = true;
      }
    }
    for (const e of events) {
      if (e.type === 'turnEnd') {
        ms += e.endτ;
      } else if (e.type === 'point') {
        yield { shots, ms, reason: e.reason, serverWon: e.winner === server, winner: e.winner,
          insaneClean: insane.clean, insaneReturned: insane.returned, insaneOffered: insane.offered };
        server = null;
        ms = 0;
        insane = { clean: 0, returned: 0, offered: false, pending: false };
      }
    }
```

- In `summarize`, add:

```ts
  const clean = points.reduce((sum, p) => sum + p.insaneClean, 0);
  const returned = points.reduce((sum, p) => sum + p.insaneReturned, 0);
```

and in the returned object: `insaneShotsClean: clean, insaneReturnRate: clean === 0 ? 0 : returned / clean, fullMeterRate: share((p) => p.insaneOffered),`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/core/cpu.test.ts tests/sim/sim.test.ts && npm test`
Expected: PASS. The balance smoke test (`tests/sim/balance.test.ts`, 300 points) checks that every summary value is finite, which holds because `insaneReturnRate` is 0 without clean shots.

- [ ] **Step 6: Commit**

```bash
git add src/core/cpu.ts src/core/sim.ts tests
git commit -F - <<'EOF'
feat(core): CPU and simulator choose among 3 or 4 options; neverInsane policy; insane metrics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 10: Plates for 4 options

**Files:**
- Modify: `src/render/layout.ts:14,47-67`
- Modify: `src/render/prompts.ts:99-103,308-335`
- Test: `tests/render/layout.test.ts`, `tests/render/prompts.test.ts`

**Interfaces:**
- Consumes: `CHOICE_4`, `INSANE_WORD` (Task 5), `insaneRallyTarget` (Task 3)
- Produces: `layoutChoice(lens, targetsScreenX, band)` accepts 3 or 4 entries. Four plates use slots 60 / 180 / 300 / 420, ordered by target screen x.

- [ ] **Step 1: Write the failing tests**

Append to `tests/render/layout.test.ts` (imports `layoutChoice, layoutServeNear, layoutServeFar, plateWidth, type PlateBox`):

```ts
describe('4-option plates (power-meter spec §6)', () => {
  const BANDS_ = ['far', 'near'] as const;
  const RANGE = { easy: [2, 4], medium: [5, 7], hard: [8, 11], insane: [12, 15] } as const;
  const lensGrid = (): number[][] => {
    const out: number[][] = [];
    for (let e = RANGE.easy[0]; e <= RANGE.easy[1]; e++)
      for (let m = RANGE.medium[0]; m <= RANGE.medium[1]; m++)
        for (let h = RANGE.hard[0]; h <= RANGE.hard[1]; h++)
          for (let i = RANGE.insane[0]; i <= RANGE.insane[1]; i++) out.push([e, m, h, i]);
    return out;
  };
  const overlap = (a: PlateBox, b: PlateBox): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const inside = (b: PlateBox): boolean => b.x >= 4 && b.x + b.w <= 476 && b.y >= 22 && b.y + b.h <= 266;
  /** Target screen x for [easy, medium, hard, insane]: medium and insane on one side, insane outermost. */
  const XS = { left: [240, 150, 340, 110], right: [240, 330, 140, 370] };

  it('puts the four plates in slots 60 / 180 / 300 / 420 by target x: insane outermost on medium\'s side', () => {
    const lens = [3, 6, 10, 14];
    const centre = (b: PlateBox): number => b.x + (b.w - 1) / 2;
    const left = layoutChoice(lens, XS.left, 'far');
    expect(left.map((b) => Math.round(centre(b)))).toEqual([300, 180, 420, 60]);
    const right = layoutChoice(lens, XS.right, 'far');
    expect(right.map((b) => Math.round(centre(b)))).toEqual([180, 300, 60, 420]);
  });

  it('never overlaps and stays inside x 4–476, y 22–266 for every length in each tier\'s band', () => {
    const bad: string[] = [];
    for (const lens of lensGrid()) {
      for (const band of BANDS_) {
        for (const xs of [XS.left, XS.right]) {
          const boxes = layoutChoice(lens, xs, band);
          boxes.forEach((a, i) => {
            if (!inside(a)) bad.push(`${lens} ${band} option ${i} outside`);
            boxes.slice(i + 1).forEach((b) => overlap(a, b) && bad.push(`${lens} ${band} ${a.option}/${b.option}`));
          });
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('serve stacks and rows of 4 stay inside, never overlap, keep clear of the toss column, and the widest plate is 101 px', () => {
    expect(plateWidth(15)).toBe(101);
    const bad: string[] = [];
    for (const lens of lensGrid()) {
      const near = layoutServeNear(lens, 262, 200);
      const far = layoutServeFar(lens, 251);
      for (const boxes of [near, far]) {
        boxes.forEach((a, i) => {
          if (!inside(a)) bad.push(`${lens} option ${i} outside`);
          boxes.slice(i + 1).forEach((b) => overlap(a, b) && bad.push(`${lens} ${a.option}/${b.option}`));
        });
      }
      // Near server right of centre: the stack goes left, its inner edge ≥ 10 px from the head.
      for (const b of near) if (b.x + b.w > 252) bad.push(`${lens} near option ${b.option} in the toss column`);
      // Far server: every plate ends ≥ 12 px left of it or starts ≥ 12 px right of it.
      for (const b of far) if (!(b.x + b.w <= 239 || b.x >= 263)) bad.push(`${lens} far option ${b.option} in the toss gap`);
    }
    expect(bad).toEqual([]);
  });

  it('rejects 2 or 5 options, or mismatched target counts', () => {
    expect(() => layoutChoice([3, 6], [240, 150], 'far')).toThrow(/3 or 4/);
    expect(() => layoutChoice([3, 6, 10, 14, 5], [1, 2, 3, 4, 5], 'far')).toThrow(/3 or 4/);
    expect(() => layoutChoice([3, 6, 10, 14], [240, 150, 340], 'far')).toThrow(/3 or 4/);
  });
});
```

Then update the existing layout test that expects the old error text ("needs 3 word lengths") to match `/3 or 4/`.

Append to `tests/render/prompts.test.ts` (imports: `CHOICE_4, INSANE_WORD` from turnFixtures):

```ts
describe('promptScene with the insane option (power-meter spec §6)', () => {
  /** Player 1's return at a full meter, `chase` typed from 100 ms, 100 ms apart. */
  function fullMeterReturn(chase: string): TurnState {
    const t = createTurn(returnData({ power: 4, choice: CHOICE_4 }));
    startTurn(t);
    typeWord(t, chase, 100);
    return t;
  }

  it('shows 4 choice rings and leaders while the meter is full', () => {
    const s = scene(view({ ...matchState(fullMeterReturn('ball')), power: [0, 4] }, 600, 1));
    expect(s.rings.map((r) => r.tier)).toEqual(['easy', 'medium', 'hard', 'insane']);
    expect(s.leaders).toHaveLength(4);
  });

  it('after a chase slip shows 3, though 4 targets were pre-picked', () => {
    const s = scene(view({ ...matchState(fullMeterReturn('bzall')), power: [0, 4] }, 700, 1));
    expect(s.rings.map((r) => r.tier)).toEqual(['easy', 'medium', 'hard']);
    expect(s.leaders).toHaveLength(3);
  });

  it('Large words: a locked insane word at 2× (14 letters: 190 px) stays inside x 4–476', () => {
    const t = fullMeterReturn('ball');
    typeWord(t, 'ph', 600);
    const s = scene(view({ ...matchState(t), power: [0, 4] }, 800, 1), { ...PREFS, largeWords: true });
    const big = s.plates.filter((p: PlateDraw) => p.scale === 2);
    expect(big).toHaveLength(1);
    expect(big[0]!.box.w).toBe(190);
    expect(big[0]!.box.x).toBeGreaterThanOrEqual(4);
    expect(big[0]!.box.x + big[0]!.box.w).toBeLessThanOrEqual(476);
  });
});
```

If `PromptScene` names its arrays differently (check with `grep -n "export interface PromptScene" -A 12 src/render/prompts.ts`), use its names.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/render/layout.test.ts tests/render/prompts.test.ts`
Expected: FAIL (`layoutChoice needs 3 word lengths…` is thrown).

- [ ] **Step 3: Implement `layoutChoice`**

In `src/render/layout.ts`, below `SLOT_X`:

```ts
/** Slot centres of a 4-plate choice row (power-meter spec §6), left to right. */
const SLOTS_4 = [60, 180, 300, 420] as const;
```

Replace `layoutChoice`:

```ts
/**
 * Choice plates (spec §4.2, power-meter spec §6) for `lens` in option order, [easy, medium, hard] or
 * [easy, medium, hard, insane]: one 1× row in the band of the targeted half (far: the far prompt band;
 * near: 6 px below the net line). Three plates: slot centres x 90 / 240 / 390, easy in the centre,
 * medium in the outer slot on its target's side of the hard target, hard in the other. Four plates:
 * slot centres x 60 / 180 / 300 / 420, taken in the order of the targets' screen x, so insane is
 * outermost on medium's side. Throws unless both arrays hold 3 or 4 entries, the same number.
 */
export function layoutChoice(lens: number[], targetsScreenX: number[], band: 'far' | 'near'): PlateBox[] {
  const n = lens.length;
  if ((n !== 3 && n !== 4) || targetsScreenX.length !== n) {
    throw new Error(
      `layoutChoice needs 3 or 4 word lengths and as many target x values, got ${lens.length} and ${targetsScreenX.length}`,
    );
  }
  const y = band === 'far' ? BANDS.far[0] : Math.round(netScreenY() + NEAR_BAND_GAP);
  const slots = n === 3 ? threeSlots(targetsScreenX) : fourSlots(targetsScreenX);
  return lens.map((len, option) => {
    const w = plateWidth(len);
    return { x: centredX(slots[option]!, w), y, w, h: PLATE_H, option };
  });
}

/** Slot centres for [easy, medium, hard]: easy central, medium on its target's side of hard. */
function threeSlots(targetsScreenX: number[]): number[] {
  const [, mediumX, hardX] = targetsScreenX as [number, number, number];
  const mediumLeft = mediumX <= hardX;
  return [SLOT_X.centre, mediumLeft ? SLOT_X.left : SLOT_X.right, mediumLeft ? SLOT_X.right : SLOT_X.left];
}

/** Slot centres for four options: `SLOTS_4` handed out left to right in the order of their targets' screen x. */
function fourSlots(targetsScreenX: number[]): number[] {
  const order = targetsScreenX.map((x, option) => ({ x, option })).sort((a, b) => a.x - b.x || a.option - b.option);
  const slots: number[] = [];
  order.forEach(({ option }, k) => {
    slots[option] = SLOTS_4[k]!;
  });
  return slots;
}
```

- [ ] **Step 4: Implement the prompt renderer changes**

In `src/render/prompts.ts`, below `HINT_X`:

```ts
/** The same for a 4-plate choice row (slot centres 60 / 180 / 300 / 420): the gaps of the outer pairs. */
const HINT_X4 = [120, 360] as const;
```

In `choicePlates`, change `const targets = d.choice.targets.map((p) => groundAt(f, p));` to:

```ts
  // A full meter pre-picks 4 targets; a chase slip leaves the prompt showing only the first 3.
  const targets = d.choice.targets.slice(0, choice.options.length).map((p) => groundAt(f, p));
```

In the same function, change `const [left, right] = HINT_X;` to `const [left, right] = choice.options.length === 4 ? HINT_X4 : HINT_X;`. Update the doc comment of `servePrompts`: "the three serve words" → "the serve words (3, or 4 at a full meter)".

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/render/layout.test.ts tests/render/prompts.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render/layout.ts src/render/prompts.ts tests/render
git commit -F - <<'EOF'
feat(render): 4-option choice row (slots 60/180/300/420); plates follow the options actually shown

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 11: The HUD power meter

**Files:**
- Modify: `src/render/hud.ts` (constants, `meterLevels`, `meterRects`, `Hud.draw`)
- Modify: `src/render/renderer.ts:76` (pass the clock)
- Test: `tests/render/hud.test.ts`

**Interfaces:**
- Consumes: `POWER_MAX` (Task 5), `TurnView.power` (Task 6), `TIER_COLOR.insane`, `TIER_TYPED.insane` (Task 1)
- Produces:
  - `meterLevels(f: WorldFrame): [number, number] | null`
  - `meterRects(levels: [number, number], clockMs: number, steady: boolean): MeterRect[]`
  - `Hud.draw(ctx, f, prefs, clockMs = 0)`

- [ ] **Step 1: Write the failing tests**

Append to `tests/render/hud.test.ts` (imports `meterLevels, meterRects` from hud; `TIER_COLOR, TIER_TYPED, OUTLINE, PAL` from palette; `WorldFrame` type):

```ts
describe('power meter (power-meter spec §6)', () => {
  const frame = (over: { training?: boolean; power?: [number, number]; owner?: 0 | 1; live?: number | null }): WorldFrame =>
    ({
      pub: { config: { training: over.training ? {} : null }, power: over.power ?? [0, 0] },
      turn: over.owner === undefined ? null : { data: { owner: over.owner } },
      view: over.owner === undefined ? null : { power: over.live ?? null },
    }) as unknown as WorldFrame;

  it('shows each player\'s committed level, the turn owner\'s live level, and nothing in training', () => {
    expect(meterLevels(frame({ power: [2, 4] }))).toEqual([2, 4]);
    expect(meterLevels(frame({ power: [4, 1], owner: 0, live: 0 }))).toEqual([0, 1]);
    expect(meterLevels(frame({ power: [3, 1], owner: 1, live: 2 }))).toEqual([3, 2]);
    expect(meterLevels(frame({ training: true, power: [0, 0] }))).toBeNull();
  });

  it('paints a backing strip and four 3×5 segments per row inside the HUD band, x ≤ 170', () => {
    const rects = meterRects([2, 4], 0, false);
    expect(rects).toHaveLength(10);
    for (const r of rects) {
      expect(r.x + r.w - 1).toBeLessThanOrEqual(170);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y + r.h - 1).toBeLessThanOrEqual(21);
    }
    const [strip0, ...rest] = rects;
    expect(strip0!.color).toBe(OUTLINE);
    const row0 = rest.slice(0, 4);
    expect(row0.map((r) => [r.w, r.h])).toEqual([[3, 5], [3, 5], [3, 5], [3, 5]]);
    expect(row0.map((r) => r.color)).toEqual([TIER_COLOR.insane, TIER_COLOR.insane, PAL.slate, PAL.slate]);
  });

  it('pulses a full meter every 400 ms unless Reduce effects keeps it steady', () => {
    const lit = (clockMs: number, steady: boolean): string => meterRects([0, 4], clockMs, steady)[6]!.color;
    expect(lit(0, false)).toBe(TIER_COLOR.insane);
    expect(lit(400, false)).toBe(TIER_TYPED.insane);
    expect(lit(800, false)).toBe(TIER_COLOR.insane);
    expect(lit(400, true)).toBe(TIER_COLOR.insane);
  });
});
```

`rects[6]` is row 1's first segment: row 0 has a strip and 4 segments (indices 0–4), row 1's strip is index 5.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/render/hud.test.ts`
Expected: FAIL ("meterLevels is not exported").

- [ ] **Step 3: Implement**

In `src/render/hud.ts`, import `POWER_MAX` from `'../core/power'` and `TIER_COLOR, TIER_TYPED` from `'./palette'`. Below `BOARD`:

```ts
/** Power meters (power-meter spec §6): four 3×5 segments, 1 px apart, right of each scoreboard row; full ones pulse every 400 ms. */
const METER = { x: BOARD.x + BOARD.w + 3, dy: 2, segW: 3, segH: 5, gap: 1, pulseMs: 400 };

/** One rectangle of the HUD power meters, in buffer pixels. */
export interface MeterRect { x: number; y: number; w: number; h: number; color: string }

/**
 * Both players' meter levels as shown this frame: the committed `pub.power`, with the turn owner's
 * live level at the displayed τ (a slip empties it at once), or null in training (meter off).
 */
export function meterLevels(f: WorldFrame): [number, number] | null {
  if (f.pub.config.training !== null) return null;
  const levels: [number, number] = [f.pub.power[0], f.pub.power[1]];
  const owner = f.turn?.data.owner;
  const live = f.view?.power ?? null;
  if (owner !== undefined && live !== null) levels[owner] = live;
  return levels;
}

/**
 * The meters' rectangles, row by row: a dark backing strip, then lit segments in the insane colour
 * (alternating with its typed shade every 400 ms at a full meter, unless `steady`) and unlit ones in slate.
 */
export function meterRects(levels: [number, number], clockMs: number, steady: boolean): MeterRect[] {
  const out: MeterRect[] = [];
  const stripW = POWER_MAX * METER.segW + (POWER_MAX - 1) * METER.gap + 2;
  levels.forEach((level, row) => {
    const top = BOARD.y + 1 + row * BOARD.row + METER.dy;
    out.push({ x: METER.x - 1, y: top - 1, w: stripW, h: METER.segH + 2, color: OUTLINE });
    const pulse = level >= POWER_MAX && !steady && Math.floor(clockMs / METER.pulseMs) % 2 === 1;
    const lit = pulse ? TIER_TYPED.insane : TIER_COLOR.insane;
    for (let k = 0; k < POWER_MAX; k++) {
      const x = METER.x + k * (METER.segW + METER.gap);
      out.push({ x, y: top, w: METER.segW, h: METER.segH, color: k < level ? lit : PAL.slate });
    }
  });
  return out;
}
```

In `Hud.draw`, change the signature to `draw(ctx: CanvasRenderingContext2D, f: WorldFrame, prefs: DisplayPrefs, clockMs = 0): void`. Replace `else drawScoreboard(ctx, f.pub);` with:

```ts
    else {
      drawScoreboard(ctx, f.pub);
      const levels = meterLevels(f);
      if (levels) for (const r of meterRects(levels, clockMs, prefs.reduceEffects)) rect(ctx, r.x, r.y, r.w, r.h, r.color);
    }
```

Add "power meters" to the class doc comment's list.

In `src/render/renderer.ts:76`: `this.hud.draw(g, f, prefs, this.clockMs);`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/render/hud.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/hud.ts src/render/renderer.ts tests/render/hud.test.ts
git commit -F - <<'EOF'
feat(render): HUD power meters beside the scoreboard, live for the turn owner, pulsing when full

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 12: Insane ball trail and the meter and insane sounds

**Files:**
- Modify: `src/render/ball.ts` (BallView, `flightBall`, `drawBall`)
- Modify: `src/render/world.ts:78-86,171,175` (WorldActors.hotTrail)
- Modify: `src/render/renderer.ts:71`
- Modify: `src/audio/sfx.ts` (names, voices)
- Modify: `src/audio/director.ts` (strike, power)
- Test: `tests/render/renderer.test.ts` (or a new `tests/render/ball.test.ts`), `tests/audio/director.test.ts`, `tests/audio/engine.test.ts`

**Interfaces:**
- Consumes: `TIER_COLOR.insane` (Task 1), `POWER_MAX` (Task 5), the `power` event (Task 5)
- Produces:
  - `flightBall(flight: BallFlight, t: number, alpha: number): BallView` (exported; was the private `inFlight`)
  - `BallView` `air` gains `hot: boolean`
  - `WorldActors.hotTrail: boolean`
  - `SfxName` gains `'powerUp' | 'powerDown'`

- [ ] **Step 1: Write the failing tests**

Create `tests/render/ball.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { flightBall } from '../../src/render/ball';
import { flight } from '../core/turnFixtures';

describe('the insane ball trail (power-meter spec §6)', () => {
  it('marks an insane flight hot with a 4-sample trail; other tiers keep 2 samples', () => {
    const hot = flightBall(flight({ tier: 'insane' }), 500, 1);
    expect(hot.kind === 'air' && hot.hot).toBe(true);
    expect(hot.kind === 'air' && hot.trail).toHaveLength(4);
    const plain = flightBall(flight({ tier: 'medium' }), 500, 1);
    expect(plain.kind === 'air' && plain.hot).toBe(false);
    expect(plain.kind === 'air' && plain.trail).toHaveLength(2);
  });
});
```

In `tests/audio/director.test.ts`, widen the helper to `const strike = (tier: Tier): EventBody => ({ ... })` (import `Tier`) and add:

```ts
describe('AudioDirector power meter and insane sounds (power-meter spec §6)', () => {
  const power = (player: PlayerId, from: number, to: number): EventBody => ({ type: 'power', player, from, to });

  it('an insane strike hits hard and draws the crowd\'s "ooh"', () => {
    director.onEvents([ev(strike('insane'))], context());
    expect(engine.names()).toEqual(['hitHard', 'ooh']);
  });

  it('plays powerUp when a meter fills and powerDown when a full one empties; other changes are silent', () => {
    director.onEvents([ev(power(0, 3, 4)), ev(power(0, 4, 0)), ev(power(0, 2, 0)), ev(power(0, 1, 2))], context());
    expect(engine.names()).toEqual(['powerUp', 'powerDown']);
  });

  it('plays the opponent\'s meter cues quieter', () => {
    director.onEvents([ev(power(1, 3, 4))], context({ viewer: 0 }));
    expect(engine.plays).toEqual([{ name: 'powerUp', opts: { gain: 0.6 } }]);
  });
});
```

In `tests/audio/engine.test.ts`, if a test lists every `SfxName` (check with `grep -n "SFX_NAMES\|'coin'" tests/audio/engine.test.ts`), add `'powerUp', 'powerDown'` to its expected list.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/render/ball.test.ts tests/audio`
Expected: FAIL ("flightBall is not exported"; no `powerUp`).

- [ ] **Step 3: Ball trail**

In `src/render/ball.ts`, import `TIER_COLOR` from `'./palette'`. Then:

```ts
/** The insane trail: more samples, drawn in the insane colour at falling opacity (power-meter spec §6). */
const HOT_TRAIL_SAMPLES = 4;
const HOT_TRAIL_ALPHA = [0.7, 0.5, 0.3, 0.15];
```

Change the `air` member of `BallView` to `| { kind: 'air'; pos: Vec3; alpha: number; trail: Vec3[]; hot: boolean };`. Replace `inFlight` with the exported:

```ts
/** The ball `t` ms along `flight` (height capped), with its trail: 4 hot samples for an insane shot, else 2. */
export function flightBall(flight: BallFlight, t: number, alpha: number): BallView {
  const hot = flight.tier === 'insane';
  const trail: Vec3[] = [];
  for (let i = 1; i <= (hot ? HOT_TRAIL_SAMPLES : TRAIL_SAMPLES); i++) trail.push(capped(ballAt(flight, t - i * TRAIL_STEP_MS)));
  return { kind: 'air', pos: capped(ballAt(flight, t)), alpha, trail, hot };
}
```

Rename the two `inFlight(` calls to `flightBall(`. Give the other `air` view (the toss ball, around line 67) `hot: false`.

In `drawBall`, add a parameter `hotTrail = false` and replace the trail loop:

```ts
  if (ball.kind === 'air') {
    const hot = ball.hot && hotTrail;
    ball.trail.forEach((p, i) => {
      const s = project(p, viewer);
      if (!hot && Math.hypot(s.x - at.x, s.y - at.y) < TRAIL_MIN_PX * (i + 1)) return;
      ctx.globalAlpha = ball.alpha * (hot ? (HOT_TRAIL_ALPHA[i] ?? 0.15) : i === 0 ? 0.5 : 0.25);
      ctx.fillStyle = hot ? TIER_COLOR.insane : i === 0 ? PAL.ball : PAL.ballShade;
      const size = hot ? 3 : 3 - i;
      ctx.fillRect(Math.round(s.x) - 1, Math.round(s.y) - 1, size, size);
    });
    ctx.globalAlpha = ball.alpha;
  }
```

Update the `drawBall` doc: "…with its motion trail when fast, or a purple trail for an insane shot when `hotTrail` (Reduce effects off)".

In `src/render/world.ts`, add `hotTrail: boolean;` to `WorldActors`. Pass `a.hotTrail` as the 5th argument in both `drawBall(` calls. In `src/render/renderer.ts:71`, add `hotTrail: !prefs.reduceEffects` to the `drawWorld` actors. Fix any other `drawWorld` caller the typecheck lists (art tools) with `hotTrail: true`.

- [ ] **Step 4: Sounds**

In `src/audio/sfx.ts`, add `| 'powerUp' | 'powerDown'` to `SfxName` and `'powerUp', 'powerDown'` to `SFX_NAMES`. Add the voices:

```ts
/** Power meter full: a rising three-note arpeggio (C6, E6, G6), 70 ms apart. */
function powerUp(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  [1047, 1319, 1568].forEach((hz, i) => {
    const at = t + i * 0.07;
    tone(ctx, envelope(ctx, out, at, 0.18, 0.005, 0.18), 'triangle', at, 0.2, hz);
  });
}

/** Power meter lost: a soft falling sweep, 600 → 200 Hz over 0.35 s. */
function powerDown(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  tone(ctx, envelope(ctx, out, t, 0.12, 0.01, 0.35), 'sine', t, 0.36, 600, 200);
}
```

Add `powerUp,` and `powerDown,` to `VOICES`. If `'triangle'` is not part of `tone`'s wave type, use `'sine'`.

In `src/audio/director.ts`, import `POWER_MAX` from `'../core/power'` and add `const REMOTE_POWER_GAIN = 0.6;` next to `REMOTE_KEY_GAIN`. Replace the `strike` case and add a `power` case:

```ts
        case 'strike':
          this.audio.play(ev.tier === 'hard' || ev.tier === 'insane' ? 'hitHard' : 'hit');
          if (ev.tier === 'insane') this.audio.play('ooh');
          break;
        case 'power': {
          const opts = ctx.viewer === 'spectator' || ev.player === ctx.viewer ? undefined : { gain: REMOTE_POWER_GAIN };
          if (ev.to >= POWER_MAX && ev.from < POWER_MAX) this.audio.play('powerUp', opts);
          else if (ev.from >= POWER_MAX && ev.to === 0) this.audio.play('powerDown', opts);
          break;
        }
```

If the first director test expects `opts: undefined` for the viewer's own cues, this matches. Check with `engine.plays` in the "quieter" test.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/render tests/audio && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render src/audio tests
git commit -F - <<'EOF'
feat(render,audio): purple trail on insane shots; power-up and power-down cues; insane hits draw an "ooh"

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 13: How to Play, README, art QA samples and the e2e typist

**Files:**
- Modify: `src/ui/screens/howTo.ts`
- Modify: `README.md` (the how-to-play section)
- Modify: `tools/art/plates.ts:10-16,97-140`
- Modify: `tools/art/hudStates.ts` (`servingState`, `preServe`, `scoreboardSamples`)
- Modify: `tests/e2e/typist.mjs:29-32`
- Test: `tests/ui/howTo.test.ts` (new), `tests/e2e/typist.test.ts`, `tests/tools/hudStates.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `POWER_TEXT` (exported string) in `howTo.ts`. `mediumOption` picks option 1 of 3 or 4 words.

- [ ] **Step 1: Write the failing tests**

Create `tests/ui/howTo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { POWER_TEXT } from '../../src/ui/screens/howTo';

describe('How to Play: the power meter (power-meter spec §6)', () => {
  it('explains filling, the insane word and what empties the meter', () => {
    for (const phrase of ['POWER METER', 'four', 'INSANE', 'wrong key', 'losing a point']) {
      expect(POWER_TEXT, phrase).toContain(phrase);
    }
  });
});
```

In `tests/e2e/typist.test.ts`, add next to the `mediumOption` tests:

```ts
  it('mediumOption takes the medium word of 3 or 4 options, the only word of a chase', () => {
    expect(mediumOption(['a', 'b', 'c'])).toBe(1);
    expect(mediumOption(['a', 'b', 'c', 'd'])).toBe(1);
    expect(mediumOption(['a'])).toBe(0);
  });
```

In `tests/tools/hudStates.test.ts`, add:

```ts
  it('scoreboards: some sample shows a full meter and some a part-filled one', () => {
    const levels = scoreboardSamples().map((s) => meterLevels(s.frame));
    expect(levels.some((l) => l !== null && l.includes(4))).toBe(true);
    expect(levels.some((l) => l !== null && l.some((n) => n > 0 && n < 4))).toBe(true);
  });
```

Import `meterLevels` from `'../../src/render/hud'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ui/howTo.test.ts tests/e2e/typist.test.ts tests/tools/hudStates.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/ui/screens/howTo.ts`, below `RULES`:

```ts
/** The power meter rule (power-meter spec §6), under the illustrated rules. */
export const POWER_TEXT =
  'POWER METER: every serve or shot you type without a wrong key fills one of four segments. ' +
  'While it is full you also get an INSANE word: a near-winner into the corner, but one typo sends it out. ' +
  'Any wrong key, or losing a point, empties the meter.';
```

In the panel, after `h('div', { class: 'cards' }, ...cards),`, add `h('p', { class: 'power' }, POWER_TEXT),`.

`README.md`: in the how-to-play section, replace the word-length sentence with "Words are easy (2–4 letters), medium (5–7) or hard (8–11)." and add the power meter paragraph (the same text as `POWER_TEXT`). Find the section with `grep -n -i "how to play\|letters" README.md`.

`tests/e2e/typist.mjs`:

```js
/** The medium option of three or four (serve, choice), else the first (chase). */
export function mediumOption(words) {
  return words.length >= 3 ? 1 : 0;
}
```

`tools/art/plates.ts`: bring `WORDS` into the new bands and add an insane row.

```ts
/** One word per tier at lengths 3, 7 and 8 (tiers follow length, power-meter spec §3), with ascenders and descenders. */
const WORDS: readonly WordOption[] = [
  { word: 'jog', len: 3, tier: 'easy' },
  { word: 'jumping', len: 7, tier: 'medium' },
  { word: 'skipping', len: 8, tier: 'hard' },
];
/** The insane sample: 14 letters, the widest common plate. */
const INSANE_WORDS: readonly WordOption[] = [
  { word: 'counterpuncher', len: 14, tier: 'insane' },
  { word: '', len: 14, tier: 'insane', hidden: true },
];
```

In `plateStates`, change `pick([1, 4, 9], i)` to `pick([1, 4, 7], i)` and `pick([2, 5, 11], i)` to `pick([2, 5, 7], i)`. Update the "typed: 1 / 4 / 9 letters" label to "typed: 1 / 4 / 7 letters". Append this state:

```ts
  {
    label: 'insane: 4 pips, 5 letters typed; hidden remote with 3 typed',
    plates: trio((i) => (i === 0 ? { typed: 5, isNextCursor: true } : { style: 'hiddenRemote', typed: 3 }), { words: INSANE_WORDS }),
  },
```

`tools/art/hudStates.ts`: give `servingState` and `preServe` an optional last parameter `power: [number, number] = [0, 0]` (`preServe` passes it through). In `servingState`, set `s.power = power` and `d.power = power[d.owner]` before `engine.start(d.owner)`. In `scoreboardSamples`, pass `PRE_SERVE_AT_MS, [4, 1]` to `preServe('short set 3-3, deuce (brown belt)', …)` and `PRE_SERVE_AT_MS, [2, 4]` to `preServe('short set 3-3, advantage Bruno', …)`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/ui tests/e2e/typist.test.ts tests/tools && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Look at the art page**

Run: `npm run art:export`
Expected: PNGs in `artifacts/art/`. Open the rings, plates and HUD images with the Read tool and check:
- The insane burst reads as distinct from the hard star.
- Four pips are countable on the insane plate.
- The meters sit right of the scoreboard without touching it.

If anything collides, fix the geometry and add a test that pins it.

- [ ] **Step 6: Commit**

```bash
git add src/ui/screens/howTo.ts README.md tools/art tests
git commit -F - <<'EOF'
docs(ui): How to Play and README explain the power meter; art QA shows insane plates, rings and meters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 14: Balance — new targets, retune and record

**Files:**
- Modify: `tests/sim/balance.test.ts` (header comment, targets, new cells)
- Modify: `src/core/tuning.ts` (knobs, comments)

**Interfaces:**
- Consumes: `summarize` fields (Task 9), `'neverInsane'` (Task 9)
- Produces: tuned `flight.pressure`, `flight.pressureFloor`, `flight.place.insane`, `tossApexMs` (and the serve reading allowance only if needed). The measured tables go in the header.

- [ ] **Step 1: Update the targets**

In `tests/sim/balance.test.ts`, in the equal-players `describe.each`:
- Median test: `it('median rally is 5–8 shots', ...)` with bounds 5 and 8.
- p90: `it('90th-percentile rally is ≤ 16 shots', ...)` with `toBeLessThanOrEqual(16)`.
- Max: `it('no point lasts more than 60 shots', ...)` with 60.
- Time: `it('a point takes ≤ 50 s (median)', ...)` with 50.

Keep aces, double faults and server share as they are. Add `const INSANE_POINTS = 20_000;` beside `CELL_POINTS` and add this cell:

```ts
  describe.each(PRESETS.map((p, i) => ({ ...p, seed: 4000 + i })))(
    '$pace at $wpm WPM, the insane option between equal players',
    ({ pace, wpm, seed }) => {
      const s = once(() =>
        summarize(simulatePoints({ config: config(pace), typists: [humanTypist(wpm), humanTypist(wpm)], seed, points: INSANE_POINTS })),
      );
      it('sees at least 200 clean insane shots (raise INSANE_POINTS if not)', ({ expect }) => {
        expect(s().insaneShotsClean).toBeGreaterThanOrEqual(200);
      });
      it('the equal opponent returns 15–40 % of clean insane shots', ({ expect }) => {
        expect(s().insaneReturnRate).toBeGreaterThanOrEqual(0.15);
        expect(s().insaneReturnRate).toBeLessThanOrEqual(0.4);
      });
    },
  );

  describe.each(PRESETS.map((p, i) => ({ ...p, seed: 5000 + i })))(
    '$pace at $wpm WPM, never-insane against the adaptive human model',
    ({ pace, wpm, seed }) => {
      it('wins 40–50 % of points: insane helps without dominating', ({ expect }) => {
        const typists: [SimTypist, SimTypist] = [humanTypist(wpm, 'neverInsane'), humanTypist(wpm)];
        const points = simulatePoints({ config: config(pace), typists, seed, points: CELL_POINTS });
        expect(winShare(points, 0)).toBeGreaterThanOrEqual(0.4);
        expect(winShare(points, 0)).toBeLessThanOrEqual(0.5);
      });
    },
  );
```

- [ ] **Step 2: Measure**

For fast iteration, run only the equal-player and insane cells:

```bash
BBT_SIM=1 npx vitest run tests/sim/balance.test.ts -t "equal human-model|insane option|never-insane"
```

For figures on every cell, add a temporary `console.log(JSON.stringify({ pace, ...s() }))` in each `once` and remove it before committing. Write the measured numbers down.

- [ ] **Step 3: Tune, one knob at a time, in this order**

| Symptom | Knob | Direction |
|---|---|---|
| median < 5 or p90 well under 16 | `flight.pressure` | raise toward 0.96 (gentler) |
| median > 8, p90 > 16 or max > 60 | `flight.pressure`, then `flight.pressureFloor` | lower |
| median s/point > 50 | `flight.pressureFloor` | lower |
| double faults outside 1–6 % | `tossApexMs` | raise → fewer DFs, lower → more |
| server wins outside 55–65 % | `flight.serveReturnBonusMs` / `serveReturnBonusPaceMs` | raise → the server wins less |
| insane return rate > 40 % | `flight.place.insane` | lower (less time) |
| insane return rate < 15 % | `flight.place.insane` | raise |
| never-insane wins > 50 % | `flight.place.insane` | lower (insane too weak) |
| never-insane wins < 40 % | `flight.place.insane` | raise (insane too strong) |

Keep `place.insane < place.hard` (0.70) so the Task 1 ordering test holds. After each change, rerun Step 2. Then rerun the whole suite with `npm run test:sim`, which also covers the fixed-strategy, aggression and CPU-level cells.

**Stop condition:** if two targets pull one knob in opposite directions and no combination meets both after a reasonable search, stop. Report the best settings and the measured trade-off to the user, and wait. Do not loosen any target.

- [ ] **Step 4: Record**

Replace the header comment's "Final summary" tables with the new measurements, in the same format as the existing tables:
- Equal players: median, p90, max, aces, DF, server share and s/point per preset.
- Fixed strategies, including neverInsane.
- Aggression and CPU levels.
- New insane lines: clean insane shots, return rate and full-meter rate (information only) per preset.

List every constant changed as "old → new" in the header and in the comments beside each constant in `src/core/tuning.ts`.

- [ ] **Step 5: Run everything**

Run: `npm run test:sim && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/sim/balance.test.ts src/core/tuning.ts tests
git commit -F - <<'EOF'
test(sim): balance targets for longer rallies and the insane option; retuned constants recorded

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```

---

### Task 15: Amend the main spec and verify end to end

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-black-belt-tennis-design.md` §3.2.6, §3.3.3, §3.4, §3.5, §3.10, §4.2, §4.3, §4.4, §5.3, §6

- [ ] **Step 1: Amend the main spec**

In each section below, change only the lines this feature changes. After each change, add `(amended: power-meter spec 2026-09-27)` and use the final tuned values from Task 14:
- §3.2.6: add the insane serve target (box coordinates, keyed by the hard variant).
- §3.3.3: add the insane rally target `(m·3.965, 11.735)`.
- §3.4: replace `0.85^⌊n/2⌋` with `P(n) = max(pressureFloor, pressure^⌊n/2⌋)` and state the final values. Add `insane` to `place` and to the km/h tier bonus.
- §3.5: add the insane values for σ0, σe and netRate, and the e = 1 expectation of 60–85 %.
- §3.10: new tier bands and pack minimums (insane ≥ 60), one pool per pack.
- §4.2: insane colour and typed shade (and the CVD threshold note), 4 pips, burst ring, 101 px max plate, 4-slot choice row, 4-plate serve stack and row.
- §4.3: HUD power meters.
- §4.4: powerUp and powerDown cues, "ooh" on insane strikes.
- §5.3: `PROTO` 2; frames carry `power`.
- §6: the new balance targets (as in Task 14).

- [ ] **Step 2: Full verification**

Run each and read the output:

```bash
npm run typecheck
npm test
npm run test:sim
npm run build
npm run e2e
```

Expected: all pass. `npm run e2e` needs the local Chrome that Playwright uses. If e2e cannot launch the browser in this environment, say so in the final report rather than claiming it passed.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-26-black-belt-tennis-design.md
git commit -F - <<'EOF'
docs(spec): main spec follows the power meter, insane tier and rally pacing amendments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
EOF
```
