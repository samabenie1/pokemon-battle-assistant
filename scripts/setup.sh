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

echo "Compiling native scanners..."
for f in native/*.c; do cc -O2 -o "${f%.c}" "$f"; done

echo "Done. Put ANTHROPIC_API_KEY=... in .env, then run: npm start"
