// ── JV Studio Server — Railway Edition ───────────────────────────────────────
// No ffmpeg — pure JS patcher only
// Routes:
//   GET  /              → health check
//   GET  /tier/:uid     → get tier info
//   GET  /quota/:uid    → get upload quota
//   POST /verify        → check Telegram channel membership
//   POST /patch         → patch MP4 (multipart: video + uid)

const express    = require('express');
const multer     = require('multer');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const { getUploadInfo, recordUpload } = require('./upstash');
const { patchMp4 } = require('./patcher_bypass');

const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHANNEL    = '@jv_60fps';
const PORT       = process.env.PORT || 5000;
const TMP_DIR    = '/tmp';

// ── Tier config ───────────────────────────────────────────────────────────────
const FREE_LIMIT_MB    = 70;
const PREMIUM_LIMIT_MB = 120;

function getPremiumUids() {
  try {
    // Load from file so you can update without redeploying
    return require('./premium-check.js').map(String);
  } catch { return []; }
}

function getTier(uid) {
  const isPremium = !!uid && getPremiumUids().includes(String(uid));
  return {
    tier:       isPremium ? 'premium' : 'free',
    limitBytes: (isPremium ? PREMIUM_LIMIT_MB : FREE_LIMIT_MB) * 1024 * 1024,
    limitMB:    isPremium ? PREMIUM_LIMIT_MB : FREE_LIMIT_MB,
  };
}

// ── Telegram membership check ─────────────────────────────────────────────────
async function checkMembership(uid) {
  if (!BOT_TOKEN) return { ok: false, error: 'BOT_TOKEN not set' };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(CHANNEL)}&user_id=${uid}`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    if (!d.ok) return { ok: false, error: d.description };
    const status = d.result && d.result.status;
    return { ok: true, member: ['member','administrator','creator'].includes(status), status };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// ── Cleanup /tmp ──────────────────────────────────────────────────────────────
function safeDelete(filePath) {
  if (!filePath) return;
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(TMP_DIR).forEach(f => {
      if (!/^jv_/.test(f)) return;
      const full = path.join(TMP_DIR, f);
      try {
        if (now - fs.statSync(full).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(full);
      } catch {}
    });
  } catch {}
}, 10 * 60 * 1000);

// ── Express setup ─────────────────────────────────────────────────────────────
const app    = express();
const upload = multer({ dest: TMP_DIR, limits: { fileSize: PREMIUM_LIMIT_MB * 1024 * 1024 + 5 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'JV Studio Server', version: '2.0' });
});

app.get('/tier/:uid', (req, res) => {
  const { tier, limitMB } = getTier(req.params.uid);
  res.json({ tier, limit_mb: limitMB });
});

app.get('/quota/:uid', async (req, res) => {
  const uid      = req.params.uid;
  const { tier } = getTier(uid);
  const info     = await getUploadInfo(uid, tier);
  res.json({ ...info, tier });
});

app.post('/verify', async (req, res) => {
  const uid = String(req.body && req.body.uid || '').trim();
  if (!uid || !/^\d{5,15}$/.test(uid)) return res.status(400).json({ error: 'Invalid UID' });

  const result = await checkMembership(uid);
  if (!result.ok) return res.status(500).json({ error: result.error });

  const { tier } = getTier(uid);
  res.json({ member: result.member, status: result.status, tier });
});

app.post('/patch', upload.single('video'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No video file provided' });

  const uid                        = String(req.body && req.body.uid || '').trim();
  const { tier, limitBytes, limitMB } = getTier(uid);
  const inputPath                  = file.path;
  let   outputPath                 = null;
  let   cleaned                    = false;

  function cleanup() {
    if (cleaned) return; cleaned = true;
    safeDelete(inputPath);
    if (outputPath) safeDelete(outputPath);
  }
  res.on('close', cleanup);

  // Size check
  if (file.size > limitBytes) {
    cleanup();
    return res.status(413).json({
      error:    `File exceeds ${limitMB}MB limit for ${tier} users`,
      tier, limit_mb: limitMB,
      file_mb:  +(file.size / 1024 / 1024).toFixed(1),
    });
  }

  // Quota check
  if (uid) {
    const quota = await getUploadInfo(uid, tier);
    if (!quota.allowed) {
      cleanup();
      return res.status(429).json({
        error:     `Weekly limit reached (${quota.limit} uploads/week)`,
        tier, used: quota.used, limit: quota.limit, remaining: 0,
        resets_at: quota.resets_at,
      });
    }
  }

  // Patch
  try {
    const inputBuf = fs.readFileSync(inputPath).buffer;
    const patched  = patchMp4(inputBuf);

    const fileId = crypto.randomBytes(8).toString('hex');
    outputPath   = path.join(TMP_DIR, `jv_${fileId}.mp4`);
    fs.writeFileSync(outputPath, patched);

    safeDelete(inputPath);

    // Record upload
    if (uid) {
      try { await recordUpload(uid); } catch(e) { console.warn('quota record failed:', e.message); }
    }

    // Build response headers
    const headers = {
      'Content-Type':        'video/mp4',
      'Content-Disposition': `attachment; filename="jv_${fileId}.mp4"`,
      'X-Tier':              tier,
      'X-Limit-MB':          String(limitMB),
    };

    if (uid) {
      try {
        const q = await getUploadInfo(uid, tier);
        headers['X-Uploads-Used']      = String(q.used);
        headers['X-Uploads-Limit']     = String(q.limit);
        headers['X-Uploads-Remaining'] = String(q.remaining);
        if (q.resets_at) headers['X-Uploads-Resets-At'] = String(q.resets_at);
      } catch {}
    }

    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));

    const stream = fs.createReadStream(outputPath);
    stream.on('end', cleanup);
    stream.on('error', (e) => { console.error('Stream error:', e.message); cleanup(); });
    stream.pipe(res);

  } catch(err) {
    cleanup();
    return res.status(422).json({ error: `Patch failed: ${err.message}` });
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: `File too large (max ${PREMIUM_LIMIT_MB}MB)` });
  if (err) return res.status(500).json({ error: err.message });
  next();
});

app.listen(PORT, '0.0.0.0', () => console.log(`[server] Listening on port ${PORT}`));
