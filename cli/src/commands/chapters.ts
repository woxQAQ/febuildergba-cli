import { hex } from '../cli/hex.ts';
import { alwaysForcedUnits, forcedUnitsForMap, MAP_ANY, routeLabel } from '../tables/forceSortie.ts';
import { isStoryTitle } from '../analysis/report.ts';
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
 */
export const chapters: Command = {
  name: 'chapters',
  summary: 'Join order: per-chapter rosters and mid-chapter recruit sites',
  description:
    'Two views of the same data: `joinOrder` is one row per unit ordered by when ' +
    'it becomes available, and `chapters` is one row per map. **Prefer ' +
    '`chapterNumber` over `mapIndex`** - the map table has a row per map id, so ' +
    'the index also counts unused slots and bonus maps.',
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
      return {
        mapIndex: chapter.index,
        /**
         * The game's own chapter number (`u16(record + 0x80) / 2`). **Use this,
         * not `mapIndex`.** The table has a row per map id, so `mapIndex` counts
         * unused slots and bonus maps too; 0 means "this row is not a chapter".
         */
        chapterNumber: chapter.chapterNumber,
        /** Chapter title from `+0x70`; `''` for unused slots, `@001F` for world-map maps. */
        title: chapter.title,
        titleTextId: chapter.titleTextId,
        mapSettingAddress: hex(chapter.mapSettingAddr),
        eventPlist: chapter.eventPlist,
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
        placements: chapter.placements.map((p) => {
          const ref = described(p.unitId);
          return {
            ...ref,
            placedClassId: p.classId,
            placedClassName:
              p.classId === 0 ? '(own class)' : (rom.classNames.get(p.classId) ?? null),
            level: p.level,
            prePlacementCoord: p.prePlacementCoord,
            postPlacementCoords: p.postPlacementCount,
            classOverridden: p.classId !== 0 && p.classId !== ref.ownClassId,
          };
        }),
        recruitSites: (scan?.recruits ?? []).map((site) => ({
          kind: site.kind,
          slot: site.slotKind,
          address: hex(site.addr),
          instruction: site.instruction,
          block: hex(site.blockAddr),
          units: site.units.map((u) => ({
            id: u.unitId,
            name: describe(u.unitId),
            placedClassId: u.classId,
          })),
        })),
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
         * Items this chapter's scripts hand out. `unitPrice` is the item's `+26`
         * field: for a money bag (`Gold`, `3,000 Gold`, ...) that field **is** the
         * gold amount the bag is worth, which is how the game pays out money.
         */
        itemsGiven: (scan?.itemsGiven ?? []).map((g) => {
          const item = rom.itemMap.get(g.itemId);
          return {
            address: hex(g.addr),
            itemId: g.itemId,
            name: item?.name ?? `item#${g.itemId}`,
            unitPrice: item?.unitPrice ?? 0,
            toUnit: g.unitId === 0xffff ? '(visiting unit)' : describe(g.unitId),
          };
        }),
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
      chapters: chapterRows,
      limitations: [
        'A placement record counts as the named character only when its class id ' +
          'is 0 or matches the unit\'s own class. Hack authors reuse one unit id ' +
          'as a generic template with varying class ids; those records are ' +
          'reported with classOverridden=true and excluded from join order.',
        'mapIndex is a row number in the map-setting table, NOT a chapter ' +
          'number: the table has one row per map id, so it also holds unused ' +
          'slots (chapterNumber 0), world-map/skirmish maps (title "@001F", ' +
          'sharing a story chapter\'s number) and bonus maps. Use ' +
          'chapterNumber / joinChapterNumber, or the decoded title.',
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
          'be referenced by many maps, so the same goldEvents / itemsGiven ' +
          '`address` (and the same placement block) reappears under every chapter ' +
          'that reaches it. Deduplicate by address before summing: a single ' +
          '5,000-gold script shared by 17 maps is one payout, not 85,000 gold.',
      ],
    };
  },
};