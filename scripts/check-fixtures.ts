/**
 * Exercise the public CLI against every local fixture ROM. Artifacts retain
 * complete stdout/stderr; a failed command is never parsed as an empty result.
 * ROMs and generated databases stay local and are not committed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Envelope } from "../src/cli/emit.ts";
import type { StatLine } from "../src/analysis/projection.ts";
import type { UnitAvailability } from "../src/analysis/availability.ts";
import type { CandidateFacts } from "../src/analysis/candidates.ts";
import type { SupportPair } from "../src/commands/supports.ts";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
mkdirSync("out", { recursive: true });
const output = mkdtempSync("out/fixture-check-");
const roms = readdirSync("fixtures", { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.gba$/i.test(entry.name))
  .map((entry) => entry.name)
  .sort();
assert(roms.length > 0, "No ROMs in fixtures/: supply local .gba files before checking");

function run<D>(directory: string, command: string, path: string, ...args: string[]): Envelope<D> {
  const result = spawnSync(process.execPath, ["src/index.ts", command, path, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  const label = command + (args.includes("--full") ? "-full" : "");
  writeFileSync(join(directory, `${label}.json`), result.stdout ?? "");
  writeFileSync(join(directory, `${label}.stderr`), result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${path}: ${result.stderr}`);
  const envelope = JSON.parse(result.stdout) as Envelope<D>;
  assert.equal(envelope.meta.command, command);
  assert.equal(envelope.meta.path, path);
  assert(Array.isArray(envelope.meta.diagnostics), `${command}: missing diagnostics`);
  return envelope;
}

type AvailabilityRow = Omit<UnitAvailability, "chapters">;
interface JoinRow {
  kind: "join" | "appearance";
  unitId: number;
}

interface RecruitSite {
  mapIndex: number;
  kind: string;
  units: {
    unitId: number;
    classId: number;
    level: number;
    side: string;
    items: number[];
    ext: number | null;
    autolevel: number;
  }[];
}

const STAT_FIELDS: readonly (keyof StatLine)[] = ["hp", "str", "skl", "spd", "def", "res", "lck"];

const results: object[] = [];
for (const rom of roms) {
  const directory = join(output, basename(rom, ".gba"));
  mkdirSync(directory);
  const dbPath = join(directory, "rom.db");
  try {
    const extraction = run<{ tables: Record<string, number> }>(
      directory,
      "extract",
      join("fixtures", rom),
      "--out",
      dbPath,
    );
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let rosterIds: number[];
    try {
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(extraction.data.tables.inputs, 1);
      for (const [table, count] of Object.entries(extraction.data.tables)) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get();
        assert.equal(row?.n, count, `${rom}: receipt disagrees with ${table}`);
      }
      rosterIds = (
        db.prepare("SELECT id FROM units WHERE has_support_data = 1 ORDER BY id").all() as {
          id: number;
        }[]
      ).map((row) => row.id);
    } finally {
      db.close();
    }

    // Gate the dependent workflow on one successful DB read.
    const availability = run<AvailabilityRow[]>(directory, "availability", dbPath);
    const joins = run<JoinRow[]>(directory, "joins", dbPath);
    const joinerIds = new Set(
      availability.data.filter((row) => row.joinMapIndex !== null).map((row) => row.unitId),
    );
    assert.deepEqual(
      new Set(joins.data.filter((row) => row.kind === "join").map((row) => row.unitId)),
      joinerIds,
    );
    const recruits = run<RecruitSite[]>(directory, "recruits", dbPath);
    const candidates = run<CandidateFacts>(directory, "candidates", dbPath);
    const supports = run<SupportPair[]>(directory, "supports", dbPath);
    assert.deepEqual(new Set(candidates.data.audit.joinerIds), joinerIds);
    assert.deepEqual(candidates.data.audit.rosterIds, rosterIds);
    assert.equal(candidates.data.audit.joinRowCount, joinerIds.size);
    for (const key of [
      "missingUnitIds",
      "missingProjectionIds",
      "joinIdsMissingFromAvailability",
      "joinIdsMissingFromJoins",
    ] as const)
      assert.deepEqual(candidates.data.audit[key], [], `${rom}: ${key}`);
    const candidateIds = candidates.data.units.map((unit) => unit.unitId);
    assert.equal(new Set(candidateIds).size, candidateIds.length, `${rom}: duplicate candidates`);
    assert.deepEqual(new Set(candidateIds), new Set([...rosterIds, ...joinerIds]));
    const evidenceDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const supportRows = evidenceDb
        .prepare(
          "SELECT unit_id, partner_id, initial, growth FROM support_partners ORDER BY unit_id, partner_id",
        )
        .all() as { unit_id: number; partner_id: number; initial: number; growth: number }[];
      const directed = new Map(
        supportRows.map((row) => [
          `${row.unit_id}:${row.partner_id}`,
          { initial: row.initial, growth: row.growth },
        ]),
      );
      const pairKeys = new Set(
        supportRows.map(
          (row) =>
            `${Math.min(row.unit_id, row.partner_id)}:${Math.max(row.unit_id, row.partner_id)}`,
        ),
      );
      assert.equal(supports.data.length, pairKeys.size);
      assert.deepEqual(new Set(supports.data.map((pair) => `${pair.a}:${pair.b}`)), pairKeys);
      for (const pair of supports.data) {
        assert(pair.a < pair.b);
        assert.deepEqual(pair.aToB, directed.get(`${pair.a}:${pair.b}`) ?? null);
        assert.deepEqual(pair.bToA, directed.get(`${pair.b}:${pair.a}`) ?? null);
        assert.equal(pair.reciprocal, pair.aToB !== null && pair.bToA !== null);
      }
      for (const unit of candidates.data.units) {
        const rawBaseline = evidenceDb
          .prepare(
            "SELECT u.class_id, u.level, c.is_empty, "
              + "u.delta_hp + c.base_hp AS hp, u.delta_str + c.base_str AS str, "
              + "u.delta_skl + c.base_skl AS skl, u.delta_spd + c.base_spd AS spd, "
              + "u.delta_def + c.base_def AS def, u.delta_res + c.base_res AS res, "
              + "u.delta_lck AS lck FROM units u "
              + "LEFT JOIN classes c ON c.id = u.class_id WHERE u.id = ?",
          )
          .get(unit.unitId) as
          | (StatLine & { class_id: number; level: number; is_empty: number | null })
          | undefined;
        assert(rawBaseline);
        assert.equal(unit.tableLevel, rawBaseline.level);
        if (rawBaseline.is_empty !== 0) {
          assert.equal(unit.tableClass, null);
          assert.equal(unit.tableStartingStats, null);
          assert.deepEqual(unit.plans, []);
          assert(unit.baselineIssues.includes("missing-class"));
          continue;
        }
        assert(unit.tableClass !== null);
        assert.equal(unit.tableClass.classId, rawBaseline.class_id);
        assert.deepEqual(
          unit.tableStartingStats,
          Object.fromEntries(STAT_FIELDS.map((stat) => [stat, rawBaseline[stat]])),
        );
        assert(unit.plans.length > 0);
        assert.equal(new Set(unit.plans.map((plan) => plan.classId)).size, unit.plans.length);
        for (const plan of unit.plans) {
          assert(plan.profile !== null);
          assert.equal(plan.classId, plan.profile.classId);
          assert(plan.promotionSteps === 0 || plan.promotionSteps === 1);
          if (plan.promotionSteps === 0) {
            assert.equal(plan.classId, unit.tableClass.classId);
            assert.equal(unit.plans.length, 1);
          }
          assert.deepEqual(Object.keys(plan.stats).sort(), [...STAT_FIELDS].sort());
          assert(STAT_FIELDS.every((stat) => Number.isFinite(plan.stats[stat])));
          assert.equal(
            plan.trainingLevels,
            Math.max(0, 20 - rawBaseline.level) + 19 * plan.promotionSteps,
          );
        }
        const placements = evidenceDb
          .prepare(
            "SELECT class_id, level, autolevel, items FROM chapter_placements "
              + "WHERE map_index = ? AND unit_id = ? AND side = 'player'",
          )
          .all(unit.availability?.joinMapIndex ?? -1, unit.unitId) as {
          class_id: number;
          level: number;
          autolevel: number;
          items: string;
        }[];
        const expectedEvidence = [
          ...placements
            .filter(
              (row) =>
                !(
                  row.class_id === 0
                  && row.level === 0
                  && (JSON.parse(row.items) as number[]).every((item) => item === 0)
                ),
            )
            .map((row) => ({
              source: "placement",
              side: "player",
              placedClassId: row.class_id,
              placedLevel: row.level,
              placedAutolevel: row.autolevel,
            })),
          ...recruits.data
            .filter(
              (site) =>
                site.kind === "recruit" && site.mapIndex === unit.availability?.joinMapIndex,
            )
            .flatMap((site) =>
              site.units
                .filter(
                  (entry) =>
                    entry.unitId === unit.unitId
                    && (entry.side === "player" || (entry.side === "ally" && unit.inRoster)),
                )
                .map((entry) => ({
                  source: "recruit",
                  side: entry.side,
                  placedClassId: entry.classId,
                  placedLevel: entry.level,
                  placedAutolevel: entry.autolevel,
                })),
            ),
        ];
        const evidenceKey = (entry: (typeof expectedEvidence)[number]) =>
          [
            entry.source,
            entry.side,
            entry.placedClassId,
            entry.placedLevel,
            entry.placedAutolevel,
          ].join("|");
        assert.deepEqual(
          new Set(unit.joinEvidence.map(evidenceKey)),
          new Set(expectedEvidence.map(evidenceKey)),
          `${rom}: unit ${unit.unitId} entry evidence differs from raw placements/load sites`,
        );
        const expectedIssues = [];
        if (
          expectedEvidence.some(
            (entry) =>
              entry.placedClassId !== 0 && entry.placedClassId !== unit.tableClass!.classId,
          )
        )
          expectedIssues.push("class-override");
        if (expectedEvidence.some((entry) => entry.placedLevel !== unit.tableLevel))
          expectedIssues.push("level-override");
        if (expectedEvidence.some((entry) => entry.placedAutolevel !== 0))
          expectedIssues.push("entry-autolevel");
        assert.deepEqual(
          unit.baselineIssues,
          expectedIssues,
          `${rom}: unit ${unit.unitId} baseline audit`,
        );
      }
    } finally {
      evidenceDb.close();
    }

    const full = run<(AvailabilityRow & { chapters: unknown[] })[]>(
      directory,
      "availability",
      dbPath,
      "--full",
    );
    assert.deepEqual(
      full.data.map(({ chapters, ...summary }) => {
        assert(Array.isArray(chapters));
        return summary;
      }),
      availability.data,
    );
    for (const command of ["niches", "transitions", "gains"]) {
      run<unknown>(directory, command, dbPath);
    }
    assert(recruits.data.length > 0);
    for (const site of recruits.data)
      for (const unit of site.units) {
        assert(Array.isArray(unit.items));
        assert.equal(unit.items.length, 4);
        assert(unit.ext === null || Number.isInteger(unit.ext));
        assert(Number.isInteger(unit.autolevel));
      }
    const expcurve = run<{ budgets: { difficulty: string }[] }>(
      directory,
      "expcurve",
      dbPath,
      "--difficulty",
      "normal",
      "--actor-level",
      "13",
      "--actor-class-power",
      "2",
      "--actor-promoted",
    );
    assert(expcurve.data.budgets.length > 0);
    assert(expcurve.data.budgets.every((row) => row.difficulty === "normal"));
    assert.deepEqual(expcurve.meta.parameters?.actor, { level: 13, classPower: 2, promoted: true });
    assert.deepEqual(expcurve.meta.parameters?.difficulties, ["normal"]);
    assert(Array.isArray(expcurve.meta.parameters?.assumptions));
    results.push({
      rom,
      ok: true,
      tables: Object.keys(extraction.data.tables).length,
      roster: rosterIds.length,
      joiners: joinerIds.size,
      candidates: candidateIds.length,
      supportPairs: supports.data.length,
      onRouteBaselineIssues: candidates.data.units.filter(
        (unit) => unit.availability?.joinState === "on_route" && unit.baselineIssues.length > 0,
      ).length,
      onRouteClassLevelIssues: candidates.data.units.filter(
        (unit) =>
          unit.availability?.joinState === "on_route"
          && unit.baselineIssues.some(
            (issue) => issue === "class-override" || issue === "level-override",
          ),
      ).length,
      diagnostics: availability.meta.diagnostics,
    });
    console.error(`${rom}: ok`);
  } catch (error) {
    results.push({ rom, ok: false, error: String(error) });
    process.exitCode = 1;
    console.error(`${rom}: ${error}`);
  }
}
const summary = JSON.stringify({ output, results }, null, 2);
writeFileSync(join(output, "summary.json"), summary + "\n");
console.log(summary);
