import { h } from './dom';

/** What a failed start shows in `#ui` in place of the game. */
export const BOOT_ERROR = 'Something went wrong starting the game — reload the page';

/** The game as the page boots it (the App). */
export interface Startable { start(): Promise<void> }

/** Longest wait for the UI fonts before the first screen shows anyway. */
const FONTS_WAIT_MS = 3000;

/** Resolves once both UI fonts are loaded (spec §4.6), or after 3 s, so a font failure never blocks the game. */
export async function fontsReady(): Promise<void> {
  try {
    const fonts = document.fonts;
    const loads = Promise.all([fonts.load('16px "Press Start 2P"'), fonts.load('16px "Pixelify Sans"')]).then(() => fonts.ready);
    await Promise.race([loads, new Promise((r) => setTimeout(r, FONTS_WAIT_MS))]);
  } catch {
    // Fall back to whatever fonts are available.
  }
}

/**
 * Creates the game with `create` and starts it. A failure, thrown while creating or rejected while
 * starting (a screen factory throwing on the first screen, say), is logged and shown in `ui` as a
 * readable message instead of leaving a blank page. Never rejects.
 */
export async function bootGame(ui: HTMLElement, create: () => Startable): Promise<void> {
  try {
    await create().start();
  } catch (err) {
    console.error('[bbt] the game failed to start', err);
    ui.append(h('div', { class: 'boot-error', role: 'alert' }, BOOT_ERROR));
  }
}
