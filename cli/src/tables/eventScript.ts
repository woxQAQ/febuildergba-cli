/**
 * Event-script disassembler, ported from FEBuilderGBA's `EventScript.cs`.
 *
 * A unit's join chapter is not stored as a number: it is implied by the
 * chapter's event script - either the initial player placement or a recruit
 * instruction (`402C0100` + unit-info pointer, ユニット読込 自軍ユニットは仲間に
 * する). Finding those means walking the script byte by byte, which needs every
 * opcode length; that table is `config/data/event_<game>.txt` (625 patterns).
 *
 * Pattern format: `<pattern>\t<description>\t<hint>\t{category}\t...`. A byte
 * whose both nibbles are a non-hex letter is a variable; a run of the same
 * letter is one argument of that length (`40050B00XXXXYYYY` = `40 05 0B 00`
 * fixed, a 2-byte `X`, a 2-byte `Y`). Argument types come from the
 * description's `[XXXX:TYPE:name]` markers, as in `ParseInfoString`
 * (EventScript.cs:513).
 *
 * `EventScript.Load` sorts by descending pattern size, then fewer arguments,
 * then smaller total argument size, and `DisAseemble` returns the **first**
 * match - load-bearing, or a short pattern would shadow a longer one sharing a
 * prefix.
 */

import {
  parseTwoColumnTable,
  readTextFile,
  resolveDataFile,
  splitTab,
  isComment,
} from "../config/data.ts";
import type { RomBuffer } from "../rom/RomBuffer.ts";

/** Argument type names, matching `EventScript.ArgType` by string. */
export const ARG_TYPE_FIXED = "FIXED";

/** Types where the value must be a valid GBA pointer for the pattern to match. */
const POINTER_ARG_TYPES: ReadonlySet<string> = new Set([
  "POINTER",
  "POINTER_ASM",
  "POINTER_PROCS",
  "POINTER_EVENT",
  "POINTER_UNIT",
  "POINTER_EVENTBATTLEDATA",
  "POINTER_EVENTMOVEDATA",
  "POINTER_TALKGROUP",
  "POINTER_MENUEXTENDS",
  "POINTER_AICOORDINATE",
  "POINTER_AIUNIT",
  "POINTER_AITILE",
  "POINTER_AIRANGE",
  "POINTER_AICALLTALK",
  "POINTER_UNITSSHORTTEXT",
]);

/**
 * Types that may also be zero. `IsPointerArgsOrNULL` (EventScript.cs:1283)
 * lists only this one.
 */
const POINTER_OR_NULL_ARG_TYPES: ReadonlySet<string> = new Set(["POINTER_UNITSSHORTTEXT"]);

/** `ScriptHas` values we act on. */
export type ScriptHas =
  | "NOTHING"
  | "UNKNOWN"
  | "POINTER_UNIT_OR_EVENT"
  | "POINTER_OTHER"
  | "IF_CONDITIONAL"
  | "LABEL_CONDITIONAL"
  | "GOTO_CONDITIONAL"
  | "MAP"
  | "TEXT"
  | "TERM"
  | "MAPTERM"
  | "PATCH_EXTENDS"
  | "GIVE_ITEM";

export interface EventArg {
  /** Byte offset of the argument within the instruction. */
  position: number;
  /** Size in bytes. */
  size: number;
  /** The placeholder letter, e.g. `X`. */
  symbol: string;
  /** `ArgType` name, or `FIXED`. */
  type: string;
  /** Field name from the info string, e.g. `ユニット情報`. */
  name: string;
  /** Index of the first argument sharing this symbol, or -1. */
  alias: number;
}

export interface EventScriptDef {
  pattern: string;
  size: number;
  /** Literal bytes; positions covered by a variable argument are zeroed. */
  data: Buffer;
  args: EventArg[];
  /** `{CATEGORY}` tokens, concatenated. */
  category: string;
  has: ScriptHas;
  description: string;
}

export interface EventCode {
  script: EventScriptDef;
  addr: number;
  /** Raw bytes of this instruction. */
  bytes: Buffer;
}

/** Size of an unrecognised instruction. `EventScript.Init(unk_size = 4)`. */
export const UNKNOWN_SIZE = 4;

function cut(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  if (i < 0) return "";
  const j = source.indexOf(end, i + start.length);
  if (j < 0) return "";
  return source.slice(i + start.length, j);
}

/** Port of `EventScript.ParseInfoString` (EventScript.cs:513). */
function parseInfoString(info: string, symbol: string): { type: string; name: string } {
  const name = symbol;
  const sym = cut(info, `[${name}`, "]");
  if (sym.length <= 0) return { type: "None", name };

  const sp = sym.split(":");
  if (sp.length < 2) return { type: "None", name: sp[0] ?? symbol };

  return { type: (sp[1] ?? "").toUpperCase(), name: sp[2] ?? symbol };
}

/** Port of `EventScript.SelectAlias`. */
function selectAlias(args: readonly EventArg[], symbol: string): number {
  for (let i = 0; i < args.length; i++) {
    if (args[i]?.symbol === symbol) return i;
  }
  return -1;
}

/** Port of `EventScript.MakeScriptHas`. */
function makeScriptHas(
  args: readonly EventArg[],
  info: readonly string[],
  sourceLine: string,
): ScriptHas {
  for (const token of info) {
    if (token === "[TERM]") return "TERM";
    if (token === "[MAPTERM]") return "MAPTERM";
  }

  for (const arg of args) {
    if (arg.type === "IF_CONDITIONAL") return "IF_CONDITIONAL";
    if (arg.type === "LABEL_CONDITIONAL") return "LABEL_CONDITIONAL";
    if (arg.type === "GOTO_CONDITIONAL") return "GOTO_CONDITIONAL";
    if (arg.type === "POINTER_UNIT" || arg.type === "POINTER_EVENT") {
      return "POINTER_UNIT_OR_EVENT";
    }
    if (POINTER_ARG_TYPES.has(arg.type)) return "POINTER_OTHER";
    if (arg.type === "MAPCHAPTER") return "MAP";
    if (
      arg.type === "TEXT" ||
      arg.type === "CONVERSATION_TEXT" ||
      arg.type === "SYSTEM_TEXT" ||
      arg.type === "ONELINE_TEXT"
    ) {
      return "TEXT";
    }
  }

  if (sourceLine.includes("{ITEM}")) {
    for (const arg of args) {
      if (arg.type === "ITEM") return "GIVE_ITEM";
    }
  }

  return "NOTHING";
}

/** True when both nibbles of the byte at `i` are non-hex letters. */
function isVariableByte(pattern: string, i: number): boolean {
  const a = pattern[i];
  const b = pattern[i + 1];
  return a !== undefined && b !== undefined && a > "F" && b > "F";
}

/**
 * Port of `EventScript.SplitInfo` (EventScript.cs:392).
 *
 * Splits the info column into text and `[...]` segments, so that a marker
 * buried inside a description - `リターン[TERM](ENDA)` - becomes its own token
 * `[TERM]`. Splitting on tabs instead silently loses every `[TERM]` /
 * `[MAPTERM]`, and `MakeScriptHas` then fails to classify `20010000` as a
 * terminator. The walker stops only on
 * terminators, so it would run straight past the end of the script into
 * whatever bytes follow.
 */
export function splitInfo(info: string): string[] {
  const list: string[] = [];
  let pos = 0;
  while (pos < info.length) {
    const start = info.indexOf("[", pos);
    if (start < 0) {
      list.push(info.slice(pos));
      return list;
    }
    const end = info.indexOf("]", pos + 1);
    if (end < 0) {
      list.push(info.slice(pos));
      return list;
    }
    list.push(info.slice(pos, start));
    list.push(info.slice(start, end + 1));
    pos = end + 1;
  }
  return list;
}

/**
 * Port of `EventScript.ParseScriptLine` (EventScript.cs:290).
 *
 * Returns `null` for lines the reference itself rejects: too short, not a
 * multiple of 8 hex characters, or with no info column.
 */
export function parseScriptLine(line: string): EventScriptDef | null {
  const sp = line.split("\t");
  if (sp.length <= 1) return null;

  const pattern = sp[0] ?? "";
  const info = sp[1] ?? "";
  if (pattern.length < 8) return null;
  if (pattern.length % 8 !== 0) return null;

  const data = Buffer.alloc(pattern.length / 2);
  const args: EventArg[] = [];

  let i = 0;
  while (i < pattern.length) {
    if (isVariableByte(pattern, i)) {
      const symbol = pattern[i] as string;
      const start = i;
      data[i / 2] = 0;
      i += 2;
      while (i < pattern.length && pattern[i] === symbol) {
        data[i / 2] = 0;
        i += 2;
      }
      const size = (i - start) / 2;
      const parsed = parseInfoString(info, symbol);

      // `ErrorCheckArg`: a pointer argument shorter than 4 bytes is dropped.
      if (POINTER_ARG_TYPES.has(parsed.type) && size < 4) continue;

      args.push({
        position: start / 2,
        size,
        symbol,
        type: parsed.type,
        name: parsed.name,
        alias: selectAlias(args, symbol),
      });
    } else {
      const start = i;
      while (i < pattern.length && !isVariableByte(pattern, i)) {
        data[i / 2] = Number.parseInt(pattern.slice(i, i + 2), 16) & 0xff;
        i += 2;
      }
      args.push({
        position: start / 2,
        size: (i - start) / 2,
        symbol: "",
        type: ARG_TYPE_FIXED,
        name: "",
        alias: -1,
      });
    }
  }

  // `[TERM]` / `[MAPTERM]` live inside the info column and are only visible
  // after splitting on brackets, not on tabs. See {@link splitInfo}.
  const infoTokens = splitInfo(info);

  // Categories come from the columns *after* the info column, i.e. `sp[2..]`
  // (`EventScript.ParsePopupHintAndCategory`, EventScript.cs:436); reading them
  // out of the info column finds nothing.
  let category = "";
  for (let c = 2; c < sp.length; c++) {
    const token = sp[c] ?? "";
    if (token.length > 0 && token.startsWith("{")) category += token;
  }

  return {
    pattern,
    size: pattern.length / 2,
    data,
    args,
    category,
    has: makeScriptHas(args, infoTokens, line),
    description: info,
  };
}

function sumArgsSize(args: readonly EventArg[]): number {
  let n = 0;
  for (const a of args) n += a.size;
  return n;
}

/** Port of the `scripts.Sort(...)` in `EventScript.Load` (EventScript.cs:256). */
function sortScripts(scripts: EventScriptDef[]): EventScriptDef[] {
  return [...scripts].sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    if (a.args.length !== b.args.length) return a.args.length - b.args.length;
    return sumArgsSize(a.args) - sumArgsSize(b.args);
  });
}

const UNKNOWN_SCRIPT: EventScriptDef = {
  pattern: "",
  size: UNKNOWN_SIZE,
  data: Buffer.alloc(UNKNOWN_SIZE),
  args: [],
  category: "",
  has: "UNKNOWN",
  description: "unknown",
};

export interface EventScriptTable {
  scripts: EventScriptDef[];
  /** Path the table was loaded from, or `null` when `config/data` was absent. */
  source: string | null;
}

/** Load `event_<game>.txt`. */
export function loadEventScripts(
  configDir: string,
  game: string,
  language?: string,
): EventScriptTable {
  const path = resolveDataFile(configDir, "event_", game, language);
  if (path === null) return { scripts: [], source: null };

  const scripts: EventScriptDef[] = [];
  for (const raw of readTextFile(path).split(/\r?\n/)) {
    if (isComment(raw)) continue;
    const parsed = parseScriptLine(raw);
    if (parsed !== null) scripts.push(parsed);
  }
  return { scripts: sortScripts(scripts), source: path };
}

/** Port of `EventScript.DisAseemble` (EventScript.cs:622). First match wins. */
export function disassemble(rom: RomBuffer, addr: number, table: EventScriptTable): EventCode {
  const left = rom.length - addr;

  for (const script of table.scripts) {
    if (left < script.size) continue;

    let pos = 0;
    let matched = true;

    for (const arg of script.args) {
      if (arg.type === ARG_TYPE_FIXED) {
        for (let m = 0; m < arg.size; m++) {
          if (rom.u8(addr + pos) !== script.data[pos]) {
            matched = false;
            break;
          }
          pos++;
        }
        if (!matched) break;
      } else {
        if (POINTER_ARG_TYPES.has(arg.type)) {
          const v = rom.u32(addr + pos);
          if (POINTER_OR_NULL_ARG_TYPES.has(arg.type)) {
            if (v !== 0 && !rom.isSafePointer(v)) {
              matched = false;
              break;
            }
          } else if (!rom.isSafePointer(v)) {
            matched = false;
            break;
          }
        }
        pos += arg.size;
      }
    }

    if (matched && addr + script.size <= rom.length) {
      return { script, addr, bytes: Buffer.from(rom.bytes(addr, script.size)) };
    }
  }

  const size = Math.min(UNKNOWN_SIZE, Math.max(0, left));
  return {
    script: UNKNOWN_SCRIPT,
    addr,
    bytes: Buffer.from(rom.bytes(addr, size)),
  };
}

/**
 * Read an argument's value by symbol.
 *
 * `EventScript.GetArgValue` resolves aliases and pointer arguments the same way:
 * find the argument with that symbol and read `size` bytes at its position.
 */
export function argValue(rom: RomBuffer, code: EventCode, symbol: string): number {
  const arg = code.script.args.find((a) => a.symbol === symbol);
  if (arg === undefined) return 0;
  const at = code.addr + arg.position;
  switch (arg.size) {
    case 1:
      return rom.u8(at);
    case 2:
      return rom.u16(at);
    case 4:
      return rom.u32(at);
    default:
      return 0;
  }
}

/**
 * Port of `EventScript.IsExitCode` (EventScript.cs), with the FE8 dummy-end
 * check. `lastBranchAddr` is 0 when we have not seen an `IF_CONDITIONAL` yet.
 */
export function isExitCode(rom: RomBuffer, code: EventCode, lastBranchAddr: number): boolean {
  if (code.script.has !== "TERM" && code.script.has !== "MAPTERM") return false;

  if (lastBranchAddr === 0) {
    return !isFe8DummyEnd(rom, code);
  }
  if (code.addr - lastBranchAddr >= 0x28) return true;
  return false;
}

/** Port of `EventScript.IsFE8DummyEnd`. */
function isFe8DummyEnd(rom: RomBuffer, code: EventCode): boolean {
  if (code.script.has !== "TERM") return false;
  const next = code.addr + code.script.size;
  if (next + 4 >= rom.length) return false;

  if (rom.u8(next + 0) !== 0x20 || rom.u8(next + 1) !== 0x08) return false;
  const a5 = rom.u8(next + 4) & 0xf0;
  return a5 === 0x20 || a5 === 0x40;
}

/** Chapter-condition slot kinds, from `config/data/eventcond_<game>.txt`. */
export interface CondSlot {
  flag: string;
  name: string;
}

export function loadConditionSlots(configDir: string, game: string, language?: string): CondSlot[] {
  const path = resolveDataFile(configDir, "eventcond_", game, language);
  if (path === null) return [];
  return parseTwoColumnTable(readTextFile(path));
}

export { splitTab };
