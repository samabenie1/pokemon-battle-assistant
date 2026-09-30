// Black 2 / White 2 (USA/EUR, rev 0) main-RAM layout, taken from NDS-Ironmon-Tracker 6.3.11
// (constants/MemoryAddresses.lua, BattleHandlerGen5.lua). Offsets are main-RAM offsets (address - 0x02000000).
// Most are relative to the pointer stored at MAIN_POINTER.
export const B2 = {
  gameCodes: { IREO: "Black 2", IRDO: "White 2" } as Record<string, string>,
  MAIN_POINTER: 0x24,
  // Relative to *MAIN_POINTER:
  partyCount: 0x19724,
  party: 0x19728,            // 6 × 220-byte encrypted PK5 (overworld copy)
  playerBattleParty: 0x53610, // 6 × 220 in battle
  enemyBattleParty: 0x53b70,  // 6 × 220 in battle
  enemyTrainerID: 0x5262e,    // u16
  mainBattleDataPtr: 0x526a8, // player battler pointers at +i*4; enemy battler pointer at +0x1C (singles)
  doubleTripleFlag: 0x900a0,  // u8: 0 single, 1 double, 2/3 triple/rotation
  badges: 0x21a24,
  // Absolute main-RAM offsets:
  battleStatus: 0x1b5138,     // u16: 0x2100 / 0x2101 = in battle
  // Battler struct (pointed to by the battle data pointers):
  battler: {
    pkm: 0x00,       // pointer to the encrypted PK5 of this battler
    illusion: 0x04,  // pointer to the disguised PK5 if Illusion is active
    maxHP: 0x0e, curHP: 0x10, level: 0x18, status: 0x20,
    stats: 0xee,     // u16 × 5: Atk Def SpA SpD Spe
    statStages: 0xfc, // u8 × 7: Atk Def SpA SpD Spe Acc Eva (6 = neutral)
    moves: 0x104,    // 4 × 14 bytes: u16 move id, u8 current PP
    moveStride: 14,
  },
  enemyBattlerOffset: 0x1c,
} as const;
