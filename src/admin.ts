// 管理面: 开关假服 / 改存档 / 看日志. 与假服本体同进程, 但**独立端口、独立生命周期** ——
// 关掉假服时管理端口必须还活着, 否则手机上的界面会把自己关成不可再开。
//
// 写档三道闸: (1)顶层 18 键必须齐全(缺=拒, 多=拒) (2)normalizeSave 逐键重建, 垃圾字段进不去
// (3)items/money 的 id 必须认得(客户端 Items_Xls 里没有的 id, 下发过去就是空白条目)。
// 通过之后才复制现状到 data/logs/save.pre-admin.<ts>.json, 再走 saveSave 的原子写。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { config, DATA } from "./config.js";
import { log, setLevel, summary } from "./logger.js";
import type { OfflineServer } from "./offline.js";
import { DEFAULT_SAVE, loadSave, normalizeSave, saveSave, type SaveData } from "./save.js";
import { ITEM_VALID, MONEY_IDS } from "./data/items.js";
import { itemType, countItem } from "./econ.js";
import { missReport, row } from "./tbl.js";

/** 顶层键的**唯一真源**是 DEFAULT_SAVE: 加了新块忘了登记, 这里自动就变了。 */
const SAVE_KEYS = Object.keys(DEFAULT_SAVE);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_BODY = 4 << 20;

class BadRequest extends Error {}

const send = (res: http.ServerResponse, code: number, obj: unknown): void => {
  const body = Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj));
  res.writeHead(code, {
    "content-type": typeof obj === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
};

const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BadRequest(`请求体超过 ${MAX_BODY}B`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

/** 顶层键的形状类别, 拿 DEFAULT_SAVE 当唯一真源。 */
const kindOf = (v: unknown): string => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

/** 校验 + 补齐: 任何一步不对都抛 BadRequest, 调用方因此可以假定"没抛就是能写的档". */
function buildSave(body: unknown, mode: "patch" | "put"): SaveData {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("请求体必须是 JSON 对象");
  const o = body as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !SAVE_KEYS.includes(k));
  if (extra.length) throw new BadRequest(`顶层不认识的键: ${extra.join(", ")} (可用: ${SAVE_KEYS.join(", ")})`);
  // 逐个给到的键先比形状: normalizeSave 对 null/类型不对的值是"补默认值"而不是报错,
  // 于是 PATCH {characters:null} 会被当成"你没给", 静默把整支队伍重置成初始号 —— 删档级脚枪。
  for (const [k, v] of Object.entries(o)) {
    const want = kindOf((DEFAULT_SAVE as unknown as Record<string, unknown>)[k]);
    const got = kindOf(v);
    if (got !== want) throw new BadRequest(`${k} 要是 ${want}, 收到 ${got}`);
  }
  const merged = mode === "patch" ? { ...loadSave(), ...o } : o;
  const missing = SAVE_KEYS.filter((k) => !(k in merged));
  if (missing.length) throw new BadRequest(`顶层缺键: ${missing.join(", ")} —— 整档替换(put)必须给全, 局部改用小写(patch)即可`);

  const next = normalizeSave(merged);
  // 道具认得 = Items_Xls 里的条目 + 六个货币 id(10/11/12/121/122/90000000 不在 ITEM_IDS 里,
  // 它们是 money 专用的条目, 只按 ITEM_VALID 卡会把改余额整个拒掉)。
  const known = (id: number): boolean => ITEM_VALID.has(id) || MONEY_IDS.includes(id);
  for (const bucket of ["items", "money"] as const) {
    for (const [k, v] of Object.entries(next[bucket])) {
      const id = Number(k);
      if (!Number.isInteger(id) || !known(id)) throw new BadRequest(`${bucket} 里 ${k} 不是客户端认识的道具 id`);
      if (!Number.isInteger(v) || v < 0 || v > 1e12) throw new BadRequest(`${bucket}[${k}] 数量要是 0..1e12 的整数, 收到 ${v}`);
    }
  }
  if (!Array.isArray(next.characters)) throw new BadRequest("characters 必须是数组");
  return next;
}

/** 写档: 先留一份现状到 logs/save.pre-admin.<ts>.json, 再原子写. */
function writeSave(next: SaveData): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(config.paths.logs, `save.pre-admin.${stamp}.json`);
  if (fs.existsSync(config.paths.save)) fs.copyFileSync(config.paths.save, backup);
  saveSave(next);
  return backup;
}

export interface AdminHandle {
  server: http.Server;
  /** listen 成功才算就绪; 端口被占时这条 promise 会 reject(调用方必须 await 它)。 */
  ready: Promise<void>;
  port: number;
  host: string;
  needsToken: boolean;
  close(): Promise<void>;
}

export function createAdminServer(offline: OfflineServer, overrides: { host?: string; port?: number } = {}): AdminHandle {
  const host = overrides.host ?? config.admin.host;
  const port = overrides.port ?? config.admin.port;
  const needsToken = !LOOPBACK.has(host);

  const token = (): string => {
    const file = path.join(DATA, "admin.token");
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
    const t = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(file, t + "\n", { mode: 0o600 });
    log("warn", "admin", `绑在 ${host} 不是回环地址, 已生成管理令牌 ${file}`);
    return t;
  };
  const authorized = (url: URL, req: http.IncomingMessage): boolean => {
    if (!needsToken) return true;
    const got = url.searchParams.get("token") || req.headers["x-admin-token"] || "";
    return got === token();
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://" + (req.headers.host || "localhost"));
    const json_ = (code: number, obj: unknown) => send(res, code, obj);
    if (!authorized(url, req)) return json_(401, { error: "需要管理令牌: 首次启动会生成 data/admin.token" });

    (async () => {
      const p = url.pathname;
      if (p === "/api/status" && req.method === "GET") {
        const saveFile = config.paths.save;
        const st = fs.existsSync(saveFile) ? fs.statSync(saveFile) : null;
        return json_(200, {
          ...offline.status(),
          save: { file: saveFile, bytes: st?.size ?? 0, mtime: st?.mtime.toISOString() ?? null },
          tables: missReport(),
          uptimeSec: Math.round(process.uptime()),
        });
      }
      if (p.startsWith("/api/") && req.method === "POST" && /(start|stop|restart)$/.test(p)) {
        const what = p.split("/").pop() as "start" | "stop" | "restart";
        await offline[what]();
        log("info", "admin", `${what} -> running=${offline.running}`);
        return json_(200, offline.status());
      }
      if (p === "/api/save" && req.method === "GET") return json_(200, loadSave());
      if (p === "/api/save" && (req.method === "PATCH" || req.method === "PUT")) {
        const mode = req.method === "PATCH" ? "patch" : "put";
        const raw = (await readBody(req)).toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          throw new BadRequest(`JSON 解析失败: ${(e as Error).message}`);
        }
        const next = buildSave(parsed, mode);
        const backup = writeSave(next);
        log("info", "admin", `写档(${mode}) 已落盘, 改前副本 ${path.basename(backup)}`);
        return json_(200, { ok: true, backup, save: next });
      }
      return json_(404, { error: `管理面没有 ${req.method} ${p}` });
    })().catch((e: unknown) => {
      if (e instanceof BadRequest) return json_(400, { error: e.message });
      log("error", "admin", `${req.method} ${url.pathname} ${(e as Error).stack || String(e)}`);
      return json_(500, { error: String((e as Error).message || e) });
    });
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => {
      log("info", "admin", `管理面 http://${host}:${port} (开关假服/改档/日志), ${needsToken ? "需令牌" : "仅回环可访问"}`);
      resolve();
    });
    server.once("error", (e: Error) => reject(new Error(`管理端口 ${host}:${port} 起不来: ${e.message}`)));
  });
  server.listen(port, host);
  return {
    server,
    ready,
    port,
    host,
    needsToken,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
