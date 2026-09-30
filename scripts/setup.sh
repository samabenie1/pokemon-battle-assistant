#!/usr/bin/env bash
# Downloads Pokémon data and compiles the native memory scanners.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data

echo "Downloading Pokémon Showdown dex data..."
curl -fsS https://play.pokemonshowdown.com/data/pokedex.json -o data/pokedex.json
curl -fsS https://play.pokemonshowdown.com/data/moves.json -o data/moves.json
curl -fsS https://play.pokemonshowdown.com/data/abilities.js -o data/abilities.js
curl -fsS https://play.pokemonshowdown.com/data/items.js -o data/items.js

echo "Downloading growth rates and catch rates from PokeAPI..."
node scripts/fetch-pokeapi.mjs

echo "Downloading item names (PKHeX) and TM/TR data (PokeAPI)..."
curl -fsS https://raw.githubusercontent.com/kwsch/PKHeX/master/PKHeX.Core/Resources/text/items/text_Items_en.txt -o data/items_en.txt
node scripts/fetch-machines.mjs

echo "Downloading Black 2/White 2 level-up learnsets (PokeAPI)..."
node scripts/fetch-learnsets.mjs

echo "Compiling native scanners..."
for f in native/*.c; do cc -O2 -o "${f%.c}" "$f"; done

echo "Done. Put ANTHROPIC_API_KEY=... in .env, then run: npm start"
