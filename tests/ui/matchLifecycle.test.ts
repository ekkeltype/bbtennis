import { describe, expect, it, vi } from 'vitest';
import { CPU_LEVELS } from '../../src/core/cpu';
import { Engine } from '../../src/core/engine';
import { TUNING } from '../../src/core/tuning';
import type { MatchState, PlayerId, ViewModel } from '../../src/core/types';
import { VirtualScheduler } from '../../src/game/clock';
import { LocalSession } from '../../src/game/localSession';
import type { Session } from '../../src/game/session';
import { BELT_COLOR } from '../../src/render/palette';
import type { MatchKind, ResultsParams } from '../../src/ui/context';
import {
  FIRST_MATCHES_WITH_HINTS,
  TRAINING_END_MS,
  decided,
  hintsOn,
  mayPause,
  onlineEnd,
  recordCpuMatch,
  recordWhenDecided,
  resultsAfterLeave,
  trainingEnd,
  type CareerState,
  type CpuCredit,
  type Match,
  type TrainingFrame,
} from '../../src/ui/matchLifecycle';
import { attractPlayers } from '../../src/ui/players';
import { DEFAULT_CAREER, DEFAULT_PROFILE, type Belt, type Career } from '../../src/ui/settings';

const WHITE = CPU_LEVELS.findIndex((l) => l.belt === 'white' && l.stripes === 0);
const WHITE_STRIPE = CPU_LEVELS.findIndex((l) => l.belt === 'white' && l.stripes === 1);
const GREEN = CPU_LEVELS.findIndex((l) => l.belt === 'green' && l.stripes === 0);
const BROWN_2 = CPU_LEVELS.findIndex((l) => l.belt === 'brown' && l.stripes === 2);
const BLACK_2ND_DAN = CPU_LEVELS.findIndex((l) => l.belt === 'black' && l.dan === 2);

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

/** A CPU-vs-CPU tiebreak on a virtual clock, played frame by frame up to the frame whose state says it is over. */
function playedToTheEnd(): { clock: VirtualScheduler; session: LocalSession } {
  const clock = new VirtualScheduler();
  const session = new LocalSession({
    config: { format: 'tiebreak', pace: 'normal', surface: 'hard', wordPack: 'everyday', deuceRule: 'advantage', training: null },
    players: attractPlayers(() => 0.5),
    seed: 11,
    human: null,
    scheduler: clock,
  });
  let vm = session.frame(0);
  for (let i = 0; i < 20_000 && vm.pub.status !== 'over'; i++) {
    clock.advance(250);
    vm = session.frame(250);
  }
  return { clock, session };
}

describe('decided (the MATCH_OVER celebration counts as a finished match)', () => {
  it('is false before the first frame and while the match is played', () => {
    const view = (status: 'playing' | 'over'): ViewModel => ({ pub: { status } }) as unknown as ViewModel;
    expect(decided({ over: false, view: null })).toBe(false);
    expect(decided({ over: false, view: view('playing') })).toBe(false);
    expect(decided({ over: false, view: view('over') })).toBe(true);
    expect(decided({ over: true, view: view('over') })).toBe(true);
  });

  it('from the frame the final point is decided, through the celebration: no in-match menu (its Quit or Restart would drop the match)', () => {
    const { clock, session } = playedToTheEnd();
    expect(session.view?.pub.status).toBe('over');
    expect(session.over).toBe(false);
    expect(decided(session)).toBe(true);
    for (const auto of [false, true]) {
      expect(mayPause({ kind: 'cpu', finished: false, over: decided(session) }, 'match', auto)).toBe(false);
      expect(mayPause({ kind: 'cpu', finished: false, over: session.over }, 'match', auto)).toBe(true);
    }
    let celebrating = 0;
    while (!session.over && celebrating < 10_000) {
      expect(decided(session)).toBe(true);
      clock.advance(250);
      session.frame(250);
      celebrating += 250;
    }
    expect(session.over).toBe(true);
    expect(celebrating).toBeGreaterThanOrEqual(TUNING.leadIn.matchOverMs - 250);
    expect(decided(session)).toBe(true);
  }, 60_000);
});

describe('recordWhenDecided (vs CPU: the career is written as the final point is decided)', () => {
  const LEVEL = 4;
  const match = (kind: MatchKind): Match => ({
    kind,
    session: {} as Session,
    make: null,
    level: kind === 'cpu' ? LEVEL : null,
    controls: null,
    sinceDoneMs: null,
    results: null,
    frozen: false,
    recorded: null,
  });
  const playing = (): MatchState => ({ ...finished(0), status: 'playing', winner: null });

  it('records a decided vs-CPU match exactly once, at its level with its final state, and keeps the earned belt for Results', () => {
    const record = vi.fn((_level: number, _r: MatchState): CpuCredit => ({ newBelt: 'white' }));
    const m = match('cpu');
    recordWhenDecided(m, playing(), record);
    expect(record).not.toHaveBeenCalled();
    expect(m.recorded).toBeNull();
    const end = finished(0);
    for (let i = 0; i < 5; i++) recordWhenDecided(m, end, record);
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(LEVEL, end);
    expect(m.recorded).toEqual({ newBelt: 'white' });
  });

  it('a match that earned no belt is recorded once too', () => {
    const record = vi.fn((): CpuCredit => ({ newBelt: null }));
    const m = match('cpu');
    recordWhenDecided(m, finished(1), record);
    recordWhenDecided(m, finished(1), record);
    expect(record).toHaveBeenCalledOnce();
    expect(m.recorded).toEqual({ newBelt: null });
  });

  it('keeps a first striped-level win for Results with the belt', () => {
    const m = match('cpu');
    recordWhenDecided(m, finished(0), () => ({ newBelt: null, newLevel: BROWN_2 }));
    expect(m.recorded).toEqual({ newBelt: null, newLevel: BROWN_2 });
  });

  it('never records Training or online matches', () => {
    const record = vi.fn((): CpuCredit => ({ newBelt: null }));
    for (const kind of ['training', 'online'] as const) {
      const m = match(kind);
      recordWhenDecided(m, finished(0), record);
      expect(m.recorded).toBeNull();
    }
    expect(record).not.toHaveBeenCalled();
  });

  it('records a real match on the frame its state says over, 3 s before session.over hands its result to Results', () => {
    const { session } = playedToTheEnd();
    const record = vi.fn((): CpuCredit => ({ newBelt: null }));
    const m = { ...match('cpu'), session };
    recordWhenDecided(m, session.view!.pub, record);
    expect(session.over).toBe(false);
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]).toEqual([LEVEL, session.view!.pub]);
  }, 60_000);
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

  it('earns nothing new for a loss or a belt already earned', () => {
    expect(recordCpuMatch(state(), WHITE, finished(1)).newBelt).toBeNull();
    expect(recordCpuMatch(state(), WHITE_STRIPE, finished(1)).newBelt).toBeNull();
    const again = recordCpuMatch(state({ career: career(['white']) }), WHITE, finished(0));
    expect(again.newBelt).toBeNull();
    expect(again.career.perLevel[WHITE]).toEqual({ played: 1, won: 1 });
  });

  it('a win at a striped level earns its colour too: brown with 2 stripes earns brown', () => {
    const r = recordCpuMatch(state({ career: career(['white']), headband: BELT_COLOR.white }), BROWN_2, finished(0));
    expect(r.newBelt).toBe('brown');
    expect(r.career.earned).toEqual(['white', 'brown']);
    expect(r.headband).toBe(BELT_COLOR.brown);
  });

  it('reports the first win at a striped or dan level, and nothing for a plain belt, a loss or a second win', () => {
    expect(recordCpuMatch(state({ career: career(['brown']) }), BROWN_2, finished(0)).newLevel).toBe(BROWN_2);
    expect(recordCpuMatch(state({ career: career(['black']) }), BLACK_2ND_DAN, finished(0)).newLevel).toBe(BLACK_2ND_DAN);
    expect(recordCpuMatch(state(), WHITE, finished(0)).newLevel).toBeUndefined();
    expect(recordCpuMatch(state(), BROWN_2, finished(1)).newLevel).toBeUndefined();
    const once = recordCpuMatch(state({ career: career(['brown']) }), BROWN_2, finished(0));
    const twice = recordCpuMatch({ ...state(), career: once.career }, BROWN_2, finished(0));
    expect(twice.newLevel).toBeUndefined();
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

describe('onlineEnd (what online Results say about the opponent)', () => {
  it('says nothing while the opponent is there (played out or forfeited)', () => {
    expect(onlineEnd({ endReason: 'finished', opponentGone: null })).toEqual({});
    expect(onlineEnd({ endReason: 'forfeit', opponentGone: null })).toEqual({});
  });

  it('a match cut short by the opponent disconnecting or leaving ends by it: the banner says so at once (spec §5.3)', () => {
    expect(onlineEnd({ endReason: 'disconnect', opponentGone: 'disconnect' })).toEqual({ opponentGone: 'disconnect', endedBy: 'disconnect' });
    expect(onlineEnd({ endReason: 'left', opponentGone: 'left' })).toEqual({ opponentGone: 'left', endedBy: 'left' });
  });

  it('an opponent gone after the match ended only disables Rematch (with a note)', () => {
    expect(onlineEnd({ endReason: 'finished', opponentGone: 'disconnect' })).toEqual({ opponentGone: 'disconnect' });
    expect(onlineEnd({ endReason: 'forfeit', opponentGone: 'left' })).toEqual({ opponentGone: 'left' });
  });

  it('a match this side left first is not blamed on the opponent', () => {
    expect(onlineEnd({ endReason: 'left', opponentGone: null })).toEqual({});
    expect(onlineEnd({ endReason: 'left', opponentGone: 'disconnect' })).toEqual({ opponentGone: 'disconnect' });
  });
});

describe('resultsAfterLeave (online Results once the opponent has gone)', () => {
  const online = (over: Partial<Extract<ResultsParams, { kind: 'cpu' | 'online' }>> = {}): ResultsParams => ({
    kind: 'online',
    result: finished(0),
    viewer: 0,
    newBelt: null,
    canRematch: true,
    ...over,
  });

  it('stays as it is while the opponent is there', () => {
    expect(resultsAfterLeave(online(), null)).toBeNull();
  });

  it('shows the Results again with the opponent gone (Rematch disabled, a note saying how)', () => {
    const shown = online();
    expect(resultsAfterLeave(shown, 'left')).toEqual({ ...shown, opponentGone: 'left' });
    const noRematch = online({ canRematch: false });
    expect(resultsAfterLeave(noRematch, 'disconnect')).toEqual({ ...noRematch, opponentGone: 'disconnect' });
  });

  it('only once: Results that already say the opponent has gone stay (a match cut short by it is shown right the first time)', () => {
    expect(resultsAfterLeave(online({ opponentGone: 'left' }), 'left')).toBeNull();
    expect(resultsAfterLeave(online({ opponentGone: 'disconnect', endedBy: 'disconnect' }), 'disconnect')).toBeNull();
  });

  it('leaves vs-CPU and Training results alone', () => {
    expect(resultsAfterLeave({ kind: 'cpu', result: finished(0), viewer: 0, newBelt: null, canRematch: true }, 'left')).toBeNull();
    expect(resultsAfterLeave({ kind: 'training', done: true }, 'left')).toBeNull();
  });
});
