import os
import json
import re
import time
from datetime import datetime
import requests

PLAYERS_CONFIG_RAW = os.environ.get("PLAYERS_CONFIG", "[]")

try:
    players = json.loads(PLAYERS_CONFIG_RAW)
except Exception:
    players = []

DASHBOARD_FILE = "data/dashboard.json"
TURN_STATS_FILE = "data/turn_stats.json"
os.makedirs("data", exist_ok=True)

# Load the previous snapshot (if any) so we can detect turn handoffs between
# runs and accumulate real elapsed-time-per-turn stats over time - a single
# snapshot has no history, but diffing consecutive snapshots does.
try:
    with open(DASHBOARD_FILE) as f:
        previous_games_by_id = {g["gameid"]: g for g in json.load(f).get("games", [])}
except Exception:
    previous_games_by_id = {}

try:
    with open(TURN_STATS_FILE) as f:
        _turn_stats_saved = json.load(f)
except Exception:
    _turn_stats_saved = {}

# turn_stats only reflects Tracker Era *finished* games, matching every other
# player stat - so turn times are held in `pending` per game-in-progress and
# only folded into `players` once that game's gamestatus flips to Finished.
turn_stats = _turn_stats_saved.get("players", {})
pending_turn_stats = _turn_stats_saved.get("pending", {})
finalized_games = set(_turn_stats_saved.get("finalized_games", []))


def normalize_turn_names(raw):
    """current_turn is a list that may contain None placeholders or player
    objects instead of plain name strings, depending on game state."""
    if not isinstance(raw, list):
        return set()
    names = set()
    for p in raw:
        if p is None:
            continue
        names.add(p.get("name") if isinstance(p, dict) else p)
    return names


def record_turn_handoff(game_id, old_game, new_game):
    """When the set of players on-turn changes between two snapshots, credit
    the elapsed time (new turnstamp - old turnstamp) to whoever just
    finished their turn, staged under this game until it finishes. turnstamp
    only moves on a real turn change (not on every poll), so this stays
    accurate regardless of how often we poll."""
    old_names = normalize_turn_names(old_game.get("current_turn"))
    new_names = normalize_turn_names(new_game.get("current_turn"))
    if not old_names or old_names == new_names:
        return

    old_ts = old_game.get("turnstamp")
    new_ts = new_game.get("turnstamp")
    if not isinstance(old_ts, (int, float)) or not isinstance(new_ts, (int, float)):
        return
    elapsed = new_ts - old_ts
    if elapsed <= 0:
        return

    game_pending = pending_turn_stats.setdefault(game_id, {})
    for name in old_names - new_names:
        stats = game_pending.setdefault(name, {"turns": 0, "total_seconds": 0})
        stats["turns"] += 1
        stats["total_seconds"] += elapsed


def finalize_turn_stats_if_finished(game_id, game):
    """Fold a game's staged turn times into the permanent per-player totals
    the first time we see it as Finished."""
    if game.get("gamestatus") != "Finished" or game_id in finalized_games:
        return
    for name, stats in pending_turn_stats.pop(game_id, {}).items():
        totals = turn_stats.setdefault(name, {"turns": 0, "total_seconds": 0})
        totals["turns"] += stats["turns"]
        totals["total_seconds"] += stats["total_seconds"]
    finalized_games.add(game_id)

# Only games with at least this many of the core group members are counted -
# keeps out games friends started with people outside the group. Names are
# read from core_players.txt (one per line) so the group can be updated
# without touching code.
CORE_PLAYERS_FILE = "core_players.txt"
MIN_CORE_PLAYERS = 2

with open(CORE_PLAYERS_FILE) as f:
    CORE_GROUP = {line.strip() for line in f if line.strip()}


def count_core_players(game):
    players = game.get("players")
    if not isinstance(players, dict):
        return 0
    names = {p.get("name") for p in players.values() if isinstance(p, dict)}
    return len(names & CORE_GROUP)

# Tracker Era start: September 2, 2026, 00:00:00 UTC
TRACKER_ERA_START = int(datetime(2026, 9, 2, 0, 0, 0).timestamp())

GAME_LIST_URL = "https://www.wargear.net/rest/GetGameList/my"
HEADERS = {'User-Agent': 'Mozilla/5.0'}

all_games = {}


def parse_php_string_array(value):
    """WarGear returns fields like 'winners' as a PHP-serialized array of
    player id strings (e.g. a:1:{i:0;s:32:"...";}) instead of JSON."""
    if isinstance(value, list):
        return value
    if not isinstance(value, str) or not value.startswith("a:"):
        return []
    return re.findall(r's:\d+:"([^"]*)"', value)


def fetch_page(api_key, view_type, page):
    """Fetch one page of games, or None on any error/empty response."""
    try:
        resp = requests.get(
            GAME_LIST_URL,
            params={"api_key": api_key, "viewselector": view_type, "pagenumber": page, "format": "json"},
            headers=HEADERS,
            timeout=20
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        if not data or not isinstance(data, list):
            return None
        return data
    except Exception:
        return None


def page_signature(data):
    """Identifies a page's content cheaply. Past the last real page, the API
    just keeps re-returning the last page instead of an empty one, so we
    detect 'no more pages' by comparing signatures rather than page length."""
    return (data[0].get("gameid"), data[-1].get("gameid"), len(data))


def normalize_game(game):
    """Coerce API quirks: endstamp arrives as a string, and winners arrives
    as a PHP-serialized array of player-id hashes instead of a JSON array
    of names."""
    game["endstamp"] = int(game.get("endstamp", 0) or 0)

    player_id_to_name = {}
    if isinstance(game.get("players"), dict):
        for p in game["players"].values():
            if isinstance(p, dict) and p.get("id"):
                player_id_to_name[p["id"]] = p.get("name")

    winner_ids = parse_php_string_array(game.get("winners"))
    game["winners"] = [player_id_to_name.get(wid, wid) for wid in winner_ids]
    return game


def fetch_live_games(api_key):
    """Live game lists are small - walk pages sequentially until the API
    starts repeating the last page (or returns nothing)."""
    games = []
    prev_sig = None
    page = 1
    while True:
        data = fetch_page(api_key, "Live", page)
        if not data:
            break
        sig = page_signature(data)
        if sig == prev_sig:
            break
        prev_sig = sig
        games.extend(data)
        page += 1
    return games


def find_last_page(api_key, view_type, stride=10):
    """Locate the last real page of results without reading every page in
    between. Jumps forward in strides until the API starts repeating a page
    (proof we've overshot the end), then binary-searches the stride window
    to pin down the exact last page."""
    last_good_page = 1
    last_good_data = fetch_page(api_key, view_type, 1)
    if not last_good_data:
        return None, None

    prev_sig = page_signature(last_good_data)
    page = 1 + stride
    overshoot_page = None

    while True:
        data = fetch_page(api_key, view_type, page)
        if not data:
            overshoot_page = page
            break
        sig = page_signature(data)
        if sig == prev_sig:
            # page and (page - stride) are identical -> we've passed the end
            overshoot_page = page
            break
        prev_sig = sig
        last_good_data = data
        last_good_page = page
        page += stride

    # Binary-search between the last confirmed real page and the overshoot
    # page for the exact boundary.
    low, high = last_good_page, overshoot_page
    while high - low > 1:
        mid = (low + high) // 2
        data = fetch_page(api_key, view_type, mid)
        if data and page_signature(data) != prev_sig:
            low = mid
            last_good_data = data
        else:
            high = mid

    return low, last_good_data


def fetch_finished_games_since_era(api_key):
    """Finished games are returned oldest-first, so the games we actually
    care about (Tracker Era onward) sit at the very end of a potentially
    long history. Jump straight to the last page, then walk backward one
    page at a time, stopping as soon as a page is entirely older than the
    Tracker Era start - no need to read the full history every run."""
    last_page, last_page_data = find_last_page(api_key, "Finished")
    if last_page is None:
        return []

    games = []
    page = last_page
    page_data = last_page_data
    while page >= 1:
        if page_data is None:
            page_data = fetch_page(api_key, "Finished", page)
        if not page_data:
            page -= 1
            page_data = None
            continue

        page_max_endstamp = max(int(g.get("endstamp", 0) or 0) for g in page_data)
        games.extend(page_data)

        if page_max_endstamp < TRACKER_ERA_START:
            break

        page -= 1
        page_data = None

    return games


for player in players:
    api_key = player.get("api_key")
    if not api_key:
        continue

    for raw_game in fetch_live_games(api_key) + fetch_finished_games_since_era(api_key):
        game = raw_game.get("games") if isinstance(raw_game, dict) and "games" in raw_game else raw_game
        game_id = str(game.get("gameid", ""))
        if not game_id:
            continue

        game = normalize_game(game)

        # Filter out old finished games before the Tracker Era
        if game.get("gamestatus") == "Finished" and game["endstamp"] < TRACKER_ERA_START:
            continue

        # Filter out games that aren't mostly the core group
        if count_core_players(game) < MIN_CORE_PLAYERS:
            continue

        old_game = previous_games_by_id.get(game_id)
        if old_game:
            record_turn_handoff(game_id, old_game, game)
        finalize_turn_stats_if_finished(game_id, game)

        all_games[game_id] = game

# Save turn-speed stats
with open(TURN_STATS_FILE, "w") as f:
    json.dump({
        "last_updated": int(time.time()),
        "players": turn_stats,
        "pending": pending_turn_stats,
        "finalized_games": sorted(finalized_games)
    }, f, indent=2)

# Save dashboard data
dashboard_payload = {
    "last_updated": int(time.time()),
    "total_games": len(all_games),
    "games": list(all_games.values())
}
with open(DASHBOARD_FILE, "w") as f:
    json.dump(dashboard_payload, f, indent=2)

print(f"Sync complete. Saved {len(all_games)} games.")
