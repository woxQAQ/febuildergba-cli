import { hex } from '../cli/hex.ts';
import {
  chapterRouteOf,
  duplicateRegistrations,
  isRealMap,
  readAllTransitions,
  traceStoryPath,
} from '../tables/storyPath.ts';
import type { Command } from './types.ts';

/**
 * Main-path order, recovered from each chapter's END_EVENT.
 *
 * Chapter numbers cannot answer this. `chapterNumber` is the number the prep
 * screen shows and it restarts at 1 in every act, so grouping by consecutive
 * chapter number invents boundaries that are not in the game: Vision Quest's
 * real path leaves chapter 5 and comes back at chapter 6 through two maps the
 * numbering never mentions.
 *
 * The transitions are what the ROM actually executes. Three views of them:
 *
 *   - `chain`      - the main path, in play order
 *   - `chapters`   - one row per map with its outgoing transitions
 *   - `branches`   - maps that lead to more than one destination, i.e. where a
 *                    gaiden chapter is spliced into the path
 *
 * The `limitations` field lists what this does not establish, because a
 * transition says where a chapter can go, not which branch a playthrough takes.
 */
export const storypath: Command = {
  name: 'storypath',
  summary: 'Main-path chapter order, from END_EVENT transition opcodes',
  description:
    'Follows each map\'s END_EVENT script and reports where it sends you. ' +
    '**Prefer this over `chapterNumber` for ordering**: the chapter number ' +
    'restarts at 1 in every act, so it cannot order chapters. `chain` is the ' +
    'no-detour path; `reachable` also includes the side chapters listed under ' +
    '`branches`. Padded map rows are excluded unless `--all`, and the raw ' +
    'instruction edges come only with `--all` too.',
  run: ({ rom, flags }) => {
    if (rom.eventScripts.scripts.length === 0) {
      return {
        available: false,
        reason:
          'the event-opcode table (config/data/event_<game>.txt) is missing, ' +
          'so END_EVENT scripts cannot be decoded',
        chapters: [],
        chain: [],
        branches: [],
        endOfChain: { lastMap: null, lastTitle: '', closedLoop: [] },
        startCandidates: [],
      };
    }

    const edges = readAllTransitions(rom.rom, rom.eventScripts, rom.chapters);
    const byMap = new Map(edges.map((e) => [e.mapIndex, e]));

    const rows = edges.map((e) => {
      const chapter = rom.chapters.find((c) => c.index === e.mapIndex);
      const real = chapter === undefined ? false : isRealMap(rom.rom, chapter);
      const route = chapter === undefined ? 0 : chapterRouteOf(rom.rom, chapter);
      const targets = [...new Set(e.transitions.map((t) => t.targetMap))];

      return {
        mapIndex: e.mapIndex,
        /**
         * The game's own chapter number. Shown for convenience; it restarts per
         * act and must not be used to order chapters.
         */
        chapterNumber: e.chapterNumber,
        title: e.title,
        /**
         * False for the rows that pad the map table out to its full length.
         * These are not playable and their transitions are copies.
         */
        isRealMap: real,
        /** `mapSetting + 0x0C`. `3` is the F part; see `tables/forceSortie.ts`. */
        chapterRoute: route,
        deploySlots: chapter?.deploySlots ?? 0,
        endEvent: e.endEventAddress === 0 ? null : hex(e.endEventAddress),
        /** Destination maps, in the order the script names them. */
        goesTo: targets,
        transitions: e.transitions.map((t) => ({
          opcode: t.opcode,
          targetMap: t.targetMap,
          at: hex(t.scriptAddress),
          /** > 0 means the instruction sits in a shared helper event. */
          callDepth: t.callDepth,
        })),
        instructionsDecoded: e.instructionsDecoded,
        /**
         * Why the walk ended. `"unrecognised opcode"` means the script was not
         * read to its end, so a missing transition there is not evidence of
         * anything.
         */
        stopReason: e.stopReason,
      };
    });

    const realMap = new Set(
      rom.chapters.filter((c) => isRealMap(rom.rom, c)).map((c) => c.index),
    );
    const path = traceStoryPath(edges, (m) => realMap.has(m));
    const name = (m: number): string => {
      const t = byMap.get(m)?.title ?? '';
      return t.length === 0 ? `(map ${m})` : t;
    };

    return {
      available: true,
      /**
       * Real maps, padded rows, and the rows that register an existing battle
       * a second time. Vision Quest: 60 real, 19 padded, and 14 rows that all
       * duplicate map 56's battle.
       */
      mapRows: {
        total: rom.chapters.length,
        real: rows.filter((r) => r.isRealMap).length,
        padded: rows.filter((r) => !r.isRealMap).length,
        duplicateRegistrations: duplicateRegistrations(rom.rom, rom.chapters),
      },
      /** How the first map was chosen, so the chain is not a black box. */
      startReason: path.startReason,
      /**
       * Every chapter numbered 1 that no real numbered chapter leads into. Vision
       * Quest has four because its four acts each open at chapter 1; the chain
       * starts at the first of them in map-table order.
       */
      startCandidates: path.startCandidates,
      /**
       * `chain` is the no-detour path, so a gaiden chapter spliced into the
       * middle of it is absent from `chain` and appears only under `branches`.
       * `reachable` is the union: every chapter the game can send you to.
       */
      reachable: path.reachable.map((m) => ({
        mapIndex: m,
        title: name(m),
        onChain: path.chain.some((c) => c.mapIndex === m),
      })),
      /** How many chapters the chain has, for comparison against `reachable`. */
      chainLength: path.chain.length,
      /** The main path in play order. */
      chain: path.chain.map((e, i) => ({
        order: i + 1,
        mapIndex: e.mapIndex,
        chapterNumber: e.chapterNumber,
        title: e.title,
        goesTo: [...new Set(e.transitions.map((t) => t.targetMap))],
      })),
      /**
       * Maps with more than one story-advancing destination: where the path
       * splices in a side chapter and comes back, or forks. The first is the
       * one `chain` followed. `viaLoma` lists the same map's `LOMA` targets,
       * which are in-chapter teleports rather than chapters.
       */
      branches: path.branches.map((b) => ({
        mapIndex: b.mapIndex,
        title: byMap.get(b.mapIndex)?.title ?? '',
        to: b.to.map((m, i) => ({
          mapIndex: m,
          title: name(m),
          followedByChain: i === 0,
        })),
        viaLoma: b.viaLoma.map((m) => ({ mapIndex: m, title: name(m) })),
      })),
      /**
       * Where the walk stopped, and why: a chapter with no advancing transition
       * ends the path; one that leads back into the chain closes a loop.
       */
      endOfChain: {
        lastMap: path.chain.at(-1)?.mapIndex ?? null,
        lastTitle: name(path.chain.at(-1)?.mapIndex ?? -1),
        /** Maps the walk re-entered, i.e. it stopped because it looped. */
        closedLoop: path.closedLoop.map((m) => ({ mapIndex: m, title: name(m) })),
      },
      /**
       * Per-map transition table: the resolved destination list for every real
       * map. `chain` and `branches` are derived from this, so it is the view to
       * read when the path looks wrong.
       *
       * `transitions` - the raw instruction edges with their addresses and call
       * depth - is the audit trail, and is only under `--all`: it makes a
       * missing edge distinguishable from an undecodable script, but nothing
       * consumes it when the path is already correct.
       */
      chapters: (flags.all ? rows : rows.filter((r) => r.isRealMap)).map((r) =>
        flags.all
          ? {
              mapIndex: r.mapIndex,
              chapterNumber: r.chapterNumber,
              title: r.title,
              goesTo: r.goesTo,
              transitions: r.transitions,
              decode: { instructions: r.instructionsDecoded, stoppedBecause: r.stopReason },
              isRealMap: r.isRealMap,
            }
          : {
              mapIndex: r.mapIndex,
              chapterNumber: r.chapterNumber,
              title: r.title,
              goesTo: r.goesTo,
              /** Omitted unless --all: a walk that fell off is not a dead end. */
              stoppedBecause: r.stopReason,
            },
      ),
      /**
       * Every map's transitions, including the padded rows, for auditing. The
       * instruction-level `transitions` are under `--all`.
       */
      limitations: [
        'A transition says where a chapter CAN go. Which branch a playthrough ' +
          'takes depends on flag conditions inside the branch, which this does ' +
          'not walk.',
        '`chain` is the path with no detours, so a chapter spliced into the ' +
          'middle of it is absent from `chain` and appears under `branches` and ' +
          '`reachable` instead. `reachable` is the full set the game can send ' +
          'you to.',
        'Transitions reached through CALL (callDepth > 0, under --all) live in a ' +
          'shared helper event, so they fire for every chapter that calls it. The ' +
          'per-map attribution is correct but the helper may also run mid-chapter.',
        'LOMA is reported in `viaLoma` and never treated as a chapter edge: the ' +
          'opcode also moves a battle around inside one map.',
        'Padded rows are excluded by default; pass --all to see them. Their ' +
          'transitions are copies of a real map and would otherwise invent ' +
          'chapters that do not exist.',
      ],
    };
  },
};