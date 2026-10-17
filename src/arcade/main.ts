import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/pixelify-sans/latin-400.css';
import '../styles.css';
import './arcade.css';
import { bootGame } from '../ui/boot';
import { ArcadeApp } from './ui/app';

/** Boots the Arcade on the page's `#app` root, `#game` canvas and `#ui` overlay; a failed start shows a message in `#ui`. */
function boot(): void {
  const root = document.getElementById('app');
  const canvas = document.getElementById('game');
  const ui = document.getElementById('ui');
  if (!root || !(canvas instanceof HTMLCanvasElement) || !ui) throw new Error('Black Belt Tennis Arcade: #app, #game or #ui is missing');
  void bootGame(ui, () => new ArcadeApp({ root, canvas, ui }));
}

boot();
