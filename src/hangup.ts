// 挂机/外派 (30400-30405) 的会话状态机与数值口径.
//
// 这一份只碰存档与表, 不碰 GS 帧: 回包怎么拼、ShowItem_Push 怎么推, 留在 payloads.ts 的 handler 里.
// 口径全部从客户端 Lua 反推 (HangUpBattleDataMgr / HangUpBattleMsg / UIHangUpBattleCtrl),
// 三条最要命的:
//   1. 单场时长 = **玩家自己那条通关记录的 passTime** (GetPassedMinTime), 不是表里的固定值;
//      客户端算剩余场次是 math.ceil(剩余秒 / 单场秒), passTime=0 直接除零 -> 进度全废.
//   2. state=1 到点时客户端自己会**重发一次 GetHangUpInfo**, 所以读请求必须负责把 1 翻成 2.
//   3. settleInfo 只要带 type 客户端就去查关卡表 (GetMainLevelData(info.id).insType), 查不到就崩 ->
//      挂机不会"新通关一关", 回包里 settleInfo 一律给空消息(有字段、无 type).
import { all, num, row } from "./tbl.js";
import {
  addExp, addStrength, costItem, playerMaxStrength, rewardById,
  type Effects, type RewardItem,
} from "./econ.js";
import { type SaveData, type SaveHangUp } from "./save.js";
import * as pb from "./proto.js";

/** CONST_BattleType 里能挂机的两类 (挂机表与客户端都只认这两个). */
export const HU_MAIN = 1;
export const HU_TRAIN = 2;
/** HangUpBattleState (客户端): 0 未挂机或已领奖 · 1 挂机中 · 2 完成未领. */
export const HU_IDLE = 0;
export const HU_RUNNING = 1;
export const HU_FINISH = 2;
/** 体力在 Items 里的那一行 (typeId 9/4 -> costItem 走 player.strength). */
const STRENGTH_ITEM = 13;

const tableOf = (type: number): string => (type === HU_TRAIN ? "TrainLevel" : "MainLevel");
const key = (levelId: number): string => String(levelId);

/** 这条关有没有通关记录 (挂机入口的 unlockCondition=1 就是"必须已通关"). */
const recordOf = (s: SaveData, type: number, levelId: number) =>
  (type === HU_TRAIN ? s.trainLevels[key(levelId)] : s.levels[key(levelId)]) ?? null;

/**
 * 单场秒数 = 记录里的 passTime; 没记录返回 0, 调用方必须当成"不许挂机".
 * 与客户端 GetPassedMinTime 同源同值: 它读的是我们登录时下发的 MainLevelInfo/TrainLevelInfo.passTime.
 * 有记录就至少有 1 秒 —— 读档经 safePassTime 兜底, 所以开始/扫荡不用再防耗时为 0.
 */
export function singleTime(s: SaveData, type: number, levelId: number): number {
  const pt = Math.floor(recordOf(s, type, levelId)?.passTime ?? 0);
  return pt > 0 ? pt : 0;
}

/** 每场消耗: 主线 powerCost / 训练 strengthCost (客户端 costItemId 恒为 13). */
export function costOf(type: number, levelId: number): number {
  return Math.max(0, Math.floor(num(tableOf(type), levelId, type === HU_TRAIN ? "strengthCost" : "powerCost", 0)));
}

/**
 * 每场奖励 id: 训练本用 reward; 主线用 passDropId —— passRewardShow 与 firstPassReward 是同一个
 * 首通固定包(MainLevel 101101 实测三者 501001/501001), 重复通关的真实产出在 passDropId.
 */
export function rewardOf(type: number, levelId: number): number {
  if (type === HU_TRAIN) return num("TrainLevel", levelId, "reward", 0);
  return num("MainLevel", levelId, "passDropId", 0) || num("MainLevel", levelId, "passRewardShow", 0);
}

const expOf = (type: number, levelId: number): number => num(tableOf(type), levelId, "userExpReward", 0);

/** 单次挂机上限: HangUpBattle_Xls.maxNum 全表取最大 (六行都是 10), 表读不到兜 10. */
export function maxTimes(): number {
  const rows = all("HangUpBattle");
  const m = rows.reduce((a, r) => Math.max(a, Math.floor(Number(r.maxNum) || 0)), 0);
  return m > 0 ? m : 10;
}

/** 会话时间到没到: 1 -> 2 只在"读的时候"翻, 因为客户端是靠重发 GetHangUpInfo 才知道完成. */
export function refreshState(h: SaveHangUp, nowSec: number): boolean {
  if (h.state === HU_RUNNING && nowSec >= h.endTime) {
    h.state = HU_FINISH;
    return true;
  }
  return false;
}

/**
 * 已完成场次, 与客户端同式: times - ceil(剩余秒/单场秒), 剩余秒按 [startTime, endTime] 夹住.
 * 客户端用 math.ceil, 所以刚开始的那一刻也算"0 场完成"以外还要留一整场的时间.
 */
export function doneTimes(h: SaveHangUp, nowSec: number, st: number): number {
  if (!st) return h.times;
  const at = Math.max(Math.min(nowSec, h.endTime), h.startTime);
  const remain = Math.max(0, h.endTime - at);
  const remainTimes = Math.ceil(remain / st);
  return Math.max(0, Math.min(h.times, h.times - remainTimes));
}

/** HangUpInfo{ type=1 levelId=2 times=3 startTime=4 endTime=5 state=6(required int64) } */
export function infoBuf(h: SaveHangUp): Buffer {
  return pb.concat(
    pb.vfield(1, h.type), pb.vfield(2, h.levelId), pb.vfield(3, h.times),
    pb.vfield(4, BigInt(h.startTime)), pb.vfield(5, BigInt(h.endTime)),
    pb.vfield(6, BigInt(h.state)),
  );
}

/** 空 HangUpSettle: required 字段得有, 但里面一个字段都不给 —— 客户端 UpdateLevelInfo 见不到 type 就跳过. */
export const emptySettleBuf = (): Buffer => Buffer.alloc(0);

export function clearSession(h: SaveHangUp): void {
  h.type = 0; h.levelId = 0; h.times = 0; h.startTime = 0; h.endTime = 0; h.state = HU_IDLE;
}

/** 一次挂机操作的结果: deny=不许做; rewards/exp=这次真发出去的东西 (由 payloads 决定怎么推给客户端). */
export interface HangUpOp {
  deny?: string;
  rewards?: RewardItem[];
  /** 这次发的导师经验(总和, 不是每场) */
  exp?: number;
  /** 这次结算的场次数 */
  times?: number;
  /** 这次扣掉的体力 */
  cost?: number;
  /** 这次返还的体力 */
  back?: number;
}

/** 开一场挂机的共同校验: 类型/关卡/通关记录/次数. 通过时返回算好的单场秒与总消耗. */
function checkLevel(s: SaveData, type: number, levelId: number, times: number): { deny?: string; st?: number; cost?: number } {
  if (type !== HU_MAIN && type !== HU_TRAIN) return { deny: `挂机类型 ${type} 不是主线(1)/训练(2)` };
  if (!row(tableOf(type), levelId)) return { deny: `${tableOf(type)} 表里没 ${levelId}` };
  if (!recordOf(s, type, levelId)) return { deny: `${levelId} 还没通关, 不能挂机` };
  if (!Number.isInteger(times) || times < 1 || times > maxTimes()) return { deny: `次数 ${times} 不在 1..${maxTimes()}` };
  return { st: singleTime(s, type, levelId), cost: costOf(type, levelId) * times };
}

/** 发 n 场奖励 + 经验, 并把这关的进本次数记上. */
function settle(s: SaveData, eff: Effects, type: number, levelId: number, times: number): { rewards: RewardItem[]; exp: number } {
  const rid = rewardOf(type, levelId);
  const merged = new Map<number, number>();
  for (let i = 0; i < times; i++) {
    for (const r of rewardById(s, rid, eff)) merged.set(r.itemId, (merged.get(r.itemId) ?? 0) + r.count);
  }
  const exp = expOf(type, levelId) * times;
  if (exp > 0) addExp(s, exp, eff);
  const rec = recordOf(s, type, levelId);
  if (rec) {
    rec.todayAttackNum += times;
    rec.attackNum += times;
    rec.lastAttackTime = Date.now();
  }
  const rewards = [...merged.entries()].map(([itemId, count]) => ({ itemId, count }));
  return { rewards, exp };
}

export function startHangUp(s: SaveData, eff: Effects, type: number, levelId: number, times: number, nowSec: number): HangUpOp {
  const h = s.hangUp;
  if (h.state !== HU_IDLE) return { deny: `已有挂机(state=${h.state}) 未结束` };
  const c = checkLevel(s, type, levelId, times);
  if (c.deny) return { deny: c.deny };
  const cost = c.cost ?? 0;
  if (cost > 0 && !costItem(s, STRENGTH_ITEM, cost, eff)) {
    return { deny: `感知不足: 需 ${cost} 只有 ${s.player.strength}` };
  }
  h.type = type; h.levelId = levelId; h.times = times;
  h.startTime = nowSec; h.endTime = nowSec + times * (c.st ?? 0); h.state = HU_RUNNING;
  return { cost };
}

/** 领取: 只在 state=2 时结算全部场次. 到点却没读过的会话在这里补翻状态. */
export function receiveHangUpReward(s: SaveData, eff: Effects, nowSec: number): HangUpOp {
  const h = s.hangUp;
  if (h.state === HU_IDLE) return { deny: "没有待领的挂机" };
  refreshState(h, nowSec);
  if (h.state !== HU_FINISH) return { deny: `还差 ${Math.max(0, h.endTime - nowSec)} 秒才挂完` };
  const op = settle(s, eff, h.type, h.levelId, h.times);
  const times = h.times;
  clearSession(h);
  return { ...op, times };
}

/**
 * 召回: 已完成场次照常结算(不结算就凭空丢了), 未开始场次的体力按 (times-done)*单价 返还且不超上限.
 * 客户端确认框(8007)就是照这个口径写的文案.
 */
export function cancelHangUp(s: SaveData, eff: Effects, nowSec: number): HangUpOp {
  const h = s.hangUp;
  if (h.state === HU_IDLE) return { deny: "没在挂机, 召回无意义" };
  refreshState(h, nowSec);
  const st = singleTime(s, h.type, h.levelId);
  const done = st ? doneTimes(h, nowSec, st) : h.times;
  const left = Math.max(0, h.times - done);
  const cap = playerMaxStrength(s.player.level);
  const want = costOf(h.type, h.levelId) * left;
  const back = Math.min(want, Math.max(0, cap - s.player.strength));
  if (back > 0) addStrength(s, back, eff);
  const op = done > 0 ? settle(s, eff, h.type, h.levelId, done) : { rewards: [] as RewardItem[], exp: 0 };
  clearSession(h);
  return { ...op, times: done, back };
}

/**
 * 加速: 把剩余时间砍掉 times 个单场 (= endTime 前移), 于是 done 自然涨 times.
 * 我方 HangUpBattle_Xls 没有 jumpItemId/jumpItemNum 两列, 且六行 modelSwitch 都是 2(NoSpeedUp)
 * -> 界面根本不给加速按钮, 这条只能被协议打到; 因此不扣加速道具, 只做时间前移.
 */
export function speedUpHangUp(s: SaveData, times: number, nowSec: number): HangUpOp {
  const h = s.hangUp;
  if (h.state !== HU_RUNNING) return { deny: `不在挂机中(state=${h.state}), 没有可加速的进度` };
  const st = singleTime(s, h.type, h.levelId);
  if (!st) return { deny: `${h.levelId} 的通关记录没了, 算不出单场时长` };
  if (!Number.isInteger(times) || times < 1) return { deny: `加速次数 ${times} 不合法` };
  h.endTime = Math.max(nowSec, h.endTime - times * st);
  refreshState(h, nowSec);
  return { times };
}

/** 扫荡: 一次性完成 n 场, 不动会话 (HangUpSweep_S2C 连 info 字段都没有). */
export function hangUpSweep(s: SaveData, eff: Effects, type: number, levelId: number, times: number): HangUpOp {
  const h = s.hangUp;
  if (h.state !== HU_IDLE) return { deny: `挂机进行中(state=${h.state}) 不能扫荡` };
  const c = checkLevel(s, type, levelId, times);
  if (c.deny) return { deny: c.deny };
  const cost = c.cost ?? 0;
  if (cost > 0 && !costItem(s, STRENGTH_ITEM, cost, eff)) {
    return { deny: `感知不足: 需 ${cost} 只有 ${s.player.strength}` };
  }
  const op = settle(s, eff, type, levelId, times);
  return { ...op, times, cost };
}
