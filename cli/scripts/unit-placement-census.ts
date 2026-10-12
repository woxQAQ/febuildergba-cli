/**
 * Unit-placement census: every placement block the ROM's event scripts point at,
 * grouped by referencing instruction and record allegiance. FE8 has **no enemy
 * placement table**: player/NPC/enemy units are the same 20-byte records, and
 * only `+3` bits 1-2 make one an enemy, so "where are the enemies" means walking
 * the scripts and reading allegiance (`docs/chapters-and-events.md` §3.19). This
 * is the evidence for that and a regression check on the reader.
 *
 * Usage: node scripts/unit-placement-census.ts [rom.gba] [--chapter N]
 * Default ROM `../../fixtures/dream-of-five.gba`; `--chapter N` prints per-block
 * detail for one map-setting index.
 */

import { load } from "../src/load.ts";
import { classifyUnitArg, type LoadKind } from "../src/tables/eventScript.ts";
import { reachableInstructions, type TracedBlockUnit } from "../src/tables/eventTrace.ts";

const argv = process.argv.slice(2);
const romPath =
  argv.find((a) => a.endsWith(".gba")) ??
  new URL("../../fixtures/dream-of-five.gba", import.meta.url).pathname;
const chapterFlag = argv.indexOf("--chapter");
const onlyChapter = chapterFlag >= 0 ? Number(argv[chapterFlag + 1]) : null;

const loaded = load(romPath);
const { chapters, eventTrace } = loaded;
if (!loaded.chaptersAvailable || loaded.eventScripts.scripts.length === 0) {
  throw new Error("chapter/event evidence is unavailable; supply canonical cli/data resources");
}

const hex = (n: number): string => "0x" + n.toString(16).padStart(7, "0");
const SIDE = ["player", "ally", "enemy", "removed"] as const;

interface Block {
  hit: { addr: number; blockAddr: number; instruction: string; kind: LoadKind };
  units: TracedBlockUnit[];
  chapterIndex: number;
  scriptId: number;
}

/**
 * Decode only in load(), then attribute instructions through the shared reach
 * walk. A load site shared by chapters is counted once in this whole-ROM
 * census, but appears in each chapter's projection.
 */
const blocks: Block[] = [];
const seen = new Set<string>();
const addresses = new Map(eventTrace.blocks.map((b) => [b.id, b.address]));
const unitsByBlock = new Map<number, TracedBlockUnit[]>();
for (const unit of eventTrace.loadBlockUnits) {
  const units = unitsByBlock.get(unit.blockId);
  if (units === undefined) unitsByBlock.set(unit.blockId, [unit]);
  else units.push(unit);
}

for (const { mapIndex, instruction } of reachableInstructions(eventTrace)) {
  if (onlyChapter !== null && mapIndex !== onlyChapter) continue;
  for (const load of instruction.loads) {
    const blockAddr = addresses.get(load.blockId);
    if (blockAddr === undefined) throw new Error(`missing load block ${load.blockId}`);
    const key = `${instruction.address}:${load.position}:${load.blockId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push({
      hit: {
        addr: instruction.address,
        blockAddr,
        instruction: instruction.pattern,
        kind: load.kind,
      },
      units: unitsByBlock.get(load.blockId) ?? [],
      chapterIndex: mapIndex,
      scriptId: instruction.scriptId,
    });
  }
}

// ---------------------------------------------------------------- detail mode

if (onlyChapter !== null) {
  for (const b of blocks) {
    console.log(
      `map${b.chapterIndex} script ${b.scriptId}  ${b.hit.kind.padEnd(8)} insn ${hex(b.hit.addr)} -> block ${hex(b.hit.blockAddr)}  n=${b.units.length}`,
    );
    console.log(`    ${b.hit.instruction}`);
    for (const u of b.units.slice(0, 12)) {
      console.log(
        `    #${String(u.position).padStart(3)}  unit ${String(u.unitId).padStart(3)} class ${String(u.classId).padStart(3)} ` +
          `lv ${String(u.level).padStart(2)} ${u.side.padEnd(7)} auto ${u.autolevel} ` +
          `pos (${u.x},${u.y}) items [${u.items.join(",")}]`,
      );
    }
    if (b.units.length > 12) console.log(`    ... ${b.units.length - 12} more`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- summary mode

console.log(`rom: ${romPath}`);
console.log(`blocks: ${blocks.length}`);

console.log("\n-- by instruction (leading 8 bytes) --");
const byInsn = new Map<string, number>();
for (const b of blocks) {
  const k = b.hit.instruction.slice(0, 8);
  byInsn.set(k, (byInsn.get(k) ?? 0) + 1);
}
for (const [k, n] of [...byInsn].sort((a, b) => b[1] - a[1])) {
  const s = blocks.find((b) => b.hit.instruction.startsWith(k))!;
  console.log(
    `  ${k}  ${String(n).padStart(4)}  kind=${s.hit.kind.padEnd(8)} ${s.hit.instruction.slice(0, 44)}`,
  );
}

console.log("\n-- blocks by instruction x allegiance --");
const bySide = new Map<string, Map<string, number>>();
for (const b of blocks) {
  const k = b.hit.instruction.slice(0, 8);
  const m = bySide.get(k) ?? new Map<string, number>();
  for (const s of new Set(b.units.map((u) => u.side))) m.set(s, (m.get(s) ?? 0) + 1);
  bySide.set(k, m);
}
for (const [k, m] of [...bySide].sort()) {
  console.log(
    `  ${k}  ${[...m]
      .sort()
      .map(([s, n]) => `${s}:${n}`)
      .join("  ")}`,
  );
}

console.log("\n-- blocks by script --");
const bySlot = new Map<string, number>();
for (const b of blocks) {
  const key = String(b.scriptId);
  bySlot.set(key, (bySlot.get(key) ?? 0) + 1);
}
for (const [k, n] of [...bySlot].sort()) console.log(`  ${k.padEnd(22)} ${n}`);

// ---------------------------------------------------------------- records

const all = blocks.flatMap((b) => b.units.map((u) => ({ u, ch: b.chapterIndex })));
console.log("\n-- records by allegiance --");
for (const side of SIDE) {
  const rows = all.filter((x) => x.u.side === side);
  if (rows.length === 0) continue;
  const lvs = rows.map((x) => x.u.level);
  console.log(
    `  ${side.padEnd(8)} ${String(rows.length).padStart(5)} records  ` +
      `lv ${Math.min(...lvs)}..${Math.max(...lvs)} (mean ${(lvs.reduce((a, b) => a + b, 0) / lvs.length).toFixed(1)})  ` +
      `classes ${new Set(rows.map((x) => x.u.classId)).size}`,
  );
}

const enemies = all.filter((x) => x.u.side === "enemy");
console.log("\n-- enemy records --");
const hist = new Map<number, number>();
for (const x of enemies) hist.set(x.u.unitId, (hist.get(x.u.unitId) ?? 0) + 1);
console.log(
  `  top unit ids: ${[...hist]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([u, n]) => `${u}(${n})`)
    .join(" ")}`,
);

// ---------------------------------------------------------------- validity

console.log("\n-- validity --");
const classIds = new Set(loaded.classes.map((c) => c.id));
let zeroLen = 0;
let badClass = 0;
let badUnit = 0;
let badLevel = 0;
let nonPlayerInSlot10 = 0;
for (const b of blocks) {
  if (b.units.length === 0) zeroLen++;
  for (const u of b.units) {
    if (u.classId !== 0 && !classIds.has(u.classId)) badClass++;
    if (u.unitId === 0) badUnit++;
    if (u.side !== "enemy" && u.level > 20) badLevel++;
  }
}
for (const ch of chapters) {
  for (const u of ch.placements) if (u.side !== "player") nonPlayerInSlot10++;
}
console.log(`  blocks with 0 records          : ${zeroLen}`);
console.log(`  classId outside the class table: ${badClass}`);
console.log(`  unitId == 0                    : ${badUnit}`);
console.log(`  non-enemy record with lv > 20  : ${badLevel}`);
console.log(`  slot 10 records that are not player: ${nonPlayerInSlot10}`);

console.log("\n-- condition slot 11 vs 10 --");
const differ = chapters.filter(
  (c) => c.condTableAddr !== 0 && c.hardPlacementAddr !== c.playerPlacementAddr,
);
console.log(`  chapters where slot 11 != slot 10: ${differ.length}`);
for (const c of differ) {
  console.log(
    `    map${c.index} ch${c.chapterNumber} "${c.title}"  slot10 ${c.placements.length} rec, slot11 ${c.hardPlacements.length} rec ` +
      `[${[...new Set(c.hardPlacements.map((u) => u.side))].join(",")}]`,
  );
}

console.log("\n-- FREEMAP slots 12-17 --");
let freemap = 0;
for (const c of chapters) {
  const p = c.condPointers;
  if (p.slice(12, 18).some((v) => v !== 0)) freemap++;
}
console.log(`  chapters with any of slot 12-17 set: ${freemap}`);

console.log(
  `\nclassifyUnitArg on a reinforcement pattern = ${classifyUnitArg("40050200XXXXXXXX400A000074E29E08", 4)}`,
);
