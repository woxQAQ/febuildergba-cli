/**
 * Exercise the public CLI against every local fixture ROM. Artifacts retain
 * complete stdout/stderr; a failed command is never parsed as an empty result.
 * ROMs and generated databases stay local and are not committed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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
const snapshotDiagnostics = new Map<string, readonly string[]>();

function run<D>(directory: string, command: string, path: string, ...args: string[]): Envelope<D> {
  const result = spawnSync(process.execPath, ["src/index.ts", command, path, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  const label = [command, ...args]
    .join("_")
    .replaceAll("--", "")
    .replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  writeFileSync(join(directory, `${label}.json`), result.stdout ?? "");
  writeFileSync(join(directory, `${label}.stderr`), result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${path}: ${result.stderr}`);
  const envelope = JSON.parse(result.stdout) as Envelope<D>;
  assert.equal(envelope.meta.command, command);
  assert.equal(envelope.meta.path, path);
  assert(Array.isArray(envelope.meta.diagnostics), `${command}: missing diagnostics`);
  assert.equal(new Set(envelope.meta.diagnostics).size, envelope.meta.diagnostics.length);
  for (const warning of snapshotDiagnostics.get(path) ?? []) {
    assert(envelope.meta.diagnostics.includes(warning), `${command}: lost snapshot warning`);
  }
  return envelope;
}

function reject(
  directory: string,
  command: string,
  path: string,
  status: number,
  message: RegExp,
  ...args: string[]
): void {
  const result = spawnSync(process.execPath, ["src/index.ts", command, path, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const label = ["rejected", command, basename(path), ...args].join("_").replaceAll("--", "");
  writeFileSync(join(directory, `${label}.stdout`), result.stdout ?? "");
  writeFileSync(join(directory, `${label}.stderr`), result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, "", "failed command must not emit success JSON");
  assert.match(result.stderr, message);
}

type AvailabilityRow = Omit<UnitAvailability, "chapters">;
type FullAvailabilityRow = AvailabilityRow & {
  chapters: { position: number; mapIndex: number; status: string }[];
};
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
    snapshotDiagnostics.set(dbPath, extraction.meta.diagnostics);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let rosterIds: number[];
    try {
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.deepEqual(
        JSON.parse(
          db.prepare("SELECT value FROM meta WHERE key = 'extract.diagnostics'").get()
            ?.value as string,
        ),
        extraction.meta.diagnostics,
      );
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
      const meta = new Map(
        (
          evidenceDb.prepare("SELECT key, value FROM meta").all() as {
            key: string;
            value: string;
          }[]
        ).map((row) => [row.key, row.value]),
      );
      assert.deepEqual(
        candidates.data.playOrder.branches,
        JSON.parse(meta.get("playOrder.branches")!),
      );
      assert.deepEqual(
        candidates.data.playOrder.closedLoop,
        JSON.parse(meta.get("playOrder.closedLoop")!),
      );
      const expectedSteps = evidenceDb
        .prepare(
          "SELECT p.position AS 'order', p.map_index AS mapIndex, p.role, p.playable, "
            + "c.chapter_number AS chapterNumber, c.title, c.deploy_slots AS deploySlots, "
            + "c.deploy_slots_hard AS deploySlotsHard FROM derived_play_order p "
            + "JOIN chapters c USING (map_index) ORDER BY p.position",
        )
        .all()
        .map((row) => ({ ...row, playable: row.playable === 1 }));
      assert.deepEqual(candidates.data.playOrder.steps, expectedSteps);
      assert.deepEqual(candidates.data.playOrder.last, expectedSteps.at(-1) ?? null);
      assert.deepEqual(
        candidates.data.playOrder.lastPlayable,
        expectedSteps.findLast((step) => step.playable) ?? null,
      );
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
        const flagsOf = (classId: number) =>
          (
            evidenceDb
              .prepare("SELECT flag FROM class_ability_flags WHERE class_id = ? ORDER BY flag")
              .all(classId) as { flag: string }[]
          ).map((row) => row.flag);
        assert.deepEqual(unit.tableClass.abilityFlagIds, flagsOf(rawBaseline.class_id));
        assert.deepEqual(
          unit.tableStartingStats,
          Object.fromEntries(STAT_FIELDS.map((stat) => [stat, rawBaseline[stat]])),
        );
        assert(unit.plans.length > 0);
        assert.equal(new Set(unit.plans.map((plan) => plan.classId)).size, unit.plans.length);
        for (const plan of unit.plans) {
          assert(plan.profile !== null);
          assert.equal(plan.classId, plan.profile.classId);
          assert.deepEqual(plan.profile.abilityFlagIds, flagsOf(plan.classId));
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

    const full = run<FullAvailabilityRow[]>(directory, "availability", dbPath, "--full");
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
    const expArgs = [
      "--difficulty",
      "normal",
      "--actor-level",
      "13",
      "--actor-class-power",
      "2",
      "--actor-promoted",
    ];
    const expcurve = run<{ budgets: { position: number; difficulty: string }[] }>(
      directory,
      "expcurve",
      dbPath,
      ...expArgs,
    );
    assert(expcurve.data.budgets.length > 0);
    assert(expcurve.data.budgets.every((row) => row.difficulty === "normal"));
    assert.deepEqual(expcurve.meta.parameters?.actor, { level: 13, classPower: 2, promoted: true });
    assert.deepEqual(expcurve.meta.parameters?.difficulties, ["normal"]);
    assert(Array.isArray(expcurve.meta.parameters?.assumptions));
    const end = (candidates.data.playOrder.last?.order ?? 0) + 1;
    assert(end > 3, `${rom}: need a nontrivial real chapter interval`);
    const beforePosition = Math.floor(end * 0.7);
    const window = { fromPosition: 2, beforePosition };
    const windowArgs = ["--from-position", "2", "--before-position", String(beforePosition)];
    const scoped = run<FullAvailabilityRow[]>(
      directory,
      "availability",
      dbPath,
      "--full",
      ...windowArgs,
    );
    const scopedSummary = run<AvailabilityRow[]>(directory, "availability", dbPath, ...windowArgs);
    assert.deepEqual(scoped.meta.parameters?.window, window);
    assert.deepEqual(
      scoped.data.map(({ chapters, ...summary }) => {
        assert(Array.isArray(chapters));
        return summary;
      }),
      scopedSummary.data,
    );
    assert.equal(scoped.data.length, full.data.length);
    for (const [index, row] of full.data.entries()) {
      const actual = scoped.data[index]!;
      const chapters = row.chapters.filter(
        (chapter) => chapter.position >= 2 && chapter.position < beforePosition,
      );
      const postJoin = chapters.filter(
        (chapter) => row.joinPosition !== null && chapter.position >= row.joinPosition,
      );
      const available = postJoin.filter(
        (chapter) => chapter.status === "available" || chapter.status === "forced",
      ).length;
      const windowed = row.joinPosition !== null;
      assert.deepEqual(actual.chapters, chapters);
      assert.equal(actual.joinState, row.joinState);
      assert.equal(actual.joinPosition, row.joinPosition);
      assert.equal(actual.joinMapIndex, row.joinMapIndex);
      assert.equal(actual.joinUnresolved, row.joinUnresolved);
      assert.equal(actual.availableCount, windowed ? available : null);
      assert.equal(actual.totalAfterJoin, windowed ? postJoin.length : null);
      assert.equal(
        actual.windowRatio,
        windowed && postJoin.length > 0 ? available / postJoin.length : null,
      );
      assert.deepEqual(
        actual.gaps,
        row.gaps
          ?.map((gap) => ({
            ...gap,
            fromPosition: Math.max(2, gap.fromPosition),
            toPosition: Math.min(beforePosition - 1, gap.toPosition),
          }))
          .filter((gap) => gap.fromPosition <= gap.toPosition) ?? null,
      );
    }
    const scopedCandidates = run<CandidateFacts>(directory, "candidates", dbPath, ...windowArgs);
    assert.deepEqual(scopedCandidates.meta.parameters?.window, window);
    assert.deepEqual(scopedCandidates.data.audit, candidates.data.audit);
    assert.deepEqual(scopedCandidates.data.playOrder, candidates.data.playOrder);
    assert.deepEqual(
      scopedCandidates.data.units.map((unit) => ({ ...unit, availability: null })),
      candidates.data.units.map((unit) => ({ ...unit, availability: null })),
    );
    for (const unit of scopedCandidates.data.units) {
      if (unit.availability === null) continue;
      const row = scopedSummary.data.find((entry) => entry.unitId === unit.unitId);
      assert(row);
      for (const [key, value] of Object.entries(unit.availability)) {
        assert.deepEqual(value, row[key as keyof AvailabilityRow]);
      }
    }
    const scopedExp = run<typeof expcurve.data>(
      directory,
      "expcurve",
      dbPath,
      ...expArgs,
      ...windowArgs,
    );
    assert.deepEqual(scopedExp.meta.parameters, { ...expcurve.meta.parameters, window });
    assert.deepEqual(
      scopedExp.data.budgets,
      expcurve.data.budgets.filter((row) => row.position >= 2 && row.position < beforePosition),
    );
    const empty = run<FullAvailabilityRow[]>(
      directory,
      "availability",
      dbPath,
      "--full",
      "--before-position",
      "1",
    );
    assert(
      empty.data.every(
        (row) =>
          row.chapters.length === 0
          && row.windowRatio === null
          && row.availableCount === (row.joinPosition === null ? null : 0)
          && row.totalAfterJoin === (row.joinPosition === null ? null : 0)
          && (row.gaps === null || row.gaps.length === 0),
      ),
    );
    const emptyCandidates = run<CandidateFacts>(
      directory,
      "candidates",
      dbPath,
      "--before-position",
      "1",
    );
    assert.deepEqual(emptyCandidates.data.audit, candidates.data.audit);
    assert.deepEqual(
      emptyCandidates.data.units.map((unit) => unit.unitId),
      candidateIds,
    );
    assert(
      emptyCandidates.data.units.every(
        (unit) =>
          unit.availability === null
          || unit.availability.availableCount
            === (unit.availability.joinPosition === null ? null : 0),
      ),
    );
    const emptyExp = run<typeof expcurve.data>(
      directory,
      "expcurve",
      dbPath,
      ...expArgs,
      "--before-position",
      "1",
    );
    assert.deepEqual(emptyExp.data.budgets, []);
    for (const command of ["availability", "candidates", "expcurve"]) {
      reject(directory, command, dbPath, 2, /expects an integer/, "--from-position", "0");
      reject(
        directory,
        command,
        dbPath,
        2,
        /expects an integer/,
        "--before-position",
        String(end + 1),
      );
      reject(
        directory,
        command,
        dbPath,
        2,
        /must be <=/,
        "--from-position",
        "3",
        "--before-position",
        "2",
      );
      reject(directory, command, dbPath, 2, /expects an integer/, "--before-position", "1.5");
    }
    reject(directory, "supports", dbPath, 2, /unknown option/, "--before-position", "2");
    for (const kind of ["missing", "malformed"]) {
      const invalidPath = join(directory, `${kind}-diagnostics.db`);
      copyFileSync(dbPath, invalidPath);
      const invalid = new DatabaseSync(invalidPath);
      try {
        invalid.exec(
          kind === "missing"
            ? "DELETE FROM meta WHERE key = 'extract.diagnostics'"
            : "UPDATE meta SET value = '[42]' WHERE key = 'extract.diagnostics'",
        );
      } finally {
        invalid.close();
      }
      reject(
        directory,
        "supports",
        invalidPath,
        1,
        kind === "missing" ? /re-run `fe-rom extract`/ : /malformed.*extract.diagnostics/,
      );
    }
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
