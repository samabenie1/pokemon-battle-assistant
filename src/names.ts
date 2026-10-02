// Number → name lookups from Pokémon Showdown's dex data (data/*.json|js).
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../data/", import.meta.url);
const json = (f: string) => JSON.parse(readFileSync(new URL(f, root), "utf8"));
const js = (f: string, key: string) => {
  const ctx = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(readFileSync(new URL(f, root), "utf8"), ctx);
  return ctx.exports[key] as Record<string, { num: number; name: string }>;
};

const byNum = (table: Record<string, { num: number; name: string; forme?: string }>) => {
  const m = new Map<number, string>();
  // Base formes first so e.g. 52 → "Meowth", not "Meowth-Galar".
  for (const e of Object.values(table)) if (e.num > 0 && !e.forme && !m.has(e.num)) m.set(e.num, e.name);
  return m;
};

const species = byNum(json("pokedex.json"));
const moveTable = json("moves.json") as Record<string, { num: number; name: string; accuracy: number | true }>;
const moves = byNum(moveTable);
const accuracyByName = new Map(Object.values(moveTable).map((m) => [m.name, m.accuracy === true ? 100 : m.accuracy]));
/** Base accuracy in % (100 for moves that never miss). */
export const moveAccuracy = (name: string) => accuracyByName.get(name) ?? 100;
const abilities = byNum(js("abilities.js", "BattleAbilities"));
const items = byNum(js("items.js", "BattleItems"));

export const speciesName = (n: number) => species.get(n) ?? `#${n}`;
/** How to refer to one of the player's Pokémon: "Nickname (Species)" when it has a nickname. */
export const monLabel = (m: { species: number; nickname?: string }) =>
  m.nickname && m.nickname.toLowerCase() !== speciesName(m.species).toLowerCase() ? `${m.nickname} (${speciesName(m.species)})` : speciesName(m.species);
/** Does `said` (e.g. an AI answer "Chompy" or "Drapion") name the Pokémon labelled `label` ("Chompy (Drapion)")? */
export const sameMon = (label: string, said: string) =>
  label === said || label.startsWith(`${said} (`) || label.endsWith(`(${said})`);
export const moveName = (n: number) => (n ? moves.get(n) ?? `move#${n}` : "");
export const abilityName = (n: number) => abilities.get(n) ?? `ability#${n}`;
export const itemName = (n: number) => (n ? items.get(n) ?? `item#${n}` : "");
export const NATURES = ["Hardy","Lonely","Brave","Adamant","Naughty","Bold","Docile","Relaxed","Impish","Lax","Timid","Hasty","Serious","Jolly","Naive","Modest","Mild","Quiet","Bashful","Rash","Calm","Gentle","Sassy","Careful","Quirky"];

const reverse = (m: Map<number, string>) => new Map([...m].map(([n, s]) => [s.toLowerCase(), n]));
const speciesRev = reverse(species), movesRev = reverse(moves), abilitiesRev = reverse(abilities);
const need = (m: Map<string, number>, s: string) => {
  const n = m.get(s.toLowerCase());
  if (n === undefined) throw new Error(`unknown name: ${s}`);
  return n;
};
export const speciesNum = (s: string) => need(speciesRev, s);
export const moveNum = (s: string) => need(movesRev, s);
export const abilityNum = (s: string) => need(abilitiesRev, s);
