// Inferring a foe's hidden ability from what visibly happened in battle (Sam, 10-06: "are you not able to infer the
// ability?"). The real (randomized) ability is in RAM, but it must stay hidden until Sam could have learned it.
// So each check below asks: did something happen on screen that only this ability explains? If yes, the ability
// counts as revealed, the same as Sam tapping "I saw its ability". Abilities with no visible effect stay hidden.
import { Generations, Move } from "@smogon/calc";
import { GAME } from "../game.ts";
import { abilityName, moveAccuracy, moveName } from "../names.ts";
import type { Mon } from "../pk8.ts";

const gen = Generations.get(GAME.gen);

/** Gen 5 shows a battle message for these as soon as the Pokémon enters. */
const ON_ENTRY = new Set(["Intimidate", "Drizzle", "Drought", "Sand Stream", "Snow Warning", "Pressure", "Mold Breaker",
  "Teravolt", "Turboblaze", "Forewarn", "Trace", "Imposter", "Slow Start", "Download"]);
/** Frisk only announces when my Pokémon holds an item. */
const FRISK = "Frisk";
/** Moves of this type do nothing to it (or heal it / boost it). */
const IMMUNE: Record<string, string[]> = {
  "Water Absorb": ["Water"], "Storm Drain": ["Water"], "Dry Skin": ["Water"], "Volt Absorb": ["Electric"],
  "Lightning Rod": ["Electric"], "Motor Drive": ["Electric"], "Flash Fire": ["Fire"], "Sap Sipper": ["Grass"], "Levitate": ["Ground"],
};
/** Contact punishes the attacker: HP loss, or a status (one of these). */
const CONTACT_HP = new Set(["Rough Skin", "Iron Barbs"]);
const CONTACT_STATUS: Record<string, number[]> = { Static: [0x40], "Flame Body": [0x10], "Poison Point": [0x08, 0x80], "Effect Spore": [0x40, 0x08, 0x80, 1, 2, 3, 4, 5, 6, 7] };
/** The foe's own stat stages change by themselves (no move of its own): only the ability explains it. */
const SELF_STAGES = new Set(["Speed Boost", "Moody", "Defiant", "Justified", "Rattled", "Weak Armor", "Steadfast", "Moxie", "Anger Point"]);
/** Damage cut by the ability, and the move condition under which it applies. Revealed when the hit lands well short. */
const CUTS: Record<string, (type: string, superEff: boolean, foeFull: boolean) => boolean> = {
  "Thick Fat": (t) => t === "Fire" || t === "Ice", Heatproof: (t) => t === "Fire",
  Filter: (_t, se) => se, "Solid Rock": (_t, se) => se, Multiscale: (_t, _se, full) => full,
};

type Pending = { ec: number; ability: string; move: string; type: string; contact: boolean; hpBefore: number; full: boolean;
  myHPBefore: number; myStatusBefore: number; boostsBefore: string; at: number };

export class AbilityInference {
  private pending: Pending | null = null;
  private seenEntry = new Set<number>();
  private boostsPrev = new Map<number, string>();

  reset() { this.pending = null; this.seenEntry.clear(); this.boostsPrev.clear(); }

  /** A foe is on the field. Returns a reason if its ability just announced itself on entry. */
  entry(foe: Mon, myItem: number): string | null {
    if (this.seenEntry.has(foe.ec)) return null;
    this.seenEntry.add(foe.ec);
    const a = abilityName(foe.ability);
    if (ON_ENTRY.has(a)) return "announced on entry";
    if (a === FRISK && myItem) return "Frisk announced my held item";
    return null;
  }

  /** Singles, each poll: my moves just used (PP drops), the foe's moves just used, and both sides now. */
  observe(foe: Mon & { maxHP?: number }, me: Mon, myUsed: number[], foeUsed: number[]): string | null {
    const a = abilityName(foe.ability), now = Date.now();
    const stages = JSON.stringify(foe.boosts ?? {});
    const prevStages = this.boostsPrev.get(foe.ec);
    this.boostsPrev.set(foe.ec, stages);
    // Stat stages rising/falling with no status move of its own this turn.
    if (SELF_STAGES.has(a) && prevStages !== undefined && prevStages !== stages && !foeUsed.some((m) => new Move(gen, moveName(m)).category === "Status"))
      return "its stats changed on their own";
    for (const id of myUsed) {
      const mv = new Move(gen, moveName(id));
      if (mv.category === "Status") continue;
      this.pending = { ec: foe.ec, ability: a, move: mv.name, type: mv.type, contact: !!mv.flags?.contact, hpBefore: foe.hp, full: !!foe.maxHP && foe.hp === foe.maxHP,
        myHPBefore: me.hp, myStatusBefore: me.status, boostsBefore: stages, at: now };
    }
    const p = this.pending;
    if (!p || p.ec !== foe.ec) return null;
    if (now - p.at > 8_000) { this.pending = null; return null; }
    const dropped = foe.hp < p.hpBefore;
    // Immunities: it healed or got a boost from my move, or a sure-hit move did nothing at all.
    if (IMMUNE[a]?.includes(p.type)) {
      if (foe.hp > p.hpBefore || stages !== p.boostsBefore) { this.pending = null; return `${p.move} healed or boosted it`; }
      if (now - p.at > 5_000 && !dropped && moveAccuracy(p.move) >= 100) { this.pending = null; return `${p.move} had no effect`; }
      return null;
    }
    if (!dropped) return null;
    // Sturdy: from full HP, a hit left it at exactly 1.
    if (a === "Sturdy" && p.full && foe.hp === 1) { this.pending = null; return "it hung on at 1 HP from full"; }
    if (p.contact && CONTACT_HP.has(a) && me.hp < p.myHPBefore) { this.pending = null; return `${p.move} (contact) hurt me back`; }
    if (p.contact && CONTACT_STATUS[a] && me.status !== p.myStatusBefore && matchesStatus(me.status, CONTACT_STATUS[a])) { this.pending = null; return `${p.move} (contact) gave me a status`; }
    return null;
  }

  /** Damage calibration hook: observed/predicted for one of my hits. A big shortfall that only this ability explains. */
  shortfall(foe: Mon, move: string, ratio: number, superEff: boolean, foeWasFull: boolean): string | null {
    const a = abilityName(foe.ability), cut = CUTS[a];
    const type = new Move(gen, move).type;
    return cut && ratio < 0.75 && cut(type, superEff, foeWasFull) ? `${move} did only ${Math.round(ratio * 100)}% of the predicted damage` : null;
  }
}

function matchesStatus(status: number, kinds: number[]) { return kinds.some((k) => (k < 8 ? (status & 7) !== 0 : (status & k) !== 0)); }

/** Type effectiveness of a move against these defending types (e.g. 2 = super effective). */
export function effectiveness(move: string, defTypes: readonly string[]) {
  const t = gen.types.get(new Move(gen, move).type.toLowerCase() as never) as { effectiveness: Record<string, number> } | undefined;
  return defTypes.reduce((x, d) => x * (t?.effectiveness[d] ?? 1), 1);
}
