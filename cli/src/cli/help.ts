import { COMMANDS, commandColumnWidth } from '../commands/registry.ts';
import { FLAGS, globalFlags, type FlagSpec } from './flags.ts';
import type { Command } from '../commands/types.ts';

const TEXT_WIDTH = 78;

function flagLabel(flag: FlagSpec): string {
  const short = flag.short === undefined ? '    ' : `-${flag.short}, `;
  const arg = flag.arg === undefined ? '' : ` ${flag.arg}`;
  return `${short}--${flag.name}${arg}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Naive greedy wrap; these descriptions are plain prose with no markup. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line += ` ${word}`;
  }
  if (line !== '') lines.push(line);
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
  command: string | null,
): string[] {
  const flags = groups.flat();
  if (flags.length === 0) return [];

  // One width across every group, so a command's own options and the global
  // ones share a column instead of each lining up to their own.
  const width = flags.reduce((n, f) => Math.max(n, flagLabel(f).length), 0);
  const indent = ' '.repeat(width + 4);

  return flags.flatMap((flag) => {
    const note = command === null ? undefined : flag.notes?.[command];
    const summary = note === undefined ? flag.summary : `${flag.summary}; ${note}`;
    const label = `  ${pad(flagLabel(flag), width)}  `;
    const [first, ...rest] = wrap(summary, TEXT_WIDTH - indent.length);
    return [label + first, ...rest.map((line) => indent + line)];
  });
}

/** `fe-rom --help` */
export function usage(): string {
  const width = commandColumnWidth();
  return [
    'fe-rom - parse GBA Fire Emblem ROMs',
    '',
    'Usage:',
    '  fe-rom <command> <rom.gba> [options]',
    '  fe-rom <command> --help',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${pad(c.name, width)}  ${c.summary}`),
    '',
    'Global options:',
    ...optionLines([globalFlags()], null),
    '',
    'Each command documents its own options under "fe-rom <command> --help".',
    'A command-specific option is rejected by commands that do not read it.',
    '',
    'Examples:',
    '  fe-rom info         fixtures/dream-of-five.gba',
    '  fe-rom roles        fixtures/dream-of-five.gba',
    '  fe-rom chapters     fixtures/dream-of-five.gba',
    '  fe-rom chapters     fixtures/dream-of-five.gba --all',
    '  fe-rom terrain      fixtures/dream-of-five.gba',
    '  fe-rom units        fixtures/dream-of-five.gba',
    '  fe-rom units        fixtures/dream-of-five.gba --all',
    '  fe-rom enemy-stats  fixtures/dream-of-five.gba --hard',
    '  fe-rom enemy-stats  fixtures/dream-of-five.gba --all',
    '  fe-rom text         fixtures/dream-of-five.gba 703 704 --range 0x210-0x218',
    '  fe-rom validate     fixtures/dream-of-five.gba',
  ].join('\n');
}

/** `fe-rom <command> --help` */
export function commandHelp(command: Command): string {
  const local = FLAGS.filter((f) => f.commands?.includes(command.name) === true);
  const lines = [
    `fe-rom ${command.name} - ${command.summary}`,
    '',
    'Usage:',
    `  fe-rom ${command.name} <rom.gba> [options]${command.extraArgs ?? ''}`,
    '',
  ];

  if (command.description !== undefined) lines.push(...wrap(command.description, TEXT_WIDTH), '');

  lines.push('Options:');
  lines.push(...optionLines([local, globalFlags()], command.name));

  lines.push('', 'Other commands: "fe-rom --help" lists all of them.');
  return lines.join('\n');
}

/**
 * Near-misses for an unknown command word: names containing it, or containing
 * a name from it. Empty string when nothing is close enough to mention.
 */
export function suggestions(input: string): string[] {
  const lower = input.toLowerCase();
  return COMMANDS.map((c) => c.name).filter(
    (name) => name.includes(lower) || lower.includes(name),
  );
}