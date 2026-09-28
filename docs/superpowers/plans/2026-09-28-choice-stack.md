# Choice Stack, Side Leaders and the Insane-Return Cheer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the near typist's shot words as a stack where the chase word was, join each plate to its ring with a side leader that never crosses another, and cheer when a player returns an insane shot.

**Architecture:**
- **Leaders:** they become polylines. `drawLeaderPath` in `render/plates.ts` draws them, and a pure router in a new `render/leaders.ts` places the stack and computes its leader routes.
- **Stack geometry:** `layoutChoiceStack` and `growUp` in `render/layout.ts`.
- **Wiring:** `render/prompts.ts` uses the stack when the choice prompt's owner is the near player, and keeps today's row for the far one.
- **Cheer:** the audio director and the effects read the return turn's public chase word to cheer an insane return.
- **Untouched:** `core/`, `game/`, `net/` and the protocol.

**Tech Stack:** TypeScript 7, Vite 8, Vitest 5 (Node), Canvas 2D, WebAudio.

**Spec:** `docs/superpowers/specs/2026-09-28-choice-stack-design.md`. It amends `docs/superpowers/specs/2026-09-26-black-belt-tennis-design.md` (the "main spec") and `docs/superpowers/specs/2026-09-27-power-meter-and-rally-pacing-design.md`.

## Global Constraints

- **Plates:** plates stay within x 4–476 and y 22–266. Plate width is `6n + 11` px (1×), height 16.
- **Stack:** tier order top to bottom (easy 0, medium 1, hard 2, insane 3), 3 px gaps. Every plate is centred on the column of the owner's head x at turn start. The bottom plate's bottom edge is 4 px above that head (the chase plate's bottom edge).
- **Stack vs rings:** the stack's top edge is ≥ 8 px below the lowest ring centre it shows. If not, the stack moves down.
- **Leaders:**
  - They start 2 px outside a plate's side (past its 1 px halo), at `box.y + box.h / 2`.
  - Medium and insane leave from medium's side (medium's ring screen x relative to hard's). Hard leaves from the other side. Easy leaves from the side its ring is on relative to the column (hard's side when exactly on it).
  - Lanes are 4 px apart, lower plates outermost. A lane route turns `4 + 4·k` px above the stack's top (k = lane index from the inside).
- **Guarantee:** no two leaders' outlined pixels overlap. No leader pixel, outline included, enters another plate's box grown by 1 px, or another ring's keep-out. Leader pixels stay within x 4–475. **If this cannot be met, stop and report to the user; never drop a condition quietly.**
- **Far typist:** keeps today's row (`layoutChoice(…, 'near')`) and today's straight leaders from each plate's bottom centre.
- **Cheer:** at the `strike` of a return turn whose chase word is insane: applause at full gain for the returner-viewer or a spectator, `POLITE_APPLAUSE_GAIN` (0.5) otherwise. Crowd excitement rises to `EXCITE.point` (0.7). No new event, field or `PROTO` change.
- **Every commit:** `npm run typecheck` and `npm test` pass. `npm run build` and `npm run e2e` pass at the end.
- **Commit messages** follow the repo's `type(scope): summary` style and end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01RPS14iGVpk9JBscyVsKAHb
  ```

### Feasibility already checked

A throwaway prototype of exactly the routing in Task 2 was run before this plan was written (then deleted). It covered, for both medium sides and 3 and 4 options:
- every column 4–476 with depth steps of 0.25 m, at each tier's shortest and longest word;
- every word length, every 4th column.

That is 1.8 M layouts with 0 breaches of the guarantee. The measured rings for viewer 0 were:
- m = 1: easy (240, 91), medium (199, 89), hard (290, 82), insane (186, 81);
- m = −1: easy (240, 91), medium (281, 89), hard (190, 82), insane (294, 81).

Near head heights were 40–43 px.

### Recorded deviation from the spec: the live 4-plate screenshot

Spec §6 asks for "a devshot of a 4-plate stack in a live match". The art page's live match uses a fixed seed chosen so its moments appear early. A full-meter choice by player 0 is not guaranteed there, and re-choosing the seed would move every other live shot. Instead:
- a new art section `choice-stack` (Task 5) draws 3- and 4-plate stacks with the real layout, routing, plates and rings over the real hard-court scene, at five columns and both medium sides;
- a new live moment `stack` (Task 5) shows a real 3-plate stack drawn by the Renderer in the live match;
- the 4-plate case in a live frame is pinned by the prompt tests (Task 3).

## Review Focus

1. **A near player standing far forward.** Their head is high enough that the stack would reach the rings, and the stack must move down (spec §2). The guarantee test's depths start at the service line. Test in Task 2.
2. **A stack at a screen edge.** Plates and lanes must both stay on screen, with the unit shifted inward. Columns 4 and 476 are in the guarantee sweep, plus a direct `placeChoiceStack` test. Tests in Task 2.
3. **A chase slip at a full meter.** Four targets were pre-picked but 3 options are shown, so the stack, rings and routes must use 3. Test in Task 3.
4. **Large words with the bottom (insane) plate locked.** The 2× plate must grow upward, never over the head, and stay in the area. Its leader must leave the doubled box. Test in Task 3.
5. **The return turn has already become `lastTurn` in the frame that carries its strike event.** The director must still find it and cheer. Test in Task 4.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/render/plates.ts` | `Pt`, `leaderPixels`, `drawLeaderPath`, `drawLeader` (2-point), `inRingKeepOut` | 1 |
| `src/render/world.ts` | draws `LeaderMark.points` | 1 |
| `src/render/layout.ts` | `PLATE_AREA`, `stackHeight`, `layoutChoiceStack`, `growUp` | 2 |
| `src/render/leaders.ts` (new) | `routeStackLeaders`, `placeChoiceStack` | 2 |
| `src/render/prompts.ts` | `LeaderMark.points`; near typist → stack, bar, hint, Large words | 1, 3 |
| `src/audio/director.ts`, `src/render/effects.ts` | insane-return cheer | 4 |
| `tools/art/choiceStack.ts` (new), `tools/art.ts`, `tools/art/liveMatch.ts`, `tools/art/liveScenes.ts` | art QA | 5 |
| `README.md`, main spec | docs | 6 |

---

### Task 1: Leaders become polylines

A pure refactor. Leaders are drawn from a list of points instead of `from`/`to`. Every existing leader becomes a 2-point path, so nothing on screen changes.

**Files:**
- Modify: `src/render/plates.ts:344-397` (leader drawing), plus a new `inRingKeepOut`
- Modify: `src/render/prompts.ts:49-50` (`LeaderMark`), `:328` (row leader push)
- Modify: `src/render/world.ts:7,147-156`
- Test: `tests/render/plates.test.ts`, `tests/render/renderer.test.ts:199-200`, `tests/render/prompts.test.ts:253-259,464`

**Interfaces:**
- Produces:
  - `export interface Pt { x: number; y: number }` (plates.ts)
  - `export function leaderPixels(points: readonly Pt[], tier: Tier): [x: number, y: number][]`: the ink pixels drawn, each once, minus the ring keep-out around the last point.
  - `export function drawLeaderPath(ctx: CanvasRenderingContext2D, points: readonly Pt[], tier: Tier): void`
  - `export function drawLeader(ctx, from: Pt, to: Pt, tier): void`: unchanged behaviour, now `drawLeaderPath(ctx, [from, to], tier)`.
  - `export function inRingKeepOut(tier: Tier, dx: number, dy: number): boolean`
  - `export interface LeaderMark { points: Pt[]; tier: Tier; alpha: number }` (prompts.ts)

- [ ] **Step 1: Write the failing tests**

In `tests/render/plates.test.ts`, change the import on line 9 to:

```ts
import { drawLeader, drawLeaderPath, drawPlate, drawTierRing, drawTimingBar, inRingKeepOut, leaderPixels, type PlateDraw } from '../../src/render/plates';
```

Inside `describe('drawLeader', …)`, after the last `it` (the "skips a leader too long" test, before the closing `});` of the describe), add:

```ts
  it('draws an elbow path: along the row, up the column, into the ring, as one outlined mark (choice-stack spec §3)', () => {
    const g = scene(60, 60);
    drawLeaderPath(as2d(g), [{ x: 50, y: 50 }, { x: 20, y: 50 }, { x: 20, y: 10 }], 'medium');
    drawTierRing(as2d(g), 'medium', 20, 10);
    const tier = TIER_COLOR.medium;
    for (let x = 20; x <= 50; x++) expect(at(g, x, 50), `row pixel ${x}`).toBe(tier);
    for (let y = 15; y <= 50; y++) expect(at(g, 20, y), `column pixel ${y}`).toBe(tier);
    expect(at(g, 21, 49)).toBe(OUTLINE);
    expect(at(g, 19, 51)).toBe(OUTLINE);
    expect(marks(g)).toBe(1);
  });

  it('lists each leader pixel once, corners included, and stops at the ring keep-out', () => {
    const px = leaderPixels([{ x: 10, y: 40 }, { x: 30, y: 40 }, { x: 30, y: 10 }], 'easy');
    const keys = px.map(([x, y]) => `${x},${y}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('30,40');
    expect(px.every(([x, y]) => (y === 40 && x >= 10 && x <= 30) || (x === 30 && y <= 40))).toBe(true);
    // The easy ring's keep-out reaches 4 px below its centre, so the column stops 5 px below it.
    expect(Math.min(...px.filter(([x]) => x === 30).map(([, y]) => y))).toBe(15);
    expect(leaderPixels([{ x: 10.4, y: 5 }], 'easy')).toEqual([]);
    expect(leaderPixels([{ x: 10, y: 5 }, { x: NaN, y: 20 }, { x: 30, y: 30 }], 'easy')).toEqual([]);
  });

  it('draws the same pixels for drawLeader(from, to) and a 2-point path', () => {
    const a = scene(60, 50);
    const b = scene(60, 50);
    drawLeader(as2d(a), { x: 10, y: 5 }, { x: 40.4, y: 35.2 }, 'hard');
    drawLeaderPath(as2d(b), [{ x: 10, y: 5 }, { x: 40.4, y: 35.2 }], 'hard');
    for (let y = 0; y < 50; y++) for (let x = 0; x < 60; x++) expect(at(b, x, y)).toBe(at(a, x, y));
  });

  it('knows each ring\'s keep-out: the filled ring grown by 1 px', () => {
    expect(inRingKeepOut('easy', 0, 4)).toBe(true);
    expect(inRingKeepOut('easy', 0, 5)).toBe(false);
    expect(inRingKeepOut('easy', 7, 0)).toBe(true);
    expect(inRingKeepOut('easy', 8, 0)).toBe(false);
    expect(inRingKeepOut('medium', 0, 0)).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/render/plates.test.ts`
Expected: FAIL. `drawLeaderPath`, `leaderPixels` and `inRingKeepOut` are not exported.

- [ ] **Step 3: Implement the polyline in `src/render/plates.ts`**

Replace the doc comment and body of `drawLeader` (from `/**\n * Draws the leader joining a choice plate…` to the end of `drawLeader`) with:

```ts
/** A screen point in buffer pixels (unrounded; leaders round each end). */
export interface Pt { x: number; y: number }

/**
 * The ink pixels of a leader along `points`, a polyline from a plate to the ring centre (the last
 * point), each pixel once: every segment walked between rounded ends (`linePixels`), minus the ring's
 * keep-out around the last point. Empty for fewer than 2 points, an end that is not a finite whole
 * pixel once rounded, or a segment longer than `MAX_LEADER` (a malformed peer target).
 */
export function leaderPixels(points: readonly Pt[], tier: Tier): [x: number, y: number][] {
  if (points.length < 2) return [];
  const ends = points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ends.length; i++) {
    const a = ends[i]!;
    const b = ends[i + 1]!;
    const seg = linePixels(a.x, a.y, b.x, b.y);
    if (seg.length === 0) return [];
    out.push(...(i === 0 ? seg : seg.slice(1)));
  }
  const ring = ends[ends.length - 1]!;
  const { keepOut } = RINGS[tier];
  return out.filter(([x, y]) => !keepOut.has(key(x - ring.x, y - ring.y)));
}

/**
 * Draws a leader joining a choice plate to its ground ring (spec §4.2, choice-stack spec §3): a 1 px
 * tier-coloured polyline through `points`, outlined 1 px in near-black and stopping where it meets the
 * outline of the ring centred on the last point, so the ring stays clean whichever is drawn first.
 * Draw it before the plate so the plate covers its start. Nothing is drawn for a malformed path
 * (`leaderPixels`).
 */
export function drawLeaderPath(ctx: CanvasRenderingContext2D, points: readonly Pt[], tier: Tier): void {
  const pixels = leaderPixels(points, tier);
  for (const [x, y] of pixels) rect(ctx, x - 1, y - 1, 3, 3, OUTLINE);
  for (const [x, y] of pixels) rect(ctx, x, y, 1, 1, TIER_COLOR[tier]);
}

/** A straight leader from `from` (the plate end) to the ring centre `to`: `drawLeaderPath` with two points. */
export function drawLeader(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, tier: Tier): void {
  drawLeaderPath(ctx, [from, to], tier);
}

/**
 * True when offset (dx, dy) from a `tier` ring's centre lies in its keep-out: the filled ring grown
 * by 1 px, where no pixel of another ring's leader may go (choice-stack spec §3).
 */
export function inRingKeepOut(tier: Tier, dx: number, dy: number): boolean {
  return RINGS[tier].keepOut.has(key(dx, dy));
}
```

- [ ] **Step 4: Switch `LeaderMark` to points**

In `src/render/prompts.ts`:
- Change the `plates` import to `import { drawPlate, drawTimingBar, type PlateDraw, type PlateStyle, type Pt } from './plates';`.
- Replace lines 49–50 with:

```ts
/** A choice leader: a polyline from its plate to its ring centre (the last point); the world pass draws it under the players (R42). */
export interface LeaderMark { points: Pt[]; tier: Tier; alpha: number }
```

- In `choicePlates`, replace the `s.leaders.push(…)` line with:

```ts
    s.leaders.push({ points: [{ x: box.x + Math.floor(box.w / 2), y: box.y + box.h }, { x: to.x, y: to.y }], tier, alpha });
```

In `src/render/world.ts`:
- Change the import on line 7 to `import { drawLeaderPath, drawTierRing } from './plates';`.
- In `drawLeaders`, replace `drawLeader(ctx, l.from, l.to, l.tier);` with `drawLeaderPath(ctx, l.points, l.tier);`.

- [ ] **Step 5: Update the tests that build leaders**

In `tests/render/renderer.test.ts`, replace the two `LeaderMark` literals (lines 199–200) with:

```ts
    const leader: LeaderMark = { points: [{ x: feet.x, y: 38 }, { x: ring.x, y: ring.y }], tier: 'easy', alpha: 1 };
    const faded: LeaderMark = { ...leader, points: [{ x: feet.x + 60, y: 38 }, { x: ring.x + 60, y: ring.y }], alpha: 0 };
```

In `tests/render/prompts.test.ts`:
- In the test "lays the choice out in the band of the targeted half…", replace the `s.leaders.forEach` body with:

```ts
      const box = s.plates[i]!.box;
      const from = l.points[0]!;
      expect(l.points.at(-1)).toEqual({ x: targets[i]!.x, y: targets[i]!.y });
      expect(from.y).toBe(box.y + box.h);
      expect(from.x).toBeGreaterThanOrEqual(box.x);
      expect(from.x).toBeLessThan(box.x + box.w);
```

- In `describe('drawPrompts')`, replace the `leader` literal with:

```ts
    const leader = { points: [{ x: 150, y: 150 }, { x: ring.x, y: ring.y }], tier: ring.tier, alpha: 1 };
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run tests/render && npm run typecheck`
Expected: PASS. `tools/art/rings.ts` and `src/ui/illustrations.ts` still call `drawLeader(g, from, to, tier)`, which is unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/render/plates.ts src/render/prompts.ts src/render/world.ts tests/render/plates.test.ts tests/render/renderer.test.ts tests/render/prompts.test.ts
git commit -m "refactor(render): choice leaders are polylines (drawLeaderPath, leaderPixels, inRingKeepOut)"
```

---

### Task 2: Stack placement and side-leader routing

**Files:**
- Modify: `src/render/layout.ts` (export `PLATE_AREA`, add `stackHeight`, `layoutChoiceStack`, `growUp`)
- Create: `src/render/leaders.ts`
- Test: `tests/render/layout.test.ts` (append), `tests/render/leaders.test.ts` (new)

**Interfaces:**
- Consumes: `Pt`, `leaderPixels`, `inRingKeepOut` (Task 1).
- Produces:
  - `export const PLATE_AREA: { left: 4; right: 476; top: 22; bottom: 266 }` (layout.ts)
  - `export function stackHeight(n: number): number`: `16n + 3(n − 1)`.
  - `export function layoutChoiceStack(lens: number[], columnX: number, bottomY: number): PlateBox[]`: tier order, centred on `columnX`, the last plate ending at `bottomY` (exclusive). Not clamped. Throws unless 3 or 4 lengths.
  - `export function growUp(box: PlateBox): PlateBox`: 2× around the centre column, bottom edge kept, clamped to the plate area.
  - `export function routeStackLeaders(boxes: readonly PlateBox[], rings: readonly Pt[], columnX: number): Pt[][]` (leaders.ts). `rings` are whole pixels, one per box, in option order.
  - `export interface PlacedStack { boxes: PlateBox[]; routes: Pt[][]; columnX: number }`
  - `export function placeChoiceStack(lens: number[], columnX: number, bottomY: number, rings: readonly Pt[]): PlacedStack`

- [ ] **Step 1: Write the failing layout tests**

In `tests/render/layout.test.ts`, add `growUp`, `layoutChoiceStack` and `stackHeight` to the import from `../../src/render/layout`, then append:

```ts
describe('layoutChoiceStack (choice-stack spec §2)', () => {
  /** Every length of each tier's band (easy 2–4, medium 5–7, hard 8–11, insane 12–15), 3 and 4 options. */
  const STACKS: number[][] = [2, 3, 4].flatMap((e) =>
    [5, 6, 7].flatMap((m) => [8, 9, 10, 11].flatMap((h) => [[e, m, h], ...[12, 13, 14, 15].map((i) => [e, m, h, i])])),
  );

  it('stacks the options in tier order, 3 px apart, ending at bottomY, each centred on the column', () => {
    const boxes = layoutChoiceStack([4, 7, 11, 15], 200, 190);
    expect(boxes.map((b) => b.option)).toEqual([0, 1, 2, 3]);
    expect(boxes.map((b) => b.w)).toEqual([35, 53, 77, 101]);
    expect(boxes.map((b) => b.y)).toEqual([117, 136, 155, 174]);
    expect(boxes.every((b) => b.h === 16)).toBe(true);
    for (const b of boxes) expect(b.x + (b.w - 1) / 2).toBe(200);
    expect(stackHeight(4)).toBe(73);
    expect(stackHeight(3)).toBe(54);
  });

  it('is a pyramid: each plate reaches at least 3 px farther than the one above on both sides', () => {
    for (const lens of STACKS) {
      const boxes = layoutChoiceStack(lens, 240.4, 200);
      for (let i = 1; i < boxes.length; i++) {
        const [up, b] = [boxes[i - 1]!, boxes[i]!];
        expect(b.x, `${lens}`).toBeLessThanOrEqual(up.x - 3);
        expect(b.x + b.w, `${lens}`).toBeGreaterThanOrEqual(up.x + up.w + 3);
      }
    }
  });

  it('throws unless given 3 or 4 lengths', () => {
    expect(() => layoutChoiceStack([4, 7], 240, 200)).toThrow('layoutChoiceStack needs 3 or 4 word lengths');
  });
});

describe('growUp (choice-stack spec §2, Large words)', () => {
  it('doubles a stack plate around its centre column, keeping its bottom edge', () => {
    expect(growUp({ x: 150, y: 174, w: 101, h: 16, option: 3 })).toEqual({ x: 100, y: 158, w: 202, h: 32, option: 3 });
  });

  it('stays inside x 4–476 and y 22–266', () => {
    expect(growUp({ x: 4, y: 30, w: 101, h: 16, option: 3 })).toEqual({ x: 4, y: 22, w: 202, h: 32, option: 3 });
    expect(growUp({ x: 375, y: 250, w: 101, h: 16, option: 3 }).x).toBe(274);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/render/layout.test.ts`
Expected: FAIL. `layoutChoiceStack`, `stackHeight` and `growUp` are not exported.

- [ ] **Step 3: Implement the layout functions**

In `src/render/layout.ts`, replace line 11 (`const AREA = …`) with:

```ts
/** Area every plate must stay inside (spec §4.2): x 4–476, y 22–266. */
export const PLATE_AREA = { left: 4, right: 476, top: BANDS.far[0], bottom: 266 } as const;
const AREA = PLATE_AREA;
```

(Remove the old doc comment above line 11 that said the same thing.) Then add after `layoutChoice`'s helpers (after `fourSlots`):

```ts
/** Height of a choice stack of `n` plates, 3 px apart (choice-stack spec §2). */
export function stackHeight(n: number): number {
  return n * PLATE_H + (n - 1) * STACK_GAP;
}

/**
 * The near typist's choice plates (choice-stack spec §2) for `lens` in option order, [easy, medium,
 * hard] or [easy, medium, hard, insane]: a stack in that order from the top, 3 px apart, the last plate
 * ending at `bottomY` (exclusive), every plate centred on `columnX`. Each tier's words are longer than
 * the tier above, so the stack is a pyramid. Not clamped: `placeChoiceStack` (leaders.ts) fits the stack
 * and its leaders into the plate area as one unit. Throws unless given 3 or 4 lengths.
 */
export function layoutChoiceStack(lens: number[], columnX: number, bottomY: number): PlateBox[] {
  if (lens.length !== 3 && lens.length !== 4) {
    throw new Error(`layoutChoiceStack needs 3 or 4 word lengths, got ${lens.length}`);
  }
  const top = Math.round(bottomY) - stackHeight(lens.length);
  return lens.map((len, option) => {
    const w = plateWidth(len);
    return { x: Math.round(columnX - (w - 1) / 2), y: top + option * (PLATE_H + STACK_GAP), w, h: PLATE_H, option };
  });
}

/**
 * A choice-stack plate redrawn at 2× (a locked word with Large words; choice-stack spec §2): around its
 * centre column with its bottom edge kept, so it grows away from the head below the stack; kept inside
 * x 4–476 and y 22–266.
 */
export function growUp(box: PlateBox): PlateBox {
  const w = box.w * 2;
  const h = box.h * 2;
  return {
    x: centredX(box.x + (box.w - 1) / 2, w),
    y: clamp(box.y + box.h - h, AREA.top, AREA.bottom - h),
    w,
    h,
    option: box.option,
  };
}
```

- [ ] **Step 4: Run the layout tests**

Run: `npx vitest run tests/render/layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing leader tests**

Create `tests/render/leaders.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { insaneRallyTarget, rallyTargets } from '../../src/core/court';
import type { Look, Tier } from '../../src/core/types';
import { layoutChoiceStack } from '../../src/render/layout';
import { placeChoiceStack, routeStackLeaders, type PlacedStack } from '../../src/render/leaders';
import { inRingKeepOut, leaderPixels, type Pt } from '../../src/render/plates';
import { project } from '../../src/render/projection';
import { headHeight } from '../../src/render/prompts';

const TIERS: readonly Tier[] = ['easy', 'medium', 'hard', 'insane'];
const BAND: Record<Tier, readonly number[]> = { easy: [2, 3, 4], medium: [5, 6, 7], hard: [8, 9, 10, 11], insane: [12, 13, 14, 15] };
const W = 480;
const H = 270;
const LOOK: Look = { skin: 1, hairStyle: 0, hair: 1, shirt: 6, shorts: 0, headband: null, racket: 0 };

/** The rounded screen rings of the far half's rally targets for viewer 0, medium's side `m`: easy, medium, hard, insane. */
function ringsFor(m: 1 | -1): Pt[] {
  return [...rallyTargets(1, m), insaneRallyTarget(1, m)].map((p) => {
    const q = project({ ...p, z: 0 }, 0);
    return { x: Math.round(q.x), y: Math.round(q.y) };
  });
}

/** Which leader last covered each pixel (−1 none); reset after every check. */
const owner = new Int8Array(W * H).fill(-1);

/** Every way `s` breaks the choice-stack spec §3 guarantee; empty when it holds. */
function breaches(s: PlacedStack, rings: readonly Pt[]): string[] {
  const out = new Set<string>();
  const touched: number[] = [];
  for (const b of s.boxes) {
    if (b.x < 4 || b.x + b.w > 476 || b.y < 22 || b.y + b.h > 266) out.add(`plate ${b.option} outside the plate area`);
  }
  s.routes.forEach((route, i) => {
    for (const [ix, iy] of leaderPixels(route, TIERS[i]!)) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = ix + dx;
          const y = iy + dy;
          if (x < 4 || x > 475 || y < 0 || y >= H) {
            out.add(`leader ${i} leaves x 4–475`);
            continue;
          }
          const k = y * W + x;
          const o = owner[k]!;
          if (o >= 0 && o !== i) out.add(`leaders ${o} and ${i} overlap`);
          owner[k] = i;
          touched.push(k);
          s.boxes.forEach((b, j) => {
            if (j !== i && x >= b.x - 1 && x <= b.x + b.w && y >= b.y - 1 && y <= b.y + b.h) out.add(`leader ${i} enters plate ${j}`);
          });
          rings.forEach((r, j) => {
            const [rx, ry] = [x - r.x, y - r.y];
            if (j !== i && Math.abs(rx) <= 8 && Math.abs(ry) <= 5 && inRingKeepOut(TIERS[j]!, rx, ry)) out.add(`leader ${i} enters ring ${j}`);
          });
        }
      }
    }
  });
  for (const k of touched) owner[k] = -1;
  return [...out];
}

/** Word lengths per option for `n` options: every length of each band (`all`), or each band's shortest and longest. */
function lengthSets(n: 3 | 4, all: boolean): number[][] {
  let sets: number[][] = [[]];
  for (const t of TIERS.slice(0, n)) {
    const band = BAND[t];
    const pick = all ? band : [band[0]!, band[band.length - 1]!];
    sets = sets.flatMap((s) => pick.map((len) => [...s, len]));
  }
  return sets;
}

/** The bottom edge of a near player's chase plate: 4 px above the head of a player standing `depth` m behind the net. */
function chaseBottom(depth: number, head: number): number {
  return Math.round(project({ x: 0, y: -depth, z: 0 }, 0).y) - head - 4;
}

describe('routeStackLeaders (choice-stack spec §3)', () => {
  // A centred 4-stack: easy x 223–257, medium 214–266, hard 202–278, insane 190–290; rows 127 / 146 / 165 / 184.
  const centred = layoutChoiceStack([4, 7, 11, 15], 240, 200);
  const spread: Pt[] = [{ x: 240, y: 90 }, { x: 180, y: 90 }, { x: 300, y: 82 }, { x: 170, y: 80 }];

  it('runs a leader straight out along its row, then up to its ring, when the ring lies farther out', () => {
    const r = routeStackLeaders(centred, spread, 240);
    expect(r[1]).toEqual([{ x: 212, y: 154 }, { x: 180, y: 154 }, { x: 180, y: 90 }]);
    expect(r[2]).toEqual([{ x: 280, y: 173 }, { x: 300, y: 173 }, { x: 300, y: 82 }]);
    expect(r[3]).toEqual([{ x: 188, y: 192 }, { x: 170, y: 192 }, { x: 170, y: 80 }]);
  });

  it('sends easy out on hard\'s side when its ring is on the column, up a lane above the stack when the ring lies inward', () => {
    const r = routeStackLeaders(centred, spread, 240);
    expect(r[0]).toEqual([{ x: 259, y: 135 }, { x: 259, y: 123 }, { x: 240, y: 90 }]);
  });

  it('nests lanes: a lower plate takes a lane farther out and turns higher', () => {
    const off = layoutChoiceStack([4, 7, 11, 15], 120, 200);
    const rings: Pt[] = [{ x: 240, y: 90 }, { x: 199, y: 89 }, { x: 290, y: 82 }, { x: 186, y: 80 }];
    const r = routeStackLeaders(off, rings, 120);
    expect(r[1]).toEqual([{ x: 92, y: 154 }, { x: 92, y: 123 }, { x: 199, y: 89 }]);
    expect(r[3]).toEqual([{ x: 68, y: 192 }, { x: 68, y: 119 }, { x: 186, y: 80 }]);
    expect(r[0]).toEqual([{ x: 139, y: 135 }, { x: 240, y: 135 }, { x: 240, y: 90 }]);
    expect(r[2]).toEqual([{ x: 160, y: 173 }, { x: 290, y: 173 }, { x: 290, y: 82 }]);
  });
});

describe('placeChoiceStack (choice-stack spec §2)', () => {
  const rings = ringsFor(1);

  it('keeps the chase plate\'s bottom edge and column when nothing is in the way', () => {
    const s = placeChoiceStack([4, 7, 11, 15], 240, 190, rings);
    expect(s.columnX).toBe(240);
    expect(s.boxes.at(-1)!.y + 16).toBe(190);
  });

  it('moves the stack down to stay 8 px below the lowest ring, and inside y 22–266', () => {
    const lowest = Math.max(...rings.map((r) => r.y));
    const s = placeChoiceStack([4, 7, 11, 15], 240, 120, rings);
    expect(s.boxes[0]!.y).toBe(lowest + 8);
    expect(placeChoiceStack([4, 7, 11], 240, 400, rings.slice(0, 3)).boxes.at(-1)!.y + 16).toBe(266);
  });

  it('shifts the stack and its lanes inward together at either screen edge', () => {
    for (const col of [4, 476]) {
      const s = placeChoiceStack([4, 7, 11, 15], col, 190, rings);
      expect(breaches(s, rings), `column ${col}`).toEqual([]);
      expect(s.columnX).not.toBe(col);
    }
  });

  it('meets the guarantee everywhere a near player can stand: no two leaders touch, none enters another plate or ring', () => {
    const heads = [0, 1, 2, 3, 4].flatMap((hairStyle) =>
      [0, null].map((headband) => headHeight({ ...LOOK, hairStyle, headband }, 'near')),
    );
    const headRange = [Math.min(...heads), Math.max(...heads)];
    const fails: string[] = [];
    const check = (m: 1 | -1, lens: number[], col: number, bottom: number): void => {
      const rings = ringsFor(m).slice(0, lens.length);
      for (const b of breaches(placeChoiceStack(lens, col, bottom, rings), rings)) {
        if (fails.length < 20) fails.push(`m ${m} lens ${lens} column ${col} bottom ${bottom}: ${b}`);
      }
    };
    for (const m of [1, -1] as const) {
      // Every column (step 4), service line to 1.2 m behind the baseline, each band's extremes.
      for (const depth of [6.4, 8, 10, 11.5, 12.2, 12.5, 13.085]) {
        for (const head of headRange) {
          for (let col = 4; col <= 476; col += 4) {
            for (const n of [3, 4] as const) for (const lens of lengthSets(n, false)) check(m, lens, col, chaseBottom(depth, head));
          }
        }
      }
      // Every word length at the edges, the serve-return spots and the centre.
      for (const col of [4, 60, 158, 240, 322, 420, 476]) {
        for (const n of [3, 4] as const) for (const lens of lengthSets(n, true)) check(m, lens, col, chaseBottom(12.5, headRange[0]!));
      }
    }
    expect(fails).toEqual([]);
  }, 120_000);
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run tests/render/leaders.test.ts`
Expected: FAIL. Cannot resolve `../../src/render/leaders`.

- [ ] **Step 7: Implement `src/render/leaders.ts`**

```ts
import { clamp } from '../core/util';
import { layoutChoiceStack, PLATE_AREA, stackHeight, type PlateBox } from './layout';
import type { Pt } from './plates';

// Side leaders of the near typist's choice stack (choice-stack spec §2–3).

/** Lanes on one side are this far apart: 1 px ink with a 1 px outline each side, then 1 px of court. */
const LANE_GAP = 4;
/** A leader starts this far outside its plate's edge, past the 1 px halo. */
const START_OUT = 2;
/** The innermost lane turns this far above the stack's top edge; each lane farther out turns `LANE_GAP` higher. */
const TURN_GAP = 4;
/** The stack's top edge stays at least this far below the lowest ring centre. */
const RING_CLEAR = 8;
/** Column shifts tried to fit the stack and its leaders inside the plate area. */
const FIT_TRIES = 4;

/** `points` without any point equal to the one before it. */
function compact(points: Pt[]): Pt[] {
  return points.filter((p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y);
}

/**
 * The side leaders of a choice stack (choice-stack spec §3): one polyline per plate from the middle row
 * of one of its sides, 2 px out, to its ring centre `rings[i]` (whole pixels, option order). Medium and
 * insane leave from medium's side of the screen (medium's ring relative to hard's), hard from the other
 * and easy from the side its ring is on relative to `columnX` (hard's side when exactly on it). Plates
 * are taken top to bottom on each side. A ring farther out than both the plate's start and every lane
 * or column used above it on that side gets a direct route: along the plate's row to the ring's x, then
 * up. Otherwise the leader runs out to a lane (the start, or 4 px beyond the previous lane or column),
 * up to 4 px above the stack's top plus 4 px per lane already turned on that side, then straight to the
 * ring. With a pyramid stack and the tier rings' fixed left-to-right order, no two routes meet and none
 * crosses another plate (tests/render/leaders.test.ts).
 */
export function routeStackLeaders(boxes: readonly PlateBox[], rings: readonly Pt[], columnX: number): Pt[][] {
  if ((boxes.length !== 3 && boxes.length !== 4) || rings.length !== boxes.length) {
    throw new Error(`routeStackLeaders needs 3 or 4 plates and a ring each, got ${boxes.length} and ${rings.length}`);
  }
  const medium: -1 | 1 = rings[1]!.x < rings[2]!.x ? -1 : 1;
  const sideOf = (i: number): -1 | 1 => {
    if (i === 2) return medium === 1 ? -1 : 1;
    if (i !== 0) return medium;
    const x = rings[0]!.x;
    if (x === columnX) return medium === 1 ? -1 : 1;
    return x < columnX ? -1 : 1;
  };
  const top = Math.min(...boxes.map((b) => b.y));
  const routes: Pt[][] = [];
  for (const side of [-1, 1] as const) {
    let edge: number | null = null;
    let lanes = 0;
    boxes.forEach((b, i) => {
      if (sideOf(i) !== side) return;
      const start = { x: side < 0 ? b.x - START_OUT : b.x + b.w - 1 + START_OUT, y: b.y + b.h / 2 };
      const inner = edge === null ? start.x : side < 0 ? Math.min(start.x, edge - LANE_GAP) : Math.max(start.x, edge + LANE_GAP);
      const ring = { x: rings[i]!.x, y: rings[i]!.y };
      if (side * (ring.x - inner) >= 0) {
        routes[i] = compact([start, { x: ring.x, y: start.y }, ring]);
        edge = ring.x;
      } else {
        const turn = top - TURN_GAP - LANE_GAP * lanes++;
        routes[i] = compact([start, { x: inner, y: start.y }, { x: inner, y: turn }, ring]);
        edge = inner;
      }
    });
  }
  return routes;
}

/** A placed choice stack: its plates, their leader routes and the column it ended up on. */
export interface PlacedStack { boxes: PlateBox[]; routes: Pt[][]; columnX: number }

/** Pixels to move the stack right (+) or left (−) so its plates and leaders fit x 4–476; 0 when they fit. */
function fitShift(boxes: readonly PlateBox[], routes: readonly Pt[][]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of boxes) {
    lo = Math.min(lo, b.x);
    hi = Math.max(hi, b.x + b.w);
  }
  // Every point but the ring (always well inside), widened by the 1 px outline.
  for (const r of routes) {
    for (const p of r.slice(0, -1)) {
      lo = Math.min(lo, p.x - 1);
      hi = Math.max(hi, p.x + 2);
    }
  }
  if (lo < PLATE_AREA.left) return PLATE_AREA.left - lo;
  return hi > PLATE_AREA.right ? PLATE_AREA.right - hi : 0;
}

/**
 * The near typist's choice stack for `lens` (choice-stack spec §2), placed where the chase plate was:
 * centred on `columnX`, the last plate ending at `bottomY`. It moves down if needed so its top stays
 * 8 px below the lowest of `rings` (whole-pixel ring centres, one per option), is kept inside y 22–266,
 * and is shifted sideways as one unit with its leaders until they fit x 4–476 (the plates alone as a
 * last resort, which the leader tests show never happens).
 */
export function placeChoiceStack(lens: number[], columnX: number, bottomY: number, rings: readonly Pt[]): PlacedStack {
  const h = stackHeight(lens.length);
  const lowest = Math.max(...rings.map((r) => r.y));
  const bottom = clamp(Math.max(Math.round(bottomY), lowest + RING_CLEAR + h), PLATE_AREA.top + h, PLATE_AREA.bottom);
  let column = columnX;
  for (let k = 0; k < FIT_TRIES; k++) {
    const boxes = layoutChoiceStack(lens, column, bottom);
    const routes = routeStackLeaders(boxes, rings, column);
    const dx = fitShift(boxes, routes);
    if (dx === 0) return { boxes, routes, columnX: column };
    column += dx;
  }
  column += fitShift(layoutChoiceStack(lens, column, bottom), []);
  const boxes = layoutChoiceStack(lens, column, bottom);
  return { boxes, routes: routeStackLeaders(boxes, rings, column), columnX: column };
}
```

- [ ] **Step 8: Run the leader and layout tests**

Run: `npx vitest run tests/render/leaders.test.ts tests/render/layout.test.ts`
Expected: PASS. The guarantee test takes about 10–20 s.

If the guarantee test reports breaches, **stop**. Do not relax a check or narrow the sweep. Report the failing cases to the user (spec §3).

- [ ] **Step 9: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/render/layout.ts src/render/leaders.ts tests/render/layout.test.ts tests/render/leaders.test.ts
git commit -m "feat(render): choice stack placement and side leaders that never cross (choice-stack spec §2–3)"
```

---

### Task 3: The near typist's choice appears as the stack

**Files:**
- Modify: `src/render/prompts.ts` (imports; remove `HINT_X`/`HINT_X4`; `choicePlates`; `drawTags`)
- Test: `tests/render/prompts.test.ts`

**Interfaces:**
- Consumes: `layoutChoiceStack`/`growUp` (Task 2), `placeChoiceStack`/`routeStackLeaders` (Task 2), `LeaderMark.points` (Task 1).
- Produces: `promptScene` output for a near-owned choice: `plates` stacked, `leaders[i].points` = side routes, `bar` under the stack (then under the locked plate), the `hint` tag above the stack.

- [ ] **Step 1: Write the failing prompt tests**

In `tests/render/prompts.test.ts`:
- Add `import { rallyTargets } from '../../src/core/court';` beside the `receiverSpot, serverSpot` import (merge into one import line).
- Add `import { clamp } from '../../src/core/util';`.

Replace the whole test `it('lays the choice out in the band of the targeted half with rings and leaders, then fades the others after the lock', …)` with:

```ts
  it('stacks the near typist\'s choice where the chase plate was, easy on top, side leaders to the rings (choice-stack spec §2–3)', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnClock(t, 500);
    const a = new PlayerAnimator();
    const chase = scene(view(matchState(t), 350, 1), PREFS, a).plates.find((p) => p.opt.word === 'ball')!.box;
    const s = scene(view(matchState(t), 500, 1), PREFS, a);
    expect(s.plates.map((p) => [p.opt.word, p.style])).toEqual(CHOICE.map((w) => [w, 'localActive']));
    const stack = s.plates.map((p) => p.box);
    stack.slice(1).forEach((b, i) => expect(b.y).toBe(stack[i]!.y + 16 + 3));
    const bottom = stack.at(-1)!;
    expect(bottom.y + bottom.h).toBe(chase.y + chase.h);
    const column = chase.x + (chase.w - 1) / 2;
    for (const b of stack) expect(Math.abs(b.x + (b.w - 1) / 2 - column)).toBeLessThanOrEqual(0.5);

    const targets = returnData().choice.targets.map((p) => project({ ...p, z: 0 }, 1));
    expect(s.rings.map((r) => [r.x, r.y])).toEqual(targets.map((p) => [p.x, p.y]));
    const sides = s.leaders.map((l, i) => {
      const b = stack[i]!;
      const from = l.points[0]!;
      expect(from.y).toBe(b.y + 8);
      expect([b.x - 2, b.x + b.w + 1]).toContain(from.x);
      expect(l.points.at(-1)).toEqual({ x: Math.round(targets[i]!.x), y: Math.round(targets[i]!.y) });
      return from.x < b.x ? 'left' : 'right';
    });
    const mediumLeft = targets[1]!.x < targets[2]!.x;
    expect(sides[1]).toBe(mediumLeft ? 'left' : 'right');
    expect(sides[2]).toBe(mediumLeft ? 'right' : 'left');
    expect(s.bar).toMatchObject({ x: Math.min(...stack.map((b) => b.x)), y: bottom.y + bottom.h + 2 });

    turnInput(t, 'v', 600);
    turnClock(t, 700);
    const locked = scene(view(matchState(t), 700, 1), PREFS, a);
    const volley = locked.plates.find((p) => p.opt.word === 'volley')!;
    expect(volley).toMatchObject({ locked: true, faded: 0, typed: 1 });
    expect(volley.box).toEqual(stack[1]);
    const other = locked.plates.find((p) => p.opt.word === 'drop')!;
    expect(other.faded).toBeGreaterThan(0);
    expect(other.faded).toBeLessThan(1);
    expect(locked.bar).toMatchObject({ x: volley.box.x, w: volley.box.w, y: volley.box.y + volley.box.h + 2 });
  });

  it('stacks player 0\'s choice for a spectator too: remote plates, the name chip on the top plate', () => {
    const t = createTurn(returnData({ owner: 0, striker: 1, choice: { options: CHOICE.map(opt), targets: rallyTargets(1, 1), m: 1 } }));
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnClock(t, 500);
    const s = scene(view(matchState(t), 500, 'spectator'));
    expect(s.plates.map((p) => p.style)).toEqual(['remote', 'remote', 'remote']);
    expect(s.plates.map((p) => p.nameChip)).toEqual(['Alex', null, null]);
    const ys = s.plates.map((p) => p.box.y);
    expect(ys).toEqual([ys[0]!, ys[0]! + 19, ys[0]! + 38]);
    s.leaders.forEach((l, i) => {
      const b = s.plates[i]!.box;
      expect([b.x - 2, b.x + b.w + 1]).toContain(l.points[0]!.x);
    });
    expect(s.bar).toBeNull();
  });
```

In the test "puts the choice in the near band when the targets are on the viewer's half", add before `turnInput(t, 'c', 600);`:

```ts
    // The far typist keeps today's straight leaders from each plate's bottom centre.
    s.leaders.forEach((l, i) => {
      const box = s.plates[i]!.box;
      expect(l.points).toHaveLength(2);
      expect(l.points[0]).toEqual({ x: box.x + Math.floor(box.w / 2), y: box.y + box.h });
    });
```

Rename the test `'fades the completed chase plate out within 100 ms, its timing bar moving to the choice row'` to `'fades the completed chase plate out within 100 ms, its timing bar moving to the choice stack'`. Its body stays the same.

Replace the whole test `it('labels the first choice row "type a first letter" under the row, clear of the far player', …)` with:

```ts
  it('puts "type a first letter" centred on the stack, 2 px above its top plate, inside x 4–476', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnClock(t, 500);
    const vm = view(matchState(t), 500, 1, { overlay: { ...OVERLAY, hintFirstLetter: true } });
    const f = worldFrame(vm);
    const labelW = textWidth('TYPE A FIRST LETTER') + 8;
    for (const x of [-5.8, -3, 0, 3, 5.8]) {
      const far: PlayerPose = { feet: { x: 0, y: -12.2 }, anim: 'idle', frame: 0, view: 'far', flip: false };
      const near: PlayerPose = { feet: { x, y: 12.2 }, anim: 'idle', frame: 0, view: 'near', flip: false };
      const s = promptScene(f, [far, near], {
        prefs: PREFS,
        looks: [vm.pub.players[0].look, vm.pub.players[1].look],
        turnStart: [far.feet, near.feet],
        pop: false,
      });
      const top = s.plates[0]!.box;
      const hint = s.tags.find((g) => g.kind === 'hint');
      expect(hint, `x ${x}`).toBeDefined();
      expect(hint!.y).toBe(top.y - 2 - 11);
      const centre = clamp(top.x + (top.w - 1) / 2, 4 + labelW / 2, 476 - labelW / 2);
      expect(Math.abs(hint!.x - centre)).toBeLessThanOrEqual(0.5);
      const left = Math.round(hint!.x - labelW / 2);
      expect(left).toBeGreaterThanOrEqual(4);
      expect(left + labelW).toBeLessThanOrEqual(476);
    }
    const locked = createTurn(returnData());
    startTurn(locked);
    typeWord(locked, 'ball', 100);
    turnInput(locked, 'd', 600);
    turnClock(locked, 650);
    const after = scene(view(matchState(locked), 650, 1, { overlay: { ...OVERLAY, hintFirstLetter: true } }));
    expect(after.tags.some((g) => g.kind === 'hint')).toBe(false);
  });
```

In `describe('promptScene with the insane option (power-meter spec §6)')`, extend `'shows 4 choice rings and leaders while the meter is full'` with (after its last `expect`):

```ts
    expect(s.plates.map((p) => p.box.w)).toEqual([35, 47, 71, 95]);
    s.plates.slice(1).forEach((p, i) => expect(p.box.y).toBe(s.plates[i]!.box.y + 19));
```

Extend `'after a chase slip shows 3, though 4 targets were pre-picked'` with:

```ts
    expect(s.plates).toHaveLength(3);
    s.leaders.forEach((l, i) => expect(l.tier).toBe(s.plates[i]!.opt.tier));
```

Add after the existing Large-words test:

```ts
  it('Large words: the locked plate doubles upward, keeping its bottom edge, and its leader leaves the doubled box', () => {
    const t = fullMeterReturn('ball');
    const a = new PlayerAnimator();
    const before = scene(view({ ...matchState(t), power: [0, 4] }, 550, 1), PREFS, a).plates.find((p) => p.opt.word === INSANE_WORD)!.box;
    typeWord(t, 'ph', 600);
    const s = scene(view({ ...matchState(t), power: [0, 4] }, 800, 1), { ...PREFS, largeWords: true }, a);
    const big = s.plates.find((p) => p.scale === 2)!;
    expect(big.opt.word).toBe(INSANE_WORD);
    expect(big.box.y + big.box.h).toBe(before.y + before.h);
    const from = s.leaders[3]!.points[0]!;
    expect([big.box.x - 2, big.box.x + big.box.w + 1]).toContain(from.x);
    expect(from.y).toBe(big.box.y + 16);
  });
```

(`CHOICE_4` is `drop` 4, `volley` 6, `crosscourt` 10, `photosynthesis` 14 letters: widths 35 / 47 / 71 / 95.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/render/prompts.test.ts`
Expected: FAIL. The near typist's plates are still a row in the far band. The leaders still start at the plate bottom. The hint is still under the row.

- [ ] **Step 3: Implement the stack in `src/render/prompts.ts`**

Change the layout import to:

```ts
import { growUp, layoutChoice, layoutServeFar, layoutServeNear, layoutSingle, type PlateBox } from './layout';
import { placeChoiceStack, routeStackLeaders } from './leaders';
```

Delete `HINT_X`, `HINT_X4` and their doc comments (lines 99–104), and add in their place:

```ts
/** The first-letter hint's text and width (`drawTag` pads the text by 4 px each side). */
const HINT_TEXT = 'TYPE A FIRST LETTER';
const HINT_W = textWidth(HINT_TEXT) + 8;
```

Replace the whole `choicePlates` function with:

```ts
/**
 * The choice prompt (spec §4.2): for the near typist, a stack where the chase plate was with side
 * leaders (choice-stack spec §2–3); for the far typist, today's row in the near band with straight
 * leaders from each plate's bottom centre. Rings on the targets; the local typist's timing bar under the
 * options (then under the locked one); the first-letter hint above the stack.
 */
function choicePlates(c: Ctx, d: ReturnTurnData, choice: PromptView, style: PlateStyle): void {
  const { f, v, s } = c;
  // A full meter pre-picks 4 targets; a chase slip leaves the prompt showing only the first 3.
  const targets = d.choice.targets.slice(0, choice.options.length).map((p) => groundAt(f, p));
  const lens = choice.options.map((o) => o.len);
  const large = largeOption(c, choice);
  const n = choice.options.length;
  let boxes: PlateBox[];
  let paths: Pt[][];
  let column: number | null = null;
  if (d.owner === f.near) {
    const head = headAt(c, d.owner, c.o.turnStart[d.owner]);
    const rings = targets.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    const placed = placeChoiceStack(lens, head.x, head.y - HEAD_GAP, rings);
    column = placed.columnX;
    boxes = placed.boxes.map((b, i) => (i === large ? growUp(b) : b));
    paths = placed.routes;
    if (large !== null) paths[large] = routeStackLeaders(boxes, rings, placed.columnX)[large]!;
  } else {
    const row = layoutChoice(lens, targets.map((p) => p.x), 'near');
    boxes = row.map((b, i) => (i === large ? doubled(b) : b));
    paths = row.map((b, i) => [{ x: b.x + Math.floor(b.w / 2), y: b.y + b.h }, { x: targets[i]!.x, y: targets[i]!.y }]);
  }
  optionPlates(c, choice, boxes, large, style, d.owner);
  targets.forEach((to, i) => {
    const tier = choice.options[i]!.tier;
    const alpha = 1 - fadeOf(c, n, i);
    s.rings.push({ tier, x: to.x, y: to.y, alpha });
    s.leaders.push({ points: paths[i]!, tier, alpha });
  });
  if (style !== 'localActive' || v.phase !== 'choice') return;
  const share = contactShare(v, d, turnViewAt(c.t, choice.shownAt).simτ);
  s.bar = barUnder(choice.locked === null ? boxes : [boxes[choice.locked]!], share.frac, share.grace);
  if (f.vm.overlay.hintFirstLetter && choice.locked === null && column !== null) {
    const top = Math.min(...boxes.map((b) => b.y));
    const x = clamp(column, AREA.left + HINT_W / 2, AREA.right - HINT_W / 2);
    s.tags.push({ kind: 'hint', x, y: Math.max(AREA.top, top - 2 - TAG_H) });
  }
}
```

In `drawTags`, replace the literal `'TYPE A FIRST LETTER'` with `HINT_TEXT`.

Update the doc comment of `promptScene`: replace "the choice row in the band of the targeted half with rings and leaders;" with "the choice (the near typist's stack or the far typist's row) with rings and leaders;".

Update the `TagMark` doc comment: replace "the first-letter label under the choice row" with "the first-letter label above the choice stack".

- [ ] **Step 4: Run the prompt tests, then the whole render suite**

Run: `npx vitest run tests/render`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

```bash
git add src/render/prompts.ts tests/render/prompts.test.ts
git commit -m "feat(render): the near typist's shot words stack where the chase word was, with side leaders (choice-stack spec §2–3)"
```

---

### Task 4: Cheer for an insane return

**Files:**
- Modify: `src/audio/director.ts` (import `TurnState`; `turnById`, `returnsInsane`; the `strike` case)
- Modify: `src/render/effects.ts` (the `strike` case)
- Test: `tests/audio/director.test.ts`, `tests/render/renderer.test.ts` (`describe('Effects')`)

**Interfaces:**
- Consumes: `PublicState.turn`/`lastTurn`, `ReturnTurnData.chase.tier` (unchanged core types).
- Produces: no new API. It adds an `applause` play and an excitement peak at an insane return's strike.

- [ ] **Step 1: Write the failing director tests**

Append to `tests/audio/director.test.ts`:

```ts
describe('AudioDirector cheer for an insane return (choice-stack spec §4)', () => {
  /** A state whose return turn 7 chases a `tier` word: the current turn, or the last one when `moved`. */
  function returning(tier: Tier, moved = false): PublicState {
    const ret = { data: { turnId: CURRENT_TURN, kind: 'return', chase: { word: 'w', len: 1, tier } }, τ: 1000 };
    return {
      players: [{ name: 'Alex' }, { name: 'Bo' }],
      score: { points: [1, 0] },
      turn: moved ? { data: { turnId: CURRENT_TURN + 1, kind: 'serve' }, τ: 0 } : ret,
      lastTurn: moved ? ret : null,
    } as unknown as PublicState;
  }
  const mine = (tier: Tier): EventBody => ({ ...strike(tier), player: 0 });

  it('applauds when the viewer hits back an insane shot', () => {
    director.onEvents([ev(mine('easy'))], context({ state: returning('insane') }));
    expect(engine.plays).toEqual([
      { name: 'hit', opts: undefined },
      { name: 'applause', opts: undefined },
    ]);
  });

  it("applauds politely when the opponent hits back the viewer's insane shot, and fully for a spectator", () => {
    director.onEvents([ev(strike('medium'))], context({ state: returning('insane') }));
    expect(engine.plays.at(-1)).toEqual({ name: 'applause', opts: { gain: 0.5 } });
    director.onEvents([ev(strike('medium'))], context({ viewer: 'spectator', state: returning('insane') }));
    expect(engine.plays.at(-1)).toEqual({ name: 'applause', opts: undefined });
  });

  it('finds the return turn after it has become the last turn', () => {
    director.onEvents([ev(mine('easy'))], context({ state: returning('insane', true) }));
    expect(engine.names()).toEqual(['hit', 'applause']);
  });

  it('stays quiet for the return of any other tier, and for a serve', () => {
    for (const tier of ['easy', 'medium', 'hard'] as const) director.onEvents([ev(mine('easy'))], context({ state: returning(tier) }));
    director.onEvents([ev({ ...mine('easy'), isServe: true })], context());
    expect(engine.names()).toEqual(['hit', 'hit', 'hit', 'hit']);
  });

  it('an insane return of an insane shot hits hard, goes "ooh" and applauds', () => {
    director.onEvents([ev(mine('insane'))], context({ state: returning('insane') }));
    expect(engine.names()).toEqual(['hitHard', 'ooh', 'applause']);
  });
});
```

- [ ] **Step 2: Write the failing effects test**

In `tests/render/renderer.test.ts`, add `INSANE_WORD` to the import from `'../core/turnFixtures'`. Then add inside `describe('Effects', …)`, after the "cheers points" test:

```ts
  it('cheers the strike that returns an insane shot, and no other strike (choice-stack spec §4)', () => {
    const poses = posesFor(view(matchState(createTurn(serveData())), 0));
    const strikeIn = (turn: number): GameEvent => ({
      turn, τ: 0, type: 'strike', player: 1, word: 'drop', tier: 'easy', kmh: 100, isServe: false, stretch: false, forehand: true,
    });
    for (const [chase, cheers] of [[INSANE_WORD, true], ['volley', false]] as const) {
      const t = createTurn(returnData({ chase: opt(chase) }));
      const fx = new Effects();
      fx.update(worldFrame(view(matchState(t), 0, 0, { events: [strikeIn(8)] })), poses, 16, false);
      if (cheers) expect(fx.crowdExcite, chase).toBeGreaterThanOrEqual(0.69);
      else expect(fx.crowdExcite, chase).toBe(0);
    }
  });
```

(`returnData()` is turn 8. The peak 0.7 decays by 0.3/s × 16 ms to 0.6952. `rallyStrikes` 1 gives no rally floor.)

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/audio/director.test.ts tests/render/renderer.test.ts`
Expected: FAIL. No `applause` at the strike, and `crowdExcite` stays 0.

- [ ] **Step 4: Implement the director cheer**

In `src/audio/director.ts`, add `TurnState` to the `../core/types` import. After `panFor`, add:

```ts
/** The turn of `s` (current or previous) with id `id`, or null. */
function turnById(s: PublicState, id: number): TurnState | null {
  if (s.turn?.data.turnId === id) return s.turn;
  return s.lastTurn?.data.turnId === id ? s.lastTurn : null;
}

/** True when the strike `ev` hits back an insane shot: its turn is a return chasing an insane word (choice-stack spec §4). */
function returnsInsane(ev: GameEvent, s: PublicState): boolean {
  const d = turnById(s, ev.turn)?.data;
  return d?.kind === 'return' && d.chase.tier === 'insane';
}
```

Replace the `case 'strike':` block with:

```ts
        case 'strike':
          this.audio.play(ev.tier === 'hard' || ev.tier === 'insane' ? 'hitHard' : 'hit');
          if (ev.tier === 'insane') this.audio.play('ooh');
          // The crowd cheers the retrieval itself, before the return's own outcome is called.
          if (returnsInsane(ev, ctx.state)) {
            const polite = ctx.viewer !== 'spectator' && ev.player !== ctx.viewer;
            this.audio.play('applause', polite ? { gain: POLITE_APPLAUSE_GAIN } : undefined);
          }
          break;
```

- [ ] **Step 5: Implement the effects cheer**

In `src/render/effects.ts`, replace the start of `case 'strike': {` up to and including `if (o?.kind !== 'strike') return;` with:

```ts
      case 'strike': {
        const t = turnById(f, e.turn);
        // Returning an insane shot draws a cheer, whatever the return's own outcome (choice-stack spec §4).
        if (t?.data.kind === 'return' && t.data.chase.tier === 'insane') this.excite = Math.max(this.excite, EXCITE.point);
        const o = t?.outcome;
        if (o?.kind !== 'strike') return;
```

Also update the class doc comment's "crowd excitement (points, aces, long rallies)" to "crowd excitement (points, aces, long rallies, insane returns)".

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/audio tests/render/renderer.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

```bash
git add src/audio/director.ts src/render/effects.ts tests/audio/director.test.ts tests/render/renderer.test.ts
git commit -m "feat(audio,render): the crowd cheers a returned insane shot (choice-stack spec §4)"
```

---

### Task 5: Art QA shows the stack

**Files:**
- Create: `tools/art/choiceStack.ts`
- Modify: `tools/art.ts:10-22` (register the section)
- Modify: `tools/art/liveMatch.ts` (new moment `stack`)
- Modify: `tools/art/liveScenes.ts:74-79` (doc comment)
- Test: `tests/tools/liveMatch.test.ts`

**Interfaces:**
- Consumes: `placeChoiceStack`, `routeStackLeaders`, `growUp` (Task 2); `drawLeaderPath`, `Pt` (Task 1); `sceneCanvas` (`tools/art/scenes.ts`); `headHeight` (`src/render/prompts.ts`).
- Produces: art section `choice-stack` (exported as `artifacts/art/choice-stack.png`); live moment `stack`.

- [ ] **Step 1: Write the failing live-moment test**

In `tests/tools/liveMatch.test.ts`:
- Change the first moments test to:

```ts
  it('plans the seven moments of the brief, in its order, all seen by player 0', () => {
    expect(plans.map((p) => p.moment.name)).toEqual(['toss', 'chase', 'stack', 'choice', 'point', 'hidden', 'matchpoint']);
    expect(LIVE_VIEWER).toBe(0);
    for (const vm of seen.values()) expect(vm.viewer).toBe(0);
  });
```

- Add after the `chase:` test:

```ts
  it('stack: player 0\'s choice prompt, shown for at least 150 ms and not locked yet', () => {
    const vm = shot('stack');
    const { turn, view } = turnOf(vm);
    expect(turn.data.owner).toBe(0);
    expect(view.phase).toBe('choice');
    const p = activePrompt(view);
    expect(p.kind).toBe('choice');
    expect(p.locked).toBeNull();
    expect(vm.turnτ - p.shownAt).toBeGreaterThanOrEqual(150);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tools/liveMatch.test.ts`
Expected: FAIL. There is no `stack` moment.

- [ ] **Step 3: Add the live moment**

In `tools/art/liveMatch.ts`, after `viewerTyped`, add:

```ts
/** How long after the choice prompt appears the completed chase plate has surely faded out (100 ms fade). */
const STACK_SETTLED_MS = 150;

/** The viewer's choice prompt, shown for at least `STACK_SETTLED_MS` and not locked yet: the whole stack with its leaders. */
function viewerChoosing({ vm, view }: LiveFrame): boolean {
  const p = activePrompt(view);
  return (
    vm.pub.turn?.data.owner === LIVE_VIEWER &&
    view?.phase === 'choice' &&
    p?.kind === 'choice' &&
    p.locked === null &&
    vm.turnτ - p.shownAt >= STACK_SETTLED_MS
  );
}
```

In `LIVE_MOMENTS`, insert between the `chase` and `choice` entries:

```ts
  {
    name: 'stack',
    label: 'choice stack shown, nothing locked yet',
    shows: viewerChoosing,
  },
```

Update the `LIVE_MOMENTS` doc comment: replace "the viewer chasing mid-way and with a choice locked" with "the viewer chasing mid-way, choosing from the stack and with a choice locked". In `tools/art/liveScenes.ts`, update `drawLiveSceneSections`'s doc comment: replace "the chase mid-way, a locked choice" with "the chase mid-way, the choice stack, a locked choice".

- [ ] **Step 4: Run the tool tests**

Run: `npx vitest run tests/tools`
Expected: PASS. The "finds every moment on every surface, on the same frames" test also covers `stack`.

- [ ] **Step 5: Add the `choice-stack` art section**

Create `tools/art/choiceStack.ts`:

```ts
import { insaneRallyTarget, rallyTargets } from '../../src/core/court';
import type { Look, Tier, WordOption } from '../../src/core/types';
import { growUp } from '../../src/render/layout';
import { placeChoiceStack, routeStackLeaders } from '../../src/render/leaders';
import { drawLeaderPath, drawPlate, drawTierRing, type PlateDraw, type Pt } from '../../src/render/plates';
import { project } from '../../src/render/projection';
import { headHeight } from '../../src/render/prompts';
import { addFigure, addHeading, addRow, addSection, scaled } from './dom';
import { sceneCanvas } from './scenes';

const TIERS: readonly Tier[] = ['easy', 'medium', 'hard', 'insane'];
/** The longest word of each tier's band, so the pyramid is as wide as it gets. */
const WORDS = ['kite', 'lantern', 'grasshopper', 'internationally'];
/** Alex's look (tools/art/liveMatch.ts), for the head the stack sits on. */
const LOOK: Look = { skin: 1, hairStyle: 0, hair: 1, shirt: 6, shorts: 0, headband: null, racket: 0 };
/** Stack columns: near each screen edge, both serve-return spots (about 80 px off centre) and the centre. */
const COLUMNS = [40, 158, 240, 322, 440];
/** The receiver's spot, 12.5 m behind the net. */
const DEPTH = 12.5;
const BIG = 2;
/** The locked option in the Large-words close-up: hard, at 2×. */
const LOCKED = 2;

const optionOf = (word: string, i: number): WordOption => ({ word, len: word.length, tier: TIERS[i]! });

/** The far half's rally rings for viewer 0, medium's side `m`, rounded as `drawTierRing` draws them. */
function ringsFor(m: 1 | -1, n: number): Pt[] {
  return [...rallyTargets(1, m), insaneRallyTarget(1, m)].slice(0, n).map((p) => {
    const q = project({ ...p, z: 0 }, 0);
    return { x: Math.round(q.x), y: Math.round(q.y) };
  });
}

function plateDraw(box: PlateDraw['box'], opt: WordOption, over: Partial<PlateDraw>): PlateDraw {
  return {
    box, opt, typed: 0, locked: false, faded: 0, style: 'localActive', lastWrongAgeMs: null,
    isNextCursor: false, showInitialBlock: true, nameChip: null, oppColor: null, scale: 1, reduceEffects: false,
    ...over,
  };
}

/**
 * One 480×270 frame: the static hard-court scene for viewer 0 with the near player's choice stack of
 * `n` words at `column`, its rings and side leaders; with `lock`, the hard word locked at 2× (Large
 * words) with 4 letters typed and the rest half faded, the way they look mid-fade.
 */
function stackCanvas(n: 3 | 4, m: 1 | -1, column: number, lock = false): HTMLCanvasElement {
  const canvas = sceneCanvas('hard', 0, { crowdExcite: 0, umpireLook: 0, t: 0 });
  const g = canvas.getContext('2d')!;
  const words = WORDS.slice(0, n).map(optionOf);
  const rings = ringsFor(m, n);
  const feetY = Math.round(project({ x: 0, y: -DEPTH, z: 0 }, 0).y);
  const placed = placeChoiceStack(words.map((w) => w.len), column, feetY - headHeight(LOOK, 'near') - 4, rings);
  const boxes = placed.boxes.map((b, i) => (lock && i === LOCKED ? growUp(b) : b));
  const routes = placed.routes.slice();
  if (lock) routes[LOCKED] = routeStackLeaders(boxes, rings, placed.columnX)[LOCKED]!;
  const alpha = (i: number): number => (lock && i !== LOCKED ? 0.5 : 1);
  routes.forEach((r, i) => {
    g.globalAlpha = alpha(i);
    drawLeaderPath(g, r, words[i]!.tier);
  });
  rings.forEach((r, i) => {
    g.globalAlpha = alpha(i);
    drawTierRing(g, words[i]!.tier, r.x, r.y);
  });
  g.globalAlpha = 1;
  const order = boxes.map((_, i) => i).sort((a, b) => Number(lock && a === LOCKED) - Number(lock && b === LOCKED));
  for (const i of order) {
    const locked = lock && i === LOCKED;
    const over: Partial<PlateDraw> = lock
      ? { faded: locked ? 0 : 0.5, locked, typed: locked ? 4 : 0, isNextCursor: locked, showInitialBlock: false, scale: locked ? 2 : 1 }
      : {};
    drawPlate(g, plateDraw(boxes[i]!, words[i]!, over));
  }
  return canvas;
}

/**
 * Section `choice-stack` (choice-stack spec §2–3, §6): the near player's choice stack over the hard
 * court at five columns, 3 and 4 words, medium's side left and right, at 1×; then 2× close-ups of a
 * centred stack, a serve-return stack, an edge stack and a hard word locked at 2× (Large words).
 */
export function drawChoiceStackSection(parent: HTMLElement): void {
  const section = addSection(
    parent,
    'choice-stack',
    "choice stack: the near player's shot words stacked where the chase word was, side leaders to the rings",
  );
  for (const n of [3, 4] as const) {
    for (const m of [1, -1] as const) {
      const rings = ringsFor(m, 3);
      const row = addRow(section, `${n} words, medium ${rings[1]!.x < rings[2]!.x ? 'left' : 'right'}`);
      for (const column of COLUMNS) addFigure(row, stackCanvas(n, m, column), `column x ${column}`);
    }
  }
  const closeUps: [string, HTMLCanvasElement][] = [
    ['4 words, centred', stackCanvas(4, 1, 240)],
    ['4 words, serve-return spot', stackCanvas(4, 1, 158)],
    ['4 words at the right edge', stackCanvas(4, -1, 440)],
    ['hard locked at 2× (Large words), the rest fading', stackCanvas(4, 1, 240, true)],
  ];
  for (const [label, canvas] of closeUps) {
    addHeading(section, `${BIG}×: ${label}`);
    addFigure(section, scaled(canvas, BIG));
  }
}
```

In `tools/art.ts`, add `import { drawChoiceStackSection } from './art/choiceStack';` (keep the imports sorted by path), and add `['choice stack', drawChoiceStackSection],` to `PARTS` right after `['rings', drawRingsSection],`.

- [ ] **Step 6: Typecheck, test, export and look**

Run: `npm run typecheck && npm test`
Expected: PASS.

Run: `npm run art:export`
Expected: it prints the PNG paths, including `artifacts/art/choice-stack.png`.

Open `artifacts/art/choice-stack.png` and `artifacts/art/scene-live-hard.png` with the Read tool and check:
- every stack sits above where the player's head would be;
- the plates are a pyramid, easy on top;
- each leader leaves a plate side and reaches the ring of the plate's colour;
- no leaders touch or cross;
- the Large-words close-up grows upward;
- the live `stack` shot shows the real stack above Alex.

- [ ] **Step 7: Commit**

```bash
git add tools/art/choiceStack.ts tools/art.ts tools/art/liveMatch.ts tools/art/liveScenes.ts tests/tools/liveMatch.test.ts
git commit -m "docs(art): art QA shows the choice stack, static and live"
```

---

### Task 6: Docs and full verification

**Files:**
- Modify: `README.md:37-38`
- Modify: `docs/superpowers/specs/2026-09-26-black-belt-tennis-design.md:138`, `:379-384`, `:390`, §4.4 audio paragraph

- [ ] **Step 1: Update the README**

In `README.md`, replace:

```
the ball (the chase). Three shot words then appear on your opponent's side: type the first letter of
one to pick it, and finish it before the ball reaches you.
```

with:

```
the ball (the chase). Three shot words then appear in a stack where the chase word was, each joined
by a line to the spot it aims for on your opponent's side: type the first letter of one to pick it,
and finish it before the ball reaches you.
```

- [ ] **Step 2: Amend the main spec**

In `docs/superpowers/specs/2026-09-26-black-belt-tennis-design.md`:

1. §3.3 item 3 (line 138): replace `chase emptied it) on the **opponent's half**, visible to both players with live` with `chase emptied it) aimed at the **opponent's half** (the near typist's words stack above its head; amended: choice-stack spec 2026-09-28), visible to both players with live`.

2. §4.2 Layout (lines 379–384): replace the bullet that begins `  - Choice plates use three fixed slots` (through `tier-coloured leader (1 px dark outline).`) with:

```
  - **Near typist's choice** (the player drawn at the bottom; amended: choice-stack spec 2026-09-28
    §2–3): a stack where the chase plate was: easy on top, then medium, hard[, insane], 3 px gaps,
    each plate centred on the chase plate's column, the bottom plate's bottom edge 4 px above the
    head at turn start. The stack stays ≥ 8 px below the lowest ring centre and inside the plate
    area, shifted as one unit with its leaders. Each leader leaves the middle of a plate side
    (medium and insane from medium's side, hard from the other, easy from the side facing its ring)
    and runs straight out and up to its ring, or up a lane beside the stack (lanes 4 px apart, lower
    plates outermost) and across. No two leaders touch; none crosses another plate or ring.
  - **Far typist's choice**: three fixed slots in the band of the targeted half, slot centres
    x = 90 / 240 / 390; easy always in the centre slot, medium and hard in the left/right slot on
    their target's side. With the insane option (4 plates) the slot centres are x = 60 / 180 / 300 /
    420, handed out in the order of the targets' screen x, so insane is outermost on medium's side
    (amended: power-meter spec 2026-09-27). Each plate joins its ground ring with a 1 px
    tier-coloured leader (1 px dark outline) from its bottom centre.
```

3. §4.2 Large words (line 391): replace `place, clamped to x 4–476). Unlocked options stay 1×.` with `place, clamped to x 4–476; a locked stack plate grows upward, keeping its bottom edge: choice-stack spec 2026-09-28 §2). Unlocked options stay 1×.`

4. §4.4 Audio: after `an insane strike plays the hard hit and the crowd "ooh".`, add ` Returning an insane shot draws applause at the return's strike (polite for the opponent's return), and the crowd raises its arms (amended: choice-stack spec 2026-09-28 §4).`

- [ ] **Step 3: Full verification**

Run each and read its output:
- `npm run typecheck`: expect PASS.
- `npm test`: expect every file to pass.
- `npm run build`: expect a production build in `dist/`.
- `npm run e2e`: expect PASS for scenarios 1–4, and PASS or WARN (broker unreachable) for 5.

Open `artifacts/e2e/4-match-choice.png` and `artifacts/e2e/4-match-chase.png` with the Read tool. Confirm that the choice appears above the player where the chase plate was, with side leaders.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-09-26-black-belt-tennis-design.md
git commit -m "docs: README and main spec follow the choice stack, side leaders and the insane-return cheer"
```
