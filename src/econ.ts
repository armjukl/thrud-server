// 经济原语: 扣费 / 发奖 / 经验曲线. 语义逐条对齐路 B mockgs_pc.lua (行号写在函数注释上),
// 但取数一律走 src/tbl.ts 的客户端表, 不自定曲线.
//
// 依赖方向: econ -> save/tbl/gacha. **绝不 import payloads.ts** (HANDLERS 在那边, 会成环),
// 也**不在这层编 protobuf / 发推送** —— 只改存档并把这些改动记进 Effects, 由 handler 决定推什么.
import type { SaveData } from "./save.js";
import { defaultCharacter, newWeapon } from "./save.js";
import { all, arr, num, row } from "./tbl.js";
import { dropAll } from "./gacha.js";
import { log } from "./logger.js";

/** ItemTypes_Xls[typeId].type —— 值取自客户端全局表 (d4fed020…:81 ItemType). */
export const ITEMTYPE = {
  Money: 1,
  Item: 2,
  Weapon: 3,
  Equip: 4,
  Leader: 5,
  Leader_Skin: 6,
  Equip_Skin: 7,
  Hero_Head: 8,
  Hero_Prop: 9,
  Leader_Prop: 10,
  Weapon_Prop: 11,
  Equip_Prop: 12,
  Perk: 16,
} as const;

/** Hero_Prop(type=9) 的 subType 分流: 4=感知/体力 5=导师(统御)经验. */
const SUB_STRENGTH = 4;
const SUB_PLAYER_EXP = 5;

/**
 * 一次操作改到了哪些东西. 存档是唯一的真值, 这里只是"回执", 让 handler 能按客户端要的
 * 通道推对应推送 (changeStrength / changeMoney / leaderAttrChanged / weaponChanged …).
 */
export interface Effects {
  strength: boolean;
  money: number[];
  items: number[];
  /** 新获得的斯露德 id */
  leaders: number[];
  /** 新获得的武装实例 onlyId */
  weapons: string[];
  /** 新解锁的战装(皮肤) id */
  cloths: number[];
  /** 新解锁的武装涂装 id */
  wskin: number[];
  /** 导师经验导致的等级变化 (没升级则 null) */
  player: { oldLevel: number; level: number; exp: number } | null;
}

export const newEffects = (): Effects => ({
  strength: false, money: [], items: [], leaders: [], weapons: [], cloths: [], wskin: [], player: null,
});

/** 把多次操作的Effects并起来 (一个 handler 里既扣又发的时候用). */
export function mergeEffects(a: Effects, b: Effects): Effects {
  return {
    strength: a.strength || b.strength,
    money: [...a.money, ...b.money],
    items: [...a.items, ...b.items],
    leaders: [...a.leaders, ...b.leaders],
    weapons: [...a.weapons, ...b.weapons],
    cloths: [...a.cloths, ...b.cloths],
    wskin: [...a.wskin, ...b.wskin],
    player: b.player || a.player,
  };
}

/** 一条奖励的展示口径 (对应 proto RewardItem 的 itemId/curCount/count). */
export interface RewardItem {
  itemId: number;
  count: number;
}

// ---------------------------------------------------------------- 道具/货币

const num0 = (o: Record<string, unknown>, k: string): number => {
  const n = Number(o[k]);
  return Number.isFinite(n) ? n : 0;
};

/** Items_Xls 行 -> ItemTypes_Xls 行的 (type, subType). 表里没有 = (0,0) 调用方自己判. */
export function itemType(id: number): { type: number; sub: number } {
  const typeId = num("Items", id, "typeId", 0);
  const t = row("ItemTypes", typeId);
  return { type: t ? num0(t, "type") : 0, sub: t ? num0(t, "subType") : 0 };
}

/**
 * 持有量. 体力类(9/4)读 strength —— 它**不在** items 里, 按道具条目去查会永远查不到.
 * items / money 两张表都查: 存档里的归属是历史上按白名单分的, 不该让原语猜.
 */
export function countItem(s: SaveData, id: number): number {
  const { type, sub } = itemType(id);
  if (type === ITEMTYPE.Hero_Prop && sub === SUB_STRENGTH) return s.player.strength;
  const k = String(id);
  return Math.max(s.items[k] ?? 0, 0) + Math.max(s.money[k] ?? 0, 0);
}

const decWhere = (s: SaveData, id: number, n: number): void => {
  const k = String(id);
  const inItems = s.items[k] ?? 0;
  const fromItems = Math.min(inItems, n);
  if (fromItems > 0) s.items[k] = inItems - fromItems;
  const rest = n - fromItems;
  if (rest > 0) s.money[k] = Math.max(0, (s.money[k] ?? 0) - rest);
};

/** 扣道具 (路 B :3880). 体力类扣 strength 并把回算锚点评到此刻; 数量不足一分不扣并返回 false. */
export function costItem(s: SaveData, id: number, n: number, eff: Effects): boolean {
  n = Math.floor(Number(n) || 0);
  if (n <= 0) return true;
  const { type, sub } = itemType(id);
  if (type === ITEMTYPE.Hero_Prop && sub === SUB_STRENGTH) {
    catchUpStrength(s);
    if (s.player.strength < n) return false;
    s.player.strength -= n;
    s.player.strengthRealTime = Math.floor(Date.now() / 1000);
    eff.strength = true;
    return true;
  }
  if (countItem(s, id) < n) return false;
  decWhere(s, id, n);
  eff.items.push(id);
  return true;
}

/** 加钱 (路 B :4705). 货币一律进 money{}, 顶栏靠 Data_Push.changeMoney 刷. */
export function addMoney(s: SaveData, id: number, n: number, eff: Effects): void {
  n = Math.floor(Number(n) || 0);
  if (n === 0) return;
  const k = String(id);
  s.money[k] = Math.max(0, (s.money[k] ?? 0) + n);
  eff.money.push(id);
}

/**
 * 发一件东西 (路 B :4613). 按 ItemTypes.type 分流, **不能统统堆进 items**:
 * 皮肤要当场解锁, 体力/导师经验有各自真通道, 角色/武装要实例化.
 */
export function addItem(s: SaveData, id: number, n: number, eff: Effects): void {
  n = Math.floor(Number(n) || 0);
  if (n <= 0) return;
  const { type, sub } = itemType(id);
  if (type === ITEMTYPE.Money) return addMoney(s, id, n, eff);
  if (type === ITEMTYPE.Hero_Prop) {
    if (sub === SUB_STRENGTH) return addStrength(s, n, eff);
    if (sub === SUB_PLAYER_EXP) {
      addExp(s, n, eff);
      return;
    }
  }
  if (type === ITEMTYPE.Leader) {
    if (grantLeader(s, id)) eff.leaders.push(id);
    return;
  }
  if (type === ITEMTYPE.Weapon) {
    // 武装不是可叠加道具, 必须建实例: 教程 10713/10714 打开替换列表读的就是 weapons[].
    for (let i = 0; i < n; i++) eff.weapons.push(grantWeapon(s, id));
    return;
  }
  if (type === ITEMTYPE.Leader_Skin || type === ITEMTYPE.Equip_Skin) {
    // 战装/涂装不入背包: 进 cloths/wskin 才拥有 (皮肤界面靠 HasSkin 判).
    const use = arr("Items", id, "useParam");
    const target = Number(use[0]) > 0 ? Number(use[0]) : id;
    const bucket = type === ITEMTYPE.Leader_Skin ? s.cloths : s.wskin;
    if (!bucket.includes(target)) bucket.push(target);
    (type === ITEMTYPE.Leader_Skin ? eff.cloths : eff.wskin).push(target);
    return;
  }
  if (type !== ITEMTYPE.Item) log("warn", "econ", `UNROUTED-TYPE item=${id} type=${type} -> 兜底入 items`);
  // Items_Xls 里没有这行就别入包: 客户端 ItemData:Init 对缺行 id 无保护地 index -> 崩.
  if (!row("Items", id)) {
    log("warn", "econ", `DROP-NOT-AN-ITEM item=${id} Items_Xls 无此行`);
    return;
  }
  const k = String(id);
  s.items[k] = (s.items[k] ?? 0) + n;
  eff.items.push(id);
}

// ---------------------------------------------------------------- 消耗

/** Consume_Xls 全量校验 (路 B :3675): 与客户端 ItemManager.CheckConsume 同口径, 先全验再扣. */
export function checkConsume(s: SaveData, cid: number): [boolean, string] {
  const ids = arr("Consume", cid, "itemId");
  const nums = arr("Consume", cid, "num");
  if (!ids.length) return [false, `no-consume ${cid}`];
  for (let i = 0; i < ids.length; i++) {
    const need = Math.floor(Number(nums[i]) || 0);
    if (need > 0 && countItem(s, ids[i]) < need) return [false, `lack ${ids[i]}<${need}`];
  }
  return [true, ""];
}

export function payConsume(s: SaveData, cid: number, eff: Effects): boolean {
  const [ok] = checkConsume(s, cid);
  if (!ok) return false;
  const ids = arr("Consume", cid, "itemId");
  const nums = arr("Consume", cid, "num");
  for (let i = 0; i < ids.length; i++) costItem(s, ids[i], Math.floor(Number(nums[i]) || 0), eff);
  return true;
}

/**
 * 客户端送上来的消耗列表 (repeated ProtoHashInt2Int{key=道具id,value=数量}) ——
 * 主线现在根本不读它. 逐条全量校验够不够, 够了一次性扣掉, 并按 Items_Xls.useParam[1]
 * 折算成经验返还 (路 B :3945). 返回 [经验, 失败原因]; 失败时一分不扣.
 */
export function payItemList(s: SaveData, list: { key: number; value: number }[], eff: Effects): [number, string] {
  let got = 0;
  const plan: [number, number][] = [];
  for (const it of list) {
    const iid = Math.floor(Number(it.key) || 0);
    const cnt = Math.floor(Number(it.value) || 0);
    if (!iid || cnt <= 0) continue;
    if (countItem(s, iid) < cnt) return [0, `lack ${iid}<${cnt}`];
    const use = arr("Items", iid, "useParam");
    got += (Number(use[0]) || 0) * cnt;
    plan.push([iid, cnt]);
  }
  for (const [iid, cnt] of plan) costItem(s, iid, cnt, eff);
  return [got, ""];
}

// ---------------------------------------------------------------- 体力 / 经验

/**
 * 体力离线回算 (路 B :786-819). 客户端 PlayerDataManager 每帧按 GetServerTime()-lastStrengthTime
 * 自己回体, 而 GetServerTime 由登录包 nowTime 反推 —— 所以服务端下发的 strength 与
 * lastStrengthTime 必须成对: 锚点是"上次权威变更的时刻", 不是 now.
 * **只补不削**: 升级/任务发的体力可以溢出上限, 回算不能把它钳回去.
 */
export function catchUpStrength(s: SaveData): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const maxv = playerMaxStrength(s.player.level);
  const anchor = s.player.strengthRealTime;
  if (!(anchor > 0) || s.player.strength >= maxv) {
    s.player.strengthRealTime = nowSec;
    return;
  }
  // Common 10042: value4[1]=回体周期(分钟), value4[2]=每次回几点.
  const c = row("Common", 10042);
  const v4 = arr("Common", 10042, "value4");
  if (!c) return;
  const recT = (Number(v4[0]) || 6) * 60;
  const recN = Number(v4[1]) || 1;
  const elapsed = nowSec - anchor;
  if (recT > 0 && elapsed >= recT) {
    const cycles = Math.floor(elapsed / recT);
    s.player.strength = Math.min(s.player.strength + recN * cycles, maxv);
    s.player.strengthRealTime = s.player.strength >= maxv ? nowSec : anchor + cycles * recT;
  }
}

export function addStrength(s: SaveData, n: number, eff: Effects): void {
  n = Math.floor(Number(n) || 0);
  if (n <= 0) return;
  catchUpStrength(s);
  s.player.strength += n;
  s.player.strengthRealTime = Math.floor(Date.now() / 1000);
  eff.strength = true;
}

/** 某级的体力上限 (PlayerGrow_Xls.power). */
export function playerMaxStrength(lv: number): number {
  return num("PlayerGrow", lv, "power", 100);
}

/** 升到下一级所需经验; 满级/无配置返回 0 = 停止滚级. */
export function playerNeedExp(lv: number): number {
  return num("PlayerGrow", lv, "exp", 0);
}

/** 逐级结算 (路 B :136), guard 防表配错造成死循环. */
export function rollPlayerLv(lv: number, exp: number): [number, number] {
  let l = Math.floor(Number(lv) || 1);
  let e = Math.floor(Number(exp) || 0);
  for (let guard = 0; guard < 400; guard++) {
    const need = playerNeedExp(l);
    if (need > 0 && e >= need) {
      e -= need;
      l += 1;
    } else break;
  }
  return [l, e];
}

/**
 * 导师经验入账 (路 B :4728). 升级附带一笔"当前体力 +addPower" —— 客户端升级弹窗只改
 * maxStrength, 那笔真的加必须由服务端入账, 否则"弹了 +10 却没到账". 返回 [旧等级, 新等级, 余经验].
 */
export function addExp(s: SaveData, n: number, eff: Effects): [number, number, number] {
  const oldLv = s.player.level;
  n = Math.floor(Number(n) || 0);
  if (n <= 0) return [oldLv, oldLv, s.player.exp];
  const [lv, exp] = rollPlayerLv(oldLv, s.player.exp + n);
  s.player.level = lv;
  s.player.exp = exp;
  s.player.maxExp = playerNeedExp(lv);
  eff.player = { oldLevel: oldLv, level: lv, exp };
  if (lv > oldLv) {
    let addP = 0;
    for (let i = oldLv + 1; i <= lv; i++) addP += num("PlayerGrow", i, "addPower", 0);
    if (addP > 0) addStrength(s, addP, eff);
  }
  return [oldLv, lv, exp];
}

// ---------------------------------------------------------------- 角色 / 武装曲线

/** 授予角色: 已有返回 false (重复角色在抽卡里换碎片, 由调用方决定). */
export function grantLeader(s: SaveData, id: number): boolean {
  if (s.characters.some((c) => c.id === id)) return false;
  s.characters.push(defaultCharacter(id));
  return true;
}

/**
 * 授予武装实例, 返回 onlyId. 发号走 s.wSeq 自增 —— 旧的 "7000000"+leaderId 派生号在
 * 一个角色有多把武装时必撞号, 存量派生号不迁移 (按派生识别给 defleaderId).
 */
export function grantWeapon(s: SaveData, cfg: number, leaderId = 0): string {
  const onlyId = "7000000" + ++s.wSeq;
  s.weapons.push(newWeapon(onlyId, cfg, leaderId));
  return onlyId;
}

/** 本突等级上限 = LeaderBreak_Xls[leaderId, breakNum==本突].breakLevel (客户端 HeroData:GetMaxLv 同式). */
export function leaderMaxLv(id: number, breach: number): number {
  let mx = 0;
  for (const r of rowsOf("LeaderBreak")) {
    if (num0(r, "leaderId") === id && (num0(r, "breakNum") || 0) === (breach || 0)) mx = num0(r, "breakLevel");
  }
  return mx;
}

/** 该级升到下一级所需经验: LeaderLv_Xls[lv].levelConsumeId -> LevelConsume_Xls.exp. */
export function leaderLevelExp(lv: number): number {
  const cid = num("LeaderLv", lv, "levelConsumeId", 0);
  return cid ? num("LevelConsume", cid, "exp", 0) : 0;
}

/** 武装本突强化上限 = WeaponBreak_Xls[weaponId, breakLevel==本突].breakGrowLimit. */
export function weaponMaxLv(cfgId: number, breach: number): number {
  let mx = 0;
  for (const r of rowsOf("WeaponBreak")) {
    if (num0(r, "weaponId") === cfgId && (num0(r, "breakLevel") || 0) === (breach || 0)) mx = num0(r, "breakGrowLimit");
  }
  return mx;
}

/** 武装下一级所需经验: WeaponGrow_Xls[quality=Weapon_Xls.grate, level].levelConsumeID -> LevelConsume.exp. */
export function weaponLevelExp(quality: number, lv: number): number {
  for (const r of rowsOf("WeaponGrow")) {
    if (num0(r, "quality") === quality && num0(r, "level") === lv) {
      return num("LevelConsume", num0(r, "levelConsumeID"), "exp", 0);
    }
  }
  return 0;
}

/**
 * 通用滚级 (角色/武装共用): 从 (level, exp) 出发, 封顶 cap, 逐级扣经验.
 * need 缺配置(0) 立即停 —— 表里没这行时宁可停在原地, 也不要凭空造一条曲线.
 */
export function upgradeByExp(
  level: number,
  exp: number,
  cap: number,
  needFor: (lv: number) => number,
): { level: number; exp: number; raised: number } {
  let lv = level;
  let e = exp;
  let raised = 0;
  for (let guard = 0; guard < 400; guard++) {
    if (cap > 0 && lv >= cap) break;
    const need = needFor(lv);
    if (!(need > 0) || e < need) break;
    e -= need;
    lv += 1;
    raised += 1;
  }
  return { level: lv, exp: e, raised };
}

// ---------------------------------------------------------------- 奖励

/** FixedReward_Xls 固定组解析并入账 (路 B :4752). 返回展示用的条数. */
export function fixedRewardItems(s: SaveData, fid: number, eff: Effects): RewardItem[] {
  const out: RewardItem[] = [];
  if (!fid) return out;
  const ids = arr("FixedReward", fid, "rewardGoodId");
  if (!ids.length) return out;
  const lo = arr("FixedReward", fid, "numMin");
  const hi = arr("FixedReward", fid, "numMax");
  for (let i = 0; i < ids.length; i++) {
    const n = Math.floor(Number(hi[i]) || Number(lo[i]) || 1);
    addItem(s, ids[i], n, eff);
    out.push({ itemId: ids[i], count: n });
  }
  return out;
}

/**
 * 奖励 id 多态 (路 B :4781): 既可能指 FixedReward_Xls(固定组), 也可能直接就是 Drop_Xls 的行
 * (实测多个主线关的 passRewardShow 与 passDropId 同一个 id). 只查 FixedReward 会让后者一分钱不发.
 * dropAll 内部已含"不是整批必掉就 roll 一次"的回退, 这里不再补第二次 roll.
 */
export function rewardById(s: SaveData, fid: number, eff: Effects): RewardItem[] {
  if (!fid) return [];
  if (arr("FixedReward", fid, "rewardGoodId").length) return fixedRewardItems(s, fid, eff);
  const rolled = dropAll(fid);
  if (!rolled || !rolled.length) {
    log("warn", "econ", `rewardById(${fid}) 既不是 FixedReward 也不是 Drop`);
    return [];
  }
  const out: RewardItem[] = [];
  for (const d of rolled) {
    addItem(s, d.itemId, d.num, eff);
    out.push({ itemId: d.itemId, count: d.num });
  }
  return out;
}

// 扫表函数用的行缓存 (只存"这一轮进程里读过的那几张表的行数组"; all() 本身是懒 parse).
const rowCache = new Map<string, Record<string, unknown>[]>();
function rowsOf(name: string): Record<string, unknown>[] {
  let v = rowCache.get(name);
  if (!v) {
    v = all(name) as unknown as Record<string, unknown>[];
    rowCache.set(name, v);
  }
  return v;
}
