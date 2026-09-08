/**
 * WarGear Turns Tracker - single Cloudflare Worker.
 *
 * On a 1-minute cron it polls the WarGear "my games" API for every configured
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

const EMPTY_STATE = { games: [], turn_stats: {}, pending: {}, finalized: [], cursors: {} };

function parseJsonEnv(value, fallback) {
  try {
    const v = JSON.parse(value ?? "");
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

async function runSync(env) {
  const players = parseJsonEnv(env.PLAYERS_CONFIG, []);
  const coreSet = new Set(
    (env.CORE_PLAYERS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const minCore = parseInt(env.MIN_CORE_PLAYERS || "2", 10) || 2;

  const prev = { ...EMPTY_STATE, ...(await env.WG_STATE.get("state", "json")) };
  const prevSerialized = stableState(prev);

  const previousById = {};
  for (const g of prev.games) previousById[String(g.gameid)] = g;

  const turnStats = prev.turn_stats || {};
  const pending = prev.pending || {};
  const finalized = new Set(prev.finalized || []);
  const cursors = { ...(prev.cursors || {}) };

  const budget = newBudget();
  const allGames = {};

  for (let i = 0; i < players.length; i += 1) {
    const apiKey = players[i]?.api_key;
    if (!apiKey) continue;

    const live = await fetchLiveGames(apiKey, budget);
    const { games: finishedGames, lastPage } = await fetchFinishedSinceEra(
      apiKey,
      cursors[i],
      budget
    );
    cursors[i] = lastPage;

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

      const oldGame = previousById[gameId];
      if (oldGame) recordTurnHandoff(gameId, oldGame, game, pending);
      finalizeTurnStatsIfFinished(gameId, game, turnStats, pending, finalized);

      allGames[gameId] = game;
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

  // When nothing changed, still refresh the heartbeat every 5 minutes so the
  // last successful poll stays visible (and provably live) without exhausting
  // the KV free-tier write budget.
  if (!changed && now - (prev.updated || 0) < 300) {
    return { changed: false, games: next.games.length };
  }

  next.updated = now;
  await env.WG_STATE.put("state", JSON.stringify(next));
  return { changed, games: next.games.length };
}

// Serialize the parts of state we diff on (everything except the `updated`
// timestamp) so an unchanged poll writes nothing.
function stableState(s) {
  return JSON.stringify({
    games: s.games || [],
    turn_stats: s.turn_stats || {},
    pending: s.pending || {},
    finalized: (s.finalized || []).slice().sort(),
    cursors: s.cursors || {},
  });
}

// --- HTTP -------------------------------------------------------------

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      // Let the edge serve repeat visitors for 30s; the cron runs every 60s.
      "Cache-Control": "public, max-age=15, s-maxage=30",
    },
  });
}

async function handleDataRoute(pathname, env) {
  const state = (await env.WG_STATE.get("state", "json")) || { ...EMPTY_STATE, updated: 0 };
  const lastUpdated = state.updated || 0;

  if (pathname === "/data/dashboard.json") {
    return jsonResponse({
      last_updated: lastUpdated,
      total_games: (state.games || []).length,
      games: state.games || [],
    });
  }
  if (pathname === "/data/turn_stats.json") {
    return jsonResponse({
      last_updated: lastUpdated,
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

    if (url.pathname.startsWith("/data/")) {
      const res = await handleDataRoute(url.pathname, env);
      if (res) return res;
      return new Response("Not found", { status: 404 });
    }

    // Manual trigger for debugging: /__resync (no auth - it only re-polls a
    // public game list and writes to our own KV).
    if (url.pathname === "/__resync") {
      const result = await runSync(env);
      return jsonResponse(result);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runSync(env).then(
        (r) => console.log(`sync ok: ${JSON.stringify(r)}`),
        (e) => console.log(`sync failed: ${e && e.stack ? e.stack : e}`)
      )
    );
  },
};
