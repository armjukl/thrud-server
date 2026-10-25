> ⚠️ **已归档（老文档）** · 最后更新：2026-10-10 · 当前方案见 [`docs/README.md`](../README.md)
>
> 本文写作时的口径可能已过时（路径、结论、结论所依赖的文件位置都变了），仅作历史记录。

# 斯露德（Thrud）离线可玩 · 从立项到今天的全过程

跨度：**2026-09-21 → 2026-10-06**（约 16 天，实际动手约 6 天）。
本文是"总账"。逐日细节见同目录 `CHANGELOG-2026-10-05.md`；静态分析见 `README-静态分析-1.0.6.md`；真机攻坚见 `PROGRESS-frida.md`。

每条结论后面都跟了证据路径或数字；凡是推断而非实测的，写明"（推断）"。

---

## 0. 基本盘

| 项目 | 内容 |
|---|---|
| 目标 | 让**已停服**的《斯露德》在真机上跑到主城并能点界面，服务端全部伪造 |
| 样本 | `/home/qkzx/sld_1.0.6.1338_20230926_061320_5fb48.apk` — 1,885,239,979 B / 36,827 条目（`unzip -Z1` 实测），构建 2023-09-26，`resVersion=1336 / buildVersion=1338` |
| 机上包 | 1.0.7 / version_code **1426**（Bilibili 渠道） |
| 包名 | `com.wth.thrud.bilibili` |
| 引擎 | Unity **2021.3.18f1** + IL2CPP（metadata **v29**），arm64-v8a |
| 脚本 | 双 VM：`libtolua.so`（ToLua，逻辑在 `toLua/`）+ `liblua54.so`（Lua 5.4，战斗在 `fightLua/`）；消息用 C 扩展 `pb`（protobuf） |
| 音频 | Wwise（AK），`.bnk` / `.wem` |
| 过场 | CRI Ware（`.usm`） |
| 现在的设备 | vivo V1911A / Android 10 / Adreno 616 / 6 GB / 2408x1080，**无 root、无 Frida** |
| 攻坚用的旧设备 | Adreno 509 / **3 GB**，有 root + frida-server（10-04 全程在这台上） |

### 0.1 最后定下来的一条铁律

> **APK 不碰、不重签。** 改动只允许落在三个面：**外部覆盖目录的磁盘文件**、**假服务端**、**hosts 重定向**。

这不是设计偏好，是被一次事故钉死的：进主城后约 45 s 静默退出，根因就是重签名（见 §4.4）。

**10-07 补：这条铁律的解除条件已经查清并写进 §13** —— `apk_sign` 是客户端自算明文上报的普通参数，钉死那一行 smali 后重签即可通过；Lua chunk 加密也破了（§7.6）。但 §13 那套路**尚未实机验证**，且要求卸载原版（清空 `files/` 下全部补丁 + 重下资源）。在那之前，仍按本条执行。

### 0.2 当前拓扑

```
手机 --hosts--> 23.147.232.29:443 / 80
                    |  frps :7000（token yhjjx-frp-9f2k7）
                    v
                frpc（pid 689913，frpc-sld.toml **只有两条代理**：9443→远端 443、9080→远端 80）
                    v
                node 假服（pid 770585，监听 9443）
                    stdout  /home/qkzx/sld/probe-tmp/server.out
                    流水    offline-server/data/logs/http-requests.jsonl（2,122,920 B）
                    抓包    offline-server/data/capture/（9,148 个文件）

发补丁：python3 -m http.server 8081 --directory /home/qkzx/offline/sld/dl（原 pid 791315，**10-06 17:35 已关**）
        手机浏览器打开 http://23.147.232.29:8081/<文件名>（**当前拒连**，起回 8081 才可用；详见 12.5）
```

**手机时钟 = 服务器时钟 + 8 h**（客户端日志名用手机时间：`00_55` 即服务器 `16:55`）。

两条通道性质（别重新推一遍）：**业务只有 HTTPS 一条路**（UDP/KCP 从未收到过一个包，见 §3.5 与 §8 死路表），**客户端不校验 TLS 证书**（不装 CA、CN/SAN/有效期随便写，见 §14）。

---

## 1. 阶段一（9-21 ~ 9-23）：静态分析，把 APK 榨干

工作目录 `/home/qkzx/sld/sld/`，**APK 全程只读、没往游戏目录写过任何东西**。主要产出集中在 9-21 上午到傍晚（`offline/sld/` 下 `lists/ manifests/ metadata/ samples/ tools/` 的 mtime 全是 9-21 10:00，`offline-server/README.md` 与 `test/selftest.mjs` 是 10:00~10:35，`reports/sld-dump-failure.md` 是 17:16）。

### 1.1 已经拿下的部分

| 结论 | 证据强度 |
|---|---|
| 资源层**完全明文可用**：`res/data` 下 **27,877 个 `.ab` 全部以 `UnityFS` 开头**，UnityPy 可解析；随机抽 250 个解析 0 失败 | 已确证 |
| `assets/kvl.kvl`（3,583,235 B）明文，**35,679 条** `路径 : md5 : System.String`，字段 2 是**存储字节的 md5**（抽检 300/300 命中） | 已确证 |
| `abIndex.json` 4,741 条逻辑名→哈希名；其中 **581 个逻辑名在 APK 里没有对应文件**（属 CDN 下载资源）；反向有 23,718 个 `res/data` 文件不在 abIndex 里 | 已确证 |
| 网络传输用 **Mirror kcp2k**（KCP over UDP，24 B 小端段头） | 已确证 |
| 业务消息 = **protobuf + Lua 驱动**（`liblua54.so` 导出 `luaopen_pb*`，另有 `ProtocolParserLua` / `RegToCoreMsgId` / `CMsgHeaders` / `_InitMsgHeaderRule`） | 组件已确证 |
| APK 里唯一加密的类别 = **4,670 个 Lua 数据文件**（`toLua/` 3,198 + `fightLua/` 1,472） | 已确证 |
| 真实服务器 `thrud-dev.accessgames.com:8005`（dev 残留） | 已确证（字符串） |

### 1.2 攻下的第一道锁：`global-metadata.dat` 的分页 XOR

7,625,500 B，magic 是假的（`0x12724394`，应为 `0xFAB11BAF`）。规律：

```
XOR 值   = 0x66
页大小   = 0x1000
加密判定 = (绝对偏移 / 0x1000) % 16 ∈ {1, 2, 3, 4}     # 每 16 页轮转 4 页
```

解密脚本 `offline-server/tools/meta_decrypt.py` → `metadata/m_dec.dat`（版本 29，16 个区间偏移/大小完全自洽）。
工具：`tools/meta_keyhunt.py`（10:35，反推这组参数用的）。

### 1.3 没攻下的锁，和两条被证伪的判断

`/home/qkzx/offline/reports/sld-dump-failure.md`（9-21 17:16，119 行）把"dump 不出 dump.cs"钉成三道门：

1. **门 1 已解**（上面的分页 XOR）。
2. **门 2**：`Il2CppDumper` 在 `Il2Cpp.Init:232` 抛 `OverflowException`。
   并且纠正了两条旧结论：**`ERROR: This file may be protected.` 是假警报**（判据只是"存在 DT_INIT"，任何 so 都命中）；`.init_proc` 的 WARNING 同理不代表壳。
3. **门 3**：`libil2cpp.so` 的 `.rodata` **也有一层分页变换**。量出的规律：被改动的页全部满足 `页号 % 0x10000 ∈ {0x7000,0x8000,0x9000,0xa000}`；137 页 `key=0x76`，用已知明文 `Assembly-CSharp.dll` / `UnityEngine.Burst.dll` 等验证成立。
   **但 `module[0].rgctxRanges@0x215a7f4` 那批页无法用单字节解释**（256 个 key 全试 + 20 组已知明文对齐都不行）→ 要么第二层密钥，要么被壳**主动抹表**（运行时 il2cpp 不需要 RGCTX，只有 dumper 需要，抹它正好防 dump）。

顺带踩实的一条方法论：**不能靠"分数最大化"盲猜 key**——第一次批量解 823 个结构位所在页时，给干净页挑了 0x60/0x6c/0x7c 这类假 key，把 18 个 module 指针解成 `0x6464…64`。必须只在"存在 ≥32 字节非 0/非 FF 常量游程"的页上动手。

同年 9-21 记下的两条**后来被证伪**的判断（重要，别照着它规划工作）：

- ❌ "KCP 之上还有 **AES + RSA 认证信道**，这是最大阻碍。"
  → 10-04 实测：**98 个 `net-*` 抓包目录全空，一个 UDP 包都没走**。真正的业务通道是 **HTTPS `POST /AppInterface`**（按 IP 直连），根本没有认证握手这一层。`AESKeySize/Challenge/ProcessAuthentication` 那组字段是 Mirror 社区加密组件的**代码残留**，本包没启用。
- ❌ "逻辑在密文 Lua 里，必须先破 toLua/fightLua 的 chunk 加密。"
  → 10-04 用 Frida 在 VM 侧直接捞：98 个 `lua-*` 抓取目录里只有 `lua-1004-083834` 非空，**889 个明文 Lua 一次到手**。静态盲推（RC4、短周期 XOR、zlib@offset、UnityFS crib 滑窗…共 8 类假设全部否证）那几天其实是低收益的。

**判断：静态阶段真正的产出是"资源层可用 + metadata 可解 + 协议组件定位"，而"必须先破密"的两个结论都是弯路。**

### 1.4 9-21 就建好的假服雏形

`offline-server/src/`：`config.js` `log.js` `kcp.js`（KCP 段编解码 + 最小可靠会话）`framing.js`（规则驱动框帧，读 `data/header-rule.json`，没有就 6 候选试探）`gateway.js` `http.js` `index.js`；`test/selftest.mjs` 11 项（含 2 个端到端 UDP 用例）。

> 注：今天再跑 `node test/selftest.mjs` 会在端到端用例上 `EADDRINUSE 127.0.0.1:19005`——因为活着的假服占着 KCP 口。**这不是回归，是端口冲突**；要跑先停 `src/index.js`。

这套东西到 10-05 仍在用的只有 `log.js`/`config.js`；`framing/gateway/kcp` 已被 `gs.js`（HTTPS 路线）取代。

---

## 2. 阶段二（9-24 ~ 10-03）：sld 停摆十天

证据（很硬）：对当时的三处 sld 工作区 —— `offline/sld`（现为 `/home/qkzx/offline/sld`）、`/home/tmp/sld`（现为 `/home/qkzx/sld/sld`）、`/home/tmp/sld_probe`（现为 `/home/qkzx/sld/probe-hometmp`）—— 取 `9-24 → 10-04` 之间的 mtime，**返回空**。sld 相关文件最早跳到 **10-04 03:44**（`offline-server/certs/` 整个目录）。
（路径对照：10-06 那次搬迁把 `/tmp` 与 `/home/tmp` 下的 sld 杂物统一挪进了 `/home/qkzx/sld/`，详见第 12 节。）

那十天不是躺平，是**并行在别的项目上**，务必别混进 sld 时间线（这是本次复盘纠正掉的一条错误记忆）：

| 时间 | 东西 | 属于哪个项目 |
|---|---|---|
| 9-22 09:55 | `/home/qkzx/base.apk`（1,817,995,640 B） | 非 sld |
| 9-22 18:07 | `reports/yhjjx-so-redirect.md` | 银河境界线（yhjjx） |
| 9-23 16:32 | `/home/qkzx/ljjc2.apk`（1,003,127,929 B） | 另一个项目 |
| 9-23 20:29 | `reports/il2cpp-proto-from-metadata.md` | 通用方法（后来 10-05 在 sld 用上） |
| 9-24 17:28 | `/home/qkzx/jmqs.apk`（65,852,302 B） | jmqs |
| 9-24 18:22 | `reports/jmqs-fake-server.md` | jmqs |
| 9-25 15:17~15:59 | `sky-yhskip_v1..v3.apk` | 明日启动 |

（`/root/.codex` / `/root/.commandcode` 会话检索确认：`67fbbf42`=ljjc2，`9c83f5ea/16f4b325/764985cb/f28e50ec/6c1fad20/353c29cc`=银河境界线，`-home---/dc15e920`=安卓病毒样本分析。）

停摆的原因（推断）：静态阶段给出的两大前提（AES/RSA 信道 + 必须破 Lua）都把路指向"需要 root 设备 + Frida"，而那台带 frida-server 的手机当时被别的项目占着。真正重启是靠**换思路**：10-04 起先用运行时手段验证"信道"和"密文"这两件事到底成不成立。

---

## 3. 阶段三（10-04）：真机 + Frida/MITM —— 从"一启动就闪退"到首次进大厅

会话来源：Codex `01a1054e`（rollout 8.5 MB / 6,492 行，61 条 prompt，10-04 05:06 → 10-05 06:16）+ CommandCode `5d8174c8`（3 MB / 62 条消息，10-04 03:04 → 10-05 13:15）。
**注意：整个"运行时攻坚"只有 10-04 和 10-05 两天**，之前记成"9-24→9-25"是错的。

### 3.1 先确认没有真服可以连

| 主机 | 结果 |
|---|---|
| `armorgirls-ts-all-gs.bilibiligame.net` | NXDOMAIN（metadata 里的线上 GS） |
| `l1/le1/l2-prod-bili-api-thrud.bilibiligame.net` | NXDOMAIN（运行时解析出的 API） |
| `thrud-dev.accessgames.com:8005` | A 记录是私网 `10.22.151.127`，不可达 |
| `*.accessgames.com` | 泛解析到官网 `42.194.188.227` |

→ 只能全伪造。03:44 自建 CA + server 证书（`offline-server/certs/`，SAN 覆盖 `*.bilibiligame.net` / `*.accessgames.com` 等 8 项，`C=CN,O=SLD Local Test CA`）。

MITM 设施三件套：
1. `hook_redirect_trust.js`：在 **`getaddrinfo` 入口改入参**（域名 NXDOMAIN 时改解析结果无效，必须改参数）把死域名换成隧道 IP `23.147.232.29`；同时 hook Java `SSLContext.init` / `HostnameVerifier` 装 trust-all。（**后半条 10-07 作废**：免 root 路线没挂任何 hook 也连上了，客户端自己就放水，见 §14）
2. `frpc-sld.toml`（03:45）：9443→远端 443、9080→远端 80。验证 `https://23.147.232.29/` 返回我们的证书。
3. `http.js` 支持 `SLD_TLS=1`；所有请求落 `data/logs/http-requests.jsonl`。

### 3.2 "一启动就闪退"是我们的探针自己打挂的

这是当天最有价值的一条定性（PROGRESS-frida §8.1）：

- `hook_logexc.js` 在 `Debug.LogException/LogError` 的 onEnter 里 `il2cpp_runtime_invoke` 调 `get_Message/get_StackTrace` → **重入运行时 → 原生崩溃**；
- 在 `JsonData.get_Item`（热 getter）的 **onLeave 解引用返回值** → 异常时返回空指针 → 崩；
- `hookNamed(...)` 忘传回调，每次进入抛 `TypeError` → 不稳定。

换成"只读入参、不碰返回值"的干净探针（`/home/qkzx/sld/probe-hometmp/hook_probe.js`）后，游戏全程存活到更新流程走完。

另外两条硬约束：**不要用 `pgrep/pkill -f`**（会匹配到调用者自己，杀 hook 用 pidfile）；**spawn 早期（il2cpp 未 init，domain=null）调 `il2cpp_*` 直接崩进程**，必须等 `il2cpp_init` 返回后再挂 → 于是有 `run_hook.py` 的两段式注入（`SLD_AGENTS` 预初始化装 redirect/trust，`SLD_AGENTS2` 延迟 ≥15 s 装业务 hook；冷启动时 `libil2cpp.so` 可能还没加载完）。

### 3.3 运行时 IL2CPP dump：绕过 so 加固

`libil2cpp.so` **导出了 235 个完整 il2cpp 运行时 API** → 静态 dump 进不去，就在内存里遍历。
`il2cpp_dump.js` + `run_dump.py` → `dump/il2cpp_runtime_dump.cs`（**2,147,552 B，10-04 04:49，2051 类 / 21529 方法 / 8710 字段**）。
静态阶段那道"门 3"到此不再重要——后面所有 RVA（§7.3）都是从这份 dump 里取的。

### 3.4 启动链路上三道卡点，逐个填平

| 卡点 | 现象 | 解法 |
|---|---|---|
| `skipAPI` 回调不推进 | `UIHotUpdate.<SendApiSkipRequest>b__87_0` 的 onLeave 从不触发；`Debug.LogException` 抓到 `LitJson.JsonException: Can't assign value '0' (Int32) to List<String>` | 用 **LitJson 泛型 `ToObject<T>`**，响应 4 个 key 必须是标量/数组 |
| `getClientUpdateData` | 缺任一 key → `KeyNotFoundException`；给数组 → `FormatException: "JsonData array"` | `data/getclientupdatedata.json` = `appVersion"1426" / resVersion"1426" / forceUpdateUrl"" / hotUpdateUrls[]`（**读取顺序即此顺序**），之后顺利 `VersionCheckFinish()` |
| 缺 `CombineAbIndex.json` / `CombineAssetBundleDepData.json` | `ABLoadManager.CoInit` 用 `UnityWebRequest.Get` 读 **jar 内不存在的条目时该 UWR 永不完成** → 协程卡在 `state==1`，UI 永远"信息同步中" | `hook_combine_redirect.js` 把 URL 改写成同目录的 `abIndex.json` / `AssetBundleDepData.json`（schema 相同，从 dump 里的 `AllABResInfo{mAbList:[AbResData{mOriginName,mAbName}]}` / `AssetBundleDepData{mItemList:[{mName,mDeps}]}` 推出）；改完 `MoveNext` 走到 0→1→2→3 |
| 缺 `media/video/loginLoop.usm` | `[CRIWARE] Error:E07020601M: File Open Error` 反复刷 → `Criware Error!` → 进程退出 | `hook_skip_loginvideo.js`：`Interceptor.replace` 把 `VideoManager.PreLoadVideo`（RVA `0xf6fb54`）整个换成空实现，只对拿到的 `CSPrepareCallback` 手动 `il2cpp_runtime_invoke` 触发 `Invoke`（"调原函数再在 onLeave 补回调"不行，CRI 仍刷屏并最终崩） |

日志实测序列（PROGRESS-frida §9.3）：

```
>>>SendApiSkipRequest>>> success → >>>SendResVersionUpdateRequest>>> success
读取 .../CombineAbIndex.json / CombineAssetBundleDepData.json / CombineShaderFindData.json
abLoadManager init end → ====OnVideoPrepareFinish====
LuaABLoader.StartLuaLoader（3,397 个 assets/toLua/Data/<hash>）
LuaState start / ver20199 / load table.lua 读取所有表格结束
Main:10 执行main.lua的main函数 → SDK/SDKMgr:66 Init 当前为Bilibili平台
```

**10-04 07:38 —— 首次进大厅。**

### 3.5 两条"其实不存在"的发现，直接改了后续路线

1. **`lua-*` 98 个抓取目录只有 1 个非空**（`lua-1004-083834`，**889 个明文 Lua**）；**`net-*` 98 个目录全空**。
   → KCP/AES-RSA 那条路根本没被客户端走过；业务全在 **HTTPS `POST /AppInterface`**（请求 Host 就是裸 IP `23.147.232.29`，`serverUrlData` 回 `https://23.147.232.29:443`，客户端按 IP 直连）。
   → 假服务端从"KCP 网关"整个改成"HTTP 应答机"，`pb.js`（10-04 16:13）+ `gs.js` 由此而生。
2. **Lua 是明文可读的**（VM 侧不加密，加密只发生在包存储层）→ 4,670 个密文 chunk 的破解价值从"必须"降为"不需要"。§4.4 的定案、§4.5 的三条 trycatch 全都靠这 889 个明文文件。

### 3.6 GS 协议还原（帧格式，全部实测）

请求（`gs.js:485-513` 注释）：

```
[u32BE totalLen][u32 crc][u32 ?=0][u32BE msgId]
+ 5 个 length-prefixed 串（uid / platform / pfUid / channel / token）
+ [u32 packetUUid]           ← 客户端唯一 id，回包必须原样带回
+ [u32 ?=0][u8 ?=0][u32 dataLen]
+ [protobuf data]
+ [u32 appendLen][appendData]
```

定位 `data` 起点不能写死偏移（5 个串之后的定长头长度会变）：尾部必是 `[u32 appendLen][append]`，其前是 `[u32 dataLen][data]`，扫 `s` 使 `u32BE@(s-4) === (len-4-appendLen) - s` 即闭合。**实测 327 条抓包：299 条唯一命中，24 条双命中**（"空 body"与"5 个 0 字节"之争），用"protobuf 首字节不能为 0（field 0 非法）"消歧。另对 30 条抓包验证过头部布局。

回包（来自 `WebCommunicationHelper.HandleResult` 的运行时行为）：

```
[u8 压缩标志（0=不压缩；>=1=剩余是 raw deflate）]
[i32 errorCode]
[i32 pushLen][ReturnPackagePush]
[i32 msgId][i32 bodyLen][body]      → completedList
[i32 moreLen]（0=结束）
```

**最关键的一条规则：不认识的 msgId 也必须回一个"带头的合法成帧包"。** 客户端 Lua 派发器按 header 找回调，收不到就永远等 —— 签到面板关闭按钮卡死（`SetCanCloseUI` 不执行）就是这么来的（`gs.js:406-407`、`:553-554`）。

进主城前有一段**串行拉取**（`PlayerMsg.MsgListBeforeEnterMainCity`）：客户端收到一个回包才发下一个，任何一个没回包就卡加载界面 —— `gs.js:415-447` 那批 handler 的存在理由。

---

## 4. 阶段四（10-05）：协议补全 + PostProcessing + 免 root + 闪退定案

这一天的逐条细节在 `CHANGELOG-2026-10-05.md`（297 行），这里只串主线。

### 4.1 上午：协议表与资源补全

- **05:36** 用户报"点了，可以看到人物模型了！！"——PC 纪念版资源转换的价值第一次被确认。
- **07:42** `proto/` 落 **44 个 `.proto` / 1,677 个 message / 48 个 enum**（`CmdDefine.proto` 68 KB、640 条命令号），外加检索脚本 `proto/pfind.py`。这是 `gs.js` 每个 handler 注释里字段号的来源。
- PC 纪念版（`/home/qkzx/sld/sld_full/斯露德纪念版/`，原档 `斯露德纪念版.7z` 7,025,859,470 B）里 **Windows=19 / Android=13** 的差异包：先判"不补全"，后来改走 **UnityPy 换 target_platform** 的转换路线。
  `convert_all.py`：`sf.target_platform = BuildTarget.Android` + `sf._m_target_platform` 双写，再 `env.file.save(packer="lz4")`；解不动就原样拷。
  `/home/qkzx/sld/probe-tmp/vmstage` = `/home/qkzx/sld/probe-tmp/conv_android` = **123 个**；`missing.txt` 15 行；`vmstage_list.txt` 123 行。
  推送用 `bulk_push.py`（Frida 分块 base64 写文件，262,144 B/块，写完校验字节数）。
- **14:54~14:57** 定出 1.0.7 的缺失包总账：`/home/qkzx/sld/probe-tmp/missing107.txt` **24,585 行**（缺失引用）、`missing107.json` **618 条** `[hash, 逻辑名, 是否已在]`（例：`00c668d9… UIPatrolPrepare`）。
  ✅ 原来待办 #2 跑不通的具体原因：`miss13/convert.py:74` 读 `/home/qkzx/sld/probe-hometmp/missing107.json`，而文件在 **`/home/qkzx/sld/probe-tmp/`**（`/home/tmp` 与 `/tmp` 是**两个不同目录**，本会话里两边都有 sld_probe）。10-06 搬迁时路径已合并，`convert.py` 已改指向 `probe-tmp/missing107.json` 并实跑验证（分片 `0 500` → 唯一 id 618、ok=2）。

### 4.2 PostProcessing：今天的主工程（已彻底修复）

**前提**：1.0.7 的 Android 包**一个 PP kernel 都没有**。`apk107_pp.txt`（16:12）扫全 APK shader 索引：

```
PostProcessLayer 12 处引用   ColorGrading 32 处引用
KGenLut3D / AcesTonemap / PostProcessResources  0 命中
```

**错误签名**（修复前的日志 `Thrud2026_10_05_23_42_24.log`，5,594 行 / 623 条 `:Error`）：

| 签名 | 修复前 | 修复后（`10_06_00_55_17`，742 行 / 12 条） |
|---|---|---|
| `Kernel 'KGenLut3D_AcesTonemap' not found` | **582** | **0** |
| `Invalid pass number (1) for Graphics.Blit (Material "(Unknown material)" with 1 passes)` | **291** | **0** |
| `Desired shader compiler platform 18 is not available in shader blob` | 28 | 0 |
| `AudioError: SoundBank_Load`（缺 bnk，非致命） | 7 | 7 |
| Lua `trycatch`（假服缺字段） | 9 行含 `trycatch` | 9 行含 `trycatch`（两边都只有 **3 条不同错误**，其余是 traceback 行 —— 数量不变正说明这 3 条与 PP 无关） |
| `NullReferenceException` | — | **0** |

**第一版为什么没用**：`ppatch.py`（15:34）只在**同一个 SerializedFile 内**找 `m_Script`，而大厅相关那 5 个是**场景包**——场景包里有**两个 SerializedFile 节点**，MonoBehaviour 落在第二个，`m_Script.pPtr.fileID=1` 指向同包 `.sharedAssets` 那个节点的 externals，解析不到就整片漏掉。
更糟的是中途把包改成单节点/错 flags，客户端报 `not built with the right version or build target` + `LuaException Managers/ResourceManagerLua:124 LoadResSync`。

**现在的做法** `ppatch2.py`（16:29）：

- UnityFS 容器 `UnityFS\0` + ver8，`>qiii`(totalsize, bic, biu, **flags=0x243**)，blockinfo 在 align16=64，块 **131,072** LZ4HC，节点表 `>qqi` + NUL 名。
- **节点 flags 必须原样保留**：单节点包 `(4,)`；CAB + `.resS` 是 `(4,0)`；**场景包两个 SerializedFile 节点都是 `(4,4)`**。
- SerializedFile v22：元数据大端、对象负载小端；`o.byte_start` 是**相对自己那个 SerializedFile 起点** → 流内绝对位置 = `nodeOffset + byte_start`。
- MonoBehaviour 头（小端）：`[0:4] m_GameObject fileID | [4:12] pathID | [12] m_Enabled | [16:20] m_Script fileID | [20:28] m_Script pathID | [28:32] m_Name len`；`fileID=0` → 同 SF，`fileID=n` → `externals[n-1]`。
- 跨 SF 解析出 MonoScript 类名，命中 `PostProcessLayer` 才把 `m_Enabled` 那一字节 1→0；重打包后逐节点回验数量/大小/flags/名/totalsize，成品与原包**只差那一字节**。
- 源包 44 个（`pp107/src/`，从 1.0.7 解出），产物 12 个（`pp107/out2/`）+ 一个 **281 B 的空包** `4ae712cc80547c646839d91734922068`（让缺包加载直接成功而不是报错；内部 CAB 是 `CAB-4e0590c7f7cac8289c1b7097a6283caa`，pathID `-14191494099089390`）。

### 4.3 免 root 的部署口径（今天定下来）

外部覆盖目录（无需 root、无需重签、重装 APK 也在）：

```
/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/res/data/
```

Frida 时代靠 hook 绕过的两道卡点，免 root 的等价物全是**文件**：

| 卡点 | 免 root 解法 |
|---|---|
| `CombineAbIndex/CombineAssetBundleDepData/CombineShaderFindData` | 直接放 `thd/res/` 三个 json（已打进 `sld_fix.zip` / `sld_data_full.zip`） |
| `media/video/loginLoop.usm` | 放真视频。发布 `dl/loginLoop.usm`（7,416,864 B，14:31）。**效果可量化**：`21:45` 那份日志 CRIWARE 报错 **2,183** 行 / `loginLoop` **1,091** 行；之后 `22:37` 起两份日志 `CRIWARE=0`、`loginLoop=0` |
| AB 补丁 | `thd/res/data/<hash>` 覆盖 |

> 客户端**没有 AB 完整性校验**（`CombineAssetBundleDepData.json` 只有 `mName/mDeps`，无 hash/size）→ 覆盖是安全的。这条是免 root 路线成立的前提。

### 4.4 进大厅后约 45 s 静默退出：定案 = Lua 主动 `Application.Quit()`

**不是崩溃**（托管层一条异常都没有），排除了内存（老机 3 GB 能长待大厅）、Wwise 缺 `.bnk`（老机同样 7 条照样活）、AB 校验、我的 PP 补丁、Vulkan。

三份同型日志（`:Error` 14/12/12 条，只差时间戳和多点的按钮）里，最后一次 gs 请求固定是：

```
16:55:57.362 msgId=10100(ClientDataOverLogin)      body=0B  push=11B framed=32B
16:56:02.853 msgId=21015(ActivityReplayReward)     body=0B  push=12B framed=33B
  ← 之后服务端再无请求；客户端日志最后一行是 AudioError: UI_Menu_SignInMonthly_Open
```

硬证据在 889 个明文 Lua 里全文检索：**整个游戏只有 3 处 `UnityEngine.Application.Quit()`，全在 `00889-LuaFileUtils_SDK_BilibiliSDK-94135.bin`**：

```lua
local success_code = 10010                                     -- 第 10 行
SDKAgreementWithLicenceCallback  -- obj.code ~= success_code → Post(SDK_QuitCallback) + Quit()  (1022-1023)
SDKAgreementWithPrivacyCallback  -- 同上                                                          (1046-1047)
SDKQuitCallback                  -- 注释原文:"SDK退出返回（游戏杀死进程的那种）（防沉迷，付费之类）" → 无条件 Quit() (1110-1111)
```

`SDK_AgreementWith*` 事件在 Lua 侧**没有任何 Post 点** → 由原生 SDK 触发。路径：原生 SDK 拉协议/防沉迷 → 校验不过 → 回调 `code ≠ 10010` → `Quit()`。静默、零异常、时间点固定、与 GPU/内存无关，全部对上。

**根因 = 重签名。** SDK 每个请求都带 `apk_sign=a04f5c1df7a58a632015edd153209ea5`（65 个请求命中），而本地三个包的签票 md5 全不匹配：

| 包 | 签票 subject | cert DER md5 |
|---|---|---|
| `sld_1.0.71426_…apk`（官方 B站渠道） | `O = bilibili`（`META-INF/BILIGAME.RSA`） | `4502a02a00395dec05a4134ad593224d` |
| `base.apk` | `CN = ZhuoYou, O = Alpha`（joygames） | `f88dedc712f7b02bb1c152c9e7853032` |
| `1.apk` | `CN = 9Game, O = LX` | `50553c039fcae0af68f4e41e34be9e79` |

`md5(SHA1hex)` / `md5(SHA1digest)` / `md5(pubkeyDER)` / `sha1[:32]` 等口径也都试完，无一命中 → 机上装的是**第三把 key 重签的包**，真服按 `app_id=2701` 注册的签名验不过。
**装回原版 APK 后不再退出**（用户 10-05 实测"能正常游玩了"）。→ §0.1 那条铁律由此而来。

附带定性：SDK 埋点报的 `net_error/login code=6 "响应签名不匹配"` 是 SDK 校验**我们假服应答**签不出来，只在 SDK 域名被重定向时出现；现在 SDK 走真服，这条自然消失。假服对 token 完全不校验（`offline-token` 只是回给客户端的字面值，`gs.js` 无验签逻辑）→ **真 SDK 出来的登录态可以直接喂进游戏服**。

### 4.5 今天的服务端改动（`offline-server/src/`，按 mtime）

| 文件 | 时间 | 内容 |
|---|---|---|
| `common_condition_ids.js` | 06:01 | 8,547 B 条件 id 表（`GetOpenFunctionData` 一次性把全部 condition 标已解锁；空集会让主城按钮全锁 —— `gs.js:441-447`） |
| `guide_ids.js` | 06:19 | 720 B 引导 id 表 |
| `gs.js` | 09:06 | 28,405 B / 566 行，`HANDLERS` **27 个 msgId**（`gs.js:381-413`） |

`gs.js` 里生效的关键几处：

- `:94` `PROLOGUE_SKIP = {101002,101004,101005,101007,101009,101011,101013}` —— 跳过 1.0.7 缺资源的序章节点（创角包 `41edf76d…` 不在包里、`video` 类节点 abIndex 无对应、教程战要 `battleEnterInfo`）。
- `:121-124` `secretaryId()` 读 `data/secretary.json`，**每次请求重读、不用重启**；换看板角色只改这个 json。
- `:265-267` `pb.bfield(80, signInfoBody())` —— `PlayerLoginGetInfo_S2C.monthSign=80` 必带，否则 `SignInMonthlyManager.InitData(nil)` 把面板清零；跨天口 `GetNextDayUpdateData_S2C.monthSign=13` 同样带（`:364`）。
- `:281-284` `GuideInfo`（字段 57）= `guideData` 原样回显 + `forceGuideStep` 跳全引导，配 `:449-455` `ChangeStep` 存储/回显，避免引导遮罩压在大厅。
- `:369-374` `GetAllActivity` **必须回显请求里的 `activityVersion`**，否则 `ActivityDataMgr.CheckVersionChange` 判版本变化 → 清数据 + 重发，死循环。
- `:397` `GetOtherPlayerInfo_S2C.type` 是 **required**，得回显。
- `:409` `ActivityReplayReward(21015)` 的类型**本身没有 `_S2C` 后缀**，它自己就是那个空 message —— 客户端解 `msg.ActivityReplayReward`。
- `:481-523` 上面 §3.6 的请求解析；`:531-542` 回包成帧；`:544-565` `handleAppInterface`（未识别 msgId 也回合法空 body 包 + `record.json` 落 `gs-req-<id>.fields.json`，`data/logs/` 下已有 **26 个** 这种字段样本，号段 3304…9400004）。

### 4.6 一个已作废的分支（技术结论留档）

`gles3_switch.zip`（212,752 B / 4 条目，17:33）**作废**。
`assets/bin/Data/globalgamemanagers`（175,304 B）里 PlayerSettings 的图形 API 表在偏移 **`0x1cb24`**，原值 `count=2 [21(Vulkan), 11(GLES3)]`；两个候选各只改 8 字节、长度不变（故对象表 `byte_start` 不错位）：`gles3_only=[11,11]` md5 `78df2c17…`、`gles3_pref=[11,21]` md5 `39a0dfcb…`、原 `75c056f4…`。
作废理由：改这个条目**必须重签 APK**，等于把 §4.4 的死因装回去。Vulkan 无辜。
（附：UnityPy 解析不了 `globalgamemanagers`，`get_assets()` 为空、`type_id` 是 0..17 的序号而非真 classID；只能靠裸字节搜 `pack('<i',21)+pack('<i',11)` → 唯一命中 `0x1cb28`。）

### 4.7 顺手摘掉的重定向

`hosts_sdk_real.txt`（1,308 B，md5 `2cea127f27f37622ea45ba7e0d2a9832`）只留 6 个游戏域名，**B站 SDK 走真服**（替代原先 19 行的 `thrud-hosts.txt`）。成立依据全按 Host 统计过 `http-requests.jsonl`：IP 直连 1,236+69 次、`line1-log.biligame.net` 820 次（埋点，文件里留了注释行可放开）、`le1-prod-bili-api-thrud…` 573 次（必须留，`/server/*` 只有它不可省）、其余 SDK 域名可摘。

---

## 5. 现在（10-06 视角）的状态快照

**能做的**：真 SDK 登录 → 跳过更新（假服 4-key）→ 过场视频（外部 usm）→ Lua 起 VM → 创角/跳过序章 → **进主城**、点界面、开月签到面板并关闭、换看板娘、改昵称/性别、引导不遮屏。PP 崩溃 0、NRE 0、静默退出 0（原版 APK + 不重签）。

**还差的**（都非致命，全在服务端侧可解）：

| 症状 | 位置 | 性质 |
|---|---|---|
| 7 × `AudioError SoundBank_Load <bank> AK_FileNotFound` | 缺 Wwise `.bnk` | 只影响音效（Weapon / Story / Role / Monster / Interface_System / Interface_Battle / ElementReaction） |
| `Patrol:603 bad argument #1 to 'pairs' (table expected, got nil)` | `PatrolDataManager.GetPatrolLevelInfo` 对模块级 `patrolLevelInfo` 做 `pairs`，而该表从未初始化 —— **客户端全程没发过 `GetPatrol(20001)`**（`server.out` 0 次、无 `gs-req-20001.fields.json`） | 触发者是任务进度评估（`TaskTools.GetTaskProgress`，144 条 `条件=3100 PatrolLevel` 的任务）。`gs.js:321-327` 已用"选无乌啦啦任务的章节 101 / 日常分组 10001"规避，**但日志里仍然出现 → 规避不彻底** |
| `RoguelikeDataManager:22 attempt to index local 'msg' (a nil value)` | `GetRogueInfoListPage(9300009)` 有 handler 但**回空 body**；且登录回包缺 `rogueLike` | 见待办 |
| `ElementTowerDataManager:54: attempt to get length of local '_levelInfoGroups' (a nil value)` | `InitTowerLevelList(_levelInfoGroups)` 对 nil 取 `#` —— `GetElementRuinsLevelGroupList(9400004)` 有 handler 但**回空 body**，`_msg.levelInfoGroups` 就是 nil | 见待办 |
| TMP 紫方框（字体缺字） | 缺的是 `6c4e24dcd86d1a6429f48f65c805a807` = `UILanTing_Big_GBK`，**APK 里根本没有这个 AB**（属要下载的 1.x GB 资源），71 个 AB 依赖它；四代重打包脚本在 `probe-hometmp/repack/`，`fonts13.zip`(4 条/23,240,660) + `fonts13_extra.zip`(2 条/102,684) 已发布 | **未收口的原因是"外部覆盖落点从没测过"，不是不会打包** —— 详见 §15 |
| 战斗/关卡等未打通 | 战斗要 `battleEnterInfo`，未做 | 只到大厅 |

> 修正一处记录：这三条 trycatch 之前笼统写成"缺三个回包"。准确说法是 ——
> **`GetPatrol(20001)` 客户端从来没发过**，所以"补个 handler"解决不了，得让 `patrolLevelInfo` 在没人发号时也不是 nil（主动推一条 patrol 包，或彻底避开 PatrolLevel 类条件）；
> **`9300009 / 9400004` 已经有 handler，但回的是空 body**，而这两个消息的空 body 恰恰就是崩因。

---

## 6. 交付物总账（`/home/qkzx/offline/sld/dl/`，手机 `http://23.147.232.29:8081/<名>`）

> **10-06 17:35 起本表所有 URL 都不可用**：假服、frpc 隧道、8081 下载服务三者已全部关闭（见 12.4/12.5）。文件本身仍在 `dl/` 里，要重新发布就按 12.3 的口径把 8081 起回来。

| 文件 | 大小 | md5 | 条目 | 状态 |
|---|---|---|---|---|
| `sld_data_full.zip` | 143,003,232 | `7aad151183c73a493591822b80d3be03` | 174（171 个 `thd/res/data/*` + 3 个 `thd/res/Combine*.json`） | **在用**，含全部 PP 修复 |
| `pp_all.zip` | 695,860 | `c76ee349decf05fd533529a1ed18dcf2` | 13（12 个 PP 包 + 1 个空 PP 包） | **在用** |
| `hosts_sdk_real.txt` | 1,308 | `2cea127f27f37622ea45ba7e0d2a9832` | 6 行有效 | **在用** |
| `loginLoop.usm` | 7,416,864 | — | — | **在用**（放外部目录后 CRIWARE 报错 2,183 → 0） |
| `thrud-ca.crt` | 1,245 | — | — | 仅 Frida/MITM 阶段需要；现在 SDK 走真服，不需要装 |
| `sld_fix.zip` | 117,656,826 | `14b20d45a6b7d0993381266f1ee061be` | 161（156 个 AB + 3 Combine json） | 已被 `sld_data_full.zip` 取代 |
| `pp_empty.zip` | 469 | `826095bdf5bd89c7edb5f0e9e3ac295b` | 1 | 试错用 |
| `pp_off.zip` | 13,250 | `54146ac6113287a7319c59b5ba51a89d` | 2 | 早期 7 包版，作废 |
| `fonts13.zip` / `fonts13_extra.zip` | 23,240,660 / 102,684 | `30ecef…` / `c685f3…` | 4 / 2 | 字体试验，未收口；**发布品与 `out/out4/out5` 三代产物都不一致，脚本已复现不出**（§15.3） |
| `gles3_switch.zip` | 212,752 | `fb20c6b07baa658b1063255e5198222f` | 4 | **作废，勿用**（要重签） |
| `CHANGELOG-2026-10-05.md` | 17,061 | `3cd5d42cc9568afe66407037da6b605c` | — | 文档（⚠ 含服务器 IP 与 `apk_sign`，见 §11） |
| `thrud-font-fix-1426.zip` | 23,181,735 | `48d7fe28cfa5db9e43b20e7867f21aa7` | 6（4 个字体 AB + `MD5SUMS` + `README.txt`，`zip -0 -X`，`unzip -t` 干净） | **10-10 新增**，官方安卓实物直拷，落点 `files/thd/res/data/`（§16.9） |
| `thrud-missing-ab-list.txt` | 50,224 | — | 622 条 / 966.6 MB | **10-10 重基到 1.0.7 APK 自己的 `abIndex.json`**；旧口径（PC 618）作废（§16.6）。表头写了落点与 `_low` 命名规则 |

`dl/` 里另有 12 个 `.ab` + 空包散文件（16:31 那批，方便单独取）。

---

## 7. 速查表

### 7.1 msgId ↔ 名字（`gs.js:28-56` 的 `CMD`，源自 `proto/CmdDefine.proto` 640 条）

| 号 | 名 | | 号 | 名 |
|---|---|---|---|---|
| 9999 | HeartBeat | | 10051 | GetSignReward |
| 10000 | PlayerLogin | | 10073 | ChangeStep |
| 10002 | PlayerLoginGetInfo | | 10100 | ClientDataOverLogin |
| 10003 / 10004 | GetPrologue / SetPrologue | | 10102 | GetOpenFunctionData |
| 10005 | GetNextDayUpdateData | | 21001 | GetAllActivity |
| 10006 / 10007 | Revelation / Weapon 列表 | | **21015** | ActivityReplayReward（**无 `_S2C`，本身即空 message**） |
| 30304 | GetPayShopDataAfterLogin | | 3304 | SetSpecialTaskProgress |
| 40002 | GetWaitOrderData | | 60003 | GetPerkInfoListPage |
| 9000007 | LoginOpenSmallBattlePanel | | **20001** | GetPatrol（**尚无 handler**） |
| **9300009** | GetRogueInfoListPage | | **9400004** | GetElementRuinsLevelGroupList |
| 9400006 | GetElementRuinsDailyReward | | 9400007 | ElementRuinsLevel_Push |
| 30405 | HangUpSweep | | 3912/3913、890105 | 已抓到过字段样本 |

### 7.2 帧格式

见 §3.6（请求 5 串 + packetUUid + dataLen/data + appendLen/append；回包 `[u8 压缩][i32 err][i32 pushLen][ReturnPackagePush][i32 msgId][i32 bodyLen][body][i32 moreLen]`）。
调试开关：`/home/qkzx/sld/probe-tmp/frame_prefix.txt` 存 1 个 hex 字节，`gs.js:20-26` 每次请求重读，用来试探那个前导字节（现在 `00`）。

### 7.3 关键 RVA（arm64，来自 `dump/il2cpp_runtime_dump.cs`）

| 符号 | RVA |
|---|---|
| `ABLoadManager.CoInit` / `<CoInit>d__12.MoveNext` | `0xf551b0` / `0xf58abc` |
| `THD.VideoManager.Init` / `PreLoadVideo` | `0xf6e0d0` / **`0xf6fb54`** |
| `CSPrepareCallback.ctor` | `0xf70d8c` |
| `UIHotUpdate.PrepareVideo` / `b__80_0` / `b__80_1` | `0xa57ce4` / `0xa58c84` / `0xa58d84` |
| `LuaManager.toLuaStart` / `LuaStart` / `CallMain` | `0xf34858` / `0xf34490` / `0xf349d8` |

PC 纪念版另有一组：`THDHelper.InitGame` `0x8912F0`、`UIHotUpdate.SendApiSkipRequest` `0x3CCDD0`。

### 7.4 其他偏移/常量

| 项 | 值 |
|---|---|
| metadata 分页 XOR | `0x66`，页 0x1000，`(off/0x1000)%16 ∈ {1,2,3,4}` |
| so `.rodata` 分页 XOR | `0x76`，页号 `% 0x10000 ∈ {0x7000,0x8000,0x9000,0xa000}`（137 页；**不足以出 dump**） |
| PlayerSettings 图形 API 表 | `globalgamemanagers` @ `0x1cb24` = `count=2 [21,11]` |
| UnityFS 容器 | ver8，`>qiii`，flags **0x243**，blockinfo @ align16=64，块 **131072** LZ4HC，节点表 `>qqi`+NUL |
| 节点 flags 必须保留 | 单节点 `(4,)`；CAB+`.resS` `(4,0)`；场景包两节点 `(4,4)` |
| classID | 114 MonoBehaviour / 115 MonoScript / 129 PlayerSettings |
| B站 SDK 成功码 | **10010** |
| 官方 apk_sign | `a04f5c1df7a58a632015edd153209ea5`（`app_id=2701`） |

### 7.5 手机侧路径

```
/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/res/data/   ← AB 覆盖（哈希名，部分无扩展名）
/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/res/        ← Combine*.json（实测：客户端自己合并生成，见 §16.2）
/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/media/video/ ← .usm（按原始路径，非哈希名）
/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/media/audio/ ← GeneratedSoundBanks/Android/*.wem|bnk
/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/{toLua,fightLua}/  ← 外部 Lua 覆盖层（生效性未验，§16.2）
  # 2026-10-17 更正：已真机验证生效。只铺单个外部 toLua/Data/<hash>（未铺 loader，且 APK 自带 loader 也列了该 hash）
  # 即改了游戏行为 ⇒ 外部优先是逐文件的。详见 ../README-战斗移动轴与高度解锁.md §7
  # 2026-10-18 补：玩法层 A/B 也过了（第1章1~8关 controlMode 翻 1 → 升降摇杆出现）。
  # 那次实测其实连带改了 kvl.kvl 里该 hash 的 md5（台账值=盘上密文 md5），照做即可；newkvl.kvl 不用动。
/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/kvl.kvl     ← 热更台账（明文，§16.3）
/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/clientLog/      ← 客户端日志（让用户上传这里）
```

`dataPath` / `streamingPath` 两个字段的实测量见 §16.2。**卸载会连带清空整个 `Android/data/<pkg>/`** —— 所以"先复制再重装"是白做，任何投递必须在安装之后（本轮实测口径）。

### 7.7 10-10 这批分析产物在哪

```
/home/qkzx/sld/phone/files/            真机完整 dump（10,596 条目 / 6.20 GB / 零告警）
  ├── thd/kvl.kvl                      1583 台账（44,841 条）      thd/newkvl.kvl = APK 1426 台账
  ├── res/abIndex.json 等 5 个索引      ⚠ 1583 版，不要往手机放（§16.4）
  └── clientLog/*.log                  162 份；冷启动那份 = Thrud2023_12_01_18_12_47.log
/home/qkzx/sld/phone/luaplain/         2,808 个明文 Lua chunk（§16.9）
/home/qkzx/sld/phone/{msg.proto,other.proto}   protobuf 全量（337 + 264 message）
/home/qkzx/sld/phone/push_pkg/         字体 4 个的暂存 + README/MD5SUMS
/home/qkzx/offline/sld/manifests-1.0.7/  1.0.7 APK 直抽的安卓原版索引 7 件 + MANIFEST.md5（§16.5）
/home/qkzx/offline/sld/kvl-1426-vs-1583-changed.txt   1,973 个会变版本的路径
/home/qkzx/offline/sld/kvl-1583-only.txt              8,252 个 1583 新增路径
/home/qkzx/sld/sld107/                 1.0.7 APK 的 listing.txt（37,737）+ manifest/
```

live `manifests/`（1.0.6 / kvl 1336-1338）**本轮一个字节没动**，切换靠 `SLD_KVL` / `SLD_ABINDEX` 两个环境变量（§16.5）。

### 7.6 Lua chunk 加密（**10-07 破掉**：固定 8 字节 XOR）

```
key        = 89 67 45 23 01 ef cd ab   (小端 uint64 = 0xabcdef0123456789)
覆盖范围    = 整个文件, 从 offset 0 循环; 无头部、无长度字段、无 per-file 派生、无压缩
打包形态    = assets/toLua/Data/<hash> 3,198 个 + assets/fightLua/Data/<hash> 1,472 个 (共 4,670)
              索引 assets/toLua/toluaLoader (108,664 B) / assets/fightLua/fightluaLoader
工具        = /home/qkzx/offline/sld/tools/lua_xor.py {dec|enc|probe} <in> [out]
```

证明链（不是推断）：Frida 抓的 889 个明文文件名尾数就是**明文字节数**，拿去 `listing.txt` 里按大小反查 `assets/toLua|fightLua/Data/<hash>`，**唯一命中**即得明文↔密文对（toLua 505 对、fightLua 51 对，另有 102/14 组同长度撞车而弃）。相减取密钥流：

| 目录 | 唯一配对 | 前 8 字节 = key | **全长** = key |
|---|---|---|---|
| toLua | 505 | 489 | **482** |
| fightLua | 51 | 15 | 1（样本太少，见下） |

端到端复验：`assets/toLua/Data/44cee35be25e1901c44512552083db3c`（= `SDK/BilibiliSDK.lua`，94,135 B）从 **1.0.6** APK 取出、`lua_xor.py dec` 解出，与 **1.0.7** 客户端 VM 收到的明文 `diff` = **0 行差异**；`enc→dec` 逐字节往返一致。

两处必须记住的限定：

1. **剩下的 7 个 toLua 不符 = 版本漂移，不是第二种密钥**。明文抓自 1.0.7、密文取自 1.0.6 APK，前 8 字节对得上而尾部发散，正是"同一 key、内容变了但长度没变"。要清零就得拿 1.0.7 的原包重跑配对。
2. **fightLua 的 key 尚未确证**（51 对里只有 1 对全长命中，15 对命中头 8 字节）。它归 `liblua54.so`（Lua 5.4，战斗逻辑），样本太少不能下结论；表现是"头 8 字节多为 `8967452301efcdab`，不符的那 35 对大概率同样是版本漂移"。**只碰大厅/SDK 逻辑就用 toLua，别假设 fightLua 同 key。**

顺带纠正第 8 节那条死路：当年"8 字节重复 XOR"被列入"已否证"清单，**测法是错的** —— 当时是盲猜 key + 猜偏移，而正确抓手是**拿运行时明文和 APK 密文配对相减**。同一批文件、同一个假设，10-07 一次就中了。

---

## 8. 走过的死路（都留了脚本，别走第二遍）

| 死路 | 停在哪 |
|---|---|
| 单字节 XOR / 8 字节重复 XOR / 仅头 34 字节替换 / zlib·lzma@0..64 / RC4（12 万候选 key）/ md5·sha 路径命名 / "38 字节前缀 ^ BE64(len)" / "UnityFS 明文头在 64..260 任意偏移 + 组内共享密钥流"滑窗 crib | Lua chunk 加密静态破解，8 类假设全否证。**但 10-07 已破**：正是 8 字节重复 XOR（key `89 67 45 23 01 ef cd ab`），见 §7.6。当时连"8 字节重复 XOR"一起否证掉是**方法错误**（拿密文互 XOR 找周期，被变长明文糊平），不是结论错误 |
| Frida hook `SSLContext.init`/`HostnameVerifier` 装 trust-all | **多余**：免 root 没挂任何 hook，客户端照连自签证书（它自己带 5 处放水），见 §14 |
| 推 KCP/AES/RSA 认证信道 | `net-*` 98 个目录全空，一个 UDP 包都没走 |
| 静态 Il2CppDumper / Il2CppInspector 2021.1 | 门 3 那批页无法单字节解释；Il2CppInspector 直接拒收 v29。运行时 dump 已解决 |
| `kvl.kvl` 的 md5 当明文 oracle | 它是**落盘原文**的 md5（300/300 验证），验不了密钥。10-10 补充：**`kvl` 台账本身是纯明文**（`路径 : md5 : System.String`，见 §16.3），真机外部 `toLua/Data/*` 落盘仍是 XOR 密文而 md5 全中 10,231/10,231 ⇒ 这行结论不变，但当年"kvl 是密文"的附带印象是错的 |
| 在 `Debug.LogException` / `Exception..ctor` / 热 getter 的 onLeave 里解引用 | 原生崩溃（§3.2） |
| `pgrep/pkill -f` | 匹配到调用者自己 |
| Vulkan → OOM → 内存不足 三级理论 | 老机 3 GB 能长待大厅；真因是 `Application.Quit()` |
| 强制 GLES3（改 `globalgamemanagers`） | 必须重签 → 把死因装回去，作废 |
| 7z `include` 模式抽 7 GB 归档 | 中文路径 + locale 导致 "Files: 0" / "Sub items Errors: 3106"；改为直接用已解包目录 |
| UnityPy 解析 `globalgamemanagers` | `get_assets()` 空、`type_id` 是序号非 classID；只能裸字节搜 |

---

## 9. 待办（全部不需要动 APK）

1. **补三处回包**（按 PC 纪念版 `_run_patched.py` 的 `LUA_MOCK` 硬约束，RULES 在 7323/7336 行）：
   > **10-10：知识半区已关**——`msg.proto` / `other.proto` 已从真机 dump 的 `protoStr` 全量还原（§16.9），下面三处缺的 message 定义（`PacketBodyInfo` / `ReturnPackageInfo` / `ElementRuinsLevelInfoGroup` / `ElementRuinsLevelInfo` / `GetRogueInfoListPage_S2C`）**全部拿到**，还附了一份 4 组 × 5 关、`remainCount=5` 的官方样例 payload。剩下的纯粹是假服侧写回包的工作量。
   - `GetElementRuinsLevelGroupList(9400004)`：`GetElementRuinsLevelGroupList_S2C{ repeated ElementRuinsLevelInfoGroup levelInfoGroups=1; bool hasDailyReward=2; int32 lastFloor=3 }`。**`levelInfoGroups` 给空表必崩**（`InitTowerLevelList` 的 `#_levelInfoGroups` 在 nil 时于 `:54` 挂；`UIActivityElementTowerCellPanel:65 → GetPassLevel:135` 也裸索引）。分组由客户端自带 `ElementRuinsLevel_Xls.belongRuins` 推，`remainCount = ElementRuins_Xls.dailyChance`（4 座遗迹 id 1..4 = 熔岩遗迹/轰雷之柱/风幕巨塔/冰川之座，`dailyChance=5`），`state` 0未解锁/1可打/2已过。
   - 登录回包补 **`rogueLike`**（`msg.RogueLikeInfo`），并给 `GetRogueInfoListPage(9300009)` 真内容；另需已看剧情集 + 已激活天赋 `talentBuff`。
   - **巡逻（乌拉拉）**：不是"加个 `GetPatrol(20001)` handler"那么简单——客户端**从没发过这个号**。要二选一：**(a)** 在 `PlayerLoginGetInfo` 之后用 `packetBodyInfoS`（`gs.js:465-473` 的推送通道，重复字段 3）主动推一条 `GetPatrol_S2C`，把 `patrolLevelInfo` 初始化掉；**(b)** 把 `taskProgress=47` 里 `chapterIndex/dayGroupIndex` 选到**真的不含 PatrolLevel 条件**的组合（现在 101/10001 只是减轻、没根除）。`Patrol.proto:19/24` 有 `GetPatrol` / `GetPatrol_S2C` 定义可照抄。
2. ~~**618 个 PC-only 包批量转换**~~ —— **10-10 作废，见 §16.6**。真机 dump 提供的是**安卓原生实物**，618 里 597 条 hash 本来就在 1.0.7 安卓 abIndex 内、剩 21 条按 `mOriginName` 反查也全部在 622 清单里有安卓对应实物；`convert.py`/gen1/gen3/UnityPy 换 `target_platform` 整条路线停止投入。真正补不上的只剩未上线角色 `UI_Lottery_zuoyide` / `UI_role_zuoyide` 两个。清单口径改为 `dl/thrud-missing-ab-list.txt`（**622 条 / 966.6 MB**，基线 = 1.0.7 APK 自己的 `abIndex.json`）。
   - 留档（当时的执行记录，勿再投入）：`/home/qkzx/sld/probe-tmp/missing107.json`（618 条，`[hash, mOriginName, False]`）；`miss13/convert.py` 输入路径已从 `probe-hometmp/` 改到 **`probe-tmp/`**，`shard 0 500` 跑出 `唯一 id 618 / ok=2`。
3. **Android Wwise `.bnk`**（7 条 `SoundBank_Load AK_FileNotFound`，影响音效不影响可用性）。
4. **TMP 紫方框字体**（`6c4e24dcd86d1a6429f48f65c805a807` = `UILanTing_Big_GBK`，APK 内不存在、71 个 AB 依赖它）——**10-10 两处收口**：(a) 落点已实测，`files/thd/res/data/` 参与加载（§16.2），§15.5 的"落点未知"结束；(b) 官方**安卓**实物已在手上（`sld/phone/files/thd/res/data/6c4e24…`，5,126,528 B，md5 `1e2796fa0cde84f3a7c98d23e1e0c832`，见 §16.9），**不再需要重打包**。剩下唯一动作是投递（4 个字体文件已在 `dl/thrud-font-fix-1426.zip` 里）。注意 §15.3 那个"已发布产物复现不出来"的问题随重打包路线一起作废。
5. **`apk_sign` 那套改包流程（§13）等实机验证**：前置条件之一已经满足 —— **1.0.7 原包本地已有**（§4.4 那张表里第一行 `sld_1.0.71426_20231115_010215_695fd.apk?sourceFrom=1007`，1,880,339,103 B；注意文件名里那段字面量 `?sourceFrom=1007` 会让 `find -name '*.apk'` 漏掉它，要加引号），"本地只有 1.0.6"那句作废。剩下的仍是接受卸载清空 `files/`。验过之后 §0.1 铁律才能正式解除，届时 Lua 覆盖（§7.6）、内置字体、gles3 三条一起复活。
   - 10-10 补一句：现在**外部覆盖落点已实测**（§16.2），改包路线的唯一剩余优势"内置字体复活"已经不需要了 —— 字体走外部即可。§13 的性价比大幅下降。
6. 每有新补丁，重打 `sld_data_full.zip` 并同步 md5（现在这份是 16:31 的，含 12 个 PP 包）。
7. **索引基线切换 + 622 投递 + 两个未决实验**：按 §16.10 的 1→3 步做。第 3 步只需一条 `adb shell ls`，决定"外部 `res/` 是不是合并层"和"外部 Lua 到底生不生效"。

---

## 10. 复现 / 排障命令

```bash
# 假服 / 隧道 / 发布口是否都在
ps -eo pid,etime,cmd | grep -E "node src/index|frpc -c frpc-sld|http.server 8081" | grep -v grep
ss -tlnp | grep -E "9443|8081"
tail -40 /home/qkzx/sld/probe-tmp/server.out

# 手机侧补丁装齐没（应 13：12 个 .ab + 1 个无扩展名空包）
ls /storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/res/data/ | wc -l

# 客户端错误签名（PP 修好后：:Error 12~14、NRE 0、KGenLut3D 0、CRIWARE 0）
L=/home/qkzx/sld/Thrud2026_10_06_00_55_17.log
grep -c ":Error" $L; grep -ci NullReference $L; grep -c KGenLut3D $L; grep -c CRIWARE $L

# 某个 msgId 客户端到底发了哪些字段
cat /home/qkzx/offline/sld/offline-server/data/logs/gs-req-9400004.fields.json

# 按 Host 看请求分布（判断某域名能不能摘）
grep -o '"host":"[^"]*"' /home/qkzx/offline/sld/offline-server/data/logs/http-requests.jsonl | sort | uniq -c | sort -rn

# 重跑 PP 补丁（源包 pp107/src 44 个，产物 pp107/out2 12 个）
/home/tmp/venv/bin/python /home/qkzx/sld/probe-hometmp/ppatch2.py

# 找一个 proto 定义
grep -n "GetElementRuinsLevelGroupList" /home/qkzx/offline/sld/proto/ElementRuins.proto
```

改 `gs.js` 后要重启假服才有新 handler 生效（只有 `data/secretary.json`、`prologue.json`、`frame_prefix.txt` 是热读的）。
**重启前先确认手机不在会话中**，否则会当场掉线（推断：客户端有重试，但没实测过恢复行为）。

---

## 11. 资料来源与两条提醒

| 来源 | 位置 | 覆盖 |
|---|---|---|
| Qoder 静态阶段会话 | `/root/.qoder/projects/-home-qkzx/a190a28c-*.jsonl`（10.9 MB） | 9-21 ~ 9-23 |
| Qoder 今天会话 | 同目录 `dd282006-*.jsonl`（11.8 MB） | 10-05 ~ 10-06 |
| Codex 真机攻坚 | `/root/.codex/sessions/2026-10-04/rollout-…01a1054e….jsonl`（8.5 MB / 6,492 行）+ `/root/.codex/history.jsonl`（387 条 prompt，sld 占 61 条） | 10-04 05:06 → 10-05 06:16 |
| CommandCode | `/root/.commandcode/projects/home-yhjjx-yhjjx/5d8174c8-*.jsonl`（3 MB / 62 条） | 10-04 03:04 → 10-05 13:15 |
| 本目录三份文档 | `README.md`(221) / `PROGRESS-frida.md`(200) / `CHANGELOG-2026-10-05.md`(297) | 各阶段一手记录 |
| PC 参考 | `/home/qkzx/sld/sld_full/斯露德纪念版/_sld_patcher.js`、`_run_patched.py`(420,973 B) | Lua 侧硬约束 |

两条提醒：

1. `dl/` 是**公网 8081 直挂**，`serve.out` 里能看到外部扫描器（如 `199.45.155.58`）在打。`CHANGELOG-2026-10-05.md` 含服务器 IP、frp token 口径和官方 `apk_sign`，要不要从 `dl/` 撤掉、只留本地，你定。
2. 本文（`PROJECT-LOG.md`）同样含这些值，目前**只写在项目根目录，没有放进 `dl/`**。要发布说一声，我按老规矩给你 zip。

---

## 12. 路径搬迁总账（10-06）

根分区 `/dev/vda1` 只剩 777 MB，而 `/home`（`/dev/vdb1`）有 333 GB 空闲；`/tmp` 和 `/home/tmp` 还各有一份互不相干的 `sld_probe`，两边路径混用已经真的坑过 `miss13/convert.py`。所以把散在两个临时目录里的 sld 杂物整体并到 **`/home/qkzx/sld/`**。**同分区先 rename、跨分区才 stop-server → mv → 重启**，全程数据无损（搬完根分区 777 MB → 1.7 GB）。

### 12.1 原路径 → 新路径

| 原 | 现 | 体量 |
|---|---|---|
| `/tmp/sld_probe` | `/home/qkzx/sld/probe-tmp` | 864 M / 1,071 条 |
| `/home/tmp/sld_probe` | `/home/qkzx/sld/probe-hometmp` | 181 M |
| `/home/tmp/sld` | `/home/qkzx/sld/sld` | 136 M（阶段一工作区，内含旧 `offline-server/README.md`） |
| `/home/tmp/sld_full` | `/home/qkzx/sld/sld_full` | 8.7 G（PC 纪念版解包） |
| `/home/tmp/slddump` | `/home/qkzx/sld/slddump` | 266 M |
| `/home/tmp/slddex` | `/home/qkzx/sld/slddex` | 2.3 G |
| `/home/tmp/sldns` | `/home/qkzx/sld/sldns` | — |
| `/home/tmp/v1lua` | `/home/qkzx/sld/v1lua` | 54 M（安卓 `luadata.assetbundle` 23.7 MB） |
| `/tmp/sld_*`、`/home/tmp/sld_combine`、`sld_lib`、`sld_data_files.txt` | `/home/qkzx/sld/` 同名 | 32 K / 46 M / 1.4 M |

**按约定没动**（不是 sld 专属）：`/home/tmp/venv`、`/home/tmp/dotnet`、`/home/tmp/il2cppdumper`、`/home/tmp/il2cppcli-linux`、ndk 等。所以下面这些命令里 `/home/tmp/venv/...` 前缀仍然正确。

两个易混的名字要背下来：
- **`probe-tmp`** ← 原 `/tmp`，装**运行时产物**（`server.out`、`missing107.*`、`frame_prefix.txt`、`vmstage/conv_android/pack/ziptest`）。
- **`probe-hometmp`** ← 原 `/home/tmp`，装**打包脚本**（`ppatch2.py`、`pp107/src`+`out2`、`miss13/`、`repack/`、`ggm/`、`ns_out/`）。

### 12.2 顺带修掉的引用

97 个文件的过期路径做了 sed（**长串先换、短串后换**，否则 `/home/tmp/sld_probe` 会被 `/home/tmp/sld` 的规则截断）：`gs.js:18-21 readPrefix()` → `/home/qkzx/sld/probe-tmp/frame_prefix.txt`、`miss13/convert.py:74` → `probe-tmp/missing107.json`、`sld_mod*.py` / `sld_reg.py` 里的 `libil2cpp.so` → `sld/slddump/...`、两份 `README.md` 的 `cd /home/tmp/sld` → `cd /home/qkzx/sld/sld`、本文与 `offline/reports/sld-dump-failure.md` 的工作区路径。

现在 `grep -rl "/tmp/sld_probe|/home/tmp/sld"` 在 **`*.py *.js *.sh`** 里已经 0 命中；仍有命中的只剩历史日志（`auto_spawn*.log/out`、`miss13/c*.log`、`server.log`），那是当时真实输出的记录，**故意不改**。

### 12.3 两条运行状态（搬完之后）

- **假服**：pid **847354**，`LISTEN 0.0.0.0:9443`，stdout 落 `probe-tmp/server.out`；走 frps 从公网验过 `https://23.147.232.29/server/getClientUpdateData?appVersion=1426` 返回正常。启动口径：
  ```bash
  cd /home/qkzx/offline/sld/offline-server
  SLD_TLS=1 SLD_HTTP_PORT=9443 SLD_KCP_PORT=19005 \
    setsid nohup node src/index.js >> /home/qkzx/sld/probe-tmp/server.out 2>&1 &
  ```
- **frpc（pid 689913）仍然持有旧 inode**：它的 fd 1/2 是 `/tmp/sld_probe/frpc2.out (deleted)`，即跨分区 `mv` 等于 copy+unlink，进程还往那个已 unlink 的 inode 写。已用 `/proc/689913/fd/1` 与原文件 `cmp` —— **一致（252,402 B），没丢日志**。代价是：从现在起到下次重启 frpc 之前，新的隧道日志只活在那个匿名 inode 里，磁盘上的 `probe-tmp/frpc2.out` 会一直停在 17:07:41。要恢复记录就得重启 frpc（隧道会闪断一下），这一步留给你决定。
- **`sld-http-80` 那条代理一直是 refused**（本地 9080 从 10-04 05:57 起就没人监听，1,073 次）。与本次搬迁无关，客户端走的是 HTTPS:443，不影响可用性；要么起个 9080 明文口，要么把这条 proxy 删掉。

### 12.4 10-06 17:30 —— 假服与隧道已按要求关闭

`kill 847354`（假服 node）+ `kill 689913`（frpc）都是 TERM 一击就走，无重启循环、无 cron、父进程只是我自己的启动 shell（`ps -o ppid=` 查过）。关前把 frpc 那个匿名 inode 的最后一段日志落盘：`probe-tmp/frpc2.out` 从 252,402 → **253,377 B**，尾行 `17:20:51 [sld-http-80] connect to local service [127.0.0.1:9080] refused`，之后进程退出、inode 随之释放，**日志完整**。

关闭后的实测状态（**最终：三个都关了**，12.4 初稿曾把 `:8081` 留着，随后按要求一并关闭）：

| 检查 | 结果 |
|---|---|
| `ps` grep `node src/index` / `frpc -c frpc-sld` / `http.server 8081` | 0 命中（三个都是 TERM 一击就走） |
| `ss -lntp` grep `9443\|9080\|8081\|7000\|19005` | 无任何监听，端口全释放 |
| 本机 `https://127.0.0.1:9443` | connection refused |
| 公网 `https://23.147.232.29/server/getClientUpdateData` | `curl rc=7`（拒绝） |
| 公网 `http://23.147.232.29/...` | `curl rc=7`（拒绝） |
| 公网 `http://23.147.232.29:8081/pp_all.zip` | `curl rc=7`（拒绝） |

### 12.5 顺带钉死的一条拓扑事实（下载 8081 到底谁在服务）

之前文档一律写"下载入口 `http://23.147.232.29:8081/<名>`"，但**本机只有 `155.117.82.134`**（`ip -4 -br addr` 实测），`23.147.232.29` 是**另一台**机器 —— 也就是 `frpc-sld.toml` 里 `serverAddr` 指向的 frps 那台。查 `/tmp/http8081.out` 的来源 IP 分布：

```
3 × 23.147.232.29  GET /pp_all.zip / sld_data_full.zip / fonts13.zip / thrud-ca.crt   ← 每个 zip 恰好 3 次
127.0.0.1          (我自己的自检)
外部扫描器         77.83.31.107 / 213.232.112.158 / 45.198.224.125 / 142.93.55.178 / 216.247.103.160
```

即：**手机并不是直连本机 8081**，而是 `23.147.232.29` 那台按文件回源来取（每个 zip 固定 3 次 = 它自己的重试/同步），本机 8081 真正的对外暴露面是那批外部扫描器。**结论：8081 直接挂公网、里面是全量补丁包 + `CHANGELOG` 这类含 IP/token/`apk_sign` 的文档，不是好状态**；现在已关，下次要发布建议只在本机自测，把「回源到 23.147.232.29」那条路单独加白名单，文档别放进 `dl/`。

另有一条待核对的自相矛盾：`/home/yhjjx/yhjjx/fakeserver/bin/frps.toml` 第一行注释写"frps 跑在 155.117.82.134（即 Claude 所在机）"，与 `frpc-sld.toml` 的 `serverAddr = 23.147.232.29` 冲突。本机现在**没有** frps 进程、7000 也没监听，所以那句注释要么是旧计划要么是错的 —— 下次起隧道前照 12.3 的口径即可，不必在本机补起 frps。

**再起来就照 12.3 那条命令**；frpc 用 `cd /home/yhjjx/yhjjx/fakeserver && setsid nohup ./bin/frpc -c frpc-sld.toml >> /home/qkzx/sld/probe-tmp/frpc2.out 2>&1 &` —— 注意把日志重定向指到**新路径**，否则又会写进一个后来搬不走的 inode。手机侧此时 hosts 仍指向 `23.147.232.29`，游戏会卡在拉更新那步（`getClientUpdateData` 拒连），补丁包也下载不了，这两条都是预期的，不是回归。

---

## 13. 改包绕过 `apk_sign`（10-07 定稿的步骤，**尚未实机验证**）

> ⚠️ **10-18 更正：下面示例里钉的值 `a04f5c1df7a58a632015edd153209ea5` 是错的。**
> 那是当时机上第三把 key 重签包**上报**的值（正是对不上才 45 s 退出的那个），
> 不是官方值。正确值是官方 B 服证书 DER 的 md5：`4502a02a00395dec05a4134ad593224d`
> （1.0.6 与 1.0.7.1426 同一把 key）。现行口径见
> [`../README-改包签名校验.md`](../README-改包签名校验.md)。
>
> ⚠️ **10-18 补充（实测）：改包这条路在 1.0.7 上不通。** 壳 `assets/__tpinfo.tsc`（带 `.sig`）里有
> 36,777 条 (未压缩大小, CRC32) 的逐文件清单，**覆盖 `classes.dex` 与 `lib/*.so`**；只改一个方法即
> **黑屏 + 进程反复被杀**，且死在登录之前（假服零请求），与 `apk_sign` 取值无关。
> 「只重签、不改内容」不触发。三条绕法（清单失效 / CRC32 碰撞 / patch 壳）**待验证**，
> 已验证可行的替代路径是**运行时 hook**，均见上述专题文档 §7/§8。

铁律「APK 不碰、不重签」的**解除条件**写在这里。目的不是玩花样，是为了把「重签 = 静默退出」这个 10-05 定下的死约束解开 —— 一旦解开，Lua 覆盖（7.6 的 key 已破）、内置字体（确切做法见 §15.6 第 3 条：把 `6c4e24` 写进 APK 的 `assets/bin/Data/`）、gles3 那 8 字节都重新变得可做。**下面每一步都有静态证据，但整套流程还没在真机上验过，照做之前先读完 13.3。**

### 13.1 为什么这条路成立

10-05 §3 的定案是：SDK 回调 `code ≠ 10010` → `SDK/BilibiliSDK.lua` 那 3 处 `Application.Quit()` → 约 45 s 静默退出；触发原因是机上包被第三把 key 重签，导致上报的 `apk_sign` 与 B 站按 `app_id=2701` 注册的签名不符。

今天把 `apk_sign` 的生产链挖穿了（反编译树 `/home/qkzx/sld/slddex/out`，源是 **1.0.6** 的 `classes.dex`）：

```java
// com/bsgamesdk/android/utils/a.smali  源文件名 = ApkSignatureUtil.java
getPackageInfo(pkgName, 0x40 /*GET_SIGNATURES*/).signatures[0].toByteArray()
  → MessageDigest("MD5").digest()
  → 逐字节 Integer.toString(b,16)，长度 1 补 "0"   ⇒ 小写 hex
```

消费点在 `com/bsgamesdk/android/api/f.smali`（1.0.6 里 490~512 行）：`sget f.k` → 为空才调 `a(Context)` 算一次并 `sput` 缓存 → `map.put("apk_sign", f.k)`。

⇒ 三条推论，都成立：**(a)** 它是客户端自算、当**普通参数明文上报**的，Android 框架层面没有任何东西参与；**(b)** 服务端只能拿这个字符串跟注册值比；**(c)** 全 `slddex` 搜 `a04f5c1df7a58a632015edd153209ea5` **0 命中** → 客户端**没有**本地自检，把值钉死不会在别处对不上。

唯一生产者已确认：`grep -rln "Lcom/bsgamesdk/android/utils/a;->a(Landroid/content/Context;)" smali smali_classes2` → **只命中 `api/f.smali` 一处**。

### 13.2 步骤

```bash
# 1) 反编译，-r 不解资源(改动面最小, 也不会引入 aapt 版本差异)
apktool d -r -o sld1426 <1.0.7 原包>.apk

# 2) 编辑 sld1426/smali/com/bsgamesdk/android/utils/a.smali
#    把"第一个方法"整个方法体替换成下面三行(按方法签名定位, 别按行号 —— 1.0.7 会漂)：
```

```smali
.method public static a(Landroid/content/Context;)Ljava/lang/String;
    .locals 1

    const-string v0, "a04f5c1df7a58a632015edd153209ea5"

    return-object v0
.end method
```

```bash
# 3) 回编 → 对齐 → 任意 key 重签(v1 保持开启: .signatures 仍要拿得到证书)
apktool b sld1426 -o u.apk
zipalign -f 4 u.apk a.apk
apksigner sign --ks x.keystore --ks-key-alias youralias \
  --v1-signing-enabled true --v2-signing-enabled true --out sld_1426_signfix.apk a.apk
apksigner verify --print-certs sld_1426_signfix.apk
```

本机工具版本：`apktool 2.5.0-dirty` / `zipalign` / `apksigner 0.9`。**注意本地没有 1.0.7 的原包** —— 只有 `/home/qkzx/sld_1.0.6.1338_20230926_061320_5fb48.apk`，真要改包得先从你那边拿 `sld_1.0.71426_*.apk`。

同名重载有四个：`a(Context)` / `a([B)` / `a(Context,String)` / `b([B)`，**只替换第一个**，另外三个是 MD5-hex 与取证书的实现，动了会把 SDK 其它逻辑一起搞坏。

### 13.3 代价与未知项（动手前必须认下来）

1. **要卸载原版** —— 签名不同无法覆盖安装。卸载清空 `files/`：PP 那 13 个补丁、`sld_data_full.zip` 的 174 个条目、`secretary.json`、`clientLog/` 全没，还要重下 1.x GB 资源。**这条改动的实际成本在这里，不在技术风险。**
2. **测之前先把假服和隧道起回来**（12.4 已全关），否则只会看到 `getClientUpdateData` 拒连，白跑一趟。
3. **静态推不出来的部分**：B 站服务端除了 `apk_sign` 是否还交叉比对 `isRoot` / `udid` / `channel_id` / `version_code`（这些在同一段参数里，`api/f.smali:71~436` 都能看到），以及 SDK 应答签名那条链会不会在其它环节失败。判定信号只有一个：**进游戏后是否仍在约 45 s 静默退出**。
4. **游戏自己的那条通道不受影响**：`com/gsc/base/model/UpDataModel.apkSign()`（1.0.6 :275，注解 `@RequestParam(name="apk_sign")`）是**另一套实现** —— `DeviceUtil.getAPKSign(ValueType.CACHE)`（:6915）→ `CommonTools.params2Str`。它会继续上报**新 key** 的 md5 到 `/AppInterface`；那条打给我们假服、不校验，所以可以不管，要日志一致就照同样方式钉掉。
5. **「只改 Lua 不改 Java」已否证**：889 个明文 Lua 里 `apk_sign` **0 命中**，toLua 层根本不读这个字段（`SetHttpLuaUpdate` 也是假线索，它只是给 HTTP 请求注册 Lua 回调，不是"从 HTTP 加载 Lua"）。

---

## 14. TLS：客户端**不校验证书**（10-07 定案）

结论一句话：**链式校验和主机名校验两道都没做，也没有证书钉扎**。所以手机永远不需要装我们的 CA，证书的 CN/SAN/有效期怎么写都无所谓，换 IP 换域名都不用动证书。

### 14.1 实测证据（最硬的一条，来自已跑通的那套现网配置）

我们 `offline-server/certs/` 用的证书是 10-04 03:44 自建的：

```
subject = C=CN, O=SLD,            CN = *.bilibiligame.net
issuer  = C=CN, O=SLD Local Test CA（自签，公网 CA 里没有）
SAN     = *.bilibiligame.net / biligame.net / *.biligame.net / *.biligame.com
          / *.bilibili.com / *.accessgames.com / accessgames.com / *.15166.com
```

而手机侧同时满足三件"本该连不上"的事：

1. 免 root，**没有证据表明机上装过这个 CA**（我们确实把 `certs/ca.crt` 改名成 `dl/thrud-ca.crt` 挂出去过，md5 `7ae6426b…` 与 `certs/ca.crt` 完全一致，§12.5 显示它被取过 3 次；但 §6 当时的口径是"仅 Frida/MITM 阶段需要，现在不需要装"，**是否真被手动装进手机没有记录**）。这条不影响结论：即便装了，Android 10 上 target API ≥ 24 的 App 默认不信用户 CA，而下面第 2 条的主机名不匹配是**装了 CA 也过不去**的。
2. 游戏主流程**按 IP 直连**：流水里 Host 是 `23.147.232.29` / `23.147.232.29:443`（1,386 + 188 条）。TLS 的对端名字就是这个 IP 字面量，SAN 里一条 IP 都没有、CN 是域名 ⇒ 主机名比对必挂；（计数口径：§3.4 里那组 `1,236+69` 是 10-05 当时的快照，同一份日志现在全量 3,353 条 = `1,386+188`；另有 `155.117.82.134:9443` 92 条是我本机自测）
3. 监听器是 **TLS-only**（`http.js:219`，`SLD_TLS=1` 时只建 `https.createServer`，从来没在 9443 上开明文）。

结果：`/AppInterface` 1,076 条 + `/server/*` 573 条全部抵达假服，客户端一路跑到大厅。**9 份客户端日志（`/home/qkzx/sld/Thrud2026_*.log`）里 `certificate|cert|SSL|handshake|unable to verify` 命中 0 条** —— 之前看着像 1,794 条是 `Poce**ssL**ayer` 的误匹配（`grep -i` 撞进 `PostProcessLayer`），已排除。

### 14.2 代码证据：Java 层有 5 处在证书上放水（反编译树 `/home/qkzx/sld/slddex/out`，源 1.0.6）

| 类 | 行为 |
|---|---|
| `com/base/track/http/SSLSocketClient$1`、`com/base/trackingdata/http/SSLSocketClient$1` | `checkServerTrusted` 函数体只有 `return-void`；`getAcceptedIssuers` 返回空数组 |
| `…/SSLSocketClient$2` | `verify()` = `const/4 p1, 0x1; return p1` —— 主机名恒真 |
| `gsc/fb$a` + `gsc/fb$b`（base SDK 网络层） | 同样 trust-all + 恒真 |
| `com/criware/filesystem/CriFsWebInstallerManager$LooseTrustManager` | CRI 视频/资源下载 trust-all |
| `com/bsgamesdk/android/api/asynchttp/EasyX509TrustManager` | **B 站 SDK 登录那条链**，拆解见 14.5 |

`EasyX509TrustManager.checkServerTrusted` 的三重放水：

- 整段校验包在 `try { … } catch(Exception) :catch_0` 后面 `return-void` ⇒ **任何 `CertificateException` 被吞掉**；
- 链里只有 **1 张**证书时（我们正是：node 只传 `cert: server.crt`，不带 CA）走 `checkValidity()` 就 `goto return-void`，**连它内部委托的 TrustManager 都不叫**；
- 链多于 1 张时先过 `EasyX509CertificateTimeless.getTimelessX509CertificatesTimeless()` —— **把有效期整个抹掉**，所以证书过期也无所谓。

`res/xml/network_security_config.xml`（264 B，AXML 里只有 `network-security-config` / `base-config` / `cleartextTrafficPermitted`）**没有 `trust-anchors`** ⇒ App 允许明文 HTTP，但没有额外加信任锚；能连上纯粹靠上面那几套代码，不是配置放开了 CA。

### 14.3 边界：游戏业务通道是 C# 侧，没有代码级证据

`grep -r "AppInterface" smali smali_classes2` → **0 命中**，所以那 1,076 条业务流量不走 Java，是 IL2CPP/C#（UnityWebRequest / libcurl）那一层。这层我只拿到实测证据（14.1：不受信 + 名字不匹配照样连上并跑到大厅），运行时 dump 里没有 `CertificateHandler` 相关符号可查。B 站 SDK 那 995 条（`okhttp/3.12.1` 872 + `Mozilla/5.0 BSGameSDK` 123）则是 14.2 的代码在兜。

### 14.4 顺带更正一条旧结论

先前把流水里 `libredtail-http` 那 147 条算作"Unity/CRI 的资源下载"，**错了**。这 147 条 Host 全是 `23.147.232.29:443`，路径是 `/index.php`、`/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php`、`/cgi-bin/%%32%65…/bin/sh`、`/hello.world`、`/test.hello`，body 是 CVE-2024-4577 的 PHP 后门（内含 `--no-check-certificate`、`curl -sk`）⇒ **外部漏洞扫描器借用这个 UA**，不是游戏。

所以客户端真实流量口径应收窄成两条：**no-UA 1,664 条（`/AppInterface` + `/server/*`，游戏自己）** + **SDK 995 条**。"客户端全都走 HTTPS"这个结论不受影响（游戏那 1,664 条本来就全落在 TLS-only 的 9443 上），但**别再把 147 条当成游戏下载量**。

> 附带一条安全提醒（同 12.5）：这批扫描器能打进我们的日志，正是因为 frps 的公网 443 经 frpc 直转本机 9443，等于把一个 TLS 口挂在公网上。现在 frpc/假服/8081 都已关（12.4），下次起隧道时记得这条。

### 14.5 SDK 登录单独拆开看：它验得更松，而且和主进程是两套独立实现

**结论：B 站 SDK 登录也没有 TLS 校验**，路径和游戏那条（14.3 的 C# 侧）完全不同，值得单独记 —— 因为"不想重定向 SDK 登录"这件事只跟 hosts 版本有关，跟证书无关。

放水的完整装配链（反编译树 `/home/qkzx/sld/slddex/out`，源 1.0.6）：

```
asynchttp/HttpManager.smali:155-160      Scheme("https", new EasySSLSocketFactory(), 0x1bb=443) → SchemeRegistry.register
asynchttp/EasySSLSocketFactory.smali:31  SSLContext.getInstance("TLS")
                                     :55  init(null, [ new EasyX509TrustManager(null) ], null)
asynchttp/EasyX509TrustManager.smali:93  checkServerTrusted(chain, authType):
         if (chain != null && chain.length == 1) { chain[0].checkValidity(); return; }   ← 我们命中这条
         else { chain = EasyX509CertificateTimeless.getTimelessX509CertificatesTimeless(chain);
                委托.checkServerTrusted(chain, null) }                                    ← 先抹掉有效期
         整段 try { … } catch (Exception) { } → :goto_0 return-void                        ← 异常全吞
```

三条要点：

1. **`certs/server.crt` 里只有 1 张证书**（`grep -c "BEGIN CERTIFICATE" server.crt` = 1；node 只传 leaf、不带 CA）⇒ 命中 `chain.length == 1` 那条捷径，**只调 `checkValidity()`，委托的 TrustManager 一次都没被叫**，信任链与主机名两道整体跳过。
2. `EasySSLSocketFactory.smali` 里 **没有 `X509HostnameVerifier` / `SSLParameters` / `AllowAll` 任何一处**（grep 0 命中）→ Apache HC 这条路径根本没装配主机名校验。
3. **没有钉扎**：`okhttp3.CertificatePinner` 在 `com/bsgamesdk`、`gsc`、`com/base` 三个业务包里 **0 处实际使用**，只剩 okhttp 库自己的实现文件。

两套 SDK TLS 栈不要混（UA 就能分清）：

| UA | 条数 | 实现 | 放水方式 |
|---|---|---|---|
| `Mozilla/5.0 BSGameSDK` | 123 | Apache HC + `EasySSLSocketFactory`/`EasyX509TrustManager` | 单证书链只 `checkValidity()`；异常全吞；无 hostname verifier |
| `okhttp/3.12.1` | 872 | 埋点 SDK `com/base/track`、`com/base/trackingdata` 的 `SSLSocketClient` | `checkServerTrusted` 直接 `return-void`；`verify()` 恒真 |

**实测印证 + 时间窗**（这段很重要，因为它同时说明"SDK 流量到假服"是哪一时期的产物）：

| 时间（本机 UTC 时钟） | 事件 |
|---|---|
| 10-05 13:12 | `dl/thrud-hosts.txt` 发布 —— **含** `line1-sdk-*` / `api` / `static` / `gameinfoc` / `vpn`，SDK 被一起重定向 |
| 10-05 15:02:30、15:42:35、16:34:28、16:36:42 | `/api/external/user.token.oauth.login/v3` **4 条**落到假服，Host `line1-sdk-center-login-sh.biligame.net`，body 4,000 B（内含 `apk_sign=a04f5c1d…`、`access_key=…_sh`、`bd_info=…`） |
| 10-05 17:06 | `dl/hosts_sdk_real.txt` 发布 —— 把上面那批 SDK 域名交还真服，此后假服再无 SDK 流量 |

同窗口落进来的其它 SDK 端点：`line1-sdk-app-api` 48、`api.biligame.net` 37、`static.biligame.net` 24、`gameinfoc.biligame.net` 9、`/api/agreement/config` 16、`/sdk-hot-deploy/*/client/config` 16、`/gamesdk/sdkHotConfig_v2.json` 16。也就是说：**这 4 条 login 全部属于"SDK 被一起重定向"的那版 hosts**，换成 `hosts_sdk_real.txt` 后就没再观测过 —— 但两版都不需要装 CA、不需要 hook，因为上面那两套实现本来就不验。

---

## 15. TMP 紫方框 / GBK 字体重打包全过程（10-07 补齐记录；**10-10 落点已由 §16.2 收口、重打包路线已由 §16.6 作废**，本节转为技术留档）

这条线 10-05 只在两张表里各留了一行（§5 的"未彻底解"、§6 的"字体试验"），**四代脚本和真正的卡点全没记**。今天把它从脚本里反向挖出来了，顺便发现根因跟当初写的不是同一件事。

### 15.1 缺的到底是什么（新证据，比旧记录精确得多）

把 `assets/res/abIndex.json` 里 27 条字体相关映射逐条对回 APK（`sld/listing.txt`，源是 1.0.6）：

> **10-10 重基**：同一张表按 1.0.7 APK（`sld107/listing.txt`，37,737 条目）复算，结论不变，数字变成 **`assets/res/data/` 28,344 个 / `assets/bin/Data/` 146 个**（146 这层两代完全一致，且这 146 个都不带 `.ab` 扩展名）；三个大 GBK 字体仍在 `bin/Data/`，大小一字不差（10,467,706 / 6,878,742 / 6,819,254）。`6c4e24` 在 1.0.7 依然 **APK 内 0 命中**。字体实物改从真机 dump 取，见 §16.9。

| 名字 | AB | 安卓包内落点 | PC 纪念版 |
|---|---|---|---|
| `UILanTing_Big_GBK`（传统 `Font`+`Material`+`Texture2D`） | `6c4e24dc…` | **APK 内 0 命中 —— 根本没有** | 5,126,528（`res/data/`） |
| `UILanTing_Big_GBK_SDF`（TMP 字体资产） | `c0055d77…` | `assets/res/data/` 474,741 | 464,684 |
| `UILanTing_Middle_GBK` | `a653e533…` | **`assets/bin/Data/`** 6,819,254 | — |
| `UILanTing_Small_GBK` | `0b493c6e…` | **`assets/bin/Data/`** 6,878,742 | — |
| `UIDaYaSong_Jian_GBK` | `09e2a925…` | **`assets/bin/Data/`** 10,467,706 | — |
| `UILanTing_Middle_GBK_SDF` | `8063ec8a…` | **两处都有且大小不同**：`bin/Data/` 1,088,372 + `res/data/` 458,418 | — |
| 各家 `_SDF_Material_{Shadow,Outline,DropShadow,FavorLight}` | 十余条 | 全在 `assets/res/data/`，11–25 KB | — |

⇒ 三条以前没写下来的事实：**(a)** APK 里 27,877 个 AB 在 `assets/res/data/`，只有 **146 个**在 `assets/bin/Data/`，而那三个大 GBK 字体恰好属于 146 这一族 —— 两个目录**不是镜像**（`8063ec8a` 同名两份、大小不同就是铁证）；**(b)** TMP 那半（`_SDF`）包里全有，**唯一缺的是传统 `Font` AB `6c4e24`**，它属于要下载的 1.x GB 资源；**(c)** `AssetBundleDepData.json`（4,634 条）里 **71 条把 `6c4e24` 列为依赖** → 缺它不是"一个标题字看不清"，是 71 个 UI AB 的依赖空洞。

### 15.2 四代重打包（脚本全在 `/home/qkzx/sld/probe-hometmp/repack/`）

共同的难点：PC 版是 `target_platform=13(Windows)` 序列化的，直接丢给安卓会加载失败；所以每一代都在做同一组动作 —— 换平台标记 / path_id remap / 换一个"安卓实测能加载的壳" / 改 `AssetBundle` manifest 里的 `m_Container` 路径与 bundle id。

| 代 | 脚本 | 做法 |
|---|---|---|
| gen1 | `build.py` → `out/` | 借 `8063ec8a`（安卓 AB）当壳：`rbf.files.clear(); rbf.files[CAB]=inner`、`flags=4`、lz4；PC path_id → 安卓 RAW path_id 逐个 `<q` 字符串替换；新对象 `path_id=10**12` 避免撞号 |
| gen1.5 | `build_big.py` → `out/`（只做大字） | 更省事：只把 `sf._m_target_platform=13` 改了再存 —— **13 就是 Windows，等于没改成安卓**，这代大概率是错的 |
| gen2 | `mk4.py` → `out4/` | 拆两路：三个包内字体走 `GRAFT`（同上嫁接），`6c4e24` 走 `CONVERT`；CAB 名改成官方约定 `CAB-<md5(hash)>` |
| gen3 | `mk5.py` → `out5/` | **理论上最正确的一代**：模板换成 APK 内实测可加载的 `f8dfc3f9 = TestFont_DaGeZiYu220427`（只有 5,913 B），手写 serialized file 对象表（`<qqiI` 表项、`W()` 16 字节对齐、`>Q` 回填 total size），把 PC 的 `Font`/`Material`/`Texture2D` 三块 blob 换进模板并互相对齐 path_id，`new_manifest()` 同时改 `m_Container` 资源路径和 bundle id |

配套：`ufs.py`（手写 UnityFS pack/unpack）、`packmulti.py`（记了官方安卓约定：**首节点 `flags=0x243`、附属 `.resS` 节点 `flags=0`**）、`pack.py`（lz4/none 两档回读 `objs==` 自检）、`merge.py`（PC vs 安卓逐对象 `get_raw_data()` 比对）、`probe_6c4e24dcd86d1a6429f48f65c805a807`（5,917 B 逐字段探针）。

### 15.3 发布出去的到底是哪一代 —— 复现不出来

- `dl/fonts13.zip`（23,240,660 B，md5 `30ecefcfccb416cdad3ce18a5ac0f7f7`，4 条）：`09e2…`=7,782,875 / `0b49…`=5,160,005 / `a653…`=5,157,260 / **`6c4e24…`=5,139,938**；`dl/fonts13_extra.zip`（102,684 B，`c685f3743c2a1efb1cfabd27bbca951e`，2 条：`1b654bf0…`=27,097、`6ab42611…`=75,285）；`sld_data_full.zip`（174 条）里也带了 `thd/res/data/6c4e24…`。
- **但发布品跟 `out/` `out4/` `out5/` 三代产物哪个都不一致**（`6c4e24` 大小：发布 5,139,938 vs out 5,139,523 / out4 5,139,532 / out5 5,139,995；md5 也全不同）⇒ 当时是拿**改过的脚本或临时参数**跑的，现在重跑复现不出发布品。**这是这条线第一个记录缺口，下次要动字体先重新生成并核对。**
- `fonts13_extra.zip` 那 2 条在安卓 1.0.6 的 `abIndex.json` 里**查不到**（只在 PC 版 `res/data/` 有：26,787 / 74,926，我们重打包成 27,097 / 75,285），是靠我们自己合并的 `probe-tmp/{pcres,vmres,newpush,v3push}/CombineAbIndex.json` 补进索引的；**它们的 `mOriginName` 至今没反查出来** —— 第二个缺口。

### 15.4 端侧实机反馈：没有报错，但也确实没收口

9 份客户端日志里跟字体有关的行**只有 3 行**（每份 1 条 + 2 行 traceback），内容是同一条无害警告：

```
The character used for Underline is not available in font asset [UILanTing_Small_GBK_SDF].
TMPro.TMP_Text:GetUnderlineSpecialCharacter(TMP_FontAsset)
```

**没有任何 AB 加载失败记录** —— 所以"我们打包的字体 AB 加载炸了"这一类至少没报错。真正的死结在下面这条。

### 15.5 为什么还没解：落点从没测过（不是打包技术问题）【10-10 已由 §16.2 收口】

免 root 唯一可写的外部覆盖目录是 `files/thd/res/data/`，它镜像的是包内 `assets/res/data/`。而 15.1 已经证明那三个包内 GBK 字体属于 **`assets/bin/Data/` 那 146 个**，`6c4e24` 又是它们的同族兄弟 —— **如果真机上 `6c4e24` 原本也落 `assets/bin/Data/`，那 `res/data/` 里放它根本不参与加载**。

唯一能判定落点的手段是 Frida 探针 `probe-hometmp/hook_check_font.js`（枚举 `files/thd/res{,/data,/Assets,/assets}` 找那 8 个 hash）。它的产物 `pushfont.out` 和 `fontchk/` **都是空的** —— 免 root 时代跑不了 Frida，这个实验**从没做成**。所以紫方框到今天为止是"**落点未知**"，不是"打包不会打"。

**10-10 收口**：这个实验根本不需要 Frida。我们自己的手机日志里就有 `读取外部 …/files/thd/res/CombineAbIndex.json` ×9 和 `dataPath=…/files/thd/` ×35（§16.2），外部 `res/data/` 确认参与加载，"双落点"那一步可以省掉。这一节剩下的价值只有 15.2 四代重打包踩过的坑作为技术留档。

### 15.6 下次怎么收口（按代价从小到大）【10-10：第 1、2 条已被 §16.2/§16.6 取代，第 3 条性价比大幅下降】

1. **零风险双落点**：把同一个 `6c4e24` 同时放 `files/thd/res/data/` 和（若该目录存在镜像）`files/thd/bin/Data/`，成本 = 5 MB 复制，能一次问出"到底读哪个目录"。
2. **判据要可分辨**：挑一个只有 `Big` 里有的字（大标题用字）截图对比，别用"紫方框少没少"当指标 —— 71 个 AB 都依赖它，混着别的字体看不出变化。
3. **§13 改包路线**：直接把 PC 版 `6c4e24` 写进 APK 的 `assets/bin/Data/`（跟三个兄弟同目录），**一步绕开落点问题**；代价是卸载重装清空 `files/`。这也是 §13 说的"内置字体复活"的确切含义。

### 15.7 顺手补的一条迁移漏网（10-07）

`mk5.py` 原本读 `/tmp/tmpl.sf`（= 解出来的 `f8dfc3f9` inner serialized file，11,226 B，md5 `4cb98dafcb26d25d10c7b299db04dd76`），10-06 那次路径搬迁把它漏在 `/tmp` 了 —— 一重启就没了，gen3 会直接废掉。已 `cp -p` 到 `probe-hometmp/repack/tmpl.sf`，并把 `TMPL` 改成随脚本目录解析；`/tmp` 原件保留没动。其余 `/tmp/*.bin`（`ppatch.py` / `ppatch2.py` / `ufs.py` / `nullshader.py` / `miss13/convert.py`）都是**运行期输出**、不是输入，不用搬。

⚠ 跑 gen3 前记得 **`cd` 到 `repack/` 再跑**：`mk5.py` 的 `OUT='out5/'` 是相对路径，在别的 cwd 跑会在那儿新建一个空的 `out5/`，很容易把"产物"和"发布品"再次搞混（15.3 那个缺口大概率就是这么来的）。

---

## 16. 真机完整资源 dump + 索引基线定案（10-10）

这一节把 §15 的"落点未知"关掉、把 §9 待办 #2 判死，并且给出一条比"手动复制"更正的资源投递路线。所有数字都是本轮脚本实测，脚本留在 `/tmp/{kvldiff,buckets2,closure2,audio,idxcheck}.py`（逻辑已抄进本节，重跑要照本节重建）。

### 16.1 这批东西是哪来的 —— 不是 1.0.7

`/home/qkzx/sld/phone/` = 某台真机 `/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/` 的完整解压：**10,560 文件 + 36 目录 = 10,596 个 zip 条目，6.20 GB**，`extract.out` 0 字节（解压零告警）。

它**不是** 1.0.7 的设备。`files/clientLog/`（162 份）里：

- `skipAPI?os=android&appVersion=1428` × 706
- `getClientUpdateData?os=android&appVersion=1428&resVersion=1583&sdkType=2&channelId=bili_uo_17&platformUID=2023081817244800700000` × 178
- `forceUpdateUrl` = `https://storedl.nearme.com.cn/apk/202311-21-35c463b717890fcbf67f93c289e2524f.apk` × 136（当时在强制更新循环里）

⇒ 造包设备是 **OPPO 联运渠道的 1428 包**（`sdkType=2 / channelId=bili_uo_17`）。而我们的手机（`/home/qkzx/sld/Thrud2026_10_0*.log` 9 份）是 `appVersion=1426 & sdkType=1 & channelId=bili_1` = **B站官渠 1.0.7**。两套渠道包，同一套 CDN 资源。

热更链 12 跳，日志实测：`1426 → 1486 → 1489 → 1507 → 1523 → 1548 → 1560 → 1562 → 1567 → 1570 → 1572 → 1574 → 1583`。冷启动那份是 `Thrud2023_12_01_18_12_47.log`（34,441 行），一次下 5,624 个文件，日志停在 `1588 / 5624` —— **这台设备自己是半成品**。

`il2cpp/Metadata/global-metadata.dat` = 7,637,236 B、**加密**（头 `94 43 72 12 …fgff`），APK 内那份 7,625,500 B，前 12 字节相同 ⇒ 元数据本身也是可热更对象，**这条以前没记录过**。

### 16.2 落点：§15.5 结束

我们本机 9 份日志，每份都有：

| 计数 | 内容 |
|---|---|
| 35× | `dataPath = /storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/` |
| 35× | `streamingPath = jar:file:///data/app/com.wth.thrud.bilibili-XujxrvGPf-aytGY6Ld7G-Q==/base.apk!/assets/` |
| **9×** | `读取外部 …/files/thd/res/CombineAbIndex.json`、`CombineAssetBundleDepData.json`、`CombineShaderFindData.json` |
| 0× | `读取外部 …/toLua/toluaLoader` |

⇒ **外部 `files/thd/res/data/` 参与加载，落点已实测**，§15.5 那套"可能落 `bin/Data/` 所以 `res/data/` 不生效"的顾虑关闭；§15.1 的"两个目录不是镜像"同时得到印证（1.0.7 APK：`assets/res/data/` 28,344 个、`assets/bin/Data/` 只有 146 个）。

⇒ 一条新推论（重要）：APK 里**只有** `assets/res/abIndex.json` 和 `assets/res/CombineShaderFindData.json`，**没有** `res/CombineAbIndex.json` / `res/CombineAssetBundleDepData.json`。而本机外部目录里这两个存在且每次启动被读，假服又从没供过（见 16.7：`resVersion` 相等 → 一次下载都没触发）。唯一解释是 **客户端自己把包内索引与外部索引合并成 `Combine*` 写到外部** —— 外部 `res/` 是**合并层**，不是只读缓存。这条是 16.5 "能不能改指" 的基础。

⇒ 反过来，`0× toLua/toluaLoader` **不能**推"外部 Lua 覆盖不生效"：也可能只是那目录当时不存在，所以那行压根不打。§15/§16 一直按"未验"处理（16.8）。

本机日志里与资源无关的存量报错：590× `Kernel 'KGenLut3D_AcesTonemap' not found`、14× `Sound Event not found`、1× `Failed to load 'archive:/CAB-4e0590c7…/CAB-4e0590c7….resS'`。这三类**不是**复制资源能解决的。

### 16.3 `kvl` 是明文台账（并顺手加强 §8 那一行）

格式：`ResVersion : 1426 : System.Int32 ; BuildVersion : 1426 : System.Int32 ; <路径> : <md5> : System.String ; …`

| 台账 | 大小 | 条数 | ResVer | AppVer | 备注 |
|---|---|---|---|---|---|
| 1.0.7 APK `assets/kvl.kvl` | 3,676,360 | 36,589 | 1426 | — | md5 `195387ea53a1d632517641edb85d8b38` |
| 真机 `thd/newkvl.kvl` | 3,676,360 | 36,589 | 1426 | — | **与 APK 逐字节相同**；`thd_repair/kvl.kvl` 亦相同 |
| 真机 `thd/kvl.kvl` | 4,508,995 | 44,841 | 1583 | 1428 | 热更后台账 |

- 逐文件对盘（`thd/kvl.kvl` vs 磁盘实物）：**10,231 匹配 / 0 失配 / 34,610 条无实物**。
- **加强而非推翻 §8**：md5 登记的是**落盘原文**（外部 `toLua/Data/*` 仍是 XOR 密文），md5 全中恰恰证明"拿 kvl 的 md5 当明文 oracle 反推 Lua 密钥"无效。当年错的只是"kvl 本身是密文"这个附带印象 —— 它是纯文本。
- 台账差集：`1336→1426` = +1,612 / −702 / 1,523 变；`1426→1583` = **+8,252 / −0 / 1,973 变** ⇒ 路径层面 **1583 是 1426 的严格超集**，覆盖不会删文件，只会**顶掉 1,973 个版本**。那 1,973 个的分布：`toLua/Data` 837、`fightLua/Data` 551、`res/data` 437、`media/audio` 143，外加 `abIndex.json`、`AssetBundleDepData.json`、`CombineShaderFindData.json`、`toluaLoader`、`fightluaLoader` 各 1。清单已导出到 `offline/sld/kvl-1426-vs-1583-changed.txt` 与 `kvl-1583-only.txt`。

### 16.4 6.32 GB 全量分桶 —— "全部复制替换"为什么不划算

10,390 个文件 / 6,321.6 MB（不含两个 kvl）。逐文件按"两版索引 + 两版台账 + APK 是否自带"分类：

| 桶 | 文件 | 体积 | 判断 |
|---|---|---|---|
| **① `res/data`：1426 abIndex 引用 & APK 没带** | **622** | **966.6 MB** | **1.0.7 唯一真缺口**；622/622 dump 都有，md5 精确等于 1583 台账，且 **0/622 在 1426 台账里** ⇒ 零版本冲突 |
| `media/video/*.usm` | 157 | 2,933.4 MB | **全部只在 1583 台账**。1426 台账 `media/video` 只有 **2 条**（`necessary/{h264,vp9}/Season01_PV.usm`），而 APK 自带这 2 个（67 MB + 48 MB）⇒ **1.0.7 没有视频缺口** |
| `res/data`：仅 1583 台账 | 5,085 | 1,886.3 MB | 两版 abIndex 都不引用 1.0.7 需要的东西 |
| `media/audio`：仅 1583 | 966 | 225.9 MB | 同上 |
| `cdnTextures/{activity,bili_uo}` | 156 | 152.6 MB | **两版台账都没登记** ⇒ 运行时缓存图（活动 + 联运渠道），不是热更资源，复制无意义 |
| `toLua/Data`：1426 已登记 | 837 | 53.5 MB | 正是"变过"的那 837 个 ⇒ 复制=顶版本，不是补缺 |
| `toLua/Data`：仅 1583 | 1,060 | 32.5 MB | 用不到 |
| ② `res/data`：1426 索引要 & APK 已自带 | 178 | 30.1 MB | 纯重复 |
| ④ 两版台账都有、两版 abIndex 都不引用 | 265 | 16.0 MB | 边角 |
| `media/audio`：1426 已登记 | 143 | 6.1 MB | 也在"变过"名单里 |
| `fightLua/Data` | 1,467 | 8.4 MB | 837/551 同理 |
| `res/*.json` 索引 5 个 | 5 | 9.9 MB | **明确不能复制**（见下） |
| `BtnLayout/`、`Chat/200173153/` | 3 | <0.1 MB | 那台设备的本地账号数据 |

全量替换会把 6 个索引一起顶成 1583 版：`kvl` 3,676,360→4,508,995、`abIndex` 421,441/5,000 条→499,803/5,925 条、`AssetBundleDepData` 389,594→449,065、`CombineShaderFindData` 16,269→16,991，并新增 APK 没有的 `CombineAbIndex.json` 3,253,033、`CombineAssetBundleDepData.json` 6,134,694。而**索引和实物不自洽**：1583 台账 44,841 条只有 10,231 个实物（缺 77%）、1583 abIndex 5,925 条只有 1,750 个实物（缺 70.5%）。后果：`CheckCover` 逐条比 md5 → 缺 34,610 + 1,973 不符 → 进 `ShowHotUpdateUI` 索要 34,610 个文件 → 假服没有 → **把已经打通的大厅换成热更卡死**。所以 **15.6 第 1 条"双落点"和"全量复制"两个方案一起作废**，只走白名单。

### 16.5 索引基线：现在发的是 PC/1.0.6 口径，该换成安卓 1426

`config.js:30-31` + `http.js:158` 目前把 `manifests/kvl.kvl`（**ResVersion 1336 / BuildVersion 1338**）和 `manifests/abIndex.json`（**4,741 条**）发给一个 `BuildVersion=1426` 的客户端。实测索引差：

```
1.0.7 APK abIndex − 1.0.6 live abIndex = 271 条   ← 1.0.6 口径漏掉的
1.0.6 live − 1.0.7 APK                  = 12 条   ← 已废弃
条目数  live/1.0.6 = 4,741 | 1.0.7 APK = 5,000 | dump 1583 = 5,925
```

安卓原版 1.0.7 索引已整套导出到 **`offline/sld/manifests-1.0.7/`**（`kvl.kvl 195387ea`、`abIndex.json 1f9ed398`、`AssetBundleDepData.json ccedbc9d` 4,886、`ShaderFindData.json`、`CombineShaderFindData.json`、`toluaLoader` 3,397、`fightluaLoader` 1,589，见同目录 `MANIFEST.md5`）。**live `manifests/` 本轮没动**。切换动作 = 两个环境变量 `SLD_KVL` / `SLD_ABINDEX` 指过去（或直接改 `config.js`）。

顺带：`6c4e24` 在 1426 台账里**不存在**，最早出现在 1489 的 `cdn_file_list_h264` 里，却**被 1.0.7 的 abIndex 引用**（71 个 AB 依赖它那条结论不变）。⇒ 官方 1426 自己也是"索引指向、实物没有"，紫方框不是我们造成的，也不是打包技术问题 —— 是 APK 精简 + 资源没落盘。

### 16.6 待办 #2（618 个 PC-only 包批量转换）作废

`probe-tmp/missing107.json` 是 `[hash, mOriginName, False]` × 618。按 hash 名与 1.0.7 安卓 abIndex 对：

- **597 条 hash 本来就在安卓索引里** —— 命名没错，缺的是文件；
- **21 条是纯 PC 纪念版命名**（如 `b42ea40ae3b3…`=`UIItemIcon_256_Sprite`、`5a6f3b186b75…`=`UIPropsIcon_Sprite`），1.0.7 安卓索引里根本没有这些 hash；
- 对这 21 条按 `mOriginName` 反查 1.0.7 安卓索引 ⇒ **21/21 都有同名安卓条目，且全部已在 622 清单里、dump 里有实物**（`UIItemIcon_256_Sprite` 的安卓名是 `0e2e6fba704d…`，三套索引都有；`UIPropsIcon_Sprite` 是 `28aa3da4126f…`）。
- 622 全部是**安卓原生实物**，不需要换平台。

⇒ **`miss13/convert.py`、gen1（借 `8063ec8a` 换壳）、gen3（`mk5.py` + `tmpl.sf`）、UnityPy 换 `target_platform`、PC→安卓 `path_id` remap 整条路线停止投入。** 之前 `shard 0 500` 卡在 `ok=2/618`，不是转换难度，是方向错。

真正补不上的只剩 **2 个**：`UI_Lottery_zuoyide`（`1be54bca2603…`）、`UI_role_zuoyide`（`9e9768c3354d…`）—— 1.0.7 索引引用，但 1583 安卓索引和 dump 里都没有 = **未上线角色**，官方也没投过 CDN。

### 16.7 热更下载通道已经在假服手里（比手动复制更正的路线）

本机日志里收到的回包（假服 `data/getclientupdatedata.json`）：

```
SendResVersionUpdateRequest>>>>> success {"appVersion":"1426","resVersion":"1426",
  "forceUpdateUrl":"","hotUpdateUrls":["https://le1-prod-bili-api-thrud.bilibiligame.net"]}
```

`resVersion 1426` == 本机 1426 ⇒ 客户端判"无需热更"，**一次都没去要清单**。这就是开关。而 dump 日志把投递协议钉死了：

```
18:12:58:659   1 / 5624    res/data/19e308f175103394f93e6af5f1b14aab
18:12:58:792   3 / 5624    res/data/b82f67b65e812d744bfcbd381566c0f6.ab
18:12:59:099   7 / 5624    media/audio/GeneratedSoundBanks/Android/429358166.wem
```

⇒ `cdn_file_list_h264` = **一行一个相对路径**；单文件 URL = `hotUpdateUrls[0] + <目标resVersion> + "/" + <路径>`；下完客户端**自己写 `kvl`、自己生成 `Combine*`**。走这条路，索引/实物/台账由客户端自己维护 ⇒ 天然自洽，不会出 16.4 那种 1,973 个 md5 冲突。

要改的三处：

1. `data/getclientupdatedata.json` 的 `resVersion` 抬到比本机高（1427）。
2. `hotUpdateUrls` 补成带路径段+尾斜杠 `["…/android/update/"]`。官方值是 `https://l1-prod-patch-thrud.bilibiligame.net//android/update/`，拼接是**裸字符串相加**；现在是裸域名，一抬 `resVersion` 就会拼成 `…bilibiligame.net1427/…`，主机名直接废。
3. `src/http.js` 加 `/android/update/<ver>/cdn_file_list_h264` 与 `/android/update/<ver>/<路径>` 路由。现有假 CDN 只吃 `^/(res|assets|download|cdn)/(.+)$`（`http.js:78`，从 `data/www` 给文件，骨架已就绪；`data/www` 目前只有 `sld_fix.zip` 225 MB）。

官方侧已确认拿不到：`l1/l3-prod-patch-thrud`、`le1/l1/l2-prod-{bili,uo}-api-thrud.bilibiligame.net` **DNS 全部无法解析**（`/etc/hosts` 里没有 thrud 条目，是真死不是被劫持）；`storedl.nearme.com.cn` 12 s 超时。⇒ 缺的 34,610 个文件永久拿不到，只能玩 10,231 个实物的子集。

### 16.8 "把 1.0.7 指向 1583 资源" —— 两关已过，卡在第三关

| 关 | 实测 | 结论 |
|---|---|---|
| 序列化格式 | APK 1426 AB / 622 需补 AB / 1583 新增 AB，9 个样本全 `serializationVersion=22` + `2021.3.18f1` | **能读**，无格式壁垒 |
| 依赖闭包 | 1583 `AssetBundleDepData` 5,795 条：只看 dump 实物断链 129；把 APK 自带 28,344 个算进来 ⇒ **0 断链** | **拼起来完整** |
| 谁来引用 | AB 是被配置表 + Lua 按资源名 `LoadAsset` 拉起的。1426 的表里没有 1428 的新内容条目；新角色的 `MonoScript` 类不在 1426 的 IL2CPP 元数据里 | **指了也不出现**，prefab 出来是 missing script 空壳 |

所以：**方向要反过来** —— 622 个不需要"指"，1426 索引**已经**指着它们（这正是紫方框的成因），缺的只是文件；5,085 个 1583-only AB 就算换索引也没有调用方。要让 1583 内容真出现，前提是 **1428 客户端**，而那是 OPPO 渠道包（`sdkType=2`），登录体系会从 B站 SDK 变成 OPPO 账号 SDK —— 和"不动 B站 SDK 登录"直接冲突，属用户决策项。

### 16.9 本轮顺带拿到的两批知识

- **Lua 批量解密**：`sld/phone/luaplain/{toLua,fightLua}` = 2,808 个明文 chunk（`bytes(b ^ K[i%8])`，`K=89 67 45 23 01 ef cd ab`）。
- **protobuf 全量还原**（关掉 §9 待办 #1 的知识半区）：`sld/phone/msg.proto`（123,196 B，337 message / 15 enum，`package msg; java_package='com.server.logic.socket.netmsg'`）与 `other.proto`（39,754 B，264 message，`import 'msg.proto'`），由 `luaplain/toLua/5a889dc8…`（4,154 行）和 `…/1ced4949…` 里的 `protoStr` 重建。以前缺的三处全在里面：`PacketBodyInfo{header=1,bodyBytes=2}`（`msg.proto:39`）、`ReturnPackageInfo{packetUUid=1,bodyInfo=2,packetBodyInfoS=3}`（`:46-49`）、`ElementRuinsLevelInfoGroup{id=1,remainCount=2,levelInfos=3,endTime=4}`（`:2834`）/`ElementRuinsLevelInfo{id=1,state=2}`（`:2843`）、`GetRogueInfoListPage_S2C{rogueLike=1}`。样例 payload 在 `luaplain/toLua/65c1606c…:18-70`（4 组 × 5 关，`remainCount=5`，与 §9 推的 `dailyChance=5` 对得上）。
- 字体 AB 实物到位：`thd/res/data/6c4e24…` = 5,126,528 B / md5 `1e2796fa0cde84f3a7c98d23e1e0c832`，解开后 flags `0x243`、sf 6,709,112、`CAB-703189fbb7a48d3ccdb107f1fadcb2df`、对象 `Font+AssetBundle+Material+Texture2D`、内嵌 TTF 6,704,076 B（`00 01 00 00 00 11 01 00`，17 张表）、`m_Name=UILanTing_Big_GBK`。与我们 gen 产物（sf 6,709,126）**只差 14 字节 = 路径串** ⇒ 15.2 那条"重打包方向是对的"得到确认，但现在直接用官方实物即可。
- **一条以前没注意到的事实**：那三个大 GBK 字体在**外部 `res/data/` 也有一份，且和 APK 内 `bin/Data/` 的那份不是同一个东西**：
  | 名字 | APK `bin/Data/` | dump `res/data/` |
  |---|---|---|
  | `09e2a925` `UIDaYaSong_Jian_GBK` | 10,467,706 | 7,758,431 |
  | `0b493c6e` `UILanTing_Small_GBK` | 6,878,742 | 5,147,788 |
  | `a653e533` `UILanTing_Middle_GBK` | 6,819,254 | 5,144,397 |
  ⇒ 官方 CDN 给这三个也发了 `res/data/` 变体（md5 与 1583 台账一致）。"两个目录不是镜像"从推论升级成实例。`dl/thrud-font-fix-1426.zip` 里 4 个文件全按外部口径打，落点统一 `files/thd/res/data/`。
- 交付物：`offline/sld/dl/thrud-font-fix-1426.zip`（23,181,735 B，md5 `48d7fe28cfa5db9e43b20e7867f21aa7`，`zip -0 -X`，6 条目，`unzip -t` 干净）；`dl/thrud-missing-ab-list.txt` 已重基到 1.0.7（622 条 / 966.6 MB）；暂存区 `sld/phone/push_pkg/`。
- ⚠ PC 版那份 `6c4e24` 大小 ±1-2 B 但 md5 是 `d2dcd421…` —— **不要用**（`res/data/` 只有 PC 命名族）。

### 16.10 下一步（按性价比）

1. `SLD_KVL` / `SLD_ABINDEX` 切到 `manifests-1.0.7/`（16.5）。纯收益，无冲突。
2. 622 个安卓实物投递（966.6 MB）：假 CDN（16.7，客户端自己下自己记账）或 adb push。
3. 跑一条命令定性 16.2 那两个未决问题：
   `adb shell ls -l /storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/ /storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/res/`
   —— 看 `res/` 里 `CombineAbIndex.json` 是否存在（定"合并层"）、顶层有没有 `toLua/`（定外部 Lua 那条日志能不能算证据）。
4. §9 待办 #2 删除、#4 改判为"复制官方安卓实物，不再重打包"。

