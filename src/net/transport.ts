import type { Scheduler } from '../game/clock';
import { loopbackPair as channelLoopback, TransportListeners as ChannelListeners, type LoopbackOptions, type Transport as Channel } from './channel';
import { msgBytes, NET_CODEC, type NetMsg } from './protocol';

export { MAX_HELD_BYTES, MAX_HELD_MESSAGES, REMOTE_CLOSED, type LoopbackOptions } from './channel';

/** A reliable, ordered channel of the typing game's messages to the other player (spec §5.3); see `net/channel`. */
export type Transport = Channel<NetMsg>;

/** The listeners of a typing-game transport: held messages are measured by `msgBytes` (see `net/channel`). */
export class TransportListeners extends ChannelListeners<NetMsg> {
  constructor() {
    super(msgBytes);
  }
}

/** Two connected in-memory transports of the typing game's messages, driven by `s` (see `net/channel` loopbackPair). */
export function loopbackPair(s: Scheduler, opts: LoopbackOptions): [Transport, Transport] {
  return channelLoopback(s, opts, NET_CODEC);
}
