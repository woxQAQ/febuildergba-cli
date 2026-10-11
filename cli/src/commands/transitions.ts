import { traceTransitionSteps, walkTransitions } from "../tables/storyPath.ts";
import type { TracedInstruction } from "../tables/eventTrace.ts";
import type { Command } from "./types.ts";

export const transitions: Command<"db"> = {
  name: "transitions",
  input: "db",
  summary: "List where each chapter's END_EVENT advances the story to",
  description:
    "One row per story-advancing destination found in a chapter's END_EVENT " +
    "script or its CALL closure. Replaces the former `chapter_transitions` db " +
    "view; the data source is the same END_EVENT walk `tables/storyPath.ts` " +
    "has always done, run over the event layer the extract persisted. " +
    "`callDepth` > 0 means the instruction lives in a shared helper and fires " +
    "for every chapter that calls it. Note the walk follows CALLs 4 deep " +
    "(deeper chains are boilerplate) where the old view went 8.",
  run: ({ data }) => {
    // Seed per chapter: its END_EVENT slot's script (`chapter.endEventAddr`
    // on the ROM side; the same cond-table pointer, linked at extract time).
    const seedByMap = new Map<number, number>();
    for (const slot of data.trace.chapterSlots) {
      if (slot.slotKind !== "END_EVENT" || slot.scriptId === null) continue;
      if (!seedByMap.has(slot.mapIndex)) seedByMap.set(slot.mapIndex, slot.scriptId);
    }

    const instructionsByScript = new Map<number, TracedInstruction[]>();
    for (const i of data.trace.instructions) {
      const list = instructionsByScript.get(i.scriptId);
      if (list === undefined) instructionsByScript.set(i.scriptId, [i]);
      else list.push(i);
    }
    const stepsOf = traceTransitionSteps(instructionsByScript);

    return data.chapters.flatMap((c) => {
      const seed = seedByMap.get(c.index);
      if (seed === undefined) return [];
      return walkTransitions(seed, stepsOf).map((t) => ({
        mapIndex: c.index,
        opcode: t.opcode,
        targetMap: t.targetMap,
        callDepth: t.callDepth,
      }));
    });
  },
};
