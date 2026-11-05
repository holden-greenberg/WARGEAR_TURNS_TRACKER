/**
 * WarGear Turns Tracker - single Cloudflare Worker.
 *
 * On a 5-minute cron it polls the WarGear "my games" API for every configured
 * player, rebuilds the dashboard + turn-speed stats, and stashes everything in
 * one KV key. The fetch handler serves the static site (public/) plus
 * /data/dashboard.json and /data/turn_stats.json straight from that KV key.
 *
 * All persistent state lives in a single KV entry ("state") so a run that
 * changes nothing performs zero writes - that keeps us inside the KV free
 * tier's 1,000 writes/day.
 *
 * Bindings (see wrangler.jsonc):
 *   WG_STATE          KV namespace
 *   ASSETS            static assets (public/)
 *   CORE_PLAYERS      comma-separated WarGear names; a game must include at
 *                     least MIN_CORE_PLAYERS of them to be tracked
 *   MIN_CORE_PLAYERS  string int, default "2"
 *   PLAYERS_CONFIG    secret: JSON array of { "api_key": "..." }
 */

const GAME_LIST_URL = "https://www.wargear.net/rest/GetGameList/my";
const REQUEST_HEADERS = { "User-Agent": "Mozilla/5.0" };

// Tracker Era start: 2026-09-02 00:00:00 UTC. Finished games older than this
// are ignored so the dashboard only ever reflects the current era.
const TRACKER_ERA_START = Math.floor(Date.UTC(2026, 8, 2, 0, 0, 0) / 1000);

// Hard ceiling on WarGear page fetches per cron run. Steady-state runs use a
// handful; only a cold start (no cached page cursor) approaches this. If we hit
// it the run just saves what it has and the next tick continues - self-healing.
const MAX_PAGE_FETCHES = 45;

// --- WarGear API plumbing --------------------------------------------------

function newBudget() {
  return { used: 0, max: MAX_PAGE_FETCHES };
}

async function fetchPage(apiKey, viewType, page, budget) {
  if (budget.used >= budget.max) return null;
  budget.used += 1;
  try {
    const url = new URL(GAME_LIST_URL);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("viewselector", viewType);
    url.searchParams.set("pagenumber", String(page));
    url.searchParams.set("format", "json");
    const resp = await fetch(url, { headers: REQUEST_HEADERS });
    if (resp.status !== 200) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

// Past the last real page the API keeps re-returning the final page rather than
// an empty one, so "no more pages" is detected by a repeated signature.
function pageSignature(data) {
  return [data[0]?.gameid, data[data.length - 1]?.gameid, data.length].join("|");
}

async function fetchLiveGames(apiKey, budget) {
  const games = [];
  let prevSig = null;
  let page = 1;
  while (true) {
    const data = await fetchPage(apiKey, "Live", page, budget);
    if (!data) break;
    const sig = pageSignature(data);
    if (sig === prevSig) break;
    prevSig = sig;
    games.push(...data);
    page += 1;
  }
  return games;
}

// Cold-start only: locate the last real page without reading every page in
// between - jump forward in strides until the API repeats a page, then binary
// search the final stride window.
async function findLastPage(apiKey, viewType, budget, stride = 10) {
  let lastGoodPage = 1;
  let lastGoodData = await fetchPage(apiKey, viewType, 1, budget);
  if (!lastGoodData) return [null, null];

  let prevSig = pageSignature(lastGoodData);
  let page = 1 + stride;
  let overshootPage = null;

  while (true) {
    const data = await fetchPage(apiKey, viewType, page, budget);
    if (!data) {
      overshootPage = page;
      break;
    }
    const sig = pageSignature(data);
    if (sig === prevSig) {
      overshootPage = page;
      break;
    }
    prevSig = sig;
    lastGoodData = data;
    lastGoodPage = page;
    page += stride;
  }

  let low = lastGoodPage;
  let high = overshootPage;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const data = await fetchPage(apiKey, viewType, mid, budget);
    if (data && pageSignature(data) !== prevSig) {
      low = mid;
      lastGoodData = data;
    } else {
      high = mid;
    }
  }
  return [low, lastGoodData];
}

// Finished games come back oldest-first, so the era games sit at the very end
// of a long history. `hintPage` is last run's discovered last page: from it we
// only step forward the odd new page and walk backward until a page is entirely
// pre-era. With no hint we binary-search for the end once.
async function fetchFinishedSinceEra(apiKey, hintPage, budget) {
  let page;
  let data;

  if (hintPage && hintPage >= 1) {
    data = await fetchPage(apiKey, "Finished", hintPage, budget);
    if (data) {
      page = hintPage;
      let sig = pageSignature(data);
      while (true) {
        const next = await fetchPage(apiKey, "Finished", page + 1, budget);
        if (!next) break;
        const nextSig = pageSignature(next);
        if (nextSig === sig) break; // API repeating final page
        page += 1;
        data = next;
        sig = nextSig;
      }
    }
  }

  if (data === undefined || data === null) {
    const [lastPage, lastPageData] = await findLastPage(apiKey, "Finished", budget);
    if (lastPage === null) return { games: [], lastPage: hintPage || 1 };
    page = lastPage;
    data = lastPageData;
  }

  const games = [];
  let p = page;
  let pageData = data;
  while (p >= 1) {
    if (!pageData) pageData = await fetchPage(apiKey, "Finished", p, budget);
    if (!pageData) {
      if (budget.used >= budget.max) break;
      p -= 1;
      pageData = null;
      continue;
    }
    const pageMaxEnd = Math.max(
      ...pageData.map((g) => parseInt(g.endstamp || 0, 10) || 0)
    );
    games.push(...pageData);
    if (pageMaxEnd < TRACKER_ERA_START) break;
    p -= 1;
    pageData = null;
  }

  return { games, lastPage: page };
}

// WarGear returns 'winners' as a PHP-serialized array of player-id hashes
// (a:1:{i:0;s:32:"...";}) rather than JSON.
function parsePhpStringArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.startsWith("a:")) return [];
  return [...value.matchAll(/s:\d+:"([^"]*)"/g)].map((m) => m[1]);
}

function normalizeGame(game) {
  game.endstamp = parseInt(game.endstamp || 0, 10) || 0;
  // WarGear sends turnstamp as a numeric string; recordTurnHandoff needs a
  // real number or it bails and no turn-time stats are ever accumulated.
  game.turnstamp = parseInt(game.turnstamp || 0, 10) || 0;

  const idToName = {};
  if (game.players && typeof game.players === "object") {
    for (const p of Object.values(game.players)) {
      if (p && typeof p === "object" && p.id) idToName[p.id] = p.name;
    }
  }
  const winnerIds = parsePhpStringArray(game.winners);
  game.winners = winnerIds.map((wid) => idToName[wid] ?? wid);
  return game;
}

function countCorePlayers(game, coreSet) {
  if (!game.players || typeof game.players !== "object") return 0;
  let n = 0;
  for (const p of Object.values(game.players)) {
    if (p && typeof p === "object" && coreSet.has(p.name)) n += 1;
  }
  return n;
}

// --- turn diffing --------------------------------------------------------

// current_turn is a list that may hold nulls or player objects, not just names.
function normalizeTurnNames(raw) {
  if (!Array.isArray(raw)) return new Set();
  const names = new Set();
  for (const p of raw) {
    if (p == null) continue;
    names.add(typeof p === "object" ? p.name : p);
  }
  return names;
}

function recordTurnHandoff(gameId, oldGame, newGame, pending) {
  const oldNames = normalizeTurnNames(oldGame.current_turn);
  const newNames = normalizeTurnNames(newGame.current_turn);
  if (oldNames.size === 0 || setsEqual(oldNames, newNames)) return;

  const oldTs = oldGame.turnstamp;
  const newTs = newGame.turnstamp;
  if (typeof oldTs !== "number" || typeof newTs !== "number") return;
  const elapsed = newTs - oldTs;
  if (elapsed <= 0) return;

  const gamePending = (pending[gameId] ||= {});
  for (const name of oldNames) {
    if (newNames.has(name)) continue;
    const stats = (gamePending[name] ||= { turns: 0, total_seconds: 0 });
    stats.turns += 1;
    stats.total_seconds += elapsed;
  }
}

function finalizeTurnStatsIfFinished(gameId, game, turnStats, pending, finalized) {
  if (game.gamestatus !== "Finished" || finalized.has(gameId)) return;
  const staged = pending[gameId] || {};
  for (const [name, stats] of Object.entries(staged)) {
    const totals = (turnStats[name] ||= { turns: 0, total_seconds: 0 });
    totals.turns += stats.turns;
    totals.total_seconds += stats.total_seconds;
  }
  delete pending[gameId];
  finalized.add(gameId);
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// --- the sync -----------------------------------------------------------

const EMPTY_STATE = { games: [], turn_stats: {}, pending: {}, finalized: [], cursors: {}, sections: {} };

function parseJsonEnv(value, fallback) {
  try {
    const v = JSON.parse(value ?? "");
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

async function runSync(env, budget = newBudget()) {
  const { players, coreSet, minCore } = readConfig(env);

  const prev = { ...EMPTY_STATE, ...(await env.WG_STATE.get("state", "json")) };
  const prevSerialized = stableState(prev);

  const previousById = {};
  for (const g of prev.games) previousById[String(g.gameid)] = g;

  const turnStats = prev.turn_stats || {};
  const pending = prev.pending || {};
  const finalized = new Set(prev.finalized || []);
  const cursors = { ...(prev.cursors || {}) };

  const allGames = {};

  for (let i = 0; i < players.length; i += 1) {
    const apiKey = players[i]?.api_key;
    if (!apiKey) continue;

    const live = await fetchLiveGames(apiKey, budget);
    const r = await fetchFinishedSinceEra(apiKey, cursors[i], budget);
    const finishedGames = r.games;
    cursors[i] = r.lastPage;

    for (const rawGame of [...live, ...finishedGames]) {
      let game =
        rawGame &&
        typeof rawGame === "object" &&
        !Array.isArray(rawGame) &&
        "games" in rawGame &&
        !rawGame.gameid
          ? rawGame.games
          : rawGame;
      const gameId = String(game?.gameid ?? "");
      if (!gameId) continue;

      game = normalizeGame(game);

      if (game.gamestatus === "Finished" && game.endstamp < TRACKER_ERA_START) continue;
      if (countCorePlayers(game, coreSet) < minCore) continue;

      // The same game comes back once per tracked player in it, and WarGear can
      // keep a just-ended game in one player's "Live" list after it is already
      // in another's "Finished" list. Last write used to win, so whichever
      // player was polled last decided the status. A Finished copy now always
      // beats a live one.
      const seen = allGames[gameId];
      if (seen && seen.gamestatus === "Finished" && game.gamestatus !== "Finished") continue;

      const oldGame = previousById[gameId];
      if (oldGame) recordTurnHandoff(gameId, oldGame, game, pending);
      finalizeTurnStatsIfFinished(gameId, game, turnStats, pending, finalized);

      allGames[gameId] = game;
    }
  }

  // A finished game never changes, so once seen it stays in state even if this
  // run didn't fetch it (API error, page budget) or only saw a stale live copy. Ratings and stats would
  // otherwise swing whenever a poll came back partial. The era and core-player
  // checks still apply, so a CORE_PLAYERS edit takes effect on archived games.
  for (const g of prev.games) {
    const gameId = String(g.gameid);
    if (
      g.gamestatus === "Finished" &&
      allGames[gameId]?.gamestatus !== "Finished" &&
      g.endstamp >= TRACKER_ERA_START &&
      countCorePlayers(g, coreSet) >= minCore
    ) {
      allGames[gameId] = g;
    }
  }

  const next = {
    games: Object.values(allGames),
    turn_stats: turnStats,
    pending,
    finalized: [...finalized].sort(),
    cursors,
  };

  const now = Math.floor(Date.now() / 1000);
  const changed = stableState(next) !== prevSerialized;
  const sinceWrite = now - (prev.updated || 0);

  // Stamp each section whose rendered content actually changed this poll, so
  // every "Updated" label on the site reflects that section's own last change.
  // Computed up front (cheap, no write) so it's available even on a throttled
  // run's eventual write, once the skipped diff folds into the next one.
  const prevSections = prev.sections || {};
  const newSigs = sectionSignatures(next);
  next.sections = {};
  for (const key of Object.keys(newSigs)) {
    const p = prevSections[key];
    next.sections[key] = p && p.sig === newSigs[key] ? p : { sig: newSigs[key], at: now };
  }
  const changedSections = Object.keys(next.sections).filter((k) => next.sections[k].at === now);

  // When nothing changed, still refresh the heartbeat every cron tick (~5 min) so the
  // last successful poll stays visible (and provably live) without exhausting
  // the KV free-tier write budget.
  if (!changed && sinceWrite < 240) {
    return { changed: false, games: next.games.length };
  }

  // Even when something changed, never write more than once every 2 minutes.
  // With a 5-minute cron this is a safety net at most 288 writes/day,
  // far under the KV free tier's 1,000. Turn timing itself comes from WarGear's own
  // `turnstamp`, not our poll cadence, so throttling writes loses no
  // accuracy: the skipped run's diff just gets folded into the next write.
  if (changed && sinceWrite < 120) {
    return { changed, games: next.games.length, throttled: true };
  }

  next.updated = now;
  next.last_poll = now;
  await env.WG_STATE.put("state", JSON.stringify(next));
  return { changed, sections: changedSections, games: next.games.length };
}

// Fields on a live game that move on their own every poll (the boot-timer
// countdown). They are still stored and served - the frontend also derives the
// countdown from turnstamp + boot_time - but excluding them from the diff means
// a steady-state minute with no real change writes nothing.
const VOLATILE_GAME_FIELDS = ["time_remaining", "time_remaining_words", "boot_words"];

function gameForDiff(g) {
  const c = { ...g };
  for (const f of VOLATILE_GAME_FIELDS) delete c[f];
  return c;
}

// Serialize the parts of state we diff on (everything except the `updated`
// timestamp and per-poll volatile fields) so an unchanged poll writes nothing.
// Games are sorted by id so a reordered fetch is not mistaken for a change.
function stableState(s) {
  return JSON.stringify({
    games: (s.games || [])
      .map(gameForDiff)
      .sort((a, b) => String(a.gameid).localeCompare(String(b.gameid))),
    turn_stats: s.turn_stats || {},
    pending: s.pending || {},
    finalized: (s.finalized || []).slice().sort(),
    cursors: s.cursors || {},
  });
}

// A signature per site section: a stable string of exactly the data that
// section renders. When it changes between polls we restamp that section's
// `changed_at`. Keys map to the site's headers:
//   clock     - On The Clock (who is up, in which live game, since when)
//   live      - Live Games grid (full live rosters / status / timeline)
//   finished  - Archive, and the bulk of Player Stats
//   turnstats - the "Avg Turn Time" column
function sectionSignatures(s) {
  const games = (s.games || [])
    .slice()
    .sort((a, b) => String(a.gameid).localeCompare(String(b.gameid)));
  const live = games.filter((g) => g.gamestatus !== "Finished");
  const finished = games.filter((g) => g.gamestatus === "Finished");
  return {
    clock: JSON.stringify(
      live.map((g) => [g.gameid, [...normalizeTurnNames(g.current_turn)].sort(), g.turnstamp])
    ),
    live: JSON.stringify(live.map(gameForDiff)),
    finished: JSON.stringify(finished.map(gameForDiff)),
    turnstats: JSON.stringify(s.turn_stats || {}),
  };
}

// --- historical backfill ---------------------------------------------------
//
// Pre-Tracker-Era finished games, for the site's "All time" stats toggle. A
// one-off, resumable scan: each run reads a few more of every configured
// player's Finished pages (oldest first) and keeps the pre-era games that pass
// the same core-player check as the live tracker. Players share most games,
// so games are deduplicated by gameid across everyone's history.
//
// Storage is kept apart from "state" so the 5-minute sync never has to parse
// or diff it:
//   history_meta      small: per-player cursor + every stored gameid
//   history_chunk_<n> a JSON array of the slim games one run found; append-only
// /data/history.json concatenates the chunks without parsing them.
// Delete history_meta to start the backfill over.

const HISTORY_META_KEY = "history_meta";
const HISTORY_CHUNK_PREFIX = "history_chunk_";
// Kept low so the extra JSON parsing stays inside the Workers Free CPU limit.
const BACKFILL_PAGES_PER_RUN = 10;
// A page that fails this many runs in a row (no repeat page seen) is treated
// as the end of that player's history.
const BACKFILL_MAX_FAILS = 3;

async function playerKeyId(apiKey) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Only what the stats table needs; old games are never shown as live cards.
function slimHistoricGame(g) {
  const players = {};
  for (const [k, p] of Object.entries(g.players || {})) {
    if (!p || typeof p !== "object" || !p.name) continue;
    players[k] = {
      name: p.name,
      seat: p.seat,
      status: p.status,
      eliminated_by: p.eliminated_by,
      turn_counter: p.turn_counter,
      color_code: p.color_code,
    };
  }
  return {
    gameid: g.gameid,
    name: g.name,
    gamestatus: g.gamestatus,
    teamplay: g.teamplay,
    boardname: g.boardname,
    startstamp: g.startstamp,
    createstamp: g.createstamp,
    endstamp: g.endstamp,
    winners: g.winners,
    players,
  };
}

function readConfig(env) {
  const players = parseJsonEnv(env.PLAYERS_CONFIG, []);
  const coreSet = new Set(
    (env.CORE_PLAYERS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const minCore = parseInt(env.MIN_CORE_PLAYERS || "2", 10) || 2;
  return { players, coreSet, minCore };
}

async function runBackfill(env, budget) {
  const { players, coreSet, minCore } = readConfig(env);
  const meta = (await env.WG_STATE.get(HISTORY_META_KEY, "json")) || {};
  meta.players ||= {};
  meta.game_ids ||= [];
  meta.chunks ||= 0;

  const keys = [];
  for (const p of players) if (p?.api_key) keys.push({ apiKey: p.api_key, id: await playerKeyId(p.api_key) });
  const todo = keys.filter((k) => !meta.players[k.id]?.done);
  if (todo.length === 0) {
    return { done: true, games: meta.game_ids.length };
  }

  const pageCap = Math.min(budget.max, budget.used + BACKFILL_PAGES_PER_RUN);
  const local = { used: budget.used, max: pageCap };
  const seen = new Set(meta.game_ids);
  const found = [];
  let pagesRead = 0;

  for (const { apiKey, id } of todo) {
    const cur = (meta.players[id] ||= { next_page: 1, last_sig: null, fails: 0, done: false });
    while (local.used < local.max) {
      const before = local.used;
      const data = await fetchPage(apiKey, "Finished", cur.next_page, local);
      if (!data) {
        if (local.used === before) break; // budget spent before the fetch: not a failure
        cur.fails += 1;
        if (cur.fails >= BACKFILL_MAX_FAILS) cur.done = true;
        break;
      }
      pagesRead += 1;
      cur.fails = 0;
      const sig = pageSignature(data);
      if (sig === cur.last_sig) {
        // Past the last page the API repeats the final one.
        cur.done = true;
        break;
      }
      for (const raw of data) {
        const g0 = raw && typeof raw === "object" && "games" in raw && !raw.gameid ? raw.games : raw;
        const gameId = String(g0?.gameid ?? "");
        if (!gameId || seen.has(gameId)) continue;
        const game = normalizeGame(g0);
        if (game.gamestatus !== "Finished") continue;
        if (!game.endstamp || game.endstamp >= TRACKER_ERA_START) continue;
        if (countCorePlayers(game, coreSet) < minCore) continue;
        seen.add(gameId);
        found.push(slimHistoricGame(game));
      }
      cur.last_sig = sig;
      cur.next_page += 1;
    }
    if (local.used >= local.max) break;
  }
  budget.used = local.used;

  if (found.length) {
    await env.WG_STATE.put(HISTORY_CHUNK_PREFIX + meta.chunks, JSON.stringify(found));
    meta.chunks += 1;
    meta.game_ids = [...seen];
  }
  meta.updated = Math.floor(Date.now() / 1000);
  const done = keys.every((k) => meta.players[k.id]?.done);
  meta.done = done;
  await env.WG_STATE.put(HISTORY_META_KEY, JSON.stringify(meta));
  return { done, pages: pagesRead, new_games: found.length, games: meta.game_ids.length };
}

async function handleHistoryRoute(env) {
  const meta = (await env.WG_STATE.get(HISTORY_META_KEY, "json")) || {};
  const n = meta.chunks || 0;
  const chunks = await Promise.all(
    Array.from({ length: n }, (_, i) => env.WG_STATE.get(HISTORY_CHUNK_PREFIX + i))
  );
  // Each chunk is a JSON array; splice them together without parsing.
  const inner = chunks
    .filter((c) => c && c.length > 2)
    .map((c) => c.slice(1, -1))
    .join(",");
  const body = `{"complete":${meta.done ? "true" : "false"},"updated":${meta.updated || 0},"games":[${inner}]}`;
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": meta.done ? "public, max-age=3600, s-maxage=3600" : "public, max-age=60, s-maxage=120",
    },
  });
}

// --- HTTP -------------------------------------------------------------

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      // Let the edge serve repeat visitors for 2 min; the cron runs every 5 min.
      "Cache-Control": "public, max-age=60, s-maxage=120",
    },
  });
}

async function handleDataRoute(pathname, env) {
  const state = (await env.WG_STATE.get("state", "json")) || { ...EMPTY_STATE, updated: 0 };
  const sections = state.sections || {};
  const at = (k) => (sections[k] && sections[k].at) || state.updated || 0;
  // Per-section change times, plus a liveness pulse the frontend uses to warn
  // when the poller itself looks stuck.
  const meta = {
    last_updated: state.updated || 0,
    last_poll: state.last_poll || state.updated || 0,
    section_updated: {
      clock: at("clock"),
      live: at("live"),
      finished: at("finished"),
      turnstats: at("turnstats"),
    },
  };

  if (pathname === "/data/dashboard.json") {
    return jsonResponse({
      ...meta,
      total_games: (state.games || []).length,
      games: state.games || [],
    });
  }
  if (pathname === "/data/turn_stats.json") {
    return jsonResponse({
      ...meta,
      players: state.turn_stats || {},
      pending: state.pending || {},
      finalized_games: state.finalized || [],
    });
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/data/history.json") {
      return handleHistoryRoute(env);
    }

    if (url.pathname.startsWith("/data/")) {
      const res = await handleDataRoute(url.pathname, env);
      if (res) return res;
      return new Response("Not found", { status: 404 });
    }

    // Manual trigger for debugging (no auth - it only re-polls a public game
    // list and writes to our own KV).
    if (url.pathname === "/__resync") {
      const result = await runSync(env);
      return jsonResponse(result);
    }

    // Manual backfill step (same no-auth reasoning as /__resync). Each call
    // reads up to BACKFILL_PAGES_PER_RUN more pages; the cron also runs it.
    if (url.pathname === "/__backfill") {
      const result = await runBackfill(env, newBudget());
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    // Sync first; the backfill only gets whatever page budget is left, and a
    // backfill failure can never affect the live dashboard.
    const budget = newBudget();
    ctx.waitUntil(
      (async () => {
        try {
          console.log(`sync ok: ${JSON.stringify(await runSync(env, budget))}`);
        } catch (e) {
          console.log(`sync failed: ${e && e.stack ? e.stack : e}`);
        }
        try {
          const r = await runBackfill(env, budget);
          if (!r.done || r.pages) console.log(`backfill: ${JSON.stringify(r)}`);
        } catch (e) {
          console.log(`backfill failed: ${e && e.stack ? e.stack : e}`);
        }
      })()
    );
  },
};
