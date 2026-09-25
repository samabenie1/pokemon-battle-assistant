// Histogram of u64 values that look like guest pointers, by top bits.
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
int main(int argc, char **argv) {
  int fd = open(argv[1], O_RDONLY);
  uint64_t len = 0x100000000ull;
  uint64_t *m = mmap(0, len, PROT_READ, MAP_SHARED, fd, 0);
  static uint64_t h[4096];
  for (uint64_t i = 0; i < len / 8; i++) { uint64_t v = m[i]; if (v >= 0x8000000ull && v < 0x8000000000ull) h[v >> 28]++; }
  for (int i = 0; i < 4096; i++) if (h[i] > 1000) printf("%03x0000000 %llu\n", i, (unsigned long long)h[i]);
}
