// Gen 5 level-up learnsets (Black 2/White 2) from PokeAPI → data/learnsets-b2.json: { species: [[level, moveId], ...] }.
// Move ids are the games' own ids, the same numbers the PK5 stores.
import { writeFileSync } from "node:fs";

const res = await fetch("https://beta.pokeapi.co/graphql/v1beta", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: `{ pokemon_v2_pokemonmove(where:{
    pokemon_v2_versiongroup:{name:{_eq:"black-2-white-2"}},
    pokemon_v2_movelearnmethod:{name:{_eq:"level-up"}},
    pokemon_v2_pokemon:{is_default:{_eq:true}} }) { level move_id pokemon_v2_pokemon { pokemon_species_id } } }` }),
});
const rows = (await res.json()).data.pokemon_v2_pokemonmove;
const out = {};
for (const r of rows) (out[r.pokemon_v2_pokemon.pokemon_species_id] ??= []).push([r.level, r.move_id]);
for (const k in out) out[k].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
writeFileSync("data/learnsets-b2.json", JSON.stringify(out));
console.log(`${Object.keys(out).length} species, ${rows.length} rows`);
