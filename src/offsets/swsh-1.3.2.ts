// Heap-relative offsets for Sword/Shield v1.3.2, from SysBot.NET's
// PokeDataOffsetsSWSH (sys-botbase "peek" addresses are relative to the heap base).
export const SWSH_132 = {
  trainerData: 0x45068f18, // MyStatus8, 0x110 bytes; OT name UTF-16 at +0xB0
  trainerDataLength: 0x110,
  party: 0x450c68b0, // 6 × PK8 party format (0x158), found by checksum scan 09-25
  boxStart: 0x45075880, // PK8, 0x158 stride
  slotSize: 0x158,
  wildPokemon: 0x8fea3648, // PK8 of the current wild encounter
  battleMenu: 0x8398a470, // non-zero while the fight/bag/run menu is up
  inBattleSword: 0x3f128624, // 0 outside battle, 0x40/0x41 in battle
} as const;
