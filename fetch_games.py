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

STATE_FILE = "data/last_pings.json"
DASHBOARD_FILE = "data/dashboard.json"
os.makedirs("data", exist_ok=True)

# Tracker Era start: September 2, 2026, 00:00:00 UTC
TRACKER_ERA_START = int(datetime(2026, 9, 2, 0, 0, 0).timestamp())

# Load previously alerted turn stamps to stop notification spam
if os.path.exists(STATE_FILE):
    try:
        with open(STATE_FILE, "r") as f:
            notified_turns = json.load(f)
    except Exception:
        notified_turns = {}
else:
    notified_turns = {}

new_notified_turns = {}
all_games = {}
headers = {'User-Agent': 'Mozilla/5.0'}

for player in players:
    name = player.get("name", "Player")
    api_key = player.get("api_key")
    discord_id = player.get("discord_id")

    if not api_key:
        continue

    player_pings = notified_turns.get(name, {})

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

                    # Check turn alerts strictly for live games
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
                            turn_stamp = str(game.get("turnstamp", ""))
                            if turn_stamp:
                                unique_turn_key = f"{game_id}_{turn_stamp}"
                                
                                # Carry over the record so we don't alert again for this turn
                                player_pings[game_id] = turn_stamp

                                # If we haven't pinged for this specific turn key yet, send it
                                if player_pings.get(f"alerted_{game_id}") != unique_turn_key:
                                    if DISCORD_WEBHOOK_URL:
                                        mention = f"<@{discord_id}>" if discord_id else f"**{name}**"
                                        game_url = f"https://www.wargear.net/games/player/{game_id}"
                                        msg = {"content": f"⚔️ {mention}, it's your turn in **{game.get('name', 'WarGear Game')}**!\n👉 Play: {game_url}"}
                                        try:
                                            requests.post(DISCORD_WEBHOOK_URL, json=msg, timeout=10)
                                            print(f"Alerted {name} for game {game_id}")
                                        except Exception as e:
                                            print(f"Webhook error: {e}")
                                    
                                    # Mark this exact turn as notified
                                    player_pings[f"alerted_{game_id}"] = unique_turn_key

                if len(data) < 5:
                    break
                page += 1
            except Exception:
                break
                
    new_notified_turns[name] = player_pings

# Save state
with open(STATE_FILE, "w") as f:
    json.dump(new_notified_turns, f, indent=2)

# Save dashboard data
dashboard_payload = {
    "last_updated": int(time.time()),
    "total_games": len(all_games),
    "games": list(all_games.values())
}
with open(DASHBOARD_FILE, "w") as f:
    json.dump(dashboard_payload, f, indent=2)

print(f"Sync complete. Saved {len(all_games)} games.")
