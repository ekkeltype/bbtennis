import { describe, expect, it } from 'vitest';
import type { ActiveWords, DebugHooks } from '../../src/game/debug';
import { hardestOption, mediumOption, momentOf, nextKey, pageSnapshot, type Snapshot } from './typist.mjs';

/** A snapshot of player 0's own turn in `status`, with `words` active. */
const own = (status: string, words: ActiveWords | null = null): Snapshot => ({ status, me: 0, owner: 0, words, points: 0, coach: null });
const serve = (locked: number | null, typed: number): ActiveWords => ({ words: ['cat', 'garden', 'strawberry'], locked, typed, kind: 'serve' });
const chase = (typed: number): ActiveWords => ({ words: ['moon'], locked: 0, typed, kind: 'chase' });

/** Debug hooks over a fake view model: only the fields pageSnapshot reads. */
function hooks(o: { status: string; viewer: 0 | 1 | 'spectator'; pubOwner: 0 | 1 | null; liveOwner?: 0 | 1; over?: boolean; words?: ActiveWords | null }): DebugHooks {
  const turn = (owner: 0 | 1 | null) => (owner === null ? null : { data: { owner } });
  const vm = {
    viewer: o.viewer,
    liveTurn: o.liveOwner === undefined ? null : turn(o.liveOwner),
    pub: { status: o.over === true ? 'over' : 'playing', turn: turn(o.pubOwner), stats: [{ pointsWon: 3 }, { pointsWon: 2 }] },
    overlay: { coach: 'PRESS SPACE TO TOSS THE BALL' },
  };
  return {
    view: () => vm,
    activeWords: () => o.words ?? null,
    owner: () => o.pubOwner,
    status: () => o.status,
  } as unknown as DebugHooks;
}

describe('pageSnapshot', () => {
  it('reads nothing on a page without the debug hooks or a match', () => {
    const empty = { status: 'none', me: null, owner: null, words: null, points: 0, coach: null };
    expect(pageSnapshot({})).toEqual(empty);
    expect(pageSnapshot({ __bbt: { ...hooks({ status: 'none', viewer: 0, pubOwner: null }), view: () => null } })).toEqual(empty);
  });

  it("reads the status, the viewer, the turn's owner, the active words, the points played and the coach text", () => {
    const words = serve(1, 2);
    expect(pageSnapshot({ __bbt: hooks({ status: 'toss', viewer: 1, pubOwner: 1, words }) })).toEqual({
      status: 'toss',
      me: 1,
      owner: 1,
      words,
      points: 5,
      coach: 'PRESS SPACE TO TOSS THE BALL',
    });
  });

  it("takes the owner from the viewer's live turn, the turn the status and words come from, over the displayed one", () => {
    expect(pageSnapshot({ __bbt: hooks({ status: 'chase', viewer: 1, pubOwner: 0, liveOwner: 1 }) }).owner).toBe(1);
  });

  it('has no owner once the match is over, and no player for a spectator', () => {
    expect(pageSnapshot({ __bbt: hooks({ status: 'matchOver', viewer: 0, pubOwner: 0, over: true }) }).owner).toBeNull();
    expect(pageSnapshot({ __bbt: hooks({ status: 'toss', viewer: 'spectator', pubOwner: 0 }) }).me).toBeNull();
  });
});

describe('option policies', () => {
  it('mediumOption picks the middle of three words, else the only one', () => {
    expect(mediumOption(['cat', 'garden', 'strawberry'])).toBe(1);
    expect(mediumOption(['moon'])).toBe(0);
  });

  it('mediumOption takes the medium word of 3 or 4 options, the only word of a chase', () => {
    expect(mediumOption(['a', 'b', 'c'])).toBe(1);
    expect(mediumOption(['a', 'b', 'c', 'd'])).toBe(1);
    expect(mediumOption(['a'])).toBe(0);
  });

  it('hardestOption picks the last (hardest) word', () => {
    expect(hardestOption(['cat', 'garden', 'strawberry'])).toBe(2);
    expect(hardestOption(['moon'])).toBe(0);
  });
});

describe('nextKey', () => {
  it('presses Space to toss in its own PRE_SERVE', () => {
    expect(nextKey(own('preServe'))).toBe('Space');
  });

  it("starts the medium option of a serve or a choice, or the option `choose` picks", () => {
    expect(nextKey(own('toss', serve(null, 0)))).toBe('g');
    expect(nextKey(own('choice', { ...serve(null, 0), kind: 'choice' }))).toBe('g');
    expect(nextKey(own('toss', serve(null, 0)), () => 2)).toBe('s');
  });

  it('types the next letter of the locked word, whatever `choose` says', () => {
    expect(nextKey(own('toss', serve(2, 4)))).toBe('w');
    expect(nextKey(own('choice', serve(0, 1)), () => 2)).toBe('a');
    expect(nextKey(own('chase', chase(0)))).toBe('m');
    expect(nextKey(own('chase', chase(3)))).toBe('n');
  });

  it('waits once the word is complete (a queued shot) or without an active prompt', () => {
    expect(nextKey(own('choice', serve(0, 3)))).toBeNull();
    expect(nextKey(own('queued', serve(0, 3)))).toBeNull();
    expect(nextKey(own('toss', null))).toBeNull();
  });

  it.each(['none', 'leadIn:intro', 'leadIn:point', 'catch', 'paused', 'countdown', 'matchOver', 'over', 'ended'])(
    'waits in %s',
    (status) => {
      expect(nextKey(own(status, serve(0, 1)))).toBeNull();
    },
  );

  it("never types in the opponent's turn, or without a player", () => {
    expect(nextKey({ ...own('preServe'), owner: 1 })).toBeNull();
    expect(nextKey({ ...own('chase', chase(1)), owner: 1 })).toBeNull();
    expect(nextKey({ ...own('chase', chase(1)), me: null })).toBeNull();
    expect(nextKey({ ...own('chase', chase(1)), owner: null })).toBeNull();
  });
});

describe('momentOf', () => {
  it('names the point call on either side', () => {
    expect(momentOf(own('leadIn:point'))).toBe('pointCall');
    expect(momentOf({ ...own('leadIn:point'), owner: 1 })).toBe('pointCall');
  });

  it('names its own PRE_SERVE', () => {
    expect(momentOf(own('preServe'))).toBe('preServe');
    expect(momentOf({ ...own('preServe'), owner: 1 })).toBeNull();
  });

  it('names its own toss, chase and choice once a word is part typed', () => {
    expect(momentOf(own('toss', serve(1, 2)))).toBe('toss');
    expect(momentOf(own('chase', chase(1)))).toBe('chase');
    expect(momentOf(own('choice', { ...serve(0, 2), kind: 'choice' }))).toBe('choice');
  });

  it('names nothing before the first letter, once the word is complete, or in the opponent\'s turn', () => {
    expect(momentOf(own('toss', serve(null, 0)))).toBeNull();
    expect(momentOf(own('chase', chase(0)))).toBeNull();
    expect(momentOf(own('chase', chase(4)))).toBeNull();
    expect(momentOf({ ...own('chase', chase(1)), owner: 1 })).toBeNull();
    expect(momentOf(own('leadIn:intro'))).toBeNull();
    expect(momentOf(own('queued', serve(0, 3)))).toBeNull();
  });
});
