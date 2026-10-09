/**
 * Print a command's payload as pretty-printed JSON on stdout.
 *
 * There is no `--out` or `--compact`: the two remaining payload commands
 * (`text`, `validate`) are diagnostics small enough to read or redirect with
 * the shell. `extract` writes its database itself.
 */
export function emit(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}
