# JV Studio — Cloudflare Worker

## How the patcher works
The worker fetches `patcher_bypass.js` from your GitHub repo at runtime.
To update the patcher: just push a new version to GitHub — no redeployment needed.

Patcher URL (set in worker.js line ~20):
https://raw.githubusercontent.com/gaynalgaynal0-afk/JV-Upload-method-bot/main/patcher_bypass.js

Change the URL if your repo/branch/path is different.

## Deploy via GitHub (no CLI needed)

1. Create a new GitHub repo: jv-studio-worker
2. Upload these files:
   - worker.js
   - wrangler.toml
   - patcher_bypass.js  ← put this here too so you can update it easily

3. Go to dash.cloudflare.com
   → Workers & Pages → Create → Import from Git
   → Connect GitHub → select jv-studio-worker

4. After deploy → Settings → Variables and Secrets → add:
   BOT_TOKEN              = your telegram bot token
   UPSTASH_REDIS_REST_URL = https://assuring-ray-176654.upstash.io
   UPSTASH_REDIS_REST_TOKEN = gQAAAAAAArIOAAIg...

## To update the patcher
Just push a new patcher_bypass.js to GitHub.
The worker picks it up within 5 minutes automatically (cache TTL).

## Endpoints
GET  /              → health check
GET  /tier/:uid     → free or premium
GET  /quota/:uid    → weekly upload count
POST /verify        → { uid } → { member, tier }
POST /patch         → multipart: video + uid → patched MP4
