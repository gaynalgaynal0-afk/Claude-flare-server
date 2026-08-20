// ── JV Studio Server — Cloudflare Worker ─────────────────────────────────────
// Pure JS — no ffmpeg, no Node.js, fully compatible with Cloudflare Workers
// Routes:
//   GET  /              → health check
//   GET  /tier/:uid     → get tier info
//   GET  /quota/:uid    → get upload quota
//   POST /verify        → check Telegram channel membership
//   POST /patch         → patch MP4 (multipart/form-data: video file + uid)

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const CHANNEL         = '@jv_60fps';
const FREE_LIMIT_MB   = 70;
const PREMIUM_LIMIT_MB= 120;
const FREE_LIMIT      = 3;   // uploads per week
const PREMIUM_LIMIT   = 5;
const WEEK_MS         = 7 * 24 * 60 * 60 * 1000;
const TTL_SECONDS     = 8 * 24 * 60 * 60;

// Premium UIDs — same as premium-check.js
const PREMIUM_UIDS = new Set([
  '7082829394',
  '8346579206',
  '5985087699',
]);

// ── CORS headers ──────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

// ── Tier helper ───────────────────────────────────────────────────────────────
function getTier(uid) {
  const isPremium = !!uid && PREMIUM_UIDS.has(String(uid));
  return {
    tier:       isPremium ? 'premium' : 'free',
    limitBytes: (isPremium ? PREMIUM_LIMIT_MB : FREE_LIMIT_MB) * 1024 * 1024,
    limitMB:    isPremium ? PREMIUM_LIMIT_MB : FREE_LIMIT_MB,
    weekLimit:  isPremium ? PREMIUM_LIMIT : FREE_LIMIT,
  };
}

// ── Upstash Redis helper ──────────────────────────────────────────────────────
async function redis(env, ...args) {
  const url   = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Upstash env vars not set');

  const res  = await fetch(`${url}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(`Redis: ${data.error}`);
  return data.result;
}

async function getUploadInfo(env, uid, tier) {
  const LIMIT   = tier === 'premium' ? PREMIUM_LIMIT : FREE_LIMIT;
  const key     = `uploads:${uid}`;
  let   raw;
  try { raw = await redis(env, 'GET', key); } catch { raw = null; }

  const now        = Date.now();
  const weekAgo    = now - WEEK_MS;
  const timestamps = raw ? JSON.parse(raw).filter(t => t > weekAgo) : [];
  const used       = timestamps.length;
  const remaining  = Math.max(0, LIMIT - used);
  const resets_at  = timestamps.length > 0 ? timestamps[0] + WEEK_MS : null;

  return { allowed: used < LIMIT, used, limit: LIMIT, remaining, resets_at };
}

async function recordUpload(env, uid) {
  const key     = `uploads:${uid}`;
  let   raw;
  try { raw = await redis(env, 'GET', key); } catch { raw = null; }

  const now        = Date.now();
  const weekAgo    = now - WEEK_MS;
  const timestamps = raw ? JSON.parse(raw).filter(t => t > weekAgo) : [];
  timestamps.push(now);

  await redis(env, 'SET', key, JSON.stringify(timestamps), 'EX', String(TTL_SECONDS));
}

// ── Telegram membership check ─────────────────────────────────────────────────
async function checkMembership(env, uid) {
  const token = env.BOT_TOKEN;
  if (!token) return { ok: false, error: 'BOT_TOKEN not configured' };

  const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(CHANNEL)}&user_id=${uid}`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    if (!d.ok) return { ok: false, error: d.description || 'Telegram API error' };
    const status = d.result && d.result.status;
    const member = ['member', 'administrator', 'creator'].includes(status);
    return { ok: true, member, status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── patchMp4 — pure JS MP4 patcher (ported from patcher_bypass.js) ───────────
const FAKE_FRAME_SIZE = 8;
const FAKE_SAMPLE     = new Uint8Array([0,0,0,4, 0,0,0,0]);
const FAKE_MULTIPLIER = 10;
const CONTAINERS      = new Set(['moov','trak','mdia','minf','stbl','edts','dinf','udta','meta','ilst']);

function readType(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
}
function assertUint32(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 4294967295)
    throw new Error(`${label}: value ${value} is not a valid uint32`);
}
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
function concat(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out   = new Uint8Array(total);
  let   pos   = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}
function rawBox(box) { return box.data.slice(box.offset, box.end); }
function boxPayload(box) { return box.data.slice(box.contentStart, box.end); }

function parseOneBox(bytes, view, offset, end) {
  if (offset + 8 > end) throw new Error('Invalid MP4: truncated box header');
  const rawSize = view.getUint32(offset, false);
  const type    = readType(bytes, offset + 4);
  let   size    = rawSize;
  let   headerSize = 8;
  if (rawSize === 1) {
    if (offset + 16 > end) throw new Error(`Incomplete 64-bit ${type} box`);
    if (view.getUint32(offset + 8, false) !== 0) throw new Error('MP4 box >4GB not supported');
    size = view.getUint32(offset + 12, false);
    headerSize = 16;
  } else if (rawSize === 0) {
    size = end - offset;
  }
  if (type === 'mdat' && offset + size > end) size = end - offset;
  if (size < headerSize || offset + size > end) throw new Error(`Bad size in ${type} (size=${size})`);
  return {
    type, data: bytes, view, offset, end: offset + size, size, headerSize,
    contentStart: offset + headerSize,
    prefixStart: offset + headerSize, prefixEnd: offset + headerSize,
    suffixStart: offset + size, suffixEnd: offset + size,
    children: [],
  };
}
function childrenStart(box) { return box.type === 'meta' ? box.contentStart + 4 : box.contentStart; }
function parseBoxes(bytes, view, start, end) {
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    if (bytes.slice(pos, end).every(b => b === 0)) break;
    const box = parseOneBox(bytes, view, pos, end);
    if (CONTAINERS.has(box.type)) {
      const cs = childrenStart(box);
      box.prefixStart = box.contentStart; box.prefixEnd = cs;
      box.children = parseBoxes(bytes, view, cs, box.end);
      box.suffixStart = box.children.length ? box.children[box.children.length-1].end : cs;
      box.suffixEnd = box.end;
    }
    boxes.push(box);
    pos = box.end;
  }
  return boxes;
}
function findChild(box, type) { return box.children.find(c => c.type === type) || null; }
function findPath(box, path) {
  let node = box;
  for (const t of path) { node = findChild(node, t); if (!node) return null; }
  return node;
}
function getHandlerType(track) {
  const hdlr = findPath(track, ['mdia','hdlr']);
  if (!hdlr || hdlr.contentStart + 12 > hdlr.end) return null;
  return readType(hdlr.data, hdlr.contentStart + 8);
}
function readChunkOffsets(box) {
  const payload = boxPayload(box);
  if (payload.length < 8) throw new Error(`Malformed ${box.type}`);
  const view    = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count   = view.getUint32(4, false);
  const entrySize = box.type === 'co64' ? 8 : 4;
  if (8 + count * entrySize > payload.length) throw new Error(`Malformed ${box.type}: too short`);
  const offsets = [];
  for (let i = 0; i < count; i++) {
    const off = 8 + i * entrySize;
    if (box.type === 'co64') {
      const hi = view.getUint32(off, false);
      const lo = view.getUint32(off+4, false);
      offsets.push(hi * 4294967296 + lo);
    } else {
      offsets.push(view.getUint32(off, false));
    }
  }
  return offsets;
}
function collectChunkSnapshots(root) {
  const snapshots = [];
  function visit(box) {
    if (box.type === 'stco' || box.type === 'co64')
      snapshots.push({ box, originalType: box.type, originalOffsets: readChunkOffsets(box) });
    box.children.forEach(visit);
  }
  visit(root);
  return snapshots;
}
function buildChunkOffsetBox(snapshot, shift, poisonOffset, appendPoison) {
  const offsets = snapshot.originalOffsets.map(o => o + shift);
  if (appendPoison) offsets.push(poisonOffset);
  const useCo64   = snapshot.originalType === 'co64' || Math.max(0, ...offsets) > 4294967295;
  const entrySize = useCo64 ? 8 : 4;
  const payload   = new Uint8Array(8 + offsets.length * entrySize);
  const view      = new DataView(payload.buffer);
  const origPayload = boxPayload(snapshot.box);
  payload.set(origPayload.slice(0, 4), 0);
  view.setUint32(4, offsets.length, false);
  offsets.forEach((val, i) => {
    const off = 8 + i * entrySize;
    if (useCo64) { view.setUint32(off, Math.floor(val/4294967296), false); view.setUint32(off+4, val>>>0, false); }
    else { assertUint32(val, 'stco offset'); view.setUint32(off, val, false); }
  });
  return makeBox(useCo64 ? 'co64' : 'stco', payload);
}
function buildAudioStsz(stszBox, fakeFrames) {
  const content = boxPayload(stszBox);
  if (content.length < 12) throw new Error('Malformed audio stsz');
  const view       = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const sampleSize = view.getUint32(4, false);
  const realFrames = view.getUint32(8, false);
  if (sampleSize !== 0) throw new Error('Constant-size stsz not supported');
  if (!realFrames) throw new Error('Audio track has zero samples');
  const totalFrames = realFrames + fakeFrames;
  assertUint32(totalFrames, 'stsz total');
  const payload = new Uint8Array(12 + totalFrames * 4);
  const outView = new DataView(payload.buffer);
  payload.set(content.slice(0, 4), 0);
  outView.setUint32(4, 0, false);
  outView.setUint32(8, totalFrames, false);
  payload.set(content.slice(12, 12 + realFrames * 4), 12);
  for (let i = realFrames; i < totalFrames; i++) outView.setUint32(12 + i*4, FAKE_FRAME_SIZE, false);
  return { box: makeBox('stsz', payload), realFrames };
}
function buildAudioStsc(stscBox, realChunkCount, fakeFrames) {
  const content = boxPayload(stscBox);
  if (content.length < 8) throw new Error('Malformed audio stsc');
  const view  = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const count = view.getUint32(4, false);
  const lastDesc = count ? view.getUint32(8 + (count-1)*12 + 8, false) : 1;
  const payload  = new Uint8Array(8 + (count+1) * 12);
  const outView  = new DataView(payload.buffer);
  payload.set(content.slice(0, 4), 0);
  outView.setUint32(4, count+1, false);
  payload.set(content.slice(8, 8 + count*12), 8);
  const at = 8 + count*12;
  outView.setUint32(at,   realChunkCount+1, false);
  outView.setUint32(at+4, fakeFrames,       false);
  outView.setUint32(at+8, lastDesc,         false);
  return makeBox('stsc', payload);
}
function buildPoisonBlob(fakeFrames) {
  const out = new Uint8Array(fakeFrames * FAKE_FRAME_SIZE);
  out.set(FAKE_SAMPLE, 0);
  for (let filled = FAKE_SAMPLE.length; filled < out.length;) {
    const copyLen = Math.min(filled, out.length - filled);
    out.copyWithin(filled, 0, copyLen);
    filled += copyLen;
  }
  return out;
}
function rebuildBox(box, replacements, removed) {
  if (removed.has(box))      return null;
  if (replacements.has(box)) return replacements.get(box);
  if (!box.children.length)  return rawBox(box);
  const pieces = [box.data.slice(box.prefixStart, box.prefixEnd)];
  for (const child of box.children) {
    const rebuilt = rebuildBox(child, replacements, removed);
    if (rebuilt) pieces.push(rebuilt);
  }
  if (box.suffixStart < box.suffixEnd) pieces.push(box.data.slice(box.suffixStart, box.suffixEnd));
  return makeBox(box.type, concat(pieces));
}

function patchMp4(inputBuffer) {
  const bytes    = new Uint8Array(inputBuffer);
  const view     = new DataView(inputBuffer);
  const topBoxes = parseBoxes(bytes, view, 0, bytes.length);
  const moov = topBoxes.find(b => b.type === 'moov');
  const mdat = topBoxes.find(b => b.type === 'mdat');
  if (!moov || !mdat) throw new Error("moov or mdat not found. Fragmented MP4 not supported.");

  const audioTrack = moov.children.find(b => b.type === 'trak' && getHandlerType(b) === 'soun');
  if (!audioTrack) throw new Error('No audio track found.');

  const stbl       = findPath(audioTrack, ['mdia','minf','stbl']);
  const stsz       = stbl && findChild(stbl, 'stsz');
  const stsc       = stbl && findChild(stbl, 'stsc');
  const audioCoBox = stbl && (findChild(stbl, 'stco') || findChild(stbl, 'co64'));
  if (!stbl || !stsz || !stsc || !audioCoBox) throw new Error('Audio sample tables missing.');

  const audioOffsets   = readChunkOffsets(audioCoBox);
  const realChunkCount = audioOffsets.length;
  if (!realChunkCount) throw new Error('Audio track has zero chunks.');

  const stszContent = boxPayload(stsz);
  const stszView    = new DataView(stszContent.buffer, stszContent.byteOffset, stszContent.byteLength);
  const realFrames  = stszView.getUint32(8, false);
  const totalFrames = Math.floor(realFrames * FAKE_MULTIPLIER);
  const fakeFrames  = totalFrames - realFrames;
  if (fakeFrames <= 0) throw new Error('Audio track too short for patching.');

  const stszResult      = buildAudioStsz(stsz, fakeFrames);
  const stscReplacement = buildAudioStsc(stsc, realChunkCount, fakeFrames);
  const chunkSnapshots  = collectChunkSnapshots(moov);
  const removed         = new Set();
  const editList        = findChild(audioTrack, 'edts');
  if (editList) removed.add(editList);

  const baseReplacements = new Map([[stsz, stszResult.box],[stsc, stscReplacement]]);

  function makeReplacements(shift, poisonOffset) {
    const map = new Map(baseReplacements);
    for (const snapshot of chunkSnapshots) {
      const appendPoison = snapshot.box === audioCoBox;
      map.set(snapshot.box, buildChunkOffsetBox(snapshot, shift, poisonOffset, appendPoison));
    }
    return map;
  }

  const prefixLimit  = Math.min(moov.offset, mdat.offset);
  const tailEdge     = Math.max(moov.end, mdat.end);
  const prefixBytes  = concat(topBoxes.filter(b => !['moov','mdat'].includes(b.type) && b.offset < prefixLimit).map(rawBox));
  const trailerBytes = concat(topBoxes.filter(b => !['moov','mdat'].includes(b.type) && b.offset >= tailEdge).map(rawBox));

  const firstMoov     = rebuildBox(moov, makeReplacements(0, 0), removed);
  const newMdatOffset = prefixBytes.length + firstMoov.length;
  const shift         = newMdatOffset - mdat.offset;
  const poisonOffset  = newMdatOffset + mdat.size;
  const finalMoov     = rebuildBox(moov, makeReplacements(shift, poisonOffset), removed);

  if (finalMoov.length !== firstMoov.length) throw new Error('moov size changed between passes.');

  return concat([prefixBytes, finalMoov, rawBox(mdat), buildPoisonBlob(fakeFrames), trailerBytes]);
}

// ── Request router ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // Preflight
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // GET /
    if (method === 'GET' && path === '/') {
      return json({ status: 'ok', service: 'JV Studio Worker', version: '2.0' });
    }

    // GET /tier/:uid
    const tierMatch = path.match(/^\/tier\/(\d+)$/);
    if (method === 'GET' && tierMatch) {
      const { tier, limitMB } = getTier(tierMatch[1]);
      return json({ tier, limit_mb: limitMB });
    }

    // GET /quota/:uid
    const quotaMatch = path.match(/^\/quota\/(\d+)$/);
    if (method === 'GET' && quotaMatch) {
      const uid          = quotaMatch[1];
      const { tier }     = getTier(uid);
      const info         = await getUploadInfo(env, uid, tier);
      return json({ ...info, tier });
    }

    // POST /verify  — body: { uid }
    if (method === 'POST' && path === '/verify') {
      let uid;
      try { const body = await request.json(); uid = String(body.uid || '').trim(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!uid || !/^\d{5,15}$/.test(uid)) return json({ error: 'Invalid UID' }, 400);

      const result = await checkMembership(env, uid);
      if (!result.ok) return json({ error: result.error }, 500);

      const { tier } = getTier(uid);
      return json({ member: result.member, status: result.status, tier });
    }

    // POST /patch  — multipart/form-data: video (file) + uid (field)
    if (method === 'POST' && path === '/patch') {
      let formData;
      try { formData = await request.formData(); } catch { return json({ error: 'Invalid multipart form data' }, 400); }

      const file = formData.get('video');
      const uid  = String(formData.get('uid') || '').trim();

      if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'No video file provided' }, 400);

      const { tier, limitBytes, limitMB, weekLimit } = getTier(uid);

      // Size check
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength > limitBytes) {
        return json({
          error:    `File exceeds the ${limitMB}MB limit for ${tier} users`,
          tier, limit_mb: limitMB,
          file_mb:  +(buffer.byteLength / 1024 / 1024).toFixed(1),
        }, 413);
      }

      // Quota check
      if (uid) {
        const quota = await getUploadInfo(env, uid, tier);
        if (!quota.allowed) {
          return json({
            error:     `Weekly limit reached (${quota.limit} uploads/week)`,
            tier, used: quota.used, limit: quota.limit, remaining: 0,
            resets_at: quota.resets_at,
          }, 429);
        }
      }

      // Patch
      let patched;
      try {
        patched = patchMp4(buffer);
      } catch (err) {
        return json({ error: `Patch failed: ${err.message}` }, 422);
      }

      // Record upload
      if (uid) {
        try { await recordUpload(env, uid); } catch (e) { console.warn('quota record failed:', e.message); }
      }

      // Build response headers
      const extraHeaders = { ...CORS, 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="jv_patched.mp4"', 'X-Tier': tier, 'X-Limit-MB': String(limitMB) };
      if (uid) {
        try {
          const q = await getUploadInfo(env, uid, tier);
          extraHeaders['X-Uploads-Used']      = String(q.used);
          extraHeaders['X-Uploads-Limit']     = String(q.limit);
          extraHeaders['X-Uploads-Remaining'] = String(q.remaining);
          if (q.resets_at) extraHeaders['X-Uploads-Resets-At'] = String(q.resets_at);
        } catch {}
      }

      return new Response(patched, { status: 200, headers: extraHeaders });
    }

    return json({ error: 'Not found' }, 404);
  }
};
