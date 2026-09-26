import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { SFX_NAMES } from '../../src/audio/sfx';
import type { Surface } from '../../src/core/types';
import { chainFrom, FakeBufferSource, installFakeAudio } from './fakeWebAudio';
import type { FakeAudioContext, FakeNode } from './fakeWebAudio';

const SURFACES: Surface[] = ['hard', 'clay', 'grass', 'dojo'];

/** Calls every public method with plausible and hostile arguments. */
function exerciseEverything(a: AudioEngine): void {
  a.setVolumes({ master: 0.5, music: 0.5, sfx: 0.5 });
  a.setVolumes({ master: Number.NaN, music: -1, sfx: 7 });
  for (const name of SFX_NAMES) a.play(name, { surface: 'clay', pan: -0.3, gain: 0.8 });
  a.play('hit', { pan: Number.NaN, gain: Number.POSITIVE_INFINITY });
  a.crowd(0.6);
  a.crowd(Number.NaN);
  a.music(true);
  a.music(false);
}

async function unlocked(opts: Parameters<typeof installFakeAudio>[0] = {}): Promise<{ a: AudioEngine; ctx: FakeAudioContext }> {
  const contexts = installFakeAudio(opts);
  const a = new AudioEngine();
  await a.unlock();
  const ctx = contexts[0];
  if (!ctx) throw new Error('no AudioContext was created');
  return { a, ctx };
}

/** The last node before the master gain → compressor → destination tail, i.e. the bus the chain feeds. */
function busOf(chain: FakeNode[]): FakeNode | undefined {
  return chain[chain.length - 4];
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AudioEngine in hostile environments', () => {
  it('is silent and never throws when AudioContext does not exist', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const a = new AudioEngine();
    await expect(a.unlock()).resolves.toBeUndefined();
    expect(a.ok).toBe(false);
    expect(() => exerciseEverything(a)).not.toThrow();
  });

  it('is silent and never throws when the AudioContext constructor throws', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('NotSupportedError');
        }
      },
    );
    const a = new AudioEngine();
    await expect(a.unlock()).resolves.toBeUndefined();
    expect(a.ok).toBe(false);
    expect(() => exerciseEverything(a)).not.toThrow();
  });

  it('stays locked and plays nothing when resume() rejects', async () => {
    const { a, ctx } = await unlocked({ resume: 'reject' });
    expect(a.ok).toBe(false);
    expect(() => exerciseEverything(a)).not.toThrow();
    expect(ctx.started()).toEqual([]);
  });

  it('does not hang when resume() never settles, and wakes up if the context starts later', async () => {
    vi.useFakeTimers();
    const contexts = installFakeAudio({ resume: 'hang' });
    const a = new AudioEngine();
    let settled = false;
    const done = a.unlock().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(settled).toBe(true);
    expect(a.ok).toBe(false);
    const ctx = contexts[0];
    if (!ctx) throw new Error('no AudioContext was created');
    ctx.setState('running');
    expect(a.ok).toBe(true);
    a.play('key');
    expect(ctx.started().length).toBeGreaterThan(0);
  });

  it('plays nothing before unlock and creates no context', () => {
    const contexts = installFakeAudio();
    const a = new AudioEngine();
    exerciseEverything(a);
    expect(contexts).toEqual([]);
    expect(a.ok).toBe(false);
  });

  it('goes quiet again if the context is closed', async () => {
    const { a, ctx } = await unlocked();
    ctx.setState('closed');
    expect(a.ok).toBe(false);
    const before = ctx.started().length;
    a.play('hit');
    expect(ctx.started()).toHaveLength(before);
  });
});

describe('AudioEngine once unlocked', () => {
  it('creates one context, resumes it and reports ok', async () => {
    const contexts = installFakeAudio();
    const a = new AudioEngine();
    await a.unlock();
    await a.unlock();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.resumeCalls).toBe(1);
    expect(a.ok).toBe(true);
  });

  it('skips resume() for a context that starts running', async () => {
    const { a, ctx } = await unlocked({ initialState: 'running' });
    expect(ctx.resumeCalls).toBe(0);
    expect(a.ok).toBe(true);
  });

  it('plays every sound on every surface into the sfx bus', async () => {
    const { a, ctx } = await unlocked();
    for (const name of SFX_NAMES) {
      for (const surface of SURFACES) {
        const before = ctx.started().length;
        a.play(name, { surface, pan: 0.4, gain: 0.9 });
        const fresh = ctx.started().slice(before);
        expect(fresh.length, `${name} on ${surface}`).toBeGreaterThan(0);
        for (const src of fresh) {
          const chain = chainFrom(src);
          expect(chain.at(-1), `${name} reaches the speakers`).toBe(ctx.destination);
        }
      }
    }
  });

  it('keeps hostile play options within range', async () => {
    const { a, ctx } = await unlocked();
    expect(() => a.play('bounce', { pan: 9, gain: Number.NaN })).not.toThrow();
    expect(() => a.play('bounce', { pan: Number.NEGATIVE_INFINITY, gain: -2 })).not.toThrow();
    const pans = ctx.created.flatMap((n) => ('pan' in n ? [(n as FakeNode & { pan: { value: number } }).pan.value] : []));
    for (const p of pans) expect(Math.abs(p)).toBeLessThanOrEqual(1);
  });

  it('routes volumes to the master, music and sfx buses, clamped to 0..1', async () => {
    const { a, ctx } = await unlocked();
    a.setVolumes({ master: 0.5, music: 0.25, sfx: 2 });
    a.play('coin');
    const sfxChain = chainFrom(ctx.started()[0] as FakeNode);
    const master = sfxChain.at(-3) as FakeNode & { gain: { value: number } };
    const sfxBus = busOf(sfxChain) as FakeNode & { gain: { value: number } };
    expect(master.gain.value).toBe(0.5);
    expect(sfxBus.gain.value).toBe(1);

    const before = ctx.started().length;
    a.music(true);
    const musicChain = chainFrom(ctx.started()[before] as FakeNode);
    const musicBus = busOf(musicChain) as FakeNode & { gain: { value: number } };
    expect(musicBus).not.toBe(sfxBus);
    expect(musicBus.gain.value).toBe(0.25);
    a.music(false);

    a.setVolumes({ master: -1, music: Number.NaN, sfx: 0.75 });
    expect(master.gain.value).toBe(0);
    expect(musicBus.gain.value).toBe(0);
    expect(sfxBus.gain.value).toBe(0.75);
  });

  it('runs a single crowd murmur loop and only starts it when asked for sound', async () => {
    const { a, ctx } = await unlocked();
    const loops = (): FakeBufferSource[] =>
      ctx.started().filter((n): n is FakeBufferSource => n instanceof FakeBufferSource && n.loop);
    a.crowd(0);
    expect(loops()).toHaveLength(0);
    a.crowd(0.5);
    a.crowd(0.9);
    a.crowd(0.2);
    expect(loops()).toHaveLength(1);
    expect(chainFrom(loops()[0] as FakeNode).at(-1)).toBe(ctx.destination);
  });

  it('keeps sequencing music while on and stops when off', async () => {
    vi.useFakeTimers();
    const { a, ctx } = await unlocked();
    a.music(true);
    const first = ctx.started().length;
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      ctx.currentTime += 0.1;
      await vi.advanceTimersByTimeAsync(100);
    }
    const playing = ctx.started().length;
    expect(playing).toBeGreaterThan(first);
    a.music(false);
    for (let i = 0; i < 20; i++) {
      ctx.currentTime += 0.1;
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(ctx.started()).toHaveLength(playing);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours music and crowd requests made before unlock', async () => {
    const contexts = installFakeAudio();
    const a = new AudioEngine();
    a.music(true);
    a.crowd(0.5);
    await a.unlock();
    const ctx = contexts[0];
    if (!ctx) throw new Error('no AudioContext was created');
    expect(ctx.started().some((n) => n instanceof FakeBufferSource && n.loop)).toBe(true);
    expect(ctx.started().some((n) => !(n instanceof FakeBufferSource && n.loop))).toBe(true);
    a.music(false);
  });
});
