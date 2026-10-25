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
  /** 已通关训练本 id 列表 (trainLevelInfo). */
  trainLevels: number[];
  /** 抽卡: 卡池id(字符串) -> 已抽总次数. */
  gacha: Record<string, number>;
  /** 月签到状态: month=年*12+月, times=本月已签天数, day=已签到的"天序号"(4:00 UTC+8 日界), lastTime=上次签到时间. */
  signin: { month: number; times: number; day: number; lastTime: number };
}

const SAVE_FILE = path.join(ROOT, "data", "save.json");

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
  },
  // 服务端保证这两个默认武将在列表里 (客户端 GetHeroDataById 拿模型/立绘).
  characters: [defaultCharacter(2001001), defaultCharacter(2010001)],
  weapons: [],
  items: {},
  money: {},
  cloths: [],
  wskin: [],
  levels: {},
  trainLevels: [],
  gacha: {},
  signin: { month: 0, times: 0, day: -1, lastTime: 0 },
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
    };
  });

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
    },
    characters,
    weapons,
    items: numMap(o.items),
    money: numMap(o.money),
    cloths: numArr(o.cloths),
    wskin: numArr(o.wskin),
    levels: levelMap(o.levels),
    trainLevels: numArr(o.trainLevels),
    gacha: numMap(o.gacha),
    signin: {
      month: num((o.signin as Record<string, unknown> | undefined)?.month, d.signin.month),
      times: num((o.signin as Record<string, unknown> | undefined)?.times, d.signin.times),
      day: num((o.signin as Record<string, unknown> | undefined)?.day, d.signin.day),
      lastTime: num((o.signin as Record<string, unknown> | undefined)?.lastTime, d.signin.lastTime),
    },
  };
}

/** 读存档; 文件缺失/非法时回退默认 (每次请求调用, 改 json 即生效). */
export function loadSave(): SaveData {
  try {
    return normalizeSave(JSON.parse(fs.readFileSync(SAVE_FILE, "utf8")));
  } catch {
    return normalizeSave(DEFAULT_SAVE);
  }
}

/** 写回存档 (游戏内变化时调用); 2 空格缩进便于手改. */
export function saveSave(s: SaveData): void {
  try {
    fs.writeFileSync(SAVE_FILE, JSON.stringify(s, null, 2) + "\n");
  } catch (e) {
    log("warn", "save", `落盘失败: ${(e as Error).message}`);
  }
}

/** 取武将; 存档里没有就补一个默认属性条目 (保证看板/默认武将可解析). */
export function characterById(s: SaveData, id: number): SaveCharacter {
  return s.characters.find((c) => c.id === id) ?? defaultCharacter(id);
}
