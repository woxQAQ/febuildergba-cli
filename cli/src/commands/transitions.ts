import { parseRom } from "../load.ts";
import { readAllTransitions } from "../tables/storyPath.ts";
import type { Command } from "./types.ts";

export const transitions: Command = {
  name: "transitions",
  summary: "List where each chapter's END_EVENT advances the story to",
  description:
    "One row per story-advancing destination found in a chapter's END_EVENT " +
    "script or its CALL closure. Replaces the former `chapter_transitions` db " +
    "view; the data source is the same END_EVENT walk `tables/storyPath.ts` " +
    "has always done. `callDepth` > 0 means the instruction lives in a shared " +
    "helper and fires for every chapter that calls it. Note the walk follows " +
    "CALLs 4 deep (deeper chains are boilerplate) where the old view went 8.",
  run: ({ rom }) => {
    const parsed = parseRom(rom);
    return readAllTransitions(parsed.rom, parsed.eventScripts, parsed.chapters).flatMap((e) =>
      e.transitions.map((t) => ({
        mapIndex: e.mapIndex,
        opcode: t.opcode,
        targetMap: t.targetMap,
        callDepth: t.callDepth,
      })),
    );
  },
};
