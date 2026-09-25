// Guards around the LLM advice: a deterministic fallback (for timeouts/errors) and a
// checker that flags recommendations the damage numbers say are unsafe.
import type { Analysis } from "./calc.ts";
import type { Advice } from "./advisor.ts";

const pct = (hp: string) => { const [c, m] = hp.split("/").map(Number); return (100 * c) / m; };

/** Would this bench Pokémon be KO'd by the hit it takes switching in? */
function switchKills(a: Analysis, name: string, nuzlocke: boolean) {
  const sw = a.switches.find((s) => s.name === name);
  if (!sw) return null;
  const worst = (sw.takesWorst?.pctMax[1] ?? 0) * (nuzlocke ? 1.5 : 1);
  return worst >= pct(sw.hp) ? { worst: Math.round(sw.takesWorst!.pctMax[1]), move: sw.takesWorst!.move } : null;
}

/** A KO this turn that lands before the enemy moves. */
function sureKO(a: Analysis) {
  const first = a.iMoveFirst === true;
  return a.myMoves.find((m) => first && m.category !== "Status" && m.ofCurrent[0] >= a.enemy.hp);
}

const HEALING = new Set(["Pain Split", "Recover", "Roost", "Synthesis", "Moonlight", "Morning Sun", "Rest", "Slack Off",
  "Soft-Boiled", "Milk Drink", "Wish", "Shore Up", "Strength Sap", "Leech Seed", "Giga Drain", "Drain Punch", "Horn Leech", "Aqua Ring", "Ingrain"]);
/** Enemy can undo chip damage, and our best move needs 3+ hits. */
const stalled = (a: Analysis) => a.enemyMoves.some((m) => HEALING.has(m.move)) && (a.myMoves[0]?.pctMax[0] ?? 0) < 50;

export function fallbackAdvice(a: Analysis, nuzlocke: boolean): Advice {
  const base = { model: "calculator", ms: 0 };
  if (a.swap && (stalled(a) || a.enemyMoves.every((m) => m.category === "Status")) && !sureKO(a))
    return { ...base, action: "switch", choice: a.swap.to, reason: a.swap.reason, alternative: a.myMoves[0]?.move ?? "–" };
  const ko = sureKO(a);
  if (ko) return { ...base, action: "move", choice: ko.move, reason: `${ko.move} KOs before ${a.enemy.name} can move (${ko.pctMax[0]}%+ vs ${a.enemy.hpPercent}% left).`, alternative: "–" };
  const danger = a.koRisk.maxRoll || (nuzlocke && a.koRisk.withCrit);
  const safe = a.switches
    .filter((s) => !switchKills(a, s.name, nuzlocke))
    .sort((x, y) => (x.takesWorst?.pctMax[1] ?? 0) - (y.takesWorst?.pctMax[1] ?? 0))[0];
  if (danger && safe) return { ...base, action: "switch", choice: safe.name, reason: `${a.me.name} can be KO'd this turn; ${safe.name} takes at most ${safe.takesWorst?.pctMax[1] ?? 0}% coming in.`, alternative: a.myMoves[0]?.move ?? "–" };
  const best = a.myMoves[0];
  return { ...base, action: "move", choice: best?.move ?? "–",
    reason: danger ? `No safe switch exists, so hit as hard as possible: ${best?.move} does ${best?.pctMax.join("–")}%.`
      : `${a.me.name} survives ${a.enemy.name}'s best hit${nuzlocke ? " even with a crit" : ""}, so attack: ${best?.move} does ${best?.pctMax.join("–")}%.`,
    alternative: a.swap ? `Switch to ${a.swap.to}` : "–" };
}

/** Returns a warning when the advice contradicts the numbers, or null if it checks out. */
export function checkAdvice(adv: Advice, a: Analysis, nuzlocke: boolean): string | null {
  if (adv.action === "switch") {
    const k = switchKills(a, adv.choice, nuzlocke);
    if (k) return `Unsafe: ${adv.choice} can be KO'd switching in (${k.move} does up to ${k.worst}%${nuzlocke ? ", more with a crit" : ""}).`;
    if (!a.switches.some((s) => s.name === adv.choice)) return `${adv.choice} isn't an available switch-in.`;
  }
  if (adv.action === "move" && stalled(a) && a.swap)
    return `${a.enemy.name} can heal (${a.enemyMoves.find((m) => HEALING.has(m.move))?.move}), so ${adv.choice} (${a.myMoves.find((m) => m.move === adv.choice)?.pctMax.join("–") ?? "?"}%) won't keep up. Switch to ${a.swap.to} instead.`;
  if (adv.action === "move") {
    const danger = a.koRisk.maxRoll || (nuzlocke && a.koRisk.withCrit);
    const mv = a.myMoves.find((m) => m.move === adv.choice);
    if (!mv) return `${adv.choice} isn't one of ${a.me.name}'s moves.`;
    if (danger && !(a.iMoveFirst === true && mv.ofCurrent[0] >= a.enemy.hp))
      return `Risky: ${a.enemy.name}'s ${a.koRisk.move} can KO ${a.me.name} this turn, and ${adv.choice} doesn't surely KO first.`;
  }
  return null;
}
