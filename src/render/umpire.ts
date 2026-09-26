import type { Surface } from '../core/types';
import { paintGrid } from './court';
import { OUTLINE, PAL } from './palette';
import { project } from './projection';
import type { SceneState } from './scene';
import { cachedLayer, createLayer, type Layer } from './screen';

// Umpire on a high chair beside the screen-right net post, head turning towards the ball.

/** o outline, G/g chair green, b/B blazer, c/C trousers and shirt, s/S skin, h hair, k eyes, w shoes. */
const CHAIR = [
  '..........................',
  '..........................',
  '..................ooo.....',
  '..................oGo.....',
  '..................oGo.....',
  '..................oGo.....',
  '..................oGo.....',
  '.........ooooooo..oGo.....',
  '........obbbccbbo.oGo.....',
  '.......obbbbcbbbBooGo.....',
  '.......obbbbbbbbBooGo.....',
  '.......obbbbbbbbBooGo.....',
  '......obbbbbbbbbBooGo.....',
  '......obboobbbbbBooGo.....',
  '.....osbbbbboobbBooGo.....',
  '....oSsoooooccbbBooGo.....',
  '....ooocccccccccCooGo.....',
  '.....occcccccccccCoGo.....',
  '.....occoooooooooooGoo....',
  '.....occoGGGGGGGGGGGGGo...',
  '.....occogggggggggggggo...',
  '.....occoooooooooooooooo..',
  '.....occo.oGo.....oGo.....',
  '.....occo.oGo.....oGo.....',
  '....owwwo.oGo.....oGo.....',
  '...owwwwwooGo.....oGo.....',
  '.ooooooooooGoooooooGo.....',
  '.oGGGGGGGGGGGGGGGGGGo.....',
  '.ooooooooooGoooooooGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGooooooooGo....',
  '..........oGGGGGGGGGGo....',
  '..........oGooooooooGo....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGooooooooGo....',
  '..........oGGGGGGGGGGo....',
  '..........oGooooooooGo....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '.........oGGGo...oGGGo....',
  '.........ooooo...ooooo....',
];

/** Head frames 7×8 (placed with the chin row on the collar): far end, across the court, near end. */
const HEADS: Record<-1 | 0 | 1, string[]> = {
  [-1]: ['.ooooo.', 'ohhhhho', 'ohhhhho', 'ohhhhho', 'oShhhho', 'osShhho', '.oSSho.', '..oso..'],
  [0]: ['.ooooo.', 'ohhhhho', 'osshhho', 'oksshho', 'osssSho', '.osSSho', '..oSSo.', '..oso..'],
  [1]: ['.ooooo.', 'ohhhhho', 'ohssshh', 'oskskho', 'osssSho', 'oossSho', '..oSSo.', '..oso..'],
};
const HEAD_AT = { x: 9, y: 0 };

const UMPIRE_COLORS: Record<string, string> = {
  o: OUTLINE,
  G: PAL.boardGreenHi,
  g: PAL.boardGreen,
  b: PAL.crowdBlue,
  B: PAL.hardLo,
  c: PAL.cream,
  C: PAL.silver,
  s: PAL.skinLight,
  S: PAL.clayDust,
  h: PAL.slate,
  k: PAL.ink,
  w: PAL.shadow,
};

/** World x of the umpire chair (beside the right-hand net post as the stadium camera sees it). */
const UMPIRE_X = 7.9;
/** Column of `CHAIR` that stands on `UMPIRE_X`. */
const CHAIR_ANCHOR = 12;

/** Screen position of the chair grid's top-left pixel (the same for every viewer). */
function chairOrigin(): { x: number; y: number } {
  const foot = project({ x: UMPIRE_X, y: 0, z: 0 }, 0);
  return { x: Math.floor(foot.x) - CHAIR_ANCHOR, y: Math.floor(foot.y) - CHAIR.length + 1 };
}

/** Contact shadow as `CHAIR` grid spans [row, first column, last column]: a flat ellipse around the feet. */
const CHAIR_SHADOW: readonly (readonly [number, number, number])[] = [
  [50, 7, 23],
  [51, 6, 24],
  [52, 8, 22],
];

/** Shadow tone per surface: darker than every shade of the surround the chair stands on. */
const SHADOW_TONE: Record<Surface, string> = {
  hard: PAL.boardGreen,
  clay: PAL.clayDeep,
  grass: PAL.boardGreen,
  dojo: PAL.tatamiLo,
};

/**
 * Paints the umpire chair's ground contact shadow on `surface` into `g`, shifted `dy` rows (for a
 * layer whose top is not the screen's): one solid tone, drawn before the chair so the feet stand on it.
 */
export function paintChairShadow(g: CanvasRenderingContext2D, surface: Surface, dy: number): void {
  const at = chairOrigin();
  g.fillStyle = SHADOW_TONE[surface];
  for (const [row, from, to] of CHAIR_SHADOW) g.fillRect(at.x + from, at.y + row + dy, to - from + 1, 1);
}

function paintUmpire(look: -1 | 0 | 1): Layer {
  const layer = createLayer(CHAIR[0]!.length, CHAIR.length);
  paintGrid(layer.g, CHAIR, UMPIRE_COLORS, 0, 0);
  paintGrid(layer.g, HEADS[look], UMPIRE_COLORS, HEAD_AT.x, HEAD_AT.y);
  return layer;
}

const umpires = new Map<-1 | 0 | 1, Layer>();

/**
 * Paints the umpire on the high chair beside the screen-right net post (the stadium does not rotate
 * with the viewer), head turned per `s.umpireLook`. Three cached frames; one blit per call. The
 * chair's ground shadow belongs to the net layer (`paintChairShadow`), which knows the surface.
 */
export function drawUmpire(ctx: CanvasRenderingContext2D, s: SceneState): void {
  const look: -1 | 0 | 1 = s.umpireLook === -1 || s.umpireLook === 1 ? s.umpireLook : 0;
  const frame = cachedLayer(umpires, look, () => paintUmpire(look));
  const at = chairOrigin();
  ctx.drawImage(frame.canvas, at.x, at.y);
}
