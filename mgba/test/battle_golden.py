#!/usr/bin/env python3
"""独立的 Python 实现，产出 mgba/test/selftest.lua 里战斗模型的黄金数值。

为什么要有这个文件：selftest.lua 里的期望值不能由被测代码自己算出来，否则
「实现错了」和「期望值也错了」会互相抵消。这里按 AGENTS.md §3.17 的反汇编
结论**重写一遍**，两边独立，对上了才算数。

跑法：
    <venv>/bin/python mgba/test/battle_golden.py
"""

MASK = 0xFFFF


# --- RNG -------------------------------------------------------------------
# NextRN @0x08000B88
def step(s):
    s0, s1, s2 = s
    n = ((s1 << 11) | (s0 >> 5)) & MASK
    t = ((s2 << 1) | ((s1 >> 15) & 1)) & MASK
    r = (n ^ t) & MASK
    return [r, s0, s1], r


# NextRN_100 @0x08000C64
def rn100(s):
    s, r = step(s)
    return s, (r * 100) >> 16


# Roll1RN @0x08000CA0 -> 恰好 1 个
def roll1(s, p):
    s, v = rn100(s)
    return s, (1 if p > v else 0)


# Roll2RN @0x08000CB8 -> 恰好 2 个
def roll2(s, p):
    s, a = rn100(s)
    s, b = rn100(s)
    return s, (1 if p > ((a + b) >> 1) else 0)


# --- 战斗 ------------------------------------------------------------------
SKILL_CLASS = {0x4A, 0x4B}
INSTK_IMMUNE = {0x4F, 0x66}
WATTR_BRAVE = 0x20
DOUBLING_MIN = 4


def strike(s, atk, dfn, flags, n):
    """一次出手。返回 (状态, 命中, 必杀, 累计消耗, 伤害, flags)。

    顺序严格照 GenerateCurrentRoundData：未命中在 0x0802B43C 直接跳函数尾，
    所以「守方职业 0x6D/0x6E」的判定和 RollForPierce 都不会执行。
    """
    clean = (flags & 0x1C000) == 0          # bit14 | bit15 | bit16
    clean2 = (flags & 0x1C002) == 0         # 多一条 bit1

    # ① RollForSureShot
    if (clean and atk["classId"] in SKILL_CLASS
            and not (0x35 <= atk["wattr"] <= 0x37)):
        n += 1
        s, r = roll1(s, atk["level"])
        if r:
            flags |= 0x4000

    # ② 命中判定
    if flags & 0x4000:
        hit = True
    else:
        n += 2
        s, r = roll2(s, atk["hit"])
        hit = bool(r)

    # ③ 未命中：到此为止
    if not hit:
        return s, False, False, n, 0, flags

    # ④ 0x0802B2E8：守方职业 0x6D/0x6E
    if clean2 and dfn["classId"] in (0x6D, 0x6E):
        n += 1
        s, _ = roll1(s, atk["level"])

    # ⑤ RollForPierce
    if clean and atk["classId"] in SKILL_CLASS:
        n += 1
        s, r = roll1(s, atk["level"])
        if r:
            flags |= 0x14000

    # ⑥ 必杀判定
    n += 1
    s, r = roll1(s, atk["crit"])
    crit = bool(r)

    # ⑦ 瞬杀判定
    if crit and dfn["classId"] not in INSTK_IMMUNE:
        n += 1
        s, _ = roll1(s, atk["inst"])

    # ⑧ 武器效果 4
    if atk["weffect"] == 4 and atk["luck"] < 30:
        n += 1
        s, _ = roll1(s, 30 - atk["luck"])

    dmg = max(0, atk["atk"] - dfn["def"])
    if crit:
        dmg *= 3
    return s, True, crit, n, dmg, flags


def battle(seed, a, t, flags=0, limit=12):
    s = list(seed)
    hp = [a["hp"], t["hp"]]
    cost = 0
    trace = []

    def unit(i):
        return a if i == 1 else t

    def do(ai, di):
        nonlocal s, flags, cost
        atk, dfn = unit(ai), unit(di)
        times = 2 if (atk["wattr"] & WATTR_BRAVE) else 1
        for _ in range(times):
            if hp[di - 1] <= 0 or hp[ai - 1] <= 0:
                return
            s, hit, crit, n, dmg, flags = strike(s, atk, dfn, flags, 0)
            cost += n
            if hit:
                hp[di - 1] -= dmg
            trace.append((ai, n, hit, crit))

    do(1, 2)
    if hp[0] > 0 and hp[1] > 0:
        do(2, 1)
    if hp[0] > 0 and hp[1] > 0:
        diff = a["as"] - t["as"]
        if diff >= DOUBLING_MIN:
            do(1, 2)
        elif diff <= -DOUBLING_MIN:
            do(2, 1)
    return cost, trace, hp


SEED = (0x1234, 0x5678, 0x9ABC)


def mk(hp, atk, dfn, as_, hit, crit, lvl, cls=0x01, wattr=0, inst=0, luck=10, weff=0):
    return {
        "hp": hp, "atk": atk, "def": dfn, "as": as_, "hit": hit,
        "crit": crit, "level": lvl, "classId": cls,
        "wattr": wattr, "inst": inst, "luck": luck, "weffect": weff,
    }


SCENARIOS = {
    # 不追击：攻速差 2 < 4 -> 各打一下（都命中 = 3 + 3）
    "basic": (mk(24, 11, 0, 12, 87, 4, 5), mk(30, 5, 0, 10, 52, 0, 3)),
    # 攻方追击：攻速差 5 >= 4 -> 攻方多打一下
    "dbl": (mk(24, 11, 0, 12, 87, 4, 5), mk(30, 5, 0, 7, 52, 0, 3)),
    # 勇者武器：攻方每次出手打两下
    "brave": (mk(24, 11, 0, 12, 87, 4, 5, wattr=0x20), mk(30, 5, 0, 10, 52, 0, 3)),
    # 必中职业（0x4A）：命中前多一次必中判定，命中后多一次贯穿判定
    "skill": (mk(24, 11, 0, 12, 87, 4, 5, cls=0x4A), mk(30, 5, 0, 10, 52, 0, 3)),
    # 攻方必不中：只有命中判定的 2 个
    "missA": (mk(24, 11, 0, 12, 0, 4, 5), mk(30, 5, 0, 10, 52, 0, 3)),
    # 一击必杀：守方 HP 只有 5、攻方伤害 20 -> 守方没机会反击
    "kill": (mk(24, 20, 0, 12, 87, 4, 5), mk(5, 5, 0, 7, 52, 0, 3)),
}


def fmt_trace(trace):
    out = []
    for side, n, hit, crit in trace:
        tag = "A" if side == 1 else "T"
        suf = "*" if crit else ("" if hit else "-")
        out.append(f"{tag}{n}{suf}")
    return " ".join(out) if out else "(no exchange)"


if __name__ == "__main__":
    print(f"seed = {SEED[0]:#06x} {SEED[1]:#06x} {SEED[2]:#06x}")
    for name, (a, t) in SCENARIOS.items():
        cost, trace, hp = battle(SEED, a, t)
        print(f"{name:8s} cost={cost:3d}  trace={fmt_trace(trace):24s} "
              f"endHP={hp[0]}/{hp[1]}")

    # --- 单次出手：为每种结果找一个确定的种子 -----------------------------
    # 与其看分布（种子族容易退化），不如搜出「第一个产生该消耗的种子」，
    # 把这个种子硬写进 selftest.lua —— 完全确定，可复现。
    base_a = mk(24, 11, 0, 12, 40, 4, 5)
    base_t = mk(30, 5, 0, 10, 52, 0, 3)

    def find_seed(atk, want_costs, limit=4000):
        found = {}
        for i in range(limit):
            s = [i, 0x0C0D, 0x0E0F]
            _, hit, crit, n, _, _ = strike(s, atk, base_t, 0, 0)
            key = (n, hit, crit)
            if n in want_costs and n not in found:
                found[n] = (i, hit, crit)
            if len(found) == len(want_costs):
                break
        return found

    print("\n单次出手（命中率 40 / 必杀率 4，普通职业）:")
    for n, (i, hit, crit) in sorted(find_seed(base_a, [2, 3]).items()):
        print(f"  cost={n}  seed={i:#06x}  hit={hit} crit={crit}")

    crit_a = mk(24, 11, 0, 12, 40, 100, 5)
    print("单次出手（命中率 40 / 必杀率 100 -> 必杀后多一次瞬杀判定）:")
    for n, (i, hit, crit) in sorted(find_seed(crit_a, [2, 4]).items()):
        print(f"  cost={n}  seed={i:#06x}  hit={hit} crit={crit}")

    skill_a = mk(24, 11, 0, 12, 40, 4, 5, cls=0x4A)
    print("单次出手（职业 0x4A：未命中 -> 3 = 必中1+命中2；命中 -> 5 = 再加贯穿1+必杀1）:")
    for n, (i, hit, crit) in sorted(find_seed(skill_a, [3, 5]).items()):
        print(f"  cost={n}  seed={i:#06x}  hit={hit} crit={crit}")

    # 守方职业 0x6D/0x6E：多一次判定
    def mk_def(cls):
        d = mk(30, 5, 0, 10, 52, 0, 3)
        d["classId"] = cls
        return d
    print("守方职业 0x6D -> 多一个（命中时 3+1=4）:")
    for i in range(200):
        s = [i, 0x0C0D, 0x0E0F]
        _, hit, crit, n, _, _ = strike(s, base_a, mk_def(0x6D), 0, 0)
        if hit:
            print(f"  seed={i:#06x} hit={hit} cost={n}")
            break
