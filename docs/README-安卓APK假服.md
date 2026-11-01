# 安卓 APK 假服 · 手机自己当服务器

> 相关：[当前方案总览](README.md) §4 · [注入器 gadget](README-注入器gadget.md)（端口改写就住在那份脚本里）·
> [存档修改](README-存档修改.md)（存档落盘位置和 PC 上同一套流程）· [frida 抓包](README-frida抓包.md)

把 `offline-server` 整套塞进一个 APK，跑在手机上：**不需要 PC、不需要 frpc 隧道**。
手写的那 4,923 行协议字节实现一行没改，上机的是已经在真机跑绿两轮的那份产物，只是多了一层壳。

---

## 0. 两条网络路，二选一

```
现状(隧道)：手机(改 hosts) ──> <YOUR_SERVER_IP> ──frps:7000──> frpc ──> PC 假服(9443/19005)
本地自服：  手机 ──127.0.0.1──> APK 里的 Node 假服(9443/19005)      ← 本文
```

本地自服只多一道坎：**非 root 绑不了 443**，而假服在服务器列表/登录包里下发的 GS 地址写死了 `:443`
（`src/http.ts` 的 `urlList`）。解法不是让 APK 去绑 443，而是让**客户端侧**把 sockaddr 里的端口就地改掉：
gadget 那份 hook 脚本已经 hook 了 `connect()`，顺手把 `127.0.0.1:443` 写成 `127.0.0.1:9443`
（9443 = 0x24E3，**网络序大端**）。KCP 走 UDP 用的是 `sendto`、根本不经过 `connect()`，
所以 `getaddrinfo` 的返回链（`ai_addr`）也要同样改一遍 —— 只改 `connect` 的话 HTTPS 通了而网关连不上。

开关做在脚本内部（不是两个文件）：

| `MODE` | `REDIR` | 端口改写 | 用于 |
|---|---|---|---|
| `tunnel`（默认） | <YOUR_SERVER_IP> | `SA_RULE = null`，一个字节都不碰 | PC 跑假服 + frpc |
| `local` | 127.0.0.1 | `{ip:'127.0.0.1', from:443, to:9443}` | 手机 APK 假服 |

---

## 1. 两个 APK

| 模块 | 包名 | 产物 | 装机大小 | 干什么 |
|---|---|---|---|---|
| `:probe` | `com.sld.offline.probe` | `probe/build/outputs/apk/debug/probe-debug.apk` | 18,725,472 B | **路线判生死**：屏上直接写 `process.versions` / `typeof CustomEvent` / dgram 复用结论 / 36 张表展开峰值 RSS / 8 个模块能否 require。✅ **11-01 真机全绿**（读数在 §7） |
| `:app` | `com.sld.offline.server` | `app/build/outputs/apk/debug/app-debug.apk` | 18,730,110 B | 正式壳：前台服务跑假服 + WebView 管理页 |

体积几乎全是 `libnode.so`（发布件 62,475,584 B，AGP 的 `stripDebugSymbols` 剥到 49.5 MB，再 deflate 进包）。
装机用的两份落在 **`/home/sld/apkbuild/`**：`sld-offline-probe-v1.apk`（md5 `744b618a4a14…`）、
`sld-offline-server-v1.apk`（md5 `aa940f9ae062…`），和上面的 build 产物逐字节一致。
同目录还有 `gadget-local/` 与 `gadget-tunnel/` 两份就绪 hook 脚本（按设备上的文件名叫，见 §6）。
`res/apk/` 只放游戏包，别混（AGENTS.md 那条"APK 不碰、不重签"说的是游戏 APK，我们的产物也不该去蹭它）。

先装 probe。它证明的是"这台机器的 arm64 libnode 能不能跑起来 + 内存够不够"，
这两件事错了，后面整条 nodejs-mobile 路线都要推翻（备选是无 Node 的重写，见 §9）。

---

## 2. 构建（这台 2 核 2GB 机上验证过的命令）

料全在 `/home/tmp`（仓库铁律，不占系统 `/tmp`）：

```
/home/tmp/nodejs-mobile/{bin/arm64-v8a/libnode.so, include/node}   # v18.20.4 android 发布件
/home/tmp/node18/bin/node                                          # 同版本 linux-x64, 离线模拟用
/home/tmp/gradle/gradle-8.7/bin/gradle
/home/tmp/android-sdk/  platforms;android-34 + build-tools + ndk;26.3.11579264 + cmake;3.22.1
/home/tmp/gradle-home/                                             # GRADLE_USER_HOME, 依赖缓存
```

`android/local.properties` 写 `sdk.dir=/home/tmp/android-sdk`（不入库）。

```bash
cd /home/sld/offline-server
npm run build:cjs                              # tsc -> dist-cjs/ (CommonJS) + dist-cjs/package.json
node tools/pack_nodejs.mjs                     # dist-cjs + 必需数据 -> app/src/main/assets/{code,seed}
GRADLE_USER_HOME=/home/tmp/gradle-home /home/tmp/gradle/gradle-8.7/bin/gradle \
  --no-daemon -p android :app:assembleDebug    # 换 :probe:assembleDebug 出探针
# 产物落进 apkbuild(换版就改后缀 v2, 别覆盖掉能装的那一份)
cp android/app/build/outputs/apk/debug/app-debug.apk /home/sld/apkbuild/sld-offline-server-v1.apk
```

探针那份 assets 单独铺：`node tools/pack_nodejs.mjs --main android/probe.js --out android/probe/src/main/assets`。

**内存护栏是必需的，不是洁癖**：1,963 MB RAM、无 swap、根分区只剩 3.0 G。
`android/gradle.properties` 里写死了 `-Xmx640m -XX:MaxMetaspaceSize=256m -XX:+UseSerialGC` 且关了
daemon 与并行；命令行再带 `--no-daemon`。任何"gradle 构建中途被杀"先怀疑这里。

工具链版本（升之前知道自己在动什么）：Gradle 8.7 / AGP 8.5.2 / JDK 17 / compileSdk=targetSdk 34 /
minSdk 21 / NDK 26.3.11579264 / CMake 3.22.1 / 纯 Java（无 Kotlin）/ `abiFilters 'arm64-v8a'`。

### 2.1 改了假服代码之后重出 APK（日常路径）

**先提交，再打包。** `buildCode = <package.version>-g<git rev-parse --short HEAD>`，未提交的改动不改号；
而同一 `buildCode` 目录是**覆盖式解包、不删多余旧文件**（跨版才整目录删旧的，见 `NodeBridge.prepare`），
所以改了名/删了的模块会在手机上留着 —— 想干净换代就得让号变，也就是先 commit。

```bash
cd /home/sld/offline-server
git add -A && git commit -m '<scope>: <一句话>'      # 号要变, 不然手机上是旧码目录
npm run typecheck && npm run selftest                # 老规矩: 改完先过 PC 侧
npm run build:cjs && npm run selftest:cjs            # CJS 产物单独再验一遍(Node18 语义)
node tools/pack_nodejs.mjs --check                   # 只核产物树, 不重写
node tools/pack_nodejs.mjs                           # -> assets/{code,seed}
GRADLE_USER_HOME=/home/tmp/gradle-home /home/tmp/gradle/gradle-8.7/bin/gradle \
  --no-daemon -p android :app:assembleDebug
cp android/app/build/outputs/apk/debug/app-debug.apk /home/sld/apkbuild/sld-offline-server-v2.apk
md5sum /home/sld/apkbuild/*.apk                      # 装机时报哪个包, 靠这个对
```

- **只改了 hook 脚本**（`frida/hook_gadget_all.js`）不用重编 APK：`cd frida && ./make_variants.sh`，
  再把两份变体 `cp` 进 `apkbuild/gadget-{local,tunnel}/hook_redirect_trust.js`（文件名不许动）。
- **升级不会动玩家的档**：`slddata/` 由 `seedOnce` 保证"缺了才铺"，新版 APK 里那份更新的 `save.json`
  铺不进去。要把 PC 上推进的档带到手机，两条路：管理页存档标签贴 JSON 保存，或者先把 `slddata/` USB
  拉走备份、删掉 `data/save.json{,.bak}` 再冷启动让 seed 重铺。
- **别覆盖掉能装的那一份**（`-v1` 留着回退），也别卸载重装 —— 卸载连 `Android/data/com.sld.offline.server/`
  一起删，档就没了。同机 debug 签名（`~/.android/debug.keystore`）才能覆盖安装。

---

## 3. 运行时布局：铺盘铁律

**代码目录与数据目录彻底分开**，这是"更新 APK 会不会刷掉存档"的唯一防线：

| 位置（设备） | 内容 | 更新语义 |
|---|---|---|
| `files/code/<buildCode>/` | `main.js` + `dist-cjs` 全部 + `package.json` | APK 更新就整目录覆盖，换版删掉旧 `<buildCode>` 目录 |
| `files/seed/` | `certs/` + `data/{save,header-rule,frame_prefix,skipapi,getclientupdatedata}.json` | 从 assets 解出来，**只在目标缺失时铺**（`bootstrap.seedOnce` + `.seedver`） |
| `Android/data/com.sld.offline.server/files/slddata/` | `data/save.json`、`logs/`、`admin.token` | 可写数据根，USB 能直接拉，升级 APK 不动它 |

`<buildCode>` 由 Java 从 `assets/code/manifest.json` 读（不在 Java 里抄一份版本号），形如 `0.1.0-g<commit>`。
存档落错目录的后果是"下次 APK 更新连档带码一起没"，所以顺序有硬约束：
`android/main.js` **必须在 require 任何本项目模块之前**把 `SLD_ROOT`/`SLD_DATA_DIR` 设好
（`src/config.ts` 在模块加载时就把 `ROOT`/`DATA` 求成常量）。

Java → Node 的 argv 契约：

```
node main.js --root <filesDir/code/<bc>> --data <externalFilesDir/slddata> \
             --seed <filesDir/seed> --admin 19080 --admin-host 127.0.0.1 --build-code <bc>
```

`--root/--data/--admin/--admin-host/--http-port/--kcp-port/--public-host/--tls/--net-mode/--log-level`
逐个映射进 `SLD_*`（`android/main.js` 的 `FLAG_ENV`），手机默认全在回环上（`PHONE_DEFAULTS`）。
这条契约有离线判据，见 §4。

**开关语义 = Node VM 常驻，JS 层真启真停**：`node::Start` 会阻塞、样例 glue 没有可靠的
quit/restart，所以"关假服"不是杀进程，而是 `socket.close()` + `server.closeAllConnections()` +
`peers.clear()` + 摘掉 message/error 监听 —— 不许出现"关了还在收包"。管理面端口（19080）**永不随开关关闭**，
否则手机 UI 自己把自己锁在外面。Node 18 上 `dgram` 的 socket `close()` 之后再 `bind()` 会**同步抛**
`ERR_SOCKET_DGRAM_NOT_RUNNING`（不是 error 事件），所以每次 start 都新建一个 gateway。

---

## 4. 离线闸门（这台机器没有 adb，所以能离线判的先离线判）

`npm run selftest` 现在 **78/78**。APK 这条路上新增的闸门（另有启停三轮、seed 不覆盖已有存档、
管理面写档安全与 token，都在同一次自检里）：

| 自检 | 判的是什么 |
|---|---|
| `pack+node18: 按手机布局起假服` | 用 `/home/tmp/node18` 按 §3 的目录布局真起一次：铺盘 7 留 0、管理面 `running:true`、`urlList` 下发 `https://127.0.0.1:443`、存档落在数据目录而不是代码目录 |
| `probe: 探针脚本在 node18 上跑出预期读数` | 同一个 `android/probe.js` 在 linux-x64 的 node18 上跑，断 `CustomEvent=undefined`、`旧socket复用=ERR_SOCKET_…`、`新socket占回同端口=ok`、`modules=ok/8`、整表 25,193 行 —— 屏上那几行的**期望值**是先离线钉住的，上机只需要比对数值 |
| `android: 壳的接线` | 从源码文本断 JNI 符号名 = `Java_com_sld_offline_server_NodeBridge_nativeRun`、`System.loadLibrary` 的名字 = CMake 的 target、argv 的每个标志都在 `FLAG_ENV` 里、manifest 的 abi/node 版本对得上 |
| `gadget: sockaddr 端口改写` | 把 `SLD_SA_START/SLD_SA_END` 圈出的纯字节函数抽进 `vm` 空上下文：`127.0.0.1:443 → 24 E3`、四种"不该动"的 sockaddr 逐字节不变、再按改写出来的字节**真 connect** 一次临时端口。附带断言 `hook_gadget_all.js` 的共享块 == `hook_redirect_trust.js`、变体没和基线漂移 |

改 frida 那份脚本里的字节偏移 = 直接改这条自检的前提，红了就是真红。

---

## 5. 界面与端口

| 端口 | 用途 | 绑 |
|---|---|---|
| 9443 | HTTPS 游戏 API / SDK 桩（自签证书，靠客户端自带放水信任） | 0.0.0.0 |
| 19005 | KCP/UDP 网关 | 0.0.0.0 |
| 19080 | 管理页（单文件 HTML，JS 侧下发） | **127.0.0.1** |

打开 App 就是管理页（`MainActivity` 里 WebView 指 `http://127.0.0.1:19080/`），同时顺手把前台服务拉起来；
首次铺盘 + 解析 13 MB 整表要十几秒，所以加载失败是 **1.5 s × 20 次重试**，真连不上才换成失败页
（里面是 `NodeBridge.lastError()` 原文 + logcat tag）。返回键只是退应用，假服继续在前台服务里跑。

页面三个标签：**状态**（`启动/停止/重启` + handler 数、peer、RSS、Node 版本、表缺失统计）·
**存档**（18 个顶层键的 JSON + 货币快捷改，走 `/api/items?kind=money`）·
**日志**（尾读 + 级别切换 + 2 秒跟随，`nextOffset` 续着读不重复）。
日志走管理页而不是 logcat —— 用户手机上没有 adb，logcat 等于不存在。

安全：绑非回环才要 token（首启生成 `data/admin.token`，0600；WebView 拼 `?token=`，页面存 localStorage
后改带 `X-Admin-Token`）。写档路径是 `normalizeSave()` + 18 个顶层键结构断言 + 道具 id ∈ `ITEM_VALID`，
通过才在 `data/logs/save.pre-admin.<ts>.json` 留一份原件，任一环抛错回 400 **且不落盘**。
明文 HTTP 只对 127.0.0.1 放行（`res/xml/network_security_config.xml`），不给整个网面。

通知栏常驻一条：`假服在跑 https:9443 kcp:19005 · 管理页 19080`，起不来时变成 `起不来: <错误>`
（8 秒后回填，见 `REPORT_AFTER_MS`）。点通知回到管理页。**开关只在页面里**，通知没有 action 按钮。

---

## 6. 手机上跑通一轮

1. 装 `sld-offline-server-v1.apk`，打开 → 允许通知权限（Android 13+）→ 页面应显示 `running:true`。
   30 秒后还变成"连不上管理页"，那页里就写着 `NodeBridge.lastError()` 原文，通知栏同一句也会显示出来。
2. 把设备侧 hook 脚本换成 **local 那份**。就绪副本已经按设备上的文件名铺在 `/home/sld/apkbuild/` 里 ——
   **文件名必须是 `hook_redirect_trust.js`**（`libTool.config.so` 里写死了这个路径），所以每个模式一个目录：

   ```
   /home/sld/apkbuild/gadget-local/hook_redirect_trust.js    MODE=local   手机自服用（md5 14901874a19e）
   /home/sld/apkbuild/gadget-tunnel/hook_redirect_trust.js   MODE=tunnel  回退用（md5 eef48793f17b）
   ```

   覆盖到 `/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/hook_redirect_trust.js`（USB 或游戏内文件管理）。
   这两份是**产物**，别手改；改了基线就重新生成再重新铺：

   ```bash
   cd /home/sld/offline-server/frida && ./make_variants.sh
   cp hook_gadget_local_pool_zaxis_skip.js /home/sld/apkbuild/gadget-local/hook_redirect_trust.js
   cp hook_gadget_pool_zaxis_skip.js      /home/sld/apkbuild/gadget-tunnel/hook_redirect_trust.js
   ```
3. 冷启动游戏，看 `/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/gadget.log`：
   - `==== 脚本装载 mode=SKIP net=local ====` ← `net=` 这个字段就是为这一步加的；没有它说明推的是旧文件；
   - `sockaddr 127.0.0.1:443->9443 改写 {"connect":n,"getaddrinfo":m}` ← n+m 为 0 就是改写没生效，
     别去查假服，先查脚本；gadget 没有 host 端收 `send()`，所以这个计数只能落进文件。
4. 登录进大厅即通。存档要拉出来就用 [存档修改](README-存档修改.md) 那套：
   `Android/data/com.sld.offline.server/files/slddata/data/save.json`。

---

## 7. 真机验收（装完只需答这五条）

| # | 看什么 | 判据 |
|---|---|---|
| 1 | 探针 APK 屏上那几行 | `node=v18.20.4`、`CustomEvent=undefined`、`dgram=旧socket复用=ERR_SOCKET_… 新socket占回同端口=ok`、`tables=36张/25193行`、`modules=ok/8`、`rssMb=…` —— 路线成不成一看就定 |
| 2 | 壳起服 + 游戏登录 | 通知栏写 `https:9443 kcp:19005 · 管理页 19080`，游戏能登进大厅（证明 `127.0.0.1` + 443→9443 生效） |
| 3 | 真停真起 | 页面里"停止假服"→ 游戏掉线；"启动假服"→ 重连进得来。掉了又马上回来才算数（不是"关了还在收包"） |
| 4 | 改存档不重登生效 | 页面把某个角色等级/金币改掉 → 大厅里立刻变（`loadSave()` 每请求重读盘）；日志页能看到刚才那几条 `req/resp msgId=` |
| 5 | 息屏 5 分钟 | 回来还在大厅、管理页还能开（前台服务 + `WAKE_LOCK` 成不成） |

**第 1 条已过（2026-11-01 真机读数，手机 = 5,616 MB RAM / 可用 1,017 MB）**：

```
node=v18.20.4  abi=arm64/aarch64  CustomEvent=undefined  EventTarget=function  events=ok@0ms
dgram=旧socket复用=ERR_SOCKET_DGRAM_NOT_RUNNING 新socket占回同端口=ok @28ms
tables=36张/25193行/186ms  modules=ok/8  rssMb=228  heapMb=56  sysMb=5616/1017  ok=1  hold=alive
```

对着判据：`dgram` 那串和离线自检断的字样逐字相同（所以"每次 start 换新 socket"是真机行为不是我这边保守）；
整表 186 ms（PC 103 ms，阈值 400 ms）；`modules=ok/8` 关掉 `export * as` 那条风险；`hold=alive` 说明
`node::Start` 常驻成立。**`rssMb=228` 比 PC 上"36 张表全展开天花板 114 MB"高一倍** —— 探针是最坏情况
（8 个模块全 require + 整表一次展开且都持着），真服是惰性 parse 所以稳态更低；5.6 GB 的机器上不是约束。
2 GB 那条约束是构建机，不是手机。

**第 2 条已过（2026-11-01）**：用户报"可以用了"，即壳起服 → 游戏经 `127.0.0.1` 登进大厅并打得动关卡
（443→9443 的 sockaddr 改写生效）。同一次反馈里先说"**关卡进度像是清零了**"、随后"**重进就好了**" ——
盘上核过是**假警报**：`data/save.json` 与 APK 铺盘的 seed 逐键对得上（`levels` 1915 条、每条 `[1,2,3]`，
除 `signin` 外无差异），是客户端 `LevelDataMgr` 要重登才把 `mainLevelInfo` 铺满，不是服务端丢档。
**这条对 B3 有直接意义**：通关后大厅星级/章节的即时刷新依赖结算包里的 `mainLevelInfo`
（[`src/payloads.ts`](../src/payloads.ts) 的 `overMainLevelS2C`），下次真机轮就是看**不重登**会不会自己亮。

第 3/4/5 条（真停真起 / 改档不重登生效 / 息屏 5 分钟）尚未收到反馈。

失败时先回 §6 第 3 步核 `gadget.log` 那两行，再回 §5 看通知栏是不是"起不来: …"——
**这两处分别是"客户端没连过来"和"服务端没起来"的分界**，别看现象猜。

## 8. 已知边界

- **只解决服务端**。资源仍是盘上那份 1583（`resVersion` 在 `src/config.ts` 硬编码），APK 里不下资源。
- **没 root 就只能 9443**，所以 local 模式的成败完全压在 §0 那条端口改写 + gadget 装载上；两者任一失效都是"连不上"，
  靠 `gadget.log` 那两行区分。
- Android 14 对前台服务收紧：`foregroundServiceType="specialUse"` + `FOREGROUND_SERVICE_SPECIAL_USE`
  + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`。息屏 5 分钟不掉线这件事**还没真机验过**（WAKE_LOCK + `START_STICKY`）。
- Node 18 无全局 `CustomEvent`（Node 19 才保证）；`kcp.ts`/`gateway.ts` 已经改用 `node:events`，别在 APK 路线上再引它。
- 包内 JS 图在 node18 上 require 干净（探针的 `modules=ok/8`），但**混淆/release 构建没测**：
  `minifyEnabled false` 是刻意的，假服靠 require 路径与动态 import 起服务。

## 10. 迭代线：以后都在 `apk-server` 上改

本文档所属的 APK 路线与 B 组（假 GS 对齐）**共用一条线**，就是 `apk-server`。理由与现状（`git rev-list --count` 实测，2026-11-01）：

| 分支 | HEAD | 与 `apk-server` 的关系 |
|---|---|---|
| `apk-server` | `5bc2c64` | **迭代线**：APK 步0-7 与 B 组各档都在这条上 |
| `gs-parity` | `92864f5` | 已**整条并入**（`merge-base --is-ancestor` 为真），不再往上提交 |
| `master` | `381b037` | 也是严格祖先，落后 34 个提交；B 组之前的老基线，只作历史参照 |
| `channel-1428` | `9a2bb22` | **未并入、也没废弃** —— 1 个提交（渠道包 1428 一套 + `SLD_NOW` 时间仿真 + `data/save.nearme.json` + `tools/convert_save.py`），改了 `config.ts/save.ts/payloads.ts/http.ts/selftest.mjs`，其中 `src/data/tables.ts` 那部分已被 A2 的整表管线取代。**要不要 cherry 进来是个未决问题**，动它之前先想清楚冲突面 |

日常顺序照本文 §2.1：改 `src/` → `typecheck` + `selftest`（ESM 产物）
→ `build:cjs` + `SLD_DIST=dist-cjs /home/tmp/node18/bin/node test/selftest.mjs`（APK 用的是这份 CJS 产物，
**两条都得绿**）→ 提交 → `pack:android` → gradle。**先提交后打包**，`buildCode` 里带 `git rev-parse --short HEAD`，
不提交就打包会让手机上留着同名的旧代码。

## 11. 备选路线（为什么没走）

不用 Node、把协议重写成纯 Java/Kotlin：省掉 49 MB `.so`、常驻内存再降一截，但要**手写第二份字节实现**——
上机验证过的 4,923 行协议代码得重做一遍并重新和真机对齐，风险全在协议侧而不是运行时侧。
内存实测也不构成理由：真服在 2 GB 机上常驻 80 MB、`VmHWM` 108 MB，36 张表 25,193 行全展开的天花板 114 MB。
