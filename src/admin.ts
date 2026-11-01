// 管理面: 开关假服 / 改存档 / 看日志. 与假服本体同进程, 但**独立端口、独立生命周期** ——
// 关掉假服时管理端口必须还活着, 否则手机上的界面会把自己关成不可再开。
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
