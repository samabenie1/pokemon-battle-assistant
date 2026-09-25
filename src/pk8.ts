// Gen 8 (Sword/Shield) Pokémon structure: decryption and field layout,
import { readFileSync } from "node:fs";
// ported from PKHeX.Core (PokeCrypto.Decrypt8, G8PKM).
export const SIZE_STORED = 0x148;
export const SIZE_PARTY = 0x158;
const BLOCK = 0x50;
const BLOCK_POSITION = [
  0, 1, 2, 3, 0, 1, 3, 2, 0, 2, 1, 3, 0, 3, 1, 2, 0, 2, 3, 1, 0, 3, 2, 1, 1, 0, 2, 3, 1, 0, 3, 2,
  2, 0, 1, 3, 3, 0, 1, 2, 2, 0, 3, 1, 3, 0, 2, 1, 1, 2, 0, 3, 1, 3, 0, 2, 2, 1, 0, 3, 3, 1, 0, 2,
  2, 3, 0, 1, 3, 2, 0, 1, 1, 2, 3, 0, 1, 3, 2, 0, 2, 1, 3, 0, 3, 1, 2, 0, 2, 3, 1, 0, 3, 2, 1, 0,
  0, 1, 2, 3, 0, 1, 3, 2, 0, 2, 1, 3, 0, 3, 1, 2, 0, 2, 3, 1, 0, 3, 2, 1, 1, 0, 2, 3, 1, 0, 3, 2,
];

function crypt(d: Buffer, start: number, end: number, seed: number) {
  for (let i = start; i < end; i += 2) {
    seed = (Math.imul(seed, 0x41c64e6d) + 0x6073) >>> 0;
    d.writeUInt16LE(d.readUInt16LE(i) ^ (seed >>> 16), i);
  }
}

/** Returns a decrypted copy, or null if the checksum doesn't match. */
export function decrypt(enc: Buffer): Buffer | null {
  const d = Buffer.from(enc);
  const ec = d.readUInt32LE(0);
  if (ec === 0) return null;
  crypt(d, 8, SIZE_STORED, ec);
  if (d.length >= SIZE_PARTY) crypt(d, SIZE_STORED, SIZE_PARTY, ec);
  const sv = (ec >>> 13) & 31;
  const src = Buffer.from(d.subarray(8, SIZE_STORED));
  for (let i = 0; i < 4; i++) src.copy(d, 8 + i * BLOCK, BLOCK_POSITION[sv * 4 + i] * BLOCK, (BLOCK_POSITION[sv * 4 + i] + 1) * BLOCK);
  let sum = 0;
  for (let i = 8; i < SIZE_STORED; i += 2) sum = (sum + d.readUInt16LE(i)) & 0xffff;
  return sum === d.readUInt16LE(6) ? d : null;
}

export interface Mon {
  ec: number; species: number; exp: number; tid: number; ot: string; form: number; heldItem: number; ability: number; nature: number;
  moves: number[]; pp: number[]; hp: number; status: number;
  level?: number; stats?: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  evs: number[]; ivs: number[];
  /** Live in-battle stat stages (-6..+6), when read from a battle block. */
  boosts?: Boosts;
  /** Dynamaxed right now (detected from the live max HP roughly doubling). */
  dynamax?: boolean;
}

export interface Boosts { atk: number; def: number; spa: number; spd: number; spe: number; accuracy: number; evasion: number }

export function parse(d: Buffer): Mon {
  const iv32 = d.readUInt32LE(0x8c);
  const m: Mon = {
    ec: d.readUInt32LE(0), exp: d.readUInt32LE(0x10), tid: d.readUInt16LE(0x0c),
    ot: d.subarray(0xf8, 0xf8 + 26).toString("utf16le").split("\0")[0], species: d.readUInt16LE(0x08), form: d[0x24], heldItem: d.readUInt16LE(0x0a),
    ability: d.readUInt16LE(0x14), nature: d[0x21], // stat nature (mints) is what the damage calc uses
    moves: [0x72, 0x74, 0x76, 0x78].map((o) => d.readUInt16LE(o)),
    pp: [0x7a, 0x7b, 0x7c, 0x7d].map((o) => d[o]),
    hp: d.readUInt16LE(0x8a), status: d.readInt32LE(0x94),
    evs: [0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b].map((o) => d[o]), // HP Atk Def Spe SpA SpD
    ivs: [0, 5, 10, 15, 20, 25].map((s) => (iv32 >>> s) & 31), // HP Atk Def Spe SpA SpD
  };
  m.level = levelFromExp(m.species, d.readUInt32LE(0x10));
  if (d.length >= SIZE_PARTY && d[0x148] === m.level) {
    m.stats = {
      hp: d.readUInt16LE(0x14a), atk: d.readUInt16LE(0x14c), def: d.readUInt16LE(0x14e),
      spe: d.readUInt16LE(0x150), spa: d.readUInt16LE(0x152), spd: d.readUInt16LE(0x154),
    };
  }
  return m;
}

// Stored-format mons (wild slot, boxes) have no level byte: derive it from EXP.
const growth = JSON.parse(readFileSync(new URL("../data/growth.json", import.meta.url), "utf8")) as
  { rates: Record<string, number[]>; species: Record<string, string> };
/** EXP needed to reach `level` (table index level-1). */
export function expForLevel(species: number, level: number) {
  const table = growth.rates[growth.species[species] ?? "medium"];
  return table[Math.min(100, Math.max(1, level)) - 1];
}

export function levelFromExp(species: number, exp: number) {
  const table = growth.rates[growth.species[species] ?? "medium"];
  let lv = 1;
  while (lv < 100 && exp >= table[lv]) lv++;
  return lv;
}
