# WarGear Turns Tracker

One Cloudflare Worker does everything:

- **`scheduled()`** runs every minute (`triggers.crons` in `wrangler.jsonc`): polls the
  WarGear "my games" API for each configured player, rebuilds the dashboard and
  turn-speed stats, and fires "it's your turn" pushes via [ntfy](https://ntfy.sh).
- **`fetch()`** serves the static site from `public/` and answers
  `/data/dashboard.json` and `/data/turn_stats.json` from KV.

All state lives in a single KV key (`state`). A poll that changes nothing writes
nothing, so we stay inside the KV free tier (1,000 writes/day).

```
wrangler.jsonc      config: cron, KV binding, static assets, vars
worker/index.js     the Worker (sync + HTTP)
public/index.html   the dashboard frontend
```

## First-time deploy

Requires a Cloudflare account and Node. From the repo root:

```bash
npm install

# 1. Log in
npx wrangler login

# 2. Create the KV namespace, then paste the printed id into
#    wrangler.jsonc -> kv_namespaces[0].id
npx wrangler kv namespace create WG_STATE

# 3. Set the two secrets (values are NOT stored in the repo)
#    PLAYERS_CONFIG - JSON array of WarGear api keys:
#      [{"api_key":"...player one..."},{"api_key":"...player two..."}]
npx wrangler secret put PLAYERS_CONFIG
#    NOTIFY_TOPICS - JSON map of WarGear name -> ntfy topic (optional; omit to
#    disable pushes). Each friend subscribes to their own topic in the ntfy app.
#      {"HoldenGreenberg":"wg-turn-holden-9f3k2x"}
npx wrangler secret put NOTIFY_TOPICS

# 4. Deploy
npx wrangler deploy

# 5. Populate KV immediately instead of waiting for the first cron tick
curl -s https://wargear-turns-tracker.<your-subdomain>.workers.dev/__resync
```

The site is then live at
`https://wargear-turns-tracker.<your-subdomain>.workers.dev`.

## Day-to-day

| Task | Command |
| --- | --- |
| Watch live logs | `npx wrangler tail` |
| Force a poll now | `curl .../__resync` |
| Change tracked players | edit `CORE_PLAYERS` in `wrangler.jsonc`, redeploy |
| Rotate an API key | `npx wrangler secret put PLAYERS_CONFIG`, redeploy not needed |
| Inspect state | `npx wrangler kv key get --binding WG_STATE state` |
| Ship a frontend change | edit `public/index.html`, `npx wrangler deploy` |

## Notes

- **Cron cadence.** Cloudflare cron triggers fire on time, unlike GitHub Actions
  schedules. One minute is the minimum interval.
- **Request budget.** A run is capped at `MAX_PAGE_FETCHES` (45) WarGear page
  fetches to stay under the Workers Free 50-subrequest limit. Steady-state runs
  use a handful; the per-player "last finished page" cursor in `state.cursors`
  means only a cold start (empty KV) does the expensive history scan. If a cold
  start ever hits the cap it just resumes on the next tick.
- **Tracker Era.** Finished games before 2026-09-02 00:00 UTC are ignored
  (`TRACKER_ERA_START` in `worker/index.js`).
