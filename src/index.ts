#!/usr/bin/env node
// 入口: 起 HTTP(SDK/CND/热更) 与 UDP/KCP 网关, 并把收到的东西全部落盘.
//
//   node dist/index.js
//   SLD_NET_MODE=kcp SLD_LOG_LEVEL=debug node dist/index.js
//   SLD_ADMIN=1 node dist/index.js                # 附带管理面(默认 127.0.0.1:19080)
//
// 装配与启停都在 offline.ts(PC 常驻、管理面开关、APK 里的 main.js 走同一条路),
// 这里只负责"起进程 + Ctrl-C 收尾"。顶层 await 在 CommonJS 产物里不允许(TS1378), 故包一层。
import { log, summary } from "./logger.js";
import { createOfflineServer } from "./offline.js";
import { createAdminServer } from "./admin.js";

async function boot(): Promise<void> {
  const srv = createOfflineServer();
  await srv.start();
  // PC 上管理面是可选的(APK 里由 main.js 直接起)。起了就不随假服开关关 —— 否则手机
  // 一点"停止"就把自己锁在门外。端口被占只降级, 不许把假服一起带崩。
  if (process.env.SLD_ADMIN && process.env.SLD_ADMIN !== "0") {
    try {
      await createAdminServer(srv).ready;
    } catch (e) {
      log("warn", "admin", `${(e as Error).message} —— 假服照常运行; 换 SLD_ADMIN_PORT 再来`);
    }
  }
  process.on("SIGINT", () => {
    log("info", "boot", `退出 ${JSON.stringify(summary())}`);
    const hardExit = setTimeout(() => process.exit(0), 1500); // 收尾卡住也要让 Ctrl-C 有效
    void srv.stop().then(() => {
      clearTimeout(hardExit);
      process.exit(0);
    });
  });
}

boot().catch((e: Error) => {
  log("error", "boot", `起不来: ${e.stack || e.message}`);
  process.exit(1);
});
