import { hex } from '../cli/hex.ts';
import { alwaysForcedUnits, forcedUnitsForMap, MAP_ANY, routeLabel } from '../tables/forceSortie.ts';
import { isRealMap } from '../tables/storyPath.ts';
import { isStoryTitle } from '../analysis/crossTable.ts';
import type { Command } from './types.ts';

/**
 * Join order. A unit's join chapter is not stored anywhere; it is derived from
 * two kinds of evidence:
 *
 *   1. the chapter's initial player placement block (condition slot 10), and
 *   2. `LOAD1` ("自軍ユニットは仲間にする") instructions in the chapter's events.
 *
 * See `tables/chapters.ts` for the full chain and its two documented
 * deviations from FEBuilderGBA.
 *
 * ## Output shape
 *
 * Two views, and deliberately not three. `joinOrder` is one row per **unit** -
 * the question "when can I use this unit" is per-unit, and 62 rows answer it.
 * `chapters` is one row per **map**, for questions about a single map.
 *
 * The per-map row does not repeat every placement record. A map's placement
 * block holds one entry per deployment slot, and hack authors reuse unit ids as
 * generic templates with a different class, so the block runs to several
 * hundred entries where the roster is sixty characters. Emitting them all made
 * this command the largest by output size (535 KB on Vision Quest, against 27 KB
 * for `storypath`) while adding nothing the other views did not carry. What is
 * kept is `detachedClasses`, the one thing placements say that join order cannot:
 * a character fought this map as a different class than their own.
 *
 * `storypath` owns the main path, so this command does not repeat it.
 */
export const chapters: Command = {
name: 'chapters',
  summary: 'Join order: when each unit becomes available, and per-map rosters',
  description:
    'Two views of the same data: `joinOrder` is one row per **unit** ordered by ' +
    'when it becomes available, and `chapters` is one row per **map**. ' +
    '**Prefer `chapterNumber` over `mapIndex`** - the map table has a row per map ' +
    'id, so the index also counts unused slots and bonus maps. **Run `storypath` ' +
    'for the order chapters play in**: the chapter number restarts at 1 in every ' +
    'act and cannot order them. Padded map rows are dropped unless `--all`; the ' +
    'deploy roster is deduplicated per character rather than per slot.',
  run: ({ rom, flags }) => {
    const supportIds = new Set(rom.supports.entries.map((e) => e.unitId));
    const unitById = new Map(rom.units.map((u) => [u.id, u]));

    const describe = (id: number): string => {
      const unit = unitById.get(id);
      if (unit === undefined || unit.name.length === 0) return `#${id}`;
      return unit.name;
    };

    interface UnitRef {
      id: number;
      name: string;
      ownClassId: number | null;
      ownClassName: string | null;
      isSupportCharacter: boolean;
    }

    const described = (id: number): UnitRef => {
      const unit = unitById.get(id);
      return {
        id,
        name: describe(id),
        ownClassId: unit?.classId ?? null,
        ownClassName: unit?.className ?? null,
        isSupportCharacter: supportIds.has(id),
      };
    };

    const chapterRows = rom.chapters.map((chapter) => {
      const scan = rom.chapterScans.find((s) => s.chapterIndex === chapter.index);
      /**
       * True for a row that pads the map table out to its full length: the row
       * does not claim its own slot id, so nothing refers to it either. Same
       * test `storypath` uses, kept here so the two commands agree.
       */
      const isPaddedRow = !isRealMap(rom.rom, chapter);
      return {
        mapIndex: chapter.index,
        /** False for the rows that only pad the table; see `storypath`. */
        isPaddedRow,
        /**
         * The game's own chapter number (`u16(record + 0x80) / 2`). **Use this,
         * not `mapIndex`.** The table has a row per map id, so `mapIndex` counts
         * unused slots and bonus maps too; 0 means "this row is not a chapter".
         */
        chapterNumber: chapter.chapterNumber,
        /** Chapter title from `+0x70`; `''` for unused slots, `@001F` for world-map maps. */
        title: chapter.title,
        /**
         * Raw table pointers, for auditing a decode. `startEvent` /
         * `endEvent` / `playerPlacement` are three of the twenty condition
         * slots; `condTableAddress` is the table holding them.
         */
        mapSettingAddress: hex(chapter.mapSettingAddr),
        condTableAddress: chapter.condTableAddr === 0 ? null : hex(chapter.condTableAddr),
        startEvent: chapter.startEventAddr === 0 ? null : hex(chapter.startEventAddr),
        endEvent: chapter.endEventAddr === 0 ? null : hex(chapter.endEventAddr),
        playerPlacement: chapter.playerPlacementAddr === 0 ? null : hex(chapter.playerPlacementAddr),
        /**
         * How many units this map lets you field. See `Chapter.deploySlots` in
         * `tables/chapters.ts` for how this is derived and why it is the same
         * number the game computes in `GetChapterAllyUnitCount`.
         */
        deploySlots: chapter.deploySlots,
        /** Same, on hard mode (condition slot 11). Falls back to `deploySlots`. */
        deploySlotsHard: chapter.deploySlotsHard,
        /**
         * Units the prep screen will not let you bench here
         * (`event_force_sortie_pointer`). A record's `mapIndex` of 0xFF means
         * "every map", so such units also appear on every chapter's list.
         */
        forcedUnits: forcedUnitsForMap(rom.forceSortie, chapter.index).map((f) => ({
          ...described(f.unitId),
          /** 0xFF = applies on every route; otherwise `ChapterData + 0x1B`. */
          routeFilter: f.route,
          routeFilterLabel: routeLabel(f.route),
          /** True when the record has no map filter - the unit is forced everywhere. */
          everyMap: f.mapIndex === MAP_ANY,
          recordAddress: hex(f.addr),
        })),
        /**
         * Roster actually deployed here, one entry per **character** rather than
         * per placement record: a character placed under two classes in the same
         * map appears once per distinct class.
         *
         * Replaces the raw `placements` list, which was one entry per
         * deployment slot and therefore hundreds of rows on a hack that reuses
         * ids as generic templates.
         */
        roster: (() => {
          const merged = new Map<string, {
            id: number;
            name: string;
            ownClassName: string | null;
            isSupportCharacter: boolean;
            levels: number[];
            classes: string[];
            overridden: boolean;
          }>();
          for (const p of chapter.placements) {
            const ref = described(p.unitId);
            const placed =
              p.classId === 0 ? '(own class)' : (rom.classNames.get(p.classId) ?? `class#${p.classId}`);
            const key = `${p.unitId}|${placed}`;
            const hit = merged.get(key);
            if (hit === undefined) {
              merged.set(key, {
                id: ref.id,
                name: ref.name,
                ownClassName: ref.ownClassName,
                isSupportCharacter: ref.isSupportCharacter,
                levels: [p.level],
                classes: [placed],
                overridden: p.classId !== 0 && p.classId !== ref.ownClassId,
              });
            } else {
              hit.levels.push(p.level);
            }
          }
          return [...merged.values()].sort((a, b) => a.id - b.id);
        })(),
        /**
         * Mid-chapter recruit sites, **filtered to the playable roster**.
         *
         * The scan reads every `LOAD1` in the chapter's scripts, and in a hack
         * that reuses unit ids for generic templates that set includes enemies:
         * on Vision Quest 204 ids appear across the sites and only 62 are
         * characters. The other 142 are noise for a roster question, so they are
         * dropped here and the character rows are already in `joinOrder`.
         *
         * What survives is the part `joinOrder` cannot express: a character
         * recruited *during* this map rather than at its start.
         */
        midChapterRecruits: (() => {
          const sites = scan?.recruits ?? [];
          const out: Array<{
            kind: string;
            address: string;
            units: Array<{ id: number; name: string }>;
          }> = [];
          for (const site of sites) {
            const units = site.units
              .filter((u) => supportIds.has(u.unitId))
              .map((u) => ({ id: u.unitId, name: describe(u.unitId) }));
            if (units.length === 0) continue;
            out.push({ kind: site.kind, address: hex(site.addr), units });
          }
          return out;
        })(),
        truncatedScriptWalks: scan?.truncatedWalks ?? 0,
        /**
         * Direct gold writes reachable from this chapter's scripts, from the two
         * literal instructions `40050300XXXX000021370000` (gain) and
         * `...22370000` (lose). Money bags handed over as items are in
         * `itemsGiven`, not here.
         */
        goldEvents: (scan?.gold ?? []).map((g) => ({
          address: hex(g.addr),
          delta: g.delta,
          instruction: g.instruction,
        })),
        /**
         * Items this chapter's scripts hand out, deduplicated by address.
         *
         * Hack chapters share one script across many maps, so the same payout
         * reappears under every map that reaches it - the reference's own
         * limitation note calls this out. Keeping one row per address stops a
         * single 5,000-gold script from being counted once per map.
         *
         * `unitPrice` is the item's `+26` field: for a money bag (`Gold`,
         * `3,000 Gold`, ...) that field **is** the gold amount the bag is worth,
         * which is how the game pays out money.
         */
        itemsGiven: (() => {
          const byAddress = new Map<
            string,
            { address: string; itemId: number; name: string; unitPrice: number; toUnit: string }
          >();
          for (const g of scan?.itemsGiven ?? []) {
            const address = hex(g.addr);
            if (byAddress.has(address)) continue;
            const item = rom.itemMap.get(g.itemId);
            byAddress.set(address, {
              address,
              itemId: g.itemId,
              name: item?.name ?? `item#${g.itemId}`,
              unitPrice: item?.unitPrice ?? 0,
              toUnit: g.unitId === 0xffff ? '(visiting unit)' : describe(g.unitId),
            });
          }
          return [...byAddress.values()];
        })(),
      };
    });

    const rows: Array<Record<string, unknown>> = [];
    const chapterOf = (index: number | null | undefined) =>
      index === null || index === undefined
        ? null
        : (rom.chapters.find((c) => c.index === index) ?? null);
    const titleOf = (index: number | null | undefined): string | null =>
      chapterOf(index)?.title ?? null;
    const where = (index: number | null | undefined): string => {
      const chapter = chapterOf(index);
      if (chapter === null) return `map#${index}`;
      const label = chapter.title === '' ? '(untitled)' : chapter.title;
      return chapter.chapterNumber > 0
        ? `ch${chapter.chapterNumber} ${label}`
        : `map#${index} ${label}`;
    };
    const unitIds = new Set<number>([...rom.joins.joins.keys(), ...rom.joins.appearances.keys()]);
    for (const record of rom.forceSortie?.records ?? []) unitIds.add(record.unitId);

    // unit id -> the forced-deployment records that name it, with the chapter they
    // apply to resolved. A record with mapIndex 0xFF applies everywhere.
    const forcedByUnit = new Map<
      number,
      Array<{ chapterIndex: number | null; route: number; everyMap: boolean }>
    >();
    for (const record of rom.forceSortie?.records ?? []) {
      const list = forcedByUnit.get(record.unitId) ?? [];
      list.push({
        chapterIndex: record.mapIndex === MAP_ANY ? null : record.mapIndex,
        route: record.route,
        everyMap: record.mapIndex === MAP_ANY,
      });
      forcedByUnit.set(record.unitId, list);
    }

    for (const id of unitIds) {
      if (!flags.all && !supportIds.has(id)) continue;
      if (flags.playableOnly && !supportIds.has(id)) continue;
      const join = rom.joins.joins.get(id);
      const appearance = rom.joins.appearances.get(id);
      const earliestChapter = appearance?.chapterIndex ?? join?.chapterIndex ?? null;
      const earliestSource = appearance?.source ?? join?.source ?? null;
      const joinRecord = chapterOf(join?.chapterIndex);
      const joinIsStory = joinRecord === null ? null : isStoryTitle(joinRecord.title);
      const forced = forcedByUnit.get(id) ?? [];
      const forcedEverywhere = forced.filter((f) => f.everyMap);
      const notes: string[] = [];
      if (forced.length > 0) {
        const places =
          forcedEverywhere.length > 0
            ? 'on every map'
            : forced
                .map((f) => (f.chapterIndex === null ? 'every map' : where(f.chapterIndex)))
                .join(', ');
        notes.push(`forced deployment: must be fielded ${places}.`);
      }
      if (join === undefined) {
        notes.push(
          earliestChapter === null
            ? 'no chapter evidence found at all'
            : `no recruit instruction names this unit; it is only loaded ` +
              `(${earliestSource}) in ${where(earliestChapter)}.`,
        );
      } else if (earliestChapter !== null && earliestChapter < join.chapterIndex) {
        notes.push(
          `loaded (${earliestSource}) in ${where(earliestChapter)} but only ` +
            `recruited in ${where(join.chapterIndex)}; the real join is likely ` +
            `${where(earliestChapter)} or earlier.`,
        );
      }
      if (joinIsStory === false) {
        notes.push(
          `the recruit instruction points at map#${join?.chapterIndex}, which has ` +
            'no title (an unused slot or a world-map encounter map) - treat this ' +
            'join chapter as unreliable.',
        );
      }
      rows.push({
        ...described(id),
        /** Earliest chapter with a placement or a `LOAD1` ("仲間にする") instruction. */
        joinChapter: join?.chapterIndex ?? null,
        /** The game's chapter number for `joinChapter`. **Prefer this over `joinChapter`.** */
        joinChapterNumber: joinRecord?.chapterNumber ?? null,
        /** **Prefer this over `joinChapter`** - the index counts placeholder records. */
        joinChapterTitle: joinRecord?.title ?? null,
        /** False when `joinChapter` is an unused slot, a skirmish map or a bonus map. */
        joinChapterIsStory: joinIsStory,
        joinSource: join?.source ?? null,
        joinEvidence: join === undefined ? null : hex(join.evidenceAddr),
        placedClassId: join?.placedClassId ?? null,
        /**
         * Chapters where the prep screen will not let this unit be benched
         * (`event_force_sortie_pointer`). An entry with `mapIndex: null` has no
         * map filter and therefore applies to every map. `[]` means the unit is
         * never force-deployed by this table - note the game may still force the
         * lord through a separate rule, so `[]` is not "freely benchable".
         */
        forcedDeployment: forced.map((f) => ({
          mapIndex: f.chapterIndex,
          chapterNumber:
            f.chapterIndex === null ? null : (chapterOf(f.chapterIndex)?.chapterNumber ?? null),
          chapterTitle: f.chapterIndex === null ? null : (chapterOf(f.chapterIndex)?.title ?? null),
          everyMap: f.everyMap,
          routeFilter: f.route,
          routeFilterLabel: routeLabel(f.route),
        })),
        /**
         * Earliest chapter with *any* load evidence, including `LOAD2`. A `LOAD2`
         * only loads units that are already in the party, so this is a sound
         * lower bound on "usable from" - but it can also be a script the author
         * reused defensively, so it is a hint rather than a fact.
         */
        earliestEvidenceChapter: earliestChapter,
        earliestEvidenceChapterNumber: chapterOf(earliestChapter)?.chapterNumber ?? null,
        earliestEvidenceChapterTitle: titleOf(earliestChapter),
        earliestEvidenceSource: earliestSource,
        ...(notes.length === 0 ? {} : { note: notes.join(' ') }),
      });
    }
    rows.sort(
      (a, b) =>
        ((a.joinChapter as number | null) ?? Number.MAX_SAFE_INTEGER) -
          ((b.joinChapter as number | null) ?? Number.MAX_SAFE_INTEGER) ||
        (a.id as number) - (b.id as number),
    );

    return {
      source: {
        configDir: rom.configDir,
        eventOpcodeTable: rom.eventScripts.source,
        eventOpcodes: rom.eventScripts.scripts.length,
      },
      mapSettings:
        rom.mapSettings === null
          ? null
          : {
              slot: hex(rom.mapSettings.slotOffset),
              table: hex(rom.mapSettings.tableOffset),
              recordSize: rom.mapSettings.recordSize,
              count: rom.mapSettings.count,
              countSource: rom.mapSettings.countSource,
              countNote:
                rom.mapSettings.countSource === 'structural'
                  ? 'The reference terminator test (u32(+0) must not be a pointer) ' +
                    'rejected every record, so the table was scanned on structure.'
                  : 'Counted with the reference terminator test.',
            },
      conditionSlots: rom.condSlots.map((s) => ({
        index: s.index,
        flag: s.flag,
        kind: s.kind,
        name: s.name,
      })),
      forcedDeployment: {
        table:
          rom.forceSortie === null
            ? null
            : {
                slot: hex(rom.forceSortie.slotOffset),
                address: hex(rom.forceSortie.tableOffset),
                recordSize: rom.forceSortie.recordSize,
                count: rom.forceSortie.count,
                termination: rom.forceSortie.termination,
              },
        /**
         * Records with no map filter (`mapIndex` 0xFF): these units are forced on
         * every map, which is what a "must always be deployed" lord looks like.
         */
        everyMap: alwaysForcedUnits(rom.forceSortie).map((f) => ({
          ...described(f.unitId),
          routeFilter: f.route,
          routeFilterLabel: routeLabel(f.route),
        })),
        /** Every record, including the per-map ones. */
        records: (rom.forceSortie?.records ?? []).map((f) => ({
          ...described(f.unitId),
          mapIndex: f.mapIndex,
          mapIndexIsAny: f.mapIndex === MAP_ANY,
          chapterNumber: f.mapIndex === MAP_ANY ? null : (chapterOf(f.mapIndex)?.chapterNumber ?? null),
          chapterTitle: f.mapIndex === MAP_ANY ? null : (chapterOf(f.mapIndex)?.title ?? null),
          routeFilter: f.route,
          routeFilterLabel: routeLabel(f.route),
          recordAddress: hex(f.addr),
        })),
        limitations: [
          'The route byte is compared by the game against a RUNTIME value ' +
            '(ChapterData + 0x1B), so it cannot be resolved statically. Records ' +
            'are reported regardless of it; check routeFilter when it is not 0xFF.',
          'A unit absent from this table is not necessarily benchable - the lord ' +
            'is force-deployed by a separate rule the table does not describe.',
          'A record with mapIndex 0xFF applies to every map, so such units appear ' +
            'on every chapter\'s forcedUnits list.',
        ],
      },
      stats: {
        /** Rows in the map-setting table, not the number of story chapters. */
        mapSettingRecords: rom.chapters.length,
        /** Rows that carry a non-zero chapter number (`+0x80 / 2`). */
        chaptersWithNumber: rom.chapters.filter((c) => c.chapterNumber > 0).length,
        /** Highest chapter number in the table. */
        maxChapterNumber: rom.chapters.reduce((n, c) => Math.max(n, c.chapterNumber), 0),
        placementsExamined: rom.joins.placementsExamined,
        classOverriddenPlacements: rom.joins.classOverriddenPlacements,
        loadSites: rom.joins.sitesByKind,
        unitsWithJoinEvidence: rom.joins.joins.size,
        unitsWithAnyAppearance: rom.joins.appearances.size,
        /** Forced-deployment records read (0 when the game has no such table). */
        forceSortieRecords: rom.forceSortie?.count ?? 0,
        /** Units named by the forced-deployment table. */
        unitsForcedSomewhere: new Set((rom.forceSortie?.records ?? []).map((r) => r.unitId)).size,
        /** Highest deployment slot count across all maps. */
        maxDeploySlots: rom.chapters.reduce((n, c) => Math.max(n, c.deploySlots), 0),
      },
      joinOrder: rows,
      /**
       * One row per map. Padded rows are dropped unless `--all`: the map table
       * has a row per map *slot*, and those rows carry no roster, no events and
       * no title, so a default run would spend two thirds of its output on
       * nothing. `storypath` reports how many were dropped and which battles are
       * registered twice.
       */
      chapters: flags.all ? chapterRows : chapterRows.filter((c) => !c.isPaddedRow),
      limitations: [
        'A placement record counts as the named character only when its class id ' +
          'is 0 or matches the unit\'s own class. Hack authors reuse one unit id ' +
          'as a generic template with varying class ids; those records are ' +
          'reported with `overridden` in `roster` and excluded from join order.',
        'mapIndex is a row number in the map-setting table, NOT a chapter ' +
          'number: the table has one row per map id, so it also holds unused ' +
          'slots (chapterNumber 0), world-map/skirmish maps (title "@001F", ' +
          'sharing a story chapter\'s number) and bonus maps. Use ' +
          'chapterNumber / joinChapterNumber, or the decoded title. Run ' +
          '`storypath` for the order the chapters actually play in - the chapter ' +
          'number restarts at 1 in every act and cannot order them.',
        'Script walks stop after ten consecutive unrecognised opcodes, matching ' +
          'FEBuilderGBA. truncatedScriptWalks counts those. A recruit site after ' +
          'such a stop is missed.',
        'LOAD2 (412C) and LOAD3 (422C) do not recruit; they appear in ' +
          'earliestEvidenceChapter only. A LOAD2 loads units that are already in ' +
          'the party, so when it predates the joinChapter the real join is ' +
          'probably earlier - such rows carry a `note`.',
        'Hack chapters often share one "load the whole party" script between ' +
          'several maps, so a LOAD1 seen in a late chapter is usually a re-load, ' +
          'not a join.',
        'Deduplication is **per chapter**, never across chapters. One script can ' +
          'be referenced by many maps, so the same `address` in goldEvents / ' +
          'itemsGiven reappears under every chapter that reaches it. Deduplicate ' +
          'by address before summing: a single 5,000-gold script shared by 17 ' +
          'maps is one payout, not 85,000 gold.',
        '`midChapterRecruits` is filtered to the playable roster. The underlying ' +
          'scan sees every LOAD1 including enemy placements, which in a hack that ' +
          'reuses ids runs to several times the character count.',
      ],
    };
  },
};