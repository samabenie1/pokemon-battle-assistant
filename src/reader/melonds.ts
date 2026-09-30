// Live DS main RAM from melonDS (1.x), read with plain file reads: no pause, no ptrace, no sudo.
// melonDS backs its emulated memory with a shared-memory file (/dev/shm/melondsfastmem<N>, deleted
// right after creation but kept open). Main RAM (0x02000000, 4 MB in DS mode) sits at offset 0 of it.
// Verified 09-30 on the flatpak build: the ROM header copy is at main RAM +0x3FFE00.
import { closeSync, openSync, readFileSync, readSync, readdirSync, readlinkSync } from "node:fs";

export const MAIN_RAM = 0x02000000;
export const MAIN_RAM_SIZE = 0x400000;

export class MelonDS {
  private fd = -1;
  pid = 0;
  /** Game code from the cartridge header (e.g. "IREO" = Black 2 USA/EUR). */
  gameCode = "";

  connect(): boolean {
    for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      try {
        if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "melonDS") continue;
        for (const fd of readdirSync(`/proc/${pid}/fd`)) {
          if (!readlinkSync(`/proc/${pid}/fd/${fd}`).includes("melondsfastmem")) continue;
          this.close();
          this.fd = openSync(`/proc/${pid}/fd/${fd}`, "r");
          this.pid = +pid;
          this.gameCode = this.bytes(MAIN_RAM + 0x3ffe0c, 4).toString("latin1");
          return true;
        }
      } catch { /* vanished / not ours */ }
    }
    return false;
  }

  close() {
    if (this.fd >= 0) closeSync(this.fd);
    this.fd = -1;
  }

  /** Read `len` bytes at a DS address in main RAM (0x02xxxxxx) or a raw main-RAM offset. */
  bytes(addr: number, len: number): Buffer {
    const off = addr >= MAIN_RAM ? addr - MAIN_RAM : addr;
    const b = Buffer.alloc(len);
    if (off < 0 || off + len > MAIN_RAM_SIZE) return b;
    readSync(this.fd, b, 0, len, off);
    return b;
  }
  u8 = (a: number) => this.bytes(a, 1)[0];
  u16 = (a: number) => this.bytes(a, 2).readUInt16LE(0);
  u32 = (a: number) => this.bytes(a, 4).readUInt32LE(0);
  /** Follow a pointer into main RAM; returns a main-RAM offset, or 0 if it points elsewhere. */
  ptr(a: number) {
    const v = this.u32(a) & 0xffffff;
    return v < MAIN_RAM_SIZE ? v : 0;
  }
}
