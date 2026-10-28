// 玩家存档: data/save.json —— 唯一一份可读可写的持久化存档.
//
// 合并了原先分散的三处: prologue.json(序章/创角) + secretary.json(大厅看板) +
// 写死在 payloads.ts 里的等级/经验/体力/武将列表. 全部收进这一个文件.
//
// 读写约定:
//   - 每次请求 loadSave() 重读 -> 手工改 json **改完即生效, 不用重启**;
//   - 游戏内变化(改名/改性别/换看板/序章推进)由 payloads.ts 改完调 saveSave() 回写.
// 文件缺失/损坏时回退到 DEFAULT_SAVE, 不影响登录.
import fs from "node:fs";
import path from "node:path";

import { ROOT } from "./config.js";
import { log } from "./logger.js";

/** 单个武将 (对应 msg.proto 的 LeaderInfo). */
export interface SaveCharacter {
  id: number;
  level: number;
  exp: number;
  star: number;
  starLevel: number;
  /** 突破等级 (参与属性成长计算) */
  breach: number;
  /** 属性覆盖: 属性id(字符串) -> 值. 直接覆盖按等级/突破算出的终值(如 {"100":999999,"101":88888}). */
  attrs: Record<string, number>;
  favorabilityLevel: number;
  favorabilityExp: number;
  clothingId: number;
  weaponId: string;
  signLv: number;
  perkId: string;
  /** 主动/极奏/普攻技能等级: skillId(字符串) -> 等级. 缺席按 1 级(客户端 HeroData 同口径). */
  activeLv: Record<string, number>;
  /** 被动(天赋)技能等级: skillId(字符串) -> 等级. */
  talentLv: Record<string, number>;
  /** 式杖技能槽: 槽位id(字符串) -> LeaderWandSkill_Xls 的行 id. 0/缺席 = 该槽空着. */
  stick: Record<string, number>;
  /** 式杖技能等级: skillId(字符串) -> 等级. ResetStickSkill **不清这一项**(只清 stick). */
  stickLv: Record<string, number>;
}

/** 玩家自身数值 (PlayerLoginGetInfo / PlayerLiveInfo 里那些). */
export interface SavePlayer {
  uid: number;
  name: string;
  /** 0 女 / 1 男 */
  sex: number;
  level: number;
  exp: number;
  maxExp: number;
  strength: number;
  maxStrength: number;
  shipStrength: number;
  maxShipStrength: number;
  /** 大厅看板 leaderId */
  secretary: number;
  /**
   * 上次权威结算体力的**秒**锚点 (对齐 proto lastStrengthTime=19 的 int32 秒口径).
   * catchUpStrength 取用前按 (now-anchor)/回体周期 把 strength 追平, 只补不削(奖励发的溢出体力不能钳回上限).
   */
  strengthRealTime: number;
}

/** 一关的通关记录 (对应 proto TrainLevelInfo / MainLevelInfo 里那几个计数). */
export interface SaveLevelRecord {
  id: number;
  /**
   * 单局耗时(**秒**). TrainLevelInfo.passTime 是 required 8, 给 0 会让挂机把"单场时长"
   * 判成 0 -> 结算秒数 0、奖励池算空(路 B _hangUpSingleTime 也是兜 30 秒).
   * 真值由 OverTrainLevel/OverMainLevel 的 C2S passTime 写进来; 这里 30 只是历史档补齐的兜底.
   */
  passTime: number;
  /** 今日进本次数(日界清) */
  todayAttackNum: number;
  /** 累计进本次数 */
  attackNum: number;
  /** 上次进本时刻(**毫秒**) */
  lastAttackTime: number;
}

/** 任务/活跃度 (原写死在 payloads.ts 的 taskProgress 那一块搬进来). */
export interface SaveTasks {
  /** 主线章节索引 (TaskProgressInfo.taskChapter). 默认 101. */
  taskChapter: number;
  /** 日常任务组 (TaskProgressInfo.dayGroupIndex). **默认只能 10001**: 144 条 condition=3100
   *  的任务按组索引取数, 选错组会让 PatrolDataManager 取空崩在主城. */
  dayGroupIndex: number;
  /** 今日活跃度(日界清) */
  dayTaskPoint: number;
  /** 本周活跃度(周界清) */
  weekTaskPoint: number;
  /** 已领奖任务: taskId(字符串) -> 领奖时刻(ms) */
  passedTasks: Record<string, number>;
  /** 后端侧任务进度: taskId(字符串) -> 进度值 */
  progress: Record<string, number>;
  /** 已领的日活跃度宝箱 id */
  passedDayPoints: number[];
  /** 已领的周活跃度宝箱 id */
  passedWeekPoints: number[];
  /** 上次"跨日清零"命中的日界点(ms); 0 = 还没登记过 */
  rollDay: number;
  /** 上次"跨周清零"命中的周界点(ms) */
  rollWeek: number;
}

/** 初心者(FirstThought)/七日签到那一组面板状态. */
export interface SaveBg {
  /** 面板开启时刻(**秒**, proto openTimeStamp 是 int64 秒). 0/缺 = 兜到 regTime("注册即开启"). */
  open: number;
  /** 七日签到已签次数 */
  sign: number;
  /** 上次签到时刻(秒) */
  signTime: number;
  /** 已领的 bingo 行 id */
  bingo: number[];
  /** 红点 (FirstThoughtInfo.redDot=2 是 required bool) */
  redDot: boolean;
}

/** 挂机/外派会话 (HangUpInfo). */
export interface SaveHangUp {
  /** 1=主线关 2=训练关 */
  type: number;
  levelId: number;
  /** 计划场次 */
  times: number;
  /** 开始时刻(**秒**, 与 HeartManager.GetServerTime 同源) */
  startTime: number;
  /** 预计结束时刻(秒) = startTime + times*单场秒数 */
  endTime: number;
  /** 0 未挂机/已领奖 · 1 挂机中 · 2 完成未领 (HangUpInfo.state=6 是 required int64) */
  state: number;
}

/**
 * 一把武装的一批随机结果. 编出去是 WeaponInfo.weaponRandomInfo(17) / lastWeaponRandomInfo(18)
 * = WeaponRandomInfo{ weaponRandomSkill=1, secondaryPropInfo=2{ key=1, val=2, scope=4, poolIdx=5, attrIdx=6 } }.
 */
export interface SaveWeaponRand {
  /** WeaponRandomInfo.weaponRandomSkill=1: 随机技能 id 列表 */
  skill: number[];
  /** SecondaryPropInfo.secondaryKeyList=1: 生效属性 id (只能取自 EquipAttribute_Xls) */
  key: number[];
  /** SecondaryPropInfo.secondaryValueList=2: 与 key 一一对应 —— 长度不等客户端会取到 undefined 崩在属性行 */
  val: number[];
  /** randomPropPoolIndex=5: 与 key 一一对应, 该条来自 WeaponRandom_Xls 的哪一行 */
  poolIdx: number[];
  /** randomEquipAttrIndex=6: 与 key 一一对应, 池内序号 */
  attrIdx: number[];
  /** weaponPropScope=4: 随机属性评分 (客户端拿它算"洗出的是不是更好") */
  scope: number;
}

/** 武器(式仗)实例 (对应 msg.proto WeaponInfo). */
export interface SaveWeapon {
  /** 唯一 id (字符串, 客户端按它索引实例). 空则自动补. */
  onlyId: string;
  /** 武器配置 id (Weapon_Xls). */
  cfg: number;
  /** 穿戴者 leaderId (0=闲置). */
  leaderId: number;
  level: number;
  breach: number;
  exp: number;
  refine: number;
  lock: number;
  skin: number;
  /**
   * WeaponInfo.recastingTime=19 (required int32) —— **已洗属性次数**, 不是时刻.
   * 客户端 WeaponDataManager.NeedRecastingTips 判 `grate==5 且 ==0` 才弹"该洗练了"的红点,
   * 所以这里必须从 0 起、每洗一次 +1 (路 B det.recast 同口径).
   */
  recastingTime: number;
  /** WeaponInfo.recastingSkillTime=20 (required int32) —— 已洗技能次数. */
  recastingSkillTime: number;
  /** 当前生效的那组随机结果 (WeaponInfo 字段 17). */
  rand: SaveWeaponRand;
  /** 洗出来还没保留的那组 (WeaponInfo 字段 18); SelectWeaponRandomInfo 在它和 rand 之间选. */
  last: SaveWeaponRand;
}

export interface SaveData {
  /** 序章 / 创角进度 (原 prologue.json 的 done/id). */
  prologue: { done: boolean; id: string };
  player: SavePlayer;
  characters: SaveCharacter[];
  /** 武器(式仗)实例列表; 空则按 characters[] 每人生成一把默认. */
  weapons: SaveWeapon[];
  /** 背包道具: itemId(字符串) -> 数量. */
  items: Record<string, number>;
  /** 货币: itemId(字符串) -> 数量. */
  money: Record<string, number>;
  /** 已拥有角色战装(皮肤) id 列表 (clothingInfo.clothingIdSet). */
  cloths: number[];
  /** 已拥有武装涂装 id 列表 (weaponSkinInfo.existIdSet). */
  wskin: number[];
  /** 主线关卡通关进度: levelId(字符串) -> 星级数组 (mainLevelInfo). */
  levels: Record<string, number[]>;
  /** 训练关卡通关记录: levelId(字符串) -> 记录 (trainLevelInfo). 老档的 number[] 会自动升上来. */
  trainLevels: Record<string, SaveLevelRecord>;
  /** 抽卡: 卡池id(字符串) -> 已抽总次数. */
  gacha: Record<string, number>;
  /** 月签到状态: month=年*12+月, times=本月已签天数, day=已签到的"天序号"(4:00 UTC+8 日界), lastTime=上次签到时间. */
  signin: { month: number; times: number; day: number; lastTime: number };
  /** 任务/活跃度 */
  tasks: SaveTasks;
  /** 初心者 + 七日签到面板 */
  bg: SaveBg;
  /**
   * 存档结构迁移哨兵. 加新字段要判"老档缺它"的, 都在 loadSave 里按 < BG_SCHEMA 一次性补,
   * 而不是每次读档都猜(口径会变来变去). 仿路 B mockgs_pc.lua 的 BG_SCHEMA.
   */
  bgVersion: number;
  /** 挂机/外派会话; state=0 表示没在挂. */
  hangUp: SaveHangUp;
  /** 武装实例 onlyId 的发号器. 新实例用 7000000+ ++wSeq, 不再从 leaderId 派生(会撞号). */
  wSeq: number;
  /** 建档时刻(秒). 七日/体力回算的锚点. */
  regTime: number;
}

const SAVE_FILE = path.join(ROOT, "data", "save.json");
const SAVE_TMP = SAVE_FILE + ".tmp";
const SAVE_BAK = SAVE_FILE + ".bak";

/** 空的一组随机结果. 长度约束(key/val/poolIdx/attrIdx 一一对应)由 weapons.ts 负责维持. */
export function emptyRand(): SaveWeaponRand {
  return { skill: [], key: [], val: [], poolIdx: [], attrIdx: [], scope: 0 };
}

/** 一条通关记录; passTime 兜 30 秒的理由见 SaveLevelRecord 注释. */
export function newLevelRecord(id: number, passTime = 30, nowMs = Date.now()): SaveLevelRecord {
  return { id, passTime: passTime > 0 ? Math.floor(passTime) : 30, todayAttackNum: 1, attackNum: 1, lastAttackTime: nowMs };
}

/**
 * 建一把武装实例. onlyId 由调用方发号 (新实例走 s.wSeq 自增, 见 weapons.ts);
 * 这里只保证四列新字段不会又被漏掉.
 */
export function newWeapon(onlyId: string, cfg: number, leaderId: number, over: Partial<SaveWeapon> = {}): SaveWeapon {
  return {
    onlyId, cfg, leaderId, level: 1, breach: 0, exp: 0, refine: 0, lock: 0, skin: 0,
    recastingTime: 0, recastingSkillTime: 0, rand: emptyRand(), last: emptyRand(), ...over,
  };
}

/** 武将默认属性 (原 leaderInfo() 写死的那套). */
export function defaultCharacter(id: number): SaveCharacter {
  return {
    id,
    level: 1,
    exp: 0,
    star: 0,
    starLevel: 0,
    breach: 0,
    attrs: {},
    favorabilityLevel: 1,
    favorabilityExp: 0,
    clothingId: 0,
    weaponId: "",
    signLv: 0,
    perkId: "",
    activeLv: {},
    talentLv: {},
    stick: {},
    stickLv: {},
  };
}

export const DEFAULT_SAVE: SaveData = {
  prologue: { done: false, id: "" },
  player: {
    uid: 10001,
    name: "指挥官",
    sex: 0,
    level: 1,
    exp: 0,
    maxExp: 100,
    strength: 100,
    maxStrength: 100,
    shipStrength: 100,
    maxShipStrength: 100,
    secretary: 2001001,
    strengthRealTime: 0,
  },
  // 服务端保证这两个默认武将在列表里 (客户端 GetHeroDataById 拿模型/立绘).
  characters: [defaultCharacter(2001001), defaultCharacter(2010001)],
  weapons: [],
  items: {},
  money: {},
  cloths: [],
  wskin: [],
  levels: {},
  trainLevels: {},
  gacha: {},
  signin: { month: 0, times: 0, day: -1, lastTime: 0 },
  tasks: {
    taskChapter: 101,
    dayGroupIndex: 10001,
    dayTaskPoint: 0,
    weekTaskPoint: 0,
    passedTasks: {},
    progress: {},
    passedDayPoints: [],
    passedWeekPoints: [],
    rollDay: 0,
    rollWeek: 0,
  },
  bg: { open: 0, sign: 0, signTime: 0, bingo: [], redDot: false },
  bgVersion: 0,
  hangUp: { type: 0, levelId: 0, times: 0, startTime: 0, endTime: 0, state: 0 },
  wSeq: 0,
  regTime: 0,
};

const num = (v: unknown, fallback: number): number => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
// 解析 { "id": 数量 } 映射 (非法值丢弃).
const numMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const n = Number(val);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
};
// 解析数字数组 (非法值丢弃).
const numArr = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : []);
// 解析 { "id": [星级] } 映射.
const levelMap = (v: unknown): Record<string, number[]> => {
  const out: Record<string, number[]> = {};
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = numArr(val);
  }
  return out;
};
const bool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);
/** 一组成对的随机列: 长度不对齐客户端取属性行会取到 nil, 这里按最短的那条截齐. */
const pairCut = (a: number[], b: number[]): [number[], number[]] => {
  const n = Math.min(a.length, b.length);
  return [a.slice(0, n), b.slice(0, n)];
};
const randOf = (v: unknown): SaveWeaponRand => {
  const o = (v ?? {}) as Record<string, unknown>;
  const skill = numArr(o.skill);
  let key = numArr(o.key);
  let val = numArr(o.val);
  [key, val] = pairCut(key, val);
  const poolIdx = numArr(o.poolIdx).slice(0, key.length);
  const attrIdx = numArr(o.attrIdx).slice(0, key.length);
  return { skill, key, val, poolIdx, attrIdx, scope: num(o.scope, 0) };
};
/**
 * trainLevels 两代形状都吃: 老档是"通关过的 id 列表" number[], 新档是 { id: 记录 }.
 * 老档升上来时 passTime 走兜底 30 秒 —— 通关记录里没有时长, 而挂机把这一列当单场时长用,
 * 给 0 等于"瞬间打完", 结算奖励池会被算空.
 */
const levelRecordMap = (v: unknown): Record<string, SaveLevelRecord> => {
  const out: Record<string, SaveLevelRecord> = {};
  if (Array.isArray(v)) {
    for (const id of numArr(v)) out[String(id)] = newLevelRecord(id);
    return out;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const id = Number(k);
      if (!Number.isFinite(id)) continue;
      if (val === null || val === undefined || typeof val === "number") { out[k] = newLevelRecord(id); continue; }
      const o = val as Record<string, unknown>;
      const pt = num(o.passTime, 30);
      out[k] = {
        id: num(o.id, id),
        passTime: pt > 0 ? Math.floor(pt) : 30,
        todayAttackNum: num(o.todayAttackNum, 0),
        attackNum: num(o.attackNum, 0),
        lastAttackTime: num(o.lastAttackTime, 0),
      };
    }
  }
  return out;
};

/** 把任意来源的对象补齐成完整 SaveData (缺字段用默认值), 不修改入参. */
export function normalizeSave(raw: unknown): SaveData {
  const o = (raw ?? {}) as Record<string, unknown>;
  const pro = (o.prologue ?? {}) as Record<string, unknown>;
  const p = (o.player ?? {}) as Record<string, unknown>;
  const d = DEFAULT_SAVE;

  const rawChars = Array.isArray(o.characters) && o.characters.length ? o.characters : d.characters;
  const characters: SaveCharacter[] = rawChars.map((c) => {
    const cc = (c ?? {}) as Record<string, unknown>;
    return {
      id: num(cc.id, 0),
      level: num(cc.level, 1),
      exp: num(cc.exp, 0),
      star: num(cc.star, 0),
      starLevel: num(cc.starLevel, 0),
      breach: num(cc.breach, 0),
      attrs: numMap(cc.attrs),
      favorabilityLevel: num(cc.favorabilityLevel, 1),
      favorabilityExp: num(cc.favorabilityExp, 0),
      clothingId: num(cc.clothingId, 0),
      weaponId: str(cc.weaponId, ""),
      signLv: num(cc.signLv, 0),
      perkId: str(cc.perkId, ""),
      activeLv: numMap(cc.activeLv),
      talentLv: numMap(cc.talentLv),
      stick: numMap(cc.stick),
      stickLv: numMap(cc.stickLv),
    };
  });

  const rawWeapons = Array.isArray(o.weapons) ? o.weapons : d.weapons;
  const weapons: SaveWeapon[] = rawWeapons.map((w) => {
    const ww = (w ?? {}) as Record<string, unknown>;
    return {
      onlyId: str(ww.onlyId, ""),
      cfg: num(ww.cfg, 0),
      leaderId: num(ww.leaderId, 0),
      level: num(ww.level, 1),
      breach: num(ww.breach, 0),
      exp: num(ww.exp, 0),
      refine: num(ww.refine, 0),
      lock: num(ww.lock, 0),
      skin: num(ww.skin, 0),
      recastingTime: num(ww.recastingTime, 0),
      recastingSkillTime: num(ww.recastingSkillTime, 0),
      rand: randOf(ww.rand),
      last: randOf(ww.last),
    };
  });

  const t = (o.tasks ?? {}) as Record<string, unknown>;
  const bg = (o.bg ?? {}) as Record<string, unknown>;
  const hu = (o.hangUp ?? {}) as Record<string, unknown>;
  const si = (o.signin ?? {}) as Record<string, unknown>;

  return {
    prologue: { done: !!pro.done, id: str(pro.id, "") },
    player: {
      uid: num(p.uid, d.player.uid),
      name: str(p.name, d.player.name),
      sex: num(p.sex, d.player.sex),
      level: num(p.level, d.player.level),
      exp: num(p.exp, d.player.exp),
      maxExp: num(p.maxExp, d.player.maxExp),
      strength: num(p.strength, d.player.strength),
      maxStrength: num(p.maxStrength, d.player.maxStrength),
      shipStrength: num(p.shipStrength, d.player.shipStrength),
      maxShipStrength: num(p.maxShipStrength, d.player.maxShipStrength),
      secretary: num(p.secretary, d.player.secretary),
      strengthRealTime: num(p.strengthRealTime, 0),
    },
    characters,
    weapons,
    items: numMap(o.items),
    money: numMap(o.money),
    cloths: numArr(o.cloths),
    wskin: numArr(o.wskin),
    levels: levelMap(o.levels),
    trainLevels: levelRecordMap(o.trainLevels),
    gacha: numMap(o.gacha),
    signin: {
      month: num(si.month, d.signin.month),
      times: num(si.times, d.signin.times),
      day: num(si.day, d.signin.day),
      lastTime: num(si.lastTime, d.signin.lastTime),
    },
    tasks: {
      taskChapter: num(t.taskChapter, d.tasks.taskChapter),
      dayGroupIndex: num(t.dayGroupIndex, d.tasks.dayGroupIndex),
      dayTaskPoint: num(t.dayTaskPoint, 0),
      weekTaskPoint: num(t.weekTaskPoint, 0),
      passedTasks: numMap(t.passedTasks),
      progress: numMap(t.progress),
      passedDayPoints: numArr(t.passedDayPoints),
      passedWeekPoints: numArr(t.passedWeekPoints),
      rollDay: num(t.rollDay, 0),
      rollWeek: num(t.rollWeek, 0),
    },
    bg: {
      open: num(bg.open, 0),
      sign: num(bg.sign, 0),
      signTime: num(bg.signTime, 0),
      bingo: numArr(bg.bingo),
      redDot: bool(bg.redDot, false),
    },
    bgVersion: num(o.bgVersion, 0),
    hangUp: {
      type: num(hu.type, 0),
      levelId: num(hu.levelId, 0),
      times: num(hu.times, 0),
      startTime: num(hu.startTime, 0),
      endTime: num(hu.endTime, 0),
      state: num(hu.state, 0),
    },
    wSeq: num(o.wSeq, 0),
    regTime: num(o.regTime, 0),
  };
}

/**
 * 存档结构版本. 加"必须每档都有值"的字段(锚点类)时 +1, 并在 migrateSave 里补一次.
 * 判据只能靠这个哨兵, 不能靠"字段值是不是 0": 老档里 regTime 可能恰好等于当时那一秒,
 * 用数值大小猜会把"旧档清零"当成"新号第 1 天"(路 B 实机踩过, 见 mockgs_pc.lua BG_SCHEMA v3).
 */
export const BG_SCHEMA = 1;

/** 就地补齐缺锚点的老档; 返回是否改动过(改动过就得落盘, 光登记等于没登记). */
function migrateSave(s: SaveData): boolean {
  if (s.bgVersion >= BG_SCHEMA) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (s.regTime <= 0) s.regTime = nowSec;
  if (s.player.strengthRealTime <= 0) s.player.strengthRealTime = nowSec;
  if (s.bg.open <= 0) s.bg.open = s.regTime;
  if (s.tasks.rollDay <= 0) s.tasks.rollDay = nowSec * 1000;
  if (s.tasks.rollWeek <= 0) s.tasks.rollWeek = nowSec * 1000;
  s.bgVersion = BG_SCHEMA;
  return true;
}

/** 读一份 json 并补齐; 不存在/坏 json/坏类型都算失败返回 null(交调用方决定回退到哪). */
function readSaveFile(p: string): SaveData | null {
  try {
    return normalizeSave(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}

/**
 * 读存档; 每次请求调用, 改 json 即生效.
 *
 * 回退顺序 save.json -> save.json.bak -> DEFAULT_SAVE, **不能直接跳到最后一步**:
 * 半截文件(写盘被中断/磁盘满)会让 JSON.parse 抛, 老实现一口回默认档 = 整档静默回滚成新号.
 */
export function loadSave(): SaveData {
  let s = readSaveFile(SAVE_FILE);
  if (!s && fs.existsSync(SAVE_FILE)) {
    s = readSaveFile(SAVE_BAK);
    log("warn", "save", s ? "save.json 解析失败，已回退 .bak" : "save.json 与 .bak 都读不出，本轮按新号继续");
  }
  if (!s) s = normalizeSave(DEFAULT_SAVE);
  if (migrateSave(s)) saveSave(s);
  return s;
}

/**
 * 写回存档 (游戏内变化时调用); 2 空格缩进便于手改.
 *
 * 原子写: 先 .tmp 再 rename, 顺手把上一版留成 .bak (loadSave 的坏档回退就读它).
 * 直接 writeFileSync 目标文件 = 截断窗口, 进程在这中间被杀就得到一份解析不了的档.
 */
export function saveSave(s: SaveData): void {
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_TMP, JSON.stringify(s, null, 2) + "\n");
    if (fs.existsSync(SAVE_FILE)) fs.copyFileSync(SAVE_FILE, SAVE_BAK);
    fs.renameSync(SAVE_TMP, SAVE_FILE);
  } catch (e) {
    log("warn", "save", `落盘失败: ${(e as Error).message}`);
  }
}

/** 取武将; 存档里没有就补一个默认属性条目 (保证看板/默认武将可解析). */
export function characterById(s: SaveData, id: number): SaveCharacter {
  return s.characters.find((c) => c.id === id) ?? defaultCharacter(id);
}
