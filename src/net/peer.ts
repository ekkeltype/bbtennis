import { NET_CODEC, type NetMsg } from './protocol';
import { hostRtc, joinRtc, type HostHandle as RtcHostHandle, type PeerEnv, type RtcProtocol } from './rtc';
import type { Transport } from './transport';

export {
  CLOSE_FLUSH_MS, GUEST_OPEN_TIMEOUT_MS, HOST_CODE_TRIES, JOIN_TIMEOUT_MS, RECONNECT_DELAY_MS, SLOW_STATUS_MS, STILL_CONNECTING,
  type ConnLike, type PeerEnv, type PeerErrorLike, type PeerFactory, type PeerLike,
} from './rtc';
export { NetError, errorKind, errorText, type NetErrorKind } from './netErrors';
export { DEFAULT_ICE_SERVERS, peerOptions, type BrokerOptions, type PeerEnvVars } from './peerConfig';

/** Prefix of every typing-game host's PeerJS id; the rest is the game code. */
export const PEER_ID_PREFIX = 'bbtennis-';

/** The typing game's PeerJS protocol: its wire codec and peer id prefix. */
const TYPING_RTC: RtcProtocol<NetMsg> = { codec: NET_CODEC, prefix: PEER_ID_PREFIX };

/** A registered host of the typing game waiting for guests (see net/rtc). */
export type HostHandle = RtcHostHandle<NetMsg>;

/** Registers a new typing-game code with the broker (PeerJS id `bbtennis-<CODE>`); see net/rtc hostRtc. */
export function hostGame(opts: PeerEnv = {}): Promise<HostHandle> {
  return hostRtc(TYPING_RTC, opts);
}

/** Connects to the typing-game host of `code` with a reliable raw DataConnection; see net/rtc joinRtc. */
export function joinGame(code: string, opts: PeerEnv = {}): Promise<Transport> {
  return joinRtc(TYPING_RTC, code, opts);
}
