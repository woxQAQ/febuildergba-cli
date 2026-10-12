/** Complete decoded records carried by an extraction snapshot. */
import type { CondKind, MountKind, UnitSide } from "./game.ts";
import type { ClassBases, UnitGrowths, UnitStartingStats, UnitStats } from "./stats.ts";

/** The eight weapon types, in the order the ROM stores them. */
export const WEAPON_TYPES = [
  "sword",
  "lance",
  "axe",
  "bow",
  "staff",
  "anima",
  "light",
  "dark",
] as const;

export type WeaponType = (typeof WEAPON_TYPES)[number];
export type WeaponLevels = Record<WeaponType, number>;

/** Which storage format a text-table entry uses. */
export type TextPointerKind = "huffman" | "unhuffman" | "direct" | "invalid";

/** How the end of a force-sortie table is determined. */
export type ForceSortieTermination = "terminator" | "fixed";

/**
 * Field names for bytes 1..7 of a record, in offset order.
 *
 * Transcribed from the labels adjacent to `B1`-`B7` in
 * `SupportAttributeForm.Designer.cs`. Byte 7's label is literally `??` in the
 * reference, and the disassembly above shows the game never reads it, so it
 * stays unnamed here rather than being guessed.
 */
export const SUPPORT_BONUS_FIELDS = [
  "atk", // 攻撃
  "def", // 防御
  "hit", // 命中
  "avoid", // 回避
  "crit", // 必殺
  "critAvoid", // 必殺回避
  "unknown7", // J_7, labelled "??" in the reference; never read by the game
] as const;

export interface Unit {
  /** Unit id as used by the game and by support data. 1-based. */
  id: number;
  /** Index into the unit table. 0-based. `id === index + 1` for vanilla data. */
  index: number;
  address: number;
  nameTextId: number;
  descriptionTextId: number;
  /**
   * Display name: decoded, control bytes removed, `@XXXX` escapes stripped.
   * Upstream is inconsistent - `UnitForm.GetUnitNameByAddr` keeps the escapes,
   * `StatusUnitsMenuForm.GetNameFast` strips them; this CLI strips, because 17
   * units in `dream-of-five.gba` carry a trailing `@001F`. The unstripped form
   * is in {@link Unit.nameRaw}.
   */
  name: string;
  /** Decoded name with `@XXXX` escapes left in place. See {@link Unit.name}. */
  nameRaw: string;
  description: string;
  classId: number;
  className: string;
  /**
   * True when this unit's class is the promoted half of a base/promoted pair
   * (some class's reverse `promotesToClassId` points at it), so it has no
   * promotion left. Hack rosters skew this way - Vision Quest starts 74% of
   * playable units promoted - so it is a real strategic field, derived here from
   * the class table.
   */
  isPromotedClass: boolean;
  mapFaceId: number;
  portraitId: number;
  attribute: number;
  sortOrder: number;
  level: number;
  /** Per-unit deltas, **signed**. See `UnitStats`. */
  stats: UnitStats;
  /** Class base + per-unit delta: what the unit actually starts with. */
  startingStats: UnitStartingStats;
  growths: UnitGrowths;
  /** Sum of the seven growth rates. A rough "how much does this unit scale" signal. */
  growthTotal: number;
  weaponLevels: WeaponLevels;
  abilityFlags: [number, number, number, number];
  /** Raw pointer value stored at +44. */
  supportPointer: number;
  /** File offset the support pointer resolves to, or 0 when unset/invalid. */
  supportAddress: number;
  /** True when +44 held a pointer that lands inside the ROM. */
  hasSupportData: boolean;
  /** Heuristic: no name, no class and no level means an unused slot. */
  isEmpty: boolean;
}

/**
 * What a class *adds* to its avoid / defence / resistance while standing on a
 * terrain. All three arrays are indexed by the same terrain id `0x00..0x40` the
 * movement-cost table uses.
 */
export interface TerrainBonuses {
  avoid: number[];
  def: number[];
  res: number[];
}

export interface UnitClass {
  id: number;
  index: number;
  address: number;
  nameTextId: number;
  name: string;
  description: string;
  /**
   * The class this one is promoted FROM - a **reverse** link despite the name.
   * Verified FE8U: `Knight`(1) stores 3 (`General`), `Paladin`(7) stores 5
   * (`Lance Cavalier`); reading it forward gives nonsense. The name is kept
   * because {@link CLASS_OFFSET.promotesToClassId} reads byte `+5` and
   * FEBuilderGBA's own label for it is 転職先 (promotion *destination*), so a
   * reader comparing the two should not find them quietly disagreeing. Read
   * `model/promotion.ts`'s `buildPromotionGraph` resolves the direction.
   *
   * The pair links **both ways** (base -> promoted and promoted -> base), so
   * the byte alone cannot order it; `sortOrder` breaks the tie.
   */
  promotesToClassId: number;
  /**
   * Promotion tier; each base/promoted pair shares one value (1 = Brawler/Great
   * Chief, 2 = Gladiator, ...). Read this to know which side a class is on.
   */
  sortOrder: number;
  movementRange: number;
  movementSpeed: number;
  /**
   * `+26`: **class power** (威力等级), the divisor/multiplier of the FE6/7/8
   * experience formula. The designer label is 経験値補正値 with
   * `AccessibleDescription = "@CLASS_POWER"` (ClassForm.Designer.cs `J_26`,
   * same in ClassFE6Form.Designer.cs), and the FE8U decomp names the byte
   * `ClassData.classRelativePower` at `0x1A` (include/bmunit.h). Vanilla
   * values are 1 (trainees/civilians), 2 (thieves, healers, dancers),
   * 3 (everything else), 5 (final bosses); 0 marks the empty entry.
   * Earlier read as "experience bonus" - a mistranslation of the label.
   */
  classPower: number;
  bases: ClassBases;
  /** Stat caps, same field order as `bases`. */
  caps: ClassBases;
  enemyGrowths: {
    hp: number;
    str: number;
    skl: number;
    spd: number;
    def: number;
    res: number;
    lck: number;
  };
  /** Stat gains applied on promotion. Six fields - the ROM has no luck bonus. */
  promotionBonuses: {
    hp: number;
    str: number;
    skl: number;
    spd: number;
    def: number;
    res: number;
  };
  weaponLevels: WeaponLevels;
  /** The raw four ability bytes at `+40`..`+43`. */
  abilityFlags: [number, number, number, number];
  /**
   * Decoded ability flags as stable ids (`mountHorse`, `canto`, `dance`, ...).
   *
   * Stable ids remain available without label resources. Display labels come
   * from `unitclass_checkbox_<game>.txt`; see `tables/classFlags.ts`.
   */
  abilityFlagIds: string[];
  /** Mount category from the icon flags. `null` for foot units. */
  mount: MountKind;
  /** Utility role from the action flags, or `null`. */
  specialAction: "dancer" | "bard" | "thief" | null;
  /**
   * Cost to enter each terrain type, indexed by terrain id. `0xFF` means the
   * class cannot enter that terrain. Read from the pointer at `+56`.
   */
  movementCosts: number[];
  /** Rain-weather cost table (`+60`), or `[]` when the class has none. */
  movementCostsRain: number[];
  /** Snow-weather cost table (`+64`), or `[]` when the class has none. */
  movementCostsSnow: number[];
  /**
   * True when every *passable* terrain costs the same - the mechanical signature
   * of a flier, whose cost table is uniform except impassable terrain. A
   * cross-check (the ability flags give `mountPegasus`/`mountWyvern` directly);
   * disagreement signals a mis-parse.
   */
  flying: boolean;
  /**
   * Terrain avoid/defence/resistance bonuses, indexed by the same terrain id.
   * `ClassForm.cs:517-521` maps 地形回避/地形防御/地形魔防 to `+68`/`+72`/`+76`;
   * `MoveCostForm.cs:329-334` dereferences each as `p32(classAddr + offset)`
   * before indexing, so they are pointers like `+56`. `null` when unusable.
   */
  terrainBonuses: TerrainBonuses | null;
  /**
   * True when this class gets **no terrain bonus on any terrain** - the
   * definition of ignoring terrain, and the most complete of three signals:
   * icon flags (`+41` bits 0x08/0x10) find 9 classes on the fixture, uniform
   * movement costs (`+56`) 17, all-zero terrain bonus (`+68`) 17 with the
   * **identical set**. The 8 the flags miss are airborne monsters (Manakete,
   * Phantom, Mogall, Arch Mogall, Gargoyle, Grotesque, Dracolich), which have no
   * mount flag because their icons are not flier icons.
   */
  terrainBonusImmune: boolean;
  /** Heuristic: name id 0 and class id 0 means an unused slot. */
  isEmpty: boolean;
}

export interface CondSlot {
  flag: string;
  name: string;
}

/**
 * A condition slot as described by `config/data/eventcond_<game>.txt`: a flag
 * on the left, a human-readable name on the right. FE8U has 20 of them.
 */
export interface CondSlotInfo extends CondSlot {
  index: number;
  kind: CondKind;
}

export interface PostPlacement {
  /** Decoded packed FE8 coordinate at `+0`. */
  x: number;
  y: number;
  ext: number | null;
  /** `+2`: movement speed override for the approach (0 = default). */
  speed: number;
  /** `+3`: unit id this step belongs to (0 = the placed unit itself). */
  unitId: number;
  /** `+6`: frames to wait before this step. */
  wait: number;
}

export interface PlacedUnit {
  /** Byte offset of this record in the ROM. */
  addr: number;
  /** `+0`. Zero terminates the block and is never emitted. */
  unitId: number;
  /** `+1`. Zero means "use the unit's own class". */
  classId: number;
  /** `+2`. Unit id this unit acts after; 0 for none. */
  commander: number;
  /** Decoded from `+3` via `U.ParseUnitGrowLV`. */
  level: number;
  /**
   * Raw `+3` (the reference's `B3`): the only place a placement records its
   * allegiance - see {@link parseUnitGrowLevel}.
   */
  unitGrow: number;
  /** `+3` bits 1-2 (`U.ParseUnitGrowAssign`). */
  assign: number;
  /** `+3` bits 1-2 decoded: player / ally / enemy / removed. */
  side: UnitSide;
  /** `+3` bit 0: 0 = no autolevel, 1 = autolevel by class growths. */
  autolevel: number;
  /** `+4`, the packed pre-placement coordinate. */
  position: number;
  /**
   * Decoded `position`. For FE8 this is the coordinate the unit is *staged* at
   * before the placement script runs; the coordinates it actually ends up on
   * live in the array at `postPlacementAddr` (see `postPlacementCount`).
   */
  prePlacementCoord: { x: number; y: number; ext: number | null };
  /** `+7`: number of post-placement coordinates. */
  postPlacementCount: number;
  /** `+8`: file offset of the post-placement coordinate array (0 when absent). */
  postPlacementAddr: number;
  /**
   * The post-placement steps, decoded from the 8-byte records at
   * `postPlacementAddr` (u16 packed pos, u8 speed, u8 unit id, u16 wait -
   * `EventUnitForm.cs` writes them at `8 * i`). Empty when absent.
   */
  postPlacements: PostPlacement[];
  /** `+12..15`: starting items. */
  items: number[];
}

export interface Chapter {
  /**
   * Map setting index, i.e. the row number in the map-setting table.
   *
   * **This is NOT the chapter number.** The table has a row per map id, so it
   * also counts unused slots, world-map/skirmish maps and bonus maps. Use
   * `chapterNumber` when you mean "which chapter is this".
   */
  index: number;
  mapSettingAddr: number;
  /**
   * `u16(addr + 0x80) / 2`: the number the game shows in the prep screen and
   * uses for the ending's turn count (`J_128`,
   * `AccessibleDescription = "@MAPSETTING_CHAPTOR_ID"`,
   * `InputFormRef.cs:12097`). Stored doubled so gaiden chapters can occupy half
   * steps: prologue 0, `C1` 2, `C26` 52, `Finale` 54 (27), `Postscript` 55
   * (27.5). Zero = no chapter number (every unused slot and bonus map).
   */
  chapterNumber: number;
  /** `u16(addr + 0x80)` before halving. */
  chapterNumberRaw: number;
  /**
   * `u16(addr + 0x70)`: "map name 1" text id (`J_112_TEXT`, マップ名1) - the prep
   * screen title. One of the four "is this a map setting record" probes in
   * `IsMapSettingEnd`.
   */
  titleTextId: number;
  /**
   * Decoded chapter title, e.g. `C7A: ... Into the ...`. Empty when there is no
   * text context, the id is 0, or the id does not decode. Distinguishes a real
   * chapter from a placeholder: unused slots are blank, world-map encounter maps
   * decode to `@001F`.
   */
  title: string;
  /** Event plist index from the map setting record. */
  eventPlist: number;
  /** `u8(addr + 12)`; 0 = none, else the game's rain/snow/sandstorm id. */
  weatherId: number;
  /** Raw `u16` at `layout.map.difficultyPos` (+0x14); 0 when not transcribed. */
  difficultyRaw: number;
  /**
   * Enemy level bonus on hard: `(difficultyRaw & 0xF0) >> 4`. Effective enemy
   * level is `level + hardBoost` before autolevel and class bases.
   */
  hardBoost: number;
  /** Enemy level penalty on normal: `(difficultyRaw >> 8) & 0xF`. */
  normalPenalty: number;
  /** Enemy level penalty on easy: `difficultyRaw & 0xF`. */
  easyPenalty: number;
  /** File offset of the event-condition table (0 when unresolved). */
  condTableAddr: number;
  /** The 20 raw pointer values from the condition table. */
  condPointers: number[];
  /** Normal-mode player placement block, or 0. */
  playerPlacementAddr: number;
  /** Hard-mode player placement block, or 0. */
  hardPlacementAddr: number;
  /** START_EVENT script, or 0. */
  startEventAddr: number;
  /** END_EVENT script, or 0. */
  endEventAddr: number;
  /**
   * Deployment slot count = `placements.length`, the same number the game
   * computes: `GetChapterAllyUnitCount` (`0x08012344`) resolves slot 10/11 via
   * `GetChapterAllyUnitDataPointer` (`0x08083348`) and counts 20-byte records
   * until `u8(+0) == 0` - byte-for-byte what {@link readPlacements} does. The
   * block doubles as the slot list: prep-screen chapters fill unused slots with
   * a placeholder template (this ROM: `unit 2 / Thief`, one per coordinate), so
   * `placements` can hold twelve records for one character. Read the count.
   */
  deploySlots: number;
  /**
   * Hard-mode slots (condition slot 11), equal to `deploySlots` unless slot 11
   * points elsewhere - here only `mapIndex 22` (`C10B: Needle's Eye`), whose
   * slot 11 is a 9-record block of green allies. `GetChapterAllyUnitCount`
   * (`0x08012344`) does not filter allegiance, so it counts 9, and the hard prep
   * screen would offer 9. The same block is also loaded by the start event
   * (`402C0100` at `0x14c2128`), so the greens are placed either way; only the
   * count is odd. Verify in-game.
   */
  deploySlotsHard: number;
  /** Units on the field at the start of the chapter. */
  placements: PlacedUnit[];
  /** Hard-mode variant of {@link placements}, or `[]` when slot 11 is absent. */
  hardPlacements: PlacedUnit[];
}

export interface SupportPartner {
  /** Partner unit id, 1-based. */
  unitId: number;
  unitName: string;
  /** Support points the pair starts with. */
  initial: number;
  /** Support points gained per turn spent adjacent. */
  growth: number;
}

export interface SupportEntry {
  unitId: number;
  unitName: string;
  /** File offset of this unit's support record. */
  address: number;
  /** Partner count recorded at +21. */
  declaredCount: number;
  /** Number of slots holding a non-zero partner id. Should equal `declaredCount`. */
  actualCount: number;
  countMatches: boolean;
  partners: SupportPartner[];
}

export interface SupportReadResult {
  entries: SupportEntry[];
  /** Units whose +44 slot did not hold a usable pointer. */
  missing: { unitId: number; unitName: string; rawPointer: number }[];
}

export interface SupportBonus {
  /** Affinity id, 1..7. */
  affinity: number;
  affinityName: string;
  /** Raw 8 bytes, exactly as stored. */
  raw: number[];
  /** Bytes 1..7 keyed by {@link SUPPORT_BONUS_FIELDS}. */
  bonuses: Record<(typeof SUPPORT_BONUS_FIELDS)[number], number>;
}

export interface TerrainName {
  /** Terrain id, 0..0x40. Also the index into a class's movement-cost table. */
  id: number;
  /** Decoded name; `''` when the record is empty or undecodable. */
  name: string;
  /** Non-multibyte releases only: the text id the name was decoded from. */
  textId: number | null;
  /** Multibyte releases only: file offset of the raw string. */
  nameAddress: number | null;
  /** False when the name could not be decoded (Shift-JIS releases). */
  decoded: boolean;
  /** Raw bytes, always present - useful for the undecoded case. */
  raw: number[];
}

export interface TerrainTable {
  slotOffset: number;
  tableOffset: number;
  recordSize: number;
  isMultibyte: boolean;
  count: number;
}

export interface TerrainReadResult {
  table: TerrainTable | null;
  names: TerrainName[];
}

export interface ForceSortieRecord {
  /** Position in the table. */
  index: number;
  /** File offset of the record. */
  addr: number;
  /** `+0`. The unit that must be deployed. */
  unitId: number;
  /** `+2`. `0xFF` = any route, otherwise must equal `ChapterData + 0x1B`. */
  route: number;
  /** `+3`. `0xFF` = any map, otherwise a map-setting index. */
  mapIndex: number;
}

export interface ForceSortieTable {
  /** File offset of the 4-byte slot holding the table pointer. */
  slotOffset: number;
  /** File offset of the table itself. */
  tableOffset: number;
  recordSize: number;
  count: number;
  /** How the end of the table was found. */
  termination: ForceSortieTermination;
  records: ForceSortieRecord[];
}

/**
 * One row of the class-change branch table: the two promotion targets the CC
 * menu offers this class. `0` = no branch in that slot. See
 * `tables/classBranch.ts` for why this table and not the class record's `+5`.
 */
export interface ClassBranchEntry {
  /** The class this entry belongs to; also the row's index in the table. */
  classId: number;
  /** File offset of the 2-byte record. */
  addr: number;
  /** `+0`. First promotion target; 0 = none. */
  branch1: number;
  /** `+1`. Second promotion target; 0 = none. */
  branch2: number;
}

export interface ClassBranchTable {
  /** File offset of the 4-byte slot holding the table pointer. */
  slotOffset: number;
  /** File offset of the table itself. */
  tableOffset: number;
  recordSize: number;
  /** Entries read: one per extracted class. */
  count: number;
  entries: ClassBranchEntry[];
}

/**
 * Equipped-stat bonuses, read from the table `+12` points at.
 *
 * Record layout per `ItemStatBonusesForm.cs` (HP / 攻撃 / 技 / 速さ / 守備 /
 * 魔防 / 幸運 / 移動 / 体格 at bytes 0..8). Read as `u8`, matching the
 * reference; vanilla never goes negative, and a hack that wants a penalty
 * uses the ability bytes instead.
 */
export interface ItemStatBonuses {
  hp: number;
  str: number;
  skl: number;
  spd: number;
  def: number;
  res: number;
  lck: number;
  mov: number;
  con: number;
}

export interface Item {
  id: number;
  addr: number;
  /** Decoded name. See the module doc: this is the item-font path. */
  name: string;
  /** Name as the normal text decoder would render it (diagnostic). */
  nameRaw: string;
  nameTextId: number;
  descTextId: number;
  useDescTextId: number;
  /** Storage format of the name string. */
  nameKind: TextPointerKind;
  /** Codes the item-font table has no mapping for (should stay empty). */
  nameUnknownCodes: number[];
  desc: string;
  type: number;
  typeName: string;
  /** `+8..+11`, four bytes of ability flags. */
  attributes: number[];
  /**
   * Stat bonuses while equipped, from the table `+12` points at, or `null`
   * when the pointer is unusable. See {@link ItemStatBonuses}.
   */
  statBonuses: ItemStatBonuses | null;
  /**
   * Class ids this weapon is effective against, from the `+16` table
   * (u8 list, 0-terminated, per `ItemEffectivenessForm.cs`), or `null` when
   * the pointer is unusable. Empty list = the table exists but names nothing.
   */
  effectiveness: number[] | null;
  uses: number;
  might: number;
  hit: number;
  weight: number;
  crit: number;
  rangeMin: number;
  rangeMax: number;
  weaponRank: number;
  weaponRankLetter: string;
  iconId: number;
  /**
   * `+30`: the item's **use-effect code**, or 0 for "no use effect".
   *
   * `ItemForm.B30_ValueChanged` treats this byte as the thing that decides
   * what using the item does, and its combo box is fed by the
   * `item_staff_use_effect_*` resource. See {@link staffEffectName}.
   */
  staffEffect: number;
  /** Name of {@link staffEffect} from the resource table, or `""` when unknown. */
  staffEffectName: string;
  /**
   * Whether `staffEffect` is one of the codes the game treats as a promotion.
   *
   * `ItemForm.IsPromotionItemFE8` (ItemForm.cs:954) accepts exactly
   * `{0x19..0x1D} U {0x2D} U {0x2F..0x32}`. That is the whole "which items
   * promote?" answer - it is a code test, not a scan of a table.
   */
  isPromotionItem: boolean;
  /**
   * Class ids this item promotes, from the class list belonging to its effect
   * code, or `null` when the ROM has no promotion tables / the effect is not a
   * promotion code. See {@link readPromotionTables}.
   *
   * Read-only because it is handed out straight from {@link PromotionTables};
   * callers only ever iterate it.
   */
  promotionClasses: readonly number[] | null;
  damageBonus: number;
  wexp: number;
  /** `+26`: price **per use**. */
  unitPrice: number;
  /** `uses x unitPrice` — what a shop charges. */
  buyPrice: number;
  /** `buyPrice / 2` — `ItemForm.cs:311`. */
  sellPrice: number;
  /** True when the item is a weapon or staff (type 0..7). */
  isWeapon: boolean;
}

export interface ItemTable {
  slotOffset: number;
  tableOffset: number;
  recordSize: number;
  count: number;
}

export interface ItemReadResult {
  table: ItemTable | null;
  items: Item[];
}

export type ShopKind = "weapon" | "item" | "secret" | "prep";

export interface ShopEntry {
  itemId: number;
  /** Durability the shop sells at; 0 = full. */
  uses: number;
  /** `uses || item.uses` — the durability you actually receive. */
  effectiveUses: number;
  name: string;
  /** `effectiveUses x item.unitPrice`. */
  price: number;
}

export interface Shop {
  kind: ShopKind;
  /** Human label, e.g. `C7A: ... Into the Fire weapon`. */
  label: string;
  /** File offset of the 2-byte entry list. */
  addr: number;
  /** Map-setting index this shop belongs to; `null` for the prep shop. */
  mapIndex: number | null;
  /** Chapter number (`u16(+0x80)/2`), or `null` for the prep shop. */
  chapterNumber: number | null;
  chapterTitle: string | null;
  entries: ShopEntry[];
}

export interface ShopReadResult {
  prepShopAddress: number;
  shops: Shop[];
  /** Addresses that looked like a shop pointer but held no entries. */
  emptyCount: number;
}

export interface MapObject {
  addr: number;
  /** `u16(+0)` trigger type. */
  type: number;
  kind: string;
  /** `u16(+2)` achievement flag; 0 means the object can be used repeatedly. */
  flag: number;
  /** `u8(+10)` object type. */
  objectType: number;
  objectTypeName: string;
  x: number;
  y: number;
  /** Chest only: item id, `u8(+4)`. */
  itemId: number | null;
  /** Chest only: gold, `u16(+6)`. */
  gold: number;
  /** Chest only: the chest pays gold instead of an item. */
  isGoldChest: boolean;
  /** Non-chest: file offset of the object's event script, or 0. */
  eventAddr: number;
  /** Shop only: file offset of the 2-byte shop entry list, or 0. */
  shopAddr: number;
}

export interface ChapterObjects {
  chapterIndex: number;
  chapterNumber: number;
  title: string;
  objects: MapObject[];
}

/** The slot each skill table's pointer lives in, or `null` when unresolved. */
export interface SkillPointers {
  /** `FindIconPointer`: 16x16 icon tiles, 128 bytes per skill. */
  icon: number | null;
  /** `FindTextPointer`: `u16` text id per skill id. */
  text: number | null;
  anime: number | null;
  /** `FindAssignPersonalSkillPointer`: one `u8` skill id per **unit** id. */
  assignUnit: number | null;
  /** `FindAssignClassSkillPointer`: one `u8` skill id per **class** id. */
  assignClass: number | null;
  /** `FindAssignClassLevelUpSkillPointer`: a `u32` pointer list per class. */
  levelUpClass: number | null;
  /** `FindAssignUnitLevelUpSkillPointer`: a `u32` pointer list per unit. */
  levelUpUnit: number | null;
}

export interface Skill {
  id: number;
  /** Text id from the `text` table; 0 = the empty skill slot. */
  nameTextId: number;
  /** Upstream's name rule: text before the first `:`. Empty when there is none. */
  name: string;
  /**
   * Everything after the first `:`, trimmed. The text table's own format is
   * `Name:Description` - `SkillTextToName` splits on the first colon and keeps
   * the left half - so this is the right half, and it is where the patch
   * actually documents what a skill does ("攻撃時に...", "地形..."). Empty when
   * the string carries no colon, which is also when {@link name} is empty.
   */
  description: string;
  /** The full decoded string, for the cases where {@link name} is empty. */
  text: string;
}

/** An innate skill: one per unit/class at most, so `skillId` is never 0. */
export interface SkillAssignment {
  ownerId: number;
  skillId: number;
}

export interface SkillLearn {
  ownerId: number;
  /** Index inside the owner's learn list. */
  position: number;
  /**
   * `rawLevel & 0x1f` with the extension, else the whole byte.
   *
   * `255` is not a level: it means the skill is innate on entering the class
   * directly and is *lost* by promoting into it. See the module doc.
   */
  level: number;
  skillId: number;
  /** The level byte as stored; the flags live in its high bits. */
  rawLevel: number;
  playerOnly: boolean;
  enemyOnly: boolean;
  /** Both sides (`(rawLevel & 96) == 96`) - upstream calls this 通常・ハード共通. */
  bothSides: boolean;
  hardOnly: boolean;
}

export interface SkillReadResult {
  pointers: SkillPointers;
  /** Whether the level byte's player/enemy/hard bits are meaningful. */
  classSkillExtends: boolean;
  skills: Skill[];
  unitSkills: SkillAssignment[];
  classSkills: SkillAssignment[];
  unitLearns: SkillLearn[];
  classLearns: SkillLearn[];
}
