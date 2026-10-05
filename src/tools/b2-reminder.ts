// Black 2: for each party Pokémon, the level-up moves it could relearn at the Move Reminder (learned at or below its level, not known now).
// Usage: node --import tsx src/tools/b2-reminder.ts
import { readFileSync } from "node:fs";
import { MelonDS } from "../reader/melonds.ts";
import { B2 } from "../offsets/b2.ts";
import { decrypt, parse, SIZE_PARTY } from "../pk5.ts";
import { speciesName, moveName, monLabel, itemName, abilityName } from "../names.ts";

const data = (f: string) => JSON.parse(readFileSync(new URL(`../../data/${f}`, import.meta.url), "utf8"));
const learnsets = data("learnsets-b2.json") as Record<string, [number, number][]>;
const dex = Object.values(data("pokedex.json") as Record<string, { num: number; types: string[]; forme?: string }>);
const moveByNum = new Map(Object.values(data("moves.json") as Record<string, { num: number; basePower: number; type: string; category: string; accuracy: number | true }>).map((m) => [m.num, m]));
const typesOf = (n: number) => dex.find((d) => d.num === n && !d.forme)?.types ?? [];
const desc = (id: number) => {
  const m = moveByNum.get(id);
  if (!m) return moveName(id);
  const acc = m.accuracy === true ? "—" : `${m.accuracy}%`;
  return `${moveName(id)} (${m.type} ${m.category}${m.basePower ? " " + m.basePower : ""}, ${acc})`;
};

const ds = new MelonDS();
if (!ds.connect()) throw new Error("melonDS isn't running (or has no game loaded)");
const base = ds.ptr(B2.MAIN_POINTER);
const count = Math.min(6, ds.u32(base + B2.partyCount));
for (let i = 0; i < count; i++) {
  const d = decrypt(ds.bytes(base + B2.party + i * SIZE_PARTY, SIZE_PARTY));
  if (!d) continue;
  const m = parse(d);
  const known = new Set(m.moves.filter(Boolean));
  const options = [...new Map((learnsets[m.species] ?? []).filter(([lv, id]) => lv <= (m.level ?? 0) && !known.has(id)).map(([lv, id]) => [id, lv])).entries()];
  console.log(`\n${monLabel(m)} Lv${m.level} [${typesOf(m.species).join("/")}] ${abilityName(m.ability)}${m.heldItem ? " @" + itemName(m.heldItem) : ""}`);
  console.log(`  knows: ${m.moves.filter(Boolean).map(desc).join(" | ")}`);
  console.log(`  can relearn: ${options.length ? options.map(([id, lv]) => `L${lv} ${desc(id)}`).join(" | ") : "(none)"}`);
}
