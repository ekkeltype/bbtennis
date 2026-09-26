import { vi } from 'vitest';

/** How the fake context answers `resume()`. */
export type ResumeBehaviour = 'resolve' | 'reject' | 'hang';

function checkTime(t: number, what: string): void {
  if (!Number.isFinite(t) || t < 0) throw new RangeError(`${what}: bad time ${t}`);
}

function checkValue(v: number, what: string): void {
  if (!Number.isFinite(v)) throw new TypeError(`${what}: non-finite value ${v}`);
}

/** AudioParam stand-in; `value` ends up at the last scheduled target. Validates like browsers do. */
export class FakeParam {
  constructor(public value: number) {}

  setValueAtTime(v: number, t: number): this {
    checkValue(v, 'setValueAtTime');
    checkTime(t, 'setValueAtTime');
    this.value = v;
    return this;
  }

  linearRampToValueAtTime(v: number, t: number): this {
    checkValue(v, 'linearRampToValueAtTime');
    checkTime(t, 'linearRampToValueAtTime');
    this.value = v;
    return this;
  }

  exponentialRampToValueAtTime(v: number, t: number): this {
    checkValue(v, 'exponentialRampToValueAtTime');
    if (v === 0) throw new RangeError('exponentialRampToValueAtTime: value must be non-zero');
    checkTime(t, 'exponentialRampToValueAtTime');
    this.value = v;
    return this;
  }

  setTargetAtTime(v: number, t: number, timeConstant: number): this {
    checkValue(v, 'setTargetAtTime');
    checkTime(t, 'setTargetAtTime');
    if (!(timeConstant >= 0)) throw new RangeError(`setTargetAtTime: bad time constant ${timeConstant}`);
    this.value = v;
    return this;
  }

  setValueCurveAtTime(values: Float32Array | number[], t: number, duration: number): this {
    checkTime(t, 'setValueCurveAtTime');
    if (!(duration > 0) || values.length < 2) throw new RangeError('setValueCurveAtTime: bad curve');
    this.value = values[values.length - 1] ?? this.value;
    return this;
  }

  cancelScheduledValues(t: number): this {
    checkTime(t, 'cancelScheduledValues');
    return this;
  }
}

/** AudioNode stand-in that records its outgoing connections. */
export class FakeNode {
  readonly outputs: (FakeNode | FakeParam)[] = [];

  constructor(readonly context: FakeAudioContext) {
    context.created.push(this);
  }

  connect<T extends FakeNode | FakeParam>(dest: T): T {
    if (dest instanceof FakeNode && dest.context !== this.context) throw new Error('InvalidAccessError: other context');
    this.outputs.push(dest);
    return dest;
  }

  disconnect(): void {
    this.outputs.length = 0;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
}

class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);
  readonly gain = new FakeParam(0);
}

class FakePanner extends FakeNode {
  readonly pan = new FakeParam(0);
}

class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam(-24);
  readonly knee = new FakeParam(30);
  readonly ratio = new FakeParam(12);
  readonly attack = new FakeParam(0.003);
  readonly release = new FakeParam(0.25);
}

/** Source node: start once, stop only after start, never at a negative time. */
export class FakeSource extends FakeNode {
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;

  start(when = 0): void {
    if (this.startedAt !== null) throw new Error('InvalidStateError: start called twice');
    checkTime(when, 'start');
    this.startedAt = when;
  }

  stop(when = 0): void {
    if (this.startedAt === null) throw new Error('InvalidStateError: stop before start');
    checkTime(when, 'stop');
    this.stoppedAt = when;
  }
}

class FakeOscillator extends FakeSource {
  private waveType: OscillatorType = 'sine';
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);

  get type(): OscillatorType {
    return this.waveType;
  }

  set type(t: OscillatorType) {
    if (t === 'custom') throw new Error("InvalidStateError: set 'custom' via setPeriodicWave");
    this.waveType = t;
  }

  setPeriodicWave(_wave: unknown): void {
    this.waveType = 'custom';
  }
}

class FakeBuffer {
  private readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(i: number): Float32Array {
    const data = this.channels[i];
    if (!data) throw new RangeError(`no channel ${i}`);
    return data;
  }
}

/** Buffer source; `loop` marks the crowd murmur loop. */
export class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
  readonly detune = new FakeParam(0);

  override start(when = 0, offset = 0, duration?: number): void {
    super.start(when);
    if (!(offset >= 0) || (duration !== undefined && !(duration >= 0))) throw new RangeError('start: bad offset/duration');
    if (this.buffer && offset > this.buffer.duration) throw new RangeError('start: offset past the buffer end');
  }
}

/** AudioContext stand-in; `created` lists every node in creation order. */
export class FakeAudioContext extends EventTarget {
  state: AudioContextState;
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly created: FakeNode[] = [];
  readonly destination: FakeNode;
  resumeCalls = 0;

  constructor(
    private readonly resumeBehaviour: ResumeBehaviour,
    initialState: AudioContextState,
  ) {
    super();
    this.state = initialState;
    this.destination = new FakeNode(this);
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.resumeBehaviour === 'reject') return Promise.reject(new Error('NotAllowedError: no user gesture'));
    if (this.resumeBehaviour === 'hang') return new Promise<void>(() => {});
    this.setState('running');
    return Promise.resolve();
  }

  setState(state: AudioContextState): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }

  createGain(): FakeGain {
    return new FakeGain(this);
  }

  createBiquadFilter(): FakeFilter {
    return new FakeFilter(this);
  }

  createStereoPanner(): FakePanner {
    return new FakePanner(this);
  }

  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor(this);
  }

  createOscillator(): FakeOscillator {
    return new FakeOscillator(this);
  }

  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource(this);
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    if (!(channels >= 1) || !(length >= 1) || !(sampleRate > 0)) throw new Error('NotSupportedError: bad buffer');
    return new FakeBuffer(channels, length, sampleRate);
  }

  createPeriodicWave(real: Float32Array, imag: Float32Array): object {
    if (real.length !== imag.length || real.length < 2) throw new Error('IndexSizeError: bad periodic wave');
    return {};
  }

  /** Source nodes that have been started. */
  started(): FakeSource[] {
    return this.created.filter((n): n is FakeSource => n instanceof FakeSource && n.startedAt !== null);
  }
}

/** Installs a fake global `AudioContext`; returns the list that collects every constructed context. */
export function installFakeAudio(
  opts: { resume?: ResumeBehaviour; initialState?: AudioContextState } = {},
): FakeAudioContext[] {
  const instances: FakeAudioContext[] = [];
  const resume = opts.resume ?? 'resolve';
  const initialState = opts.initialState ?? 'suspended';
  vi.stubGlobal(
    'AudioContext',
    class extends FakeAudioContext {
      constructor() {
        super(resume, initialState);
        instances.push(this);
      }
    },
  );
  return instances;
}

/** Follows first outgoing connections from `node` until a node with none (normally the destination). */
export function chainFrom(node: FakeNode): FakeNode[] {
  const chain = [node];
  let cur = node;
  for (;;) {
    const next = cur.outputs.find((o): o is FakeNode => o instanceof FakeNode);
    if (!next || chain.includes(next)) return chain;
    chain.push(next);
    cur = next;
  }
}
