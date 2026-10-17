import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/pixelify-sans/latin-400.css';
import { Screen } from '../render/screen';
import { ArcadeCpu } from './core/cpu';
import { ArcadeSession } from './game/session';
import { ArcadeRenderer } from './render/renderer';

/**
 * Temporary Arcade entry (replaced in Task 13): a CPU-vs-CPU match (levels 6 and 9) drawn by the
 * renderer every animation frame; signals `__shotReady` once a rally is under way after 3 s.
 */
function boot(): void {
  const canvas = document.getElementById('game');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Black Belt Tennis Arcade: #game is missing');
  const screen = new Screen(canvas);
  const renderer = new ArcadeRenderer(screen);
  const seed = 7;
  const session = new ArcadeSession({
    config: { format: 'short', deuceRule: 'advantage', surface: 'hard', pace: 'normal' },
    players: [
      { name: 'Kai', look: { skin: 1, hairStyle: 2, hair: 3, shirt: 6, shorts: 7, headband: 5, racket: 2 }, kind: 'cpu', cpuLevel: 6 },
      { name: 'Mira', look: { skin: 3, hairStyle: 4, hair: 1, shirt: 2, shorts: 1, headband: null, racket: 0 }, kind: 'cpu', cpuLevel: 9 },
    ],
    seed,
    controllers: [new ArcadeCpu(0, 6, seed), new ArcadeCpu(1, 9, seed)],
    viewer: 0,
  });
  let start: number | null = null;
  let last: number | null = null;
  const loop = (now: number): void => {
    const dt = last === null ? 0 : now - last;
    last = now;
    start ??= now;
    const view = session.frame(dt);
    renderer.draw(view, { reduceEffects: false }, dt);
    if (now - start > 3000 && view.state.phase.kind === 'rally') (window as unknown as { __shotReady: boolean }).__shotReady = true;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

boot();
