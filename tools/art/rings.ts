import type { Surface, Tier } from '../../src/core/types';
import { SURFACE_PAL } from '../../src/render/palette';
import { drawLeader, drawTierRing, drawTimingBar } from '../../src/render/plates';
import { addFigure, addRow, addSection, newCanvas, scaled } from './dom';

const K = 4;
const SURFACES: readonly Surface[] = ['hard', 'clay', 'grass', 'dojo'];
const TIERS: readonly Tier[] = ['easy', 'medium', 'hard', 'insane'];
/** One column per surface shade, holding a ring of each tier 16 px apart. */
const COL_W = 52;
const RING_GAP = 16;
/** Leader start offsets per tier (a plate end up and to the side of the ring), and the ring rows. */
const LEADER_DX = [-6, 0, 6, 12];
const LEADER_TOP = 2;
const RING_Y = 30;
const LINE_Y = 50;
/** Timing bars: normal row, then grace row; each at 100 / 40 / 10 % remaining. */
const BAR_ROWS = [{ y: 64, grace: false }, { y: 72, grace: true }];
const BARS = [{ x: 4, w: 95, frac: 1 }, { x: 108, w: 95, frac: 0.4 }, { x: 212, w: 40, frac: 0.1 }];
const PANEL_H = 78;

/**
 * Court-space marks at 1× over every court then surround shade of `surface`: leaders into rings of
 * each tier, the same rings straddling a court line, and timing bars (normal, then grace).
 */
function marksCanvas(surface: Surface): HTMLCanvasElement {
  const pal = SURFACE_PAL[surface];
  const shades = [...pal.court, ...pal.surround];
  const { canvas, g } = newCanvas(shades.length * COL_W, PANEL_H);
  shades.forEach((shade, col) => {
    g.fillStyle = shade;
    g.fillRect(col * COL_W, 0, COL_W, PANEL_H);
  });
  g.fillStyle = pal.lines;
  g.fillRect(0, LINE_Y, canvas.width, 1);
  shades.forEach((_, col) => {
    TIERS.forEach((tier, t) => {
      const x = col * COL_W + COL_W / 2 + (t - 1.5) * RING_GAP;
      drawLeader(g, { x: x + (LEADER_DX[t] ?? 0), y: LEADER_TOP }, { x, y: RING_Y }, tier);
      drawTierRing(g, tier, x, RING_Y);
      drawTierRing(g, tier, x, LINE_Y);
    });
  });
  for (const { y, grace } of BAR_ROWS) {
    for (const { x, w, frac } of BARS) drawTimingBar(g, x, y, w, frac, grace);
  }
  return canvas;
}

/**
 * Section `rings`: ground rings, leaders and timing bars (normal and grace) over each surface's
 * colours, at 1× and 4×.
 */
export function drawRingsSection(parent: HTMLElement): void {
  const section = addSection(
    parent,
    'rings',
    'rings, leaders and timing bars: columns are the court shades then the surround shades; ' +
      'rings with leaders, rings on a court line; timing bars normal then grace at 100 / 40 / 10 %',
  );
  for (const surface of SURFACES) {
    const one = marksCanvas(surface);
    const row = addRow(section, surface);
    addFigure(row, one, '1×');
    addFigure(row, scaled(one, K), '4×');
  }
}
