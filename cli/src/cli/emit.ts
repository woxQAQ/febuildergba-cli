import { writeFileSync } from 'node:fs';

import type { ResolvedFlags } from '../commands/types.ts';

/**
 * Write a command's payload as JSON, to `--out` when given and to stdout
 * otherwise. Progress notes go to stderr so `--out` can be piped safely.
 */
export function emit(payload: unknown, flags: ResolvedFlags): void {
  const json = flags.compact ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);
  if (flags.out !== undefined) {
    writeFileSync(flags.out, `${json}\n`, 'utf8');
    console.error(`Wrote ${flags.out}`);
  } else {
    console.log(json);
  }
}