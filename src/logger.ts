// 分级日志 + 原始报文落盘。落盘格式与 qkzx 一致, 方便两套协议并排比对。
import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[config.log.level as Level] ?? 20;

fs.mkdirSync(config.paths.logs, { recursive: true });
fs.mkdirSync(config.paths.capture, { recursive: true });

const stamp = (): string => new Date().toISOString().replace("T", " ").replace("Z", "");

export function log(level: Level, tag: string, msg: string): void {
  if ((LEVELS[level] ?? 20) < threshold) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${tag.padEnd(9)} ${msg}`;
  fs.appendFileSync(path.join(config.paths.logs, "server.log"), line + "\n");
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
const dir = config.paths.capture;

export const record = {
  // 每条收发消息存成 <时间>-<seq>-<tag>.bin, 另附 .txt 头部说明, 供离线逆向
  packet(tag: string, data: Buffer, note = ""): string {
    const base = `${Date.now()}-${String(++seq).padStart(5, "0")}-${tag.replace(/[^a-z0-9]+/gi, "_")}`;
    fs.writeFileSync(path.join(dir, base + ".bin"), data);
    fs.writeFileSync(path.join(dir, base + ".txt"), `${stamp()} ${tag}\nlen=${data.length}\n${note}\n`);
    return base;
  },
  json(name: string, obj: unknown): void {
    fs.writeFileSync(path.join(config.paths.logs, name), JSON.stringify(obj, null, 2));
  },
};

export function summary(): { logs: string; capture: string; packets: number } {
  return { logs: config.paths.logs, capture: dir, packets: seq };
}
