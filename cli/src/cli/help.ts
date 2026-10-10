import { COMMANDS, commandColumnWidth } from "../commands/registry.ts";
import { FLAGS, globalFlags, type FlagSpec } from "./flags.ts";
import type { Command, CommandName } from "../commands/types.ts";

const TEXT_WIDTH = 78;

function flagLabel(flag: FlagSpec): string {
  const short = flag.short === undefined ? "    " : `-${flag.short}, `;
  const arg = flag.arg === undefined ? "" : ` ${flag.arg}`;
  return `${short}--${flag.name}${arg}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Naive greedy wrap; these descriptions are plain prose with no markup. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line += ` ${word}`;
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * One block of `--flag  description` lines, all descriptions wrapped to
 * `TEXT_WIDTH` and aligned to a single shared column.
 *
 * `command` is the command whose help is being rendered - a flag can carry a
 * per-command note, so the two have to travel together.
 */
function optionLines(
  groups: readonly (readonly FlagSpec[])[],
  command: CommandName | null,
): string[] {
  const flags = groups.flat();
  if (flags.length === 0) return [];

  // One width across every group, so a command's own options and the global
  // ones share a column instead of each lining up to their own.
  const width = flags.reduce((n, f) => Math.max(n, flagLabel(f).length), 0);
  const indent = " ".repeat(width + 4);

  return flags.flatMap((flag) => {
    const note = command === null ? undefined : flag.notes?.[command];
    const summary = note === undefined ? flag.summary : `${flag.summary}; ${note}`;
    const label = `  ${pad(flagLabel(flag), width)}  `;
    const [first, ...rest] = wrap(summary, TEXT_WIDTH - indent.length);
    return [label + first, ...rest.map((line) => indent + line)];
  });
}

/**
 * `fe-rom --help`
 *
 * The examples assume the current directory is `cli/`, which is where the
 * package lives and where its npm scripts run from.
 */
export function usage(): string {
  const width = commandColumnWidth();
  return [
    "fe-rom - extract GBA Fire Emblem ROMs into SQLite",
    "",
    "Usage:",
    "  fe-rom <command> <rom.gba> [options]",
    "  fe-rom <command> --help",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${pad(c.name, width)}  ${c.summary}`),
    "",
    "Global options:",
    ...optionLines([globalFlags()], null),
    "",
    'Each command documents its own options under "fe-rom <command> --help".',
    "A command-specific option is rejected by commands that do not read it.",
    "",
    "Analysis happens against the extracted database, with SQL. Example:",
    "  sqlite3 dream-of-five.db 'SELECT id, name FROM roster ORDER BY id'",
    "The full schema and its conventions are documented in src/db/schema.ts.",
    "",
    "Exit codes: 0 ok, 1 the ROM could not be parsed, 2 bad arguments.",
    "",
    "Examples (run from cli/):",
    "  fe-rom extract  ../fixtures/dream-of-five.gba",
    "  fe-rom extract  ../fixtures/dream-of-five.gba --out do5.db --lang zh",
    "  fe-rom text     ../fixtures/dream-of-five.gba 703 704 --range 0x210-0x218",
  ].join("\n");
}

/** `fe-rom <command> --help` */
export function commandHelp(command: Command): string {
  const local = FLAGS.filter((f) => f.commands?.includes(command.name) === true);
  const lines = [
    `fe-rom ${command.name} - ${command.summary}`,
    "",
    "Usage:",
    `  fe-rom ${command.name} <rom.gba> [options]${command.extraArgs ?? ""}`,
    "",
  ];

  if (command.description !== undefined) lines.push(...wrap(command.description, TEXT_WIDTH), "");

  lines.push("Options:");
  lines.push(...optionLines([local, globalFlags()], command.name));

  lines.push("", 'Other commands: "fe-rom --help" lists all of them.');
  return lines.join("\n");
}

/** Levenshtein distance, iterative two-row form. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/**
 * Near-misses for an unknown command word.
 *
 * Substring matching alone misses the common typo - `untis` contains no
 * command name and contains no substring of one, so it drew a blank line. A
 * plain edit distance catches it; the threshold scales with the word length so
 * a short name is not matched by something wildly unlike it.
 */
export function suggestions(input: string): string[] {
  const lower = input.toLowerCase();
  const substring = COMMANDS.map((c) => c.name).filter(
    (name) => name.includes(lower) || lower.includes(name),
  );
  if (substring.length > 0) return substring;

  const tolerance = lower.length <= 4 ? 1 : lower.length <= 8 ? 2 : 3;
  return COMMANDS.map((c) => ({ name: c.name, distance: editDistance(lower, c.name) }))
    .filter((c) => c.distance <= tolerance)
    .sort((x, y) => x.distance - y.distance)
    .map((c) => c.name);
}
