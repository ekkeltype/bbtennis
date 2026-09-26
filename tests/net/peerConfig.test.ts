import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ICE_SERVERS, peerOptions } from '../../src/net/peerConfig';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('peerOptions', () => {
  it('uses the PeerJS cloud broker and the spec ICE servers by default', () => {
    expect(DEFAULT_ICE_SERVERS).toEqual([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
    ]);
    expect(peerOptions({})).toEqual({ config: { iceServers: DEFAULT_ICE_SERVERS } });
  });

  it('applies every VITE_ override', () => {
    const ice = [{ urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }, { urls: 'stun:stun.example.com' }];
    expect(peerOptions({
      VITE_PEER_HOST: 'peer.example.com',
      VITE_PEER_PORT: '9000',
      VITE_PEER_PATH: '/bbt',
      VITE_PEER_KEY: 'secret',
      VITE_ICE_SERVERS: JSON.stringify(ice),
    })).toEqual({ host: 'peer.example.com', port: 9000, path: '/bbt', key: 'secret', config: { iceServers: ice } });
  });

  it('treats blank values as unset', () => {
    expect(peerOptions({ VITE_PEER_HOST: '', VITE_PEER_PORT: ' ', VITE_PEER_PATH: '', VITE_PEER_KEY: '', VITE_ICE_SERVERS: '' }))
      .toEqual({ config: { iceServers: DEFAULT_ICE_SERVERS } });
  });

  it('accepts an empty ICE list (host candidates only)', () => {
    expect(peerOptions({ VITE_ICE_SERVERS: '[]' })).toEqual({ config: { iceServers: [] } });
  });

  it.each(['abc', '0', '70000', '80.5', '-1'])('ignores port %j with a warning', (port) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(peerOptions({ VITE_PEER_PORT: port })).toEqual({ config: { iceServers: DEFAULT_ICE_SERVERS } });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('VITE_PEER_PORT');
  });

  it.each(['not json', '{"urls":"stun:x"}', '[{"urls":5}]', '[{"username":"u"}]', '[{"urls":["stun:x", 3]}]', '[{"urls":"stun:x","credential":7}]', '[null]'])(
    'falls back to the default ICE servers for %j with a warning',
    (json) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(peerOptions({ VITE_ICE_SERVERS: json })).toEqual({ config: { iceServers: DEFAULT_ICE_SERVERS } });
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toContain('VITE_ICE_SERVERS');
    },
  );
});
