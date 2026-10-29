// GS 应用层: S2C 消息构造 + 请求->处理器表.
//
// 客户端链路 (来自 Lua):
//   HttpClientForLua:SendMessageUrlList(msgId, data, appendData)
//     -> WebCommunicationHelper:SendMessage(url, uid, pfUid, token, msgId, data, appendData, ...)
//     -> POST /AppInterface  [二进制头 + protobuf data + appendData]
//   回包 HTTP body = protobuf msg.ReturnPackagePush {
//       packetList: [{ packetUUid, bodyInfo: {header, bodyBytes}, packetBodyInfoS: [...] }]
//   }
//   native WebCommunicationHelper.HandleResult() 解 ReturnPackagePush -> UploadDataCompletedData
//   Lua HttpClientForLua:isReceiveFromServer() 读 completedList / replenishList, 按 header 派发.
import { log } from "./logger.js";
import { config } from "./config.js";
import * as pb from "./proto.js";
import { COMMON_CONDITION_IDS } from "./data/conditions.js";
import { GUIDE_IDS } from "./data/guides.js";
import { MAIN_LEVEL } from "./data/mainlevels.js";
import { LEADER } from "./data/leader.js";
import { WEAPON } from "./data/weapon.js";
import { WEAPON_BREAK } from "./data/weaponbreak.js";
import { heroAttrMap, heroPower, weaponAttr, weaponPower, type AttrKV } from "./attrs.js";
import { ITEM_VALID } from "./data/items.js";
import { LEADER_DEBRIS } from "./data/leaderdebr.js";
import { LEADER_QUALITY, WEAPON_GRATE } from "./data/rarity.js";
import { poolDraw } from "./gacha.js";
import {
  addItem, addMoney, checkConsume, countItem, fixedRewardItems, grantWeapon, ITEMTYPE, itemType,
  leaderLevelExp, leaderMaxLv, newEffects, payConsume, payItemList, upgradeByExp, weaponLevelExp,
  weaponMaxLv, type Effects,
} from "./econ.js";
import { setSkillLv, skillConsumeId, skillLv, stickMaxLv, upgradeSkill } from "./skills.js";
import { all, arr, num, row } from "./tbl.js";
import {
  characterById, defaultCharacter, emptyRand, loadSave, saveSave,
  type SaveCharacter, type SaveData, type SaveWeapon, type SaveWeaponRand,
} from "./save.js";
import {
  RECAST_PROP, RECAST_SKILL, SELECT_NEW, SELECT_OLD, applyPending, breakConsume, defLeaderOf,
  equippedWeaponOf, findWeapon, grateOf, keepFor, lastBufFor, materializeWeapons, maxRefineOf,
  pendingHalf, randIsEmpty, rollWeapon, seedOf, weaponInstances, weaponRandomInfoBuf,
  weaponTotalExp,
} from "./weapons.js";

export interface GsRequest {
  msgId: number | null;
  packetUUid: number;
  proto: Buffer | null;
  headerHex: string;
  stringsEnd?: number;
  protoStart?: number;
  appendData?: Buffer;
}

export interface GsResponse {
  body: Buffer;
  pushes: Array<[number, Buffer]>;
  /** 额外"后一包"(packetList 追加, 保证晚于主包派发). */
  extra?: Array<[number, Buffer]>;
  /**
   * true 时主包改走 completedList 的单包槽 (ReturnPackageInfo.bodyInfo 是 replenish 通道,
   * 会被 Lua 的 Ignore_Replenish_MsgID 过滤). extra 随之改走 PushMsg2Client(同样进 completedList).
   */
  mainInCompleted?: boolean;
  /**
   * 置为失败原因字符串 = **"合法帧 + 不派发"** (对齐路 B 的"只准不收包"):
   * gs.ts 回 header=0 的空包, 客户端照常清 CurSend/关遮罩, 但 header 找不到回调 -> 面板不动.
   * 用在"升级失败却会弹假窗"的命令上 (UpgradeLeaderTalentSkillHandler 是无条件弹 UIHeroLevelUp).
   */
  deny?: string;
}

export type GsResult = Buffer | GsResponse;
export type GsBuilder = (req: GsRequest) => GsResult;

// msg.CmdEnum 里与本流程相关的号 (proto/CmdDefine)
export const CMD = {
  HeartBeat: 9999,
  PlayerLogin: 10000,
  PlayerLoginGetInfo: 10002,
  GetPrologue: 10003,
  SetPrologue: 10004,
  GetNextDayUpdateData: 10005,
  GetRevelationInfoListPage: 10006,
  GetWeaponListPage: 10007,
  ClientDataOverLogin: 10100,
  GetOpenFunctionData: 10102,
  ChangeStep: 10073,
  GetSignReward: 10051,
  SetSpecialTaskProgress: 3304,
  GetPayShopDataAfterLogin: 30304,
  GetWaitOrderData: 40002,
  GetPerkInfoListPage: 60003,
  LoginOpenSmallBattlePanel: 9000007,
  GetAllFriendInfo: 3912,
  GetOtherPlayerInfo: 3913,
  GetAllActivity: 21001,
  ActivityReplayReward: 21015,
  GetBattlePassInfoListPage: 890105,
  GetRogueInfoListPage: 9300009,
  GetElementRuinsLevelGroupList: 9400004,
  CheckPlayerName: 10076,
  ChangePlayerName: 10077,
  ChangeSex: 10080,
  ChangeSecretary: 10057,
  // 战斗 (客户端 fightLua VM 跑逻辑; 游戏服只给开战数据与收结算)
  BattleLogin: 11003,
  BattleSettle: 11018,
  BattleLeave: 11019,
  StartSoloBattle: 11028,
  CloseBattleSettle: 11031,
  BattleLeaveFinishS2C: 11032,
  OverMainLevel: 3004,
  SwitchClothing: 1007,
  UpgradeLeader: 1001,
  // 养成 (B1): 等级/突破/位阶/技能. 号见 proto/CmdDefine.proto:68-83
  UpgradeLeaderStar: 1002,
  UpgradeLeaderStarLevel: 1003,
  UpgradeLeaderTalentSkill: 1004,
  UpgradeLeaderBreach: 1005,
  UpgradeLeaderActiveSkill: 1008,
  ChangeStickSkill: 1010,
  ResetStickSkill: 1011,
  UpgradeStickSkill: 1016,
  SwitchWeapon: 1203,
  // 武装 (B2): 突破/强化/分解/上锁/精炼/洗练/选保留. 号见 proto/CmdDefine.proto:98-106
  // (1206 SwitchWeaponSkin 是涂装, 不在本轮).
  UpgrageWeaponBreach: 1201,
  UpgrageWeapon: 1202,
  DecomposeWeapon: 1204,
  ChangeWeaponLock: 1205,
  UpgradeWeaponRefineLevel: 1207,
  RecastingWeapon: 1208,
  SelectWeaponRandomInfo: 1209,
  GetPayShopData: 30300,
  DataPush: 900011,
  // 抽卡(简化)
  SwearHero: 2000,
  SelectSwearChange: 2001,
  GetSwearRecord: 2002,
  ShowItemPush: 900009, // 展示获得物品推送
} as const;

export const CMD_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(CMD).map(([k, v]) => [v, k]),
);

export const now = (): bigint => BigInt(Math.floor(Date.now() / 1000));

// 新手引导信息流(服务器原样回显/落内存). 登录包 GuideInfo.guideData(字段57) 回填,
// ChangeStep_S2C 原样回显; 否则 m_guideDataJsonStr 被清空, 引导每步重发/重启后从头开始.
let guideData = "";
export const getGuideData = (): string => guideData;

// ---- 序章 / 创角 (服务端侧存档) ----
// 客户端 PrologueDataMgr.CheckOver() 判"序章已完成"的两个口径:
//   curPrologueId == 0 && LoginModule.GetFinishBeginnerProgress() > NewRoleProgress.Login(=0)
//   curPrologueId >= lastPrologueId (ChapterPrologue_Xls 里最大 prologueId = 101014 UIMain)
// 其中 curPrologueId 来自 GetPrologue_S2C.data(字符串转数字, 空=0),
// GetFinishBeginnerProgress 来自 PlayerLogin_S2C.beginnerModeProgress.
// 所以想让它**进序章**要同时改两处: beginnerModeProgress=0 + data 回一个 <101014 的值(或空).
// 效果: 客户端不再 JumpTo(1,{isGameStart=true}) 直插大厅, 而是 PlayNext 播序章链
//   101001 剧情1100011 -> 101002 创角 -> 101003 剧情 -> 101004 视频 -> 101005/101007 教程战
//   -> ... -> 101014 UIMain 进大厅.
// 走这条路进大厅时 param 不带 isGameStart, UpdateSecretaryOver 落到 PlayIdle() ——
// 正是看板待机动作缺失的修法(旧版 beginnerModeProgress=2 直插大厅 -> HelloLogin() 把
// helloLogin 置 true 后只有 CheckCurrentAniClip 见到 Home_Idle_01 才清, 而那段动画根本没播,
// Animator 停在 Empty State, 于是开场动作做完就僵住).
// 进度落盘 + 每次请求重读: 若某步资源离线取不到(视频/教程战)卡住, 直接改
// data/save.json 里 prologue.id 为下一步(如 {"prologue":{"id":"101013"}} = 只剩进大厅)即可续播.
export const LAST_PROLOGUE_ID = 101014;
// 离线取不到资源的序章节点 -> 上报到它就当作已完成, 顺延下一步.
// 逐个实测出来的(clientLog + 抓包):
//   101002 创角面板: bundle UICreateRole 既不在 base.apk 也不在下载目录 -> 面板开不出来.
//   101004/101009/101011/101013 视频(type=5): abIndex 里没有任何 video bundle.
//   101005/101007 教程战(type=2): 要 StartSoloBattle_S2C 的 battleEnterInfo, 服务端还没做战斗构造.
// 剩下的 101001/101003/101006/101008/101010/101012 剧情都能播(个别背景图缺, 只报一次 NRE 不拦路),
// 101014 UIMain 进大厅不带 isGameStart -> UpdateSecretaryOver 走 PlayIdle() 播放看板待机.
const PROLOGUE_SKIP = new Set(["101002", "101004", "101005", "101007", "101009", "101011", "101013"]);

// 序章链是 101001..101014 线性(condition=上一个 id), 所以"下一个"= id+1.
export function prologuePlayable(id: string): string {
  let cur = Number(id) || 0;
  for (let g = 0; g < 20 && PROLOGUE_SKIP.has(String(cur + 1)); g++) cur += 1;
  return String(cur);
}

function reqStr(req: GsRequest | undefined, field: number): string {
  if (!req?.proto) return "";
  const f = pb.decodeFields(req.proto).find((x) => x.field === field && x.wire === 2);
  return f && Buffer.isBuffer(f.value) ? f.value.toString("utf8") : "";
}

/** 请求里 repeated string 字段的全部值 (分解/精炼送的是"一串 onlyId"). */
function reqStrs(req: GsRequest | undefined, field: number): string[] {
  if (!req?.proto) return [];
  return pb.decodeFields(req.proto)
    .filter((x) => x.field === field && x.wire === 2 && Buffer.isBuffer(x.value))
    .map((x) => (x.value as Buffer).toString("utf8"));
}

function reqNum(req: GsRequest | undefined, field: number): number | null {
  if (!req?.proto) return null;
  const f = pb.decodeFields(req.proto).find((x) => x.field === field && x.wire === 0);
  return f ? Number(f.value) : null;
}

// 网络字节序(大端) u32
function u32(v: number | bigint): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(Number(BigInt(v) & 0xffffffffn) >>> 0);
  return b;
}

// 拒单: 合法帧 + 什么都不派发 (见 GsResponse.deny). 养成类"不能升/材料不足"全走这里,
// 免得回一个等级没变的 S2C 让客户端弹出假升级窗.
const deny = (reason: string): GsResult => ({ body: Buffer.alloc(0), pushes: [], deny: reason });

/** 请求里 repeated ProtoHashInt2Int{key=1,value=2} 字段 -> [{key,value}] (升级素材列表). */
function reqHashList(req: GsRequest | undefined, field: number): { key: number; value: number }[] {
  const out: { key: number; value: number }[] = [];
  if (!req?.proto) return out;
  for (const f of pb.decodeFields(req.proto)) {
    if (f.field !== field || !Buffer.isBuffer(f.value)) continue;
    const inner = pb.decodeFields(f.value);
    const key = inner.find((x) => x.field === 1);
    const val = inner.find((x) => x.field === 2);
    out.push({ key: Number(key?.value ?? 0), value: Number(val?.value ?? 0) });
  }
  return out;
}

/** 按列等值找一行 (养成表都是"leaderId + 档位"这种复合定位, row(id) 走不到). */
function findRow(table: string, cond: Record<string, number>): Record<string, any> | undefined {
  const ks = Object.entries(cond);
  return all(table).find((r) => ks.every(([k, v]) => Number(r[k] || 0) === v));
}

/**
 * 养成后刷新面板的那一条: Data_Push{ leaderAttrChanged=5{LeaderInfo}, changePart=10{Part} }.
 * 扣了材料必须同时推 changePart —— 背包走的是物品通道, 只推 leader 的话素材数量在客户端不变.
 */
function leaderDataPush(s: SaveData, c: SaveCharacter, eff: Effects): Buffer {
  const parts = [pb.bfield(5, pb.bfield(1, leaderInfo(s, c)))];
  const ids = [...new Set(eff.items)];
  if (ids.length) parts.push(pb.bfield(10, pb.concat(...ids.map((id) => pb.bfield(1, partBody(id, countItem(s, id)))))));
  return pb.concat(...parts);
}

// ---- 各 S2C 消息体 ----
function levelExp(level = 1, curExp = 0, maxExp = 100): Buffer {
  return pb.concat(pb.vfield(6, level), pb.vfield(7, curExp), pb.vfield(8, maxExp));
}

function playerLoginS2C(): Buffer {
  const t = now();
  const s = loadSave();
  return pb.concat(
    // beginnerModeProgress: 0=未完成创角 -> 客户端进序章; 2=已完成 -> 直插大厅.
    pb.vfield(1, s.prologue.done ? 2 : 0),
    pb.vfield(2, s.player.uid), // uid
    pb.sfield(3, "1"), // serverDataVersion
    pb.sfield(4, "offline-token"), // token
    pb.vfield(5, t - 86400n * 30n), // regDate
    pb.vfield(6, t), // now
    pb.bfield(7, levelExp(s.player.level, s.player.exp, s.player.maxExp)),
  );
}

function getPrologueS2C(): Buffer {
  const s = loadSave();
  // data = 上次完成的步; 空=从头播. 完成态回终值 101014 让 CheckOver()=true 不再重播.
  // 离线缺资源的节点不回(回的就是"已播到", 客户端播它的下一步).
  return pb.sfield(2, s.prologue.done ? String(LAST_PROLOGUE_ID) : prologuePlayable(s.prologue.id));
}

function setPrologueS2C(req: GsRequest): GsResult {
  const s = loadSave();
  const wasDone = s.prologue.done;
  const data = reqStr(req, 3); // SetPrologue{platformId=1, platformUserId=2, data=3}
  if (data === "0") {
    s.prologue.done = true;
    s.prologue.id = "";
  } else if (data !== "") {
    s.prologue.id = prologuePlayable(data);
    s.prologue.done = Number(s.prologue.id) >= LAST_PROLOGUE_ID;
  }
  saveSave(s);
  log("info", "prologue", `SetPrologue data="${data}" -> done=${s.prologue.done} id="${s.prologue.id}"`);
  const ack = pb.vfield(1, 0); // SetPrologue_S2C{ required int32 errorCode=1 }
  if (!wasDone && s.prologue.done) {
    // 新号播完序章走的是 PrologueDataMgr.OnGetPlayerInfo 分支, 全程不自发请求登录大包,
    // 缺 PlayerLoginGetInfo 会让进大厅后的 UITopMenu.GetStrength 索引 nil playerInfo 崩.
    // 借这次回包的 packetBodyInfoS(推送包通道)补踢一次.
    log("info", "prologue", "首次完成 -> 随回包推送 PlayerLoginGetInfo_S2C");
    return { body: ack, pushes: [[CMD.PlayerLoginGetInfo, playerLoginGetInfoS2C()]] };
  }
  return ack;
}

function checkPlayerNameS2C(): Buffer {
  return pb.vfield(1, 0); // CheckPlayerName_S2C{ required int32 errorCode=1 } 0=名字可用
}

function changePlayerNameS2C(req: GsRequest): Buffer {
  const s = loadSave();
  const nm = reqStr(req, 1); // ChangePlayerName{ required string uName=1 }
  if (nm) {
    s.player.name = nm;
    saveSave(s);
  }
  // ChangePlayerName_S2C{ errorCode=1(注释掉了); uName=2; lastUNameTime=3; nameCode=4 }
  return pb.concat(pb.sfield(2, s.player.name || "指挥官"), pb.vfield(3, now()));
}

function changeSexS2C(req: GsRequest): Buffer {
  const s = loadSave();
  const sx = reqNum(req, 1) ?? 0; // ChangeSex{ required int32 sex=1 } 0=女 1=男
  s.player.sex = sx;
  saveSave(s);
  return pb.vfield(2, sx); // ChangeSex_S2C{ sex=2 } (0=女 1=男)
}

// LeaderInfo (msg.proto): 武将信息. required: id/level/exp/star/starLevel/
// favorabilityLevel/favorabilityExp/clothingId/weaponId/signLv/perkId.
// HeroData:SetHeroAttr 会直接读 calcPropModelInfo.attributeMap, 所以必须带上.
// 数值全部来自存档 data/save.json 的 characters[].
//
// 式仗实例的 onlyId 发号/物化/默认杖判定全在 weapons.ts —— leaderInfo.weaponId 与
// GetWeaponListPage 必须报同一个号, 客户端才索引得到那把实例.

/**
 * 养成面板的被动技能集合 = Leader_Xls.commonSkillId(普攻) + talentSkill(突破解锁的被动).
 * **不是**武器的 weaponSkillId: 那是武装自带的战斗被动(走 WeaponInfo 展示), 且它们在 Skill_Xls
 * 里 maxLevel 恒为 1 —— 放进来会让"被动升级"每个都判成满级而永远拒绝.
 */
const talentIdsOf = (leaderId: number): number[] =>
  [...new Set([...arr("Leader", leaderId, "commonSkillId"), ...arr("Leader", leaderId, "talentSkill")]
    .map(Number).filter((n) => n > 0))];

/** 随机属性并入基础属性 (真服是合好再下发; 客户端"把武装并进角色"那段代码是注释掉的). */
function mergeRandAttrs(m: Map<number, number>, r: SaveWeaponRand): Map<number, number> {
  for (let i = 0; i < r.key.length; i++) {
    const k = r.key[i]!;
    m.set(k, (m.get(k) || 0) + (r.val[i] || 0));
  }
  return m;
}

// 角色终值属性 (自身等级/突破 + 穿戴武装 + 武装随机属性 + 存档覆盖); 表缺失时回退占位.
function heroAttrs(s: SaveData, c: SaveCharacter): AttrKV {
  const w = equippedWeaponOf(s, c.id);
  const m = mergeRandAttrs(new Map(heroAttrMap(c.id, c.level, c.breach, w.cfg, w.level, w.breach)), w.rand);
  for (const [k, v] of Object.entries(c.attrs || {})) m.set(Number(k), v); // 存档覆盖: 直接改终值
  if (!m.size) for (const [k, v] of DEFAULT_ATTRS) m.set(k, v);
  return [...m.entries()].map(([k, v]) => [k, v] as [number, number]);
}

// 武装属性 (基础 + 等级成长 + 随机属性); 表缺失时回退占位.
function weaponAttrsOf(w: SaveWeapon): AttrKV {
  const a = [...mergeRandAttrs(weaponAttr(w.cfg, w.level, w.breach), w.rand).entries()];
  return a.length ? a : DEFAULT_ATTRS;
}

function leaderInfo(s: SaveData, c: SaveCharacter): Buffer {
  const w = equippedWeaponOf(s, c.id);
  const lm = LEADER[c.id];
  const wm = WEAPON[w.cfg];
  const shooting = wm ? wm[0] : 0;
  const weaponSkills = wm ? wm[1] : [];
  // 式杖槽 stickSkills=23: key=槽Id, value=LeaderWandSkill 表id (Change/ResetStickSkill 落进 c.stick).
  const stickSlots = Object.entries(c.stick)
    .filter(([, sid]) => sid > 0)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([pos, sid]) => pb.bfield(23, protoHash(Number(pos), sid)));
  // stickSkillLevel=27 只列**升级过**的(表注释"升级过的技能"), 1 级由客户端按默认显示.
  const stickLevels = Object.entries(c.stickLv)
    .filter(([, lv]) => lv > 1)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([sid, lv]) => pb.bfield(27, stickSkillLevelBuf(Number(sid), lv)));
  return pb.concat(
    pb.vfield(1, c.id),   // id
    pb.vfield(2, c.level), // level
    pb.vfield(3, c.exp),   // exp
    pb.vfield(4, c.star),  // star
    pb.vfield(5, c.starLevel), // starLevel
    pb.vfield(6, c.favorabilityLevel), // favorabilityLevel
    pb.vfield(7, c.favorabilityExp),   // favorabilityExp
    pb.vfield(8, c.clothingId), // clothingId
    pb.sfield(9, w.onlyId),     // weaponId = 穿戴式仗的 onlyId (required string)
    pb.bfield(10, battlePropModelInfo(heroPower(c.id, c.level, c.breach, w.cfg), heroAttrs(s, c))), // calcPropModelInfo
    ...talentIdsOf(c.id).map((id) => pb.bfield(11, talentSkill(id, skillLv(c, id, "talent")))), // talentSkills=11
    pb.vfield(12, c.breach),    // breachLevel=12 (缺则 LeaderAttrChangedHandler 误判去开突破界面)
    ...(lm
      ? [
          pb.bfield(17, activeSkill(shooting, skillLv(c, shooting, "active"), 1)), // activeSkills=17 武器射击
          pb.bfield(17, activeSkill(lm[1], skillLv(c, lm[1], "active"), 2)),       // 主动
          pb.bfield(17, activeSkill(lm[2], skillLv(c, lm[2], "active"), 3)),       // 极奏
        ]
      : []),
    pb.vfield(22, c.signLv),    // signLv (required)
    ...stickSlots,
    pb.sfield(25, c.perkId),    // perkId (required string)
    ...stickLevels,
  );
}

// 背包道具 -> Part{ required id=1; required num=2; required uuid=4(string) }. 只发 Items_Xls 里
// 存在的 id(type=2 道具), 否则客户端 ItemData:Init 对缺行 id 无保护地 index -> 崩.
const partBody = (id: number, n: number): Buffer =>
  pb.concat(pb.vfield(1, id), pb.vfield(2, n), pb.sfield(4, String(id)));

function partsBody(s: SaveData): Buffer[] {
  const out: Buffer[] = [];
  for (const [k, n] of Object.entries(s.items)) {
    const id = Number(k);
    if (!ITEM_VALID.has(id) || !(n > 0)) continue;
    out.push(partBody(id, n));
  }
  return out;
}

// 货币 -> MoneyPart{ required int64 currentNum=1; required int32 itemId=2 }
function moneyPartBody(s: SaveData): Buffer[] {
  return Object.entries(s.money)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => pb.concat(pb.vfield(1, Math.floor(n)), pb.vfield(2, Number(k))));
}

// 已拥有角色战装 -> ClothingInfo{ repeated int32 clothingIdSet=1 } (空则整字段省略, 客户端 #nil 会崩).
function clothingInfoBody(s: SaveData): Buffer | null {
  const ids = [...new Set(s.cloths)].sort((a, b) => a - b);
  return ids.length ? pb.concat(...ids.map((id) => pb.vfield(1, id))) : null;
}

// 已拥有武装涂装 -> WeaponSkinInfo{ repeated int32 existIdSet=1 }.
function weaponSkinInfoBody(s: SaveData): Buffer | null {
  const ids = [...new Set(s.wskin)].sort((a, b) => a - b);
  return ids.length ? pb.concat(...ids.map((id) => pb.vfield(1, id))) : null;
}

// 主线通关 -> MainLevelInfo{ required id=1; stars=2; todayAttackNum=3; attackNum=4; lastAttackTime=5; passTime=10 }.
function mainLevelInfoEntries(s: SaveData): Buffer[] {
  const now = BigInt(Date.now());
  return Object.entries(s.levels).map(([k, stars]) => pb.concat(
    pb.vfield(1, Number(k)),
    ...(stars || []).map((v) => pb.vfield(2, v)),
    pb.vfield(3, 1), pb.vfield(4, 1), pb.vfield(5, now), pb.vfield(10, 0),
  ));
}

// 训练本通关 -> TrainLevelInfo{ required id=1; todayAttackNum=2; attackNum=3; lastAttackTime=4; required passTime=8 }.
// passTime 以前恒发 0: 客户端把这一列当"单局耗时", 挂机/扫荡按它算场次, 发 0 等于告诉客户端
// "瞬间打完" -> 奖励池算空. 现在取存档里的真记录(OverTrainLevel 按 C2S 写进来, 老档兜 30 秒).
function trainLevelInfoBody(s: SaveData): Buffer[] {
  return Object.values(s.trainLevels).map((r) => pb.concat(
    pb.vfield(1, r.id), pb.vfield(2, r.todayAttackNum), pb.vfield(3, r.attackNum),
    pb.vfield(4, BigInt(r.lastAttackTime || Date.now())), pb.vfield(8, r.passTime),
  ));
}

// PlayerLoginGetInfo_S2C (10002): 登录后拉全部玩家数据.
// 三个 required 字段 (refreshTimes=65 / smallBattleIsOver=89 / abyssFrontIsOver=90) 必须给,
// 否则 Lua 端 pbNew.decode 会因缺 required 报错.
export function playerLoginGetInfoS2C(): Buffer {
  const t = now();
  const s = loadSave();
  const sec = s.player.secretary;
  // 看板角色必须在武将列表里(否则 GetHeroDataById 返回 nil), 缺就补一个默认条目.
  const ids = s.characters.map((c) => c.id);
  if (!ids.includes(sec)) ids.push(sec);
  const leaders = [...new Set(ids)];
  const clothingInfo = clothingInfoBody(s);
  const weaponSkinInfo = weaponSkinInfoBody(s);
  return pb.concat(
    // monthSign=80 (SignInfo): SignInMonthlyManager.InitData(msg.monthSign) 的唯一数据来源,
    // 缺它 -> InitData(nil) -> 月签到面板回到"第 1 天", 与 GetSignReward 的回显自相矛盾.
    pb.bfield(80, signInfoBody()),
    // swearInfo=20 (SwearInfo): 抽卡状态(已抽过的池). 空消息也可, 客户端 SetData({}).
    pb.bfield(20, swearInfoBody(s)),
    // leaderInfo=4 (repeated LeaderInfo): HeroDataManager.Init 直接 #leaderData,
    // 缺字段会 nil -> ResetHeroDataDic 报错, 卡在登录.
    ...leaders.map((id) => pb.bfield(4, leaderInfo(s, characterById(s, id)))),
    pb.vfield(7, t),             // nowTime
    pb.vfield(54, t),            // lastLoginTime
    pb.vfield(65, 4),            // refreshTimes (required) 跨天刷新小时
    pb.vfield(76, t + 604800n),  // nextWeekRefreshTime
    pb.vfield(78, s.player.shipStrength),    // shipStrength
    pb.vfield(79, s.player.maxShipStrength), // maxShipStrength
    pb.vfield(88, 1),            // httpStabilityId
    pb.vfield(89, 0),            // smallBattleIsOver (required)
    pb.vfield(90, 0),            // abyssFrontIsOver (required)
    // guideInfo=57 (GuideInfo): 回填已完成的新手引导流, 否则每次登录引导从头开始.
    // GuideInfo{ optional string guideData=1; repeated int32 forceGuideStep=2 }
    pb.bfield(57, pb.concat(
      pb.sfield(1, guideData),
      // forceGuideStep: 强制跳过全部新手引导(避免引导遮罩卡死大厅点击).
      ...GUIDE_IDS.map((id) => pb.vfield(2, id)),
    )),
    pb.vfield(95, t + 2592000n), // nextMonthRefreshTime
    pb.vfield(96, t + 86400n),   // nextDayRefreshTime
    // serverInfos=14 (repeated ServerInfo): 客户端 NetWorkManager 需要 type=3 聊天服, 否则
    // GetServerInfoByType(3) 返回 nil -> NetWorkManager:56 报错 (每 15s 一次).
    pb.bfield(14, pb.concat(
      pb.vfield(1, 1), pb.vfield(2, 2), pb.sfield(3, "23.147.232.29"), pb.vfield(4, 19005), pb.vfield(5, 1),
      pb.vfield(1, 2), pb.vfield(2, 3), pb.sfield(3, "23.147.232.29"), pb.vfield(4, 19005), pb.vfield(5, 1),
    )),
    // weaponInfos=32 (repeated WeaponInfo): 式仗实例集合(与 GetWeaponListPage 同源).
    ...weaponInstances(s).map((w) => pb.bfield(32, weaponInfoFromInst(s, w))),
    // parts=12 (repeated Part): 背包道具; moneyPart=62 (repeated MoneyPart): 货币.
    ...partsBody(s).map((p) => pb.bfield(12, p)),
    ...moneyPartBody(s).map((m) => pb.bfield(62, m)),
    // clothingInfo=41 (角色战装/皮肤); weaponSkinInfo=45 (武装涂装). 空则整字段省略.
    ...(clothingInfo ? [pb.bfield(41, clothingInfo)] : []),
    ...(weaponSkinInfo ? [pb.bfield(45, weaponSkinInfo)] : []),
    // mainLevelInfo=63 (主线通关) / trainLevelInfo=64 (训练本通关).
    ...mainLevelInfoEntries(s).map((m) => pb.bfield(63, m)),
    ...trainLevelInfoBody(s).map((m) => pb.bfield(64, m)),
    // cdnInfo=55 (repeated ProtoHashInt2String): PlayerDataManager.SetCDNAddressList 直接
    // pairs(cdnInfo), 缺字段会 bad argument -> 整个登录回调中断.
    pb.bfield(55, pb.concat(pb.vfield(1, 1), pb.sfield(2, "https://le1-prod-bili-api-thrud.bilibiligame.net"))),
    // playerLiveInfo=58 (PlayerLiveInfo): SetPlayerInfo 缺它会 return, 之后
    // SetPlayerShowInfo 里 playerInfo 仍是 nil -> PlayerDataManager:528 报错, 进不了主城.
    pb.bfield(58, pb.concat(
      pb.vfield(1, s.player.uid),                 // uid
      pb.sfield(2, s.player.name || "指挥官"),     // uName
      pb.sfield(3, ""),                     // nameCode
      pb.vfield(4, s.player.exp),           // exp
      pb.vfield(5, s.player.level),         // level
      pb.vfield(6, s.player.sex || 0),      // sex
      pb.vfield(7, 0),                     // headId
      pb.vfield(8, 1),                     // serverId
      pb.sfield(9, "bili"),                // platformId
      pb.sfield(10, "382030473"),          // platformUid
      pb.vfield(11, 0),                    // languageId
      pb.vfield(12, 0),                    // birthday (required)
      pb.vfield(13, 0),                    // lastBirthdayTime (required)
      pb.sfield(14, ""),                   // autograph (required)
      pb.vfield(15, sec),                  // secretary = 看板角色 leaderId (required)
      pb.vfield(16, t),                    // regDate (required)
      pb.vfield(17, s.player.strength),    // strength
      pb.vfield(18, s.player.maxStrength), // maxStrength
      pb.vfield(19, t),                    // lastStrengthTime
    )),
    // taskProgress=47 (TaskProgressInfo): 必须给 chapterIndex/dayGroupIndex.
    // 缺省 0 会让 TaskDataMgr 把 144 条条件=3100(PatrolLevel) 的任务塞进
    // mainTaskData/dailyTaskData, TaskTools.GetTaskProgress -> PatrolDataManager
    // 对 nil 的 patrolLevelInfo 做 pairs -> 崩. 选没有乌啦啦任务的章节(101)与日常分组(10001).
    pb.bfield(47, pb.concat(
      pb.vfield(1, 0),      // dayTaskPoint (required)
      pb.vfield(3, 101),    // chapterIndex (required)
      pb.vfield(4, 10001),  // dayGroupIndex (required)
      pb.vfield(5, 0),      // weekTaskPoint (required)
    )),
  );
}

// ---- 月签到 (SignInMonthlyManager / UISignInMonthlyCtrl) ----
// SignInfo{1=monthGetSignRewardTimes 本月已领天数, 2=lastGetSignRewardTime, 3=days 本次可领的第几天}
// 客户端凭 days > monthGetSignRewardTimes 判"今天还能签" -> 弹面板. 所以当天已签时必须 days==times,
// 否则每次进大厅都弹(旧版踩过: 恒回 times+1 -> 每次弹、永远"第 1 天"). 状态落存档, 跨自然月清零.
const DAY = 86400, TZ8 = 8 * 3600;
const signDayIdx = (): number => Math.floor((Number(now()) + TZ8) / DAY);
const signMonthKey = (): number => { const d = new Date(Number(now()) * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth() + 1; };

// 跨月归零; 返回是否改动了存档(需要回写).
function signRoll(s: SaveData): boolean {
  const mk = signMonthKey();
  if (s.signin.month !== mk) { s.signin = { month: mk, times: 0, day: -1, lastTime: 0 }; return true; }
  return false;
}

export function signInfoBody(): Buffer {
  const s = loadSave();
  if (signRoll(s)) saveSave(s);
  const signedToday = s.signin.day === signDayIdx();
  return pb.concat(
    pb.vfield(1, s.signin.times),                          // 本月已签天数
    pb.vfield(2, s.signin.lastTime),                       // 上次签到时间
    pb.vfield(3, s.signin.times + (signedToday ? 0 : 1)),  // 本次可领第几天(当天已签 = times, 不再弹)
  );
}

function getSignRewardS2C(): Buffer {
  const s = loadSave();
  let dirty = signRoll(s);
  const today = signDayIdx();
  if (s.signin.day !== today) {                            // 一天只签一次, 跨天才推进
    s.signin.times += 1;
    s.signin.day = today;
    s.signin.lastTime = Number(now());
    dirty = true;
  }
  if (dirty) saveSave(s);
  // GetSignReward_S2C{optional int32 monthGetSignRewardTimes=2; lastGetSignRewardTime=3; Rewards rewards=4}
  return pb.concat(pb.vfield(2, s.signin.times), pb.vfield(3, s.signin.lastTime), pb.bfield(4, Buffer.alloc(0)));
}

function getNextDayUpdateDataS2C(): Buffer {
  const t = Number(now());
  const dayEdge = (Math.floor((t + TZ8) / DAY) + 1) * DAY - TZ8;      // 下一个 4:00(UTC+8)
  const d = new Date(t * 1000);
  const firstNext = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return pb.concat(
    pb.vfield(12, dayEdge + (7 - ((firstNext.getUTCDay() + 6) % 7)) * DAY - TZ8), // nextWeekRefreshTime
    pb.bfield(13, signInfoBody()),                                               // monthSign
    pb.vfield(17, Math.floor(firstNext.getTime() / 1000) - TZ8),                 // nextMonthRefreshTime
    pb.vfield(19, dayEdge),                                                      // nextDayRefreshTime
  );
}

function getAllActivityS2C(req: GsRequest): Buffer {
  // GetAllActivity_s2c{ required int32 activityVersion=1 } —— 必须回显请求里的版本号,
  // 否则 ActivityDataMgr.CheckVersionChange 判版本变化 -> 清数据 + 再发 GetAllActivity (死循环).
  const f = req?.proto ? pb.decodeFields(req.proto).find((x) => x.field === 1) : null;
  return pb.vfield(1, Number(f?.value ?? 0));
}

function getOtherPlayerInfoS2C(req: GsRequest): Buffer {
  // GetOtherPlayerInfo_S2C{ repeated friendInfoList=1; required int32 type=2 } —— type 必填, 回显请求的
  const f = req?.proto ? pb.decodeFields(req.proto).find((x) => x.field === 2) : null;
  return pb.vfield(2, Number(f?.value ?? 1));
}

// ---- 进主城前的串行拉取 (PlayerMsg.MsgListBeforeEnterMainCity) ----
// 客户端每收到一个回包才会发下一个, 任何一个没有回包都会把加载界面卡住.
function getPayShopDataAfterLoginS2C(): Buffer {
  // GetPayShopDataAfterLogin_S2C{ required PayShopData payShopData=1 }
  // PayShopData{ required int64 payConfVersion=5 }
  return pb.bfield(1, pb.vfield(5, 1));
}

function getWaitOrderDataS2C(): Buffer {
  return Buffer.alloc(0); // GetWaitOrderData_S2C{ repeated string idS=1 }
}

function loginOpenSmallBattlePanelS2C(): Buffer {
  // LoginOpenSmallBattlePanel_S2C{ required int32 state=1; repeated SmallBattleState=2 }
  return pb.vfield(1, 0);
}

function getWeaponListPageS2C(req: GsRequest): Buffer {
  // GetWeaponListPage_S2C{ repeated WeaponInfo weaponInfos=1; required int32 page=2; required bool next=3 }
  // 每个角色下发一把默认式仗实例(客户端 WeaponDataManager 只认服务端下发的实例).
  const s = loadSave();
  const page = reqNum(req, 1) ?? 0;
  const infos = weaponInstances(s).map((w) => weaponInfoFromInst(s, w));
  // 物化可能当场给空/撞号的实例发了新 onlyId —— 不落盘下次登录又换一套号, 客户端按 onlyId 索引就全乱.
  saveSave(s);
  log("info", "weapon", `GetWeaponListPage page=${page} -> ${infos.length} 把式仗`);
  return pb.concat(
    ...infos.map((w) => pb.bfield(1, w)), // weaponInfos
    pb.vfield(2, page),                   // page (required)
    pb.vfield(3, 0),                      // next (required bool)
  );
}

function getPerkInfoListPageS2C(): Buffer {
  // GetPerkInfoListPage_S2C{ repeated perkInfo=1; required int32 page=2; required bool next=3 }
  return pb.concat(pb.vfield(2, 1), pb.vfield(3, 0));
}

function getRevelationInfoListPageS2C(): Buffer {
  // GetRevelationInfoListPage_S2C{ repeated revelationInfo=1; required int32 page=2; required bool next=3 }
  return pb.concat(pb.vfield(2, 1), pb.vfield(3, 0));
}

function getOpenFunctionDataS2C(): Buffer {
  // GetOpenFunctionData_S2C{ repeated int32 conditionSet=1 }
  // 离线新号: 一次把全部 condition id 都标为已解锁(等价于真服随教程/关卡逐步推送的结果).
  // 客户端 FuncTab 只内建 0(永久锁)/1(永久开)/5001(依赖链), type 1001(等级)/3001(通关)
  // 及其余通用类型都回落到 unLock_list[conditionId]; 空集时 unLock_list 恒空 -> 主城按钮全锁.
  return pb.concat(...COMMON_CONDITION_IDS.map((id) => pb.vfield(1, id)));
}

function changeStepS2C(req: GsRequest): Buffer {
  // ChangeStep{ required string guideData=1; optional int32 completedId=2 } -> ChangeStep_S2C{ optional string guideData=1 }
  // 真服语义: 存下客户端上报的全量引导流并原样回显, 登录时再经 GuideInfo 回填.
  if (req?.proto) {
    const f = pb.decodeFields(req.proto).find((x) => x.field === 1 && x.wire === 2);
    if (f && Buffer.isBuffer(f.value)) guideData = f.value.toString("utf8");
  }
  return pb.sfield(1, guideData);
}

function clientDataOverLoginS2C(): Buffer {
  return Buffer.alloc(0); // ClientDataOverLogin_S2C{}
}

function changeSecretaryS2C(req: GsRequest): Buffer {
  const id = reqNum(req, 1) ?? 0; // ChangeSecretary{ required int32 secretary=1 }
  if (id) {
    const s = loadSave();
    s.player.secretary = id;
    // 新看板要能在 leaderInfo 里拿到模型/立绘, 不在列表就补一个默认条目.
    if (!s.characters.some((c) => c.id === id)) s.characters.push(defaultCharacter(id));
    saveSave(s);
  }
  return pb.vfield(2, id); // ChangeSecretary_S2C{ secretary=2 } 客户端靠回显改本地 playerInfo.secretary
}

// ---- 战斗 ----
// 战斗逻辑在客户端独立的 fightLua VM(liblua54.so) 里跑; 游戏服侧的职责只有两件:
//   开战前发 battleEnterInfo(战场初始数据) + 收结算(11018).
// 战场内 12xxx 的实时同步走独立「战斗服」(ServerInfo.serverType=2), 由我们自己的 KCP 网关
// 一并承接(网关按 msgId 派发, 不分主/战). 这里先把 11028 这条「进战斗」最小闭环打通,
// 具体字段按 proto/msg.proto:BattleEnterInfo + 抓到的真实请求构造, 之后按客户端日志迭代.
export const BATTLE_SERVER_TYPE = 2; // ServerInfo.serverType: 2=战斗服

// 战斗单位属性 (CalcPropModelInfo): attributeMap=1 repeated ProtoHashInt2Float{key=1,value=2 double}
// key 约定: 100=hp 101=atk 102=def 103=en 104=crit (与旧版实现回退口径一致).
// TODO: 数值目前是占位, 待从客户端 Attribute 表按等级/突破算真值.
function battlePropModelInfo(capability: number, attrs: Array<[number, number]>): Buffer {
  return pb.concat(
    pb.vfield(3, Math.round(capability)), // capability
    ...attrs.map(([k, v]) => pb.bfield(1, pb.concat(pb.vfield(1, k), pb.dblfield(2, v)))), // attributeMap
  );
}

const DEFAULT_ATTRS: Array<[number, number]> = [[100, 1000], [101, 100], [102, 50], [103, 100], [104, 0]];

// WeaponInfo (msg.proto): 武装(式仗)实例. required: id/leaderId/exp/level/breachLevel/onlyId/getTime/
// defleaderId/skinId/lockState/recastingTime/recastingSkillTime —— 一个都不能缺, 否则 Lua 解码报错.
// 19/20 是**终身洗练次数**, 不是时间戳 (客户端只拿它判"首次洗要不要弹确认").
function weaponInfoFromInst(s: SaveData, w: SaveWeapon): Buffer {
  // 17/18 编码函数对"没有这组数据"回空 Buffer; 这里必须整个字段省略, 不能发一个空的 message
  // —— 空 message 解出来是张空表, 客户端那些 `18 and 18.secondaryPropInfo...` 的判据就全走偏了.
  const randBuf = weaponRandomInfoBuf(w.rand);
  const lastBuf = lastBufFor(w.rand, w.last);
  return pb.concat(
    pb.vfield(1, w.cfg),                    // id (配置id, required)
    pb.vfield(2, w.leaderId),               // leaderId (required)
    pb.vfield(3, w.exp),                    // exp (required)
    pb.vfield(4, w.level),                  // level (required)
    pb.vfield(5, w.breach),                 // breachLevel (required)
    pb.sfield(6, w.onlyId),                 // onlyId (required string)
    pb.bfield(7, battlePropModelInfo(weaponPower(w.cfg, w.level, w.breach), weaponAttrsOf(w))), // calcPropModelInfo
    pb.vfield(8, Math.floor(s.regTime) || 0), // getTime (required, 秒) —— 存档没记单把的获得时刻, 统一用建档时刻
    pb.vfield(9, defLeaderOf(w)),           // defleaderId (required) 默认式仗=所属角色, 其余=0
    pb.vfield(10, w.skin),                  // skinId (required)
    pb.vfield(11, w.lock),                  // lockState (required)
    pb.vfield(12, w.refine),                // refineLevel
    ...(randBuf.length ? [pb.bfield(17, randBuf)] : []), // weaponRandomInfo (生效中的随机数据)
    ...(lastBuf.length ? [pb.bfield(18, lastBuf)] : []), // lastWeaponRandomInfo (洗出来没确认的那半)
    pb.vfield(19, w.recastingTime),         // recastingTime (required) 已洗属性次数
    pb.vfield(20, w.recastingSkillTime),    // recastingSkillTime (required) 已洗技能次数
  );
}

/**
 * 武装写操作后刷新面板的那条 Data_Push:
 *   weaponChanged=7 刷武装本身, leaderAttrChanged=5 刷穿戴者(精炼/突破都改他的属性),
 *   changeMoney=2 / changePart=10 刷顶栏货币与背包素材 —— 扣了东西不推这两路,
 *   客户端的数量要等下次登录才对得上.
 * 金币(id 10 之类)在 Items_Xls 里 itemType=1, 只能走 MoneyPart; 硬塞进 Part 客户端没有这行.
 */
function weaponDataPush(s: SaveData, w: SaveWeapon | null, eff: Effects): Buffer {
  const parts: Buffer[] = [];
  if (w) {
    parts.push(pb.bfield(7, pb.bfield(1, weaponInfoFromInst(s, w))));
    const c = w.leaderId > 0 ? s.characters.find((x) => x.id === w.leaderId) : undefined;
    if (c) parts.push(pb.bfield(5, pb.bfield(1, leaderInfo(s, c))));
  }
  const money: number[] = [];
  const items: number[] = [];
  for (const id of [...new Set([...eff.money, ...eff.items])]) {
    (itemType(id).type === ITEMTYPE.Money ? money : items).push(id);
  }
  if (money.length) {
    parts.push(pb.bfield(2, pb.concat(...money.map((id) =>
      pb.bfield(1, pb.concat(pb.vfield(1, Math.floor(countItem(s, id))), pb.vfield(2, id)))))));
  }
  const shown = items.filter((id) => ITEM_VALID.has(id));
  if (shown.length) parts.push(pb.bfield(10, pb.concat(...shown.map((id) => pb.bfield(1, partBody(id, countItem(s, id)))))));
  return pb.concat(...parts);
}

/**
 * Rewards{ rewardItem } 的一条. RewardItem{ itemId=1; curCount=2; count=3; type=4; rewardParInfo=5 }
 * 里 rewardParInfo{ oldLv=1; level=2; par=3(string) } 是展示弹窗取的那个数, 缺了会崩 -> 一律带上.
 */
const rewardItemBody = (id: number, n: number, type = 0): Buffer =>
  pb.concat(
    pb.vfield(1, id), pb.vfield(2, n), pb.vfield(3, n), pb.vfield(4, type),
    pb.bfield(5, pb.concat(pb.vfield(1, 0), pb.vfield(2, 0), pb.sfield(3, String(n)))),
  );

const rewardsBuf = (rows: Array<[number, number]>, type = 0): Buffer =>
  pb.concat(...rows.map(([id, n]) => pb.bfield(1, rewardItemBody(id, n, type))));

/** 某一档 Consume_Xls 回显成 Rewards (客户端这几条 handler 不读它, 只留给抓包对账). */
function consumeRewards(cid: number): Buffer {
  const ids = arr("Consume", cid, "itemId").map(Number);
  const nums = arr("Consume", cid, "num").map(Number);
  return rewardsBuf(ids.map((id, i) => [id, nums[i] ?? 0] as [number, number]));
}

// ActiveSkillInfo{ required id/level/type } type: 1=主动... 旧版口径: 1=武器射击(shootingtype) 2=主动 3=极奏
function activeSkill(id: number, level: number, type: number): Buffer {
  return pb.concat(pb.vfield(1, id), pb.vfield(2, level), pb.vfield(3, type));
}

// TalentSkill{ required id/level/state } —— 养成面板取自 Leader 表, 战斗包取自武器 weaponSkillId.
function talentSkill(id: number, level: number): Buffer {
  return pb.concat(pb.vfield(1, id), pb.vfield(2, level), pb.vfield(3, 1), pb.vfield(4, 1));
}

// ProtoHashInt2Int{ required key=1; required value=2 }
const protoHash = (key: number, value: number): Buffer =>
  pb.concat(pb.vfield(1, key), pb.vfield(2, value));

// StickSkillLevel{ required id=1 level=2 state=3 } —— id 是**技能id**(不是 LeaderWandSkill 表id).
const stickSkillLevelBuf = (id: number, level: number): Buffer =>
  pb.concat(pb.vfield(1, id), pb.vfield(2, level), pb.vfield(3, 1));

// LeaderBattleInfo (msg.proto): 战斗所需的武将数据; 基础数值取自存档, 武器/技能 id 取自客户端表
// (data/leader.ts, data/weapon.ts). required 只有 id; weapon/activeSkills/talentSkills 供 Core 建单位.
function leaderBattleInfo(s: SaveData, c: SaveCharacter): Buffer {
  const lm = LEADER[c.id];
  const w = equippedWeaponOf(s, c.id);
  const wm = WEAPON[w.cfg];
  const shooting = wm ? wm[0] : 0;
  const weaponSkills = wm ? wm[1] : [];
  return pb.concat(
    pb.vfield(1, c.id),   // id (required)
    pb.vfield(2, c.level),
    pb.vfield(3, c.exp),
    pb.vfield(4, c.star),
    pb.vfield(5, c.starLevel),
    pb.vfield(6, c.favorabilityLevel),
    pb.vfield(7, c.favorabilityExp),
    pb.vfield(8, c.clothingId),
    pb.bfield(9, weaponInfoFromInst(s, w)), // weapon
    pb.bfield(10, battlePropModelInfo(heroPower(c.id, c.level, c.breach, w.cfg), heroAttrs(s, c))), // calcPropModelInfo
    ...weaponSkills.map((id) => pb.bfield(11, talentSkill(id, skillLv(c, id, "talent")))), // talentSkills
    ...(lm
      ? [
          pb.bfield(12, activeSkill(shooting, skillLv(c, shooting, "active"), 1)), // 武器射击
          pb.bfield(12, activeSkill(lm[1], skillLv(c, lm[1], "active"), 2)),       // 主动
          pb.bfield(12, activeSkill(lm[2], skillLv(c, lm[2], "active"), 3)),       // 极奏
        ]
      : []),
    pb.vfield(14, c.signLv),  // signLv
    pb.dblfield(16, heroPower(c.id, c.level, c.breach, w.cfg)), // capability
  );
}

// 从请求里解 StartSoloBattle.leaderSquadInfo(3).leaderSet(2)[].leaderId(2) —— 客户端要上场的武将.
function squadLeaderIds(req: GsRequest): number[] {
  if (!req?.proto) return [];
  const squad = pb.decodeFields(req.proto).find((x) => x.field === 3 && x.wire === 2);
  if (!squad || !Buffer.isBuffer(squad.value)) return [];
  const ids: number[] = [];
  for (const f of pb.decodeFields(squad.value)) {
    if (f.field === 2 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      const lid = pb.decodeFields(f.value).find((x) => x.field === 2 && x.wire === 0);
      if (lid) ids.push(Number(lid.value));
    }
  }
  return ids;
}

// BattlePlayerInfo: 单个玩家的战斗数据(武将列表 + 当前出战武将).
function battlePlayerInfo(s: SaveData, leaderIds: number[]): Buffer {
  const leaders = leaderIds.length ? leaderIds : s.characters.map((c) => c.id);
  return pb.concat(
    pb.vfield(1, s.player.uid),                 // playerId (required)
    pb.sfield(2, s.player.name || "指挥官"),     // name (required)
    pb.vfield(3, s.player.level),               // level (required)
    pb.vfield(4, leaders[0] ?? 0),              // curLeaderId (required)
    ...leaders.map((id) => pb.bfield(5, leaderBattleInfo(s, characterById(s, id)))), // leaders
    pb.vfield(7, 0),                            // playerIndex
  );
}

// 客户端 Core 用 levelInstanceId 查 NewLevelInstance 表, 用 levelStageId 查 NewLevelStage.
// 主线关卡(MainLevel.type=1): levelInstanceId = MainLevel.levelId, levelStageId = MainLevel.stageLevel.
// 给成"关卡自身 id"会查不到 -> FightClientLua StartLoading 拿 nil -> 卡在进战斗加载.
// 数据表见 data/mainlevels.ts (从客户端 Lua 反解).
const BATTLE_NET_INSTANCE_ID = 2872; // 服务器战斗副本实例 id(旧版实现固定值, 客户端不据此查表)

// 结算(OverMainLevel)里 battleId 必填, 但请求不带关卡 id -> 记下最近一次 StartSoloBattle 的关卡.
let lastBattleLevelId = 0;
let battleUniqueSeq = 1;

function resolveLevelInstance(levelId: number): { levelInstanceId: number; levelStageId: number; known: boolean } {
  const m = MAIN_LEVEL[levelId];
  if (m) return { levelInstanceId: m[0], levelStageId: m[1], known: true };
  return { levelInstanceId: levelId, levelStageId: 1, known: false };
}

// BattleEnterInfo (msg.proto): 战场初始数据. 五个 required + teamCapability(double) 必给.
function battleEnterInfo(req: GsRequest): Buffer {
  const s = loadSave();
  const levelId = reqNum(req, 1) ?? 0;     // StartSoloBattle.battleId = 关卡行 id (MainLevel.id)
  const battleType = reqNum(req, 2) ?? 1;  // BattleType
  const leaderIds = squadLeaderIds(req);
  const { levelInstanceId, levelStageId, known } = resolveLevelInstance(levelId);
  if (!known) log("warn", "battle", `level=${levelId} 不在 MainLevel 表 -> levelInstanceId 回退用关卡id(可能卡加载)`);
  const capability = (leaderIds.length || s.characters.length || 1) * 100;
  const seed = (Date.now() >>> 0) & 0x7fffffff;
  return pb.concat(
    pb.vfield(1, BATTLE_NET_INSTANCE_ID), // battleId (服务器副本实例id)
    pb.vfield(2, levelInstanceId),        // levelInstanceId (NewLevelInstance 键, required)
    pb.vfield(3, levelStageId),           // levelStageId (required)
    pb.vfield(4, battleType),             // battleType (required)
    pb.vfield(5, levelId),                // levelId (关卡行 id, required)
    pb.bfield(6, battlePlayerInfo(s, leaderIds)), // battlePlayerInfo (repeated)
    pb.vfield(7, 1),                      // indieGame = true
    pb.vfield(10, seed),                  // randomSeed
    pb.dblfield(11, capability),          // teamCapability (required double)
    pb.sfield(12, "1"),                   // customParams[0]
    pb.vfield(14, seed),                  // randomSecretKey (战斗收尾算 MD5 用, 缺了报 "randomSecretKey nil")
  );
}

// StartSoloBattle_S2C{ required bool result=1; required BattleEnterInfo battleEnterInfo=2; optional ServerInfo server=3 }
function startSoloBattleS2C(req: GsRequest): Buffer {
  const s = loadSave();
  const battleId = reqNum(req, 1);
  const battleType = reqNum(req, 2);
  if (battleId) lastBattleLevelId = battleId;
  const leaderIds = squadLeaderIds(req);
  // 战斗服地址: 指向本进程的 KCP 网关(它同样收 UDP 战斗消息). 战场内 12xxx 同步尚未实现,
  // 先把地址给出去让客户端能连; 真实战斗服行为待后续迭代.
  const server = pb.concat(
    pb.vfield(1, config.server.serverId),   // serverId
    pb.vfield(2, BATTLE_SERVER_TYPE),        // serverType=2 战斗服
    pb.sfield(3, config.server.publicHost),  // serverIP
    pb.vfield(4, config.gateway.port),       // socketPort
    pb.vfield(5, 1),                         // serverVersion
  );
  log("info", "battle", `StartSoloBattle battleId=${battleId} type=${battleType} leaders=[${leaderIds.join(",")}] uid=${s.player.uid} -> battleEnterInfo`);
  return pb.concat(
    pb.vfield(1, 1),       // result=true
    pb.bfield(2, battleEnterInfo(req)), // battleEnterInfo
    pb.bfield(3, server),  // server
  );
}

// BattleLogin_S2C{ required int32 kcpConvId=1; required string kcpIp=2; required int32 kcpPort=3 }
// 战斗服登录: 直接把我们的 KCP 网关当作战斗服的 KCP 端点回给客户端.
function battleLoginS2C(req: GsRequest): Buffer {
  log("info", "battle", `BattleLogin uid=${reqNum(req, 1)} -> kcp ${config.server.publicHost}:${config.gateway.port}`);
  return pb.concat(
    pb.vfield(1, 1),                        // kcpConvId
    pb.sfield(2, config.server.publicHost), // kcpIp
    pb.vfield(3, config.gateway.port),      // kcpPort
  );
}

// ---- 战斗结算 ----
// 客户端打完发 3004 OverMainLevel{result, starArray, fightPar.attackTime}; 必须回 OverMainLevel_S2C
// (required: uniqueId/battleId/passTime/playerInfo). 缺 playerInfo -> 结算面板
// UIBattleSettlementNewMainLevel:144 索引 nil 崩、退不出战斗; 缺 uniqueId -> UIBattleMsg.CheckSameUniqueId
// 报"没有结算数据". 关卡 id 请求里没有, 用最近一次 StartSoloBattle 记下的.
function reqNums(req: GsRequest | undefined, field: number): number[] {
  if (!req?.proto) return [];
  return pb.decodeFields(req.proto).filter((x) => x.field === field && x.wire === 0).map((x) => Number(x.value));
}

// 取嵌套 message(req[outer][inner]) 的 varint 值.
function nestedNum(req: GsRequest | undefined, outer: number, inner: number): number | null {
  if (!req?.proto) return null;
  const f = pb.decodeFields(req.proto).find((x) => x.field === outer && x.wire === 2);
  if (!f || !Buffer.isBuffer(f.value)) return null;
  const g = pb.decodeFields(f.value).find((x) => x.field === inner && x.wire === 0);
  return g ? Number(g.value) : null;
}

// OverSoloPlayerInfo{ required oldExp/oldLevel/newExp/newLevel }
function overSoloPlayerInfo(s: SaveData): Buffer {
  return pb.concat(
    pb.vfield(1, s.player.exp),   // oldExp
    pb.vfield(2, s.player.level), // oldLevel
    pb.vfield(3, s.player.exp),   // newExp
    pb.vfield(4, s.player.level), // newLevel
  );
}

// MainLevelInfo{ required id/passTime }
function mainLevelInfoBody(id: number, stars: number[], passTime: number): Buffer {
  return pb.concat(
    pb.vfield(1, id),                    // id (required)
    ...stars.map((v) => pb.vfield(2, v)),// stars
    pb.vfield(3, 1),                     // todayAttackNum
    pb.vfield(4, 1),                     // attackNum
    pb.vfield(5, BigInt(Date.now())),    // lastAttackTime (ms)
    pb.vfield(10, passTime),             // passTime (required)
  );
}

function overMainLevelS2C(req: GsRequest): Buffer {
  const s = loadSave();
  const result = reqNum(req, 1) ?? 0;        // 0无/1平/2胜/3负
  const win = result === 2;
  const stars = reqNums(req, 2);
  const passTime = nestedNum(req, 3, 5) ?? 0; // fightPar.attackTime
  const levelId = lastBattleLevelId;
  const uniqueId = (Date.now() % 0x3fffffff) + battleUniqueSeq++;
  // 通关落盘: 把本关写入存档 levels, 重登仍保留(否则"打完这关"只活在客户端本地, 重登又变没打).
  if (win && levelId) {
    const prev = s.levels[String(levelId)] || [];
    s.levels[String(levelId)] = [...new Set([...prev, ...stars])].sort((a, b) => a - b);
    saveSave(s);
  }
  log("info", "battle", `OverMainLevel level=${levelId} result=${result} stars=[${stars.join(",")}] passTime=${passTime} uniqueId=${uniqueId}`);
  return pb.concat(
    pb.vfield(1, uniqueId),                 // uniqueId (required)
    pb.vfield(2, levelId),                  // battleId (required)
    pb.vfield(3, win ? 1 : 0),              // result
    pb.vfield(6, passTime),                 // passTime (required)
    pb.bfield(7, overSoloPlayerInfo(s)),    // playerInfo (required)
    pb.bfield(8, mainLevelInfoBody(levelId, stars, passTime)), // mainLevelInfo
    pb.vfield(9, 1),                        // firstPass
    pb.vfield(10, 1),                       // multipleValue
  );
}

// ---- 抽卡 (按池真实掉落 roll) ----
// 掉落链来自客户端 LotteryInstance_Xls -> Drop_Xls -> DropSet_Xls -> DropGroup_Xls (src/gacha.ts).
// 每次出货归属该池的真实掉落集(角色池出角色/武器池出武器/材料等), 客户端才会正常展示.
// 调试开关 SLD_GACHA_FORCE_QUALITY=5: 出货强制为该品质的随机本体, 只影响展示/入库, 不改掉落链.
// 类型: SLD_GACHA_FORCE_TYPE=leader/weapon 强制角色/律叶; 留空则按本次 roll 到的类型推断.
const GOLD_LEADER_IDS = Object.keys(LEADER_QUALITY).map(Number).filter((k) => LEADER_QUALITY[k] === 5 && LEADER[k]);
const GOLD_WEAPON_IDS = Object.keys(WEAPON_GRATE).map(Number).filter((k) => WEAPON_GRATE[k] === 5 && WEAPON[k] && WEAPON_BREAK[k]);
// 登录字段20 SwearInfo{ repeated SwearPoolInfo poolInfo=2 } (只回已抽过的池; 空则空消息).
export function swearInfoBody(s: SaveData): Buffer {
  const pools = Object.entries(s.gacha)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => pb.concat(pb.vfield(1, Number(k)), pb.vfield(2, n)));
  return pools.length ? pb.concat(...pools.map((p) => pb.bfield(2, p))) : Buffer.alloc(0);
}

// SwearHero{ required cardBoxId=1; required number=2 } -> SwearHero_S2C + 后置 ShowItem_Push.
function swearHeroS2C(req: GsRequest): GsResult {
  const s = loadSave();
  const poolId = reqNum(req, 1) ?? 0;
  const n = Math.max(0, Math.min(20, reqNum(req, 2) ?? 0));
  const rewards: Buffer[] = [];
  const drawn: number[] = [];
  const newLeaderIds: number[] = []; // 本次新获得的角色 -> 后置 Data_Push 让大厅角色表实时刷新
  for (let i = 0; i < n; i++) {
    // 掉落链理论上不会失败(见 gacha.ts MAX_DEPTH); 仍留重试兜底, 避免单抽静默失败
    // 导致 number < 请求次数让客户端结果 UI 卡住.
    let dr = poolDraw(poolId);
    for (let t = 0; !dr && t < 5; t++) dr = poolDraw(poolId);
    if (!dr || !dr.itemId) continue;
    let id = dr.itemId;
    if (config.gacha.forceQuality > 0) {
      const wantLeader = config.gacha.forceType === "leader" || (config.gacha.forceType !== "weapon" && !!LEADER[id]);
      const pool = wantLeader ? GOLD_LEADER_IDS : GOLD_WEAPON_IDS;
      if (pool.length) id = pool[Math.floor(Math.random() * pool.length)];
    }
    const num = Math.max(1, dr.num);
    let rItem = id, rNum = num, rType = 0, par = String(id);
    if (LEADER[id]) {
      if (!s.characters.some((c) => c.id === id)) {
        rType = 1; // 新角色
        s.characters.push(defaultCharacter(id));
        newLeaderIds.push(id);
      } else {
        // 重复角色 -> 意识碎片(真服口径): decomposeId × decomposeNum; par 指回角色 id.
        const db = LEADER_DEBRIS[id];
        if (db) {
          rItem = db[0]; rNum = db[1]; rType = 0;
          if (ITEM_VALID.has(rItem)) s.items[String(rItem)] = (s.items[String(rItem)] || 0) + rNum;
        } else {
          rType = 1; // 无分解配置: 仍给角色
        }
      }
    } else if (WEAPON[id]) {
      rType = 2; // 获得式仗(建实例; 无突破配置的不建, 否则登录时崩)
      if (WEAPON_BREAK[id] && !s.weapons.some((w) => w.cfg === id)) grantWeapon(s, id);
    } else if (ITEM_VALID.has(id)) {
      s.items[String(id)] = (s.items[String(id)] || 0) + num;
    }
    // recordInfo.itemId 必须是"抽到的本体"(角色/律叶), 不能是碎片:
    // - 客户端 GachaDataMgr 用 recordInfo.itemId 去匹配 Rewards[*].rewardParInfo.par,
    //   匹配上才把 parid/parcount 填成碎片 (GachaResultItemCtrl 只对 Leader/Weapon 建卡).
    // - 一旦 recordInfo 里出现碎片(Item), GachaResultItemCtrl 的 itemQuality 为 nil ->
    //   GetEffectNameWithQuality(nil) 报错, 十连结果页统计不到第 10 个特效 -> 跳过卡死.
    drawn.push(id);
    // RewardItem{ itemId=1; curCount=2; count=3; type=4; rewardParInfo=5 }
    // rewardParInfo{ required oldLv=1; level=2; par=3 } (展示弹窗取 par, 缺了会崩)
    rewards.push(pb.concat(
      pb.vfield(1, rItem), pb.vfield(2, rNum), pb.vfield(3, rNum), pb.vfield(4, rType),
      pb.bfield(5, pb.concat(pb.vfield(1, 0), pb.vfield(2, 0), pb.sfield(3, par))),
    ));
  }
  // 以实际出货数为准, 避免任何单次 roll 失败时 number 与 rewards 数量不一致导致客户端卡住.
  const got = drawn.length;
  const total = (s.gacha[String(poolId)] || 0) + got;
  s.gacha[String(poolId)] = total;
  saveSave(s);
  log("info", "gacha", `SwearHero pool=${poolId} n=${n} got=${got} -> [${drawn.join(",")}]`);
  const rewardsMsg = pb.concat(...rewards.map((p) => pb.bfield(1, p))); // Rewards{ rewardItem }
  // recordInfo=5 (SwearRecordInfo{ itemId=1; itemNum=2; timeStamp=3; drawCardPoolId=4; recordId=7 })
  const nowSec = Math.floor(Date.now() / 1000);
  const recs = drawn.map((lid, i) => pb.concat(
    pb.vfield(1, lid), pb.vfield(2, 1), pb.vfield(3, nowSec), pb.vfield(4, poolId), pb.vfield(7, total - got + i + 1),
  ));
  const body = pb.concat(
    pb.vfield(1, got),                                                  // number
    rewards.length ? pb.bfield(2, rewardsMsg) : null,                   // rewards
    // swearNumberInfo=3 (SwearNumberInfo{ bottomgroup=1; dropbottomMap=2 }): 客户端 GachaDataMgr:656
    // 无保护读 .bottomgroup, 缺了必崩 -> 抽卡"点了没反应". 必须给(哪怕 bottomgroup=0).
    pb.bfield(3, pb.vfield(1, 0)),
    // poolInfo=4 (SwearPoolInfo{ id=1; totalTimes=2; upSwearId=3; specialCoinCount=5 })
    pb.bfield(4, pb.concat(pb.vfield(1, poolId), pb.vfield(2, total), pb.vfield(3, 0), pb.vfield(5, 0))),
    ...recs.map((r) => pb.bfield(5, r)),                                // recordInfo
    // dropPropTimeInfo=7 (DropPropTimeInfo{ required bottomGroup2=1; repeated ProtoHashInt2Int dropPropTime=2 })
    pb.bfield(7, pb.concat(pb.vfield(1, 0), pb.bfield(2, pb.concat(pb.vfield(1, 0), pb.vfield(2, 0))))),
  );
  // 抽卡结果靠 ShowItem_Push 展示. 关键: ReturnPackageInfo 走 replenishList, 而 Lua 的
  // HttpClientForLua.Ignore_Replenish_MsgID 里 ShowItem_Push 会被过滤掉 -> 必须走 completedList:
  // 主包(SwearHero_S2C)放 completedList 单包槽, ShowItem_Push 走 PushMsg2Client(同进 completedList, 晚于主包).
  const showItem = pb.concat(pb.vfield(1, 56), rewards.length ? pb.bfield(2, rewardsMsg) : null);
  // 新角色另推 Data_Push(900011){ leaderAttrChanged=5{ leaderInfo=1[...] } }:
  // 客户端 HeroMsg.LeaderAttrChangedHandler 才把角色加进大厅角色表(SetLeaderDataForId -> SetHas(true));
  // 只靠登录的 PlayerLoginGetInfo.leaderInfo 得重登才看得到, 实时刷新必须靠这条推送.
  const extraPushes: Array<[number, Buffer]> = [];
  if (rewards.length) extraPushes.push([CMD.ShowItemPush, showItem]);
  if (newLeaderIds.length) {
    const infos = newLeaderIds.map((lid) => leaderInfo(s, characterById(s, lid)));
    extraPushes.push([CMD.DataPush, pb.bfield(5, pb.concat(...infos.map((b) => pb.bfield(1, b))))]);
  }
  return { body, pushes: [], extra: extraPushes, mainInCompleted: true };
}

// GetSwearRecord_S2C{ required cardBoxId=1; required offsetIndex=2; required totalRecordNumber=4 }
function getSwearRecordS2C(req: GsRequest): Buffer {
  return pb.concat(pb.vfield(1, reqNum(req, 1) ?? 0), pb.vfield(2, reqNum(req, 2) ?? 1), pb.vfield(4, 0));
}

// SwitchClothing{ required leaderId=1; required clothingId=2 } -> SwitchClothing_S2C.
// 客户端 SkinMsg:58 读 destinationLeaderBean, 缺了换皮肤就报 "destinationLeaderBean nil" 失败.
function switchClothingS2C(req: GsRequest): Buffer {
  const s = loadSave();
  const lid = reqNum(req, 1) ?? 0;
  const cid = reqNum(req, 2) ?? 0;
  let other = 0;
  if (lid && cid > 0) {
    for (const c of s.characters) if (c.id !== lid && c.clothingId === cid) other = c.id;
    for (const c of s.characters) {
      if (c.id === lid) c.clothingId = cid;
      else if (other && c.id === other) c.clothingId = 0;
    }
    saveSave(s);
    log("info", "skin", `SwitchClothing ${lid} <- ${cid} off=${other}`);
  }
  return pb.concat(
    pb.bfield(2, leaderInfo(s, characterById(s, lid))),               // destinationLeaderBean
    pb.bfield(3, leaderInfo(s, characterById(s, other || lid))),     // sourceLeaderBean
  );
}

// UpgradeLeader{ required leaderId=1; repeated ProtoHashInt2Int itemInfo=3 } -> UpgradeLeader_S2C{} + Data_Push.
// 客户端 UX 靠推送刷新(leaderAttrChanged), 只回空包不会更新面板.
function upgradeLeaderS2C(req: GsRequest): GsResult {
  const s = loadSave();
  const lid = reqNum(req, 1) ?? 0;
  const c = s.characters.find((x) => x.id === lid);
  if (!c) return deny(`UpgradeLeader 无此角色 ${lid}`);
  const eff = newEffects();
  const [gained, why] = payItemList(s, reqHashList(req, 3), eff);
  if (why) return deny(`UpgradeLeader ${lid} 材料不足 ${why}`);
  c.exp += gained;
  const cap = leaderMaxLv(c.id, c.breach) || 80;   // 本突上限; 无突破行(表缺)才兜 80
  const r = upgradeByExp(c.level, c.exp, cap, leaderLevelExp);
  c.level = r.level;
  c.exp = r.exp;
  saveSave(s);
  // 到顶时经验照旧入账(路 B 同口径: 攒着的经验在下次突破后一次滚级), 所以不 deny 也不报错.
  log("info", "leader", `UpgradeLeader ${lid} +${gained}exp -> lv${r.level}/${cap} exp=${r.exp} raised=${r.raised}`);
  return { body: Buffer.alloc(0), pushes: [[CMD.DataPush, leaderDataPush(s, c, eff)]] };
}

// 提升武将突破等级: 扣 LeaderBreak[leaderId, breakNum==本突].consumeId, breach+1.
// S2C 是空 message, 客户端的突破成功弹窗全靠随后那条 Data_Push.leaderAttrChanged
// (HeroMsg.LeaderAttrChangedHandler 比 bfBreak ~= breachLevel 才开 UIHeroBreakUp).
function upgradeLeaderBreachS2C(req: GsRequest): GsResult {
  const s = loadSave();
  const lid = reqNum(req, 1) ?? 0;
  const c = s.characters.find((x) => x.id === lid);
  if (!c) return deny(`Breach 无此角色 ${lid}`);
  const row = findRow("LeaderBreak", { leaderId: lid, breakNum: c.breach });
  const cid = row ? Number(row.consumeId || 0) : 0;
  if (!cid) return deny(`breachRow? ${lid} #${c.breach}`);
  const [ok, why] = checkConsume(s, cid);
  if (!ok) return deny(`breachCost ${why}`);
  const eff = newEffects();
  payConsume(s, cid, eff);
  c.breach += 1;
  saveSave(s);
  log("info", "leader", `UpgradeLeaderBreach ${lid} #${c.breach - 1}->#${c.breach} 上限=${leaderMaxLv(c.id, c.breach)}`);
  return { body: Buffer.alloc(0), pushes: [[CMD.DataPush, leaderDataPush(s, c, eff)]] };
}

// 位阶(大阶段 star / 小阶段 starLevel) 收费档口径抄客户端
// UIHeroDevelop_QualityTabCtrl:OnLvUpBtnClick —— 15 个节点线性排开(index = star*3 + starLevel),
//   STARLV 节点扣**目标档**(next 行, 客户端展示的就是这档的消耗),
//   STAR  节点扣**当前档**(LeaderStar[star].consumeID), 且要求本 star 的小阶已满.
// 下一档行不存在就拒. 两个 handler 仅 SetLeaderDataForId + 发事件, 所以回包只带 leader(字段 2).
function upgradeLeaderStarLevelS2C(req: GsRequest): GsResult {
  const s = loadSave();
  const lid = reqNum(req, 1) ?? 0;
  const c = s.characters.find((x) => x.id === lid);
  if (!c) return deny(`StarLevel 无此角色 ${lid}`);
  const nxt = findRow("LeaderStarlevel", { leaderId: lid, star: c.star, starLevel: c.starLevel + 1 });
  if (!nxt) return deny(`starLevel 顶档 ${lid} ${c.star}-${c.starLevel}`);
  const cid = Number(nxt.consumeID || 0);
  if (!cid) return deny(`starLevel 无消耗档 ${lid} ${c.star}-${c.starLevel + 1}`);
  const [ok, why] = checkConsume(s, cid);
  if (!ok) return deny(`starLvCost ${why}`);
  const eff = newEffects();
  payConsume(s, cid, eff);
  c.starLevel += 1;
  saveSave(s);
  log("info", "leader", `UpgradeLeaderStarLevel ${lid} -> ${c.star}-${c.starLevel}`);
  return { body: pb.bfield(2, leaderInfo(s, c)), pushes: [[CMD.DataPush, leaderDataPush(s, c, eff)]] };
}

function upgradeLeaderStarS2C(req: GsRequest): GsResult {
  const s = loadSave();
  const lid = reqNum(req, 1) ?? 0;
  const c = s.characters.find((x) => x.id === lid);
  if (!c) return deny(`Star 无此角色 ${lid}`);
  const cur = findRow("LeaderStar", { leaderId: lid, star: c.star });
  const nxt = findRow("LeaderStar", { leaderId: lid, star: c.star + 1 });
  if (!cur || !nxt) return deny(`star 顶档 ${lid} star${c.star}`);   // 无下一档 = 已是最高位阶
  // 大阶段晋升前提: 本 star 的小阶段已满(再下一级小阶行不存在). GetIsUnLockStarType 注释即此语义.
  if (findRow("LeaderStarlevel", { leaderId: lid, star: c.star, starLevel: c.starLevel + 1 })) {
    return deny(`starNeedMaxLv ${lid} ${c.star}-${c.starLevel}`);
  }
  const cid = Number(cur.consumeID || 0);
  if (!cid) return deny(`star 无消耗档 ${lid} star${c.star}`);
  const [ok, why] = checkConsume(s, cid);
  if (!ok) return deny(`starCost ${why}`);
  const eff = newEffects();
  payConsume(s, cid, eff);
  c.star += 1;
  c.starLevel = 0;   // 升上去后"坐在大位阶上"
  saveSave(s);
  log("info", "leader", `UpgradeLeaderStar ${lid} -> star${c.star}`);
  return { body: pb.bfield(2, leaderInfo(s, c)), pushes: [[CMD.DataPush, leaderDataPush(s, c, eff)]] };
}

// 潜能觉醒(主动/极奏 1008) 与 普攻被动(1004): 请求都是 {leaderId=1, skillId=2}, 收费走
// SkillValue/TalentSkill 当前级的 consumeId, 上限双卡(本突 skillLevel + Skill.maxLevel).
// 差别在回包字段号与客户端行为:
//   UpgradeLeaderActiveSkill_S2C.leader=1 —— handler 无条件读 msg.leader.id 与 #msg.leader.activeSkills,
//     不给就当场崩; 等级确实涨了才弹 UIHeroLevelUp.
//   UpgradeLeaderTalentSkill_S2C.leader=2 —— handler **无条件**弹 UIHeroLevelUp, 所以"不能升/材料不足"
//     只能 deny(回一个等级没变的包 = 弹假升级窗).
function upgradeSkillS2C(cmd: string, leaderField: number, kind: "active" | "talent"): GsBuilder {
  return (req: GsRequest): GsResult => {
    const s = loadSave();
    const lid = reqNum(req, 1) ?? 0;
    const sid = reqNum(req, 2) ?? 0;
    const c = s.characters.find((x) => x.id === lid);
    if (!c) return deny(`${cmd} 无此角色 ${lid}`);
    const eff = newEffects();
    const cid = skillConsumeId(sid, skillLv(c, sid, kind), kind);
    const [ok, why] = upgradeSkill(s, c, sid, kind, eff);
    if (!ok) return deny(`${cmd} ${why}`);
    saveSave(s);
    log("info", "leader", `${cmd} ${lid} skill=${sid} -> lv${skillLv(c, sid, kind)} consumeId=${cid}`);
    return { body: pb.bfield(leaderField, leaderInfo(s, c)), pushes: [[CMD.DataPush, leaderDataPush(s, c, eff)]] };
  };
}

// 式杖技能升级(1016): 上限取 TalentSkill_Xls 里该 skillId 的最大 skillLevel(Skill.maxLevel 对式杖恒 1).
// 暂不扣材料(路 B 同口径: LeaderWandSkill 的 8200xxx 是获取途径/跳转 id, 不是价格, 无从坐实),
// 客户端也已在 UI 侧用 talentSkill.consumeId ~= 0 卡住入口. 到顶时**照旧回当前 leader**
// (客户端只 SetLeaderDataForId + 发事件, UIStickSkillLevelUp 已注释掉, 不会弹假窗).
function upgradeStickSkillS2C(req: GsRequest): GsResult {
  const s = loadSave();
  const lid = reqNum(req, 1) ?? 0;
  const sid = reqNum(req, 2) ?? 0;
  const rowId = reqNum(req, 3) ?? 0;
  const c = s.characters.find((x) => x.id === lid);
  if (!c || !sid) return deny(`UpgradeStickSkill 参数 lid=${lid} skill=${sid}`);
  const cur = skillLv(c, sid, "stick");
  const max = stickMaxLv(sid);
  if (cur < max) setSkillLv(c, sid, "stick", cur + 1);
  saveSave(s);
  log("info", "leader", `UpgradeStickSkill ${lid} skill=${sid} 表id=${rowId} lv=${cur}->${skillLv(c, sid, "stick")}/${max}`);
  return { body: pb.bfield(1, leaderInfo(s, c)), pushes: [[CMD.DataPush, leaderDataPush(s, c, newEffects())]] };
}

// 式杖槽切换(1010): {skillLeaderId=1, skillPosition=2, changeSkillId=3}, S2C 原样回显三个 required.
// 无消耗(在已解锁集合里换); changeSkillId=0 = 卸下该槽. 客户端随后本地 SetWandSkill 并弹 551 通知.
function changeStickSkillS2C(req: GsRequest): GsResult {
  const s = loadSave();
  const lid = reqNum(req, 1) ?? 0;
  const pos = reqNum(req, 2) ?? 0;
  const sid = reqNum(req, 3) ?? 0;
  const c = s.characters.find((x) => x.id === lid);
  if (!c) return deny(`ChangeStickSkill 无此角色 ${lid}`);
  if (sid > 0) c.stick[String(pos)] = sid; else delete c.stick[String(pos)];
  saveSave(s);
  log("info", "leader", `ChangeStickSkill ${lid} 槽${pos} <- 表id=${sid}`);
  return {
    body: pb.concat(pb.vfield(1, lid), pb.vfield(2, pos), pb.vfield(3, sid)),
    pushes: [[CMD.DataPush, leaderDataPush(s, c, newEffects())]],
  };
}

// 式杖槽重置(1011): 只清**装备关系** stick, 不清 stickLv —— 升级过的技能等级是玩家资产.
function resetStickSkillS2C(req: GsRequest): GsResult {
  const s = loadSave();
  const lid = reqNum(req, 1) ?? 0;
  const c = s.characters.find((x) => x.id === lid);
  if (!c) return deny(`ResetStickSkill 无此角色 ${lid}`);
  c.stick = {};
  saveSave(s);
  log("info", "leader", `ResetStickSkill ${lid} (等级保留: ${Object.keys(c.stickLv).length} 条)`);
  return {
    body: pb.vfield(1, lid),
    pushes: [[CMD.DataPush, leaderDataPush(s, c, newEffects())]],
  };
}

// SwitchWeapon{ required leaderId=1; required weaponId=2(onlyId string) } -> SwitchWeapon_S2C.
function switchWeaponS2C(req: GsRequest): Buffer {
  const s = loadSave();
  const lid = reqNum(req, 1) ?? 0;
  const oid = reqStr(req, 2);
  // 走 weaponInstances 而不是 s.weapons: 它会把默认式仗/缺失的随机数据物化出来,
  // 客户端能选到的实例必然在这份列表里, 回包的 WeaponInfo 也才带得齐 17.
  const list = weaponInstances(s);
  const nw = list.find((w) => w.onlyId === oid);
  if (!lid || !nw) { log("warn", "weapon", `SwitchWeapon 找不到实例 lid=${lid} oid="${oid}"`); return Buffer.alloc(0); }
  const old = list.find((w) => w.leaderId === lid && w.onlyId !== oid);
  const other = nw.leaderId || 0;
  if (other === lid) return Buffer.alloc(0);
  nw.leaderId = lid;
  if (old) old.leaderId = other;
  saveSave(s);
  log("info", "weapon", `SwitchWeapon ${lid} <- ${oid} from=${other} out=${old?.onlyId ?? "-"}`);
  return pb.concat(
    pb.bfield(1, weaponInfoFromInst(s, nw)),                    // weaponInfo (客户端 CheckValid 无条件读)
    pb.bfield(2, leaderInfo(s, characterById(s, lid))),         // leader
    ...(other > 0 ? [pb.bfield(3, leaderInfo(s, characterById(s, other)))] : []), // beforeLeader
    ...(old ? [pb.bfield(4, weaponInfoFromInst(s, old))] : []), // oldWeaponInfo
  );
}

// ---- 武装养成 (B2): 突破 / 强化 / 分解 / 上锁 / 精炼 / 洗练 / 选保留 ----
// 除 1202 之外, 客户端 handler 都是"收到就无条件弹成功窗" (UIBreakUpSuccess / UIRefineUpSuccess /
// UIWeaponRecastingSuccess / 洗练确认页), 所以任何前置不满足一律 deny —— 回一个"数值没变"的包
// 就等于让它弹一个假成功窗, 比不弹还难查.
// 写操作全部先 materializeWeapons(s): 旧的 weaponInstances 是"每次现编一份列表", 写完就丢.

// 1201 UpgrageWeaponBreach{ required weaponId=2(onlyId) } -> { weaponInfo=1, rewards=2, leaderInfo=3 }
function upgradeWeaponBreachS2C(req: GsRequest): GsResult {
  const s = loadSave();
  materializeWeapons(s);
  const oid = reqStr(req, 2);
  const w = findWeapon(s, oid);
  if (!w) return deny(`1201 无实例 "${oid}"`);
  const cap = weaponMaxLv(w.cfg, w.breach);
  if (cap > 0 && w.level !== cap) return deny(`1201 未满级 ${oid} lv=${w.level}/${cap}`);
  const cid = breakConsume(w.cfg, w.breach); // 本突行的 consumeId=0 就是封顶 (最后一突没有消耗档)
  if (!cid) return deny(`1201 已封顶 ${oid} breach=${w.breach}`);
  const [ok, why] = checkConsume(s, cid);
  if (!ok) return deny(`1201 消耗不足 ${why}`);
  const eff = newEffects();
  payConsume(s, cid, eff);
  w.breach += 1;
  saveSave(s);
  log("info", "weapon", `UpgrageWeaponBreach ${oid} #${w.breach - 1}->#${w.breach} 等级上限=${weaponMaxLv(w.cfg, w.breach)}`);
  return {
    body: pb.concat(
      pb.bfield(1, weaponInfoFromInst(s, w)),
      pb.bfield(2, consumeRewards(cid)),
      w.leaderId > 0 ? pb.bfield(3, leaderInfo(s, characterById(s, w.leaderId))) : null,
    ),
    pushes: [[CMD.DataPush, weaponDataPush(s, w, eff)]],
  };
}

// 1202 UpgrageWeapon{ itemInfo=1(道具), required weaponId=3(onlyId) } -> { weaponInfo=1, rewards=2, leaderInfo=3 }
// 强化只吃经验 (Items_Xls.useParam[1]), 不收金币: WeaponGrow 全表 parNum 为空.
function upgradeWeaponS2C(req: GsRequest): GsResult {
  const s = loadSave();
  materializeWeapons(s);
  const oid = reqStr(req, 3);
  const w = findWeapon(s, oid);
  if (!w) return deny(`1202 无实例 "${oid}"`);
  const list = reqHashList(req, 1);
  if (!list.length) return deny(`1202 没带材料 ${oid}`);
  const eff = newEffects();
  const [gained, why] = payItemList(s, list, eff);
  if (why) return deny(`1202 材料不足 ${why}`);
  const cap = weaponMaxLv(w.cfg, w.breach);
  const r = upgradeByExp(w.level, w.exp + gained, cap, (lv) => weaponLevelExp(grateOf(w.cfg), lv));
  w.level = r.level;
  w.exp = r.exp;
  saveSave(s);
  log("info", "weapon", `UpgrageWeapon ${oid} +${gained}exp -> lv${r.level}/${cap} exp=${r.exp} raised=${r.raised}`);
  // 满级时 r.raised=0, 客户端比 aftLv > befLv 得 false -> 走 notice 605(已达上限)而不是成功窗,
  // 所以这种情况照回不误: 回包是安全的, 只有"武器不存在/材料不足"才该 deny.
  return {
    body: pb.concat(
      pb.bfield(1, weaponInfoFromInst(s, w)),
      pb.bfield(2, rewardsBuf(list.map((it) => [it.key, it.value] as [number, number]))),
      w.leaderId > 0 ? pb.bfield(3, leaderInfo(s, characterById(s, w.leaderId))) : null,
    ),
    pushes: [[CMD.DataPush, weaponDataPush(s, w, eff)]],
  };
}

// 1204 DecomposeWeapon{ repeated weaponId=1(onlyId) } -> { repeated weaponId=1, rewards=2 }
// 客户端 handler 只有 WeaponDataManager.DeleteWeapon(msg.weaponId) —— **不看 rewards**,
// 所以返还必须另走 ShowItem_Push, 否则东西凭空消失. 回包只列真正删掉的 onlyId.
function decomposeWeaponS2C(req: GsRequest): GsResult {
  const s = loadSave();
  materializeWeapons(s);
  const del: SaveWeapon[] = [];
  for (const oid of new Set(reqStrs(req, 1))) {
    const w = findWeapon(s, oid);
    if (!w || w.lock || w.leaderId > 0) continue; // 上锁/已装备: 客户端的仓库列表也筛掉
    if (!num("Items", w.cfg, "saleReward", 0)) continue; // 没有出售定价组 = 不可分解
    del.push(w);
  }
  if (!del.length) return deny(`1204 没有可分解的实例`);
  const eff = newEffects();
  const gains = new Map<number, number>();
  const gain = (id: number, n: number): void => { if (n > 0) gains.set(id, (gains.get(id) ?? 0) + n); };
  for (const w of del) {
    for (const g of fixedRewardItems(s, num("Items", w.cfg, "saleReward", 0), eff)) gain(g.itemId, g.count);
    // 强化/突破投进去的经验按比例折损返还 (仓库预览 UIWarehouse_SalePanel:90-100 同一套数).
    const total = weaponTotalExp(w);
    const per = Number(arr("Items", 1090001, "useParam")[0] || 0);
    const expN = per > 0 ? Math.floor((total * num("Common", 20, "value3", 0)) / per) : 0;
    if (expN > 0) { addItem(s, 1090001, expN, eff); gain(1090001, expN); }
    const coin = Math.floor(total * num("Common", 10233, "value3", 0) * num("Common", 20, "value3", 0));
    if (coin > 0) { addMoney(s, 10, coin, eff); gain(10, coin); }
  }
  s.weapons = s.weapons.filter((w) => !del.includes(w));
  saveSave(s);
  const rows = [...gains.entries()];
  const rewards = rewardsBuf(rows);
  log("info", "weapon", `DecomposeWeapon x${del.length} [${del.map((w) => w.onlyId).join(",")}] -> ${rows.map(([i, n]) => i + "×" + n).join(" ")}`);
  // ShowItem_Push 在 HttpClientForLua.Ignore_Replenish_MsgID 里, 走 replenish 通道会被丢掉 ->
  // 整条回复改走 completedList (与抽卡那一套相同).
  return {
    body: pb.concat(...del.map((w) => pb.sfield(1, w.onlyId)), rows.length ? pb.bfield(2, rewards) : null),
    pushes: [[CMD.DataPush, weaponDataPush(s, null, eff)]],
    extra: rows.length ? [[CMD.ShowItemPush, pb.concat(pb.vfield(1, 56), pb.bfield(2, rewards))]] : [],
    mainInCompleted: true,
  };
}

// 1205 ChangeWeaponLock{ required weaponId=1(onlyId); required state=2 } -> { weaponInfo=2 }
// 回包字段号是 **2** 不是 1 (proto/WeaponProto.proto:93), 写错位客户端 UpdateData(nil) 就是"点了没反应".
function changeWeaponLockS2C(req: GsRequest): GsResult {
  const s = loadSave();
  materializeWeapons(s);
  const oid = reqStr(req, 1);
  const state = reqNum(req, 2);
  const w = findWeapon(s, oid);
  if (!w || (state !== 0 && state !== 1)) return deny(`1205 锁状态 "${oid}" state=${state}`);
  w.lock = state;
  saveSave(s);
  log("info", "weapon", `ChangeWeaponLock ${oid} -> ${state}`);
  return pb.bfield(2, weaponInfoFromInst(s, w)); // 客户端只 UpdateData + 发事件, 不用再推 Data_Push
}

// 1207 UpgradeWeaponRefineLevel{ required weaponId=1; repeated consumeIds=2 } -> { weaponInfo=2, consumeWeaponIds=3 }
// 精炼不收钱不收物: 90 把武器的 weaponRefineCos 全空、weaponRefineCosCoin 全是"0 个金币"(Consume 90000).
// 每张同名卡按 (它的精炼等级 + 1) 计入 —— 客户端 GetAllSelectRefineLv:689 同式("0级当1级用").
// consumeItemInfo=3 不读: 那条"非武装素材"分支在客户端 UIWeaponIntensify_RefineTabCtrl:610 是注释掉的.
function upgradeWeaponRefineS2C(req: GsRequest): GsResult {
  const s = loadSave();
  materializeWeapons(s);
  const oid = reqStr(req, 1);
  const w = findWeapon(s, oid);
  if (!w) return deny(`1207 无实例 "${oid}"`);
  const max = maxRefineOf(w.cfg); // = TalentSkill 里该武技的最大 skillLevel-1; 无武技配置的武器回 0
  if (w.refine >= max) return deny(`1207 ${max ? "已满炼" : "无精炼配置"} ${oid} ${w.refine}/${max}`);
  const mats = [...new Set(reqStrs(req, 2))].filter((m) => m !== oid);
  if (!mats.length) return deny(`1207 没喂卡 ${oid}`);
  if (mats.length > 4) return deny(`1207 一次喂 ${mats.length} 张(客户端 selectMaxCount=4)`);
  const cards: SaveWeapon[] = [];
  for (const m of mats) {
    const x = findWeapon(s, m);
    // 素材要"同名 / 未装备 / 未上锁 / 不是默认式仗": 客户端的精炼列表就筛这些.
    if (!x || x.cfg !== w.cfg || x.leaderId > 0 || x.lock || defLeaderOf(x) > 0) return deny(`1207 素材不合法 ${m}`);
    cards.push(x);
  }
  const add = cards.reduce((a, x) => a + x.refine + 1, 0);
  if (w.refine + add > max) return deny(`1207 超上限 ${w.refine}+${add}>${max}`);
  w.refine += add;
  s.weapons = s.weapons.filter((x) => !cards.includes(x));
  saveSave(s);
  log("info", "weapon", `UpgradeWeaponRefineLevel ${oid} -> ${w.refine}/${max} 吞卡 ${cards.length} 张`);
  return {
    body: pb.concat(
      pb.bfield(2, weaponInfoFromInst(s, w)),
      ...cards.map((x) => pb.sfield(3, x.onlyId)), // consumeWeaponIds: 客户端靠它把卡从仓库删掉
    ),
    pushes: [[CMD.DataPush, weaponDataPush(s, w, newEffects())]],
  };
}

// 1208 RecastingWeapon{ required weaponId=1; repeated lockPropKeyIndex=2; repeated lockSkillId=3;
//   required recastingType=4 } -> { required weaponInfo=1, required recastingType=2 }
// 回包的 17 仍是**生效中的旧值**, 新结果只进 18 —— 确认页靠"17 与 18 同下标"左右对照画属性/技能.
// lockPropKeyIndex 是 0 基下标(客户端送的是 index-1), lockSkillId 是 WeaponRandom.skillID.
function recastingWeaponS2C(req: GsRequest): GsResult {
  const s = loadSave();
  materializeWeapons(s);
  const oid = reqStr(req, 1);
  const kind = reqNum(req, 4) ?? 0;
  const w = findWeapon(s, oid);
  if (!w) return deny(`1208 无实例 "${oid}"`);
  if (kind !== RECAST_PROP && kind !== RECAST_SKILL) return deny(`1208 类型 ${kind}`);
  const grate = grateOf(w.cfg);
  // 客户端 CanRecasting 只放行 Common 99117.value4(=[4,5]) 里的星级. 3★以下连"锁定几个"都算不出来
  // (GetWeaponRecastingLockCount 没有分支 -> nil 参与比较), 且确认页 GetScope 的 else 分支要读
  // 对侧的 #weaponRandomSkill, 而 17 里"技能一条都没有"在线上是 nil —— 一律拒, 不造兜底数据.
  if (!arr("Common", 99117, "value4").map(Number).includes(grate)) return deny(`1208 ${grate}★ 不可洗练 ${oid}`);
  if (!randIsEmpty(w.last)) return deny(`1208 已有待确认 ${oid}`);
  if (randIsEmpty(w.rand)) return deny(`1208 没有生效随机数据 ${oid}`);
  const lockProp = reqNums(req, 2);
  const lockSkill = reqNums(req, 3);
  const locks = kind === RECAST_PROP ? lockProp : lockSkill; // 两个页签的锁定数各算各的, 不相加
  if (locks.length > 4) return deny(`1208 锁定 ${locks.length} 个(WeaponRefiningLock 只有 1..4 档)`);
  if (lockProp.some((i) => i < 0 || i >= w.rand.key.length)) return deny(`1208 属性下标越界 ${lockProp}`);
  if (lockSkill.some((id) => !w.rand.skill.includes(id))) return deny(`1208 锁定的技能不在武装上 ${lockSkill}`);
  const col = kind === RECAST_SKILL ? "consume" : "consume2";
  const cids = [
    num("WeaponRefining", grate, col, 0),
    ...(locks.length ? [num("WeaponRefiningLock", locks.length, col, 0)] : []),
  ].filter((cid) => cid > 0);
  for (const cid of cids) {
    const [ok, why] = checkConsume(s, cid);
    if (!ok) return deny(`1208 消耗不足 ${why}`); // 一条都没扣: 半途扣钱不回包最难查
  }
  const eff = newEffects();
  for (const cid of cids) payConsume(s, cid, eff);
  const round = (kind === RECAST_SKILL ? w.recastingSkillTime : w.recastingTime) + 1;
  const rolled = rollWeapon(w.cfg, seedOf(oid, round), w.rand, {
    ...keepFor(w.rand, kind),
    ...(kind === RECAST_SKILL ? { skill: lockSkill } : { propIdx: lockProp }),
  });
  const pend = pendingHalf(rolled, kind);
  // 条数必须和 17 一模一样(池子太短摇不满就会少一条), 否则确认页按下标取到 nil.
  const aligned = kind === RECAST_SKILL ? pend.skill.length === w.rand.skill.length : pend.key.length === w.rand.key.length;
  if (!aligned) return deny(`1208 摇出的条数对不上 ${oid}`);
  w.last = pend;
  if (kind === RECAST_SKILL) w.recastingSkillTime = round;
  else w.recastingTime = round;
  saveSave(s);
  log("info", "weapon", `RecastingWeapon ${oid} ${kind === RECAST_SKILL ? "SKILL" : "PROP"} 锁${locks.length} 第${round}次`);
  return {
    body: pb.concat(pb.bfield(1, weaponInfoFromInst(s, w)), pb.vfield(2, kind)),
    pushes: [[CMD.DataPush, weaponDataPush(s, w, eff)]],
  };
}

// 1209 SelectWeaponRandomInfo{ required weaponId=1; required recastingType=2; required selectType=3 }
// -> 同样三个 required 字段. NEW(2) 把 18 并进 17 再清 18; OLD(1) 只清 18.
function selectWeaponRandomS2C(req: GsRequest): GsResult {
  const s = loadSave();
  materializeWeapons(s);
  const oid = reqStr(req, 1);
  const kind = reqNum(req, 2) ?? 0;
  const sel = reqNum(req, 3) ?? 0;
  const w = findWeapon(s, oid);
  if (!w) return deny(`1209 无实例 "${oid}"`);
  if (randIsEmpty(w.last)) return deny(`1209 没有待确认 ${oid}`);
  const pending = w.last.skill.length ? RECAST_SKILL : RECAST_PROP; // 与 lastBufFor 同一套判据
  if (kind !== pending) return deny(`1209 类型不符 ${oid} 请求=${kind} 待确认=${pending}`);
  if (sel !== SELECT_NEW && sel !== SELECT_OLD) return deny(`1209 选择类型 ${sel}`);
  if (sel === SELECT_NEW) {
    const next = applyPending(w.rand, w.last, kind);
    if (next.key.length !== w.rand.key.length || next.skill.length !== w.rand.skill.length) return deny(`1209 条数不齐 ${oid}`);
    w.rand = next;
  }
  w.last = emptyRand();
  saveSave(s);
  log("info", "weapon", `SelectWeaponRandomInfo ${oid} ${pending === RECAST_SKILL ? "SKILL" : "PROP"} ${sel === SELECT_NEW ? "保留新" : "保留旧"}`);
  return {
    body: pb.concat(pb.bfield(1, weaponInfoFromInst(s, w)), pb.vfield(2, kind), pb.vfield(3, sel)),
    pushes: [[CMD.DataPush, weaponDataPush(s, w, newEffects())]],
  };
}

// GetPayShopData{ required version=1; required update=2 } -> GetPayShopData_S2C{ required PayShopData=1 }.
function getPayShopDataS2C(): Buffer {
  // PayShopData{ required int64 payConfVersion=5 }
  return pb.bfield(1, pb.vfield(5, 1));
}

// 结算/离开: 回一个合法空包(客户端 Lua 按 header 派发, 不回会一直等).
function battleAck(tag: string): GsBuilder {
  return (req: GsRequest): Buffer => {
    const fields = pb.decodeFields(req.proto ?? Buffer.alloc(0));
    log("info", "battle", `${tag} fields=${fields
      .map((f) => (Buffer.isBuffer(f.value) ? `${f.field}:bytes(${f.value.length})` : `${f.field}:${f.value}`))
      .join(" ")}`);
    return Buffer.alloc(0);
  };
}

export const HANDLERS: Record<number, GsBuilder> = {
  [CMD.PlayerLogin]: playerLoginS2C,
  [CMD.PlayerLoginGetInfo]: playerLoginGetInfoS2C,
  [CMD.GetPrologue]: getPrologueS2C,
  [CMD.SetPrologue]: setPrologueS2C,
  [CMD.GetPayShopDataAfterLogin]: getPayShopDataAfterLoginS2C,
  [CMD.GetWaitOrderData]: getWaitOrderDataS2C,
  [CMD.LoginOpenSmallBattlePanel]: loginOpenSmallBattlePanelS2C,
  [CMD.GetWeaponListPage]: getWeaponListPageS2C,
  [CMD.GetPerkInfoListPage]: getPerkInfoListPageS2C,
  [CMD.GetRevelationInfoListPage]: getRevelationInfoListPageS2C,
  [CMD.GetOpenFunctionData]: getOpenFunctionDataS2C,
  [CMD.ChangeStep]: changeStepS2C,
  [CMD.ClientDataOverLogin]: clientDataOverLoginS2C,
  [CMD.GetSignReward]: getSignRewardS2C,
  [CMD.GetNextDayUpdateData]: getNextDayUpdateDataS2C,
  [CMD.GetAllActivity]: getAllActivityS2C,
  [CMD.GetOtherPlayerInfo]: getOtherPlayerInfoS2C,
  [CMD.CheckPlayerName]: checkPlayerNameS2C,
  [CMD.ChangePlayerName]: changePlayerNameS2C,
  [CMD.ChangeSex]: changeSexS2C,
  [CMD.ChangeSecretary]: changeSecretaryS2C,
  [CMD.SwitchClothing]: switchClothingS2C,
  [CMD.UpgradeLeader]: upgradeLeaderS2C,
  // 养成 (B1). 回包字段号不统一(ActiveSkill/Stick 的 leader=1, Talent/Star/StarLevel 的 leader=2),
  // 是逐条对着 proto 与客户端 handler 核过的 —— 写错一位 optional 字段, required 自检抓不到.
  [CMD.UpgradeLeaderBreach]: upgradeLeaderBreachS2C,
  [CMD.UpgradeLeaderStar]: upgradeLeaderStarS2C,
  [CMD.UpgradeLeaderStarLevel]: upgradeLeaderStarLevelS2C,
  [CMD.UpgradeLeaderActiveSkill]: upgradeSkillS2C("UpgradeLeaderActiveSkill", 1, "active"),
  [CMD.UpgradeLeaderTalentSkill]: upgradeSkillS2C("UpgradeLeaderTalentSkill", 2, "talent"),
  [CMD.UpgradeStickSkill]: upgradeStickSkillS2C,
  [CMD.ChangeStickSkill]: changeStickSkillS2C,
  [CMD.ResetStickSkill]: resetStickSkillS2C,
  [CMD.SwitchWeapon]: switchWeaponS2C,
  // 武装 (B2). weaponInfo 的字段号两条不一样: 1205/1207 在 **2**, 1201/1202/1208/1209 在 1.
  [CMD.UpgrageWeaponBreach]: upgradeWeaponBreachS2C,
  [CMD.UpgrageWeapon]: upgradeWeaponS2C,
  [CMD.DecomposeWeapon]: decomposeWeaponS2C,
  [CMD.ChangeWeaponLock]: changeWeaponLockS2C,
  [CMD.UpgradeWeaponRefineLevel]: upgradeWeaponRefineS2C,
  [CMD.RecastingWeapon]: recastingWeaponS2C,
  [CMD.SelectWeaponRandomInfo]: selectWeaponRandomS2C,
  [CMD.GetPayShopData]: getPayShopDataS2C,
  // 战斗: 11028 进战斗(核心), 11003 战斗服 KCP 登录, 11018/11019/11031/11032 结算与离开
  [CMD.StartSoloBattle]: startSoloBattleS2C,
  [CMD.OverMainLevel]: overMainLevelS2C,
  [CMD.BattleLogin]: battleLoginS2C,
  [CMD.BattleSettle]: battleAck("BattleSettle"),
  [CMD.BattleLeave]: battleAck("BattleLeave"),
  [CMD.CloseBattleSettle]: battleAck("CloseBattleSettle"),
  [CMD.BattleLeaveFinishS2C]: battleAck("BattleLeaveFinish"),
  // 抽卡
  [CMD.SwearHero]: swearHeroS2C,
  [CMD.SelectSwearChange]: () => Buffer.alloc(0),
  [CMD.GetSwearRecord]: getSwearRecordS2C,
  // SetSpecialTaskProgress_S2C{ required int32 errCode=1 } — 秘书互动等任务的进度回执,
  // required 字段缺了 Lua 侧 pbNew.decode 直接报错.
  [CMD.SetSpecialTaskProgress]: () => pb.vfield(1, 0),
  // 以下几种的 S2C 只有 optional/repeated, 空 body 即"新号无数据"; 但仍要**成包**回,
  // 否则客户端派发器收不到这个 msgId, 面板回调永不触发 (签到弹窗关不掉就是这么来的).
  [CMD.GetAllFriendInfo]: () => Buffer.alloc(0),        // GetAllFriendInfo_S2C{repeated ...=1}
  // ActivityReplayReward_S2C{ required int32 errorCode=1 } —— 别再回空 body:
  // 缺 required 字段会让 Lua pbNew.decode 报错, 客户端还当成没收到 -> 0.5s 一条反复重发 21015.
  [CMD.ActivityReplayReward]: () => pb.vfield(1, 0),
  [CMD.GetBattlePassInfoListPage]: () => Buffer.alloc(0),
  [CMD.GetRogueInfoListPage]: () => Buffer.alloc(0),
  [CMD.GetElementRuinsLevelGroupList]: () => Buffer.alloc(0),
};
