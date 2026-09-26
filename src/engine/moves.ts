// Which move to forget when a Pokémon wants to learn a new one: damaging moves by effective power,
// status moves by a hand-rated usefulness (in-game, vs the AI, Nuzlocke-minded).
import { Generations, Move } from "@smogon/calc";
import type { Mon } from "../pk8.ts";
import { moveName, speciesName } from "../names.ts";
import { toCalc } from "./calc.ts";

const gen = Generations.get(8);
// Rough value of status moves on the same scale as effective power (~BP × STAB).
const STATUS_VALUE: Record<string, number> = {
  "Hypnosis": 80, "Sleep Powder": 90, "Spore": 110, "Yawn": 60, "Thunder Wave": 70, "Stun Spore": 65, "Glare": 75,
  "Will-O-Wisp": 70, "Toxic": 60, "Protect": 55, "Detect": 55, "Haze": 55, "Recover": 85, "Roost": 80, "Rest": 50,
  "Swords Dance": 80, "Nasty Plot": 80, "Calm Mind": 70, "Dragon Dance": 80, "Bulk Up": 70, "Quiver Dance": 90,
  "Reflect": 45, "Light Screen": 45, "Aqua Ring": 35, "Baby-Doll Eyes": 35, "Charm": 40, "Scary Face": 30,
  "Leer": 10, "Tail Whip": 10, "Growl": 10, "Sand Attack": 15, "Defense Curl": 10, "Harden": 10, "Howl": 35,
  "Imprison": 5, "Safeguard": 20, "Disable": 25, "Endure": 20, "Supersonic": 25, "Confuse Ray": 35, "Poison Gas": 30,
};

function value(mon: Mon, move: string) {
  const mv = new Move(gen, move);
  if (mv.category === "Status") return STATUS_VALUE[move] ?? 25;
  if (!mv.bp) return 40; // variable power (Endeavor, Seismic Toss…)
  const p = toCalc(mon);
  const stab = p.types.includes(mv.type) ? 1.5 : 1;
  const stat = mv.category === "Physical" ? p.stats.atk : p.stats.spa;
  const hits = Array.isArray(mv.hits) ? 3.1 : 1;
  return mv.bp * hits * stab * (stat / Math.max(p.stats.atk, p.stats.spa));
}

/** The move to drop first, and why. */
export function dropCandidate(mon: Mon) {
  const moves = mon.moves.filter(Boolean).map(moveName);
  const base = moves.map((m) => ({ m, v: value(mon, m), mv: new Move(gen, m) }));
  // Coverage: a damaging move that shares its type with a stronger move is redundant (worth half);
  // a Pokémon's only move of a type keeps full value.
  const ranked = base.map((x) => {
    const redundant = x.mv.category !== "Status" && base.some((y) => y !== x && y.mv.category !== "Status" && y.mv.type === x.mv.type && y.v >= x.v);
    return { m: x.m, v: redundant ? x.v * 0.5 : x.v, redundant };
  }).sort((a, b) => a.v - b.v);
  const worst = ranked[0];
  if (!worst) return null;
  const mv = new Move(gen, worst.m);
  const why = mv.category === "Status" ? "least useful status move"
    : worst.redundant ? `same type as a stronger move, so it adds no coverage` : `weakest attack for ${speciesName(mon.species)}'s stats`;
  return { pokemon: speciesName(mon.species), drop: worst.m, why, ranking: ranked.map((r) => r.m) };
}
