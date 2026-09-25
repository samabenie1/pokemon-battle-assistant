// Gen 8 (Sword/Shield) capture odds per ball, following
// https://www.dragonflycave.com/mechanics/gen-viii-capturing/
// Critical captures are ignored (needs Pokédex count), so odds are slightly conservative.
import { readFileSync } from "node:fs";
import { Generations } from "@smogon/calc";
import type { StatusName } from "@smogon/calc/dist/data/interface.js";

const gen = Generations.get(8);
const CATCH_RATE = JSON.parse(readFileSync(new URL("../../data/capture.json", import.meta.url), "utf8")) as Record<string, number>;

export const BALLS: Record<number, string> = {
  1: "Master Ball", 2: "Ultra Ball", 3: "Great Ball", 4: "Poké Ball", 6: "Net Ball", 7: "Dive Ball", 8: "Nest Ball",
  9: "Repeat Ball", 10: "Timer Ball", 11: "Luxury Ball", 12: "Premier Ball", 13: "Dusk Ball", 14: "Heal Ball", 15: "Quick Ball",
  492: "Fast Ball", 493: "Level Ball", 494: "Lure Ball", 495: "Heavy Ball", 496: "Love Ball", 497: "Friend Ball",
  498: "Moon Ball", 576: "Dream Ball", 851: "Beast Ball",
};

export interface CatchInput {
  speciesNum: number; speciesName: string; level: number; types: string[]; status: StatusName | "";
  maxHP: number; hpPercent: number; myLevel: number; turn: number; balls: { id: number; count: number }[];
}

export interface BallOdds { ball: string; count: number; chance: number; note?: string; }

export function catchOdds(c: CatchInput): { odds: BallOdds[]; levelPenalty: boolean } {
  const sp = gen.species.get(c.speciesName.toLowerCase().replace(/[^a-z0-9]/g, "") as never);
  const baseRate = CATCH_RATE[c.speciesNum] ?? 45;
  const M = c.maxHP, H = Math.max(1, Math.round(M * c.hpPercent / 100));
  const L = c.level < 21 ? (30 - c.level) / 10 : 1;
  const S = c.status === "slp" || c.status === "frz" ? 2.5 : c.status ? 1.5 : 1;
  const levelPenalty = c.myLevel < c.level; // assumes fewer than 8 badges
  const D = levelPenalty ? 410 / 4096 : 1;
  const hour = new Date().getHours(); // Eden follows the host clock by default

  const ballBonus = (id: number): [number, string?] => {
    switch (id) {
      case 1: return [Infinity];
      case 2: return [2];
      case 3: return [1.5];
      case 6: return c.types.some((t) => t === "Water" || t === "Bug") ? [3.5] : [1];
      case 7: return [1, "×3.5 only in water"];
      case 8: return [c.level < 30 ? (41 - c.level) / 10 : 1];
      case 9: return [1, "×3.5 if you've caught this species before"];
      case 10: return [Math.min(4, 1 + c.turn * 1229 / 4096)];
      case 13: return hour >= 19 || hour < 5 ? [3] : [1, "×3 at night or in caves"];
      case 15: return c.turn <= 1 ? [5] : [1];
      case 492: return [(sp?.baseStats.spe ?? 0) >= 100 ? 4 : 1];
      case 493: return [c.myLevel >= 4 * c.level ? 8 : c.myLevel >= 2 * c.level ? 4 : c.myLevel > c.level ? 2 : 1];
      case 494: return [1, "×4 when fishing"];
      case 496: return [1, "×8 vs same species, opposite gender"];
      case 498: return [1, "×4 on Moon Stone Pokémon"];
      case 576: return [c.status === "slp" ? 4 : 1];
      case 851: return [410 / 4096];
      default: return [1]; // Poké, Premier, Luxury, Heal, Friend, Heavy (weight handled below)
    }
  };

  const odds = c.balls.filter((b) => BALLS[b.id] && b.count > 0).map((b): BallOdds => {
    const [B, note] = ballBonus(b.id);
    if (B === Infinity) return { ball: BALLS[b.id], count: b.count, chance: 1 };
    let C = baseRate;
    if (b.id === 495) { // Heavy Ball adjusts the catch rate by weight
      const w = sp?.weightkg ?? 0;
      C = Math.max(1, C + (w >= 300 ? 30 : w >= 200 ? 20 : w >= 100 ? 0 : -20));
    }
    const X = ((3 * M - 2 * H) * C * B) / (3 * M) * L * S * D;
    const chance = X >= 255 ? 1 : Math.pow(Math.floor(65536 / Math.pow(255 / X, 3 / 16)) / 65536, 4);
    return { ball: BALLS[b.id], count: b.count, chance, note };
  });
  odds.sort((a, b) => b.chance - a.chance);
  return { odds, levelPenalty };
}
