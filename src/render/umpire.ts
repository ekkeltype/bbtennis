import { paintGrid } from './court';
import { OUTLINE, PAL } from './palette';
import { project } from './projection';
import type { SceneState } from './scene';
import { cachedLayer, createLayer, type Layer } from './screen';

// Umpire on a high chair beside the screen-right net post, head turning towards the ball.

/** o outline, G/g chair green, b/B blazer, c/C trousers and shirt, s/S skin, h hair, k shoes. */
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
  '.....occo.oGo.....oGo.....',
  '....okkko.oGo.....oGo.....',
  '...okkkkooGGooooooGGo.....',
  '...oooooGGGGGGGGGGGGo.....',
  '........oooGoooooooGo.....',
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
};

/** World x of the umpire chair (beside the right-hand net post as the stadium camera sees it). */
const UMPIRE_X = 7.9;
/** Column of `CHAIR` that stands on `UMPIRE_X`. */
const CHAIR_ANCHOR = 12;

function paintUmpire(look: -1 | 0 | 1): Layer {
  const layer = createLayer(CHAIR[0]!.length, CHAIR.length);
  paintGrid(layer.g, CHAIR, UMPIRE_COLORS, 0, 0);
  paintGrid(layer.g, HEADS[look], UMPIRE_COLORS, HEAD_AT.x, HEAD_AT.y);
  return layer;
}

const umpires = new Map<-1 | 0 | 1, Layer>();

/**
 * Paints the umpire on the high chair beside the screen-right net post (the stadium does not rotate
 * with the viewer), head turned per `s.umpireLook`. Three cached frames; one blit per call.
 */
export function drawUmpire(ctx: CanvasRenderingContext2D, s: SceneState): void {
  const look: -1 | 0 | 1 = s.umpireLook === -1 || s.umpireLook === 1 ? s.umpireLook : 0;
  const frame = cachedLayer(umpires, look, () => paintUmpire(look));
  const foot = project({ x: UMPIRE_X, y: 0, z: 0 }, 0);
  ctx.drawImage(frame.canvas, Math.floor(foot.x) - CHAIR_ANCHOR, Math.floor(foot.y) - CHAIR.length + 1);
}
