// Healing suggestions from the medicine pouch: in battle (when it beats attacking or
// switching) and between battles (top the team up before the next fight).
import type { Analysis } from "./calc.ts";

// HP restored per item (Gen 8). Revives are never suggested (fainted = gone in a Nuzlocke).
const HEALS: Record<number, { name: string; hp: number }> = {
  17: { name: "Potion", hp: 20 }, 26: { name: "Super Potion", hp: 60 }, 25: { name: "Hyper Potion", hp: 120 },
  24: { name: "Max Potion", hp: 9999 }, 23: { name: "Full Restore", hp: 9999 }, 30: { name: "Fresh Water", hp: 30 },
  31: { name: "Soda Pop", hp: 50 }, 32: { name: "Lemonade", hp: 70 }, 33: { name: "Moomoo Milk", hp: 100 },
  34: { name: "Energy Powder", hp: 60 }, 35: { name: "Energy Root", hp: 120 },
};

export interface Item { id: number; count: number }

// Status cures: item id → the calc status it fixes ("any" = Full Heal and friends).
const CURES: Record<number, { name: string; cures: string }> = {
  18: { name: "Antidote", cures: "psn" }, 19: { name: "Burn Heal", cures: "brn" }, 20: { name: "Ice Heal", cures: "frz" },
  21: { name: "Awakening", cures: "slp" }, 22: { name: "Paralyze Heal", cures: "par" }, 27: { name: "Full Heal", cures: "any" },
  36: { name: "Heal Powder", cures: "any" }, 54: { name: "Lava Cookie", cures: "any" },
};

/** The item that cures `status` (a specific cure first, then an all-round one). */
export function cureFor(status: string, items: Item[]) {
  if (!status) return null;
  const want = status === "tox" ? "psn" : status;
  const have = items.filter((i) => CURES[i.id] && i.count > 0).map((i) => ({ ...CURES[i.id], count: i.count }));
  return have.find((c) => c.cures === want) ?? have.find((c) => c.cures === "any") ?? null;
}
export interface MemberHP { name: string; hp: number; maxHP: number }

/** Smallest item that restores at least `need` HP (or the biggest available if none does). */
function pick(items: Item[], need: number) {
  const have = items.filter((i) => HEALS[i.id] && i.count > 0).map((i) => ({ ...HEALS[i.id], count: i.count }))
    .sort((a, b) => a.hp - b.hp);
  return have.find((h) => h.hp >= need) ?? have[have.length - 1];
}

/** In-battle: should the active Pokémon be healed this turn? */
export function battleHeal(a: Analysis, items: Item[], nuzlocke: boolean) {
  const { me } = a;
  const missing = me.maxHP - me.hp;
  const item = pick(items, missing);
  if (!item || missing <= 0) return null;
  const restored = Math.min(item.hp, missing);
  const hpAfter = me.hp + restored;
  // Healing gives the enemy a free hit, so it only helps if we're still ahead after it.
  const worstMaxHP = ((a.enemyMoves[0]?.pctMax[1] ?? 0) / 100) * me.maxHP;
  const crit = nuzlocke ? 1.5 : 1;
  const survivesAfterHeal = hpAfter - worstMaxHP * crit > 0;
  const outpaces = restored > worstMaxHP;
  const inDanger = a.koRisk.maxRoll || (nuzlocke && a.koRisk.withCrit) || me.hp / me.maxHP < 0.35;
  if (!inDanger || !survivesAfterHeal || !outpaces) return null;
  return {
    item: item.name, count: item.count, target: me.name, restored,
    reason: `${me.name} is at ${me.hp}/${me.maxHP}. ${item.name} restores ${restored} HP, more than ${a.enemyMoves[0]?.move ?? "the enemy"}'s max hit (${Math.round(worstMaxHP)}${nuzlocke ? `, ${Math.round(worstMaxHP * 1.5)} with a crit` : ""}).`,
  };
}

/** Between battles: who's below 70%, and the cheapest item that gets them close to full. */
export function topUp(team: MemberHP[], items: Item[]) {
  return team.filter((m) => m.hp > 0 && m.hp / m.maxHP < 0.7).map((m) => {
    const it = pick(items, m.maxHP - m.hp);
    return { name: m.name, hp: m.hp, maxHP: m.maxHP, item: it?.name ?? null };
  });
}

export function healItems(items: Item[]) {
  return items.filter((i) => HEALS[i.id] && i.count > 0).map((i) => ({ name: HEALS[i.id].name, count: i.count, hp: HEALS[i.id].hp }));
}
