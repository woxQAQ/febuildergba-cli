import { hex } from '../cli/hex.ts';
import { affinityLabel } from './shared.ts';
import { SUPPORT_RANK_THRESHOLDS, SUPPORT_CONVERSATION_CAPS } from '../tables/supports.ts';
import { SUPPORT_BONUS_STATS, rankedBonus } from '../tables/supportBonus.ts';
import type { Command } from './types.ts';

export const info: Command = {
  name: 'info',
  summary: 'ROM identity, resolved table addresses, quick sanity counters',
  description:
    'What this ROM is and where every table was found. Start here when a later ' +
    'command reports a suspicious count: the addresses in this output are the ' +
    'ones the rest of the run read from.',
  run: ({ rom }) => {
    const playable = rom.units.filter((u) => !u.isEmpty);
    const classes = rom.classes.filter((c) => !c.isEmpty);
    const named = playable.filter((u) => u.name.length > 0).length;

    return {
      rom: {
        file: rom.path,
        sizeBytes: rom.rom.length,
        sizeHex: hex(rom.rom.length),
        gameCode: rom.identity.gameCode,
        title: rom.identity.title,
        version: rom.layout.version,
        displayName: rom.layout.displayName,
        isMultibyte: rom.layout.text.isMultibyte,
        notes: rom.identity.notes,
      },
      tables: {
        unit: {
          slot: hex(rom.unitTable.slotOffset),
          address: hex(rom.unitTable.tableOffset),
          recordSize: rom.unitTable.recordSize,
          declaredCount: rom.unitTable.maxCount,
          entriesRead: rom.units.length,
          nonEmpty: playable.length,
        },
        class: {
          slot: hex(rom.classTable.slotOffset),
          address: hex(rom.classTable.tableOffset),
          recordSize: rom.classTable.recordSize,
          entriesRead: rom.classes.length,
          nonEmpty: classes.length,
        },
        text: {
          huffmanTreeBase: hex(rom.text.treeBase),
          huffmanDataBase: hex(rom.text.treeDataBase),
          textTableBase: hex(rom.text.textBase),
          namesDecoded: `${named}/${playable.length}`,
        },
      },
      supports: {
        unitsWithSupportData: rom.supports.entries.length,
        edges: rom.supportGraph.length,
        unreadablePointers: rom.supports.missing.length,
        rankThresholds: SUPPORT_RANK_THRESHOLDS,
        conversationCaps: SUPPORT_CONVERSATION_CAPS,
        affinities: Object.fromEntries([...rom.affinityNames.entries()]),
        bonusTable: rom.supportBonuses.map((b) => ({
          affinity: b.affinity,
          name: affinityLabel(rom, b.affinity),
          storedHalfPoints: Object.fromEntries(
            SUPPORT_BONUS_STATS.map((s) => [s, b.bonuses[s]]),
          ),
          byRank: rankedBonus(b),
        })),
      },
      terrainNames: {
        table: rom.terrainNames.table?.tableOffset ?? null,
        recordSize: rom.terrainNames.table?.recordSize ?? null,
        count: rom.terrainNames.names.length,
        decoded: rom.terrainNames.names.filter((n) => n.decoded).length,
      },
    };
  },
};