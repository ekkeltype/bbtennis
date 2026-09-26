/** User-facing network failure classes (spec §5.4); 'cancelled' means the caller aborted the attempt. */
export type NetErrorKind = 'notFound' | 'broker' | 'webrtc' | 'nat' | 'version' | 'full' | 'timeout' | 'cancelled';

/** A network failure; show it with errorText. `versions` are protocol versions for kind 'version'. */
export class NetError extends Error {
  override readonly name = 'NetError';

  constructor(readonly kind: NetErrorKind, message: string = kind, readonly versions?: { host: number; you: number }) {
    super(message);
  }
}

const ERROR_KINDS: Record<string, NetErrorKind> = {
  'peer-unavailable': 'notFound',
  'browser-incompatible': 'webrtc',
  webrtc: 'webrtc',
  'negotiation-failed': 'nat',
  'connection-closed': 'nat',
};

/** Maps a PeerJS error type to a NetErrorKind (spec §5.4); anything unlisted is a broker problem. */
export function errorKind(type: string): NetErrorKind {
  return Object.hasOwn(ERROR_KINDS, type) ? ERROR_KINDS[type]! : 'broker';
}

/** The message shown for `e` (spec §5.4); `code` is the game code the user tried. */
export function errorText(e: NetError, code?: string): string {
  switch (e.kind) {
    case 'notFound':
      return code ? `No game with code ${code}` : 'No game with that code';
    case 'broker':
      return "Can't reach the connection server";
    case 'webrtc':
      return 'Your browser has WebRTC disabled';
    case 'nat':
      return "Couldn't connect directly (firewall/NAT) — try another network";
    case 'version':
      return e.versions
        ? `Versions differ (host v${e.versions.host}, you v${e.versions.you}) — reload with Ctrl+Shift+R`
        : 'Versions differ — reload with Ctrl+Shift+R';
    case 'full':
      return 'That game already has two players';
    case 'timeout':
      return "The game didn't answer — try again";
    case 'cancelled':
      return 'Cancelled';
  }
}
