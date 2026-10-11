/**
 * The extract database schema, as drizzle table definitions - the single source
 * of truth. `ddl.ts` generates CREATE TABLE from them, `populate.ts` inserts
 * through them, query-side consumers select through them; no hand-written SQL
 * copy to drift.
 *
 * Two shaping principles:
 *   - Model the game, not the ROM bytes: no file offsets, raw pointers or
 *     extraction diagnostics as columns. What a ROM address was needed to reach
 *     (stat-bonus tables, effectiveness lists, post-placement steps) is parsed
 *     and modelled.
 *   - Store facts, derive at query time: names join by id, prices are
 *     `uses * unit_price`, usability is `wl_* > 0`. Absence is NULL or a missing
 *     child row, never the ROM's zero-as-absence.
 *
 * Two physical layers, decreasing trust:
 *   1. Raw tables (plain names): mechanical decodes of ROM bytes or config/data
 *      files - records, lists, names. No inference.
 *   2. `derived_*` tables: inference SQL cannot express - currently only
 *      `derived_play_order` (branch splicing is a custom ordering). Materialized
 *      because the consumer cannot recompute it without ROM and parser; treat as
 *      a conclusion, not evidence.
 *
 * The derivations that used to be a third layer of db views (`roster`,
 * `support_edges`, the walk-based `chapter_transitions`, `chapter_recruits`,
 * `chapter_recruit_units`, `chapter_gold`, `chapter_item_gives`, `unit_joins`,
 * `class_roles`) are CLI commands over the parsed ROM now: `roster`,
 * `supports`, `transitions`, `recruits`, `gains`, `joins`, `roles`.
 *
 * Conventions:
 *   - Booleans use `integer({ mode: "boolean" })` (0/1).
 *   - Small non-joining lists (ability bytes, placement items, recruited ids)
 *     are `text({ mode: "json" })`; joining data (effectiveness, movement
 *     costs) is a child table.
 *   - Ids are the game's own: unit ids 1-based, class ids 0-based, `map_index`
 *     is the map-setting row, **not** the chapter number; those natural ids are
 *     the primary keys, so a duplicate fails the extract loudly rather than
 *     needing a surrogate.
 *   - Support bonuses are the ROM's half-points (`*_half`); applied bonus at
 *     rank C/B/A is `half * 1/2/3` (`tables/supportBonus.ts`).
 *
 * Empty unit slots (no name, class or level, non-unique id 0) are not
 * extracted; their count is `meta` `units.emptySlots`.
 */

import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { foreignKey } from "drizzle-orm/sqlite-core";

/** Provenance and run-level facts, as key/value pairs. */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const units = sqliteTable("units", {
  /** Game unit id, 1-based. Unique per ROM; support/placement data keys on it. */
  id: integer("id").primaryKey(),
  /** Display name: decoded, control bytes and `@XXXX` escapes stripped. */
  name: text("name").notNull(),
  /** Text id the name was decoded from; feed it to `fe-rom text` to see raw. */
  nameTextId: integer("name_text_id").notNull(),
  description: text("description").notNull(),
  descTextId: integer("desc_text_id").notNull(),
  classId: integer("class_id").notNull(),
  /** True when this unit's class is the promoted half of a base/promoted pair. */
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
  /** True when the unit's support pointer (+44) resolves to a record. */
  hasSupportData: integer("has_support_data", { mode: "boolean" }).notNull(),
});

export const classes = sqliteTable("classes", {
  /** Class id, 0-based. Id 0 is the reserved empty entry (kept, is_empty = 1). */
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  nameTextId: integer("name_text_id").notNull(),
  description: text("description").notNull(),
  /**
   * REVERSE link: the class this one is promoted FROM, despite the name.
   * Resolve direction via `sort_order` (promoted sorts higher) - see
   * tables/classes.ts.
   */
  promotesToClassId: integer("promotes_to_class_id").notNull(),
  /** Promotion tier; each base/promoted pair shares one value. */
  sortOrder: integer("sort_order").notNull(),
  movementRange: integer("movement_range").notNull(),
  movementSpeed: integer("movement_speed").notNull(),
  /** Class power (威力等级) of the exp formula; class record +26. */
  classPower: integer("class_power").notNull(),

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

/**
 * 65 rows per class per variant, indexed by terrain id; 0xFF = impassable.
 * `rain`/`snow` rows exist only for classes with a weather-specific table.
 */
export const classMovementCosts = sqliteTable(
  "class_movement_costs",
  {
    classId: integer("class_id").notNull(),
    variant: text("variant", { enum: ["normal", "rain", "snow"] }).notNull(),
    terrainId: integer("terrain_id").notNull(),
    cost: integer("cost").notNull(),
  },
  (t) => [primaryKey({ columns: [t.classId, t.variant, t.terrainId] })],
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

/** Mobility is the `class_roles` VIEW over classes.mount - see ddl.ts. */

/**
 * Skill-system tables; empty unless the ROM carries the FE8U `SkillSystem` patch
 * (`tables/skills.ts`). `meta.rom.skillSystem` records the family, and
 * `meta.skills.classSkillExtends` whether the learn-list level byte carries the
 * player/enemy/hard flags.
 */
export const skills = sqliteTable("skills", {
  /** Skill id 0..254; id 0 is the empty slot every name-less id reads as. */
  id: integer("id").primaryKey(),
  /** Text id from the ROM's `TEXT` table; 0 = no text. */
  nameTextId: integer("name_text_id").notNull(),
  /** Text before the first `:` - FEBuilderGBA's name rule. `""` when none. */
  name: text("name").notNull(),
  /**
   * Text after the first `:`, trimmed. The ROM's format is `Name:Description`;
   * this half says what the skill does. `""` when there is no colon.
   */
  description: text("description").notNull(),
  /** The full decoded string; the fallback when {@link name} is `""`. */
  text: text("text").notNull(),
});

/**
 * Innate skill per unit: one byte per id, so at most one; rows only for non-zero
 * ids.
 */
export const unitSkills = sqliteTable(
  "unit_skills",
  {
    unitId: integer("unit_id").notNull(),
    skillId: integer("skill_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.unitId] })],
);

/** Innate skill per class. Same one-byte table shape as {@link unitSkills}. */
export const classSkills = sqliteTable(
  "class_skills",
  {
    classId: integer("class_id").notNull(),
    skillId: integer("skill_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.classId] })],
);

/**
 * Skills a unit learns by levelling, from the per-unit pointer list. With the
 * class-skill extension the level byte's high bits gate side/difficulty;
 * without it they are always false and `level` is the whole byte. `raw_level` is
 * kept because `0xFF` sets all four flags at once in upstream's UI.
 */
export const unitSkillLearn = sqliteTable(
  "unit_skill_learn",
  {
    unitId: integer("unit_id").notNull(),
    position: integer("position").notNull(),
    level: integer("level").notNull(),
    skillId: integer("skill_id").notNull(),
    rawLevel: integer("raw_level").notNull(),
    playerOnly: integer("player_only", { mode: "boolean" }).notNull(),
    enemyOnly: integer("enemy_only", { mode: "boolean" }).notNull(),
    bothSides: integer("both_sides", { mode: "boolean" }).notNull(),
    hardOnly: integer("hard_only", { mode: "boolean" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.unitId, t.position] })],
);

/** Skills a class learns by levelling. Same shape as {@link unitSkillLearn}. */
export const classSkillLearn = sqliteTable(
  "class_skill_learn",
  {
    classId: integer("class_id").notNull(),
    position: integer("position").notNull(),
    level: integer("level").notNull(),
    skillId: integer("skill_id").notNull(),
    rawLevel: integer("raw_level").notNull(),
    playerOnly: integer("player_only", { mode: "boolean" }).notNull(),
    enemyOnly: integer("enemy_only", { mode: "boolean" }).notNull(),
    bothSides: integer("both_sides", { mode: "boolean" }).notNull(),
    hardOnly: integer("hard_only", { mode: "boolean" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.classId, t.position] })],
);

export const terrains = sqliteTable("terrains", {
  /** Terrain id 0..0x40; also the movement-cost index space. */
  id: integer("id").primaryKey(),
  /** Decoded name; "" when the record is empty or undecodable. */
  name: text("name").notNull(),
  /** Non-multibyte releases: the text id the name was decoded from. */
  textId: integer("text_id"),
  /** False when the name could not be decoded (Shift-JIS releases). */
  decoded: integer("decoded", { mode: "boolean" }).notNull(),
});

/**
 * Affinity names from the ROM's text table. Every id referenced by units or the
 * bonus table gets a row; ids the ROM has no name for (hacks extend past seven)
 * have name NULL.
 */
export const affinities = sqliteTable("affinities", {
  id: integer("id").primaryKey(),
  name: text("name"),
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

/** Per-unit support record: partner count as declared vs as actually filled. */
export const supportEntries = sqliteTable("support_entries", {
  unitId: integer("unit_id").primaryKey(),
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

/** Deduplicated support pairs are the `support_edges` VIEW - see ddl.ts. */

export const items = sqliteTable("items", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  nameTextId: integer("name_text_id").notNull(),
  descTextId: integer("desc_text_id").notNull(),
  useDescTextId: integer("use_desc_text_id").notNull(),
  description: text("description").notNull(),
  type: integer("type").notNull(),
  typeName: text("type_name").notNull(),
  /** Raw ability bytes at +8..+11. */
  attributes: text("attributes", { mode: "json" }).$type<number[]>().notNull(),

  // Stat bonuses while equipped; NULL columns when the item has no table.
  sbHp: integer("sb_hp"),
  sbStr: integer("sb_str"),
  sbSkl: integer("sb_skl"),
  sbSpd: integer("sb_spd"),
  sbDef: integer("sb_def"),
  sbRes: integer("sb_res"),
  sbLck: integer("sb_lck"),
  sbMov: integer("sb_mov"),
  sbCon: integer("sb_con"),

  uses: integer("uses").notNull(),
  might: integer("might").notNull(),
  hit: integer("hit").notNull(),
  weight: integer("weight").notNull(),
  crit: integer("crit").notNull(),
  rangeMin: integer("range_min").notNull(),
  rangeMax: integer("range_max").notNull(),
  weaponRank: integer("weapon_rank").notNull(),
  iconId: integer("icon_id").notNull(),
  /** `+30`: the use-effect code. See `items.ts`. */
  staffEffect: integer("staff_effect").notNull(),
  /** Display name of {@link staffEffect}, or `""` when the code table lacks it. */
  staffEffectName: text("staff_effect_name").notNull(),
  /** Whether `staff_effect` is one of the ten promotion codes. */
  isPromotionItem: integer("is_promotion_item", { mode: "boolean" }).notNull(),
  damageBonus: integer("damage_bonus").notNull(),
  wexp: integer("wexp").notNull(),
  /** Price per use; buy = uses * unit_price, sell = buy / 2. */
  unitPrice: integer("unit_price").notNull(),
  isWeapon: integer("is_weapon", { mode: "boolean" }).notNull(),
});

/** Classes a weapon is effective against. */
export const itemEffectiveness = sqliteTable(
  "item_effectiveness",
  {
    itemId: integer("item_id").notNull(),
    classId: integer("class_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.classId] }),
    foreignKey({ columns: [t.itemId], foreignColumns: [items.id] }),
  ],
);

/**
 * Promotion items: which classes an item promotes. From the ROM's
 * per-effect-code class table (`readPromotionTables`), attached to every item
 * whose `staff_effect` is that code - so the list repeats across items sharing a
 * code, as the game reads it.
 */
export const itemPromotions = sqliteTable(
  "item_promotions",
  {
    itemId: integer("item_id").notNull(),
    classId: integer("class_id").notNull(),
    /** The `staff_effect` code the list was taken from. */
    effectCode: integer("effect_code").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.classId] }),
    foreignKey({ columns: [t.itemId], foreignColumns: [items.id] }),
  ],
);

export const shops = sqliteTable("shops", {
  id: integer("id").primaryKey(),
  kind: text("kind", { enum: ["weapon", "item", "secret", "prep"] }).notNull(),
  /** NULL for the prep-screen shop. */
  mapIndex: integer("map_index"),
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
  /** Prep-screen number; gaiden chapters use half steps (8.5). */
  chapterNumber: real("chapter_number").notNull(),
  titleTextId: integer("title_text_id").notNull(),
  title: text("title").notNull(),
  /** Weather id; 0 = none. */
  weatherId: integer("weather_id").notNull(),
  /**
   * The raw `u16` difficulty-adjustment word. Its three nibbles are decoded
   * into the three columns below; kept so a surprising decode is traceable.
   */
  difficultyRaw: integer("difficulty_raw").notNull(),
  /** Enemy **level** bonus on hard mode (`(difficulty_raw & 0xF0) >> 4`). */
  hardBoost: integer("hard_boost").notNull(),
  /** Enemy level penalty on normal (`(difficulty_raw >> 8) & 0xF`). */
  normalPenalty: integer("normal_penalty").notNull(),
  /** Enemy level penalty on easy (`difficulty_raw & 0xF`). */
  easyPenalty: integer("easy_penalty").notNull(),
  /** Deployment slot count, normal mode. */
  deploySlots: integer("deploy_slots").notNull(),
  deploySlotsHard: integer("deploy_slots_hard").notNull(),
});

/**
 * Player/enemy/ally placements, both modes. class_id 0 = the unit's own
 * class. The coordinate is the pre-placement (staging) position; where the
 * unit actually walks to is `chapter_placement_steps`.
 */
export const chapterPlacements = sqliteTable(
  "chapter_placements",
  {
    mapIndex: integer("map_index").notNull(),
    mode: text("mode", { enum: ["normal", "hard"] }).notNull(),
    /** Row number within the placement block. */
    position: integer("position").notNull(),
    unitId: integer("unit_id").notNull(),
    classId: integer("class_id").notNull(),
    commander: integer("commander").notNull(),
    level: integer("level").notNull(),
    side: text("side", { enum: ["player", "ally", "enemy", "removed"] }).notNull(),
    autolevel: integer("autolevel", { mode: "boolean" }).notNull(),
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    ext: integer("ext"),
    /** Starting items, +12..+15. */
    items: text("items", { mode: "json" }).$type<number[]>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.mapIndex, t.mode, t.position] }),
    foreignKey({ columns: [t.mapIndex], foreignColumns: [chapters.mapIndex] }),
  ],
);

/** Where a placed unit actually walks to, step by step (8-byte records). */
export const chapterPlacementSteps = sqliteTable(
  "chapter_placement_steps",
  {
    mapIndex: integer("map_index").notNull(),
    mode: text("mode", { enum: ["normal", "hard"] }).notNull(),
    /** Placement row this belongs to. */
    position: integer("position").notNull(),
    /** Step number within the unit's approach. */
    step: integer("step").notNull(),
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    ext: integer("ext"),
    /** Movement speed override for the approach; 0 = default. */
    speed: integer("speed").notNull(),
    /** Unit id this step belongs to; 0 = the placed unit itself. */
    unitId: integer("unit_id").notNull(),
    /** Frames to wait before this step. */
    wait: integer("wait").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mapIndex, t.mode, t.position, t.step] })],
);

/**
 * The order chapters are actually played in. THIS, not chapter_number,
 * orders the game; see tables/storyPath.ts.
 */
export const derivedPlayOrder = sqliteTable("derived_play_order", {
  mapIndex: integer("map_index").primaryKey(),
  /** 1-based position, no gaps. */
  position: integer("position").notNull(),
  /** main = no-detour path; side = spliced in at a branch. */
  role: text("role", { enum: ["main", "side"] }).notNull(),
  playable: integer("playable", { mode: "boolean" }).notNull(),
});

/**
 * The stats each unit enters each chapter with, per difficulty.
 *
 * A ROM stores *inputs* (unit, class, level, grow flag) and the game computes
 * seven numbers on map load; this is that computation, ported from
 * FEBuilderGBA's simulator (`tables/unitStats.ts` for algorithm/provenance).
 *
 * Materialized rather than a view because the arithmetic is not SQL's: C#
 * `Math.Round` is banker's rounding and the growth is a double product, so a
 * `ROUND()` view would disagree on ties.
 *
 * Enemy levels are adjusted per difficulty before the growth runs
 * (`hard_boost`/`normal_penalty`/`easy_penalty`), so the same enemy differs
 * across the three settings. Rows exist for all three whether or not they differ.
 */
export const derivedUnitStats = sqliteTable(
  "derived_unit_stats",
  {
    mapIndex: integer("map_index").notNull(),
    difficulty: text("difficulty", { enum: ["easy", "normal", "hard"] }).notNull(),
    /** Where the unit comes from: the initial block, or an event load. */
    source: text("source", { enum: ["placement", "event"] }).notNull(),
    /**
     * The block within the source: 0 = normal placement block (slot 10),
     * 1 = hard placement block (slot 11), or the `load_blocks.id` for `event`.
     */
    sourceId: integer("source_id").notNull(),
    /** Row number within that block. */
    position: integer("position").notNull(),
    unitId: integer("unit_id").notNull(),
    /** Resolved: a record's class id of 0 means the unit's own class. */
    classId: integer("class_id").notNull(),
    side: text("side", { enum: ["player", "ally", "enemy", "removed"] }).notNull(),
    /** The level the record stores, before the difficulty adjustment. */
    shownLevel: integer("shown_level").notNull(),
    /** Enemy level adjustment for this difficulty; 0 for every other side. */
    levelDelta: integer("level_delta").notNull(),
    /** `shown_level + level_delta`, deliberately not clamped. */
    level: integer("level").notNull(),
    /**
     * `level < 0`. The reference warns this underflows in-game and maxes the
     * enemy - a hack bug worth surfacing, so the level is stored raw, not clamped.
     */
    levelUnderflow: integer("level_underflow", { mode: "boolean" }).notNull(),
    /** The record's grow flag: 0 = fixed stats, 1 = grown on class growths. */
    autolevel: integer("autolevel", { mode: "boolean" }).notNull(),
    /** The level the growth ran to: `level + 10` when promoted. */
    growLevel: integer("grow_level").notNull(),
    /** Either the unit's or the class's promoted bit (`+41` bit 0). */
    promoted: integer("promoted", { mode: "boolean" }).notNull(),
    statHp: integer("stat_hp").notNull(),
    statStr: integer("stat_str").notNull(),
    statSkl: integer("stat_skl").notNull(),
    statSpd: integer("stat_spd").notNull(),
    statDef: integer("stat_def").notNull(),
    statRes: integer("stat_res").notNull(),
    statLck: integer("stat_lck").notNull(),
    /** No growth exists for constitution; this is `unit delta + class base`. */
    statCon: integer("stat_con").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.mapIndex, t.difficulty, t.source, t.sourceId, t.position] }),
    foreignKey({ columns: [t.mapIndex], foreignColumns: [chapters.mapIndex] }),
  ],
);

export const mapObjects = sqliteTable("map_objects", {
  mapIndex: integer("map_index").notNull(),
  type: integer("type").notNull(),
  kind: text("kind").notNull(),
  /** Achievement flag; 0 = repeatable. */
  flag: integer("flag").notNull(),
  objectType: integer("object_type").notNull(),
  objectTypeName: text("object_type_name").notNull(),
  x: integer("x").notNull(),
  y: integer("y").notNull(),
  /** Chest only: the item inside. */
  itemId: integer("item_id"),
  /** Chest only: pays gold instead of an item. */
  gold: integer("gold").notNull(),
  isGoldChest: integer("is_gold_chest", { mode: "boolean" }).notNull(),
  /** The shop this object opens, when it is one. */
  shopId: integer("shop_id"),
});

/** 必ず出撃: units the chapter forces into the deployment. */
export const forceSortie = sqliteTable(
  "force_sortie",
  {
    unitId: integer("unit_id").notNull(),
    /** 0xFF = any route. */
    route: integer("route").notNull(),
    /** 0xFF = any map. */
    mapIndex: integer("map_index").notNull(),
  },
  (t) => [primaryKey({ columns: [t.unitId, t.route, t.mapIndex] })],
);

/** Condition-slot names from config/data; empty when that directory was missing. */
export const condSlots = sqliteTable("cond_slots", {
  idx: integer("idx").primaryKey(),
  flag: text("flag").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
});

// ---------------------------------------------------------- raw event layer
// See tables/eventTrace.ts for the extraction rules. Everything walk-based
// (transitions, recruits, gold, joins) is a VIEW over these tables - ddl.ts.

/**
 * One unique event script, decoded once. Helpers shared via CALL appear once
 * and are referenced by many chapters through `event_instructions`.
 */
export const eventScripts = sqliteTable("event_scripts", {
  id: integer("id").primaryKey(),
  /** Why the linear decode stopped; "exit" is the clean case. */
  stopReason: text("stop_reason").notNull(),
  instructionCount: integer("instruction_count").notNull(),
});

export const eventInstructions = sqliteTable(
  "event_instructions",
  {
    scriptId: integer("script_id").notNull(),
    /** Ordinal within the script's linear decode. */
    seq: integer("seq").notNull(),
    /** Mnemonic from the opcode table, e.g. MNC2; UNKNOWN when unmatched. */
    opcode: text("opcode").notNull(),
    /** The opcode table's {CATEGORY} tokens. */
    category: text("category").notNull(),
    /** Load classification of a POINTER_UNIT argument; NULL when not a load. */
    loadKind: text("load_kind", { enum: ["recruit", "load", "cutscene", "other"] }),
    /** Unit block a POINTER_UNIT argument points at; NULL otherwise. */
    blockId: integer("block_id"),
    /** Script a POINTER_EVENT argument (CALL) points at; NULL otherwise. */
    callScriptId: integer("call_script_id"),
    /** Destination map of a transition opcode; NULL otherwise. */
    targetMap: integer("target_map"),
    /** First gold literal inside the instruction, signed; NULL otherwise. */
    goldDelta: integer("gold_delta"),
    /** Item handed over by a {ITEM}-category instruction; NULL otherwise. */
    itemId: integer("item_id"),
    /** Unit receiving it; 0xFFFF = the unit currently acting. */
    giveUnitId: integer("give_unit_id"),
  },
  (t) => [
    primaryKey({ columns: [t.scriptId, t.seq] }),
    foreignKey({ columns: [t.scriptId], foreignColumns: [eventScripts.id] }),
  ],
);

/** One condition-slot entry of one chapter, linked to the script it runs. */
export const chapterEventSlots = sqliteTable(
  "chapter_event_slots",
  {
    mapIndex: integer("map_index").notNull(),
    slotIndex: integer("slot_index").notNull(),
    slotKind: text("slot_kind").notNull(),
    /** Row number within a table-kind slot; 0 for direct (START/END) slots. */
    position: integer("position").notNull(),
    scriptId: integer("script_id"),
    /**
     * `TURN` only: 開始ターン (`+8`). `NULL` for other slot kinds. `end <= start`
     * means "turn `start`, once" - upstream prints a range only when
     * `start < end` (`EventCondForm.DrawEventListTurn`). Values are **verbatim**:
     * both fixtures carry `start` 112-255, an unreachable-turn hack sentinel for
     * "do not fire on a turn"; filtering is a query-time decision.
     */
    turnStart: integer("turn_start"),
    /** `TURN` only: 終了ターン (`+9`). `0` means "no end", i.e. a single turn. */
    turnEnd: integer("turn_end"),
    /**
     * `TURN` only: ターン前指定 (`+10`), which side's turn fires the event.
     * `EventCondForm.DrawEventListTurn` recognises exactly 0x00 / 0x40 / 0x80.
     */
    turnPhase: text("turn_phase", { enum: ["player", "ally", "enemy"] }),
    /** `TURN` only: 達成フラグ (`+2`), set once the event has run. */
    condFlag: integer("cond_flag"),
  },
  (t) => [
    primaryKey({ columns: [t.mapIndex, t.slotIndex, t.position] }),
    foreignKey({ columns: [t.mapIndex], foreignColumns: [chapters.mapIndex] }),
  ],
);

/**
 * Unit blocks that event instructions point at (LOAD* targets). Same record
 * format as the initial placement blocks; ids are assigned at extract time
 * because the blocks have no identity of their own besides their offset.
 */
export const loadBlocks = sqliteTable("load_blocks", {
  id: integer("id").primaryKey(),
});

export const loadBlockUnits = sqliteTable(
  "load_block_units",
  {
    blockId: integer("block_id").notNull(),
    /** Row number within the block. */
    position: integer("position").notNull(),
    unitId: integer("unit_id").notNull(),
    /** 0 = the unit's own class. */
    classId: integer("class_id").notNull(),
    level: integer("level").notNull(),
    side: text("side", { enum: ["player", "ally", "enemy", "removed"] }).notNull(),
    /** 0 = fixed stats, 1 = grow to `level` on the class's growths. */
    autolevel: integer("autolevel", { mode: "boolean" }).notNull(),
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    /**
     * `+12..15`: the unit's four starting items, `0` = empty. This is where
     * **enemy** equipment lives (deployment blocks hold player/ally only). Slot 0
     * is not a declared equip slot; GBA FE picks the weapon at battle time, so
     * "attack power" is `stat_str + item.might` over the usable ones.
     */
    items: text("items", { mode: "json" }).$type<number[]>().notNull(),
    /**
     * Decoded `ext` of the packed coordinate, FE8 only (NULL on FE6/FE7).
     * Bit `0x2` = アイテムドロップ, the unit drops its item on death.
     */
    ext: integer("ext"),
  },
  (t) => [
    primaryKey({ columns: [t.blockId, t.position] }),
    foreignKey({ columns: [t.blockId], foreignColumns: [loadBlocks.id] }),
  ],
);

/** Every data table, in insertion order. `roster` is a view, not in here. */
export const TABLES = [
  meta,
  units,
  classes,
  classAbilityFlags,
  classMovementCosts,
  classTerrainBonuses,
  skills,
  unitSkills,
  classSkills,
  unitSkillLearn,
  classSkillLearn,
  terrains,
  affinities,
  supportBonuses,
  supportEntries,
  supportPartners,
  items,
  itemEffectiveness,
  itemPromotions,
  shops,
  shopItems,
  chapters,
  chapterPlacements,
  chapterPlacementSteps,
  mapObjects,
  forceSortie,
  condSlots,
  // Raw event layer - walk-based derivations are views over these (ddl.ts).
  eventScripts,
  eventInstructions,
  chapterEventSlots,
  loadBlocks,
  loadBlockUnits,
  // Materialized inference SQL cannot express - see the module doc.
  derivedPlayOrder,
  derivedUnitStats,
] as const;
