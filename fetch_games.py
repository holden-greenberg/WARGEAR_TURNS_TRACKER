import os
import json
import time
import requests
from datetime import datetime

DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")
PLAYERS_CONFIG_RAW = os.environ.get("PLAYERS_CONFIG", "[]")

try:
    players = json.loads(PLAYERS_CONFIG_RAW)
except Exception:
    players = []

STATE_FILE = "data/last_turns.json"
DASHBOARD_FILE = "data/dashboard.json"
os.makedirs("data", exist_ok=True)

# Tracker Era start: September 2, 2026, 00:00:00 UTC
TRACKER_ERA_START = int(datetime(2026, 9, 2, 0, 0, 0).timestamp())

# Load previous turn states to prevent duplicate pings
if os.path.exists(STATE_FILE):
    try:
        with open(STATE_FILE, "r") as f:
            previous_state = json.load(f)
    except Exception:
        previous_state = {}
else:
    previous_state = {}

new_state = {}
all_games = {}
headers = {'User-Agent': 'Mozilla/5.0'}

for player in players:
    name = player.get("name", "Player")
    api_key = player.get("api_key")
    discord_id = player.get("discord_id")

    if not api_key:
        continue

    current_player_turns = {}
    prev_player_turns = previous_state.get(name, {})

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
                    
                    # Enforce Tracker Era filter for finished games to keep payload clean
                    if status == "Finished":
                        endstamp = game.get("endstamp", 0) or 0
                        if endstamp < TRACKER_ERA_START:
                            continue

                    all_games[game_id] = game

                    # Check turn notifications ONLY for Live games where a turnstamp exists
                    if view_type == "Live" and status == "Live":
                        current_turn = game.get("current_turn", [])
                        turn_names = []
                        if isinstance(current_turn, list):
                            for t in current_turn:
                                if isinstance(t, dict):
                                    turn_names.append(t.get("name", "").lower())
                                elif isinstance(t, str):
                                    turn_names.append(t.lower())

                        if name.lower() in turn_names:
                            # Use the official game turnstamp so it only changes when a real turn changes
                            turn_stamp = game.get("turnstamp")
                            if turn_stamp:
                                current_player_turns[game_id] = str(turn_stamp)
                                
                                # Only alert if this exact turn timestamp hasn't been pinged yet
                                if prev_player_turns.get(game_id) != str(turn_stamp):
                                    if DISCORD_WEBHOOK_URL:
                                        mention = f"<@{discord_id}>" if discord_id else f"**{name}**"
                                        game_url = f"https://www.wargear.net/games/player/{game_id}"
                                        msg = {"content": f"⚔️ {mention}, it's your turn in **{game.get('name', 'WarGear Game')}**!\n👉 Play: {game_url}"}
                                        try:
                                            requests.post(DISCORD_WEBHOOK_URL, json=msg, timeout=10)
                                            print(f"Sent Discord alert for {name} in game {game_id}")
                                        except Exception as e:
                                            print(f"Discord webhook error: {e}")

                if len(data) < 5:
                    break
                page += 1
            except Exception as e:
                print(f"Error fetching page {page} for {name}: {e}")
                break
                
    new_state[name] = current_player_turns

# Save updated state so future runs recognize current turns have already been alerted
with open(STATE_FILE, "w") as f:
    json.dump(new_state, f, indent=2)

dashboard_payload = {
    "last_updated": int(time.time()),
    "total_games": len(all_games),
    "games": list(all_games.values())
}
with open(DASHBOARD_FILE, "w") as f:
    json.dump(dashboard_payload, f, indent=2)

print(f"Saved {len(all_games)} games to dashboard.")
