/**
 * The raw event layer: chapter condition slots, event scripts and their
 * disassembled instruction streams. This is the *evidence* the walk-based
 * derivations compute from: which slot of which chapter points at which script,
 * what instructions each contains, what their arguments are - nothing else.
 * The control-flow layer (CALL reach, which loads count as recruits) is
 * `model/events.ts`, computed from this trace;
 * the CLI commands consume those, `repository/write.ts` persists the raw layer.
 *
 * Extraction rules, all mechanical:
 *   - Scripts are identified by start offset and decoded **once**; a CALL-shared
 *     helper gets one row set. Decoding is linear from the start, stopping at an
 *     exit opcode (the reference's branch-aware `isExitCode`), after >10
 *     consecutive unknown instructions, or at a hard budget. UNKNOWN
 *     instructions are stored, not skipped - their size is a guess
 *     (`UNKNOWN_SIZE`), so the script row records where and why it stopped.
 *   - Slot iteration follows `EventCondForm.MakeUnitPointer`: TURN/TALK/OBJECT/
 *     ALWAYS walk small records with a script pointer at +4, TUTORIAL a pointer
 *     array, START_EVENT/END_EVENT point straight at a script; the rest
 *     (PLAYER_UNIT / ENEMY_UNIT / TRAP / FREEMAP_*) are not scripts. TURN and
 *     TALK records carry more than a script pointer, and both are kept: TURN's
 *     turn window, TALK's character pair.
 *   - `POINTER_UNIT` blocks use the same `readPlacements` reader as the initial
 *     placement blocks (same record format).
 */

import type { RomBuffer } from "../rom/RomBuffer.ts";
import { RomBuffer as RB } from "../rom/RomBuffer.ts";
import type { GameLayout } from "../data/layouts.ts";
import type { EventCode, EventScriptTable } from "./eventScript.ts";
import {
  classifyUnitArg,
  destinationOf,
  disassemble,
  findGoldLiteralsIn,
  isExitCode,
  TRANSITION_OPCODES,
} from "./eventScript.ts";
import type { Chapter, CondSlotInfo } from "../model/snapshotRecords.ts";
import { readPlacements } from "./chapters.ts";

import type {
  TracedInstruction,
  TalkPair,
  EventTrace,
  TurnPhase,
  TurnWindow,
} from "../model/events.ts";

/** One decode policy for every event consumer. */
const MAX_CONSECUTIVE_UNKNOWNS = 10;
/** Per-script instruction ceiling. */
const MAX_SCRIPT_INSTRUCTIONS = 4000;

/** Decode ターン前指定; `null` for a byte upstream does not recognise. */
function turnPhase(byte: number): TurnPhase | null {
  if (byte === 0x00) return "player";
  if (byte === 0x40) return "ally";
  if (byte === 0x80) return "enemy";
  return null;
}

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
    blocks: [],
    loadBlockUnits: [],
  };
  if (table.scripts.length === 0) return trace;

  const scriptIds = new Map<number, number>();
  const blockIds = new Map<number, number>();
  /** Scripts queued by CALL edges, decoded after the slot pass. */
  const queue: number[] = [];

  const scriptIdOf = (addr: number): number => {
    const known = scriptIds.get(addr);
    if (known !== undefined) return known;
    const id = scriptIds.size;
    scriptIds.set(addr, id);
    queue.push(addr);
    return id;
  };

  const blockIdOf = (addr: number): number => {
    const known = blockIds.get(addr);
    if (known !== undefined) return known;
    const id = blockIds.size;
    blockIds.set(addr, id);
    trace.blocks.push({ id, address: addr });
    for (const [position, u] of readPlacements(rom, addr, layout).entries()) {
      trace.loadBlockUnits.push({
        blockId: id,
        position,
        unitId: u.unitId,
        classId: u.classId,
        level: u.level,
        side: u.side,
        autolevel: u.autolevel,
        x: u.prePlacementCoord.x,
        y: u.prePlacementCoord.y,
        items: u.items,
        ext: u.prePlacementCoord.ext,
      });
    }
    return id;
  };

  const decodeInstruction = (code: EventCode, scriptId: number, seq: number): TracedInstruction => {
    const row: TracedInstruction = {
      scriptId,
      seq,
      address: code.addr,
      bytes: code.bytes.toString("hex"),
      pattern: code.script.pattern,
      args: code.script.args
        .filter((arg) => arg.type !== "FIXED")
        .map((arg) => ({
          position: arg.position,
          size: arg.size,
          symbol: arg.symbol,
          type: arg.type,
          value: readArgument(rom, code, arg.position, arg.size),
        })),
      opcode: code.script.opcode,
      category: code.script.category,
      loads: [],
      calls: [],
      targetMap: null,
      gold: findGoldLiteralsIn(code),
      items: [],
    };

    for (const arg of row.args) {
      if (arg.type === "POINTER_EVENT") {
        if (!rom.isSafePointer(arg.value)) continue;
        row.calls.push({ position: arg.position, scriptId: scriptIdOf(rom.toOffset(arg.value)) });
      } else if (arg.type === "POINTER_UNIT") {
        const raw = arg.value;
        if (!rom.isSafePointer(raw)) continue;
        const target = rom.toOffset(raw);
        if (target === 0xff_ffff) continue; // INVALIDATE_UNIT_POINTER
        if (!rom.isSafeOffset(target)) continue;
        row.loads.push({
          position: arg.position,
          kind: classifyUnitArg(code.script.pattern, arg.position),
          blockId: blockIdOf(target),
        });
      }
    }

    if (code.script.category.includes("MAP") && TRANSITION_OPCODES.has(row.opcode)) {
      row.targetMap = destinationOf(rom, code);
    }
    if (code.script.category.includes("{ITEM}")) {
      for (const arg of row.args) {
        if (arg.type === "ITEM") {
          // Bind each item to its own following GIVEITEMTO operand. A fixed
          // 0xFFFF recipient denotes the active unit even without a UNIT arg.
          let unitId: number | null = null;
          for (
            let offset = Math.ceil((arg.position + arg.size) / 4) * 4;
            offset + 4 <= code.bytes.length;
            offset += 4
          ) {
            if (code.script.pattern.slice(offset * 2, offset * 2 + 4) === "2037") {
              unitId = code.bytes.readUInt16LE(offset + 2);
              break;
            }
          }
          if (unitId === null) {
            const units = row.args.filter((a) => a.type === "UNIT");
            const unitArg =
              units.find((a) => a.position > arg.position)
              ?? (units.length === 1 ? units[0] : undefined);
            unitId = unitArg?.value ?? null;
          }
          row.items.push({ position: arg.position, itemId: arg.value, unitId });
        }
      }
    }
    return row;
  };

  const decodeScript = (start: number): void => {
    const id = scriptIds.get(start);
    if (id === undefined) throw new Error(`unqueued event script at ${start}`);

    let addr = start;
    let lastBranchAddr = 0;
    let unknowns = 0;
    let unknownInstructionCount = 0;
    let seq = 0;
    let stopReason = "budget";

    while (seq < MAX_SCRIPT_INSTRUCTIONS) {
      if (!rom.isSafeOffset(addr)) {
        stopReason = "end-of-rom";
        break;
      }
      const code = disassemble(rom, addr, table);
      // The terminating instruction is evidence too, and may carry effects.
      const exit = isExitCode(rom, code, lastBranchAddr);
      trace.instructions.push(decodeInstruction(code, id, seq));
      seq++;

      if (exit) {
        stopReason = "exit";
        break;
      }
      if (code.script.has === "UNKNOWN") {
        unknowns++;
        unknownInstructionCount++;
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
    trace.scripts.push({
      id,
      address: start,
      stopReason,
      instructionCount: seq,
      unknownInstructionCount,
    });
  };

  // Slot pass: link every chapter's condition slots to their scripts.
  const map = layout.map;
  for (const chapter of chapters) {
    if (map === null || chapter.condTableAddr === 0) continue;
    const isFe7 = layout.version === "FE7U" || layout.version === "FE7J";

    const link = (
      slotIndex: number,
      slotKind: string,
      position: number,
      scriptAddr: number,
      /**
       * The fields a record shape adds beyond its script pointer: `TURN`'s turn
       * window and `TALK`'s character pair, on the record shapes that carry them.
       */
      extra: { turn?: TurnWindow; talk?: TalkPair; condFlag?: number } | null = null,
    ): void => {
      trace.chapterSlots.push({
        mapIndex: chapter.index,
        slotIndex,
        slotKind,
        position,
        scriptId: scriptIdOf(scriptAddr),
        turn: extra?.turn ?? null,
        talk: extra?.talk ?? null,
        condFlag: extra?.condFlag ?? null,
      });
    };

    for (const slot of condSlots) {
      const addr = chapter.condPointers[slot.index] ?? 0;
      if (!rom.isSafeOffset(addr)) continue;

      switch (slot.kind) {
        case "TURN": {
          for (let a = addr, pos = 0; ; a += map.turnCondSize, pos++) {
            if (!rom.isSafeOffset(a + map.turnCondSize)) break;
            // Upstream's TURN terminator is the whole `u32` at +0, not just its
            // first byte (`EventCondForm.InitN02`, `u32(addr + 0) != 0`) - the
            // ALWAYS slot below already matches that shape.
            if (rom.u32(a) === 0) break;
            const type = rom.u8(a);
            const event = rom.p32(a + 4);
            if (rom.isSafeOffset(event)) {
              link(slot.index, slot.kind, pos, event, {
                turn: {
                  start: rom.u8(a + 8),
                  end: rom.u8(a + 9),
                  phase: turnPhase(rom.u8(a + 10)),
                },
                condFlag: rom.u16(a + 2),
              });
            }
            // "信じられないがFE7は12バイトの短いターンイベントが存在する"
            if (isFe7 && type === 1) a -= map.turnCondSize - 12;
          }
          break;
        }
        case "TALK": {
          // 16-byte records (`eventcond_talk_size`). `+0` is the condition kind
          // (`EventCondForm`'s `TALK_L_0_COMBO`: `0x3` talk command, `0x4`
          // talk-command ASM) and doubles as the terminator; `+2` the flag, `+4`
          // the script, `+8`/`+9` the character pair whose adjacency offers the
          // command (`from_unit` / `to_unit` upstream). A talk is stored twice,
          // once per direction, sharing the flag; `from` `0` means "any unit may
          // initiate", which is why one flag can carry several records. The kind
          // byte is not persisted: this ROM carries only `0x3`, and nothing
          // consumes the ASM variant (`+12`/`+14`, unused here).
          for (let a = addr, pos = 0; ; a += map.talkCondSize, pos++) {
            if (!rom.isSafeOffset(a + map.talkCondSize)) break;
            if (rom.u8(a) === 0) break;
            const event = rom.p32(a + 4);
            if (rom.isSafeOffset(event)) {
              link(slot.index, slot.kind, pos, event, {
                talk: { from: rom.u8(a + 8), to: rom.u8(a + 9) },
                condFlag: rom.u16(a + 2),
              });
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
              link(slot.index, slot.kind, pos, event);
            }
          }
          break;
        }
        case "TUTORIAL": {
          for (let a = addr, pos = 0; ; a += 4, pos++) {
            if (!rom.isSafeOffset(a + 4)) break;
            if (!RB.isPointer(rom.u32(a))) break;
            const event = rom.p32(a);
            if (rom.isSafeOffset(event)) link(slot.index, slot.kind, pos, event);
          }
          break;
        }
        case "START_EVENT":
        case "END_EVENT":
          link(slot.index, slot.kind, 0, addr);
          break;
        default:
          break; // PLAYER_UNIT / ENEMY_UNIT / FREEMAP_* / TRAP: not scripts
      }
    }
  }

  // Decode the queue: slot scripts first, CALL-reachable helpers after.
  for (let head = 0; head < queue.length; head++) {
    decodeScript(queue[head] as number);
  }

  return trace;
}

function readArgument(rom: RomBuffer, code: EventCode, position: number, size: number): number {
  const at = code.addr + position;
  if (size === 1) return rom.u8(at);
  if (size === 2) return rom.u16(at);
  if (size === 4) return rom.u32(at);
  throw new Error(`unsupported event operand width ${size} at ${code.addr}+${position}`);
}
