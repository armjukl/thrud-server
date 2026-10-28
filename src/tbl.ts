// 客户端配置表的唯一取数面. 36 张整表由 tools/gen_tables.py 生成到 src/data/tbl/ (勿手改).
//
// 为什么只留一个口子:
//  - 产物有两种形状(行存 {id:row} / 列存 {k,c,r}, 单表超 4 MB 自动切), 业务代码不该各判一次;
//  - "表缺行"是要被看见的异常(假服从没查过的 id 突然查了 = 表带错了或 id 是客户端造的),
//    收在这里才能统一计数并打进日志, 而不是散成几十个 `if (!row) return`.
//
// 行里省略的列, 客户端是 `local default` + `mt.__index` 兜的; 这里**不复制那套默认值** ——
// 那会变成第二套真相, 且和客户端热更后的 default 漂移。取数一律用 num/str/arr 显式传兜底,
// 每个兜底值都得是调用点自己论证过的。
import * as TBL from './data/tbl/index.js';

export type TblRow = Record<string, any>;

type Mod = { raw(): any; table: string };

const registry = TBL as unknown as Record<string, Mod>;
const expanded: Record<string, Record<string, TblRow>> = {};
const missed: Record<string, number> = {};

/** 列存 -> 行存. k= 是行 id 数组(生成器带上), 缺了就退回行里的 id 列. */
function toRows(name: string, raw: any): Record<string, TblRow> {
  if (raw && Array.isArray(raw.c) && Array.isArray(raw.r)) {
    const cols: string[] = raw.c;
    const keys: string[] = raw.k || [];
    const out: Record<string, TblRow> = {};
    raw.r.forEach((cells: any[], i: number) => {
      if (!Array.isArray(cells)) return;
      const row: TblRow = {};
      for (let j = 0; j < cols.length; j++) row[cols[j]] = cells[j];
      out[String(keys[i] ?? row.id ?? i)] = row;
    });
    return out;
  }
  return raw as Record<string, TblRow>;
}

function tableOf(name: string): Record<string, TblRow> {
  let t = expanded[name];
  if (t) return t;
  const mod = registry[name];
  if (!mod) {
    throw new Error('tbl: 没有 ' + name + ' 这张表 (名单见 tools/gen_tables.py 的 TIER1, ' +
      '新表要先生成: python3 tools/gen_tables.py --tables ' + name + ')');
  }
  t = toRows(name, mod.raw());
  expanded[name] = t;
  return t;
}

export function has(name: string): boolean {
  return !!registry[name];
}

/** 取一行; 没有就记一次缺行并返回 undefined(调用点自己决定怎么兜). */
export function row(name: string, id: number | string | null | undefined): TblRow | undefined {
  if (id === null || id === undefined) {
    missed[name] = (missed[name] || 0) + 1;
    return undefined;
  }
  const r = tableOf(name)[String(id)];
  if (!r) missed[name] = (missed[name] || 0) + 1;
  return r;
}

export function all(name: string): TblRow[] {
  return Object.values(tableOf(name));
}

export function ids(name: string): string[] {
  return Object.keys(tableOf(name));
}

/** 数字列. 客户端 nil 兜 default, 这里用 dflt 兜 —— 传进来的必须是调用点认过的值. */
export function num(name: string, id: number | string, col: string, dflt = 0): number {
  const r = row(name, id);
  const v = r ? r[col] : undefined;
  return typeof v === 'number' ? v : (typeof v === 'string' && v !== '' && isFinite(Number(v)) ? Number(v) : dflt);
}

export function str(name: string, id: number | string, col: string, dflt = ''): string {
  const r = row(name, id);
  const v = r ? r[col] : undefined;
  return typeof v === 'string' ? v : dflt;
}

/** 数组列(生成器把 Lua 的 [1]=v 连续整数键归一成 list); 非数组列返回空数组. */
export function arr(name: string, id: number | string, col: string): any[] {
  const r = row(name, id);
  const v = r ? r[col] : undefined;
  return Array.isArray(v) ? v : [];
}

/** 某张表里满足条件的行, 按某列升序. 签到/任务这类"按 times 排"的口径收在这. */
export function sorted(name: string, col: string, filter?: (r: TblRow) => boolean): TblRow[] {
  const rows = all(name).filter(r => (filter ? filter(r) : true));
  rows.sort((a, b) => (typeof a[col] === 'number' ? a[col] : 0) - (typeof b[col] === 'number' ? b[col] : 0));
  return rows;
}

/** 某列在某张表里的最大值 —— 技能等级上限这类口径只能从行里扫出来. */
export function maxOf(name: string, col: string, pred?: (r: TblRow) => boolean): number {
  let m = 0;
  for (const r of all(name)) {
    if (pred && !pred(r)) continue;
    const v = r[col];
    if (typeof v === 'number' && v > m) m = v;
  }
  return m;
}

/** 缺行统计, 'LeaderLv:3 Skill:1' 形式; 空串 = 一次没缺. */
export function missReport(): string {
  return Object.keys(missed)
    .filter(k => missed[k] > 0)
    .map(k => k + ':' + missed[k])
    .join(' ');
}

export function resetMissed(): void {
  for (const k of Object.keys(missed)) delete missed[k];
}
