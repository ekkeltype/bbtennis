import { insaneRallyTarget, rallyTargets } from '../../src/core/court';
import type { Look, Tier, WordOption } from '../../src/core/types';
import { besideColumn, growAway, plateWidth } from '../../src/render/layout';
import { placeChoiceStack, routeStackLeaders, type Facing } from '../../src/render/leaders';
import { PAL } from '../../src/render/palette';
import { drawLeaderPath, drawPlate, drawTierRing, type PlateDraw, type Pt } from '../../src/render/plates';
import { project } from '../../src/render/projection';
import { headHeight } from '../../src/render/prompts';
import { buildSheet, drawPlayer } from '../../src/render/sprites/sheet';
import { addFigure, addHeading, addRow, addSection, scaled } from './dom';
import { sceneCanvas } from './scenes';

const TIERS: readonly Tier[] = ['easy', 'medium', 'hard', 'insane'];
/** The longest word of each tier's band, so the pyramid is as wide as it gets. */
const WORDS = ['kite', 'lantern', 'grasshopper', 'internationally'];
/** Alex's look (tools/art/liveMatch.ts), for the player the stack sits beside (both ends). */
const LOOK: Look = { skin: 1, hairStyle: 0, hair: 1, shirt: 6, shorts: 0, headband: null, racket: 0 };
/**
 * Hitting spots (m): near each sideline, both serve-return spots and the centre, deep; and a serve
 * return that ran in to 9 m, where the stack moves down to clear the rings and sits beside the player.
 */
const SPOTS: readonly { x: number; depth: number; label: string }[] = [
  { x: -5.5, depth: 12.2, label: 'left sideline' },
  { x: -3, depth: 12.5, label: 'serve return, left' },
  { x: 0, depth: 12.2, label: 'centre' },
  { x: 3, depth: 12.5, label: 'serve return, right' },
  { x: 5.5, depth: 12.2, label: 'right sideline' },
  { x: -2, depth: 9, label: 'ran in to 9 m' },
];
const BIG = 2;
/** The locked option in the Large-words close-up: hard, at 2×. */
const LOCKED = 2;

const optionOf = (word: string, i: number): WordOption => ({ word, len: word.length, tier: TIERS[i]! });

/** Which typist a frame shows: the near player (player 0) or the far one (player 1), as viewer 0 sees them. */
type Who = 'near' | 'far';

/** `who`'s rings for viewer 0 (on the other half), medium's side `m`, rounded as `drawTierRing` draws them. */
function ringsFor(who: Who, m: 1 | -1, n: number): Pt[] {
  const dest = who === 'near' ? 1 : 0;
  return [...rallyTargets(dest, m), insaneRallyTarget(dest, m)].slice(0, n).map((p) => {
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
 * One 480×270 frame: the static hard-court scene for viewer 0 with `who` standing on `spot`, their
 * choice stack of `n` words beside them, its rings and side leaders: the near player's as the local
 * typist sees their own, the far one's as remote plates with the name chip on top. With `lock`, the
 * hard word locked at 2× (Large words) with 4 letters typed and the rest half faded, the way they look
 * mid-fade. Leaders go under the player and the plates over everything, as in a match.
 */
function stackCanvas(who: Who, n: 3 | 4, m: 1 | -1, spot: { x: number; depth: number }, lock = false): HTMLCanvasElement {
  const canvas = sceneCanvas('hard', 0, { crowdExcite: 0, umpireLook: 0, t: 0 });
  const g = canvas.getContext('2d')!;
  const words = WORDS.slice(0, n).map(optionOf);
  const rings = ringsFor(who, m, n);
  const facing: Facing = who === 'near' ? 'up' : 'down';
  const feet = project({ x: spot.x, y: who === 'near' ? -spot.depth : spot.depth, z: 0 }, 0);
  const lens = words.map((w) => w.len);
  const column = besideColumn(feet.x, Math.max(...lens.map((len) => plateWidth(len))));
  const placed = placeChoiceStack(lens, column, Math.round(feet.y) - headHeight(LOOK, who), rings, facing);
  const awayX = placed.columnX > Math.round(feet.x) ? 1 : -1;
  const boxes = placed.boxes.map((b, i) => (lock && i === LOCKED ? growAway(b, awayX, facing === 'up' ? 1 : -1) : b));
  const routes = placed.routes.slice();
  if (lock) routes[LOCKED] = routeStackLeaders(boxes, rings, placed.columnX, facing)[LOCKED]!;
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
  drawPlayer(g, buildSheet(LOOK), 'idle', who, 0, feet.x, feet.y);
  const order = boxes.map((_, i) => i).sort((a, b) => Number(lock && a === LOCKED) - Number(lock && b === LOCKED));
  const chipOn = lock ? LOCKED : who === 'near' ? 0 : n - 1;
  for (const i of order) {
    const locked = lock && i === LOCKED;
    const over: Partial<PlateDraw> = lock
      ? { faded: locked ? 0 : 0.5, locked, typed: locked ? 4 : 0, isNextCursor: locked && who === 'near', showInitialBlock: false, scale: locked ? 2 : 1 }
      : {};
    const remote: Partial<PlateDraw> = who === 'far'
      ? { style: 'remote', showInitialBlock: false, nameChip: i === chipOn ? 'BRU' : null, oppColor: PAL.grey }
      : {};
    drawPlate(g, plateDraw(boxes[i]!, words[i]!, { ...over, ...remote }));
  }
  return canvas;
}

/**
 * Section `choice-stack` (choice-stack spec §2–3, §6): each typist's choice stack beside their hitting
 * spot over the hard court as viewer 0 sees it, the near player's (easy on top) then the far one's
 * (easy at the bottom), at six spots, 3 and 4 words, medium's side left and right, at 1×; then 2×
 * close-ups: centred, a serve return, a player who ran in to 9 m and a hard word locked at 2× (Large
 * words), near and far.
 */
export function drawChoiceStackSection(parent: HTMLElement): void {
  const section = addSection(
    parent,
    'choice-stack',
    "choice stack: each player's shot words stacked beside their hitting spot, side leaders to the rings",
  );
  for (const who of ['near', 'far'] as const) {
    for (const n of [3, 4] as const) {
      for (const m of [1, -1] as const) {
        const rings = ringsFor(who, m, 3);
        const row = addRow(section, `${who}, ${n} words, medium ${rings[1]!.x < rings[2]!.x ? 'left' : 'right'}`);
        for (const spot of SPOTS) addFigure(row, stackCanvas(who, n, m, spot), spot.label);
      }
    }
  }
  const closeUps: [string, HTMLCanvasElement][] = [
    ['near, 4 words, centre', stackCanvas('near', 4, 1, SPOTS[2]!)],
    ['near, 4 words, serve return on the left', stackCanvas('near', 4, 1, SPOTS[1]!)],
    ['near, 4 words, ran in to 9 m', stackCanvas('near', 4, -1, SPOTS[5]!)],
    ['near, hard locked at 2× (Large words), the rest fading', stackCanvas('near', 4, 1, SPOTS[2]!, true)],
    ['far, 4 words, centre', stackCanvas('far', 4, 1, SPOTS[2]!)],
    ['far, 4 words, serve return on the right', stackCanvas('far', 4, -1, SPOTS[3]!)],
    ['far, hard locked at 2× (Large words), the rest fading', stackCanvas('far', 4, 1, SPOTS[2]!, true)],
  ];
  for (const [label, canvas] of closeUps) {
    addHeading(section, `${BIG}×: ${label}`);
    addFigure(section, scaled(canvas, BIG));
  }
}
