// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ERROR, bootGame } from '../../src/ui/boot';

let ui: HTMLElement;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  document.body.innerHTML = '<div id="ui"></div>';
  ui = document.getElementById('ui')!;
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const message = (): string | null | undefined => ui.querySelector('.boot-error')?.textContent;

describe('bootGame', () => {
  it('starts the game and shows no error when it starts', async () => {
    const start = vi.fn(async () => {});
    await bootGame(ui, () => ({ start }));
    expect(start).toHaveBeenCalledOnce();
    expect(ui.querySelector('.boot-error')).toBeNull();
    expect(logged).not.toHaveBeenCalled();
  });

  it('logs a factory that throws and shows a readable message in #ui instead of a blank page', async () => {
    const boom = new Error('no screen');
    await bootGame(ui, () => {
      throw boom;
    });
    expect(BOOT_ERROR).toBe('Something went wrong starting the game — reload the page');
    expect(message()).toBe(BOOT_ERROR);
    expect(ui.querySelector('.boot-error')?.getAttribute('role')).toBe('alert');
    expect(logged).toHaveBeenCalledWith(expect.any(String), boom);
  });

  it('does the same when starting rejects (e.g. a screen factory throwing on the first go)', async () => {
    const boom = new Error('first go');
    await bootGame(ui, () => ({ start: () => Promise.reject(boom) }));
    expect(message()).toBe(BOOT_ERROR);
    expect(logged).toHaveBeenCalledWith(expect.any(String), boom);
  });
});
