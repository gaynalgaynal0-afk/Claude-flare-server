#!/usr/bin/env node
/**
 * JV Audio-Track Patcher — Node.js Server Version
 * Ported from WTM extension popup.js
 *
 * Patches the audio track's sample tables:
 *   - stsz: adds fake audio frames (×10 total)
 *   - stsc: adds a new chunk entry for fake frames
 *   - stco/co64: recalculates all chunk offsets + adds poison offset
 *   - edts: removed from audio track
 *   - Appends poison blob after mdat
 *
 * Usage: node patcher.js <input.mp4> <output.mp4>
 */

'use strict';

const fs = require('fs');

// ── Constants ─────────────────────────────────────────────────────────────────
const FAKE_FRAME_SIZE = 8;                                      // bytes per fake audio sample
const FAKE_SAMPLE     = new Uint8Array([0,0,0,4, 0,0,0,0]);    // poison sample template
const FAKE_MULTIPLIER = 10;                                     // total = realFrames × 10

// Container box types — these have children
const CONTAINERS = new Set([
  'moov','trak','mdia','minf','stbl','edts','dinf','udta','meta','ilst'
]);

// ── Primitives ────────────────────────────────────────────────────────────────

/** Read 4-char box type at offset */
function readType(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
}

/** Validate a uint32 value — throws if out of range */
function assertUint32(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 4294967295)
    throw new Error(`${label}: value ${value} is not a valid uint32`);
}

/** Build a new MP4 box: [size(4)] [type(4)] [payload] */
function makeBox(type, payload) {
  const size = 8 + payload.length;
  const out  = new Uint8Array(size);
  const view = new DataView(out.buffer);
  assertUint32(size, `${type}.size`);
  view.setUint32(0, size, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

/** Concatenate multiple Uint8Arrays into one */
function concat(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out   = new Uint8Array(total);
  let   pos   = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}

/** Return raw box bytes (from offset to end, including header) */
function rawBox(box) {
  return box.data.slice(box.offset, box.end);
}

/** Return box payload bytes (after header) */
function boxPayload(box) {
  return box.data.slice(box.contentStart, box.end);
}

// ── MP4 Box Parser ────────────────────────────────────────────────────────────

function parseOneBox(bytes, view, offset, end, parentPath) {
  if (offset + 8 > end) throw new Error('Invalid MP4: truncated box header');

  const rawSize = view.getUint32(offset, false);
  const type    = readType(bytes, offset + 4);
  let   size    = rawSize;
  let   headerSize = 8;

  if (rawSize === 1) {
    // 64-bit box — only support if high 32 bits are zero
    if (offset + 16 > end) throw new Error(`Invalid MP4: incomplete 64-bit ${type} box`);
    if (view.getUint32(offset + 8, false) !== 0)
      throw new Error('MP4 box is too large for this patcher (>4GB)');
    size       = view.getUint32(offset + 12, false);
    headerSize = 16;
  } else if (rawSize === 0) {
    // box extends to end of file
    size = end - offset;
  }

  // mdat sometimes reports incorrect size — clamp to file end
  if (type === 'mdat' && offset + size > end) size = end - offset;

  if (size < headerSize || offset + size > end)
    throw new Error(`Invalid MP4: bad size in ${type} box (size=${size})`);

  const path = parentPath ? `${parentPath}/${type}` : type;

  const box = {
    type, path, data: bytes, view,
    offset,
    end:          offset + size,
    size,
    headerSize,
    contentStart: offset + headerSize,
    // prefix/suffix track where children sit (for rebuilding)
    prefixStart:  offset + headerSize,
    prefixEnd:    offset + headerSize,
    suffixStart:  offset + size,
    suffixEnd:    offset + size,
    children: [],
  };
  return box;
}

/** Offset where children start (meta boxes have a 4-byte version/flags prefix) */
function childrenStart(box) {
  return box.type === 'meta' ? box.contentStart + 4 : box.contentStart;
}

function parseBoxes(bytes, view, start, end, parentPath) {
  const boxes = [];
  let   pos   = start;

  while (pos + 8 <= end) {
    // stop at all-zero padding
    if (bytes.slice(pos, end).every(b => b === 0)) break;

    let box;
    try {
      box = parseOneBox(bytes, view, pos, end, parentPath);
    } catch (err) {
      // non-critical containers: ignore parse errors inside them
      if (/\/(udta|meta|ilst)$/.test(parentPath || '')) break;
      throw err;
    }

    if (CONTAINERS.has(box.type)) {
      const cs = childrenStart(box);
      if (cs > box.end) throw new Error(`Invalid MP4: ${box.type} container too short`);
      box.prefixStart  = box.contentStart;
      box.prefixEnd    = cs;
      box.children     = parseBoxes(bytes, view, cs, box.end, box.path);
      box.suffixStart  = box.children.length
        ? box.children[box.children.length - 1].end
        : cs;
      box.suffixEnd    = box.end;
    }

    boxes.push(box);
    pos = box.end;
  }

  return boxes;
}

// ── Box lookup helpers ────────────────────────────────────────────────────────

function findChild(box, type) {
  return box.children.find(c => c.type === type) || null;
}

function findPath(box, path) {
  let node = box;
  for (const t of path) {
    node = findChild(node, t);
    if (!node) return null;
  }
  return node;
}

function getHandlerType(track) {
  const hdlr = findPath(track, ['mdia', 'hdlr']);
  if (!hdlr || hdlr.contentStart + 12 > hdlr.end) return null;
  return readType(hdlr.data, hdlr.contentStart + 8);
}

// ── Chunk offset readers ──────────────────────────────────────────────────────

function readChunkOffsets(box) {
  const payload   = boxPayload(box);
  if (payload.length < 8)
    throw new Error(`Malformed ${box.type}: too short`);
  const view      = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count     = view.getUint32(4, false);
  const entrySize = box.type === 'co64' ? 8 : 4;
  if (8 + count * entrySize > payload.length)
    throw new Error(`Malformed ${box.type}: declares ${count} entries but data too short`);

  const offsets = [];
  for (let i = 0; i < count; i++) {
    const off = 8 + i * entrySize;
    if (box.type === 'co64') {
      const hi  = view.getUint32(off,     false);
      const lo  = view.getUint32(off + 4, false);
      const val = hi * 4294967296 + lo;
      if (!Number.isSafeInteger(val)) throw new Error('co64 offset exceeds safe integer range');
      offsets.push(val);
    } else {
      offsets.push(view.getUint32(off, false));
    }
  }
  return offsets;
}

/** Collect every stco/co64 box in the entire moov tree */
function collectChunkSnapshots(root) {
  const snapshots = [];
  function visit(box) {
    if (box.type === 'stco' || box.type === 'co64') {
      snapshots.push({ box, originalType: box.type, originalOffsets: readChunkOffsets(box) });
    }
    box.children.forEach(visit);
  }
  visit(root);
  return snapshots;
}

// ── Box builders ──────────────────────────────────────────────────────────────

/** Build a new stco/co64 with shifted offsets + optional poison entry */
function buildChunkOffsetBox(snapshot, shift, poisonOffset, appendPoison) {
  const offsets = snapshot.originalOffsets.map(o => o + shift);
  if (appendPoison) offsets.push(poisonOffset);

  offsets.forEach((o, i) => {
    if (!Number.isSafeInteger(o) || o < 0)
      throw new Error(`Invalid shifted chunk offset at index ${i}: ${o}`);
  });

  const useCo64  = snapshot.originalType === 'co64' || Math.max(0, ...offsets) > 4294967295;
  const entrySize = useCo64 ? 8 : 4;
  const payload   = new Uint8Array(8 + offsets.length * entrySize);
  const view      = new DataView(payload.buffer);

  // copy original flags (bytes 0-3 of original payload)
  const origPayload = boxPayload(snapshot.box);
  payload.set(origPayload.slice(0, 4), 0);
  view.setUint32(4, offsets.length, false);

  offsets.forEach((val, i) => {
    const off = 8 + i * entrySize;
    if (useCo64) {
      view.setUint32(off,     Math.floor(val / 4294967296), false);
      view.setUint32(off + 4, val >>> 0,                    false);
    } else {
      assertUint32(val, 'stco offset');
      view.setUint32(off, val, false);
    }
  });

  return makeBox(useCo64 ? 'co64' : 'stco', payload);
}

/** Build new audio stsz — appends fakeFrames entries of FAKE_FRAME_SIZE bytes */
function buildAudioStsz(stszBox, fakeFrames) {
  const content = boxPayload(stszBox);
  if (content.length < 12) throw new Error('Malformed audio stsz: too short');
  const view       = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const sampleSize = view.getUint32(4, false);
  const realFrames = view.getUint32(8, false);

  if (sampleSize !== 0) throw new Error('Constant-size stsz not supported');
  if (!realFrames)      throw new Error('Audio track has zero samples');
  if (12 + realFrames * 4 > content.length)
    throw new Error('Malformed audio stsz: declares more samples than data contains');

  const totalFrames = realFrames + fakeFrames;
  assertUint32(totalFrames, 'stsz total sample count');

  const payload = new Uint8Array(12 + totalFrames * 4);
  const outView = new DataView(payload.buffer);

  // copy original flags
  payload.set(content.slice(0, 4), 0);
  outView.setUint32(4, 0,           false);  // sample-size field = 0 (variable)
  outView.setUint32(8, totalFrames, false);

  // copy real frame sizes
  payload.set(content.slice(12, 12 + realFrames * 4), 12);

  // append fake frame sizes
  for (let i = realFrames; i < totalFrames; i++)
    outView.setUint32(12 + i * 4, FAKE_FRAME_SIZE, false);

  return { box: makeBox('stsz', payload), realFrames };
}

/** Build new audio stsc — appends one chunk entry for the fake frames */
function buildAudioStsc(stscBox, realChunkCount, fakeFrames) {
  const content = boxPayload(stscBox);
  if (content.length < 8) throw new Error('Malformed audio stsc: too short');
  const view    = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const count   = view.getUint32(4, false);
  if (8 + count * 12 > content.length)
    throw new Error('Malformed audio stsc: declares more entries than data contains');

  assertUint32(realChunkCount + 1, 'stsc first chunk');
  assertUint32(fakeFrames,         'stsc samples per chunk');

  const lastDesc = count ? view.getUint32(8 + (count - 1) * 12 + 8, false) : 1;
  const payload  = new Uint8Array(8 + (count + 1) * 12);
  const outView  = new DataView(payload.buffer);

  payload.set(content.slice(0, 4), 0);          // flags
  outView.setUint32(4, count + 1, false);         // new entry count
  payload.set(content.slice(8, 8 + count * 12), 8); // copy existing entries

  const appendAt = 8 + count * 12;
  outView.setUint32(appendAt,      realChunkCount + 1, false); // first chunk
  outView.setUint32(appendAt + 4,  fakeFrames,          false); // samples per chunk
  outView.setUint32(appendAt + 8,  lastDesc,             false); // sample description

  return makeBox('stsc', payload);
}

/** Build poison blob: fakeFrames × FAKE_FRAME_SIZE bytes of repeating FAKE_SAMPLE */
function buildPoisonBlob(fakeFrames) {
  const length = fakeFrames * FAKE_FRAME_SIZE;
  if (!Number.isSafeInteger(length) || length <= 0)
    throw new Error('Invalid poison blob size');
  const out = new Uint8Array(length);
  out.set(FAKE_SAMPLE, 0);
  for (let filled = FAKE_SAMPLE.length; filled < out.length;) {
    const copyLen = Math.min(filled, out.length - filled);
    out.copyWithin(filled, 0, copyLen);
    filled += copyLen;
  }
  return out;
}

/** Recursively rebuild a box tree, applying replacements/removals */
function rebuildBox(box, replacements, removed) {
  if (removed.has(box))      return null;
  if (replacements.has(box)) return replacements.get(box);
  if (!box.children.length)  return rawBox(box);

  const pieces = [box.data.slice(box.prefixStart, box.prefixEnd)];
  for (const child of box.children) {
    const rebuilt = rebuildBox(child, replacements, removed);
    if (rebuilt) pieces.push(rebuilt);
  }
  if (box.suffixStart < box.suffixEnd)
    pieces.push(box.data.slice(box.suffixStart, box.suffixEnd));

  return makeBox(box.type, concat(pieces));
}

// ── Main patcher ──────────────────────────────────────────────────────────────

function patchMp4(inputBuffer) {
  const bytes    = new Uint8Array(inputBuffer);
  const view     = new DataView(inputBuffer);
  const topBoxes = parseBoxes(bytes, view, 0, bytes.length, '');

  const moov = topBoxes.find(b => b.type === 'moov');
  const mdat = topBoxes.find(b => b.type === 'mdat');
  if (!moov || !mdat)
    throw new Error("Required boxes 'moov' or 'mdat' not found. Fragmented MP4 not supported.");

  // Find the audio track
  const audioTrack = moov.children.find(
    b => b.type === 'trak' && getHandlerType(b) === 'soun'
  );
  if (!audioTrack) throw new Error('No audio track found in MP4.');

  // Find audio sample table
  const stbl         = findPath(audioTrack, ['mdia', 'minf', 'stbl']);
  const stsz         = stbl && findChild(stbl, 'stsz');
  const stsc         = stbl && findChild(stbl, 'stsc');
  const audioCoBox   = stbl && (findChild(stbl, 'stco') || findChild(stbl, 'co64'));
  if (!stbl || !stsz || !stsc || !audioCoBox)
    throw new Error('Audio track is missing required sample tables (stsz, stsc, stco/co64).');

  const audioOffsets  = readChunkOffsets(audioCoBox);
  const realChunkCount = audioOffsets.length;
  if (!realChunkCount) throw new Error('Audio track has zero chunks.');

  // Calculate fake frame count (total = real × 10)
  const stszContent = boxPayload(stsz);
  const stszView    = new DataView(stszContent.buffer, stszContent.byteOffset, stszContent.byteLength);
  const realFrames  = stszView.getUint32(8, false);
  const totalFrames = Math.floor(realFrames * FAKE_MULTIPLIER);
  const fakeFrames  = totalFrames - realFrames;

  if (fakeFrames <= 0)
    throw new Error('Audio track too short for patching ratio.');

  console.log(`[patcher] Audio frames: ${realFrames} real → ${totalFrames} total (+${fakeFrames} fake)`);

  // Build patched audio boxes
  const stszResult      = buildAudioStsz(stsz, fakeFrames);
  const stscReplacement = buildAudioStsc(stsc, realChunkCount, fakeFrames);
  const chunkSnapshots  = collectChunkSnapshots(moov);

  // Remove edts (edit list) from audio track
  const removed  = new Set();
  const editList = findChild(audioTrack, 'edts');
  if (editList) removed.add(editList);

  // Base replacements (stsz + stsc)
  const baseReplacements = new Map([
    [stsz, stszResult.box],
    [stsc, stscReplacement],
  ]);

  // Build full replacements including shifted chunk offsets
  function makeReplacements(shift, poisonOffset) {
    const map = new Map(baseReplacements);
    for (const snapshot of chunkSnapshots) {
      const appendPoison = snapshot.box === audioCoBox;
      map.set(snapshot.box, buildChunkOffsetBox(snapshot, shift, poisonOffset, appendPoison));
    }
    return map;
  }

  // Separate prefix boxes (before moov/mdat) and trailer boxes (after both)
  const prefixLimit = Math.min(moov.offset, mdat.offset);
  const tailEdge    = Math.max(moov.end,    mdat.end);

  const prefixBytes  = concat(topBoxes
    .filter(b => !['moov','mdat'].includes(b.type) && b.offset <  prefixLimit)
    .map(rawBox));
  const trailerBytes = concat(topBoxes
    .filter(b => !['moov','mdat'].includes(b.type) && b.offset >= tailEdge)
    .map(rawBox));

  // Two-pass offset calculation:
  // Pass 1: build moov at shift=0 to measure its new size
  const firstMoov    = rebuildBox(moov, makeReplacements(0, 0), removed);
  const newMdatOffset = prefixBytes.length + firstMoov.length;
  const shift         = newMdatOffset - mdat.offset;
  const poisonOffset  = newMdatOffset + mdat.size;

  // Pass 2: build moov with correct shift and poison offset
  const finalMoov = rebuildBox(moov, makeReplacements(shift, poisonOffset), removed);

  if (finalMoov.length !== firstMoov.length)
    throw new Error('Internal consistency check failed: moov size changed between passes.');

  const poisonBlob = buildPoisonBlob(fakeFrames);

  console.log(`[patcher] shift=${shift}  poisonOffset=${poisonOffset}  poisonSize=${poisonBlob.length}`);

  return concat([prefixBytes, finalMoov, rawBox(mdat), poisonBlob, trailerBytes]);
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, inputPath, outputPath] = process.argv;

  if (!inputPath || !outputPath) {
    console.error('Usage: node patcher.js <input.mp4> <output.mp4>');
    process.exit(1);
  }

  try {
    console.log(`[patcher] Reading ${inputPath}`);
    const inputBuf = fs.readFileSync(inputPath).buffer;

    console.log('[patcher] Patching...');
    const output = patchMp4(inputBuf);

    fs.writeFileSync(outputPath, output);
    const sizeMB = (output.length / 1024 / 1024).toFixed(1);
    console.log(`[patcher] Done → ${outputPath} (${sizeMB} MB)`);
  } catch (err) {
    console.error('[patcher] Error:', err.message);
    process.exit(1);
  }
}

module.exports = { patchMp4 };
