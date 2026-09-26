import { describe, expect, it } from 'vitest';
import { NetError, errorKind, errorText, type NetErrorKind } from '../../src/net/netErrors';

describe('errorKind', () => {
  const table: [string, NetErrorKind][] = [
    ['peer-unavailable', 'notFound'],
    ['network', 'broker'],
    ['socket-error', 'broker'],
    ['socket-closed', 'broker'],
    ['server-error', 'broker'],
    ['unavailable-id', 'broker'],
    ['invalid-key', 'broker'],
    ['ssl-unavailable', 'broker'],
    ['browser-incompatible', 'webrtc'],
    ['webrtc', 'webrtc'],
    ['negotiation-failed', 'nat'],
    ['connection-closed', 'nat'],
    ['something-new', 'broker'],
  ];
  it.each(table)('%s → %s', (type, kind) => {
    expect(errorKind(type)).toBe(kind);
  });
});

describe('errorText', () => {
  it.each([
    ['notFound', 'No game with code K7TQM'],
    ['broker', "Can't reach the connection server"],
    ['webrtc', 'Your browser has WebRTC disabled'],
    ['nat', "Couldn't connect directly (firewall/NAT) — try another network"],
    ['full', 'That game already has two players'],
    ['timeout', "The game didn't answer — try again"],
  ] as [NetErrorKind, string][])('%s → %s', (kind, text) => {
    expect(errorText(new NetError(kind), 'K7TQM')).toBe(text);
  });

  it('names the code only when given one', () => {
    expect(errorText(new NetError('notFound'))).toBe('No game with that code');
  });

  it('shows both protocol versions for a version mismatch', () => {
    expect(errorText(new NetError('version', 'rejected', { host: 2, you: 1 })))
      .toBe('Versions differ (host v2, you v1) — reload with Ctrl+Shift+R');
    expect(errorText(new NetError('version'))).toBe('Versions differ — reload with Ctrl+Shift+R');
  });

  it('NetError is an Error carrying its kind', () => {
    const e = new NetError('nat', 'ice failed');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('NetError');
    expect(e.kind).toBe('nat');
    expect(e.message).toBe('ice failed');
  });
});
