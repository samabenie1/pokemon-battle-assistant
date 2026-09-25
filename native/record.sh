#!/bin/bash
# Log every checksum-valid Pokémon in the battle-heap area once a second.
# usage: record.sh <eden-pid> <outfile>
FD=$(ls -l /proc/$1/fd | awk '/memfd:HostMemory/{print $9}' | head -1)
while kill -0 "$1" 2>/dev/null; do
  T=$(date +%s.%N | cut -c1-14)
  { "$(dirname "$0")/pk8scan" /proc/$1/fd/$FD 4c000000 1000000; "$(dirname "$0")/pk8scan" /proc/$1/fd/$FD c0000000 30000000; } | sed "s/^/$T /"
  sleep 1
done > "$2"
