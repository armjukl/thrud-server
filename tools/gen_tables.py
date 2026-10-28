#!/usr/bin/env python3
"""整表进 TS: 从客户端解密后的 toLua 配置表生成 src/data/tbl/<表名>.ts (第一档 36 张全量行).

为什么要整表: 主线假服此前只有 18 张一次性抽出来的 id 白名单/曲线, 做任何"扣材料 +1 级"的
真逻辑都没有取值面 —— 升级曲线、突破消耗、随机属性池这些列根本不在仓库里。这里出的是
**行级全量**, 由 src/tbl.ts 作唯一取数面。

两棵树必须按行 id 合并, 不是"一棵优先、另一棵只补缺表":
  EXT(外部热更, 行多)        /home/sld/res/phone/luaplain/toLua
  APK(包内建, 有 EXT 没的表)  /home/tmp/apklua_plain/toLua   (sld_1.0.7.1426_bilibili)
实测 LeaderWandSkill_Xls: EXT 只有 15 行、APK 529 行 —— 只取 EXT 会让式杖技能全查不到;
反过来 TalentSkill_Xls EXT 4072 / APK 2933, 只取 APK 会少掉热更的技能。
**同 id 冲突 EXT 胜**(热更就是覆盖包内建)。14 张是 APK-only, 名单见 TIER1 的 [A] 标记。

APK 树只跟 B 服 1426 那份: 本轮只对 B 服可用负责。渠道包 1428 的树(/home/tmp/nearme_plain)
不用 —— 两棵树 3399 个文件里 2222 个不同, 混版本就是两套真相。

用法:
  python3 tools/gen_tables.py --check                只报行数/来源/体量, 不写盘
  python3 tools/gen_tables.py --tier 1               生成 TIER1 全部 + index.ts
  python3 tools/gen_tables.py --tables Skill,Task    点名几张
  python3 tools/gen_tables.py --tier 1 --col-store   强制全部列存(比体量用)

产物是 JSON.parse(一个大字符串) 的形状, 不是类型化对象字面量。这不是风格问题:
本机 2 GB 内存, 4.6 MB 的字面量表让 tsc 161 s 后 OOM; 同样数据走 JSON.parse 形状
3.5 MB 单文件 1.08 s / 215 MB 就过了。别把它"顺手重构成可读对象字面量"。

单表 row 形状超 COL_LIMIT 自动改列存({"c":[cols],"r":[[...]]}, 实测小 3.6 倍),
展开在 src/tbl.ts, 业务代码不感知。
"""
import argparse
import json
import os
import re
import sys

EXT_DIR = '/home/sld/res/phone/luaplain/toLua'
APK_DIR = '/home/tmp/apklua_plain/toLua'
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           'src', 'data', 'tbl')

COL_LIMIT = 4 * 1024 * 1024     # 单表 row 形状超这个字节数就切列存
TOTAL_WARN = 25 * 1024 * 1024   # 总量超这个数提示整体切列存

# 第一档(B1 养成 / B2 武装 / B3 通关 / B4 挂机 / B5 任务 / B6 签到)的取值面。
# [A] = APK-only, EXT 那棵树里没有; 删掉对应批次的表就查不到值。
TIER1 = [
    # B1 养成
    'Leader', 'LeaderLv', 'LeaderBreak', 'LeaderStar', 'LeaderStarlevel',
    'TalentSkill', 'Skill', 'SkillValue', 'LeaderWandSkill',
    'LevelConsume', 'PlayerGrow', 'Common', 'Items', 'ItemTypes', 'FixedReward',
    # B2 武装
    'Weapon', 'WeaponGrow', 'WeaponBreak', 'WeaponRefining', 'WeaponRefiningLock',
    'WeaponLibrary', 'WeaponRandom', 'EquipAttribute', 'Consume',
    # B3 通关
    'TrainLevel', 'MainLevel', 'Drop', 'DropGroup', 'DropSet',
    # B4 挂机
    'HangUpBattle',
    # B5 任务
    'Task', 'TaskDailyActive', 'TaskMissionType',
    # B6 签到
    'SignActivity', 'SignBingo', 'SignMonth',
]

# 只在一棵树里存在的表(用 EXT 口径的表名核对); 报告里点出来, 免得被当成解析失败。
APK_ONLY = {'LeaderLv', 'LevelConsume', 'PlayerGrow', 'WeaponGrow', 'WeaponRefining',
            'WeaponRefiningLock', 'WeaponLibrary', 'EquipAttribute', 'HangUpBattle',
            'TaskDailyActive', 'TaskMissionType', 'SignActivity', 'SignBingo', 'SignMonth'}

CLASS = re.compile(r'^---@class (\w+)_Xls : table', re.M)
DEFAULT_ROW = re.compile(r'^local default = \{', re.M)
TABLE_ASSIGN = re.compile(r'^\w+_Xls =\s*\{', re.M)
NUM = re.compile(r'-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?')
IDENT = re.compile(r'[A-Za-z_]\w*')


def find_table(dirpath, name):
    """按 ---@class <name>_Xls 定位文件(在第 11 行附近), 不记 hash 文件名。"""
    for fn in sorted(os.listdir(dirpath)):
        p = os.path.join(dirpath, fn)
        if not os.path.isfile(p):
            continue
        try:
            with open(p, encoding='utf-8', errors='replace') as f:
                head = f.read(6000)
        except OSError:
            continue
        m = CLASS.search(head)
        if m and m.group(1) == name:
            return p
    return None


class LuaParse(Exception):
    pass


def num(text):
    v = float(text)
    return int(v) if v.is_integer() else v


class Reader:
    """客户端表字面量的一个受限解析器: 数字/字符串/true|false/{} 表/setmetatable/xlsNilTable。

    出现别的(safe_function、string.format 等)直接抛, 宁可生成失败也不要静默给半张表。
    """

    def __init__(self, s):
        self.s = s
        self.i = 0

    def ws(self):
        while self.i < len(self.s):
            c = self.s[self.i]
            if c in ' \t\r\n':
                self.i += 1
            elif c == '-' and self.s.startswith('--', self.i):
                nl = self.s.find('\n', self.i)
                self.i = len(self.s) if nl < 0 else nl + 1
            else:
                return
        return

    def peek(self):
        self.ws()
        return self.s[self.i] if self.i < len(self.s) else ''

    def eat(self, ch):
        if self.peek() != ch:
            raise LuaParse('want %r at %d: %r' % (ch, self.i, self.s[self.i:self.i + 40]))
        self.i += 1

    def string(self):
        q = self.peek()
        out = []
        self.i += 1
        while self.i < len(self.s):
            c = self.s[self.i]
            if c == '\\':
                n = self.s[self.i + 1] if self.i + 1 < len(self.s) else ''
                self.i += 2
                out.append({'n': '\n', 't': '\t', 'r': '\r', '\\': '\\', '"': '"',
                            "'": "'", '/': '/'}.get(n, n))
                continue
            self.i += 1
            if c == q:
                return ''.join(out)
            out.append(c)
        raise LuaParse('unterminated string')

    def number(self):
        m = NUM.match(self.s, self.i)
        if not m:
            raise LuaParse('bad number at %d: %r' % (self.i, self.s[self.i:self.i + 40]))
        self.i = m.end()
        return num(m.group(0))

    def setmetatable_arg(self):
        """setmetatable 的第 2+ 个参数(mt / 具名 default 表)只负责吃掉, 不解析成数据。"""
        c = self.peek()
        if c == ',':
            self.i += 1
            return
        m = IDENT.match(self.s, self.i)
        if m and not NUM.match(self.s, self.i):
            self.i = m.end()
            return
        self.value()

    def value(self):
        c = self.peek()
        if c == '{':
            return self.table()
        if c in '"\'':
            return self.string()
        if c == '-' or c.isdigit():
            return self.number()
        m = IDENT.match(self.s, self.i)
        if not m:
            raise LuaParse('bad value at %d: %r' % (self.i, self.s[self.i:self.i + 40]))
        word = m.group(0)
        self.i = m.end()
        if word == 'true':
            return True
        if word == 'false':
            return False
        if word == 'xlsNilTable':
            return []
        if word == 'setmetatable':
            self.eat('(')
            v = self.value()
            while self.peek() != ')':
                self.setmetatable_arg()
            self.i += 1
            return v
        raise LuaParse('unsupported token %r at %d' % (word, self.i))

    def table(self, collapse=True):
        """Lua 表 -> dict; 纯位置表 -> list。`[k]=v`、`k=v`、`v` 三种写法都吃。

        collapse=False 给最外层用: 那张表的键是行 id, 恰好连号(SignActivity 的 1..7)时
        也不能塌成数组, 否则行 id 就没了。
        """
        self.eat('{')
        pairs, seq = {}, []
        while True:
            c = self.peek()
            if c == '}':
                self.i += 1
                break
            if c == ',':
                self.i += 1
                continue
            if c == '[':
                self.i += 1
                key = self.value()
                self.eat(']')
                self.eat('=')
                pairs[str(key)] = self.value()
                continue
            m = IDENT.match(self.s, self.i)
            if m:
                j = m.end()
                while j < len(self.s) and self.s[j] in ' \t':
                    j += 1
                if j < len(self.s) and self.s[j] == '=' and self.s[j + 1] != '=':
                    pairs[m.group(0)] = self.value_at(j + 1)
                    continue
            seq.append(self.value())
        if collapse and not seq and pairs:
            # 纯 1..n 的整数键 = Lua 的数组列([1]=v,[2]=v), 归一成 list, 让 TS 侧能直接 for/map。
            # 客户端 mt.__index 对这种列的行为就是数组, 留成对象会让 #arr 之类的取值写不出来。
            try:
                idx = sorted(int(k) for k in pairs)
            except ValueError:
                idx = None
            if idx and idx == list(range(1, len(idx) + 1)):
                return [pairs[str(k)] for k in idx]
        if not seq:
            return pairs
        if not pairs:
            return seq
        out = dict(pairs)
        for n, x in enumerate(seq, 1):
            out[str(n)] = x
        return out

    def value_at(self, j):
        self.i = j
        return self.value()


def brace_span(src, start):
    """从 src[start]=='{' 起找到配对的右括号, 跳过字符串里的括号。"""
    depth = 0
    i = start
    in_str = None
    while i < len(src):
        c = src[i]
        if in_str:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
        elif c in '"\'':
            in_str = c
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return src[start:i + 1]
        i += 1
    raise LuaParse('大括号不配对')


def parse_rows(path):
    """<Name>_Xls = {…} -> {id(str): row}。"""
    with open(path, encoding='utf-8', errors='replace') as f:
        src = f.read()
    m = TABLE_ASSIGN.search(src)
    if not m:
        raise LuaParse('%s 里找不到 <Name>_Xls = {' % path)
    tbl = Reader(brace_span(src, src.index('{', m.start()))).table(collapse=False)
    if not isinstance(tbl, dict) or not tbl:
        raise LuaParse('%s 解析出 0 行' % path)
    return {str(k): v for k, v in tbl.items()}


def default_cols(path):
    """local default = {…} 给出这张表的全部列名(行里省略的列在客户端由 mt.__index 兜默认)。"""
    with open(path, encoding='utf-8', errors='replace') as f:
        src = f.read(20000)
    m = DEFAULT_ROW.search(src)
    if not m:
        return []
    try:
        tbl = Reader(brace_span(src, src.index('{', m.start()))).table(collapse=False)
    except LuaParse:
        return []
    return list(tbl) if isinstance(tbl, dict) else []


def merge(name):
    """两棵树按行 id 合并, 同 id EXT 胜。返回 (rows, stats)。"""
    pe, pa = find_table(EXT_DIR, name), find_table(APK_DIR, name)
    if not pe and not pa:
        raise SystemExit('[!] 两棵树里都没有 %s_Xls —— 表名写错, 还是整包没解密?' % name)
    rows, n_ext, n_apk = {}, 0, 0
    if pe:
        re_ = parse_rows(pe)
        rows.update(re_)
        n_ext = len(re_)
    if pa:
        ra = parse_rows(pa)
        n_apk = len(ra)
        for k, v in ra.items():
            if k not in rows:
                rows[k] = v
    src = pa or pe
    return rows, {
        'table': name + '_Xls',
        'extFile': os.path.basename(pe) if pe else '-',
        'apkFile': os.path.basename(pa) if pa else '-',
        'ext': n_ext, 'apk': n_apk, 'total': len(rows),
        'merged': len(rows) - n_ext, 'collide': n_ext + n_apk - len(rows),
        'cols': default_cols(src),
    }


def to_row_shape(rows):
    return {k: v for k, v in rows.items()}


def to_col_shape(rows, cols):
    # k= 带上行 id: 列存的 r 只有顺序, 没有键就回不去 {id: row}(有的表行里根本没有 id 列)。
    return {'k': list(rows), 'c': cols,
            'r': [[row.get(c) for c in cols] if isinstance(row, dict) else None
                  for row in rows.values()]}


def all_cols(rows, defaults):
    seen = []
    for row in rows.values():
        if isinstance(row, dict):
            for k in row:
                if k not in seen:
                    seen.append(k)
    for k in defaults:
        if k not in seen:
            seen.append(k)
    if 'id' in seen:
        seen.remove('id')
        seen.insert(0, 'id')
    return seen


def emit(name, rows, stats, shape):
    cols = all_cols(rows, stats['cols'])
    payload = to_col_shape(rows, cols) if shape == 'col' else to_row_shape(rows)
    # 双编码: 内层是表数据的 JSON, 外层是"一个 JS 字符串字面量"。JSON 字符串转义是 JS 的子集,
    # 所以直接当 TS 字面量用是安全的(非 ASCII 已被 ensure_ascii 打散)。
    lit = json.dumps(json.dumps(payload, ensure_ascii=True, separators=(',', ':')))
    return ('\n'.join([
        '// AUTO-GEN tools/gen_tables.py --tier 1 (do not edit)',
        '// 改表改 tools/gen_tables.py, 手改这份下次就被覆盖。',
        '// table=%s rows=%d srcEXT=%d srcAPK=%d mergedFromAPK=%d collisionEXTWins=%d shape=%s cols=%d' % (
            stats['table'], stats['total'], stats['ext'], stats['apk'],
            stats['merged'], stats['collide'], shape, len(cols)),
        '// EXT=%s APK=%s' % (stats['extFile'], stats['apkFile']),
        '// 树: EXT=%s APK=%s' % (EXT_DIR, APK_DIR),
        "const RAW = %s;" % lit,
        '// 只在真被取到时才 parse: 36 张 12 MB 全在 import 期 parse, 这笔钱就落在起服路径上。',
        'let parsed: any = null;',
        'export function raw(): any {',
        '  if (parsed === null) parsed = JSON.parse(RAW);',
        '  return parsed;',
        '}',
        "export const table = '%s_Xls';" % name,
        '',
    ])).encode('utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tier', type=int, default=None, help='1 = 第一档 36 张')
    ap.add_argument('--tables', default=None, help='逗号分隔表名(不带 _Xls)')
    ap.add_argument('--check', action='store_true', help='只比对不写盘')
    ap.add_argument('--col-store', action='store_true', help='强制全部列存')
    ap.add_argument('--out-dir', default=DEFAULT_OUT)
    a = ap.parse_args()

    if a.tables:
        names = [t.strip().replace('_Xls', '') for t in a.tables.split(',') if t.strip()]
    elif a.tier == 1:
        names = list(TIER1)
    else:
        print(__doc__)
        return 2

    total, sizes, auto_col = 0, [], 0
    for name in names:
        rows, stats = merge(name)
        shape = 'col' if a.col_store else 'row'
        blob = emit(name, rows, stats, shape)
        if not a.col_store and len(blob) > COL_LIMIT:
            shape = 'col'
            blob = emit(name, rows, stats, shape)
            auto_col += 1
        total += len(blob)
        sizes.append((len(blob), name, shape))
        warn = ''
        if stats['total'] and stats['merged'] / stats['total'] > 0.5:
            warn = '   WARN >50% 行来自 APK 补的(EXT 那份明显偏少)'
        only = '  [APK-only]' if name in APK_ONLY else ''
        # 全量数字走 stderr: selftest 只 grep stderr, stdout 留给最后的汇总。
        print('%-20s rows=%-6d EXT=%-5d APK=%-5d merged=%-6d collide=%-6d ts=%9dB %s%s%s' % (
            stats['table'], stats['total'], stats['ext'], stats['apk'],
            stats['merged'], stats['collide'], len(blob), shape, only, warn), file=sys.stderr)
        if not a.check:
            os.makedirs(a.out_dir, exist_ok=True)
            with open(os.path.join(a.out_dir, name + '.ts'), 'wb') as f:
                f.write(blob)
    if not a.check:
        idx = ['// AUTO-GEN tools/gen_tables.py --tier 1 (do not edit)',
               '// 唯一取数面是 src/tbl.ts, 业务代码不要直接 import 这里。', '']
        idx += ["export * as %s from './%s.js';" % (n, n) for n in names]
        with open(os.path.join(a.out_dir, 'index.ts'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(idx) + '\n')
    print('--- %d 张, TS 合计 %.2f MB, 自动切列存 %d 张%s' % (
        len(names), total / 1048576.0, auto_col,
        '   WARN 总量 >25MB, 考虑 --col-store' if total > TOTAL_WARN else ''))
    print('    最大三张: ' + ', '.join('%s=%.2fMB(%s)' % (n, s / 1048576.0, sh)
                                        for s, n, sh in sorted(sizes, reverse=True)[:3]))
    if not a.check:
        print('    已写 -> %s (%d 张 + index.ts)' % (a.out_dir, len(names)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
