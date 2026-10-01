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
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, readlinkSync } from "node:fs";
import { decrypt, parse, SIZE_PARTY, type Boosts, type Mon } from "../pk8.ts";

const ECSCAN = new URL("../../native/ecscan", import.meta.url).pathname;
const PARTY = 0x450c68b0, WILD = 0x8fea3648, COUNTER = 0x8398a470;
// Poké Ball pouch in the save block (identity-mapped like the party): u32 per slot,
// item id = bits 0-10, count = bits 15-24 (PKHeX InventoryItem8).
const BALL_POUCH = 0x45067b88, BALL_SLOTS = 32;
const MEDICINE_POUCH = 0x45067a98, MEDICINE_SLOTS = 60; // same slot format, right before the balls
// Other pouches (found by scanning the save block; same u32 slot format).
const GENERAL_POUCH = 0x45067d90, MACHINE_POUCH = 0x45068628;
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
// Confusion (2 samples, both sides): +0x18E counts confused turns; the condition slot at +0x50 is filled while confused.
const CONFUSION_TURNS = 0x18e, CONFUSION_SLOT = 0x50;
// The wild Pokémon uses the same block layout: its status record (live HP) sits 0x4E8 before its PK8.
const WILD_STATUS = WILD - 0x4e8;

function findEden(): { pid: number; mem: string } | null {
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      // Only Eden itself: other processes (e.g. a research tool) can hold an old Eden's memfd open.
      if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "eden") continue;
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
  /** Set by readers that know it directly (Black 2: the enemy trainer ID); otherwise the server infers it. */
  trainer?: boolean;
  /** Black 2: the enemy trainer's index in the game's trainer table (0 = wild). */
  trainerId?: number;
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
  /** Battle positions (0xF00018 apart): singles = [foe, me]; doubles = [foe, foe, me, me]. */
  double: boolean;
  myActives: number[];   // ECs
  foeActives: number[];  // ECs
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
  private counterWorks: number | null = null; // shift at which the battle counter was seen working
  private candidates = new Map<number, { sig: string; changedAt: number }>(); // valid battle copies
  // On-field records found by search (their fixed offsets aren't reliable across game resets).
  private myRecs: number[] = [];
  private foeRecs: number[] = [];
  private recLast = new Map<number, number>(); // record addr → EC last seen (a change = a switch-in)
  private recScanning = false;
  private recScanAt = 0;
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

  private confused(blockAddr: number) {
    const turns = this.read(blockAddr + CONFUSION_TURNS, 1)[0];
    const slot = this.read(blockAddr + CONFUSION_SLOT, 1)[0];
    return turns > 0 && turns <= 5 && slot !== 0 && slot !== 248;
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

  /** Is the battle data really at this shift? The player's blocks must line up exactly: consecutive valid
   *  blocks from slot 0 (PK8 decrypts, status species matches, distinct ECs), none just before slot 0, and
   *  most of them in the saved party (the save can lag behind team changes, so not all). */
  private validShift(shift: number, ecs: Set<number>) {
    const ecAt = (slot: number) => {
      const d = decrypt(this.read((BATTLE_PARTY + shift + slot * BATTLE_STRIDE + 0x100000000) % 0x100000000, SIZE_PARTY));
      if (!d || !d.readUInt16LE(8)) return null;
      const st = this.read((STATUS + shift + slot * BATTLE_STRIDE + 0x100000000) % 0x100000000, 2).readUInt16LE(0);
      return st === d.readUInt16LE(8) ? d.readUInt32LE(0) : null;
    };
    if (ecAt(-1) !== null) return false;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) { const ec = ecAt(i); if (ec === null || seen.includes(ec)) break; seen.push(ec); }
    const known = seen.filter((ec) => ecs.has(ec)).length;
    return seen.length >= 1 && known >= Math.ceil(seen.length / 2);
  }

  /** HP snapshot of both sides at a shift (identifies a copy's state). */
  private hpSig(sh: number) {
    const hp: string[] = [];
    for (const base of [STATUS, WILD_STATUS]) for (let i = 0; i < 6; i++) {
      const st = this.read((base + sh + i * BATTLE_STRIDE) % 0x100000000, 6);
      const [sp, max, cur] = [st.readUInt16LE(0), st.readUInt16LE(2), st.readUInt16LE(4)];
      hp.push(sp > 0 && sp <= 898 && cur <= max ? `${sp}:${cur}` : "-"); // skip unused slots (garbage)
    }
    return hp.join(",");
  }

  /** Among the known valid copies, switch to the one whose data changed most recently. */
  private followLive() {
    const now = Date.now();
    let best: [number, number] | null = null;
    for (const [sh, c] of this.candidates) {
      const sig = this.hpSig(sh);
      if (sig !== c.sig) { c.sig = sig; c.changedAt = now; }
      if (!best || c.changedAt > best[1]) best = [sh, c.changedAt];
    }
    if (best && best[1] > 0) this.shift = best[0];
  }

  private foeAlive() {
    for (let i = 0; i < 6; i++) {
      const st = this.read(this.at(WILD_STATUS + i * BATTLE_STRIDE), 6), sp = st.readUInt16LE(0);
      if (!sp || sp > 898) break;
      if (st.readUInt16LE(4) > 0) return true;
    }
    return false;
  }

  private counterAt(sh: number) { return this.read((COUNTER + sh) % 0x100000000, 4).readUInt32LE(0); }

  private calibrate(ecs: Set<number>, partyOrder: number[]) {
    this.followLive();
    // Among valid copies, the live battle is the one whose step counter is running: prefer it.
    const counterOk = (sh: number) => { const c = this.counterAt(sh); return c >= 1 && c <= 0xff; };
    if (this.shift !== null && !counterOk(this.shift)) {
      const better = [0, ...[1, 2, 3, 4, 5, 6, 7].map((k) => k * 0x20000000), ...this.candidates.keys()]
        .find((sh) => counterOk(sh) && this.validShift(sh, ecs));
      if (better !== undefined) this.shift = better;
    }
    // Re-vote every 15 s even when the current copy looks valid: it may have gone stale.
    if (this.shift !== null && this.validShift(this.shift, ecs) && Date.now() - this.scanAt < 15_000) return;
    if (this.shift === null) for (let k = 0; k < 8; k++) if (this.validShift(k * 0x20000000, ecs)) { this.shift = k * 0x20000000; break; }
    if (this.scanning || Date.now() - this.scanAt < 10_000 || !ecs.size) return;
    this.scanning = true;
    this.scanAt = Date.now();
    execFile(ECSCAN, [this.mem, ...[...ecs].map((e) => e.toString(16))], { maxBuffer: 1 << 20 }, (err, out) => {
      this.scanning = false;
      if (err) return;
      const shifts = new Set<number>();
      // The in-battle order can differ from the saved party order, so try every slot for each hit.
      for (const line of out.trim().split("\n").filter(Boolean)) {
        const addr = parseInt(line.split(" ")[0], 16);
        for (let slot = 0; slot < 6; slot++) {
          const shift = (addr - slot * BATTLE_STRIDE - BATTLE_PARTY + 0x200000000) % 0x100000000;
          if (this.validShift(shift, ecs)) shifts.add(shift);
        }
      }
      // Several copies exist and some are stale (left from earlier battles). The live battle keeps a few
      // identical copies, so vote: group copies by their HP snapshot (both sides) and take the biggest group.
      const sig = (sh: number) => this.hpSig(sh);
      const groups = new Map<string, number[]>();
      for (const sh of shifts) { const k = sig(sh); groups.set(k, [...(groups.get(k) ?? []), sh]); }
      // Biggest group; on a tie, the copy at the lowest address (live copies sat lowest in every fight so far).
      const phys = (sh: number) => (BATTLE_PARTY + sh) % 0x100000000;
      const minPhys = (g: number[]) => Math.min(...g.map(phys));
      const live = [...shifts].find((sh) => { const c = this.counterAt(sh); return c >= 1 && c <= 0xff; });
      const pick = live ?? [...groups.values()].sort((a, b) => b.length - a.length || minPhys(a) - minPhys(b))[0]
        ?.sort((a, b) => phys(a) - phys(b))[0];
      if (pick !== undefined && (this.shift === null || live !== undefined)) this.shift = pick;
      // Keep every candidate: each poll follows whichever copy changed most recently (stale ones don't change).
      const now = Date.now();
      this.candidates = new Map([...shifts].map((sh) => [sh, this.candidates.get(sh) ?? { sig: sig(sh), changedAt: 0 }]));
      if (pick !== undefined && ![...this.candidates.values()].some((c) => c.changedAt)) this.candidates.get(pick)!.changedAt = now;
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
  generalItems() { return this.pouch(GENERAL_POUCH, 400); }
  battleItems() { return this.pouch(0x45067c00, 100); }
  machines() { return this.pouch(MACHINE_POUCH, 400); }

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
    if (this.shift === null) return { inBattle: false, counter: 0, party, wild: null, wildEC: 0, used: [], battleParty: [], activeEC: 0, participants: new Set(), enemyTeam: [], foeFieldEC: null, double: false, myActives: [], foeActives: [] };

    const counter = this.read(this.at(COUNTER), 4).readUInt32LE(0);
    const wildRaw = this.read(this.at(WILD), SIZE_PARTY);
    const wd = decrypt(wildRaw);
    // The step counter doesn't always move with the rest of the battle region, so also accept
    // "my on-field record names a party member and the opponent's first block is live".
    const ecs = this.partyECs();
    const foe0 = this.read(this.at(WILD_STATUS), 6);
    const foeSp = foe0.readUInt16LE(0);
    // (Weaker than the counter: these blocks can linger after a battle ends.)
    const blocksLive = this.validShift(this.shift, ecs) && foeSp > 0 && foeSp <= 898 && foe0.readUInt16LE(4) <= foe0.readUInt16LE(2);
    // Once the step counter has been seen working at this shift, it alone decides (blocks linger after a
    // battle ends); if it never worked here (it doesn't always move with the rest), fall back to the blocks.
    const counterLive = counter >= 1 && counter <= 0xff;
    if (counterLive) this.counterWorks = this.shift;
    const snap: LiveSnapshot = {
      // A large (garbage) counter value only appears outside battles; 0 is ambiguous.
      // The counter isn't always at this shift (gym vs Gordie: garbage counter on a live copy), so the fallback
      // takes live blocks with any counter value, but ends once every foe block is at 0 HP.
      inBattle: this.counterWorks === this.shift ? counterLive : counterLive || (blocksLive && this.foeAlive()),
      counter, party,
      wild: wd ? parse(wd) : null,
      wildEC: wildRaw.readUInt32LE(0),
      used: [],
      battleParty: [],
      activeEC: 0,
      participants: this.participants,
      enemyTeam: [],
      foeFieldEC: null,
      double: false, myActives: [], foeActives: [],
    };
    if (!snap.inBattle) { this.lastPP.clear(); this.lastHP.clear(); this.activeEC = 0; this.participants = new Set(); snap.participants = this.participants; this.myRecs = []; this.foeRecs = []; this.recLast.clear(); return snap; }
    snap.battleParty = this.battleParty();
    // Opponent slots 0-5 = trainer 1, 6-11 = trainer 2 (double battles against two trainers).
    for (let i = 0; i < 12; i++) {
      const d = decrypt(this.read(this.at(WILD + i * BATTLE_STRIDE), SIZE_PARTY));
      if (!d || !d.readUInt16LE(8)) continue;
      const m = parse(d);
      const st = this.read(this.at(WILD_STATUS + i * BATTLE_STRIDE), 6);
      const [sp, max, cur] = [st.readUInt16LE(0), st.readUInt16LE(2), st.readUInt16LE(4)];
      if (sp !== m.species || max === 0 || cur > max) continue; // not a live battle block
      const blk = this.at(WILD_STATUS + i * BATTLE_STRIDE);
      snap.enemyTeam.push({ ...m, hp: cur, maxHP: max, boosts: this.boosts(blk), confused: this.confused(blk) });
    }
    snap.foeFieldEC = this.vote(this.foeRecs, snap.enemyTeam) ?? this.resolve([this.at(FOE_ON_FIELD)], snap.enemyTeam);
    // Trainer battle without a resolvable record: search (both sides) in the background.
    // Switches can create new records elsewhere, so re-search regularly (every ~6 s) during battles.
    if (snap.enemyTeam.length && (snap.foeFieldEC === null || !this.myRecs.length || Date.now() - this.recScanAt > 6000))
      this.scanRecords(snap.battleParty, snap.enemyTeam);
    this.readPositions(snap);
    // Battle positions are the most reliable "who's out" signal: override the older heuristics.
    const posEC = snap.myActives[0];
    const posMon = posEC !== undefined ? snap.battleParty.find((m) => m.ec === posEC && m.hp > 0) : undefined;
    if (posMon && !snap.double) {
      this.activeEC = posMon.ec;
      snap.activeEC = posMon.ec;
      snap.active = { species: posMon.species, hp: posMon.hp, maxHP: posMon.maxHP ?? posMon.hp };
      this.participants.add(posMon.ec);
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
    // Stale records from earlier turns/battles linger, so a record only counts when it CHANGES to one
    // of my Pokémon (a switch rewrites the live ones). Fixed-offset record as a secondary signal.
    // The player's live record sits exactly 0xF00018 after the opponent's (seen in two fights), which
    // picks it out from stale copies. Otherwise: a record that changes = a switch-in; then the fixed offset.
    const voted = this.vote(this.myRecs, bp);
    const paired = this.resolve(this.foeRecs.map((f) => f + 0xf00018), bp);
    const changed = this.changedTo(this.myRecs, bp);
    // Battle positions (read above) win when available; the rest are fallbacks.
    const fromPos = !snap.double && snap.myActives[0] !== undefined && bp.some((m) => m.ec === snap.myActives[0] && m.hp > 0) ? snap.myActives[0] : null;
    const switched = fromPos ?? changed ?? voted ?? paired;
    if (switched !== null) this.activeEC = switched;
    else if (!this.myRecs.length) { const f = this.fieldEC(bp); if (f !== null) this.activeEC = f; }
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
      const blk = this.at(STATUS + i * BATTLE_STRIDE);
      out.push(sp === m.species && cur <= max ? { ...m, hp: cur, maxHP: max, boosts: this.boosts(blk), confused: this.confused(blk) } : m);
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

  /** EC that one of the records just changed to (a switch-in), or null. */
  private changedTo(recs: number[], team: Mon[]): number | null {
    let hit: number | null = null;
    for (const a of recs) {
      const rec = this.read(a, 0x14), ec = rec.readUInt32LE(0x10);
      const prev = this.recLast.get(a);
      this.recLast.set(a, ec);
      const m = team.find((x) => x.ec === ec);
      if (prev !== undefined && prev !== ec && m && m.species === rec.readUInt16LE(0)) hit = ec;
    }
    return hit;
  }

  /** Read the battle-position records starting at the first foe record (position 0). */
  private readPositions(snap: LiveSnapshot) {
    const STEP = 0xf00018;
    for (const p0 of this.foeRecs) {
      const pos = [0, 1, 2, 3].map((k) => {
        const rec = this.read(p0 + k * STEP, 0x14), ec = rec.readUInt32LE(0x10), sp = rec.readUInt16LE(0);
        const foe = snap.enemyTeam.find((m) => m.ec === ec && m.species === sp);
        const mine = snap.battleParty.find((m) => m.ec === ec && m.species === sp);
        return foe ? { side: "foe", ec } : mine ? { side: "me", ec } : null;
      });
      if (pos[0]?.side !== "foe") continue;
      if (pos[1]?.side === "foe" && pos[2]?.side === "me") {
        snap.double = true;
        snap.foeActives = [pos[0].ec, pos[1].ec];
        snap.myActives = [pos[2].ec, pos[3]?.side === "me" ? pos[3].ec : null].filter((x): x is number => x !== null);
        return;
      }
      if (pos[1]?.side === "me") { snap.foeActives = [pos[0].ec]; snap.myActives = [pos[1].ec]; return; }
    }
  }

  /** Majority of the records that name a Pokémon in `team`. */
  private vote(recs: number[], team: Mon[]): number | null {
    const votes = new Map<number, number>();
    for (const a of recs) { const ec = this.resolve([a], team); if (ec !== null) votes.set(ec, (votes.get(ec) ?? 0) + 1); }
    return [...votes].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  }

  /** Read cached on-field records: the first one naming a Pokémon in `team` (species + EC must match). */
  private resolve(recs: number[], team: Mon[]): number | null {
    for (const a of recs) {
      const rec = this.read(a, 0x14);
      const m = team.find((x) => x.ec === rec.readUInt32LE(0x10));
      if (m && m.species === rec.readUInt16LE(0)) return m.ec;
    }
    return null;
  }

  /** Background search for on-field records: [u16 species … u32 EC at +0x10] naming either side's Pokémon. */
  private scanRecords(mine: Mon[], foes: Mon[]) {
    if (this.recScanning || Date.now() - this.recScanAt < 2500) return;
    this.recScanning = true;
    this.recScanAt = Date.now();
    const all = [...mine, ...foes];
    execFile(ECSCAN, [this.mem, ...all.map((m) => m.ec.toString(16))], { maxBuffer: 1 << 20 }, (err, out) => {
      this.recScanning = false;
      if (err) return;
      const my: number[] = [], foe: number[] = [];
      for (const line of out.trim().split("\n").filter(Boolean)) {
        const [o, v] = line.split(" ");
        const at = parseInt(o, 16) - 0x10, ec = parseInt(v, 16);
        const m = all.find((x) => x.ec === ec);
        if (!m || this.read(at, 2).readUInt16LE(0) !== m.species) continue;
        (mine.includes(m) ? my : foe).push(at);
      }
      // Live on-field records stand alone; stale ones sit in lists (entries 0x1C apart), so drop any
      // record with another record within 0x40 bytes.
      const found = [...my, ...foe];
      const isolated = (a: number) => !found.some((b) => b !== a && Math.abs(b - a) < 0x40);
      const myLive = my.filter(isolated), foeLive = foe.filter(isolated);
      if (myLive.length) this.myRecs = myLive;
      if (foeLive.length) this.foeRecs = foeLive;
    });
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
