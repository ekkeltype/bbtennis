import { afterEach, describe, expect, it, vi } from 'vitest';
import { Umpire } from '../../src/audio/speech';

interface FakeVoice {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
  voiceURI: string;
}

function voice(name: string, lang: string, localService: boolean): FakeVoice {
  return { name, lang, localService, default: false, voiceURI: name };
}

class FakeUtterance {
  voice: FakeVoice | null = null;
  lang = '';
  volume = 1;
  constructor(readonly text: string) {}
}

/** Records every call in order; voices can arrive later through `voiceschanged`, like Chrome. */
class FakeSynthesis extends EventTarget {
  readonly calls: string[] = [];
  readonly spoken: FakeUtterance[] = [];
  throwOnSpeak = false;

  constructor(private voices: FakeVoice[]) {
    super();
  }

  getVoices(): FakeVoice[] {
    return this.voices;
  }

  cancel(): void {
    this.calls.push('cancel');
  }

  speak(u: FakeUtterance): void {
    if (this.throwOnSpeak) throw new Error('synthesis-failed');
    this.calls.push(`speak:${u.text}`);
    this.spoken.push(u);
  }

  changeVoices(voices: FakeVoice[]): void {
    this.voices = voices;
    this.dispatchEvent(new Event('voiceschanged'));
  }
}

const LOCAL_EN = voice('Local English', 'en-GB', true);
const REMOTE_EN = voice('Cloud English', 'en-US', false);
const LOCAL_DE = voice('Lokal Deutsch', 'de-DE', true);

function install(voices: FakeVoice[]): FakeSynthesis {
  const synth = new FakeSynthesis(voices);
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  return synth;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Umpire without speech synthesis', () => {
  it('is unavailable and say() is a silent no-op when speechSynthesis is undefined', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    const umpire = new Umpire(() => 1);
    expect(umpire.available).toBe(false);
    expect(() => umpire.say('Fifteen love', 0)).not.toThrow();
  });

  it('is unavailable when SpeechSynthesisUtterance is missing', () => {
    const synth = install([LOCAL_EN]);
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    const umpire = new Umpire(() => 1);
    expect(umpire.available).toBe(false);
    umpire.say('Deuce', 0);
    expect(synth.calls).toEqual([]);
  });

  it('is unavailable when reading speechSynthesis throws', () => {
    Object.defineProperty(globalThis, 'speechSynthesis', {
      configurable: true,
      get() {
        throw new Error('blocked by the browser');
      },
    });
    try {
      const umpire = new Umpire(() => 1);
      expect(umpire.available).toBe(false);
      expect(() => umpire.say('Out', 0)).not.toThrow();
    } finally {
      delete (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
    }
  });
});

describe('Umpire voice choice', () => {
  it('prefers a local English voice over remote English and local non-English voices', () => {
    const synth = install([REMOTE_EN, LOCAL_DE, LOCAL_EN]);
    const umpire = new Umpire(() => 1);
    expect(umpire.available).toBe(true);
    umpire.say('Fifteen love', 0);
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0]?.voice).toBe(LOCAL_EN);
    expect(synth.spoken[0]?.lang).toBe('en-GB');
  });

  it('accepts any en* language tag regardless of case', () => {
    const plainEn = voice('Plain', 'EN', true);
    install([LOCAL_DE, plainEn]);
    expect(new Umpire(() => 1).available).toBe(true);
  });

  it('is disabled when no local English voice exists (remote-only English does not count)', () => {
    const synth = install([REMOTE_EN, LOCAL_DE]);
    const umpire = new Umpire(() => 1);
    expect(umpire.available).toBe(false);
    umpire.say('Game, Alex', 0);
    expect(synth.calls).toEqual([]);
  });

  it('picks up voices that arrive later through voiceschanged', () => {
    const synth = install([]);
    const umpire = new Umpire(() => 1);
    expect(umpire.available).toBe(false);
    synth.changeVoices([REMOTE_EN, LOCAL_EN]);
    expect(umpire.available).toBe(true);
    synth.changeVoices([REMOTE_EN]);
    expect(umpire.available).toBe(false);
  });
});

describe('Umpire.say', () => {
  it('calls cancel() before every speak()', () => {
    const synth = install([LOCAL_EN]);
    const umpire = new Umpire(() => 1);
    umpire.say('Fault', 0);
    umpire.say('Double fault', 10);
    expect(synth.calls).toEqual(['cancel', 'speak:Fault', 'cancel', 'speak:Double fault']);
  });

  it('drops calls whose event is more than 800 ms old', () => {
    const synth = install([LOCAL_EN]);
    const umpire = new Umpire(() => 1);
    umpire.say('Too late', 800.5);
    umpire.say('Never', Number.POSITIVE_INFINITY);
    umpire.say('Broken age', Number.NaN);
    expect(synth.calls).toEqual([]);
    umpire.say('Just in time', 800);
    expect(synth.calls).toEqual(['cancel', 'speak:Just in time']);
  });

  it('speaks at the volume from getVolume (master × sfx), clamped to 0..1', () => {
    const synth = install([LOCAL_EN]);
    let volume = 0.8 * 0.5;
    const umpire = new Umpire(() => volume);
    umpire.say('Deuce', 0);
    volume = 3;
    umpire.say('Advantage Alex', 0);
    expect(synth.spoken.map((u) => u.volume)).toEqual([0.4, 1]);
  });

  it('stays silent at zero volume and when the toggle is off', () => {
    const synth = install([LOCAL_EN]);
    let volume = 0;
    const umpire = new Umpire(() => volume);
    umpire.say('Silent', 0);
    volume = 1;
    umpire.enabled = false;
    umpire.say('Toggle off', 0);
    expect(synth.calls).toEqual([]);
    umpire.enabled = true;
    umpire.say('Back on', 0);
    expect(synth.calls).toEqual(['cancel', 'speak:Back on']);
  });

  it('never throws when the synthesis engine fails', () => {
    const synth = install([LOCAL_EN]);
    synth.throwOnSpeak = true;
    const umpire = new Umpire(() => 1);
    expect(() => umpire.say('Out', 0)).not.toThrow();
  });
});
