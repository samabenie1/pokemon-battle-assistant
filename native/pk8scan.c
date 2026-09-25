// Scan Eden's guest RAM (memfd:HostMemory) for checksum-valid Gen 8 Pokémon.
// usage: pk8scan <path-to-memfd> [start_hex] [len_hex]
// prints: offset species level(stats byte) move1..4 ec
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>

static const uint8_t POS[32 * 4] = {
  0,1,2,3, 0,1,3,2, 0,2,1,3, 0,3,1,2, 0,2,3,1, 0,3,2,1, 1,0,2,3, 1,0,3,2,
  2,0,1,3, 3,0,1,2, 2,0,3,1, 3,0,2,1, 1,2,0,3, 1,3,0,2, 2,1,0,3, 3,1,0,2,
  2,3,0,1, 3,2,0,1, 1,2,3,0, 1,3,2,0, 2,1,3,0, 3,1,2,0, 2,3,1,0, 3,2,1,0,
  0,1,2,3, 0,1,3,2, 0,2,1,3, 0,3,1,2, 0,2,3,1, 0,3,2,1, 1,0,2,3, 1,0,3,2,
};

int main(int argc, char **argv) {
  int fd = open(argv[1], O_RDONLY);
  if (fd < 0) { perror("open"); return 1; }
  uint64_t start = argc > 2 ? strtoull(argv[2], 0, 16) : 0;
  uint64_t len = argc > 3 ? strtoull(argv[3], 0, 16) : 0x100000000ull;
  uint8_t *m = mmap(0, len, PROT_READ, MAP_SHARED, fd, start);
  if (m == MAP_FAILED) { perror("mmap"); return 1; }
  uint8_t d[0x158];
  for (uint64_t o = 0; o + 0x158 <= len; o += 4) {
    const uint8_t *p = m + o;
    uint32_t ec; memcpy(&ec, p, 4);
    if (!ec || p[4] || p[5]) continue; // sanity field is always 0
    memcpy(d, p, 0x158);
    uint32_t seed = ec; uint16_t sum = 0;
    for (int i = 8; i < 0x148; i += 2) {
      seed = seed * 0x41c64e6d + 0x6073;
      uint16_t v; memcpy(&v, d + i, 2); v ^= seed >> 16; memcpy(d + i, &v, 2);
      sum += v;
    }
    uint16_t ck; memcpy(&ck, p + 6, 2);
    if (sum != ck) continue;
    seed = ec;
    for (int i = 0x148; i < 0x158; i += 2) {
      seed = seed * 0x41c64e6d + 0x6073;
      uint16_t v; memcpy(&v, d + i, 2); v ^= seed >> 16; memcpy(d + i, &v, 2);
    }
    uint8_t s[0x140]; memcpy(s, d + 8, 0x140);
    int sv = (ec >> 13) & 31;
    for (int b = 0; b < 4; b++) memcpy(d + 8 + b * 0x50, s + POS[sv * 4 + b] * 0x50, 0x50);
    uint16_t sp; memcpy(&sp, d + 8, 2);
    if (!sp || sp > 898) continue;
    uint16_t mv[4]; memcpy(mv, d + 0x72, 8);
    uint16_t hp; memcpy(&hp, d + 0x8a, 2);
    printf("%09llx %d %d %d %d %d %d %d %08x\n", (unsigned long long)(start + o), sp, d[0x148], hp, mv[0], mv[1], mv[2], mv[3], ec);
  }
  return 0;
}
