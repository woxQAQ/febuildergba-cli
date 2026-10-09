import { hex } from "../format.ts";
import {
  alwaysForcedUnits,
  forcedUnitsForMap,
  MAP_ANY,
  routeLabel,
} from "../tables/forceSortie.ts";
import { duplicateRegistrations, isRealMap } from "../tables/storyPath.ts";
import { isStoryTitle } from "../analysis/crossTable.ts";
import type { Command } from "./types.ts";

/**
 * The chapter table, and everything keyed by chapter.
 *
 * This used to be two commands. `storypath` owned the play order and
 * `chapters` owned the per-map rosters and join order, which made the pair
 * look like two views of one table when they were really one table presented
 * twice - and, worse, one of them was presenting the wrong ordering. The
 * chapter *number* restarts at 1 in every act, so neither command's numeric
 * key could answer "when does this happen".
 *
 * So `playOrder` is the spine. It is the sequence of maps a playthrough sees,
 * derived from each chapter's END_EVENT transitions: the main path plus the
 * side chapters, each spliced in where its branch puts it. Every other list
 * here - `chapters`, `joinOrder` - is ordered by that position, and nothing
 * falls back on `mapIndex` or `chapterNumber` for ordering.
 *
 * ## Views
 *
 *   - `playOrder.sequence` - every map in play order, with `role` and
 *     `playable`; this is the chapter list.
 *   - `chapters`        - one row per map, in play order: what it deploys,
 *     who is on it, where it leads.
 *   - `joinOrder`       - one row per unit, in join order: when it becomes
 *     available.
 *   - `branches`        - where the path forks, i.e. where a side chapter
 *     hangs off it.
 *   - `offPath`         - real maps the main path does not reach.
 */
export const chapters: Command = {
  name: "chapters",
  summary: "Chapter table: play order, per-map rosters, and when each unit joins",
  description:
    "The play order first, then everything keyed by chapter. **Order on " +
    "`storyOrder`, never on `chapterNumber`**: the chapter number is the one " +
    "the prep screen shows and it restarts at 1 in every act, so Vision " +
    "Quest's map 16 is followed by 41, 42 and only then 17. `playOrder` is " +
    "derived from the END_EVENT transitions; a side chapter is spliced in " +
    "where its branch puts it. `joinOrder` is one row per unit ordered by the " +
    "play position of its join chapter. Padded map rows are dropped unless " +
    "`--all`; the deploy roster is deduplicated per character rather than per " +
    "slot.",
  run: ({ rom, flags }) => {
    const supportIds = new Set(rom.supports.entries.map((e) => e.unitId));
    const unitById = new Map(rom.units.map((u) => [u.id, u]));
    const byMap = new Map(rom.chapters.map((c) => [c.index, c]));
    const edgesByMap = new Map(rom.mapTransitions.map((e) => [e.mapIndex, e]));
    const realMaps = new Set(rom.chapters.filter((c) => isRealMap(rom.rom, c)).map((c) => c.index));

    const play = rom.playOrder;
    const position = play.position;
    const stepOf = new Map(play.steps.map((s) => [s.mapIndex, s]));
    const orderOf = (mapIndex: number | null | undefined): number | null =>
      mapIndex === null || mapIndex === undefined ? null : (position.get(mapIndex) ?? null);
    const label = (mapIndex: number): string => {
      const c = byMap.get(mapIndex);
      return c === undefined || c.title.length === 0 ? `(map ${mapIndex})` : c.title;
    };
    /** `main` / `side` / `offPath` / `padded` - how a map relates to the path. */
    const playsAsOf = (mapIndex: number): "main" | "side" | "offPath" | "padded" => {
      const step = stepOf.get(mapIndex);
      if (step !== undefined) return step.role;
      return realMaps.has(mapIndex) ? "offPath" : "padded";
    };

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
      const edge = edgesByMap.get(chapter.index);
      const step = stepOf.get(chapter.index);
      return {
        /** 1-based play position, or `null` when the main path does not reach it. */
        storyOrder: orderOf(chapter.index),
        /**
         * `main` (on the no-detour path), `side` (a chapter spliced in at a
         * branch), `offPath` (a real map the path does not reach), `padded` (a
         * table row that was never a map).
         */
        playsAs: playsAsOf(chapter.index),
        mapIndex: chapter.index,
        /** False for the rows that only pad the table out to its full length. */
        isPaddedRow: !realMaps.has(chapter.index),
        /**
         * The game's own chapter number (`u16(record + 0x80) / 2`), for display
         * next to the title. **Never order on this.** It restarts at 1 every
         * act, and gaiden chapters carry a `.5` suffix, so `7` and `7.5` are
         * both real values.
         */
        chapterNumber: chapter.chapterNumber,
        /** Chapter title from `+0x70`; `''` for unused slots, `@001F` for world-map maps. */
        title: chapter.title,
        /**
         * Maps this chapter's END_EVENT can send you to, in script order. The
         * first is the one the main path follows; any others are side chapters
         * spliced in here, and they are already in `playOrder.sequence`.
         */
        goesTo: edge === undefined ? [] : [...new Set(edge.transitions.map((t) => t.targetMap))],
        /**
         * Why the transition walk ended. `"unrecognised opcode"` means the
         * script was not read to its end, so a missing transition there is not
         * evidence of anything.
         */
        stoppedBecause: edge?.stopReason ?? "no END_EVENT",
        /**
         * Instruction-level edges, `--all` only. `goesTo` answers "where can
         * this chapter go"; this answers "which instruction said so", which is
         * how a missing destination is told apart from an undecodable script.
         * `callDepth > 0` means the instruction sits in a shared helper event.
         */
        ...(flags.all
          ? {
              transitions: (edge?.transitions ?? []).map((t) => ({
                opcode: t.opcode,
                targetMap: t.targetMap,
                callDepth: t.callDepth,
              })),
            }
          : {}),
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
         * (`event_force_sortie_pointer`).
         *
         * **Map-specific records only.** A record whose `mapIndex` is 0xFF
         * applies to every map, so listing it here put the same two rows -
         * Storch and Waluyo - into all 60 maps: 120 of the 159 entries emitted
         * were copies. They are listed once in `forcedDeployment.everyMap`
         * instead, so "who can I not bench here" is
         * `forcedUnits` + `forcedDeployment.everyMap`, filtered by `routeFilter`.
         */
        forcedUnits: forcedUnitsForMap(rom.forceSortie, chapter.index)
          .filter((f) => f.mapIndex !== MAP_ANY)
          .map((f) => ({
            ...described(f.unitId),
            /** 0xFF = applies on every route; otherwise `ChapterData + 0x1B`. */
            routeFilter: f.route,
            routeFilterLabel: routeLabel(f.route),
          })),
        /**
         * Roster actually deployed here, one entry per **character** rather than
         * per placement record: a character placed under two classes in the same
         * map appears once per distinct class.
         */
        roster: (() => {
          const merged = new Map<
            string,
            {
              id: number;
              name: string;
              ownClassName: string | null;
              isSupportCharacter: boolean;
              levels: number[];
              classes: string[];
              overridden: boolean;
            }
          >();
          for (const p of chapter.placements) {
            const ref = described(p.unitId);
            const placed =
              p.classId === 0
                ? "(own class)"
                : (rom.classNames.get(p.classId) ?? `class#${p.classId}`);
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
         * Mid-chapter recruit sites, **filtered to the playable roster and to
         * actual recruit instructions**.
         *
         * Two filters, both earned by measurement on Vision Quest:
         *
         * 1. The scan reads every `LOAD*` in the chapter's scripts, and in a
         *    hack that reuses unit ids for generic templates that set includes
         *    enemies: 204 ids appear across the sites and only 62 are
         *    characters. The other 142 are noise for a roster question, so they
         *    are dropped here and the character rows are already in `joinOrder`.
         * 2. Only `kind === 'recruit'` (`402C`, LOAD1 "仲間にする") recruits at
         *    all. `412C`/`422C` are LOAD2/LOAD3 - they load units that are
         *    already in the party - and they were 74 of the 122 sites, 42 KB of
         *    this block's 52 KB, inside a field named "recruits".
         *
         * What survives is the part `joinOrder` cannot express: a character
         * recruited *during* this map rather than at its start.
         */
        midChapterRecruits: (() => {
          const sites = scan?.recruits ?? [];
          const out: Array<{
            kind: string;
            units: Array<{ id: number; name: string }>;
          }> = [];
          for (const site of sites) {
            if (site.kind !== "recruit") continue;
            const units = site.units
              .filter((u) => supportIds.has(u.unitId))
              .map((u) => ({ id: u.unitId, name: describe(u.unitId) }));
            if (units.length === 0) continue;
            out.push({ kind: site.kind, units });
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
          /**
           * The one place an address is part of the payload rather than a decode
           * aid: a script shared by several maps is one payout seen several
           * times, and this is the only key that says so. See `itemsGiven`.
           */
          address: hex(g.addr),
          delta: g.delta,
          instruction: g.instruction,
        })),
        /**
         * Items this chapter's scripts hand out, deduplicated by address.
         *
         * Hack chapters share one script across many maps, so the same payout
         * reappears under every map that reaches it. Keeping one row per address
         * stops a single 5,000-gold script from being counted once per map.
         *
         * `unitPrice` is the item's `+26` field: for a money bag (`Gold`,
         * `3,000 Gold`, ...) that field **is** the gold amount the bag is worth.
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
              toUnit: g.unitId === 0xffff ? "(visiting unit)" : describe(g.unitId),
            });
          }
          return [...byAddress.values()];
        })(),
      };
    });

    const rows: Array<Record<string, unknown>> = [];
    const chapterOf = (index: number | null | undefined) =>
      index === null || index === undefined ? null : (byMap.get(index) ?? null);
    const titleOf = (index: number | null | undefined): string | null =>
      chapterOf(index)?.title ?? null;
    const where = (index: number | null | undefined): string => {
      const chapter = chapterOf(index);
      if (chapter === null) return `map#${index}`;
      const body = chapter.title === "" ? "(untitled)" : chapter.title;
      const place = orderOf(index) === null ? `off-path` : `play ${orderOf(index)}`;
      return `${place} ${body}`;
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
      const joinStoryOrder = orderOf(join?.chapterIndex);
      const forced = forcedByUnit.get(id) ?? [];
      const forcedEverywhere = forced.filter((f) => f.everyMap);
      const notes: string[] = [];
      if (forced.length > 0) {
        const places =
          forcedEverywhere.length > 0
            ? "on every map"
            : forced
                .map((f) => (f.chapterIndex === null ? "every map" : where(f.chapterIndex)))
                .join(", ");
        notes.push(`forced deployment: must be fielded ${places}.`);
      }
      if (join === undefined) {
        notes.push(
          earliestChapter === null
            ? "no chapter evidence found at all"
            : `no recruit instruction names this unit; it is only loaded ` +
                `(${earliestSource}) in ${where(earliestChapter)}.`,
        );
      } else if (joinStoryOrder === null) {
        notes.push(
          `the recruit instruction points at ${where(join.chapterIndex)}, which the ` +
            "main path never reaches - the story position is unknown, not late.",
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
            "no title (an unused slot or a world-map encounter map) - treat this " +
            "join chapter as unreliable.",
        );
      }
      rows.push({
        ...described(id),
        /**
         * 1-based play position of the join chapter, or `null` when the main path
         * does not reach it. **This is the ordering key** - `joinChapter` is a
         * map-table row and `joinChapterNumber` restarts every act.
         */
        joinStoryOrder,
        /** Earliest chapter with a placement or a `LOAD1` ("仲間にする") instruction. */
        joinChapter: join?.chapterIndex ?? null,
        /** The game's own number for `joinChapter`. Display only - see `storyOrder`. */
        joinChapterNumber: joinRecord?.chapterNumber ?? null,
        joinChapterTitle: joinRecord?.title ?? null,
        /** How `joinChapter` relates to the path: main / side / offPath / padded. */
        joinChapterPlaysAs:
          join?.chapterIndex === undefined || join.chapterIndex === null
            ? null
            : playsAsOf(join.chapterIndex),
        /** False when `joinChapter` is an unused slot, a skirmish map or a bonus map. */
        joinChapterIsStory: joinIsStory,
        joinSource: join?.source ?? null,
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
          storyOrder: orderOf(f.chapterIndex),
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
        earliestEvidenceStoryOrder: orderOf(earliestChapter),
        earliestEvidenceChapter: earliestChapter,
        earliestEvidenceChapterNumber: chapterOf(earliestChapter)?.chapterNumber ?? null,
        earliestEvidenceChapterTitle: titleOf(earliestChapter),
        earliestEvidenceSource: earliestSource,
        ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
      });
    }
    rows.sort(
      (a, b) =>
        ((a.joinStoryOrder as number | null) ?? Number.MAX_SAFE_INTEGER) -
          ((b.joinStoryOrder as number | null) ?? Number.MAX_SAFE_INTEGER) ||
        ((a.joinChapter as number | null) ?? Number.MAX_SAFE_INTEGER) -
          ((b.joinChapter as number | null) ?? Number.MAX_SAFE_INTEGER) ||
        (a.id as number) - (b.id as number),
    );

    return {
      /**
       * The spine: the sequence of maps a playthrough sees, from each chapter's
       * END_EVENT transitions. Everything else in this payload is ordered by the
       * position it gives.
       */
      playOrder: {
        /** Rows in the order, playable and not. */
        length: play.steps.length,
        /** Rows that are actual maps - the chapter count. */
        playable: play.steps.filter((s) => s.playable).length,
        /** Side chapters spliced in at a branch. */
        sideChapters: play.steps.filter((s) => s.role === "side").length,
        /** The no-detour path, which is `playOrder.length - sideChapters`. */
        mainPathLength: play.mainPath.length,
        /**
         * How the opening chapter was chosen, so the chain is not a black box.
         * Vision Quest has four maps numbered 1 because its four acts each open
         * at chapter 1; the first in map-table order is the real one.
         */
        startReason: play.startReason,
        startCandidates: play.startCandidates,
        endOfChain: {
          lastMap: play.mainPath.at(-1) ?? null,
          lastTitle:
            (play.mainPath.at(-1) ?? -1) === -1 ? "" : label(play.mainPath.at(-1) as number),
          /** Maps the walk re-entered, i.e. it stopped because it looped. */
          closedLoop: play.closedLoop.map((m) => ({ mapIndex: m, title: label(m) })),
        },
        /** Every map in play order. `filter(playable)` is the chapter list. */
        sequence: play.steps.map((s) => ({
          order: s.order,
          mapIndex: s.mapIndex,
          role: s.role,
          playable: s.playable,
          chapterNumber: byMap.get(s.mapIndex)?.chapterNumber ?? 0,
          title: byMap.get(s.mapIndex)?.title ?? "",
        })),
      },
      /**
       * Where the path forks: a map whose END_EVENT names more than one next
       * chapter. The first destination is the one the main path follows; the
       * others are already placed in `playOrder.sequence` at this point.
       */
      branches: play.branches.map((b) => ({
        mapIndex: b.mapIndex,
        title: label(b.mapIndex),
        to: b.to.map((m, i) => ({
          mapIndex: m,
          title: label(m),
          /** Position in `playOrder.sequence`. */
          storyOrder: orderOf(m),
          followedByMainPath: i === 0,
        })),
        /** `LOMA` targets from the same map: in-chapter teleports, not chapters. */
        viaLoma: b.viaLoma.map((m) => ({ mapIndex: m, title: label(m) })),
      })),
      /**
       * Real maps the main path never reaches - bonus maps, skirmish maps and
       * maps entered from a menu rather than from a chapter transition. A unit
       * whose join evidence points at one has no play position.
       */
      offPath: [...realMaps]
        .filter((m) => !position.has(m))
        .sort((a, b) => a - b)
        .map((m) => ({
          mapIndex: m,
          chapterNumber: byMap.get(m)?.chapterNumber ?? 0,
          title: byMap.get(m)?.title ?? "",
          deploySlots: byMap.get(m)?.deploySlots ?? 0,
          goesTo: [...new Set((edgesByMap.get(m)?.transitions ?? []).map((t) => t.targetMap))],
        })),
      /**
       * Rows that register an existing battle a second time. Vision Quest: 60
       * real maps, and 14 rows that all duplicate map 56's battle.
       */
      mapRows: {
        total: rom.chapters.length,
        real: realMaps.size,
        padded: rom.chapters.length - realMaps.size,
        duplicateRegistrations: duplicateRegistrations(rom.rom, rom.chapters),
      },
      source: {
        configDir: rom.configDir,
        eventOpcodeTable: rom.eventScripts.source,
        eventOpcodes: rom.eventScripts.scripts.length,
      },
      mapSettings:
        rom.mapSettings === null
          ? null
          : {
              recordSize: rom.mapSettings.recordSize,
              count: rom.mapSettings.count,
              countSource: rom.mapSettings.countSource,
              countNote:
                rom.mapSettings.countSource === "structural"
                  ? "The reference terminator test (u32(+0) must not be a pointer) " +
                    "rejected every record, so the table was scanned on structure."
                  : "Counted with the reference terminator test.",
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
          storyOrder: orderOf(f.mapIndex === MAP_ANY ? null : f.mapIndex),
          chapterNumber:
            f.mapIndex === MAP_ANY ? null : (chapterOf(f.mapIndex)?.chapterNumber ?? null),
          chapterTitle: f.mapIndex === MAP_ANY ? null : (chapterOf(f.mapIndex)?.title ?? null),
          routeFilter: f.route,
          routeFilterLabel: routeLabel(f.route),
        })),
        limitations: [
          "The route byte is compared by the game against a RUNTIME value " +
            "(ChapterData + 0x1B), so it cannot be resolved statically. Records " +
            "are reported regardless of it; check routeFilter when it is not 0xFF.",
          "A unit absent from this table is not necessarily benchable - the lord " +
            "is force-deployed by a separate rule the table does not describe.",
          "A record with mapIndex 0xFF applies to every map. Those records are " +
            "listed once in forcedDeployment.everyMap rather than repeated on " +
            "every chapter, so a chapter's forcedUnits holds only its own maps' " +
            'records - union the two to answer "who can I not bench here".',
        ],
      },
      stats: {
        /** Rows in the map-setting table, not the number of story chapters. */
        mapSettingRecords: rom.chapters.length,
        /** Rows in the play order that are actual maps. */
        chaptersInPlayOrder: play.steps.filter((s) => s.playable).length,
        /** Real maps the main path does not reach. */
        offPathRealMaps: realMaps.size - [...realMaps].filter((m) => position.has(m)).length,
        /** Rows that carry a non-zero chapter number (`+0x80 / 2`). */
        chaptersWithNumber: rom.chapters.filter((c) => c.chapterNumber > 0).length,
        /** Highest chapter number in the table - which restarts every act. */
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
       * One row per map, **in play order**. Padded rows are dropped unless
       * `--all`: the map table has a row per map *slot*, and those rows carry no
       * roster, no events and no title. `offPath` maps sort after every placed
       * one, and `--all` appends the padded rows at the end.
       */
      chapters: chapterRows
        .filter((c) => flags.all || !c.isPaddedRow)
        .sort(
          (a, b) =>
            (a.storyOrder ?? Number.MAX_SAFE_INTEGER) - (b.storyOrder ?? Number.MAX_SAFE_INTEGER) ||
            a.mapIndex - b.mapIndex,
        ),
      limitations: [
        "Order on `storyOrder`. `chapterNumber` is the number the prep screen " +
          "shows and it restarts at 1 in every act, so consecutive numbers are " +
          "not consecutive chapters: Vision Quest's path runs 16, 41, 42, 17. " +
          "`mapIndex` is a row number in the map-setting table and counts " +
          "unused slots and bonus maps too.",
        "A transition says where a chapter CAN go. Which branch a playthrough " +
          "takes depends on flag conditions inside the branch, which this does " +
          "not walk - so a side chapter's position is where the branch puts it, " +
          "not proof that every playthrough sees it there.",
        "Transitions reached through CALL live in a shared helper event, so they " +
          "fire for every chapter that calls it. The per-map attribution is " +
          "correct but the helper may also run mid-chapter.",
        "A map whose END_EVENT names itself is read as a self-loop and ignored " +
          "when ordering; Dream of Five's map 18 does this before naming the " +
          "chapter it actually leads to.",
        "A placement record counts as the named character only when its class id " +
          "is 0 or matches the unit's own class. Hack authors reuse one unit id " +
          "as a generic template with varying class ids; those records are " +
          "reported with `overridden` in `roster` and excluded from join order.",
        "Script walks stop after ten consecutive unrecognised opcodes, matching " +
          "FEBuilderGBA. truncatedScriptWalks counts those. A recruit site after " +
          "such a stop is missed.",
        "LOAD2 (412C) and LOAD3 (422C) do not recruit; they appear in " +
          "earliestEvidenceChapter only. A LOAD2 loads units that are already in " +
          "the party, so when it predates the joinChapter the real join is " +
          "probably earlier - such rows carry a `note`.",
        'Hack chapters often share one "load the whole party" script between ' +
          "several maps, so a LOAD1 seen in a late chapter is usually a re-load, " +
          "not a join.",
        "Deduplication is **per chapter**, never across chapters. One script can " +
          "be referenced by many maps, so the same `address` in goldEvents / " +
          "itemsGiven reappears under every chapter that reaches it. Deduplicate " +
          "by address before summing: a single 5,000-gold script shared by 17 " +
          "maps is one payout, not 85,000 gold.",
        '`midChapterRecruits` keeps only `kind: "recruit"` sites (LOAD1) and ' +
          "only the playable roster. LOAD2/LOAD3 load units that are already in " +
          "the party, and the underlying scan sees every placement including " +
          "enemy ones - in a hack that reuses ids that is several times the " +
          "character count and the bulk of the block.",
      ],
    };
  },
};
