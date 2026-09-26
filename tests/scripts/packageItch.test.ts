// Typechecked with Node types by tsconfig.node.json; this test drives a Node script and reads its zip.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'packageItch.mjs');
const ZIP_NAME = 'black-belt-tennis-itch.zip';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;

/** One file of a ZIP archive as its central directory describes it, with its extracted bytes. */
interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  size: number;
  data: Buffer;
}

/**
 * Reads a ZIP archive (no archive comment, no ZIP64) through its central directory, checking every
 * local header against it and every extracted file against its size and CRC-32. Throws on any mismatch.
 */
function readZip(zip: Buffer): ZipEntry[] {
  const fail = (what: string): never => {
    throw new Error(`bad zip: ${what}`);
  };
  const end = zip.length - 22;
  if (end < 0 || zip.readUInt32LE(end) !== END_SIG) fail('no end-of-central-directory record at the end');
  const count = zip.readUInt16LE(end + 10);
  if (zip.readUInt16LE(end + 8) !== count) fail('entry counts differ');
  const cdSize = zip.readUInt32LE(end + 12);
  const cdOffset = zip.readUInt32LE(end + 16);
  if (cdOffset + cdSize !== end) fail('central directory does not end at the end record');
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== CENTRAL_SIG) fail(`central record ${i} signature`);
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const dosTime = zip.readUInt16LE(p + 12);
    const dosDate = zip.readUInt16LE(p + 14);
    const crc = zip.readUInt32LE(p + 16);
    const compressedSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (zip.readUInt32LE(local) !== LOCAL_SIG) fail(`${name}: local header signature`);
    if (flags & DATA_DESCRIPTOR_FLAG) fail(`${name}: data descriptor not expected`);
    if (zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method) fail(`${name}: local flags/method differ`);
    if (zip.readUInt16LE(local + 10) !== dosTime || zip.readUInt16LE(local + 12) !== dosDate) fail(`${name}: local time differs`);
    if (zip.readUInt32LE(local + 14) !== crc) fail(`${name}: local CRC differs`);
    if (zip.readUInt32LE(local + 18) !== compressedSize || zip.readUInt32LE(local + 22) !== size) fail(`${name}: local sizes differ`);
    const localNameLen = zip.readUInt16LE(local + 26);
    if (zip.toString('utf8', local + 30, local + 30 + localNameLen) !== name) fail(`${name}: local name differs`);
    const start = local + 30 + localNameLen + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) fail(`${name}: method ${method}`);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== size) fail(`${name}: size ${data.length}, header says ${size}`);
    if (crc32(data) !== crc) fail(`${name}: CRC-32 mismatch`);
    entries.push({ name, flags, method, dosTime, dosDate, crc, compressedSize, size, data });
  }
  if (p !== cdOffset + cdSize) fail('central directory size');
  return entries;
}

/** Deterministic bytes that deflate cannot shrink (a PNG-like payload). */
function noise(length: number): Buffer {
  const out = Buffer.alloc(length);
  let x = 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** A small stand-in for a Vite build: the page, hashed assets, a licence and an empty file. */
const FIXTURE: Record<string, Buffer> = {
  'index.html': Buffer.from('<!doctype html><title>Black Belt Tennis</title><script type="module" src="./assets/index-B1t2e3.js"></script>'),
  'assets/index-B1t2e3.js': Buffer.from('console.log("rally");\n'.repeat(200)),
  'assets/court-C4d5.png': noise(4096),
  'licenses/press-start-2p-OFL.txt': Buffer.from('SIL OPEN FONT LICENSE Version 1.1\n'),
  'empty.txt': Buffer.alloc(0),
};

describe('scripts/packageItch.mjs', () => {
  let work: string;
  let dist: string;
  let zipPath: string;

  const writeDist = (files: Record<string, Buffer>): void => {
    for (const [rel, bytes] of Object.entries(files)) {
      const file = join(dist, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
  };
  const run = () => spawnSync(process.execPath, [SCRIPT], { cwd: work, encoding: 'utf8' });
  const entryOf = (entries: ZipEntry[], name: string): ZipEntry => {
    const e = entries.find((x) => x.name === name);
    if (!e) throw new Error(`${name} is not in the zip`);
    return e;
  };

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'bbt-itch-'));
    dist = join(work, 'dist');
    zipPath = join(work, ZIP_NAME);
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it('zips the contents of dist/ (not the folder) into black-belt-tennis-itch.zip, index.html at the root', () => {
    writeDist(FIXTURE);
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(ZIP_NAME);
    const names = readZip(readFileSync(zipPath)).map((e) => e.name);
    expect([...names].sort()).toEqual(Object.keys(FIXTURE).sort());
    expect(names).toContain('index.html');
  });

  it('stores every file byte for byte with its CRC-32', () => {
    writeDist(FIXTURE);
    expect(run().status).toBe(0);
    const entries = readZip(readFileSync(zipPath));
    for (const [name, bytes] of Object.entries(FIXTURE)) {
      const e = entryOf(entries, name);
      expect(e.data.equals(bytes), name).toBe(true);
      expect(e.crc, name).toBe(crc32(bytes));
    }
  });

  it('deflates files that compress and never stores a file larger than it is', () => {
    writeDist(FIXTURE);
    expect(run().status).toBe(0);
    const entries = readZip(readFileSync(zipPath));
    const js = entryOf(entries, 'assets/index-B1t2e3.js');
    expect(js.method).toBe(8);
    expect(js.compressedSize).toBeLessThan(js.size / 4);
    for (const e of entries) expect(e.compressedSize, e.name).toBeLessThanOrEqual(e.size);
  });

  it('marks names as UTF-8 so non-ASCII file names survive', () => {
    writeDist({ 'index.html': Buffer.from('<p>ok</p>'), 'assets/señal.txt': Buffer.from('ñ') });
    expect(run().status).toBe(0);
    const entries = readZip(readFileSync(zipPath));
    expect(entries.map((e) => e.name).sort()).toEqual(['assets/señal.txt', 'index.html']);
    for (const e of entries) expect(e.flags & UTF8_FLAG, e.name).toBe(UTF8_FLAG);
  });

  it("stamps each entry with the file's modification time (local, 2 s resolution)", () => {
    writeDist({ 'index.html': Buffer.from('<p>ok</p>') });
    const when = new Date(2026, 5, 15, 14, 30, 8);
    utimesSync(join(dist, 'index.html'), when, when);
    expect(run().status).toBe(0);
    const e = entryOf(readZip(readFileSync(zipPath)), 'index.html');
    expect({
      year: 1980 + (e.dosDate >> 9),
      month: (e.dosDate >> 5) & 0x0f,
      day: e.dosDate & 0x1f,
      hours: e.dosTime >> 11,
      minutes: (e.dosTime >> 5) & 0x3f,
      seconds: (e.dosTime & 0x1f) * 2,
    }).toEqual({ year: 2026, month: 6, day: 15, hours: 14, minutes: 30, seconds: 8 });
  });

  it('replaces a zip left by an earlier run', () => {
    writeFileSync(zipPath, 'stale bytes from an older build');
    writeDist(FIXTURE);
    expect(run().status).toBe(0);
    expect(readZip(readFileSync(zipPath)).length).toBe(Object.keys(FIXTURE).length);
  });

  it('fails without writing a zip when dist/ is missing', () => {
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('npm run build');
    expect(existsSync(zipPath)).toBe(false);
  });

  it('fails without writing a zip when index.html is not at the root of dist/', () => {
    writeDist({ 'game/index.html': Buffer.from('<p>nested</p>') });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('index.html');
    expect(existsSync(zipPath)).toBe(false);
  });
});

describe('public/licenses', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const fonts = Object.keys(pkg.dependencies)
    .filter((d) => d.startsWith('@fontsource/'))
    .map((d) => d.slice('@fontsource/'.length));

  // Line endings are normalised: a checkout with core.autocrlf may turn the shipped copies into CRLF.
  const text = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

  it('ships the OFL licence of every bundled @fontsource font verbatim as <font>-OFL.txt', () => {
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      const upstream = text(join(ROOT, 'node_modules', '@fontsource', font, 'LICENSE'));
      expect(upstream, font).toContain('SIL Open Font License, Version 1.1');
      const shipped = join(ROOT, 'public', 'licenses', `${font}-OFL.txt`);
      expect(existsSync(shipped), shipped).toBe(true);
      expect(text(shipped), font).toBe(upstream);
    }
  });
});
