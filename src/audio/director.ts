import { POWER_MAX } from '../core/power';
import { umpireCall } from '../core/scoring';
import type { KeyResult } from '../core/typing';
import type { CallKind, GameEvent, PlayerId, PointReason, PublicState, Surface, TurnState } from '../core/types';
import { clamp } from '../core/util';
import type { AudioEngine, SfxName } from './engine';
import type { Umpire } from './speech';

/** What the director needs to know about the frame whose events it voices. */
export interface DirectorContext {
  viewer: PlayerId | 'spectator';
  /** Attract mode: no sfx, no crowd, no umpire. */
  muted: boolean;
  state: PublicState;
  surface: Surface;
}

/** Gain of the opponent's keystrokes relative to the local player's own. */
const REMOTE_KEY_GAIN = 0.35;
/** Gain of the opponent's power-meter cues relative to the local player's own. */
const REMOTE_POWER_GAIN = 0.6;
/** Gain of the applause for the opponent's ace or winner. */
const POLITE_APPLAUSE_GAIN = 0.5;
/** Crowd murmur levels: chatter before the first serve, hush for serve and rally, buzz after a point. */
const CROWD = { chatter: 0.4, hush: 0.12, buzz: 0.5 } as const;
/** Lateral court position (m) that pans a bounce fully to one side. */
const PAN_WIDTH_M = 10;

/**
 * The calls the umpire says, most important first: when a frame carries several, only the top one is
 * said. Unlisted calls (ace, winner, net) are left to the score call and the banner.
 */
const SPOKEN_CALLS: readonly { call: CallKind; words: string }[] = [
  { call: 'doubleFault', words: 'Double fault' },
  { call: 'timeViolation', words: 'Time violation' },
  { call: 'fault', words: 'Fault' },
  { call: 'ballDropped', words: 'Fault' },
  { call: 'out', words: 'Out' },
];

/** Index into SPOKEN_CALLS (lower = more important), or Infinity for a call the umpire leaves unsaid. */
function callRank(call: CallKind): number {
  const i = SPOKEN_CALLS.findIndex((c) => c.call === call);
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

const LOCAL_KEY_SFX: Record<KeyResult, SfxName | null> = {
  ignored: null,
  locked: 'lock',
  correct: 'key',
  wrong: 'bad',
  completed: 'done',
};

/**
 * How long ago `ev` happened (ms) on the turn clocks, measured to the state's latest processed τ.
 * Events older than the previous turn are infinitely old.
 */
function eventAgeMs(ev: GameEvent, s: PublicState): number {
  const cur = s.turn;
  if (cur && cur.data.turnId === ev.turn) return Math.max(0, cur.τ - ev.τ);
  const last = s.lastTurn;
  if (last && last.data.turnId === ev.turn) return Math.max(0, last.τ - ev.τ) + (cur ? cur.τ : 0);
  return Number.POSITIVE_INFINITY;
}

/** Stereo pan for a court x as the viewer sees it (end-1 viewers see the court rotated by 180°). */
function panFor(x: number, viewer: PlayerId | 'spectator'): number {
  return clamp((viewer === 1 ? -x : x) / PAN_WIDTH_M, -1, 1);
}

/** The turn of `s` (current or previous) with id `id`, or null. */
function turnById(s: PublicState, id: number): TurnState | null {
  if (s.turn?.data.turnId === id) return s.turn;
  return s.lastTurn?.data.turnId === id ? s.lastTurn : null;
}

/** True when the strike `ev` hits back an insane shot: its turn is a return chasing an insane word (choice-stack spec §4). */
function returnsInsane(ev: GameEvent, s: PublicState): boolean {
  const d = turnById(s, ev.turn)?.data;
  return d?.kind === 'return' && d.chase.tier === 'insane';
}

/**
 * Maps game events to sounds, crowd level and umpire calls (spec §4.4). The viewer's own keystrokes
 * sound through `onLocalKey` the moment they are typed; the opponent's arrive as events, quieter.
 */
export class AudioDirector {
  private crowdRaised = false;

  constructor(
    private readonly audio: AudioEngine,
    private readonly umpire: Umpire,
  ) {}

  /** Voices the events that became visible this frame. */
  onEvents(events: GameEvent[], ctx: DirectorContext): void {
    if (ctx.muted) {
      this.setCrowd(0);
      return;
    }
    let bestCallRank = Number.POSITIVE_INFINITY;
    let score: string | null = null;
    let speechAge = 0;
    for (const ev of events) {
      switch (ev.type) {
        case 'coinToss':
          this.audio.play('coin');
          this.setCrowd(CROWD.chatter);
          break;
        case 'preServe':
          this.setCrowd(CROWD.hush);
          if (ev.server === ctx.viewer) this.audio.play('yourTurn');
          break;
        case 'promptShown':
          if (ev.kind === 'chase' && ev.player === ctx.viewer) this.audio.play('yourTurn');
          break;
        case 'lock':
        case 'keyOk':
        case 'keyBad':
          if (ev.player !== ctx.viewer) this.audio.play('key', { gain: REMOTE_KEY_GAIN });
          break;
        case 'strike':
          this.audio.play(ev.tier === 'hard' || ev.tier === 'insane' ? 'hitHard' : 'hit');
          if (ev.tier === 'insane') this.audio.play('ooh');
          // The crowd cheers the retrieval itself, before the return's own outcome is called.
          if (returnsInsane(ev, ctx.state)) {
            const polite = ctx.viewer !== 'spectator' && ev.player !== ctx.viewer;
            this.audio.play('applause', polite ? { gain: POLITE_APPLAUSE_GAIN } : undefined);
          }
          break;
        case 'power': {
          const opts = ctx.viewer === 'spectator' || ev.player === ctx.viewer ? undefined : { gain: REMOTE_POWER_GAIN };
          if (ev.to >= POWER_MAX && ev.from < POWER_MAX) this.audio.play('powerUp', opts);
          else if (ev.from >= POWER_MAX && ev.to === 0) this.audio.play('powerDown', opts);
          break;
        }
        case 'bounce':
          this.audio.play('bounce', { surface: ctx.surface, pan: panFor(ev.at.x, ctx.viewer) });
          break;
        case 'netHit':
          this.audio.play('netHit');
          break;
        case 'call': {
          const rank = callRank(ev.call);
          if (rank < bestCallRank) {
            bestCallRank = rank;
            speechAge = Math.max(speechAge, eventAgeMs(ev, ctx.state));
          }
          break;
        }
        case 'point': {
          if (ev.reason === 'forfeit') break;
          this.react(ev.winner, ev.reason, ctx.viewer);
          this.setCrowd(CROWD.buzz);
          const names: [string, string] = [ctx.state.players[0].name, ctx.state.players[1].name];
          score = umpireCall(ctx.state.score, names, ev.winner);
          speechAge = Math.max(speechAge, eventAgeMs(ev, ctx.state));
          break;
        }
        default:
          break;
      }
    }
    // One utterance per frame: Umpire.say cancels whatever it was saying, so a call and the score must travel together.
    const words: string[] = [];
    const call = SPOKEN_CALLS[bestCallRank];
    if (call) words.push(call.words);
    if (score !== null) words.push(score);
    if (words.length > 0) this.umpire.say(words.join('. '), speechAge);
  }

  /** Voices the local player's own keystroke immediately (click, buzz, lock tick, word chime). */
  onLocalKey(result: KeyResult): void {
    const name = LOCAL_KEY_SFX[result];
    if (name) this.audio.play(name);
  }

  /** The home crowd: cheers the viewer's points, groans at the viewer's errors, claps politely otherwise. */
  private react(winner: PlayerId, reason: PointReason, viewer: PlayerId | 'spectator'): void {
    if (viewer === 'spectator' || winner === viewer) this.audio.play('applause');
    else if (reason === 'ace' || reason === 'winner') this.audio.play('applause', { gain: POLITE_APPLAUSE_GAIN });
    else this.audio.play('ooh');
  }

  private setCrowd(level: number): void {
    if (level === 0 && !this.crowdRaised) return;
    this.audio.crowd(level);
    this.crowdRaised = level > 0;
  }
}
