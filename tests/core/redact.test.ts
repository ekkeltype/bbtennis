import { describe, expect, it, vi } from 'vitest';
import { cpuProfile } from '../../src/core/cpu';
import { Engine } from '../../src/core/engine';
import { redact, redactEvents, redactTurn } from '../../src/core/redact';
import { createTurn, startTurn, turnInput } from '../../src/core/turn';
import { TUNING } from '../../src/core/tuning';
import { other, type GameEvent, type MatchState, type PlayerId, type TurnState, type WordOption } from '../../src/core/types';
import { Driver, PLAYERS, config, cpuTypist, idle, scripted, serveWords, withRetosses, type Typist } from './engineHelpers';
import { INSANE_WORD, SET_A, serveData, serveSet } from './turnFixtures';

const VIEWERS = [0, 1, 'spectator'] as const;
const ZEROS = [0, 0, 0, 0, 0, 0, 0, 0, 0];

/**
 * Lower-case strings of the state schema (enum values) that could also be pack words. For these only
 * the `"word":"…"` field is searched; every other word is searched as any JSON string.
 */
const SCHEMA = new Set([
  'tiebreak', 'short', 'full', 'relaxed', 'normal', 'fast', 'lightning', 'hard', 'clay', 'grass', 'dojo',
  'everyday', 'sports', 'mixed', 'tennis', 'advantage', 'golden', 'human', 'cpu', 'remote', 'easy', 'medium',
  'serve', 'chase', 'choice', 'return', 'intro', 'fault', 'point', 'none', 'deuce', 'wide', 'out', 'net',
  'toss', 'catch', 'queued', 'ended', 'strike', 'miss', 'call', 'show', 'lock', 'bad', 'done', 'freeze',
  'playing', 'over',
]);

const valuePatterns = new Map<string, RegExp>();

/** Matches `w` as a JSON string value (after ':', '[' or ',' and not followed by ':', i.e. not a key). */
function valuePattern(w: string): RegExp {
  let re = valuePatterns.get(w);
  if (re === undefined) {
    re = new RegExp(`[:\\[,]"${w}"(?!:)`);
    valuePatterns.set(w, re);
  }
  return re;
}

/** The words that appear in `json` as a word (or, for non-schema words, as any JSON string value). */
function found(json: string, words: Iterable<string>): string[] {
  return [...words].filter((w) => json.includes(`"word":"${w}"`) || (!SCHEMA.has(w) && valuePattern(w).test(json)));
}

const hidden = (o: WordOption): WordOption => ({ word: '', len: o.len, tier: o.tier, hidden: true });

function serveTurn(t: TurnState | null): TurnState & { data: { kind: 'serve' } } {
  if (t?.data.kind !== 'serve') throw new Error('expected a serve turn');
  return t as TurnState & { data: { kind: 'serve' } };
}

/** A fresh engine with its first serve turn started, in PRE_SERVE. */
function inPreServe(seed: number): { e: Engine; server: PlayerId; receiver: PlayerId } {
  const e = new Engine({ config: config(), players: PLAYERS, seed });
  const server = e.owner() as PlayerId;
  e.start(server);
  e.clock(server, TUNING.leadIn.introMs);
  return { e, server, receiver: other(server) };
}

/** Tosses at τ and lets the ball be caught; returns the τ at which PRE_SERVE begins again. */
function tossAndCatch(e: Engine, server: PlayerId, τ: number): number {
  e.input(server, 'toss', τ);
  const end = τ + 2 * TUNING.tossApexMs + TUNING.catchMs;
  e.clock(server, end);
  return end;
}

describe('redact', () => {
  it('removes rng and picker for every viewer and never mutates the input state', () => {
    const { e, server } = inPreServe(1);
    e.input(server, 'toss', 3000);
    const before = JSON.stringify(e.state);
    for (const v of VIEWERS) {
      const pub = redact(e.state, v);
      expect(pub.rng).toBeNull();
      expect(pub.picker).toBeNull();
      expect(pub).not.toBe(e.state);
      expect(pub.turn).not.toBe(e.state.turn);
    }
    expect(JSON.stringify(e.state)).toBe(before);
    expect(e.state.rng).not.toBeNull();
  });

  it('shows the opponent a serve turn as word lengths, tiers and typing counts only', () => {
    const { e, server, receiver } = inPreServe(2);
    e.input(server, 'toss', 3000);
    const turn = serveTurn(e.state.turn);
    const word = turn.data.wordSets[0]?.options[1]?.word as string;
    e.input(server, word.charAt(0), 3500);
    e.input(server, word.charAt(1) === 'z' ? 'y' : 'z', 3600);
    e.input(server, word.charAt(1), 3700);

    const pub = redact(e.state, receiver);
    const t = serveTurn(pub.turn);
    expect(t.data.wordSets).toEqual(
      turn.data.wordSets.map((s) => ({ options: s.options.map(hidden), targets: [], variant: 'T' })),
    );
    expect(t.data.randoms).toEqual(ZEROS);
    const [p] = t.prompts;
    const [q] = turn.prompts;
    expect(p?.options).toEqual(q?.options.map(hidden));
    expect(p).toMatchObject({ locked: 1, typed: 2, correctKeys: 2, wrongKeys: 1, slips: 1 });
    expect(t.log.map((x) => ('ch' in x ? x.ch : x.k))).toEqual(turn.log.map((x) => ('ch' in x ? '*' : x.k)));
    expect(t.log.filter((x) => 'ch' in x)).toHaveLength(3);
    expect(found(JSON.stringify(pub), serveWords(turn))).toEqual([]);

    for (const v of [server, 'spectator'] as const) {
      expect(redact(e.state, v)).toStrictEqual({ ...JSON.parse(JSON.stringify(e.state)), rng: null, picker: null });
    }
  });

  it('hides the target variant too (it determines the markers): every hidden set reads T', () => {
    const variants = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const { e, server, receiver } = inPreServe(seed);
      tossAndCatch(e, server, 3000);
      const real = serveTurn(e.state.turn).data.wordSets;
      for (const s of real) variants.add(s.variant);
      expect(serveTurn(redact(e.state, receiver).turn).data.wordSets.map((s) => s.variant)).toEqual(real.map(() => 'T'));
      for (const v of [server, 'spectator'] as const) {
        expect(serveTurn(redact(e.state, v).turn).data.wordSets.map((s) => s.variant)).toEqual(real.map((s) => s.variant));
      }
    }
    expect([...variants].sort()).toEqual(['T', 'wide']);
  });

  it('after the strike reveals only the struck word, in its prompt', () => {
    const { e, server, receiver } = inPreServe(3);
    let τ = tossAndCatch(e, server, 3000);
    e.input(server, 'toss', τ);
    const turn = serveTurn(e.state.turn);
    const struck = turn.data.wordSets[1]?.options[0] as WordOption;
    for (const ch of struck.word) e.input(server, ch, (τ += 120));
    expect(e.state.lastTurn?.outcome?.kind).toBe('strike');

    const pub = redact(e.state, receiver);
    const last = serveTurn(pub.lastTurn);
    const [caught, hit] = last.prompts;
    expect(caught?.options.every((o) => o.hidden === true && o.word === '')).toBe(true);
    expect(hit?.options.map((o) => o.word)).toEqual([struck.word, '', '']);
    expect(hit?.options[0]).toEqual(struck);
    expect(last.data.wordSets.every((s) => s.options.every((o) => o.hidden === true))).toBe(true);
    const json = JSON.stringify(pub);
    expect(found(json, [struck.word])).toEqual([struck.word]);
    expect(found(json, serveWords(serveTurn(e.state.lastTurn)).filter((w) => w !== struck.word))).toEqual([]);

    const ret = e.state.turn as TurnState;
    expect(ret.data.owner).toBe(receiver);
    expect(redact(e.state, receiver).turn?.data.randoms).toEqual(ret.data.randoms);
    const seenByServer = redact(e.state, server).turn as TurnState;
    expect(seenByServer.data.randoms).toEqual(ZEROS);
    expect(seenByServer.data.kind === 'return' && seenByServer.data.choice).toEqual(ret.data.kind === 'return' && ret.data.choice);
    expect(seenByServer.data.kind === 'return' && seenByServer.data.chase).toEqual(struck);
  });

  it('redactTurn matches the turns inside redact and copies its input', () => {
    const { e, server } = inPreServe(4);
    const d = new Driver(e, server === 0 ? [scripted(), idle] : [idle, scripted()]);
    d.playTurn();
    for (const v of VIEWERS) {
      const pub = redact(e.state, v);
      expect(redactTurn(e.state.turn as TurnState, v)).toStrictEqual(pub.turn);
      expect(redactTurn(e.state.lastTurn as TurnState, v)).toStrictEqual(pub.lastTurn);
    }
    const t = e.state.lastTurn as TurnState;
    expect(redactTurn(t, 'spectator')).not.toBe(t);
  });

  it('redactEvents passes the events through as copies', () => {
    const { e, server } = inPreServe(5);
    const events: GameEvent[] = [...e.input(server, 'toss', 3000)];
    const turn = serveTurn(e.state.turn);
    const word = turn.data.wordSets[0]?.options[2]?.word as string;
    [...word].forEach((ch, i) => events.push(...e.input(server, ch, 3200 + i * 100)));
    expect(events.some((x) => x.type === 'strike')).toBe(true);
    for (const v of VIEWERS) {
      const out = redactEvents(events, e.state, v);
      expect(out).toStrictEqual(events);
      expect(out).not.toBe(events);
      expect(out[0]).not.toBe(events[0]);
    }
  });
});

describe('redaction of a full-meter serve (power-meter spec §5)', () => {
  it('hides all four serve words and their targets from the receiver, keeps them for the server', () => {
    const t = createTurn(serveData({ power: 4, wordSets: [serveSet([...SET_A, INSANE_WORD])] }));
    startTurn(t);
    turnInput(t, 'toss', 2600);
    const seen = redactTurn(t, 1);
    expect(JSON.stringify(seen)).not.toContain(INSANE_WORD);
    if (seen.data.kind !== 'serve') throw new Error('expected a serve turn');
    expect(seen.data.wordSets[0]!.options.map((o) => ({ len: o.len, tier: o.tier, hidden: o.hidden }))).toEqual([
      { len: 4, tier: 'easy', hidden: true },
      { len: 6, tier: 'medium', hidden: true },
      { len: 10, tier: 'hard', hidden: true },
      { len: 14, tier: 'insane', hidden: true },
    ]);
    expect(seen.data.wordSets[0]!.targets).toEqual([]);
    expect(seen.prompts[0]!.options).toHaveLength(4);
    expect(JSON.stringify(redactTurn(t, 0))).toContain(INSANE_WORD);
  });
});

describe('redact: serve secrecy', () => {
  /** Words anyone may know: those of return turns (chase and choice) in the state. */
  function publicWords(s: MatchState): Set<string> {
    const words = new Set<string>();
    for (const t of [s.turn, s.lastTurn]) {
      if (t?.data.kind !== 'return') continue;
      words.add(t.data.chase.word);
      for (const o of t.data.choice.options) words.add(o.word);
    }
    return words;
  }

  function checkServeSecrecy(fullMeter: boolean): void {
    const spy = fullMeter
      ? vi.spyOn(Engine.prototype as unknown as { meterFor(owner: PlayerId): number | null }, 'meterFor').mockReturnValue(4)
      : null;
    let fourWordSets = 0;
    try {
      const problems: string[] = [];
      let serves = 0;
      let strikes = 0;
      let samples = 0;
      let catches = 0;
      let faults = 0;

      /** Player 1's view of player 0's serve turns in the state; every 10th sample also the owner's and a spectator's. */
      const check = (s: MatchState, when: string): void => {
        const turns = [s.turn, s.lastTurn].filter((t): t is TurnState => t?.data.kind === 'serve' && t.data.owner === 0);
        if (turns.length === 0) return;
        for (const t of turns) if (t.data.kind === 'serve') fourWordSets += t.data.wordSets.filter((set) => set.options.length === 4).length;
        const views: (PlayerId | 'spectator')[] = samples++ % 10 === 0 ? [1, 0, 'spectator'] : [1];
        const [seenBy1, seenBy0, seenByAll] = views.map((v) => {
          const pub = redact(s, v);
          if (pub.rng !== null || pub.picker !== null) problems.push(`${when}: rng/picker not removed for ${v}`);
          return JSON.stringify(pub);
        }) as [string, string?, string?];
        const known = publicWords(s);
        for (const t of turns) {
          const struck = t.outcome?.kind === 'strike' ? t.outcome.strike.word.word : null;
          const all = serveWords(t);
          const leaked = found(seenBy1, all.filter((w) => w !== struck && !known.has(w)));
          if (leaked.length > 0) problems.push(`${when}: turn ${t.data.turnId} leaked ${leaked.join(',')}`);
          if (struck !== null && found(seenBy1, [struck]).length === 0) problems.push(`${when}: struck ${struck} hidden`);
          if (seenBy0 === undefined || seenByAll === undefined) continue;
          const missing = all.filter((w) => !seenBy0.includes(`"word":"${w}"`) || !seenByAll.includes(`"word":"${w}"`));
          if (missing.length > 0) problems.push(`${when}: owner/spectator missing ${missing.join(',')}`);
        }
      };

      for (let seed = 0; serves < 1000; seed++) {
        const e = new Engine({ config: config(), players: PLAYERS, seed });
        const typists: [Typist, Typist] = [
          withRetosses(cpuTypist(0, cpuProfile(seed % 15), seed), 6),
          cpuTypist(1, cpuProfile((seed * 5 + 2) % 15), seed),
        ];
        const d = new Driver(e, typists, {
          stepMs: 50,
          stepIf: (t) => t.data.kind === 'serve' && t.data.owner === 0,
          onStep: (x, τ) => check(x.state, `seed ${seed} τ ${τ}`),
          onCall: (x, call, events) => {
            for (const ev of events) {
              if (ev.type === 'strike' && ev.isServe && ev.player === 0) {
                strikes++;
                check(x.state, `seed ${seed} strike`);
              }
              if (ev.type === 'catch' && ev.player === 0) catches++;
              if (ev.type === 'call' && ev.player === 0 && ['fault', 'ballDropped', 'timeViolation'].includes(ev.call)) faults++;
            }
          },
        });
        while (e.state.status === 'playing' && serves < 1000) {
          const t = e.state.turn as TurnState;
          if (t.data.kind === 'serve' && t.data.owner === 0) serves++;
          d.playTurn();
        }
      }

      expect(problems.slice(0, 10)).toEqual([]);
      expect(serves).toBe(1000);
      expect(strikes).toBeGreaterThan(800);
      expect(catches).toBeGreaterThan(50);
      expect(faults).toBeGreaterThan(10);
      expect(samples).toBeGreaterThan(50000);
      if (fullMeter) expect(fourWordSets).toBeGreaterThan(0);
    } finally {
      spy?.mockRestore();
    }
  }

  it('across 1,000 serves by player 0, player 1 never sees a serve word before it is struck', { timeout: 600000 }, () =>
    checkServeSecrecy(false));
  it('the same across 1,000 serves at a full meter: all four words, insane included, stay hidden', { timeout: 600000 }, () =>
    checkServeSecrecy(true));
});
