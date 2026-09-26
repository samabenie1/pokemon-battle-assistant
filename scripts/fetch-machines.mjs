// Sword/Shield TM/TR → move, and which species can learn each move by TM/TR (PokeAPI GraphQL).
import { writeFileSync } from "node:fs";
const q = async (query) => (await (await fetch("https://beta.pokeapi.co/graphql/v1beta", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
})).json()).data;
const vg = (await q(`{ pokemon_v2_versiongroup(where:{name:{_eq:"sword-shield"}}) { id } }`)).pokemon_v2_versiongroup[0].id;
const machines = (await q(`{ pokemon_v2_machine(where:{version_group_id:{_eq:${vg}}}) { pokemon_v2_item { name } pokemon_v2_move { name } } }`)).pokemon_v2_machine;
const byItem = Object.fromEntries(machines.map((m) => [m.pokemon_v2_item.name, m.pokemon_v2_move.name]));
const learn = (await q(`{ pokemon_v2_pokemonmove(where:{version_group_id:{_eq:${vg}}, pokemon_v2_movelearnmethod:{name:{_eq:"machine"}}, pokemon_id:{_lte:898}}) { pokemon_id pokemon_v2_move { name } } }`)).pokemon_v2_pokemonmove;
const canLearn = {};
for (const r of learn) (canLearn[r.pokemon_id] ??= []).push(r.pokemon_v2_move.name);
writeFileSync("data/machines.json", JSON.stringify({ byItem, canLearn }));
console.log(Object.keys(byItem).length, "machines;", Object.keys(canLearn).length, "species");
