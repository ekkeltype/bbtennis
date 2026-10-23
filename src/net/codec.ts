/**
 * Largest message a transport sends, in UTF-8 bytes of its JSON (see Codec.bytes); transports drop a
 * larger one (see Codec.encode). It is also the most characters Codec.decode accepts in a received
 * string: a string never has more characters than UTF-8 bytes, so every sendable message passes. Well
 * under the 64 KiB a WebRTC data channel always accepts.
 */
export const MAX_SEND_BYTES = 32000;

/** A message in wire form: its JSON and the UTF-8 byte length of that JSON. */
export interface EncodedMsg { json: string; bytes: number }

/** How one protocol's messages go on the wire (spec §5.3): JSON strings, size-capped and validated on receipt. */
export interface Codec<M> {
  /** The wire form of `m` with its size, or null with a `[bbt] frame too big` warning when it is over MAX_SEND_BYTES. */
  encode(m: M): EncodedMsg | null;
  /**
   * A received wire message: a JSON string of at most MAX_SEND_BYTES characters (checked before it is
   * parsed; no sendable message is longer) whose value the protocol's checks accept; anything else is null.
   */
  decode(data: unknown): M | null;
  /** Size of `m` on the wire: the UTF-8 byte length of its JSON. */
  bytes(m: M): number;
}

const utf8 = new TextEncoder();

const jsonBytes = (json: string): number => utf8.encode(json).byteLength;

/** Size of any message on a JSON wire: the UTF-8 byte length of its JSON (what a jsonCodec's `bytes` measures). */
export function wireBytes(m: unknown): number {
  return jsonBytes(JSON.stringify(m));
}

/**
 * The JSON codec of a protocol whose received values `parse` validates (returning a clean copy, or
 * null). `parse` gets values whose size was already checked, so it need not measure them again.
 */
export function jsonCodec<M>(parse: (raw: unknown) => M | null): Codec<M> {
  return {
    encode(m) {
      const json = JSON.stringify(m);
      const bytes = jsonBytes(json);
      if (bytes <= MAX_SEND_BYTES) return { json, bytes };
      console.warn('[bbt] frame too big', bytes);
      return null;
    },
    decode(data) {
      if (typeof data !== 'string' || data.length > MAX_SEND_BYTES) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        return null;
      }
      return parse(raw);
    },
    bytes(m) {
      return wireBytes(m);
    },
  };
}
