#!/usr/bin/env python3
"""Disassemble a slice of a GBA ROM as Thumb, to verify what the ROM's own code does.

Why this exists
---------------
FEBuilderGBA is an *editor*, not a simulator: it shows you tables, it never
computes battle results. So when the reference has no arithmetic for something
(support bonuses, growth rules, movement rules) that means nothing about whether
the ROM has the data - the rule is implemented in the ROM's own ARM code.

The ROM ships with a symbol map naming every vanilla function:

    FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/asmmap_FE8.txt   (also .en / .zh)

Format is tab-separated:  <GBA address>\t<function name>\t<notes>...
`{U}` = US release, `{J}` = Japanese. `grep -i <keyword> asmmap_FE8.txt` to find
the function you need, then disassemble from that address to the next symbol.

Setup (any Python 3 with capstone works; let uv pull it on demand):

    uv run --with capstone python disasm.py <rom.gba> <startOffset> <endOffset>

Usage:

    <venv>/bin/python disasm.py <rom.gba> <startOffset> <endOffset> [baseAddress]

Offsets are FILE offsets; `baseAddress` defaults to `0x08000000 + startOffset`.
Symbol map addresses are GBA addresses, so file offset = address - 0x08000000.

Example - the support bonus arithmetic (see SKILL.md 1.6.3):

    uv run --with capstone python disasm.py fixtures/dream-of-five.gba 0x2852C 0x285B0
"""

import sys

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB, CS_MODE_LITTLE_ENDIAN


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__)
        return 2

    rom_path = sys.argv[1]
    start = int(sys.argv[2], 0)
    end = int(sys.argv[3], 0)
    base = int(sys.argv[4], 0) if len(sys.argv) > 4 else 0x08000000 + start

    with open(rom_path, "rb") as handle:
        data = handle.read()[start:end]

    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_LITTLE_ENDIAN)
    md.detail = False
    # CRITICAL: without skipdata, the disasm iterator STOPS SILENTLY at the first
    # byte sequence it cannot decode (a literal pool, an alignment gap, data
    # between functions). You get a truncated listing and no error - which reads
    # exactly like "the function ends here". With skipdata it emits `.byte` lines
    # and keeps going, so you can see where the code resumes.
    md.skipdata = True

    for ins in md.disasm(data, base):
        raw = " ".join(f"{b:02x}" for b in ins.bytes)
        print(f"{ins.address:08X}  {raw:<12} {ins.mnemonic:<8} {ins.op_str}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
