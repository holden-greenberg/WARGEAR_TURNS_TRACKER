import os
import json
import time
import requests

DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")
PLAYERS_CONFIG_RAW = os.environ.get("PLAYERS_CONFIG", "[]")

try:
    players = json.loads(PLAYERS_CONFIG_RAW)
except Exception as e:
    print(f"Error parsing PLAYERS_CONFIG: {e}")
    players = []

STATE_FILE = "data/last_turns.json"
DASHBOARD_FILE = "data/dashboard.json"
os.makedirs("data", exist_ok=True)

# Load previous turns state for Discord notifications
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
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
}

for player in players:
    name = player.get("name", "Player")
    api_key = player.get("api_key")
    discord_id = player.get("discord_id")

    if not api_key:
        continue

    print(f"\n--- Checking games & turns for {name} ---")
    current_player_turns = {}
    prev_player_turns = previous_state.get(name, {})

    # Fetch both Live and Finished games to support the archive and leaderboard
    for view_type in ["Live", "Finished"]:
        url = "https://www.wargear.net/rest/GetGameList/my"
        try:
            resp = requests.get(
                url,
                params={"api_key": api_key, "viewselector": view_type, "format": "json"},
                headers=headers,
                timeout=20
            )
            
            if resp.status_code == 200:
                data = resp.json()

                if not data or not isinstance(data, list):
                    continue

                for item in data:
                    game = item.get("games") if isinstance(item, dict) and "games" in item else item
                    game_id = str(game.get("gameid", ""))
                    if not game_id:
                        continue

                    # Deduplicate into master game collection
                    if game_id not in all_games:
                        all_games[game_id] = game

                    # Only check for active Discord turn alerts if the game is Live
                    if view_type == "Live":
                        current_turn = game.get("current_turn", [])
                        turn_names = []
                        if isinstance(current_turn, list):
                            for t in current_turn:
                                if isinstance(t, dict):
                                    turn_names.append(t.get("name", "").lower())
                                elif isinstance(t, str):
                                    turn_names.append(t.lower())

                        is_player_turn = name.lower() in turn_names
                        turn_stamp = str(game.get("turnstamp") or game.get("createstamp") or "active")

                        if is_player_turn:
                            current_player_turns[game_id] = turn_stamp
                            game_name = game.get("name", "WarGear Game")

                            # Alert Discord if it's newly their turn
                            if game_id not in prev_player_turns or prev_player_turns[game_id] != turn_stamp:
                                print(f"⚔️ New turn for {name} in '{game_name}'! Sending Discord alert...")
                                mention = f"<@{discord_id}>" if discord_id else f"**{name}**"
                                game_url = f"https://www.wargear.net/games/player/{game_id}"

                                if DISCORD_WEBHOOK_URL:
                                    msg = {
                                        "content": f"⚔️ {mention}, it's your turn in **{game_name}**!\n👉 Play: {game_url}"
                                    }
                                    try:
                                        requests.post(DISCORD_WEBHOOK_URL, json=msg, timeout=10)
                                    except Exception as post_err:
                                        print(f"Failed to post to Discord: {post_err}")

            else:
                print(f"Failed to fetch {view_type} games for {name}: Status {resp.status_code}")

        except Exception as e:
            print(f"Error fetching {view_type} games for {name}: {e}")
            
    # Save their turn state to prevent duplicate Discord pings
    new_state[name] = current_player_turns

# Save notification state
with open(STATE_FILE, "w") as f:
    json.dump(new_state, f, indent=2)

# Save aggregated dashboard payload
dashboard_payload = {
    "last_updated": int(time.time()),
    "total_games": len(all_games),
    "games": list(all_games.values())
}
with open(DASHBOARD_FILE, "w") as f:
    json.dump(dashboard_payload, f, indent=2)

print(f"\nDone! Saved {len(all_games)} games to {DASHBOARD_FILE}.")
