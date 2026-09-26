import { clamp } from '../core/util';

/** Calls about events older than this (ms) are dropped rather than announced late (spec §4.4). */
const MAX_CALL_AGE_MS = 800;

/** A voice the umpire may use: English (`en*`) and synthesised on this machine, never a network voice. */
function isLocalEnglish(v: SpeechSynthesisVoice): boolean {
  return v.localService === true && v.lang.toLowerCase().startsWith('en');
}

/**
 * The chair umpire's voice through the Web Speech API (spec §4.4). Unavailable (and silent) without
 * speech synthesis or a local English voice; every speech failure is swallowed (spec §5.4).
 */
export class Umpire {
  /** The player's umpire-voice toggle. */
  enabled = true;
  private synth: SpeechSynthesis | null = null;
  private utterance: typeof SpeechSynthesisUtterance | null = null;
  private voice: SpeechSynthesisVoice | null = null;

  /** `getVolume` returns master × sfx volume (0..1), read at every call. */
  constructor(private readonly getVolume: () => number) {
    try {
      const synth: SpeechSynthesis | undefined = globalThis.speechSynthesis;
      const utterance: typeof SpeechSynthesisUtterance | undefined = globalThis.SpeechSynthesisUtterance;
      if (!synth || typeof utterance !== 'function') return;
      this.synth = synth;
      this.utterance = utterance;
      this.pickVoice();
      synth.addEventListener('voiceschanged', () => this.pickVoice());
    } catch {
      this.synth = null;
      this.voice = null;
    }
  }

  /** True while a local English voice exists; the options screen disables the toggle otherwise. */
  get available(): boolean {
    return this.voice !== null;
  }

  /** Speaks `text`, cutting off any earlier call, unless disabled, silent, or the event is over 800 ms old. */
  say(text: string, eventAgeMs: number): void {
    const { synth, utterance: Utterance, voice } = this;
    if (!this.enabled || !synth || !Utterance || !voice) return;
    if (!(eventAgeMs <= MAX_CALL_AGE_MS)) return;
    try {
      const volume = clamp(this.getVolume(), 0, 1);
      if (!(volume > 0)) return;
      const u = new Utterance(text);
      u.voice = voice;
      u.lang = voice.lang;
      u.volume = volume;
      synth.cancel();
      synth.speak(u);
    } catch {
      // Speech failures mute silently.
    }
  }

  private pickVoice(): void {
    try {
      this.voice = this.synth?.getVoices().find(isLocalEnglish) ?? null;
    } catch {
      this.voice = null;
    }
  }
}
