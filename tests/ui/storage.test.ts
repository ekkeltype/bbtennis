// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { load, save, storageOk, STORAGE_PREFIX } from '../../src/ui/storage';

const isNumberList = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number');

/** Makes every `window.localStorage` access throw, as a sandboxed iframe or blocked site data does. */
function blockStorage(): void {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storage keys', () => {
  it('uses the bbtennis:v1: prefix', () => {
    expect(STORAGE_PREFIX).toBe('bbtennis:v1:');
  });

  it('saves JSON under the prefixed key and loads it back', () => {
    expect(save('scores', [1, 2, 3])).toBe(true);
    expect(window.localStorage.getItem('bbtennis:v1:scores')).toBe('[1,2,3]');
    expect(window.localStorage.getItem('scores')).toBeNull();
    expect(load('scores', [], isNumberList)).toEqual([1, 2, 3]);
  });

  it('never reads an unprefixed key', () => {
    window.localStorage.setItem('scores', '[9]');
    expect(load('scores', [0], isNumberList)).toEqual([0]);
  });
});

describe('load falls back', () => {
  it('when nothing is stored', () => {
    const fallback = [7];
    expect(load('missing', fallback, isNumberList)).toBe(fallback);
  });

  it.each(['{not json', '', 'undefined', '[1,'])('when the stored text %j is not JSON', (raw) => {
    window.localStorage.setItem('bbtennis:v1:scores', raw);
    expect(load('scores', [0], isNumberList)).toEqual([0]);
  });

  it.each(['{"a":1}', '["x"]', 'null', '42'])('when the stored JSON %s fails validation', (raw) => {
    window.localStorage.setItem('bbtennis:v1:scores', raw);
    expect(load('scores', [0], isNumberList)).toEqual([0]);
  });

  it('when the validator itself throws', () => {
    save('scores', [1]);
    const angry = (_: unknown): _ is number[] => {
      throw new Error('boom');
    };
    expect(load('scores', [0], angry)).toEqual([0]);
  });
});

describe('storage unavailable (throwing localStorage)', () => {
  it('load returns the fallback, save returns false and storageOk() is false', () => {
    blockStorage();
    expect(load('scores', [5], isNumberList)).toEqual([5]);
    expect(save('scores', [1])).toBe(false);
    expect(storageOk()).toBe(false);
  });

  it('save returns false when setItem throws (quota exceeded, Safari private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    expect(save('scores', [1])).toBe(false);
    expect(storageOk()).toBe(false);
  });

  it('load returns the fallback when getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(load('scores', [3], isNumberList)).toEqual([3]);
  });

  it('save returns false for a value JSON cannot encode', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(save('cyclic', cyclic)).toBe(false);
  });
});

describe('storageOk', () => {
  it('is true with working storage and leaves no probe key behind', () => {
    expect(storageOk()).toBe(true);
    expect(window.localStorage.length).toBe(0);
  });
});
