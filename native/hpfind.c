// Find live battle HP: u16 values in [lo,hi] with the max HP u16 nearby.
// pass 1: hpfind <memfd> scan <lo> <hi> <max>  > candidates   (prints "addr value")
// pass 2: hpfind <memfd> check < candidates                    (prints "addr old new" when changed)
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static const uint64_t RANGES[][2] = {{0x40000000, 0x10000000}, {0xc0000000, 0x30000000}};

int main(int argc, char **argv) {
  int fd = open(argv[1], O_RDONLY);
  if (fd < 0) { perror("open"); return 1; }
  if (!strcmp(argv[2], "scan")) {
    int lo = atoi(argv[3]), hi = atoi(argv[4]), mx = atoi(argv[5]);
    for (int r = 0; r < 2; r++) {
      uint64_t base = RANGES[r][0], len = RANGES[r][1];
      uint8_t *m = mmap(0, len, PROT_READ, MAP_SHARED, fd, base);
      if (m == MAP_FAILED) { perror("mmap"); return 1; }
      for (uint64_t o = 0x20; o + 0x22 < len; o += 2) {
        uint16_t v; memcpy(&v, m + o, 2);
        if (v < lo || v > hi) continue;
        for (int k = -0x10; k <= 0x10; k += 2) {
          uint16_t w; memcpy(&w, m + o + k, 2);
          if (k && w == mx) { printf("%llx %d\n", (unsigned long long)(base + o), v); break; }
        }
      }
      munmap(m, len);
    }
  } else {
    unsigned long long a; int old;
    while (scanf("%llx %d", &a, &old) == 2) {
      uint16_t v; if (pread(fd, &v, 2, a) != 2) continue;
      if (v != old) printf("%llx %d %d\n", a, old, v);
    }
  }
  return 0;
}
