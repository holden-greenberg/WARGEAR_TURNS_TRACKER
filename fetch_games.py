import os
import json
import requests

API_KEY = os.environ.get('WARGEAR_API_KEY')
if not API_KEY:
    raise ValueError("API Key not found in environment variables.")

# Your list of player usernames
PLAYERS = [
    "fitzyfbaby", "MeadeBot", "Bofa Deez", "Invader Zim", 
    "HoldenGreenberg", "harambae", "jgliks", "somethingpete", "nico12"
]

API_BASE = "https://www.wargear.net/rest/GetGameList/player"
active_games = {}

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

for player in PLAYERS:
    params = {
        'api_key': API_KEY,
        'player': player,
        'format': 'json'
    }
    
    try:
        response = requests.get(API_BASE, params=params, headers=headers)
        response.raise_for_status()
        data = response.json()
        
        print(f"\n--- Fetching data for {player} ---")
        
        if not data:
            print("No active games found for this player in the API response.")
            continue
            
        # Print a snippet of the raw data so we can verify the actual structure
        print(f"Raw data snippet: {str(data)[:300]}")
        
        if isinstance(data, list):
            for item in data:
                # Handle the documentation structure OR direct object structure
                game = item.get("games") if "games" in item else item
                
                game_id = game.get("gameid")
                status = game.get("gamestatus", "")
                
                # If we still can't find a gameid, skip
                if not game_id:
                    continue
                    
                print(f"Found Game ID: {game_id} | Status: '{status}'")
                
                if status.lower() in ["live", "initial placement", "territory select"]:
                    active_games[game_id] = game
        else:
            print("API did not return a list.")
                
    except Exception as e:
        print(f"Error fetching data for {player}: {e}")

unique_games = list(active_games.values())

os.makedirs("data", exist_ok=True)
with open("data/games.json", "w") as f:
    json.dump(unique_games, f, indent=4)

print(f"\nSuccessfully saved {len(unique_games)} active games.")
