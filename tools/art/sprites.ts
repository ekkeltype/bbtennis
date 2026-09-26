import type { Look } from '../../src/core/types';
import { ANIMS, ANIM_NAMES, CELL, VIEWS, type AnimName, type View } from '../../src/render/sprites/animations';
import { HAIR_STYLES } from '../../src/render/sprites/parts';
import { buildSheet, drawPlayer, type SpriteSheet } from '../../src/render/sprites/sheet';
import { addFigure, addRow, addSection, newCanvas } from './dom';

const K = 4;
/** Opacity of the first frame in an onion-skin composite; later frames step up to fully opaque. */
const ONION_FIRST_ALPHA = 0.25;
/** Feet-anchor crosshair (behind the sprite) and the anchor pixel's outline (over it). */
const CROSSHAIR = 'rgba(255, 64, 224, 0.55)';
const ANCHOR = '#FF40E0';

/**
 * Four contrasting looks: light to deep skins, four hair styles and colours, light and dark cloth,
 * two with a headband. Each section is named after the look's hair style.
 */
const PRESETS: readonly { note: string; look: Look }[] = [
  {
    note: 'fair skin, blonde, white shirt, navy shorts, no headband, graphite racket',
    look: { skin: 0, hairStyle: 0, hair: 5, shirt: 0, shorts: 7, headband: null, racket: 0 },
  },
  {
    note: 'deep skin, black hair, black shirt, white shorts, yellow headband, white racket',
    look: { skin: 5, hairStyle: 4, hair: 0, shirt: 4, shorts: 0, headband: 1, racket: 3 },
  },
  {
    note: 'mid skin, auburn, teal shirt, black shorts, white headband, red racket',
    look: { skin: 2, hairStyle: 2, hair: 3, shirt: 11, shorts: 4, headband: 0, racket: 1 },
  },
  {
    note: 'tan skin, silver hair, orange shirt, blue shorts, no headband, lime racket',
    look: { skin: 3, hairStyle: 1, hair: 7, shirt: 8, shorts: 6, headband: null, racket: 4 },
  },
];

/**
 * One 48×48 cell at 4× with the feet-anchor crosshair: a single frame, or several frames overlaid
 * as an onion skin (earlier frames fainter).
 */
function spriteCell(sheet: SpriteSheet, anim: AnimName, view: View, frames: readonly number[]): HTMLCanvasElement {
  const one = newCanvas(CELL.w, CELL.h);
  frames.forEach((frame, j) => {
    const step = frames.length > 1 ? j / (frames.length - 1) : 1;
    one.g.globalAlpha = ONION_FIRST_ALPHA + (1 - ONION_FIRST_ALPHA) * step;
    drawPlayer(one.g, sheet, anim, view, frame, CELL.anchorX, CELL.anchorY);
  });

  const { canvas, g } = newCanvas(CELL.w * K, CELL.h * K);
  const mid = K / 2 - 1;
  g.fillStyle = CROSSHAIR;
  g.fillRect(CELL.anchorX * K + mid, 0, 2, canvas.height);
  g.fillRect(0, CELL.anchorY * K + mid, canvas.width, 2);
  g.drawImage(one.canvas, 0, 0, canvas.width, canvas.height);
  g.strokeStyle = ANCHOR;
  g.lineWidth = 1;
  g.strokeRect(CELL.anchorX * K - 0.5, CELL.anchorY * K - 0.5, K + 1, K + 1);
  canvas.className = 'cell';
  return canvas;
}

function spriteSection(parent: HTMLElement, note: string, look: Look, view: View): void {
  const style = HAIR_STYLES[look.hairStyle] ?? `style${look.hairStyle}`;
  const side = view === 'near' ? 'near view (back)' : 'far view (front)';
  const section = addSection(parent, `sprites-${style}-${view}`, `sprites: ${style}, ${side}, 4×. ${note}`);
  const sheet = buildSheet(look);
  for (const anim of ANIM_NAMES) {
    const { frames, msPerFrame, loop } = ANIMS[anim];
    const row = addRow(section, `${anim}\n${frames} frames × ${msPerFrame} ms, ${loop ? 'loop' : 'one-shot'}`);
    const all = Array.from({ length: frames }, (_, i) => i);
    for (const i of all) addFigure(row, spriteCell(sheet, anim, view, [i]), `f${i}`);
    addFigure(row, spriteCell(sheet, anim, view, all), 'onion skin');
  }
}

/**
 * Sections `sprites-<hair style>-<view>`: every animation of four look presets in both views at 4×,
 * one row per animation with frame labels, the feet anchor and an onion-skin composite.
 */
export function drawSpriteSections(parent: HTMLElement): void {
  for (const { note, look } of PRESETS) {
    for (const view of VIEWS) spriteSection(parent, note, look, view);
  }
}
