# 斯露德假服 · 改客户端 Lua 脚本（免 root / 免重签 / 免推文件）

> 相关：[注入器 gadget](README-注入器gadget.md) §5.5 / §5.6（卡池与战斗高度轴这两个目标的具体实现）·
> [战斗移动轴与高度解锁](README-战斗移动轴与高度解锁.md) §7（外部覆盖那条路的第一次实机验证）·
> [改包签名校验](README-改包签名校验.md)（为什么**不需要**走改包重签）·
> 工具 [`tools/lua_xor.py`](../tools/lua_xor.py)

## 0. 一页速览：三条路

| 路 | 动什么 | 要不要重签/推文件 | 关掉即回退 | 实机状态 |
|---|---|---|---|---|
| **A. 外部覆盖** | `files/thd/toLua/Data/<hash>`（XOR 密文） | 要推文件、要 `enc` 加密 | 否（得手动删） | ✅ 两轮（高度轴、卡池活动） |
| **B. gadget 运行期换 buffer** | 内存里交给 VM 的明文，落盘零改动 | 都不用 | 是（旋钮关掉就走） | ✅ 10-18 卡池（`POOL`）、✅ 10-18 高度轴（`ZAXIS`） |
| C. 改包重签 | APK 内 `assets/toLua/Data/<hash>` | 都要，且 `apk_sign` 会炸 | 否 | ❌ 不需要，见 §7 |

实验期一律用 B（改一次重跑一轮就行、可回退），定稿要长期留着再落 A。

B 做到头的形态（**只靠 hook 的本地化**：把 PC 纪念版那套本地假 GS 整体搬进 gadget，A 的产物一个不留）：[`../../frida-gadget/README.md`](../../frida-gadget/README.md)。机制与 `offline-server/frida/hook_gadget_all.js` 同源，内容 = `_sld_patcher.js` 的规则引擎（`NetWorkManager` 追加假 GS + `Main_IndieGame` 两条 sub + `InitGame→indie`）。

---

## 1. Lua 在哪、什么形态

- 包内（1.0.7 / 1426）：`assets/toLua/Data/<hash>` **3,399 个** + `assets/fightLua/Data/<hash>` **1,589 个**，
  各由 `assets/toLua/toluaLoader` / `assets/fightLua/fightluaLoader` 索引。
  那两个索引就是**纯 hash 清单**（一行一个、CRLF），**不带表名**。
- 保护方案（实测）：整个文件逐字节 XOR 固定 8 字节 key `89 67 45 23 01 ef cd ab`，从偏移 0 循环；
  无头部、无长度字段、无 per-file 派生。
  **密文没有统一魔数**（明文首行不同 → 前缀就不同），认明文/密文一律用 `probe`，它看的是头 8 字节能否异或回
  `--` / `\1bLua` / `local` / `require` / `function`。

  ```bash
  python3 offline-server/tools/lua_xor.py dec <密文> <明文>
  python3 offline-server/tools/lua_xor.py enc <明文> <密文>
  python3 offline-server/tools/lua_xor.py probe <文件>     # 只判断明文/密文
  ```

- 本地已经解出来一批明文可直接 grep：`/home/sld/res/phone/luaplain/toLua/` **1,897 个**、
  `luaplain/fightLua/` **911 个**（是包内的子集，缺的自己 `dec`）。
- ⚠️ **行尾是 CRLF**。跨文件比对（尤其跟手改过的 LF 版本比）要先去 `\r`，否则满屏"不同"。

---

## 2. 定位一张表 = 按内容 grep，别想别的

每张表的**第 11 行**是 `---@class <表名>_Xls : table`（抽样两张都在 11 行），第 1 行是
`local default = {字段列表}` —— 后者连字段名都直接给你，当指纹最省事：

```bash
cd /home/sld/res/phone/luaplain/toLua
grep -l -- '^---@class CommonTime_Xls : table' *        # → 8a233aae5979f58131ffa10ca2122774
grep -l -- '^---@class NewLevelInstance_Xls' *          # → 75320b33287a4e48a35b08186d22d7d5
head -1 <hash>                                           # 反查：这个 hash 是什么表、有哪些字段
```

两个**已核实**的坏消息，别浪费时间：

1. **hash ↔ 表名的推导关系没破**：它不是明文的 md5、不是密文的 md5，也不是
   `md5("CommonTime")` / `md5("@dataTable/CommonTime")` 这类直接形式（都试过，暴力不中）。
2. **运行时 chunk 名与包内文件名无关**：真机流水里 CommonTime 那张的名字是逻辑名
   `@dataTable/CommonTime`（同理 `@UnityEngine/Vector3`、`@tolua.lua`、`LuaCoroutine.cs`）。
   PC 那边才是 `Modules/xxx/yyy` 的形态。**所以按名字匹配这条路是死的，一律按内容认。**

---

## 3. 路 A：外部覆盖（改文件，一次生效到删掉为止）

```bash
# 1) 从包内取原版并解密
unzip -p /home/sld/res/apk/sld_1.0.7.1426_bilibili.apk assets/toLua/Data/<hash> > /home/tmp/x/<hash>.bin
python3 offline-server/tools/lua_xor.py dec /home/tmp/x/<hash>.bin /home/tmp/x/edit.lua
# 2) 改 edit.lua（只动值，别动结构）
# 3) 加密回去
python3 offline-server/tools/lua_xor.py enc /home/tmp/x/edit.lua /home/tmp/x/<hash>
# 4) 推到手机（外部目录，不是 assets）
adb push /home/tmp/x/<hash> /storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/toLua/Data/
```

- 外部优先于包内，实测有效（高度轴那轮）。
- 台账：`kvl.kvl` 里这一条的 md5 要跟着换，不然 1583 台账的逐条校验会缺一块
  （见 [README.md](README.md) §3 第 1 条）。"无热更"下不拦进游戏，但别留破损。
- 回退 = 删掉外部那个文件。

---

## 4. 路 B：gadget 运行期换 buffer（`POOL` 这套）

机制：游戏交给 Lua VM 的是**解密后的明文**，在 `load*` 那一步换掉它就行得通。

**挂哪个模块** —— 这是第一轮翻车的地方：

| 模块 | 真机 3,800 次调用里 |
|---|---|
| `libtolua.so`（LuaJIT，852,592 B） | **全部走它** |
| `liblua54.so`（Lua 5.4，1,635,264 B） | **0 次** |

（PC 那份 `_sld_patcher.js` 本来就是 `tolua.dll` + `lua54.dll` 两个一起挂的，只挂一个必漏。
`liblua54.so` 计数 0 也可能是那轮没进战斗，见 §7。）

**一个 chunk 走四站**（真机流水实测）：

```
tolua_loadbuffer → luaL_loadbuffer → luaL_loadbufferx → lua_loadx
```

**参数布局决定敢不敢改**：

| 布局 | 导出 | 能不能改 |
|---|---|---|
| `(L, buff, sz, name[, mode])` | `luaL_loadbuffer` / `luaL_loadbufferx` / `luaL54_loadbufferx` | **可改** |
| `(L, s)` | `luaL_loadstring` / `luaL54_loadstring` | 只记流水 |
| `(L, fname, mode)` | `luaL_loadfilex` / `luaL54_loadfilex` / `luaL_loadfile` | 只记路径 |
| `(L, reader, dt, name)` | `lua_load` / `lua_loadx` / `lua54_load` | **`a[1]` 是函数指针，当字符串读会崩**；名字在 `a[3]` |
| 未知 | `tolua_loadbuffer` | 只数次数，一个指针都不碰 |

**改写那五行**（顺序不能省）：

```js
var buf = Memory.alloc(out.length + 1);
buf.writeByteArray(out);
buf.add(out.length).writeU8(0);        // Lua 那边可能按 NUL 结尾取
POOL_KEEP.push(buf);                   // 不留住就被 frida 回收, 游戏读到飞掉的内存
a[1] = buf; a[2] = ptr(out.length);
```

**三道安全阀**（照抄 `hook_gadget_all.js` 的 `poolPatchText()` / `tryPatch()`）：

1. 行关键字必须**唯一**（`txt.indexOf(key, a+1) >= 0` 就算重），正则必须真的命中，否则计入 `bad`；
2. **`hits > 0 且 bad == 0` 才写回**，宁可整轮不改，也不改一半；
3. **幂等**：第二站必然看到第一站的产物 → `已是目标 N → 不改写`。真机日志里那两条连着的就是它。

**换一张表要动什么**（已经有第二个目标 `ZAXIS` = 战斗高度轴，照它抄）：钩子、四站链、写回那五行、三道安全阀
**一个字节都不用改**，只加三样——

1. 一个"认表"函数（按内容，别按 chunk 名，见 §2）。**条件要够窄**：`ZAXIS` 用的是
   「首行 `local default = {id=0,stageLevel=0,`」+「文里有 `["1000101"]=setmetatable({`」+「有 `controlMode=`」三条同时成立 ——
   只留第一条会误伤 `TowerLevel_Xls`（`c2b9b7e8…`，元素塔关卡表，首行前缀一模一样）。
2. 一个 `xxxPatchText(txt)`，返回 `{text, hits, same, bad}`：`hits`=改了几处、`same`=本来就是目标值、
   `bad`=形状没认出来。**优先做等长替换**（`controlMode=0`→`1` 就只动一个字符，尺寸都不变）。
3. 一枚旋钮 `var ZAXIS = false;` + 在 `tryPatch()` 里挂一个分支；`armPool()` 的挂载条件已是 `POOL || ZAXIS`。
   `POOL_SIG` 那种"注释当门"的老毛病别再犯：**门只用于认表，认出来就必须把命中/已是目标/没认出的数报出来**。

日志里的改写计数 `poolDone` 是**所有目标合计**的，所以第二个目标可能报"第 4 次改写"——不是 bug。

**开关与副本**：`POOL` / `ZAXIS` / `POOL_LOGFLOW`（后者默认 `false`，排查期翻 `true` 逐条打流水）；
变体一律用 [`frida/make_variants.sh`](../frida/make_variants.sh) 从基线生成（它会 `node --check` 并打 md5），
**改完基线忘了跑它 = 测的是旧脚本**；设备侧文件名必须仍是 `hook_redirect_trust.js`
（`libTool.config.so` 写死了路径），副本在 `/home/tmp/sldcarrier/device-phase*/`。

---

## 5. 验证套路（动 Lua 前后都要做，别直接上真机）

1. **别 append 自由 Lua**。本机没有任何 lua 解释器（`which lua lua5.1 lua5.4 luajit luac luac5.4` 全空），
   语法错了没人拦得住，而后果是**整张表消失**。所以只做"字节级替换值"，不写新代码。
2. **node 打桩跑真脚本 + 真字节**：模板 `/home/tmp/sldcarrier/smoke_pool2.cjs`
   （stub `Process/Memory/Interceptor/Java/setInterval`，两个模块各喂一份假导出表），**十五条**断言：
   1–9 卡池 —— 命中数/尺寸变化、**改出来的字节与已在真机验证过的手改版忽略 CRLF 后逐字节一致**、
   别的 chunk 不动、幂等、注释被剥掉仍能改、四种只读布局一次都不 memcpy、小 chunk 不 memcpy、两种打印模式；
   10–15 高度轴 —— 命中 210 且**等长**改写、**逐位置只允许 `controlMode=` 后面那一个字符 `0`→`1`**、
   改动集合 ⊇ 真机验证过的 route-A 手改版（那 8 关）、`local default` 那处也翻了、幂等且 `controlMode=2` 一处未动、
   1.0.7 包内那份（结构更老、649 个 0、没有轨道关）同样吃得下。
   `node smoke_pool2.cjs` = 排查模式，`node smoke_pool2.cjs quiet` = 发布模式，**两遍都要跑**。
   ⚠️ 它加载的是**变体** `hook_gadget_pool_zaxis.js`（`POOL`+`ZAXIS` 同开），不是基线 ——
   跑之前先 `./frida/make_variants.sh`，脚本自己会拒绝旋钮形状不对的基线。
3. **python 侧比对**（去 CR）：

   ```bash
   python3 -c "a=open('got','rb').read().replace(b'\r',b'');b=open('want','rb').read().replace(b'\r',b'');print(a==b,len(a),len(b))"
   ```

4. **真机三条证据**（缺一不可，别看注入器的状态卡）：`gadget.log` 的 `卡池:`/`load:` 行、
   游戏内现象、假服 `data/logs/server.out`（时钟差 8 小时，先换算）。

---

## 6. 已经做成的两个例子

| 目标 | chunk（hash） | 改了什么 | 走哪条路 | 状态 |
|---|---|---|---|---|
| 卡池全开 | `8a233aae5979f58131ffa10ca2122774` = `CommonTime_Xls` | 63 个被池引用的 `timeId` 行，`beginTime/overTime` → `2020-10-10 10:00:00` / `2029-9-27 10:00:00`（抄官方常驻模板 `9999` 的原值） | B（hook） | ✅ 10-18 真机 |
| 战斗高度轴 | `75320b33287a4e48a35b08186d22d7d5` = `NewLevelInstance_Xls` | 第 1 章 1~8 关 `controlMode 0 → 1` | A（外部覆盖） | ✅ 真机 |
| 战斗高度轴·全关卡 | 同上 | **所有** `controlMode=0` → `1`（1583 那份 210 处、含 `local default` 那一处；11 个轨道关 `2` 不动） | B（hook，`ZAXIS`） | ✅ 10-18 真机 |

卡池那轮的算术依据（为什么正好 63 行）留在 [注入器 gadget](README-注入器gadget.md) §5.5 的表里：
129 个池 → 64 个被引用的 `timeId` = 63 个真窗口 + `9999`（常驻模板）+ `0`（不看时间）；`9203` 在表里但没池引用。

---

## 7. 踩过的坑

1. **只挂 `liblua54.so`** → 一条 `load` 都没有，因为配置表全走 `libtolua.so`（见 §4）。
2. **拿 `---@class` 注释当门** → "没调用"和"调用了但门没过"表现完全一样，白跑一轮。现在只当日志提示。
3. **想按 chunk 名匹配** → 运行时名是 `@dataTable/<表名>`，跟包内 hash 毫无关系（见 §2）。
4. **`lua_load` 的 `a[1]` 当字符串读** → 那是 reader 函数指针，会崩。名字在 `a[3]`。
5. **CRLF** → 包内明文是 CRLF、手改版常是 LF，比对不去 CR 会以为改坏了（差值正好等于行数时就是这个）。
6. **`clearInterval(null)`** → QuickJS 里会抛并打断整个脚本；首次同步成功时定时器句柄还没赋值，要判空。
7. **忘了手机上外部覆盖还留着手改版** → hook 只会报 `已是目标 N → 不改写`，看着像"补丁没生效"。
   测 B 之前先删掉 `files/thd/toLua/Data/<hash>`，让它回落到包内原版（`已是目标 0` 才是拿到了原版）。
8. 一次 `Edit` 用 `allow_multiple` 把辅助函数自己替换成了自己 → **自递归**。命中数不是 1 就要停下来看。
9. **表有两个版本**：同一张 `NewLevelInstance` 在 1583 外部增量里是 1,494,415 B（2,038 行、有轨道关 `2`），
   在 1.0.7 包内是 812,314 B（1,206 行、`649 个 0 / 142 个 1`、没有 `2`）。按"当前盘上那份"设计的字段分布
   换个版本就不成立 —— 认表的条件要两份都成立，改动集合要两份都跑一遍（harness 第 15 条就是这个）。
10. **只翻显式写出来的行不够**：`NewLevelInstance`（1583 那份 2,038 行）里有 **424 行**根本不写 `controlMode`，
    靠 `local default` 继承 `0`（1.0.7 包内那份 1,206 行里也有 416 行这样）。
   `default` 那一处也在 `controlMode=` 的匹配里，顺手一起翻才对 —— 这类"表头 default + 行内覆盖"的形状
   是这套导表的通用结构，动任何一张表前先数一遍"显式写了的"和"没写的"。

## 8. 现状与待办

- **两个目标都已真机生效**（`POOL` 10-18 03:35、`ZAXIS` 10-18 用 `device-phase5-pool-zaxis-skip/`）。
  `ZAXIS` 那轮没留 `gadget.log`，所以 `命中` 的确切数字与"这张表是登录时还是进战斗时加载的"还没有日志证据；
  顺带它证明了**进战斗才用的表也经这条钩子改得到**（原来担心只有大厅那批表走 `load*`）。
  下一次想拿数字：`grep '高度轴:' gadget.log`，手机若还留着 route A 那份手改外部文件会报 `命中 202` 而非 `210`。
- **fightLua（战斗 Lua）这条线还没验**：`liblua54.so` 零调用可能只是那轮没进战斗。
  要 hook 战斗脚本，先拿一轮"进过战斗 + `POOL_LOGFLOW=true`"的流水确认它经不经 `liblua54.so`。
- 改包重签（路 C）不需要：见 [改包签名校验](README-改包签名校验.md)（`apk_sign` 那条路还没实机验证，也不去走）。
