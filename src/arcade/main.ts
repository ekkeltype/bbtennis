import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/pixelify-sans/latin-400.css';
import { drawCourt } from '../render/court';
import { drawBackdrop, drawNet } from '../render/scene';
import { Screen } from '../render/screen';

/** Temporary Arcade entry (replaced in Task 13): paints the hard court once and signals `__shotReady`. */
function boot(): void {
  const canvas = document.getElementById('game');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Black Belt Tennis Arcade: #game is missing');
  const screen = new Screen(canvas);
  drawBackdrop(screen.buf, 'hard', { crowdExcite: 0, umpireLook: 0, t: 0 });
  drawCourt(screen.buf, 'hard', 0);
  drawNet(screen.buf, 'hard', 0);
  screen.present();
  (window as unknown as { __shotReady: boolean }).__shotReady = true;
}

boot();
