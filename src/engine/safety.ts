// Guards around the LLM advice: a deterministic fallback (for timeouts/errors) and a
// checker that flags recommendations the damage numbers say are unsafe.
import type { Analysis } from "./calc.ts";
import type { Advice } from "./advisor.ts";
import { sameMon } from "../names.ts";

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
  if (a.between) {
    const next = a.enemy.name;
    const safest = [...a.switches].sort((x, y) => (x.takesWorst?.pctMax[1] ?? 0) - pct(x.hp) - ((y.takesWorst?.pctMax[1] ?? 0) - pct(y.hp)))[0];
    if (!a.swap && (a.koRisk.maxRoll || !a.activeMatchup.wins) && safest)
      return { ...base, action: "switch", choice: safest.name, reason: `Free switch before ${next} comes in: ${a.me.name} is in danger; ${safest.name} takes the least (up to ${safest.takesWorst?.pctMax[1] ?? 0}%).`, alternative: "Stay" };
    return a.swap
      ? { ...base, action: "switch", choice: a.swap.to, reason: `Free switch before ${next} comes in: ${a.swap.reason}`, alternative: "Stay" }
      : { ...base, action: "move", choice: "Stay", reason: a.activeMatchup.wins ? `${a.me.name} wins the matchup vs ${next}.` : `No clearly better switch-in vs ${next}.`, alternative: "–" };
  }
  if (a.swap && (stalled(a) || a.enemyMoves.every((m) => m.category === "Status")) && !sureKO(a))
    return { ...base, action: "switch", choice: a.swap.to, reason: a.swap.reason, alternative: a.myMoves[0]?.move ?? "–" };
  // Asleep/frozen: a move choice is likely wasted. Switch to a safe winner if there is one (switching keeps the
  // sleep counter, but the switch-in can act); otherwise pick the best move in case it wakes up.
  if (a.me.status === "slp" || a.me.status === "frz") {
    const out = a.switches.filter((s) => s.matchup.wins && !switchKills(a, s.name, nuzlocke))
      .sort((x, y) => (x.takesWorst?.pctMax[1] ?? 0) - (y.takesWorst?.pctMax[1] ?? 0))[0];
    if (out) return { ...base, action: "switch", choice: out.name, reason: `${a.me.name} is ${a.me.status === "slp" ? "asleep" : "frozen"}; ${out.name} wins the matchup and takes at most ${out.takesWorst?.pctMax[1] ?? 0}% coming in.`, alternative: a.myMoves[0]?.move ?? "–" };
  }
  const ko = sureKO(a);
  if (!ko && a.dynamaxOption?.recommend && a.dynamaxOption.best)
    return { ...base, action: "move", choice: `Dynamax: ${a.dynamaxOption.best.move}`, reason: a.dynamaxOption.recommend, alternative: a.myMoves[0]?.move ?? "–" };
  if (ko) return { ...base, action: "move", choice: ko.move, reason: `${ko.move} KOs before ${a.enemy.name} can move (${ko.pctMax[0]}%+ vs ${a.enemy.hpPercent}% left).`, alternative: "–" };
  const danger = a.koRisk.maxRoll || (nuzlocke && a.koRisk.withCrit);
  const winning = a.switches.filter((s) => s.matchup.wins && !switchKills(a, s.name, nuzlocke));
  // Wild battle in danger with no winning switch: just leave.
  if (danger && !winning.length && a.run)
    return { ...base, action: "run", choice: a.run.chance >= 1 ? "Run" : "Poké Doll",
      reason: `${a.me.name} is at KO risk and no switch wins; ${a.run.chance >= 1 ? "you're faster, so running always works" : `running is only ${Math.round(a.run.chance * 100)}% here, a Poké Doll always escapes`}.`, alternative: "Run" };
  const safe = a.switches
    .filter((s) => !switchKills(a, s.name, nuzlocke) && s.matchup.wins) // a switch that can't win just loses turns
    .sort((x, y) => (x.takesWorst?.pctMax[1] ?? 0) - (y.takesWorst?.pctMax[1] ?? 0))[0];
  if (danger && safe) return { ...base, action: "switch", choice: safe.name, reason: `${a.me.name} can be KO'd this turn; ${safe.name} takes at most ${safe.takesWorst?.pctMax[1] ?? 0}% coming in.`, alternative: a.myMoves[0]?.move ?? "–" };
  // Staying in is a sure KO and nothing is crit-proof: take the switch-in that survives a normal hit with the most room.
  const lessBad = a.koRisk.maxRoll ? a.switches
    .filter((s) => !switchKills(a, s.name, false) && s.matchup.wins)
    .sort((x, y) => (x.takesWorst?.pctMax[1] ?? 0) - pct(x.hp) - ((y.takesWorst?.pctMax[1] ?? 0) - pct(y.hp)))[0] : undefined;
  if (lessBad) return { ...base, action: "switch", choice: lessBad.name, reason: `${a.me.name} is KO'd if it stays. ${lessBad.name} survives a normal hit (takes up to ${lessBad.takesWorst?.pctMax[1] ?? 0}%); only a crit is a risk.`, alternative: a.myMoves[0]?.move ?? "–" };
  const best = a.myMoves[0];
  return { ...base, action: "move", choice: best?.move ?? "–",
    reason: danger ? `No safe switch exists, so hit as hard as possible: ${best?.move} does ${best?.pctMax.join("–")}%.`
      : `${a.me.name} survives ${a.enemy.name}'s best hit${nuzlocke ? " even with a crit" : ""}, so attack: ${best?.move} does ${best?.pctMax.join("–")}%.`,
    alternative: a.swap ? `Switch to ${a.swap.to}` : "–" };
}

/** Returns a warning when the advice contradicts the numbers, or null if it checks out. */
export function checkAdvice(adv: Advice, a: Analysis, nuzlocke: boolean): string | null {
  if (a.between && adv.choice === "Stay") return null;
  if (adv.action === "run") return a.run ? null : "You can't run from a trainer battle.";
  if (adv.action === "switch" && !a.between) {
    const k = switchKills(a, adv.choice, nuzlocke);
    // If staying in is a sure KO, a switch-in that survives a normal (non-crit) hit is still the better bet.
    if (k && a.koRisk.maxRoll && !switchKills(a, adv.choice, false)) return null;
    if (k) return `Unsafe: ${adv.choice} can be KO'd switching in (${k.move} does up to ${k.worst}%${nuzlocke ? ", more with a crit" : ""}).`;
    const sw = a.switches.find((s) => sameMon(s.name, adv.choice));
    if (!sw) return `${adv.choice} isn't an available switch-in.`;
    // A switch-in that loses the exchange just gets switched back out next turn (free hits for the foe).
    const danger = a.koRisk.maxRoll || (nuzlocke && a.koRisk.withCrit);
    if (!sw.matchup.wins && !danger)
      return `${adv.choice} loses the matchup vs ${a.enemy.name} (needs ${sw.matchup.myHits} hits, dies in ${sw.matchup.theirHits}), so it would just have to switch back out.`;
  }
  if (adv.action === "move" && stalled(a) && a.swap)
    return `${a.enemy.name} can heal (${a.enemyMoves.find((m) => HEALING.has(m.move))?.move}), so ${adv.choice} (${a.myMoves.find((m) => m.move === adv.choice)?.pctMax.join("–") ?? "?"}%) won't keep up. Switch to ${a.swap.to} instead.`;
  if (adv.action === "move") {
    const danger = a.koRisk.maxRoll || (nuzlocke && a.koRisk.withCrit);
    if (/dynamax/i.test(adv.choice)) return null; // Dynamax plays are checked against dynamaxOption, not myMoves
    const mv = a.myMoves.find((m) => m.move === adv.choice || m.maxMove === adv.choice);
    if (!mv) return `${adv.choice} isn't one of ${a.me.name}'s moves.`;
    const winningSwitch = a.switches.some((s) => s.matchup.wins && !switchKills(a, s.name, false));
    if (danger && winningSwitch && !(a.iMoveFirst === true && mv.ofCurrent[0] >= a.enemy.hp))
      return `Risky: ${a.enemy.name}'s ${a.koRisk.move} can KO ${a.me.name} this turn, and ${adv.choice} doesn't surely KO first.`;
  }
  return null;
}
