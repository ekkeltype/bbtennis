import type { DisplayPrefs } from '../../src/core/types';
import { Hud } from '../../src/render/hud';
import { H, W } from '../../src/render/projection';
import { addFigure, addHeading, addRow, addSection, cropped, newCanvas, scaled } from './dom';
import { bannerSamples, readoutSample, scoreboardSamples, serveClockSamples, type HudSample } from './hudStates';
import { sceneCanvas } from './scenes';

/** The HUD band (spec §4.1 screen zones): y 0–21. */
const BAND_H = 22;
/** Rows the call banners can cover: from 3 px above their top (y 83) to 3 px below a three-line banner. */
const BANNER_Y = 80;
const BANNER_H = 68;
const BAND_SCALE = 3;
const BANNER_SCALE = 2;
/** The display options of a new player (DEFAULT_SETTINGS). */
const PREFS: DisplayPrefs = { largeWords: false, reduceEffects: false, showWpm: true };

/** A 1× frame: the static hard-court scene as player 0 sees it with `s`'s HUD drawn over it. */
function hudFrame(scene: HTMLCanvasElement, s: HudSample): HTMLCanvasElement {
  const { canvas, g } = newCanvas(W, H);
  g.drawImage(scene, 0, 0);
  const hud = new Hud();
  hud.update(s.frame);
  hud.draw(g, s.frame, PREFS);
  return canvas;
}

/**
 * Section `hud`: the real HUD (spec §4.3) over the hard court: the top band at 3× for scoreboards,
 * serve clocks and the rally readouts, and the banner rows at 2× for every call, lead-in sequence,
 * situation and the champion.
 */
export function drawHudSection(parent: HTMLElement): void {
  const section = addSection(parent, 'hud', 'HUD: scoreboard, serve clock, readouts and banners (hard court, player 0)');
  const scene = sceneCanvas('hard', 0, { crowdExcite: 0, umpireLook: 0, t: 0 });
  addHeading(section, `top band y 0–${BAND_H - 1} at ${BAND_SCALE}×`);
  for (const s of [...scoreboardSamples(), ...serveClockSamples(), readoutSample()]) {
    addFigure(addRow(section, s.label), scaled(cropped(hudFrame(scene, s), 0, 0, W, BAND_H), BAND_SCALE));
  }
  addHeading(section, `banners, y ${BANNER_Y}–${BANNER_Y + BANNER_H - 1} at ${BANNER_SCALE}×`);
  for (const s of bannerSamples()) {
    addFigure(addRow(section, s.label), scaled(cropped(hudFrame(scene, s), 0, BANNER_Y, W, BANNER_H), BANNER_SCALE));
  }
}
