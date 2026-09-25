// Growth-rate tables (level from EXP), catch rates and base EXP yields from PokeAPI.
import { writeFileSync } from "node:fs";

const growth = { rates: {}, species: {} };
for (let i = 1; i <= 6; i++) {
  const g = await (await fetch(`https://pokeapi.co/api/v2/growth-rate/${i}/`)).json();
  growth.rates[g.name] = g.levels.sort((a, b) => a.level - b.level).map((l) => l.experience);
  for (const s of g.pokemon_species) growth.species[+s.url.match(/\/(\d+)\/$/)[1]] = g.name;
}
writeFileSync("data/growth.json", JSON.stringify(growth));

const res = await fetch("https://beta.pokeapi.co/graphql/v1beta", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "{ pokemon_v2_pokemonspecies(where:{id:{_lte:898}}) { id capture_rate } }" }),
});
const rows = (await res.json()).data.pokemon_v2_pokemonspecies;
writeFileSync("data/capture.json", JSON.stringify(Object.fromEntries(rows.map((r) => [r.id, r.capture_rate]))));

const exp = await fetch("https://beta.pokeapi.co/graphql/v1beta", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "{ pokemon_v2_pokemon(where:{is_default:{_eq:true}, pokemon_species_id:{_lte:898}}) { pokemon_species_id base_experience } }" }),
});
const expRows = (await exp.json()).data.pokemon_v2_pokemon;
writeFileSync("data/baseexp.json", JSON.stringify(Object.fromEntries(expRows.map((r) => [r.pokemon_species_id, r.base_experience]))));
