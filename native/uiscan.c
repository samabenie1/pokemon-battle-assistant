// Find in-battle status records: u16 [species, maxHP, curHP, ?, 0, ability, level]
// for the given party members. usage: uiscan <memfd> <start_hex> <len_hex> sp:ab:lv:max ...
// prints: offset species curHP maxHP
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
int main(int argc, char **argv) {
  int fd = open(argv[1], O_RDONLY);
  uint64_t start = strtoull(argv[2], 0, 16), len = strtoull(argv[3], 0, 16);
  uint16_t *m = mmap(0, len, PROT_READ, MAP_SHARED, fd, start);
  if (m == MAP_FAILED) { perror("mmap"); return 1; }
  int n = argc - 4; unsigned sp[6], ab[6], lv[6], mx[6];
  for (int i = 0; i < n && i < 6; i++) sscanf(argv[i + 4], "%u:%u:%u:%u", &sp[i], &ab[i], &lv[i], &mx[i]);
  for (uint64_t i = 0; i + 7 < len / 2; i++)
    for (int k = 0; k < n; k++)
      if (m[i] == sp[k] && m[i + 1] == mx[k] && m[i + 4] == 0 && m[i + 5] == ab[k] && m[i + 6] == lv[k] && m[i + 2] <= mx[k])
        printf("%09llx %u %u %u\n", (unsigned long long)(start + i * 2), sp[k], m[i + 2], mx[k]);
  return 0;
}
