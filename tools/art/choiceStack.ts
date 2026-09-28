import { insaneRallyTarget, rallyTargets } from '../../src/core/court';
import type { Look, Tier, WordOption } from '../../src/core/types';
import { besideColumn, growUp, plateWidth } from '../../src/render/layout';
import { placeChoiceStack, routeStackLeaders } from '../../src/render/leaders';
import { drawLeaderPath, drawPlate, drawTierRing, type PlateDraw, type Pt } from '../../src/render/plates';
import { project } from '../../src/render/projection';
import { headHeight } from '../../src/render/prompts';
import { buildSheet, drawPlayer } from '../../src/render/sprites/sheet';
import { addFigure, addHeading, addRow, addSection, scaled } from './dom';
import { sceneCanvas } from './scenes';

const TIERS: readonly Tier[] = ['easy', 'medium', 'hard', 'insane'];
/** The longest word of each tier's band, so the pyramid is as wide as it gets. */
const WORDS = ['kite', 'lantern', 'grasshopper', 'internationally'];
/** Alex's look (tools/art/liveMatch.ts), for the player the stack sits beside. */
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
 * One 480×270 frame: the static hard-court scene for viewer 0 with the near player standing on
 * `spot`, their choice stack of `n` words beside them, its rings and side leaders; with `lock`, the
 * hard word locked at 2× (Large words) with 4 letters typed and the rest half faded, the way they look
 * mid-fade. Leaders go under the player and the plates over everything, as in a match.
 */
function stackCanvas(n: 3 | 4, m: 1 | -1, spot: { x: number; depth: number }, lock = false): HTMLCanvasElement {
  const canvas = sceneCanvas('hard', 0, { crowdExcite: 0, umpireLook: 0, t: 0 });
  const g = canvas.getContext('2d')!;
  const words = WORDS.slice(0, n).map(optionOf);
  const rings = ringsFor(m, n);
  const feet = project({ x: spot.x, y: -spot.depth, z: 0 }, 0);
  const lens = words.map((w) => w.len);
  const column = besideColumn(feet.x, Math.max(...lens.map((len) => plateWidth(len))));
  const placed = placeChoiceStack(lens, column, Math.round(feet.y) - headHeight(LOOK, 'near'), rings);
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
  drawPlayer(g, buildSheet(LOOK), 'idle', 'near', 0, feet.x, feet.y);
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
 * Section `choice-stack` (choice-stack spec §2–3, §6): the near player's choice stack beside their
 * hitting spot over the hard court, at six spots, 3 and 4 words, medium's side left and right, at 1×;
 * then 2× close-ups of a centred stack, a serve-return stack, a player who ran in to 9 m and a hard
 * word locked at 2× (Large words).
 */
export function drawChoiceStackSection(parent: HTMLElement): void {
  const section = addSection(
    parent,
    'choice-stack',
    "choice stack: the near player's shot words stacked beside their hitting spot, side leaders to the rings",
  );
  for (const n of [3, 4] as const) {
    for (const m of [1, -1] as const) {
      const rings = ringsFor(m, 3);
      const row = addRow(section, `${n} words, medium ${rings[1]!.x < rings[2]!.x ? 'left' : 'right'}`);
      for (const spot of SPOTS) addFigure(row, stackCanvas(n, m, spot), spot.label);
    }
  }
  const closeUps: [string, HTMLCanvasElement][] = [
    ['4 words, centre', stackCanvas(4, 1, SPOTS[2]!)],
    ['4 words, serve return on the left', stackCanvas(4, 1, SPOTS[1]!)],
    ['4 words, ran in to 9 m', stackCanvas(4, -1, SPOTS[5]!)],
    ['hard locked at 2× (Large words), the rest fading', stackCanvas(4, 1, SPOTS[2]!, true)],
  ];
  for (const [label, canvas] of closeUps) {
    addHeading(section, `${BIG}×: ${label}`);
    addFigure(section, scaled(canvas, BIG));
  }
}
