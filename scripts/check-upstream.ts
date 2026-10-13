/**
 * Cross-check the two things in this repo that are hand-transcribed from
 * FEBuilderGBA and have nothing else verifying them:
 *
 *   1. `src/data/layouts.ts` - the per-game pointer tables, transcribed by eye
 *      from `FEBuilderGBA/FEBuilderGBA/ROMFE*.cs`.
 *   2. `cli/data/*.txt` - the 36 vendored `config/data` files, copied there by
 *      hand so `cli/` stands alone.
 *
 * Upstream line numbers move whenever FEBuilderGBA does, so this script checks
 * the transcription mechanically rather than trusting prose to stay accurate.
 *
 * Usage (from `cli/`):
 *
 *     node scripts/check-upstream.ts            # report and exit non-zero on drift
 *     node scripts/check-upstream.ts --update   # also record the submodule commit
 *
 * Exit codes: 0 everything agrees, 1 drift found, 2 the check could not run.
 *
 * It needs the `FEBuilderGBA` submodule, which `cli/` deliberately does not
 * need at runtime. Without it the script says so and exits 0 - a bare `cli/`
 * checkout is still valid, it just cannot be verified here.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { LAYOUTS } from "../src/data/layouts.ts";
import type { GameVersion } from "../src/model/game.ts";
import type { SlotRef } from "../src/data/layouts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, "..");
const REPO = join(CLI_ROOT, "..");
const VENDORED_DATA = join(CLI_ROOT, "data");
const STAMP_FILE = join(VENDORED_DATA, "UPSTREAM.txt");

/** The `config/data` families `cli/data/` vendors - see `src/config/data.ts`. */
const VENDORED_PREFIXES: readonly string[] = [
  "unitclass_checkbox_",
  "event_",
  "eventcond_",
  "item_staff_use_effect_",
];

/** `ROMFE8U.cs` and friends. The C# file each game's constants live in. */
const CS_FILE: Readonly<Record<GameVersion, string>> = {
  FE6J: "ROMFE6JP.cs",
  FE7J: "ROMFE7JP.cs",
  FE7U: "ROMFE7U.cs",
  FE8J: "ROMFE8JP.cs",
  FE8U: "ROMFE8U.cs",
};

/**
 * The map-setting editor each game opens. FE8J and FE8U share one form, which
 * is why they cannot disagree about the difficulty field's offset.
 */
const MAPSETTING_DESIGNER: Readonly<Record<GameVersion, string>> = {
  FE6J: "MapSettingFE6Form.Designer.cs",
  FE7J: "MapSettingFE7Form.Designer.cs",
  FE7U: "MapSettingFE7UForm.Designer.cs",
  FE8J: "MapSettingForm.Designer.cs",
  FE8U: "MapSettingForm.Designer.cs",
};

const hex = (n: number): string => `0x${n.toString(16).toUpperCase()}`;

// --------------------------------------------------------------------------
// Reading the C# side
// --------------------------------------------------------------------------

/** A value assigned in a `ROMFE*.cs` constructor. */
type CsValue =
  | { kind: "number"; value: number }
  | {
      kind: "find";
      checkPointer: number;
      checkBelow?: number;
      checkEqual?: number;
      candidates: readonly number[];
    };

/**
 * Every `<field> = <value>;` in the file, first assignment wins.
 *
 * Not a regex over the whole line: `U.FindROMPointer`'s predicate argument is a
 * lambda containing its own `;`, so the terminator has to be found with brace
 * depth in mind. First-wins matters for FE6, which sets
 * `map_setting_datasize` twice (a default, then a revision-specific value).
 */
function assignments(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const start = /([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
  let match: RegExpExecArray | null;

  while ((match = start.exec(source)) !== null) {
    const name = match[1] as string;
    let i = match.index + match[0].length;
    const from = i;
    let depth = 0;
    while (i < source.length) {
      const ch = source[i] as string;
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (ch === ";" && depth === 0) break;
      i++;
    }
    if (!out.has(name)) out.set(name, source.slice(from, i).trim());
  }
  return out;
}

const NUMBER = /(0x[0-9A-Fa-f]+|\d+)/;

/**
 * Turn a C# value into something comparable with our `SlotRef`.
 *
 * `U.FindROMPointer(rom, <probe>, <candidates>)` has two shapes for `<probe>`:
 * a bare offset (the probe must be a pointer) or a lambda
 * `(uint addr) => { return rom.u32(0x12) < 0xE; }`. For the lambda we take the
 * offset and the comparison, which is what `layouts.ts` stores as
 * `checkPointer` plus `checkBelow` / `checkEqual`.
 *
 * Note the lambda reads `rom.u32(0x12)` - a constant, not `addr + 0x12`. That
 * is the upstream bug `layouts.ts` documents under `checkBelow`: we compare the
 * numbers upstream wrote, not the way upstream reads them.
 */
function parseValue(raw: string): CsValue | null {
  const text = raw.trim();
  if (/^(0[xX][0-9A-Fa-f]+|\d+)$/.test(text)) return { kind: "number", value: Number(text) };
  if (!text.startsWith("U.FindROMPointer")) return null;

  const find =
    /^U\.FindROMPointer\s*\(\s*rom\s*,\s*([\s\S]*?)\s*,\s*new\s+uint\s*\[\s*\]\s*\{([\s\S]*?)\}\s*\)$/.exec(
      text,
    );
  if (find === null) return null;

  const probe = find[1] as string;
  const candidates = [...(find[2] as string).matchAll(new RegExp(NUMBER.source, "g"))].map((m) =>
    Number(m[1]),
  );

  const bare = probe.trim();
  const checkPointer = /^0[xX][0-9A-Fa-f]+$|^\d+$/.test(bare)
    ? Number(bare)
    : Number(/u32\(\s*(0x[0-9A-Fa-f]+|\d+)\s*\)/.exec(probe)?.[1] ?? "0");
  const below = /<\s*(0x[0-9A-Fa-f]+|\d+)/.exec(probe);
  const equal = /==\s*(0x[0-9A-Fa-f]+|\d+)/.exec(probe);

  const value: {
    kind: "find";
    checkPointer: number;
    checkBelow?: number;
    checkEqual?: number;
    candidates: readonly number[];
  } = { kind: "find", checkPointer, candidates };
  if (below !== null) value.checkBelow = Number(below[1]);
  if (equal !== null) value.checkEqual = Number(equal[1]);
  return value;
}

/** One line of the layouts report: a field, what we say, what upstream says. */
interface Drift {
  label: string;
  ours: string;
  theirs: string;
}

/**
 * Our side of a comparison. `num` covers plain offsets, sizes and limits;
 * `slot` covers the pointer slots, which upstream may express either as a
 * constant or as a `U.FindROMPointer` search.
 */
type Ours = { kind: "num"; value: number } | { kind: "slot"; slot: SlotRef };

/** Numbers are shown both ways: one side is written in hex, the other in decimal. */
const showNum = (n: number): string => `${n} / ${hex(n)}`;

function showOurs(ours: Ours): string {
  return ours.kind === "num" ? showNum(ours.value) : describeSlot(ours.slot);
}

function showTheirs(value: CsValue): string {
  return value.kind === "number" ? showNum(value.value) : describeValue(value);
}

/** Same value, not same text - the two files do not agree on notation. */
function agree(ours: Ours, theirs: CsValue): boolean {
  if (ours.kind === "num") return theirs.kind === "number" && ours.value === theirs.value;
  if (ours.slot.kind === "fixed") {
    return theirs.kind === "number" && ours.slot.slot === theirs.value;
  }
  if (theirs.kind !== "find") return false;

  const slot = ours.slot;
  return (
    slot.checkPointer === theirs.checkPointer &&
    (slot.checkBelow ?? null) === (theirs.checkBelow ?? null) &&
    (slot.checkEqual ?? null) === (theirs.checkEqual ?? null) &&
    slot.candidates.length === theirs.candidates.length &&
    slot.candidates.every((c, i) => c === theirs.candidates[i])
  );
}

function describeSlot(slot: SlotRef): string {
  if (slot.kind === "fixed") return hex(slot.slot);
  const probe =
    slot.checkEqual !== undefined
      ? `== ${hex(slot.checkEqual)}`
      : slot.checkBelow !== undefined
        ? `< ${hex(slot.checkBelow)}`
        : "pointer";
  return `search(+${hex(slot.checkPointer)} ${probe}; ${slot.candidates.map(hex).join(",")})`;
}

function describeValue(value: CsValue): string {
  if (value.kind === "number") return hex(value.value);
  const probe =
    value.checkEqual !== undefined
      ? `== ${hex(value.checkEqual)}`
      : value.checkBelow !== undefined
        ? `< ${hex(value.checkBelow)}`
        : "pointer";
  return `search(+${hex(value.checkPointer)} ${probe}; ${value.candidates.map(hex).join(",")})`;
}

/**
 * Compare one game's layout against its C# source.
 *
 * Fields a game omits because the constants are not transcribed yet (items and
 * shops for every game but FE8U) are skipped rather than reported - this check
 * is about the numbers we claim, not about coverage.
 */
function layoutDrift(version: GameVersion, cs: ReadonlyMap<string, string>): Drift[] {
  const layout = LAYOUTS[version];
  const drift: Drift[] = [];

  const num = (value: number): Ours => ({ kind: "num", value });
  const slot = (ref: SlotRef): Ours => ({ kind: "slot", slot: ref });

  const expect = (label: string, ours: Ours, key: string): void => {
    const raw = cs.get(key);
    if (raw === undefined) {
      drift.push({ label, ours: showOurs(ours), theirs: `no ${key} in ${CS_FILE[version]}` });
      return;
    }
    const value = parseValue(raw);
    if (value === null) {
      drift.push({ label, ours: showOurs(ours), theirs: `could not read "${raw.trim()}"` });
      return;
    }
    if (!agree(ours, value)) {
      drift.push({ label, ours: showOurs(ours), theirs: showTheirs(value) });
    }
  };

  expect("unit.slot", slot(layout.unit.slot), "unit_pointer");
  expect("unit.recordSize", num(layout.unit.recordSize), "unit_datasize");
  expect("unit.maxCount", num(layout.unit.maxCount), "unit_maxcount");
  expect("unitClass.slot", slot(layout.unitClass.slot), "class_pointer");
  expect("unitClass.recordSize", num(layout.unitClass.recordSize), "class_datasize");

  expect("text.maskPointer", num(layout.text.maskPointer), "mask_pointer");
  expect(
    "text.maskPointBasePointer",
    num(layout.text.maskPointBasePointer),
    "mask_point_base_pointer",
  );
  expect("text.textPointer", num(layout.text.textPointer), "text_pointer");
  expect("text.textRecoverAddress", num(layout.text.textRecoverAddress), "text_recover_address");

  if (layout.support !== null) {
    expect("support.unitPointer", num(layout.support.unitPointer), "support_unit_pointer");
    expect("support.talkPointer", num(layout.support.talkPointer), "support_talk_pointer");
    expect(
      "support.attributePointer",
      num(layout.support.attributePointer),
      "support_attribute_pointer",
    );
  }

  expect("terrainNames.slot", num(layout.terrainNames.slot), "map_terrain_name_pointer");

  if (layout.map !== null) {
    expect("map.settingSlot", slot(layout.map.settingSlot), "map_setting_pointer");
    expect("map.settingRecordSize", num(layout.map.settingRecordSize), "map_setting_datasize");
    expect("map.eventPlistPos", num(layout.map.eventPlistPos), "map_setting_event_plist_pos");
    expect("map.eventSlot", num(layout.map.eventSlot), "map_event_pointer");
    expect("map.plistLimit", num(layout.map.plistLimit), "map_map_pointer_list_default_size");
    expect("map.turnCondSize", num(layout.map.turnCondSize), "eventcond_tern_size");
    expect("map.talkCondSize", num(layout.map.talkCondSize), "eventcond_talk_size");
    expect("map.unitDataSize", num(layout.map.unitDataSize), "eventunit_data_size");
  }

  if (layout.forceSortie !== null) {
    expect("forceSortie.slot", num(layout.forceSortie.slot), "event_force_sortie_pointer");
  }
  if (layout.classBranch !== null) {
    expect("classBranch.slot", num(layout.classBranch.slot), "ccbranch_pointer");
  } else {
    // `null` claims the game has no branch table, which upstream evidences by
    // assigning the pointer 0 - the two-direction stance `forceSortie` takes
    // for FE6, applied to the same kind of claim.
    const raw = cs.get("ccbranch_pointer");
    if (raw === undefined) {
      drift.push({
        label: "classBranch",
        ours: "none",
        theirs: `no ccbranch_pointer in ${CS_FILE[version]}`,
      });
    } else {
      const value = parseValue(raw);
      if (value === null || value.kind !== "number" || value.value !== 0) {
        drift.push({
          label: "classBranch",
          ours: "none",
          theirs: value === null ? `could not read "${raw.trim()}"` : showTheirs(value),
        });
      }
    }
  }
  if (layout.item !== undefined) {
    expect("item.slot", slot(layout.item.slot), "item_pointer");
    expect("item.recordSize", num(layout.item.recordSize), "item_datasize");
  }
  if (layout.shop !== undefined) {
    expect("shop.prepShopSlot", num(layout.shop.prepShopSlot), "item_shop_hensei_pointer");
  }

  return drift;
}

// --------------------------------------------------------------------------
// The two checks
// --------------------------------------------------------------------------

interface Problem {
  where: string;
  detail: string;
}

function checkLayouts(csDir: string): Problem[] {
  const problems: Problem[] = [];
  for (const version of Object.keys(CS_FILE) as GameVersion[]) {
    const path = join(csDir, CS_FILE[version]);
    if (!existsSync(path)) {
      problems.push({ where: `layouts ${version}`, detail: `${CS_FILE[version]} is missing` });
      continue;
    }
    const drift = layoutDrift(version, assignments(readFileSync(path, "utf8")));
    for (const d of drift) {
      problems.push({
        where: `layouts ${version}: ${d.label}`,
        detail: `cli says ${d.ours}, upstream says ${d.theirs}`,
      });
    }
  }
  return problems;
}

/** The leading decimal run in a control name, e.g. `20` out of `J_20_DIFFCULTY`. */
const U_ATOI_DIGITS = /\d+/;

/**
 * Check the one layout field whose C# anchor is a *designer file* rather than a
 * `ROMFE*.cs` constant: `map.difficultyPos`, the offset of the 難易度補正 word.
 *
 * Upstream never writes this offset down as a number. Each map-setting form has
 * a numeric control named e.g. `W20`, and `InputFormRef.RomToUI` builds the
 * field address from the digits in that name (`U.atoi`, decimal - *not* hex,
 * which is the trap) with the leading letter choosing the width (`W` = `u16`).
 * So the only machine-checkable statement of "offset 0x14 is the difficulty
 * field" is the pairing of that control with the 難易度補正 *label* beside it.
 *
 * Two directions are enforced, because "we measured nothing" and "there is
 * nothing to measure" are different claims: a game we set to `null` must have
 * no such label, and a game we set to a number must have exactly one.
 */
function checkMapSettingDifficulty(csDir: string): Problem[] {
  const problems: Problem[] = [];

  for (const version of Object.keys(MAPSETTING_DESIGNER) as GameVersion[]) {
    const name = MAPSETTING_DESIGNER[version];
    const path = join(csDir, name);
    if (!existsSync(path)) {
      problems.push({ where: `difficulty ${version}`, detail: `${name} is missing` });
      continue;
    }
    const source = readFileSync(path, "utf8");

    // `this.J_20_DIFFCULTY.Text = "難易度補正";` -> control J_20_DIFFCULTY.
    const labels = [...source.matchAll(/this\.([A-Za-z_][A-Za-z0-9_]*)\.Text = "難易度補正"/g)].map(
      (m) => m[1] as string,
    );
    const offsets = new Set(
      labels.map((label) => Number(U_ATOI_DIGITS.exec(label)?.[0] ?? Number.NaN)),
    );

    const ours = LAYOUTS[version].map?.difficultyPos ?? null;

    if (ours === null) {
      if (labels.length > 0) {
        problems.push({
          where: `difficulty ${version}`,
          detail: `cli says none, but ${name} labels ${labels.join(", ")} 難易度補正`,
        });
      }
      continue;
    }
    if (offsets.size !== 1) {
      problems.push({
        where: `difficulty ${version}`,
        detail:
          labels.length === 0
            ? `cli says ${showNum(ours)}, but no 難易度補正 label in ${name}`
            : `cli says ${showNum(ours)}, but ${name} labels ${[...offsets].join(", ")}`,
      });
      continue;
    }
    const theirs = [...offsets][0] as number;
    if (theirs !== ours) {
      problems.push({
        where: `difficulty ${version}: difficultyPos`,
        detail: `cli says ${showNum(ours)}, upstream says ${showNum(theirs)}`,
      });
      continue;
    }
    // The offset is only the difficulty field if the numeric control that reads
    // it is the `W` (u16) one - a `B20` would make it a byte.
    if (!source.includes(`.Name = "W${theirs}"`)) {
      problems.push({
        where: `difficulty ${version}: difficultyPos`,
        detail: `offset ${theirs} has no W${theirs} (u16) control in ${name}`,
      });
    }
  }

  return problems;
}

/**
 * Check `classBranch.recordSize` against its only C# anchor.
 * `CCBranchForm.Init` builds the `InputFormRef` over `ccbranch_pointer` with
 * the record size as the block-size argument, and the two columns are read as
 * `u8(addr + 0)` / `u8(addr + 1)` - the same mechanical derivation
 * {@link checkMapSettingDifficulty} performs for a designer-file-only offset.
 */
function checkClassBranchRecordSize(csDir: string): Problem[] {
  const path = join(csDir, "CCBranchForm.cs");
  if (!existsSync(path)) {
    return [{ where: "classBranch recordSize", detail: "CCBranchForm.cs is missing" }];
  }
  const source = readFileSync(path, "utf8");
  const problems: Problem[] = [];

  const init = /RomInfo\.ccbranch_pointer\s*,\s*(\d+)\s*,/.exec(source);
  const theirs = init === null ? null : Number(init[1]);
  for (const version of ["FE8U", "FE8J"] as const) {
    const ours = LAYOUTS[version].classBranch?.recordSize ?? null;
    if (ours === null || theirs === null || ours !== theirs) {
      problems.push({
        where: `classBranch recordSize ${version}`,
        detail:
          theirs === null
            ? "no block size after ccbranch_pointer in CCBranchForm.cs"
            : `cli says ${ours === null ? "none" : showNum(ours)}, upstream says ${showNum(theirs)}`,
      });
    }
  }

  // The two u8 columns are what makes the record size 2 rather than one u16.
  for (const column of [0, 1]) {
    if (!source.includes(`u8(list[i].addr + ${column})`)) {
      problems.push({
        where: "classBranch recordSize",
        detail: `CCBranchForm.cs never reads u8(addr + ${column}); the two-column layout is unverified`,
      });
    }
  }

  return problems;
}

function checkConfigData(upstreamData: string): Problem[] {
  const problems: Problem[] = [];
  // Exactly the four prefixes `config/data.ts` documents, so the provenance
  // stamp sitting alongside them is not mistaken for a vendored resource.
  const files = readdirSync(VENDORED_DATA).filter(
    (f) => f.endsWith(".txt") && VENDORED_PREFIXES.some((p) => f.startsWith(p)),
  );

  for (const file of files) {
    const upstream = join(upstreamData, file);
    if (!existsSync(upstream)) {
      problems.push({ where: `config/data ${file}`, detail: "no longer exists upstream" });
      continue;
    }
    if (!readFileSync(join(VENDORED_DATA, file)).equals(readFileSync(upstream))) {
      problems.push({ where: `config/data ${file}`, detail: "differs from upstream" });
    }
  }
  console.log(`config/data: ${files.length} vendored files compared`);
  return problems;
}

// --------------------------------------------------------------------------
// Provenance stamp
// --------------------------------------------------------------------------

function submoduleCommit(submodule: string): string | null {
  try {
    return execFileSync("git", ["-C", submodule, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function readStamp(): string | null {
  return existsSync(STAMP_FILE) ? readFileSync(STAMP_FILE, "utf8").trim() : null;
}

// --------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update");

  const submodule = join(REPO, "FEBuilderGBA");
  const csDir = join(submodule, "FEBuilderGBA");
  const upstreamData = join(submodule, "FEBuilderGBA", "bin", "Debug", "config", "data");

  if (!existsSync(join(submodule, "FEBuilderGBA", "ROMFE8U.cs"))) {
    const stamp = readStamp();
    console.log(
      "FEBuilderGBA submodule is not checked out - nothing to compare against.\n" +
        (stamp === null
          ? "No provenance stamp either: this vendored data has never been verified here."
          : `Last verified against:\n${stamp}`) +
        "\nRun `git submodule update --init` to enable this check.",
    );
    return;
  }

  const commit = submoduleCommit(submodule);
  const problems = [
    ...checkLayouts(csDir),
    ...checkMapSettingDifficulty(csDir),
    ...checkClassBranchRecordSize(csDir),
    ...checkConfigData(upstreamData),
  ];

  if (problems.length === 0) {
    console.log(`layouts: ${Object.keys(CS_FILE).length} games agree with ROMFE*.cs`);
    console.log("difficulty: 4 games match the map-setting designer labels");
    console.log("classBranch: record size matches CCBranchForm.cs");
  } else {
    console.log(`layouts / difficulty / config/data: ${problems.length} difference(s)`);
    for (const p of problems) console.log(`  ${p.where}: ${p.detail}`);
  }

  const stamp = readStamp();
  const recorded = stamp?.split("\n")[0]?.replace(/^commit\s+/, "") ?? null;
  if (update && commit !== null) {
    const body = [
      `commit ${commit}`,
      `checked ${new Date().toISOString().slice(0, 10)}`,
      "",
      "The vendored config/data files and the constants in src/data/layouts.ts were",
      "last verified against this FEBuilderGBA commit by scripts/check-upstream.ts.",
    ].join("\n");
    writeFileSync(STAMP_FILE, `${body}\n`, "utf8");
    console.log(`stamp: wrote ${STAMP_FILE} (${commit.slice(0, 12)})`);
  } else if (commit !== null && recorded !== commit) {
    console.log(
      `stamp: upstream moved - recorded ${recorded ?? "nothing yet"}, now ${commit.slice(0, 12)}. ` +
        "Re-run with --update once the differences above are understood.",
    );
  } else if (commit !== null) {
    console.log(`stamp: up to date with ${commit.slice(0, 12)}`);
  }

  if (problems.length > 0) {
    console.error("\nupstream check failed");
    process.exitCode = 1;
  }
}

main();
