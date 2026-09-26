/** Prefix of every key this game stores, so it never collides with other games on a shared origin (spec §5.4, §8). */
export const STORAGE_PREFIX = 'bbtennis:v1:';

const PROBE_KEY = `${STORAGE_PREFIX}probe`;

/**
 * The stored value under `key` (prefixed), or `fallback` when nothing is stored, the text is not
 * JSON, `validate` rejects it, or storage is unavailable: reading `localStorage` itself throws in
 * sandboxed iframes and with blocked site data. Never throws. `fallback` is returned as given.
 */
export function load<T>(key: string, fallback: T, validate: (v: unknown) => v is T): T {
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    const v: unknown = JSON.parse(raw);
    return validate(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Stores `v` as JSON under `key` (prefixed); false when storage is unavailable or full, or `v` is not JSON-encodable. */
export function save(key: string, v: unknown): boolean {
  try {
    globalThis.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

/** True when values can be stored in this browser mode (a probe key is written and removed). */
export const storageOk = (): boolean => {
  try {
    const store = globalThis.localStorage;
    store.setItem(PROBE_KEY, '1');
    store.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
};
