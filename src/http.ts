// HTTP 侧: Bilibili SDK 登录 + 服务器列表 + 版本清单 + 协议路由.
//
// 现在能确定的只有"存在这些请求"这件事(来自 metadata 里的 THDNetworkUtil/HttpPost
// 回调、supplierconfig.json 的 bilibili 渠道、license.txt 的服务条款), 具体 URL 与
// JSON 字段得等抓包. 所以这里的策略是:
//   1) 已知猜测的端点给出结构合理的假数据;
//   2) 其它任何请求一律 记录完整 method/path/headers/body + 返回 code:0,
//      这样客户端不会卡在 HTTP 阶段, 我们也能从 data/logs/http-requests.jsonl
//      里直接看到真机/模拟器实际请求了什么.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import { config } from "./config.js";
import { log, record } from "./logger.js";
import { handleAppInterface } from "./gs.js";

const httpLog = (): ((entry: unknown) => void) => {
  const file = path.join(config.paths.logs, "http-requests.jsonl");
  return (entry) => fs.appendFileSync(file, JSON.stringify(entry) + "\n");
};

function ok(res: http.ServerResponse, obj: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "x-offline-server": "sld/1.0.7",
  });
  res.end(body);
}

function raw(res: http.ServerResponse, buf: Buffer, type = "application/octet-stream"): void {
  res.writeHead(200, { "content-type": type, "content-length": buf.length, "x-offline-server": "sld/1.0.7" });
  res.end(buf);
}

// 路由表: key = 正则, value = handler(req, res, url, body)
const ROUTES: Array<[RegExp]> = [
  // ---- 服务器列表 / 网关地址 ----
  [/\/(server_?list|serverlist|gameserver|dispatch|line)/i],
  // ---- 版本 / 资源更新 ----
  [/\/(version|update|patch|res_?version|check_?update)/i],
  // ---- SDK 登录 ----
  [/\/(login|token|auth|passport|sdk|account)/i],
  // ---- 排队/公告 ----
  [/\/(notice|announce|bulletin|queue|maintain)/i],
];

export function createHttpServer(): { server: http.Server | https.Server; routes: string[] } {
  const note = httpLog();
  const lanIp = config.server.lanIp;

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://" + (req.headers.host || "localhost"));
      note({ t: Date.now(), method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body.toString("latin1").slice(0, 4000) });
      log("info", "http", `${req.method} ${url.pathname}${url.search} ${body.length}B host=${req.headers.host ?? "-"}`);
      record.packet(`http-${req.method}-${url.pathname.replace(/[^a-z0-9]+/gi, "_")}`, body, `headers: ${JSON.stringify(req.headers)}`);

      // GS 应用层: NetWorkManager -> HttpClientForLua -> POST /AppInterface
      // 请求 = 二进制头 + protobuf data; 回包 = protobuf msg.ReturnPackagePush (裸二进制)
      if (/\/AppInterface/i.test(url.pathname)) {
        const { body: reply, note: n } = handleAppInterface(body);
        record.packet("gs-reply", reply, n);
        return raw(res, reply);
      }

      // skipAPI: 优先读 data/skipapi.raw (原样返回, 允许空体); 否则 data/skipapi.json
      if (/skipAPI/i.test(url.pathname)) {
        const rawFile = path.join(config.paths.logs, "..", "skipapi.raw");
        if (fs.existsSync(rawFile)) {
          const data = fs.readFileSync(rawFile);
          log("info", "skipapi", `返回 skipapi.raw (${data.length}B)`);
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": data.length });
          return res.end(data);
        }
        try {
          const f = path.join(config.paths.logs, "..", "skipapi.json");
          const j = JSON.parse(fs.readFileSync(f, "utf8")) as unknown;
          log("info", "skipapi", "返回 skipapi.json");
          return ok(res, j);
        } catch {
          log("warn", "skipapi", "skipapi.json 缺失/非法, 用默认空响应");
          return ok(res, { code: 0, msg: "ok", data: {} });
        }
      }

      // getClientUpdateData: resVersion 一律由 config.server.resVersion 覆盖(文件里那个数不生效),
      // 报盘上资源包的那个版本, 客户端判定"无需更新" -> 不走热更下载.
      if (/getClientUpdateData/i.test(url.pathname)) {
        try {
          const f = path.join(config.paths.logs, "..", "getclientupdatedata.json");
          const j = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
          j.resVersion = String(config.server.resVersion);
          log("info", "update", `无热更: resVersion=${String(j.resVersion)}`);
          return ok(res, j);
        } catch {
          log("warn", "update", "getclientupdatedata.json 缺失/非法, 用空对象");
          return ok(res, {});
        }
      }

      if (/\/(server_?list|serverlist|gameserver|dispatch|line)/i.test(url.pathname)) {
        return ok(res, {
          code: 0, msg: "ok",
          data: [{
            id: config.server.serverId,
            lineId: config.server.lineId,
            name: "离线私服",
            ip: lanIp,
            host: lanIp,
            port: config.gateway.port,
            udpPort: config.gateway.port,
            tcpPort: config.gateway.port,
            status: 1,
            region: "cn",
          }],
        });
      }

      if (/\/(version|update|patch|check_?update|res_?version)/i.test(url.pathname)) {
        return ok(res, {
          code: 0, msg: "ok",
          data: {
            resVersion: config.server.resVersion,
            buildVersion: config.server.buildVersion,
            force: false,
            needUpdate: false,
          },
        });
      }

      if (/\/(login|token|auth|passport|sdk|account)/i.test(url.pathname)) {
        return ok(res, {
          code: 0, status: 0, msg: "ok",
          data: {
            uid: 10001,
            token: "offline-token",
            accessToken: "offline-token",
            openId: "offline-openid",
            userId: "offline-user",
            serverId: config.server.serverId,
            gateway: { ip: lanIp, port: config.gateway.port },
          },
        });
      }

      // ---- Thrud(sld) 登录流程端点 (来自 Lua LoginMgr / GameStateManager / NetWorkManager) ----
      // 维护公告: 必须返回空对象 {}; 若返回带字段的对象, Lua 会走维护分支并对 nil 做 string.gsub 报错,
      // 导致 UIManager.OpenUI(UILogin) 永远执行不到。
      if (/\/server\/clientNotice/i.test(url.pathname)) {
        return ok(res, {});
      }
      // 全局日志等级 {logLevel:N}; 空对象用默认等级
      if (/\/server\/clientLogLevel/i.test(url.pathname)) {
        return ok(res, {});
      }
      // CDN 列表: PlayerDataManager.ParseCDNListInfo 直接存整个 json
      if (/\/server\/cdnData/i.test(url.pathname)) {
        return ok(res, []);
      }
      // 功能开关 [{id,state}]; 空数组 = 全部关闭
      if (/\/server\/OpenStatus/i.test(url.pathname)) {
        return ok(res, []);
      }
      // GS 域名: NetWorkManager.SetGameServerInfo 解析 {serverId,serverVersion,urlList} 并拼 <url>/AppInterface?...
      if (/\/server\/serverUrlData/i.test(url.pathname)) {
        return ok(res, { serverId: config.server.serverId, serverVersion: Math.floor(Date.now() / 1000), urlList: ["https://" + config.server.publicHost + ":443"] });
      }
      // 登录后公告: NoticeDataMgr.SetNoticeData 期望 json 数组
      if (/\/server\/clientAnnounce/i.test(url.pathname)) {
        return ok(res, []);
      }

      if (/\/(notice|announce|bulletin|queue|maintain)/i.test(url.pathname)) {
        return ok(res, { code: 0, msg: "ok", data: { list: [], tips: "offline", queue: 0, serverStatus: "OPEN" } });
      }

      // 兜底: 让 HTTP 阶段别卡住, 同时把路径记下来当"端点清单"
      log("warn", "http", `未实现 ${url.pathname} —— 已记录, 需要时在这里补 handler`);
      return ok(res, { code: 0, msg: "ok", data: {} });
    });
  };

  const certDir = config.paths.certs;
  const server = config.tls.enabled
    ? https.createServer({
        key: fs.readFileSync(path.join(certDir, "server.key")),
        cert: fs.readFileSync(path.join(certDir, "server.crt")),
      }, handler)
    : http.createServer(handler);
  server.on("error", (e: Error) => log("error", "http", String(e.message || e)));
  log("info", "http", config.tls.enabled ? "TLS 已启用" : "明文 HTTP (SLD_TLS=1 开 TLS)");
  return { server, routes: ROUTES.map((r) => r[0].source) };
}
