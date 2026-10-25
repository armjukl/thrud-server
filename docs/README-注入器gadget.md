# 斯露德假服 · 用注入器载体注入 frida-gadget（免 root / 免 frida-server 的 hook 通道）

> 最后更新：2026-10-17 ｜ 载体产物在 `/home/tmp/sldcarrier/` ｜ 脚本在 [`frida/`](../frida/) ｜ 传统远程 frida 见 [`README-frida抓包.md`](README-frida抓包.md)

一句话：**把 frida-gadget 塞进游戏进程里，让它开机自带 hook**。不依赖手机跑 frida-server，不依赖 adb，不依赖 root；
脚本改动只需覆盖外置目录里的 `.js`，不用重装 APK。

---

## 1. 为什么需要这条通道

原来所有 hook 都走 `frida/run_hook.py` → 远程连手机上的 frida-server（`23.147.232.29:27049`）。
它的软肋：frida-server 一挂（本项目 10-17 13:25 之后就是这状态，`adb devices` 也是空），
观测能力直接归零，连设备上的文件都读不出来。

gadget 是"进程内"的：脚本随库加载就在进程里跑，日志自己落盘到游戏外部目录，
所以只要游戏能被带起来，我们就有 hook + 有日志。

| | `run_hook.py` + frida-server | 载体 + gadget（本文） |
|---|---|---|
| 前置 | 手机跑 frida-server + 隧道 | 装一次载体 APK |
| 脚本热更新 |  host 侧改，随时 | 覆盖外置 `.js`，随时 |
| 收消息 | `send()` 到 host | 只能自己 `open/write` 落盘 |
| spawn 时机 | frida spawn，可控 | 天然最早（native init 前） |
| 失效风险 | server 挂 = 全瞎 | 游戏更新换包 = 载体白装 |

> gadget 的装载时机比 frida-server 的 spawn 还早，好处是 `Interceptor.replace` 一定赶得上；
> 麻烦是 `libil2cpp.so` 还没映射（§5.1）。大流量 dump（Lua 明文、UDP 报文）仍走 `run_hook.py`，
> 但那条路依赖 `SLD_AGENTS`/`SLD_AGENTS2` 两段式来避开"域还没建就调 `il2cpp_*` 崩进程"的老坑。

---

## 2. 原理链

1. 载体 APK `com.hitmargin.cve_2025_59489`（"sky明日启动器"，利用了 CVE-2025-59489）
   取目标包的 launch intent，往里塞 `android.intent.extra.TEXT`，
   内容是 Unity 命令行参数 `-xrsdk-pre-init-library <nativeLibraryDir>/libTool.so`。
2. Unity Player 启动时把那个 extra 当命令行参数解析，`-xrsdk-pre-init-library`
   让它在 native 初始化**极早期** dlopen 指定的 so。
3. 那个 so 就是 frida-gadget 16.7.19（arm64）；同目录的 `libTool.config.so` 决定它的行为模式。

dex 里的直接证据（`unzip -p sky-sldgadget_v1.apk classes.dex | strings`）：

```
-xrsdk-pre-init-library      /lib/arm64/libTool.so      /libTool.so
android.intent.extra.TEXT    getLaunchIntentForPackage
launchAppWithPreInit         launchAppNormally          Launched normally (no pre-init)
libTool.so library loaded!   SO Exists:                 SO Readable:
```

三条硬约束，都是踩过才记住的：

- **文件名必须是 `libTool.so`**：路径是 `nativeLibraryDir` + `/lib/arm64/libTool.so` 硬编码在 dex 里，改不了一点。
- **gadget 配置的找法是"替换式"不是"追加式"**：`libTool.so` ↔ **`libTool.config.so`**；
  网上常见的 `libTool.so.config.so` 它**不认**（三路对照实验证实）。
- **配置文件可以跟着 APK 走**：PMS 的 `NativeLibraryExtractor` 会把 `lib/<abi>/` 下**任何** `.so` 命名的条目解出去
  （128 B 的 JSON 也照样解），落在 `/data/app/<pkg>-<hash>/lib/arm64/`。重装会重新解包，路径里的 `<hash>` 每次安装都变。

注意：游戏必须**由载体带起来**才会挂 gadget；直接点游戏图标走的是 `launchAppNormally`，没有 hook。

---

## 3. gadget 的两种模式

配置内容就是 JSON，整包 128 B 左右。

**script 模式（当前用的）** —— 进程内自动加载一个 js，无需 host：

```json
{"interaction":{"type":"script","path":"/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/hook_redirect_trust.js"}}
```

`path` 用**游戏自己的外部目录**，好处是 untrusted_app 可读写、换脚本只要覆盖文件；
代价是没有 host 收 `send()`，日志必须自己落盘（见 §5.2）。

**listen 模式** —— gadget 起 frida-server，host 侧照常连（可复用 `run_hook.py`）：

```json
{"interaction":{"type":"listen","address":"127.0.0.1","port":27043,"wait":false}}
```

现成的两份在 [`frida/gadget/`](../frida/gadget/)（`libTool.config.so` = script，`.listen.example` = listen）。
`wait:false` 表示不阻塞等 host 附加，游戏照常跑。listen 模式还没实测（要先把端口弄到本机）。

---

## 4. 打包与安装

产物（已构建好，别重复劳动）：

| 文件 | 大小 | md5 |
|---|---|---|
| `/home/tmp/sldcarrier/sky-sldgadget_v2.apk` | 25,904,126 B | `afd2d2d76667cf7d4f08ab04f58bfa9d` |
| `└ classes.dex` | 43,848 B | 改了默认目标包/Activity + 显示字色（见 §4.1） |
| `└ lib/arm64-v8a/libTool.so`（gadget 16.7.19 arm64） | 25,822,568 B | `03aedba31baeac4ab7f9f488cd6ff823` |
| `└ lib/arm64-v8a/libTool.config.so` | 128 B | `2509ebb3a042846ab0156bad81e690b9` |

> `sky-sldgadget_v1.apk`（md5 `ba69f15d…`）是只换 payload、没改 UI 默认值的上一版，已被 v2 取代；
> 两版**同一个 debug 证书**签名，可以直接覆盖安装，不用先卸载。

### 4.1 改载体的默认目标（包名 / Activity）

载体 UI 有两个输入框，点"启动游戏"时走 `Intent.setClassName(包名, Activity)` + `putExtra("unity", "-xrsdk-pre-init-library <路径>")`：

| 标签 | id | 原默认 | 现在 |
|---|---|---|---|
| 游戏名称 | `package_name_input` | 布局里 `android:text="com.hypergryph.endfield"` | `com.wth.thrud.bilibili` |
| 游戏进程 | `entry_input` | `DEFAULT_ENTRY` = `com.u8.sdk.U8UnityContext`（U8/9 游的） | `com.thrud.main.MainActivity` |
| 两个输入框的字色 | 同上（布局里 `android:textColor`） | `#00ffffff`（透明，作者故意藏起来） | `#ff333333`（显示出来） |

值从 `aapt dump badging res/apk/sld_1.0.7.1426_bilibili.apk` 拿：
`package name='com.wth.thrud.bilibili'`，`launchable-activity name='com.thrud.main.MainActivity'`。

改这些的脚本（可重复执行，带锚点校验、原子写）：`/home/tmp/sldcarrier/patch_carrier_defaults.py src2/smali`。

改这些前必须知道的三个坑：

- **dex 里有两套完全重复的类树**：`com/example/cve_2025_59489/*` 和 `com/hitmargin/cve_2025_59489/*`
  （2427 行的 `MainActivity` 各一份，互为副本）。manifest 启动的是 **`com.hitmargin.…MainActivity`**，
  只改 `com.example` 那份是**没用的死代码**。改的时候两棵都改，保持一致。
- **包名默认值在 `resources.arsc`（布局 XML）里，不在 dex 里**。重编资源要用 `apktool b`，
  而这份 APK 会触发 `Renamed manifest package`（apktool 会把包名写成 `com.hitmargin.sky明日`，直接变成另一个 App）。
  所以**不动资源**，改为在 `onCreate` 里 `packageNameInput.setText("com.wth.thrud.bilibili")` 覆盖布局初值。
- **写 smali 别用 `open(path,'w').write(transform(text))`**：`io.open(p,'w')` 会**先截断文件**，
  参数表达式（如 `str.format()`）一旦抛异常，文件就成 0 字节了——本项目真把一份 `MainActivity.smali` 写空过，
  只能从原 dex 重新 baksmali 再来。改成"先在内存里算好新内容，再写临时文件 + `os.replace()`"。
  顺带：`str.format()` 会把 smali 指令里的 `{p1, v1}` 当字段名，拼模板用 `@PKG@` 占位再 `replace()`。

只重编 dex 的完整链子（`resources.arsc`/`libTool.so` 原样保留）：

```bash
cd /home/tmp/sldcarrier
apktool d -f -o src2 sky-sldgadget_v1.apk                    # 1) 反编(只为拿 smali)
python3 patch_carrier_defaults.py src2/smali                 # 2) 改默认值/字色(两棵类树一起)
BP="/usr/share/apktool/*:/usr/share/java/jcommander.jar"     #    smali CLI 需要 jcommander
java -cp "$BP" org.jf.smali.Main assemble src2/smali -o classes_new.dex   # 3) 汇编
java -cp "$BP" org.jf.baksmali.Main disassemble _orig/classes.dex -o chk_orig   # 4) round-trip 校验
java -cp "$BP" org.jf.baksmali.Main disassemble classes_new.dex -o chk_new
diff -r chk_orig chk_new        # 只应看到那几处字符串/指令 + 标签重编号(:cond_99 -> :cond_a0)
# 5) 替换 + 对齐 + 签名
cp sky-sldgadget_v1.apk sky-sldgadget_v2.unsigned.apk
mkdir -p stage && cp classes_new.dex stage/classes.dex
(cd stage && zip -q -X ../sky-sldgadget_v2.unsigned.apk classes.dex)
zipalign -f -p 4 sky-sldgadget_v2.unsigned.apk sky-sldgadget_v2.aligned.apk
apksigner sign --ks /home/yhjjx/yhjjx/apk/debug.keystore --ks-pass pass:android \
  --key-pass pass:android --ks-key-alias androiddebugkey \
  --out sky-sldgadget_v2.apk sky-sldgadget_v2.aligned.apk
apksigner verify sky-sldgadget_v2.apk
```

原 dex 是 `dex.035`，smali 默认 api 就产出 035，不用加 `--api`。
`libTool.so` 必须保持 **Stored**（`unzip -v` 里 `Stored` 而不是 `Defl:N`）。

签名：Android debug key（`CN=Android Debug`，SHA-256 `7bb3a7569bc4f6fa6a63e5eebba7e9b91bb30e0db41932c99339d161cbb786e8`），
`apksigner verify` = Verifies。包 `com.hitmargin.cve_2025_59489`，versionCode 2，targetSdk 26。

复现（要换 gadget 版本 / 换配置时才需要）：

```bash
cd /home/tmp/sldcarrier
cp /home/qkzx/sky-yhskip_v3.apk work.apk                    # 基础载体（原带 20672B 的 yhskip libTool.so）
zip -d work.apk 'lib/arm64-v8a/libTool.so'                  # 1) 删掉载体的原 payload
cp /home/tmp/gadget1619/frida-gadget-16.7.19-android-arm64.so lib/arm64-v8a/libTool.so
zip -0 -X work.apk lib/arm64-v8a/libTool.so lib/arm64-v8a/libTool.config.so   # 2) 不压缩加入(-0), 保证可 mmap
zipalign -f -p 4 work.apk aligned.apk                       # 3) 对齐
apksigner sign --ks /home/yhjjx/yhjjx/apk/debug.keystore \
  --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey --out sky-sldgadget_v1.apk aligned.apk   # 4) 重签
apksigner verify --print-certs sky-sldgadget_v1.apk         # 5) 验
```

安装由人来做（手机侧），两个必踩点先说：

- 换签名会 `INSTALL_FAILED_UPDATE_INCOMPATIBLE` → 先卸载旧载体再装（v1/v2 同证书，互相可直接覆盖安装）。
- 目标包/Activity 从 **v2 起已默认填好斯露德**（§4.1），打开就能点"启动游戏"；旧版要手输两栏。
- 载体 UI 里"游戏文件"下拉要选 **`libTool.so`**（那个 128 B 的 `libTool.config.so` 也在列表里，别选它）。

> `AGENTS.md` 的"APK 不碰、不重签"指的是**游戏 APK**；这里重签的是我们自己的注入载体，游戏包原封不动。

设备上相关路径：

| 用途 | 路径 |
|---|---|
| 解出的 gadget + 配置 | `/data/app/com.hitmargin.cve_2025_59489-<hash>/lib/arm64/{libTool.so,libTool.config.so}` |
| 实际跑的 hook 脚本 | `/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/hook_redirect_trust.js` |
| 脚本自己的日志 | 同目录 `gadget.log` |
| 客户端日志 | 同目录 `clientLog/Thrud<年_月_日_时_分_秒>.log` |

设备侧就绪副本（直接覆盖上面那个 `.js` 即可，注意**文件名保持 `hook_redirect_trust.js`**，因为配置里写死了这个名字）：

- `/home/tmp/sldcarrier/device-phase1/hook_redirect_trust.js` = WATCH（只观察）
- `/home/tmp/sldcarrier/device-phase2/hook_redirect_trust.js` = SKIP（跳过登录视频预载）

### 4.2 载体的提示，以及它对 gadget 的"假阴性"

点"启动游戏"后的 UI 反馈（`src2/smali/.../MainActivity*.smali` 里的字符串）：

| 时机 | 提示 | 触发条件 |
|---|---|---|
| 点按钮 | Toast `Please enter a package name` / `Please select a SO file` | 包名为空 / 没选 so |
| 点按钮 | `Error: SO file not found in APK!` / `Error: Cannot read SO file from APK!` | 选中的 so 在解出目录里不存在/读不了 |
| 点按钮 | Toast `Activity not found: <进程框的值>` → 转普通启动 `Launched normally (no pre-init)` | `setClassName` 抛异常，即 Activity 名不对 |
| 点按钮 | Toast `Launch error: …` / `Error launching: …` / `Fallback launch failed` | `startActivity` 失败 |
| 启动后 | 状态卡进入等待（logcat `Waiting for broadcast...`），**15 s** 超时（`TIMEOUT_MS=0x3a98`） | — |
| 收到广播 | **红卡**，标题 `✗ VULNERABLE`，正文 `libTool.so was successfully loaded by the target app!`，Toast `libTool.so library loaded!` | 见下 |
| 15 s 超时 | **绿卡**，标题 `启动完成`，正文 `libTool.so was NOT loaded. The app may not be vulnerable, try again to be safe.`，Toast `libTool.so library not loaded` | 见下 |

两分支的配色（`onPreinitLoaded` / `onPreinitNotLoaded` 里的 `setBackgroundColor` 常量，别被"绿=成功"的直觉带偏）：
收到广播 → 状态卡 `#E53935` 红 + 整屏背景 `#FFEBEE` 淡粉；超时 → 状态卡 `#4CAF50` 绿 + 背景 `#E8F5E9` 淡绿。
标题一律白字（`-0x1`），`✗` 只是原作者的符号，不代表失败。

**关键：没加补发之前，用 frida-gadget 当 payload 只会走"超时"那一行，那是假阴性。**
状态卡的判据是收到广播 `com.example.example.cve_2025_59489.PREINIT_LOADED`
（logcat：`✓ Received broadcast from Tool library!`）——这个广播是载体**原作者的 payload**（yhskip 那个 20672 B 的 `libTool.so`）
自己发的；frida-gadget 不发任何广播，所以它永远不会显示 `VULNERABLE`。

所以判断注入是否成功**别看状态卡**，看这两样：

1. `/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/gadget.log` 里有没有 `==== 脚本装载 mode=WATCH/SKIP ====`；
2. 假服 `data/logs/server.out` 有没有该轮次的 `skipAPI` / `getClientUpdateData`（时钟差 8 小时，§7）。

想让状态卡变准的做法已经在脚本里实现了（见下），但它本质上只是"脚本自己报个平安"，
**别把它当证据**——真正的证据还是上面那两条（`gadget.log` + 假服流量）。

#### 补发广播（`hook_gadget_all.js` 里的 `sendLoaded()`）

载体接收者的三条约束，决定了补发怎么写：

| 约束（smali 里读出来的） | 影响 |
|---|---|
| `onReceive` 只比 `intent.getAction().equals(ACTION)`，不看 extra、不看发送方 | 一个裸 `Intent(ACTION)` 就够 |
| SDK≥33 分支 `registerReceiver(r, f, 0x2)` → `RECEIVER_EXPORTED` | 跨进程（游戏 → 载体）投递得到 |
| 处理前先判 `waiting`，`TIMEOUT_MS=15000` | **必须赶在 15 秒内发出去**，超时后收到也不认 |

而 gadget 脚本装载时机在 `handleBindApplication` 附近，`ActivityThread` / Context 可能还没就绪，
所以不是一次性调用，而是 `setInterval(sendLoaded, 300)`：拿到 Context 就发、发成功即 `clearInterval`，
最多 60 次（18 s，刚好盖过载体窗口）。Context 依次试三个来源
`getSystemContext()` → `currentApplication()` → `UnityPlayer.currentActivity`，
并 `setPackage('com.hitmargin.cve_2025_59489')` 显式定向。

`gadget.log` 里会多出 `广播#<n>: sent via <来源>`（失败则 `no ActivityThread` / `no context` / `err …`，
只在状态变化时打一行）。成功时载体侧显示的是**红卡** `✗ VULNERABLE` + Toast `libTool.so library loaded!`
——"VULNERABLE" 是原作者的措辞，这里只表示"payload 被装载了"，`✗` 不代表失败。

**真机已验（10-17 深夜那轮）**：状态卡显示 `✗ VULNERABLE`、Toast `libTool.so library loaded!`，
说明补发这条路整体走得通 —— 顺带证明了 `getSystemContext`/`currentApplication` 没被 hidden API 拦死，
且 `RECEIVER_EXPORTED` 的动态接收者确实收得到跨进程广播。
具体用了哪个 Context 来源，看 `gadget.log` 里 `sent via …` 那一行。

控制流在本地打桩验过（`/home/tmp/sldcarrier/smoke_broadcast.cjs`，`node` 直接跑整个脚本，
stub 掉 `Process/Memory/Java/setInterval`）：顶层不抛、拿不到 Context 时静默重试、
第 22 次 tick（≈6.6 s）拿到 Context 即发出且只发一条、发完停表不再重复 clear。
**这只是逻辑验证，JNI 语义（`getSystemContext` 是否被 hidden API 拦、广播能否投递到载体）还得真机看。**

### 4.3 免 root 第二条：把 gadget 打进目标 APK 自己 `System.load`（不依赖载体 / 不依赖 CVE）

载体法要求目标 `libunity.so` 里留着 `xrsdk-pre-init-library` 字面量；这条不要它，**代价是必须改包重签**，
所以只用在"本来就允许改包"的目标上（研究台 / 停服游戏）。10-18 在双生视界上真机验通，
**三个成品包都能装载 gadget**（判据 = `logcat | grep sldgadget` 出 `load ok` + `gadget.log` 有脚本自报行）。

装载点与载体法的差别只在"谁去 dlopen"：

| | 载体法（§2） | 打进目标包（本节） |
|---|---|---|
| 触发者 | Unity 解析 `-xrsdk-pre-init-library` 后 `dlopen` | 我们补的 `Application.onCreate` 调 `System.load` |
| 游戏包 | 原封不动 | 改 `classes.dex` + 加 2 个 `lib/` 条目 + 重签 |
| 需要 root / MT 挂载 | 都不需要 | **也不需要**（见下） |

三个关键点，全是踩出来的：

1. **`.so` 和 config 放 APK 的 `lib/arm64-v8a/`，不要往 `/data/data` 塞**。
   往 `/data/data/<pkg>/files/` 塞要先能写它，而免 root 写它靠 MT 注入的 `MTDataFilesProvider`——
   那要求**目标进程活着**，改包后进程起不来就写不进去，**死锁**。打进 APK 则装机由系统解到
   `nativeLibraryDir`，owner/SELinux 标签都天然正确，`Android/data/<pkg>/files/`（放脚本用）也是装机即建。
2. **Deflate 就行**（和 §4.1 末那句"`libTool.so` 必须保持 Stored"相反）：那里是载体 `extractNativeLibs=false`
   要直接 mmap APK 内条目；双生视界整个包全 Deflate ⇒ 隐式 `extractNativeLibs=true`，装机解成真实文件，
   同目录的 `libTool.config.so` 才按 `<basename>.config.so` 规则被读到。
3. **方法体不要硬编码包名**，用 `getApplicationInfo().nativeLibraryDir` 拼 `/libTool.so`；
   `System.load` 包 `try/catch Throwable` + `Log.e("sldgadget", …)`，装载失败只打日志不闪退
   （否则一个 `UnsatisfiedLinkError` 就把进程炸在 `onCreate`，provider 也拉不起来，排查全靠猜）。

补丁正文（`sssj` 的 `XGApplication.onCreate`，阿里版/B 站版只差 `super` 一行）：
`/home/sssj/gadget/smali/XGApplication.变体四.smali`（阿里版）、`同目录 XGApplication.变体四.bili.smali`（B 站版，只换 `super`）。

最小改动流水线（只换 `classes.dex` + 加 2 条目，**其余条目逐字节不动**；比 `apktool b` / F.G.i 的改动面小得多）：

```bash
BP=/usr/share/java/baksmali.jar:/usr/share/java/smali.jar:/usr/share/java/smali-util.jar:/usr/share/java/dexlib2.jar:/usr/share/java/jcommander.jar:/usr/share/java/guava.jar:$(ls /usr/share/java/antlr*.jar|tr '\n' ':')
unzip -o -q 目标.apk classes.dex -d work                      # 1) 只取 dex
java -cp "$BP" org.jf.baksmali.Main d work/classes.dex -o work/smali     # 2) 全树反编
# 3) 改 work/smali/<目标类>.smali
java -cp "$BP" org.jf.smali.Main a -j 4 -o stage/classes.dex work/smali  # 4) 全树重编
cd stage && cp 目标.apk out.apk
zip -q -d out.apk 'META-INF/*'; zip -q -9 out.apk classes.dex lib/arm64-v8a/libTool.so lib/arm64-v8a/libTool.config.so
zipalign -f 4 out.apk aligned.apk                             # 5) 对齐 + V1/V2 重签
apksigner sign --ks sld.keystore --ks-pass pass:123456 --key-pass pass:123456 \
  --v1-signing-enabled true --v2-signing-enabled true --out 成品.apk aligned.apk
apksigner verify 成品.apk
```

两个坑：

- **`zip out.apk classes.dex=new.dex` 这种 `新名=旧名` 写法在这里静默不生效**，包内还是原 dex。
  必须把新产物命名成 `classes.dex` 放进 stage 目录再 `zip`。验一次才算数：
  `unzip -p 成品.apk classes.dex | md5sum` 对比你编出来的那个。
- **单文件汇编产物不能当 `classes.dex` 用**。`org.jf.smali.Main a x.smali` 出来的 dex 只含那一个类，
  而目标包是单 `classes.dex` / 5,297~7,069 个类，换进去 = 删掉其余全部类，Activity 直接找不到。
  它只能用来校验语法。

双生视界有两个同版本(1.1.36/10136)不同渠道的包，**差别是加固**，路径/判据/三包 md5 见
[`/home/sssj/gadget/README-双生视界gadget.md`](/home/sssj/gadget/README-双生视界gadget.md)（该目录 10-19 已从 `/home/tmp` 归置过去）：

| 源 APK | 包名 | 壳 |
|---|---|---|
| `sssj_1.1.36_bilibili_20211110_098184.apk` | `com.bilibili.gcg2.bili` | **腾讯 TP 壳**：`XGApplication.super = com/tencent/tpshell/TPShellApplication`、`libtprt.so`、`assets/{__tpinfo.tsa,__tpcfinfo.tsa,__tpsinfo.t.p.sin,tpginf.dat}` |
| `sssj.apk` | `com.bilibili.gcg2.aligames` | 无壳（`super = com/bsgamesdk/…/BSGameApplication`） |

> **对斯露德主线的直接冲击（待钉死）**：`sssj_bili_gadget.apk` 是"**壳清单原样留着、`classes.dex` 已改**"，
> 它也能跑 gadget。而斯露德那边实测"只改一个 smali 方法 → 黑屏 + 外部 SIGKILL"（[改包签名校验](README-改包签名校验.md)）。
> 两者同属 B 站 xgsdk + TP 家族，结论却不一致 ⇒ 斯露德的判罚者**未必是 TP 清单**，
> 得在斯露德包上重做"改 dex / 删壳文件 / 只加条目"三态对照（见该文档 §8 路线 A/D）。

---

## 5. 在 gadget 里写脚本的硬规则

主文件 [`frida/hook_gadget_all.js`](../frida/hook_gadget_all.js)（523 行 / 26,610 B）：
前 80 行是从 `hook_redirect_trust.js` **原样复制**的重定向 + trust-all（`cmp` 校验过），
后面追加 il2cpp 观察/替换块 + 落盘日志 + 载体广播（§4.2）+ 运行期改 Lua（§5.5 卡池、§5.6 战斗高度轴）。开关在文件里：

```js
var WATCH = true;                  // 只读 PreLoadVideo 入参并落盘, 不碰代码页
var SKIP  = false;                 // true = Interceptor.replace + 手动 Invoke CSPrepareCallback
var POOL  = false;                 // true = 劫 Lua 加载, 只把卡池时间窗改宽(§5.5)
var ZAXIS = false;                 // true = 同一条钩子, 把 NewLevelInstance 的 controlMode 0→1 解战斗高度(§5.6)
var POOL_LOGFLOW = false;          // true = 每次 lua*load* 调用逐个打一行(排查期用)
var EXPECT_RVA = 0xf6fb54;         // 1.0.7 / appVersion 1426: THD.VideoManager.PreLoadVideo
```

变体**只由基线生成、不许手改**（忘了重生成 = 测的是旧脚本，这个坑踩过两次）：

```bash
cd /home/sld/offline-server/frida && ./make_variants.sh
```

它逐行 `sed` 四枚旋钮生成 7 个变体，每个跑 `node --check`，然后打印大小 / md5 / 用途。当前（10-18 加完 `ZAXIS`，
基线 26,610 B / `1424dbb5b799`）：

| 变体 | 大小 | md5 前 12 | 用途 |
|---|---|---|---|
| `hook_gadget_all.js` | 26,610 B | `1424dbb5b799` | 基线：只观测登录视频 |
| `hook_gadget_all_skip.js` | 26,610 B | `402af3112863` | 跳视频，不改 Lua |
| `hook_gadget_pool.js` | 26,609 B | `4d73a06167e8` | 卡池（WATCH） |
| `hook_gadget_pool_skip.js` | 26,609 B | `54d7e6f7e9b7` | 卡池 + 跳视频 |
| `hook_gadget_zaxis.js` | 26,609 B | `3798f6e6c75c` | 高度轴（WATCH） |
| `hook_gadget_zaxis_skip.js` | 26,609 B | `bd9dc21da604` | 高度轴 + 跳视频（单独验证高度用它） |
| `hook_gadget_pool_zaxis_skip.js` | 26,608 B | `ac38fa9d8a21` | **推荐**：卡池 + 高度 + 跳视频 |

> 10-18 真机验证卡池那两轮用的是 `03887295af5b`（WATCH+POOL）与 `4c1f1259626b`（SKIP+POOL，23,116 B），
> 那是**加 `ZAXIS` 之前**的基线产物；副本留在 `device-phase3-pool/`、`device-phase4-pool-skip/` 当记录，
> 别拿现在的大小去比它们。新副本：`device-phase5-pool-zaxis-skip/`（`ac38fa9d8a21`）、
> `device-phase6-zaxis-skip/`（`bd9dc21da604`）。

改完跑 `/home/tmp/sldcarrier/smoke_pool2.cjs` 两遍（默认 + `quiet`），
**十五条全 `true`** 才算数（1–9 卡池、10–15 高度轴，见 [改Lua脚本](README-改Lua脚本.md) §5）。

### 5.1 冷启动时 il2cpp 还不存在

gadget 在 native init 前就装载脚本，此时 `Process.findModuleByName('libil2cpp.so')` 是 null。
旧脚本（`hook_skip_loginvideo.js`、`hook_force.js` 等）第一行拿到 null 就 `emit('err'); return;` —— 在 frida-server 下能跑是因为那时进程已经起来了，
换到 gadget 就**静默废掉**。现在的写法是轮询：

```js
var timer = setInterval(function () {
  tries++;
  var il2 = Process.findModuleByName('libil2cpp.so');
  if (!il2) return;
  var d = <il2cpp_domain_get>();
  if (!d || d.isNull()) { ... return; }     // 域还没建
  clearInterval(timer); boot(il2, d);
}, 500);
```

实测 `tries=1`（第一个 500 ms tick 就绪），而游戏真正调 `PreLoadVideo` 在十几秒后 → 不存在竞态，
`Interceptor.replace` 一定先于调用生效。**别在 spawn 极早期直接调 `il2cpp_*`**（会崩进程，老文档里记过）。

### 5.2 落盘日志：两个容易写错的常量

script 模式没有 `send()` 的出口，`console.log` 也没人接，只能 `open/write/close`：

```js
var O_WRONLY_CREAT_APPEND = 1089;             // 1 | 64 | 1024
var fd = fOpen(Memory.allocUtf8String(LOG_FILE), O_WRONLY_CREAT_APPEND, 0x1a4);
fWrite(fd, Memory.allocUtf8String(s), u8len(s));    // 长度必须是 UTF-8 字节数
```

- **`O_APPEND` = 1024，不是 2048**（2048 是 `O_NONBLOCK`）。之前写成 `1|64|2048 = 2113`，
  等于"没开 append"，每行都从偏移 0 覆写 → `gadget.log` 永远只剩最后一行，看着像被覆盖更新。
- **`write` 的第三个参数是字节数**，中文在 UTF-8 里 3 字节；用 `s.length`（UTF-16 code unit）
  会把含中文的行尾截掉。所以配了个 `u8len()`。
- 每行都 `open/write/close`：客户端遇到 Criware 错误可能直接退进程，任何缓冲都会跟着丢。
- 每轮装载先写一行 `==== 脚本装载 mode=WATCH/SKIP ====`，因为日志现在会跨轮次累积，不然分不出是谁写的。

### 5.3 线程

- 脚本装载的那个线程 = **Unity 主线程**（实测 `脚本装载` 与 `PreLoadVideo` 调用同一个 tid）。
- `setInterval` 回调跑在 **frida 工作线程**（`il2cpp 就绪` / replace / `Invoke` 是另一个 tid）。
- 跨线程 `il2cpp_runtime_invoke` 这次 `exc=null`、流程正常，但严格说不在主线程；
  要更稳就把 invoke 挪进主线程的 `Update` 钩子里（[`hook_force2.js`](../frida/hook_force2.js) 就是这个套路）。

### 5.4 通用禁令（继承自 `README-frida抓包.md` §5）

别挂 `Debug.LogException` / `System.Exception..ctor`，别在热 getter 的 `onLeave` 里解引用返回值，
探针保持"只读入参"——这些都能把游戏直接打挂，而 gadget 下挂了连日志都拿不到。

### 5.5 `POOL`：只把卡池时间窗改宽（运行期改 Lua，不落盘）

> 这一节是**卡池那一次的具体实现**；换一张表要怎么找、XOR 格式、外部覆盖那条路、参数布局总表、
> 验证套路，都抽到 [改Lua脚本](README-改Lua脚本.md) 里了。

思路来自 PC 纪念版的 `_sld_patcher.js`（劫 `lua*L*loadbuffer*`，在 VM 编译前换掉明文 buffer；那边同时挂了
`tolua.dll` 和 `lua54.dll` 两个模块）。安卓这边对应的就是 **`liblua54.so` + `libtolua.so` 两个都要挂**，
`buff/sz/name` 的参数布局一样（`a[1]=明文buff`、`a[2]=长度`、`a[3]=chunk 名`）；
arm64 首参是 `x0`（PC 那份写的 `rcx`，别照抄）。

**要改什么，是先算出来的，不是猜的。** 卡池表 `LotteryInstance_Xls`（chunk `6ddca182610a956ed0727462a9def6d5`，
129 个池）自己不写时间，只按 `timeId` 引用开放时间表 `CommonTime_Xls`（chunk `8a233aae5979f58131ffa10ca2122774`）：

| 情况 | 个数 | 处理 |
|---|---|---|
| 被池引用、且有真窗口的 `timeId` | **63** | 就改这 63 行的 `beginTime` / `overTime` |
| `9999` | 1 | 官方常驻模板，原值已是 `2020-10-10 10:00:00 → 2029-9-27 10:00:00`，**照抄它当目标值** |
| `0` | — | 表示"不看时间"，本来就一直开 |
| `9203` | 1 | 在 `CommonTime_Xls` 里，但**没有任何池引用**，改了无意义 |

所以 `POOL` 只碰 `CommonTime_Xls` 那一块，改法是**字节级替换**：对每个 `["<id>"]=setmetatable({` 行做两次正则替换。
没有用 PC 那套 `append` 一段 Lua 的做法，因为本机没有任何 lua 解释器（`lua`/`luac5.4` 都不存在），
语法错了会让**整张 `CommonTime_Xls` 消失**，风险不可接受。

**判定认的是 buffer 内容，不是 chunk 名、也不是注释。** 第一版（10-18 上午）用
`POOL_SIG = '---@class CommonTime_Xls : table'` 当门，真机 `WATCH+POOL` 跑一轮**一条卡池日志都没有**。
事后查明 `sig` 本来是过的（第三版日志里 `sig=true`），**问题纯粹是挂错了模块** —— 但第一版那种写法
在"没调用"和"调用了但门没过"下表现完全一样，问不出问题。现在改成：先粗筛 `beginTime=` + `setmetatable(`，
再数 `POOL_IDS` 的行键出现个数（≥5 才当它是目标表），`POOL_SIG` 只留作日志里的一个 `sig=` 提示。
**顺带把"按 chunk 名匹配"这条路否掉了**：运行时给的名字是逻辑名 `@dataTable/CommonTime`，
不是包内文件名 `toLua/Data/8a233aae…`（同理 `@UnityEngine/Vector3`、`@tolua.lua`、`LuaCoroutine.cs`）。

**要挂两个模块，不是一个。** 第二版（还是 10-18 上午）只挂 `liblua54.so` 的四个导出并记流水，真机
`SKIP+POOL` 进了大厅、`POOL 就位: 0x7988c43000 + 挂了[…]` 打了，**`load #` 仍然一条都没有** →
配置表压根不走 `liblua54.so`。看 `lib/arm64-v8a/`：APK 里同时有 `liblua54.so`（Lua 5.4，1,635,264 B）
和 `libtolua.so`（LuaJIT，852,592 B）—— PC 那份本来也是 `tolua.dll` + `lua54.dll` 两个一起挂的，
我照搬时漏了一半。`nm -D` 数出来的导出，按参数布局决定能不能改：

| 布局 | 导出 | 处理 |
|---|---|---|
| `(L, buff, sz, name[, mode])` | `luaL54_loadbufferx` / `luaL_loadbufferx` / `luaL_loadbuffer` | **可改**：换 `a[1]` + `a[2]` |
| `(L, s)` | `luaL54_loadstring` / `luaL_loadstring` | 只记流水（`sz` 打源码长度、名字截前 120 字） |
| `(L, fname, mode)` | `luaL54_loadfilex` / `luaL_loadfilex` / `luaL_loadfile` | 只记路径 |
| `(L, reader, dt, name)` | `lua54_load` / `lua_load` / `lua_loadx` | `a[1]` 是**函数指针**，绝不能当字符串读；名字在 `a[3]` |
| 未知 | `tolua_loadbuffer` | 只数次数，一个指针都不碰 |

流水是前 40 次逐个打 `load #n <mod>!<fn> sz=… name=…`，之后每 200 次报一次各导出累计次数；
`sz < 2048` 的 chunk 直接跳过，不 memcpy（63 行的表不可能这么小，省掉绝大多数拷贝）。
（地址可核：`liblua54.so` 里 `luaL54_loadbufferx` 偏移 `0xb95c`，真机日志 `0x798bda0000 + 0xb95c = 0x798bdab95c`
对得上，说明第一版挂的位置本身没错，是**挂错了模块**。`libtolua.so` 里 `luaL_loadbufferx` 偏移 `0x6d774`、
`luaL_loadbuffer` `0x6d7a0`、`tolua_loadbuffer` `0x149e8`。）

三道安全阀（`poolPatchText()` / `tryPatch()`）：

- 关键字 `["<id>"]=setmetatable({` 在 buffer 里**不唯一**、或正则没命中 → 记 `bad`；
- 只有 `hits > 0 且 bad == 0` 才写回 buffer，否则一行不动，只打日志；
- **幂等**：第二次喂进来的已是目标值 → `hits=0 / 已是目标 63` → 不改写（外部覆盖文件还留着手改版时就是这种情形）。

`POOL_KEEP[]` 挂住新分配的 buffer 防 GC，然后 `a[1]=buf; a[2]=ptr(新长度)`。

验证：`/home/tmp/sldcarrier/smoke_pool2.cjs` 用 node 打桩（stub `Process/Memory/Interceptor/Java/setInterval`，
两个模块各喂一份假导出表）加载**真脚本**（`hook_gadget_pool_zaxis.js`，两枚旋钮同开）、喂**真字节**，
十五条全过（1–9 卡池 / 10–15 高度轴，明细见 [改Lua脚本](README-改Lua脚本.md) §5）—— `liblua54.so` 与 `libtolua.so` 两条
`loadbufferx` 都能命中 63 行并真改写（`168,692 B → 168,774 B`，+82 纯粹是日期串变长）、改出来的字节与你已在
真机验证过的手改版**忽略 CRLF 后逐字节一致**（167,748 B）、`LotteryInstance_Xls` 那个 chunk 只记流水不改、
再喂一次改好的 buffer → `已是目标 63` → 不重复改写、把 `---@class` 注释抹掉照样改得动、
`file`/`load`/`raw`/`str` 四种布局一次都不 memcpy、`sz<2048` 的小 chunk 不 memcpy、流水打印开关两种模式各跑一遍
（`node smoke_pool2.cjs` = 排查模式，`node smoke_pool2.cjs quiet` = 发布模式；**改完基线先 `./make_variants.sh`**，
否则验的是旧脚本）。
（旧的第一版 harness 留在 `smoke_pool.cjs`，只对单模块有效，已作废。）

**真机已生效（10-18 03:35，`SKIP+POOL`，`/home/tmp/sldcarrier/卡池gadget.log`）**，游戏内卡池全开，
顺带把运行时的调用链照出来了：

```
load  #1  libtolua.so!tolua_loadbuffer          sz=?      name=(布局未知, 不碰指针)
load  #2  libtolua.so!luaL_loadbuffer           sz=2454    name=LuaCoroutine.cs
load  #3  libtolua.so!luaL_loadbufferx          sz=2454    name=LuaCoroutine.cs
load  #4  libtolua.so!lua_loadx                 sz=?       name=LuaCoroutine.cs
...
卡池: 行键 63 命中 63 / 已是目标 0 / 没认出 0  sig=true  name=@dataTable/CommonTime
卡池: 第 1 次改写 (168692B -> 168774B) @dataTable/CommonTime
卡池: 行键 63 命中 0  / 已是目标 63 / 没认出 0  sig=true  name=@dataTable/CommonTime
卡池: 不改写(要求 hits>0 且 bad=0)
load: 累计 3800 次  libtolua.so!tolua_loadbuffer=950 libtolua.so!luaL_loadbuffer=950 …  卡池改写 1 次
```

四个事实：

1. **全走 `libtolua.so`，`liblua54.so` 一次都没被调**（`liblua54.so` 的四个导出在这轮 3,800 次调用里计数为 0）。
2. 一个 chunk 过 **4 站**：`tolua_loadbuffer → luaL_loadbuffer → luaL_loadbufferx → lua_loadx`，同尺寸，
   所以流水里每 4 行是一批、每批同一个 chunk（`累计 3800 次` ≈ 950 个 chunk）。
3. **第一站改掉 `a[1]` 之后，后面几站看到的就是新 buffer** —— 因为 `luaL_loadbuffer` 内部把（被我们换掉的）指针
   直接转给 `luaL_loadbufferx`。日志里那两条连着的就是这个：`命中 63 真改写` 紧跟着 `已是目标 63 → 不改写`。
   幂等阀不是纸面设计，是真撞上了。
4. `已是目标 0` 说明 hook 拿到的是**包内原版**，即手机外部覆盖那份 `8a233aae…` 当时已经不生效（回落到 `assets/`）。

用之前要知道的两件事：

1. **`POOL` 只在 Lua 真起来之后才 fire。** 如果 `loginLoop.usm` 那批资源还没铺回、客户端还卡在登录界面，
   Lua VM 根本没跑到加载表，`gadget.log` 里一条卡池日志都不会有 —— 那不是补丁坏了，得用 `hook_gadget_pool_skip.js`（`SKIP+POOL`）。
2. 它和外部覆盖通道（`files/thd/toLua/Data/<hash>`，XOR 密文，`tools/lua_xor.py enc/dec`）改的是同一件事，
   区别是那边"解密→编辑→加密→推送"每一步都得手工做、还得留一堆文件，这边**运行期内存里改、落盘零改动、关掉旋钮即回退**。
   代价是每次冷启动都要重跑一遍（几十毫秒级）。

回退：把 `POOL` 改回 `false`（或用 `hook_gadget_all*.js`），或者删掉手机上的外部覆盖文件让表回到包内原版。
观察：`gadget.log` 里 `POOL 就位: liblua54.so @ …` **和** `POOL 就位: libtolua.so @ …`（外加 `两个模块都处理完了`）
→ `load #n <mod>!<fn> sz=… name=…`（流水）→ `卡池: 行键 63 命中 63 / …` → `卡池: 第 n 次改写 (旧B -> 新B) <name>`。
**读法**：`POOL 就位` 都打了但一条 `load #` 都没有 = 表根本不经这两个模块的导出（下一步得去 `libtolua.so` 里
找真正的入口，或者从 C# 侧 `lua_load` 的调用方反推）；有 `load #` 但没有 `卡池:` = 表走了别的路，
看流水里的 `name=` 是 `@toLua/Data/<hash>` 还是别的样子；有 `卡池: 行键 N` 但 `不改写` =
外部覆盖文件还是手改版（`已是目标 63`），或形状没认出来（`没认出 K>0`）。

### 5.6 `ZAXIS`：把战斗高度轴发给所有关卡（同一条钩子，另一张表）

`POOL` 那套钩子（模块、四站链、参数布局、三道安全阀、写回五行）一个字节都不用改，多加一个"目标"就行 ——
这是 [改Lua脚本](README-改Lua脚本.md) §4 那句"换一张表只要改三样"的第一个实践。

改的是 `NewLevelInstance_Xls` 每行的 `controlMode`：`0` 水平面 / `1` 自由飞行 / `2` 轨道
（`fightLua/e2394275…:10-14` 的 `Enum_MoveControlType`）。**只有 `==1` 才给升降**：控件显隐
`toLua/4f52bc70…:45-58`、输入掐断 `toLua/f9b4d055…:106-111`。链路全在
[战斗移动轴与高度解锁](README-战斗移动轴与高度解锁.md) §1/§3。

**要翻多少不是猜的**（1583 那份，明文 1,494,415 B / 2,038 行）：

| | 处数 | 处理 |
|---|---|---|
| `controlMode=` 显式写了的 | **1,615** | 里面 `0` 有 **210**（含 `local default` 那一处）→ 翻成 `1`；`1` 有 1,394 不动 |
| 没写、继承 `local default` 的 | **424** | 靠翻 default 那一处一起解锁 —— **只翻显式的行等于没翻完** |
| `controlMode=2`（轨道，关卡设计里就锁深度） | **11** | **不动**，翻了会让轨道关飞出去 |

这张表**有两个版本都在跑**，钩子两个都得能吃（本地各验过一遍）：1583 外部那份 `210 个 0 / 1,394 个 1 / 11 个 2`；
1.0.7 包内那份（812,314 B / 1,206 行 / 只有 791 处显式）`649 个 0 / 142 个 1 / 没有 2`。

认表**按内容、两个条件都要**：首行是 `local default = {id=0,stageLevel=0,` **且** 文里有 `["1000101"]=setmetatable({`
**且** 有 `controlMode=`。全 1,897 份明文里只有这一个文件含 `controlMode=`，但光看首行不够 ——
`TowerLevel_Xls`（`c2b9b7e8116f107223c444c39fe3df4d`，元素塔关卡表）首行前缀一模一样。

替换是**等长**的（一个字符 `0`→`1`），尺寸不变；值只认 `0/1/2`，出现别的形状就计入 `bad` → 整轮不写回。

```
高度轴: controlMode= 共 1615 处 → 命中 210 / 本来就是 1 的 1394 / 轨道 2 不动 11 / 没认出 0 name=@dataTable/NewLevelInstance
高度轴: 第 4 次改写 (1494415B -> 1494415B) @dataTable/NewLevelInstance
```

第二次喂进来（四站链的后三站）会是 `命中 0 / 本来就是 1 的 1604` → `不改写`，幂等。
改写计数器 `poolDone` 是**两个目标合计**的，所以高度轴那条可能报"第 4 次改写"。

**这条解锁的是升降（Y）**。真·滚转（绕自身前进轴的 Z）不是开关能解的，见
[战斗移动轴与高度解锁](README-战斗移动轴与高度解锁.md) §2；飞得更高更快要另外动 `StateParameter_Xls`（同文件 §5），
本钩子没做。

回退：`ZAXIS` 改回 `false`（或换 `hook_gadget_pool*.js`）。观察与读法同 §5.5，只是行首是 `高度轴:`。
**状态：真机已生效**（10-18 用 `device-phase5-pool-zaxis-skip/` = `SKIP+POOL+ZAXIS`，游戏内可升降 ✅）。
这同时补上 §5.5 没答的一个问题：**进战斗才用的表也经这条钩子改得到**。
（本轮没留 `gadget.log`，所以 `命中` 的确切数字、这张表是登录时还是进战斗时加载的，都还没写进日志证据。）

---

## 6. 实测记录：撤掉 `loginLoop.usm`，看能不能抓到"视频加载失败"

结论：**报错抓到了，而且证明"卡在登录"的门禁是 `CSPrepareCallback`，不是网络。**
（手机时钟 23:2x/23:3x = 本机 UTC 15:2x/15:3x，见 §7）

| 模式 | gadget.log | 客户端日志 | 假服侧 |
|---|---|---|---|
| WATCH（只 attach 观察） | `mode=WATCH` → `rva=0xf6fb54 (文档记 0xf6fb54)` → `已挂 观测` → `PreLoadVideo path=media/video/loginLoop loop=1 cb=yes id=1` | `E07020601M File Open Error - media/video/loginLoop.usm` ×50，`OnVideoPrepareFinish` **0 次** | 只有 `skipAPI` + `getClientUpdateData`（`无热更: resVersion=1583`），**之后彻底断流** → 卡在登录界面 |
| SKIP（replace + 手动 Invoke） | 同上 + `PreLoadVideo(NOOP) ... cb=yes` → `CSPrepareCallback.Invoke 已触发 exc=null` | 同样报 `E07020601M` ×192，但 `OnVideoPrepareFinish` 2 次（在 `VideoManager:Init` 后 70 ms） | 13 秒后走完 `clientLogLevel → cdnData → clientNotice → OpenStatus → serverUrlData → clientAnnounce`，另有 20+ 个 gs 包（`10004 SetPrologue`、`10100 ClientDataOverLogin`、`9300009`、`9400004`…）→ **进大厅** |

补充三点：

- **`Interceptor.replace` 挡不住 CRIWARE 刷屏**：replace 掉的只是"预载/prepare"那一次调用；登录界面真正要放视频时走
  `CriWare.CriMonoBehaviourManager:Update() → CriMana.Player:UpdateNativePlayer()`，它自己去 open 那个 `.usm`，
  每帧失败一次并抛一个空的 `System.Exception`。不致命（大厅都进了），要彻底安静得去挂 CriMana 的 open，不值得。
- **`EXPECT_RVA` 守卫有意义但当前没触发**：实测 `0xf6fb54` 与 IL2CPP dump 里记的一致
  （`System.Void PreLoadVideo(System.String, System.Boolean, THD.VideoManager.CSPrepareCallback, System.Int32)`），
  即"版本没变"，`res/backup/offline-old/dump/il2cpp_runtime_dump.cs` 的 RVA 仍然可用。
  脚本在 `SKIP` 模式下若 rva 不符会**拒绝 replace**，只报错。
- **`VersionCheckFinish` 出现 11 次不是递归**，只是每条日志的堆栈里都带这一帧（`CoInit` 链），两轮都是 11。

启动阶段的完整顺序（可当基线，以后判断"卡在哪一步"就照它比）：

```
skipAPI → getClientUpdateData → UIHotUpdate.SendResVersionUpdateRequest → VersionCheckFinish
  → 读外部 thd/res/Combine{AbIndex,AssetBundleDepData,ShaderFindData}.json → ABLoadManager.Init (abLoadManager init end)
  → THD.AudioManager.Init → THD.VideoManager.Init(LuaFunction)
  → UIHotUpdate.PrepareVideo → THD.VideoManager.PreLoadVideo("media/video/loginLoop")
  → ====OnVideoPrepareFinish====          ← 卡点就在这之前
  → LuaFramework.StartLuaLoader(LuaBundleTableCount 4440) → LuaState start → ==== StartLua Finish ====
  → CloseGameStart / CloseHotUpdateUI / ShowLoginUI → LoginMgr.InitData → SDK 链(clientLogLevel…)
  → POST /AppInterface (gs)
```

---

## 7. 时钟陷阱（会得出完全错误的结论）

本机 **UTC**，手机 **UTC+8**，手机还快约 1 秒。手机 `23:22:50` = 本机 `15:22:50`。
用客户端日志（手机时间）对假服 `data/logs/server.out`（本机时间）时**先换算**，
否则会把"其实正常的一轮"误判成"重定向没生效"（本项目 10-17 真就这么错过一次）。

---

## 8. 现状与待办

- 手机 frida-server（`27049`）自 10-17 13:25 起不可用，`adb devices` 空，yhjjx 的 `fsprobe.py` 因此
  报 `ServerNotRunningError`；目前设备侧只能靠 gadget 落盘 + 人工导文件。
- **10-18 用 §4.3 的最小改动流水线打了三个双生视界包，真机三个都成功装载 gadget**（`load ok` + 脚本自报行），
  所以此前"两种变体都闪退"是本地 MT 改包的问题，不是装载方式的问题。这条通道**不依赖载体、不依赖
  `xrsdk-pre-init-library`、不依赖 MT 的 `MTDataFilesProvider`、也不需要 root**。
  待钉死：`sssj_bili_gadget.apk` 是"壳清单原样 + `classes.dex` 已改"也能跑，与斯露德实测
  "只改一个 smali 方法 → 黑屏 + 外部 SIGKILL"（[改包签名校验](README-改包签名校验.md)）不一致
  ⇒ 判罚者未必是 TP 清单，得在斯露德自己包上做三态对照（改 dex / 删壳文件 / 只加条目），见该文档 §8。
- **10-20：本地化整条路换到 gadget 脚本集**（零落盘，不推 `files/thd/`、不改台账、不碰 APK）—— 见 [`../../frida-gadget/README.md`](../../frida-gadget/README.md)。机制就是 §5.5/§5.6 那套换 buffer，内容换成 PC 纪念版的规则引擎（`NetWorkManager` 追加假 GS + `Main_IndieGame` 两条 sub + `InitGame→indie`）。
  顺带一条与载体有关的变更：补发 `PREINIT_LOADED` 那段（§4.2 的"假阴性"解法）原先只住在 `hook_gadget_all.js` 的**追加段之前**，所以只有走 `make_variants.sh` 生成的那些脚本才会翻红卡；`frida-gadget/sld_patcher.js` 把它归成了自己的旋钮 `MK_LOADED`（默认开），`--with-tables` 时会与拼接段各发一发（载体只认第一发）。
- 待办：① 把 `CSPrepareCallback.Invoke` 挪回主线程；② listen 模式实测（配合隧道就能复用 `run_hook.py`）；
  ③ 决定 `SKIP` 版是否长期常驻（它改变游戏行为，资源包铺回去后应当切回 `WATCH` 或纯 `hook_redirect_trust.js`）；
  ④ 测完把 `frpc` 关掉（9443 挂在公网 443 上正被扫描）；
  ⑤ §4.2 的补发广播真机已生效（状态卡出现 `✗ VULNERABLE` + Toast `loaded`）；还差从 `gadget.log` 的
  `广播#n: sent via …` 确认用的哪个 Context 来源、第几秒发出去的；
  ⑥ §5.5 的 `POOL`（只动卡池）**真机已生效**（10-18 03:35 `SKIP+POOL`：`卡池: 行键 63 命中 63 … 第 1 次改写
  (168692B -> 168774B) @dataTable/CommonTime`，游戏内卡池全开）。之前两轮的失败原因各不相同，都已写进 §5.5
  （第一轮 `POOL_SIG` 那种写法问不出问题、第二轮挂错模块只挂了 `liblua54.so`）。
  定案后把逐条流水默认关掉（`POOL_LOGFLOW = false`，每 2000 次调用一行汇总），排查时再开。
  ⑦ §5.6 的 `ZAXIS`（战斗高度轴全关卡）**真机已生效**（10-18 用 `device-phase5-pool-zaxis-skip/`，游戏内可升降）。
  设备上如果还留着 route A 那份手改的 `75320b33…` 外部文件，日志会是 `命中 202 / 本来就是 1 的 1402`
  而不是 `命中 210`；想看清钩子本身就把那个文件删掉让表回到原版（见 [改Lua脚本](README-改Lua脚本.md) §7 第 7 条）。
  设备副本（文件名必须仍叫 `hook_redirect_trust.js`，`libTool.config.so` 写死了这个路径）：
  `device-phase5-pool-zaxis-skip/`（`SKIP+POOL+ZAXIS`，推荐，`ac38fa9d8a21`）、
  `device-phase6-zaxis-skip/`（`SKIP+ZAXIS`，只想验高度时用，`bd9dc21da604`）、
  `device-phase4-pool-skip/`（`SKIP+POOL`，卡池那轮真机用过的）、`device-phase3-pool/`（`WATCH+POOL`）、
  `device-phase1/2`（13,664 B，无 Lua 改写）。全量 md5 见 `./frida/make_variants.sh` 的输出，
  **手机上现在是 `device-phase5-pool-zaxis-skip/` = `ac38fa9d8a21`（26,608 B，卡池 + 高度 + 跳视频，quiet）** ——
  10-18 两轮真机确认的就是它（卡池全开、战斗可升降）。
  遗留：`WATCH` 版仍会卡在登录界面（§6），所以带 `POOL` 的一律配 `SKIP`；
  `loginLoop.usm` 那批资源铺回去之后应当切回不带 `SKIP` 的版本。
