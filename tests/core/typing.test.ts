import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/core/tuning';
import type { PromptState, Tier, WordOption } from '../../src/core/types';
import {
  applyLetter,
  classifyKey,
  createPrompt,
  isComplete,
  lockedWord,
  progress,
  wordCps,
  wpmOf,
} from '../../src/core/typing';
import type { KeyClass, RawKey } from '../../src/core/typing';

function opt(word: string): WordOption {
  const tier: Tier = word.length <= 5 ? 'easy' : word.length <= 9 ? 'medium' : 'hard';
  return { word, len: word.length, tier };
}

function typeWord(p: PromptState, letters: string, τ0: number, stepMs: number): void {
  for (const [i, ch] of [...letters].entries()) applyLetter(p, ch, τ0 + i * stepMs);
}

function snapshot(p: PromptState): PromptState {
  return JSON.parse(JSON.stringify(p)) as PromptState;
}

describe('createPrompt', () => {
  it('creates an unlocked choice prompt with zeroed counters', () => {
    const options = [opt('ball'), opt('topspin'), opt('quarterfinal')];
    expect(createPrompt(7, 'choice', options, 1234)).toEqual({
      id: 7,
      kind: 'choice',
      options,
      locked: null,
      typed: 0,
      correctKeys: 0,
      wrongKeys: 0,
      slips: 0,
      inSlip: false,
      tFirst: null,
      tLast: null,
      shownAt: 1234,
      completedAt: null,
      lastWrongAt: null,
    });
  });

  it('creates a chase prompt already locked on its single word, with nothing typed', () => {
    const p = createPrompt(3, 'chase', [opt('lob')], 0);
    expect(p.locked).toBe(0);
    expect(p.typed).toBe(0);
    expect(p.tFirst).toBeNull();
    expect(lockedWord(p)).toEqual(opt('lob'));
  });

  it('survives a JSON round trip unchanged at every step', () => {
    const p = createPrompt(1, 'serve', [opt('ace'), opt('volley'), opt('backhander')], 5);
    expect(snapshot(p)).toEqual(p);
    applyLetter(p, 'v', 10);
    applyLetter(p, 'x', 20);
    expect(snapshot(p)).toEqual(p);
    typeWord(p, 'olley', 30, 10);
    expect(snapshot(p)).toEqual(p);
  });
});

describe('applyLetter', () => {
  it('locks by initial and types strictly', () => {
    const p = createPrompt(1, 'choice', [opt('ball'), opt('topspin'), opt('quarterfinal')], 0);
    expect(applyLetter(p, 'z', 10)).toBe('ignored');
    expect(p.wrongKeys).toBe(0);
    expect(applyLetter(p, 't', 100)).toBe('locked');
    expect(p.locked).toBe(1);
    expect(applyLetter(p, 'x', 150)).toBe('wrong');
    expect(applyLetter(p, 'y', 160)).toBe('wrong');
    expect(p.slips).toBe(1); expect(p.wrongKeys).toBe(2);
    expect(applyLetter(p, 'o', 300)).toBe('correct');
    expect(applyLetter(p, 'q', 310)).toBe('wrong');
    expect(p.slips).toBe(2);
    for (const [i, ch] of [...'pspin'].entries()) applyLetter(p, ch, 400 + i * 100);
    expect(isComplete(p)).toBe(true); expect(p.completedAt).toBe(800);
    expect(wordCps(p)).toBeCloseTo(6 / 0.7, 5);
  });

  it('leaves the prompt untouched when an unlocked prompt gets a letter matching no initial', () => {
    const p = createPrompt(1, 'choice', [opt('ball'), opt('topspin'), opt('quarterfinal')], 0);
    const before = snapshot(p);
    expect(applyLetter(p, 'o', 50)).toBe('ignored');
    expect(p).toEqual(before);
  });

  it('sets the lock bookkeeping: typed 1, tFirst = tLast = τ, lock key counted as correct', () => {
    const p = createPrompt(1, 'serve', [opt('ace'), opt('volley'), opt('backhander')], 0);
    expect(applyLetter(p, 'b', 250)).toBe('locked');
    expect(p.locked).toBe(2);
    expect(p.typed).toBe(1);
    expect(p.correctKeys).toBe(1);
    expect(p.tFirst).toBe(250);
    expect(p.tLast).toBe(250);
    expect(p.completedAt).toBeNull();
    expect(lockedWord(p)).toEqual(opt('backhander'));
  });

  it('records wrong keys: lastWrongAt, one slip per run, cursor and tLast unmoved', () => {
    const p = createPrompt(1, 'choice', [opt('ball'), opt('topspin'), opt('quarterfinal')], 0);
    applyLetter(p, 'b', 100);
    expect(applyLetter(p, 'l', 180)).toBe('wrong');
    expect(p.inSlip).toBe(true);
    expect(p.lastWrongAt).toBe(180);
    expect(applyLetter(p, 'l', 220)).toBe('wrong');
    expect(p.lastWrongAt).toBe(220);
    expect(p.slips).toBe(1);
    expect(p.wrongKeys).toBe(2);
    expect(p.typed).toBe(1);
    expect(p.tLast).toBe(100);
    expect(applyLetter(p, 'a', 300)).toBe('correct');
    expect(p.inSlip).toBe(false);
    expect(p.tLast).toBe(300);
    expect(p.lastWrongAt).toBe(220);
  });

  it('does not re-lock or switch words once locked: another initial is a wrong key', () => {
    const p = createPrompt(1, 'choice', [opt('ball'), opt('topspin'), opt('quarterfinal')], 0);
    applyLetter(p, 'b', 100);
    expect(applyLetter(p, 't', 200)).toBe('wrong');
    expect(p.locked).toBe(0);
    expect(p.typed).toBe(1);
  });

  it('returns completed on the final letter and keeps correctKeys equal to typed', () => {
    const p = createPrompt(1, 'choice', [opt('ball'), opt('topspin'), opt('quarterfinal')], 0);
    const results = [...'bxall'].map((ch, i) => applyLetter(p, ch, 100 + i * 100));
    expect(results).toEqual(['locked', 'wrong', 'correct', 'correct', 'completed']);
    expect(p.typed).toBe(4);
    expect(p.correctKeys).toBe(4);
    expect(p.wrongKeys).toBe(1);
    expect(p.tLast).toBe(500);
    expect(p.completedAt).toBe(500);
  });

  it('chase prompt: the first correct key sets tFirst; earlier wrong keys do not', () => {
    const p = createPrompt(4, 'chase', [opt('lob')], 50);
    expect(applyLetter(p, 'x', 60)).toBe('wrong');
    expect(p.tFirst).toBeNull();
    expect(p.slips).toBe(1);
    expect(applyLetter(p, 'l', 100)).toBe('correct');
    expect(p.tFirst).toBe(100);
    expect(p.tLast).toBe(100);
    expect(p.typed).toBe(1);
    expect(applyLetter(p, 'o', 200)).toBe('correct');
    expect(p.tFirst).toBe(100);
    expect(applyLetter(p, 'b', 300)).toBe('completed');
    expect(p.completedAt).toBe(300);
    expect(wordCps(p)).toBeCloseTo(2 / 0.2, 9);
  });

  it('accepts uppercase letters for locking and typing', () => {
    const p = createPrompt(1, 'choice', [opt('ball'), opt('topspin'), opt('quarterfinal')], 0);
    expect(applyLetter(p, 'Q', 100)).toBe('locked');
    expect(p.locked).toBe(2);
    expect(applyLetter(p, 'U', 200)).toBe('correct');
    expect(p.typed).toBe(2);
  });

  it('ignores every key after completion without touching the prompt', () => {
    const p = createPrompt(1, 'chase', [opt('net')], 0);
    typeWord(p, 'net', 100, 100);
    expect(isComplete(p)).toBe(true);
    const before = snapshot(p);
    expect(applyLetter(p, 'x', 400)).toBe('ignored');
    expect(applyLetter(p, 'n', 500)).toBe('ignored');
    expect(p).toEqual(before);
  });
});

describe('isComplete / lockedWord / progress', () => {
  it('reports nothing for an unlocked prompt', () => {
    const p = createPrompt(1, 'choice', [opt('ball'), opt('topspin'), opt('quarterfinal')], 0);
    expect(isComplete(p)).toBe(false);
    expect(lockedWord(p)).toBeNull();
    expect(progress(p)).toBe(0);
  });

  it('tracks progress of the locked word from 0 to 1', () => {
    const p = createPrompt(1, 'chase', [opt('smash')], 0);
    expect(progress(p)).toBe(0);
    applyLetter(p, 's', 100);
    applyLetter(p, 'x', 150);
    expect(progress(p)).toBeCloseTo(1 / 5, 9);
    typeWord(p, 'mas', 200, 100);
    expect(progress(p)).toBeCloseTo(4 / 5, 9);
    expect(isComplete(p)).toBe(false);
    applyLetter(p, 'h', 500);
    expect(progress(p)).toBe(1);
    expect(isComplete(p)).toBe(true);
  });
});

describe('wordCps / wpmOf', () => {
  it('floors the typing span at minSpanS when all keys share one τ', () => {
    const p = createPrompt(1, 'choice', [opt('ball'), opt('topspin'), opt('quarterfinal')], 0);
    typeWord(p, 'quarterfinal', 1000, 0);
    expect(isComplete(p)).toBe(true);
    expect(wordCps(p)).toBeCloseTo(11 / TUNING.speed.minSpanS, 9);
  });

  it('uses the real span once it exceeds minSpanS', () => {
    const p = createPrompt(1, 'chase', [opt('lob')], 0);
    typeWord(p, 'lob', 0, 30);
    expect(wordCps(p)).toBeCloseTo(2 / 0.06, 9);
  });

  it('returns 0 (never NaN) for a prompt that is not complete', () => {
    const p = createPrompt(1, 'chase', [opt('lob')], 0);
    expect(wordCps(p)).toBe(0);
    applyLetter(p, 'l', 100);
    expect(wordCps(p)).toBe(0);
  });

  it('converts cps to WPM at 12 per cps', () => {
    expect(wpmOf(5)).toBe(60);
    expect(wpmOf(0)).toBe(0);
    expect(wpmOf(6 / 0.7)).toBeCloseTo(72 / 0.7, 9);
  });
});

describe('classifyKey', () => {
  const base: RawKey = {
    key: 'a', code: 'KeyA', repeat: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false,
  };
  const letter = (l: string, viaCode = false): KeyClass => ({ kind: 'letter', letter: l, viaCode });
  const toss: KeyClass = { kind: 'toss' };
  const ignore: KeyClass = { kind: 'ignore' };

  const cases: [string, Partial<RawKey>, KeyClass][] = [
    ['plain letter', {}, letter('a')],
    ['uppercase letter (Shift / Caps Lock)', { key: 'A' }, letter('a')],
    ['layout letter wins over code (AZERTY a on KeyQ)', { key: 'a', code: 'KeyQ' }, letter('a')],
    ['auto-repeat', { repeat: true }, ignore],
    ['IME composition', { isComposing: true }, ignore],
    ['IME Process key', { key: 'Process', code: 'KeyA' }, ignore],
    ['Dead key', { key: 'Dead', code: 'BracketLeft' }, ignore],
    ['Unidentified key', { key: 'Unidentified', code: 'KeyA' }, ignore],
    ['Ctrl+R', { key: 'r', code: 'KeyR', ctrlKey: true }, ignore],
    ['Ctrl+W', { key: 'w', code: 'KeyW', ctrlKey: true }, ignore],
    ['Meta+W', { key: 'w', code: 'KeyW', metaKey: true }, ignore],
    ['Alt+x', { key: 'x', code: 'KeyX', altKey: true }, ignore],
    ['AltGr letter (Ctrl+Alt)', { key: 'ł', code: 'KeyL', ctrlKey: true, altKey: true }, ignore],
    ['Space', { key: ' ', code: 'Space' }, toss],
    ['Space auto-repeat', { key: ' ', code: 'Space', repeat: true }, ignore],
    ['Ctrl+Space', { key: ' ', code: 'Space', ctrlKey: true }, ignore],
    ['accented letter on KeyE', { key: 'é', code: 'KeyE' }, letter('e', true)],
    ['accented letter on a digit key (AZERTY é)', { key: 'é', code: 'Digit2' }, ignore],
    ['Cyrillic letter on KeyA', { key: 'ф', code: 'KeyA' }, letter('a', true)],
    ['uppercase Cyrillic letter on KeyA', { key: 'Ф', code: 'KeyA' }, letter('a', true)],
    ['long s (case-folds to s under /iu) on KeyS', { key: 'ſ', code: 'KeyS' }, letter('s', true)],
    ['digit', { key: '1', code: 'Digit1' }, ignore],
    ['punctuation', { key: ';', code: 'Semicolon' }, ignore],
    ['Enter', { key: 'Enter', code: 'Enter' }, ignore],
    ['Tab', { key: 'Tab', code: 'Tab' }, ignore],
    ['Escape', { key: 'Escape', code: 'Escape' }, ignore],
    ['Shift alone', { key: 'Shift', code: 'ShiftLeft' }, ignore],
  ];

  it.each(cases)('%s', (_name, over, expected) => {
    expect(classifyKey({ ...base, ...over })).toEqual(expected);
  });
});
