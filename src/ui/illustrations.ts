import type { Look, Tier, WordOption } from '../core/types';
import { drawText } from '../render/font';
import { plateWidth } from '../render/layout';
import { OUTLINE, PAL, SURFACE_PAL } from '../render/palette';
import { drawLeader, drawPlate, drawTierRing, drawTimingBar, type PlateDraw } from '../render/plates';
import { buildSheet, drawPlayer } from '../render/sprites/sheet';
import { rect } from './paint';

/** Size of every How to Play illustration, in game pixels (CSS shows one per `--u`). */
export const ILLUSTRATION = { w: 116, h: 56 } as const;

type Paint = (g: CanvasRenderingContext2D, look: Look) => void;

const opt = (word: string, tier: Tier): WordOption => ({ word, len: word.length, tier });

/** A local-active plate at (x, y), 1×, with the given typing state. */
function plate(g: CanvasRenderingContext2D, o: WordOption, x: number, y: number, state: Partial<PlateDraw> = {}): void {
  drawPlate(g, {
    box: { x, y, w: plateWidth(o.len), h: 16, option: 0 },
    opt: o,
    typed: 0,
    locked: false,
    faded: 0,
    style: 'localActive',
    lastWrongAgeMs: null,
    isNextCursor: false,
    showInitialBlock: true,
    nameChip: null,
    oppColor: null,
    scale: 1,
    reduceEffects: true,
    ...state,
  });
}

/** Night backdrop with a strip of hard court (surround, court, a white line) along the bottom. */
function ground(g: CanvasRenderingContext2D, top: number): void {
  const { court, surround, lines } = SURFACE_PAL.hard;
  rect(g, 0, 0, ILLUSTRATION.w, ILLUSTRATION.h, PAL.night);
  rect(g, 0, top, ILLUSTRATION.w, ILLUSTRATION.h - top, surround[1]!);
  rect(g, 6, top + 3, ILLUSTRATION.w - 12, ILLUSTRATION.h - top - 3, court[1]!);
  rect(g, 6, top + 3, ILLUSTRATION.w - 12, 1, lines);
}

/** The ball: 3×3 core with a 1 px outline, centred on (x, y). */
function ball(g: CanvasRenderingContext2D, x: number, y: number): void {
  rect(g, x - 2, y - 1, 5, 3, OUTLINE);
  rect(g, x - 1, y - 2, 3, 5, OUTLINE);
  rect(g, x - 1, y - 1, 3, 3, PAL.ball);
  rect(g, x + 1, y + 1, 1, 1, PAL.ballShade);
}

/** Bitmap-font text with a 1 px dark outline. */
function label(g: CanvasRenderingContext2D, s: string, x: number, y: number, color: string): void {
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) drawText(g, s, x + dx, y + dy, OUTLINE);
  drawText(g, s, x, y, color);
}

/** Serve: SPACE tosses the ball, then any of three words hits it. */
const serve: Paint = (g, look) => {
  ground(g, 44);
  const sheet = buildSheet(look);
  drawPlayer(g, sheet, 'serve', 'near', 1, 20, 53);
  ball(g, 14, 5);
  plate(g, opt('cat', 'easy'), 43, 2);
  plate(g, opt('garden', 'medium'), 43, 21);
  plate(g, opt('lighthouse', 'hard'), 43, 40);
};

/** Choose: the first letter picks the shot; harder words aim wider, towards the sideline. */
const choose: Paint = (g) => {
  ground(g, 20);
  rect(g, ILLUSTRATION.w - 8, 23, 1, ILLUSTRATION.h - 23, SURFACE_PAL.hard.lines);
  const words = [opt('tree', 'easy'), opt('candle', 'medium'), opt('motorcycle', 'hard')];
  const rings: [number, number][] = [
    [80, 27],
    [96, 40],
    [106, 51],
  ];
  words.forEach((w, i) => {
    const [rx, ry] = rings[i]!;
    drawLeader(g, { x: plateWidth(w.len), y: 10 + 18 * i }, { x: rx, y: ry }, w.tier);
    drawTierRing(g, w.tier, rx, ry);
  });
  words.forEach((w, i) => plate(g, w, 2, 2 + 18 * i));
};

/** Chase: type the word the opponent hit to run to the ball, then choose a shot. */
const chase: Paint = (g, look) => {
  ground(g, 40);
  const sheet = buildSheet(look);
  const word = opt('garden', 'medium');
  plate(g, word, 46, 3, { typed: 3, locked: true, isNextCursor: true, showInitialBlock: false });
  drawTimingBar(g, 46, 21, plateWidth(word.len), 0.55, false);
  drawPlayer(g, sheet, 'runRight', 'near', 2, 20, 53);
  ball(g, 104, 34);
  for (let x = 40; x < 98; x += 4) rect(g, x, 47, 2, 1, PAL.white);
};

/** Typos: wrong keys don't advance and make the shot riskier, so it can land out. */
const typos: Paint = (g) => {
  ground(g, 30);
  const word = opt('kitchen', 'medium');
  plate(g, word, 4, 4, { typed: 3, locked: true, isNextCursor: true, showInitialBlock: false, lastWrongAgeMs: 20 });
  const { lines } = SURFACE_PAL.hard;
  rect(g, 78, 33, 1, ILLUSTRATION.h - 33, lines);
  ball(g, 94, 44);
  rect(g, 91, 47, 7, 1, OUTLINE);
  label(g, 'OUT', 84, 22, PAL.tierYellow);
};

/** The four How to Play illustrations, in reading order. */
export const ILLUSTRATIONS: readonly { id: string; paint: Paint }[] = [
  { id: 'serve', paint: serve },
  { id: 'choose', paint: choose },
  { id: 'chase', paint: chase },
  { id: 'typos', paint: typos },
];

/** A canvas with illustration `paint` drawn for `look` (the player's own look); blank where 2D canvas is unavailable. */
export function illustration(paint: Paint, look: Look): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = ILLUSTRATION.w;
  c.height = ILLUSTRATION.h;
  c.className = 'illustration';
  const g = c.getContext('2d');
  if (g) {
    g.imageSmoothingEnabled = false;
    try {
      paint(g, look);
    } catch {
      // A drawing failure leaves the canvas blank; the text still explains the rule.
    }
  }
  return c;
}
