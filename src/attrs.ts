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

// Attribute/GrowAttribute 行 = [atk,hp,def,en,crit,breakdamage,critrate,critdamage]
// → AttrManager.AttrDef 属性 key: atk=101 hp=100 def=102 en=103 crit=104 breakdamage=305 critrate=201 critdamage=200
const ATTR_COLS: Array<[number, number]> = [[0, 101], [1, 100], [2, 102], [3, 103], [4, 104], [5, 305], [6, 201], [7, 200]];

export type AttrKV = Array<[number, number]>;

const round = (v: number): number => Math.floor(v + 0.5);

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
    m.set(key, round(v));
  }
  return m;
}

// 武装属性(按等级/突破成长), key=属性id. 只保留基础值非 0 的属性(与客户端一致).
export function weaponAttr(cfgId: number, level: number, breach: number): Map<number, number> {
  const m = new Map<number, number>();
  const w = WEAPON[cfgId];
  const base = w ? ATTR[w[2]] : undefined;
  if (!base) return m;
  const br = (WEAPON_BREAK[cfgId] || []).find((b) => b[0] === breach && b[1] > 0);
  const grow = br ? GROWATTR[br[1]] : undefined;
  const add = Math.max(0, level - 1);
  for (const [ci, key] of ATTR_COLS) {
    const bv = base[ci];
    if (bv !== 0) m.set(key, round(bv + (grow ? grow[ci] * add : 0)));
  }
  return m;
}

// 角色终值 = 角色(等级/突破) + 穿戴武装.
export function heroAttrMap(leaderId: number, level: number, breakLv: number, weaponCfg: number, weaponLevel = 1, weaponBreach = 0): AttrKV {
  const m = leaderAttr(leaderId, level, breakLv);
  for (const [k, v] of weaponAttr(weaponCfg, weaponLevel, weaponBreach)) m.set(k, (m.get(k) || 0) + v);
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

// 角色战力: 基础属性折算 + 武装战力 + 累计突破战力.
export function heroPower(leaderId: number, level: number, breakLv: number, weaponCfg: number): number {
  const lm = LEADER[leaderId];
  if (!lm) return 0;
  const base = ATTR[lm[3]];
  let p = 0;
  if (base) p += base[1] * 0.02 + base[2] * 0.02 + base[0] * 0.15 + base[3] * 0.04 + base[4] * 0.04;
  p += weaponPower(weaponCfg, 1, 0);
  for (const bc of LEADER_BREAK[leaderId] || []) if (bc[0] <= breakLv) p += bc[2];
  return round(p);
}
