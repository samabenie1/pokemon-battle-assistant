// Which move to forget when a Pokémon wants to learn a new one: damaging moves by effective power,
// status moves by a hand-rated usefulness (in-game, vs the AI, Nuzlocke-minded).
import { Generations, Move } from "@smogon/calc";
import type { Mon } from "../pk8.ts";
import { monLabel, moveName, speciesName } from "../names.ts";
import { HM_MOVES } from "../offsets/b2rom.ts";
import { movePower } from "./calc.ts";
import { GAME } from "../game.ts";
import { readFileSync, existsSync } from "node:fs";

const gen = Generations.get(GAME.gen);
// Level-up learnsets (Black 2 only for now; scripts/fetch-learnsets.mjs): species → [[level, moveId], …].
const lsFile = new URL("../../data/learnsets-b2.json", import.meta.url);
const LEARNSETS: Record<string, [number, number][]> = GAME.id === "b2" && existsSync(lsFile) ? JSON.parse(readFileSync(lsFile, "utf8")) : {};
// Rough value of status moves on the same scale as effective power (~BP × STAB).
const STATUS_VALUE: Record<string, number> = {
  "Hypnosis": 80, "Sleep Powder": 90, "Spore": 110, "Yawn": 60, "Thunder Wave": 70, "Stun Spore": 65, "Glare": 75,
  "Will-O-Wisp": 70, "Toxic": 60, "Protect": 55, "Detect": 55, "Haze": 55, "Recover": 85, "Roost": 80, "Rest": 50,
  "Swords Dance": 80, "Nasty Plot": 80, "Calm Mind": 70, "Dragon Dance": 80, "Bulk Up": 70, "Quiver Dance": 90,
  "Reflect": 45, "Light Screen": 45, "Aqua Ring": 35, "Baby-Doll Eyes": 35, "Charm": 40, "Scary Face": 30,
  "Leer": 10, "Tail Whip": 10, "Growl": 10, "Sand Attack": 15, "Defense Curl": 10, "Harden": 10, "Howl": 35,
  "Imprison": 5, "Safeguard": 20, "Disable": 25, "Endure": 20, "Supersonic": 25, "Confuse Ray": 35, "Poison Gas": 30,
};

/** Status moves strong enough to keep over an attack (Sam, 10-01: "forget status moves first, unless they are OP"). */
export const isOPStatus = (move: string) => (STATUS_VALUE[move] ?? 0) >= 70;
/** A status move that should be the first thing forgotten. */
export const isWeakStatus = (move: string) => new Move(gen, move).category === "Status" && !isOPStatus(move);

function value(mon: Mon, move: string) {
  const mv = new Move(gen, move);
  if (mv.category === "Status") return STATUS_VALUE[move] ?? 25;
  if (!mv.bp) return 40; // variable power (Endeavor, Seismic Toss…)
  return movePower(mon, move); // ability included
}

/** Rank moves worst-first. Coverage: a damaging move that shares its type with a stronger move is redundant
 *  (worth half); a Pokémon's only move of a type keeps full value. */
function rank(mon: Mon, moves: string[]) {
  const base = moves.map((m) => ({ m, v: value(mon, m), mv: new Move(gen, m) }));
  return base.map((x) => {
    const redundant = x.mv.category !== "Status" && base.some((y) => y !== x && y.mv.category !== "Status" && y.mv.type === x.mv.type && y.v >= x.v);
    // Weak status moves always go first; OP ones (Spore, Swords Dance, Recover…) compete on value like attacks.
    // HM moves can't be forgotten (only the Move Deleter removes them): never rank one as the move to drop.
    const v = (redundant ? x.v * 0.5 : x.v) - (isWeakStatus(x.m) ? 1000 : 0) + (HM_MOVES.has(x.m) ? 1e6 : 0);
    return { m: x.m, v, redundant, status: x.mv.category === "Status" };
  }).sort((a, b) => a.v - b.v);
}

const whyWorst = (mon: Mon, w: { status: boolean; redundant: boolean }) =>
  w.status ? "weakest status move (status moves go first unless they're strong)" : w.redundant ? "same type as a stronger move, so it adds no coverage" : `weakest attack for ${speciesName(mon.species)}'s stats`;

/** The move to drop first, and why. */
export function dropCandidate(mon: Mon) {
  const ranked = rank(mon, mon.moves.filter(Boolean).map(moveName));
  const worst = ranked[0];
  if (!worst) return null;
  return { pokemon: monLabel(mon), drop: worst.m, why: whyWorst(mon, worst), ranking: ranked.map((r) => r.m) };
}

export interface NewMove {
  pokemon: string; move: string; level: number;
  /** "now": offered at its current level (the game is asking); "next": the next one it will learn. */
  when: "now" | "next";
  /** What to do: forget this move ("" when it has a free slot), or skip learning the new one. */
  forget: string; skip: boolean; why: string;
}

/** Level-up moves for the party: what each Pokémon is being offered now (or learns next), and what to forget. */
export function newMoves(team: Mon[]): NewMove[] {
  const out: NewMove[] = [];
  for (const mon of team) {
    const ls = LEARNSETS[mon.species], lv = mon.level ?? 0;
    if (!ls) continue;
    const known = mon.moves.filter(Boolean);
    const fresh = ls.filter(([l, id]) => !known.includes(id) && l >= lv);
    const now = fresh.filter(([l]) => l === lv && l > 1);
    const next = fresh.find(([l]) => l > lv);
    for (const [l, id] of [...now, ...(next ? [next] : [])]) {
      const move = moveName(id), when = l === lv ? "now" : "next";
      if (known.length < 4) { out.push({ pokemon: monLabel(mon), move, level: l, when, forget: "", skip: false, why: "free move slot, it learns it automatically" }); continue; }
      const ranked = rank(mon, [...known.map(moveName), move]);
      const worst = ranked[0];
      out.push(worst.m === move
        ? { pokemon: monLabel(mon), move, level: l, when, forget: "", skip: true, why: `worse than all 4 current moves (${whyWorst(mon, worst)})` }
        : { pokemon: monLabel(mon), move, level: l, when, forget: worst.m, skip: false, why: `${worst.m} is the ${whyWorst(mon, worst)}` });
    }
  }
  return out.sort((a, b) => (a.when === b.when ? 0 : a.when === "now" ? -1 : 1));
}
