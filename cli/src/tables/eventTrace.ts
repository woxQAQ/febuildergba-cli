/**
 * The raw event layer: chapter condition slots, event scripts and their
 * disassembled instruction streams.
 *
 * This module is the *evidence* the walk-based derivations are computed
 * from. It answers "what does the ROM say" - which slot of which chapter
 * points at which script, what instructions each script contains, what each
 * instruction's arguments are - and nothing else. Control-flow questions
 * (which instructions a chapter actually reaches through CALLs, which loads
 * count as recruits) are answered by SQL views over this layer, not here.
 *
 * Extraction rules, all mechanical:
 *
 *   - Scripts are identified by start offset internally and decoded **once**;
 *     a helper shared via CALL gets one row set, referenced by many.
 *     Decoding is linear from the start, stopping at an exit opcode (the
 *     reference's branch-aware `isExitCode`), after more than 10 consecutive
 *     unknown instructions, or at a hard budget. UNKNOWN instructions are
 *     stored, not skipped - their size is a guess (`UNKNOWN_SIZE`), which is
 *     why the script row records where and why the decode stopped.
 *   - Slot iteration mirrors `scanChapter`: TURN/TALK/OBJECT/ALWAYS walk a
 *     table of small records with a script pointer at +4, TUTORIAL walks a
 *     pointer array, START_EVENT/END_EVENT point straight at a script, and
 *     the rest (PLAYER_UNIT / ENEMY_UNIT / TRAP / FREEMAP_*) are not scripts.
 *   - Unit blocks pointed at by `POINTER_UNIT` arguments are decoded with the
 *     same `readPlacements` reader as the initial placement blocks; they are
 *     the same record format.
 */

import type { RomBuffer } from "../rom/RomBuffer.ts";
import { RomBuffer as RB } from "../rom/RomBuffer.ts";
import type { GameLayout } from "../data/layouts.ts";
import type { EventCode, EventScriptTable } from "./eventScript.ts";
import { argValue, disassemble, isExitCode } from "./eventScript.ts";
import type { Chapter, CondSlotInfo, PlacedUnit, UnitSide } from "./chapters.ts";
import { classifyUnitArg, findGoldLiteralsIn, readPlacements } from "./chapters.ts";
import { callTargetOf, destinationOf, mnemonicOf, TRANSITION_OPCODES } from "./storyPath.ts";

export interface TracedScript {
  id: number;
  /** Why the linear decode stopped; "exit" is the clean case. */
  stopReason: string;
  instructionCount: number;
}

export interface TracedInstruction {
  scriptId: number;
  /** Ordinal within the script's linear decode. */
  seq: number;
  /** Mnemonic from the opcode table, e.g. `MNC2`; "UNKNOWN" when unmatched. */
  opcode: string;
  /** The opcode table's `{CATEGORY}` tokens. */
  category: string;
  /** Raw instruction bytes, hex - the ground truth behind every column here. */
  bytesHex: string;
  /** Load classification of a POINTER_UNIT argument; NULL when not a load. */
  loadKind: "recruit" | "load" | "cutscene" | "other" | null;
  /** Unit block a POINTER_UNIT argument points at; NULL otherwise. */
  blockId: number | null;
  /** Script a POINTER_EVENT argument (CALL) points at; NULL otherwise. */
  callScriptId: number | null;
  /** Destination map of a transition opcode; NULL otherwise. */
  targetMap: number | null;
  /** First gold literal inside the instruction, signed; NULL otherwise. */
  goldDelta: number | null;
  /** Item handed over by a `{ITEM}`-category instruction; NULL otherwise. */
  itemId: number | null;
  /** Unit receiving it; 0xFFFF = the unit currently acting. */
  giveUnitId: number | null;
}

/** One condition-slot entry of one chapter, linked to its script. */
export interface ChapterEventSlot {
  mapIndex: number;
  slotIndex: number;
  slotKind: string;
  /** Row number within a table-kind slot; 0 for direct slots. */
  position: number;
  /** Raw record bytes, hex; "" for direct slots. */
  dataHex: string;
  scriptId: number | null;
}

export interface TracedBlockUnit {
  blockId: number;
  position: number;
  unitId: number;
  /** 0 = the unit's own class. */
  classId: number;
  level: number;
  side: UnitSide;
  x: number;
  y: number;
}

export interface EventTrace {
  scripts: TracedScript[];
  instructions: TracedInstruction[];
  chapterSlots: ChapterEventSlot[];
  /** Ids only - the rows are in `loadBlockUnits`. */
  loadBlockCount: number;
  loadBlockUnits: TracedBlockUnit[];
}

/** `walkScript`'s consecutive-unknown tolerance, kept identical on purpose. */
const MAX_CONSECUTIVE_UNKNOWNS = 10;
/** Per-script instruction ceiling. */
const MAX_SCRIPT_INSTRUCTIONS = 4000;

const hex = (buf: Buffer): string => buf.toString("hex");

export function extractEventTrace(
  rom: RomBuffer,
  layout: GameLayout,
  chapters: readonly Chapter[],
  condSlots: readonly CondSlotInfo[],
  table: EventScriptTable,
): EventTrace {
  const trace: EventTrace = {
    scripts: [],
    instructions: [],
    chapterSlots: [],
    loadBlockCount: 0,
    loadBlockUnits: [],
  };
  if (table.scripts.length === 0) return trace;

  const scriptIds = new Map<number, number>();
  const blockIds = new Map<number, number>();
  const decoded = new Set<number>();
  /** Scripts queued by CALL edges, decoded after the slot pass. */
  const queue: number[] = [];
  const queued = new Set<number>();

  const scriptIdOf = (addr: number): number => {
    const known = scriptIds.get(addr);
    if (known !== undefined) return known;
    const id = scriptIds.size;
    scriptIds.set(addr, id);
    if (!queued.has(addr)) {
      queued.add(addr);
      queue.push(addr);
    }
    return id;
  };

  const blockIdOf = (addr: number): number => {
    const known = blockIds.get(addr);
    if (known !== undefined) return known;
    const id = blockIds.size;
    blockIds.set(addr, id);
    for (const [position, u] of readPlacements(rom, addr, layout).entries()) {
      trace.loadBlockUnits.push({
        blockId: id,
        position,
        unitId: u.unitId,
        classId: u.classId,
        level: u.level,
        side: u.side,
        x: u.prePlacementCoord.x,
        y: u.prePlacementCoord.y,
      });
    }
    return id;
  };

  const decodeInstruction = (
    code: EventCode,
    scriptId: number,
    seq: number,
  ): TracedInstruction => {
    const mnemonic = code.script.description === "UNKNOWN" ? "UNKNOWN" : mnemonicOf(code.script.description);
    const row: TracedInstruction = {
      scriptId,
      seq,
      opcode: mnemonic || code.script.description,
      category: code.script.category,
      bytesHex: hex(code.bytes),
      loadKind: null,
      blockId: null,
      callScriptId: null,
      targetMap: null,
      goldDelta: null,
      itemId: null,
      giveUnitId: null,
    };

    for (const arg of code.script.args) {
      if (arg.type === "POINTER_EVENT") {
        const target = rom.toOffset(argValue(rom, code, arg.symbol));
        if (rom.isSafeOffset(target)) row.callScriptId = scriptIdOf(target);
      } else if (arg.type === "POINTER_UNIT") {
        const raw = argValue(rom, code, arg.symbol);
        if (!rom.isSafePointer(raw)) continue;
        const target = rom.toOffset(raw);
        if (target === 0xff_ffff) continue; // INVALIDATE_UNIT_POINTER
        if (!rom.isSafeOffset(target)) continue;
        row.loadKind = classifyUnitArg(code.script.pattern, arg.position);
        row.blockId = blockIdOf(target);
      }
    }

    if (code.script.category.includes("MAP") && TRANSITION_OPCODES.has(mnemonic)) {
      row.targetMap = destinationOf(rom, code);
    }
    // Gold literals and item grants do not depend on the opcode being known.
    row.goldDelta = findGoldLiteralsIn(code)[0]?.delta ?? null;
    if (code.script.category.includes("{ITEM}")) {
      const itemArg = code.script.args.find((a) => a.type === "ITEM");
      const unitArg = code.script.args.find((a) => a.type === "UNIT");
      row.itemId = itemArg === undefined ? null : argValue(rom, code, itemArg.symbol);
      row.giveUnitId = unitArg === undefined ? null : argValue(rom, code, unitArg.symbol);
    }
    return row;
  };

  const decodeScript = (start: number): void => {
    const id = scriptIds.get(start);
    if (id === undefined || decoded.has(id)) return;
    decoded.add(id);

    let addr = start;
    let lastBranchAddr = 0;
    let unknowns = 0;
    let seq = 0;
    let stopReason = "budget";

    while (seq < MAX_SCRIPT_INSTRUCTIONS) {
      if (!rom.isSafeOffset(addr)) {
        stopReason = "end-of-rom";
        break;
      }
      const code = disassemble(rom, addr, table);
      if (isExitCode(rom, code, lastBranchAddr)) {
        stopReason = "exit";
        break;
      }
      trace.instructions.push(decodeInstruction(code, id, seq));
      seq++;

      if (code.script.has === "UNKNOWN") {
        unknowns++;
        if (unknowns > MAX_CONSECUTIVE_UNKNOWNS) {
          stopReason = "unknowns";
          break;
        }
      } else {
        unknowns = 0;
        if (code.script.has === "IF_CONDITIONAL") lastBranchAddr = addr;
        else if (code.script.has === "LABEL_CONDITIONAL") lastBranchAddr = 0;
      }
      addr += code.script.size;
    }
    trace.scripts.push({ id, stopReason, instructionCount: seq });
  };

  // Slot pass: link every chapter's condition slots to their scripts.
  const map = layout.map;
  for (const chapter of chapters) {
    if (map === null || chapter.condTableAddr === 0) continue;
    const isFe7 = layout.version === "FE7U" || layout.version === "FE7J";

    const link = (slotIndex: number, slotKind: string, position: number, dataHex: string, scriptAddr: number): void => {
      trace.chapterSlots.push({
        mapIndex: chapter.index,
        slotIndex,
        slotKind,
        position,
        dataHex,
        scriptId: scriptIdOf(scriptAddr),
      });
    };

    for (const slot of condSlots) {
      const addr = chapter.condPointers[slot.index] ?? 0;
      if (!rom.isSafeOffset(addr)) continue;

      switch (slot.kind) {
        case "TURN": {
          for (let a = addr, pos = 0; ; a += map.turnCondSize, pos++) {
            if (!rom.isSafeOffset(a + map.turnCondSize)) break;
            const type = rom.u8(a);
            if (type === 0) break;
            const event = rom.p32(a + 4);
            if (rom.isSafeOffset(event)) {
              const size = isFe7 && type === 1 ? 12 : map.turnCondSize;
              link(slot.index, slot.kind, pos, hex(Buffer.from(rom.bytes(a, size))), event);
            }
            // "信じられないがFE7は12バイトの短いターンイベントが存在する"
            if (isFe7 && type === 1) a -= map.turnCondSize - 12;
          }
          break;
        }
        case "TALK": {
          for (let a = addr, pos = 0; ; a += map.talkCondSize, pos++) {
            if (!rom.isSafeOffset(a + map.talkCondSize)) break;
            if (rom.u8(a) === 0) break;
            const event = rom.p32(a + 4);
            if (rom.isSafeOffset(event)) {
              link(slot.index, slot.kind, pos, hex(Buffer.from(rom.bytes(a, map.talkCondSize))), event);
            }
          }
          break;
        }
        case "OBJECT":
        case "ALWAYS": {
          const endOnU32 = slot.kind === "ALWAYS";
          for (let a = addr, pos = 0; ; a += 12, pos++) {
            if (!rom.isSafeOffset(a + 12)) break;
            if (endOnU32 ? rom.u32(a) === 0 : rom.u8(a) === 0) break;
            const event = rom.p32(a + 4);
            if (rom.isSafeOffset(event)) {
              link(slot.index, slot.kind, pos, hex(Buffer.from(rom.bytes(a, 12))), event);
            }
          }
          break;
        }
        case "TUTORIAL": {
          for (let a = addr, pos = 0; ; a += 4, pos++) {
            if (!rom.isSafeOffset(a + 4)) break;
            if (!RB.isPointer(rom.u32(a))) break;
            const event = rom.p32(a);
            if (rom.isSafeOffset(event)) link(slot.index, slot.kind, pos, "", event);
          }
          break;
        }
        case "START_EVENT":
        case "END_EVENT":
          link(slot.index, slot.kind, 0, "", addr);
          break;
        default:
          break; // PLAYER_UNIT / ENEMY_UNIT / FREEMAP_* / TRAP: not scripts
      }
    }
  }

  // Decode the queue: slot scripts first, CALL-reachable helpers after.
  while (queue.length > 0) {
    decodeScript(queue.shift() as number);
  }

  trace.loadBlockCount = blockIds.size;
  return trace;
}
