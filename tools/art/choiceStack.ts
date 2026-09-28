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
