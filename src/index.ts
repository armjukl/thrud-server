#!/usr/bin/env node
// 入口: 起 HTTP(SDK/CND/热更) 与 UDP/KCP 网关, 并把收到的东西全部落盘.
//
//   node dist/index.js
//   SLD_NET_MODE=kcp SLD_LOG_LEVEL=debug node dist/index.js
import { config } from "./config.js";
import { log, record, summary, hex } from "./logger.js";
import { createGateway, onUnknown, on, handlerIds } from "./gateway.js";
import { createHttpServer } from "./http.js";

const gw = createGateway();
const { server } = createHttpServer();

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

await gw.start();
server.listen(config.http.port, config.http.host, () => {
  log("info", "http", `HTTP 监听 ${config.tls.enabled ? "https" : "http"}://${config.http.host}:${config.http.port} (SDK 登录/服务器列表/假 CDN)`);
});

log("info", "boot", `Thrud(sld) 离线服务端 | resVersion=${config.server.resVersion} build=${config.server.buildVersion} 渠道=${config.server.channel}`);
log("info", "boot", `已注册 msgId 处理器: ${handlerIds().join(", ") || "(仅兜底记录)"} | 落盘 ${summary().capture}`);
log("info", "boot", "让客户端过来: 见 docs/README.md (hosts/代理/服务器列表改写 三条路)");

process.on("SIGINT", () => {
  log("info", "boot", `退出 ${JSON.stringify(summary())}`);
  gw.stop();
  server.close();
  process.exit(0);
});
