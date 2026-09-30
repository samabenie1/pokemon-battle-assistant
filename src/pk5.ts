// Gen 5 (Black 2/White 2) Pokémon structure: decryption and field layout,
// ported from PKHeX.Core (PokeCrypto.DecryptArray45, PK5).
// Stored = 136 bytes (8-byte header + 4 shuffled 32-byte blocks), party = 220 (+84 bytes of live stats).
import { levelFromExp, type Mon } from "./pk8.ts";

export const SIZE_STORED = 136;
export const SIZE_PARTY = 220;
const BLOCK = 32;
// Block order for each shuffle value, as the letters ABCD mean in PKHeX.
const ORDERS = ["ABCD","ABDC","ACBD","ACDB","ADBC","ADCB","BACD","BADC","BCAD","BCDA","BDAC","BDCA",
  "CABD","CADB","CBAD","CBDA","CDAB","CDBA","DABC","DACB","DBAC","DBCA","DCAB","DCBA"];

function crypt(d: Buffer, start: number, end: number, seed: number) {
  for (let i = start; i < end; i += 2) {
    seed = (Math.imul(seed, 0x41c64e6d) + 0x6073) >>> 0;
    d.writeUInt16LE(d.readUInt16LE(i) ^ (seed >>> 16), i);
  }
}

/** Returns a decrypted, unshuffled copy, or null if the checksum doesn't match (empty slot / not a PKM). */
export function decrypt(enc: Buffer): Buffer | null {
  const d = Buffer.from(enc);
  const pid = d.readUInt32LE(0);
  const checksum = d.readUInt16LE(6);
  if (pid === 0 && checksum === 0) return null;
  crypt(d, 8, SIZE_STORED, checksum);
  if (d.length >= SIZE_PARTY) crypt(d, SIZE_STORED, SIZE_PARTY, pid);
  const order = ORDERS[((pid >>> 13) & 31) % 24];
  const src = Buffer.from(d.subarray(8, SIZE_STORED));
  for (let i = 0; i < 4; i++) {
    const from = order.indexOf("ABCD"[i]);
    src.copy(d, 8 + i * BLOCK, from * BLOCK, (from + 1) * BLOCK);
  }
  let sum = 0;
  for (let i = 8; i < SIZE_STORED; i += 2) sum = (sum + d.readUInt16LE(i)) & 0xffff;
  return sum === checksum ? d : null;
}

/** Parse a decrypted PK5 into the shared Mon shape (ec = PID, since Gen 5 has no encryption constant). */
export function parse(d: Buffer): Mon {
  const iv32 = d.readUInt32LE(0x38);
  const m: Mon = {
    ec: d.readUInt32LE(0), species: d.readUInt16LE(0x08), heldItem: d.readUInt16LE(0x0a),
    tid: d.readUInt16LE(0x0c), exp: d.readUInt32LE(0x10), ability: d[0x15],
    ot: d.subarray(0x68, 0x68 + 16).toString("utf16le").split("￿")[0].split("\0")[0],
    form: d[0x40] >> 3, nature: d[0x41],
    moves: [0x28, 0x2a, 0x2c, 0x2e].map((o) => d.readUInt16LE(o)),
    pp: [0x30, 0x31, 0x32, 0x33].map((o) => d[o]),
    evs: [0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d].map((o) => d[o]), // HP Atk Def Spe SpA SpD
    ivs: [0, 5, 10, 15, 20, 25].map((s) => (iv32 >>> s) & 31), // HP Atk Def Spe SpA SpD
    hp: 0, status: 0,
  };
  // Nickname: 11 UTF-16 chars at 0x48, 0xFFFF-terminated; only meaningful when the "nicknamed" IV bit is set.
  if (iv32 >>> 31) m.nickname = d.subarray(0x48, 0x48 + 22).toString("utf16le").split("\uffff")[0].split("\0")[0] || undefined;
  m.level = levelFromExp(m.species, m.exp);
  if (d.length >= SIZE_PARTY) {
    m.status = d.readUInt32LE(0x88);
    m.hp = d.readUInt16LE(0x8e);
    if (d[0x8c] === m.level) {
      m.stats = {
        hp: d.readUInt16LE(0x90), atk: d.readUInt16LE(0x92), def: d.readUInt16LE(0x94),
        spe: d.readUInt16LE(0x96), spa: d.readUInt16LE(0x98), spd: d.readUInt16LE(0x9a),
      };
    }
  }
  return m;
}
