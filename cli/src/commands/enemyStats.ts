import { hex } from '../cli/hex.ts';
import {
  attackSpeedFirstWeapon,
  collectEnemyStats,
  summarizeAs,
} from '../analysis/enemyStats.ts';
import type { AsSummary, AutolevelRoutine, EnemySample } from '../analysis/enemyStats.ts';
import type { Command } from './types.ts';

export const enemyStats: Command = {
  name: 'enemy-stats',
  summary: 'Enemy attack-speed distribution, projected from placement records',
  description:
    'Walks every reachable enemy placement block and projects attack speed, ' +
    'con and weight. `--hard` re-projects with the hard-mode autolevel round ' +
    '(19 levels instead of 9). The `samples` array is flat on purpose: ' +
    'per-chapter summaries cannot be combined into a route phase exactly.',
  run: ({ rom, flags }) => {
    const { samples, unresolvedClass } = collectEnemyStats({
      rom: rom.rom,
      layout: rom.layout,
      eventScripts: rom.eventScripts,
      chapters: rom.chapters,
      condSlots: rom.condSlots,
      classes: rom.classes,
      units: rom.units,
      items: rom.items,
      hard: flags.hard,
    });

    const round = (n: number): number => Math.round(n * 100) / 100;
    const summary = (s: AsSummary) => ({
      n: s.n,
      min: round(s.min),
      p10: round(s.p10),
      p25: round(s.p25),
      median: round(s.median),
      p75: round(s.p75),
      p90: round(s.p90),
      max: round(s.max),
      mean: round(s.mean),
      /** Outer envelope of the RNG-driven band across the sample. */
      bandLo: round(s.bandLo),
      bandHi: round(s.bandHi),
      /** Records whose attack speed lands below zero (weight > speed + con). */
      negative: s.negative,
      /** Records with `+3` bit 0 clear, i.e. no autolevel at all. */
      noAutolevel: s.noAutolevel,
    });

    const classesOf = (sub: readonly EnemySample[]) => {
      const grouped = new Map<string, EnemySample[]>();
      for (const s of sub) {
        const key = `${s.classId}`;
        const list = grouped.get(key) ?? [];
        list.push(s);
        grouped.set(key, list);
      }
      return [...grouped.values()]
        .map((list) => ({
          classId: list[0]!.classId,
          className: list[0]!.className,
          count: list.length,
          /** The class's own base speed, before the character delta and autolevel. */
          classBaseSpd: list[0]!.classBaseSpd,
          /** Mean signed character-table delta across these records. */
          meanUnitSpdDelta: round(list.reduce((a, s) => a + s.unitSpdDelta, 0) / list.length),
          meanAs: round(summarizeAs(list).mean),
          medianAs: round(summarizeAs(list).median),
        }))
        .sort((a, b) => b.count - a.count);
    };

    const chapterRows = rom.chapters
      .map((chapter) => {
        const sub = samples.filter((s) => s.mapIndex === chapter.index);
        if (sub.length === 0) return null;
        return {
          mapIndex: chapter.index,
          chapterNumber: chapter.chapterNumber,
          title: chapter.title,
          startEvent: chapter.startEventAddr === 0 ? null : hex(chapter.startEventAddr),
          summary: summary(summarizeAs(sub)),
          /**
           * The same records priced with the **first** weapon in each record
           * instead of the heaviest. Quoted so the report can say how much the
           * one input we cannot read (the AI's weapon choice) is worth.
           */
          firstWeaponSummary: summary(summarizeAs(sub, attackSpeedFirstWeapon)),
          classes: classesOf(sub),
        };
      })
      .filter((x) => x !== null);

    const routine = (r: AutolevelRoutine) => samples.filter((s) => s.routine === r);

    const negative = samples
      .filter((s) => s.as.mean < 0)
      .map((s) => ({
        mapIndex: s.mapIndex,
        className: s.className,
        level: s.level,
        spd: round(s.spd.mean),
        con: s.con,
        weight: s.weight,
        as: round(s.as.mean),
      }));

    return {
      rom: rom.path,
      hardMode: flags.hard,
      totals: {
        records: samples.length,
        promoted: samples.filter((s) => s.promoted).length,
        byRoutine: {
          /** `AutolevelUnit`: class growths, `level - 1` rounds. */
          unit: routine('unit').length,
          /** `AutolevelRealistic`: the character's own growths, simulated. */
          realistic: routine('realistic').length,
          /** `+3` bit 0 clear: the record keeps its raw stats. */
          none: routine('none').length,
        },
        /** Records with no weapon in `+12..15`, so no weight penalty. */
        noWeapon: samples.filter((s) => s.weight === 0).length,
        negativeAs: negative.length,
        /** Enemy records whose class id did not resolve; 0 expected. */
        unresolvedClass,
      },
      overall: summary(summarizeAs(samples)),
      byRoutine: {
        unit: summary(summarizeAs(routine('unit'))),
        realistic: summary(summarizeAs(routine('realistic'))),
        none: summary(summarizeAs(routine('none'))),
      },
      chapters: chapterRows,
      /**
       * Every projected record, flat. Per-chapter summaries cannot be combined
       * into a route phase exactly, so the raw rows are emitted and consumers
       * aggregate for themselves.
       */
      samples: samples.map((s) => ({
        mapIndex: s.mapIndex,
        unitId: s.unitId,
        classId: s.classId,
        className: s.className,
        level: s.level,
        grow: s.grow,
        routine: s.routine,
        promoted: s.promoted,
        spd: round(s.spd.mean),
        con: s.con,
        weight: s.weight,
        weightFirst: s.weightFirst,
        as: round(s.as.mean),
      })),
      /** Every record whose attack speed came out below zero, with its inputs. */
      negativeSamples: negative,
      limitations: [
        'Attack speed is `speed - max(0, weapon weight - constitution)`, the same formula `BattleLoadAS @ 0x0802AB74` runs for both sides. It is signed: nothing clamps it at zero, so a Gorgon Egg holding a 10-weight tome really does sit at -4.',
        'Weapon weight uses the **heaviest** weapon in the record (worst case for the enemy, best case for the player). Which weapon the AI actually picks is the one input this projection cannot read from the ROM; `firstWeaponSummary` prices the other convention, and the two differ by about 0.2 attack speed.',
        'Autolevel burns random numbers (`NextRN_N` in `GetAutoleveledStat`, `Roll1RN` in `GetStatIncrease`), so `mean` is exact in expectation but no single playthrough reproduces it. `bandLo`/`bandHi` bracket what the RNG can reach.',
        'Only placement blocks reachable from a condition-slot script are seen. Blocks referenced from TRAP slots or from code the opcode table does not know are invisible, and the walk gives up after ten consecutive unknown instructions - so the sample is a lower bound on the enemy count, not a census.',
        'The `realistic` routine simulates one level-up per level with the character\'s own growths. Its mean is exact; its band is quoted as `mean +/- 2 standard deviations` of the equivalent binomial, not as the ROM\'s own reachable set.',
      ],
    };
  },
};