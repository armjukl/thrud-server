# 斯露德假服 · 改包关掉 apk_sign 签名校验

> 最后更新：2026-10-18 ｜ 当前方案 [`README.md`](README.md) ｜ 历史推演 [`old/PROJECT-LOG.md`](old/PROJECT-LOG.md) §4.4 / §13

本文是「**APK 不碰、不重签**」这条铁律（[`README.md`](README.md) §9）的**解除条件**：
改包后让客户端继续上报**官方签名值**，绕开 B 站服务端按 `app_id=2701` 做的 `apk_sign` 比对。

> ## ⚠️ 2026-10-18：改 dex 会黑屏（**已实测**）；怎么绕过去**待验证**
>
> **已实测（可复现，证据见 §9）：**
>
> - 1.0.7 的 TP 壳（`assets/__tpinfo.tsc` + `__tpinfo.tsc.sig`）带一份**带签名的逐文件清单**：
>   36,777 条记录，每条 = (未压缩大小, CRC32)，**覆盖 `classes.dex`、`classes2.dex`、`resources.arsc`、
>   `lib/*.so`、`assets/kvl.kvl`、`assets/toLua|fightLua/**`、`assets/bin/Data/**`**；
>   清单外 959 条：`res/**`(935)、`META-INF`(3)、`AndroidManifest.xml`、`assets/__tpinfo.*` 等（全表见 §8）。
> - 只改 `com/bsgamesdk/android/utils/a.a(Context)` 一个方法 → **启动黑屏、进程反复被杀**。
>   装机 `classes.dex` 8,254,784 → 8,254,736 字节、CRC `6259c73a` → `9960a747`；
>   其余 37,736 个条目（含 `__tpinfo.*`、manifest、`resources.arsc`、`libtprt.so`）逐字节未变，zip 条目数一致。
> - 假服**一个请求都没收到**（死在登录之前 ⇒ 与 `apk_sign` 取值无关，是「包被改」本身）。
> - 进程是被**外部 SIGKILL**：进程内 `exit` / `_exit` / `exit_group` / `abort` / `raise` / `kill` / `tgkill`
>   + Java `killProcess` / `System.exit` / `Runtime.halt` 全挂上，一个都没响。
> - 「只重签、不改内容」不触发（清单仍然对得上；10-05 那次重签也进过大厅）。
>
> **待验证（推论 + 三条绕法，真机都没试过）：**
>
> - 「杀手 = 壳的这份清单」目前是**最强假设、不是直接证据**（取证时 frida 隧道中途抖动，没跑完进程内回溯）。
> - **§8 的三条绕法（A 让清单失效 / B 等长+CRC32 碰撞 / C patch 壳）全部是待验证状态。**
>
> ⇒ 目前**唯一已验证可行**的是 §7：APK 原封不动，用 gadget 在运行时把 `apk_sign` 换成官方值。
> 下面 §3/§4 的「改包」步骤在 1.0.7 上不可行，保留作 1.0.6 参考。

---

## 0. 一句话原理

游戏**没有本地签名自检**——全 dex 搜官方签名值 0 命中，`app_id` 也不出现在本地比对里。
链路是：

```
apk_sign = md5(本包签名证书 DER)          ← 客户端自己算
        → 塞进 SDK 请求参数 apk_sign       ← 只是普通字符串参数
        → B 站服务端与 app_id=2701 注册值比对
        → 不匹配：SDK 回调 code ≠ 10010
        → SDK/BilibiliSDK.lua 那 3 处 Application.Quit()
        → 进游戏后约 45 s 静默退出（托管层零异常，不是闪退）
```

所以「关掉签名校验」= **把算 `apk_sign` 的那个方法钉成固定返回官方值**。

---

## 1. 改哪一处

| 项 | 内容 |
|---|---|
| dex | `classes.dex`（**不是** classes2.dex） |
| 类 | `com.bsgamesdk.android.utils.a`（源文件名 `ApkSignatureUtil.java`） |
| 方法 | **第 1 个**同名方法：`public static a(Landroid/content/Context;)Ljava/lang/String;` |
| 原本逻辑 | `getPackageInfo(pkg, 0x40 /*GET_SIGNATURES*/).signatures[0].toByteArray()` → `MessageDigest("MD5")` → 小写 hex |
| 唯一调用者 | `com.bsgamesdk.android.api.f`（`f.smali:498` 调用 → `f.smali:510` 塞进参数 `apk_sign`） |

1.0.6 与 1.0.7.1426 的**这个 smali 文件逐字节相同**（baksmali 后 md5 均为
`62b2a00069d9fa10b1d5870e08fac797`），所以两个版本改法完全一样。

### 原来的代码（1.0.7.1426，该文件第 7 ~ 62 行）

```smali
.method public static a(Landroid/content/Context;)Ljava/lang/String;
    .registers 4

    .line 1
    invoke-virtual {p0}, Landroid/content/Context;->getPackageName()Ljava/lang/String;

    move-result-object v0

    invoke-static {p0, v0}, Lcom/bsgamesdk/android/utils/a;->a(Landroid/content/Context;Ljava/lang/String;)[Landroid/content/pm/Signature;

    move-result-object p0

    const-string v0, "signs is null"

    if-eqz p0, :cond_22

    .line 2
    array-length v1, p0

    if-nez v1, :cond_10

    goto :goto_22

    .line 6
    :cond_10
    array-length v1, p0

    const/4 v2, 0x0

    if-lez v1, :cond_22

    aget-object p0, p0, v2

    .line 8
    :try_start_16
    invoke-virtual {p0}, Landroid/content/pm/Signature;->toByteArray()[B

    move-result-object p0

    invoke-static {p0}, Lcom/bsgamesdk/android/utils/a;->a([B)Ljava/lang/String;

    move-result-object p0
    :try_end_1e
    .catch Ljava/lang/Exception; {:try_start_16 .. :try_end_1e} :catch_1f

    return-object p0

    :catch_1f
    const-string p0, "get sign failed"

    return-object p0

    :cond_22
    :goto_22
    return-object v0
.end method
```

### 改成（整个方法体替换，其它一行不动）

```smali
.method public static a(Landroid/content/Context;)Ljava/lang/String;
    .locals 1

    const-string v0, "4502a02a00395dec05a4134ad593224d"

    return-object v0
.end method
```

> 若工具报寄存器错误，把 `.locals 1` 换成 `.registers 1`，等价。

**只改这一个。** 同名重载 `a([B)` / `a(Landroid/content/Context;Ljava/lang/String;)` / `b([B)`
是 MD5 与取证书的真实实现，动了会连带把 SDK 其它逻辑搞坏。

---

## 2. 值从哪来（原值核对）

`apk_sign = md5(Signature.toByteArray())`，也就是**签名证书 DER 的 md5：小写、无分隔符**。
用包内 v1 证书直接算，不用装机器：

```bash
unzip -o -j <apk> 'META-INF/*.RSA' -d certs/
openssl pkcs7 -inform DER -in certs/BILIGAME.RSA -print_certs \
  | openssl x509 -noout -subject -fingerprint -md5
```

| 包 | 签名主体 | 证书 DER md5（= 要钉的值） |
|---|---|---|
| `res/apk/sld_1.0.7.1426_bilibili.apk` | `O = bilibili`（`META-INF/BILIGAME.RSA`） | `4502a02a00395dec05a4134ad593224d` |
| `res/backup/apk-old/sld_1.0.6.1338_….apk` | 同上（同一把 key） | `4502a02a00395dec05a4134ad593224d` |
| `res/apk/sld_1.0.7.1428_nearme.apk` | `CN = nearme`（`META-INF/ANDROID_.RSA`） | `7815c5174154b7ce33f023602106ecc6` |

> ⚠️ **`old/PROJECT-LOG.md` §13 里写的 `a04f5c1df7a58a632015edd153209ea5` 不要用。**
> 那是 10-05 装在手机上那个**第三把 key 重签包**上报的值（正因为对不上才 45 s 退出），
> 不是官方值。§4.4 表里三个本地包的证书 md5（`4502a02a…` / `f88dedc7…` / `50553c03…`）
> 都跟它对不上，可以印证。要钉的就是上表的值。

---

## 3. 用 MT 管理器改（手机）

1. 把 APK 拷进手机，MT 管理器里点开它 → **查看** → 点 `classes.dex`（MT 会打开 Dex 编辑器）。
2. 编辑器里搜索类名（或直接跳转）：`com.bsgamesdk.android.utils.a`。
3. 右上角菜单打开**反编译 / smali 视图**，找到第 1 个方法
   `a(Landroid/content/Context;)Ljava/lang/String;`（看源文件名应是 `ApkSignatureUtil.java`）。
4. 长按该方法 → **编辑**，按 §1 的「改成」整段替换方法体。
5. 保存（MT 会重新编译 dex）→ 退出 → **保存 APK**。
6. 弹签名时用 MT 的签名功能，**V1 和 V2 都勾上**。
   这包 `minSdk 19 / targetSdk 26`，且 SDK 走 `GET_SIGNATURES`，V1 必须留；只签 V2 在老设备装不上。
7. **先卸载原版**（签名不同无法覆盖安装）→ 装改好的包 → 重铺外部资源。
8. 判定见 §5。

> 1.9 GB 的包在手机上重签很吃内存，容易失败。能碰电脑就用 §4 的方案。

---

## 4. 用 PC 改（推荐）

不用 apktool 全解包（1.9 G 太慢），只换 `classes.dex`。下面这条链子 10-18 在双生视界上逐字跑通
（三个包真机都能装载 gadget，见 [注入器gadget](README-注入器gadget.md) §4.3），改动面只有 `classes.dex` 一个条目：

```bash
cd /home/tmp/sigcheck
BP=/usr/share/java/baksmali.jar:/usr/share/java/smali.jar:/usr/share/java/smali-util.jar:/usr/share/java/dexlib2.jar:/usr/share/java/jcommander.jar:/usr/share/java/guava.jar:$(ls /usr/share/java/antlr*.jar|tr '\n' ':')

# 1) 取出 dex，全树反汇编（5000~7000 个类，几十秒）
mkdir -p stage && unzip -o -j <原包>.apk 'classes*.dex' -d stage/
java -cp "$BP" org.jf.baksmali.Main d -a 30 stage/classes.dex -o stage/sm/

# 2) 改 smali → 全树回汇编（产物就叫 classes.dex）
#    编辑 stage/sm/com/bsgamesdk/android/utils/a.smali（改法见 §1）
java -Xmx2g -cp "$BP" org.jf.smali.Main a -a 30 -j 4 -o stage/classes.dex stage/sm/

# 3) 换进 zip：条目名必须就是 classes.dex，先删旧签名块
cp <原包>.apk stage/out.apk
( cd stage && zip -q -d out.apk 'META-INF/*' && zip -q -9 out.apk classes.dex )
zipalign -f 4 stage/out.apk stage/a.apk
apksigner sign --ks x.keystore --ks-key-alias <alias> --ks-pass pass:<pwd> --key-pass pass:<pwd> \
  --v1-signing-enabled true --v2-signing-enabled true --out sld_apksignfix.apk stage/a.apk
apksigner verify --print-certs sld_apksignfix.apk

# 4) 收尾必查：包内 dex 是不是你编的那个（不是就说明替换没生效）
unzip -p sld_apksignfix.apk classes.dex | md5sum; md5sum stage/classes.dex
```

三个已踩过的坑：

- **`zip` 的 `条目名=本地文件` 写法静默不生效**（`zip -u out.apk classes.dex.new` 同理只会加一个名叫
  `classes.dex.new` 的条目，包内原 dex 纹丝不动）。把新产物**命名成 `classes.dex` 放进 stage 目录**再 `zip`，
  并按第 4 步比对 md5 才算闭环。
- **单文件汇编产物绝不能当 `classes.dex` 用**。`smali a 单个.smali` 出的 dex 只含那一个类（1 KB 量级），
  换进去等于删掉其余 5000+ 个类，启动必崩——它只能用来校验语法。
- 全树汇编默认堆够用，个别包（B 站版双生视界 7.3 MB dex）默认堆会被 OOM kill，加 `-Xmx2g`。

---

## 5. 怎么判定成功

1. **看上报值**：假服 `data/logs/http-requests.jsonl` 里 SDK 请求的 `apk_sign`
   应为 `4502a02a00395dec05a4134ad593224d`。
2. **看行为**：进游戏后是否**仍在约 45 s 静默退出**（不是闪退）。这是唯一硬信号。

---

## 6. 代价 / 未知项（动手前认下来）

1. **要卸载原版** —— 签名不同无法覆盖安装。卸载清空 `files/`：外部补丁 + `clientLog/`
   全没，1.x GB 资源要重铺（见 [`README-资源指引.md`](README-资源指引.md)）。**成本在这里，不在技术风险。**
2. **静态推不出来的部分**：B 站服务端除 `apk_sign` 外是否还交叉比对
   `isRoot` / `udid` / `channel_id` / `version_code`（同段参数，`api/f.smali:71~436`），
   以及 SDK 应答签名那条链会不会在别处失败。—— 只能实机试。
3. **壳的完整性表（清单存在已实测；「清单就是杀手」待验证）**：`assets/__tpinfo.tsc`（441,336 B，带 `__tpinfo.tsc.sig`）
   是 **36,777 条 (未压缩大小, CRC32)** 的逐文件清单，**覆盖 `classes.dex` 与 `lib/*.so`**（复现见 §9）；
   没覆盖的 959 条只有 `res/**`(935)、`META-INF`(3)、`AndroidManifest.xml`、`androidsupportmultidexversion.txt` 等。
   实测：**改了 `classes.dex` 就黑屏**。「清单就是杀手」这一步仍是**待验证**推论，绕法见 §8。
4. **游戏自己那条通道不用管**：`com/gsc/base/model/UpDataModel.apkSign()`（`:278`）走
   `com/base/*/device/ApkSignatureUtil` + `DeviceUtil.getAPKSign`，上报给假服 `/AppInterface`，
   我们**不校验**。想让日志好看就照同样手法钉掉，不改也没影响。

---

## 7. 【推荐】不改包：运行时换掉 apk_sign

既然「改 dex」会被壳的清单抓住，正路是**让 APK 原封不动**（不重签、不卸载、外部资源不丢、壳的清单仍然对得上），
在进程里把那个方法拦下来返回官方值。gadget / frida-server 两条通道都能用：

```js
Java.perform(function () {
  try {
    var a = Java.use('com.bsgamesdk.android.utils.a');
    a.a.overload('android.content.Context').implementation = function (ctx) {
      return '4502a02a00395dec05a4134ad593224d';
    };
    console.log('apk_sign hook 就位');
  } catch (e) { console.log('hook 失败 ' + e); }
});
```

要点：

- **必须赶在 SDK 第一次取值之前**：`api/f.smali` 会 `sput-object f.k` 缓存，取过一次就不再调。
  gadget 在 native init 前装载（比 frida spawn 还早），时间上够；挂到载体配置里那个
  `hook_redirect_trust.js` 或 `hook_gadget_all.js` 里即可（见 [`README-注入器gadget.md`](README-注入器gadget.md)）。
- 只 hook `a(Context)` 这一个重载（唯一调用点 `api/f.smali:498`），别动 `a([B)` / `b([B)`。
- 想先验证值对不对，先原样透传再打印：
  `var r = this.a(ctx); console.log('apk_sign=' + r); return r;`
- **不改包 ⇒ 不用卸载 ⇒ `files/` 资源不丢**，这也是它最大的好处。

若一定要「改包」，就得先干掉壳的清单校验（patch `libtprt.so` / 让 `__tpinfo.*` 那套失效），
成本高且没有任何验证，不建议。

---

## 8. 改包还有可能吗：三条路（**全部待验证**）

两个观测给出去壳的缺口：**清单只存 (未压缩大小, CRC32) 没有哈希**、**清单文件自己不在清单里**。
三条路都**没在真机上验过**，每条附「怎么验证」。

> **10-18 新增旁证（同族游戏，方向不利）**：双生视界 B 站包 `com.bilibili.gcg2.bili` 也是腾讯 TP 壳
> （`XGApplication.super = com/tencent/tpshell/TPShellApplication`、`libtprt.so`、`assets/{__tpinfo.tsa,__tpcfinfo.tsa,__tpsinfo.t.p.sin,tpginf.dat}`），
> 用 §4 的链子改过 `classes.dex`（7,287,640 → 7,287,756 B，size 与 CRC 都变）**且壳清单原样保留**，
> 重签后真机**能正常启动并装载 gadget**。也就是说"改了 dex 必被清单抓"在同族里并不成立，
> 斯露德那轮"改一个 smali → 黑屏 + 外部 SIGKILL"的判罚者需要重新钉：优先怀疑 ①`libtersafe2.so`/ACE 对
> **签名变化**动手（双生视界那次也换了证书却没死，说明不是普遍行为）②斯露德的清单条目确实覆盖被改文件而双生的没覆盖
> ③当初那轮改包同时踩了别的问题（比如 §4 那条小 dex 陷阱，或只改包没重铺资源）。
> 一次安装就能分诊：**只加条目不改 `classes.dex`**（应活）／**改 `classes.dex` 一个字节**（判 size+CRC 比对方向）／
> **删 `assets/__tpinfo.*` 四个壳文件**（路线 A）。

### A. 让壳的清单失效（最便宜，1 次安装就能验）— 待验证

壳自己那一套文件（`assets/__tpinfo.tsc` / `__tpinfo.tsd` / `__tpinfo.tsc.sig` / `__tpinfo.tsd.sig` /
`__tpinfo.tp` / `__tpcfinfo.tsa` / `__tpsinfo.t.p.sin` / `tpginf.dat`）**都不在它自己的清单里**（见下面全表），
所以改/删它们不会被清单抓。

做法：删掉或改名 `assets/__tpinfo.tsc` 与 `__tpinfo.tsd`（两个 `.sig` 一起），同一次把 dex 补丁也带上，装上看：

- 壳「没清单就跳过校验」→ 从此可自由改包（含 `classes.dex`）；
- 壳把「没清单」当篡改 → 照样黑屏，转 B。

**怎么验证**：不黑屏、能进游戏 = A 成立，**同时也坐实「杀手就是壳」这个待验证前提**。

### B. 等长改写 + CRC32 碰撞（不动壳，理论上最干净）— 待验证

清单每条只有 **(未压缩大小, CRC32)**：把 `__tpinfo.tsc` 按 12 字节切记录，第 2/3 字段与包内条目
`(file_size, CRC)` 逐条命中 36,778 / 37,737 ⇒ 就是这两个值，**没有内容哈希**。而 CRC32 可碰撞：
改完内容后，只要在文件里找到 **4 个可自由改的字节**（dex 的 padding 区够用），就能把整文件 CRC32
调回原值，同时**大小不变** ⇒ 清单看不出任何差别。

具体到本补丁：

1. 把 `a(Context)` 的方法体改成「等长指令 + 引用一个**已存在**的 32 字节字符串」（原地改，不移动任何偏移）；
2. 把那个闲置的 32 字节字符串**等长**改写成 `4502a02a00395dec05a4134ad593224d`；
3. 修 dex 头的 adler32 / sha1、zip 里该条目的 CRC 字段，再重签。

这条路对 `lib/*.so` 一样有效（等于壳这套校验形同虚设）。

**怎么验证**：改完先本地 baksmali round-trip 确认 dex 可解析；装上看能否进游戏；碰撞后 `unzip -t` 应报 CRC 正常。

**未定的前提**：tsc 记录第 1 个字段（32 位）含义未知（可能是文件名哈希或序号）。若它其实也参与内容校验，
B 需要适配；这条只能靠实测排除。

### C. patch 掉壳本身（`libtprt.so`，可能还有 `libtersafe2.so`）— 待验证

自举对我们有利：`lib/*.so` 虽在清单里，但我们改的正是「判罚者」，改完它就不再判自己。
难点：`libtprt.so` 的字符串是加密的，要先逆出校验点（它必然要读 `__tpinfo.tsc`、取文件、比 size+CRC、
不匹配则杀进程），再打补丁。

**怎么验证**：逆出校验点打上补丁后，把 `classes.dex` 随便改一个字节，装上不黑屏即成立。

优先级 **A → B → C**（成本递增；A 还能顺带验证「杀手是壳」）。

### 附：清单未覆盖的 959 条（这些**可以随便改**）

```
res/**                                            935
META-INF/{MANIFEST.MF,BILIGAME.SF,BILIGAME.RSA}     3
AndroidManifest.xml                                 1
androidsupportmultidexversion.txt                   1
assets/__tpinfo.tsc / .tsd / .tsc.sig / .tsd.sig |    8
assets/__tpinfo.tp / __tpcfinfo.tsa / __tpsinfo.t.p.sin / tpginf.dat
assets/res/{abIndex,AssetBundleDepData,ShaderFindData,CombineShaderFindData}.json   4
assets/{JigsawData,supplierconfig,license,distributor}*                             4
assets/bin/Data/{RuntimeInitializeOnLoads,ScriptingAssemblies}.json                 2
assets/media/audio/GeneratedSoundBanks/Android/PluginInfo.xml                       1
```

反过来，**必须保持 (大小, CRC32) 一字不变**的：`classes.dex`、`classes2.dex`、`resources.arsc`、
`lib/**`(42 个 so)、`assets/kvl.kvl`、`assets/toLua|fightLua/**`、`assets/bin/Data/**`、`assets/media/**`。

---

## 9. 附：本次静态证据怎么复现

```bash
# 类与方法的位置（1.0.6 / 1.0.7.1426 都适用）
unzip -o -j <apk> 'classes*.dex' -d dex/
java -cp "/usr/share/java/*" org.jf.baksmali.Main d -a 30 dex/classes.dex -o sm/
grep -rn "apk_sign" sm/                       # → com/bsgamesdk/android/api/f.smali:510
grep -rn "utils/a;->a(Landroid/content/Context;)" sm/   # → 只有 f.smali:498 一处调用
md5sum sm/com/bsgamesdk/android/utils/a.smali          # → 1.0.6 与 1.0.7 一致

# 壳的逐文件清单（覆盖 classes.dex 的证据）
unzip -o -j <apk> 'assets/__tpinfo.*' -d tp/
python3 - <<'EOF'
import zipfile, struct
z = zipfile.ZipFile('<apk>'); body = open('tp/__tpinfo.tsc','rb').read()[12:]
pairs = {(struct.unpack('<III', body[o:o+12])[1], struct.unpack('<III', body[o:o+12])[2])
         for o in range(0, len(body)-11, 12)}
cov = [i.filename for i in z.infolist() if (i.file_size & 0xffffffff, i.CRC & 0xffffffff) in pairs]
print(len(cov), '/', len(z.infolist()), 'classes.dex' in cov)   # → 36778 / 37737 True
EOF
```
