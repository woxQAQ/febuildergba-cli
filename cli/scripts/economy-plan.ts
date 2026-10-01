/**
 * 「经济规划」脚本 —— 读 cli/out/*.json（由 `node src/index.ts <cmd>` 产出），
 * 不重新解析 ROM，纯分析层。
 *
 * 用法：
 *   node src/index.ts <cmd> ../fixtures/dream-of-five.gba --out out/dream-of-five.<cmd>.json
 *   node scripts/training-plan.ts --json > out/dream-of-five.training-plan.json   # 可选
 *   node scripts/economy-plan.ts [--route=A|B] [--json]
 *
 * 产物：out/dream-of-five.economy.md      ← 选定路线（默认 A 线）的那一份
 *       out/dream-of-five.economy-A.md    ← A 线
 *       out/dream-of-five.economy-B.md    ← B 线
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 数据来源（全部来自 ROM，没有外部攻略假设）
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   金币 · 金箱      objects.json  宝箱记录 `+4` 低位 = 物品 id，`+6` = 金额
 *   金币 · 事件      chapters.json goldEvents（`40050300XXXX000021370000`）
 *   装备 · 宝箱      objects.json  itemChests
 *   装备 · 村庄/剧情 chapters.json itemsGiven
 *   价格            items.json     `+26` 是「每次使用单价」，总价 = 耐久 × 单价
 *   商店            shops.json     编成准备店 + 每章地图商店
 *   谁能用          units.json     weaponLevels（0..251，≥ 武器 rankValue 才能装备）
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 口径与假设（报告里也会写明）
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. **同一段脚本可以被多张图引用**，所以金币/物品按**地址去重**，归给路线顺序里
 *    最早引用它的那张图。不去重会把 5000 金数成 17 遍。
 * 2. **武器价值指标**（都是「每 1 金换来多少」，越高越省）：
 *      dmgPerGold = might × uses ÷ buyPrice        —— 纯攻击力
 *      hitDmgPerGold = dmgPerGold × hit/100        —— 命中加权
 *      effPerGold  = hitDmgPerGold × (1 + crit/100 × 2)   —— 期望伤害（暴击按 3 倍算）
 *    没算武器三角、特効、射程、重量对追击的影响 —— 这些依赖对手数据，静态拿不到。
 * 3. **消耗模型按编队槽位算，不按全名单算。** 每张图能上场的单位数 = 该章 `deploySlots`，
 *    每名上场单位每章出手 `ATTACKS_PER_CHAPTER` 次（**拍的常数**，报告里给 ±50% 敏感性）。
 *    各类型分到的名额按「主力类型」在名单里的比例拆分。
 *    早先的版本按全名单 52 人 × 每章 10 次算，得出「满编要 26 万」这种没用的数字。
 * 4. 卖价 = 总价 ÷ 2（`ItemForm.cs:311`）。
 * 5. **非主线图一律不进任何数字**：对线专属图直接排除；遭遇图（`@001F`）、原版遗留图、
 *    空槽位单独列在 §1.2。判据见 `classifyOffRoute()`。
 * 6. §3 的性价比表用「全 ROM 有标价的武器」，其中有一部分**本路线商店买不到**（标 `†`）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'out');
const STEM = 'dream-of-five';

const argv = process.argv.slice(2);
const routeArg = argv.find((a) => a.startsWith('--route='))?.slice(8)?.toUpperCase();
const asJson = argv.includes('--json');

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(OUT, `${STEM}.${name}.json`), 'utf8')) as T;
}
function loadOptional<T>(name: string): T | null {
  const p = join(OUT, `${STEM}.${name}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 类型
// ─────────────────────────────────────────────────────────────────────────────

interface ItemEntry {
  id: number;
  name: string;
  type: string;
  rank: string;
  rankValue: number;
  uses: number;
  might: number;
  hit: number;
  crit: number;
  weight: number;
  range: string;
  unitPrice: number;
  buyPrice: number;
  sellPrice: number;
}

interface ShopEntry {
  label: string;
  kind: string;
  address: string;
  mapIndex: number | null;
  chapterNumber: number | null;
  entries: { itemId: number; name: string; uses: number; price: number }[];
}

interface ObjectChapter {
  mapIndex: number;
  chapterNumber: number;
  title: string;
  objects: {
    kind: string;
    flag: number;
    x: number;
    y: number;
    itemId?: number;
    itemName?: string;
    gold?: number;
    isGoldChest?: boolean;
    sellPrice?: number;
  }[];
}

interface ChapterEntry {
  mapIndex: number;
  chapterNumber: number;
  title: string;
  titleTextId: number;
  /** 条件表地址；空槽位没有（`chapters.json` 里省略）。 */
  condTableAddress?: string;
  /** 开场事件脚本地址；空槽位没有。用来区分「本 hack 的内容」与「原版遗留」。 */
  startEvent?: string;
  deploySlots: number;
  goldEvents: { address: string; delta: number; instruction: string }[];
  itemsGiven: { address: string; itemId: number; name: string; unitPrice: number }[];
}

interface UnitEntry {
  id: number;
  name: string;
  className: string;
  classId: number;
  level: number;
  /** 基础值（角色表 `+0..+11`）。`stats` 那份是别的口径，别用。 */
  startingStats: Record<string, number>;
  /** 成长率（百分数）。体格（con）**没有**成长 —— FE8 的体格不随等级涨。 */
  growths: Record<string, number>;
  weaponLevels: Record<string, number>;
  mobility: string;
  hasStaff: boolean;
  supportAddress: string;
}

interface ClassEntry {
  id: number;
  name: string;
  bases: Record<string, number>;
  caps: Record<string, number>;
  promotionBonuses: Record<string, number>;
  promotesToClassId?: number;
}

const itemsDoc = load<{ entries: ItemEntry[] }>('items');
const shopsDoc = load<{ shops: ShopEntry[] }>('shops');
const objectsDoc = load<{ chapters: ObjectChapter[] }>('objects');
const chaptersDoc = load<{ chapters: ChapterEntry[] }>('chapters');
const unitsRaw = load<Record<string, UnitEntry>>('units');
const classesRaw = load<Record<string, ClassEntry>>('classes');

const itemById = new Map<number, ItemEntry>(itemsDoc.entries.map((e) => [e.id, e]));
const chapterByIndex = new Map<number, ChapterEntry>(chaptersDoc.chapters.map((c) => [c.mapIndex, c]));
const objectsByIndex = new Map<number, ObjectChapter>(
  objectsDoc.chapters.map((c) => [c.mapIndex, c]),
);
const classById = new Map<number, ClassEntry>();
for (const k of Object.keys(classesRaw)) classById.set(classesRaw[k].id, classesRaw[k]);

const WEAPON_TYPES = ['sword', 'lance', 'axe', 'bow', 'anima', 'light', 'dark', 'staff'] as const;
type WeaponType = (typeof WEAPON_TYPES)[number];

const TYPE_LABEL: Record<string, string> = {
  sword: '剑',
  lance: '枪',
  axe: '斧',
  bow: '弓',
  anima: '理',
  light: '光',
  dark: '暗',
  staff: '杖',
};

/**
 * 每名上场单位每章的出手次数 —— **拍的常数，不是 ROM 数据**。
 *
 * 6 是中枢估计：GBA 火纹一章约 10–15 回合，前排单位大概接战 5–8 次，
 * 后排（杖/再动）大概 5–10 次。报告里给出 ±50%（3 / 6 / 9）的敏感性。
 */
const ATTACKS_PER_CHAPTER = 6;

// ─────────────────────────────────────────────────────────────────────────────
// 1b. 重量 / 攻速 / 追击
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 参考敌方攻速 —— **不再是拍的常数，是从配置记录投影出来的分布**。
 *
 * 数据来自 `enemy-stats` 命令（`node src/index.ts enemy-stats ... --out
 * out/dream-of-five.enemy-stats.json`），公式与证据见 `AGENTS.md` §3.20。
 * 一句话：敌人和自军共用同一份 20 字节配置记录，所以
 *
 *     敌攻速 = 职业基础速度 + 角色表增量 + 自动升级 − max(0, 武器重量 − 体格)
 *
 * 每一项都能从 ROM 读出来：
 *   · 职业基础速度/体格 —— 职业表 `+0x0E` / `+0x11`；
 *   · 角色表增量 —— 配置记录的 `unitId` 指向角色表，`+12..+19` 是**有符号增量**；
 *   · 自动升级 —— `AutolevelUnit @ 0x08018120`，`count = 等级 − 1`，
 *     用**职业**的 `enemyGrowths`（`+0x1B`）；转职职业再加一轮 9（普通）/ 19（hard）；
 *   · 装备 —— 记录的 `+12..15`，经道具表 `+23` 取重量。
 *
 * ⚠️ 三个必须记住的口径（否则会读出一个比真实值整齐得多的数）：
 *
 *   ① **`+3` bit 0 是自动升级的总开关**（编辑器里的「成長させない / クラス依存」）。
 *      `0x08017C10` 第一件事就是测这一位，**在阵营判断之前**。本 ROM 有 11%
 *      的敌人记录这一位是 0 —— 漏掉就会把这些敌人的属性算高。
 *   ② **自动升级会烧随机数**（`GetAutoleveledStat @ 0x0802B9C4` 里的 `NextRN_N`
 *      + `GetStatIncrease` 里的 `Roll1RN`），所以结果是一个**区间**而不是定值。
 *      报告取 `mean`，`bandLo/bandHi` 是随机数能触及的边界。
 *   ③ **攻速是有符号的**，引擎不钳零。Gorgon Egg（速 0 拿重 10 的书）真的是 −4，
 *      Arch Mogall（体格 5 拿重 20）真的是 −8.8。所以分布里出现负数是**对的**。
 *
 * 取**中位数**当参考值：它回答「这一阶段的典型敌人有多快」，而不是「最快的那个」。
 * `p75` 一并留着，给「要不要为高速敌人留余量」用。
 */
const FALLBACK_ENEMY_AS = 10;

interface EnemyAsRow {
  /** 这一阶段投影到的敌人记录数。 */
  n: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  /**
   * 同一批记录改用「记录里的第一把武器」算出来的中位数。
   * 「AI 会挑哪把武器」是本投影唯一读不到的输入，这一列就是它的量级。
   */
  medianFirstWeapon: number;
}

interface EnemyAsSample {
  mapIndex: number;
  className: string;
  level: number;
  spd: number;
  con: number;
  weight: number;
  weightFirst: number;
  as: number;
}

interface EnemyStatsDoc {
  hardMode: boolean;
  totals: {
    records: number;
    promoted: number;
    byRoutine: { unit: number; realistic: number; none: number };
    noWeapon: number;
    negativeAs: number;
  };
  overall: EnemyAsRow & { mean: number; bandLo: number; bandHi: number; n: number };
  samples: EnemyAsSample[];
}

const enemyStatsDoc = loadOptional<EnemyStatsDoc>('enemy-stats');

function quantileOf(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] as number;
}

/** 一把武器（或一条记录）按「第一把武器」口径折算出来的攻速。 */
function asFirstWeapon(s: EnemyAsSample): number {
  return s.as + Math.max(0, s.weight - s.con) - Math.max(0, s.weightFirst - s.con);
}

/**
 * 逐阶段的敌攻速分布。阶段划分与 `phaseOf` 一致，所以报告里每个阶段看到的
 * 就是该阶段各章敌人的真实混合。
 */
function enemyAsByPhase(route: 'A' | 'B'): Map<Phase, EnemyAsRow> {
  const out = new Map<Phase, EnemyAsRow>();
  if (!enemyStatsDoc) return out;

  const indicesOf = new Map<Phase, Set<number>>();
  for (const idx of routeOrder(route)) {
    const phase = phaseOf(idx, route);
    if (phase === null) continue;
    const set = indicesOf.get(phase) ?? new Set<number>();
    set.add(idx);
    indicesOf.set(phase, set);
  }

  for (const [phase, indices] of indicesOf) {
    const sub = enemyStatsDoc.samples.filter((s) => indices.has(s.mapIndex));
    if (sub.length === 0) continue;
    const as = sub.map((s) => s.as).sort((a, b) => a - b);
    const first = sub.map(asFirstWeapon).sort((a, b) => a - b);
    out.set(phase, {
      n: sub.length,
      p25: quantileOf(as, 0.25),
      median: quantileOf(as, 0.5),
      p75: quantileOf(as, 0.75),
      max: as[as.length - 1] as number,
      medianFirstWeapon: quantileOf(first, 0.5),
    });
  }
  return out;
}

/** FE6/7/8 的追击阈值：攻速差 ≥ 4 才追击（不是 5，也不是 3）。 */
const DOUBLE_THRESHOLD = 4;

/** 未转职单位达到该等级后视作已转职（与 training-plan.ts 同一口径）。 */
const PROMOTION_LEVEL = 15;

/**
 * 攻速 = 速度 − max(0, 武器重量 − 体格)。
 *
 * 这是 GBA 火纹的原始公式：**只有超出的部分才扣**，所以体格 ≥ 重量时零惩罚。
 * 这就是「重甲拿重斧不吃亏、法师拿钢剑要命」的原因。
 */
function attackSpeed(spd: number, con: number, weight: number): number {
  return spd - Math.max(0, weight - con);
}

/** 这把武器对这名单位而言吃掉了多少攻速（0 = 体格扛得住）。 */
function asCost(con: number, weight: number): number {
  return Math.max(0, weight - con);
}

/**
 * 能不能追击参考敌人。
 *
 * `enemyAs` **必须显式给出** —— 每个调用点属于哪个阶段是它自己的信息，
 * 留个默认值只会让「终盘敌攻速被悄悄用在前期」这种错溜过去。
 */
function doublesWith(spd: number, con: number, weight: number, enemyAs: number): boolean {
  return attackSpeed(spd, con, weight) >= enemyAs + DOUBLE_THRESHOLD;
}

/** 一名单位在终盘的速度 / 体格，以及「带多重还能追击」。 */
interface Fighter {
  unit: UnitEntry;
  /** 终盘速度（按训练计划的出场章数投影，与 training-plan.ts 的 projectPower 同一套公式）。 */
  spd: number;
  con: number;
  /** 出场章数 = 训练计划给的 `deployments`。 */
  levels: number;
}

/**
 * 一名单位在 `levels` 级成长之后的单项数值。
 * 公式与 `training-plan.ts:projectPower` 一致：`base + growth/100 × levels`，
 * 越过 `PROMOTION_LEVEL` 时吃一次转职奖励并换上转职后的上限。
 */
function projectStat(unit: UnitEntry, levels: number, field: string): number {
  const cls = classById.get(unit.classId);
  const lvl = unit.level + levels;
  const promoCls = cls?.promotesToClassId ? classById.get(cls.promotesToClassId) : undefined;
  const alreadyPromoted = (cls?.caps.str ?? 0) >= 25;
  const promotesNow = !alreadyPromoted && lvl >= PROMOTION_LEVEL && !!promoCls;
  const caps = (promotesNow ? promoCls?.caps : cls?.caps) ?? {};
  const bonus = promotesNow ? (cls?.promotionBonuses ?? {}) : {};
  const raw = (unit.startingStats[field] ?? 0) + ((unit.growths[field] ?? 0) / 100) * levels;
  return Math.min(raw + (bonus[field] ?? 0), caps[field] ?? 99);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 路线与阶段（与 training-plan.ts 完全一致，保证两份报告能对上）
// ─────────────────────────────────────────────────────────────────────────────

const SHARED_PRE = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const CROSSROADS = [18];
const ROUTE_A = [9, 10, 11, 12, 13, 14, 15, 16, 17];
const ROUTE_B = [19, 20, 21, 22, 23, 24, 25, 26, 27];
const SHARED_POST = [36, 37, 38, 39, 40, 41, 42, 43];
const LATE_HEAD = [46, 47];
const C23X = [54];
const LATE_TAIL = [48, 49, 50];
const FINALE = { A: [51], B: [52] } as const;
const POSTSCRIPT = [53];

function routeOrder(route: 'A' | 'B'): number[] {
  return [
    ...SHARED_PRE,
    ...CROSSROADS,
    ...(route === 'A' ? ROUTE_A : ROUTE_B),
    ...SHARED_POST,
    ...LATE_HEAD,
    ...C23X,
    ...LATE_TAIL,
    ...FINALE[route],
    ...POSTSCRIPT,
  ];
}

/** 本路线的**对线**章节 —— 单周目里根本走不到，任何收入统计都必须排除。 */
function otherRoute(route: 'A' | 'B'): number[] {
  return route === 'A' ? ROUTE_B : ROUTE_A;
}

const PHASES = ['分线前', '分线点', '本线中段', '合流', '终盘'] as const;
type Phase = (typeof PHASES)[number];

function phaseOf(index: number, route: 'A' | 'B'): Phase | null {
  if (SHARED_PRE.includes(index)) return '分线前';
  if (CROSSROADS.includes(index)) return '分线点';
  if ((route === 'A' ? ROUTE_A : ROUTE_B).includes(index)) return '本线中段';
  if (SHARED_POST.includes(index)) return '合流';
  if (
    LATE_HEAD.includes(index) ||
    C23X.includes(index) ||
    LATE_TAIL.includes(index) ||
    FINALE[route].includes(index) ||
    POSTSCRIPT.includes(index)
  ) {
    return '终盘';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 名单（与 training-plan.ts 同口径）
// ─────────────────────────────────────────────────────────────────────────────

const DEBUG_UNITS = new Set([38]); // Rophon：成长总和 1111、0 伙伴，调试单位

const unitById = new Map<number, UnitEntry>();
for (const k of Object.keys(unitsRaw)) unitById.set(unitsRaw[k].id, unitsRaw[k]);

/** 该单位武器等级 ≥ 1 的所有类型，按等级降序。 */
function weaponTypesOf(u: UnitEntry): WeaponType[] {
  return WEAPON_TYPES.filter((t) => (u.weaponLevels[t] ?? 0) > 0).sort(
    (a, b) => (u.weaponLevels[b] ?? 0) - (u.weaponLevels[a] ?? 0),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 训练计划（可选输入）：谁在队伍里
// ─────────────────────────────────────────────────────────────────────────────

interface PlanEntry {
  id: number;
  name: string;
  className: string;
  level: number;
  promoted: boolean;
  joinIndex: number;
  window: number;
  deployments: number;
  roles: string[];
  score: number;
}

const planDoc = loadOptional<Record<string, PlanEntry[]>>('training-plan');

// ─────────────────────────────────────────────────────────────────────────────
// 5. 收入：金币（去重）
// ─────────────────────────────────────────────────────────────────────────────

interface OffRouteRow {
  /** 同一张图可能有多个槽位指向它 —— 这里存**最小的**那个槽位号。 */
  mapIndex: number;
  title: string;
  kind: string;
  /** 指向这同一张图的**全部**槽位号（升序）。 */
  slotIds: number[];
  gold: number;
  gems: number;
  items: number;
  note: string;
}

interface Income {
  goldChest: { mapIndex: number; title: string; amount: number }[];
  goldEvent: { mapIndex: number; title: string; address: string; amount: number }[];
  gems: { mapIndex: number; title: string; name: string; sell: number }[];
  freeItems: { mapIndex: number; title: string; name: string; sell: number; source: string }[];
  /** 不在本路线推进顺序里、且不是对线专属的图能给的东西。 */
  offRoute: OffRouteRow[];
  /** 完全没有内容的槽位（无条件表、无事件脚本），单独计数。 */
  emptySlots: number;
}

/**
 * 非主线图的分类。判据**全部**来自 `chapters.json` 里已有的字段，不做猜测：
 *
 * - `遭遇图`      标题字面就是 `@001F`（世界地图刷怪）。
 * - `原版遗留图`  `startEvent` 落在原版 FE8U 数据区（`< 0x1000000`）。
 *                 本 hack 新写的事件脚本**全部**在 `0x1000000` 以上 —— 47/47 张主线图
 *                 （含 Act 2/3 Checkpoint）都满足；而落在这块低地址的，正好是
 *                 Lagdou Ruins / Castle Frelia / Creeping Darkness / Phantom Ship
 *                 这些**原版 FE8 的章节名**，以及 16 个指向 Castle Frelia 的别名槽位。
 * - `检查点`      标题含 `Checkpoint`，事件脚本在高端区 —— 是**本 hack 自己的**图。
 * - `空槽位`      没有条件表、也没有起始事件。
 */
function classifyOffRoute(ch: ChapterEntry): string {
  const t = ch.title || '';
  if (t === '@001F') return '遭遇图';
  if (!ch.condTableAddress && !ch.startEvent) return '空槽位';
  const start = ch.startEvent ? Number.parseInt(ch.startEvent, 16) : 0;
  if (start < 0x1000000) return '原版遗留图';
  if (/Checkpoint/i.test(t)) return '检查点';
  return '其他非主线图';
}

/** 把一串编号压成区间写法：`[56,63,64,65]` → `56、63–65`。 */
function rangeList(ids: number[]): string {
  const sorted = [...ids].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = start;
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur !== undefined && cur === (prev as number) + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    if (cur === undefined) break;
    start = cur;
    prev = cur;
  }
  return parts.join('、');
}

/** 表格里的「槽位」列：单槽位只写 `1`，多槽位写 `17 个（56、63–78）`。 */
function slotCell(ids: number[]): string {
  if (ids.length <= 1) return '1';
  return `${ids.length} 个（${rangeList(ids)}）`;
}

/**
 * 同一张图的签名 —— **只用事件脚本 + 条件表**。
 * ⚠️ 不能带 `titleTextId`：本 ROM 里 Castle Frelia 是槽位 56（有标题 id 408），
 * 而 63–78 这 16 个槽位指向**完全相同**的事件脚本与条件表，标题 id 却是 0。
 * 带上标题 id 就合并不了，会输出 17 行看起来各不相同的图。
 */
function offRouteKey(ch: ChapterEntry): string {
  return `${ch.startEvent ?? '-'}|${ch.condTableAddress ?? '-'}`;
}

/**
 * 同一段脚本会被多张图引用（本 ROM 里 0x9FF3E4 那 5000 金被 17 张图共享）。
 * 按地址去重，归给路线顺序里最早引用它的图 —— 不去重会把一笔钱数成十几笔。
 */
function collectIncome(route: 'A' | 'B'): Income {
  const order = routeOrder(route);
  const posOf = new Map<number, number>();
  order.forEach((idx, i) => posOf.set(idx, i));

  const seenGold = new Set<string>();
  const seenGiven = new Set<string>();
  const income: Income = {
    goldChest: [],
    goldEvent: [],
    gems: [],
    freeItems: [],
    offRoute: [],
    emptySlots: 0,
  };

  for (const idx of order) {
    const ch = chapterByIndex.get(idx);
    const objs = objectsByIndex.get(idx);
    if (!ch) continue;
    const title = ch.title || `map#${idx}`;

    for (const o of objs?.objects ?? []) {
      if (o.kind !== 'chest') continue;
      if (o.isGoldChest && o.gold) {
        income.goldChest.push({ mapIndex: idx, title, amount: o.gold });
      } else if (o.itemName) {
        const item = o.itemId === undefined ? undefined : itemById.get(o.itemId);
        const sell = item?.sellPrice ?? 0;
        if (item && /Gem$/.test(item.name)) {
          income.gems.push({ mapIndex: idx, title, name: item.name, sell });
        } else {
          income.freeItems.push({ mapIndex: idx, title, name: o.itemName, sell, source: '宝箱' });
        }
      }
    }

    for (const g of ch.goldEvents) {
      const key = `${g.address}`;
      if (seenGold.has(key)) continue;
      // 只算这张图在路线顺序里最早出现的那次
      const first = order.find((i) => (chapterByIndex.get(i)?.goldEvents ?? []).some((e) => e.address === g.address));
      if (first !== idx) continue;
      seenGold.add(key);
      income.goldEvent.push({ mapIndex: idx, title, address: g.address, amount: g.delta });
    }

    for (const it of ch.itemsGiven) {
      const key = `${it.address}#${it.itemId}`;
      if (seenGiven.has(key)) continue;
      const first = order.find((i) =>
        (chapterByIndex.get(i)?.itemsGiven ?? []).some(
          (e) => e.address === it.address && e.itemId === it.itemId,
        ),
      );
      if (first !== idx) continue;
      seenGiven.add(key);
      const item = itemById.get(it.itemId);
      if (!item) continue;
      if (/Gem$/.test(item.name)) {
        income.gems.push({ mapIndex: idx, title, name: item.name, sell: item.sellPrice });
      } else {
        income.freeItems.push({
          mapIndex: idx,
          title,
          name: item.name,
          sell: item.sellPrice,
          source: '村庄/剧情',
        });
      }
    }
  }

  // ---- 不在推进顺序里的图 -------------------------------------------------
  // 遭遇图（`@001F`）、原版遗留图和空槽位也能给钱给装备。它们算不算「单周目收入」
  // 取决于玩家会不会去刷 / 走不走得到，所以单独列出来，不进上面任何数字。
  //
  // ⚠️ **必须排除对线专属图**（A 线的 9–17 / B 线的 19–27）—— 那是另一条线才走得到的
  // 图，把它列进「不在推进顺序里」会让人以为本路线也拿得到。
  const inRoute = new Set(order);
  const excluded = new Set(otherRoute(route));
  const offGroups = new Map<string, OffRouteRow>();

  for (const ch of chaptersDoc.chapters) {
    if (inRoute.has(ch.mapIndex)) continue;
    if (excluded.has(ch.mapIndex)) continue;
    if (classifyOffRoute(ch) === '空槽位') {
      income.emptySlots += 1;
      continue;
    }

    const objs = objectsByIndex.get(ch.mapIndex);
    let gold = 0;
    let gems = 0;
    let itemCount = 0;
    const notes: string[] = [];
    for (const o of objs?.objects ?? []) {
      if (o.kind !== 'chest') continue;
      if (o.isGoldChest && o.gold) gold += o.gold;
      else if (o.itemName) {
        const item = o.itemId === undefined ? undefined : itemById.get(o.itemId);
        if (item && /Gem$/.test(item.name)) gems += item.sellPrice;
        else itemCount++;
      }
    }
    for (const g of ch.goldEvents) {
      if (seenGold.has(g.address)) continue;
      seenGold.add(g.address);
      gold += g.delta;
      notes.push(`事件金 +${money(g.delta)}`);
    }
    for (const it of ch.itemsGiven) {
      const key = `${it.address}#${it.itemId}`;
      if (seenGiven.has(key)) continue;
      seenGiven.add(key);
      const item = itemById.get(it.itemId);
      if (item && /Gem$/.test(item.name)) gems += item.sellPrice;
      else itemCount++;
    }

    // 同一张图可能有多个槽位指向它（本 ROM 里 Castle Frelia 被 17 个槽位共享）
    // —— 按签名合并，只出一行，另记槽位数。
    const key = offRouteKey(ch);
    let row = offGroups.get(key);
    if (!row) {
      row = {
        mapIndex: ch.mapIndex,
        title: ch.title || '(未命名槽位)',
        kind: classifyOffRoute(ch),
        slotIds: [],
        gold: 0,
        gems: 0,
        items: 0,
        note: '',
      };
      offGroups.set(key, row);
    }
    // 槽位按 mapIndex 升序遍历，所以第一个遇到的槽位就定了标题与代表编号。
    // （Castle Frelia：56 有标题，63–78 没有 —— 保留 56 的名字。）
    row.slotIds.push(ch.mapIndex);
    row.gold += gold;
    row.gems += gems;
    row.items += itemCount;
    if (notes.length) row.note = [row.note, ...notes].filter(Boolean).join('、');
  }

  income.offRoute = [...offGroups.values()]
    .filter((r) => r.gold > 0 || r.gems > 0 || r.items > 0)
    .sort((a, b) => a.mapIndex - b.mapIndex);

  return income;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 武器性价比
// ─────────────────────────────────────────────────────────────────────────────

interface Value {
  item: ItemEntry;
  /** 纯攻击力 / 金 */
  dmgPerGold: number;
  /** 命中加权后 / 金 */
  hitDmgPerGold: number;
  /** 期望伤害（暴击按 3 倍）/ 金 */
  effPerGold: number;
  /** 1000 金能买多少次使用 */
  usesPer1000: number;
  /** 耐久 × 攻击力 = 一辈子打出的总攻击力 */
  totalPower: number;
}

function valueOf(e: ItemEntry): Value {
  const cost = e.buyPrice > 0 ? e.buyPrice : 1;
  const totalPower = e.might * e.uses;
  const dmgPerGold = totalPower / cost;
  const hitDmgPerGold = dmgPerGold * (e.hit / 100);
  const critFactor = 1 + (e.crit / 100) * 2;
  return {
    item: e,
    dmgPerGold,
    hitDmgPerGold,
    effPerGold: hitDmgPerGold * critFactor,
    usesPer1000: e.unitPrice > 0 ? 1000 / e.unitPrice : Number.POSITIVE_INFINITY,
    totalPower,
  };
}

/** 可购买的武器（买价 > 0 且不是调试条目）。item 213「Dark」是垃圾数据。 */
const BUYABLE = itemsDoc.entries.filter(
  (e) =>
    (WEAPON_TYPES as readonly string[]).includes(e.type) &&
    e.buyPrice > 0 &&
    e.unitPrice > 0 &&
    e.unitPrice < 60000 &&
    e.name.length > 0,
);

const VALUE_BY_ID = new Map<number, Value>(BUYABLE.map((e) => [e.id, valueOf(e)]));

// ─────────────────────────────────────────────────────────────────────────────
// 7. 商店可得性（按阶段）
// ─────────────────────────────────────────────────────────────────────────────

/** 某阶段可买到的物品 id 集合（含编成准备店，它全程可用）。 */
function buyableInPhase(phase: Phase, route: 'A' | 'B'): Set<number> {
  const ids = new Set<number>();
  for (const shop of shopsDoc.shops) {
    if (shop.mapIndex === null) {
      for (const e of shop.entries) ids.add(e.itemId);
      continue;
    }
    if (phaseOf(shop.mapIndex, route) === phase) {
      for (const e of shop.entries) ids.add(e.itemId);
    }
  }
  return ids;
}

/** 每个物品第一次能买到的阶段。 */
const firstBuyCache = new Map<string, Map<number, Phase>>();

function firstBuyPhase(route: 'A' | 'B'): Map<number, Phase> {
  const cached = firstBuyCache.get(route);
  if (cached) return cached;
  const first = new Map<number, Phase>();
  const order = routeOrder(route);
  for (const idx of order) {
    const phase = phaseOf(idx, route);
    if (phase === null) continue;
    for (const shop of shopsDoc.shops) {
      if (shop.mapIndex !== idx) continue;
      for (const e of shop.entries) if (!first.has(e.itemId)) first.set(e.itemId, phase);
    }
  }
  // 编成准备店全程可用 → 阶段视为「分线前」
  for (const shop of shopsDoc.shops) {
    if (shop.mapIndex !== null) continue;
    for (const e of shop.entries) if (!first.has(e.itemId)) first.set(e.itemId, '分线前');
  }
  firstBuyCache.set(route, first);
  return first;
}

const routeShopCache = new Map<string, Set<number>>();

/**
 * 本路线的商店里出现过的**全部**物品 id（含编成准备店）。
 * ⚠️ §3 的性价比表用的是「全 ROM 有标价的武器」（`BUYABLE`），里面有一批**只出现在
 * 非主线图 / 对线图的商店**里 —— 例如 `@001F` 秘密屋的 Tianlong Jian / Implosion，
 * 以及**任何商店都不卖**的 Hammerne / Bolting / Purge。所以每行要标出来。
 */
function routeShopIds(route: 'A' | 'B'): Set<number> {
  const cached = routeShopCache.get(route);
  if (cached) return cached;
  const ids = new Set<number>();
  for (const phase of PHASES) for (const id of buyableInPhase(phase, route)) ids.add(id);
  routeShopCache.set(route, ids);
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. 报告
// ─────────────────────────────────────────────────────────────────────────────

function pad(s: string | number, w: number): string {
  const str = String(s);
  let width = 0;
  for (const ch of str) width += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, w - width));
}

function money(n: number): string {
  return n.toLocaleString('en-US');
}

function report(route: 'A' | 'B'): string {
  const order = routeOrder(route);
  const income = collectIncome(route);
  const firstPhase = firstBuyPhase(route);
  const plan = planDoc?.[route] ?? null;

  const L: string[] = [];
  const push = (s = '') => L.push(s);

  /** 逐阶段的参考敌攻速（中位数）。缺数据时退回常数，见 `FALLBACK_ENEMY_AS`。 */
  const enemyAs = enemyAsByPhase(route);
  const refAs = (phase: Phase): number => enemyAs.get(phase)?.median ?? FALLBACK_ENEMY_AS;

  // ---- 名单 + 终盘速度/体格（§3 与 §5/§6 共用，所以在这里先算好） --------------
  const team = plan
    ? (plan.map((p) => unitById.get(p.id)).filter(Boolean) as UnitEntry[])
    : [...unitById.values()].filter((u) => u.supportAddress && !DEBUG_UNITS.has(u.id));

  const fighters: Fighter[] = team.map((u) => {
    const levels = plan?.find((p) => p.id === u.id)?.deployments ?? 0;
    return {
      unit: u,
      spd: projectStat(u, levels, 'spd'),
      con: u.startingStats.con ?? 0,
      levels,
    };
  });
  const fighterById = new Map<number, Fighter>(fighters.map((f) => [f.unit.id, f]));

  /**
   * 一把武器在本路线队伍里的追击表现。
   * `avgHits` 是「平均每次攻击打几下」（1 或 2 的加权平均），用作期望伤害的乘数。
   */
  const weightStats = (item: ItemEntry) => {
    const users = fighters.filter(
      (f) => (f.unit.weaponLevels[item.type] ?? 0) >= item.rankValue,
    );
    if (users.length === 0) return null;
    const doublers = users.filter((f) => doublesWith(f.spd, f.con, item.weight, refAs('终盘')));
    return {
      users: users.length,
      doublers: doublers.length,
      avgHits: 1 + doublers.length / users.length,
    };
  };

  /** 本路线队伍里，每把武器的追击表现 + 含追击的期望/金。 */
  const WEIGHTED = new Map<
    number,
    { users: number; doublers: number; avgHits: number; effWithDouble: number }
  >();
  for (const e of BUYABLE) {
    const ws = weightStats(e);
    if (!ws) continue;
    const v = VALUE_BY_ID.get(e.id) as Value;
    WEIGHTED.set(e.id, { ...ws, effWithDouble: v.effPerGold * ws.avgHits });
  }
  /** 排序键：含追击的期望/金。没算出来的（队伍里没人能用）退回不含追击的值。 */
  const valueKey = (id: number) =>
    WEIGHTED.get(id)?.effWithDouble ?? (VALUE_BY_ID.get(id) as Value).effPerGold;

  const totalGoldChest = income.goldChest.reduce((s, g) => s + g.amount, 0);
  const totalGoldEvent = income.goldEvent.reduce((s, g) => s + g.amount, 0);
  const totalGems = income.gems.reduce((s, g) => s + g.sell, 0);

  // 「全部卖掉」这个数字会被少数几件传说武器的展示价格撑爆（Tianlong Jian 的
  // `+26` 是 10000/次 × 50 次 = 500,000），所以分成两档：能真的变现的、和只是
  // 账面上的。
  const SANE_SELL = 20000;
  const sane = income.freeItems.filter((f) => f.sell <= SANE_SELL);
  const absurd = income.freeItems.filter((f) => f.sell > SANE_SELL);
  const saneSell = sane.reduce((s, g) => s + g.sell, 0);
  const absurdSell = absurd.reduce((s, g) => s + g.sell, 0);

  // 同一件装备可能由**多段脚本**发放（C17x 的 Tianlong Jian 3 段、C6x 的 Mioritza 2 段、
  // C23x 的 Member Card 2 段）。遍历器不判分支，只会逐段收集 —— 所以这里的「段数」
  // 是**上界**，不是确定到手件数。按「物品 + 来源图 + 途径」聚合，避免看起来像 3 件不同的东西。
  const freeGroups = new Map<
    string,
    { name: string; title: string; source: string; sell: number; count: number }
  >();
  for (const f of income.freeItems) {
    const k = `${f.name}|${f.title}|${f.source}`;
    const g = freeGroups.get(k);
    if (g) g.count += 1;
    else
      freeGroups.set(k, {
        name: f.name,
        title: f.title,
        source: f.source,
        sell: f.sell,
        count: 1,
      });
  }
  const freeList = [...freeGroups.values()];
  const topFree = [...freeList].sort((a, b) => b.sell * b.count - a.sell * a.count).slice(0, 10);

  push(`# Dream of Five — 经济规划（路线 ${route}）`);
  push();
  push(
    `> 单周目 ${order.length} 张图。所有数字来自 ROM 静态数据：\`objects.json\`（宝箱）、` +
      `\`chapters.json\`（事件金币 / 村庄发放）、\`shops.json\`（商店）、\`items.json\`（价格与性能）。`,
  );
  push(`> 生成方式：\`node scripts/economy-plan.ts --route=${route}\`。`);
  push(
    `> 两条线的报告各写一份：\`dream-of-five.economy-A.md\` / \`dream-of-five.economy-B.md\`；` +
      `\`dream-of-five.economy.md\` 是不带 \`--route\` 时的默认（A 线）。`,
  );
  push();

  // ── 8.1 总预算 ────────────────────────────────────────────────────────────
  push(`## 1. 总预算：这一周目到底有多少钱`);
  push();
  push(`| 来源 | 金额 | 笔数 | 说明 |`);
  push(`|---|---:|---:|---|`);
  push(
    `| 金箱 | ${money(totalGoldChest)} | ${income.goldChest.length} | 宝箱记录 \`+6\` 存金额，物品栏写 0x77(Gold) |`,
  );
  push(
    `| 事件直接给钱 | ${money(totalGoldEvent)} | ${income.goldEvent.length} | \`40050300XXXX000021370000\` |`,
  );
  push(
    `| 宝石变卖 | ${money(totalGems)} | ${income.gems.length} | 卖价 = 总价 ÷ 2 |`,
  );
  push(
    `| **确定可得现金** | **${money(totalGoldChest + totalGoldEvent + totalGems)}** | | 这是唯一能直接花的钱 |`,
  );
  push();
  push(
    `**全 ROM 只有 4 条「直接给钱」指令和 4 个金箱。** 钱不是靠打怪掉的，` +
      `是靠**开箱**和**卖宝石**来的 —— 漏掉一个宝石箱就等于少买 10 把铁剑。`,
  );
  push();
  push(
    `另有 **${income.freeItems.length} 段**免费装备发放（宝箱 + 村庄/剧情脚本，${freeList.length} 种物品）。` +
      `其中 ${sane.length} 段属于「用不上就卖」的档位，合计可换 **${money(saneSell)}** 金；` +
      `剩下 ${absurd.length} 段是传说/专用武器，价格字段只是展示值（合计 ${money(absurdSell)}），` +
      `不要指望靠卖它们发财。`,
  );
  push();
  push(
    `> ⚠️ 「段数」是**上界**。脚本里的分支会被逐段计入 —— C17x 的 Tianlong Jian 是 3 段、` +
      `C6x 的 Mioritza 2 段、C23x 的 Member Card 2 段，但遍历器不判分支，` +
      `「3 段」不等于「3 把」。宝箱那部分是逐条记录的，没有这个问题。`,
  );
  push();
  push(`**免费拿到的最值钱的 10 项**（按 卖价 × 段数 排序）`);
  push();
  push(`| 物品 | 段数 | 来源图 | 途径 | 卖价 | 小计 |`);
  push(`|---|---:|---|---|---:|---:|`);
  for (const f of topFree) {
    push(
      `| ${f.name} | ${f.count} | ${f.title} | ${f.source} | ${money(f.sell)} | ` +
        `${money(f.sell * f.count)} |`,
    );
  }
  push();

  push(`### 1.1 逐笔明细`);
  push();
  push(`**金箱（${money(totalGoldChest)}）**`);
  push();
  push(`| 图 | 章 | 金额 |`);
  push(`|---|---|---:|`);
  for (const g of income.goldChest) push(`| ${g.mapIndex} | ${g.title} | ${money(g.amount)} |`);
  push();
  push(`**事件给钱（${money(totalGoldEvent)}）**`);
  push();
  if (income.goldEvent.length === 0) {
    push(
      `本路线**一笔都没有**。ROM 里那 4 条给钱指令落在：C8B（B 线中段）、` +
        `一张 \`@001F\` 遭遇图、以及 Castle Frelia / 未使用槽位 —— 见 §1.2。`,
    );
  } else {
    push(`| 图 | 章 | 地址 | 金额 |`);
    push(`|---|---|---|---:|`);
    for (const g of income.goldEvent) {
      push(`| ${g.mapIndex} | ${g.title} | \`${g.address}\` | ${money(g.amount)} |`);
    }
  }
  push();
  push(`**宝石（可卖 ${money(totalGems)}）**`);
  push();
  push(`| 图 | 章 | 宝石 | 卖价 |`);
  push(`|---|---|---|---:|`);
  for (const g of income.gems) push(`| ${g.mapIndex} | ${g.title} | ${g.name} | ${money(g.sell)} |`);
  push();
  push(`### 1.2 本路线拿不到的图`);
  push();
  if (income.offRoute.length === 0) {
    push(`（没有）`);
  } else {
    push(
      `这些图**不在本路线的推进顺序里**，所以**没有计入上面任何数字**。` +
        `分类判据全部来自 \`chapters.json\` 的字段，不是猜的：`,
    );
    push();
    push(
      `- **对线专属图**（${rangeList(otherRoute(route))}）已**直接排除** —— ` +
        `那是 ${route === 'A' ? 'B' : 'A'} 线才走得到的图。`,
    );
    push(`- **遭遇图**：标题字面就是 \`@001F\`（世界地图刷怪）。去不去刷取决于你。`);
    push(
      `- **原版遗留图**：事件脚本落在原版 FE8U 数据区（\`< 0x1000000\`）。` +
        `本 hack 新写的事件脚本**全部**在 \`0x1000000\` 以上（47/47 张主线图，含两个检查点，` +
        `都满足），而落在这块低地址的正好是 Lagdou Ruins / Castle Frelia / ` +
        `Creeping Darkness / Phantom Ship 这些**原版 FE8 章节名**。` +
        `**大概率单周目走不到**，但静态数据不能 100% 断定，所以列出来让你自己判断。`,
    );
    push(`- **检查点**：Act 2 / Act 3 Checkpoint，事件脚本在高端区 —— 是**本 hack 自己的**图。`);
    push();
    push(`| 图 | 标题 | 类别 | 槽位 | 现金 | 宝石 | 装备 | 备注 |`);
    push(`|---|---|---|---|---:|---:|---:|---|`);
    for (const o of income.offRoute) {
      push(
        `| ${o.mapIndex} | ${o.title} | ${o.kind} | ${slotCell(o.slotIds)} | ${money(o.gold)} | ` +
          `${money(o.gems)} | ${o.items} | ${o.note || '—'} |`,
      );
    }
    if (income.emptySlots > 0) {
      push(
        `| — | — | 空槽位 | ${income.emptySlots} 个 | 0 | 0 | 0 | 无条件表、无事件脚本 |`,
      );
    }
  }
  push();

  // ── 8.2 分阶段预算 ────────────────────────────────────────────────────────
  push(`## 2. 分阶段收入`);
  push();
  push(`| 阶段 | 图数 | 金箱 | 事件金 | 宝石 | 阶段合计 | 累计 |`);
  push(`|---|---:|---:|---:|---:|---:|---:|`);
  let cumulative = 0;
  for (const phase of PHASES) {
    const maps = order.filter((i) => phaseOf(i, route) === phase);
    const gc = income.goldChest.filter((g) => phaseOf(g.mapIndex, route) === phase);
    const ge = income.goldEvent.filter((g) => phaseOf(g.mapIndex, route) === phase);
    const gm = income.gems.filter((g) => phaseOf(g.mapIndex, route) === phase);
    const sum =
      gc.reduce((s, g) => s + g.amount, 0) +
      ge.reduce((s, g) => s + g.amount, 0) +
      gm.reduce((s, g) => s + g.sell, 0);
    cumulative += sum;
    push(
      `| ${phase} | ${maps.length} | ${money(gc.reduce((s, g) => s + g.amount, 0))} | ` +
        `${money(ge.reduce((s, g) => s + g.amount, 0))} | ${money(gm.reduce((s, g) => s + g.sell, 0))} | ` +
        `${money(sum)} | ${money(cumulative)} |`,
    );
  }
  push();
  push(
    `**读法**：钱几乎全在**宝箱**里，而宝箱集中在少数几张图 —— 漏开一个宝箱就是几千金。` +
      `村庄给的是装备不是钱，所以「钱」和「装备」要分开算。`,
  );
  push();

  // ── 8.3 武器性价比 ────────────────────────────────────────────────────────
  push(`## 3. 武器性价比`);
  push();
  push(
    `指标定义（全部是「每 1 金换来多少」，越高越省）：`,
  );
  push();
  push(`- \`纯攻击/金\` = 攻击 × 耐久 ÷ 总价`);
  push(`- \`命中加权/金\` = 纯攻击/金 × 命中%`);
  push(`- \`期望/金\` = 命中加权/金 × (1 + 必杀% × 2)　（暴击按 3 倍伤害算）`);
  push(`- \`千金额度\` = 1000 金能买多少次使用（耐久）`);
  push(`- \`追击(终盘)\` = 你队伍里**带得动它还能追击**的人数 / 能装备它的人数，按**终盘**速度算（见 §3.0）`);
  push(`- \`含追击期望/金\` = 期望/金 × 平均出手次数（1 或 2）　**这是本表的排序键**`);
  push();
  push(
    `> 没进模型的：武器三角、特効、射程，以及**对手**的防御/速度。` +
      `重量**已经进模型**了 —— 见 §3.0。`,
  );
  push();
  push(
    `> \`†\` = **本路线（${route} 线）的商店买不到** —— 它只出现在非主线图 / 对线图的商店里，` +
      `或者**任何商店都不卖**。数值仍可用于比较（比如评估捡来的那把值不值钱），` +
      `但**别把它写进采购计划**。`,
  );
  push();

  // ---- §3.0 重量与追击 ------------------------------------------------------
  push(`### 3.0 重量与追击（先看这节）`);
  push();
  push(
    `攻速公式是 **\`攻速 = 速度 − max(0, 武器重量 − 体格)\`**，追击条件是 ` +
      `**\`|我方攻速 − 敌方攻速| ≥ ${DOUBLE_THRESHOLD}\`**（双向 —— 谁快谁都能追）。` +
      `注意**只有超出的部分才扣** —— 体格 ≥ 重量时零惩罚，这就是重甲拿重斧不吃亏、` +
      `法师拿钢剑要命的原因。`,
  );
  push();
  push(
    `> 这两条**不是照抄公知公式，是从 ROM 自己的代码里读出来的**：` +
      `\`BattleLoadAS @ 0x0802AB74\` 里有一段「比较后钳到 0、再相减」，` +
      `\`BattleCheckDoubling @ 0x0802AF90\` 里是两处 \`cmp #3\` + \`ble\`（所以是 ≥4）。` +
      `FEBuilderGBA 的两个引擎补丁（\`PATCH_Eliminate attack speed penalty\` / ` +
      `\`PATCH_Required pursuit attack speed difference\`）标的地址 ` +
      `\`0x02AB92\` / \`0x02AFBC\`、\`0x02AFCE\` **与反汇编结果逐个吻合**，` +
      `说明这个 hack 没动过这段代码。细节见仓库 \`AGENTS.md\` §3.18。`,
  );
  push();
  push(
    `**追击不是加 50% 伤害，是直接多打一次** —— 一次命中变两次，等于攻击力翻倍。` +
      `所以「少 3 点攻速」的代价往往比「多 4 点攻击」的收益大得多。`,
  );
  push();

  const refSpeeds = [...fighters.map((f) => f.spd)].sort((a, b) => a - b);
  const refCons = [...fighters.map((f) => f.con)].sort((a, b) => a - b);
  const median = (a: number[]) => (a.length ? a[Math.floor((a.length - 1) / 2)] : 0);
  push(
    `你队伍（${fighters.length} 人）**终盘**速度中位数 **${median(refSpeeds).toFixed(0)}**、` +
      `体格中位数 **${median(refCons).toFixed(0)}**。` +
      `体格**不随等级涨**（FE8 没有体格成长），所以早期速度没长起来时，` +
      `同样的武器会吃掉更多攻速 —— **§5 的采购清单用的是各阶段自己的速度**，不是终盘值。`,
  );
  push();

  // 逐阶段的真实分布 —— 这是模型真正采用的参考值
  if (enemyStatsDoc) {
    push(
      `| 阶段 | 敌人记录 | p25 | **中位数（本报告采用）** | p75 | 最高 | 换成「第一把武器」的中位数 |`,
    );
    push(`|---|---:|---:|---:|---:|---:|---:|`);
    for (const phase of PHASES) {
      const row = enemyAs.get(phase);
      if (!row) continue;
      push(
        `| ${phase} | ${row.n} | ${row.p25.toFixed(1)} | **${row.median.toFixed(1)}** | ` +
          `${row.p75.toFixed(1)} | ${row.max.toFixed(1)} | ${row.medianFirstWeapon.toFixed(1)} |`,
      );
    }
    push();
    const emptyPhases = PHASES.filter((p) => !enemyAs.has(p));
    push(
      `> 每一行都是**那一阶段各章敌人记录的实际混合**（含增援），不是抽样估计。` +
        `取中位数是因为它回答「典型敌人有多快」；\`p75\` 是「四分之一的敌人至少这么快」，` +
        `要留余量就看它。最后一列是**口径敏感性**：换成「记录里的第一把武器」后中位数动了多少 —— ` +
        `「AI 到底挑哪把武器」是本投影唯一读不到的输入，这一列就是它的量级。` +
        (emptyPhases.length
          ? `\n>\n> ${emptyPhases.join(' / ')} 没有行，是因为${emptyPhases.join(' / ')}的那张图` +
            `（mapIndex ${emptyPhases.map((p) => routeOrder(route).filter((i) => phaseOf(i, route) === p).join('、')).join('、')}）` +
            `**一条敌人记录都没有** —— 它是剧情/编成图，不打。`
          : ''),
    );
    push();
  }

  // 灵敏度：换参考敌攻速，看队伍整体还能不能追击
  const probes: { label: string; source: string; as: number }[] = [];
  for (const phase of PHASES) {
    const row = enemyAs.get(phase);
    if (!row) continue;
    probes.push({
      label: row.median.toFixed(1),
      source: `**${phase}** —— ${row.n} 条敌人记录的中位数`,
      as: row.median,
    });
  }
  for (const legacy of [6, 10, 14]) {
    probes.push({
      label: String(legacy),
      source: '旧口径：拍的常数（已废弃，留作对照）',
      as: legacy,
    });
  }
  if (enemyStatsDoc) {
    probes.push({
      label: enemyStatsDoc.overall.p25.toFixed(1),
      source: '全 ROM p25 —— 假设你只遇到偏快的那四分之一',
      as: enemyStatsDoc.overall.p25,
    });
    probes.push({
      label: enemyStatsDoc.overall.p75.toFixed(1),
      source: '全 ROM p75 —— 假设你只遇到偏慢的那四分之一',
      as: enemyStatsDoc.overall.p75,
    });
  }

  push(`| 参考敌攻速 | 出处 | 队伍里「带得动还能追击」的（单位 × 武器）组合 | 占比 |`);
  push(`|---|---|---:|---:|`);
  for (const probe of probes) {
    let ok = 0;
    let total = 0;
    for (const e of BUYABLE) {
      for (const f of fighters) {
        if ((f.unit.weaponLevels[e.type] ?? 0) < e.rankValue) continue;
        total += 1;
        if (doublesWith(f.spd, f.con, e.weight, probe.as)) ok += 1;
      }
    }
    const pct = total ? (ok / total) * 100 : 0;
    push(`| ${probe.label} | ${probe.source} | ${ok} / ${total} | ${pct.toFixed(0)}% |`);
  }
  push();
  push(
    `> ⚠️ **这张表里前 ${enemyAs.size} 行是数据，后 5 行是敏感性。** 参考敌攻速已经**不是假设**了：` +
      `它由 \`enemy-stats\` 命令从配置记录逐条投影出来（\`AGENTS.md\` §3.20），` +
      `每个阶段那一行就是该阶段敌人的实际分布。` +
      `保留后面几行是为了让你看到「如果这个数错了会错多少」：` +
      `把参考值从 8 抬到 15，能追击的组合会掉一大截 —— 这就是**速度**在这份报告里的分量。`,
  );
  push();
  push(
    `**这个数还剩多少不确定性**（按重要性排）：` +
      `① **AI 挑哪把武器**读不到 —— 投影取「记录里最重的那把」（对敌人最不利、对你最有利），` +
      `换成第一把武器中位数只动 0.1–0.3，所以这条基本不影响结论；` +
      `② **自动升级会烧随机数** —— \`GetAutoleveledStat @ 0x0802B9C4\` 里 \`NextRN_N\` 做 \`±v/16\` 抖动、` +
      `\`GetStatIncrease\` 里 \`Roll1RN\` 决定进位，所以每条记录是**区间**不是定值（本报告取均值）；` +
      `③ **遍历是下界** —— 只走到条件表脚本引用得到的配置块，` +
      `遇到 10 条连续未知指令就放弃，所以敌人记录数（${enemyStatsDoc ? enemyStatsDoc.totals.records : '—'} 条）` +
      `是「至少这么多」，不是普查总数。`,
  );
  push();
  push(
    `**速查**：你队伍里**带不动**（会掉追击）的武器 —— ` +
      (() => {
        const bad = BUYABLE.filter((e) => {
          const ws = WEIGHTED.get(e.id);
          return ws && ws.doublers < ws.users;
        })
          .map((e) => {
            const ws = WEIGHTED.get(e.id)!;
            return { e, ws };
          })
          .sort((a, b) => b.e.weight - a.e.weight)
          .slice(0, 10);
        return bad
          .map(
            ({ e, ws }) =>
              `${e.name}（重 ${e.weight}，只有 ${ws.doublers}/${ws.users} 人带得动）`,
          )
          .join('、');
      })() +
      `。`,
  );
  push();

  const shopIds = routeShopIds(route);
  let offShopCount = 0;

  for (const type of WEAPON_TYPES) {
    const rows = BUYABLE.filter((e) => e.type === type)
      .map((e) => VALUE_BY_ID.get(e.id) as Value)
      .sort((a, b) => valueKey(b.item.id) - valueKey(a.item.id));
    if (rows.length === 0) continue;
    const buyableHere = rows.filter((v) => shopIds.has(v.item.id)).length;
    offShopCount += rows.length - buyableHere;
    push(
      `### 3.${WEAPON_TYPES.indexOf(type) + 1} ${TYPE_LABEL[type]}（${rows.length} 件有标价，` +
        `其中 ${buyableHere} 件本路线能买到）`,
    );
    push();
    if (type === 'staff') {
      push(
        `> 杖的「攻击力」字段是 0，所以后面几列（纯攻击/金 等）**对杖没有意义** —— ` +
          `看耐久、单价、射程就好。真正决定杖价值的是**效果**（隔空治疗 / 群体治疗 / 状态异常 / 修理），` +
          `那不在静态数据里。`,
      );
      push();
    }
    push(
      `| 武器 | 级 | 耐久 | 攻 | 中 | 必 | 重 | 射程 | 单价 | 总价 | 纯攻击/金 | 命中加权/金 | 期望/金 | 追击(终盘) | 含追击期望/金 | 千金额度 |`,
    );
    push(`|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
    for (const v of rows) {
      const e = v.item;
      const mark = shopIds.has(e.id) ? '' : ' †';
      const w = WEIGHTED.get(e.id);
      const chase = w ? `${w.doublers}/${w.users}` : '—';
      const withD = w ? w.effWithDouble.toFixed(2) : '—';
      push(
        `| ${e.name}${mark} | ${e.rank} | ${e.uses} | ${e.might} | ${e.hit} | ${e.crit} | ${e.weight} | ${e.range} | ` +
          `${money(e.unitPrice)} | ${money(e.buyPrice)} | ${v.dmgPerGold.toFixed(2)} | ` +
          `${v.hitDmgPerGold.toFixed(2)} | ${v.effPerGold.toFixed(2)} | ${chase} | ${withD} | ` +
          `${v.usesPer1000.toFixed(0)} |`,
      );
    }
    push();
  }
  push(
    `全表 ${BUYABLE.length} 件有标价的武器里，**${offShopCount} 件带 \`†\`** —— 本路线的商店买不到。`,
  );
  push();

  // ── 8.4 商店 ──────────────────────────────────────────────────────────────
  push(`## 4. 商店什么时候有什么`);
  push();
  const prep = shopsDoc.shops.find((s) => s.mapIndex === null);
  if (prep) {
    push(`**编成准备店**（全程可用，${prep.entries.length} 件）`);
    push();
    push(`| 物品 | 耐久 | 总价 |`);
    push(`|---|---:|---:|`);
    for (const e of prep.entries) push(`| ${e.name} | ${e.uses} | ${money(e.price)} |`);
    push();
  }
  push(`**每章地图商店**（只列本路线会经过的图）`);
  push();
  push(`| 阶段 | 图 | 种类 | 件数 | 新增（相对上一次） |`);
  push(`|---|---|---|---:|---|`);
  const seenSoFar = new Set<number>();
  for (const idx of order) {
    const ch = chapterByIndex.get(idx);
    const phase = phaseOf(idx, route);
    if (phase === null) continue;
    for (const shop of shopsDoc.shops.filter((s) => s.mapIndex === idx)) {
      const fresh = shop.entries.filter((e) => !seenSoFar.has(e.itemId));
      for (const e of shop.entries) seenSoFar.add(e.itemId);
      push(
        `| ${phase} | ${idx} ${ch?.title || `map#${idx}`} | ${shop.kind} | ${shop.entries.length} | ` +
          `${fresh.map((e) => e.name).join('、') || '—'} |`,
      );
    }
  }
  push();

  // ── 8.5 采购清单 ──────────────────────────────────────────────────────────
  push(`## 5. 采购清单`);
  push();
  push(
    `模型：**按编队槽位算，不是按全名单算。** 每张图能上场的战斗单位数 = 该章的 ` +
      `\`deploySlots\`（初始配置块条数 = 游戏的 \`GetChapterAllyUnitCount\`，见 \`chapters.json\`），` +
      `每名上场单位每章出手约 **${ATTACKS_PER_CHAPTER}** 次 → 每次攻击消耗 1 点耐久。`,
  );
  push();
  push(
    `各类型分到的上场名额，按**主力类型**（该单位武器等级最高的那一类）在名单里的比例拆分。` +
      `出手次数 ${ATTACKS_PER_CHAPTER} 是拍的常数，不是 ROM 数据 —— 末尾给出 ±50% 的敏感性。` +
      (plan ? '' : ' ⚠️ 没找到 `dream-of-five.training-plan.json`，改用全体可玩角色。'),
  );
  push();
  push(
    `选武器时按 **含追击的期望/金** 排（§3.0），而且用的是**该阶段自己的速度** —— ` +
      `早期单位还没长起来，带不动的重武器会自动掉下去。每张表都带一列 **\`本阶段追击\`**，` +
      `那就是「现在这件武器带不带得动」的答案；它和 §3 的终盘列会不一样，见本节末尾的说明。`,
  );
  push();

  /** 每个单位的主力类型 = 武器等级最高的那一类。 */
  const primaryCount = new Map<string, number>();
  let primaryTotal = 0;
  for (const u of team) {
    const types = weaponTypesOf(u);
    if (types.length === 0) continue;
    primaryCount.set(types[0] as string, (primaryCount.get(types[0] as string) ?? 0) + 1);
    primaryTotal += 1;
  }

  /** 某阶段能拿到的现金（金箱 + 事件金 + 宝石变卖）。 */
  const phaseIncome = (phase: Phase) =>
    income.goldChest.filter((g) => phaseOf(g.mapIndex, route) === phase).reduce((s, g) => s + g.amount, 0) +
    income.goldEvent.filter((g) => phaseOf(g.mapIndex, route) === phase).reduce((s, g) => s + g.amount, 0) +
    income.gems.filter((g) => phaseOf(g.mapIndex, route) === phase).reduce((s, g) => s + g.sell, 0);

  /**
   * 到某阶段结束时，这名单位大概涨了多少级。
   *
   * 做法是**线性摊派**：`deployments × (该阶段为止的图数 ÷ 全程图数)`。
   * 粗略但单调，而且**早期慢后期快**这件事是对的 —— 分线前 9 张图只占全程的 1/4，
   * 所以那时候单位还没长起来，能带的重量明显更低。这就是为什么 §5 的基础档
   * 可能和 §3 的终盘最优不同（早期会被迫用轻武器换追击）。
   */
  const levelsAt = (f: Fighter, phase: Phase): number => {
    const upto = order.filter((i) => {
      const p = phaseOf(i, route);
      return p !== null && PHASES.indexOf(p) <= PHASES.indexOf(phase);
    }).length;
    return f.levels * (upto / order.length);
  };

  /** 某阶段结束时这名单位的速度。 */
  const spdAt = (f: Fighter, phase: Phase) => projectStat(f.unit, levelsAt(f, phase), 'spd');

  /** 一把武器在某阶段、某类型使用者里的追击表现。 */
  const weightStatsAt = (item: ItemEntry, phase: Phase) => {
    const users = fighters.filter(
      (f) => (f.unit.weaponLevels[item.type] ?? 0) >= item.rankValue,
    );
    if (users.length === 0) return null;
    const doublers = users.filter((f) =>
      doublesWith(spdAt(f, phase), f.con, item.weight, refAs(phase)),
    );
    return { users: users.length, doublers: doublers.length, avgHits: 1 + doublers.length / users.length };
  };

  /** 某阶段的排序键：含追击的期望/金（用**该阶段**的速度，不是终盘）。 */
  const valueKeyIn = (item: ItemEntry, phase: Phase): number => {
    const v = VALUE_BY_ID.get(item.id) as Value;
    const ws = weightStatsAt(item, phase);
    return ws ? v.effPerGold * ws.avgHits : v.effPerGold;
  };

  let carry = 0;
  let grandBase = 0;
  let grandUpgrade = 0;
  const upgradeLines: string[] = [];
  // 用来量化「阶段化到底改了什么」：基础档选品与终盘一致的有几个；
  // 次一档里「选出来这件，队里有人会因此掉追击」的有几个。
  let basePickTotal = 0;
  let basePickSameAsTerminal = 0;
  let upgradeTotal = 0;
  let upgradeDropsDouble = 0;

  for (const phase of PHASES) {
    const maps = order.filter((i) => phaseOf(i, route) === phase);
    if (maps.length === 0) continue;
    const slots = maps.reduce((s, i) => s + (chapterByIndex.get(i)?.deploySlots ?? 0), 0);
    const avgSlots = slots / maps.length;
    const available = buyableInPhase(phase, route);
    const incomeHere = phaseIncome(phase);
    const budget = carry + incomeHere;

    push(
      `### 5.${PHASES.indexOf(phase) + 1} ${phase}` +
        `（${maps.length} 张图，共 ${slots} 个槽位，平均每图 ${avgSlots.toFixed(1)} 人）`,
    );
    push();
    push(`| 类型 | 上场名额 | 需要耐久 | 基础档（本阶段含追击最优） | 重 | 本阶段追击 | 件数 | 花费 |`);
    push(`|---|---:|---:|---|---:|---:|---:|---:|`);
    let baseCost = 0;
    let upgradeCost = 0;

    for (const type of WEAPON_TYPES) {
      const users = team.filter((u) => (u.weaponLevels[type] ?? 0) > 0);
      if (users.length === 0) continue;
      const maxRank = Math.max(...users.map((u) => u.weaponLevels[type] ?? 0));

      const candidates = BUYABLE.filter(
        (e) => e.type === type && available.has(e.id) && e.rankValue <= maxRank,
      ).map((e) => VALUE_BY_ID.get(e.id) as Value);
      if (candidates.length === 0) continue;

      // 基础档 = **本阶段**含追击的期望/金最高的那一件（不是裸期望/金，也不是终盘值）
      // —— 这样带不动、会掉追击的重武器会被自动淘汰，而且早期速度没长起来时
      // 会自然退到更轻的武器上。
      const base = [...candidates].sort(
        (a, b) => valueKeyIn(b.item, phase) - valueKeyIn(a.item, phase),
      )[0] as Value;
      const baseW = weightStatsAt(base.item, phase);

      // 终盘最优（用终盘速度算的排序键）—— 用来量化「阶段化改变了几个选品」。
      const baseTerminal = [...candidates].sort(
        (a, b) => valueKey(b.item.id) - valueKey(a.item.id),
      )[0] as Value;
      basePickTotal += 1;
      if (baseTerminal.item.id === base.item.id) basePickSameAsTerminal += 1;

      const fielded = avgSlots * ((primaryCount.get(type) ?? 0) / Math.max(1, primaryTotal));
      const neededUses = fielded * maps.length * ATTACKS_PER_CHAPTER;
      const count = Math.ceil(neededUses / Math.max(1, base.item.uses));
      const cost = count * base.item.buyPrice;
      baseCost += cost;

      push(
        `| ${TYPE_LABEL[type]} | ${fielded.toFixed(1)} | ${money(Math.round(neededUses))} | ` +
          `${base.item.name}（${money(base.item.buyPrice)}/件） | ${base.item.weight} | ` +
          `${baseW ? `${baseW.doublers}/${baseW.users}` : '—'} | ${count} | ${money(cost)} |`,
      );

      // 次一档 = 攻击力**高于**基础档、且同样按本阶段含追击的期望/金排最前的那一件。
      const better = candidates.filter((c) => c.item.might > base.item.might);
      if (better.length === 0) continue;
      const up = [...better].sort(
        (a, b) => valueKeyIn(b.item, phase) - valueKeyIn(a.item, phase),
      )[0] as Value;
      const upW = weightStatsAt(up.item, phase);
      const upCount = Math.max(1, Math.ceil(fielded));
      const upCost = upCount * up.item.buyPrice;
      upgradeCost += upCost;
      upgradeTotal += 1;
      if (upW && upW.doublers < upW.users) upgradeDropsDouble += 1;
      upgradeLines.push(
        `| ${phase} | ${TYPE_LABEL[type]} | ${up.item.name} | ${up.item.rank} | ${up.item.might} | ` +
          `${up.item.weight} | ${upW ? `${upW.doublers}/${upW.users}` : '—'} | ` +
          `${money(up.item.buyPrice)} | ${upCount} | ${money(upCost)} |`,
      );
    }

    grandBase += baseCost;
    grandUpgrade += upgradeCost;
    const after = budget - baseCost;
    carry = Math.max(0, after);
    push(`| **基础档小计** | | | | | | | **${money(baseCost)}** |`);
    push();
    push(
      `| 项 | 金额 |\n|---|---:|\n` +
        `| 期初结余 | ${money(budget - incomeHere)} |\n` +
        `| 本阶段收入 | ${money(incomeHere)} |\n` +
        `| **可用资金** | **${money(budget)}** |\n` +
        `| 基础档花费 | ${money(baseCost)} |\n` +
        `| **阶段末结余** | **${money(after)}** |`,
    );
    push();
    if (after < 0) {
      push(
        `> ⚠️ 本阶段基础档差 ${money(-after)}。先拿宝箱/村庄发的免费装备顶，只补最缺的那一类。`,
      );
      push();
    }
  }

  push(
    `> **阶段化实际改了什么**：${basePickTotal} 个「阶段 × 类型」里，基础档的**选品**与终盘一致的` +
      `有 ${basePickSameAsTerminal} 个 —— 本 ROM 的 E 级铁系武器同时最便宜也最轻，所以从头到尾都是它。` +
      `真正随阶段变的是「本阶段追击」那一列。所以：**早期省下来的不是武器钱，是追击** —— ` +
      `同样买一把 Iron Blade，分线前只有一部分人追得动，到终盘几乎全员追得动。`,
  );
  push();

  push(`### 5.6 次一档：攻击力更高的那一档`);
  push();
  push(
    `「次一档」= 攻击力**高于**基础档那一件、且**按该阶段含追击的期望/金**排在这一档里最前的。` +
      `注意排序键随阶段变：表里的「追击」列是**这一阶段自己的速度**算出来的 —— ` +
      `同一件武器在「分线前」和「终盘」两行的分母相同、分子不同，越往后能追的人越多，` +
      `所以**早期买重武器等于白买**。数量按「每名该类型上场单位 1 把」估。`,
  );
  push(
    `下面 ${upgradeTotal} 行里有 **${upgradeDropsDouble} 行**选出来的武器是「队里有人会因此掉追击」的 —— ` +
      `这些行**不能整队统一配**，要按 §6 每人的「重量上限」逐个看：速度够的用次一档，` +
      `速度不够的留在基础档反而打得更多。`,
  );
  push();
  push(
    `> ⚠️ **别把这张表当成「该买银系」**。期望/金这个指标天然偏爱便宜货，所以选出来的` +
      `多是**钢系（D 级）**而不是银系/杀手系。真正需要银系 / 杀手系 / 特效系的场合` +
      `（重甲、高防、Boss）在这张表上**看不出来** —— 那取决于对手数据，静态拿不到。` +
      `另外银系**普遍比钢系重**（§3.0 的「带不动的武器」里 Brutal/Silver 系占多数），` +
      `给速度不够的单位上银系是**用掉追击换威力**，不一定是升级。见 §7「该花钱的地方」。`,
  );
  push();
  push(`| 阶段 | 类型 | 次一档 | 级 | 攻 | 重 | 追击 | 单价 | 建议件数 | 花费 |`);
  push(`|---|---|---|---|---:|---:|---:|---:|---:|---:|`);
  for (const l of upgradeLines) push(l);
  push(`| **合计** | | | | | | | | | **${money(grandUpgrade)}** |`);
  push();

  push(`### 5.7 全周目收支对照`);
  push();
  const supply = totalGoldChest + totalGoldEvent + totalGems;
  push(`| 项 | 金额 |`);
  push(`|---|---:|`);
  push(`| 基础档（铁系）满勤消耗 | ${money(grandBase)} |`);
  push(`| 次一档（钢系等，每类型每人 1 把） | ${money(grandUpgrade)} |`);
  push(`| 两项合计 | ${money(grandBase + grandUpgrade)} |`);
  push(`| 确定可得资金 | ${money(supply)} |`);
  push(`| **买完基础档后的余额** | **${money(supply - grandBase)}** |`);
  push(`| **再买次一档后的余额** | **${money(supply - grandBase - grandUpgrade)}** |`);
  push();
  push(
    `敏感性：出手次数取 ${Math.round(ATTACKS_PER_CHAPTER * 0.5)} / ${ATTACKS_PER_CHAPTER} / ` +
      `${Math.round(ATTACKS_PER_CHAPTER * 1.5)} 时，基础档约为 ` +
      `${money(Math.round(grandBase / 2))} / ${money(grandBase)} / ${money(Math.round(grandBase * 1.5))}。`,
  );
  push();
  const surplus = supply - grandBase;
  let conclusion: string;
  if (surplus >= 0) {
    conclusion =
      `基础档（铁系）买得起，剩 ${money(surplus)} 金` +
      (surplus >= grandUpgrade
        ? `，次一档也够（${money(grandUpgrade)}）。`
        : `；次一档要 ${money(grandUpgrade)}，**只能买一半** —— 按 §5.6 从上往下挑，` +
          `而且宝箱/村庄白给的 ${income.freeItems.length} 段装备大多是**次一档/特殊武器**` +
          `（Reforged S 级、Rapier、Killer Lance、Silver Bow、Physic、Fortify、Hammerne），` +
          `正好顶在需要花钱的那一层上，实际缺口比这个数字小。`);
  } else {
    conclusion =
      `「满勤 + 全靠买」差 ${money(-surplus)}。四个杠杆都能填：` +
      `① **出手次数很可能高估** —— 取 ${Math.round(ATTACKS_PER_CHAPTER * 0.5)} 次/章时基础档只要 ` +
      `${money(Math.round(grandBase / 2))}，缺口直接消失；` +
      `② 不是每个槽位都要填满，实际部署往往少于 \`deploySlots\`；` +
      `③ 宝箱/村庄白给的 ${income.freeItems.length} 段装备里也有少量基础档（Steel Sword 等），` +
      `能顶掉一点点采购；` +
      `④ **重量**：次一档里混着「买来就掉追击」的重武器（§3.0），把这一部分换成轻一档，` +
      `少花的是武器钱、多花的只是每回合几次出手 —— 反过来，给速度不够的人硬塞银系，` +
      `等于花两份钱（武器 + 少打的那一次）。`;
  }
  push(`**结论**：${conclusion}`);
  push();

  // ── 8.6 谁用什么 ──────────────────────────────────────────────────────────
  push(`## 6. 人员配置：谁该拿什么`);
  push();
  if (plan) {
    // 全路线可买到的武器（含编成准备店）
    const allAvail = new Set<number>();
    for (const phase of PHASES) for (const id of buyableInPhase(phase, route)) allAvail.add(id);

    /** 某类型在某武器等级下能买到的武器，按用途分两档。 */
    const picksFor = (type: WeaponType, rank: number, f: Fighter) => {
      const cands = BUYABLE.filter(
        (e) => e.type === type && allAvail.has(e.id) && e.rankValue <= rank,
      ).map((e) => VALUE_BY_ID.get(e.id) as Value);
      if (cands.length === 0) return null;
      // 杖的「攻击力」是 0，期望/金 全是 0 —— 按单价从低到高挑，且不给「硬仗档」。
      if (type === 'staff') {
        return {
          daily: [...cands].sort((a, b) => a.item.unitPrice - b.item.unitPrice)[0] as Value,
          punch: null as Value | null,
        };
      }
      // 日常档 = **这名单位自己**含追击的期望/金最高的那一件 —— 不是全队平均。
      // 体格小 / 速度低的单位会自动被推到轻武器上。
      const effFor = (v: Value) =>
        v.effPerGold * (doublesWith(f.spd, f.con, v.item.weight, refAs('终盘')) ? 2 : 1);
      // 硬仗档要求「正常耐久」（≥ 15 次）—— 否则会选出玻璃系（5 次、单价高、
      // 期望/金 很差）。玻璃系不是不能买，是它不该出现在「给谁配什么」这张表里。
      const durable = cands.filter((c) => c.item.uses >= 15);
      return {
        daily: [...cands].sort((a, b) => effFor(b) - effFor(a))[0] as Value,
        punch: (durable.length
          ? [...durable].sort((a, b) => b.item.might - a.item.might)[0]
          : null) as Value | null,
      };
    };

    push(
      `| 角色 | 职业 | 终盘速/体 | 重量上限 | 武器等级 | 日常档（含追击最优） | 硬仗档（攻最高） |`,
    );
    push(`|---|---|---:|---:|---|---|---|`);
    for (const p of plan) {
      const u = team.find((x) => x.id === p.id);
      if (!u) continue;
      const f = fighterById.get(u.id);
      if (!f) continue;
      const types = weaponTypesOf(u);
      const lv = types.map((t) => `${TYPE_LABEL[t]}${rankLetter(u.weaponLevels[t] ?? 0)}`).join(' ');
      const top2 = types.slice(0, 2);
      // 带多重还能追击：`攻速 = spd − max(0, w − con) ≥ 敌攻速 + 4`
      // → `w ≤ con + spd − 敌攻速 − 4`。这张表讲的是**终盘**，所以用终盘的敌攻速。
      const budget = f.con + f.spd - refAs('终盘') - DOUBLE_THRESHOLD;
      const daily = top2
        .map((t) => {
          const pk = picksFor(t, u.weaponLevels[t] ?? 0, f);
          return pk ? `${TYPE_LABEL[t]}: ${pk.daily.item.name}（重 ${pk.daily.item.weight}）` : '';
        })
        .filter(Boolean)
        .join('；');
      const punch = top2
        .map((t) => {
          const pk = picksFor(t, u.weaponLevels[t] ?? 0, f);
          if (!pk?.punch || pk.punch.item.id === pk.daily.item.id) return '';
          const ok = doublesWith(f.spd, f.con, pk.punch.item.weight, refAs('终盘'))
            ? ''
            : ' ⚠️掉追击';
          return `${TYPE_LABEL[t]}: ${pk.punch.item.name}（攻 ${pk.punch.item.might}${ok}）`;
        })
        .filter(Boolean)
        .join('；');
      push(
        `| ${u.name} | ${u.className} | ${f.spd.toFixed(0)}/${f.con} | ` +
          `${budget >= 0 ? budget.toFixed(0) : '**永不追击**'} | ${lv} | ${daily || '—'} | ${punch || '—'} |`,
      );
    }
    push();
    push(
      `> 「武器等级」用的是 ROM 的原始数值换算的等级字母（1–30 E / 31–70 D / 71–120 C / ` +
        `121–180 B / 181–250 A / 251 S）。装备条件是**单位等级 ≥ 武器 rankValue**。`,
    );
    push();
    push(
      `> **「终盘速/体」**= 按训练计划的出场章数投影出来的速度 / 体格（体格不随等级涨）。` +
        `**「重量上限」= \`体格 + 速度 − 终盘敌攻速(${refAs('终盘').toFixed(1)}) − ${DOUBLE_THRESHOLD}\`** —— ` +
        `武器重量不超过它就能追击；显示「永不追击」表示这名单位裸装都追不上。`,
    );
    push();
    push(
      `> 「日常档」= **这名单位自己**含追击的期望/金最高的那一件（所以体格小的单位会被推到轻武器上）；` +
        `「硬仗档」= 该等级下**攻击力最高**的那一件，专门对付高防 / 重甲 / Boss —— ` +
        `标 ⚠️掉追击 的表示为了那点攻击力要牺牲一次出手，值不值自己判断。` +
        `两者都只从**本路线商店**里挑，宝箱/村庄捡到的更强武器不在表内。`,
    );
  } else {
    push(`（缺 \`out/dream-of-five.training-plan.json\`，先跑：`);
    push();
    push(`\`\`\`bash`);
    push(`node scripts/training-plan.ts --json > out/dream-of-five.training-plan.json`);
    push(`\`\`\``);
    push(`再重跑本脚本。）`);
  }
  push();

  // ── 8.7 卖什么 ────────────────────────────────────────────────────────────
  push(`## 7. 卖什么、别买什么`);
  push();
  push(`**该卖的**`);
  push();
  for (const g of income.gems) {
    push(`- **${g.name}**（${g.title}）→ 卖 ${money(g.sell)} 金。宝石除了卖钱没有任何用途。`);
  }
  const sealGroups = new Map<string, number>();
  for (const f of income.freeItems.filter((f) => /Master Seal/i.test(f.name))) {
    sealGroups.set(f.title, (sealGroups.get(f.title) ?? 0) + 1);
  }
  if (sealGroups.size) {
    push(
      `- **多余的 Master Seal**：免费拿到 ${[...sealGroups.entries()].map(([t, n]) => `${n} 个（${t}）`).join('、')}，` +
        `商店 ${firstBuyPhase(route).get(136) ?? '全程'} 起也有卖（${money(itemById.get(136)?.buyPrice ?? 0)} 金）。` +
        `转职石够用就好，多的每个能换 ${money(itemById.get(136)?.sellPrice ?? 0)} 金。`,
    );
  }
  push();
  push(`**不该买的**`);
  push();
  push(
    `- **铁系之外的「Warding」系**：攻击力低到离谱（Warding Sword 攻 2、Warding Lance 攻 4、` +
      `Warding Axe 攻 5），除非明确要它们的特殊效果，否则每一分钱都是浪费。`,
  );
  push(
    `- **玻璃系（Glass）**：耐久只有 5，单价却高（Glass Sword 300/次、Glass Axe 200/次）。` +
      `看着攻击力不错，实际每金输出很差。`,
  );
  push(
    `- **弩车（Ballista）**：不在任何商店里，只能捡；不要为它留预算。`,
  );
  push(
    `- **超重的「大件」**（Brutal Axe 重 20、Brutal Lance 重 19、Battle Axe 重 18）：` +
      `队伍里几乎没人带得动，买来就是**用掉追击 + 减攻速**换一点威力。§3.0 的「带不动的武器」速查` +
      `里有完整名单 —— 那些是**捡到就用、别买**的东西。`,
  );
  push();
  push(`**该花钱的地方**（括号里是**本路线**第一次能买到它的阶段；\`—\` = 本路线买不到）`);
  push();
  const when = (id: number) => firstBuyPhase(route).get(id) ?? '**买不到**';
  const line = (id: number) => {
    const it = itemById.get(id);
    return it ? `${it.name}（${money(it.buyPrice)} 金／${when(id)}）` : `#${id}`;
  };
  push(
    `1. **银系 / 杀手系**：基础铁系的期望/金看着更高，但那是「拿命换的」—— ` +
      `铁系打不动重甲和高防单位，该用银系时用银系。` +
      `银系：${line(4)}、${line(23)}、${line(33)}；` +
      `杀手系：${line(13)}、${line(26)}、${line(36)}。` +
      `⚠️ 银系**比同档钢系重**（§3.0）：给「重量上限」低的单位上银系会**掉追击**，` +
      `实际期望伤害可能还不如拿钢系打两下 —— 先看 §6 每人的「重量上限」再决定。`,
  );
  push(
    `2. **Master Seal**：${line(136)}，一次转职，是全局收益最高的单笔消费。` +
      `注意它**要到合流之后**才有货 —— 分线前那 9 张图只能靠捡。`,
  );
  push(
    `3. **杖**：${line(78)} 能隔空治疗，把治疗者从危险位置解放出来；` +
      `${line(79)} 是全场群体治疗，但**只在终盘卖**，且 C23x 之后就没剩几张图了。`,
  );
  const hammerneAt = firstBuyPhase(route).get(87);
  const hammerneSrc = [
    ...new Set(income.freeItems.filter((f) => /Hammerne/i.test(f.name)).map((f) => f.title)),
  ];
  push(
    `4. **修理杖 Hammerne**：${
      hammerneAt
        ? `${money(itemById.get(87)?.buyPrice ?? 0)} 金／${hammerneAt}。`
        : `本路线**任何商店都不卖** —— 只能靠${
            hammerneSrc.length ? `宝箱（${hammerneSrc.join('、')}）` : '捡'
          }。`
    }优先修银系和特效系，别浪费在铁系上。`,
  );
  push(
    `5. **远程魔法 Bolting / Purge**：同样是 \`†\` 档，本路线买不到。` +
      `商店里能买到的远程手段只有投枪 / 投斧 / 短弓这一档。`,
  );
  push();

  // ── 8.8 局限 ──────────────────────────────────────────────────────────────
  push(`## 8. 这份报告不知道什么`);
  push();
  push(
    `- **重量 / 追击已经进模型**（§3.0）：攻速 = \`速度 − max(0, 重量 − 体格)\`，` +
      `追击条件 \`|攻速差| ≥ ${DOUBLE_THRESHOLD}\`，多打一次按 ×2 计入期望伤害。` +
      `**公式和阈值都是从 ROM 代码里读出来的**（\`BattleLoadAS\` / \`BattleCheckDoubling\`，见 §3.0），` +
      `不是照抄公知。`,
  );
  push(
    `- ✅ **敌方攻速已经接进模型了 —— 不再是拍的常数。** ` +
      `链路是：FE8 **没有敌人表**，敌人和自军共用同一种 20 字节配置记录，` +
      `**是不是敌人由记录自己 \`+3\` 字节的 bits 1–2 决定**（0 自军 / 1 友军 / 2 敌军 / 3 消灭）；` +
      `常规章节的初始敌人在 **START_EVENT（槽 18）** 里用 \`402C0100\` 摆进去，` +
      `增援在 **TURN（槽 0）** 用 \`40050200\` 摆进去。然后 ` +
      `\`敌攻速 = 职业基础速度 + 角色表增量 + 自动升级 − max(0, 武器重量 − 体格)\`，` +
      `四项分别读职业表 \`+0x0E/0x11\`、角色表 \`+12..19\`（**有符号增量**）、` +
      `\`AutolevelUnit @ 0x08018120\`（用职业的 \`enemyGrowths\`，` +
      `\`count = 等级 − 1\`，转职再加一轮 9 / 19）、道具表 \`+23\`。` +
      `产物：\`node src/index.ts enemy-stats … --out out/dream-of-five.enemy-stats.json\`；` +
      `公式与反汇编证据见 \`AGENTS.md\` §3.20。` +
      `⚠️ **仍剩下的三条**：` +
      `① **AI 挑哪把武器读不到** —— 投影取「记录里最重的那把」（对你最有利），` +
      `换成第一把武器中位数只动 0.1–0.3，所以这条基本不影响结论；` +
      `② **自动升级会烧随机数**（\`GetAutoleveledStat\` 里的 \`NextRN_N\`、` +
      `\`GetStatIncrease\` 里的 \`Roll1RN\`），所以每条记录是**区间**、报告取均值；` +
      `③ **遍历是下界** —— 只走到条件表脚本引用得到的配置块，遇到 10 条连续未知指令就放弃，` +
      `所以${enemyStatsDoc ? ` **${enemyStatsDoc.totals.records}** 条敌人记录` : '敌人记录数'}` +
      `是「至少这么多」，不是普查总数（普查脚本按全 ROM 去重，报的是 502 块 / 2723 条）。`,
  );
  push(
    `- **速度是投影值，不是实测值**。按训练计划的「每出场一章涨 1 级」线性外推，` +
      `再按职业上限截断 —— 没算随机成长、没算能力药、没算武器三角对命中的修正。` +
      `⚠️ 追击是**阈值**（差 ≥ 4）而不是连续收益，所以同样的 ±2 速度误差，` +
      `在别的指标上是小事，在追击上是**翻倍级**的差别 —— §6 的「重量上限」请当档位看，别当刻度。`,
  );
  push(
    `- **没有敌人数据**，所以「该买什么武器」只按「每金换多少期望伤害」排序。` +
      `这个指标衡量**效率**，不衡量**够不够** —— 敌人防御一高，便宜的武器就是 0 伤害，` +
      `那时这个比值本身失效。真打起来，特效系（Ridersbane、Armoursmasher、Wyrmslayer）` +
      `对特定兵种**武器威力 ×3**（已从 ROM 核实：\`BattleLoadAttack @0x0802AABC\` 里是 \`×2+×1\`，` +
      `判据 \`IsSlayerApplied\`），实战价值远高于它在这张表上的排名。` +
      `⚠️ 但即便算上 ×3，Ridersbane 的含追击期望/金（0.15 → 0.45）**仍低于钢枪的 0.86** —— ` +
      `所以这不是「特效系被低估」，而是「效率」和「够不够」是两个问题。`,
  );
  push(
    `- **出手次数是拍的**（${ATTACKS_PER_CHAPTER} 次/章/人）。它是敏感性分析里最大的不确定源。`,
  );
  push(
    `- **同一段脚本被多张图共享**。金币/物品按地址去重后归给路线里最早的图，` +
      `所以「某章给了 X 金」的意思是「这张图第一次让这段脚本可达」。`,
  );
  push(
    `- **脚本里的分支会被逐段计入**。遍历器不判分支，遇到 \`400A0000 <ptr>\` 这类条件结构时` +
      `会把每个分支都走一遍 —— 所以「免费装备」的**段数是上界**（C17x 的 Tianlong Jian 3 段、` +
      `C6x 的 Mioritza 2 段、C23x 的 Member Card 2 段）。**金币和宝石不受影响**：` +
      `全 ROM 只有 4 条给钱指令、宝石都来自互不相同的记录，没有重复。`,
  );
  push(
    `- **\`†\` 的武器只出现在「有标价」这个意义上**。${BUYABLE.length} 件里有 ${offShopCount} 件` +
      `本路线买不到（\`@001F\` 秘密屋、原版遗留图的商店、或任何商店都不卖）。` +
      `§5 采购清单只从**本路线商店**里挑，所以不会推荐它们。`,
  );
  push(
    `- **打不开的宝箱**。本 hack 里 56/57 个宝箱的达成标记是 0（正常意味着可以反复触发）。` +
      `ROM 里就是这么写的，报告原样呈现，不替它解释。`,
  );
  push(
    `- **不是每张图都在主线上**。\`@001F\` 遭遇图（世界地图刷怪）里有金箱和事件金，` +
      `它们是否属于单周目取决于玩家会不会去刷 —— 全部列在 §1.2，没有计入任何数字。`,
  );
  push();

  return L.join('\n');
}

function rankLetter(level: number): string {
  if (level <= 0) return '-';
  if (level <= 30) return 'E';
  if (level <= 70) return 'D';
  if (level <= 120) return 'C';
  if (level <= 180) return 'B';
  if (level <= 250) return 'A';
  return 'S';
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. 入口
// ─────────────────────────────────────────────────────────────────────────────

if (asJson) {
  const routes = routeArg ? [routeArg as 'A' | 'B'] : (['A', 'B'] as const);
  const payload: Record<string, unknown> = {};
  for (const r of routes) {
    payload[r] = {
      income: collectIncome(r),
      buyable: Object.fromEntries(
        PHASES.map((p) => [p, [...buyableInPhase(p, r)]]),
      ),
      firstBuyPhase: Object.fromEntries([...firstBuyPhase(r).entries()]),
    };
  }
  console.log(JSON.stringify(payload, null, 1));
} else {
  const routes = routeArg ? [routeArg as 'A' | 'B'] : (['A', 'B'] as const);
  const written: string[] = [];
  let primaryMd = '';
  for (const r of routes) {
    const md = report(r);
    if (r === routes[0]) primaryMd = md;
    // 每条路线一份独立文件，避免后写的把先写的覆盖掉
    const named = join(OUT, `${STEM}.economy-${r}.md`);
    writeFileSync(named, md, 'utf8');
    written.push(named);
  }
  // `dream-of-five.economy.md` 恒为「选定路线」的那份（不指定 --route 时 = A 线），
  // 这样文档里承诺的路径一直存在。
  const primary = join(OUT, `${STEM}.economy.md`);
  writeFileSync(primary, primaryMd, 'utf8');
  written.push(primary);

  for (const w of written) console.log(`Wrote ${w}`);
}
