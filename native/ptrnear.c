// Find u64 values pointing into [target-before, target+after) for guest VAs given as hex args.
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
int main(int argc, char **argv) {
  int fd = open(argv[1], O_RDONLY);
  uint64_t len = 0x100000000ull, before = strtoull(argv[2], 0, 16), after = strtoull(argv[3], 0, 16);
  uint64_t *m = mmap(0, len, PROT_READ, MAP_SHARED, fd, 0);
  if (m == MAP_FAILED) { perror("mmap"); return 1; }
  int n = argc - 4; uint64_t t[64];
  for (int i = 0; i < n; i++) t[i] = strtoull(argv[i + 4], 0, 16);
  for (uint64_t i = 0; i < len / 8; i++) {
    uint64_t v = m[i];
    if (v < 0x2000000000ull || v > 0x2400000000ull) continue;
    for (int k = 0; k < n; k++)
      if (v + before >= t[k] && v < t[k] + after)
        printf("%09llx -> %llx (target %llx %+lld)\n", (unsigned long long)(i * 8), (unsigned long long)v, (unsigned long long)t[k], (long long)(v - t[k]));
  }
  return 0;
}
