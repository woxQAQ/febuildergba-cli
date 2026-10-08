import { decodeTextIdDetailed } from '../text/huffman.ts';
import { hex } from '../cli/hex.ts';
import type { Command } from './types.ts';

/** Largest `--range` span we will expand, to keep output bounded. */
const MAX_TEXT_RANGE = 4096;

function parseTextIds(specs: readonly string[], range: string | undefined): number[] {
  const ids: number[] = [];

  for (const spec of specs) {
    const id = Number.parseInt(spec, 0); // radix 0 accepts 0x-prefixed input
    if (Number.isNaN(id)) throw new Error(`not a text id: "${spec}"`);
    ids.push(id);
  }

  if (range !== undefined) {
    const match = /^(0x[0-9a-f]+|\d+)\s*-\s*(0x[0-9a-f]+|\d+)$/i.exec(range);
    if (!match) throw new Error(`--range expects "start-end", got "${range}"`);
    const start = Number.parseInt(match[1] as string, 0);
    const end = Number.parseInt(match[2] as string, 0);
    if (end < start) throw new Error('--range: end is before start');
    if (end - start + 1 > MAX_TEXT_RANGE) {
      throw new Error(`--range spans more than ${MAX_TEXT_RANGE} ids`);
    }
    for (let id = start; id <= end; id++) ids.push(id);
  }

  return ids;
}

export const text: Command = {
  name: 'text',
  summary: 'Decode one or more text ids (diagnostic)',
  description:
    'Diagnostic: decode raw text ids to see what the ROM actually holds. Ids ' +
    'go after the ROM path, `--range a-b` expands an inclusive span (max ' +
    `${MAX_TEXT_RANGE}). \`kind\` distinguishes the two storage forms hacks mix: ` +
    "'huffman' for ordinary compressed strings and 'unhuffman' for the " +
    '`0x08000000`-marked patch strings, some of which carry only glyph codes.',
  extraArgs: ' [id...]',
  run: ({ rom, flags, args }) => {
    const ids = parseTextIds(args, flags.range);
    if (ids.length === 0) {
      throw new Error('give at least one text id, or --range a-b');
    }

    return ids.map((id) => {
      const decoded = decodeTextIdDetailed(rom.rom, id, rom.text);
      return {
        id,
        idHex: hex(id),
        kind: decoded.kind,
        text: decoded.text,
        raw: decoded.raw,
      };
    });
  },
};