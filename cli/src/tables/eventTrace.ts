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
  /** Ids only - the rows are in `loadBlockUnits`. */
  loadBlockCount: number;
  loadBlockUnits: TracedBlockUnit[];
}

/** `walkScript`'s consecutive-unknown tolerance, kept identical on purpose. */
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
    const mnemonic =
      code.script.description === "UNKNOWN" ? "UNKNOWN" : mnemonicOf(code.script.description);
    const row: TracedInstruction = {
      scriptId,
      seq,
      opcode: mnemonic || code.script.description,
      category: code.script.category,
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
  while (queue.length > 0) {
    decodeScript(queue.shift() as number);
  }

  trace.loadBlockCount = blockIds.size;
  return trace;
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
  trace: EventTrace,
  options: ScriptReachOptions = {},
): Map<number, Map<number, number>> {
  // CALL edges per script, decoded once here so the breadth-first pass below
  // does not re-scan the instruction stream per chapter.
  const calls = new Map<number, number[]>();
  for (const i of trace.instructions) {
    if (i.callScriptId === null) continue;
    const list = calls.get(i.scriptId);
    if (list === undefined) calls.set(i.scriptId, [i.callScriptId]);
    else if (!list.includes(i.callScriptId)) list.push(i.callScriptId);
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
  trace: EventTrace,
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
export function reachedLoadSites(trace: EventTrace): ReachedLoadSite[] {
  const unitsByBlock = new Map<number, TracedBlockUnit[]>();
  for (const u of trace.loadBlockUnits) {
    const list = unitsByBlock.get(u.blockId);
    if (list === undefined) unitsByBlock.set(u.blockId, [u]);
    else list.push(u);
  }
  const out: ReachedLoadSite[] = [];
  for (const { mapIndex, instruction } of reachableInstructions(trace)) {
    // A null loadKind never co-occurs with a blockId (decodeInstruction sets
    // them together), and "other" loads are not unit loads at all.
    if (instruction.blockId === null) continue;
    if (instruction.loadKind === null || instruction.loadKind === "other") continue;
    out.push({
      mapIndex,
      scriptId: instruction.scriptId,
      seq: instruction.seq,
      kind: instruction.loadKind,
      blockId: instruction.blockId,
      units: unitsByBlock.get(instruction.blockId) ?? [],
    });
  }
  return out;
}
