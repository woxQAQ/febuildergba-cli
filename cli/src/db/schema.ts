/**
 * The extract database schema, as drizzle table definitions.
 *
 * These definitions are the **single source of truth**: `ddl.ts` generates
 * the CREATE TABLE statements from them, `populate.ts` inserts through them,
 * and query-side consumers (`scripts/emit-mgba-units.ts`) select through
 * them. There is no hand-written SQL copy of the schema to drift away from.
 *
 * One principle decides the shape: **store facts, derive at query time**.
 * Everything the old JSON commands computed by joining tables in memory -
 * class names on unit rows, shop prices, buy/sell prices, promotion direction
 * - is a SQL join or expression away, so none of it is a column here. What is
 * stored is what the ROM (or the config/data tables) actually says, plus the
 * derived facts SQL cannot reproduce on its own (play order, joins, enemy
 * projections - these come from walking event scripts).
 *
 * Conventions:
 *
 *   - Booleans use `integer({ mode: "boolean" })` (stored 0/1).
 *   - Bulky leaf detail that never joins (raw ability bytes, condition-slot
 *     pointers, placement item lists) is a `text({ mode: "json" })` column.
 *   - Ids are the game's own: unit ids are 1-based, class ids 0-based,
 *     `map_index` is the map-setting table row, **not** the chapter number.
 *     Primary keys are those natural ids; a duplicate id means corrupt data
 *     and fails the extract loudly instead of needing a surrogate key.
 *   - Support bonuses are stored as the ROM's half-points (`*_half` columns);
 *     the applied bonus at rank C/B/A is `half * 1/2/3` (see
 *     `tables/supportBonus.ts`).
 *   - Prices: `buy = items.uses * items.unit_price`, `sell = buy / 2`;
 *     a shop row charges `shop_items.effective_uses * items.unit_price`.
 *
 * The roster the old `units` command emitted by default (units carrying
 * support data) survives as the `roster` view - filtering is a query-time
 * decision now. Empty unit slots (no name, class or level) are **not**
 * extracted at all: they carry no data and their id 0 is not unique. Their
 * count is recorded in `meta` as `units.emptySlots`.
 */

import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { foreignKey } from "drizzle-orm/sqlite-core";

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const units = sqliteTable("units", {
  /** Game unit id, 1-based. Unique per ROM; support/placement data keys on it. */
  id: integer("id").primaryKey(),
  /** File offset of the 52-byte record. */
  address: integer("address").notNull(),
  /** Display name: decoded, control bytes and `@XXXX` escapes stripped. */
  name: text("name").notNull(),
  /** Decoded name with `@XXXX` escapes intact. */
  nameRaw: text("name_raw").notNull(),
  nameTextId: integer("name_text_id").notNull(),
  description: text("description").notNull(),
  descTextId: integer("desc_text_id").notNull(),
  classId: integer("class_id").notNull(),
  /** True when this class is the promoted half of a base/promoted pair. */
  isPromotedClass: integer("is_promoted_class", { mode: "boolean" }).notNull(),
  mapFaceId: integer("map_face_id").notNull(),
  portraitId: integer("portrait_id").notNull(),
  /** Support affinity id; 0 = none. Names join through `affinities`. */
  affinityId: integer("affinity_id").notNull(),
  sortOrder: integer("sort_order").notNull(),
  level: integer("level").notNull(),

  // Per-unit SIGNED deltas on the class base, not final stats.
  // starting stat = classes.base_* + units.delta_*; luck has no class base.
  deltaHp: integer("delta_hp").notNull(),
  deltaStr: integer("delta_str").notNull(),
  deltaSkl: integer("delta_skl").notNull(),
  deltaSpd: integer("delta_spd").notNull(),
  deltaDef: integer("delta_def").notNull(),
  deltaRes: integer("delta_res").notNull(),
  deltaLck: integer("delta_lck").notNull(),
  deltaCon: integer("delta_con").notNull(),

  growthHp: integer("growth_hp").notNull(),
  growthStr: integer("growth_str").notNull(),
  growthSkl: integer("growth_skl").notNull(),
  growthSpd: integer("growth_spd").notNull(),
  growthDef: integer("growth_def").notNull(),
  growthRes: integer("growth_res").notNull(),
  growthLck: integer("growth_lck").notNull(),
  growthTotal: integer("growth_total").notNull(),

  // Weapon experience per weapon type, ROM order.
  wlSword: integer("wl_sword").notNull(),
  wlLance: integer("wl_lance").notNull(),
  wlAxe: integer("wl_axe").notNull(),
  wlBow: integer("wl_bow").notNull(),
  wlStaff: integer("wl_staff").notNull(),
  wlAnima: integer("wl_anima").notNull(),
  wlLight: integer("wl_light").notNull(),
  wlDark: integer("wl_dark").notNull(),

  /** Raw ability bytes at +40..+43. */
  abilityFlags: text("ability_flags", { mode: "json" })
    .$type<[number, number, number, number]>()
    .notNull(),
  /** Raw pointer value stored at +44. */
  supportPointer: integer("support_pointer").notNull(),
  /** File offset the support pointer resolves to; 0 when unset/invalid. */
  supportAddress: integer("support_address").notNull(),
  hasSupportData: integer("has_support_data", { mode: "boolean" }).notNull(),
});

export const classes = sqliteTable("classes", {
  /** Class id, 0-based. Id 0 is the reserved empty entry (kept, is_empty = 1). */
  id: integer("id").primaryKey(),
  address: integer("address").notNull(),
  name: text("name").notNull(),
  nameTextId: integer("name_text_id").notNull(),
  description: text("description").notNull(),
  /**
   * REVERSE link: the class this one is promoted FROM, despite the name.
   * Resolve direction via `sort_order` (the promoted side sorts higher) -
   * see tables/classes.ts.
   */
  promotesToClassId: integer("promotes_to_class_id").notNull(),
  /** Promotion tier; each base/promoted pair shares one value. */
  sortOrder: integer("sort_order").notNull(),
  movementRange: integer("movement_range").notNull(),
  movementSpeed: integer("movement_speed").notNull(),

  baseHp: integer("base_hp").notNull(),
  baseStr: integer("base_str").notNull(),
  baseSkl: integer("base_skl").notNull(),
  baseSpd: integer("base_spd").notNull(),
  baseDef: integer("base_def").notNull(),
  baseRes: integer("base_res").notNull(),
  baseCon: integer("base_con").notNull(),

  capHp: integer("cap_hp").notNull(),
  capStr: integer("cap_str").notNull(),
  capSkl: integer("cap_skl").notNull(),
  capSpd: integer("cap_spd").notNull(),
  capDef: integer("cap_def").notNull(),
  capRes: integer("cap_res").notNull(),
  capCon: integer("cap_con").notNull(),

  enemyGrowthHp: integer("enemy_growth_hp").notNull(),
  enemyGrowthStr: integer("enemy_growth_str").notNull(),
  enemyGrowthSkl: integer("enemy_growth_skl").notNull(),
  enemyGrowthSpd: integer("enemy_growth_spd").notNull(),
  enemyGrowthDef: integer("enemy_growth_def").notNull(),
  enemyGrowthRes: integer("enemy_growth_res").notNull(),
  enemyGrowthLck: integer("enemy_growth_lck").notNull(),

  /** Stat gains applied on promotion; the ROM has no luck bonus. */
  promoHp: integer("promo_hp").notNull(),
  promoStr: integer("promo_str").notNull(),
  promoSkl: integer("promo_skl").notNull(),
  promoSpd: integer("promo_spd").notNull(),
  promoDef: integer("promo_def").notNull(),
  promoRes: integer("promo_res").notNull(),

  wlSword: integer("wl_sword").notNull(),
  wlLance: integer("wl_lance").notNull(),
  wlAxe: integer("wl_axe").notNull(),
  wlBow: integer("wl_bow").notNull(),
  wlStaff: integer("wl_staff").notNull(),
  wlAnima: integer("wl_anima").notNull(),
  wlLight: integer("wl_light").notNull(),
  wlDark: integer("wl_dark").notNull(),

  /** Raw ability bytes at +40..+43; names join through `class_ability_flags`. */
  abilityFlags: text("ability_flags", { mode: "json" })
    .$type<[number, number, number, number]>()
    .notNull(),
  /** Mount category from the icon flags; NULL for foot units. */
  mount: text("mount", { enum: ["wyvern", "pegasus", "horse", "armour"] }),
  /** Utility role from the action flags; NULL otherwise. */
  specialAction: text("special_action", { enum: ["dancer", "bard", "thief"] }),
  /** Cost-table signature of a flier; a cross-check, not the source of truth. */
  flying: integer("flying", { mode: "boolean" }).notNull(),
  /** True when the class gets no terrain bonus on any terrain. */
  terrainBonusImmune: integer("terrain_bonus_immune", { mode: "boolean" }).notNull(),
  isEmpty: integer("is_empty", { mode: "boolean" }).notNull(),
});

/** Ability-bit names from config/data; empty when that directory was missing. */
export const classAbilityFlags = sqliteTable(
  "class_ability_flags",
  {
    classId: integer("class_id").notNull(),
    flag: text("flag").notNull(),
  },
  (t) => [primaryKey({ columns: [t.classId, t.flag] })],
);

/** 65 rows per class, indexed by terrain id; cost 0xFF = impassable. */
export const classMovementCosts = sqliteTable(
  "class_movement_costs",
  {
    classId: integer("class_id").notNull(),
    terrainId: integer("terrain_id").notNull(),
    cost: integer("cost").notNull(),
  },
  (t) => [primaryKey({ columns: [t.classId, t.terrainId] })],
);

export const classTerrainBonuses = sqliteTable(
  "class_terrain_bonuses",
  {
    classId: integer("class_id").notNull(),
    terrainId: integer("terrain_id").notNull(),
    avoid: integer("avoid").notNull(),
    def: integer("def").notNull(),
    res: integer("res").notNull(),
  },
  (t) => [primaryKey({ columns: [t.classId, t.terrainId] })],
);

/**
 * Derived mobility profile; SQL cannot reproduce it (it needs the
 * infantry-baseline comparison across the whole class table). `movement`,
 * `mount` and `special_action` live on `classes`.
 */
export const classRoles = sqliteTable("class_roles", {
  classId: integer("class_id").primaryKey(),
  mobility: text("mobility", { enum: ["flying", "mounted", "armour", "normal"] }).notNull(),
  /** "flags" when the ROM stated it, "costs" when we inferred it. */
  mobilitySource: text("mobility_source", { enum: ["flags", "costs"] }).notNull(),
  /** Weapon types this class can use, in ROM order. */
  weapons: text("weapons", { mode: "json" }).$type<string[]>().notNull(),
  hasStaff: integer("has_staff", { mode: "boolean" }).notNull(),
  isMagic: integer("is_magic", { mode: "boolean" }).notNull(),
});

export const terrains = sqliteTable("terrains", {
  /** Terrain id 0..0x40; also the movement-cost index space. */
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  textId: integer("text_id"),
  nameAddress: integer("name_address"),
  decoded: integer("decoded", { mode: "boolean" }).notNull(),
  /** Raw bytes, for the undecoded case. */
  raw: text("raw", { mode: "json" }).$type<number[]>().notNull(),
});

/** Affinity names decoded from the ROM's own text table. */
export const affinities = sqliteTable("affinities", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const supportBonuses = sqliteTable("support_bonuses", {
  affinityId: integer("affinity_id").primaryKey(),
  atkHalf: integer("atk_half").notNull(),
  defHalf: integer("def_half").notNull(),
  hitHalf: integer("hit_half").notNull(),
  avoidHalf: integer("avoid_half").notNull(),
  critHalf: integer("crit_half").notNull(),
  critAvoidHalf: integer("crit_avoid_half").notNull(),
});

/** Per-unit support record diagnostics (declared vs actual partner count). */
export const supportEntries = sqliteTable("support_entries", {
  unitId: integer("unit_id").primaryKey(),
  address: integer("address").notNull(),
  declaredCount: integer("declared_count").notNull(),
  actualCount: integer("actual_count").notNull(),
});

/** Raw, asymmetric: one row per direction as the ROM records it. */
export const supportPartners = sqliteTable(
  "support_partners",
  {
    unitId: integer("unit_id").notNull(),
    partnerId: integer("partner_id").notNull(),
    /** Support points the pair starts with. */
    initial: integer("initial").notNull(),
    /** Support points gained per adjacent turn. */
    growth: integer("growth").notNull(),
  },
  (t) => [primaryKey({ columns: [t.unitId, t.partnerId] })],
);

/** Deduplicated: a < b, one row per pair. */
export const supportEdges = sqliteTable(
  "support_edges",
  {
    a: integer("a").notNull(),
    b: integer("b").notNull(),
    initial: integer("initial").notNull(),
    growth: integer("growth").notNull(),
  },
  (t) => [primaryKey({ columns: [t.a, t.b] })],
);

export const items = sqliteTable("items", {
  id: integer("id").primaryKey(),
  address: integer("address").notNull(),
  /** Decoded via the item-font path; see tables/items.ts. */
  name: text("name").notNull(),
  /** As the plain text decoder renders it (diagnostic). */
  nameRaw: text("name_raw").notNull(),
  nameTextId: integer("name_text_id").notNull(),
  descTextId: integer("desc_text_id").notNull(),
  useDescTextId: integer("use_desc_text_id").notNull(),
  /** Storage format of the name string. */
  nameKind: text("name_kind", { enum: ["huffman", "unhuffman", "direct", "invalid"] }).notNull(),
  /** Codes the item-font table has no mapping for; should stay []. */
  nameUnknownCodes: text("name_unknown_codes", { mode: "json" }).$type<number[]>().notNull(),
  description: text("description").notNull(),
  type: integer("type").notNull(),
  typeName: text("type_name").notNull(),
  /** Raw ability bytes at +8..+11. */
  attributes: text("attributes", { mode: "json" }).$type<number[]>().notNull(),
  statBonusPointer: integer("stat_bonus_pointer").notNull(),
  effectivenessPointer: integer("effectiveness_pointer").notNull(),
  uses: integer("uses").notNull(),
  might: integer("might").notNull(),
  hit: integer("hit").notNull(),
  weight: integer("weight").notNull(),
  crit: integer("crit").notNull(),
  rangeMin: integer("range_min").notNull(),
  rangeMax: integer("range_max").notNull(),
  weaponRank: integer("weapon_rank").notNull(),
  iconId: integer("icon_id").notNull(),
  staffEffect: integer("staff_effect").notNull(),
  damageBonus: integer("damage_bonus").notNull(),
  wexp: integer("wexp").notNull(),
  /** Price per use; buy = uses * unit_price, sell = buy / 2. */
  unitPrice: integer("unit_price").notNull(),
  isWeapon: integer("is_weapon", { mode: "boolean" }).notNull(),
});

export const shops = sqliteTable("shops", {
  id: integer("id").primaryKey(),
  kind: text("kind", { enum: ["weapon", "item", "secret", "prep"] }).notNull(),
  label: text("label").notNull(),
  address: integer("address").notNull(),
  /** NULL for the prep shop. */
  mapIndex: integer("map_index"),
  chapterNumber: real("chapter_number"),
  chapterTitle: text("chapter_title"),
});

export const shopItems = sqliteTable(
  "shop_items",
  {
    shopId: integer("shop_id").notNull(),
    /** Order in the shop's list. */
    position: integer("position").notNull(),
    itemId: integer("item_id").notNull(),
    /** Durability the shop sells at; 0 = full. */
    uses: integer("uses").notNull(),
    /** The durability actually received; price = effective_uses * unit_price. */
    effectiveUses: integer("effective_uses").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shopId, t.position] }),
    foreignKey({ columns: [t.shopId], foreignColumns: [shops.id] }),
  ],
);

export const chapters = sqliteTable("chapters", {
  /** Map-setting table row. NOT the chapter number. */
  mapIndex: integer("map_index").primaryKey(),
  mapSettingAddr: integer("map_setting_addr").notNull(),
  /** Prep-screen number; gaiden chapters use half steps (8.5). */
  chapterNumber: real("chapter_number").notNull(),
  /** The doubled raw field. */
  chapterNumberRaw: integer("chapter_number_raw").notNull(),
  titleTextId: integer("title_text_id").notNull(),
  title: text("title").notNull(),
  eventPlist: integer("event_plist").notNull(),
  condTableAddr: integer("cond_table_addr").notNull(),
  /** The 20 raw condition-slot pointer values. */
  condPointers: text("cond_pointers", { mode: "json" }).$type<number[]>().notNull(),
  playerPlacementAddr: integer("player_placement_addr").notNull(),
  hardPlacementAddr: integer("hard_placement_addr").notNull(),
  startEventAddr: integer("start_event_addr").notNull(),
  endEventAddr: integer("end_event_addr").notNull(),
  /** Deployment slot count, normal mode. */
  deploySlots: integer("deploy_slots").notNull(),
  deploySlotsHard: integer("deploy_slots_hard").notNull(),
});

/** Player/enemy/ally placements, both modes. class_id 0 = the unit's own class. */
export const chapterPlacements = sqliteTable(
  "chapter_placements",
  {
    mapIndex: integer("map_index").notNull(),
    mode: text("mode", { enum: ["normal", "hard"] }).notNull(),
    /** Row number within the placement block. */
    position: integer("position").notNull(),
    address: integer("address").notNull(),
    unitId: integer("unit_id").notNull(),
    classId: integer("class_id").notNull(),
    commander: integer("commander").notNull(),
    level: integer("level").notNull(),
    /** Raw +3 byte, the only place allegiance is recorded. */
    unitGrow: integer("unit_grow").notNull(),
    assign: integer("assign").notNull(),
    side: text("side", { enum: ["player", "ally", "enemy", "removed"] }).notNull(),
    autolevel: integer("autolevel", { mode: "boolean" }).notNull(),
    /** Pre-placement (staging) coordinate. */
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    ext: integer("ext"),
    positionRaw: integer("position_raw").notNull(),
    postPlacementCount: integer("post_placement_count").notNull(),
    postPlacementAddr: integer("post_placement_addr").notNull(),
    /** Starting items, +12..+15. */
    items: text("items", { mode: "json" }).$type<number[]>().notNull(),
  },
  (t) => [foreignKey({ columns: [t.mapIndex], foreignColumns: [chapters.mapIndex] })],
);

/** END_EVENT walk results, one row per chapter. */
export const chapterEndEvents = sqliteTable("chapter_end_events", {
  mapIndex: integer("map_index").primaryKey(),
  endEventAddress: integer("end_event_address").notNull(),
  instructionsDecoded: integer("instructions_decoded").notNull(),
  /** Why the walk stopped - a table that ran out is not a chapter with no exit. */
  stopReason: text("stop_reason").notNull(),
});

export const chapterTransitions = sqliteTable("chapter_transitions", {
  mapIndex: integer("map_index").notNull(),
  /** Destination: a map-setting index, not a chapter number. */
  targetMap: integer("target_map").notNull(),
  opcode: text("opcode").notNull(),
  scriptAddress: integer("script_address").notNull(),
  /** > 0 means reached via a shared CALL helper. */
  callDepth: integer("call_depth").notNull(),
});

/**
 * The order chapters are actually played in. THIS, not chapter_number,
 * orders the game; see tables/storyPath.ts.
 */
export const playOrder = sqliteTable("play_order", {
  mapIndex: integer("map_index").primaryKey(),
  /** 1-based position, no gaps. */
  position: integer("position").notNull(),
  /** main = no-detour path; side = spliced in at a branch. */
  role: text("role", { enum: ["main", "side"] }).notNull(),
  playable: integer("playable", { mode: "boolean" }).notNull(),
});

/**
 * Earliest chapter per unit, from placements and LOAD1 instructions.
 * kind: "join" = in the player's army; "appearance" = any load, incl. guests.
 */
export const unitJoins = sqliteTable(
  "unit_joins",
  {
    unitId: integer("unit_id").notNull(),
    kind: text("kind", { enum: ["join", "appearance"] }).notNull(),
    mapIndex: integer("map_index").notNull(),
    /** play_order.position; NULL when the map is off every known path. */
    storyOrder: integer("story_order"),
    source: text("source", { enum: ["placement", "recruit", "load", "cutscene"] }).notNull(),
    evidenceAddr: integer("evidence_addr").notNull(),
    classOverridden: integer("class_overridden", { mode: "boolean" }).notNull(),
    placedClassId: integer("placed_class_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.unitId, t.kind] }),
    foreignKey({ columns: [t.mapIndex], foreignColumns: [chapters.mapIndex] }),
  ],
);

export const mapObjects = sqliteTable("map_objects", {
  mapIndex: integer("map_index").notNull(),
  address: integer("address").notNull(),
  type: integer("type").notNull(),
  kind: text("kind").notNull(),
  /** Achievement flag; 0 = repeatable. */
  flag: integer("flag").notNull(),
  objectType: integer("object_type").notNull(),
  objectTypeName: text("object_type_name").notNull(),
  x: integer("x").notNull(),
  y: integer("y").notNull(),
  /** Chest only. */
  itemId: integer("item_id"),
  /** Chest only. */
  gold: integer("gold").notNull(),
  isGoldChest: integer("is_gold_chest", { mode: "boolean" }).notNull(),
  eventAddr: integer("event_addr").notNull(),
  shopAddr: integer("shop_addr").notNull(),
});

/** 必ず出撃: units the chapter forces into the deployment. */
export const forceSortie = sqliteTable("force_sortie", {
  idx: integer("idx").primaryKey(),
  address: integer("address").notNull(),
  unitId: integer("unit_id").notNull(),
  /** 0xFF = any route. */
  route: integer("route").notNull(),
  /** 0xFF = any map. */
  mapIndex: integer("map_index").notNull(),
});

/** Condition-slot names from config/data; empty when that directory was missing. */
export const condSlots = sqliteTable("cond_slots", {
  idx: integer("idx").primaryKey(),
  flag: text("flag").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
});

/** Event-script walk hits, per chapter. */
export const chapterRecruits = sqliteTable("chapter_recruits", {
  mapIndex: integer("map_index").notNull(),
  /** Address of the LOAD* instruction. */
  address: integer("address").notNull(),
  /** Condition slot the walk started from; -1 for a direct placement block. */
  slotIndex: integer("slot_index").notNull(),
  slotKind: text("slot_kind").notNull(),
  /** The opcode pattern, for diagnostics. */
  instruction: text("instruction").notNull(),
  kind: text("kind").notNull(),
  blockAddr: integer("block_addr").notNull(),
  /** Unit ids named in the block. */
  unitIds: text("unit_ids", { mode: "json" }).$type<number[]>().notNull(),
});

export const chapterGold = sqliteTable("chapter_gold", {
  mapIndex: integer("map_index").notNull(),
  address: integer("address").notNull(),
  /** Signed: gain or lose. */
  delta: integer("delta").notNull(),
  instruction: text("instruction").notNull(),
});

export const chapterItemGives = sqliteTable("chapter_item_gives", {
  mapIndex: integer("map_index").notNull(),
  address: integer("address").notNull(),
  itemId: integer("item_id").notNull(),
  /** 0xFFFF = the unit currently acting. */
  unitId: integer("unit_id").notNull(),
  instruction: text("instruction").notNull(),
});

export const chapterScanStats = sqliteTable("chapter_scan_stats", {
  mapIndex: integer("map_index").primaryKey(),
  truncatedWalks: integer("truncated_walks").notNull(),
});

/**
 * One row per projected enemy placement record, per autolevel mode. "hard"
 * re-projects with the hard-mode autolevel round (19 levels instead of 9);
 * both modes are extracted so the choice is a WHERE clause, not a re-run.
 */
export const enemySamples = sqliteTable("enemy_samples", {
  mode: text("mode", { enum: ["normal", "hard"] }).notNull(),
  mapIndex: integer("map_index").notNull(),
  chapterNumber: real("chapter_number").notNull(),
  address: integer("address").notNull(),
  unitId: integer("unit_id").notNull(),
  classId: integer("class_id").notNull(),
  level: integer("level").notNull(),
  /** +3 bit 0: autolevel on/off. */
  grow: integer("grow", { mode: "boolean" }).notNull(),
  routine: text("routine", { enum: ["none", "unit", "realistic"] }).notNull(),
  promoted: integer("promoted", { mode: "boolean" }).notNull(),
  classBaseSpd: integer("class_base_spd").notNull(),
  /** Signed character-table speed delta. */
  unitSpdDelta: integer("unit_spd_delta").notNull(),
  // Projected speed as an RNG band:
  spdLo: integer("spd_lo").notNull(),
  spdHi: integer("spd_hi").notNull(),
  spdMean: real("spd_mean").notNull(),
  con: integer("con").notNull(),
  /** Heaviest weapon (worst case for the enemy). */
  weight: integer("weight").notNull(),
  /** First weapon (editor order). */
  weightFirst: integer("weight_first").notNull(),
  // Attack speed = spd - max(0, weight - con); signed on purpose:
  asLo: integer("as_lo").notNull(),
  asHi: integer("as_hi").notNull(),
  asMean: real("as_mean").notNull(),
});

/** Every data table, in insertion order. `roster` is a view, not in here. */
export const TABLES = [
  meta,
  units,
  classes,
  classAbilityFlags,
  classMovementCosts,
  classTerrainBonuses,
  classRoles,
  terrains,
  affinities,
  supportBonuses,
  supportEntries,
  supportPartners,
  supportEdges,
  items,
  shops,
  shopItems,
  chapters,
  chapterPlacements,
  chapterEndEvents,
  chapterTransitions,
  playOrder,
  unitJoins,
  mapObjects,
  forceSortie,
  condSlots,
  chapterRecruits,
  chapterGold,
  chapterItemGives,
  chapterScanStats,
  enemySamples,
] as const;
