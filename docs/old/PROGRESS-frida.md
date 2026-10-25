> ⚠️ **已归档（老文档）** · 最后更新：2026-10-07 · 当前方案见 [`docs/README.md`](../README.md)
>
> 本文写作时的口径可能已过时（路径、结论、结论所依赖的文件位置都变了），仅作历史记录。

# sld(斯露德)假服务端 · frida 分析进展

样本:`com.wth.thrud.bilibili`(斯露德/Thrud, Bilibili 渠道, Unity 2021.3.18f1 + IL2CPP metadata v29, arm64)
工作机:frida 通过隧道 `23.147.232.29:27049` 连手机 frida-server;frps 在 `23.147.232.29:7000`。

## 1. 服务器存活结论:全部已死

| 主机 | 结果 |
|---|---|
| `armorgirls-ts-all-gs.bilibiligame.net` | NXDOMAIN(元数据里的线上游戏服) |
| `l1/le1/l2-prod-bili-api-thrud.bilibiligame.net` | NXDOMAIN(运行时解析出的 API 服) |
| `thrud-dev.accessgames.com:8005` | A 记录指向私网 10.22.151.127,不可达 |
| `*.accessgames.com` | 泛解析到公司官网 42.194.188.227 |

→ 无法从官方拉资源/更新,只能伪造。

## 2. 已搭建的 MITM 设施(可用)

- **重定向**:`hook_redirect_trust.js` — 在 `getaddrinfo` 入口把死域名参数替换成隧道 IP `23.147.232.29`(NXDOMAIN 时改结果无效,必须改入参)。
- **TLS 假服**:`offline-server/src/http.js` 支持 `SLD_TLS=1`;证书 `certs/`(覆盖 `*.bilibiligame.net` / `*.accessgames.com` 等)。
- **隧道**:`frpc-sld.toml` 把本地 9443→远程 443、9080→远程 80。已验证 `https://23.147.232.29/` 返回我们的证书。
- **绕证书校验**:~~脚本 hook Java `SSLContext.init`/`HostnameVerifier`,装 trust-all。~~
  **10-07 更正:这一步根本不需要** —— 免 root 路线没挂任何 hook,客户端照样连上了我们的自签证书。客户端自己就带了 5 处放水实现(`com/base/track|trackingdata/http/SSLSocketClient$1/$2`、`gsc/fb$a`+`fb$b`、`CriFsWebInstallerManager$LooseTrustManager`、`bsgamesdk/…/EasyX509TrustManager` 把校验包在 `catch(Exception){return}` 里)。手机**不用装 CA**,证书 CN/SAN/过期都无所谓。证据链见 `../PROJECT-LOG.md` §14。
- 客户端请求能实时落到本地假服并记录到 `data/logs/http-requests.jsonl`。

## 3. 运行时 IL2CPP dump(绕过 so 加固)

`libil2cpp.so` **导出了完整的 il2cpp 运行时 API**(235 个)。据此写了运行时 dumper:
- `il2cpp_dump.js` + `run_dump.py` → `dump/il2cpp_runtime_dump.cs`(2051 类 / 21529 方法 / 8710 字段, 2.1MB)。
- 静态 Il2CppDumper 被加固挡住的部分, 现在全有了(类名/方法/字段/偏移/RVA)。

## 4. 卡点:更新流程在 skipAPI 后中断

调用序列(实测):

```
UIHotUpdate.Start → InitHotUpdateUI → SendApiSkipRequest
  → THD.HttpClientPost.SendHttp  GET https://le1-prod-bili-api-thrud.bilibiligame.net/server/skipAPI?os=android&appVersion=1426
  → THD.HttpClientPost.HandleResult
  → UIHotUpdate.<SendApiSkipRequest>b__87_0(System.Boolean, System.String)   ← 回调
  → 之后只剩 Update() 空转
```

关键实测:
- 回调签名 `b__87_0(Boolean success, String resp)`;读取到 `success=0x1`(即真)。
- **回调的 onLeave 从不触发** → 回调内抛异常。
- 用 `Debug.LogException` 抓到:

  ```
  LitJson.JsonException: Can't assign value '0' (type System.Int32)
      to type System.Collections.Generic.List`1[System.String]
    at LitJson.JsonMapper.ReadValue (System.Type inst_type, LitJson.JsonReader reader)
  ```
- 说明响应是用 **LitJson 泛型 `ToObject<T>`** 反序列化的, 且目标类型里有 **`List<string>`** 字段。
- 但 `JsonMapper.ToObject`(非泛型)/`ToObjectByType`/`JsonData.get_Item` 都 **0 次调用**(走的是泛型, hook 不到)。

尝试过的响应(都不推进, 且除第一种外不闪退):
`{"code":0,"msg":"ok","data":{}}`(抛异常)、`[]`、`{}`、GlobalConfig 字段名 camelCase 版、空体。

- `UIHotUpdate` 状态字段读取:requestTryCount=0/5, needUpdateRes/App=false, startDownload=false → **完全空闲**, 不是重试。
- B站 SDK:`com.thrud.sdk.bilibili.BilibiliSDK`, SDK 各 `config/init` 等请求全部 200;但 **login 未被调用**;`SDK.SDKInterface_LuaCall` 说明登录是 Lua 驱动的, 而 Lua VM 在更新流程结束前不初始化。

## 5. 已知坑

- **不要用 `pgrep/pkill -f`(会匹配调用者自己)**;杀 hook 用 pidfile。
- spawn 早期(il2cpp 未 init, domain=null)调用 `il2cpp_*` 会**崩进程**;必须等 `il2cpp_init` 返回后再挂载。
- 挂钩 `JsonMapper.ReadValue`(热递归)、`System.Exception..ctor`、`Debug.LogException` 等会**导致游戏闪退**, 排查时慎用。
- 两段式注入:`run_hook.py` 用 `SLD_AGENTS`(预初始化, 装 redirect/trust)+ `SLD_AGENTS2`(延迟 13s 后, il2cpp 已就绪再装)。

## 6. 下一步候选

1. 拿到 skipAPI 响应的**确切泛型类型**(从而知道 schema):想办法读取 `ToObject<T>` 的 T(不引起闪退)。
2. 或不管响应, **强制推进**:在主线程(如 `UIHotUpdate.Update` 钩子内)对实例 invoke `SendResVersionUpdateRequest`/`VersionCheckFinish`。
3. 或从 IL2CPP dump 里离线分析 `UIHotUpdate` 相关类型与字符串引用, 还原响应结构。
4. 让用户点游戏里的“重试”, 看是否走另一条路径。

## 7. 关键脚本

| 脚本 | 作用 |
|---|---|
| `hook_redirect_trust.js` | getaddrinfo 重定向 + Java 证书 trust-all |
| `hook_il2cpp.js` | 在线按类名/方法名挂钩(UIHotUpdate/HttpClientPost/THDNetwork) |
| `hook_uiupdate_all.js` | 打印 UIHotUpdate 全部方法调用序列 |
| `hook_logexc.js` | 抓 `Debug.LogException` 的异常类型/消息/堆栈 |
| `il2cpp_dump.js` / `run_dump.py` | 运行时全量 IL2CPP dump |
| `run_hook.py` | spawn/attach 驱动(两段式注入) |

---

## 8. 突破: 更新流程已打通 (2026-10-04)

### 8.1 关于"一启动就闪退"的真相
闪退**不是游戏本身**, 而是我们自己的 frida 探针把进程打挂的:
- `hook_logexc.js` 在 `Debug.LogException/LogError` 的 onEnter 里用
  `il2cpp_runtime_invoke` 去调 `get_Message/get_StackTrace` → 重入运行时 → 原生崩溃;
- `hook_intparse.js` + 在 `JsonData.get_Item` 的 **onLeave 读返回值** → 热方法 + 异常返回空指针 → 崩溃;
- 探针里 `hookNamed(...)` 忘传回调 `cb`, 每次进入都抛 `TypeError: not a function` → 不稳定。

换成只读入参、不碰返回值的"干净探针"(`/home/qkzx/sld/probe-tmp/hook_probe.js`)后,
游戏全程存活, 直到更新流程走完。**结论: 排查时不要挂 Debug.LogException / Exception..ctor,
也不要在热 getter 的 onLeave 里解引用返回值。**

### 8.2 getClientUpdateData 的正确响应 (关键)
`/server/getClientUpdateData` 的响应用 `JsonMapper.ToObject` 解析成 `LitJson.JsonData`
(不是 Dictionary), 客户端按顺序读 4 个 key, **值必须是标量/数组, 不能是 `Dictionary<string,List<string>>` 那种列表包装**:

```json
{
  "appVersion": "1426",
  "resVersion": "1426",
  "forceUpdateUrl": "",
  "hotUpdateUrls": ["https://le1-prod-bili-api-thrud.bilibiligame.net"]
}
```

读取顺序(实测): `appVersion` → `resVersion` → `forceUpdateUrl` → `hotUpdateUrls`
- `appVersion`/`resVersion`: 会被 `int.Parse(data[key].ToString())`, 给标量字符串或数字;
  给数组会得到 `FormatException: "JsonData array"`。
- 缺任意一个 key → `KeyNotFoundException`(Dictionary/JsonData.get_Item), 回调中止, 游戏停在更新界面。
- `forceUpdateUrl`: 字符串。
- `hotUpdateUrls`: 字符串数组(域名列表, 给假服自己的域名即可)。

### 8.3 现状
加入以上 4 个 key 后, 客户端在 `SendResVersionUpdateRequest` 回调里顺利调用
`UIHotUpdate.VersionCheckFinish()` → 更新阶段通过, 游戏继续启动(后续进入 Lua/登录阶段)。
流程: `skipAPI` → `getClientUpdateData` → `VersionCheckFinish` → (下一阶段待抓)。

对应文件:
- `data/skipapi.json`   = `{"urlList":["https://le1-prod-bili-api-thrud.bilibiligame.net"]}`
- `data/getclientupdatedata.json` = 上面 4-key 对象
- `src/http.js`: 已加 `getClientUpdateData` 文件 handler + URL 解析兜底(Host 为空不再崩)

---

## 9. 更新屏之后的两道资源卡点 + 进入 Lua (2026-10-04)

在 `getClientUpdateData` 正确返回后, 客户端依次卡在两处 **缺失资源导致的异步永不完成** 上。
两处都用 frida 绕过, 之后游戏成功执行 `main.lua` 并停在登录界面(进程稳定存活)。

### 9.1 缺失 `CombineAbIndex.json` / `CombineAssetBundleDepData.json`
- `ABLoadManager.CoInit` 用 `UnityWebRequest.Get` 读
  `jar:file://<base.apk>!/assets/res/CombineAbIndex.json`(然后 `CombineAssetBundleDepData.json`、`CombineShaderFindData.json`)。
- **读 jar 内不存在的条目时该 UWR 永不完成** → 协程 `MoveNext` 卡在 `state==1`, UI 停在“信息同步中”。
- APK(1.0.6 与设备 1.0.7)实测 `assets/res/` 根只有
  `abIndex.json` / `AssetBundleDepData.json` / `ShaderFindData.json` / `CombineShaderFindData.json`,
  即 **缺 CombineAbIndex / CombineAssetBundleDepData**(CombineShaderFindData 本来就有)。
- 数据模型(dump): `AllABResInfo{mAbList:[AbResData{mOriginName,mAbName}]}` =
  原始 `abIndex.json` 的 schema; `AssetBundleDepData{mItemList:[{mName,mDeps}]}` 同理。
  ⇒ Combine* 就是对应原始索引的合并版, schema 相同。
- **绕过**: `hook_combine_redirect.js` — 把这两个 URL 改写成同目录的
  `abIndex.json` / `AssetBundleDepData.json`(`il2cpp_string_new` 换参数)。改完后
  `CoInit` 的 `MoveNext` 走到 `state=0→1→2→3`, 触发 `callback`。

### 9.2 缺失登录循环视频 `media/video/loginLoop`
- `UIHotUpdate.PrepareVideo → <PrepareVideo>b__80_0 → new CSPrepareCallback →
  VideoManager.PreLoadVideo("media/video/loginLoop")`, 等 CRI 的 prepare 回调。
- 该视频 **不在 APK、也不在 `kvl.kvl`**(APK 只有 `media/video/necessary/{h264,vp9}/Season01_PV.usm`,
  它是 CDN 下载资源)。CRI 打开失败 → `[CRIWARE] Error:E07020601M: File Open Error - media/video/loginLoop.usm`
  反复刷 → `Criware Error !` 异常 → 进程最终退出。
- **绕过**: `hook_skip_loginvideo.js` — 用 `Interceptor.replace` 把
  `VideoManager.PreLoadVideo`(rva `0xf6fb54`)整个换成空实现, 只对拿到的
  `CSPrepareCallback` 走 `il2cpp_runtime_invoke` 触发 `Invoke`。
  (先试过“调用原函数后在 onLeave 里触发回调”, 流程能走但 CRI 仍报错刷屏并最终崩溃; replace 才干净。)

### 9.3 结果
日志(`Debug.Log`/`LogUtil.Log` 只读钩子)实测顺序:
```
>>>SendApiSkipRequest>>>>> success
>>>SendResVersionUpdateRequest>>>>> success
读取内部 .../CombineAbIndex.json / CombineAssetBundleDepData.json / CombineShaderFindData.json
abLoadManager init end
====OnVideoPrepareFinish====
LuaABLoader.StartLuaLoader  (读取 3397 个 assets/toLua/Data/<hash>)
LuaState start / ver20199 / load table.lua读取所有表格结束
Main:10 执行main.lua的main函数
SDK/SDKMgr:66 Init   当前为Bilibili平台
UISettingDataMgr.SetVolume ...
```
之后出现 1 次 `LogException(LuaInterFace_UI.LuaException)`, 但进程存活、无新网络请求 ⇒
停在登录界面等待(下一步: SDK 登录 / 服务器列表 / KCP 网关)。

### 9.4 可用 hook 组合(spawn)
```
SLD_AGENTS=hook_redirect_trust.js \
SLD_AGENTS2=<abs>/hook_combine_redirect.js,<abs>/hook_skip_loginvideo.js \
SLD_DELAY2=16 python3 -u run_hook.py spawn 170
```
(延迟需 ≥ ~15s, 冷启动时 `libil2cpp.so` 可能还没加载完。)

### 9.5 关键 RVA(本轮新增)
| 符号 | RVA |
|---|---|
| `ABLoadManager.CoInit` | `0xf551b0` |
| `<CoInit>d__12.MoveNext` | `0xf58abc` |
| `THD.VideoManager.Init` | `0xf6e0d0` |
| `THD.VideoManager.PreLoadVideo` | `0xf6fb54` |
| `CSPrepareCallback.ctor` | `0xf70d8c` |
| `UIHotUpdate.PrepareVideo` | `0xa57ce4` |
| `<PrepareVideo>b__80_0/1` | `0xa58c84` / `0xa58d84` |
| `LuaManager.toLuaStart` | `0xf34858` |
| `LuaManager.LuaStart` / `CallMain` | `0xf34490` / `0xf349d8` |
