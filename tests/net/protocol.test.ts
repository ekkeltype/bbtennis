import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_ID, MAX_MSG_CHARS, MAX_SEND_BYTES, PROTO, decodeMsg, encodeMsg, encodeWithBytes, msgBytes, parseMsg, type NetMsg,
} from '../../src/net/protocol';
import { sanitizeName } from '../../src/core/text';
import { MAX_EARLY_KEYS } from '../../src/core/turn';
import type { GameEvent, Look, MatchConfig, PlayerStats, Profile, PublicState } from '../../src/core/types';

const look: Look = { skin: 2, hairStyle: 1, hair: 3, shirt: 4, shorts: 5, headband: 6, racket: 1 };
const noBand: Look = { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 };
const config: MatchConfig = { format: 'short', pace: 'normal', surface: 'clay', wordPack: 'mixed', deuceRule: 'golden', training: null };
const trainingConfig: MatchConfig = {
  format: 'tiebreak',
  pace: 'relaxed',
  surface: 'dojo',
  wordPack: 'everyday',
  deuceRule: 'advantage',
  training: { serveClock: false, freezeUntilFirstKey: true, fixedWords: { serve: [['ace', 'volley', 'backspinner']], choice: [['net', 'return', 'overheadsmash']] } },
};
const host: Profile = { name: 'ALEX', look };
const guest: Profile = { name: 'Sam-2', look: noBand };

const zeroStats = (): PlayerStats => ({
  pointsWon: 0, aces: 0, doubleFaults: 0, winners: 0, errors: 0, wordsCompleted: 0,
  intervalSum: 0, typingMs: 0, topWpm: 0, correctKeys: 0, wrongKeys: 0, fastestServeKmh: 0,
});

function publicState(names: [string, string] = ['ALEX', 'Sam-2']): PublicState {
  return {
    v: 2,
    config,
    players: [
      { name: names[0], look, kind: 'human', cpuLevel: null },
      { name: names[1], look: noBand, kind: 'remote', cpuLevel: null },
    ],
    score: {
      format: 'short', deuceRule: 'golden', setGames: [], setTiebreaks: [], games: [1, 0], points: [2, 3], inTiebreak: false,
      setsWon: [0, 0], firstServerOfMatch: 1, gameServer: 0, winner: null,
    },
    stats: [zeroStats(), zeroStats()],
    turn: null,
    lastTurn: null,
    rallyStrikes: 0,
    longestRally: 4,
    power: [1, 4],
    pointNo: 7,
    status: 'playing',
    winner: null,
    forfeitBy: null,
    nextTurnId: 12,
    nextPromptBase: 30,
    rng: null,
    picker: null,
  };
}

const events: GameEvent[] = [
  { turn: 11, τ: 0, type: 'turnStart', owner: 1, kind: 'serve' },
  { turn: 11, τ: 812.5, type: 'strike', player: 1, word: 'volley', tier: 'medium', kmh: 151, isServe: true, stretch: false, forehand: true },
];

/** One valid sample of every message type (some types more than once). */
const samples: NetMsg[] = [
  { type: 'hello', proto: PROTO, app: APP_ID, name: 'Sam-2', look: noBand },
  { type: 'welcome', proto: PROTO, hostProfile: host, config },
  { type: 'welcome', proto: PROTO, hostProfile: host, config: trainingConfig },
  { type: 'reject', reason: 'version', proto: PROTO, app: APP_ID },
  { type: 'reject', reason: 'full', proto: PROTO, app: APP_ID },
  { type: 'reject', reason: 'in-match', proto: PROTO, app: APP_ID },
  { type: 'lobby', config, ready: [true, false] },
  { type: 'ready', on: true },
  { type: 'start', config, hostProfile: host, guestProfile: guest },
  { type: 'input', seq: 0, turn: 11, k: 'q', τ: 431.25 },
  { type: 'input', seq: 17, turn: 11, k: 'toss', τ: 0 },
  { type: 'clock', turn: 11, τ: 1250 },
  { type: 'frame', turn: 11, τ: 50 },
  { type: 'frame', turn: 11, τ: 812.5, ev: events },
  { type: 'frame', turn: 11, τ: 900, s: publicState() },
  { type: 'frame', turn: 11, τ: 900, ev: [], s: publicState() },
  { type: 'ping', id: 3 },
  { type: 'pong', id: 3 },
  { type: 'rematch', want: false },
  { type: 'forfeit' },
  { type: 'leave' },
  { type: 'early', turn: 12, keys: [{ key: 'd', τ: -300 }, { key: 'x', τ: -120.5 }] },
];

/** Simulates the wire: JSON out, JSON in. */
const wire = (m: unknown): unknown => JSON.parse(JSON.stringify(m));

/** A deep copy of `m` with `mutate` applied, sent over the wire. */
function tampered<T>(m: T, mutate: (x: Record<string, any>) => void): unknown {
  const copy = wire(m) as Record<string, any>;
  mutate(copy);
  return copy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const find = <K extends NetMsg['type']>(type: K): Extract<NetMsg, { type: K }> =>
  samples.find((m) => m.type === type) as Extract<NetMsg, { type: K }>;

describe('constants', () => {
  it('protocol version is 3 and messages are capped at 32 KB of JSON', () => {
    expect(PROTO).toBe(3);
    expect(MAX_MSG_CHARS).toBe(32 * 1024);
  });

  it('senders keep to 32000 UTF-8 bytes, so every sendable message passes the receive cap', () => {
    expect(MAX_SEND_BYTES).toBe(32000);
    expect(MAX_SEND_BYTES).toBeLessThanOrEqual(MAX_MSG_CHARS);
  });
});

describe('msgBytes', () => {
  const hello = (name: string): NetMsg => ({ type: 'hello', proto: PROTO, app: APP_ID, name, look: noBand });

  it('is the length of the JSON for ASCII-only messages', () => {
    const m: NetMsg = { type: 'ping', id: 12 };
    expect(msgBytes(m)).toBe('{"type":"ping","id":12}'.length);
  });

  it('counts the τ key as its two UTF-8 bytes', () => {
    expect(msgBytes({ type: 'clock', turn: 1, τ: 5 })).toBe('{"type":"clock","turn":1,"":5}'.length + 2);
  });

  it.each([
    ['a', 1],
    ['é', 2],
    ['€', 3],
    ['🎾', 4],
    ['\uD83C', 6],
    ['"', 2],
  ])('a name %j adds %i bytes (UTF-8 of its JSON, as the data channel carries it)', (name, bytes) => {
    expect(msgBytes(hello(name)) - msgBytes(hello(''))).toBe(bytes);
  });

  it('matches the TextEncoder measure for every sample', () => {
    const utf8 = new TextEncoder();
    for (const m of samples) expect(msgBytes(m)).toBe(utf8.encode(JSON.stringify(m)).byteLength);
  });
});

/** A frame whose JSON is exactly `chars` long. */
function frameOfLength(chars: number): Extract<NetMsg, { type: 'frame' }> {
  const ev = { turn: 1, τ: 0, type: 'situation' as const, text: '' };
  const m = { type: 'frame' as const, turn: 1, τ: 0, ev: [ev] };
  ev.text = 'x'.repeat(chars - JSON.stringify(m).length);
  expect(JSON.stringify(m).length).toBe(chars);
  return m;
}

/** A frame whose JSON is exactly `bytes` UTF-8 bytes, its event text padded with `pad`. */
function frameOfBytes(bytes: number, pad: string): Extract<NetMsg, { type: 'frame' }> {
  const ev = { turn: 1, τ: 0, type: 'situation' as const, text: '' };
  const m = { type: 'frame' as const, turn: 1, τ: 0, ev: [ev] };
  const room = bytes - msgBytes(m);
  const width = new TextEncoder().encode(pad).byteLength;
  ev.text = pad.repeat(Math.floor(room / width)) + 'x'.repeat(room % width);
  expect(msgBytes(m)).toBe(bytes);
  return m;
}

/** A hello whose JSON is exactly `bytes` UTF-8 bytes. */
function helloOfBytes(bytes: number): NetMsg {
  const m = { type: 'hello', proto: PROTO, app: APP_ID, name: '', look: noBand } satisfies NetMsg;
  m.name = 'x'.repeat(bytes - msgBytes(m));
  expect(msgBytes(m)).toBe(bytes);
  return m;
}

describe('encodeMsg', () => {
  it('is the JSON of the message', () => {
    for (const m of samples) expect(encodeMsg(m)).toBe(JSON.stringify(m));
  });

  it(`sends a message of exactly MAX_SEND_BYTES (${MAX_SEND_BYTES}) bytes`, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = helloOfBytes(MAX_SEND_BYTES);
    expect(encodeMsg(m)).toBe(JSON.stringify(m));
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([MAX_SEND_BYTES + 1, 40000])('refuses a %i-byte message with a "[bbt] frame too big" warning', (bytes) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(encodeMsg(helloOfBytes(bytes))).toBeNull();
    expect(warn.mock.calls).toEqual([['[bbt] frame too big', bytes]]);
  });

  it('measures UTF-8 bytes, not characters', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m: NetMsg = { type: 'hello', proto: PROTO, app: APP_ID, name: 'é'.repeat(16000), look: noBand };
    expect(JSON.stringify(m).length).toBeLessThan(MAX_SEND_BYTES);
    expect(encodeMsg(m)).toBeNull();
    expect(warn.mock.calls).toEqual([['[bbt] frame too big', msgBytes(m)]]);
  });
});

describe('encodeWithBytes', () => {
  it('is the JSON of the message with its size in UTF-8 bytes', () => {
    for (const m of [...samples, frameOfBytes(MAX_SEND_BYTES, '🎾')]) {
      expect(encodeWithBytes(m)).toEqual({ json: JSON.stringify(m), bytes: msgBytes(m) });
    }
  });

  it('refuses an oversized message with the same warning as encodeMsg', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(encodeWithBytes(frameOfBytes(MAX_SEND_BYTES + 1, 'é'))).toBeNull();
    expect(warn.mock.calls).toEqual([['[bbt] frame too big', MAX_SEND_BYTES + 1]]);
  });
});

describe('decodeMsg', () => {
  it('parses and validates a JSON string', () => {
    for (const m of samples) expect(decodeMsg(JSON.stringify(m))).toEqual(parseMsg(wire(m)));
    expect(decodeMsg(JSON.stringify({ ...find('hello'), name: '<b>' }))).toEqual({ ...find('hello'), name: '?b?' });
  });

  it.each(['', 'garbage', '[object Object]', '{"type":"leave"', 'null', '42', '"leave"', '{"type":"hello"}', '{"type":"nope"}'])(
    'drops the string %j',
    (data) => {
      expect(decodeMsg(data)).toBeNull();
    },
  );

  it.each([
    ['an object', { type: 'leave' }],
    ['an ArrayBuffer', new TextEncoder().encode('{"type":"leave"}').buffer],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
  ])('drops %s (only strings are wire messages)', (_label, data) => {
    expect(decodeMsg(data)).toBeNull();
  });

  it(`drops a string whose JSON is over MAX_MSG_CHARS (${MAX_MSG_CHARS})`, () => {
    const m = { type: 'hello', proto: PROTO, app: APP_ID, name: 'x'.repeat(MAX_MSG_CHARS), look: noBand };
    expect(decodeMsg(JSON.stringify(m))).toBeNull();
  });

  it(`keeps a string of exactly MAX_SEND_BYTES (${MAX_SEND_BYTES}) characters and drops one a character longer`, () => {
    const fits = JSON.stringify(frameOfLength(MAX_SEND_BYTES));
    expect(decodeMsg(fits)).toEqual(JSON.parse(fits));
    expect(decodeMsg(JSON.stringify(frameOfLength(MAX_SEND_BYTES + 1)))).toBeNull();
  });

  it('drops a 100 KB string without parsing it', () => {
    const big = JSON.stringify(frameOfLength(100 * 1024));
    const parse = vi.spyOn(JSON, 'parse');
    const decoded = decodeMsg(big);
    const parses = parse.mock.calls.length;
    parse.mockRestore();
    expect(decoded).toBeNull();
    expect(parses).toBe(0);
  });

  it.each(['x', 'é', '🎾'])('keeps every message encodeMsg sends, up to MAX_SEND_BYTES padded with %j', (pad) => {
    const json = encodeMsg(frameOfBytes(MAX_SEND_BYTES, pad));
    expect(json).not.toBeNull();
    expect(decodeMsg(json)).toEqual(JSON.parse(json!));
  });

  it('does not stringify what it parsed again to measure it', () => {
    const json = JSON.stringify(samples[15]);
    const stringify = vi.spyOn(JSON, 'stringify');
    const decoded = decodeMsg(json);
    const stringifies = stringify.mock.calls.length;
    stringify.mockRestore();
    expect(decoded).toEqual(samples[15]);
    expect(stringifies).toBe(0);
  });
});

describe('parseMsg round trip', () => {
  it('the samples cover every message type', () => {
    const types = new Set(samples.map((m) => m.type));
    expect([...types].sort()).toEqual(
      ['clock', 'early', 'forfeit', 'frame', 'hello', 'input', 'leave', 'lobby', 'ping', 'pong', 'ready', 'reject', 'rematch', 'start', 'welcome'],
    );
  });

  it.each(samples.map((m, i) => [`${i}:${m.type}`, m] as const))('%s survives the wire unchanged', (_label, m) => {
    expect(parseMsg(wire(m))).toEqual(m);
  });

  it('a frame without ev/s has no ev/s keys', () => {
    const parsed = parseMsg(wire(find('frame')));
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!).sort()).toEqual(['turn', 'type', 'τ']);
  });

  it('treats ev/s set to undefined (never on the wire) as absent', () => {
    expect(parseMsg({ type: 'frame', turn: 4, τ: 10, ev: undefined, s: undefined })).toEqual({ type: 'frame', turn: 4, τ: 10 });
  });

  it.each(['everyday', 'sports', 'dojo', 'mixed'])('keeps a config with the %s word pack', (pack) => {
    expect(parseMsg(tampered(find('lobby'), (x) => (x.config.wordPack = pack)))).toMatchObject({ config: { wordPack: pack } });
  });

  it('drops unknown fields', () => {
    const parsed = parseMsg(tampered(find('hello'), (x) => {
      x.evil = '<script>';
      x.look.extra = 1;
    }));
    expect(parsed).toEqual(find('hello'));
  });

  it('drops unknown fields inside config and profiles', () => {
    const parsed = parseMsg(tampered(find('start'), (x) => {
      x.config.seed = 1234;
      x.hostProfile.admin = true;
    }));
    expect(parsed).toEqual(find('start'));
  });
});

describe('parseMsg rejects', () => {
  it.each([null, undefined, 42, 'hello', true, [], [{ type: 'leave' }]])('non-message %j', (raw) => {
    expect(parseMsg(raw)).toBeNull();
  });

  it.each([{}, { type: 'shout' }, { type: 'HELLO' }, { type: 7 }, { type: 'toString' }, { type: '__proto__' }])('unknown or missing type %j', (raw) => {
    expect(parseMsg(raw)).toBeNull();
  });

  const required = samples.flatMap((m) =>
    Object.keys(m)
      .filter((k) => k !== 'type' && !(m.type === 'frame' && (k === 'ev' || k === 's')))
      .map((k) => [`${m.type} without ${k}`, m, k] as const),
  );
  it.each(required)('%s', (_label, m, key) => {
    expect(parseMsg(tampered(m, (x) => delete x[key]))).toBeNull();
  });

  const lookFields = ['skin', 'hairStyle', 'hair', 'shirt', 'shorts', 'headband', 'racket'];
  it.each(lookFields)('hello with look.%s missing or not a number', (field) => {
    expect(parseMsg(tampered(find('hello'), (x) => delete x.look[field]))).toBeNull();
    expect(parseMsg(tampered(find('hello'), (x) => (x.look[field] = '3')))).toBeNull();
  });

  const configFields = ['format', 'pace', 'surface', 'wordPack', 'deuceRule', 'training'];
  it.each(configFields)('lobby with config.%s missing or invalid', (field) => {
    expect(parseMsg(tampered(find('lobby'), (x) => delete x.config[field]))).toBeNull();
    expect(parseMsg(tampered(find('lobby'), (x) => (x.config[field] = 'bogus')))).toBeNull();
  });

  it('lobby with the retired tennis word pack', () => {
    expect(parseMsg(tampered(find('lobby'), (x) => (x.config.wordPack = 'tennis')))).toBeNull();
  });

  const wrongTypes: [string, NetMsg, (x: Record<string, any>) => void][] = [
    ['hello proto as string', find('hello'), (x) => (x.proto = '1')],
    ['hello fractional proto', find('hello'), (x) => (x.proto = 1.5)],
    ['hello numeric name', find('hello'), (x) => (x.name = 5)],
    ['hello numeric app', find('hello'), (x) => (x.app = 1)],
    ['hello look null', find('hello'), (x) => (x.look = null)],
    ['hello look array', find('hello'), (x) => (x.look = [1, 2, 3, 4, 5, 6, 7])],
    ['welcome hostProfile null', find('welcome'), (x) => (x.hostProfile = null)],
    ['welcome hostProfile without look', find('welcome'), (x) => delete x.hostProfile.look],
    ['welcome config null', find('welcome'), (x) => (x.config = null)],
    ['welcome training.serveClock not boolean', samples[2]!, (x) => (x.config.training.serveClock = 1)],
    ['welcome training.fixedWords.serve not nested strings', samples[2]!, (x) => (x.config.training.fixedWords.serve = [['ace', 3]])],
    ['welcome training.fixedWords.choice missing', samples[2]!, (x) => delete x.config.training.fixedWords.choice],
    ['reject unknown reason', find('reject'), (x) => (x.reason = 'banned')],
    ['lobby ready of length 1', find('lobby'), (x) => (x.ready = [true])],
    ['lobby ready of length 3', find('lobby'), (x) => (x.ready = [true, false, true])],
    ['lobby ready with a string', find('lobby'), (x) => (x.ready = [true, 'no'])],
    ['ready on as string', find('ready'), (x) => (x.on = 'yes')],
    ['start guestProfile name null', find('start'), (x) => (x.guestProfile.name = null)],
    ['input uppercase letter', find('input'), (x) => (x.k = 'Q')],
    ['input two letters', find('input'), (x) => (x.k = 'ab')],
    ['input empty key', find('input'), (x) => (x.k = '')],
    ['input non-letter', find('input'), (x) => (x.k = '1')],
    ['input Toss', find('input'), (x) => (x.k = 'Toss')],
    ['input fractional seq', find('input'), (x) => (x.seq = 1.5)],
    ['input τ as string', find('input'), (x) => (x.τ = '5')],
    ['input τ null (NaN on the wire)', find('input'), (x) => (x.τ = null)],
    ['input turn as string', find('input'), (x) => (x.turn = '11')],
    ['clock τ as boolean', find('clock'), (x) => (x.τ = true)],
    ['frame ev not an array', samples[13]!, (x) => (x.ev = { 0: x.ev[0] })],
    ['frame ev null', samples[13]!, (x) => (x.ev = null)],
    ['frame ev entry not an object', samples[13]!, (x) => x.ev.push('boom')],
    ['frame ev entry without type', samples[13]!, (x) => delete x.ev[0].type],
    ['frame ev entry with numeric type', samples[13]!, (x) => (x.ev[0].type = 3)],
    ['frame ev entry without turn', samples[13]!, (x) => delete x.ev[1].turn],
    ['frame ev entry with string τ', samples[13]!, (x) => (x.ev[1].τ = '812')],
    ['frame s null', samples[14]!, (x) => (x.s = null)],
    ['frame s array', samples[14]!, (x) => (x.s = [])],
    ['frame s with v 1', samples[14]!, (x) => (x.s.v = 1)],
    ['frame s without v', samples[14]!, (x) => delete x.s.v],
    ['frame s with one player', samples[14]!, (x) => x.s.players.pop()],
    ['frame s with three players', samples[14]!, (x) => x.s.players.push(x.s.players[0])],
    ['frame s with a player that is not an object', samples[14]!, (x) => (x.s.players[1] = 'guest')],
    ['frame s with a player without a name', samples[14]!, (x) => delete x.s.players[0].name],
    ['frame s with a player look that is not an object', samples[14]!, (x) => (x.s.players[0].look = 3)],
    ['frame s without score', samples[14]!, (x) => delete x.s.score],
    ['frame s with score null', samples[14]!, (x) => (x.s.score = null)],
    ['frame s with numeric turn', samples[14]!, (x) => (x.s.turn = 5)],
    ['frame s without turn', samples[14]!, (x) => delete x.s.turn],
    ['frame s with numeric status', samples[14]!, (x) => (x.s.status = 1)],
    ['ping id as string', find('ping'), (x) => (x.id = '3')],
    ['pong fractional id', find('pong'), (x) => (x.id = 0.5)],
    ['rematch want as number', find('rematch'), (x) => (x.want = 1)],
  ];
  it.each(wrongTypes)('%s', (_label, m, mutate) => {
    expect(parseMsg(tampered(m, mutate))).toBeNull();
  });
});

describe('parseMsg size cap', () => {
  it('accepts a message of exactly 32 KB of JSON', () => {
    expect(parseMsg(frameOfLength(MAX_MSG_CHARS))).not.toBeNull();
  });

  it('drops a message one character over 32 KB', () => {
    expect(parseMsg(frameOfLength(MAX_MSG_CHARS + 1))).toBeNull();
  });

  it('drops an oversized hello even though its name would be clamped', () => {
    expect(parseMsg(tampered(find('hello'), (x) => (x.name = 'A'.repeat(40000))))).toBeNull();
  });
});

describe('parseMsg clamps names and looks', () => {
  const hostile = [
    '<img src=x onerror=alert(1)>',
    '🎾🎾 Ace 🔥 Player Supreme',
    '',
    '   ',
    'Zoë Ünïcödé',
    'a'.repeat(200),
    '‮evil\u0000name',
  ];

  it.each(hostile)('hello name %j is passed through sanitizeName', (name) => {
    const parsed = parseMsg(tampered(find('hello'), (x) => (x.name = name)));
    expect(parsed).toMatchObject({ type: 'hello', name: sanitizeName(name) });
  });

  it('clamps an HTML name to 12 glyphs with ? for characters outside the font', () => {
    const parsed = parseMsg(tampered(find('hello'), (x) => (x.name = '<b>Bob</b>')));
    expect(parsed).toMatchObject({ name: '?b?Bob??b?' });
    const long = parseMsg(tampered(find('hello'), (x) => (x.name = '<img src=x onerror=alert(1)>')));
    expect(long).toMatchObject({ name: '?img src?x o' });
  });

  it('sanitizes the profile names in welcome and start', () => {
    const welcome = parseMsg(tampered(find('welcome'), (x) => (x.hostProfile.name = '💥<host>💥')));
    expect(welcome).toMatchObject({ hostProfile: { name: sanitizeName('💥<host>💥') } });
    const start = parseMsg(tampered(find('start'), (x) => {
      x.hostProfile.name = '<h>';
      x.guestProfile.name = '👾👾👾';
    }));
    expect(start).toMatchObject({ hostProfile: { name: '?h?' }, guestProfile: { name: '???' } });
  });

  it('sanitizes the player names inside a frame state', () => {
    const parsed = parseMsg(wire({ type: 'frame', turn: 2, τ: 0, s: publicState(['<i>Eve</i>', '🤖 bot']) }));
    expect(parsed).not.toBeNull();
    const s = (parsed as Extract<NetMsg, { type: 'frame' }>).s!;
    expect(s.players.map((p) => p.name)).toEqual([sanitizeName('<i>Eve</i>'), sanitizeName('🤖 bot')]);
    expect(s.players[0].kind).toBe('human');
    expect(s.score.points).toEqual([2, 3]);
  });

  it('clamps look indices to their ranges', () => {
    const wild = { skin: 99, hairStyle: 9, hair: 8, shirt: 12, shorts: -1, headband: 50, racket: 6 };
    const parsed = parseMsg(tampered(find('hello'), (x) => (x.look = wild)));
    expect(parsed).toMatchObject({ look: { skin: 5, hairStyle: 4, hair: 7, shirt: 11, shorts: 0, headband: 11, racket: 5 } });
  });

  it('clamps negative and fractional look indices to whole numbers in range', () => {
    const odd = { skin: -3, hairStyle: 2.9, hair: 0.2, shirt: 11.99, shorts: 3.5, headband: -0.5, racket: 1e9 };
    const parsed = parseMsg(tampered(find('hello'), (x) => (x.look = odd)));
    expect(parsed).toMatchObject({ look: { skin: 0, hairStyle: 2, hair: 0, shirt: 11, shorts: 3, headband: 0, racket: 5 } });
  });

  it('keeps a null headband', () => {
    const parsed = parseMsg(wire(find('hello')));
    expect(parsed).toMatchObject({ look: { headband: null } });
  });

  it('clamps looks inside profiles and frame state players', () => {
    const start = parseMsg(tampered(find('start'), (x) => (x.guestProfile.look.racket = 77)));
    expect(start).toMatchObject({ guestProfile: { look: { racket: 5 } } });
    const frame = parseMsg(tampered(samples[14]!, (x) => (x.s.players[1].look.skin = 40)));
    expect(frame).toMatchObject({ s: { players: [{}, { look: { skin: 5 } }] } });
  });
});

describe('frame states and the power meter (PROTO 2)', () => {
  /** A frame carrying state `s`, as it arrives on the wire (JSON text, decoded by decodeMsg). */
  const frame = (s: unknown): string => JSON.stringify({ type: 'frame', turn: 11, τ: 900, s });

  it('accepts a v2 state and keeps its meter levels', () => {
    const m = decodeMsg(frame(publicState()));
    expect(m?.type === 'frame' && m.s?.power).toEqual([1, 4]);
  });

  it('clamps levels to 0–4 and rejects a missing, non-array or non-finite meter, and a v1 state', () => {
    const clamped = decodeMsg(frame({ ...publicState(), power: [-3, 9] }));
    expect(clamped?.type === 'frame' && clamped.s?.power).toEqual([0, 4]);
    for (const power of [undefined, null, 3, [1], [1, 'x'], [1, NaN]]) {
      expect(decodeMsg(frame({ ...publicState(), power })), JSON.stringify(power)).toBeNull();
    }
    expect(decodeMsg(frame({ ...publicState(), v: 1 }))).toBeNull();
  });

  it('is protocol version 3 (2 brought the meter; early typing brought 3)', () => {
    expect(PROTO).toBe(3);
  });
});

describe('early (early-typing spec §6.3)', () => {
  const keys = [{ key: 'd', τ: -300 }, { key: 'r', τ: -120.5 }];

  it('passes a valid list, copied clean', () => {
    expect(parseMsg({ type: 'early', turn: 12, keys: keys.map((k) => ({ ...k, extra: 1 })), junk: true })).toEqual({ type: 'early', turn: 12, keys });
    expect(parseMsg({ type: 'early', turn: 12, keys: [] })).toEqual({ type: 'early', turn: 12, keys: [] });
  });

  it.each([
    ['a non-integer turn', { turn: 1.5, keys }],
    ['a key after τ 0', { turn: 1, keys: [{ key: 'd', τ: 1 }] }],
    ['a non-finite τ', { turn: 1, keys: [{ key: 'd', τ: null }] }],
    ['a non-letter', { turn: 1, keys: [{ key: 'toss', τ: -1 }] }],
    ['an upper-case letter', { turn: 1, keys: [{ key: 'D', τ: -1 }] }],
    ['more than MAX_EARLY_KEYS keys', { turn: 1, keys: Array.from({ length: MAX_EARLY_KEYS + 1 }, () => ({ key: 'z', τ: -1 })) }],
    ['keys that are not a list', { turn: 1, keys: 'dr' }],
  ])('drops a message with %s', (_name, m) => {
    expect(parseMsg({ type: 'early', ...m })).toBeNull();
  });

  it('is protocol version 3', () => {
    expect(PROTO).toBe(3);
  });
});
