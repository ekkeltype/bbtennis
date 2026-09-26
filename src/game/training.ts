import { Engine } from '../core/engine';
import type { MatchConfig, PlayerInfo, PromptKind, Surface, TurnState, ViewModel } from '../core/types';
import type { Scheduler } from './clock';
import type { LocalSessionOptions } from './localSession';

/** One training lesson: the coach text for a frame, and whether the frame completes the lesson. */
export interface Lesson {
  id: string;
  coach: (v: ViewModel) => string | null;
  done: (v: ViewModel) => boolean;
}

/** The lessons a training session runs through, in order (spec §3.12). */
export interface TrainingScript { lessons: Lesson[] }

/**
 * Training's fixed words (spec §3.12): [easy, medium, hard] triples from the Everyday pack with valid
 * initials, cycled in order. No word repeats anywhere, so a re-toss or a choice never offers a word of
 * the previous set or the chase word.
 */
export const TRAINING_WORDS: { readonly serve: readonly (readonly string[])[]; readonly choice: readonly (readonly string[])[] } = {
  serve: [
    ['cat', 'garden', 'strawberry'],
    ['moon', 'pillow', 'helicopter'],
    ['duck', 'basket', 'lighthouse'],
    ['sun', 'rainbow', 'playground'],
  ],
  choice: [
    ['tree', 'candle', 'motorcycle'],
    ['bird', 'kitchen', 'skateboard'],
    ['lamp', 'cheese', 'thunderstorm'],
    ['fish', 'bottle', 'peppermint'],
    ['cake', 'summer', 'microphone'],
    ['star', 'puzzle', 'toothbrush'],
  ],
};

/** Every coach text: lesson headlines, how-to tips and explanations (at most two HUD lines each). */
export const COACH = {
  serve: 'LESSON 1: THE SERVE',
  return: 'LESSON 2: THE RETURN',
  rally: 'LESSON 3: RALLY! KEEP THE BALL IN PLAY FOR 3 SHOTS',
  point: 'LESSON 4: PLAY ONE REAL POINT. GOOD LUCK!',
  toss: 'PRESS SPACE TO TOSS THE BALL',
  serveWord: 'TYPE ANY OF THE THREE WORDS TO SERVE',
  serveFinish: 'FINISH THE WORD BEFORE THE BALL DROPS',
  retoss: 'NO WORD STARTED, SO YOU CAUGHT THE BALL. SPACE TO TOSS AGAIN',
  fault: 'FAULT! YOU GET A SECOND SERVE. EASY WORDS ARE SAFER',
  faultDropped: 'FAULT! ONCE YOU START A WORD, FINISH IT BEFORE THE BALL DROPS',
  doubleFault: 'DOUBLE FAULT: TWO FAULTS IN A ROW LOSE THE POINT',
  oppServe: 'YOUR OPPONENT SERVES. THE WORD THEY TYPE IS THE ONE YOU CHASE',
  chase: 'TYPE THE WORD TO RUN TO THE BALL',
  choice: 'TYPE A FIRST LETTER TO PICK A SHOT: HARDER = WIDER AND RISKIER',
  choiceFinish: 'FINISH THE WORD BEFORE THE BALL REACHES YOU',
  queued: 'SHOT READY! YOU HIT IT WHEN THE BALL ARRIVES',
  watch: 'WATCH THEIR WORD: IT IS THE ONE YOU WILL CHASE NEXT',
  stretch: 'STRETCH SHOT! A LATE FINISH STILL HITS, BUT LESS ACCURATELY',
} as const;

/** Tries at finding a seed whose coin toss lets the trainee serve first (each try is a fair coin). */
const SEED_TRIES = 64;

/** Training's match config (spec §3.12): a Relaxed Tiebreak with no serve clock, first-prompt freezes and fixed words. */
export function trainingConfig(surface: Surface = 'hard'): MatchConfig {
  return {
    format: 'tiebreak',
    pace: 'relaxed',
    surface,
    wordPack: 'everyday',
    deuceRule: 'advantage',
    training: {
      serveClock: false,
      freezeUntilFirstKey: true,
      fixedWords: { serve: TRAINING_WORDS.serve.map((t) => [...t]), choice: TRAINING_WORDS.choice.map((t) => [...t]) },
    },
  };
}

/**
 * LocalSession options for Training: player 0 is the trainee (with hints) and serves first, so the
 * lessons meet the serve first (the seed is the first from `seed` on whose coin toss says so); player
 * 1 plays as a White-belt CPU.
 */
export function trainingOptions(opts: {
  players: [PlayerInfo, PlayerInfo];
  seed: number;
  scheduler: Scheduler;
  surface?: Surface;
}): LocalSessionOptions {
  const config = trainingConfig(opts.surface);
  const players: [PlayerInfo, PlayerInfo] = [opts.players[0], { ...opts.players[1], kind: 'cpu', cpuLevel: 0 }];
  let seed = opts.seed >>> 0;
  for (let i = 0; i < SEED_TRIES; i++) {
    const s = (opts.seed + i) >>> 0;
    if (new Engine({ config, players, seed: s }).state.score.firstServerOfMatch === 0) {
      seed = s;
      break;
    }
  }
  return { config, players, seed, human: 0, scheduler: opts.scheduler, training: TRAINING, hints: true };
}

/** The four lessons (spec §3.12). Each ends at the end of a point, so the next begins with a fresh one. */
export const TRAINING: TrainingScript = {
  lessons: [
    // 1. Serve: SPACE to toss, type any word; re-toss and faults explained when they happen.
    { id: 'serve', coach: (v) => explain(v) ?? howTo(v) ?? COACH.serve, done: (v) => pointEnded(v) && seen(v, ['serve']) },
    // 2. Return: type the word to run to the ball, then a first letter to pick a shot.
    { id: 'return', coach: (v) => explain(v) ?? howTo(v) ?? COACH.return, done: (v) => pointEnded(v) && seen(v, ['chase', 'choice']) },
    // 3. A rally of at least 3 shots; every prompt kind has been seen, so nothing freezes any more.
    { id: 'rally', coach: (v) => explain(v) ?? COACH.rally, done: (v) => pointEnded(v) && rallyShots(v.pub.lastTurn) >= 3 },
    // 4. One real point.
    { id: 'point', coach: (v) => explain(v) ?? COACH.point, done: pointEnded },
  ],
};

/** A point ended in this frame. */
function pointEnded(v: ViewModel): boolean {
  return v.events.some((e) => e.type === 'point');
}

/** The trainee has been shown every one of `kinds` in their own turns. */
function seen(v: ViewModel, kinds: PromptKind[]): boolean {
  if (v.viewer === 'spectator') return false;
  const mine = v.pub.seenKinds?.[v.viewer] ?? [];
  return kinds.every((k) => mine.includes(k));
}

/** In-play strikes of the rally that `t` (the turn a point ended in) closed: the serve and every return. */
function rallyShots(t: TurnState | null): number {
  if (t === null || t.data.kind !== 'return') return 0;
  const { incoming, n } = t.data;
  return incoming.isServe && incoming.outcome !== 'in' ? 0 : n + 1;
}

/** Explains what just happened to the trainee (every lesson): re-toss, faults, a stretch shot. */
function explain(v: ViewModel): string | null {
  const me = v.viewer;
  const t = v.pub.turn;
  if (me === 'spectator' || t === null) return null;
  const d = t.data;
  if (d.kind === 'serve') {
    if (t.phase === 'leadIn' && d.leadIn.kind === 'point' && d.leadIn.text.includes('DOUBLE FAULT')) return COACH.doubleFault;
    if (d.owner !== me) return null;
    if (t.phase === 'leadIn' && d.leadIn.kind === 'fault') {
      return d.leadIn.text.includes('BALL DROPPED') ? COACH.faultDropped : COACH.fault;
    }
    return t.phase === 'catch' || (t.phase === 'preServe' && t.setIndex > 0) ? COACH.retoss : null;
  }
  const last = v.pub.lastTurn;
  const stretched = last?.data.owner === me && last.outcome?.kind === 'strike' && last.outcome.strike.stretch;
  return d.owner !== me && stretched ? COACH.stretch : null;
}

/** What to do now (lessons 1–2): toss, type a serve word, chase, pick a shot, or watch the opponent's word. */
function howTo(v: ViewModel): string | null {
  const me = v.viewer;
  const t = v.pub.turn;
  if (me === 'spectator' || t === null) return null;
  if (t.data.owner !== me) return t.data.kind === 'serve' ? COACH.oppServe : COACH.watch;
  const p = t.active === null ? null : t.prompts[t.active] ?? null;
  switch (t.phase) {
    case 'preServe':
      return COACH.toss;
    case 'toss':
      return p?.locked === null ? COACH.serveWord : COACH.serveFinish;
    case 'chase':
      return COACH.chase;
    case 'choice':
      return p?.locked === null ? COACH.choice : COACH.choiceFinish;
    case 'queued':
      return COACH.queued;
    default:
      return null;
  }
}
