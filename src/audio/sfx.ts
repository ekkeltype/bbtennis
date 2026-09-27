import type { Surface } from '../core/types';
import { envelope, filter, gain, monoBuffer, noise, normalise, pinkNoise, SILENCE, tone } from './synth';

/** Every one-shot sound effect (spec §4.4). */
export type SfxName =
  | 'hit'
  | 'hitHard'
  | 'bounce'
  | 'netHit'
  | 'key'
  | 'bad'
  | 'lock'
  | 'done'
  | 'yourTurn'
  | 'applause'
  | 'ooh'
  | 'coin'
  | 'powerUp'
  | 'powerDown';

/** All SfxName values, in declaration order. */
export const SFX_NAMES: readonly SfxName[] = [
  'hit',
  'hitHard',
  'bounce',
  'netHit',
  'key',
  'bad',
  'lock',
  'done',
  'yourTurn',
  'applause',
  'ooh',
  'coin',
  'powerUp',
  'powerDown',
];

/** Resolved options for one voice: output gain 0..1, stereo pan −1..1, court surface, cosmetic randomness. */
export interface VoiceOptions {
  gain: number;
  pan: number;
  surface: Surface;
  random: () => number;
}

type Voice = (ctx: BaseAudioContext, out: AudioNode, t: number, v: VoiceOptions) => void;

/** Tone colour of a ball bounce on one surface: a filtered noise scuff plus a short pitched body. */
interface BounceColour {
  filter: BiquadFilterType;
  hz: number;
  q: number;
  scuff: number;
  scuffDecay: number;
  body: number;
  bodyDecay: number;
  bodyWave: 'sine' | 'triangle';
  fromHz: number;
  toHz: number;
}

/** Hard is bright, clay duller, grass the softest, the dojo floor woody and hollow (a ringing resonance). */
const BOUNCE: Record<Surface, BounceColour> = {
  hard: { filter: 'bandpass', hz: 1500, q: 1, scuff: 0.45, scuffDecay: 0.05, body: 0.4, bodyDecay: 0.08, bodyWave: 'sine', fromHz: 220, toHz: 130 },
  clay: { filter: 'lowpass', hz: 750, q: 0.7, scuff: 0.3, scuffDecay: 0.07, body: 0.3, bodyDecay: 0.09, bodyWave: 'sine', fromHz: 160, toHz: 100 },
  grass: { filter: 'lowpass', hz: 420, q: 0.7, scuff: 0.2, scuffDecay: 0.06, body: 0.2, bodyDecay: 0.08, bodyWave: 'sine', fromHz: 120, toHz: 85 },
  dojo: { filter: 'bandpass', hz: 900, q: 7, scuff: 1.4, scuffDecay: 0.11, body: 0.3, bodyDecay: 0.16, bodyWave: 'triangle', fromHz: 400, toHz: 350 },
};

const APPLAUSE_SECONDS = 2.6;
const APPLAUSE_SEED = 0xc1a9;
/** Candidate claps; the swell's rejection sampling keeps about half of them. */
const APPLAUSE_CLAPS = 1400;
const applauseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** Crowd murmur gain at level 1 (it sits under everything else). */
const CROWD_GAIN = 0.5;
/** Time constant (s) of crowd level changes. */
const CROWD_RAMP_S = 0.5;

/** Racket "pok": a band-passed noise snap (the strings) plus a pitched body thump. */
function racket(ctx: BaseAudioContext, out: AudioNode, t: number, v: VoiceOptions, hard: boolean): void {
  const snap = envelope(ctx, out, t, hard ? 0.9 : 0.7, 0.001, hard ? 0.07 : 0.05);
  noise(ctx, filter(ctx, snap, 'bandpass', hard ? 2600 : 1900, 1.4), t, 0.08, v.random);
  const body = envelope(ctx, out, t, hard ? 0.55 : 0.45, 0.002, hard ? 0.12 : 0.09);
  tone(ctx, body, 'triangle', t, 0.13, hard ? 340 : 280, hard ? 130 : 120);
}

/** Ball bounce "tok", coloured by the court surface. */
function bounce(ctx: BaseAudioContext, out: AudioNode, t: number, v: VoiceOptions): void {
  const c = BOUNCE[v.surface];
  const scuff = envelope(ctx, out, t, c.scuff, 0.001, c.scuffDecay);
  noise(ctx, filter(ctx, scuff, c.filter, c.hz, c.q), t, c.scuffDecay + 0.01, v.random);
  const body = envelope(ctx, out, t, c.body, 0.002, c.bodyDecay);
  tone(ctx, body, c.bodyWave, t, c.bodyDecay + 0.01, c.fromHz, c.toHz);
}

/** Net-cord rattle: a run of quick, fading band-passed ticks over a dull thud of the tape. */
function netCord(ctx: BaseAudioContext, out: AudioNode, t: number, v: VoiceOptions): void {
  const rattle = filter(ctx, out, 'bandpass', 1200, 2.5);
  for (let i = 0; i < 6; i++) {
    const at = t + i * 0.022 + v.random() * 0.008;
    noise(ctx, envelope(ctx, rattle, at, 1.2 * 0.72 ** i, 0.001, 0.03), at, 0.035, v.random);
  }
  tone(ctx, envelope(ctx, out, t, 0.4, 0.003, 0.16), 'sine', t, 0.17, 120, 70);
}

/** Tiny mechanical key click; pitch varies by ±6 % from the cosmetic RNG. */
function keyClick(ctx: BaseAudioContext, out: AudioNode, t: number, v: VoiceOptions): void {
  const pitch = 1 + (v.random() - 0.5) * 0.12;
  const click = envelope(ctx, out, t, 0.2, 0.0005, 0.012);
  noise(ctx, filter(ctx, click, 'highpass', 3000 * pitch, 0.7), t, 0.015, v.random);
  tone(ctx, envelope(ctx, out, t, 0.04, 0.0005, 0.018), 'square', t, 0.02, 1800 * pitch);
}

/** Gentle wrong-key buzz: short, low and low-passed, with a soft attack (never harsh). */
function softBuzz(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  const g = envelope(ctx, filter(ctx, out, 'lowpass', 520, 0.7), t, 0.18, 0.012, 0.16);
  tone(ctx, g, 'square', t, 0.175, 98);
  tone(ctx, g, 'triangle', t, 0.175, 196);
}

/** Lock tick: one short, softened square blip. */
function lockTick(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  tone(ctx, envelope(ctx, filter(ctx, out, 'lowpass', 5000, 0.7), t, 0.22, 0.001, 0.04), 'square', t, 0.042, 1320);
}

/** Word-complete chime: two rising bell notes (C6 then G6). */
function chime(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  [1046.5, 1568].forEach((hz, i) => {
    const at = t + i * 0.085;
    tone(ctx, envelope(ctx, out, at, 0.22, 0.004, 0.4), 'sine', at, 0.41, hz);
    tone(ctx, envelope(ctx, out, at, 0.06, 0.004, 0.2), 'triangle', at, 0.21, hz * 2);
  });
}

/** "Your turn" tick: two quick rising square blips, distinct from the lock tick. */
function yourTurnTick(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  const soft = filter(ctx, out, 'lowpass', 4000, 0.7);
  [988, 1319].forEach((hz, i) => {
    const at = t + i * 0.07;
    tone(ctx, envelope(ctx, soft, at, 0.2, 0.002, 0.06), 'square', at, 0.062, hz);
  });
}

/** Swell shape of an applause burst over `u` = 0..1 of its length: fast rise, short hold, long fade. */
function applauseSwell(u: number): number {
  if (u < 0.08) return u / 0.08;
  if (u < 0.3) return 1;
  return Math.max(0, 1 - (u - 0.3) / 0.7) ** 2;
}

/** Dense random short noise clicks (hand claps) following the applause swell; built once per context. */
function applauseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buffer = applauseCache.get(ctx);
  if (!buffer) {
    buffer = monoBuffer(ctx, APPLAUSE_SECONDS, APPLAUSE_SEED, (samples, random, sampleRate) => {
      for (let n = 0; n < APPLAUSE_CLAPS; n++) {
        const u = random();
        const swell = applauseSwell(u);
        if (random() >= swell) continue;
        const start = Math.floor(u * samples.length);
        const len = Math.floor((0.002 + random() * 0.006) * sampleRate);
        const amp = (0.3 + random() * 0.7) * swell;
        for (let i = 0; i < len && start + i < samples.length; i++) {
          samples[start + i] = (samples[start + i] ?? 0) + amp * (random() * 2 - 1) * (1 - i / len) ** 2;
        }
      }
      normalise(samples, 1);
    });
    applauseCache.set(ctx, buffer);
  }
  return buffer;
}

/** Applause: the clap buffer through a broad hand-clap band, slightly re-pitched each time. */
function applause(ctx: BaseAudioContext, out: AudioNode, t: number, v: VoiceOptions): void {
  const src = ctx.createBufferSource();
  src.buffer = applauseBuffer(ctx);
  src.playbackRate.value = 0.94 + v.random() * 0.12;
  src.connect(filter(ctx, filter(ctx, gain(ctx, out, 0.8), 'lowpass', 6000, 0.5), 'highpass', 500, 0.5));
  src.start(t);
}

/** Crowd "ooh": breathy noise and a few detuned voices through two "oo" formants, swelling then fading. */
function ooh(ctx: BaseAudioContext, out: AudioNode, t: number, v: VoiceOptions): void {
  const dur = 1.4;
  const swell = ctx.createGain();
  swell.gain.setValueAtTime(0, t);
  swell.gain.linearRampToValueAtTime(1, t + 0.3);
  swell.gain.exponentialRampToValueAtTime(SILENCE, t + dur);
  swell.gain.setValueAtTime(0, t + dur);
  swell.connect(out);
  const f1 = filter(ctx, swell, 'bandpass', 330, 3);
  const f2 = filter(ctx, swell, 'bandpass', 800, 4);
  const intoFormants = (level: number): GainNode => {
    const g = gain(ctx, f1, level);
    g.connect(f2);
    return g;
  };
  noise(ctx, intoFormants(0.9), t, dur, v.random);
  for (let i = 0; i < 4; i++) {
    const hz = 160 + i * 28 + v.random() * 12;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(hz, t);
    o.frequency.linearRampToValueAtTime(hz * 1.12, t + 0.35);
    o.frequency.linearRampToValueAtTime(hz * 0.9, t + dur);
    o.connect(intoFormants(0.12));
    o.start(t);
    o.stop(t + dur);
  }
}

/** Coin "ting": a bright partial and two inharmonic overtones ringing out. */
function coin(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  const partials: [number, number, number][] = [
    [2093, 0.25, 0.5],
    [2093 * 2.76, 0.08, 0.3],
    [2093 * 5.4, 0.035, 0.15],
  ];
  for (const [hz, peak, decay] of partials) tone(ctx, envelope(ctx, out, t, peak, 0.002, decay), 'sine', t, decay + 0.01, hz);
}

/** Power meter full: a rising three-note arpeggio (C6, E6, G6), 70 ms apart. */
function powerUp(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  [1047, 1319, 1568].forEach((hz, i) => {
    const at = t + i * 0.07;
    tone(ctx, envelope(ctx, out, at, 0.18, 0.005, 0.18), 'triangle', at, 0.2, hz);
  });
}

/** Power meter lost: a soft falling sweep, 600 → 200 Hz over 0.35 s. */
function powerDown(ctx: BaseAudioContext, out: AudioNode, t: number): void {
  tone(ctx, envelope(ctx, out, t, 0.12, 0.01, 0.35), 'sine', t, 0.36, 600, 200);
}

const VOICES: Record<SfxName, Voice> = {
  hit: (ctx, out, t, v) => racket(ctx, out, t, v, false),
  hitHard: (ctx, out, t, v) => racket(ctx, out, t, v, true),
  bounce,
  netHit: netCord,
  key: keyClick,
  bad: softBuzz,
  lock: lockTick,
  done: chime,
  yourTurn: yourTurnTick,
  applause,
  ooh,
  coin,
  powerUp,
  powerDown,
};

/** Schedules sound `name` at context time `t` into `dest`; works on any BaseAudioContext (e.g. offline). */
export function playSfx(ctx: BaseAudioContext, dest: AudioNode, name: SfxName, t: number, v: VoiceOptions): void {
  let out = dest;
  if (v.pan !== 0) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = v.pan;
    panner.connect(dest);
    out = panner;
  }
  VOICES[name](ctx, gain(ctx, out, v.gain), t, v);
}

/**
 * Crowd murmur loop: pink-ish noise, band-limited to a voice-like range, with a slow irregular
 * amplitude wobble from two LFOs. Silent until `setLevel`.
 */
export class CrowdMurmur {
  private readonly level: GainNode;

  /** Starts the (silent) loop at context time `t`. */
  constructor(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    this.level = gain(ctx, dest, 0);
    const wobble = gain(ctx, this.level, 0.7);
    for (const [hz, depth] of [
      [0.21, 0.2],
      [0.53, 0.1],
    ] as const) {
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = depth;
      lfoDepth.connect(wobble.gain);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = hz;
      lfo.connect(lfoDepth);
      lfo.start(t);
    }
    const src = ctx.createBufferSource();
    src.buffer = pinkNoise(ctx);
    src.loop = true;
    src.connect(filter(ctx, filter(ctx, wobble, 'lowpass', 1400, 0.5), 'bandpass', 480, 0.6));
    src.start(t);
  }

  /** Eases the murmur toward `intensity` (0..1) from context time `t`. */
  setLevel(intensity: number, t: number): void {
    this.level.gain.setTargetAtTime(intensity * CROWD_GAIN, t, CROWD_RAMP_S);
  }
}
