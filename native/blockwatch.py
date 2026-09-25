#!/usr/bin/env python3
"""Log byte-level changes in both sides' in-battle blocks (research tool for live status).
usage: blockwatch.py <eden-memfd> <shift-hex> > log"""
import struct, sys, time
f = open(sys.argv[1], "rb", buffering=0)  # unbuffered: a buffered reader serves stale data on nearby seeks
shift = int(sys.argv[2], 16)
MINE, FOE, STRIDE, SIZE = 0x8FE9D5E0, 0x8FEA3160, 0x7A0, 0x4E8
last = {}
while True:
    for side, base in (("me", MINE), ("foe", FOE)):
        for i in range(6):
            f.seek((base + shift + i * STRIDE) % (1 << 32)); b = f.read(SIZE)
            sp = struct.unpack("<H", b[:2])[0]
            if not sp or sp > 898: continue
            key = (side, i); prev = last.get(key); last[key] = b
            if prev is None or prev[:2] != b[:2]: continue
            diffs = [f"{o:03x}:{prev[o]}>{b[o]}" for o in range(SIZE) if prev[o] != b[o]]
            if diffs: print(time.strftime("%H:%M:%S"), side, i, sp, " ".join(diffs), flush=True)
    time.sleep(0.25)
