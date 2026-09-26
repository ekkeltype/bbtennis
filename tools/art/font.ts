import { drawText, FONT, GLYPHS, textWidth } from '../../src/render/font';
import { PLATE } from '../../src/render/palette';
import { addFigure, addGrid, addHeading, addRow, addSection, newCanvas, scaled } from './dom';

const K = 4;
const SAMPLES = ['ball', 'backhand', 'counterpuncher', 'Game, Alex', '15-40', 'MATCH POINT'];
/** Metric guides behind the glyphs: cap top, x-height top, baseline bottom. */
const GUIDE = '#3E3A5C';
const GUIDE_ROWS = [FONT.baseline - FONT.capHeight + 1, FONT.baseline - FONT.xHeight + 1, FONT.baseline + 1];

/** One 6×10 glyph cell at 4×, near-white on the plate fill, with the metric guides behind it. */
function glyphCell(ch: string): HTMLCanvasElement {
  const one = newCanvas(FONT.cellW, FONT.cellH);
  drawText(one.g, ch, 0, 0, PLATE.text);
  const { canvas, g } = newCanvas(FONT.cellW * K, FONT.cellH * K);
  g.fillStyle = PLATE.fill;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = GUIDE;
  for (const row of GUIDE_ROWS) g.fillRect(0, row * K, canvas.width, 1);
  g.drawImage(one.canvas, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** `text` at 1×, near-white on the plate fill with a 2 px margin. */
function wordCanvas(text: string): HTMLCanvasElement {
  const { canvas, g } = newCanvas(textWidth(text) + 4, FONT.cellH + 4);
  g.fillStyle = PLATE.fill;
  g.fillRect(0, 0, canvas.width, canvas.height);
  drawText(g, text, 2, 2, PLATE.text);
  return canvas;
}

/** Section `font`: every glyph cell at 4×, then the sample words at 1× and 4×. */
export function drawFontSection(parent: HTMLElement): void {
  const section = addSection(parent, 'font', 'font: glyph atlas and sample words');
  const chars = Object.keys(GLYPHS);
  addHeading(
    section,
    `${chars.length} glyphs at 4×, one 6×10 cell each (guides: cap top, x-height top, baseline; descenders below)`,
  );
  const grid = addGrid(section);
  for (const ch of chars) addFigure(grid, glyphCell(ch), ch === ' ' ? 'spc' : ch);
  addHeading(section, 'sample words at 1× and 4×');
  for (const text of SAMPLES) {
    const one = wordCanvas(text);
    const row = addRow(section, JSON.stringify(text));
    addFigure(row, one, '1×');
    addFigure(row, scaled(one, K), '4×');
  }
}
