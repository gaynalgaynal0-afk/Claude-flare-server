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

// Premium UIDs — fetched from GitHub, update the file anytime without redeploying
const PREMIUM_UIDS_URL = 'https://raw.githubusercontent.com/gaynalgaynal0-afk/JV-Upload-method-bot/main/premium-check.json';

let _premiumCache    = null;
let _premiumFetchedAt = 0;
const PREMIUM_CACHE_TTL_MS = 5 * 60 * 1000; // re-fetch every 5 minutes

async function getPremiumUids() {
  const now = Date.now();
  if (_premiumCache && (now - _premiumFetchedAt) < PREMIUM_CACHE_TTL_MS) {
    return _premiumCache;
  }
  try {
    const res = await fetch(PREMIUM_UIDS_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json(); // expects a JSON array of UID strings
    _premiumCache     = new Set(list.map(String));
    _premiumFetchedAt = now;
    console.log(`[worker] Loaded ${_premiumCache.size} premium UIDs from GitHub`);
  } catch (e) {
    console.warn('[worker] Failed to fetch premium UIDs, using cache or empty set:', e.message);
    if (!_premiumCache) _premiumCache = new Set();
  }
  return _premiumCache;
}

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
async function getTier(uid) {
  const premiumUids = await getPremiumUids();
  const isPremium   = !!uid && premiumUids.has(String(uid));
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

// ── patchMp4 — loaded externally from GitHub ─────────────────────────────────
// Update patcher_bypass.js on GitHub and it takes effect immediately —
// no worker redeployment needed.

const PATCHER_URL = 'https://raw.githubusercontent.com/gaynalgaynal0-afk/JV-Upload-method-bot/main/patcher_bypass.js';

// Cache the patcher module per worker instance (lives for the lifetime of the isolate)
let _patcherCache = null;
let _patcherFetchedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // re-fetch every 5 minutes max

async function getPatchMp4() {
  const now = Date.now();
  if (_patcherCache && (now - _patcherFetchedAt) < CACHE_TTL_MS) {
    return _patcherCache;
  }

  const res = await fetch(PATCHER_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch patcher: ${res.status}`);

  const code = await res.text();

  // Strip Node.js-only parts (fs require, CLI entry, module.exports)
  const cleaned = code
    .replace(/^const fs = require\('fs'\);?
?/m, '')
    .replace(/^if \(require\.main[\s\S]*?^}
?/m, '')
    .replace(/^module\.exports[\s\S]*?;?
?/m, '');

  // Execute the cleaned code and extract patchMp4
  const fn = new Function(`${cleaned}
return patchMp4;`);
  _patcherCache     = fn();
  _patcherFetchedAt = now;

  console.log('[worker] Patcher loaded from GitHub');
  return _patcherCache;
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
      const { tier, limitMB } = await getTier(tierMatch[1]);
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

      const { tier } = await getTier(uid);
      return json({ member: result.member, status: result.status, tier });
    }

    // POST /patch  — multipart/form-data: video (file) + uid (field)
    if (method === 'POST' && path === '/patch') {
      let formData;
      try { formData = await request.formData(); } catch { return json({ error: 'Invalid multipart form data' }, 400); }

      const file = formData.get('video');
      const uid  = String(formData.get('uid') || '').trim();

      if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'No video file provided' }, 400);

      const { tier, limitBytes, limitMB, weekLimit } = await getTier(uid);

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
        const patchMp4 = await getPatchMp4();
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
