// 签到这一档 (B6: 3301 初心者/七日 · 3306 bingo · 10051 月签到 · 登录 43/44/80 · 10005 13).
//
// 与 tasks.ts 同一个分工: 这里只管"服务端那份签到状态"与校验, 不碰 GS 帧、不发奖
// (发奖在 econ, 拼帧在 payloads), 所以这里不 import econ. 初心者任务的**领奖本身**复用
// tasks.claimTask —— 初心者行就是 Task_Xls 里 missionType=4 的那 56 行(客户端
// InitTaskList 按 beginTaskGroupIndex=4 分流), 再维护第二份"已领记录"迟早和 3303 打架.
//
// 口径全部来自客户端 UIBeginner7DataMgr(a357c55…)/BeginnerMsg(294a645…)/
// SignInMonthlyManager(dff3e42e…)/SignInMonthlyMsg(cd8922a2…)/UISignInMonthlyCell(bf90a40c…),
// 四条最要命的:
//   1. **回包里的 rewards 没人读**: FirstThought_S2C.rewards=2 与 GetSignReward_S2C.rewards=4
//      在客户端一行都没取, 奖要靠 ShowItem_Push 展示 + 我们自己把库存加上.
//   2. SignInfo.days=3 是"**待领的那一格**"(客户端 todayIndex = 已签次数 + days), 不是"第几天";
//      而面板弹不弹只看 lastGetSignRewardTime(<=0 或早于当前日界), 与 days 无关.
//   3. FirstThoughtInfo 四个子字段全 required: 缺任何一个 -> Lua pbNew.decode 报错 -> 整个登录包作废,
//      卡在 loading. 所以 43 与 44 要么都发要么都不发, 发了就得带全.
//   4. 日界一律走 tasks.dayEdgeSec(UTC+8 的 04:00), 与客户端 CheckIsNextDay 那个 dayResetTime 同源;
//      按月归零也得按同一个口径取月(01:00~04:00 那段在客户端还是上个月).
import { all, row } from "./tbl.js";
import * as pb from "./proto.js";
import { dayEdgeSec } from "./tasks.js";
import type { SaveData } from "./save.js";

/** Task.missionType=4 = 初心者(七日)那一组; SignActivity_Xls 只有 7 行, 七日签到最多签 7 天. */
const MT_BEGINNER = 4;
const SEVEN_DAYS = 7;
/** 3301 的 typeId (proto 注释写了 3=阅读红点, 但这版 CONST_FirstThoughtType 只有 Sign=1/Task=2). */
export const FT_SIGN = 1;
export const FT_TASK = 2;

const TZ8 = 8 * 3600;

interface BeginnerRow { missionId: number; missionType: number }
interface BingoRow { id: number; num: number; award: number }
interface SignActivityRow { id: number; type: number; times: number; fixedRewardID: number }
interface SignMonthRow { id: number; param: number; times: number; fixedRewardID: number }

// 表在进程内是静态的, 扫一遍缓存即可 (all() 本身懒 parse, 第一次读才花这一下).
let beginnerCache: number[] | null = null;
const beginnerIds = (): number[] => (beginnerCache ??= (all("Task") as unknown as BeginnerRow[])
  .filter((r) => r.missionType === MT_BEGINNER)
  .map((r) => r.missionId)
  .sort((a, b) => a - b));

/** 3301 只该收到初心者行: 别的 missionType 走 3302, 混过来的一律拒, 免得两条通道各写一半状态. */
export const isBeginnerTask = (missionId: number): boolean => beginnerIds().includes(missionId);

/**
 * "已完成初心者任务数" —— 就是客户端 UIBeginner7DataMgr.GetHaveFinishTasknum 那个数:
 * 它数的是 state==Finish 的行, 而 Finish 只由 overTask(登录 taskInfo=48) 与 3301 回包置起来,
 * 所以服务端拿 passedTasks 对, 两边不会漂. bingo 那道门(8..56) 全靠它.
 */
export const beginnerDoneCount = (s: SaveData): number =>
  beginnerIds().filter((id) => s.tasks.passedTasks[String(id)] !== undefined).length;

export const beginnerTotal = (): number => beginnerIds().length;
/** 登录 isFirstThoughtAllOver=43 与回包 isAllOver=5: 56 条全领完才是 1. */
export const beginnerAllOver = (s: SaveData): number => (beginnerDoneCount(s) >= beginnerTotal() ? 1 : 0);

/**
 * 客户端眼里"当前是几月几号": 先按 04:00 界落到那一天, 再按 UTC+8 读月/日.
 * 它选哪个月的签到格子是按 `now - refreshTimes*3600` 取的(SignInMonthlyCtrl:55), 差这 4 小时
 * 就会在每月 1 号 00:00~04:00 与我们算的不是同一个月.
 */
export function gameMonthDay(nowSec: number): { key: number; month: number; day: number } {
  const d = new Date((dayEdgeSec(nowSec) + TZ8) * 1000);
  return { key: d.getUTCFullYear() * 12 + d.getUTCMonth() + 1, month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 本月已签第几天(04:00 界). 存的是**界点秒**, 不是序号: 与 dayEdgeSec 一比就知道今天签没签. */
export const signedToday = (s: SaveData, nowSec: number): boolean => s.signin.day === dayEdgeSec(nowSec);

/** 跨月归零(客户端那份 signed_count 只有我们清, 它自己从不按月重置). 返回是否动了存档. */
export function rollMonth(s: SaveData, nowSec: number): boolean {
  const key = gameMonthDay(nowSec).key;
  if (s.signin.month === key) return false;
  s.signin = { month: key, times: 0, day: -1, lastTime: 0 };
  return true;
}

/**
 * SignInfo{monthGetSignRewardTimes=1, lastGetSignRewardTime=2, days=3} —— 三个都 required.
 * days 只能是 0 或 1: 未签回 1(格子落在 times+1), 已签回 0(格子就停在已签那天, 面板不再弹).
 */
export function signInfoBody(s: SaveData, nowSec: number): Buffer {
  return pb.concat(
    pb.vfield(1, s.signin.times),
    pb.vfield(2, s.signin.lastTime),
    pb.vfield(3, signedToday(s, nowSec) ? 0 : 1),
  );
}

/**
 * FirstThoughtInfo{signNumber=1, redDot=2, signTimeStamp=3, openTimeStamp=4, signBingoList=5}
 * —— 与存档 bg 块 1:1. redDot 全工程没人读, 但它是 required bool, 不带就解不出包.
 * openTimeStamp(**秒**)决定七日面板的"第几天": GetBeginnerTaskCurday 拿 dayResetTime 减它算天数
 * (a357…:851-873), 装载时已兜到 regTime, 所以这里不必再判 0.
 */
export function firstThoughtInfoBody(s: SaveData): Buffer {
  return pb.concat(
    pb.vfield(1, s.bg.sign),
    pb.boolfield(2, s.bg.redDot),
    pb.vfield(3, s.bg.signTime),
    pb.vfield(4, s.bg.open),
    ...s.bg.bingo.map((id) => pb.vfield(5, id)),
  );
}

export interface Claim { ok: boolean; why: string; rewardId: number }
const noClaim = (why: string): Claim => ({ ok: false, why, rewardId: 0 });
const claimed = (rewardId: number): Claim => ({ ok: true, why: "", rewardId });

let monthIdx: Map<number, number> | null = null;
/** SignMonth_Xls 的 id 是全年连号(1..366), 不能按 (月,格) 直接 row(), 自己建索引. */
function monthRewardId(month: number, cell: number): number {
  if (!monthIdx) {
    monthIdx = new Map();
    for (const r of all("SignMonth") as unknown as SignMonthRow[]) monthIdx.set(r.param * 100 + r.times, r.fixedRewardID);
  }
  return monthIdx.get(month * 100 + cell) ?? 0;
}

/**
 * 10051 领月签到. 请求是空包(SendEmptyMessage("GetSignReward")), 一天只推进一格.
 * **已签过也照样要成包回**: 面板回不来就 SetCanCloseUI(false) 卡着关不掉(SignInMonthlyCtrl:231),
 * 所以 payloads 那边是"照样回、只是不发奖", 不走 deny.
 * 领的是哪一格 = 推进后的 times, 与客户端高亮那格(todayIndex)同一个数.
 */
export function claimMonthSign(s: SaveData, nowSec: number): Claim {
  rollMonth(s, nowSec);                 // 跨月先归零, 这一笔就算新月的第一格
  if (signedToday(s, nowSec)) return noClaim("今天已签过");
  s.signin.times += 1;
  s.signin.day = dayEdgeSec(nowSec);
  s.signin.lastTime = nowSec;
  return claimed(monthRewardId(gameMonthDay(nowSec).month, s.signin.times));
}

/**
 * 3301 typeId=1 的七日签到那一格. 这版面板是死的(AutoPopupBeginnerSign 的调用处被注释掉,
 * 唯一发 3301/1 的 UIBeginner7DaysSignCtrl:126 进不去), 但协议照接: 状态落 bg.sign/signTime,
 * 值会随 firstThoughtInfo=44 一起下发, 真哪天客户端又挂上就是现成的.
 */
export function claimSevenSign(s: SaveData, nowSec: number): Claim {
  if (s.bg.sign >= SEVEN_DAYS) return noClaim("七日已签满");
  if (s.bg.signTime >= dayEdgeSec(nowSec)) return noClaim("今天已签过");
  s.bg.sign += 1;
  s.bg.signTime = nowSec;
  const r = (all("SignActivity") as unknown as SignActivityRow[]).find((x) => x.type === 1 && x.times === s.bg.sign);
  return claimed(r?.fixedRewardID ?? 0);
}

/**
 * 3306 领 bingo 格: SignBingo_Xls 就 7 行(id 1..7, num 8/16/…/56, award 802000..802006).
 * 门槛是"已完成初心者任务数 >= num". 客户端自己也会挡(a357…:143-162 把没达标的格子置灰),
 * 我们挡的是绕过界面直接发协议的路子(改档/管理面).
 * 已领的格子记进 bg.bingo -> 下次登录 signBingoList=5 直接把它标 Finish.
 */
export function claimBingo(s: SaveData, signId: number): Claim {
  const r = row("SignBingo", signId) as unknown as BingoRow | undefined;
  if (!r) return noClaim(`SignBingo 表里没 ${signId}`);
  if (s.bg.bingo.includes(signId)) return noClaim(`bingo ${signId} 已领过`);
  const done = beginnerDoneCount(s);
  if (done < r.num) return noClaim(`已完成初心者任务 ${done}/${r.num} 没达标`);
  s.bg.bingo.push(signId);
  return claimed(r.award);
}
