/** ICE servers used unless VITE_ICE_SERVERS overrides them (spec §5.3). */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];

/** Build-time broker and ICE overrides (spec §5.3); values are strings as Vite provides them. */
export interface PeerEnvVars {
  VITE_PEER_HOST?: string;
  VITE_PEER_PORT?: string;
  VITE_PEER_PATH?: string;
  VITE_PEER_KEY?: string;
  VITE_ICE_SERVERS?: string;
}

/** Options for the PeerJS Peer constructor; absent fields keep the PeerJS cloud defaults. */
export interface BrokerOptions {
  host?: string;
  port?: number;
  path?: string;
  key?: string;
  config: { iceServers: RTCIceServer[] };
}

const warnEnv = (name: string, value: string, fallback: string): void => {
  console.warn(`[bbt] ignoring ${name}=${JSON.stringify(value)}; ${fallback}`);
};

const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every((u) => typeof u === 'string');

function isIceServer(v: unknown): v is RTCIceServer {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  const optionalString = (x: unknown): boolean => x === undefined || typeof x === 'string';
  return (typeof s.urls === 'string' || isStringList(s.urls)) && optionalString(s.username) && optionalString(s.credential);
}

function parseIceServers(json: string): RTCIceServer[] | null {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) && v.every(isIceServer) ? v : null;
  } catch {
    return null;
  }
}

/** Broker options from VITE_PEER_* / VITE_ICE_SERVERS; blank values are unset, invalid ones are ignored with a warning. */
export function peerOptions(env: PeerEnvVars): BrokerOptions {
  const value = (v: string | undefined): string | null => (v !== undefined && v.trim() !== '' ? v.trim() : null);
  const options: BrokerOptions = { config: { iceServers: DEFAULT_ICE_SERVERS } };
  const host = value(env.VITE_PEER_HOST);
  if (host !== null) options.host = host;
  const port = value(env.VITE_PEER_PORT);
  if (port !== null) {
    const n = Number(port);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) options.port = n;
    else warnEnv('VITE_PEER_PORT', port, 'using the default port');
  }
  const path = value(env.VITE_PEER_PATH);
  if (path !== null) options.path = path;
  const key = value(env.VITE_PEER_KEY);
  if (key !== null) options.key = key;
  const ice = value(env.VITE_ICE_SERVERS);
  if (ice !== null) {
    const servers = parseIceServers(ice);
    if (servers) options.config = { iceServers: servers };
    else warnEnv('VITE_ICE_SERVERS', ice, 'expected a JSON array of RTCIceServer; using the default ICE servers');
  }
  return options;
}
