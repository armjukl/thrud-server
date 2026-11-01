// 生命周期装配: PC 入口(index.ts)、管理面(admin.ts)与 APK 里的 main.js 都调这里。
//
// 为什么每次 start 都新建网关与 HTTP server: dgram socket close() 后不能再 bind
// (Node 18 实测 ERR_SOCKET_DGRAM_NOT_RUNNING), 复用旧对象只会得到"点了开启但端口没起来"。
// 反过来, 模块级的 handler/hook 注册必须只做一次 —— 每重启一轮就多挂一个 unknown 记录器,
// 同一个报文会落两遍盘、日志翻倍, 那是比起不来更难查的故障。
import http from "node:http";
import https from "node:https";

import { config } from "./config.js";
import { log, record, summary, ensureDirs, hex } from "./logger.js";
import { createGateway, on, onUnknown, handlerIds, type Gateway } from "./gateway.js";
import { HANDLERS } from "./payloads.js";
import { createHttpServer } from "./http.js";

let wired = false;

/** 默认注册: 兜底记录器 + msgId 0 探活。重复调用无副作用。 */
function wireDefaults(): void {
  if (wired) return;
  wired = true;
  // 目前没有任何"已确认"的 msgId —— 消息 ID 表在加密的 toLua 里, 必须脱壳或抓包才能拿到.
  // 所以这里只挂兜底记录器: 统计 msgId 频次 + 存原始字节, 抓到包后逐条 on(<id>, handler).
  const seen: Record<string, { count: number; firstBytes: string; bytes: number }> = {};
  onUnknown(({ id, msgId, seq, body }) => {
    const key = String(msgId ?? "unframed");
    seen[key] = { count: (seen[key]?.count ?? 0) + 1, firstBytes: hex(body, 32), bytes: body.length };
    record.json("unknown-msgids.json", seen);
    log("warn", "dispatch", `未注册 msgId=${key} seq=${seq} ${body.length}B peer=${id} ${hex(body, 48)}`);
  });
  // msgId 0 当作探活: 回空包保持连接 (真实心跳 ID 待确认)
  on(0, (frame, peer) => {
    log("debug", "heartbeat", `${peer.id} seq=${frame.seq}`);
    return [0, Buffer.alloc(0)];
  });
}

export interface OfflineStatus {
  running: boolean;
  http: { host: string; port: number; tls: boolean };
  gateway: { host: string; port: number; mode: string };
  peers: Record<string, unknown>[];
  handlers: number[];
  logs: string;
  capture: string;
  packets: number;
  node: string;
  rssMb: number;
}

export interface OfflineServer {
  readonly running: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): OfflineStatus;
}

export function createOfflineServer(): OfflineServer {
  let gw: Gateway | null = null;
  let server: http.Server | https.Server | null = null;

  const listen = (s: http.Server | https.Server): Promise<void> =>
    new Promise((resolve, reject) => {
      const done = (err?: Error): void => {
        s.off("listening", onListen);
        s.off("error", onErr);
        if (err) reject(err);
        else resolve();
      };
      const onListen = (): void => done();
      const onErr = (e: Error): void => done(e);
      s.once("listening", onListen);
      s.once("error", onErr);
      s.listen(config.http.port, config.http.host);
    });

  const start = async (): Promise<void> => {
    if (gw && server) return;
    ensureDirs();
    wireDefaults();
    const g = createGateway();
    await g.start();
    const created = createHttpServer();
    try {
      await listen(created.server);
    } catch (e) {
      g.stop();
      throw e;
    }
    gw = g;
    server = created.server;
    log("info", "http", `HTTP 监听 ${config.tls.enabled ? "https" : "http"}://${config.http.host}:${config.http.port} (SDK 登录/服务器列表/假 CDN)`);
    log("info", "boot", `Thrud(sld) 离线服务端 | resVersion=${config.server.resVersion} build=${config.server.buildVersion} 渠道=${config.server.channel}`);
    log("info", "boot", `协议表 HANDLERS ${Object.keys(HANDLERS).length} 条可应答 | 网关级注册 ${handlerIds().length} 个 [${handlerIds().join(", ") || "无"}] | 落盘 ${summary().capture}`);
    log("info", "boot", "让客户端过来: 见 docs/README.md (hosts/代理/服务器列表改写 三条路)");
  };

  const stop = async (): Promise<void> => {
    const g = gw;
    const s = server;
    gw = null;
    server = null;
    if (g) g.stop();
    if (s) {
      // close() 只停"接新连接", keep-alive 的 socket 会让它一直挂着 -> 端口看起来还占着
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
      s.removeAllListeners();
    }
    if (g || s) log("info", "boot", "假服已停止: 网关与 HTTP 端口都已释放, 对端会话清零");
  };

  return {
    get running(): boolean {
      return !!gw && !!server;
    },
    start,
    stop,
    restart: async () => {
      await stop();
      await start();
    },
    status: () => ({
      running: !!gw && !!server,
      http: { host: config.http.host, port: config.http.port, tls: config.tls.enabled },
      gateway: { host: config.gateway.host, port: config.gateway.port, mode: config.gateway.mode },
      peers: gw ? [...gw.peers.values()].map((p) => p.snapshot()) : [],
      handlers: handlerIds(),
      logs: config.paths.logs,
      capture: config.paths.capture,
      packets: summary().packets,
      node: process.version,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
    }),
  };
}
