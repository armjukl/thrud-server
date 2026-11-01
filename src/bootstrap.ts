// APK 侧的启动积木: 铺盘(seed-once) + 起假服与管理面。
//
// 铺盘只有一条铁律: 目标已存在就不许碰。APK 更新会整目录覆盖 code/, 数据目录靠这条保住
// 玩家存档 —— loadSave() 缺档时静默回 DEFAULT_SAVE, 覆盖一次就等于把号练回初始。
// 代码目录与数据目录彻底分开是同一件事的另一面: code/ 可被覆盖, slddata/ 永不。
import fs from "node:fs";
import path from "node:path";

import { log } from "./logger.js";
import { createOfflineServer, type OfflineServer } from "./offline.js";
import { createAdminServer, type AdminHandle } from "./admin.js";

export interface SeedResult {
  /** 这次真的铺下去的文件(相对 seed 根) */
  copied: string[];
  /** 数据目录里已经有, 因此一个字节没动的文件 */
  kept: string[];
  /** 写下的 .seedver 内容; 没有可铺的东西时也可能只补这一个文件 */
  seedver: string | null;
}

/** 递归列目录里的普通文件, 返回相对 dir 的路径(用 / 分隔)。目录不存在返回空。 */
export function walkFiles(dir: string, prefix = ""): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * 把 seedDir 的内容铺到 dataDir, 只铺缺失的, 已存在的一律不动。
 * 幂等: 第二次跑 copied 为空。铺完写 <dataDir>/.seedver = buildCode, 供排查"这档是哪版铺的"。
 */
export function seedOnce(seedDir: string, dataDir: string, buildCode = "unknown"): SeedResult {
  const files = walkFiles(seedDir);
  const copied: string[] = [];
  const kept: string[] = [];
  for (const rel of files) {
    const dst = path.join(dataDir, rel);
    if (fs.existsSync(dst)) {
      kept.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(seedDir, rel), dst);
    copied.push(rel);
  }
  let seedver: string | null = null;
  if (files.length) {
    const vf = path.join(dataDir, ".seedver");
    if (!fs.existsSync(vf)) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(vf, buildCode + "\n");
    }
    seedver = fs.readFileSync(vf, "utf8").trim();
  }
  if (copied.length) log("info", "seed", `铺盘 ${copied.length} 个文件(缺失才铺), 保留已有 ${kept.length} 个, seedver=${seedver}`);
  return { copied, kept, seedver };
}

export interface ApkOptions {
  /** false = 只起管理面, 假服等界面上按"开启" */
  autoStart?: boolean;
}

/**
 * main.js 铺完盘、设好 SLD_* 之后调这里 —— config 是模块级求值的, 晚一步都读不到新目录。
 * 端口/主机名都走 SLD_*, 这里只留"起不起假服"这一个开关。
 * 返回的两个 handle 让调用方(Java 侧回调 / 自检)能把它们停掉。
 */
export async function runApk(opts: ApkOptions = {}): Promise<{ offline: OfflineServer; admin: AdminHandle }> {
  const offline = createOfflineServer();
  if (opts.autoStart !== false) await offline.start();
  else log("info", "boot", "autoStart=false: 只等管理面按下'开启'");

  const admin = createAdminServer(offline);
  await admin.ready;
  return { offline, admin };
}
