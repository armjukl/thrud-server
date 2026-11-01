// 分级日志 + 原始报文落盘。落盘格式与 qkzx 一致, 方便两套协议并排比对。
import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[config.log.level as Level] ?? 20;

/**
 * 建出 logs/capture 两个目录。手机上外部存储可能还没铺好或不可写, 建不出来不能让进程起不来,
 * 后续所有写盘都走 bestEffort —— 假服的产物是内存里的回包, 落盘只是给我们看的。
 */
export function ensureDirs(): void {
  for (const d of [config.paths.logs, config.paths.capture]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch {
      /* 不可写: 退化成只打 stdout */
    }
  }
}
ensureDirs();

let diskWarned = false;
const bestEffort = (what: string, fn: () => void): void => {
  try {
    fn();
  } catch (e) {
    if (diskWarned) return;
    diskWarned = true;
    process.stdout.write(`${stamp()} WARN  logger    ${what} 写盘失败(${(e as Error).message}), 后续同类错误不再刷屏\n`);
  }
};

const stamp = (): string => new Date().toISOString().replace("T", " ").replace("Z", "");

export function log(level: Level, tag: string, msg: string): void {
  if ((LEVELS[level] ?? 20) < threshold) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${tag.padEnd(9)} ${msg}`;
  bestEffort("server.log", () => fs.appendFileSync(path.join(config.paths.logs, "server.log"), line + "\n"));
  const color = level === "error" ? "31" : level === "warn" ? "33" : "36";
  if (process.env.SLD_NO_COLOR) process.stdout.write(`${line}\n`);
  else process.stdout.write(`\x1b[${color}m${line}\x1b[0m\n`);
}

export function setLevel(name: string): void {
  threshold = LEVELS[name as Level] ?? threshold;
}

// NUL / 控制字符会让终端把整行当二进制吞掉, 这里统一转义
export function hex(data: Buffer | Uint8Array | null | undefined, limit = config.log.hexBytes): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  const s = buf.subarray(0, limit).toString("hex").replace(/../g, "$& ");
  return (s + (buf.length > limit ? `…(+${buf.length - limit}B)` : "")).trim();
}

export function ascii(data: Buffer | Uint8Array | null | undefined): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  return [...buf.subarray(0, config.log.hexBytes)]
    .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : "."))
    .join("");
}

let seq = 0;

export const record = {
  // 每条收发消息存成 <时间>-<seq>-<tag>.bin, 另附 .txt 头部说明, 供离线逆向
  packet(tag: string, data: Buffer, note = ""): string {
    const base = `${Date.now()}-${String(++seq).padStart(5, "0")}-${tag.replace(/[^a-z0-9]+/gi, "_")}`;
    bestEffort("capture", () => {
      fs.writeFileSync(path.join(config.paths.capture, base + ".bin"), data);
      fs.writeFileSync(path.join(config.paths.capture, base + ".txt"), `${stamp()} ${tag}\nlen=${data.length}\n${note}\n`);
    });
    return base;
  },
  json(name: string, obj: unknown): void {
    bestEffort("logs/" + name, () => fs.writeFileSync(path.join(config.paths.logs, name), JSON.stringify(obj, null, 2)));
  },
};

export function summary(): { logs: string; capture: string; packets: number } {
  return { logs: config.paths.logs, capture: config.paths.capture, packets: seq };
}
