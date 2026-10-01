// Bag recommendations between battles: held-item boosters, candies for the lowest levels, TM upgrades.
import { readFileSync } from "node:fs";
import { Generations, Move } from "@smogon/calc";
import { expForLevel, type Mon } from "../pk8.ts";
import { moveName, speciesName } from "../names.ts";
import { toCalc } from "./calc.ts";
import { GAME } from "../game.ts";
import { canLearn, machineLabel, machineSlot } from "../offsets/b2rom.ts";

const gen = Generations.get(GAME.gen);
const data = (f: string) => new URL(`../../data/${f}`, import.meta.url);
const ITEM_NAMES = readFileSync(data("items_en.txt"), "utf8").split("\n").map((s) => s.trim());
const MACHINES = JSON.parse(readFileSync(data("machines.json"), "utf8")) as { byItem: Record<string, string>; canLearn: Record<string, string[]> };
// TM/TR → species the player found "Not able" in-game (compatibility is randomized): data/not-able.json.
const notAble = (): Record<string, string[]> => { try { return JSON.parse(readFileSync(data("not-able.json"), "utf8")); } catch { return {}; } };

export const itemLabel = (id: number) => ITEM_NAMES[id] ?? `item#${id}`;

// Type-boosting held items (+20% to one type).
const BOOSTERS: Record<string, string> = {
  "Miracle Seed": "Grass", "Silk Scarf": "Normal", "Charcoal": "Fire", "Mystic Water": "Water", "Magnet": "Electric",
  "Never-Melt Ice": "Ice", "Black Belt": "Fighting", "Poison Barb": "Poison", "Soft Sand": "Ground", "Sharp Beak": "Flying",
  "Twisted Spoon": "Psychic", "Silver Powder": "Bug", "Hard Stone": "Rock", "Spell Tag": "Ghost", "Dragon Fang": "Dragon",
  "Black Glasses": "Dark", "Metal Coat": "Steel", "Fairy Feather": "Fairy",
};
// General-purpose held items worth equipping, best first.
const GOOD_HELD = ["Leftovers", "Life Orb", "Expert Belt", "Shell Bell", "Sitrus Berry", "Muscle Band", "Wise Glasses", "Scope Lens", "Quick Claw", "Oran Berry"];
const CANDY_EXP: Record<string, number> = { "Exp. Candy XS": 100, "Exp. Candy S": 800, "Exp. Candy M": 3000, "Exp. Candy L": 10000, "Exp. Candy XL": 30000 };

export interface Pouch { id: number; count: number }

/** "tm57"-style key for a TM/TR item name ("TM57" → "tm57"). */
const machineKey = (name: string) => name.toLowerCase().replace(/\s+/g, "");
/** PokeAPI move slug → calc move name ("liquidation" → "Liquidation"). */
const moveFromSlug = (slug: string) => {
  const id = slug.replace(/-/g, "");
  return [...gen.moves].find((m) => m.id === id)?.name ?? null;
};

/** Effective attacking power of a move for this Pokémon: BP × STAB × (its matching attack stat / the other). */
function power(mon: Mon, move: string) {
  const mv = new Move(gen, move);
  if (mv.category === "Status" || !mv.bp) return 0;
  const p = toCalc(mon);
  const stab = p.types.includes(mv.type) ? 1.5 : 1;
  // Multi-hit moves (Fury Swipes, Double Kick…): average number of hits.
  const hits = Array.isArray(mv.hits) ? 3.1 : typeof mv.hits === "number" && mv.hits > 1 ? mv.hits : 1;
  const stat = mv.category === "Physical" ? p.stats.atk : p.stats.spa;
  return mv.bp * hits * stab * (stat / Math.max(p.stats.atk, p.stats.spa));
}

/** Black 2: TM/HM moves read from RAM and compatibility from the ROM (both randomized). */
export interface B2Machines { moves: number[]; compat: Buffer[] | null }

export function bagTips(party: Mon[], general: Pouch[], machines: Pouch[], target: number, b2?: B2Machines | null) {
  const tips: string[] = [];
  const names = new Set(general.filter((i) => i.count > 0).map((i) => itemLabel(i.id)));

  // 1) Held items: boosters / good items in the bag → the Pokémon that benefits most and holds nothing useful.
  const heldNow = party.map((m) => ({ m, item: m.heldItem ? itemLabel(m.heldItem) : "" }));
  const weakHolder = (item: string) => !item || !(item in BOOSTERS) && !GOOD_HELD.includes(item);
  const given = new Set<Mon>();
  for (const item of [...GOOD_HELD.filter((i) => names.has(i)), ...Object.keys(BOOSTERS).filter((i) => names.has(i))]) {
    const type = BOOSTERS[item];
    const scored = heldNow.filter((h) => weakHolder(h.item) && !given.has(h.m)).map((h) => {
      const moves = h.m.moves.filter(Boolean).map(moveName);
      const score = type ? Math.max(0, ...moves.filter((mv) => new Move(gen, mv).type === type).map((mv) => power(h.m, mv))) : 1;
      return { h, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    const pick = scored[0];
    if (pick) {
      given.add(pick.h.m);
      tips.push(`Give ${item} to ${speciesName(pick.h.m.species)}${type ? ` (boosts its ${type} attacks by 20%)` : ""}${pick.h.item ? `, replacing ${pick.h.item}` : ""}.`);
    }
  }

  // 2) Candies → lowest-level Pokémon, never past the cap.
  const low = [...party].filter((m) => (m.level ?? 1) < target).sort((a, b) => (a.level ?? 1) - (b.level ?? 1));
  if (low.length) {
    const m = low[0];
    const rare = general.find((i) => itemLabel(i.id) === "Rare Candy" && i.count > 0);
    if (rare) tips.push(`Rare Candy on ${speciesName(m.species)} (Lv ${m.level} → ${(m.level ?? 1) + 1}), your lowest level.`);
    let exp = 0; const used: string[] = [];
    for (const i of general) { const n = itemLabel(i.id); if (CANDY_EXP[n] && i.count > 0) { exp += CANDY_EXP[n] * i.count; used.push(`${i.count}× ${n}`); } }
    if (exp) {
      let lv = m.level ?? 1; const e = m.exp + exp;
      while (lv < Math.min(100, target) && e >= expForLevel(m.species, lv + 1)) lv++;
      tips.push(`Exp. Candies (${used.join(", ")}) on ${speciesName(m.species)}: +${exp} EXP${lv > (m.level ?? 1) ? `, Lv ${m.level} → ${lv}` : " (part of a level)"}.`);
    }
  }

  // 3) TMs/TRs: a stronger attack or new coverage. Compatibility is randomized in this save, so every Pokémon is
  // considered and the player checks "Able" in the TM menu. Match TMs to Pokémon one-to-one, biggest gain first.
  const cands: { tm: string; move: string; mon: string; gain: number; replaces: string; why: string }[] = [];
  const blocked = notAble();
  // TMs/TRs the player has already tried on everyone (data/tms-checked.json): only newly found ones get tips.
  let checked = new Set<string>();
  try { checked = new Set(JSON.parse(readFileSync(data("tms-checked.json"), "utf8"))); } catch { /* none yet */ }
  for (const tm of machines.filter((i) => i.count > 0)) {
    let label = itemLabel(tm.id), move: string | null = null, slot = -1;
    if (b2) {
      slot = machineSlot(tm.id);
      if (slot < 0) continue;
      label = machineLabel(slot); move = moveName(b2.moves[slot]);
    } else {
      const slug = MACHINES.byItem[machineKey(label)];
      move = slug ? moveFromSlug(slug) : null;
      if (checked.has(label)) continue;
    }
    if (!move) continue;
    const mv = new Move(gen, move);
    if (mv.category === "Status") continue;
    for (const m of party) {
      const current = m.moves.filter(Boolean).map(moveName);
      if (current.includes(move) || (blocked[label] ?? []).includes(speciesName(m.species))) continue;
      if (b2?.compat && !canLearn(b2.compat, m.species, slot)) continue;
      if (current.length < 4) { // a free move slot: anything decent is pure gain
        if (power(m, move) > 0) cands.push({ tm: label, move, mon: speciesName(m.species), gain: 10 + power(m, move) / 100, replaces: "", why: "fills its empty move slot" });
        continue;
      }
      // Variable-power moves (Endeavor, Seismic Toss…) have no fixed BP: don't treat them as "weak".
      const scored = current.map((c) => ({ c, p: power(m, c), variable: new Move(gen, c).category !== "Status" && !new Move(gen, c).bp }));
      // Replace the weakest ATTACK: status moves (Hypnosis, Leer…) score 0 power but aren't dead weight.
      const attacks = scored.filter((x) => !x.variable && x.p > 0);
      const weakest = (attacks.length ? attacks : scored.filter((x) => !x.variable)).sort((a, b) => a.p - b.p)[0];
      const types = new Set(current.map((c) => new Move(gen, c)).filter((x) => x.category !== "Status").map((x) => x.type));
      const newType = !types.has(mv.type) && mv.type !== "Normal"; // Normal is super effective on nothing
      const gain = power(m, move) / Math.max(1, weakest?.p ?? 0);
      if (gain >= 1.25 || (newType && gain >= 0.9))
        cands.push({ tm: label, move, mon: speciesName(m.species), gain, replaces: weakest?.c ?? "–",
          why: newType ? `new ${mv.type} coverage` : gain >= 3 ? "much stronger" : `${Math.round((gain - 1) * 100)}% stronger` });
    }
  }
  const usedTM = new Set<string>(), usedMon = new Set<string>();
  for (const c of cands.sort((a, b) => b.gain - a.gain)) {
    if (usedTM.has(c.tm) || usedMon.has(c.mon)) continue;
    usedTM.add(c.tm); usedMon.add(c.mon);
    const exact = !!b2?.compat;
    const hm = c.tm.startsWith("HM") ? " HM moves can only be removed by the Move Deleter (Mistralton City)." : "";
    tips.push(`${c.tm} (${c.move}) → ${c.mon}${exact ? "" : " if it can learn it (check \"Able\" in the TM menu)"}${c.replaces ? `, replacing ${c.replaces}` : ""}: ${c.why}.${hm}`);
  }
  // Mints do nothing when held; they're used from the bag.
  for (const h of heldNow) if (/ Mint$/.test(h.item)) tips.push(`${speciesName(h.m.species)} is holding a ${h.item}, which does nothing when held (use mints from the bag).`);
  return tips;
}
