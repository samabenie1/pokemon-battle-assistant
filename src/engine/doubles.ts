// Double battles: 2 of mine vs 2 opponents. For each of my actives: every move against each target (with
// the doubles spread reduction), friendly fire on my partner, and what the two opponents can do to it.
import { Field, Move, Generations } from "@smogon/calc";
import { moveName, speciesName } from "../names.ts";
import type { Mon } from "../pk8.ts";
import { effSpeed, hit, toCalc, usableMoves } from "./calc.ts";

const gen = Generations.get(8);
const field = () => new Field({ gameType: "Doubles" });

export interface DoubleState {
  mine: (Mon & { maxHP?: number })[];   // my actives (1-2)
  foes: (Mon & { maxHP?: number })[];   // opponent actives (1-2)
  bench: Mon[];
  abilityKnown: (species: number) => boolean;
}

export function analyzeDouble(s: DoubleState, nuzlocke: boolean) {
  const foes = s.foes.map((f) => toCalc(f, undefined, !s.abilityKnown(f.species), true));
  const mine = s.mine.map((m) => toCalc(m, undefined, false, true));

  const actives = s.mine.map((mon, i) => {
    const me = mine[i];
    const ally = mine[1 - i];
    const moves = usableMoves(mon).map((id) => {
      const name = moveName(id);
      const mv = new Move(gen, name);
      const spread = mv.target === "allAdjacentFoes" || mv.target === "allAdjacent";
      const vs = foes.map((f, j) => {
        const h = hit(me, f, name, field());
        return { target: speciesName(s.foes[j].species), pctMax: h.pctMax, ko: h.ofCurrent[0] >= f.curHP(), hp: Math.round((100 * f.curHP()) / f.maxHP()) };
      });
      const allyHit = mv.target === "allAdjacent" && ally ? hit(me, ally, name, field()) : null;
      return {
        move: name, type: mv.type, category: mv.category, spread, pp: mon.pp[mon.moves.indexOf(id)], vs,
        hitsAlly: allyHit ? { pctMax: allyHit.pctMax, ko: allyHit.ofCurrent[1] >= ally!.curHP() } : null,
      };
    });
    // What each opponent can do to this Pokémon; worst case both target it.
    const threats = foes.map((f, j) => {
      const best = usableMoves(s.foes[j]).map((id) => hit(f, me, moveName(id), field())).sort((a, b) => b.pctMax[1] - a.pctMax[1])[0];
      return { from: speciesName(s.foes[j].species), move: best?.move ?? null, pctMax: best?.pctMax ?? [0, 0], faster: effSpeed(f) > effSpeed(me) };
    });
    const myPct = (100 * me.curHP()) / me.maxHP();
    const focus = threats.reduce((sum, t) => sum + t.pctMax[1], 0);
    const koRisk = {
      single: threats.some((t) => t.pctMax[1] >= myPct || (nuzlocke && t.pctMax[1] * 1.5 >= myPct)),
      focused: focus >= myPct,
    };
    return {
      name: speciesName(mon.species), level: mon.level, hp: me.curHP(), maxHP: me.maxHP(), types: me.types, speed: effSpeed(me),
      status: me.status, moves, threats, koRisk,
    };
  });

  const foeInfo = s.foes.map((f, j) => ({
    name: speciesName(f.species), level: f.level, hp: foes[j].curHP(), maxHP: foes[j].maxHP(), types: foes[j].types,
    ability: s.abilityKnown(f.species) ? foes[j].ability : "???", speed: effSpeed(foes[j]),
  }));

  // Deterministic pick per active: a sure KO (preferring spread moves that don't hurt the partner), else the
  // biggest single-target hit on the foe it damages most; never a move that could KO the partner.
  const picks = actives.map((a) => {
    const options = a.moves.filter((m) => m.category !== "Status" && !m.hitsAlly?.ko).flatMap((m) =>
      m.spread ? [{ move: m.move, target: "both foes", score: m.vs.reduce((t, v) => t + Math.min(v.pctMax[0], v.hp) + (v.ko ? 100 : 0), 0) - (m.hitsAlly ? m.hitsAlly.pctMax[1] : 0) }]
        : m.vs.map((v) => ({ move: m.move, target: v.target, score: Math.min(v.pctMax[0], v.hp) + (v.ko ? 100 : 0) })));
    const best = options.sort((x, y) => y.score - x.score)[0];
    return { pokemon: a.name, move: best?.move ?? "–", target: best?.target ?? "–" };
  });

  return { double: true as const, actives, foes: foeInfo, picks, bench: s.bench.filter((m) => m.hp > 0).map((m) => speciesName(m.species)) };
}

export type DoubleAnalysis = ReturnType<typeof analyzeDouble>;
