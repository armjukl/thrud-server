> ⚠️ **已归档（老文档）** · 最后更新：2026-10-05 · 当前方案见 [`docs/README.md`](../README.md)
>
> 本文写作时的口径可能已过时（路径、结论、结论所依赖的文件位置都变了），仅作历史记录。

# 斯露德(Thrud)离线 · 2026-10-05 改动记录

对象:`com.wth.thrud.bilibili` 1.0.7 / version_code 1426 / Unity **2021.3.18f1** + IL2CPP。
新机:**免 root**(vivo, Android 10, Adreno 616, 6 GB, 2408x1080)。因此本次全部改动只允许落在三处:
**磁盘覆盖文件(外部目录)**、**假服务端**、**hosts 重定向** —— 不动 APK 一个字节。

---

## 0. 结论速览

| 项目 | 结论 | 证据 |
|---|---|---|
| PostProcessing 崩溃 | **已彻底修复**(12 个 AB 关图层 + 1 个空包) | 最新 3 份客户端日志 NRE=0、kernel=0、ArgumentException=0 |
| 大厅可用性 | **可用**:进大厅、按钮、月签到面板均正常 | 同上;签到弹窗已能打开 |
| 进大厅后约 45 s 静默退出 | **已定案:不是崩溃,是 Lua 主动 `Application.Quit()`**;触发条件= B站 SDK 回调 code≠10010;根因=**APK 被重签名** | `SDK/BilibiliSDK.lua` 全游戏仅 3 处 Quit,全在 SDK 回调里 |
| 内存不足 | **排除** | 老手机 Adreno 509 / **3 GB** 能长时间待在大厅;新机 6 GB |
| Wwise 缺 `.bnk` | **排除**(不是死因) | 老手机同样 7 条 `SoundBank_Load AK_FileNotFound`,照样活着 |
| AB 完整性校验 | **不存在**,可安全覆盖 | `CombineAssetBundleDepData.json` 只有 `mName/mDeps`,无 hash/size |
| 强制 GLES3(改 `globalgamemanagers`) | **作废** —— 它要求重签 APK,等于把死因装回去 | 见第 4 节 |

**铁律(本次最重要的产出):APK 不碰、不重签。** 一切修复走外部覆盖 + 假服务端。

---

## 1. PostProcessing 修复(今天的主要工程)

### 1.1 前提:1.0.7 的 Android 包里根本没有 PP kernel

`scan_apk107.py`(16:11) 扫全 APK 的 shader 索引 → `apk107_pp.txt`:

```
PostProcessLayer   12 处引用
ColorGrading        32 处引用
KGenLut3D / AcesTonemap / PostProcessResources   0 命中
```

即 Android 侧 `PostProcessResources` 这个 PC-only 包缺失(空包索引键
`4ae712cc80547c646839d91734922068` 不带 `.ab`,内部 CAB 是 `CAB-4e0590c7f7cac8289c1b7097a6283caa`,
pathID `-14191494099089390`)。所以每个带 `PostProcessLayer` 的对象一实例化就 NRE 刷屏。

### 1.2 第一版为什么没用

`ppatch.py`(15:34) 只在**同一个 SerializedFile 内**找 `m_Script`。而大厅相关的 5 个是**场景包**:
场景包里有 **两个 SerializedFile 节点**,MonoBehaviour 落在第二个,`m_Script.pPtr.fileID=1`
指向同包 `.sharedAssets` 那个节点的 externals —— 第一版解析不到,于是整片漏掉。
另外早期把包改成单节点/错 flags 后,客户端报
`not built with the right version or build target` + `LuaException Managers/ResourceManagerLua:124 LoadResSync`。

### 1.3 现在的做法:`/home/qkzx/sld/probe-hometmp/ppatch2.py`(16:29)

要点(踩过的坑都在这):

- UnityFS 容器:`UnityFS\0` + ver8,`>qiii`(totalsize,bic,biu,flags=**0x243**),blockinfo 在 align16=64,
  块 **131072** LZ4HC,节点表 `>qqi` + NUL 名字。
- **节点 flags 必须原样保留**:单节点包 `(4,)`;CAB + `.resS` 是 `(4,0)`;
  **场景包两个 SerializedFile 节点都是 `(4,4)`**。改错就"not built with the right version"。
- SerializedFile v22 元数据大端、对象负载小端;`o.byte_start` 是**相对自己那个 SerializedFile 起点**,
  所以流内绝对位置 = `nodeOffset + byte_start`。
- MonoBehaviour 头(小端):`[0:4] m_GameObject fileID | [4:12] pathID | [12] m_Enabled |
  [16:20] m_Script fileID | [20:28] m_Script pathID | [28:32] m_Name len`。
  PPtr 外部:`fileID=0` → 同 SF;`fileID=n` → `externals[n-1]`(同包另一个 SF,或别的包的 `CAB-…`)。
- 跨 SF 解析 `m_Script` → 拿到 MonoScript 类名,命中 `PostProcessLayer` 才把 `m_Enabled` 一个字节 1→0。
- 重打包后逐节点断言:节点数量/大小/flags/名字、stream 长度、totalsize 全部回验;
  成品与原包相比**只有 enabled 那一字节不同**(已做字节级 diff)。

### 1.4 产物

`/home/qkzx/sld/probe-hometmp/pp107/out2/` — 12 个改好的包(源包在 `pp107/src/`,44 个从 1.0.7 解出的原包):

```
1848798d86e3e754db8cd8db41f936bc.ab    15319     70cdfdf137066924581cba9c1cdf2b2a.ab   22100
27d0269408645164b9dc9f7ec083a39c.ab      1789     a307a1137b03df64aa0133eb13cba5a1.ab   69591
5a0499bb5e9440146a0f02a20f966169.ab      9855     a859434c18345f74a9590c1fa43c79f4.ab   13615
ad36afcf530122246a67567575cb99f2.ab    106743     c19ed45f1648d7c4199686611e6ad62c.ab   21570
c1e2a808cc5be684cba14bfbf6e14e70.ab    617737     cbb8a38d385417b49bbb5b3269665a38.ab    7372
d9c40a84cb59d8a42ad0b11e07195645.ab      3029     fd3a9fb059dc4bd419d86232efc2e11d.ab   44325
```

加一个 281 B 的空 `4ae712cc80547c646839d91734922068`(让缺包的加载直接成功而非报错)。

---

## 2. 免 root 部署口径(今天定下来)

客户端外部覆盖目录(**无需 root、无需重签,重装 APK 也在**):

```
/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/res/data/
```

发布方式:静态目录 `/home/qkzx/offline/sld/dl/` 由 `python3 -m http.server 8081` 提供,
下载入口 `http://23.147.232.29:8081/<文件名>`。

| 文件 | 大小 | md5 | 条目 |
|---|---|---|---|
| `pp_all.zip` | 695,860 | `c76ee349decf05fd533529a1ed18dcf2` | 13(12 个 PP 包 + 空 PP 包,路径已带 `thd/res/data/`) |
| `sld_data_full.zip` | 143,003,232 | `7aad151183c73a493591822b80d3be03` | 174(全量含 PP 修复) |
| `pp_empty.zip` | 469 | — | 只含空 PP 包(试错用) |
| `pp_off.zip` | 13,250 | — | 早期 7 包版本,已被 `pp_all.zip` 取代 |

> 注意:今天的结论一度被"只装了空包、没复制其他几个文件"污染过一次 —— 排查时务必确认
> `res/data/` 下 12 个 `.ab` 全在,并核对 md5。

---

## 3. 闪退定案(今天的最大突破)

### 3.1 现象(三份日志完全一致)

`Thrud2026_10_06_00_34_18.log`(754 行 / `:Error` 14 条)、`00_36_20`(742 行 / 12 条)、
`00_55_17`(742 行 / 12 条)。**NRE=0**(PP 确实修好了)。错误构成三份完全同型,只差时间戳和多点的按钮:

```
7 × AudioError SoundBank_Load <bank> AK_FileNotFound      (缺 bnk, 非致命)
1 × AudioError SFX_PostEvent UI_Click_StartGame
3 × Lua trycatch  Patrol:603 / Roguelike:22 / ElementTower:54   (假服回包缺字段 → 第 7 节待办)
1~3 × AudioError SFX_PostEvent ui_s_button / UI_Menu_SignInMonthly_Open  ← 永远停在签到弹窗这一步
```

进程寿命 44–46 s。最后一次 gs 请求固定是:

```
16:55:57.362  msgId=10100(ClientDataOverLogin)   0B / resp body=0B  push=11B framed=32B
16:56:02.853  msgId=21015(ActivityReplayReward)  0B / resp body=0B  push=12B framed=33B
   ← 之后服务端再无任何请求;客户端日志最后一行是 AudioError: UI_Menu_SignInMonthly_Open
```

用户观察一致:**进大厅、角色做完开场动画就退**。托管层一条异常都没有 → 不是崩溃。

### 3.2 硬证据

`/home/qkzx/offline/sld/frida_dump/lua-1004-083834/` 里 889 个明文 Lua 全文检索,
**整个游戏只有 3 处 `UnityEngine.Application.Quit()`,全在 `00889-..._SDK_BilibiliSDK.bin`**:

```lua
local success_code = 10010                                   -- 第 10 行

SDKAgreementWithLicenceCallback   -- obj.code ~= success_code → Post(SDK_QuitCallback) + Quit()  (1022-1023)
SDKAgreementWithPrivacyCallback   -- 同上                                                        (1046-1047)
SDKQuitCallback                   -- 注释原文:"SDK退出返回（游戏杀死进程的那种）（防沉迷，付费之类）"
                                  --   无条件 Quit()                                             (1110-1111)
```

`SDK_AgreementWith*` 事件在 Lua 侧**没有任何 Post 点** → 由 Java/原生 SDK 触发;
所以路径是:原生 SDK 拉协议/防沉迷 → 校验不过 → 回调 code≠10010 → Lua `Quit()`。
静默、零异常、时间点固定、跟 GPU 和内存无关 —— 全部对上。

### 3.3 根因:签名

SDK 每个请求都带 `apk_sign=a04f5c1df7a58a632015edd153209ea5`(共 65 个请求带这个字段)。
本地三个包签票 md5 全不匹配:

| 包 | 签票 subject | cert DER md5 |
|---|---|---|
| `sld_1.0.71426_…apk`(官方 B站 渠道) | `O = bilibili` (`META-INF/BILIGAME.RSA`) | `4502a02a00395dec05a4134ad593224d` |
| `base.apk` | `CN = ZhuoYou, O = Alpha`(joygames) | `f88dedc712f7b02bb1c152c9e7853032` |
| `1.apk` | `CN = 9Game, O = LX` | `50553c039fcae0af68f4e41e34be9e79` |

另外还试过 `md5(SHA1hex)` / `md5(SHA1digest)` / `md5(pubkeyDER)` / `sha1[:32]` 等口径,无一命中
→ 机上装的是**第三把 key 重签的包**。真服按 `app_id=2701` 注册的签名验,不合格 → 协议/防沉迷回调失败 → `Quit()`。
装回原版 APK(签名对得上)后不再退出 —— 实测通过(用户 10-05 报告"能正常游玩了")。

### 3.4 顺带定性的一个干扰项

之前看到 SDK 埋点报 `net_error/login code=6 message="响应签名不匹配"`:那是 SDK 校验**我们假服的应答**签不出来。
它只在 SDK 域名被重定向时出现;现在 SDK 走真服,这条自然消失。假服对 token 完全不做校验
(`offline-token` 只是我们回给客户端的字面值,`gs.js` 里没有验签逻辑),所以真 SDK 出来的登录态可以直接喂进游戏服。

---

## 4. 今天新增的交付物

| 文件 | 大小 | md5 | 状态 | 说明 |
|---|---|---|---|---|
| `hosts_sdk_real.txt` | 1,308 | `2cea127f27f37622ea45ba7e0d2a9832` | **在用** | 只劫持游戏服,B站 SDK 走真服 |
| `gles3_switch.zip` | 212,752 | `fb20c6b07baa658b1063255e5198222f` | **作废** | 强制 GLES3;因需重签 APK 而撤销,勿用 |

### 4.1 `hosts_sdk_real.txt`(有效 6 行)

```
23.147.232.29 le1-prod-bili-api-thrud.bilibiligame.net
23.147.232.29 l1-prod-bili-api-thrud.bilibiligame.net
23.147.232.29 l2-prod-bili-api-thrud.bilibiligame.net
23.147.232.29 bili-api-thrud.bilibiligame.net
23.147.232.29 thrud.accessgames.com
23.147.232.29 thrud-dev.accessgames.com
```

成立理由(全部实测过,按 Host 统计 `data/logs/http-requests.jsonl`):

- 游戏自身两条通道都不靠域名:GS 应用层 API 是 `POST /AppInterface`,请求 Host 就是
  `23.147.232.29`(`serverUrlData` 回 `https://23.147.232.29:443`,客户端按 IP 直连,KCP 同理);
  `/AppInterface` 累计 992 次全部走 IP。
- 必须留的只有 `le1-prod-bili-api-thrud…` 的 `/server/*`(skipAPI / getClientUpdateData /
  cdnData / clientNotice / OpenStatus / serverUrlData / clientAnnounce / clientLogLevel,共 549 次)。
- 可以摘掉的都是 BSGameSDK 自己的:`api.biligame.net`(`/sdk-hot-deploy/*`、`/game-marketing/*`)、
  `static.biligame.net`(`/gamesdk/*.json`)、`gameinfoc.biligame.net`、`pinterface.biligame.net`、
  `line1-sdk-app-api.biligame.net`(`/api/config/init`、`/api/agreement/config`、`/api/package/force_update`)、
  `line1-sdk-center-login-sh.biligame.net`(**`/api/external/user.token.oauth.login/v3`** = SDK 登录本体、
  `/api/external/issue/cipher/v3`)、`vpn.bilibiligame.net`、`nfile.xy.bilibiligame.net`(客户端未向我们要过 AB)。
- 文件里另留一行注释掉的 `line1-log.biligame.net`(埋点 `/collector/api/report`,804 次),放开可继续收遥测。

### 4.2 `gles3_switch.zip`(已作废,但技术结论留档)

`assets/bin/Data/globalgamemanagers`(1.0.7 确实在这个条目,175,304 B)。PlayerSettings 的图形 API 表在
**偏移 `0x1cb24`**,原值 `count=2 [21(Vulkan), 11(OpenGLES3)]`。两个候选只改 8 字节、长度不变(故 SerializedFile
对象表 `byte_start` 不错位):`gles3_only` = `[11,11]`、`gles3_pref` = `[11,21]`;
md5 orig `75c056f4…` / only `78df2c17…` / pref `39a0dfcb…`。
**为什么不用**:见 3.3 —— 换签名才是死因,Vulkan 无辜。若以后有不需要重签的通道(比如官方包内可替换条目),这 8 字节可以再看。

---

## 5. 今天的服务端改动(`/home/qkzx/offline/sld/offline-server/src/`)

按 mtime:

| 文件 | 时间 | 今天动了什么 |
|---|---|---|
| `common_condition_ids.js` | 10-05 06:01 | 条件 id 表(任务/引导门控) |
| `guide_ids.js` | 10-05 06:19 | 引导 id 表 |
| `gs.js`(566 行) | 10-05 09:06 | 见下 |

`gs.js` 里今天生效的几处:

- `gs.js:94` `PROLOGUE_SKIP = new Set(['101002','101004','101005','101007','101009','101011','101013'])`
  —— 跳过 1.0.7 缺资源的序章节点(创角包 `41edf76d…` 不在包里、`video` 类节点 abIndex 无对应、教程战要 `battleEnterInfo`)。
- `gs.js:121-124` `secretaryId()` 读 `data/secretary.json`,**每次请求重读、不用重启**;换看板角色只改这个 json。
- `gs.js:265-267` `pb.bfield(80, signInfoBody())` —— `PlayerLoginGetInfo_S2C.monthSign=80` 必带
  `{monthGetSignRewardTimes, lastGetSignRewardTime, days}`,否则 `SignInMonthlyManager.InitData(nil)` 把面板清零。
  跨天刷新口 `GetNextDayUpdateData_S2C.monthSign=13` 同样带(`gs.js:364`)。
- `gs.js:281-284` `GuideInfo`(字段 57)= `guideData` 原样回显 + `forceGuideStep` 跳全引导,
  配合 `gs.js:449-455` `ChangeStep` 存储/回显,避免引导遮罩卡大厅。
- `gs.js:394/409` `ClientDataOverLogin(10100)`、`ActivityReplayReward(21015)` 回空 message
  —— **21015 的类型本身没有 `_S2C` 后缀**,客户端解的是 `msg.ActivityReplayReward`(空 message)。

网络拓扑(排障用):`23.147.232.29` → frps `:7000` → 本机假服
(`node src/index.js`,pid 770585,监听 **9443**;`frpc-sld.toml` 把 9443→远端 443、9080→远端 80);
stdout `/home/qkzx/sld/probe-tmp/server.out`;请求与应答体记 `data/logs/http-requests.jsonl`。
静态下载 `python3 -m http.server 8081 --directory /home/qkzx/offline/sld/dl`(pid 791315)。
**手机时钟 = 服务器时钟 + 8 h**。

---

## 6. 今天顺带拿到的外部参考(斯露德 PC 纪念版)

已解包在 `/home/qkzx/sld/sld_full/斯露德纪念版/`(7 GB 原档 `/home/qkzx/sld/斯露德纪念版.7z`)。

- `_sld_patcher.js`(Frida):劫持 `tolua.dll`/`lua54.dll` 导出的 `luaL*loadbuffer*` —— 游戏交给 VM 的是
  **解密后的明文 Lua**,在编译前动。三种模式 `sub`/`append`/`full`;另强制
  `THDHelper.InitGame → indie(2)`(RVA `0x8912F0`),并监视 `UIHotUpdate.SendApiSkipRequest`(RVA `0x3CCDD0`)。
- ~~**对安卓免 root 的等价物** = 改 Lua AB 丢进 `thd/res/data/` 覆盖(等于 append 模式)。~~
  **10-07 更正:这条推定是错的。** 安卓包里的 Lua **不是 AssetBundle**:实测 `listing.txt` 是
  `assets/toLua/Data/<hash>` **3,198 个** + `assets/fightLua/Data/<hash>` **1,472 个**独立文件(共 4,670),
  由 `assets/toLua/toluaLoader` / `fightluaLoader` 索引;`thd/res/data/` 那套外部覆盖只服务
  `res/CombineAbIndex.json`/`CombineAssetBundleDepData.json` 的 AB(PP 那 12 个包走的就是它)。
  当时那句是把 **PC 纪念版**的形态(那边确实有 `luadata.assetbundle`)误推到了安卓;
  `/home/qkzx/sld/v1lua/luadata.assetbundle`(23.7 MB)与 `/home/qkzx/sld/v1lua/extract/lua.bin`(27.9 MB, 9-09)
  都**不是**从安卓 APK 里来的。**免 root 想改 Lua 逻辑 = 目前无路**(Lua 在 APK 内,写不进去);
  要改 Lua 就得改包重签,而 chunk 加密已在 10-07 破掉(固定 8 字节 XOR,见 `PROJECT-LOG.md` 第 7 节 + `tools/lua_xor.py`)。
  ~~**免 root 改 Lua 无路**~~ —— **10-18 更正:这句也否证了,有两条路。**
  ① `files/thd/toLua/Data/<hash>` 这条外部覆盖通道**确实也吃 Lua chunk**(不只 AB),真机验证过:
  铺上改好的 `75320b33…`/`8a233aae…` 客户端行为就变(见 `README-战斗移动轴与高度解锁.md`);密文用
  `tools/lua_xor.py enc` 生成,不用重签。② gadget/frida 劫 `liblua54.so!luaL54_loadbufferx`
  在 VM 编译前换明文 buffer,连文件都不用动(见 `README-注入器gadget.md` §5.5)。
- `_run_patched.py`(420 KB)里的 `LUA_MOCK` = 整套 Lua 侧假后端(append 进 `Managers/NetWorkManager`,
  16,159 → 419,517 B)。它的注释直接写明了客户端硬约束,是我们第 7 节待办的依据:
  - 元素遗迹:`levelInfoGroups` **给空表必崩**(`ElementTowerDataManager:105/123/135/146/157` 裸索引,
    实测崩点 `UIActivityElementTowerCellPanel:65 → GetPassLevel:135`);分组由客户端自带
    `ElementRuinsLevel_Xls.belongRuins` 推,`remainCount = ElementRuins_Xls.dailyChance`,`state` 0未解锁/1可打/2已过。
  - Roguelike:登录必须回 `rogueLike`(proto `msg.RogueLikeInfo`),否则 `RoguelikeDataManager:22` 挂;
    还要带已看剧情集与已激活天赋(`talentBuff`)。
  - `GetPatrol`:字段全 optional/repeated,空回包=未参与。
  - 月签到:`monthSign` 两处都必须带(见 5),`signTimes` 是跨月流水号、要夹在当月天数内否则 `signList[day]` 越界。
  - 抽卡:`swearNumberInfo` 必给(`GachaDataMgr:656` 裸读 `.bottomgroup`);`ShowItem_Push` 必须晚于本 S2C。
  - 它给 `UIGuideCtrl.OnCurrentBtnClick` 包了安全层 —— 引导遮罩那一下点击报错会把黑罩压在大厅最上层。

---

## 7. 待办(全部不需要动 APK)

1. **补三处回包**(客户端日志里现存的 3 条 trycatch,均非致命):
   `GetPatrol` 的 `patrolLevelInfos`(`PatrolDataManager:603 pairs(nil)`)、
   登录回包补 `rogueLike`(`RoguelikeDataManager:22 index nil`)、
   元素遗迹 `levelInfoGroups` 非空分组(`ElementTowerDataManager:54`)。按第 6 节口径做。
2. **618 个 PC-only 包批量转换**(脚本已就位 `/home/qkzx/sld/probe-hometmp/miss13/convert.py`)。
3. **Android Wwise `.bnk`**(7 条 `SoundBank_Load AK_FileNotFound`;不影响可用性,影响音效)。
4. 每有新补丁包,重打 `sld_data_full.zip` 并同步 md5。

---

## 8. 复现 / 自检命令

```bash
# 补丁包是否装齐(应 12 个 .ab + 1 个空 PP 包)
ls /storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/res/data/ | wc -l

# 假服是否活着 / 最近一次会话尾部
tail -40 /home/qkzx/sld/probe-tmp/server.out

# 客户端错误签名(今天三份都应是 12~14 条、NRE 0;多出的只是重复点按钮的音效缺失)
grep -c ":Error" /home/qkzx/sld/Thrud2026_10_06_00_55_17.log
grep -ci "NullReferenceException" /home/qkzx/sld/Thrud2026_10_06_00_55_17.log

# 重跑 PP 补丁(源包在 pp107/src,产物 pp107/out2)
/home/tmp/venv/bin/python /home/qkzx/sld/probe-hometmp/ppatch2.py

# 按 Host 看请求分布(判断某域名能不能摘)
grep -o '"host":"[^"]*"' /home/qkzx/offline/sld/offline-server/data/logs/http-requests.jsonl | sort | uniq -c | sort -rn
```
