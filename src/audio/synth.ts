import { seedRng, uniform } from '../core/rng';

/** Gain treated as silence (−80 dB): exponential decays end here because they cannot reach 0. */
export const SILENCE = 0.0001;

/** Built-in oscillator shapes. */
type BuiltInWave = Exclude<OscillatorType, 'custom'>;
/** Oscillator shapes a voice may use: a built-in wave or a custom PeriodicWave. */
export type Wave = BuiltInWave | PeriodicWave;

const BUILT_IN_WAVES: ReadonlySet<unknown> = new Set<BuiltInWave>(['sine', 'square', 'sawtooth', 'triangle']);

/** PeriodicWave is an empty interface in the DOM typings, so `typeof` alone cannot tell the two apart. */
function isBuiltIn(wave: Wave): wave is BuiltInWave {
  return BUILT_IN_WAVES.has(wave);
}

const WHITE_SECONDS = 2;
const PINK_SECONDS = 4;
const NOISE_SEED = 0x6e015e;
const PULSE_HARMONICS = 32;

const whiteCache = new WeakMap<BaseAudioContext, AudioBuffer>();
const pinkCache = new WeakMap<BaseAudioContext, AudioBuffer>();
const pulseCache = new WeakMap<BaseAudioContext, Map<number, PeriodicWave>>();

/** A cosmetic random source in [0, 1) for sound variation only (never game state). */
export function cosmeticRandom(seed: number): () => number {
  const s = seedRng(seed);
  return () => uniform(s);
}

/** A mono buffer of `seconds`, filled by `fill(samples, random, sampleRate)` from a fixed seed. */
export function monoBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  seed: number,
  fill: (samples: Float32Array, random: () => number, sampleRate: number) => void,
): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  fill(buffer.getChannelData(0), cosmeticRandom(seed), ctx.sampleRate);
  return buffer;
}

/** Scales `samples` in place so the loudest one has magnitude `peak`. */
export function normalise(samples: Float32Array, peak: number): void {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  if (max === 0) return;
  const k = peak / max;
  for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] ?? 0) * k;
}

/** Two seconds of white noise in ±1, generated once per context. */
function whiteNoise(ctx: BaseAudioContext): AudioBuffer {
  let buffer = whiteCache.get(ctx);
  if (!buffer) {
    buffer = monoBuffer(ctx, WHITE_SECONDS, NOISE_SEED, (samples, random) => {
      for (let i = 0; i < samples.length; i++) samples[i] = random() * 2 - 1;
    });
    whiteCache.set(ctx, buffer);
  }
  return buffer;
}

/** Four seconds of pink-ish noise (≈ −3 dB/octave, Paul Kellet's economy filter), peak ±1, once per context. */
export function pinkNoise(ctx: BaseAudioContext): AudioBuffer {
  let buffer = pinkCache.get(ctx);
  if (!buffer) {
    buffer = monoBuffer(ctx, PINK_SECONDS, NOISE_SEED + 1, (samples, random) => {
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < samples.length; i++) {
        const white = random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.963 * b1 + white * 0.2965164;
        b2 = 0.57 * b2 + white * 1.0526913;
        samples[i] = b0 + b1 + b2 + white * 0.1848;
      }
      normalise(samples, 1);
    });
    pinkCache.set(ctx, buffer);
  }
  return buffer;
}

/** Pulse wave with the given duty cycle (0.5 = square, 0.25 = the thinner chiptune lead), once per context. */
export function pulseWave(ctx: BaseAudioContext, duty: number): PeriodicWave {
  let waves = pulseCache.get(ctx);
  if (!waves) {
    waves = new Map();
    pulseCache.set(ctx, waves);
  }
  let wave = waves.get(duty);
  if (!wave) {
    const real = new Float32Array(PULSE_HARMONICS + 1);
    const imag = new Float32Array(PULSE_HARMONICS + 1);
    for (let n = 1; n <= PULSE_HARMONICS; n++) {
      real[n] = Math.sin(2 * Math.PI * n * duty) / (Math.PI * n);
      imag[n] = (1 - Math.cos(2 * Math.PI * n * duty)) / (Math.PI * n);
    }
    wave = ctx.createPeriodicWave(real, imag);
    waves.set(duty, wave);
  }
  return wave;
}

/** A fixed gain stage into `dest`. */
export function gain(ctx: BaseAudioContext, dest: AudioNode, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  g.connect(dest);
  return g;
}

/** A biquad filter into `dest`. */
export function filter(ctx: BaseAudioContext, dest: AudioNode, type: BiquadFilterType, hz: number, q = 1): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = q;
  f.connect(dest);
  return f;
}

/** A percussive envelope into `dest`: silent at `t`, linear attack to `peak`, exponential decay to silence. */
export function envelope(ctx: BaseAudioContext, dest: AudioNode, t: number, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(SILENCE, t + attack + decay);
  g.gain.setValueAtTime(0, t + attack + decay);
  g.connect(dest);
  return g;
}

/** An oscillator into `dest` from `t` for `dur` seconds, gliding exponentially from `hz` to `toHz`. */
export function tone(ctx: BaseAudioContext, dest: AudioNode, wave: Wave, t: number, dur: number, hz: number, toHz = hz): OscillatorNode {
  const o = ctx.createOscillator();
  if (isBuiltIn(wave)) o.type = wave;
  else o.setPeriodicWave(wave);
  o.frequency.setValueAtTime(hz, t);
  if (toHz !== hz) o.frequency.exponentialRampToValueAtTime(toHz, t + dur);
  o.connect(dest);
  o.start(t);
  o.stop(t + dur);
  return o;
}

/** A white-noise burst into `dest` from `t` for `dur` seconds (≤ 2 s), from a random point in the buffer. */
export function noise(ctx: BaseAudioContext, dest: AudioNode, t: number, dur: number, random: () => number): AudioBufferSourceNode {
  const buffer = whiteNoise(ctx);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(dest);
  src.start(t, random() * Math.max(0, buffer.duration - dur), dur);
  return src;
}
