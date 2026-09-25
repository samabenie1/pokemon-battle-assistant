// Find 4-byte-aligned u32 values in guest RAM (e.g. party encryption constants).
// usage: ecscan <memfd> hexvalue...   prints: offset value
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
int main(int argc, char **argv) {
  int fd = open(argv[1], O_RDONLY);
  uint64_t len = 0x100000000ull;
  uint32_t *m = mmap(0, len, PROT_READ, MAP_SHARED, fd, 0);
  if (m == MAP_FAILED) { perror("mmap"); return 1; }
  int n = argc - 2; uint32_t v[16];
  for (int i = 0; i < n && i < 16; i++) v[i] = strtoul(argv[i + 2], 0, 16);
  for (uint64_t i = 0; i < len / 4; i++)
    for (int k = 0; k < n; k++)
      if (m[i] == v[k]) { printf("%09llx %08x\n", (unsigned long long)(i * 4), v[k]); break; }
  return 0;
}
