// 运行时探针(打进探针 APK 的 main.js): 只回答一个问题 —— nodejs-mobile 的 libnode
// 在这台手机上到底跑不跑得起来、跑起来吃多少内存。它不联网、不起服务、不读存档,
// 屏上那几行字就是判据 —— 拿不到 adb 的时候, 这是唯一能由用户眼睛确认的证据。
//
// 顶层 await 在 CJS 里是 SyntaxError(nodejs-mobile 只吃 CJS), 所以整段包在 IIFE 里。
const fs = require("fs");
const os = require("os");
const path = require("path");

const lines = [];
const say = (k, v) => lines.push(`${k}=${v}`);

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const outFile = outIdx >= 0 ? argv[outIdx + 1] : path.join(__dirname, "probe-out.txt");

const flush = () => {
  const text = lines.join("\n") + "\n";
  try {
    fs.writeFileSync(outFile, text);
  } catch (e) {
    console.log("写不出 " + outFile + ": " + e.message);
  }
  console.log(text);
};

(async () => {
  try {
    say("node", process.version);
    say("abi", `${process.arch}/${os.machine()}`);
    // 期望值: CustomEvent=undefined(Node 18 就没有, kcp.ts/gateway.ts 已改用 node:events)。
    // 手机上真跑出 function 反倒要留意 —— 说明 libnode 不是那份 18.20.4。
    say("CustomEvent", typeof CustomEvent);
    say("EventTarget", typeof EventTarget);

    const t0 = Date.now();
    const { EventEmitter } = require("node:events");
    const ee = new EventEmitter();
    let got = "";
    ee.on("data", (b) => { got = String(b); });
    ee.emit("data", Buffer.from("probe"));
    say("events", got === "probe" ? `ok@${Date.now() - t0}ms` : "EMIT-BROKEN");

    // dgram: 关掉的 socket 能不能再 bind —— 重启假服的"每次 start 换新 socket"就是为它。
    // 注意 bind 在已 close 的 socket 上是**同步抛**(node:dgram healthCheck), 不挂 error 事件,
    // 所以两条都要包起来: 这里要的是"手机上是哪种失败", 不是让探针自己被它带崩。
    const dgram = require("node:dgram");
    const t1 = Date.now();
    const s1 = dgram.createSocket("udp4");
    await new Promise((r) => s1.bind(0, "127.0.0.1", r));
    const p1 = s1.address().port;
    s1.close();
    const oldReuse = await new Promise((r) => {
      try {
        s1.once("error", (e) => r(String(e.code || e.message)));
        s1.bind(p1, "127.0.0.1", () => r("rebinds"));
      } catch (e) {
        r(String(e.code || e.message));
      }
    });
    const freshTake = await new Promise((r) => {
      const s2 = dgram.createSocket("udp4");
      s2.once("error", (e) => r("FAIL:" + String(e.code || e.message)));
      s2.bind(p1, "127.0.0.1", () => { s2.close(); r("ok"); });
    });
    say("dgram", `旧socket复用=${oldReuse} 新socket占回同端口=${freshTake} @${Date.now() - t1}ms`);

    // 36 张整表全展开: APK 里最大的一块常驻内存, 手机上撑不撑得住只看这一行
    const tbl = require("./tbl.js");
    const names = Object.keys(require("./data/tbl/index.js"));
    const t2 = Date.now();
    let rows = 0;
    for (const n of names) rows += Object.keys(tbl.all(n)).length;
    say("tables", `${names.length}张/${rows}行/${Date.now() - t2}ms`);
    // 整条 CJS 依赖图 require 得起吗: "export * as" 在 CommonJS 下编译成 getter, 具名导入认不全
    // 是已知风险点(只有 arm64 那份 libnode 上跑过才算数)。只 require, 不起任何服务。
    const mods = ["config.js", "logger.js", "gateway.js", "http.js", "payloads.js", "offline.js", "admin.js", "bootstrap.js"];
    const broken = [];
    for (const m of mods) {
      try {
        require("./" + m);
      } catch (e) {
        broken.push(`${m}:${String((e && e.message) || e).slice(0, 60)}`);
      }
    }
    say("modules", broken.length ? "FAIL " + broken.join(" ") : `ok/${mods.length}`);
    // 峰值放在这测: 整表已展开 + 全依赖图已 require, 和假服起来后的常驻规模最接近
    const rss = process.memoryUsage();
    say("rssMb", Math.round(rss.rss / 1048576));
    say("heapMb", Math.round(rss.heapUsed / 1048576));
    say("sysMb", `${Math.round(os.totalmem() / 1048576)}/${Math.round(os.freemem() / 1048576)}`);
    say("ok", "1");
  } catch (e) {
    say("fatal", String((e && (e.stack || e.message)) || e).replace(/\n/g, " | ").slice(0, 400));
  }
  // node::Start 一旦排空事件循环就会走到 exit(): 进程没了, UI 也就读不到结果了。
  // 所以下面挂一个 ref 定时器把循环钉住 —— 探针进程停在"答案已写完, 等人来看"的状态。
  say("hold", "alive");
  flush();
  setInterval(() => {}, 1 << 30);
})();
