// 武装(式仗): 实例的物化 + 随机数据(WeaponInfo 字段 17/18)的取值与编码.
//
// 为什么收成一个模块: 洗练确认页 (UIWeaponRecastingSuccessCtrl) 用**同一个下标**读 17 与 18 的
// 四列数组 (secondaryKeyList/secondaryValueList/randomPropPoolIndex/randomEquipAttrIndex),
// 短一格就取到 nil 崩在属性行; 而每个取值又必须落回 WeaponRandom/EquipAttribute 的合法域,
// 客户端才解析得出文案与上下限 —— "怎么摇"和"怎么编"只能同源, 不能造数的一份、编码的另一份.
//
// 依赖方向: weapons -> tbl/save/proto/econ. **绝不 import payloads.ts** (HANDLERS 在那边).
import * as pb from "./proto.js";
import * as tbl from "./tbl.js";
import { emptyRand, newWeapon, type SaveData, type SaveWeapon, type SaveWeaponRand } from "./save.js";
import { weaponLevelExp } from "./econ.js";

/** msg.RecastingType: 1=洗随机属性 2=洗随机技能. */
export const RECAST_PROP = 1;
export const RECAST_SKILL = 2;

/** msg.SelectRandomType: 1=保留旧的 2=保留新的. */
export const SELECT_OLD = 1;
export const SELECT_NEW = 2;

/** 默认式仗的 onlyId: 历史号(客户端早就按它索引), 同时也是"这把是谁的默认式仗"的判据. */
const derivedOnlyId = (leaderId: number): string => "7000000" + leaderId;

/**
 * WeaponInfo.defleaderId (required): 客户端 CheckIsDefaultWeapon 判 `>0`, 用它把默认式仗
 * 从武装仓库列表里摘出去 (WeaponDataManager:359/383). 认号不认人: 只有派生号才等于穿戴者,
 * 抽卡/洗出来的实例一律 0 —— 否则"换了人穿的默认杖"会被错标成不可分解.
 */
export function defLeaderOf(w: SaveWeapon): number {
  return w.onlyId === derivedOnlyId(w.leaderId) ? w.leaderId : 0;
}

/** 32 位 LCG (路 B 同式): 同一个 seed 永远摇出同一组数, 重启不跳数. */
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 0x100000000;
  };
}

/** onlyId 是字符串, 折成 32 位种子 (FNV-1a); 洗练再叠一个"第几次"以区分前后两批. */
export function seedOf(onlyId: string, round = 0): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < onlyId.length; i++) h = Math.imul(h ^ onlyId.charCodeAt(i), 0x01000193);
  return (h + Math.imul(round + 1, 0x9e3779b1)) >>> 0;
}

export const grateOf = (cfg: number): number => tbl.num("Weapon", cfg, "grate", 0);

/** 角色默认穿戴的武装配置 id (Leader_Xls.weapon). */
export const leaderWeaponCfg = (leaderId: number): number => tbl.num("Leader", leaderId, "weapon", 0);

/**
 * Common["9910"+grate].value4 = {随机技能数, 随机属性数} —— 与客户端
 * WeaponDataManager.GetWeaponPropAndSkillCount 同一个取法. 实测 1★[0,0] 2★[0,1] 3★[0,2] 4★[1,2] 5★[2,3].
 * (路 B :2458 把这两个下标写反了, 于是它发的 5★ 是 3 技能 2 属性, 面板按 value4[1]=2 只画 2 格.)
 */
export function randSlotCount(cfg: number): { skill: number; prop: number } {
  const v = tbl.arr("Common", "9910" + grateOf(cfg), "value4");
  return { skill: Number(v[0] || 0), prop: Number(v[1] || 0) };
}

// ---------------------------------------------------------------- 表索引

let breakMemo: Map<string, tbl.TblRow> | null = null;
let breakCfgMemo: Set<number> | null = null;
const breakKey = (cfg: number, breach: number): string => cfg + ":" + breach;
const breakRows = (): Map<string, tbl.TblRow> => {
  if (!breakMemo) {
    breakMemo = new Map();
    breakCfgMemo = new Set();
    for (const r of tbl.all("WeaponBreak")) {
      const cfg = Number(r.weaponId || 0);
      breakMemo.set(breakKey(cfg, Number(r.breakLevel || 0)), r);
      breakCfgMemo.add(cfg);
    }
  }
  return breakMemo;
};

/** 本突的突破行 (0 基). */
export function breakRowOf(cfg: number, breach: number): tbl.TblRow | undefined {
  return breakRows().get(breakKey(cfg, breach));
}

/** WeaponBreak_Xls 里有没有这把武器的行: 缺行的客户端 SetRedPointData_Break 会 index 到 nil 崩登录. */
export const hasBreak = (cfg: number): boolean => {
  breakRows();
  return breakCfgMemo!.has(cfg);
};

/** 升到下一突要花的 Consume; 封顶(最后一突)行是 0. */
export function breakConsume(cfg: number, breach: number): number {
  return Number(breakRowOf(cfg, breach)?.consumeId || 0);
}

let refineMemo: Map<number, number> | null = null;

/**
 * 精炼上限 = TalentSkill_Xls 里 skillId == Weapon_Xls[cfg].weaponSkillId[1] 的最大 skillLevel - 1.
 * 客户端 GetRefineMaxLv = #GetRefineXls(), 而 GetRefineXls 是 refine_level_xls[skillLevel-1] 灌出来的
 * 连续键表 —— 数出来的就是"最高级 - 1", **不是** #weaponRefinePower(恒 6, 路 B 用的那个).
 * weaponSkillId 为空(低星) 时客户端自己 #nil; 这里回 0, 由 handler 拒.
 */
export function maxRefineOf(cfg: number): number {
  if (!refineMemo) {
    refineMemo = new Map();
    const bySkill = new Map<number, number>();
    for (const r of tbl.all("TalentSkill")) {
      const sid = Number(r.skillId || 0);
      const lv = Number(r.skillLevel || 0) - 1;
      if (sid > 0 && lv > (bySkill.get(sid) ?? 0)) bySkill.set(sid, lv);
    }
    for (const w of tbl.all("Weapon")) {
      refineMemo.set(Number(w.id), bySkill.get(Number(tbl.arr("Weapon", Number(w.id), "weaponSkillId")[0] || 0)) ?? 0);
    }
  }
  return refineMemo.get(cfg) ?? 0;
}

// ---------------------------------------------------------------- 池与候选

interface PropCand {
  /** WeaponRandom 行 id (= randomPropPoolIndex) */
  pool: number;
  /** EquipAttribute 里的序号, 0 基 (= randomEquipAttrIndex; 客户端会 +1 回去) */
  attrIdx: number;
  /** 属性 id (= secondaryKeyList, 与 CalcPropModelInfo.attributeMap 同域) */
  key: number;
  weight: number;
  skillId: number;
}

interface SkillCand {
  pool: number;
  skillId: number;
  weight: number;
}

const propCandMemo = new Map<number, PropCand[]>();
const skillCandMemo = new Map<number, SkillCand[]>();

/** 属性池: WeaponLibrary[lib].weaponRandomID -> WeaponRandom(valueType=2).skillID -> EquipAttribute 的每一列. */
function propCandidates(lib: number): PropCand[] {
  let c = propCandMemo.get(lib);
  if (c) return c;
  c = [];
  for (const poolId of tbl.arr("WeaponLibrary", lib, "weaponRandomID")) {
    const wr = tbl.row("WeaponRandom", Number(poolId));
    if (!wr || Number(wr.valueType || 0) !== 2) continue;
    const sid = Number(wr.skillID || 0);
    const ea = tbl.row("EquipAttribute", sid);
    if (!ea) continue;
    const types = tbl.arr("EquipAttribute", sid, "attributeType");
    const weights = tbl.arr("EquipAttribute", sid, "attributeRandomWeight");
    types.forEach((t, i) => {
      const key = Number(t || 0);
      if (key > 0) c!.push({ pool: Number(wr.id), attrIdx: i, key, weight: Number(weights[i] || 0) || 1, skillId: sid });
    });
  }
  propCandMemo.set(lib, c);
  return c;
}

/** 技能池: WeaponLibrary[lib] -> WeaponRandom(valueType=1).skillID (客户端按它找文案, 别换成 skillIdExpand). */
function skillCandidates(lib: number): SkillCand[] {
  let c = skillCandMemo.get(lib);
  if (c) return c;
  c = [];
  for (const poolId of tbl.arr("WeaponLibrary", lib, "weaponRandomID")) {
    const wr = tbl.row("WeaponRandom", Number(poolId));
    if (!wr || Number(wr.valueType || 0) !== 1) continue;
    const skillId = Number(wr.skillID || 0);
    if (skillId > 0) c.push({ pool: Number(wr.id), skillId, weight: Number(wr.skillRate || 0) || 1 });
  }
  skillCandMemo.set(lib, c);
  return c;
}

/** 加权不放回抽取: 每轮从"还没用掉"的候选里按 weight 取一条. */
function weightedPick<T>(rng: () => number, items: T[], weight: (t: T) => number): T | undefined {
  let total = 0;
  for (const it of items) total += Math.max(0, weight(it));
  if (total <= 0) return items[0];
  let r = rng() * total;
  for (const it of items) {
    r -= Math.max(0, weight(it));
    if (r < 0) return it;
  }
  return items[items.length - 1];
}

/** 表里的上下限多是 0.0032/33.6 这种, 圆到 6 位小数只为客户展示不出现浮点噪声. */
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** 属性条目实际值落在 EquipAttribute.attributeRange[attrIdx] 的上下限之内. */
function propValue(cand: PropCand, rng: () => number): number {
  const range = tbl.arr("EquipAttribute", cand.skillId, "attributeRange")[cand.attrIdx] as unknown;
  const lo = Array.isArray(range) ? Number(range[0]) : NaN;
  const hi = Array.isArray(range) ? Number(range[1]) : NaN;
  if (!isFinite(lo)) return 0;
  if (!isFinite(hi) || hi <= lo) return lo;
  return round6(lo + rng() * (hi - lo));
}

/**
 * 随机属性评分 (= SecondaryPropInfo.weaponPropScope).
 * 客户端自己算分时, 固定属性那一路加的是 EquipAttribute.attributeRandomRateMax[1]
 * (WeaponDataManager:1003), 而固定行的取值就是 attributeRange[1][1] —— 说明这条数是"每列属性的分值",
 * 与摇出来的具体值无关. 照它累加, 换到不同属性列分数才会变.
 */
export function propScopeOf(r: SaveWeaponRand): number {
  let s = 0;
  for (let i = 0; i < r.key.length; i++) {
    const sid = tbl.num("WeaponRandom", r.poolIdx[i] ?? 0, "skillID", 0);
    s += Number(tbl.arr("EquipAttribute", sid, "attributeRandomRateMax")[r.attrIdx[i] ?? -1] || 0);
  }
  return s;
}

export interface RollKeep {
  /** 整条保留的技能 id (洗属性时把当前技能原样带过去) */
  skill?: number[];
  /** 保留 cur 里第几个属性条目 (0 基, 就是客户端上报的 lockPropKeyIndex) */
  propIdx?: number[];
}

/**
 * 摇一组随机数据. 保留项**按它原来在 cur 里的槽位**放回去, 其余按池补齐到 Common 规定的条数.
 * 槽位不能挪: 确认页(WeaponRecastingView)用同一个 index 左右对照读 17/18, 挪位等于把玩家锁的那条换到别的格.
 * 同一次内技能不重复、属性不撞同一个 key (撞了客户端那套 attrPool 映射会互相盖掉).
 */
export function rollWeapon(cfg: number, seed: number, cur: SaveWeaponRand, keep: RollKeep = {}): SaveWeaponRand {
  const rng = lcg(seed);
  const need = randSlotCount(cfg);
  const skillSlot: (number | null)[] = Array(need.skill).fill(null);
  const propSlot: ({ key: number; val: number; pool: number; attrIdx: number } | null)[] =
    Array(need.prop).fill(null);

  for (const id of keep.skill ?? []) {
    const pos = cur.skill.indexOf(id); // 锁的是技能 id, 槽位取它在生效组里的位置
    if (id <= 0 || pos < 0 || pos >= need.skill || skillSlot[pos] !== null) continue;
    skillSlot[pos] = id;
  }
  for (const idx of keep.propIdx ?? []) {
    if (idx < 0 || idx >= need.prop || idx >= cur.key.length || propSlot[idx] !== null) continue;
    propSlot[idx] = { key: cur.key[idx]!, val: cur.val[idx]!, pool: cur.poolIdx[idx] ?? 0, attrIdx: cur.attrIdx[idx] ?? 0 };
  }

  if (need.skill > skillSlot.filter((x) => x !== null).length) {
    const pool = skillCandidates(tbl.num("Weapon", cfg, "randomskill", 0));
    for (let pos = 0; pos < need.skill; pos++) {
      if (skillSlot[pos] !== null) continue;
      const free = pool.filter((c) => !skillSlot.includes(c.skillId));
      const pick = weightedPick(rng, free, (c) => c.weight);
      if (!pick) break; // 池子比要的条数短: 少给一格, 也好过重复
      skillSlot[pos] = pick.skillId;
    }
  }

  if (need.prop > propSlot.filter((x) => x !== null).length) {
    const pool = propCandidates(tbl.num("Weapon", cfg, "randomstrength", 0));
    for (let pos = 0; pos < need.prop; pos++) {
      if (propSlot[pos] !== null) continue;
      const free = pool.filter((c) => !propSlot.some((s) => s && s.key === c.key));
      const pick = weightedPick(rng, free, (c) => c.weight);
      if (!pick) break;
      propSlot[pos] = { key: pick.key, val: propValue(pick, rng), pool: pick.pool, attrIdx: pick.attrIdx };
    }
  }

  const out = emptyRand();
  for (const x of skillSlot) if (x !== null) out.skill.push(x);
  for (const p of propSlot) {
    if (!p) continue;
    out.key.push(p.key);
    out.val.push(p.val);
    out.poolIdx.push(p.pool);
    out.attrIdx.push(p.attrIdx);
  }

  out.scope = propScopeOf(out);
  // weaponPropScope 同时是"有未确认的属性结果"的标志 (IsRecastingOver 判 ~= 0), 不能摇出 0.
  if (out.key.length && !out.scope) out.scope = 1;
  return out;
}

// ---------------------------------------------------------------- 编码

export const randIsEmpty = (r: SaveWeaponRand): boolean => !r.skill.length && !r.key.length;

const secondaryPropBuf = (r: SaveWeaponRand, scope: number): Buffer =>
  pb.concat(
    ...r.key.map((k) => pb.vfield(1, k)),      // secondaryKeyList
    ...r.val.map((v) => pb.dblfield(2, v)),    // secondaryValueList (repeated double, 逐条非 packed)
    pb.dblfield(4, scope),                     // weaponPropScope —— 必须显式发, 缺字段解码出来是 nil, nil~=0 为真
    ...r.poolIdx.map((i) => pb.vfield(5, i)),  // randomPropPoolIndex (WeaponRandom 行 id)
    ...r.attrIdx.map((i) => pb.vfield(6, i)),  // randomEquipAttrIndex (池内序号, 0 基)
    // growMap=3 客户端从不读, 省掉
  );

/** 字段 17 = 生效中的那组: 技能 + 属性全量. 空组整个字段省略(客户端各处都有 nil 判). */
export function weaponRandomInfoBuf(r: SaveWeaponRand): Buffer {
  if (randIsEmpty(r)) return Buffer.alloc(0);
  return pb.concat(
    ...r.skill.map((id) => pb.vfield(1, id)),
    r.key.length ? pb.bfield(2, secondaryPropBuf(r, r.scope || propScopeOf(r) || 1)) : Buffer.alloc(0),
  );
}

/**
 * 字段 18 = 洗出来还没确认的那组. 两种形状由 IsRecastingOver 反推 (WeaponData:662-669):
 *   洗属性 -> 只带 secondaryPropInfo 且 scope~=0; **不带技能**, 否则技能页也被判成待确认.
 *   洗技能 -> 带新技能 + 属性四列**照抄 17**(scope 发 0), 因为确认页要用同一个下标读两边的属性列.
 * 低星(4★以下)永远摇不出技能, 洗练的确认页会退去读 18 的技能列 -> #nil, 所以那种武器由 handler 直接拒.
 */
export function lastRandomInfoBuf(cur: SaveWeaponRand, pending: SaveWeaponRand, kind: number): Buffer {
  if (kind === RECAST_SKILL) {
    if (!pending.skill.length) return Buffer.alloc(0);
    return pb.concat(
      ...pending.skill.map((id) => pb.vfield(1, id)),
      cur.key.length ? pb.bfield(2, secondaryPropBuf(cur, 0)) : Buffer.alloc(0),
    );
  }
  if (!pending.key.length) return Buffer.alloc(0);
  return pb.bfield(2, secondaryPropBuf(pending, pending.scope || propScopeOf(pending) || 1));
}

/**
 * 字段 18 的编码形状由"待确认的是哪一半"反推 (所以存档里 last 只存重摇的那一半):
 *   技能列非空 -> 洗技能: 带新技能 + 照抄 17 的属性四列(scope 发 0).
 *   否则属性列非空 -> 洗属性: 只带新属性(scope~=0), **不带技能**, 免得技能页也被判成待确认.
 */
export function lastBufFor(rand: SaveWeaponRand, last: SaveWeaponRand): Buffer {
  if (last.skill.length) return lastRandomInfoBuf(rand, last, RECAST_SKILL);
  if (last.key.length) return lastRandomInfoBuf(rand, last, RECAST_PROP);
  return Buffer.alloc(0);
}

/**
 * 1209 "保留新的": 把待确认那一半并进生效组并清 18.
 * 只覆盖被重摇的那一半 —— 另一半在 last 里本来就是空的, 不能拿它去盖 rand.
 */
export function applyPending(cur: SaveWeaponRand, pending: SaveWeaponRand, kind: number): SaveWeaponRand {
  if (kind === RECAST_SKILL) return { ...cur, skill: pending.skill };
  return {
    key: pending.key,
    val: pending.val,
    poolIdx: pending.poolIdx,
    attrIdx: pending.attrIdx,
    skill: cur.skill,
    scope: pending.scope || propScopeOf(pending) || 1,
  };
}

/**
 * 洗练时"整半保留"的那一半: 洗属性不动技能, 洗技能不动属性.
 * 锁定项由 handler 叠进来(锁技能给 skill 列表, 锁属性给 propIdx 列表), 覆盖这里的默认.
 */
export function keepFor(cur: SaveWeaponRand, kind: number): RollKeep {
  return kind === RECAST_SKILL ? { propIdx: cur.key.map((_, i) => i) } : { skill: cur.skill };
}

/** 只保留一半的"待确认"结果 (另一半留在 rand 里, 别存两份真相). */
export function pendingHalf(full: SaveWeaponRand, kind: number): SaveWeaponRand {
  return kind === RECAST_SKILL
    ? { ...emptyRand(), skill: full.skill }
    : { ...full, skill: [] };
}

// ---------------------------------------------------------------- 实例

/** 按 onlyId 找实例 (在完整列表里找, 不按"有突破行"过滤 —— 写操作要能看到被藏起来的那把). */
export function findWeapon(s: SaveData, onlyId: string): SaveWeapon | undefined {
  return s.weapons.find((w) => w.onlyId === onlyId);
}

/** 下发给客户端的实例: 只留有 WeaponBreak 行的 (缺行的会让登录面板 index 到 nil 崩). */
export function weaponInstances(s: SaveData): SaveWeapon[] {
  return materializeWeapons(s).filter((w) => weaponCfgKnown(w.cfg) && hasBreak(w.cfg));
}

/**
 * 某角色当前穿戴的实例. materialize 已保证每人一把, 落不到只可能是
 * "默认杖没有突破行"这种表配置死角 —— 给一把幻影实例, 只为让面板算得出数, 不参与写操作.
 */
export function equippedWeaponOf(s: SaveData, leaderId: number): SaveWeapon {
  return weaponInstances(s).find((w) => w.leaderId === leaderId)
    ?? newWeapon(derivedOnlyId(leaderId), leaderWeaponCfg(leaderId), leaderId);
}

/** 一把武装折算的总经验 (WeaponData:GetCurrentTotalExp: 当前 exp + 逐级的 LevelConsume.exp). */
export function weaponTotalExp(w: SaveWeapon): number {
  let e = w.exp;
  const quality = grateOf(w.cfg);
  for (let lv = w.level - 1; lv >= 1; lv--) e += weaponLevelExp(quality, lv);
  return e;
}

/**
 * 把 s.weapons 补成"唯一真相": 空/撞号的 onlyId 重新发号, 每个角色至少一把已装备的默认式仗,
 * 缺随机数据的补一组确定性摇出的. 只改内存 —— 谁调用谁决定要不要 saveSave.
 *
 * 之所以非要物化: 旧实现每次现编一份列表(不落盘), 洗练/突破/分解写完就丢.
 */
export function materializeWeapons(s: SaveData): SaveWeapon[] {
  // 新号统一 "7000000<n>" (与 econ.grantWeapon 同一套发号, n 来自 s.wSeq 自增).
  const issue = (): string => "7000000" + ++s.wSeq;
  const seen = new Set<string>();
  for (const w of s.weapons) {
    if (!w.onlyId || seen.has(w.onlyId)) w.onlyId = issue();
    seen.add(w.onlyId);
  }

  for (const c of s.characters) {
    if (s.weapons.some((w) => w.leaderId === c.id)) continue;
    const cfg = leaderWeaponCfg(c.id);
    if (!cfg || !hasBreak(cfg)) continue; // 没有突破行的杖发出去就是登录崩
    // 默认式仗优先沿用派生号: 客户端早就按它索引这批实例, defLeaderOf 也认它.
    const id = seen.has(derivedOnlyId(c.id)) ? issue() : derivedOnlyId(c.id);
    seen.add(id);
    s.weapons.push(newWeapon(id, cfg, c.id));
  }

  for (const w of s.weapons) {
    if (!weaponCfgKnown(w.cfg)) continue;
    if (randIsEmpty(w.rand)) w.rand = rollWeapon(w.cfg, seedOf(w.onlyId), emptyRand());
    // 待确认那组(last)不主动造: 只由洗练产生, 否则面板会一直挂着"未保存的洗练结果".
  }
  return s.weapons;
}

/** 配置表里真有这把武器吗 (存档手改/版本差异都可能带进不存在的 id). */
export const weaponCfgKnown = (cfg: number): boolean => !!tbl.row("Weapon", cfg);
