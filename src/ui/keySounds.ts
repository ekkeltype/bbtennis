import type { KeyResult } from '../core/typing';
import type { GameEvent, PlayerId } from '../core/types';

/**
 * The viewer's own keystrokes in a frame's events, as key results for `AudioDirector.onLocalKey`
 * (the director voices the opponent's keys from the events itself). A completing key emits keyOk
 * (or lock) and then wordDone; it sounds once, as 'completed'.
 */
export function localKeyResults(events: readonly GameEvent[], viewer: PlayerId | 'spectator'): KeyResult[] {
  const out: KeyResult[] = [];
  for (const e of events) {
    if (viewer === 'spectator' || !('player' in e) || e.player !== viewer) continue;
    if (e.type === 'lock') out.push('locked');
    else if (e.type === 'keyOk') out.push('correct');
    else if (e.type === 'keyBad') out.push('wrong');
    else if (e.type === 'wordDone') {
      const last = out.at(-1);
      if (last === 'correct' || last === 'locked') out.pop();
      out.push('completed');
    }
  }
  return out;
}
