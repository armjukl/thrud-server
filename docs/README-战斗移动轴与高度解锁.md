# 斯露德 1.0.7 · 战斗移动轴与高度轴解锁

> 最后更新：2026-10-18 ｜ 当前方案 [`README.md`](README.md) ｜ 战斗系统缺口 [`README-待补功能.md`](README-待补功能.md) §5 ｜ 资源与编码 [`README-资源指引.md`](README-资源指引.md)

结论：**1.0.7 的战斗不是没有高度轴，而是高度轴按关卡发放**（`NewLevelInstance.controlMode`）。
它是纯客户端明文 Lua 表里的一个整数，可以通过铺外部资源包解锁，**不用碰 APK、不用改假服**
（外部覆盖层已真机验证生效，见 §7）。
**2026-10-18 已照这条路把第1章第 1~8 关解锁，真机可升降 ✅**（包与验证过程见 §7）。
同日又做了**运行期 hook 版 `ZAXIS`**：同一条 frida 钩子把**全部** `controlMode=0`（含继承 `default` 的 424 行）
一次翻成 `1`，不推文件、不改台账、关旋钮即回退 —— **10-18 真机已生效 ✅**（§7 末）。
真正的滚转（绕自身前进轴的 Z）才是被砍掉的那个，没有开关可解。

---

## 1. 三档飞行模式

`fightLua/e239427515a1af12d2ab9b2e8cd75bd7:10-14`

```lua
Enum_MoveControlType = {
    HorizontalPlane = 0, --水平面飞行
    FreeLy          = 1, --自由飞行
    TrackPlane      = 2, --轨道飞行
}
```

分派点，每类动作状态在 `Init` 时读一次关卡表：

| 位置 | 动作 |
|---|---|
| `fightLua/f6495645145311c7e1f7c1ecf44ca93e:54-61` | `MoveActionState` → `Move_Horizontal / Move_FreeFly / Move_TrackPlane` |
| `fightLua/bf323fe0c2eb523de6eb4a9be90e5e18:52-59` | 冲刺（TrackPlane 额外置 `__needCheckMoveParam=false`） |
| `fightLua/9d519bc985c17dc6822b6686c37e0932:99-105` | 闪避 → `EnterDash / EnterDash_FreeFly / EnterDash_TrackPlane` |
| `fightLua/f6495645...:578`、`:659` | 技能位移：只判 `== 0`，TrackPlane 落进 FreeFly 分支 |

算法本体在 `fightLua/3e66bb4f476bf9d5baa8472dae6d87ca`（`MOVE_UTILS`，移动工具类）：
`AiMove:94` · `Move_Horizontal:156` · `Move_FreeFly:267` · `Move_TrackPlane:401` · `Rotate:529`。

**这套分派只管玩家**。`fightLua/f6495645...:437` 里非 `BattleUnitType.Player` 的单位一律走 `AiMove`，
AI/boss 不看 `controlMode`。

| 模式 | 位置自由度 | 升降键 |
|---|---|---|
| 0 水平面 | `ProjectOnPlane(_forward, Vector3.up)`（`:165`）把朝向拍平，且摇杆 y 强置 0（`:171` `Vector3.Set(_v3JoyInput, _moveParam.x, 0, _moveParam.y)`）→ 严格一个水平面 | **隐藏** |
| 1 自由飞行 | 摇杆走**完整** `_qCurRotation`（`:281`），外加独立的世界 up 升降速度项（`:349-368`，`:363` `Vector3.MulNumber(Vector3.up_global(), _frameUdSpd, _udVelocity)`） | **有** |
| 2 轨道 | `_v3ReceiverVelocity.z = 0`（`:475`）+ `_vehicleCom:FormatLocalPositionInTrackBoundary`（`bf323fe0...:377`、`9d519bc9...:217`）→ 字面锁深度 | 隐藏（右摇杆/锁定键也一起藏，见 §3） |

---

## 2. "Z轴"的三种理解，处境完全不同

坐标口径：**X/Z = 水平面，Y = 高度**。

| 说法 | 实际 | 证据 |
|---|---|---|
| 高度轴（升降） | **有**，但是独立一路输入、且按关卡发（`controlMode==1`） | 见 §3 |
| 纵深（沿相机前方推拉） | 模式 0/1 都有；只有 11 个轨道关被 `velocity.z = 0` 锁死 | `3e66bb...:475` |
| 滚转（绕自身前进轴的旋转 Z） | **彻底没有**，不是开关能解的 | `3e66bb...:69` 注释 `---永远不动Z`；另 `0f2351bcc286634cc9dc8b13d1016223:497`、`60b058440910671543b3c82facdb4948:96`；`BattleInputType` 里没有对应槽位；相机还设了 `m_WorldUpOverride`（`toLua/a58f7062946d2e57fbbcb10dae726c68:118`） |

想做滚转等于**新增一个操作维度**：加输入槽 → 加 `cameraParam.z` 消费点 → 去掉三处 `_euler.z = 0` →
骨骼要有侧倾动画 → AI 瞄准/碰撞全部按 `LookRotation(dir, Vector3.up)` 假设 up=世界up。
这些虽在可改的 Lua 层，但工作量和风险与"翻个表"完全不是一个级别，本文件不展开。

---

## 3. 高度轴的完整链路

### 3.1 输入层是三路独立通道

`toLua/07df7348bf8d373c2e1f3bfe9ac2e267:690-697`

```lua
self.joystickInputData.moveJoystickOffset   -- 左摇杆：水平面移动
self.joystickInputData.rotateJoystickOffset -- 右摇杆：偏航/俯仰
if not G_battleInputMgr.switch_MoveUpDown then
    self.joystickInputData.moveUDOffset = 0 -- 升降：独立一路，被开关掐
end
```

枚举 `toLua/f9b4d0553d3c2c27d80f1ac507de0b82:11-16`：`MoveUpDown = 20, --世界坐标上下移动`。
发包 `toLua/90bfdf92dc411b0e2cb422c78672fb26:1067-1077`
`SendPlayerMoveInput2Core(leftVec3, rightVec3, udParam, fixPos, fixDir)` → `msg.udParam`。
战斗侧 `fightLua/09526c431d940a95d8bb3459424cbecb:188-224` `PlayerPressKey(..., _udParam, ...)` → `SetUDParam`。

**结论：高度轴和摇杆不是同一个按键**，它是独立控件 / 独立键 / 独立协议字段。

### 3.2 三种设备上的实际按键

| 设备 | 绑定 | 位置 |
|---|---|---|
| 手机 | 独立"升降摇杆"控件 `UIBattleUpDownRockerCtrl`，HUD 布局槽 `UpDownRocker`，响应区 104×222（取自 `BattleDefault_Xls["446"].value4`） | `toLua/4f52bc706bba37c992af71d2097cc41e:12-13`、`:223` |
| PC 键盘 | `V`（预设1）/ `LeftShift`（预设2），`button="Y轴升降"` | `toLua/8a1a726c8bde9a528cd2a5ccebf3bd18:28-29`（`DefaultKeyPc_Xls` id 21/22） |
| 手柄 | **默认没绑**：`defaultKeyXbox=""` 两套预设都空 | 同上 |

盘上真机账号的 HUD 布局留档 `res/phone/files/thd/BtnLayout/200173153Settting.txt`：
`{"Hide":false,"name":"UpDownRocker","canHide":false,"id":15,"alpha":1,"parent":6,"Pos":{"x":-575.49,"y":270.81}}`
—— `canHide:false`，说明它确实在原服玩家屏幕上出现过（左侧偏上竖条）。

### 3.3 关卡闸门

`toLua/f9b4d055...:106-111`（进战斗时）与 `toLua/4f52bc70...:45-58`、`:180-191`（控件显隐）都是同一句：
`controlMode == 1` 才给升降。引导系统还能临时显隐它（`toLua/c6f67981a89916320951c4e301b7d92f:1473-1476`
→ `battleGuide_GuideBtn_MoveUpDown`）；我们假服强制跳过引导（`src/data/guides.ts`），这些节点不会跑，
显隐就只由 `controlMode` 决定。

游戏本身教过这个键：`toLua/c0e91e7e9f17454491c34851997eb2f3:273`
`id=110005, tipText="拖动升降键可调整飞行高度", tipTextKeyboard="按下升降键可调整飞行高度"`。

PC 模式（`SDKMgr.Current_PCType()`）直接 `SetActive(false)`（`4f52bc70...:46-48`），走键盘。

---

## 4. 1.0.7 数据里的模式分布

表 `toLua/75320b33287a4e48a35b08186d22d7d5` = `NewLevelInstance_Xls`，2038 行（1614 行显式写 `controlMode`，其余继承 `default.controlMode=0`）。

| controlMode | 行数 |
|---|---|
| 0 水平面 | **633** |
| 1 自由飞行 | **1394** |
| 2 轨道 | **11** → `3120101-3120105`、`4020851-4020853`、`4061251-4061253` |

章节维度（按 `mainlevel`）：第1章 142 平面 / 21 自由，第2章 52 / 88，`mainlevel=32` 999 自由 / 41 平面。

**第1章的分界点**（假服 `MAIN_LEVEL` 表换算后）：

| 关卡 | instance | controlMode |
|---|---|---|
| 序章 | `1000001` `1000002` | 0 |
| 第1章 1~8 关 | `1000101`-`1000108` | 0（**看不到升降键**） |
| 第1章 9~11 关 | `1000109`-`1000111`（MainLevel `101109`-`101111`，遭遇战） | 1（**有升降键**） |
| 第1章 12 关 | `1000112` | 0（回落） |

假服会下发的 1915 条 `MAIN_LEVEL` 对应 instance：**1599 个 mode=1 / 316 个 mode=0**。
所以从第1章一路往前打的人基本见不到这个键，但游戏里大部分关卡是有它的。

`src/data/mainlevels.ts` 里 `MainLevel.id → [levelInstanceId, stageLevel]`，
`battleEnterInfo` 就是把 `levelInstanceId` 塞给客户端去查这张表（`src/payloads.ts:717-745`）。

---

## 5. 高度有没有上限

**Lua 侧不存在高度钳位**，逐条查过：

| 可能的钳位 | 实际 |
|---|---|
| `NewLevelInstance.areaCollider` | 2039 行**全部** `xlsNilTable`，关卡没配区域盒 |
| `Enum_MotionLimitKeyType` | 只有 `NormalMove/Dodge/Sprint/Turn/RunHit`（`fightLua/e2394275...:18-24`），**没有高度项**；`NormalMove=0` 是全禁移动 |
| 对 player 的 Y 范围判断 | 不存在，只有撞墙后的修正与回滚 |

### 能改的（`StateParameter_Xls` = `toLua/7d7e242aa1381b3504f78f0b86c3a5c2`，行 `["1"]` 为玩家默认）

| 字段 | 现值 | 含义 / 消费点 |
|---|---|---|
| `yLimitAngle` | `{[1]=20,[2]=160}` | 俯仰角限制：机头与正上方夹角区间，等价仰角最多 70°。取用 `fightLua/42db71844f2e456016d1b7dde88817d2:31-40`，钳位 `MOVE_UTILS.Rotate:577` |
| `liftingAcceleration` | `{[1]=200,[2]=-250}` | 升降加速度，`[1]`上 `[2]`下 → `Move_FreeFly:349-350` |
| `liftingMaxVelocity` | `{[1]=250,[2]=300}` | 升降限速 → `Move_FreeFly:356` |
| `liftingAirFriction` | `5.0` | 升降阻尼 → `Move_FreeFly:360` |
| `maxVelocity` / `planeMaxVelocity` | `15` / `9` | 水平速度（与升降不同量级，别拿升降去对齐，按倍数小步试） |

取行链：`PlayMode.stateParameter`（`fightLua/45c74e96b77b175465dea58c4748c6e2:85,276-277`）
→ `GetDict("StateParameter", id)`（`fightLua/e1c24c2ddbad9db2cc913bb76de9517c:102`）。

### 改不了的（真正拦着你的东西）

- **场景空气墙**：Unity collider 在 AB 里（二进制）。检测 `toLua/f4bd2aeb13e4ce64cd7b2fbff22de221:742`
  `LocalPlayerDetectCollision`（`CheckIsObstacle`/`CheckIsNav`），FreeFly 分支取切向 `:795`；
  滑行修正 `Move_FreeFly:338`；按帧回滚位置 `fightLua/942081a7ad8cdd28577001f095c78083:673` `PlayerHitWall`。
- **相机包围盒**：native `CalcBoundsBox(List<GameObject>)` / `CalcCameraPositionByBoundsBox` / `GetAABBCorners`
  （`res/backup/offline-old/dump/il2cpp_runtime_dump.cs:12624-12626`）。飞太高最坏表现是镜头跟不上/出画，不是被弹回。
- **`BattleJob.TrackType{None,TrackTarget,TrackPos,BoundaryTrack}`**（同上 dump:31318-31325）—— 轨道边界跟踪是 C# job。
- 怪的高度由它们自己的 AI 调（`UnitFixHeightS2C` → `BehavState_FixHeight`，`fightLua/956b84231bce38f132fc7513322a2a76`，
  配 `MonsFixHeightEnd`）。你拉到极端高度它们不跟，容易全程打空。锁定态反而会**放宽**仰角限制
  （`toLua/516d522a10d928e40fbb241a60d158dd:109` 注释"锁定状态 无视仰角限制"）。

对我们有利的一条：区域边界要靠战斗服下发 `ChangeAreaBoundary_S2C` 修改（`fightLua/738b667fda2fd1ce6e9ae4e2175683db:601`），
**该协议假服未实现**（[`README-待补功能.md`](README-待补功能.md) §5：战场内 `12xxx` 实时同步未做），
离线模式里限区/缩圈等于不存在，不会有人把你圈回去。

---

## 6. 改包解锁方案（不碰 APK）

### 6.1 三条路

| 路线 | 判断 |
|---|---|
| 运行期 hook 换 buffer（`ZAXIS`） | 内存里改明文，**不推文件、不改台账、关掉旋钮即回退**。实验期走这条（§7 末） |
| 改 APK 内 `assets/toLua/Data/<同hash>` | 技术可行（同一把 key，`lua_xor.py enc` 出来的密文可塞回），**但破坏签名** → 违反 [`README.md`](README.md) §9 铁律，且 B 服 SDK 有签名校验风险。**不走** |
| 铺外部 `files/thd/toLua/Data/<hash>` | 外部优先，等效解锁，**重启后一直生效**。定稿要长期留着走这条（§7 就是它的首次真机验证） |

### 6.2 编码链已在目标文件上验证

`res/phone/files/thd/toLua/Data/75320b33287a4e48a35b08186d22d7d5`（1,494,415 B）：

```bash
python3 offline-server/tools/lua_xor.py dec <盘上密文> /home/tmp/sld-zaxis/lvl.lua   # 与 luaplain 逐字节一致 ✅
python3 offline-server/tools/lua_xor.py enc /home/tmp/sld-zaxis/lvl.lua out            # 与原密文逐字节一致 ✅
```

key 为固定 8 字节 `89 67 45 23 01 ef cd ab`，全文件循环、无头部（`tools/lua_xor.py` 文档字符串）。

### 6.3 改动清单

| 目的 | 文件 | 改法 |
|---|---|---|
| 给关卡高度轴（必做） | `toLua/Data/75320b33287a4e48a35b08186d22d7d5` | 目标行 `controlMode=0` → `1` |
| 飞得更高更快（可选） | `toLua/Data/7d7e242aa1381b3504f78f0b86c3a5c2` | `yLimitAngle {20,160}`→`{5,175}`；`liftingMaxVelocity/liftingAcceleration` 上调 |
| 手柄补升降键（可选） | `toLua/Data/8a1a726c8bde9a528cd2a5ccebf3bd18` | id 21/22 的 `defaultKeyXbox=""` 填一个键 |

流程：dec 出明文 → 只改目标行 → enc 回密文 → 铺到手机
`/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/toLua/Data/<同hash>`。
**假服不用改、不用重启**：战斗核心在客户端本地跑，`udParam` 不经过我们的网关。

### 6.4 代价

1. **md5 与 `kvl.kvl` 台账**：台账字段 2 存的是**盘上密文**的 md5（实测：`toLua/Data/75320b33…` 台账值
   `e71a2a93…` = 密文 md5，不是明文 md5）。改完 Lua 要**把这一条的 md5 换成新密文的 md5**，
   这才是已验证的那条路（§7）；整包铺 + 台账对齐也才不违反铁律 2。
   改法：全文替换那一处 32 位十六进制串即可（长度不变，实测 `kvl.kvl` 只有 30 字节变动）。
   即便不改，运行上也看不出来：假服钉死 `resVersion=1583` + `hotUpdateUrls:[]`
   （`src/config.ts`、`src/http.ts` 的 `getClientUpdateData`），校验/更新路径不触发，也没有 AB/Lua 运行期哈希校验
   —— 但没必要留这个不一致。
   顺带一条实测发现：**同名 hash 在 APK 和外部目录是不同内容的文件**
   （`75320b33…`：APK 自带 812,314 B / md5 `1d5991c2…`，外部 1583 增量 1,494,415 B / md5 `e71a2a93…`；
   `8a233aae…`：APK 30,649 B vs 外部 168,692 B）。所以外部铺上去的那份才是实际生效的那份。
2. 只能**改写已存在的 hash 文件**，加不了新模块（hash 命名规则未破，见 [`docs/old/PROJECT-LOG.md`](old/PROJECT-LOG.md)）。
   本方案的改动全在既有文件内，不受影响。
3. **`newkvl.kvl` 不动**（未解的一项）：它 36,589 条、头部是 `ResVersion : 1426`，
   `toLua/Data/75320b33…` 那条的值是 `1d5991c2…` = **APK 自带那份**的 md5，而不是外部 1583 那份；
   但同一份里 `8a233aae…` 的值却是手机上改过之后的外部文件 md5（`c99df487…`）。
   两条规则不一致，说明它既不是「外部台账的副本」也不能当作加载依据 —— 加载按 hash 文件名查，不看它。
   实测里它跟着一起铺了，照做即可，别指望它兜底。

---

## 7. 外部覆盖层生效性（2026-10-17 真机实测：已生效）

> 这一节是外部覆盖（路线 A）的**第一次实机验证记录**；通用做法（怎么定位表、XOR 加解密、推文件、
> 台账 md5、以及运行期 gadget 那条不用推文件的路线 B）见 [改Lua脚本](README-改Lua脚本.md)。

原先 `docs/old/PROJECT-LOG.md:476` 把「外部 Lua 覆盖层」标为**生效性未验**，本文件当时也只靠两条间接证据
（日志 `读取外部 …/thd/toLua/toluaLoader`；`LuaBundleTableCount 4440` = 外部 loader 行数，APK 自带 3397）。
**现在这条假设已关闭**：实测铺一个外部 `toLua/Data/<hash>` 就改了游戏行为。

实测样本 `test/thd/toLua/Data/8a233aae5979f58131ffa10ca2122774`（167,748 B 密文）：

| 项 | 结果 |
|---|---|
| 是哪个模块 | `CommonTime_Xls`（活动时间表，明文 1026 行） |
| 改了什么 | `timeId` 9000/9201/9202/… 的 `beginTime`/`overTime` 拉到 `2020-10-10 ~ 2029-9-27`（126 行差异） |
| **APK 里有没有同 hash 文件** | **有** —— `assets/toLua/Data/8a233aae…` |
| **APK 自带 loader 有没有列它** | **有** —— 在 `assets/toLua/toluaLoader`（3397 条）里 |
| 部署内容 | 那一个 `Data` 文件 + `thd/kvl.kvl`、`thd/newkvl.kvl`；**没有铺 `toluaLoader`**。事后核对：`test/thd/kvl.kvl` 与手机盘上那份**只差 1 条** —— `8a233aae…` 的 md5 已换成改后的 `c99df487…`，即**验证过的这条路是连带台账一起改的**（见 §6.4 第 1 条） |
| 游戏内表现 | 按改后的时间生效 ✅ |

这比"换整张 loader"强得多：客户端在 **APK 自带 loader 已列出该 hash** 的情况下，仍然优先读了外部盘上的同名文件。
⇒ **外部优先是逐文件生效的**，改 `controlMode` 这类既有 chunk **不需要动 loader、不需要重排台账（只需换那一条 md5，§6.4 第 1 条）、不需要重启假服**。

### 三步 A/B（2026-10-18 真机：全过，高度轴已解锁）

覆盖层生效 ≠ 翻 `controlMode` 的高度轴效果已验。这三步已走完：

1. 进 MainLevel `101101`（第1章第1关，`controlMode=0`）→ 屏幕左侧**没有**升降摇杆。
2. 进 `101109`（第1章第9关，`controlMode=1`）→ 左侧有竖条控件；PC 键盘按 `V` / `LeftShift`。
3. 把 `1000101`~`1000108` 改成 `controlMode=1` 重进 `101101` → **控件出现、可升降 ✅**。

⇒ 结论 §1/§3 的链路（`NewLevelInstance.controlMode` → `switch_MoveUpDown` + `UIBattleUpDownRockerCtrl`）
在真机上成立；第 1 章 1~8 关的高度轴**已解锁**，走的就是 §6.3 那条铺外部 Lua 的路。

排查手段（当时没用上，留着）：手机 `/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/clientLog/Thrud<日期>.log`
看有没有 `InstancePrefab` / `GetLayoutData` 相关 nil；`npm run selftest` 与此无关（纯客户端改动）。

### 试飞包（2026-10-18 已出，范围 = 第1章第 1~8 关）

要铺到手机 `files/thd/` 的两个文件（覆盖了原来那份）：

| 文件 | 说明 |
|---|---|
| `test/thd/toLua/Data/75320b33287a4e48a35b08186d22d7d5` | 1,494,415 B 密文，改后的关卡表 |
| `test/thd/kvl.kvl` | 4,508,995 B，`75320b33…` 那条 md5 → `82089336…`（原 `e71a2a93…`） |

`newkvl.kvl` 原样不动（见 §6.4 第 3 条）。改前两份已备份为 `test/thd/kvl.kvl.bak` /
`test/thd/newkvl.kvl.bak`（`test/` 不入库，验完随手删）。

| 项 | 结果 |
|---|---|
| 改的 8 行 | `NewLevelInstance` id `1000101`~`1000108` = MainLevel `101101`~`101108`（第1章 1~8 关，`sceneId` 100/101/102/112） |
| 改法 | 每行 `controlMode=0` → `1`，其余字段一字未动 |
| 明文差异 | **恰好 8 个字节** `0x30→0x31`（`0`→`1`），文件长度不变 |
| 密文 md5 | 原 `09017de9…`（明文）→ 新 `19364cecc…`；密文 `82089336…` |
| 往返自检 | `enc(dec(盘上原文件)) == 原文件`、`dec(新密文) == 新明文` 均逐字节成立 |
| 第9~11关 | `1000109/110/111` 本来就 `controlMode=1`，未动 → 可直接当对照组（上面第 2 步） |
| 第12关 | MainLevel `101112` → `9000199`，表里没有 `controlMode` 字段（缺省即水平面），未动 |
| 回滚 | 把 `test/thd/kvl.kvl.bak` 还原成 `kvl.kvl` 并删掉那个 `Data` 文件，即回 APK/1583 原样；APK 与假服都没碰 |

第1章还有 4 行 `mainlevel=1` 但 `controlMode=0` 的关卡**没包进这次**：`1000112`（MainLevel `461101`）、
`1000131/132/133`（`461102/461103/461104`，`sceneId` 203/401/103）—— 入口不在第1章主线列表里，先不动。
验证 OK 要一起开的话，同一文件里把这 4 行也翻掉重 enc 即可。
`StateParameter_Xls`（`yLimitAngle` / 升降速度）这次**没调**，先按原手感验。

### 运行期 hook 版（`ZAXIS`：一次把全关卡发下来，不推文件）

上面"一起开"的那句已经被做掉了 —— 不用重 enc、不用推文件、不用改台账。
`hook_gadget_all.js` 里加了一枚 `ZAXIS`，走 [注入器 gadget](README-注入器gadget.md) §5.5 那条已经真机验证过的
load 钩子，只是多认一张表（做法与为什么这样切，见 [改Lua脚本](README-改Lua脚本.md) §4）：

| 项 | 内容 |
|---|---|
| 目标 | `toLua/75320b33…` = `NewLevelInstance_Xls`（认表：首行 `local default = {id=0,stageLevel=0,` + 文里有 `["1000101"]=setmetatable({` + 有 `controlMode=`；单看首行会误伤 `TowerLevel_Xls` = `c2b9b7e8…`） |
| 改法 | 每一处 `controlMode=0` → `1`，**含 `local default` 那一处**；`2`（轨道，11 行）不动；等长替换，长度不变 |
| 覆盖面 | 1583 那份 2,038 行里 1,614 行显式写了 `controlMode`（全文 1,615 处，含 `local default` 那处），其中 **210 处是 `0`**；剩下 **424 行不写、靠 default 继承** → 翻 default 才一起解锁；上面缓着的 `1000112/131/132/133` 自动在内 |
| 两个版本都吃 | 1583 外部 `1,494,415 B`（210 个 0 / 1,394 个 1 / 11 个 2）、1.0.7 包内 `812,314 B`（649 个 0 / 142 个 1 / 无 2）—— 本地各验一遍 |
| 日志 | `高度轴: controlMode= 共 1615 处 → 命中 210 / 本来就是 1 的 1394 / 轨道 2 不动 11 / 没认出 0 name=@dataTable/NewLevelInstance` + `高度轴: 第 n 次改写 (1494415B -> 1494415B)`；再喂一次 → `命中 0` → 不改写 |
| 与 route A 的关系 | route A 那份手改文件还在手机上时，`命中` 会是 **202**（差 8 处已是目标值）—— 想干净验证就删掉 `files/thd/toLua/Data/75320b33…` 让它回落原版 |
| 本地验证 | `smoke_pool2.cjs` 十五条全 `true`（两遍：默认 + `quiet`），其中第 12 条是"改动集合 ⊇ 已真机验证的那 8 关" |
| 状态 | ✅ **真机已生效**（10-18 用 `device-phase5-pool-zaxis-skip/`，游戏内可升降）。这轮没留 `gadget.log`，`命中` 的确切数字与"这张表何时加载"未取日志证据 |

这张表**可能是进战斗才加载**，所以测的时候必须真打一关；只在登录界面看 `gadget.log` 是等不到 `高度轴:` 的。
真机确认的口径是"**测到的关卡能升降**"；"全关卡"那层保证来自算术与本地断言（210 处 `0`（含 default）+ 424 行继承 default、
改动集合 ⊇ route A 那 8 关），并没有逐关点验 —— 真出问题先怀疑个别关卡的场景空气墙/相机（§5"改不了的"）。
回退 = `ZAXIS` 翻回 `false`（或换 `hook_gadget_pool*.js`），落盘本来就零改动。
升降手感还要更猛的话接着动 `StateParameter_Xls`（§5），那是另一个目标、同样挂这张钩子。

---

## 8. 速查：文件与行号

| 内容 | 位置 |
|---|---|
| 模式枚举 / 动作限制枚举 / 关卡表读取 | `fightLua/e239427515a1af12d2ab9b2e8cd75bd7:10` `:18` `:124` `:306` |
| 三种移动算法 + 玩家/AI 分流 | `fightLua/3e66bb4f476bf9d5baa8472dae6d87ca:156/267/401`；`fightLua/f6495645145311c7e1f7c1ecf44ca93e:437` |
| 升降消费 / 俯仰钳位 | `3e66bb...:349-368`；`42db7184...:31-40`；`3e66bb...:577` |
| 滚转被清零 | `3e66bb...:69`；`0f2351...:497`；`60b058...:96` |
| 输入三路通道与掐断 | `toLua/07df7348...:690-697`；`toLua/f9b4d055...:11-16` `:106-111` `:233-237` |
| 升降摇杆控件 | `toLua/4f52bc70...:12-13` `:45-58` `:180-191` `:223` |
| 键位默认表 | `toLua/8a1a726c...:28-29`（`DefaultKeyPc_Xls`）；PC 读取 `toLua/b03e4380...:144-156` |
| 关卡表 | `toLua/75320b33287a4e48a35b08186d22d7d5`（`NewLevelInstance_Xls`） |
| 参数表 | `toLua/7d7e242aa1381b3504f78f0b86c3a5c2`（`StateParameter_Xls`） |
| 关卡 id 映射 | `src/data/mainlevels.ts` → `src/payloads.ts:717-745` |
