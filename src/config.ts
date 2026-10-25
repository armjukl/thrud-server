// 全局配置。真实端口来自 metadata 里的开发服地址 thrud-dev.accessgames.com:8005,
// 本地默认全部 +1000 以便与真机/抓包并存, 用环境变量覆盖即可。
//
// 参考 yhjjx 的 fakeserverts: 支持 <项目根>/.env(KEY=VALUE, # 注释);
// 已经是环境变量的键优先, .env 不覆盖。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根: src/ 与 dist/ 都在根下一层, 两种运行方式解析结果一致。 */
export const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = HERE;

/** 读 <项目根>/.env; 已存在的环境变量不覆盖。可用 SLD_ENV_FILE 指定别的文件。 */
function loadDotEnv(): void {
  const file = process.env.SLD_ENV_FILE || path.join(HERE, ".env");
  if (!fs.existsSync(file)) return;
  try {
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      if (!key || process.env[key] !== undefined) continue;
      process.env[key] = line.slice(eq + 1).trim();
    }
  } catch {
    // 读不到就当没有
  }
}
loadDotEnv();

const num = (v: string | undefined, d: number): number => (v === undefined || v === "" ? d : Number(v));
const str = (v: string | undefined, d: string): string => (v === undefined || v === "" ? d : v);

const RES = path.resolve(ROOT, "..", "res");

export type NetMode = "kcp" | "raw" | "auto";

export interface Section0 { host: string; port: number; }

export const config = {
  http: {
    host: str(process.env.SLD_HTTP_HOST, "0.0.0.0"),
    port: num(process.env.SLD_HTTP_PORT, 8005 + 1000),
  },
  tls: {
    /** SLD_TLS=1 -> HTTP 侧起 https(需要 certs/server.{crt,key}) */
    enabled: process.env.SLD_TLS === "1",
  },
  gateway: {
    host: str(process.env.SLD_KCP_HOST, "0.0.0.0"),
    port: num(process.env.SLD_KCP_PORT, 8005 + 1000),
    // kcp = 24 字节 KCP 段, 需要正确的 conv/握手
    // raw = 一个 UDP 数据报 = 一条消息 (THDNetwork 早期形态)
    // auto = 先按 KCP 解, 解不动当 raw 收
    mode: str(process.env.SLD_NET_MODE, "auto") as NetMode,
    maxSegmentsPerPacket: num(process.env.SLD_MAX_SEGMENTS, 64),
  },
  paths: {
    logs: path.join(ROOT, "data", "logs"),
    capture: path.join(ROOT, "data", "capture"),
    headerRule: path.join(ROOT, "data", "header-rule.json"),
    certs: path.join(ROOT, "certs"),
    // 客户端 APK(工具链/selftest 取 metadata 用, 假服运行不需要)
    apk: str(process.env.SLD_APK, path.join(RES, "apk", "sld_1.0.7.1426_bilibili.apk")),
  },
  server: {
    // 假服务端对外的身份, 之后与抓包结果对齐
    lineId: num(process.env.SLD_LINE, 1),
    serverId: num(process.env.SLD_SERVER, 10001),
    node: "offline-1",
    // 硬编码 = 复制进手机的渠道服资源包 kvl.kvl 里的 ResVersion(1583).
    // 服务端报这个值, 客户端判定"与本地一致" -> 不走热更, 直接读盘上的资源.
    // (10-24 试过回客户端自报的 1426: 照样进游戏, 没带来区别, 故回到 1583)
    resVersion: 1583,
    buildVersion: 1338,
    channel: "bilibili",
    /** 下发给客户端的公网地址(serverUrlData / 列表 / 热更 URL) */
    publicHost: str(process.env.SLD_PUBLIC_HOST, "23.147.232.29"),
    /** 局域网回连地址; 留空 = 127.0.0.1 */
    lanIp: str(process.env.SLD_LAN_IP, "127.0.0.1"),
  },
  // KCP 参数 (kcp2k 默认值); nodelay/interval/resend 只影响我们侧的发送节奏
  kcp: {
    mru: 1400,
    mtu: 1400,
    sndWnd: 32,
    rcvWnd: 32,
    interval: 10,
    maxRetrans: 0,
    nopush: false,
  },
  // 抽卡调试: forceQuality>0 时每次出货强制为该品质的随机本体(5=金), 用于验证结果动画.
  //   forceType: "" 按本次 roll 到的类型推断; "leader"/"weapon" 强制角色/律叶. forceQuality=0 时都无效.
  gacha: {
    forceQuality: num(process.env.SLD_GACHA_FORCE_QUALITY, 0),
    forceType: str(process.env.SLD_GACHA_FORCE_TYPE, ""),
  },
  log: {
    level: str(process.env.SLD_LOG_LEVEL, "info"),
    hexBytes: num(process.env.SLD_HEX_BYTES, 96),
  },
};

export const BILIBILI = {
  sdkCenter: "line3-sdkcenter-login.bilibiligame.net",
  apiHost: "app.bilibili.com",
  payHost: "pay.biligame.net",
  staticHost: "static.biligame.net",
  cdnHost: "nfile.xy.bilibiligame.net",
};
