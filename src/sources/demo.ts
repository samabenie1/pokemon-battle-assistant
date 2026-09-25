// Sample battle from the 09-25 session (Groudon vs a trainer's burned Shellos),
// used to exercise the calculator, advisor and page before live HP is decoded.
import type { Mon } from "../pk8.ts";
import { NATURES, abilityNum, moveNum, speciesNum } from "../names.ts";
import type { BattleState } from "../engine/calc.ts";

const PP: Record<string, number> = {};
function mon(species: string, level: number, nature: string, ability: string, moves: string[], hp: number, status = 0): Mon {
  return {
    ec: 0, exp: 0, tid: 0, ot: "", species: speciesNum(species), form: 0, heldItem: 0, ability: abilityNum(ability), nature: NATURES.indexOf(nature),
    moves: moves.map(moveNum), pp: moves.map((m) => PP[m] ?? 15), hp, status, level,
    evs: [0, 0, 0, 0, 0, 0], ivs: [20, 20, 20, 20, 20, 20],
  };
}

export function demoState(): BattleState {
  return {
    trainer: true,
    me: {
      active: mon("Groudon", 27, "Naughty", "Water Absorb", ["Earthquake", "Ancient Power", "Lava Plume", "Earth Power"], 84),
      bench: [
        mon("Poliwrath", 27, "Calm", "Speed Boost", ["Water Gun", "Hypnosis", "Body Slam", "Mud Shot"], 91),
        mon("Salazzle", 25, "Naive", "Intrepid Sword", ["Fire Lash", "Poison Gas", "Poison Fang", "Ember"], 73),
        mon("Vulpix", 23, "Bold", "Shed Skin", ["Tail Whip", "Disable", "Ice Shard", "Icy Wind"], 56),
        mon("Zamazenta", 23, "Serious", "Iron Fist", ["Howl", "Metal Claw", "Bite", "Slash"], 79),
        mon("Corsola", 23, "Gentle", "Mimicry", ["Tackle", "Ancient Power", "Water Gun", "Aqua Ring"], 67),
      ],
    },
    enemy: {
      active: mon("Shellos", 25, "Hardy", "Sticky Hold", ["Water Pulse", "Ancient Power", "Body Slam", "Recover"], 80, 0x10),
      hpPercent: 50,
      bench: [],
    },
  };
}
