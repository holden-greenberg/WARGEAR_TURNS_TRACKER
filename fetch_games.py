import os
import json
import requests

# Load the secret API key from the environment
API_KEY = os.environ.get('WARGEAR_API_KEY')
if not API_KEY:
    raise ValueError("API Key not found in environment variables.")

# The list of usernames from your "Wargear turns" file
PLAYERS = [
    "fitzyfbaby", "MeadeBot", "Bofa Deez", "Invader Zim", 
    "HoldenGreenberg", "harambae", "jgliks", "somethingpete", "nico12"
]

API_BASE = "https://api.wargear.net/api-docs/GetGameList/player"
active_games = {}

for player in PLAYERS:
    # Query the GetGameList endpoint for each player
    params = {
        'api_key': API_KEY,
        'player': player,
        'format': 'json'
    }
    
    try:
        response = requests.get(API_BASE, params=params)
        response.raise_for_status()
        data = response.json()
        
        # The API returns a list of dictionaries with a "games" key
        for item in data:
            game = item.get("games", {})
            if not game:
                continue
            
            game_id = game.get("gameid")
            status = game.get("gamestatus")
            
            # Filter for active games only
            if status in ["Live", "Initial Placement", "Territory Select"]:
                # Use gameid as dictionary key to prevent duplicates
                active_games[game_id] = game
                
    except Exception as e:
        print(f"Error fetching data for {player}: {e}")

# Convert dictionary back to a list of unique games
unique_games = list(active_games.values())

# Ensure a data directory exists
os.makedirs("data", exist_ok=True)

# Save the aggregated data to a static JSON file
with open("data/games.json", "w") as f:
    json.dump(unique_games, f, indent=4)

print(f"Successfully saved {len(unique_games)} active games.")
