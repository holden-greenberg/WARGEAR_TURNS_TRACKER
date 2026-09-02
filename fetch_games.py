import os
import json
import requests

DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")
PLAYERS_CONFIG_RAW = os.environ.get("PLAYERS_CONFIG", "[]")

try:
    players = json.loads(PLAYERS_CONFIG_RAW)
except Exception as e:
    print(f"Error parsing PLAYERS_CONFIG: {e}")
    players = []

STATE_FILE = "data/last_turns.json"
os.makedirs("data", exist_ok=True)

# State structure:
# {
#   "HoldenGreenberg": {
#       "81541156": "1725315000",
#       "81540266": "1725318000"
#   }
# }
if os.path.exists(STATE_FILE):
    try:
        with open(STATE_FILE, "r") as f:
            previous_state = json.load(f)
    except Exception:
        previous_state = {}
else:
    previous_state = {}

new_state = {}
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

for player in players:
    name = player.get("name", "Player")
    api_key = player.get("api_key")
    discord_id = player.get("discord_id")

    if not api_key:
        print(f"Skipping {name}: No API key provided.")
        continue

    print(f"\n--- Checking turns for {name} ---")
    current_player_turns = {}
    prev_player_turns = previous_state.get(name, {})

    url = "https://www.wargear.net/rest/GetCurrentTurns"
    try:
        resp = requests.get(url, params={"api_key": api_key, "format": "json"}, headers=headers)
        resp.raise_for_status()
        turns_data = resp.json()

        if not turns_data or not isinstance(turns_data, list):
            print(f"No active turns for {name}.")
            new_state[name] = {}
            continue

        # Each game in the list is processed independently
        for item in turns_data:
            turn = item.get("turns") if isinstance(item, dict) and "turns" in item else item
            game_id = str(turn.get("gameid", ""))
            game_name = turn.get("name", "WarGear Game")
            board_name = turn.get("boardname", "")
            turn_stamp = str(turn.get("turnstamp") or turn.get("createstamp") or "active")

            if not game_id:
                continue

            # Record this game and timestamp for the current run
            current_player_turns[game_id] = turn_stamp

            # Alert if:
            # 1. This game was not waiting on the player during the last check, OR
            # 2. A new round/turn started in this game (turn_stamp changed)
            if game_id not in prev_player_turns or prev_player_turns[game_id] != turn_stamp:
                print(f"New turn detected for {name} in '{game_name}' ({game_id})! Sending Discord alert...")
                
                mention = f"<@{discord_id}>" if discord_id else f"**{name}**"
                board_display = f" on map **{board_name}**" if board_name else ""
                game_url = f"https://www.wargear.net/games/player/{game_id}"
                
                message = {
                    "content": (
                        f"⚔️ {mention}, it's your turn in **{game_name}**{board_display}!\n"
                        f"👉 Take your turn: {game_url}"
                    )
                }

                if DISCORD_WEBHOOK_URL:
                    try:
                        post_resp = requests.post(DISCORD_WEBHOOK_URL, json=message)
                        post_resp.raise_for_status()
                    except Exception as discord_err:
                        print(f"Failed to post to Discord: {discord_err}")
            else:
                print(f"{name} is still on the clock in '{game_name}' ({game_id}). Skipping notification.")

        new_state[name] = current_player_turns

    except Exception as e:
        print(f"Error fetching turns for {name}: {e}")
        # Preserve previous state on network failure to prevent re-alerting on the next run
        new_state[name] = prev_player_turns

# Save updated game state per player
with open(STATE_FILE, "w") as f:
    json.dump(new_state, f, indent=2)

print("\nTurn state successfully saved.")
