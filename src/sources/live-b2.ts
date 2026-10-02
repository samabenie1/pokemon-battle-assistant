// Live battle state for Pokémon Black 2 / White 2 running in melonDS (PBA_GAME=b2).
// Produces the same LiveSnapshot the Sword/Shield reader does, so the server and engine are shared.
//
// Layout (NDS-Ironmon-Tracker offsets, verified in melonDS on 09-30 in a wild battle):
// - Party: *MAIN_POINTER + 0x19728, 6 × 220-byte PK5 (overworld copy; HP there is current between battles).
// - In battle, *MAIN_POINTER + 0x526A8 holds 7 battler pointers per side (player at +i*4, enemy at +0x1C + i*4).
//   The first entries are the Pokémon on the field (1 in singles, 2 in doubles). Each battler struct has live
//   HP (+0x10, max +0x0E), stats, stat stages (+0xFC: Atk Def SpA SpD Spe Acc Eva, 6 = neutral) and moves with
//   live PP (+0x104, 14 bytes each), plus a pointer to its PK5 at +0.
// - The enemy's own PK5 party copy (+0x53B70) keeps its battle-start HP, so live HP always comes from battlers.
// - Bag (PKHeX SAV5 pouch layout): items pouch at +0x18D20 (310 × u16 id, u16 count), medicine at +0x194F8 (48).
import { MelonDS } from "../reader/melonds.ts";
import { moveName, speciesName } from "../names.ts";
import { B2 } from "../offsets/b2.ts";
import { readPersonal, setHMMoves } from "../offsets/b2rom.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { decrypt, parse, SIZE_PARTY } from "../pk5.ts";
import type { Boosts, Mon } from "../pk8.ts";
import type { BattleMon, LiveSnapshot } from "./live.ts";

const BATTLERS_PER_SIDE = 7;
const ITEMS_POUCH = 0x18d20, ITEMS_SLOTS = 310;
const MEDICINE_POUCH = 0x194f8, MEDICINE_SLOTS = 48;
const TM_POUCH = 0x19344, TM_SLOTS = 109; // verified 10-01 (TMs + HMs, item ids 328-425 / 618-620)
// The TM/HM move table in the (decompressed) arm9: this prefix, then 101 × u16 move ids (TM01-92, HM01-06, TM93-95).
// UPR's Gen5RomHandler uses the same marker. Randomized in this ROM, so it's read live.
const TM_TABLE_PREFIX = Buffer.from("87038803", "hex");
const BALL_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 492, 493, 494, 495, 496, 497, 498, 499, 576]);

export class B2Reader {
  private ds = new MelonDS();
  private base = 0;
  private lastPP = new Map<number, number[]>(); // by PID
  private lastFoePP = new Map<number, number[]>();
  private participants = new Set<number>();
  private sig = "";
  private counter = 0;
  private inBattle = false;

  private connected() {
    if (this.ds.pid && this.base) {
      try {
        // Still the same melonDS process with a Black 2 / White 2 cartridge loaded?
        if (this.ds.u32(0x3ffe0c) === Buffer.from(this.ds.gameCode, "latin1").readUInt32LE(0)) {
          this.base = this.ds.ptr(B2.MAIN_POINTER);
          if (this.base) return true;
        }
      } catch { /* melonDS closed */ }
    }
    if (!this.ds.connect() || !B2.gameCodes[this.ds.gameCode]) return false;
    this.base = this.ds.ptr(B2.MAIN_POINTER);
    return this.base !== 0;
  }

  private pkm(off: number): Mon | null {
    if (!off) return null;
    const d = decrypt(this.ds.bytes(off, SIZE_PARTY));
    if (!d) return null;
    const m = parse(d);
    return m.species > 0 && m.species <= 649 ? m : null;
  }

  /** One battler: its PK5 plus the live battle values (HP, moves/PP, stat stages). */
  private battler(b: number): BattleMon | null {
    if (!b) return null;
    const bt = B2.battler;
    const m = this.pkm(this.ds.ptr(b + bt.pkm));
    if (!m) return null;
    const maxHP = this.ds.u16(b + bt.maxHP), hp = this.ds.u16(b + bt.curHP);
    if (!maxHP || hp > maxHP) return null;
    const moves: number[] = [], pp: number[] = [];
    for (let i = 0; i < 4; i++) {
      const o = b + bt.moves + i * bt.moveStride;
      moves.push(this.ds.u16(o));
      pp.push(this.ds.u8(o + 2));
    }
    const st = this.ds.bytes(b + bt.statStages, 7);
    const boosts: Boosts | undefined = [...st].every((x) => x <= 12)
      ? { atk: st[0] - 6, def: st[1] - 6, spa: st[2] - 6, spd: st[3] - 6, spe: st[4] - 6, accuracy: st[5] - 6, evasion: st[6] - 6 }
      : undefined;
    // The PK5 copy's status isn't updated mid-battle; rebuild it (PK5 bit layout) from the live condition slots.
    const cond = [0, 1, 2, 3, 4].map((i) => this.ds.u32(b + bt.status + i * 4));
    const [par, slp, frz, brn, psn] = cond.map((c) => (c & 7) !== 0);
    const status = slp ? Math.min(7, Math.max(1, cond[1] >>> 3)) : psn ? 0x08 : brn ? 0x10 : frz ? 0x20 : par ? 0x40 : 0;
    return { ...m, status, hp, maxHP, moves: moves.some(Boolean) ? moves : m.moves, pp: moves.some(Boolean) ? pp : m.pp, boosts };
  }

  private side(offset: number): BattleMon[] {
    const out: BattleMon[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < BATTLERS_PER_SIDE; i++) {
      const b = this.ds.ptr(this.base + B2.mainBattleDataPtr + offset + i * 4);
      if (!b) break;
      const m = this.battler(b);
      if (m && !seen.has(m.ec)) { seen.add(m.ec); out.push(m); }
    }
    return out;
  }

  /** Diagnostic: raw battler condition slots (+0x20: par slp frz brn psn …) vs the PK5 status for both actives. */
  debugStatus() {
    const out: string[] = [];
    for (const [side, off] of [["me", 0], ["foe", B2.enemyBattlerOffset]] as const) {
      const b = this.ds.ptr(this.base + B2.mainBattleDataPtr + off);
      const pk = b ? this.pkm(this.ds.ptr(b + B2.battler.pkm)) : null;
      if (b) out.push(`${side}:bt20=${this.ds.bytes(b + 0x20, 12).toString("hex")} pk=${pk?.status ?? "?"}`);
    }
    return `{${out.join(" ")}}`;
  }

  /** Diagnostic: every pointer slot after mainBattleDataPtr (4 clients × 7), with species/HP/OT. Used to find
   *  where an AI ally's Pokémon live in partner (multi) battles, which aren't mapped yet. */
  debugBattlers(): string[] {
    const out: string[] = [];
    for (let i = 0; i < 28; i++) {
      const b = this.ds.ptr(this.base + B2.mainBattleDataPtr + i * 4);
      const m = b ? this.battler(b) : null;
      if (m) out.push(`[${i}] +0x${(i * 4).toString(16)} ${speciesName(m.species)} ${m.hp}/${m.maxHP} OT=${m.ot} TID=${m.tid}`);
    }
    return out;
  }

  private party(): Mon[] {
    const count = Math.min(6, this.ds.u32(this.base + B2.partyCount));
    const party: Mon[] = [];
    for (let i = 0; i < count; i++) {
      const m = this.pkm(this.base + B2.party + i * SIZE_PARTY);
      if (m) party.push(m);
    }
    return party;
  }

  poll(): (LiveSnapshot & { trainer: boolean; trainerId?: number }) | null {
    if (!this.connected()) return null;
    const party = this.party();
    const status = this.ds.u16(B2.battleStatus);
    const inBattle = status === 0x2100 || status === 0x2101;
    const empty = {
      inBattle: false, counter: 0, party, wild: null, wildEC: 0, activeEC: 0, participants: new Set<number>(), enemyTeam: [],
      foeFieldEC: null, double: false, myActives: [], foeActives: [], battleParty: [], used: [], trainer: false,
    };
    if (!inBattle) {
      if (this.inBattle) { this.participants.clear(); this.lastPP.clear(); this.lastFoePP.clear(); }
      this.inBattle = false;
      return empty;
    }
    this.inBattle = true;

    const mine = this.side(0);
    const foes = this.side(B2.enemyBattlerOffset);
    if (!mine.length || !foes.length) return { ...empty, inBattle: true }; // battle still setting up

    // Doubles: the first two battlers of each side are on the field. Triple/rotation battles are
    // read as doubles (the first two), which is the best the engine supports.
    const flag = this.ds.u8(this.base + B2.doubleTripleFlag);
    const nActive = flag === 0 ? 1 : 2;
    const double = nActive === 2 && mine.length >= 2 && foes.length >= 2;
    const me = mine[0];
    this.participants.add(me.ec);
    if (double) this.participants.add(mine[1].ec);

    // Moves I just used: PP drops on my Pokémon on the field.
    const used: [number, number][] = [];
    for (const m of mine.slice(0, nActive)) {
      const prev = this.lastPP.get(m.ec);
      if (prev) m.pp.forEach((p, i) => { if (m.moves[i] && p < prev[i]) used.push([m.species, m.moves[i]]); });
      this.lastPP.set(m.ec, [...m.pp]);
    }

    // Moves the foe just used (PP drops), e.g. Bide, which the damage calc can't see coming.
    const foeUsed: number[] = [];
    for (const m of foes.slice(0, nActive)) {
      const prev = this.lastFoePP.get(m.ec);
      if (prev) m.pp.forEach((p, i) => { if (m.moves[i] && p < prev[i]) foeUsed.push(m.moves[i]); });
      this.lastFoePP.set(m.ec, [...m.pp]);
    }

    // No battle step counter is known for Gen 5: "counter" changes whenever the visible battle state does,
    // so the server waits until it's been still for a moment (the game waiting for input) before advising.
    const sig = [...mine, ...foes].map((m) => `${m.ec}:${m.hp}:${m.status}:${m.pp.join(",")}:${Object.values(m.boosts ?? {}).join(",")}`).join("|");
    if (sig !== this.sig) { this.sig = sig; this.counter = (this.counter + 1) & 0xff || 1; }

    return {
      inBattle: true, counter: this.counter, party, wild: null, wildEC: 0,
      active: { species: me.species, hp: me.hp, maxHP: me.maxHP! },
      activeEC: me.ec, participants: new Set(this.participants),
      enemyTeam: foes as (Mon & { maxHP: number })[],
      foeFieldEC: foes[0].ec,
      double, myActives: double ? [mine[0].ec, mine[1].ec] : [me.ec], foeActives: double ? [foes[0].ec, foes[1].ec] : [foes[0].ec],
      battleParty: mine, used, foeUsed,
      trainer: this.ds.u16(this.base + B2.enemyTrainerID) !== 0,
      trainerId: this.ds.u16(this.base + B2.enemyTrainerID),
    };
  }

  private pouch(off: number, slots: number) {
    const buf = this.ds.bytes(this.base + off, slots * 4);
    const out: { id: number; count: number }[] = [];
    for (let i = 0; i < slots; i++) {
      const id = buf.readUInt16LE(i * 4), count = buf.readUInt16LE(i * 4 + 2);
      if (id === 0) break;
      if (count > 0 && count <= 999) out.push({ id, count });
    }
    return out;
  }

  balls() { return this.pouch(ITEMS_POUCH, ITEMS_SLOTS).filter((i) => BALL_IDS.has(i.id)); }
  medicine() { return this.pouch(MEDICINE_POUCH, MEDICINE_SLOTS); }
  battleItems() { return this.pouch(ITEMS_POUCH, ITEMS_SLOTS); } // Poké Doll (63) lives in the items pouch
  generalItems() { return this.pouch(ITEMS_POUCH, ITEMS_SLOTS); }
  machines() { return this.pouch(TM_POUCH, TM_SLOTS); }

  private tmCache?: { pid: number; moves: number[]; compat: Buffer[] | null; catchRate: number[] | null };
  /** TM/HM moves (from RAM), per-species TM compatibility and catch rates (from the ROM file melonDS is running). */
  machineData() {
    if (!this.connected()) return null;
    if (this.tmCache?.pid === this.ds.pid) return this.tmCache;
    const ram = this.ds.bytes(0, 0x200000);
    const at = ram.indexOf(TM_TABLE_PREFIX);
    if (at < 0) return null;
    const moves = Array.from({ length: 101 }, (_, i) => ram.readUInt16LE(at + 4 + i * 2));
    setHMMoves(moves.slice(92, 98).map(moveName));
    let compat: Buffer[] | null = null, catchRate: number[] | null = null;
    // The ROM path: PBA_ROM, else melonDS's command line, else the newest entry in its Recent ROMs list.
    const recent = () => { try {
      return /RecentROM = \["([^"]+)"/.exec(readFileSync(`${homedir()}/.var/app/net.kuribo64.melonDS/config/melonDS/melonDS.toml`, "utf8"))?.[1];
    } catch { return undefined; } };
    const rom = process.env.PBA_ROM
      ?? readFileSync(`/proc/${this.ds.pid}/cmdline`, "utf8").split("\0").find((a) => /\.nds$/i.test(a)) ?? recent();
    try { if (rom && readFileSync(rom).toString("latin1", 0x0c, 0x10) === this.ds.gameCode) ({ compat, catchRate } = readPersonal(rom)); } catch (e) { console.log("[tm]", (e as Error).message); }
    console.log(`[tm] TM table at 0x${at.toString(16)}, compatibility ${compat ? `from ${rom}` : "UNKNOWN"}`);
    this.tmCache = { pid: this.ds.pid, moves, compat, catchRate };
    return this.tmCache;
  }
  /** Money (save Trainer2 block: u32 money, then the badge byte). */
  money() { return this.connected() ? this.ds.u32(this.base + 0x21a20) : 0; }
  /** The shop's buy list while a Poké Mart menu is open, else null. In RAM it's 8-byte records
   *  {u16 item, u16 0, u16 price, u16 0} (found 10-01 at 0x24b628; this shop's stock is randomized in Sam's ROM).
   *  Found by shape: 4-40 such records in a row, distinct items, prices multiples of 10. */
  shop(): { id: number; price: number }[] | null {
    if (!this.connected()) return null;
    const ram = this.ds.bytes(0, 0x400000);
    const ok = (o: number) => {
      if (o < 0) return false;
      const it = ram.readUInt16LE(o), pr = ram.readUInt16LE(o + 4);
      return it > 0 && it < 640 && ram.readUInt16LE(o + 2) === 0 && ram.readUInt16LE(o + 6) === 0 && pr <= 50000 && pr % 10 === 0;
    };
    for (let o = 0; o < ram.length - 64; o += 4) {
      if (!ok(o) || ok(o - 8)) continue;
      let n = 0;
      while (ok(o + n * 8)) n++;
      if (n < 4 || n > 40) continue;
      const list = Array.from({ length: n }, (_, i) => ({ id: ram.readUInt16LE(o + i * 8), price: ram.readUInt16LE(o + i * 8 + 4) }));
      if (new Set(list.map((x) => x.id)).size === n && list.some((x) => x.price >= 100)) return list;
    }
    return null;
  }
  /** Number of gym badges (one bit each). */
  badges() { return this.connected() ? [...Array(8).keys()].filter((i) => this.ds.u8(this.base + B2.badges) >> i & 1).length : 0; }
  /** Species whose (randomized) ability the player knows: the current party. PC boxes aren't read yet. */
  ownedSpecies() {
    return new Set(this.connected() ? this.party().map((m) => m.species) : []);
  }
}
