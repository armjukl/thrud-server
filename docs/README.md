# 斯露德（Thrud / sld）离线假服务端 · 当前方案

> **最后更新：2026-10-18** ｜ 老文档（含 PROJECT-LOG、frida 进展、1.0.6 静态分析）见 [`docs/old/`](old/)

本文只写**现在真正在用**的口径。历史推演过程不在这里，去 `docs/old/PROJECT-LOG.md`（已归档，结论可能过时）。

专题文档：[协议清单](README-协议清单.md) · [待补功能](README-待补功能.md) · [资源指引](README-资源指引.md) · [存档修改](README-存档修改.md) · [frida 抓包](README-frida抓包.md) · [注入器 gadget](README-注入器gadget.md) · [战斗移动轴与高度解锁](README-战斗移动轴与高度解锁.md) · [改包签名校验](README-改包签名校验.md) · [改Lua脚本](README-改Lua脚本.md) · 路 B 到头：只靠 hook 的本地化（[`../../frida-gadget/README.md`](../../frida-gadget/README.md)，复刻 PC 纪念版）

---

## 0. 现状速览

| 环节 | 状态 |
|---|---|
| 资源更新 | ✅ 无热更：服务端固定报 `resVersion=1583`(= 手机资源包 `kvl.kvl` 的 ResVersion) → 客户端直接读盘，不下载 |
| Lua 加载 | ✅ `LuaBundleTableCount 4440`，主城大厅能进 |
| 登录 / SDK | ✅ B 服 SDK 链通（假服 mock） |
| 大厅交互 | ⚠️ 部分：若干协议服务端回空包，Lua 拿到 nil 报错（见 §6） |
| 抽卡 | ✅ 按池真实掉落 + 结果动画 + 跳过/关闭；新角色即时入大厅（`Data_Push`）；重复角色入账碎片（见 §6、[待补功能](README-待补功能.md) §2） |
| 战斗高度轴 | ✅ 高度轴按关卡发放（客户端 `NewLevelInstance.controlMode`），第1章 1~8 关已铺外部 Lua 解锁、真机可升降（[战斗移动轴与高度解锁](README-战斗移动轴与高度解锁.md) §7）；✅ gadget 运行期版 `ZAXIS` 全关卡、不推文件，10-18 真机已生效（[改Lua脚本](README-改Lua脚本.md) §4、[注入器 gadget](README-注入器gadget.md) §5.6） |
| 只靠 hook 的本地化 | 🚧 复刻 PC 纪念版的脚本集已落地（`frida-gadget/`，离线 33 项构建自检 + 39 条真字节断言全绿），**真机一轮还没跑**（[`../../frida-gadget/README.md`](../../frida-gadget/README.md)） |
| 资源完整性 | ✅ 1583 台账 44,841 条 **逐条 md5 对得上**（改过的 Lua chunk 连带台账那一条 md5 一起换，见 §3 第 1 条） |

剩余问题全部是**服务端协议未实现**，不是资源/客户端问题。

---

## 1. 目录布局

```
/home/sld/
├── res/                          资源（不进版本库）
│   ├── phone/                      手机渠道服完整资源 dump（13G）
│   │   ├── files/thd/                真正给客户端用的：kvl.kvl(1583) / res / toLua / fightLua / media / cdnTextures
│   │   ├── files.zip                 原始 zip（顶层就是 files/）
│   │   ├── luaplain/                 明文 Lua（逆向用）
│   │   ├── msg.proto other.proto     全量 protobuf
│   │   └── push_pkg/                 字体包
│   ├── apk/
│   │   ├── sld_1.0.7.1426_bilibili.apk   ← 客户端用这个
│   │   └── sld_1.0.7.1428_nearme.apk     ← 渠道服版，不需要装
│   └── backup/                     归档（PC 纪念版 / 旧解包 / probe / 老文档数据）
└── offline-server/              假服 = git 仓库（TypeScript 工程）
    ├── src/                          TS 源码（唯一可信来源）
    │   ├── index.ts                   入口：UDP/KCP 网关 + HTTP(S)
    │   ├── config.ts                  env/.env + 路径 + 身份 + KCP 参数
    │   ├── logger.ts                  分级日志 + data/capture 报文落盘
    │   ├── proto.ts                   极简 protobuf 编解码
    │   ├── kcp.ts                     KCP 段编解码 + 最小可靠会话
    │   ├── framing.ts                 规则驱动框帧（6 候选自动试探）
    │   ├── gateway.ts                 UDP 监听 / per-peer 模式判定 / msgId 派发
    │   ├── payloads.ts                各 S2C 消息构造 + 请求→处理器表（CMD/HANDLERS）
    │   ├── gs.ts                      /AppInterface 请求解析 + ReturnPackagePush 组包
    │   ├── http.ts                    SDK/列表/版本 + AppInterface 路由
    │   └── data/                      ID 表（conditions / guides）
    ├── dist/                         tsc 构建产物（gitignore）
    ├── data/  certs/  tools/  proto/  frida/  test/
    ├── docs/  ← 你在这里
    ├── logs/                         运行日志（gitignore）
    ├── run.sh                        启动（先 build 再 node dist）
    └── frpc-sld.toml
```

资源不参与假服运行：`src/config.ts` 只用相对路径 `path.join(ROOT, '..', 'res', 'apk', ...)`
给工具链定位 APK。换机器只改 `res/` 的位置即可。

### 代码结构（对齐 yhjjx 的 `fakeserverts`）

老版本是一堆 `src/*.js` 平铺；现在按职责拆成 TS 模块，命名/分层参考同机的
`/home/yhjjx/yhjjx/fakeserverts`：

- **配置/工具**：`config.ts`（含 `.env` 解析、`SLD_*` 环境变量）、`logger.ts`、`proto.ts`。
- **网络层**：`kcp.ts` → `framing.ts` → `gateway.ts`，对应 KCP 段 / 帧 / UDP 派发。
- **协议层**：`payloads.ts`（S2C 构造 + 处理器表）、`gs.ts`（`/AppInterface` 编解码）。
- **HTTP 层**：`http.ts`（HTTP 路由）/ `index.ts`（装配）。
- 构建：`npm run build` → `dist/`；`npm run typecheck`；`npm run selftest`。
- 运行脚本已内建 `npm run build`，源码改动后直接 `./run.sh` 即可。

---

## 2. 客户端

- 包：`res/apk/sld_1.0.7.1426_bilibili.apk`（`com.wth.thrud.bilibili`，versionCode 1426，versionName 1.0.7）
- **铁律：APK 不碰、不重签。** 改动只落在外部数据目录 / 假服 / hosts。
  （2026-10-18 实测：改 `classes.dex` 会被壳 `__tpinfo.tsc` 的逐文件 (大小,CRC32) 清单拦住 → **黑屏**。
  绕法 A/B/C **待验证**；已验证可行的是**运行时 hook**，见 [改包签名校验](README-改包签名校验.md)。）

### 渠道服版（1428 nearme）为什么不用装

`aapt` + zip CRC 逐条比过：两个 APK 的**游戏内容逐字节相同** ——
`assets/res/data` 28,344、`toLua/Data` 3,399、`fightLua/Data` 1,589、`media` 3,251 全部 0 差异，
连 `kvl.kvl`、`abIndex.json`、**`global-metadata.dat`** 都一样。
差别只在 SDK 壳（B 服用 BILIGAME 签名 + bsgamesdk 资源 + `libbnfix/libbsutils/libsecsdk`；
渠道服用 nearme.apk + `opay_version` + x86 库）。换它只会把登录从 B 站 SDK 换成 OPPO SDK，没收益。

### 资源落盘

把 `res/phone/files.zip` 解压到**包名目录**（zip 顶层就是 `files/`，所以别解进 `.../files/` 里）：

```
/storage/emulated/0/Android/data/com.wth.thrud.bilibili/
```

解压后应得到 `.../com.wth.thrud.bilibili/files/thd/kvl.kvl`。校验：

| 项 | 期望 |
|---|---|
| `files/thd/kvl.kvl` | 4,508,995 字节（`ResVersion 1583 / AppVersion 1428`） |
| `files/thd/res/data/` | 6,150 个文件 |
| `files/thd/res/abIndex.json` | `mAbList` 5,925 条 |

---

## 3. 资源侧关键结论

1. **客户端读的是「APK ∪ 外部目录」合并层，外部优先。**
   日志实锤：`读取外部 …/thd/res/CombineAbIndex.json` / `…/thd/toLua/toluaLoader` 同时
   `streamingPath jar:file:///…/base.apk!/assets/`。
   这条推翻了旧 PROJECT-LOG §16.4「全量替换会把大厅换成热更卡死」的前提（它默认只读外部目录）。
   2026-10-17 直接 A/B 补强：**只铺一个外部 `toLua/Data/<hash>`**（没铺 loader，且 APK 自带 loader 也列了该 hash）
   就改了游戏行为 ⇒ 外部优先是**逐文件**生效的，改既有 Lua chunk 不需要重排 loader/台账
   （改完把台账里那一条 md5 换成新密文的 md5 即可，`newkvl.kvl` 不动）。
   样本与细节见 [战斗移动轴与高度解锁](README-战斗移动轴与高度解锁.md) §7；改 Lua 的通用做法（含不落盘的运行期路线）见 [改Lua脚本](README-改Lua脚本.md)。

2. **1583 全量台账 = 手机包 + 1.0.7 APK，无缺口。**
   台账 44,841 条 = 手机外部 10,231（1583 增量）+ APK 自带 34,610（基线），
   两个资源根并集**逐条 md5 全中（44,841 / 44,841，0 不一致）**。
   1583 `abIndex.json` 5,925 条引用也 100% 覆盖。

3. **客户端会自己重写 `kvl.kvl`。**
   启动后它把盘上那份 1583 台账原样写回，只把 `AppVersion 1428` 改成自己的 `1426`
   （条目与 md5 一个没变）。所以「只有 kvl.kvl 变了」是**正常且预期的**。

4. **旧的「622 白名单 / 热更补包」路线已废弃。** 现在整包铺，别只铺一半。

5. **资源包里带 IL2CPP 全量 `global-metadata.dat`（可反汇编）。**
   `res/phone/files/il2cpp/Metadata/global-metadata.dat` 7,637,236 B，是**完整**的；
   `data/logs/global-metadata.dat`（7,625,500 B，运行期 dump）才是被擦过的残件。
   配合 `res/backup/offline-old/dump/il2cpp_runtime_dump.cs`（含方法 RVA）用
   `aarch64-linux-gnu-objdump`/`radare2` 能把 C# 逻辑还原到指令级——
   抽卡两个根因（下条）就是靠反汇编 `THD.WebCommunicationHelper.HandleResult` 定位的。

---

## 4. 假服

### 拓扑

```
手机(改 hosts/重定向) ──> 23.147.232.29 ──frps:7000──> frpc ──> 本机假服
                                          ├─ 443 → 127.0.0.1:9443 (TLS, 游戏 API/GS)
                                          └─ 80  → 127.0.0.1:9080 (无监听, 预期报 refused)
```

### 端口 / 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SLD_TLS=1` | — | HTTP 侧只起 HTTPS |
| `SLD_HTTP_PORT` | 9443 | HTTP(S) 侧 |
| `SLD_KCP_PORT` | 19005 | KCP/UDP 网关 |
| `SLD_PUBLIC_HOST` | 23.147.232.29 | 回给客户端的公网地址（serverUrlData / 服务器列表） |
| `SLD_APK` | 见 config.ts | 覆盖 APK 路径（仅工具链/selftest 用） |
| `SLD_GACHA_FORCE_QUALITY` | 0 | 抽卡调试：>0 强制该品质出货（5=金）；0=按池真实掉落 |
| `SLD_GACHA_FORCE_TYPE` | 空 | 配上一个用：`leader`/`weapon` 强制角色/律叶，空=按掉落类型推断 |

> `resVersion` 已在 `src/config.ts` **硬编码 1583**（= 手机资源包的 ResVersion），
> 没有 `SLD_HOTUPDATE` / `SLD_RESVER`。

### 源码模块（TypeScript）

| 文件 | 职责 |
|---|---|
| `index.ts` | 入口，起 HTTP + KCP 网关 |
| `config.ts` | 全部路径/端口/资源版本（`resVersion` 硬编码 1583） |
| `http.ts` | HTTP 侧：SDK 登录桩、服务器列表、版本应答、`/AppInterface` 路由 |
| `payloads.ts` / `gs.ts` | 各协议 S2C 构造 / `/AppInterface` protobuf 编解码 |
| `gateway.ts` / `kcp.ts` / `framing.ts` | KCP/UDP 网关、KCP 段、帧封装 |
| `proto.ts` | 手写 protobuf 编解码 |
| `data/conditions.ts` / `data/guides.ts` | 补丁数据：conditionSet 全量下发、强制跳过新手引导 |
| `data/{lottery,drop,dropset,dropgroup}.ts` / `gacha.ts` | 抽卡按池真实掉落链（客户端表） |
| `data/{leader,weapon,rarity,...}.ts` | 自动生成的客户端表（本体 / 品质 1..5 等） |
| `logger.ts` | 日志 + 抓包落盘 |

### 已实现协议（`payloads.ts` 的 `HANDLERS`）

`9999` 心跳 · `10000` PlayerLogin · `10002` PlayerLoginGetInfo · `10003/10004` Prologue ·
`10005` GetNextDayUpdateData · `10006` GetRevelationInfoListPage · `10007` GetWeaponListPage ·
`10051` GetSignReward · `10057` ChangeSecretary · `10073` ChangeStep · `10076/10077/10080` 改名改性别 ·
`10100` ClientDataOverLogin · `10102` GetOpenFunctionData · `3304` SetSpecialTaskProgress ·
`30304` GetPayShopDataAfterLogin · `40002` GetWaitOrderData · `60003` GetPerkInfoListPage ·
`9000007` LoginOpenSmallBattlePanel · `3912/3913` 好友 · `21001/21015` 活动 ·
`2000/2001/2002` 抽卡（`SwearHero` / `SelectSwearChange` / `GetSwearRecord`）·
**空包回**：`890105` BattlePass · `9300009` Rogue · `9400004` ElementRuins

### HTTP 路由

| 路由 | 行为 |
|---|---|
| `POST /AppInterface` | GS 应用层 |
| `*/getClientUpdateData` | 固定回 `resVersion=1583` + `hotUpdateUrls:[]` → 客户端判定无需更新 |
| `*/skipAPI` | 原样回 `data/skipapi.json` |
**不推热更，也没有资源兜底**：没有 `/android/update`、`cdn_file_list_h264`，也不再提供
`/res/<路径>` 静态兜底。客户端稳态只请求 `getClientUpdateData`，命中即判定无需更新、
直接读手机 `files/thd/` 磁盘资源；`/res/...` 会落到未实现端点桩并记进 HTTP 日志。

### 服务端状态文件（`data/`，进版本库）

| 文件 | 用途 |
|---|---|
| `getclientupdatedata.json` | 版本应答（`resVersion` 由 config 固定覆盖为 1583） |
| `save.json` | 玩家存档（唯一一份）：序章/创角、名/性别/等级/体力、`characters[]`（含属性覆盖）、`weapons[]`、`items`/`money`、`cloths`/`wskin`(皮肤)、`levels`/`trainLevels`(关卡)、`gacha`、`signin`。**改完即生效不用重启**，游戏内变化会回写。字段见 [`README-存档修改.md`](README-存档修改.md) |
| `skipapi.json` | skipAPI 应答 |
| `header-rule.json` | 帧头规则 |
| `frame_prefix.txt` | push 段前导字节 |

---

## 5. 启动 / 停止

```bash
# 假服
cd /home/sld/offline-server && setsid nohup ./run.sh \
    >> logs/server.out 2>&1 < /dev/null &

# 隧道
setsid nohup /home/yhjjx/yhjjx/fakeserver/bin/frpc \
    -c /home/sld/offline-server/frpc-sld.toml >> logs/frpc.out 2>&1 < /dev/null &

# 停
fuser -k -n tcp 9443 19005
```

⚠️ 重启会断开已连接客户端；隧道公网 443 是暴露面，注意扫描器会打日志。

`run.sh` 会先 `npm run build`（tsc → `dist/`）再 `node dist/index.js`；手工前台跑用
`npm run build && npm run start`。TS 依赖（`typescript` + `@types/node`）在 `node_modules/`。

**完整流程**：手机装 `1.0.7` APK → 把 `res/phone/files.zip` 解到包名目录（§2）→ 起假服 → 进游戏。

---

## 6. 已知问题 / 下一步

真机日志里的 Lua 报错**基本是服务端回空包导致 Lua 索引 nil**（战斗/武器/抽卡已修，其余仍待补）：

| 报错 | 协议 | 现状 |
|---|---|---|
| `PatrolDataManager:603 GetPatrolLevelInfo` nil | `GetPatrol` | 未实现 |
| `RoguelikeDataManager:34` msg nil | `9300009 GetRogueInfoListPage` | 回空包 |
| `ElementTowerDataManager:57` `_levelInfoGroups` nil | `9400004 GetElementRuinsLevelGroupList` | 回空包 |
| `AttrManager:378 weaponData` nil | `10007 GetWeaponListPage` | ✅ 已按角色下发默认式仗实例 |
| `BattleModule:182 battleEnterInfo` nil | `11028 StartSoloBattle` | ✅ 进战斗闭环（进→打→结算→退） |
| 抽卡结果**弹窗不弹**（无 Lua 报错） | `2000 SwearHero` | ✅ 已修：`ShowItem_Push` 必须走 `PushMsg2Client`(completedList)，走 `replenishList` 会被 `Ignore_Replenish_MsgID` 过滤 |
| 抽卡**点跳过卡死**、结果页转圈 | `2000 SwearHero` | ✅ 已修：`recordInfo.itemId` 只写本体(角色/律叶)，碎片只进 `Rewards[*].rewardParInfo.par` |
| 抽到的角色**要重登**才进大厅角色表 | `2000 SwearHero` | ✅ 已修：新角色后置 `Data_Push(900011).leaderAttrChanged` 推送 |

> 抽卡三条排查详见 [`README-待补功能.md`](README-待补功能.md) §2，回包硬约束见
> [`README-协议清单.md`](README-协议清单.md) §3；关卡/章节解锁依赖统御等级（`player.level`）。
> 反作弊(ACE)会挡 frida 挂进程，但**静态反汇编 IL2CPP 不受影响**（见 §3 第 5 条）。

注意：这些 S2C 的字段多是 `repeated`/`optional`，
**空 repeated 在 protobuf 里等同于「不存在」**，回空包必然触发 nil ——
要按 `proto/` 里的定义塞至少一条骨架数据，不能靠「空但合法」糊过去。

建议顺序：`GetWeaponListPage` → `GetElementRuinsLevelGroupList` / `GetRogueInfoListPage` → `GetPatrol`；战斗已起步，按真机日志继续迭代。

---

## 7. 诊断入口

| 位置 | 内容 |
|---|---|
| `logs/server.out` | 假服 stdout（含 `req/resp msgId=…`） |
| `logs/frpc.out` | 隧道日志 |
| `data/logs/http-requests.jsonl` | 每条 HTTP 请求的完整 method/path/headers/body |
| `data/capture/` | 抓包原件 |
| 手机 `…/files/clientLog/` | 客户端日志（`Thrud<日期>.log`，含 Lua 堆栈） |

---

## 8. 克隆后重建

派生内容不进版本库，clone 后跑：

```bash
npm ci                   # 安装 TS 依赖（离线可从 fakeserverts/node_modules 拷一份）
npm run build            # tsc -> dist/
```

前提：`res/` 已就位（`res/phone/`、`res/apk/`）。

---

## 9. 铁律

1. **APK 不碰、不重签**，改动只落在外部数据目录 / 假服 / hosts。
   解除条件见 [改包签名校验](README-改包签名校验.md)：**改包已被壳的完整性清单拦住（实测黑屏）**，
   三条绕法待验证；已验证可行的是运行时 hook。
2. 外部资源**整包铺**，别混版本、别只铺一半 —— md5 与 1583 台账必须一致。
3. 别把资源包里的 `res/*.json` 索引单独替换，客户端自己维护它们。
4. 改 `data/save.json` 即可换大厅看板 / 调等级角色，不用重启。
