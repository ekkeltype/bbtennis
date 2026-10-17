import type { AudioEngine } from '../../audio/engine';
import { callRank, panFor, pointReaction, SPOKEN_CALLS } from '../../audio/cues';
import type { Umpire } from '../../audio/speech';
import { umpireCall } from '../../core/scoring';
import type { Surface } from '../../core/types';
import type { ArcadeEvent, PlayerId } from '../core/types';
import type { ArcadeView } from '../game/session';

/** Events older than this when played are dropped. */
const MAX_AGE_MS = 300;
/** Contact x (m) that pans a hit fully to one side. */
const HIT_PAN_WIDTH_M = 6;
/** Hit power at or above which the hit sounds hard. */
const HARD_POWER = 0.9;

/** The shared spoken calls, plus the two the arcade also says (lowest priority). */
const CALLS = [...SPOKEN_CALLS, { call: 'net', words: 'Net' }, { call: 'ace', words: 'Ace' }] as const;

/** Maps arcade sim events to the shared sounds, crowd reactions and umpire calls (spec §6.2). */
export class ArcadeDirector {
  constructor(
    private readonly engine: Pick<AudioEngine, 'play'>,
    private readonly umpire: Pick<Umpire, 'say'>,
    private readonly opts: { surface: () => Surface; viewer: () => PlayerId | 'spectator' },
  ) {}

  /** Plays the sounds and calls for `view.events`; `ageMs(e)` is how long ago the event happened. */
  consume(view: ArcadeView, ageMs: (e: ArcadeEvent) => number): void {
    const viewer = this.opts.viewer();
    const { players, score } = view.state;
    const names: [string, string] = [players[0].name, players[1].name];
    let bestRank = Number.POSITIVE_INFINITY;
    let scoreWords: string | null = null;
    let matchWords: string | null = null;
    let speechAge = 0;
    for (const e of view.events) {
      const age = ageMs(e);
      if (age > MAX_AGE_MS) continue;
      switch (e.type) {
        case 'hit': {
          const h = e.hit;
          const hard = h.power >= HARD_POWER || h.type === 'smash' || h.grade === 'perfect';
          this.engine.play(hard ? 'hitHard' : 'hit', { pan: panFor(h.contact.x, viewer, HIT_PAN_WIDTH_M) });
          break;
        }
        case 'bounce':
          this.engine.play('bounce', { surface: this.opts.surface(), pan: panFor(e.at.x, viewer, HIT_PAN_WIDTH_M) });
          break;
        case 'netHit':
          this.engine.play('netHit');
          break;
        case 'call': {
          const rank = callRank(e.call, CALLS);
          if (rank < bestRank) {
            bestRank = rank;
            speechAge = Math.max(speechAge, age);
          }
          break;
        }
        case 'point': {
          if (e.reason === 'forfeit') break;
          const { name, opts } = pointReaction(e.winner, e.reason, viewer);
          if (opts) this.engine.play(name, opts);
          else this.engine.play(name);
          scoreWords = umpireCall(score, names, e.winner);
          speechAge = Math.max(speechAge, age);
          break;
        }
        case 'match':
          matchWords = `Game, set and match, ${names[e.winner]}`;
          speechAge = Math.max(speechAge, age);
          break;
        default:
          break;
      }
    }
    // One utterance per frame: Umpire.say cancels whatever it was saying, so a call and the score must travel together.
    const words: string[] = [];
    const call = CALLS[bestRank];
    if (call) words.push(call.words);
    const tail = matchWords ?? scoreWords;
    if (tail !== null) words.push(tail);
    if (words.length > 0) this.umpire.say(words.join('. '), speechAge);
  }
}
