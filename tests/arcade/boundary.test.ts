import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const ARCADE = join(SRC, 'arcade');

/** Modules of the typing game that the Arcade must never reach at runtime (paths under src/, no extension). */
const TYPING_ONLY = [
  'core/typing', 'core/words/lists', 'core/words/picker', 'core/power', 'core/turn', 'core/turnServe', 'core/turnReturn',
  'core/turnView', 'core/engine', 'core/cpu', 'core/sim', 'core/redact',
  'render/prompts', 'render/plates', 'render/layout', 'render/leaders', 'render/renderer', 'render/players', 'render/world',
  'render/hud', 'render/ball',
  'game/keyboard', 'game/localSession', 'game/hostSession', 'game/guestSession', 'game/training', 'game/onlineLink',
  'net/protocol', 'net/transport', 'net/peer',
  'ui/keySounds', 'ui/attract', 'ui/screens/lobby', 'ui/screens/online', 'app',
];

/** Every .ts file under `dir`, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Source text with `//` and block comments removed. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const posix = (p: string): string => p.split('\\').join('/');

interface Edge { spec: string; runtime: boolean }

/** Import and re-export edges of a file. Type-only imports (`import type`, all-`type` specifiers, `export type … from`) are marked non-runtime. */
function edges(file: string): Edge[] {
  const text = stripComments(readFileSync(file, 'utf8'));
  const out: Edge[] = [];
  for (const m of text.matchAll(/\b(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[2]!.trim();
    const braces = /^\{([^}]*)\}$/.exec(clause);
    const allType = braces !== null && braces[1]!.trim() !== '' && braces[1]!.split(',').every((s) => s.trim() === '' || s.trim().startsWith('type '));
    out.push({ spec: m[3]!, runtime: m[1] === undefined && !allType });
  }
  for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push({ spec: m[1]!, runtime: true });
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1]!, runtime: true });
  return out;
}

/** The .ts file a relative specifier names, or null for packages, assets and unknown paths. */
function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (c.endsWith('.ts') && existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

describe('arcade import boundary', () => {
  it('(a) no file outside src/arcade imports src/arcade', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      if (file.startsWith(ARCADE)) continue;
      for (const e of edges(file)) {
        const target = resolveSpec(file, e.spec);
        if (target !== null && target.startsWith(ARCADE)) offenders.push(`${posix(relative(SRC, file))} -> ${e.spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('(b) no typing-only module is reachable from src/arcade at runtime', () => {
    const banned = new Set(TYPING_ONLY.map((m) => posix(join(SRC, `${m}.ts`))));
    const failures: string[] = [];
    const seen = new Set<string>();
    const walk = (file: string, chain: string[]): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const here = [...chain, posix(relative(SRC, file))];
      if (banned.has(posix(file))) {
        failures.push(here.join(' → '));
        return;
      }
      for (const e of edges(file)) {
        if (!e.runtime) continue;
        const target = resolveSpec(file, e.spec);
        if (target !== null) walk(target, here);
      }
    };
    for (const file of tsFiles(ARCADE)) walk(file, []);
    expect(failures).toEqual([]);
  });

  it('(c) src/arcade/core and every module it reaches at runtime use only the allowed maths and no clocks, timers or DOM', () => {
    const forbidden = [
      /Math\.(sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|exp|expm1|log1p|log2|log10|log|pow|cbrt|hypot|random)\b/,
      /\*\*/,
      /\b(Date|performance|setTimeout|setInterval|requestAnimationFrame|document|window)\b/,
    ];
    // Exact integer operations such as Math.imul and the bit operators (rng) are deterministic and stay allowed.
    const reached = new Set<string>();
    const walk = (file: string): void => {
      if (reached.has(file)) return;
      reached.add(file);
      for (const e of edges(file)) {
        if (!e.runtime) continue;
        const target = resolveSpec(file, e.spec);
        if (target !== null) walk(target);
      }
    };
    for (const file of tsFiles(join(ARCADE, 'core'))) walk(file);
    expect(reached.size).toBeGreaterThan(tsFiles(join(ARCADE, 'core')).length);
    const offenders: string[] = [];
    for (const file of reached) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const re of forbidden) {
        const m = re.exec(text);
        if (m) offenders.push(`${posix(relative(SRC, file))}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
