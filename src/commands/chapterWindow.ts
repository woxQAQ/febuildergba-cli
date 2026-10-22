import type { ChapterWindow } from "../model/chapterWindow.ts";
import type { PlayOrderRows } from "../model/records.ts";
import { UsageError, type ResolvedFlags } from "./types.ts";

/** Resolve once against the full order; filtering must not renumber positions or joins. */
export function chapterWindow(
  flags: ResolvedFlags,
  playOrder: PlayOrderRows,
): ChapterWindow | undefined {
  if (flags.fromPosition === undefined && flags.beforePosition === undefined) return undefined;
  const end = (playOrder.steps.at(-1)?.order ?? 0) + 1;
  const position = (value: string | undefined, fallback: number, flag: string): number => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > end) {
      throw new UsageError(`--${flag} expects an integer in 1..${end}, got "${value}"`);
    }
    return parsed;
  };
  const fromPosition = position(flags.fromPosition, 1, "from-position");
  const beforePosition = position(flags.beforePosition, end, "before-position");
  if (fromPosition > beforePosition) {
    throw new UsageError("--from-position must be <= --before-position");
  }
  return { fromPosition, beforePosition };
}
