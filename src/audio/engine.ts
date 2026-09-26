import type { Surface } from '../core/types';
import { clamp } from '../core/util';
import { ChiptuneSequencer } from './music';
import { CrowdMurmur, playSfx } from './sfx';
import type { SfxName } from './sfx';
import { cosmeticRandom, gain } from './synth';

export type { SfxName } from './sfx';

/** Per-call options of AudioEngine.play: stereo pan −1..1, gain 0..1, surface for the bounce colour. */
export interface PlayOptions {
  pan?: number;
  gain?: number;
  surface?: Surface;
}

/** Volume settings, each 0..1. */
export interface Volumes {
  master: number;
  music: number;
  sfx: number;
}

/** How long unlock() waits for resume() (it can stay pending until a later user gesture). */
const RESUME_TIMEOUT_MS = 1000;
const MUSIC_TICK_MS = 50;
const MUSIC_LOOKAHEAD_S = 0.3;
const MUSIC_START_DELAY_S = 0.05;
const MUSIC_FADE_S = 0.02;
const VOLUME_RAMP_S = 0.02;
const COSMETIC_SEED = 0x7e5b17;

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  music: GainNode;
  sfx: GainNode;
}

/** A finite number clamped to [lo, hi], or `fallback` for undefined/NaN/±Infinity. */
function bounded(x: number | undefined, lo: number, hi: number, fallback: number): number {
  return x !== undefined && Number.isFinite(x) ? clamp(x, lo, hi) : fallback;
}

function sanitiseVolumes(v: Volumes): Volumes {
  return { master: bounded(v.master, 0, 1, 0), music: bounded(v.music, 0, 1, 0), sfx: bounded(v.sfx, 0, 1, 0) };
}

/** Resolves when `p` settles or after `ms`, whichever comes first; never rejects. */
function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

/** Context + buses: sfx and music → master → limiter → speakers. Null if WebAudio is missing or fails. */
function openGraph(v: Volumes, onStateChange: () => void): Graph | null {
  const Ctor: typeof AudioContext | undefined = globalThis.AudioContext;
  if (typeof Ctor !== 'function') return null;
  try {
    const ctx = new Ctor({ latencyHint: 'interactive' });
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    limiter.connect(ctx.destination);
    const master = gain(ctx, limiter, v.master);
    const graph = { ctx, master, music: gain(ctx, master, v.music), sfx: gain(ctx, master, v.sfx) };
    ctx.addEventListener('statechange', onStateChange);
    return graph;
  } catch {
    return null;
  }
}

/**
 * Synthesised game audio (spec §4.4): one AudioContext created on the start-gate gesture, master /
 * music / sfx buses, one-shot sfx, the crowd murmur and the title music. When WebAudio is missing or
 * the context never runs, `ok` stays false and every call is a silent no-op; nothing ever throws.
 */
export class AudioEngine {
  private graph: Graph | null = null;
  private volumes: Volumes = { master: 1, music: 1, sfx: 1 };
  private crowdLevel = 0;
  private murmur: CrowdMurmur | null = null;
  private musicWanted = false;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private musicGate: GainNode | null = null;
  private readonly random = cosmeticRandom(COSMETIC_SEED);

  /** True while the context is running, i.e. sound can actually play. */
  get ok(): boolean {
    return this.graph?.ctx.state === 'running';
  }

  /** Creates (once) and resumes the context; call from a user gesture. Resolves within ~1 s; never throws. */
  async unlock(): Promise<void> {
    try {
      this.graph ??= openGraph(this.volumes, () => this.sync());
      const ctx = this.graph?.ctx;
      if (ctx && ctx.state !== 'running') await settleWithin(ctx.resume(), RESUME_TIMEOUT_MS);
    } catch {
      // Audio failures mute silently.
    }
    this.sync();
  }

  /** Sets the bus volumes (each clamped to 0..1; non-finite → 0). */
  setVolumes(v: Volumes): void {
    this.volumes = sanitiseVolumes(v);
    const g = this.graph;
    if (!g) return;
    try {
      const now = g.ctx.currentTime;
      g.master.gain.setTargetAtTime(this.volumes.master, now, VOLUME_RAMP_S);
      g.music.gain.setTargetAtTime(this.volumes.music, now, VOLUME_RAMP_S);
      g.sfx.gain.setTargetAtTime(this.volumes.sfx, now, VOLUME_RAMP_S);
    } catch {
      // Audio failures mute silently.
    }
  }

  /** Plays one sound effect now; a no-op while locked or failed. */
  play(name: SfxName, opts: PlayOptions = {}): void {
    const g = this.graph;
    if (!g || !this.ok) return;
    try {
      playSfx(g.ctx, g.sfx, name, g.ctx.currentTime, {
        gain: bounded(opts.gain, 0, 1, 1),
        pan: bounded(opts.pan, -1, 1, 0),
        surface: opts.surface ?? 'hard',
        random: this.random,
      });
    } catch {
      // Audio failures mute silently.
    }
  }

  /** Sets the crowd murmur intensity 0..1 (0 = silent); remembered until the context runs. */
  crowd(level: number): void {
    this.crowdLevel = bounded(level, 0, 1, 0);
    this.sync();
  }

  /** Starts or stops the title music loop; remembered until the context runs. */
  music(on: boolean): void {
    this.musicWanted = on;
    this.sync();
  }

  /** Brings the crowd loop and the music scheduler in line with the wishes and the context state. */
  private sync(): void {
    try {
      this.syncMusic();
      this.syncCrowd();
    } catch {
      // Audio failures mute silently.
    }
  }

  private syncCrowd(): void {
    const g = this.graph;
    if (!g || !this.ok) return;
    if (!this.murmur) {
      if (this.crowdLevel === 0) return;
      this.murmur = new CrowdMurmur(g.ctx, g.sfx, g.ctx.currentTime);
    }
    this.murmur.setLevel(this.crowdLevel, g.ctx.currentTime);
  }

  private syncMusic(): void {
    const g = this.graph;
    const play = this.musicWanted && this.ok;
    if (play && g && this.musicTimer === null) this.startMusic(g);
    else if (!play && this.musicTimer !== null) this.stopMusic();
  }

  private startMusic(g: Graph): void {
    const gate = g.ctx.createGain();
    gate.connect(g.music);
    const sequencer = new ChiptuneSequencer(g.ctx, gate, g.ctx.currentTime + MUSIC_START_DELAY_S);
    const tick = (): void => {
      try {
        sequencer.scheduleUntil(g.ctx.currentTime + MUSIC_LOOKAHEAD_S);
      } catch {
        this.stopMusic();
      }
    };
    this.musicGate = gate;
    this.musicTimer = setInterval(tick, MUSIC_TICK_MS);
    tick();
  }

  private stopMusic(): void {
    if (this.musicTimer !== null) clearInterval(this.musicTimer);
    this.musicTimer = null;
    const gate = this.musicGate;
    this.musicGate = null;
    if (gate && this.graph) gate.gain.setTargetAtTime(0, this.graph.ctx.currentTime, MUSIC_FADE_S);
  }
}
