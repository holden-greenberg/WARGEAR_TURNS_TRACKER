import os
import json
import time
from datetime import datetime
import requests

PLAYERS_CONFIG_RAW = os.environ.get("PLAYERS_CONFIG", "[]")

try:
    players = json.loads(PLAYERS_CONFIG_RAW)
except Exception:
    players = []

DASHBOARD_FILE = "data/dashboard.json"
os.makedirs("data", exist_ok=True)

# Tracker Era start: September 2, 2026, 00:00:00 UTC
TRACKER_ERA_START = int(datetime(2026, 9, 2, 0, 0, 0).timestamp())

all_games = {}
headers = {'User-Agent': 'Mozilla/5.0'}

for player in players:
    api_key = player.get("api_key")

    if not api_key:
        continue

    for view_type in ["Live", "Finished"]:
        page = 1
        while True:
            url = "https://www.wargear.net/rest/GetGameList/my"
            try:
                resp = requests.get(
                    url,
                    params={"api_key": api_key, "viewselector": view_type, "pagenumber": page, "format": "json"},
                    headers=headers,
                    timeout=20
                )
                if resp.status_code != 200:
                    break

                data = resp.json()
                if not data or not isinstance(data, list):
                    break

                for item in data:
                    game = item.get("games") if isinstance(item, dict) and "games" in item else item
                    game_id = str(game.get("gameid", ""))
                    if not game_id:
                        continue

                    status = game.get("gamestatus")

                    # Filter out old finished games before the Tracker Era
                    if status == "Finished":
                        endstamp = game.get("endstamp", 0) or 0
                        if endstamp < TRACKER_ERA_START:
                            continue

                    all_games[game_id] = game

                if len(data) < 5:
                    break
                page += 1
            except Exception:
                break

# Save dashboard data
dashboard_payload = {
    "last_updated": int(time.time()),
    "total_games": len(all_games),
    "games": list(all_games.values())
}
with open(DASHBOARD_FILE, "w") as f:
    json.dump(dashboard_payload, f, indent=2)

print(f"Sync complete. Saved {len(all_games)} games.")
