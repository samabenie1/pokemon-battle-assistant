// Live battle state straight from Eden's guest RAM (memfd:HostMemory),
// read with plain file reads: no debugger, no game pauses.
//
// What's known (09-25):
// - Party save copy: phys 0x450C68B0, 6 × PK8. Its HP only updates outside battle.
// - Wild slot (SysBot heap+0x8FEA3648) and the battle step counter (heap+0x8398A470)
//   sit at phys = heap offset + a per-boot shift (multiple of 0x20000000), so we calibrate it.
// - Battle counter: 1..0xFF during a battle (increments per event), 0 or garbage otherwise.
// - Active Pokémon: slot 0 of the in-battle party; live HP from the status record just before it.
// - Enemy live HP: NOT found yet, so the server estimates it.
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readdirSync, readlinkSync } from "node:fs";
import { decrypt, parse, SIZE_PARTY, type Boosts, type Mon } from "../pk8.ts";

const ECSCAN = new URL("../../native/ecscan", import.meta.url).pathname;
const PARTY = 0x450c68b0, WILD = 0x8fea3648, COUNTER = 0x8398a470;
// Poké Ball pouch in the save block (identity-mapped like the party): u32 per slot,
// item id = bits 0-10, count = bits 15-24 (PKHeX InventoryItem8).
const BALL_POUCH = 0x45067b88, BALL_SLOTS = 32;
const MEDICINE_POUCH = 0x45067a98, MEDICINE_SLOTS = 60; // same slot format, right before the balls
// PC boxes (SysBot BoxStartOffset): 32 boxes × 30 slots, 0x158 bytes per slot.
const BOXES = 0x45075880, BOX_COUNT = 32, BOX_SLOT = 0x158;
// In-battle party, one 0x7A0-byte block per party slot (party order):
//   +0x000 status record: u16 [species, maxHP, curHP, heldItem, 0, ability, slot<<8 | level]
//          curHP is live for every slot. No on-field flag is known yet, so the active
//          Pokémon is inferred: the lead at battle start, then whoever uses a move or takes damage.
//   +0x4E8 PK8 copy with live PP (its HP only syncs on switch-out)
const BATTLE_PARTY = 0x8fe9dac8, BATTLE_STRIDE = 0x7a0, STATUS = 0x8fe9d5e0;
// "Player's Pokémon on the field" record: u16 species at +0, u32 encryption constant at +0x10.
// Fixed heap offset (two copies); verified across wild and trainer battles by switch diffs.
const ON_FIELD = [0x910988b8, 0x91098b30];
// The opponent's twin record (same layout): found once (Hop's Machamp, sent out of order). Unconfirmed.
const FOE_ON_FIELD = 0x901988a0;
// Stat stages in each battle block: 7 bytes at +0x244 (Atk, Def, SpA, SpD, Spe, Acc, Eva), 6 = neutral.
// Verified: Oranguru's SpA went 6→8→10 with Nasty Plot; Salazzle's Atk was 7 from Intrepid Sword.
const BOOSTS = 0x244;
// The wild Pokémon uses the same block layout: its status record (live HP) sits 0x4E8 before its PK8.
const WILD_STATUS = WILD - 0x4e8;

function findEden(): { pid: number; mem: string } | null {
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith("/memfd:HostMemory")) return { pid: +pid, mem: `/proc/${pid}/fd/${fd}` };
      }
    } catch { /* not ours / vanished */ }
  }
  return null;
}

export type BattleMon = Mon & { maxHP?: number };

export interface LiveSnapshot {
  inBattle: boolean;
  counter: number;
  party: Mon[];
  wild: Mon | null;
  wildEC: number;
  active?: { species: number; hp: number; maxHP: number };
  /** EC of the Pokémon on the field, and everyone who's been out this battle (full EXP). */
  activeEC: number;
  participants: Set<number>;
  /** Live HP of the wild Pokémon, when its status record matches the wild slot. */
  wildHP?: { hp: number; maxHP: number };
  /** Opponent team: the wild slot is slot 0 of the opponent's party blocks (a trainer has more). */
  enemyTeam: (Mon & { maxHP: number })[];
  /** EC of the opponent's Pokémon on the field, if its on-field record names a team member. */
  foeFieldEC: number | null;
  /** In-battle party in party order, with live HP from the status records. */
  battleParty: BattleMon[];
  /** Moves whose PP dropped since the previous poll: [species, moveId]. */
  used: [number, number][];
}

export class LiveReader {
  private fd = -1;
  private mem = "";
  private pid = 0;
  private shift: number | null = null;
  private scanning = false;
  private scanAt = 0;
  private lastPP = new Map<number, number[]>(); // by encryption constant
  private lastHP = new Map<number, number>();
  private activeEC = 0;
  private participants = new Set<number>();


  connect() {
    const e = findEden();
    if (!e) return false;
    this.mem = e.mem;
    this.pid = e.pid;
    this.fd = openSync(e.mem, "r");
    this.shift = null;
    return true;
  }

  private boosts(blockAddr: number): Boosts | undefined {
    const b = this.read(blockAddr + BOOSTS, 7);
    if ([...b].some((x) => x > 12)) return undefined; // not a live battle block
    const st = (k: number) => b[k] - 6;
    return { atk: st(0), def: st(1), spa: st(2), spd: st(3), spe: st(4), accuracy: st(5), evasion: st(6) };
  }

  private read(off: number, len: number) {
    const b = Buffer.alloc(len);
    readSync(this.fd, b, 0, len, off);
    return b;
  }

  /** Is the battle data really at this shift? (the in-battle copy of party slot 0 must be the player's) */
  private validShift(shift: number, ecs: Set<number>) {
    const off = (BATTLE_PARTY + shift) % 0x100000000;
    const d = decrypt(this.read(off, SIZE_PARTY));
    if (!d || !ecs.has(d.readUInt32LE(0))) return false;
    return this.read((STATUS + shift) % 0x100000000, 2).readUInt16LE(0) === d.readUInt16LE(8);
  }

  /** Find where this boot put the battle data. It usually moves by a multiple of 0x20000000, but a
   *  game restart inside Eden can move it arbitrarily: then locate the player's party copies by
   *  their encryption constants (native/ecscan, ~2 s, in the background) and derive the shift. */
  private calibrate(ecs: Set<number>, partyOrder: number[]) {
    if (this.shift !== null && this.validShift(this.shift, ecs)) return;
    for (let k = 0; k < 8; k++) if (this.validShift(k * 0x20000000, ecs)) { this.shift = k * 0x20000000; return; }
    if (this.scanning || Date.now() - this.scanAt < 10_000 || !ecs.size) return;
    this.scanning = true;
    this.scanAt = Date.now();
    execFile(ECSCAN, [this.mem, ...[...ecs].map((e) => e.toString(16))], { maxBuffer: 1 << 20 }, (err, out) => {
      this.scanning = false;
      if (err) return;
      const shifts = new Set<number>();
      for (const line of out.trim().split("\n").filter(Boolean)) {
        const [o, v] = line.split(" ");
        const slot = partyOrder.indexOf(parseInt(v, 16));
        if (slot < 0) continue;
        const shift = (parseInt(o, 16) - slot * BATTLE_STRIDE - BATTLE_PARTY + 0x200000000) % 0x100000000;
        if (this.validShift(shift, ecs)) shifts.add(shift);
      }
      // Several stale copies can exist: prefer the one whose battle counter says a battle is running.
      const live = [...shifts].find((sh) => { const c = this.read((COUNTER + sh) % 0x100000000, 4).readUInt32LE(0); return c >= 1 && c <= 0xff; });
      const pick = live ?? [...shifts].sort((a, b) => a - b)[0];
      if (pick !== undefined) this.shift = pick;
    });
  }

  private at(heapOff: number) { return (heapOff + this.shift!) % 0x100000000; }

  /** Species the player owns (party + PC boxes): their randomized abilities are visible in the summary. */
  ownedSpecies(): Set<number> {
    const owned = new Set(this.party().map((m) => m.species));
    const raw = this.read(BOXES, BOX_COUNT * 30 * BOX_SLOT);
    for (let i = 0; i < BOX_COUNT * 30; i++) {
      const d = decrypt(raw.subarray(i * BOX_SLOT, i * BOX_SLOT + 0x148));
      if (d) owned.add(d.readUInt16LE(8));
    }
    return owned;
  }

  balls() { return this.pouch(BALL_POUCH, BALL_SLOTS); }
  medicine() { return this.pouch(MEDICINE_POUCH, MEDICINE_SLOTS); }

  private pouch(off: number, slots: number): { id: number; count: number }[] {
    if (this.fd < 0) return [];
    const raw = this.read(off, slots * 4);
    const out: { id: number; count: number }[] = [];
    for (let i = 0; i < slots; i++) {
      const v = raw.readUInt32LE(i * 4), id = v & 0x7ff;
      if (!id) break;
      out.push({ id, count: (v >>> 15) & 0x3ff });
    }
    return out;
  }

  private partyECs() {
    const raw = this.read(PARTY, SIZE_PARTY * 6), ecs = new Set<number>();
    for (let i = 0; i < 6; i++) ecs.add(raw.readUInt32LE(i * SIZE_PARTY));
    ecs.delete(0);
    return ecs;
  }

  party(): Mon[] {
    const raw = this.read(PARTY, SIZE_PARTY * 6);
    const out: Mon[] = [];
    for (let i = 0; i < 6; i++) {
      const d = decrypt(raw.subarray(i * SIZE_PARTY, (i + 1) * SIZE_PARTY));
      if (d && d.readUInt16LE(8)) out.push(parse(d));
    }
    return out;
  }

  poll(): LiveSnapshot | null {
    // Our fd keeps a dead Eden's memory alive, so check the process itself.
    if (this.fd >= 0 && !existsSync(`/proc/${this.pid}`)) { closeSync(this.fd); this.fd = -1; }
    if (this.fd < 0 && !this.connect()) return null;
    const party = this.party();
    this.calibrate(this.partyECs(), party.map((m) => m.ec));
    if (this.shift === null) return { inBattle: false, counter: 0, party, wild: null, wildEC: 0, used: [], battleParty: [], activeEC: 0, participants: new Set(), enemyTeam: [], foeFieldEC: null };

    const counter = this.read(this.at(COUNTER), 4).readUInt32LE(0);
    const wildRaw = this.read(this.at(WILD), SIZE_PARTY);
    const wd = decrypt(wildRaw);
    const snap: LiveSnapshot = {
      inBattle: counter >= 1 && counter <= 0xff,
      counter, party,
      wild: wd ? parse(wd) : null,
      wildEC: wildRaw.readUInt32LE(0),
      used: [],
      battleParty: [],
      activeEC: 0,
      participants: this.participants,
      enemyTeam: [],
      foeFieldEC: null,
    };
    if (!snap.inBattle) { this.lastPP.clear(); this.lastHP.clear(); this.activeEC = 0; this.participants = new Set(); snap.participants = this.participants; return snap; }
    snap.battleParty = this.battleParty();
    for (let i = 0; i < 6; i++) {
      const d = decrypt(this.read(this.at(WILD + i * BATTLE_STRIDE), SIZE_PARTY));
      if (!d || !d.readUInt16LE(8)) break;
      const m = parse(d);
      const st = this.read(this.at(WILD_STATUS + i * BATTLE_STRIDE), 6);
      const [sp, max, cur] = [st.readUInt16LE(0), st.readUInt16LE(2), st.readUInt16LE(4)];
      if (sp !== m.species || max === 0 || cur > max) break; // not a live battle block
      snap.enemyTeam.push({ ...m, hp: cur, maxHP: max, boosts: this.boosts(this.at(WILD_STATUS + i * BATTLE_STRIDE)) });
    }
    {
      const rec = this.read(this.at(FOE_ON_FIELD), 0x14);
      const ec = rec.readUInt32LE(0x10);
      const m = snap.enemyTeam.find((x) => x.ec === ec);
      if (m && m.species === rec.readUInt16LE(0)) snap.foeFieldEC = ec;
    }
    if (snap.wild && snap.enemyTeam[0]?.species === snap.wild.species) snap.wildHP = { hp: snap.enemyTeam[0].hp, maxHP: snap.enemyTeam[0].maxHP };
    snap.used = this.ppDrops(snap.battleParty);
    const bp = snap.battleParty;
    // Only the Pokémon on the field uses moves or takes damage (singles).
    for (const [species] of snap.used) this.activeEC = bp.find((m) => m.species === species)?.ec ?? this.activeEC;
    for (const m of bp) {
      const prev = this.lastHP.get(m.ec);
      if (prev !== undefined && m.hp < prev) this.activeEC = m.ec;
      this.lastHP.set(m.ec, m.hp);
    }
    const fieldEC = this.fieldEC(bp);
    if (fieldEC !== null) this.activeEC = fieldEC;
    let onField = bp.find((m) => m.ec === this.activeEC && m.hp > 0);
    if (!onField) { onField = bp.find((m) => m.hp > 0); this.activeEC = onField?.ec ?? 0; } // battle start or a faint
    if (onField) {
      snap.active = { species: onField.species, hp: onField.hp, maxHP: onField.maxHP ?? onField.hp };
      snap.activeEC = onField.ec;
      this.participants.add(onField.ec);
    }
    return snap;
  }

  private battleParty(): BattleMon[] {
    const out: BattleMon[] = [];
    for (let i = 0; i < 6; i++) {
      const d = decrypt(this.read(this.at(BATTLE_PARTY + i * BATTLE_STRIDE), SIZE_PARTY));
      if (!d || !d.readUInt16LE(8)) continue;
      const m = parse(d);
      const st = this.read(this.at(STATUS + i * BATTLE_STRIDE), 8);
      const [sp, max, cur] = [st.readUInt16LE(0), st.readUInt16LE(2), st.readUInt16LE(4)];
      // Status: the PK8's (correct at battle start, only syncs on switch-out). Live status isn't decoded yet.
      out.push(sp === m.species && cur <= max ? { ...m, hp: cur, maxHP: max, boosts: this.boosts(this.at(STATUS + i * BATTLE_STRIDE)) } : m);
    }
    return out;
  }

  /** EC of the player's Pokémon on the field, if the on-field record names a party member. */
  private fieldEC(bp: Mon[]): number | null {
    const ecs = new Set(bp.map((m) => m.ec));
    for (const off of ON_FIELD) {
      const rec = this.read(this.at(off), 0x14);
      const ec = rec.readUInt32LE(0x10);
      if (ecs.has(ec) && bp.find((m) => m.ec === ec)?.species === rec.readUInt16LE(0)) return ec;
    }
    return null;
  }

  private ppDrops(bp: Mon[]): [number, number][] {
    const used: [number, number][] = [];
    for (const m of bp) {
      const prev = this.lastPP.get(m.ec);
      if (prev) m.pp.forEach((pp, k) => { if (pp < prev[k] && m.moves[k]) used.push([m.species, m.moves[k]]); });
      this.lastPP.set(m.ec, m.pp);
    }
    return used;
  }

}
