import { cosmeticRandom, envelope, filter, noise, pulseWave, tone } from './synth';

const BPM = 140;
/** Seconds per sequencer step (one sixteenth note). */
const STEP_SECONDS = 60 / BPM / 4;
const STEPS_PER_BAR = 16;
const MUSIC_SEED = 0x7171e;

/** Lead melody, one bar of 16 steps per string: a note name starts a note, '-' holds it, '.' rests. */
const LEAD_BARS = [
  'e5 - g5 - c6 - - - b5 - g5 - e5 - - -',
  'a5 - - - g5 - e5 - c5 - e5 - a5 - - -',
  'f5 - a5 - c6 - a5 - f5 - a5 - c6 - d6 -',
  'b5 - - - d6 - - - g5 - - - . . . .',
  'e5 - g5 - c6 - - - e6 - d6 - c6 - - -',
  'a5 - c6 - e6 - - - d6 - c6 - a5 - - -',
  'f5 - a5 - c6 - - - d6 - - - b5 - - -',
  'c6 - - - g5 - e5 - c5 - - - . . . .',
];

/** Bass root (MIDI) and arpeggio tones of each chord of the I–vi–IV–V progression in C. */
const CHORDS = {
  C: { bass: 48, arp: [60, 64, 67] },
  Am: { bass: 45, arp: [57, 60, 64] },
  F: { bass: 41, arp: [60, 65, 69] },
  G: { bass: 43, arp: [59, 62, 67] },
} as const;

/** One chord per half bar. */
const HALF_BAR_CHORDS: (keyof typeof CHORDS)[] = ['C', 'C', 'Am', 'Am', 'F', 'F', 'G', 'G', 'C', 'C', 'Am', 'Am', 'F', 'G', 'C', 'C'];

/** Drum steps per bar (k kick, s snare, h hat, '.' none); the last bar of the loop plays the fill. */
const DRUMS = 'k.h.s.h.k.h.s.h.';
const DRUM_FILL = 'k.h.s.h.k.h.s.ss';

interface Note {
  step: number;
  midi: number;
  steps: number;
}

const SEMITONE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function midiOf(name: string): number {
  const m = /^([a-g])(#?)(\d)$/.exec(name);
  const semitone = m ? SEMITONE[m[1] ?? ''] : undefined;
  if (!m || semitone === undefined) throw new Error(`music: bad note '${name}'`);
  return 12 * (Number(m[3]) + 1) + semitone + (m[2] ? 1 : 0);
}

function hz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Parses step strings into a per-step lookup of the notes that start there. */
function parseBars(bars: readonly string[]): (Note | undefined)[] {
  const byStep: (Note | undefined)[] = [];
  let last: Note | undefined;
  bars.forEach((bar, b) => {
    const tokens = bar.split(' ');
    if (tokens.length !== STEPS_PER_BAR) throw new Error(`music: bar ${b + 1} has ${tokens.length} steps`);
    tokens.forEach((token, i) => {
      const step = b * STEPS_PER_BAR + i;
      if (token === '-') {
        if (last && last.step + last.steps === step) last.steps++;
      } else if (token !== '.') {
        last = { step, midi: midiOf(token), steps: 1 };
        byStep[step] = last;
      }
    });
  });
  return byStep;
}

const LEAD = parseBars(LEAD_BARS);
/** Steps in one pass of the loop (8 bars of sixteenths). */
const LOOP_STEPS = LEAD_BARS.length * STEPS_PER_BAR;

/** A held note's gain: 5 ms attack, a gentle fall to 60 %, then a 20 ms release. */
function held(ctx: BaseAudioContext, dest: AudioNode, t: number, peak: number, dur: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.005);
  g.gain.linearRampToValueAtTime(peak * 0.6, t + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, t + dur);
  g.connect(dest);
  return g;
}

/**
 * Procedural chiptune title loop: a tiny step sequencer driving a 25 % pulse lead, a square
 * arpeggio, a triangle bass and noise drums. Call `scheduleUntil` ahead of the context clock.
 */
export class ChiptuneSequencer {
  private step = 0;
  private readonly leadWave: PeriodicWave;
  private readonly random = cosmeticRandom(MUSIC_SEED);

  /** The loop's first step sounds at context time `startAt`, into `dest`. */
  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly dest: AudioNode,
    private readonly startAt: number,
  ) {
    this.leadWave = pulseWave(ctx, 0.25);
  }

  /** Schedules every step that starts before context time `until`; steps already in the past are skipped. */
  scheduleUntil(until: number): void {
    for (;;) {
      const t = this.startAt + this.step * STEP_SECONDS;
      if (t >= until) return;
      if (t >= this.ctx.currentTime) this.playStep(this.step % LOOP_STEPS, t);
      this.step++;
    }
  }

  private playStep(step: number, t: number): void {
    const { ctx, dest } = this;
    const inBar = step % STEPS_PER_BAR;
    const chord = CHORDS[HALF_BAR_CHORDS[Math.floor(step / (STEPS_PER_BAR / 2))] ?? 'C'];

    const lead = LEAD[step];
    if (lead) {
      const dur = lead.steps * STEP_SECONDS;
      tone(ctx, held(ctx, dest, t, 0.11, dur), this.leadWave, t, dur, hz(lead.midi));
    }
    const arp = chord.arp[step % 3] ?? chord.bass;
    tone(ctx, envelope(ctx, dest, t, 0.045, 0.002, STEP_SECONDS * 0.9), 'square', t, STEP_SECONDS, hz(arp));
    if (inBar % 2 === 0) {
      const midi = chord.bass + (inBar % 4 === 2 ? 12 : 0);
      tone(ctx, envelope(ctx, dest, t, 0.28, 0.004, STEP_SECONDS * 1.8), 'triangle', t, STEP_SECONDS * 2, hz(midi));
    }
    this.drum((step >= LOOP_STEPS - STEPS_PER_BAR ? DRUM_FILL : DRUMS)[inBar], t);
  }

  private drum(kind: string | undefined, t: number): void {
    const { ctx, dest, random } = this;
    if (kind === 'k') {
      tone(ctx, envelope(ctx, dest, t, 0.35, 0.001, 0.14), 'sine', t, 0.15, 150, 45);
    } else if (kind === 's') {
      noise(ctx, envelope(ctx, filter(ctx, dest, 'bandpass', 1800, 0.8), t, 0.5, 0.001, 0.11), t, 0.12, random);
      tone(ctx, envelope(ctx, dest, t, 0.08, 0.001, 0.06), 'triangle', t, 0.07, 190);
    } else if (kind === 'h') {
      noise(ctx, envelope(ctx, filter(ctx, dest, 'highpass', 7000, 0.7), t, 0.15, 0.001, 0.03), t, 0.04, random);
    }
  }
}
