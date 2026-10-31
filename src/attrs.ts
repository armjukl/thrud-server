// 角色/武装属性与战力计算: 复刻客户端 HeroData:GetAttrByLevel(等级+突破) 与武装属性,
// 数据全部来自客户端表 (src/data/*, 从 res/phone/luaplain 反解).
//
// 口径(与旧版实现一致):
//   角色终值 = 角色(按等级/突破成长) + 当前穿戴武装  —— 真服是服务端预先合好再下发,
//   客户端把"武装并进角色"的那段代码被注释掉了, 所以必须我们合.
import { ATTR } from "./data/attr.js";
import { GROWATTR } from "./data/growattr.js";
import { LEADER_BREAK } from "./data/leaderbreak.js";
import { WEAPON_BREAK } from "./data/weaponbreak.js";
import { LEADER } from "./data/leader.js";
import { WEAPON } from "./data/weapon.js";
import { all } from "./tbl.js";

// Attribute/GrowAttribute 行 = [atk,hp,def,en,crit,breakdamage,critrate,critdamage]
// → AttrManager.AttrDef 属性 key: atk=101 hp=100 def=102 en=103 crit=104 breakdamage=305 critrate=201 critdamage=200
const ATTR_COLS: Array<[number, number]> = [[0, 101], [1, 100], [2, 102], [3, 103], [4, 104], [5, 305], [6, 201], [7, 200]];

export type AttrKV = Array<[number, number]>;

const round = (v: number): number => Math.floor(v + 0.5);

// 百分比属性(201 暴击率 / 200 暴击伤害)在表里存的是**小数**(0.02 = 2%, 0.4 = 40%),
// 跟着其它属性一起取整会全归 0 —— 542 行 Attribute 里非零的这两列没有一行是整数.
// 只清浮点尾差(0.004*7 之类), 不做整数化.
const PERCENT_ATTR = new Set([200, 201]);
const attrValue = (key: number, v: number): number =>
  PERCENT_ATTR.has(key) ? Math.round(v * 1e6) / 1e6 : round(v);

// 角色基础属性(按等级/突破成长), key=属性id.
export function leaderAttr(leaderId: number, level: number, breakLv: number): Map<number, number> {
  const m = new Map<number, number>();
  const lm = LEADER[leaderId];
  const base = lm ? ATTR[lm[3]] : undefined;
  if (!base) return m;
  const breaks = LEADER_BREAK[leaderId] || [];
  const find = (n: number): [number, number, number, number, number] | undefined => breaks.find((b) => b[0] === n);
  for (const [ci, key] of ATTR_COLS) {
    let v = base[ci] || 0;
    for (let i = 0; i <= breakLv; i++) {
      const bc = find(i);
      if (!bc) continue;
      const grow = GROWATTR[bc[3]];
      if (!grow) continue;
      if (i === 0) {
        v += breakLv === 0 ? grow[ci] * (level - 1) : grow[ci] * ((bc[1] || 1) - 1);
      } else if (i < breakLv) {
        const prev = find(i - 1);
        v += grow[ci] * ((bc[1] || 0) - ((prev && prev[1]) || 0));
      } else {
        const prev = find(i - 1);
        v += grow[ci] * (level - ((prev && prev[1]) || 0));
      }
    }
    if (breakLv > 0) {
      for (let i = 1; i <= breakLv; i++) {
        const bc = find(i);
        if (bc && bc[4]) { const ga = GROWATTR[bc[4]]; if (ga) v += ga[ci]; }
      }
    }
    m.set(key, attrValue(key, v));
  }
  return m;
}

// 武装属性(按等级/突破成长), key=属性id. 只保留基础值非 0 的属性(与客户端一致).
// 口径 = 客户端自己的注释(8c78c6be:1069):
//   武装属性值 = 基础(Weapon.attributeID) + Σ各突等级属性(growAttributeID)×本突那几级 + Σ各突突破属性(growAddAttributeID)
// 两头上都要按**分段**算: 每突的成长行不同(突越高每级加得越多), 而 growAddAttributeID 是突破白送的
// 一坨(5★: 突1 +114攻/+2%暴击率/+2.5%暴伤, 突5 +182.4攻/…).整段漏掉就会"升级突破属性不动".
// 各突的等级区间取自 WeaponBreak.breakGrowLimit —— data/weaponbreak.ts 没带这列, 从整表读.
export function weaponAttr(cfgId: number, level: number, breach: number): Map<number, number> {
  const m = new Map<number, number>();
  const w = WEAPON[cfgId];
  const base = w ? ATTR[w[2]] : undefined;
  if (!base) return m;
  const rows = WEAPON_BREAK[cfgId] || [];
  const find = (n: number) => rows.find((r) => r[0] === n);
  const caps: number[] = [];
  for (const r of all("WeaponBreak")) {
    if (Number(r.weaponId) === cfgId) caps[Number(r.breakLevel)] = Number(r.breakGrowLimit) || 0;
  }
  for (const [ci, key] of ATTR_COLS) {
    const bv = base[ci];
    if (bv === 0) continue;
    let v = bv;
    for (let i = 0; i <= breach; i++) {
      const row = find(i);
      const grow = row ? GROWATTR[row[1]] : undefined;
      if (!grow) continue;
      const prev = i === 0 ? 1 : caps[i - 1] || 1; // 本突起始等级 = 上一突的等级上限
      const cap = caps[i] || 0;
      const upto = i < breach ? cap : Math.max(prev, Math.min(level, cap || level));
      v += grow[ci] * Math.max(0, upto - prev);
    }
    for (let i = 1; i <= breach; i++) {
      const row = find(i);
      const add = row ? GROWATTR[row[2]] : undefined;
      if (add) v += add[ci];
    }
    m.set(key, attrValue(key, v));
  }
  return m;
}

// 角色终值 = 角色(等级/突破) + 穿戴武装.
export function heroAttrMap(leaderId: number, level: number, breakLv: number, weaponCfg: number, weaponLevel = 1, weaponBreach = 0): AttrKV {
  const m = leaderAttr(leaderId, level, breakLv);
  for (const [k, v] of weaponAttr(weaponCfg, weaponLevel, weaponBreach)) m.set(k, attrValue(k, (m.get(k) || 0) + v));
  return [...m.entries()].map(([k, v]) => [k, v] as [number, number]);
}

// 武装战力: 基础 weaponBasePower + 强化增量按权重折算.
const W_CAP_W: Array<[number, number]> = [[100, 0.02], [102, 0.02], [101, 0.15], [103, 0.04], [104, 0.04]];
export function weaponPower(cfgId: number, level: number, breach: number): number {
  const w = WEAPON[cfgId];
  if (!w) return 0;
  let p = w[3] || 0;
  const cur = weaponAttr(cfgId, level, breach);
  const zero = weaponAttr(cfgId, 1, 0);
  for (const [k, wt] of W_CAP_W) p += ((cur.get(k) || 0) - (zero.get(k) || 0)) * wt;
  return round(p);
}

// 角色战力: 角色**当前**属性折算 + 穿戴武装战力(按它的等级/突破) + 累计突破战力.
// 两处都得吃等级: 早先写的是"基础行属性 + 1 级 0 突的武装", 于是角色升级、武器升级、武装突破
// 都动不了战力 —— 真机上表现为"战力从来不涨".
export function heroPower(leaderId: number, level: number, breakLv: number, weaponCfg: number, weaponLevel = 1, weaponBreach = 0): number {
  const lm = LEADER[leaderId];
  if (!lm) return 0;
  const self = leaderAttr(leaderId, level, breakLv);
  let p = 0;
  for (const [k, wt] of W_CAP_W) p += (self.get(k) || 0) * wt;
  p += weaponPower(weaponCfg, weaponLevel, weaponBreach);
  for (const bc of LEADER_BREAK[leaderId] || []) if (bc[0] <= breakLv) p += bc[2];
  return round(p);
}
