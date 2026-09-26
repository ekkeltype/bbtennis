import { describe, expect, it } from 'vitest';
import { CPU_LEVELS } from '../../src/core/cpu';
import { Engine } from '../../src/core/engine';
import type { MatchState, PlayerId } from '../../src/core/types';
import { BELT_COLOR } from '../../src/render/palette';
import type { ResultsParams } from '../../src/ui/context';
import {
  FIRST_MATCHES_WITH_HINTS,
  TRAINING_END_MS,
  hintsOn,
  mayPause,
  recordCpuMatch,
  resultsAfterLeave,
  trainingEnd,
  type CareerState,
  type TrainingFrame,
} from '../../src/ui/matchLifecycle';
import { DEFAULT_CAREER, DEFAULT_PROFILE, type Career } from '../../src/ui/settings';

const WHITE = CPU_LEVELS.findIndex((l) => l.belt === 'white' && l.stripes === 0);
const WHITE_STRIPE = CPU_LEVELS.findIndex((l) => l.belt === 'white' && l.stripes === 1);
const GREEN = CPU_LEVELS.findIndex((l) => l.belt === 'green' && l.stripes === 0);

/** A finished vs-CPU match won by `winner`, the player (0) typing at `typingMs` for `intervalSum` intervals. */
function finished(winner: PlayerId, typing = { intervalSum: 0, typingMs: 0 }): MatchState {
  const look = DEFAULT_PROFILE.look;
  const s = new Engine({
    config: { format: 'tiebreak', pace: 'normal', surface: 'hard', wordPack: 'everyday', deuceRule: 'advantage', training: null },
    players: [
      { name: 'Alex', look, kind: 'human', cpuLevel: null },
      { name: 'Mika', look, kind: 'cpu', cpuLevel: 0 },
    ],
    seed: 1,
  }).state;
  s.status = 'over';
  s.winner = winner;
  s.stats[0] = { ...s.stats[0], ...typing };
  return s;
}

const career = (earned: string[] = []): Career => ({ ...structuredClone(DEFAULT_CAREER), earned });
const state = (over: Partial<CareerState> = {}): CareerState => ({
  career: career(),
  matchesPlayed: 0,
  headband: null,
  headbandChosen: false,
  ...over,
});

describe('hintsOn (spec §3.12: a player\'s first 3 matches)', () => {
  it('is on for the first matches and off from the fourth', () => {
    expect(FIRST_MATCHES_WITH_HINTS).toBe(3);
    expect([0, 1, 2, 3, 10].map(hintsOn)).toEqual([true, true, true, false, false]);
  });
});

describe('mayPause (in-match menu gating)', () => {
  const playing = { kind: 'cpu' as const, finished: false, over: false };

  it('opens over a match being played on its play screen', () => {
    expect(mayPause(playing, 'match', false)).toBe(true);
    expect(mayPause({ ...playing, kind: 'training' }, 'training', false)).toBe(true);
    expect(mayPause({ ...playing, kind: 'online' }, 'match', false)).toBe(true);
  });

  it('not once the match is finished or over, or away from the play screen', () => {
    expect(mayPause({ ...playing, finished: true }, 'match', false)).toBe(false);
    expect(mayPause({ ...playing, over: true }, 'match', false)).toBe(false);
    for (const screen of ['pause', 'results', 'mainMenu', 'title']) expect(mayPause(playing, screen, false)).toBe(false);
  });

  it('pauses automatically (blur, hidden tab, leaving fullscreen) only local matches: online play never pauses', () => {
    expect(mayPause(playing, 'match', true)).toBe(true);
    expect(mayPause({ ...playing, kind: 'training' }, 'training', true)).toBe(true);
    expect(mayPause({ ...playing, kind: 'online' }, 'match', true)).toBe(false);
  });
});

describe('trainingEnd (Training complete vs Try again)', () => {
  const frame = (f: Partial<TrainingFrame> = {}): TrainingFrame => ({ lessonsDone: false, over: false, running: true, dtMs: 16, ...f });

  it('shows nothing while the lessons go on', () => {
    expect(trainingEnd(null, frame())).toEqual({ sinceDoneMs: null, show: null });
  });

  it('starts counting when every lesson is done, and shows "complete" after TRAINING_END_MS of running time', () => {
    let since = trainingEnd(null, frame({ lessonsDone: true })).sinceDoneMs;
    expect(since).toBe(0);
    let shown = null;
    let frames = 0;
    while (shown === null && frames < 1000) {
      const step = trainingEnd(since, frame({ lessonsDone: true, dtMs: 100 }));
      since = step.sinceDoneMs;
      shown = step.show;
      frames++;
    }
    expect(shown).toBe('complete');
    expect(frames).toBe(TRAINING_END_MS / 100);
  });

  it('counts only running frames: a pause right after the last lesson never lets the panel replace the menu', () => {
    const done = trainingEnd(null, frame({ lessonsDone: true }));
    let since = done.sinceDoneMs;
    for (let i = 0; i < 600; i++) {
      const step = trainingEnd(since, frame({ lessonsDone: true, running: false, dtMs: 100 }));
      expect(step.show).toBeNull();
      since = step.sinceDoneMs;
    }
    expect(since).toBe(0);
    expect(trainingEnd(TRAINING_END_MS - 1, frame({ lessonsDone: true, running: false, dtMs: 100 })).show).toBeNull();
    expect(trainingEnd(TRAINING_END_MS - 1, frame({ lessonsDone: true, dtMs: 1 })).show).toBe('complete');
  });

  it('shows "try again" when the match ends before the lessons are done', () => {
    expect(trainingEnd(null, frame({ over: true }))).toEqual({ sinceDoneMs: null, show: 'tryAgain' });
    expect(trainingEnd(100, frame({ lessonsDone: true, over: true, dtMs: 16 })).show).toBeNull();
  });
});

describe('recordCpuMatch (career, matches played, headband default)', () => {
  it('records the match and earns the belt of a beaten milestone level, which becomes the headband', () => {
    const r = recordCpuMatch(state({ matchesPlayed: 2 }), WHITE, finished(0, { intervalSum: 100, typingMs: 30_000 }));
    expect(r.career.perLevel[WHITE]).toEqual({ played: 1, won: 1 });
    expect(r.career.bestWpm).toBeCloseTo(40, 9);
    expect(r.matchesPlayed).toBe(3);
    expect(r.newBelt).toBe('white');
    expect(r.headband).toBe(BELT_COLOR.white);
  });

  it('earns nothing new for a loss, a non-milestone level or a belt already earned', () => {
    expect(recordCpuMatch(state(), WHITE, finished(1)).newBelt).toBeNull();
    expect(recordCpuMatch(state(), WHITE_STRIPE, finished(0)).newBelt).toBeNull();
    const again = recordCpuMatch(state({ career: career(['white']) }), WHITE, finished(0));
    expect(again.newBelt).toBeNull();
    expect(again.career.perLevel[WHITE]).toEqual({ played: 1, won: 1 });
  });

  it('dresses the player in the highest earned belt, even on a match that earned nothing', () => {
    const r = recordCpuMatch(state({ career: career(['white', 'green']), headband: BELT_COLOR.white }), WHITE_STRIPE, finished(1));
    expect(r.headband).toBe(BELT_COLOR.green);
    const higher = recordCpuMatch(state({ career: career(['white']), headband: BELT_COLOR.white }), GREEN, finished(0));
    expect(higher.newBelt).toBe('green');
    expect(higher.headband).toBe(BELT_COLOR.green);
  });

  it('keeps a headband the player chose, and none while no belt is earned', () => {
    const chosen = recordCpuMatch(state({ headband: 9, headbandChosen: true }), WHITE, finished(0));
    expect(chosen.newBelt).toBe('white');
    expect(chosen.headband).toBe(9);
    const offByChoice = recordCpuMatch(state({ headband: null, headbandChosen: true }), WHITE, finished(0));
    expect(offByChoice.headband).toBeNull();
    expect(recordCpuMatch(state({ headband: null }), WHITE, finished(1)).headband).toBeNull();
  });

  it('never changes what it was given', () => {
    const s = state();
    const before = structuredClone(s);
    recordCpuMatch(s, WHITE, finished(0));
    expect(s).toEqual(before);
  });
});

describe('resultsAfterLeave (online Results once the opponent has left)', () => {
  const online = (over: Partial<Extract<ResultsParams, { kind: 'cpu' | 'online' }>> = {}): ResultsParams => ({
    kind: 'online',
    result: finished(0),
    viewer: 0,
    newBelt: null,
    canRematch: true,
    ...over,
  });

  it('stays as it is while a rematch can still happen', () => {
    expect(resultsAfterLeave(online(), true)).toBeNull();
  });

  it('shows the Results again with the opponent gone (Rematch disabled, OPPONENT LEFT) once the rematch is off', () => {
    const shown = online();
    expect(resultsAfterLeave(shown, false)).toEqual({ ...shown, opponentLeft: true });
    const noRematch = online({ canRematch: false });
    expect(resultsAfterLeave(noRematch, false)).toEqual({ ...noRematch, opponentLeft: true });
  });

  it('only once: Results that already say so stay', () => {
    expect(resultsAfterLeave(online({ opponentLeft: true }), false)).toBeNull();
  });

  it('leaves vs-CPU and Training results alone', () => {
    expect(resultsAfterLeave({ kind: 'cpu', result: finished(0), viewer: 0, newBelt: null, canRematch: true }, false)).toBeNull();
    expect(resultsAfterLeave({ kind: 'training', done: true }, false)).toBeNull();
  });
});
