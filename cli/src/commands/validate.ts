import { validateRom } from '../analysis/validate.ts';
import type { Command } from './types.ts';

export const validate: Command = {
  name: 'validate',
  summary: 'Self-consistency checks (see AGENTS.md section 6)',
  description:
    'Checks the parsed tables against each other. The report is always written; ' +
    'the exit code is 1 when `ok` is false, so this doubles as a CI gate. Checks ' +
    'verify format invariants, never vanilla magic numbers - a hack is allowed ' +
    'to have more affinities or a longer support table than the retail game.',
  run: ({ rom }) => {
    const result = validateRom(rom);
    return {
      ok: result.ok,
      summary: result.summary,
      checks: result.checks,
      supportDetail: result.supports,
    };
  },
  exitCode: (payload) => ((payload as { ok: boolean }).ok ? 0 : 1),
};