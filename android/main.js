// nodejs-mobile 的入口脚本(打进 APK 的 assets/code/<buildCode>/main.js)。
//
// Java 侧把 assets 解出来之后这样起:
//   node main.js --root <filesDir/code/0.1.0-gXXXXXXX> --data <externalFilesDir/slddata> \
//                --seed <filesDir/seed> --admin 19080 [--no-start]
//
// 顺序是这份文件唯一的难点: config.ts 在模块加载时就把 ROOT/DATA 求成常量, 所以
// SLD_ROOT/SLD_DATA_DIR 必须在 require 任何本项目模块之前设好 —— 反过来(先 require 再设)
// 会静默用错目录, 存档落在代码目录里, 下次 APK 更新就连档带码一起没了。
const fs = require("fs");
const path = require("path");

const FLAG_ENV = {
  root: "SLD_ROOT",
  data: "SLD_DATA_DIR",
  admin: "SLD_ADMIN_PORT",
  "admin-host": "SLD_ADMIN_HOST",
  "http-port": "SLD_HTTP_PORT",
  "kcp-port": "SLD_KCP_PORT",
  "public-host": "SLD_PUBLIC_HOST",
  tls: "SLD_TLS",
  "net-mode": "SLD_NET_MODE",
  "log-level": "SLD_LOG_LEVEL",
};

// 手机上的默认值: 一切都在本机回环上。443 非 root 绑不了, 由 gadget 把 sockaddr 端口改成 9443。
const PHONE_DEFAULTS = {
  SLD_TLS: "1",
  SLD_HTTP_PORT: "9443",
  SLD_KCP_PORT: "19005",
  SLD_PUBLIC_HOST: "127.0.0.1",
  SLD_ADMIN_HOST: "127.0.0.1",
};

function parseArgv(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || String(next).startsWith("--")) flags[a.slice(2)] = true;
    else {
      flags[a.slice(2)] = String(next);
      i++;
    }
  }
  return flags;
}

const flags = parseArgv(process.argv.slice(2));
for (const [key, env] of Object.entries(FLAG_ENV)) {
  if (typeof flags[key] === "string") process.env[env] = flags[key];
}
for (const [env, val] of Object.entries(PHONE_DEFAULTS)) if (process.env[env] === undefined) process.env[env] = val;

const { seedOnce, runApk } = require("./bootstrap.js");
const { config, DATA } = require("./config.js");

// Java 侧一般显式传 --seed; 没传就在数据目录/代码目录旁边找一圈, 找不到就只得起服务不铺盘。
const seedDir =
  (typeof flags.seed === "string" && flags.seed) ||
  [path.join(DATA, "..", "seed"), path.join(path.dirname(process.env.SLD_ROOT || "."), "seed")].find((p) => fs.existsSync(p));

function report(e) {
  const msg = String((e && (e.stack || e.message)) || e);
  console.log("FATAL " + msg);
  try {
    fs.appendFileSync(path.join(config.paths.logs, "server.log"), `FATAL ${msg}\n`);
  } catch {
    /* 连日志目录都铺不出来时没什么可做的 */
  }
}

// 前台服务被系统回收也要放端口: 进程一死 socket 自然解绑, 这里只求个不卡收尾。
process.on("SIGTERM", () => process.exit(0));
// 单条消息处理里的异常不该把整个假服收掉 —— 管理面还在, 用户能在界面上看到红字并自己按重启。
process.on("uncaughtException", (e) => report(e));
process.on("unhandledRejection", (e) => report(e));

(async () => {
  const seed = seedDir ? seedOnce(seedDir, DATA, String(flags["build-code"] || "unknown")) : null;
  if (!seedDir) console.log("WARN 没找到 seed 目录, 跳过铺盘(存档得自己保证存在)");
  // 端口/主机都在上面的 FLAG_ENV 里进过了(config 读 SLD_*), runApk 只管"起不起假服"这一件事。
  const { offline, admin } = await runApk({ autoStart: !flags["no-start"] });
  console.log(
    `READY admin=http://${admin.host}:${admin.port} game=${config.http.host}:${config.http.port} ` +
      `gw=${config.gateway.host}:${config.gateway.port} mode=${config.gateway.mode} tls=${config.tls.enabled} ` +
      `data=${DATA} seed=${seedDir || "-"}(铺${seed ? seed.copied.length : 0}/留${seed ? seed.kept.length : 0}) ` +
      `running=${offline.running}`
  );
})().catch((e) => {
  report(e);
  process.exit(1);
});
