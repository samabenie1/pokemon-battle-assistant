# Memory research notes (Sword/Shield v1.3.2 in Eden)

These are the notes behind the reader, for anyone extending it. Every "verified" item below was confirmed by
diffing memory around an event the player reported ("X is out now", "Y fell asleep").

## Reading guest RAM without pausing
Eden backs the Switch's 4 GiB of RAM with a memfd named `memfd:HostMemory`. A process owned by the same
user can open it via `/proc/<eden-pid>/fd/<n>` (this needs only PTRACE_MODE_READ, so Yama's ptrace_scope=1 doesn't block it)
and `pread`/`mmap` it. A full 4 GiB `dd` snapshot takes about 1.5 s, and the game keeps running.

In Python, open it with `buffering=0`. A buffered reader serves stale data on nearby seeks.

Eden's GDB stub (`src/reader/gdb.ts`) also works, but every read halts the guest for about 40 ms, and bulk reads freeze the game.
With the stub enabled, Eden also holds the game at boot until a debugger attaches.

## Address mapping
SysBot.NET offsets are **heap-relative**. In the memfd:
- **Save block** (party, bag, PC boxes, trainer data): at the same offset as the heap offset, and stable across game restarts.
- **Battle region** (0x8…/0x9… heap offsets): at heap offset + a per-boot **shift**. It's usually a multiple of 0x20000000, but a
  game reset inside Eden can move it by an arbitrary amount (seen: −0x77FFC10). `LiveReader.calibrate()` validates the
  shift every poll. On failure it tries the 8 fixed shifts, then locates the player's party copies by their encryption
  constants (`native/ecscan.c`, ~2 s) and prefers the copy whose battle counter reads 1..255.

## Save block (fixed)
| Offset | Contents |
|---|---|
| 0x45068F18 | Trainer data (MyStatus8); OT name at +0xB0 |
| 0x450C68B0 | Party, 6 × PK8 party format (0x158 bytes). HP only updates outside battle. |
| 0x45067A98 | Medicine pouch, u32 per slot: id = bits 0-10, count = bits 15-24 |
| 0x45067B88 | Poké Ball pouch (same format) |
| 0x45075880 | PC boxes: 32 × 30 × 0x158 |

## Battle region (heap offset + shift)
One **0x7A0-byte block per Pokémon**, in party order:

| Block offset | Contents |
|---|---|
| +0x000 | Status record, u16: `[species, maxHP, curHP, heldItem, 0, ability, slot<<8 \| level]`. **curHP is live.** |
| +0x244 | **Stat stages**, 7 bytes: Atk, Def, SpA, SpD, Spe, Acc, Eva; 6 = neutral. Verified: Nasty Plot moved SpA 6→8→10; Intrepid Sword shows Atk 7. |
| +0x4E8 | PK8 copy. **PP is live** (a PP drop = that move was used); HP and status only sync on switch-out. |

| Heap offset | Contents |
|---|---|
| 0x8FE9D5E0 | Player's party blocks (slot 0) |
| 0x8FEA3160 | **Opponent's** party blocks: the SysBot "wild Pokémon" slot (0x8FEA3648) is the PK8 of opponent slot 0. A wild battle is one block; trainers have more. |
| 0x910988B8 | **Player's Pokémon on the field**: u16 species at +0, u32 encryption constant at +0x10 (copy at 0x91098B30). Verified over many switches. |
| 0x901988A0 | **Opponent's Pokémon on the field** (same layout). Trainers don't always send Pokémon out in stored order. One sample so far. |
| 0x8398A470 | Battle step counter: 1..0xFF during a battle, incremented per battle event. 0 or garbage outside battle. |

**Wild vs trainer:** wild Pokémon are pre-stamped with the *player's* TID but have an empty OT name.
Trainer Pokémon carry the trainer's OT name.

SysBot's `InBattleRaidOffsetSW` (0x3F128624) read as 0 at every shift in Eden, so the step counter is used instead.

## Open problems
- **Live status conditions:** partly decoded. The battle block holds a condition list around +0x28..+0x68: 8-byte entries
  `[code, turns, …]`, with 248 marking an empty slot. Seen so far: 98 = confusion, 97 = probably paralysis. +0x18E counted
  confused turns, and +0x398 holds the last move that hit the Pokémon. Burn, poison and sleep codes are still needed;
  `native/blockwatch.py` logs byte-level changes so they can be matched to reported events.
- **Field conditions** (weather, terrain, Reflect/Light Screen): not located.
- **Double battles and Max Raids:** not investigated.

## Tools
- `native/pk8scan.c`: finds every checksum-valid PK8 in a memfd range (about 6 s for 4 GiB)
- `native/ecscan.c`: finds u32 values (encryption constants) in 4 GiB in about 2 s; used for calibration
- `native/blockwatch.py`: logs byte changes in both sides' battle blocks, to find where state lives
- `native/hpfind.c`, `native/ptr*.c`, `native/uiscan.c`, `native/record.sh`: search helpers used during research
- `src/tools/*.ts`: the GDB-based spike, discovery and VA-map tools
