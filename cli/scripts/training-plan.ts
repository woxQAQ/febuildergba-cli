/**
 * 「该练谁」评估脚本 —— 读 cli/out/*.json（由 `node src/index.ts dump` 产出），
 * 不重新解析 ROM，纯分析层。
 *
 * 用法：node scripts/training-plan.ts [--route=A|B] [--json]
 *
 * 模型（三块，全部来自 ROM 静态数据，没有外部假设）：
 *
 * 1. 出场机会 deployments —— 每条路线按真实章节顺序走一遍：
 *      available(c) = 已加入 且 未被该路线排除
 *      free(c)      = deploySlots(c) − |必上(c) ∩ available(c)|
 *      必上单位在本章 +1；其余单位平分 free(c)
 *    这是「均匀轮换」基线，衡量的是**机会**而不是最优解。
 *
 * 2. 终盘战力 projectedPower —— 每出场一章记 1 级：
 *      lvl = level + deployments
 *      未转职且 lvl ≥ 15 → 加一次 promotionBonuses（转职奖励）
 *      stat = startingStat + growth/100 × (lvl − level)，再按职业 caps 截断
 *    五维和 = str+skl+spd+def+res（不含 HP / 体格，与既有报告口径一致）。
 *
 * 3. 职能稀缺度 —— 杖 / 飞行 / 重甲 / 再动 / 盗贼 / 魔法 / S 级武器。
 *    这是「不能替代」的部分，单独列出，不揉进分数。
 *
 * 评分 score 是**启发式**（权重写死在下面），只用来看相对次序，不是真理。
 */

import { readFileSync } from 'node:fs';
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. 读数据
// ─────────────────────────────────────────────────────────────────────────────

interface Unit {
  id: number;
  name: string;
  nameRaw: string;
  className: string;
  classId: number;
  level: number;
  stats: Record<string, number>;
  startingStats: Record<string, number>;
  growths: Record<string, number>;
  growthTotal: number;
  weaponLevels: Record<string, number>;
  affinity: string;
  mobility: string;
  hasStaff: boolean;
  supportAddress: string;
}

interface ClassRec {
  id: number;
  name: string;
  movement: number;
  promotesToClassId: number;
  promotesTo: string;
  bases: Record<string, number>;
  caps: Record<string, number>;
  promotionBonuses: Record<string, number>;
  weaponLevels: Record<string, number>;
}

interface ForcedEntry {
  id: number;
  name: string;
  everyMap: boolean;
  routeFilter: number;
}

interface Chapter {
  mapIndex: number;
  chapterNumber: number;
  title: string | null;
  deploySlots: number;
  deploySlotsHard: number;
  forcedUnits: ForcedEntry[];
  placements: { id: number; classOverridden: boolean }[];
}

interface JoinEntry {
  id: number;
  name: string;
  joinChapter: number | null;
  joinChapterTitle: string | null;
  joinChapterIsStory: boolean | null;
  joinSource: string;
  earliestEvidenceChapter: number | null;
  note?: string;
}

interface SupportEdge {
  a: number;
  aName: string;
  b: number;
  bName: string;
  initial: number;
  growth: number;
  startingRank: string;
  turnsTo: Record<string, number>;
}

const unitsRaw = load<Record<string, Unit>>('units');
const classesRaw = load<Record<string, ClassRec>>('classes');
const chaptersDoc = load<{
  chapters: Chapter[];
  joinOrder: JoinEntry[];
  limitations: string[];
}>('chapters');
const supportsDoc = load<{ edges: SupportEdge[]; maxTotalSupportLevels: number }>('supports');

const classById = new Map<number, ClassRec>();
for (const k of Object.keys(classesRaw)) classById.set(classesRaw[k].id, classesRaw[k]);

const FIVE = ['str', 'skl', 'spd', 'def', 'res'] as const;

/**
 * 转职状态：本 hack 里未转职职业的 str/skl/spd/def 上限一律 20，
 * 转职职业一律 ≥ 25（见 out/dream-of-five.classes.json）。用它判定。
 */
function isPromoted(c: ClassRec | undefined): boolean {
  return !!c && (c.caps.str ?? 0) >= 25;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 路线顺序
// ─────────────────────────────────────────────────────────────────────────────

/**
 * mapIndex 是地图设置表的行号，不是章节号（章号在两条线上重复）。
 * 这里写死单周目的真实推进顺序 —— 依据 out/dream-of-five.chapters.json 的
 * chapterNumber 与标题（C23x 的章号 23.5 落在 C23 与 C24 之间；Postscript 27.5 在最后）。
 */
const SHARED_PRE = [0, 1, 2, 3, 4, 5, 6, 7, 8]; // index 5 = "Do I Need 5x"，遗留槽（存在与否存疑）
const CROSSROADS = [18];
const ROUTE_A = [9, 10, 11, 12, 13, 14, 15, 16, 17];
const ROUTE_B = [19, 20, 21, 22, 23, 24, 25, 26, 27];
const SHARED_POST = [36, 37, 38, 39, 40, 41, 42, 43];
const LATE_HEAD = [46, 47]; // C22, C23
const C23X = [54]; // 外传，章号 23.5 → 在 C23 之后、C24 之前
const LATE_TAIL = [48, 49, 50]; // C24, C25, C26
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

const ROUTE_EXCLUSIVE: Record<'A' | 'B', number[]> = {
  // A 线专属 9 人 / B 线专属 12 人（既有报告 §2.1，来自加入章节落点）
  A: [],
  B: [],
};
// 由加入章节自动推出，见下方 buildRoster()

// ─────────────────────────────────────────────────────────────────────────────
// 3. 名单
// ─────────────────────────────────────────────────────────────────────────────

const chapterByIndex = new Map<number, Chapter>();
for (const ch of chaptersDoc.chapters) chapterByIndex.set(ch.mapIndex, ch);

const joinById = new Map<number, JoinEntry>();
for (const j of chaptersDoc.joinOrder) joinById.set(j.id, j);

/** 每张图的必上名单（保守读法：route 过滤字节一律视为生效，见既有报告 §3.2） */
const forcedByIndex = new Map<number, Set<number>>();
for (const ch of chaptersDoc.chapters) {
  forcedByIndex.set(ch.mapIndex, new Set(ch.forcedUnits.map((f) => f.id)));
}

interface Roster {
  unit: Unit;
  cls: ClassRec | undefined;
  promoted: boolean;
  joinIndex: number;
  joinTitle: string;
  joinIsExact: boolean;
  joinNote: string;
  growthTotal: number;
  fiveSum: number;
}

const DEBUG_UNITS = new Set([38]); // Rophon：成长总和 1111、0 伙伴，调试单位

/** joinChapter ≥ 55 或为空 = 不可信（加入指令指向无标题的槽位 / 根本没有加入指令） */
function isReliableJoin(j: JoinEntry | undefined): boolean {
  return !!j && j.joinChapter != null && j.joinChapter < 55;
}

function buildRoster(): Roster[] {
  const out: Roster[] = [];
  for (const k of Object.keys(unitsRaw)) {
    const u = unitsRaw[k];
    if (!u.supportAddress) continue; // 「有支援数据」= 可玩名单代理
    if (DEBUG_UNITS.has(u.id)) continue;

    const j = joinById.get(u.id);
    let joinIndex = j?.joinChapter ?? Number.NaN;
    let joinTitle = j?.joinChapterTitle ?? '';
    let joinIsExact = isReliableJoin(j);
    let joinNote = '';

    if (!joinIsExact) {
      // 回退 ①：最早出现证据（placement / recruit / load / cutscene）
      if (j?.earliestEvidenceChapter != null) {
        joinIndex = j.earliestEvidenceChapter;
        joinTitle = j.earliestEvidenceChapterTitle ?? '';
        joinNote = `加入点不可信（原值 ${j.joinChapter ?? 'null'}），按最早出现证据（索引 ${joinIndex}）推`;
      }
      // 回退 ②：强制出击 —— 能在某章被点名必上，就必然已加入（比出现证据更硬）
      const forcedIdx: number[] = [];
      for (const [idx, set] of forcedByIndex) if (set.has(u.id)) forcedIdx.push(idx);
      if (forcedIdx.length) {
        const firstForced = Math.min(...forcedIdx);
        if (Number.isNaN(joinIndex) || firstForced < joinIndex) {
          joinIndex = firstForced;
          joinTitle = chapterByIndex.get(firstForced)?.title ?? '';
          joinNote = `加入点不可信，按最早必上章（索引 ${firstForced}）推 —— 这一条是硬下界`;
        }
      }
    }

    if (Number.isNaN(joinIndex)) {
      joinIndex = Number.POSITIVE_INFINITY; // 连出现证据都没有 → 保守当作拿不到
      joinTitle = '(未知)';
      joinNote = 'ROM 里找不到任何加入证据，按「终盘前不可得」保守处理';
    }

    out.push({
      unit: u,
      cls: classById.get(u.classId),
      promoted: isPromoted(classById.get(u.classId)),
      joinIndex,
      joinTitle,
      joinIsExact,
      joinNote,
      growthTotal: u.growthTotal,
      fiveSum: FIVE.reduce((s, f) => s + (u.startingStats[f] ?? 0), 0),
    });
  }
  return out;
}

const roster = buildRoster();

// 路线专属判定：加入点只落在另一条线中段的单位
function routeExclusive(list: Roster[]): Record<'A' | 'B', Set<number>> {
  const A = new Set<number>();
  const B = new Set<number>();
  for (const r of list) {
    if (!Number.isFinite(r.joinIndex)) continue;
    if (ROUTE_A.includes(r.joinIndex)) A.add(r.unit.id);
    if (ROUTE_B.includes(r.joinIndex)) B.add(r.unit.id);
  }
  return { A, B };
}
const EXCLUSIVE = routeExclusive(roster);

// ─────────────────────────────────────────────────────────────────────────────
// 4. 出场机会 + 终盘战力
// ─────────────────────────────────────────────────────────────────────────────

const LEVELS_PER_CHAPTER = 1; // 每出场一章记 1 级（保守）
const PROMOTION_LEVEL = 15; // 未转职单位达到该等级后视作已转职（吃一次转职奖励）

interface Eval_ {
  id: number;
  name: string;
  className: string;
  level: number;
  promoted: boolean;
  joinIndex: number;
  joinTitle: string;
  joinNote: string;
  fiveSum: number;
  growthTotal: number;
  /** 窗口：从加入到终盘能出场的章数 */
  window: number;
  /** 均匀轮换下的预期出场章数 */
  deployments: number;
  /** 被点名必上的章数 */
  forcedChapters: number;
  /** 满勤上限：全程出场时的终盘五维和（含转职奖励 + 职业上限截断） */
  ceilingFiveSum: number;
  /** 成长空间 = ceiling − fiveSum */
  headroom: number;
  /** 某些章节里是全场唯一承担该职能的人 */
  soloRoles: string[];
  /** 该职能独占的章数 */
  soloChapters: Record<string, number>;
  roles: string[];
  score: number;
}

/** 满勤 levels 级之后的五维和（未转职且越过 PROMOTION_LEVEL 则转职：吃转职奖励 + 换上转职后的上限） */
function projectPower(r: Roster, levels: number): number {
  const lvl = r.unit.level + levels;
  const promoCls = r.cls && r.cls.promotesToClassId ? classById.get(r.cls.promotesToClassId) : undefined;
  const promotesNow = !r.promoted && lvl >= PROMOTION_LEVEL && !!promoCls;
  const caps = (promotesNow ? promoCls!.caps : r.cls?.caps) ?? {};
  const bonus = promotesNow ? r.cls?.promotionBonuses ?? {} : {};
  let sum = 0;
  for (const f of FIVE) {
    const base = (r.unit.startingStats[f] ?? 0) + ((r.unit.growths[f] ?? 0) / 100) * levels;
    const cap = caps[f] ?? 99;
    sum += Math.min(base + (bonus[f] ?? 0), cap);
  }
  return sum;
}

/** 只看「不能替代」的职能 —— 武器种类太容易互换，不列入 */
const ROLE_TAGS = ['杖', '飞行', '重甲', '再动', '盗贼'] as const;

function rolesOf(r: Roster): string[] {
  const tags: string[] = [];
  const u = r.unit;
  if (u.hasStaff) tags.push('杖');
  if (u.mobility === 'flying') tags.push('飞行');
  if (u.mobility === 'mounted') tags.push('骑马');
  if (u.mobility === 'armour') tags.push('重甲');
  if (u.classId === 77 || u.classId === 70) tags.push('再动');
  if (u.classId === 13) tags.push('盗贼');
  if (['anima', 'light', 'dark'].some((w) => (u.weaponLevels[w] ?? 0) > 0)) tags.push('魔法');
  const best = Math.max(...Object.values(u.weaponLevels));
  if (best >= 251) tags.push('S级武器');
  return tags;
}

function evaluate(route: 'A' | 'B'): Eval_[] {
  const order = routeOrder(route);
  const other = route === 'A' ? EXCLUSIVE.B : EXCLUSIVE.A;
  const posOf = new Map<number, number>();
  order.forEach((idx, i) => posOf.set(idx, i));

  const inRoute = roster.filter((r) => !other.has(r.unit.id));
  const posOfUnit = new Map<number, number>();
  for (const r of inRoute) {
    posOfUnit.set(r.unit.id, Number.isFinite(r.joinIndex) ? posOf.get(r.joinIndex) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY);
  }

  // 逐章：可用名单 / 必上 / 自由位 / 各职能的唯一承担者
  interface Snap {
    idx: number;
    forced: Set<number>;
    available: number[];
    free: number;
    candidates: number[];
    soloByRole: Map<string, number[]>;
  }
  const snaps: Snap[] = order.map((idx, pos) => {
    const ch = chapterByIndex.get(idx);
    const forcedAll = forcedByIndex.get(idx) ?? new Set<number>();
    const forced = new Set<number>();
    const available: number[] = [];
    for (const r of inRoute) {
      const p = posOfUnit.get(r.unit.id);
      if (p === undefined || p > pos) continue;
      available.push(r.unit.id);
      if (forcedAll.has(r.unit.id)) forced.add(r.unit.id);
    }
    const candidates = available.filter((id) => !forced.has(id));
    const free = Math.max(0, (ch?.deploySlots ?? 0) - forced.size);

    const soloByRole = new Map<string, number[]>();
    for (const role of ROLE_TAGS) {
      const carriers = inRoute.filter((r) => available.includes(r.unit.id) && rolesOf(r).includes(role));
      if (carriers.length === 1) soloByRole.set(role, [carriers[0].unit.id]);
    }
    return { idx, forced, available, free, candidates, soloByRole };
  });

  const result: Eval_[] = [];

  for (const r of inRoute) {
    const id = r.unit.id;
    const joinPos = posOfUnit.get(id) ?? Number.POSITIVE_INFINITY;

    let deployments = 0;
    let forcedChapters = 0;
    let window = 0;
    const soloChapters: Record<string, number> = {};

    for (const s of snaps) {
      const pos = posOf.get(s.idx) ?? 0;
      if (pos < joinPos) continue;
      window += 1;
      if (s.forced.has(id)) {
        deployments += 1;
        forcedChapters += 1;
      } else if (s.candidates.length > 0) {
        deployments += s.free / s.candidates.length;
      }
      const solo = s.soloByRole;
      for (const [role, ids] of solo) {
        if (ids[0] === id) soloChapters[role] = (soloChapters[role] ?? 0) + 1;
      }
    }

    const ceiling = projectPower(r, window * LEVELS_PER_CHAPTER);
    result.push({
      id,
      name: r.unit.name,
      className: r.unit.className,
      level: r.unit.level,
      promoted: r.promoted,
      joinIndex: r.joinIndex,
      joinTitle: r.joinTitle,
      joinNote: r.joinNote,
      fiveSum: r.fiveSum,
      growthTotal: r.growthTotal,
      window,
      deployments,
      forcedChapters,
      ceilingFiveSum: ceiling,
      headroom: ceiling - r.fiveSum,
      soloRoles: Object.keys(soloChapters),
      soloChapters,
      roles: rolesOf(r),
      score: 0,
    });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 评分（启发式，权重写死）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 权重写死，只用来排相对次序。刻意**不**把「现在就很强」算进去 ——
 * 那是「要不要用」，不是「要不要练」。这里衡量的是**投入价值**。
 */
const W = {
  ceiling: 0.3, // 练满之后的五维和
  window: 0.2, // 能练多少章
  growth: 0.15, // 成长率总和
  forced: 0.15, // 被点名 = 白送的出场
  solo: 0.2, // 独占职能的章数（无人可替）
};

function norm(values: number[]): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return () => 0;
  return (v: number) => (v - min) / (max - min);
}

function score(list: Eval_[]): Eval_[] {
  const soloTotal = (e: Eval_) => Object.values(e.soloChapters).reduce((a, b) => a + b, 0);
  const nCeil = norm(list.map((e) => e.ceilingFiveSum));
  const nWin = norm(list.map((e) => e.window));
  const nGrow = norm(list.map((e) => e.growthTotal));
  const nForced = norm(list.map((e) => e.forcedChapters));
  const nSolo = norm(list.map(soloTotal));
  for (const e of list) {
    e.score =
      100 *
      (W.ceiling * nCeil(e.ceilingFiveSum) +
        W.window * nWin(e.window) +
        W.growth * nGrow(e.growthTotal) +
        W.forced * nForced(e.forcedChapters) +
        W.solo * nSolo(soloTotal(e)));
  }
  return list.sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 输出
// ─────────────────────────────────────────────────────────────────────────────

function fmt(n: number, d = 1): string {
  return n.toFixed(d);
}

function pad(s: string | number, w: number): string {
  const str = String(s);
  // 粗略按显示宽度对齐（CJK 记 2 列）
  let width = 0;
  for (const ch of str) width += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, w - width));
}

function report(route: 'A' | 'B') {
  const list = score(evaluate(route));
  const order = routeOrder(route);
  const other = route === 'A' ? EXCLUSIVE.B : EXCLUSIVE.A;

  console.log(`\n${'='.repeat(120)}`);
  console.log(`路线 ${route} —— 单周目 ${order.length} 张图，可玩角色 ${list.length} 人（另一线专属 ${other.size} 人已排除）`);
  console.log(`${'='.repeat(120)}\n`);

  console.log(
    pad('角色', 12) + pad('职业', 15) + pad('加入', 20) + pad('Lv', 4) + pad('转', 3) +
    pad('五维', 5) + pad('成长', 5) + pad('窗口', 5) + pad('预期', 6) + pad('必上', 5) +
    pad('练满', 5) + pad('空间', 5) + pad('评分', 6) + '职能 / 独占'
  );
  console.log('-'.repeat(170));

  for (const e of list) {
    const join = Number.isFinite(e.joinIndex) ? `[${e.joinIndex}] ${e.joinTitle.slice(0, 15)}` : '(未知)';
    const solo = Object.entries(e.soloChapters).map(([r, n]) => `${r}×${n}`).join(' ');
    console.log(
      pad(e.name, 12) +
        pad(e.className, 15) +
        pad(join, 20) +
        pad(e.level, 4) +
        pad(e.promoted ? '已' : '未', 3) +
        pad(e.fiveSum, 5) +
        pad(e.growthTotal, 5) +
        pad(e.window, 5) +
        pad(fmt(e.deployments), 6) +
        pad(e.forcedChapters, 5) +
        pad(fmt(e.ceilingFiveSum, 0), 5) +
        pad(fmt(e.headroom, 0), 5) +
        pad(fmt(e.score, 0), 6) +
        (e.roles.join('/') || '—') +
        (solo ? `   ⭐独占: ${solo}` : '') +
        (e.joinNote ? `   ⚠️ ${e.joinNote}` : '')
    );
  }

  // 职能覆盖时间线
  console.log(`\n── 稀缺职能覆盖（谁在什么时候可用）${'─'.repeat(60)}`);
  for (const role of ROLE_TAGS) {
    const carriers = list.filter((e) => e.roles.includes(role));
    if (!carriers.length) continue;
    const desc = carriers
      .sort((a, b) => a.joinIndex - b.joinIndex)
      .map((e) => `${e.name}@${Number.isFinite(e.joinIndex) ? e.joinIndex : '?'}`)
      .join(' · ');
    console.log(`${pad(role, 6)} ${carriers.length} 人： ${desc}`);
  }

  // 每章自由位
  const other2 = other;
  const posOf = new Map<number, number>();
  order.forEach((idx, i) => posOf.set(idx, i));
  let totalFree = 0;
  let totalSlots = 0;
  const lines: string[] = [];
  for (const idx of order) {
    const ch = chapterByIndex.get(idx);
    const forcedAll = forcedByIndex.get(idx) ?? new Set<number>();
    const avail = roster.filter((r) => {
      if (other2.has(r.unit.id)) return false;
      const p = Number.isFinite(r.joinIndex) ? posOf.get(r.joinIndex) : undefined;
      return p !== undefined && p <= (posOf.get(idx) ?? 0);
    });
    const forced = avail.filter((r) => forcedAll.has(r.unit.id));
    const slots = ch?.deploySlots ?? 0;
    const free = Math.max(0, slots - forced.length);
    totalFree += free;
    totalSlots += slots;
    lines.push(
      `${String(idx).padStart(2)} ${pad((ch?.title ?? '?').slice(0, 22), 24)} 槽 ${String(slots).padStart(2)}  必上 ${String(forced.length).padStart(2)}  自由 ${String(free).padStart(2)}  可用 ${String(avail.length).padStart(2)}`
    );
  }
  console.log(`\n── 每章编队（槽位 / 必上 / 自由位 / 可用人数）${'─'.repeat(50)}`);
  for (const l of lines) console.log(l);
  console.log(`\n合计：槽位 ${totalSlots} 格，自由位 ${totalFree} 格，单周目 ${order.length} 张图。`);

  // 分阶段小计
  const phaseOf = (idx: number): string => {
    if (SHARED_PRE.includes(idx)) return '分线前 (P–C6x)';
    if (CROSSROADS.includes(idx)) return '分线点 (Crossroads)';
    if (ROUTE_A.includes(idx) || ROUTE_B.includes(idx)) return `本线中段 (C7${route}–C14${route})`;
    if (SHARED_POST.includes(idx)) return '合流 (C15–C21)';
    return '终盘 (C22–Postscript)';
  };
  const phases = new Map<string, { maps: number; slots: number; free: number }>();
  for (const idx of order) {
    const ch = chapterByIndex.get(idx);
    const forcedAll = forcedByIndex.get(idx) ?? new Set<number>();
    const avail = roster.filter((r) => {
      if (other2.has(r.unit.id)) return false;
      const p = Number.isFinite(r.joinIndex) ? posOf.get(r.joinIndex) : undefined;
      return p !== undefined && p <= (posOf.get(idx) ?? 0);
    });
    const free = Math.max(0, (ch?.deploySlots ?? 0) - avail.filter((r) => forcedAll.has(r.unit.id)).length);
    const key = phaseOf(idx);
    const acc = phases.get(key) ?? { maps: 0, slots: 0, free: 0 };
    acc.maps += 1;
    acc.slots += ch?.deploySlots ?? 0;
    acc.free += free;
    phases.set(key, acc);
  }
  console.log(`\n── 分阶段小计${'─'.repeat(70)}`);
  console.log(pad('阶段', 26) + pad('图数', 6) + pad('槽位', 6) + pad('自由位', 8) + '自由位/图');
  for (const [k, v] of phases) {
    console.log(pad(k, 26) + pad(v.maps, 6) + pad(v.slots, 6) + pad(v.free, 8) + fmt(v.free / v.maps, 1));
  }
}

if (asJson) {
  const routes = routeArg ? [routeArg as 'A' | 'B'] : (['A', 'B'] as const);
  const payload: Record<string, unknown> = {};
  for (const r of routes) payload[r] = score(evaluate(r));
  console.log(JSON.stringify(payload, null, 1));
} else if (routeArg === 'A' || routeArg === 'B') {
  report(routeArg);
} else {
  report('A');
  report('B');
}
