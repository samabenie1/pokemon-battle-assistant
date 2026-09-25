// Find 8-byte-aligned u64 values in guest RAM equal to any target (hex args).
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
int main(int argc, char **argv) {
  int fd = open(argv[1], O_RDONLY);
  uint64_t len = 0x100000000ull;
  uint64_t *m = mmap(0, len, PROT_READ, MAP_SHARED, fd, 0);
  if (m == MAP_FAILED) { perror("mmap"); return 1; }
  int n = argc - 2; uint64_t t[64];
  for (int i = 0; i < n; i++) t[i] = strtoull(argv[i + 2], 0, 16);
  for (uint64_t i = 0; i < len / 8; i++)
    for (int k = 0; k < n; k++)
      if (m[i] == t[k]) printf("%09llx -> %llx\n", (unsigned long long)(i * 8), (unsigned long long)t[k]);
  return 0;
}
