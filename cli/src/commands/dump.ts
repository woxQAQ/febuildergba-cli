import { buildReport } from '../analysis/report.ts';
import type { Command } from './types.ts';

export const dump: Command = {
  name: 'dump',
  summary: 'Everything in one JSON document, shaped for AI analysis',
  description:
    'One document containing every other command\'s output plus the derived ' +
    'analysis. Takes no command-specific options; the tables are always ' +
    'complete here.',
  run: ({ rom }) => buildReport(rom),
};