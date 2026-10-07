// Double battles: 2 of mine vs 2 opponents. For each of my actives: every move against each target (with
// the doubles spread reduction), friendly fire on my partner, and what the two opponents can do to it.
import { CRIT } from "../game.ts";
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
  /** Partner battle: the AI ally's Pokémon next to mine (the player doesn't control it). */
  ally?: (Mon & { maxHP?: number }) | null;
  abilityKnown: (species: number) => boolean;
}

export function analyzeDouble(s: DoubleState, nuzlocke: boolean) {
  const foes = s.foes.map((f) => toCalc(f, undefined, !s.abilityKnown(f.species), true));
  const mine = s.mine.map((m) => toCalc(m, undefined, false, true));
  const allyCalc = s.ally ? toCalc(s.ally, undefined, false, true) : undefined;

  const actives = s.mine.map((mon, i) => {
    const me = mine[i];
    const ally = mine[1 - i] ?? allyCalc;
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
      single: threats.some((t) => t.pctMax[1] >= myPct || (nuzlocke && t.pctMax[1] * CRIT >= myPct)),
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

  // Bench switch-ins: worst case both foes aim their best move at the slot (the switch-in eats that turn's hits).
  const benchMons = s.bench.filter((m) => m.hp > 0);
  const switchIns = benchMons.map((mon) => {
    const me = toCalc(mon, undefined, false, true);
    const hits = foes.map((f, j) => {
      const best = usableMoves(s.foes[j]).map((id) => hit(f, me, moveName(id), field())).sort((a, b) => b.pctMax[1] - a.pctMax[1])[0];
      return { from: speciesName(s.foes[j].species), move: best?.move ?? null, pctMax: best?.pctMax ?? [0, 0] };
    });
    const hpPct = (100 * me.curHP()) / me.maxHP();
    const focused = hits.reduce((t, h) => t + h.pctMax[1], 0);
    // Nuzlocke: room for a crit on the bigger hit on top of both max rolls.
    const worst = focused + (nuzlocke ? 0.5 * Math.max(0, ...hits.map((h) => h.pctMax[1])) : 0);
    return { name: speciesName(mon.species), hpPct: Math.round(hpPct), status: me.status, hits, focused: Math.round(focused), safe: worst < hpPct };
  }).sort((a, b) => (a.focused - a.hpPct) - (b.focused - b.hpPct));

  // In danger = a FASTER foe can KO it before it acts (or both foes together can, in a Nuzlocke).
  const danger = actives.map((a) => {
    const hpPct = (100 * a.hp) / a.maxHP;
    const fast = a.threats.filter((t) => t.faster && t.pctMax[1] * (nuzlocke ? CRIT : 1) >= hpPct);
    return fast.length > 0 || (nuzlocke && a.koRisk.focused);
  });

  // Deterministic pick per active: a sure KO, else the biggest single-target hit on the foe it damages most.
  // Never a move that damages the partner at all (Lava Plume, Earthquake, Surf...); 0% = partner immune, fine.
  // An active in danger switches to the safest switch-in (each switch-in used once).
  const usedSwitch = new Set<string>();
  const picks = actives.map((a, i) => {
    if (danger[i]) {
      const sw = switchIns.find((w) => w.safe && !usedSwitch.has(w.name));
      if (sw) { usedSwitch.add(sw.name); return { pokemon: a.name, move: `switch to ${sw.name}`, target: "–" }; }
    }
    const options = a.moves.filter((m) => m.category !== "Status" && !(m.hitsAlly && m.hitsAlly.pctMax[1] > 0)).flatMap((m) =>
      m.spread ? [{ move: m.move, target: "both foes", score: m.vs.reduce((t, v) => t + Math.min(v.pctMax[0], v.hp) + (v.ko ? 100 : 0), 0) - (m.hitsAlly ? m.hitsAlly.pctMax[1] : 0) }]
        : m.vs.map((v) => ({ move: m.move, target: v.target, score: Math.min(v.pctMax[0], v.hp) + (v.ko ? 100 : 0) })));
    const best = options.sort((x, y) => y.score - x.score)[0];
    return { pokemon: a.name, move: best?.move ?? "–", target: best?.target ?? "–" };
  });

  const allyInfo = s.ally && allyCalc ? { name: `${speciesName(s.ally.species)} (ally)`, level: s.ally.level, types: allyCalc.types,
    hp: allyCalc.curHP(), maxHP: allyCalc.maxHP() } : null;
  return { double: true as const, actives, ally: allyInfo, foes: foeInfo, picks, danger, switchIns, bench: benchMons.map((m) => speciesName(m.species)) };
}

/** Overrule AI advice that breaks the hard rules: hurting the partner, or leaving an endangered Pokémon in when a safe switch exists. */
export function checkDoubleAdvice(d: DoubleAnalysis, actions: { pokemon: string; choice: string; target: string }[]) {
  const notes: string[] = [];
  const fixed = actions.map((act) => {
    const i = d.actives.findIndex((a) => a.name === act.pokemon);
    if (i < 0) return act;
    const pick = d.picks[i];
    const asPick = { pokemon: pick.pokemon, choice: pick.move, target: pick.target };
    const mv = d.actives[i].moves.find((m) => m.move.toLowerCase() === act.choice.toLowerCase());
    if (mv?.hitsAlly && mv.hitsAlly.pctMax[1] > 0) {
      notes.push(`${act.pokemon}: ${mv.move} would hit your partner (${mv.hitsAlly.pctMax[1]}%), so it's replaced`);
      return asPick;
    }
    if (d.danger[i] && !/^switch/i.test(act.choice) && pick.move.startsWith("switch")) {
      notes.push(`${act.pokemon} can be KO'd by a faster foe this turn, so it switches out`);
      return asPick;
    }
    return act;
  });
  return { actions: fixed, notes };
}

export type DoubleAnalysis = ReturnType<typeof analyzeDouble>;
