// ── Upstash Redis — upload quota tracker ──────────────────────────
// Free users:    3 uploads per 7 days
// Premium users: unlimited
//
// Each UID gets a Redis key: "uploads:{uid}"
// Value: JSON array of timestamps (ms) of successful uploads
// TTL:   8 days (auto-cleanup, slightly longer than the window)

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || "https://assuring-ray-176654.upstash.io";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "gQAAAAAAArIOAAIgcDEzM2VjMmU2Mjk2NGY0MjEyODY5NjJiOWYwMDgzNWMxNQ";

const WEEK_MS       = 7 * 24 * 60 * 60 * 1000;   // 7 days in ms
const TTL_SECONDS   = 8 * 24 * 60 * 60;           // 8 days TTL on the key
const FREE_LIMIT    = 3;
const PREMIUM_LIMIT = 5;

// ── Raw Redis REST call ────────────────────────────────────────────
async function redis(...args) {
  const res = await fetch(`${UPSTASH_URL}/${args.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(`Redis error: ${data.error}`);
  return data.result;
}

// ── Get upload info for a UID ──────────────────────────────────────
// Returns: { allowed, used, limit, remaining, resets_at }
async function getUploadInfo(uid, tier) {
  const isPremium = tier === "premium";
  const LIMIT     = isPremium ? PREMIUM_LIMIT : FREE_LIMIT;

  const key = `uploads:${uid}`;
  const raw = await redis("GET", key);

  const now        = Date.now();
  const weekAgo    = now - WEEK_MS;
  const timestamps = raw ? JSON.parse(raw).filter(t => t > weekAgo) : [];
  const used       = timestamps.length;
  const remaining  = Math.max(0, LIMIT - used);
  const allowed    = used < LIMIT;

  // resets_at = when the oldest upload in the window falls out
  const resets_at = timestamps.length > 0
    ? timestamps[0] + WEEK_MS
    : null;

  return { allowed, used, limit: LIMIT, remaining, resets_at, tier: isPremium ? "premium" : "free" };
}

// ── Record a successful upload ─────────────────────────────────────
async function recordUpload(uid) {
  const key = `uploads:${uid}`;
  const raw = await redis("GET", key);

  const now        = Date.now();
  const weekAgo    = now - WEEK_MS;
  const timestamps = raw ? JSON.parse(raw).filter(t => t > weekAgo) : [];

  timestamps.push(now);

  // Save back with 8-day TTL so Redis auto-cleans old keys
  await redis("SET", key, JSON.stringify(timestamps), "EX", String(TTL_SECONDS));

  console.log(`[quota] UID=${uid} used=${timestamps.length} this week`);
}

module.exports = { getUploadInfo, recordUpload };
