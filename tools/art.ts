/**
 * Art QA page (spec §6), served by `npm run dev` at /tools/art.html and exported by
 * `npm run art:export`: every `<section data-shot>` becomes artifacts/art/<name>.png. A part that
 * fails to draw logs a console error (failing the export) and the rest of the page still draws.
 */
import { addError } from './art/dom';
import { drawFontSection } from './art/font';
import { drawHudSection } from './art/hud';
import { drawLiveSceneSections } from './art/liveScenes';
import { drawPlatesSection } from './art/plates';
import { drawRingsSection } from './art/rings';
import { drawSceneSections } from './art/scenes';
import { drawSpriteSections } from './art/sprites';

const PARTS: readonly [name: string, draw: (parent: HTMLElement) => void][] = [
  ['sprites', drawSpriteSections],
  ['font', drawFontSection],
  ['plates', drawPlatesSection],
  ['rings', drawRingsSection],
  ['scenes', drawSceneSections],
  ['live scenes', drawLiveSceneSections],
  ['hud', drawHudSection],
];

const main = document.getElementById('art');
if (!main) throw new Error('art.html has no #art element');
for (const [name, draw] of PARTS) {
  try {
    draw(main);
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`art: ${name} failed to draw: ${detail}`);
    addError(main, `${name} failed to draw:\n${detail}`);
  }
}
(window as unknown as { __shotReady: boolean }).__shotReady = true;
