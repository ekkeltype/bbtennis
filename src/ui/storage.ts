/** Prefix of every key the typing game stores, so it never collides with other games on a shared origin (spec §5.4, §8). */
export const STORAGE_PREFIX = 'bbtennis:v1:';

/** A key-value store over `localStorage` with one key prefix; none of its methods throws. */
export interface Store {
  /**
   * The stored value under `key` (prefixed), or `fallback` when nothing is stored, the text is not
   * JSON, `validate` rejects it, or storage is unavailable: reading `localStorage` itself throws in
   * sandboxed iframes and with blocked site data. Never throws. `fallback` is returned as given.
   */
  load<T>(key: string, fallback: T, validate: (v: unknown) => v is T): T;
  /** Stores `v` as JSON under `key` (prefixed); false when storage is unavailable or full, or `v` is not JSON-encodable. */
  save(key: string, v: unknown): boolean;
  /** True when values can be stored in this browser mode (a probe key is written and removed). */
  storageOk(): boolean;
}

/** A store whose keys all start with `prefix`, e.g. `'bbtennis:v1:'`. */
export function createStore(prefix: string): Store {
  const probeKey = `${prefix}probe`;
  return {
    load<T>(key: string, fallback: T, validate: (v: unknown) => v is T): T {
      try {
        const raw = globalThis.localStorage.getItem(prefix + key);
        if (raw === null) return fallback;
        const v: unknown = JSON.parse(raw);
        return validate(v) ? v : fallback;
      } catch {
        return fallback;
      }
    },
    save(key: string, v: unknown): boolean {
      try {
        globalThis.localStorage.setItem(prefix + key, JSON.stringify(v));
        return true;
      } catch {
        return false;
      }
    },
    storageOk(): boolean {
      try {
        const store = globalThis.localStorage;
        store.setItem(probeKey, '1');
        store.removeItem(probeKey);
        return true;
      } catch {
        return false;
      }
    },
  };
}

const typingStore = createStore(STORAGE_PREFIX);

/** `Store.load` of the typing game's store (prefix `bbtennis:v1:`). */
export const load = typingStore.load;
/** `Store.save` of the typing game's store (prefix `bbtennis:v1:`). */
export const save = typingStore.save;
/** `Store.storageOk` of the typing game's store (prefix `bbtennis:v1:`). */
export const storageOk = typingStore.storageOk;
