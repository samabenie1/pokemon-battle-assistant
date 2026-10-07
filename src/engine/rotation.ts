// Rotation battles (Black 2): 3 on the field per side, only the FRONT one acts, and either side can rotate a
// different one to the front before moves (free, no turn lost). So you never know which foe you'll hit or which
// one hits you: the pick is the front + move that does the most against ALL their field Pokémon while no foe can
// KO it (worst case: max roll + crit), unless it is faster and KOs that foe first. Calculator only, no AI call.
import { calculate, Generations, Move } from "@smogon/calc";
import { moveName, monLabel, speciesName } from "../names.ts";
import type { Mon } from "../pk8.ts";
import { GAME } from "../game.ts";
import { effSpeed, hit, hitChance, toCalc, usableMoves } from "./calc.ts";

const gen = Generations.get(GAME.gen);

export interface RotationState {
  mine: (Mon & { maxHP?: number })[]; // my field Pokémon, front first
  foes: (Mon & { maxHP?: number })[]; // their field Pokémon, front first (never the bench: no spoilers)
  abilityKnown: (species: number) => boolean;
}

export function analyzeRotation(s: RotationState, nuzlocke: boolean) {
  const foeMons = s.foes.filter((f) => f.hp > 0);
  const foes = foeMons.map((f) => toCalc(f, undefined, !s.abilityKnown(f.species), true));
  const foeInfo = foeMons.map((f, j) => ({
    name: speciesName(f.species), level: f.level, hp: foes[j].curHP(), maxHP: foes[j].maxHP(), types: foes[j].types,
    ability: s.abilityKnown(f.species) ? foes[j].ability : "???", speed: effSpeed(foes[j]), front: f === s.foes[0],
  }));

  const candidates = s.mine.filter((m) => m.hp > 0).map((mon) => {
    const me = toCalc(mon, undefined, false, true);
    const mySpe = effSpeed(me);
    // Each foe's worst hit on this Pokémon (max roll; crit too in a Nuzlocke), and whether it can strike first anyway.
    const threats = foes.map((f, j) => {
      const hits = usableMoves(foeMons[j]).map((id) => {
        const name = moveName(id), mv = new Move(gen, name);
        if (mv.category === "Status") return null;
        const max = (crit: boolean) => calculate(gen, f, me, new Move(gen, name, { isCrit: crit })).range()[1];
        return { move: name, hp: max(false), critHP: max(true), priority: mv.priority > 0 };
      }).filter((h): h is NonNullable<typeof h> => !!h);
      const worst = (h: (typeof hits)[number]) => (nuzlocke ? h.critHP : h.hp);
      const best = hits.sort((a, b) => worst(b) - worst(a))[0];
      const prio = hits.filter((h) => h.priority).sort((a, b) => worst(b) - worst(a))[0];
      return {
        from: foeInfo[j].name, move: best?.move ?? null,
        pct: best ? Math.round((100 * best.hp) / me.maxHP()) : 0, critPct: best ? Math.round((100 * best.critHP) / me.maxHP()) : 0,
        canKO: !!best && worst(best) >= me.curHP(), prioKO: !!prio && worst(prio) >= me.curHP(), faster: foeInfo[j].speed >= mySpe,
      };
    });

    const moves = usableMoves(mon).map((id) => {
      const name = moveName(id), mv = new Move(gen, name);
      const accuracy = Math.round(hitChance(name, me.ability));
      const vs = foes.map((f) => {
        const h = hit(me, f, name);
        return { pctMax: h.pctMax, ko: mv.category !== "Status" && accuracy >= 100 && h.ofCurrent[0] >= f.curHP(), frac: Math.min(1, h.ofCurrent[0] / f.curHP()) };
      });
      // Recoil on the biggest hit (Flare Blitz, Head Smash…) can KO me on its own.
      const rc = (mv as { recoil?: [number, number] }).recoil;
      const recoilKO = !!rc && foes.some((f, j) => Math.floor((Math.min(f.curHP(), (vs[j].pctMax[1] / 100) * f.maxHP()) * rc[0]) / rc[1]) >= me.curHP());
      // Unsafe vs a foe that can KO me, unless I move first and this move surely KOs it (and it has no priority KO).
      const unsafeVs = threats.filter((t, j) => t.canKO && (t.faster || !vs[j].ko || t.prioKO)).map((t) => t.from);
      return {
        move: name, type: mv.type, category: mv.category, pp: mon.pp[mon.moves.indexOf(id)], accuracy, vs, recoilKO,
        unsafeVs: recoilKO ? [...unsafeVs, "own recoil"] : unsafeVs,
        // vs ALL of them: the foe I'd hurt least (they may rotate it in), then the average.
        worstFrac: mv.category === "Status" ? -1 : Math.min(...vs.map((v) => v.frac)),
        meanFrac: mv.category === "Status" ? -1 : vs.reduce((t, v) => t + v.frac, 0) / Math.max(1, vs.length),
        kos: vs.filter((v) => v.ko).length,
      };
    });
    return { name: monLabel(mon), level: mon.level, hp: me.curHP(), maxHP: me.maxHP(), types: me.types, speed: mySpe,
      status: me.status, front: mon === s.mine[0], ability: me.ability, threats, moves };
  });

  // Ranking: safe first (no faints beats damage), then damage vs the foe I'd hurt least, then sure KOs, then average.
  // Staying in front breaks ties (rotating is free, but fewer surprises).
  const options = candidates.flatMap((c) => c.moves.filter((m) => m.category !== "Status" && (m.pp ?? 1) > 0).map((m) => ({ c, m })));
  options.sort((a, b) => (a.m.unsafeVs.length - b.m.unsafeVs.length) || (b.m.worstFrac - a.m.worstFrac) || (b.m.kos - a.m.kos)
    || (b.m.meanFrac - a.m.meanFrac) || (Number(b.c.front) - Number(a.c.front)));
  const best = options[0];
  const pick = best ? (() => {
    const { c, m } = best;
    const range = m.vs.map((v, j) => `${foeInfo[j].name} ${v.pctMax[0]}–${v.pctMax[1]}%${v.ko ? " KO" : ""}`).join(", ");
    const worstIn = c.threats.slice().sort((a, b) => b.critPct - a.critPct)[0];
    const safety = m.unsafeVs.length
      ? `⚠ No fully safe option: ${m.unsafeVs.join(", ")} can still KO ${c.name}.`
      : worstIn ? `Safe: the worst hit is ${worstIn.from}'s ${worstIn.move} at ${worstIn.pct}% (crit ${worstIn.critPct}%) vs ${Math.round((100 * c.hp) / c.maxHP)}% HP.` : "";
    const truant = c.ability === "Truant" ? " Truant: it loafs next turn, so rotate it out then." : "";
    return { pokemon: c.name, move: m.move, rotate: !c.front, reason: `${m.move} vs all of them: ${range}. ${safety}${truant}` };
  })() : null;
  return { rotation: true as const, actives: candidates, foes: foeInfo, pick };
}

export type RotationAnalysis = ReturnType<typeof analyzeRotation>;
