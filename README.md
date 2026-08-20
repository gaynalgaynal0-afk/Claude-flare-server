# JV Studio — Cloudflare Worker

## Deploy steps

1. Install wrangler:
   npm install -g wrangler

2. Login:
   wrangler login

3. Set your secrets (do NOT put these in wrangler.toml):
   wrangler secret put BOT_TOKEN
   → paste: 8798228886:AAGymdC7v0idzMt5_CKoqv5pCcDMhZ20KmI

   wrangler secret put UPSTASH_REDIS_REST_URL
   → paste: https://assuring-ray-176654.upstash.io

   wrangler secret put UPSTASH_REDIS_REST_TOKEN
   → paste: gQAAAAAAArIOAAIgcDEzM2VjMmU2Mjk2NGY0MjEyODY5NjJiOWYwMDgzNWMxNQ

4. Deploy:
   wrangler deploy

Your worker will be live at:
https://jv-studio-server.<your-subdomain>.workers.dev

## Endpoints

GET  /                → health check
GET  /tier/:uid       → get user tier (free/premium)
GET  /quota/:uid      → get weekly upload quota
POST /verify          → { uid } → { member, tier }
POST /patch           → multipart: video + uid → patched MP4

## Notes
- No ffmpeg needed — pure JS MP4 patcher
- Cloudflare free plan: 100k requests/day, 10ms CPU limit
  (patching large files may hit CPU limit — use paid plan for production)
- Premium UIDs are hardcoded in worker.js PREMIUM_UIDS set
