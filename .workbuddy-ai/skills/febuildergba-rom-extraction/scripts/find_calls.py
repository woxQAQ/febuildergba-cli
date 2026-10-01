#!/usr/bin/env python3
"""Find every call site of a function in a GBA ROM, by scanning for Thumb BL/BLX.

Why this exists
---------------
`disasm.py` answers "what does this function do". This answers the other
direction: "who calls this function". That question comes up constantly when
you are tracing how a rule is implemented - e.g. to find every place the game
consumes a random number, you look for all callers of `Roll1RN` / `Roll2RN`.

Linear-disassembling a 16 MB ROM to find calls is slow and unreliable (you have
to guess where code starts). Instead we scan for the *encoding*: every Thumb
BL/BLX is two halfwords, so we can just test every halfword-aligned offset.

Thumb BL/BLX encoding (ARMv4T, as used by the GBA):
    hw1 = 11110 S imm10          -> (hw1 & 0xF800) == 0xF000
    hw2 = 1111  J1 1 J2 imm11    -> (hw2 & 0xD000) == 0xD000  (BL)  [BLX: 0xC000]
    I1 = NOT(J1 ^ S), I2 = NOT(J2 ^ S)
    offset = sign_extend(S:I1:I2:imm10:imm11:'0', 25)
    target = (addr_of_hw1 + 4) + offset

Usage
-----
    <venv>/bin/python find_calls.py <rom.gba> <targetGbaAddress> [startOffset] [endOffset]

`targetGbaAddress` is a GBA address, e.g. 0x08000CA0 for Roll1RN.
Output is one `fileoffset  gbaaddress` pair per line, sorted.

Example - where does the game roll random numbers during a battle?

    <venv>/bin/python find_calls.py ../fixtures/dream-of-five.gba 0x0802A52C
"""

import struct
import sys


def sign_extend(value: int, bits: int) -> int:
    sign_bit = 1 << (bits - 1)
    return (value ^ sign_bit) - sign_bit


def find_calls(data: bytes, target: int, base: int, lo: int, hi: int):
    hits = []
    for off in range(lo, hi - 3, 2):
        hw1, hw2 = struct.unpack_from("<HH", data, off)
        if (hw1 & 0xF800) != 0xF000:
            continue
        # BL: 1111 0 J1 1 J2 imm11  |  BLX: 1111 0 J1 0 J2 imm11
        if (hw2 & 0xD000) != 0xD000 and (hw2 & 0xD000) != 0xC000:
            continue

        s = (hw1 >> 10) & 1
        imm10 = hw1 & 0x3FF
        j1 = (hw2 >> 13) & 1
        j2 = (hw2 >> 11) & 1
        imm11 = hw2 & 0x7FF
        i1 = 1 - (j1 ^ s)
        i2 = 1 - (j2 ^ s)

        raw = (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1)
        offset = sign_extend(raw, 25)

        # addr of the BL instruction in GBA space
        addr = base + off
        if (addr + 4 + offset) & 0xFFFFFFFF == target:
            hits.append((off, addr))
    return hits


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    rom_path = sys.argv[1]
    target = int(sys.argv[2], 0)
    start = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0
    with open(rom_path, "rb") as handle:
        data = handle.read()
    end = int(sys.argv[4], 0) if len(sys.argv) > 4 else len(data)

    for off, addr in find_calls(data, target, 0x08000000, start, end):
        print(f"file 0x{off:07X}   gba 0x{addr:08X}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
