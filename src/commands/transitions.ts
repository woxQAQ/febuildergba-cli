import { traceTransitionSteps, walkTransitions } from "../model/storyPath.ts";
import type { TracedInstruction } from "../model/events.ts";
import { defineDbCommand } from "./types.ts";

export const transitions = defineDbCommand({
  name: "transitions",
  input: "db",
  summary: "List where each chapter's END_EVENT advances the story to",
  description:
    "One row per story-advancing destination found in a chapter's END_EVENT " +
    "script or its sub-event closure, including composite instructions. " +
    "Uses the same decoded event evidence and END_EVENT walk as the " +
    "extractor's play-order derivation. `callDepth` > 0 means the instruction " +
    "lives in a shared helper. Sub-event references are followed 4 deep; " +
    "reachability does not prove that conditional events execute.",
  run: async ({ extract }) => {
    const trace = await extract.trace();
    const chapters = await extract.chapters();
    const seedByMap = new Map<number, number>();
    for (const slot of trace.chapterSlots) {
      if (slot.slotKind !== "END_EVENT" || slot.scriptId === null) continue;
      if (!seedByMap.has(slot.mapIndex)) seedByMap.set(slot.mapIndex, slot.scriptId);
    }

    const instructionsByScript = new Map<number, TracedInstruction[]>();
    for (const i of trace.instructions) {
      const list = instructionsByScript.get(i.scriptId);
      if (list === undefined) instructionsByScript.set(i.scriptId, [i]);
      else list.push(i);
    }
    const stepsOf = traceTransitionSteps(instructionsByScript);

    return chapters.flatMap((c) => {
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
});
