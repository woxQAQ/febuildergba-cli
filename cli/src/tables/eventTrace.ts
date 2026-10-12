/**
 * The raw event layer: chapter condition slots, event scripts and their
 * disassembled instruction streams. This is the *evidence* the walk-based
 * derivations compute from: which slot of which chapter points at which script,
 * what instructions each contains, what their arguments are - nothing else.
 * The control-flow layer (CALL reach, which loads count as recruits) is
 * `reachableScripts` / `reachableInstructions` below, computed from this trace;
 * the CLI commands consume those, `db/populate.ts` persists the raw layer.
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
 *     (PLAYER_UNIT / ENEMY_UNIT / TRAP / FREEMAP_*) are not scripts.
 *   - `POINTER_UNIT` blocks use the same `readPlacements` reader as the initial
 *     placement blocks (same record format).
 */

import type { RomBuffer } from "../rom/RomBuffer.ts";
import { RomBuffer as RB } from "../rom/RomBuffer.ts";
import type { GameLayout } from "../data/layouts.ts";
import type { EventCode, EventScriptTable } from "./eventScript.ts";
import {
  classifyUnitArg, destinationOf, disassemble, findGoldLiteralsIn, isExitCode, TRANSITION_OPCODES,
} from "./eventScript.ts";
import type { LoadKind } from "./eventScript.ts";
import type { Chapter, CondSlotInfo, UnitSide } from "./chapters.ts";
import { readPlacements } from "./chapters.ts";

export interface TracedScript {
  id: number;
  address: number;
  /** Why the linear decode stopped; "exit" is the clean case. */
  stopReason: string;
  instructionCount: number;
  unknownInstructionCount: number;
}

export interface TracedArgument {
  position: number;
  size: number;
  symbol: string;
  type: string;
  value: number;
}

export interface UnitLoad {
  position: number;
  kind: LoadKind;
  blockId: number;
}

export interface ScriptCall {
  position: number;
  scriptId: number;
}

export interface GoldWrite {
  offset: number;
  delta: number;
}

export interface ItemGrant {
  position: number;
  itemId: number;
  unitId: number | null;
}

export interface TracedInstruction {
  scriptId: number;
  /** Ordinal within the script's linear decode. */
  seq: number;
  address: number;
  /** Hex-encoded bytes and matched pattern, retained for re-interpretation. */
  bytes: string;
  pattern: string;
  args: TracedArgument[];
  /** Mnemonic from the opcode table, e.g. `MNC2`; "UNKNOWN" when unmatched. */
  opcode: string;
  /** The opcode table's `{CATEGORY}` tokens. */
  category: string;
  /** Composite instructions can reference several blocks and sub-events. */
  loads: UnitLoad[];
  calls: ScriptCall[];
  /** Destination map of a transition opcode; NULL otherwise. */
  targetMap: number | null;
  gold: GoldWrite[];
  /** Unit id 0xFFFF denotes the unit currently acting. */
  items: ItemGrant[];
}

/**
 * ターン前指定 (`+10`): which side's turn fires the event. Upstream knows exactly
 * three encodings (`EventCondForm.DrawEventListTurn` tests `0x00`/`0x40`/`0x80`:
 * 自ターン / 友軍ターン / 敵軍ターン), so anything else is `null`.
 */
export type TurnPhase = "player" | "ally" | "enemy";

/** The turn window a `TURN` record is active over. */
export interface TurnWindow {
  /** 開始ターン (`+8`). */
  start: number;
  /** 終了ターン (`+9`). */
  end: number;
  /** ターン前指定 (`+10`), or `null` for an unrecognised byte. */
  phase: TurnPhase | null;
}

/** One condition-slot entry of one chapter, linked to its script. */
export interface ChapterEventSlot {
  mapIndex: number;
  slotIndex: number;
  slotKind: string;
  /** Row number within a table-kind slot; 0 for direct slots. */
  position: number;
  scriptId: number | null;
  /**
   * `TURN` only; `null` otherwise (other slot kinds carry no turn fields).
   * `end <= start` means "turn `start`, once" - upstream prints a range only when
   * `start < end` (`EventCondForm.DrawEventListTurn`), the game's own condition,
   * so both bytes are kept verbatim.
   */
  turn: TurnWindow | null;
  /** `TURN` only: 達成フラグ (`+2`), the flag set once the event has run. */
  condFlag: number | null;
}

export interface TracedBlockUnit {
  blockId: number;
  position: number;
  unitId: number;
  /** 0 = the unit's own class. */
  classId: number;
  level: number;
  side: UnitSide;
  /** 0 = fixed stats, 1 = grow to `level` on the class's growths. */
  autolevel: number;
  x: number;
  y: number;
  /**
   * `+12..15`: the four starting items, `0` = empty. The event unit block is the
   * same record the deployment blocks use (`EventUnitForm.Designer.cs` labels
   * `B12..B15` 所持品1..4; `DrawItemIconOnly` reads `addr + 12 + n`), so this is
   * the only place an *enemy's* equipment lives. Slot 0 is not a declared equip
   * slot - GBA FE picks the weapon at battle time - so "attack power" means
   * joining `items` and choosing.
   */
  items: number[];
  /**
   * Decoded `ext` of the packed coordinate (`+4` bits 12-14); FE8 only (`null`
   * on FE6/FE7, whose coordinate word is a plain two-byte x/y). Bit `0x2` is
   * アイテムドロップ (drops its item on death; `EventUnitForm.cs:2575`); the rest
   * is the pre-placement animation/pose selector.
   */
  ext: number | null;
}

export interface EventTrace {
  scripts: TracedScript[];
  instructions: TracedInstruction[];
  chapterSlots: ChapterEventSlot[];
  blocks: { id: number; address: number }[];
  loadBlockUnits: TracedBlockUnit[];
}

/**
 * The slice of the trace the reach walk reads: the instruction stream, the
 * chapter-to-script links and the load-block contents. `EventTrace` satisfies
 * it structurally, and the db loader (`db/queries.ts` `trace()`) rebuilds
 * exactly this
 * shape from the persisted event tables - the walk below exists once and both
 * data sources feed it.
 */
export interface EventGraph {
  scripts: readonly TracedScript[];
  instructions: readonly TracedInstruction[];
  chapterSlots: readonly ChapterEventSlot[];
  loadBlockUnits: readonly TracedBlockUnit[];
}

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

/** Shared diagnostic for extract, census and database-backed analyses. */
export function eventDecodeWarning(scripts: readonly TracedScript[]): string | null {
  const incomplete = scripts.filter((s) => s.stopReason !== "exit" || s.unknownInstructionCount > 0);
  if (incomplete.length === 0) return null;
  return `${incomplete.length}/${scripts.length} event scripts contain unknown instructions ` +
    "or stopped without an exit; event-derived results are partial. " +
    "Inspect event_scripts.stop_reason and unknown_instruction_count.";
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
          for (let offset = Math.ceil((arg.position + arg.size) / 4) * 4;
            offset + 4 <= code.bytes.length; offset += 4) {
            if (code.script.pattern.slice(offset * 2, offset * 2 + 4) === "2037") {
              unitId = code.bytes.readUInt16LE(offset + 2);
              break;
            }
          }
          if (unitId === null) {
            const units = row.args.filter((a) => a.type === "UNIT");
            const unitArg = units.find((a) => a.position > arg.position) ??
              (units.length === 1 ? units[0] : undefined);
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
    trace.scripts.push({ id, address: start, stopReason, instructionCount: seq, unknownInstructionCount });
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
      /** `TURN` records only: their turn window and flag. */
      extra: { turn: TurnWindow; condFlag: number } | null = null,
    ): void => {
      trace.chapterSlots.push({
        mapIndex: chapter.index,
        slotIndex,
        slotKind,
        position,
        scriptId: scriptIdOf(scriptAddr),
        turn: extra === null ? null : extra.turn,
        condFlag: extra === null ? null : extra.condFlag,
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
          for (let a = addr, pos = 0; ; a += map.talkCondSize, pos++) {
            if (!rom.isSafeOffset(a + map.talkCondSize)) break;
            if (rom.u8(a) === 0) break;
            const event = rom.p32(a + 4);
            if (rom.isSafeOffset(event)) {
              link(slot.index, slot.kind, pos, event);
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

export interface ScriptReachOptions {
  /** Seed only slots of this kind (e.g. `END_EVENT`); absent seeds every slot. */
  slotKind?: string;
  /** Deepest CALL chain to follow; absent means unbounded. */
  maxDepth?: number;
}

/**
 * The (mapIndex, scriptId) pairs reachable from chapter condition slots, each
 * with the shallowest CALL depth it was reached at (0 = the chapter's own slot
 * script). This is the in-memory form of the reachability the extract views
 * used to compute with a recursive CTE over `chapter_event_slots` and
 * `event_instructions`; both sides attribute a CALL-shared helper to every
 * chapter that reaches it, which is its in-game behaviour.
 */
export function reachableScripts(
  trace: EventGraph,
  options: ScriptReachOptions = {},
): Map<number, Map<number, number>> {
  // CALL edges per script, decoded once here so the breadth-first pass below
  // does not re-scan the instruction stream per chapter.
  const calls = new Map<number, number[]>();
  for (const i of trace.instructions) {
    for (const call of i.calls) {
      const list = calls.get(i.scriptId);
      if (list === undefined) calls.set(i.scriptId, [call.scriptId]);
      else if (!list.includes(call.scriptId)) list.push(call.scriptId);
    }
  }

  const reached = new Map<number, Map<number, number>>();
  const queue: { mapIndex: number; scriptId: number; depth: number }[] = [];
  for (const slot of trace.chapterSlots) {
    if (slot.scriptId === null) continue;
    if (options.slotKind !== undefined && slot.slotKind !== options.slotKind) continue;
    queue.push({ mapIndex: slot.mapIndex, scriptId: slot.scriptId, depth: 0 });
  }
  for (let head = 0; head < queue.length; head++) {
    const { mapIndex, scriptId, depth } = queue[head] as (typeof queue)[number];
    let perMap = reached.get(mapIndex);
    if (perMap === undefined) reached.set(mapIndex, (perMap = new Map()));
    const known = perMap.get(scriptId);
    if (known !== undefined && known <= depth) continue;
    perMap.set(scriptId, depth);
    if (options.maxDepth !== undefined && depth >= options.maxDepth) continue;
    for (const target of calls.get(scriptId) ?? []) {
      queue.push({ mapIndex, scriptId: target, depth: depth + 1 });
    }
  }
  return reached;
}

/** One instruction of a script a chapter can reach. */
export interface ReachedInstruction {
  mapIndex: number;
  instruction: TracedInstruction;
  /** CALL depth the script was reached at: 0 = the chapter's own slot script. */
  depth: number;
}

/**
 * Every instruction of every reachable script, attributed to the chapter that
 * reaches it - a shared helper appears once per calling chapter. Ordered by
 * seed order (chapters in table order), then script, then decode order.
 */
export function reachableInstructions(
  trace: EventGraph,
  options: ScriptReachOptions = {},
): ReachedInstruction[] {
  const byScript = new Map<number, TracedInstruction[]>();
  for (const i of trace.instructions) {
    const list = byScript.get(i.scriptId);
    if (list === undefined) byScript.set(i.scriptId, [i]);
    else list.push(i);
  }
  const out: ReachedInstruction[] = [];
  for (const [mapIndex, scripts] of reachableScripts(trace, options)) {
    for (const [scriptId, depth] of scripts) {
      for (const instruction of byScript.get(scriptId) ?? []) {
        out.push({ mapIndex, instruction, depth });
      }
    }
  }
  return out;
}

/** A load site a chapter can reach, with the units its block brings in. */
export interface ReachedLoadSite {
  mapIndex: number;
  scriptId: number;
  seq: number;
  /** Operand position distinguishes multiple loads in one instruction. */
  position: number;
  /** Load classification of the POINTER_UNIT argument; never null or "other". */
  kind: "recruit" | "load" | "cutscene";
  blockId: number;
  units: TracedBlockUnit[];
}

/**
 * Every reachable POINTER_UNIT instruction with its unit block attached - the
 * answer to "which units does this chapter load, and from which script". The
 * `recruits` command prints this directly; `joins` folds it into the
 * per-unit earliest-appearance derivation.
 */
export function reachedLoadSites(trace: EventGraph): ReachedLoadSite[] {
  const unitsByBlock = new Map<number, TracedBlockUnit[]>();
  for (const u of trace.loadBlockUnits) {
    const list = unitsByBlock.get(u.blockId);
    if (list === undefined) unitsByBlock.set(u.blockId, [u]);
    else list.push(u);
  }
  const out: ReachedLoadSite[] = [];
  for (const { mapIndex, instruction } of reachableInstructions(trace)) {
    for (const load of instruction.loads) {
      if (load.kind === "other") continue;
      out.push({
        mapIndex,
        scriptId: instruction.scriptId,
        seq: instruction.seq,
        position: load.position,
        kind: load.kind,
        blockId: load.blockId,
        units: unitsByBlock.get(load.blockId) ?? [],
      });
    }
  }
  return out;
}
