/**
 * itch.io package (spec §7): `npm run package:itch`, run after `npm run build`.
 *
 * Zips the contents of dist/ (not the folder itself) into black-belt-tennis-itch.zip in the current
 * directory, which is the repo root under npm, so index.html sits at the zip root as itch.io's HTML
 * kind requires. A zip left by an earlier run is replaced. The ZIP writer is Node's zlib
 * plus the format's three records: each file is deflated when that makes it smaller and stored
 * otherwise, names are UTF-8, times are the files' modification times. No ZIP64: a build is a few MB
 * (Buffer writes throw rather than wrap if a size ever passes 4 GB).
 *
 * Exits 1 and writes nothing when dist/ has no index.html at its root.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const DIST = 'dist';
const OUT = 'black-belt-tennis-itch.zip';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
/** ZIP 2.0: the version that introduced deflate, both "made by" and "needed to extract". */
const ZIP_VERSION = 20;
const UTF8_NAMES = 0x0800;
const STORE = 0;
const DEFLATE = 8;

/** Little-endian `[bytes, value]` fields (2 or 4 bytes each) packed into one buffer. */
function pack(fields) {
  const buf = Buffer.alloc(fields.reduce((n, [bytes]) => n + bytes, 0));
  let at = 0;
  for (const [bytes, value] of fields) {
    if (bytes === 2) buf.writeUInt16LE(value, at);
    else buf.writeUInt32LE(value, at);
    at += bytes;
  }
  return buf;
}

/** MS-DOS time and date words for a local time (2 s steps; anything before 1980 becomes 1980-01-01 00:00). */
function dosDateTime(d) {
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Every file under `dir` as a path relative to it with forward slashes, sorted. */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/**
 * One archive member written at `offset`: `local` is its local header followed by its data,
 * `central` its central-directory record.
 */
function member(name, data, mtime, offset) {
  const deflated = deflateRawSync(data, { level: 9 });
  const method = deflated.length < data.length ? DEFLATE : STORE;
  const body = method === DEFLATE ? deflated : data;
  const nameBytes = Buffer.from(name, 'utf8');
  const { time, date } = dosDateTime(mtime);
  // Shared by both records: version needed, flags, method, time, date, CRC-32, compressed size,
  // uncompressed size, name length, extra-field length.
  const common = [
    [2, ZIP_VERSION],
    [2, UTF8_NAMES],
    [2, method],
    [2, time],
    [2, date],
    [4, crc32(data)],
    [4, body.length],
    [4, data.length],
    [2, nameBytes.length],
    [2, 0],
  ];
  return {
    local: Buffer.concat([pack([[4, LOCAL_SIG], ...common]), nameBytes, body]),
    // After `common`: comment length, disk number, internal attributes, external attributes, local header offset.
    central: Buffer.concat([pack([[4, CENTRAL_SIG], [2, ZIP_VERSION], ...common, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]), nameBytes]),
  };
}

/** A ZIP archive of `files` (paths relative to `dir`), each named by its relative path. */
function zipFiles(dir, files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of files) {
    const path = join(dir, name);
    const { local, central } = member(name, readFileSync(path), statSync(path).mtime, offset);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  // Disk number, disk holding the directory, entries on this disk, entries in total, directory size,
  // directory offset, archive comment length.
  const end = pack([[4, END_SIG], [2, 0], [2, 0], [2, files.length], [2, files.length], [4, directory.length], [4, offset], [2, 0]]);
  return Buffer.concat([...locals, directory, end]);
}

function main() {
  const files = existsSync(DIST) ? listFiles(DIST) : [];
  if (!files.includes('index.html')) {
    console.error(`packageItch: no index.html at the root of ${join(process.cwd(), DIST)}; run \`npm run build\` first, from the repo root.`);
    process.exitCode = 1;
    return;
  }
  const zip = zipFiles(DIST, files);
  writeFileSync(OUT, zip);
  console.log(`Wrote ${OUT}: ${files.length} files from ${DIST}/, ${(zip.length / 1024).toFixed(1)} KiB, index.html at the zip root.`);
}

main();
