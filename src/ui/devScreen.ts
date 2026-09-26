import type { UiContext } from './context';
import { sampleResults } from './samples';

/** True in dev builds and on pages opened with `?e2e=1` (the E2E script's production runs). */
export function testable(q: URLSearchParams): boolean {
  return import.meta.env.DEV || q.get('e2e') === '1';
}

/**
 * Dev/E2E (`?screen=`): jumps straight to screen `name` with sample data, skipping the start gate:
 * through Title and Main menu, then a match, the pause menu, Training, sample Results
 * (`&sample=training|retry|left|disconnect`), Join (`&join=CODE`) or any other registered screen.
 */
export function showDevScreen(ctx: UiContext, name: string, q: URLSearchParams): void {
  const r = ctx.router;
  if (name === 'gate') return r.go('gate');
  r.go('title');
  if (name === 'title') return;
  r.go('mainMenu');
  if (name === 'match' || name === 'pause') {
    ctx.startCpuMatch();
    if (name === 'pause') ctx.pauseMatch();
  } else if (name === 'training') {
    ctx.startTraining();
  } else if (name === 'results') {
    r.go('results', sampleResults(ctx.profile, q.get('sample')));
  } else if (name === 'join') {
    r.go('join', { code: q.get('join') });
  } else if (name !== 'mainMenu') {
    try {
      r.go(name);
    } catch {
      console.warn(`[bbt] ?screen=${name}: no such screen`);
    }
  }
}
