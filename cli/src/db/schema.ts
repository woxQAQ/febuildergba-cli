/**
 * The extract database schema.
 *
 * One principle decides the shape: **store facts, derive at query time**.
 * Everything the old JSON commands computed by joining tables in memory -
 * class names on unit rows, shop prices, buy/sell prices, promotion direction
 * - is a SQL join or expression away, so none of it is a column here. What is
 * stored is what the ROM (or the config/data tables) actually says, plus the
 * derived facts that SQL cannot reproduce on its own (play order, joins,
 * enemy projections - these come from walking event scripts).
 *
 * Conventions:
 *
 *   - Booleans are INTEGER 0/1.
 *   - Bulky leaf detail that never joins (raw ability bytes, condition-slot
 *     pointers, placement item lists) is a JSON text column.
 *   - Ids are the game's own: unit ids are 1-based, class ids 0-based,
 *     `map_index` is the map-setting table row, **not** the chapter number.
 *   - Support bonuses are stored as the ROM's half-points (`*_half` columns);
 *     the applied bonus at rank C/B/A is `half * 1/2/3` (see
 *     `tables/supportBonus.ts`).
 *   - Prices: `buy = items.uses * items.unit_price`, `sell = buy / 2`;
 *     a shop row charges `shop_items.effective_uses * items.unit_price`.
 *
 * The roster the old `units` command emitted by default (units carrying
 * support data) survives as the `roster` view - filtering is a query-time
 * decision now.
 */
export const SCHEMA = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE units (
  id                INTEGER NOT NULL,  -- game unit id, 1-based
  idx               INTEGER NOT NULL PRIMARY KEY,  -- 0-based table row
  address           INTEGER NOT NULL,
  name              TEXT NOT NULL,
  name_raw          TEXT NOT NULL,     -- with @XXXX escapes intact
  name_text_id      INTEGER NOT NULL,
  description       TEXT NOT NULL,
  desc_text_id      INTEGER NOT NULL,
  class_id          INTEGER NOT NULL,
  is_promoted_class INTEGER NOT NULL,
  map_face_id       INTEGER NOT NULL,
  portrait_id       INTEGER NOT NULL,
  affinity_id       INTEGER NOT NULL,  -- 0 = none
  sort_order        INTEGER NOT NULL,
  level             INTEGER NOT NULL,
  -- Per-unit SIGNED deltas on the class base, not final stats.
  -- starting stat = classes.base_* + units.delta_*; luck has no class base.
  delta_hp  INTEGER NOT NULL, delta_str INTEGER NOT NULL, delta_skl INTEGER NOT NULL,
  delta_spd INTEGER NOT NULL, delta_def INTEGER NOT NULL, delta_res INTEGER NOT NULL,
  delta_lck INTEGER NOT NULL, delta_con INTEGER NOT NULL,
  growth_hp  INTEGER NOT NULL, growth_str INTEGER NOT NULL, growth_skl INTEGER NOT NULL,
  growth_spd INTEGER NOT NULL, growth_def INTEGER NOT NULL, growth_res INTEGER NOT NULL,
  growth_lck INTEGER NOT NULL, growth_total INTEGER NOT NULL,
  wl_sword INTEGER NOT NULL, wl_lance INTEGER NOT NULL, wl_axe  INTEGER NOT NULL,
  wl_bow   INTEGER NOT NULL, wl_staff INTEGER NOT NULL, wl_anima INTEGER NOT NULL,
  wl_light INTEGER NOT NULL, wl_dark  INTEGER NOT NULL,
  ability_flags     TEXT NOT NULL,     -- JSON [b0, b1, b2, b3], raw +40..43
  support_pointer   INTEGER NOT NULL,
  support_address   INTEGER NOT NULL,
  has_support_data  INTEGER NOT NULL,
  is_empty          INTEGER NOT NULL
);

-- The roster: units carrying support data, the old "units" command's default filter.
CREATE VIEW roster AS SELECT * FROM units WHERE has_support_data = 1;

CREATE TABLE classes (
  id                  INTEGER NOT NULL,  -- 0-based; 0 is the reserved empty entry
  idx                 INTEGER NOT NULL PRIMARY KEY,
  address             INTEGER NOT NULL,
  name                TEXT NOT NULL,
  name_text_id        INTEGER NOT NULL,
  description         TEXT NOT NULL,
  -- REVERSE link: the class this one is promoted FROM. Resolve direction via
  -- sort_order (the promoted side sorts higher) - see tables/classes.ts.
  promotes_to_class_id INTEGER NOT NULL,
  sort_order          INTEGER NOT NULL,
  movement_range      INTEGER NOT NULL,
  movement_speed      INTEGER NOT NULL,
  base_hp INTEGER NOT NULL, base_str INTEGER NOT NULL, base_skl INTEGER NOT NULL,
  base_spd INTEGER NOT NULL, base_def INTEGER NOT NULL, base_res INTEGER NOT NULL,
  base_con INTEGER NOT NULL,
  cap_hp INTEGER NOT NULL, cap_str INTEGER NOT NULL, cap_skl INTEGER NOT NULL,
  cap_spd INTEGER NOT NULL, cap_def INTEGER NOT NULL, cap_res INTEGER NOT NULL,
  cap_con INTEGER NOT NULL,
  enemy_growth_hp  INTEGER NOT NULL, enemy_growth_str INTEGER NOT NULL,
  enemy_growth_skl INTEGER NOT NULL, enemy_growth_spd INTEGER NOT NULL,
  enemy_growth_def INTEGER NOT NULL, enemy_growth_res INTEGER NOT NULL,
  enemy_growth_lck INTEGER NOT NULL,
  promo_hp  INTEGER NOT NULL, promo_str INTEGER NOT NULL, promo_skl INTEGER NOT NULL,
  promo_spd INTEGER NOT NULL, promo_def INTEGER NOT NULL, promo_res INTEGER NOT NULL,
  wl_sword INTEGER NOT NULL, wl_lance INTEGER NOT NULL, wl_axe  INTEGER NOT NULL,
  wl_bow   INTEGER NOT NULL, wl_staff INTEGER NOT NULL, wl_anima INTEGER NOT NULL,
  wl_light INTEGER NOT NULL, wl_dark  INTEGER NOT NULL,
  ability_flags        TEXT NOT NULL,  -- JSON [b0, b1, b2, b3], raw +40..43
  mount                TEXT,           -- wyvern | pegasus | horse | armour | NULL
  special_action       TEXT,           -- dancer | bard | thief | NULL
  flying               INTEGER NOT NULL,  -- cost-table signature, a cross-check
  terrain_bonus_immune INTEGER NOT NULL,
  is_empty             INTEGER NOT NULL
);

-- Ability-bit names from config/data; empty when that directory was missing.
CREATE TABLE class_ability_flags (
  class_id INTEGER NOT NULL,
  flag     TEXT NOT NULL,
  PRIMARY KEY (class_id, flag)
);

-- 65 rows per class, indexed by terrain id; cost 0xFF = impassable.
CREATE TABLE class_movement_costs (
  class_id   INTEGER NOT NULL,
  terrain_id INTEGER NOT NULL,
  cost       INTEGER NOT NULL,
  PRIMARY KEY (class_id, terrain_id)
);

CREATE TABLE class_terrain_bonuses (
  class_id   INTEGER NOT NULL,
  terrain_id INTEGER NOT NULL,
  avoid      INTEGER NOT NULL,
  def        INTEGER NOT NULL,
  res        INTEGER NOT NULL,
  PRIMARY KEY (class_id, terrain_id)
);

-- Derived mobility profile; SQL cannot reproduce it (it needs the
-- infantry-baseline comparison across the whole class table).
CREATE TABLE class_roles (
  class_id        INTEGER PRIMARY KEY,
  mobility        TEXT NOT NULL,  -- flying | mounted | armour | normal
  mobility_source TEXT NOT NULL,  -- flags | costs
  weapons         TEXT NOT NULL,  -- JSON array of usable weapon types
  has_staff       INTEGER NOT NULL,
  is_magic        INTEGER NOT NULL
);

CREATE TABLE terrains (
  id           INTEGER PRIMARY KEY,  -- 0..0x40, the movement-cost index space
  name         TEXT NOT NULL,
  text_id      INTEGER,
  name_address INTEGER,
  decoded      INTEGER NOT NULL,
  raw          TEXT NOT NULL          -- JSON bytes, for the undecoded case
);

-- Affinity names decoded from the ROM's own text table.
CREATE TABLE affinities (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE support_bonuses (
  affinity_id INTEGER PRIMARY KEY,
  atk_half  INTEGER NOT NULL, def_half  INTEGER NOT NULL, hit_half INTEGER NOT NULL,
  avoid_half INTEGER NOT NULL, crit_half INTEGER NOT NULL, crit_avoid_half INTEGER NOT NULL
);

-- Per-unit support record diagnostics (declared vs actual partner count).
CREATE TABLE support_entries (
  unit_id        INTEGER PRIMARY KEY,
  address        INTEGER NOT NULL,
  declared_count INTEGER NOT NULL,
  actual_count   INTEGER NOT NULL
);

-- Raw, asymmetric: one row per direction as the ROM records it.
CREATE TABLE support_partners (
  unit_id    INTEGER NOT NULL,
  partner_id INTEGER NOT NULL,
  initial    INTEGER NOT NULL,  -- points the pair starts with
  growth     INTEGER NOT NULL,  -- points per adjacent turn
  PRIMARY KEY (unit_id, partner_id)
);

-- Deduplicated: a < b, one row per pair.
CREATE TABLE support_edges (
  a       INTEGER NOT NULL,
  b       INTEGER NOT NULL,
  initial INTEGER NOT NULL,
  growth  INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);

CREATE TABLE items (
  id                   INTEGER PRIMARY KEY,
  address              INTEGER NOT NULL,
  name                 TEXT NOT NULL,
  name_raw             TEXT NOT NULL,  -- as the plain text decoder renders it
  name_text_id         INTEGER NOT NULL,
  desc_text_id         INTEGER NOT NULL,
  use_desc_text_id     INTEGER NOT NULL,
  name_kind            TEXT NOT NULL,  -- huffman | unhuffman | direct
  name_unknown_codes   TEXT NOT NULL,  -- JSON; should stay []
  description          TEXT NOT NULL,
  type                 INTEGER NOT NULL,
  type_name            TEXT NOT NULL,
  attributes           TEXT NOT NULL,  -- JSON [b0..b3], +8..+11
  stat_bonus_pointer   INTEGER NOT NULL,
  effectiveness_pointer INTEGER NOT NULL,
  uses       INTEGER NOT NULL,
  might      INTEGER NOT NULL,
  hit        INTEGER NOT NULL,
  weight     INTEGER NOT NULL,
  crit       INTEGER NOT NULL,
  range_min  INTEGER NOT NULL,
  range_max  INTEGER NOT NULL,
  weapon_rank INTEGER NOT NULL,
  icon_id     INTEGER NOT NULL,
  staff_effect INTEGER NOT NULL,
  damage_bonus INTEGER NOT NULL,
  wexp        INTEGER NOT NULL,
  unit_price  INTEGER NOT NULL,  -- per use; buy = uses * unit_price
  is_weapon   INTEGER NOT NULL
);

CREATE TABLE shops (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,  -- weapon | item | secret | prep
  label          TEXT NOT NULL,
  address        INTEGER NOT NULL,
  map_index      INTEGER,        -- NULL for the prep shop
  chapter_number REAL,
  chapter_title  TEXT
);

CREATE TABLE shop_items (
  shop_id        INTEGER NOT NULL REFERENCES shops(id),
  position       INTEGER NOT NULL,  -- order in the shop's list
  item_id        INTEGER NOT NULL,
  uses           INTEGER NOT NULL,  -- 0 = full durability
  effective_uses INTEGER NOT NULL,  -- what you actually receive
  PRIMARY KEY (shop_id, position)
);

CREATE TABLE chapters (
  idx                   INTEGER PRIMARY KEY,  -- map-setting row, NOT the chapter number
  map_setting_addr      INTEGER NOT NULL,
  chapter_number        REAL NOT NULL,        -- prep-screen number; gaidens use .5
  chapter_number_raw    INTEGER NOT NULL,     -- the doubled raw field
  title_text_id         INTEGER NOT NULL,
  title                 TEXT NOT NULL,
  event_plist           INTEGER NOT NULL,
  cond_table_addr       INTEGER NOT NULL,
  cond_pointers         TEXT NOT NULL,        -- JSON, the 20 raw slot values
  player_placement_addr INTEGER NOT NULL,
  hard_placement_addr   INTEGER NOT NULL,
  start_event_addr      INTEGER NOT NULL,
  end_event_addr        INTEGER NOT NULL,
  deploy_slots          INTEGER NOT NULL,
  deploy_slots_hard     INTEGER NOT NULL
);

-- Player/enemy/ally placements, both modes. class_id 0 = the unit's own class.
CREATE TABLE chapter_placements (
  chapter_idx   INTEGER NOT NULL REFERENCES chapters(idx),
  mode          TEXT NOT NULL,      -- normal | hard
  position      INTEGER NOT NULL,   -- row number within the block
  address       INTEGER NOT NULL,
  unit_id       INTEGER NOT NULL,
  class_id      INTEGER NOT NULL,
  commander     INTEGER NOT NULL,
  level         INTEGER NOT NULL,
  unit_grow     INTEGER NOT NULL,   -- raw +3 byte
  assign        INTEGER NOT NULL,
  side          TEXT NOT NULL,      -- player | ally | enemy | removed
  autolevel     INTEGER NOT NULL,
  x             INTEGER NOT NULL,   -- pre-placement (staging) coordinate
  y             INTEGER NOT NULL,
  ext           INTEGER,
  position_raw  INTEGER NOT NULL,
  post_placement_count INTEGER NOT NULL,
  post_placement_addr  INTEGER NOT NULL,
  items         TEXT NOT NULL       -- JSON [i0, i1, i2, i3], +12..15
);

-- END_EVENT walk results, one row per chapter.
CREATE TABLE chapter_end_events (
  map_index             INTEGER PRIMARY KEY,
  end_event_address     INTEGER NOT NULL,
  instructions_decoded  INTEGER NOT NULL,
  stop_reason           TEXT NOT NULL
);

CREATE TABLE chapter_transitions (
  map_index      INTEGER NOT NULL,
  target_map     INTEGER NOT NULL,
  opcode         TEXT NOT NULL,
  script_address INTEGER NOT NULL,
  call_depth     INTEGER NOT NULL  -- >0 means reached via a shared CALL helper
);

-- The order chapters are actually played in. THIS, not chapter_number,
-- orders the game; see tables/storyPath.ts.
CREATE TABLE play_order (
  map_index INTEGER PRIMARY KEY,
  position  INTEGER NOT NULL,  -- 1-based, no gaps
  role      TEXT NOT NULL,     -- main | side
  playable  INTEGER NOT NULL
);

-- Earliest chapter per unit, from placements and LOAD1 instructions.
-- kind: 'join' = in the player's army; 'appearance' = any load, incl. guests.
CREATE TABLE unit_joins (
  unit_id         INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  chapter_idx     INTEGER NOT NULL,
  story_order     INTEGER,      -- play_order.position; NULL when off every path
  source          TEXT NOT NULL, -- placement | recruit | load | cutscene
  evidence_addr   INTEGER NOT NULL,
  class_overridden INTEGER NOT NULL,
  placed_class_id INTEGER NOT NULL,
  PRIMARY KEY (unit_id, kind)
);

CREATE TABLE map_objects (
  chapter_idx      INTEGER NOT NULL,
  address          INTEGER NOT NULL,
  type             INTEGER NOT NULL,
  kind             TEXT NOT NULL,
  flag             INTEGER NOT NULL,  -- achievement flag; 0 = repeatable
  object_type      INTEGER NOT NULL,
  object_type_name TEXT NOT NULL,
  x                INTEGER NOT NULL,
  y                INTEGER NOT NULL,
  item_id          INTEGER,           -- chest only
  gold             INTEGER NOT NULL,  -- chest only
  is_gold_chest    INTEGER NOT NULL,
  event_addr       INTEGER NOT NULL,
  shop_addr        INTEGER NOT NULL
);

-- 必ず出撃: units the chapter forces into the deployment.
CREATE TABLE force_sortie (
  idx       INTEGER PRIMARY KEY,
  address   INTEGER NOT NULL,
  unit_id   INTEGER NOT NULL,
  route     INTEGER NOT NULL,  -- 0xFF = any route
  map_index INTEGER NOT NULL   -- 0xFF = any map
);

-- Condition-slot names from config/data; empty when that directory was missing.
CREATE TABLE cond_slots (
  idx  INTEGER PRIMARY KEY,
  flag TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL
);

-- Event-script walk hits, per chapter.
CREATE TABLE chapter_recruits (
  chapter_idx INTEGER NOT NULL,
  address     INTEGER NOT NULL,  -- of the LOAD* instruction
  slot_index  INTEGER NOT NULL,  -- -1 for a direct placement block
  slot_kind   TEXT NOT NULL,
  instruction TEXT NOT NULL,     -- the opcode pattern, for diagnostics
  kind        TEXT NOT NULL,
  block_addr  INTEGER NOT NULL,
  unit_ids    TEXT NOT NULL      -- JSON, units named in the block
);

CREATE TABLE chapter_gold (
  chapter_idx INTEGER NOT NULL,
  address     INTEGER NOT NULL,
  delta       INTEGER NOT NULL,  -- signed: gain or lose
  instruction TEXT NOT NULL
);

CREATE TABLE chapter_item_gives (
  chapter_idx INTEGER NOT NULL,
  address     INTEGER NOT NULL,
  item_id     INTEGER NOT NULL,
  unit_id     INTEGER NOT NULL,  -- 0xFFFF = the unit currently acting
  instruction TEXT NOT NULL
);

CREATE TABLE chapter_scan_stats (
  chapter_idx     INTEGER PRIMARY KEY,
  truncated_walks INTEGER NOT NULL
);

-- One row per projected enemy placement record, per mode. "hard" re-projects
-- with the hard-mode autolevel round (19 levels instead of 9); both modes are
-- extracted so the choice is a WHERE clause, not a re-run.
CREATE TABLE enemy_samples (
  mode           TEXT NOT NULL,  -- normal | hard
  map_index      INTEGER NOT NULL,
  chapter_number REAL NOT NULL,
  address        INTEGER NOT NULL,
  unit_id        INTEGER NOT NULL,
  class_id       INTEGER NOT NULL,
  level          INTEGER NOT NULL,
  grow           INTEGER NOT NULL,  -- +3 bit 0: autolevel on/off
  routine        TEXT NOT NULL,     -- none | unit | realistic
  promoted       INTEGER NOT NULL,
  class_base_spd INTEGER NOT NULL,
  unit_spd_delta INTEGER NOT NULL,  -- signed
  -- Projected speed as an RNG band:
  spd_lo INTEGER NOT NULL, spd_hi INTEGER NOT NULL, spd_mean REAL NOT NULL,
  con          INTEGER NOT NULL,
  weight       INTEGER NOT NULL,  -- heaviest weapon (worst case)
  weight_first INTEGER NOT NULL,  -- first weapon (editor order)
  -- Attack speed = spd - max(0, weight - con); signed on purpose:
  as_lo INTEGER NOT NULL, as_hi INTEGER NOT NULL, as_mean REAL NOT NULL
);
`;
