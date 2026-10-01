// TM/HM compatibility for Black 2, read from the ROM melonDS is running (it's randomized, so PokeAPI data is wrong).
// Personal data = NARC a/0/1/6 (file id 363 in IREO), one 76-byte entry per species; the TM/HM bitfield is the
// 13 bytes at +0x28: bits 0-91 = TM01-92, 92-97 = HM01-06, 98-100 = TM93-95 (the same order as the RAM TM table).
// Verified 10-01: clean-ROM Bulbasaur gives TM06/09/10/11… exactly as in the vanilla game.
import { readFileSync } from "node:fs";

const PERSONAL_FILE = 363;
const TM_BITS = 0x28;

/** species → bitfield of machine slots (0..100). */
export function readCompat(romPath: string): Buffer[] {
  const r = readFileSync(romPath);
  const fat = r.readUInt32LE(0x48);
  const start = r.readUInt32LE(fat + PERSONAL_FILE * 8), end = r.readUInt32LE(fat + PERSONAL_FILE * 8 + 4);
  const n = r.subarray(start, end);
  if (n.toString("latin1", 0, 4) !== "NARC") throw new Error(`${romPath}: personal NARC not found`);
  let p = n.readUInt16LE(0x0c);
  if (n.toString("latin1", p, p + 4) !== "BTAF") throw new Error("NARC: no BTAF");
  const count = n.readUInt16LE(p + 8);
  const entries = Array.from({ length: count }, (_, i) => [n.readUInt32LE(p + 12 + i * 8), n.readUInt32LE(p + 16 + i * 8)]);
  p += n.readUInt32LE(p + 4);
  p += n.readUInt32LE(p + 4); // BTNF
  const gmif = p + 8;
  return entries.map(([a]) => n.subarray(gmif + a + TM_BITS, gmif + a + TM_BITS + 13));
}

export const canLearn = (compat: Buffer[], species: number, slot: number) =>
  !!compat[species] && (compat[species][slot >> 3] >> (slot & 7) & 1) === 1;

/** Bag item id → machine slot (0..100), or -1. TM01-92 = 328-419, HM01-06 = 420-425, TM93-95 = 618-620. */
export function machineSlot(item: number) {
  if (item >= 328 && item <= 425) return item - 328;
  if (item >= 618 && item <= 620) return 98 + item - 618;
  return -1;
}

export const machineLabel = (slot: number) =>
  slot < 92 ? `TM${String(slot + 1).padStart(2, "0")}` : slot < 98 ? `HM0${slot - 91}` : `TM${slot - 5}`;
