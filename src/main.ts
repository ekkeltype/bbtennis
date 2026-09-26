import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/pixelify-sans/latin-400.css';
import './styles.css';
import { App } from './app';

/** Boots the game on the page's `#app` root, `#game` canvas and `#ui` overlay. */
function boot(): void {
  const root = document.getElementById('app');
  const canvas = document.getElementById('game');
  const ui = document.getElementById('ui');
  if (!root || !(canvas instanceof HTMLCanvasElement) || !ui) throw new Error('Black Belt Tennis: #app, #game or #ui is missing');
  void new App({ root, canvas, ui }).start();
}

boot();
