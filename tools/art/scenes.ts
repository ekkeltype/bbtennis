import type { PlayerId, Surface } from '../../src/core/types';
import { drawCourt } from '../../src/render/court';
import { H, W } from '../../src/render/projection';
import { drawBackdrop, drawNet, drawUmpire, type SceneState } from '../../src/render/scene';
import { addFigure, addHeading, addRow, addSection, newCanvas, scaled } from './dom';

const SURFACES: readonly Surface[] = ['hard', 'clay', 'grass', 'dojo'];
const VIEWERS: readonly PlayerId[] = [0, 1];
const BIG = 3;

/**
 * Idle crowd with the umpire looking across; cheering crowd with the umpire looking up-screen for
 * viewer 0 and down-screen for viewer 1, so every umpire head frame appears on the page.
 */
function moods(viewer: PlayerId): { label: string; state: SceneState }[] {
  const look = viewer === 0 ? -1 : 1;
  return [
    { label: 'crowd idle, umpire looking across', state: { crowdExcite: 0, umpireLook: 0, t: 0 } },
    {
      label: `crowd cheering, umpire looking ${look === -1 ? 'up-screen (far end)' : 'down-screen (near end)'}`,
      state: { crowdExcite: 1, umpireLook: look, t: 150 },
    },
  ];
}

/** The static scene as `viewer` sees it, at 1×: backdrop, court, net and umpire. */
export function sceneCanvas(surface: Surface, viewer: PlayerId, state: SceneState): HTMLCanvasElement {
  const { canvas, g } = newCanvas(W, H);
  drawBackdrop(g, surface, state);
  drawCourt(g, surface, viewer);
  drawNet(g, surface, viewer);
  drawUmpire(g, state);
  return canvas;
}

/**
 * Sections `scene-<surface>-<viewer>`: each surface's static scene for viewers 0 and 1, crowd idle
 * and cheering, at 1× and 3×.
 */
export function drawSceneSections(parent: HTMLElement): void {
  for (const surface of SURFACES) {
    for (const viewer of VIEWERS) {
      const section = addSection(parent, `scene-${surface}-${viewer}`, `scene: ${surface}, viewer ${viewer}`);
      const shots = moods(viewer).map(({ label, state }) => ({ label, one: sceneCanvas(surface, viewer, state) }));
      const small = addRow(section, '1×');
      for (const { label, one } of shots) addFigure(small, one, label);
      for (const { label, one } of shots) {
        addHeading(section, `${BIG}×: ${label}`);
        addFigure(section, scaled(one, BIG));
      }
    }
  }
}
