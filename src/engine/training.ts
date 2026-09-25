// Training mode: level the team evenly up to a target (e.g. the next boss / Nuzlocke cap).
// Sword/Shield's Exp. Share is always on: Pokémon that were on the field at any point
// get full EXP, the rest of the party gets half.
import { readFileSync } from "node:fs";
import { expForLevel, type Mon } from "../pk8.ts";
import { speciesName } from "../names.ts";
import type { Analysis } from "./calc.ts";

const BASE_EXP = JSON.parse(readFileSync(new URL("../../data/baseexp.json", import.meta.url), "utf8")) as Record<string, number>;

/** Gen 8 (scaled) EXP formula for one Pokémon. */
function expGain(enemySpecies: number, enemyLevel: number, myLevel: number, participant: boolean, trainer: boolean) {
  const b = BASE_EXP[enemySpecies] ?? 100;
  const scaled = ((b * enemyLevel) / 5) * (participant ? 1 : 0.5) * Math.pow((2 * enemyLevel + 10) / (enemyLevel + myLevel + 10), 2.5);
  return Math.floor((Math.floor(scaled) + 1) * (trainer ? 1.5 : 1));
}

export interface TrainingMember {
  name: string; level: number; progress: number; hp: string;
  gainIfOut: number; gainIfBench: number; levelsIfOut: number; atCap: boolean; nearCap: boolean; participant: boolean; active: boolean;
}

export function training(opts: {
  target: number; team: Mon[]; activeEC: number; participants: Set<number>;
  enemySpecies: number; enemyLevel: number; trainer: boolean; analysis: Analysis; nuzlocke: boolean;
}) {
  const { target, team, analysis } = opts;
  const members: (TrainingMember & { ec: number })[] = team.map((m) => {
    const lv = m.level ?? 1;
    const cur = expForLevel(m.species, lv), next = expForLevel(m.species, lv + 1);
    const gainIfOut = expGain(opts.enemySpecies, opts.enemyLevel, lv, true, opts.trainer);
    // How far a full-EXP KO would push it, in levels (fractional).
    let exp = m.exp + gainIfOut, lvAfter = lv;
    while (lvAfter < 100 && exp >= expForLevel(m.species, lvAfter + 1)) lvAfter++;
    const levelsIfOut = lvAfter - lv + (lvAfter < 100 ? (exp - expForLevel(m.species, lvAfter)) / (expForLevel(m.species, lvAfter + 1) - expForLevel(m.species, lvAfter)) : 0)
      - (m.exp - cur) / (next - cur);
    return {
      ec: m.ec, name: speciesName(m.species), level: lv, progress: next > cur ? (m.exp - cur) / (next - cur) : 1, hp: `${m.hp}`,
      gainIfOut, gainIfBench: expGain(opts.enemySpecies, opts.enemyLevel, lv, false, opts.trainer), levelsIfOut: Math.round(levelsIfOut * 100) / 100,
      atCap: lv >= target, nearCap: lv >= target - 1, participant: opts.participants.has(m.ec), active: m.ec === opts.activeEC,
    };
  });

  const active = members.find((m) => m.active);
  // A switch-in is "safe" if the enemy's hardest hit leaves it with a healthy margin
  // (Nuzlocke: the max roll must leave at least 40% HP; otherwise at least 1 HP).
  const safeSwitch = (name: string) => {
    const sw = analysis.switches.find((s) => s.name === name);
    if (!sw) return false;
    const [cur, max] = sw.hp.split("/").map(Number);
    const worst = ((sw.takesWorst?.pctMax[1] ?? 0) / 100) * max;
    return opts.nuzlocke ? cur - worst * 1.5 >= 0.5 * max : cur - worst > 0; // survive a crit with half HP left
  };
  const laggard = members
    .filter((m) => !m.active && !m.participant && !m.atCap && Number(m.hp) > 0 && safeSwitch(m.name))
    .sort((a, b) => a.level + a.progress - (b.level + b.progress))[0];

  let tip: string;
  const losing = active && !analysis.activeMatchup.wins;
  const inDanger = analysis.koRisk.maxRoll || (opts.nuzlocke && analysis.koRisk.withCrit);
  if (members.every((m) => m.atCap)) tip = `Everyone is at Lv ${target}. Ready for the boss.`;
  else if (losing && active.participant)
    tip = `${active.name} has already earned full EXP by being out. Switch to ${analysis.swap?.to ?? "a safer teammate"} for the KO: ${active.name} keeps the EXP.`;
  else if (active?.atCap && laggard) tip = `${active.name} is at the Lv ${target} cap, so swap to ${laggard.name} (Lv ${laggard.level}) and let it take the EXP.`;
  else if (inDanger) tip = `Safety first: ${active?.name ?? "your Pokémon"} is at KO risk. Follow the safe play; EXP can wait.`;
  else if (laggard && active && laggard.level < active.level) tip = `Switch ${laggard.name} (Lv ${laggard.level}) in for a turn: anyone who's been out gets full EXP (+${laggard.gainIfOut}) instead of half.`;
  else if (active && !active.atCap && !losing) tip = `${active.name} (Lv ${active.level}) is a good one to level here: +${active.gainIfOut} EXP for the KO.`;
  else tip = "No safe low-level switch-in against this Pokémon. Take the KO with whoever is safest.";

  const warnings = members.filter((m) => m.nearCap).map((m) => m.atCap
    ? `${m.name} is at Lv ${m.level} (cap ${target}). It still gets half EXP from the bench.`
    : `${m.name} is 1 level from the cap.`);

  return {
    target, tip, warnings,
    members: members.map(({ ec: _ec, ...m }) => m),
  };
}

export type Training = ReturnType<typeof training>;
