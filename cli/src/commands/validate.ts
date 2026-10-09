import { validateRom } from "../analysis/validate.ts";
import type { Command } from "./types.ts";

export const validate: Command = {
  name: "validate",
  summary: "Self-consistency checks across the parsed tables",
  description:
    "Checks the parsed tables against each other. The report is always written; " +
    "the exit code is 1 when `ok` is false, so this doubles as a CI gate. Checks " +
    "verify format invariants, never vanilla magic numbers - a hack is allowed " +
    "to have more affinities or a longer support table than the retail game.\n\n" +
    "Run this before trusting a fresh `extract` database on a new ROM: the db " +
    "stores whatever the parse produced, and this is the net that catches a " +
    "misparsed table.",
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
