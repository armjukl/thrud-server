// 任务/活跃度 (B5: 3302 日活跃宝箱 · 3303 领奖 · 3308 一键领取 · 3309 周活跃宝箱 · 3304 进度上报).
//
// 这一层只管"服务端侧那份任务状态", 不碰 GS 帧、不发奖: 发奖在 econ, 拼帧在 payloads.
// 更要紧的是 **econ 要反过来调这里的 bumpTask**(消耗/获得是在 econ 里发生的), 所以这里绝不能 import econ.
//
// 口径全部来自客户端 TaskDataMgr(748180…)/TaskTools(9efdb78…)/UITaskCtrl(737d17…)/TaskMsg(0d1d40…),
// 四条最要命的:
//   1. **大部分任务进度是客户端自己算的**: 它只在 `taskProgressData[missionId] ~= nil`
//      且 `pbNew.enum('msg.ServerTaskType', condition)` 成立时才用服务端推的数, 否则回落到
//      TaskTools.GetTaskProgress (读本地 LevelDataMgr/HeroDataManager…). 所以我们只维护
//      "后端观测得到"的那几条, 推多了不生效, 漏推了要等下次登录才补得回来.
//   2. 领奖状态只认 passedTaskIds[missionId], 来源是回包 overTask + 登录 taskInfo=48.
//      不给 48 -> 重登后每条任务又变"可领取", 同一份奖能刷第二遍.
//   3. 达标判据是 `curProgress == -2 or curProgress >= conditionNum`. -2 是给"可回退"条件
//      (1201 获得律叶那一类)留的"已达标"哨兵; 我们的计数**只加不减**, 所以永不发 -2.
//   4. 拦不拦领奖: 只拦 GATED 里那几个"后端做一次涨一次"的条件(没记过数就按 0 算). 通关/星级/签到
//      那类真值在客户端本地(TaskTools.GetTaskProgress), 服务端拿不到, 拦了是把能领的奖打死 —— 放行.
//
// 计数按三个口径各存一份(day/week/total): 同一个条件在日常/周常/成就里的计数边界不一样,
// 一次 bump 三处同时加, 取数时按这一行属于哪个口径取哪一份. 跨天清 day、跨周清 week.
import { all, row } from "./tbl.js";
import * as pb from "./proto.js";
import type { SaveData } from "./save.js";

/** Task.missionType: 4=初心者(七日), 7=周常 (客户端 InitTaskList 就按这两个数分流). */
const MT_BEGINNER = 4;
const MT_WEEK = 7;
/** Task.condition 里需要我们自己记数的那几个 (号取自 proto/TaskProTo.proto 的 ServerTaskType). */
export const COND = {
  secretary: 1002,    // 秘书互动 (3304 上报)
  moneyObtain: 1501,  // 累计获得道具/货币 (addItem/addMoney)
  moneyConsume: 1502, // 累计消耗道具/货币 (costItem/payConsume)
  swear: 1701,        // 累计抽卡 (SwearHero)
  loginDay: 1802,     // 累计登录天数 (跨天界点 +1)
  chapterOver: 1901,  // 本章任务全部完成 (领奖即推章节)
  skillUp: 2017,      // 技能升级次数
  weaponUp: 2201,     // 武装强化次数(等级与精炼都算)
  leaderUp: 2203,     // 斯露德升级次数
  recast: 2204,       // 武装洗练次数
  dayPoint: 2303,     // 累计拿到的日活跃度
  taskDone: 2502,     // 累计完成某类型任务次数
  timedLogin: 3000,   // 指定时段登录 (12 点/16 点两档)
} as const;
/** 3000 的两档时段 (Task.conditionParam1): 客户端上报只带 type 不带档位, 只能我们自己分. */
const TIMED_LOGIN_SLOTS = [40000, 40001];

/**
 * 领奖时**要拦**的条件: 上面这些号都是"后端做一次就涨一次"的, 所以没记够数就不该让领.
 * 唯独 1901(本章任务全完成) 不在这里 —— 它在客户端是 `conditionNum = #mainTaskData - 1`,
 * 真值在本地那份列表里; 我们既不该拦, 也不该往 taskProgress 里推一个数(推 0 会把 6/6 压成 0/6,
 * 主线那一章的领奖按钮就再也不出现了).
 */
const GATED = new Set<number>(Object.values(COND).filter((c) => c !== COND.chapterOver));

export type Scope = "day" | "week" | "total";
const SCOPES: Scope[] = ["day", "week", "total"];

/** 与登录包 refreshTimes=65 里那个 4 保持一致: 刷新点是 UTC+8 的 04:00, 不是自然零点. */
const DAY = 86400, TZ8 = 8 * 3600, OFFSET = 4 * 3600 - TZ8;
const mod = (a: number, b: number): number => ((a % b) + b) % b;

/** 最近一个**已经过去**的日界点(秒). 客户端的跨天判定就围着它转 (TimeTools.SetServerDayRefreshTime). */
export function dayEdgeSec(nowSec: number): number {
  return Math.floor((nowSec - OFFSET) / DAY) * DAY + OFFSET;
}
/** 最近一个已经过去的周界点(秒): 周一 04:00(UTC+8). epoch 第 0 天是周四, 故 -4 起算. */
export function weekEdgeSec(nowSec: number): number {
  const d = Math.floor((nowSec - OFFSET) / DAY);
  return (d - mod(d - 4, 7)) * DAY + OFFSET;
}
export const nextDayRefresh = (nowSec: number): number => dayEdgeSec(nowSec) + DAY;
export const nextWeekRefresh = (nowSec: number): number => weekEdgeSec(nowSec) + 7 * DAY;

interface TaskRow {
  missionId: number;
  missionType: number;
  chapterId: number;
  dayConditionId: number;
  condition: number;
  conditionParam1: number;
  conditionNum: number;
  activityPoint: number;
  fixedRewardId: number;
  playerLevel: number;
  endLevel: number;
}

interface BoxRow { id: number; dayConditionId: number; apNum: number; fixedRewardId: number }

// 表在进程内是静态的, 扫一遍建索引即可 (all() 自己也是懒解析, 第一次读才花这一下).
let taskCache: TaskRow[] | null = null;
let condIdx: Map<number, TaskRow[]> | null = null;
const allTasks = (): TaskRow[] => (taskCache ??= all("Task") as unknown as TaskRow[]);
const taskOf = (missionId: number): TaskRow | undefined => row("Task", missionId) as unknown as TaskRow | undefined;
function byCond(cond: number): TaskRow[] {
  if (!condIdx) {
    condIdx = new Map();
    for (const r of allTasks()) {
      const list = condIdx.get(r.condition);
      if (list) list.push(r); else condIdx.set(r.condition, [r]);
    }
  }
  return condIdx.get(cond) ?? [];
}

const ck = (scope: Scope, cond: number, param: number): string =>
  param ? `${scope}:${cond}:${param}` : `${scope}:${cond}`;

/** 这一行按哪个口径计数: 当前日常组 -> day, 周常 -> week, 其余(主线/成就/初心者/活动) -> total. */
function scopeOf(s: SaveData, r: TaskRow): Scope {
  if (r.dayConditionId && r.dayConditionId === s.tasks.dayGroupIndex) return "day";
  if (r.missionType === MT_WEEK) return "week";
  return "total";
}

/**
 * 服务端这一侧看到的进度. **返回 null = 这个维度我们没记过数** —— 推送与 taskProgress 据此
 * "不列这一行"(列了个 0 会把客户端本地算出来的进度压没), 拦不拦领奖则另由 GATED 定.
 */
function progressOf(s: SaveData, r: TaskRow): number | null {
  const v = s.tasks.counters[ck(scopeOf(s, r), r.condition, r.conditionParam1)];
  return v === undefined ? null : v;
}

/** 只在"客户端此刻看得见的列表"里挑行推送: 日常组/当前章/周常/初心者. 成就与活动等下次登录的 taskProgress 补. */
function visible(s: SaveData, r: TaskRow): boolean {
  return r.chapterId === s.tasks.taskChapter || r.dayConditionId === s.tasks.dayGroupIndex
    || r.missionType === MT_WEEK || r.missionType === MT_BEGINNER;
}

// bumpTask 攒下的"哪些 missionId 的进度变了", 由 payloads 出口统一收走发 TaskProgress_Push.
// 被动计数散在 econ 里(调用方根本不知道任务动了), 逐条 handler 去挂推送不现实.
let pending = new Map<number, number>();

/**
 * 记一次后端侧任务事件. cond 用 Task.condition, n 是增量, param 是表里 conditionParam1 那个维度
 * (道具 id / 任务类型 / 时段档) —— 填了就同时记"带维度"与"不带维度"两份, 因为表里两种行都有.
 * 只加不减: 我们永不回退计数, 也就不需要客户端那个 -2 哨兵.
 */
export function bumpTask(s: SaveData, cond: number, n = 1, param = 0): void {
  if (!(n > 0)) return;
  const c = s.tasks.counters;
  for (const scope of SCOPES) {
    c[ck(scope, cond, 0)] = (c[ck(scope, cond, 0)] ?? 0) + n;
    if (param) c[ck(scope, cond, param)] = (c[ck(scope, cond, param)] ?? 0) + n;
  }
  for (const r of byCond(cond)) {
    if (!visible(s, r)) continue;
    const p = progressOf(s, r);
    if (p !== null) pending.set(r.missionId, p);
  }
}

/**
 * 3304 那条"指定时段登录"(condition=3000)的分配: 上报里只有 type 没有档位, 而 12 点档(40000)
 * 与 16 点档(40001)各要求当日计一次, 于是**按还没计过的那一档补**. 老实一天两登正好填满;
 * 狂发 3304 最多多到两档都满 —— 离线单机自己骗自己, 不值得再往上加判定.
 */
export function bumpTimedLogin(s: SaveData): boolean {
  for (const slot of TIMED_LOGIN_SLOTS) {
    if ((s.tasks.counters[ck("day", COND.timedLogin, slot)] ?? 0) <= 0) {
      bumpTask(s, COND.timedLogin, 1, slot);
      return true;
    }
  }
  return false;
}

/**
 * 取走本次请求攒下的进度变化, 拼成 TaskProgress_Push{repeated ProtoHashInt2Int progressTaskIdS=1};
 * 没变化回 null (handler 就不挂这条推送).
 */
export function drainTaskPush(): Buffer | null {
  if (!pending.size) return null;
  const body = pb.concat(...[...pending]
    .sort((a, b) => a[0] - b[0])
    .map(([id, v]) => pb.bfield(1, kv(id, v))));
  pending.clear();
  return body;
}
export const clearTaskPush = (): void => { pending.clear(); };

/** 当前等级的日常任务组: 1-80 级只有 10001, 81 级以上有 10002..10005 四组, 组间不轮换(取最小). */
function dayGroupForLevel(s: SaveData, level: number): number {
  const fit = [...new Set(allTasks()
    .filter((r) => r.dayConditionId && level >= r.playerLevel && level <= r.endLevel)
    .map((r) => r.dayConditionId))].sort((a, b) => a - b);
  if (!fit.length) return s.tasks.dayGroupIndex;
  return fit.includes(s.tasks.dayGroupIndex) ? s.tasks.dayGroupIndex : fit[0];
}

export interface RollResult { day: boolean; week: boolean }

/**
 * 跨天/跨周清零. 清的是**这一界的全部状态**: 计数、活跃度点、已领宝箱, 还有属于日常/周常的
 * 那部分 passedTasks —— 它是一张全局表, 不删今天这几条, 明天它们会一直显示"已领取".
 * 顺带按等级重挑日常组. 登录(10002)与跨天刷新(10005)都先过这里.
 */
export function rollTasks(s: SaveData, nowSec: number): RollResult {
  const t = s.tasks, nowMs = nowSec * 1000;
  // 存档手改后这两个数可能对不上任何任务行: chapterIndex 找不到行 -> UITaskCtrl 去 mainTaskData
  // 里捞那条 condition=1901 的行取 nil 直接崩; dayGroupIndex 错了则日常列表空掉. 兜回默认档.
  if (!allTasks().some((r) => r.chapterId === t.taskChapter)) t.taskChapter = 101;
  if (!allTasks().some((r) => r.dayConditionId === t.dayGroupIndex)) t.dayGroupIndex = 10001;
  const out: RollResult = { day: t.rollDay <= dayEdgeSec(nowSec) * 1000, week: t.rollWeek <= weekEdgeSec(nowSec) * 1000 };
  if (out.week) {
    dropCounters(t.counters, "week");
    for (const r of allTasks()) if (r.missionType === MT_WEEK) delete t.passedTasks[String(r.missionId)];
    t.weekTaskPoint = 0;
    t.passedWeekPoints = [];
    t.rollWeek = nowMs;
  }
  if (out.day) {
    dropCounters(t.counters, "day");
    for (const r of allTasks()) if (r.dayConditionId && r.dayConditionId === t.dayGroupIndex) delete t.passedTasks[String(r.missionId)];
    t.dayTaskPoint = 0;
    t.passedDayPoints = [];
    t.dayGroupIndex = dayGroupForLevel(s, s.player.level);
    t.rollDay = nowMs;
    bumpTask(s, COND.loginDay, 1);   // 登录天数只在跨天那一次 +1, 同一天重登不算第二天
  }
  clearTaskPush();                   // 清零后旧进度没意义, 别让上一轮的数混进这次的推送
  return out;
}

function dropCounters(c: Record<string, number>, scope: Scope): void {
  const p = `${scope}:`;
  for (const k of Object.keys(c)) if (k.startsWith(p)) delete c[k];
}

/** ProtoHashInt2Int{required key=1; required value=2}. */
const kv = (key: number, value: number): Buffer => pb.concat(pb.vfield(1, key), pb.vfield(2, value));

/**
 * TaskProgressInfo{dayTaskPoint=1, progressTaskIdS=2, chapterIndex=3, dayGroupIndex=4, weekTaskPoint=5}
 * —— 四个 required 从存档来, 不再是写死的 101/10001.
 * progressTaskIdS 只列"我们记过数且非 0"的行: 客户端对没列的行回落到本地算, 列了 0 反而会把
 * 一个后端条件型的任务硬压成 0 进度.
 */
export function taskProgressBody(s: SaveData): Buffer {
  const parts: Buffer[] = [pb.vfield(1, s.tasks.dayTaskPoint)];
  for (const r of allTasks()) {
    const p = progressOf(s, r);
    if (p !== null && p > 0) parts.push(pb.bfield(2, kv(r.missionId, p)));
  }
  parts.push(pb.vfield(3, s.tasks.taskChapter), pb.vfield(4, s.tasks.dayGroupIndex), pb.vfield(5, s.tasks.weekTaskPoint));
  return pb.concat(...parts);
}

/** TaskInfo{passedTaskIdS=1, passedDayPoints=2, passedWeekPoints=3} —— 缺它重登就能把任务再领一遍. */
export function taskInfoBody(s: SaveData): Buffer {
  const t = s.tasks;
  return pb.concat(
    ...Object.keys(t.passedTasks).map(Number).sort((a, b) => a - b)
      .map((id) => pb.bfield(1, kv(id, t.passedTasks[String(id)]))),
    ...[...t.passedDayPoints].sort((a, b) => a - b).map((id) => pb.vfield(2, id)),
    ...[...t.passedWeekPoints].sort((a, b) => a - b).map((id) => pb.vfield(3, id)),
  );
}

export interface ClaimResult {
  ok: boolean;
  why: string;
  /** 该发的奖 id (Task.fixedRewardId), 由调用方走 econ.rewardById. */
  rewardId: number;
  /** 本次加进日/周活跃度的点数. */
  point: number;
}
const noClaim = (why: string): ClaimResult => ({ ok: false, why, rewardId: 0, point: 0 });

/**
 * 领一条任务. 校验三件事: 表里有 / 没领过 / **GATED 那几个后端条件**数够了.
 * 改动直接落在 s 上(要不要 saveSave 由调用方定), 奖励 id 交回调用方发.
 */
export function claimTask(s: SaveData, missionId: number, nowSec: number): ClaimResult {
  const r = taskOf(missionId);
  if (!r) return noClaim(`Task 表里没 ${missionId}`);
  const done = (id: number): boolean => s.tasks.passedTasks[String(id)] !== undefined;
  if (done(missionId)) return noClaim(`${missionId} 已领过`);

  if (r.condition === COND.chapterOver) {
    const left = allTasks().filter((x) => x.chapterId === r.chapterId && x.missionId !== missionId && !done(x.missionId));
    if (left.length) return noClaim(`第 ${r.chapterId} 章还有 ${left.length} 条没领(${left.slice(0, 3).map((x) => x.missionId).join(",")}…)`);
  } else if (GATED.has(r.condition)) {
    const p = progressOf(s, r) ?? 0;   // 后端型条件: 没记过数就是 0, 不能当成"看不见"
    if (p < r.conditionNum) return noClaim(`${missionId} 进度 ${p}/${r.conditionNum} 没达标`);
  }

  s.tasks.passedTasks[String(missionId)] = nowSec;
  const point = Number(r.activityPoint) || 0;   // 成就/主线行根本没这列(undefined), 不能直接加
  const scope = scopeOf(s, r);
  if (point > 0) {
    if (scope === "day") s.tasks.dayTaskPoint += point;
    else if (scope === "week") s.tasks.weekTaskPoint += point;
    bumpTask(s, COND.dayPoint, point);
  }
  bumpTask(s, COND.taskDone, 1, r.missionType);

  if (r.condition === COND.chapterOver) {
    const next = r.chapterId + 1;
    // 最后一章就停在原章: 跳到表里没行的章节, 客户端 InitTaskList 挑不到那条 1901 会崩.
    if (allTasks().some((x) => x.chapterId === next)) s.tasks.taskChapter = next;
  }
  return { ok: true, why: "", rewardId: r.fixedRewardId, point };
}

export interface BoxClaim { claimed: number[]; rewardIds: number[] }

/**
 * 领活跃宝箱. day: TaskDailyActive.dayConditionId == 当前日常组 (10001 那组是 id 1..5);
 * week: dayConditionId == 0 的那五格 (id 26..30), 门槛换成 weekTaskPoint.
 * 客户端一键领时把**所有达标未领**的 id 一起发来, 所以逐条判、能领几条领几条, 一条都不成立才回 null.
 * 回包只带"这次新领的 id": 客户端是往 passedDayPoints 里 append 的, 回重了会重复计数.
 */
export function claimBoxes(s: SaveData, ids: number[], kind: "day" | "week"): BoxClaim | null {
  const group = kind === "day" ? s.tasks.dayGroupIndex : 0;
  const rows = all("TaskDailyActive") as unknown as BoxRow[];
  const point = kind === "day" ? s.tasks.dayTaskPoint : s.tasks.weekTaskPoint;
  const passed = kind === "day" ? s.tasks.passedDayPoints : s.tasks.passedWeekPoints;
  const out: BoxClaim = { claimed: [], rewardIds: [] };
  for (const id of ids) {
    const r = rows.find((x) => x.id === id && x.dayConditionId === group);
    if (!r || passed.includes(id) || point < r.apNum) continue;
    passed.push(id);
    out.claimed.push(id);
    if (r.fixedRewardId) out.rewardIds.push(r.fixedRewardId);
  }
  return out.claimed.length ? out : null;
}
