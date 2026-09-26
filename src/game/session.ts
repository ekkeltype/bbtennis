import type { KeyClass } from '../core/typing';
import type { MatchState, ViewModel } from '../core/types';

export type { DisplayPrefs, Overlay, ViewModel } from '../core/types';

/** A running match as the app drives it: local (vs CPU, training, attract) or online (host, guest). */
export interface Session {
  /** Advances the match to now and returns what to draw; `dtMs` is the time since the previous frame. */
  frame(dtMs: number): ViewModel;
  /** A classified keydown at `timeStamp` (the event's performance-clock ms), applied at once. */
  key(k: KeyClass, timeStamp: number): void;
  /** Opens the in-match menu; a local session also freezes its clocks until `resume`. */
  pause(): void;
  /** Closes the in-match menu; a local session resumes after a 3-2-1 countdown. */
  resume(): void;
  /** Releases timers and connections; the session does nothing afterwards. */
  dispose(): void;
  /** True once the match is over and its MATCH_OVER celebration has played (time for Results). */
  readonly over: boolean;
  /** The final match state once `over`, else null. */
  readonly result: MatchState | null;
  /** The view model of the latest frame, or null before the first frame (read by debug hooks). */
  readonly view: ViewModel | null;
}
