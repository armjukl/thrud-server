> ⚠️ **已归档（老文档）** · 最后更新：2026-10-06 · 当前方案见 [`docs/README.md`](../README.md)
>
> 本文写作时的口径可能已过时（路径、结论、结论所依赖的文件位置都变了），仅作历史记录。

# Thrud（sld）离线假服务端 · 静态分析报告 + 雏形

样本：`/home/qkzx/sld_1.0.6.1338_20230926_061320_5fb48.apk`（1.88 GB，包名 `com.wth.thrud.bilibili`，Bilibili 渠道，构建 2023-09-26，`resVersion=1336 / buildVersion=1338`）
工作目录全部在 `/home/qkzx/sld/sld/`，**未向游戏目录写入任何文件**，APK 只读。

---

## 0. 结论速览

| 项目 | 结论 | 证据强度 |
|---|---|---|
| 引擎/运行时 | Unity **2021.3.18f1** + IL2CPP（metadata v29），ARM64 | 已确证 |
| 资源层（美术/UI/场景/音频） | **`res/data` 的 27877 个 AssetBundle 全是明文 UnityFS**，UnityPy 可直接解析；逻辑名→哈希名的表 `abIndex.json` 也是明文 | 已确证（实测解包成功） |
| 资源清单 | `assets/kvl.kvl` 明文，**35679 条** `路径 : md5 : System.String`，字段 2 = **存储字节的 md5**（抽检 300/300 命中）→ 完整文件清单 + 校验值 | 已确证 |
| 逻辑代码 | `toLua/`（3198 个文件）+ `fightLua/`（1472 个）**共 4670 个数据文件是密文**（两份 `*Loader` 清单是明文），这是 APK 里唯一被加密的资源类别 | 已确证 |
| chunk 加密 | **未破解**。已定性：按打包批次共享密钥流（同批 912/913 个文件共享前 74 字节），逐字节位置相关（非分组密码），密钥需运行时提取 | 结构已刻画，算法未定 |
| 网络传输 | **Mirror 的 kcp2k**（KCP over UDP），段头 24 字节小端；metadata 里含 kcp2k 原版 Inspector 文案与 `mirror-networking.gitbook.io/docs/transports/kcp-transport` 链接 | 已确证 |
| 消息编码 | **protobuf**，且由 Lua 驱动：C 库 `liblua54.so` 导出 `luaopen_pb*`，另有 `ProtocolParserLua`、`RegToCoreMsgId`、`CMsgHeaders`、`_InitMsgHeaderRule` | 组件已确证，字段表未知 |
| 加密信道 | KCP 之上还有一层 **AES + RSA 认证传输**（`AESKeySize/AESSaltLen/AESOverheadSize/AESAuthCode/AUTH_CODE_LENGTH/Challenge/ChallengeResponse/ProcessAuthentication`）→ **这是最大阻碍** | 已确证存在，参数未知 |
| 登录链路 | Bilibili SDK（`license.txt` 为 B 站服务条款、`supplierconfig.json` 渠道表）→ HTTP 换 token → 服务器列表 → KCP 网关 | 部分确证 |
| 真实服务器 | `thrud-dev.accessgames.com:8005`（开发服地址残留在 metadata 字符串里） | 已确证（字符串） |
| il2cpp 全量反编译 | **失败**。`libil2cpp.so` 被加固：独立可执行段 `il2cpp`（24 MB）与 `.text`（3 MB）分离，`DT_INIT` 落在 `.text` 之外，Il2CppDumper 在 `Il2Cpp.Init:232` 抛 `OverflowException`（"This file may be protected"） | 已确证是阻碍 |
| 离线可玩性判断 | **中等偏难**：资源/协议/传输三块都能落地，卡在"Lua 逻辑 + 认证信道"这一对连环锁上——逻辑在密文里，密文的解法也在密文里 | 判断 |

一句话：**这作比 qkzx2025 难缠得多。** qkzx 是"HTTP + 长度前缀 TCP 帧"，明文可直接伪造；sld 是"KCP + protobuf + AES 认证信道 + Lua 侧协议表"，而 Lua 全加密。可行路线是先破 Lua（frida 取密钥），不是继续盲推密码学。

---

## 1. 已解决的一块：global-metadata.dat 的页旋转 XOR

`global-metadata.dat`（7,625,500 字节）magic 正确但 Il2CppDumper 报 `IndexOutOfRangeException`。原因是**按 4 KiB 页做条件 XOR**：

```
XOR 值     = 0x66
页大小     = 0x1000
加密判定   = (绝对偏移 / 0x1000) % 16 ∈ {1, 2, 3, 4}   # 每 16 页里轮转 4 页
```

复现（已验证）：

```bash
cd /home/qkzx/sld/sld
/home/tmp/venv/bin/python offline-server/tools/meta_decrypt.py \
    meta_fix/global-metadata.dat dump_sld/m_dec.dat
# written dump_sld/m_dec.dat 7625500
# metadata version = 29
#   stringLiteral      256      / 133648
#   stringLiteralData  133904   / 437236
#   string             571140   / 1188640
#   events             1759780  / 2184
#   properties         1761964  / 183460
#   methods            1945424  / 2033344
```

解密后的元数据可以直接跑 Il2CppDumper 的 metadata 阶段（`DOTNET_ROLL_FORWARD=LatestMajor` 绕开本机只有 .NET 8 的问题）：

```bash
DOTNET_ROLL_FORWARD=LatestMajor /home/tmp/tools/Il2CppDumper/Il2CppDumper \
    so/lib/arm64-v8a/libil2cpp.so meta_fix/m_dec.dat dump_out/
# Metadata Version: 29   ← 已过
# Il2Cpp.Init:232 OverflowException（rgctxsCount 溢出）← 卡在 so 侧加固
```

Il2CppInspector 2021.1 也不支持 v29（`not of a supported version (29)`），需要 2023+ 版或自定义脚本。

---

## 2. 客户端构成

| 层 | 内容 |
|---|---|
| 脚本 VM | **双 VM**：`libtolua.so`（LuaJIT/ToLua，路径残留 `F:\thrudNew\Client\Tool\nlua\tolua\android`）+ `liblua54.so`（Lua 5.4，NLua 侧）。对应 `toLua/`（游戏逻辑）与 `fightLua/`（战斗）两个包目录，由明文清单 `assets/toLua/toluaLoader`、`assets/fightLua/fightluaLoader` 列出 32 位哈希名 |
| 消息 | `pb`（protobuf C 扩展，导出 `luaopen_pb`、`luaopen_pbWrap`、`lpb_newslice54`、`luaopen_pb_{buffer,conv,io,slice,unsafe}`）；`ThdMsg`、`CMsgHeaders`、`msg.header`/`msg.data.Length` 调试串 |
| 传输 | kcp2k（`KcpClient/KcpServer/KcpConnection/KcpChannel/KcpHeader/KcpTransport/CreateKcpChannelV3/ThrudKcpV2/GetNewKcpCommandForToLuaV3`），另有 `UdpMessageHeader` |
| 门面 | `THDNetwork`、`THDNetworkUtil`、`THD_NetworkManagerWrap`、`THD_NetworkManager_HttpPostCallBack`、`set_StartLoginForLua`、`isSDKLogined` |
| 渠道/风控 | Bilibili SDK；同时存在 `libtersafe2/libsecsdk/libtprt/libshadowhook/libandfix/libmumu-jni`（TP 加固 + 反调试 + MuMu 检测） |
| 完整性 | `assets/__tpinfo.{tsd,tsc,tp,tsa}`、`tpginf.dat`、`zlsioh.dat` —— 加固壳的文件哈希表；**热更/patch 校验走 `kvl.kvl` 的 md5** |

---

## 3. 好消息：资源层完全可离线

实测：`res/data` 下 **27877 个 .ab 全部以 `UnityFS` 开头**，UnityPy 正常解析（样例：`AssetBundle + Material`）。`media/audio` 的 3113 个 `.wem` + 10 个 `.bnk` 是 FMOD 明文。`abIndex.json` 提供 4741 条 `mOriginName → mAbName` 逻辑名映射，`kvl.kvl` 提供全量清单与校验值。

```bash
# 导出 35679 个文件 + manifest.json（1.84 GiB，本目录 data/www/）
/home/tmp/venv/bin/python tools/extract_res.py --names
/home/tmp/venv/bin/python tools/extract_res.py --only res/data --dry-run
```

也就是说：**除了 Lua 逻辑，整个客户端的皮、场景、音都能直接拿**（随机抽 250 个 `res/data/*.ab`，UnityPy 解析 0 失败）。假 CDN 也已经能用（`/res/<path>` 从 `data/www` 吐文件）。

但别把"资源齐了"当成"数据齐了"，两件事实测过：

* **数值表基本不在这个明文层里**：抽样的 250 个 bundle 只有 3 个带 TextAsset，其中 `excel_txt_utf8`（1353B → 916B 文本）解出来是中文 UI 文案而不是表。表要么在 MonoBehaviour 里（自定义导出格式），要么在**密文 toLua 包**/热更下载里 → 破 Lua 的收益不止协议。
* **包内资源是不完整的**：`abIndex.json` 4740 个逻辑名里 **581 个在 APK 里没有对应文件**（`UIPatrolPrepare`、`bg_ranking_scene` 等，属下载资源）；反过来 27877 个 `res/data` 文件里有 **23718 个不在 abIndex 里**（只按哈希被引用，引用方大概率就是加密的 Lua）。另外同一份资源有两种命名：带 `.ab` 和不带扩展名，`extract_res.py` 两种都会找。


---

## 4. 通信层还原

### 4.1 KCP 段（已按 kcp2k/ikcp 实现并自测）

一个 UDP 数据报 = N 个段，每段 24 字节头 + payload，**全小端**：

```
+0  conv u32 | +4 cmd u8 | +5 frg u8 | +6 wnd u16 | +8 ts u32 | +12 sn u32 | +16 una u32 | +20 len u32
cmd: 81=PUSH 82=ACK 83=WASK 84=WAS（kcp2k 另有 0..3 控制命令）
```

`src/kcp.js` 实现了段编解码 + 最小可靠服务端（乱序重排、按 sn 有序交付、逐个 ACK、超时重传）。真实端口来自残留的 `thrud-dev.accessgames.com:8005`，本地默认 **9005**（HTTP 与 UDP 同端口号，便于 hosts 一把指）。

### 4.2 消息帧（**未确证，规则驱动**）

metadata 里的 `_InitMsgHeaderRule` / `CMsgHeaders` / `UdpMessageHeader` 说明**头格式本身是运行时可配置的**。所以 `src/framing.js` 不做硬编码，而是读 `data/header-rule.json`（字段名/偏移/宽度/字节序），没有规则文件时用 6 个候选布局试探并"连续框住两条才锁定"，锁不上就把原始字节落盘。这样抓到一个真包就能立刻改规则、不用改代码。

### 4.3 最大阻碍：KCP 之上的认证/加密信道

```
AESKeySize  AESOverheadSize  AESSaltLen  AESEncryptionStrength  AESAuthCode  AUTH_CODE_LENGTH
ENCRYPT_BLOCK  Challenge  ChallengeResponse  <ProcessAuthentication>d__48  FromXmlString/ToXmlString <RSAKeyValue>
```

这组常量与 **Mirror 社区加密组件（RSA 交换 AES 会话密钥 + AES-CBC + HMAC + challenge/response）** 的字段名完全一致。含义很直接：

* 假服务端光会讲 KCP 不够，还要完成 RSA/AES 握手；
* 客户端里只有**公钥**（且没在明文资源里找到密钥串，可能在密文 Lua 或 IL2CPP 静态数据里）；
* 因此要么拿到/换掉客户端的密钥材料，要么 hook 掉这层 `ProcessAuthentication`。

**这是本项目的第一优先攻克点**，比破 Lua 更前置（Lua 拿到也只是知道协议，信道不过去连不上）。

---

## 5. 未解决：toLua / fightLua 的 chunk 加密（已定性）

探针：`tools/lua_probe.py groups|crib|decrypt`。目前刻出的特征：

| 观察 | 数据 |
|---|---|
| 批次分组 | 按密文前 4 字节分 **62 组**，最大组 1000 个文件；按前 16 字节分 333 组，最大组 **913 个文件** |
| 组内共享 | 最大组里 **912/913 个文件的前 74 字节完全相同**；`fightLua` 的头 8 字节 `a44a682e0bc2e086` 与 `toLua` 最大组一致 → **同一批次共用一份密钥流** |
| 位置方差 | 组内 0..73 恒定，74 起几乎全变（与"明文头 74 字节 + 之后是各自数据"一致） |
| 非分组密码 | 同组内出现**仅差 1 个字节的 8 字节块**（`fb082860 6e9da883` vs `…89`），ECB/CBC 的雪崩效应不可能 → **流式/逐字节位置相关** |
| 非短周期 | 前 74 字节内部无 8/16/32 自重复 → 密钥流不是短周期重复 XOR |
| 不是纯随机 | 单文件字节直方图 256 值近似平坦，但**跨文件同位置字母表极小**（pos 0 只有 17 种取值/3194 文件）→ 头/结构高度相关，符合"同一密钥流 + 高度同构的明文头" |
| 两两相关 | 同组任意两文件前 4000 字节一致率 5–8%，异组 3%，随机基线 0.4% |
| 无完全重复文件 | 3196 个文件去重后仍 3196 |
| 校验值不可用 | `kvl.kvl` 的 md5 是**密文**的 md5（300/300 验证），不是明文 oracle，无法用来离线验证密钥 |

被否证的假设（都留了脚本，别再走一遍）：单字节 XOR；8 字节重复 XOR；仅头 34 字节替换；zlib/lzma@0..64；RC4（12 万候选 key）；md5/sha 路径命名；"38 字节前缀 + UnityFS 头"（用 `C[s+30:s+38] ^ BE64(len)` 一致性检验，8 字节 0 命中）；"UnityFS 明文头在 64..260 任意偏移 + 组内共享密钥流"（滑窗 crib，4 个最大组全 0 命中）。

**结论：继续静态盲推的期望收益已经低于动手取密钥的成本。**

---

## 6. 下一步：一次性拿到 Lua 明文与信道参数的路线

按性价比排序，全部在 `/home/qkzx/sld/sld/` 下操作，改的是副本不是原 APK。

1. **frida 抓 Lua 明文**（最推荐，一台 root 机/模拟器即可）
   ```bash
   # 只要 VM 侧不加密, 这两处就能直接捞到 chunk 明文 + 反推密钥
   frida -U -f com.wth.thrud.bilibili -l hook_lua.js
   # hook: lua_load / luaL_loadbufferx / luaL_newstate (liblua54.so, libtolua.so)
   #       AssetBundle.LoadFromMemory / .LoadFromFile (IL2CPP)
   #       UnityPy 侧: 先 dump 一个 chunk, 与密文对齐即可反解出该批次密钥流前 N 字节
   ```
   拿到一个明文 chunk 后，`tools/lua_probe.py crib` 就能立刻反解组内密钥流并验证是否共享。
2. **frida 抓网络**（与上一步同一次运行）
   `System.Security.Cryptography.Aes`/`RSA` 的 `TransformFinalBlock`、`kcp2k.KcpPeer.ServerHandshake/ClientHandshake`、`socket.sendto` → 直接得到 conv/握手/帧头/AES 参数。
3. **Il2CppInspector 新版或自写 dumper**：metadata 已明文，只差跨过 `libil2cpp.so` 的注册表混淆（`il2cpp` 独立段 + 假 `DT_INIT`）。运行时 `frida + il2cpp-dump 脚本（如 Il2CppDumper 配合 dump 后的 so）`或 `frida_scripts_for_unity/il2cpp` 系列可直接在内存里遍历 `Il2CppClass`。
4. **抓包**：KCP 是 UDP，`tcpdump -i any udp port 8005 -w sld.pcap` + 上面对 `sendto` 的 hook，比中间人代理省事（Bilibili SDK 的 HTTPS 才需要代理）。

---

## 7. 雏形怎么用

```
src/config.js    端口/路径/服务器身份/KCP 参数（真实 8005 → 本地默认 9005）
src/log.js       分级日志 + 报文落盘（data/logs/server.log, data/capture/*.bin）
src/kcp.js       KCP 24 字节段编解码 + 最小可靠会话（有序/ACK/重传）
src/framing.js   规则驱动框帧 + 6 候选自动试探 + 解不动就存原始字节
src/gateway.js   UDP 监听、per-peer 模式判定（kcp/raw/auto）、msgId 派发
src/http.js      Bilibili SDK/服务器列表/版本/公告 桩 + 假 CDN(/res/...) + 全量请求记录
src/index.js     入口
tools/meta_decrypt.py  global-metadata.dat 页旋转 XOR 解密/校验
tools/lua_probe.py     Lua 密文分组/crib/解密尝试
tools/extract_res.py   APK → data/www 资源导出 + manifest.json
tools/hook_lua.js      frida 脚本: 抓 Lua chunk 明文 + UDP 原始包（**未实机验证**, 本机无设备）
test/selftest.mjs      11 项自测（含两个端到端 UDP 用例）
```

```bash
cd /home/qkzx/sld/sld/offline-server
node test/selftest.mjs        # 11/11 通过
node src/index.js             # HTTP+UDP 都在 9005, mode=auto
SLD_NET_MODE=kcp SLD_LOG_LEVEL=debug node src/index.js
```

让客户端过来（按干扰从小到大）：

1. **改服务器列表返回值**：`src/http.js` 已在 `/serverlist`、`/res_version`、`/sdk/login` 返回 `ip:port = 本机:9005`；只要客户端的列表请求落到我们这儿就能通。
2. **hosts/DNS**：把 `thrud-dev.accessgames.com`、`line3-sdkcenter-login.bilibiligame.net`、`app.bilibili.com`、`static.biligame.net` 指到本机（`adb shell` 改 `/etc/hosts` 或路由器 DNS）。
3. **代理**：SDK 的 HTTPS 走 mitmproxy + 客户端证书；UDP 侧代理无效，必须靠 1/2。

现在这个雏形能做的事：**接受并解析 KCP 会话、把每一条消息（不管识不识别）连同原始字节全部落盘、对任何 HTTP 请求作答且记录**——即"只要客户端发得出包，我们就不会丢信息"。它**还不能**：完成 AES/RSA 认证握手、回答任何具体 msgId（消息表在密文 Lua 里）。

---

## 8. 已知未知清单（抓包/hook 后逐条填）

- [ ] 帧头布局：`_InitMsgHeaderRule` 实际装的字段（`data/header-rule.json` 一改即生效）
- [ ] msgId ↔ 协议名表（`RegToCoreMsgId` / `mToCoreMsgId`）
- [ ] `.proto` 描述（`pb` 的 schema 注册在 Lua 里）
- [ ] KCP 握手：conv 分配规则、kcp2k 是否走 cookie 认证、`KcpChannel` 可靠/不可靠划分
- [ ] `CRYPTO_HEADER_SIZE` / `CryptoHeaderSize` 的确切语义与长度
- [ ] AES 会话密钥协商：RSA 公钥位置、challenge 算法、HMAC 覆盖范围
- [ ] toLua/fightLua 密钥流生成（批次 key 从哪来）
- [ ] Bilibili SDK 登录请求/响应字段（`isSDKLogined` 之前的那一步）
- [ ] 客户端是否有 `tp` 壳的完整性自校验会拦住 patch（`__tpinfo.*`）
