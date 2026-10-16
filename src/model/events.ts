import type { LoadKind, UnitSide } from "./game.ts";

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

/** The turn window a `TURN` record is active over. */
export interface TurnWindow {
  /** 開始ターン (`+8`). */
  start: number;
  /** 終了ターン (`+9`). */
  end: number;
  /** ターン前指定 (`+10`), or `null` for an unrecognised byte. */
  phase: TurnPhase | null;
}

/**
 * The character pair a `TALK` record fires on. Upstream names the two bytes
 * `from_unit` / `to_unit` (`EventCondForm.MakeTalkUnitPointer`) and draws a unit
 * face from each, so the same names are kept here.
 *
 * A conversation is **two** records, A→B and B→A, sharing their `+2` flag; that
 * flag is the identity of one conversation, not of one row.
 */
export interface TalkPair {
  /** 話す人 (`+8`)：发起方。`0` = 任何人皆可发起，不是单位表 id。 */
  from: number;
  /** 話される人 (`+9`)：被搭话方。 */
  to: number;
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
  /**
   * `TALK` only; `null` otherwise. The character pair whose adjacency makes the
   * talk command available (`EventCondForm` draws a unit face from each id).
   */
  talk: TalkPair | null;
  /**
   * `TURN` / `TALK` only: the flag word at `+2`, which both record shapes carry
   * (`EventCondForm.InitN02` / `InitTalk` label it `W2`). For `TURN` it is set
   * once the event has run (達成フラグ); for `TALK` both directions of one
   * conversation share it, so it identifies the conversation.
   */
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

/** Decoded evidence consumed by pure event walks, whether extracted or persisted. */
export interface EventGraph {
  scripts: readonly TracedScript[];
  instructions: readonly TracedInstruction[];
  chapterSlots: readonly ChapterEventSlot[];
  loadBlockUnits: readonly TracedBlockUnit[];
}

/** Shared diagnostic for extract, census and database-backed analyses. */
export function eventDecodeWarning(scripts: readonly TracedScript[]): string | null {
  const incomplete = scripts.filter(
    (s) => s.stopReason !== "exit" || s.unknownInstructionCount > 0,
  );
  if (incomplete.length === 0) return null;
  return (
    `${incomplete.length}/${scripts.length} event scripts contain unknown instructions ` +
    "or stopped without an exit; event-derived results are partial. " +
    "Inspect event_scripts.stop_reason and unknown_instruction_count."
  );
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
 * script). A CALL-shared helper is attributed to every chapter that reaches it.
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

/** Every reachable POINTER_UNIT instruction with its unit block attached. */
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
