// Read a DSH session log, scanning per-frame because the file is concatenated zstd frames.
//
// WHY NOT zstd CLI
//
// There is no zstd binary on this machine, but Node 22+ ships zstd support in `node:zlib`. That is enough, and it
// avoids a dependency the user would have to install to read their own logs.
//
// WHY PER-FRAME
//
// The session log appends one compressed frame at a time. A process interrupted mid-write leaves a truncated tail
// frame, and a whole-file decompress refuses everything for that one bad frame. Scanning the magic bytes and
// decompressing each frame separately recovers all the good ones.
//
// Usage: node read-session-log.mjs <path> [pattern] [maxLines]
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const path = process.argv[2];
const pattern = process.argv[3];
const maxLines = Number(process.argv[4] ?? '40');

const buffer = readFileSync(path);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const offsets = [];
for (let at = buffer.indexOf(MAGIC); at !== -1; at = buffer.indexOf(MAGIC, at + 1)) {
  offsets.push(at);
}

const chunks = [];
let skipped = 0;
for (let i = 0; i < offsets.length; i += 1) {
  const start = offsets[i];
  const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
  try {
    chunks.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'));
  } catch {
    // A truncated tail frame is expected; skipping it beats losing the whole log.
    skipped += 1;
  }
}

const text = chunks.join('');
const lines = text.split('\n').filter((line) => line.trim() !== '');

let selected = lines;
if (typeof pattern === 'string' && pattern !== '') {
  let re;
  try {
    re = new RegExp(pattern, 'u');
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u');
  }
  selected = lines.filter((line) => re.test(line));
}

console.error(`frames=${offsets.length} decoded=${chunks.length} skipped=${skipped} lines=${lines.length} matched=${selected.length}`);
for (const line of selected.slice(-maxLines)) {
  console.log(line);
}
