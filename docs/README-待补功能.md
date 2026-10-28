# 斯露德假服 · 待补功能

> 最后更新：2026-10-28 ｜ 协议现状 [`README-协议清单.md`](README-协议清单.md) ｜ 当前方案 [`README.md`](README.md)

---

## 1. 数值 / 成长（本版新增，最影响体验）

### 1.1 通关加经验 / 统御等级成长（未做）

- 章节解锁由客户端 `LevelDataMgr.IsChapterUnlock` 判定，其中一条是
  **`config.unlockLevel > PlayerDataManager.GetPlayLevel()` → 锁**；
  `MainChapter_Xls` 里 `unlockLevel` 最高 **45**。
- 目前玩家等级是**写死的**（[`data/save.json`](../data/save.json) 的 `player.level`，已设 45 以全开章节）。
  真服是靠通关发**导师经验**（`MainLevel_Xls.userExpReward`）按客户端 `PlayerGrow` 曲线升统御等级，
  **这条服务端逻辑没做** → 打完关等级不动、后续章节不会自然解锁。
- 要补：`OverMainLevel`/`OverTrainLevel` 胜利时按关卡表发经验 → 用成长曲线升级 → 落 `save.json`
  并推 `Data_Push`（`playerChangeExpandLvl`，字段1）。**已排期：`gs-parity` 第一档 B3**（原语 `econ.addExp` /
  `rollPlayerLv` 在地基里已备好）。

### 1.2 养成九条（`1001/1002/1003/1004/1005/1008/1010/1011/1016`）—— 已做（2026-10-28，分支 `gs-parity` · B1）

- 1001 不再是"每次 +1 级封顶 80"的简化版：读 C2S `itemInfo=3` 的素材，按 `Items_Xls.useParam` 折成经验，
  `econ.ts` 的 `upgradeByExp` 沿 `LeaderLv`/`PlayerGrow` 曲线连升，**真扣材料**并推 `Data_Push`
  （`leaderAttrChanged=5` + `changePart=10`）。
- 突破/大阶/小阶/主动/被动/式杖全部按表收费与卡上限；口径与判据见
  [协议清单](README-协议清单.md) §4 的 B1 行与 §4.1（**拒单 = 合法帧 + `header=0` 不派发**）。
- 已知缺口（不影响 B1 收尾）：升级/通关类任务进度**还没跟着涨**（等 B5 `src/tasks.ts` 的 `bumpTask`）；
  式杖升级**不扣材料**（贴路 B，客户端自己按 `consumeId ~= 0` 拦）；突破的 `commonConditionId` 未校验；
  `LeaderInfo.seasonTalentId=24` / `baseCalcPropModelInfo=26` 仍未发。
- **真机一轮还没跑**（自检修的是"包对不对"，测不到"面板跳不跳"）。

### 1.3 角色属性覆盖（已有）

- `characters[].attrs`（属性id→值）可**直接覆盖**终值（hp=100/atk=101/def=102/en=103/crit=104/击破=305/暴击率=201/暴击伤害=200）。
- 默认属性按 `level/breach + 武器` 用客户端 `Attribute/GrowAttribute/LeaderBreak/WeaponBreak` 表算（[`src/attrs.ts`](../src/attrs.ts)）；
  战力 `heroPower` 未计入**星级战力**、未叠加**属性百分比**。

---

## 2. 抽卡

**已做（2026-10-11）**：

- `2000 SwearHero`：**按池真实掉落 roll**（`LotteryInstance → Drop → DropSet → DropGroup`，
  表来自客户端，见 [`src/gacha.ts`](../src/gacha.ts) + `src/data/{lottery,drop,dropset,dropgroup}.ts`）。
  回 `SwearHero_S2C{number, rewards, swearNumberInfo, poolInfo, recordInfo, dropPropTimeInfo}`
  **并后置推 `ShowItem_Push(900009)`**：主包走 completedList 单包槽、推送走 `PushMsg2Client`
  （`GsResponse.mainInCompleted`）——`ShowItem_Push` 走 `ReturnPackagePush`(replenishList) 会被 Lua 的
  `Ignore_Replenish_MsgID` 过滤，这是"扣了次数不弹结果"的真正原因（详见 [`README-协议清单.md`](README-协议清单.md) §3）。
  - 入账：新角色→`characters[]`；**重复角色→意识碎片**（`Items_Xls.decomposeId×decomposeNum`，见 `data/leaderdebr.ts`）；武器→建实例；材料→`items`。
  - 硬约束：`swearNumberInfo` 必给（客户端 `GachaDataMgr:656` 无保护读 `.bottomgroup`）。
- `2002 GetSwearRecord` 回空记录；`2001 SelectSwearChange` 空 ack。

**仍未做**：大小保底 / UP(50-50) / 抽卡消耗门票（客户端自己扣）/ `CardBoxAddGoods` 副产物。

**调试开关（2026-10-11）**：`SLD_GACHA_FORCE_QUALITY=5` 启动假服 → 每次出货强制为该品质的随机本体
（按本次 roll 到的类型选角色/律叶，5=金；品质表 `src/data/rarity.ts` 取自 `Leader_Xls.quality` /
`Weapon_Xls.grate`）。只改展示/入库、不改掉落链；`0`（默认）= 按池真实掉落。例：
`SLD_GACHA_FORCE_QUALITY=5 ./run.sh`。
再配 `SLD_GACHA_FORCE_TYPE=leader|weapon` 可强制出货**角色**或**律叶**（留空按本次掉落的类型推断）：
`SLD_GACHA_FORCE_QUALITY=5 SLD_GACHA_FORCE_TYPE=leader ./run.sh` → 十连全金角色。

- **已修复（2026-10-11）：点抽卡后次数 -N 但结果动画不弹**。
  根因：`src/gacha.ts` 掉落链递归上限 `MAX_DEPTH` 原来只有 `8`，而真实链
  （`Drop→DropSet→DropGroup` 多层嵌套）最深 **11 层** → 约 1.6% 的 `poolDraw` 误判为环返回 `null`，
  被 `swearHeroS2C` 的 `continue` 跳过。于是 10 连只出 9 个 `rewardItem`，
  但 `SwearHero_S2C.number` 仍回 10 → 客户端按 `number` 循环取 `rewards[i]`，第 10 个为 `nil` 即中断：
  表现为"`poolInfo` 已 -N（次数生效）但结果动画不弹"。
  修法：`MAX_DEPTH=32`（放开误判）；并让 `number`/`gacha` 计数以**实际出货数**为准，
  保证 `number == #rewards`。角色/武器/碎片本就写进 [save.json](../data/save.json)（重登可见）。
- **已修复（2026-10-11）：抽卡动画能出，但点"跳过"卡死**。
  根因：重复角色时服务端把 `recordInfo.itemId` 写成了**意识碎片**（`3006001`），
  而客户端十连结果页 `UIGachaTenResultCtrl` 硬编码等满 10 个特效才播动画、
  `GachaResultItemCtrl:SetView` 又只对 `ItemType.Leader/Weapon` 建卡——碎片走 `else` 分支，
  `itemQuality=nil` → `GetEffectNameWithQuality(nil)` 报错，第 10 个特效永远等不到 → 跳过不动。
  修法：`recordInfo.itemId` 只写"抽到的本体"（角色/律叶），碎片由 `Rewards` 携带、
  `rewardParInfo.par` 指回本体（客户端据此回填 `parid/parcount`）。见 [`src/payloads.ts`](../src/payloads.ts) `swearHeroS2C`。
- **证据链（2026-10-11）**：`ReturnPackageInfo → replenishList` 由反汇编
  `THD.WebCommunicationHelper.HandleResult`（完整 metadata + `il2cpp_runtime_dump.cs` 的 RVA，
  `aarch64-linux-gnu-objdump`）确认；`Ignore_Replenish_MsgID` / `GachaResultItemCtrl` /
  `UIGachaTenResultCtrl` 由明文 Lua（`res/phone/luaplain/toLua`）确认。
  品质口径 `Leader_Xls.quality` / `Weapon_Xls.grate`（1..5，5=金）已落表到
  [`src/data/rarity.ts`](../src/data/rarity.ts)。
- **已修复（2026-10-11）：抽到的角色要重登才出现在大厅角色表**。
  根因：大厅角色表只有两个数据源——登录 `PlayerLoginGetInfo_S2C.leaderInfo` 与
  `Data_Push(900011).leaderAttrChanged` 推送；`SwearHero_S2C` 本身不带角色数据。
  客户端 `HeroMsg.LeaderAttrChangedHandler` 收到推送才 `SetLeaderDataForId`（`SetHas(true)`）。
  修法：`swearHeroS2C` 对本次新获得的角色后置一条 `Data_Push`
  （[`src/payloads.ts`](../src/payloads.ts)；与 `upgradeLeaderS2C` 同一玩法），大厅角色表即时刷新。

---

## 3. 皮肤 / 看板（多为客户端资源缺口）

| 现象（客户端日志） | 位置 | 说明 |
|---|---|---|
| `MainSecretaryManager:422 InstancePrefab` null | 换秘书(看板) | 所选角色的 3D 预制（`LeaderClothing.homePrefabPath`）**不在离线资源**里 |
| `UISkin_RoleTabCtrl:370 commonCameraBroomXls` nil | 皮肤列表点到某皮肤 | 该皮肤相关配置/资源缺失 |

- 协议侧已补：`1007 SwitchClothing`（回 `destinationLeaderBean`）、`clothingInfo(41)` / `weaponSkinInfo(45)` 全量下发。
- 换秘书报 null 是**资源缺口**（1.x GB 下载被跳过），服务端改不了；皮肤同理。

---

## 4. 仍回空包 / 未实现的系统（Lua nil）

| 现象（客户端日志） | 协议 | 现状 |
|---|---|---|
| `RoguelikeDataManager:34` msg nil | `9300009 GetRogueInfoListPage` | 空 body |
| `ElementTowerDataManager:57 _levelInfoGroups` nil | `9400004 GetElementRuinsLevelGroupList` | 空 body |
| `PatrolDataManager:603 GetPatrolLevelInfo` nil | `20001 GetPatrol` | 未实现 |

> 关键：这些 S2C 字段多是 `repeated`/`optional`，**空 repeated 等同「不存在」**，
> 回空包必然 nil。要按 `proto/` 定义塞骨架数据。

---

## 5. 战斗

- **进战斗闭环已完成**：`11028 StartSoloBattle` → `OverMainLevel(3004) → OverMainLevel_S2C` → 可打完退出。
  `battleEnterInfo` 的 `levelInstanceId/levelStageId` 取自 `MainLevel` 表（[`src/data/mainlevels.ts`](../src/data/mainlevels.ts)），
  `randomSecretKey` 已补，武将 `weapon/activeSkills/talentSkills` 已补。
- **仍未做**：战场内 `12xxx` 实时同步（`ServerInfo.serverType=2` 那台「战斗服」）—— 只把地址指向本网关。
- `PROLOGUE_SKIP` 里教程战 `101005/101007` 仍跳过，真机确认后再移除。
- 战斗的移动模式（水平面/自由飞行/轨道）与**高度轴**是客户端 `NewLevelInstance.controlMode` 决定的，
  跟假服无关；机制与改包解锁见 [`README-战斗移动轴与高度解锁.md`](README-战斗移动轴与高度解锁.md)。
  **2026-10-18 真机已验证**：铺外部 `toLua/Data/75320b33…`（+ 台账那条 md5）把第1章 1~8 关翻成 `controlMode=1`，
  升降摇杆出现、能自由飞。同日 gadget 运行期版 `ZAXIS` 把**全部**关卡一次发下来（633 行水平面 = 209 行显式 `0`
  + 424 行继承 default，再加 default 那一处；11 个轨道关不动），**也真机生效**，不推文件、关旋钮即回退 ——
  见 [注入器 gadget](README-注入器gadget.md) §5.6 与 [战斗移动轴与高度解锁](README-战斗移动轴与高度解锁.md) §7 末。

---

## 6. 存档 / 全解锁相关

- 存档 [`data/save.json`](../data/save.json) 一份包含：`characters[]`（含 `attrs` 覆盖 / `breach`）、`weapons[]`、
  `items`、`money`、`cloths`、`wskin`、`levels`、`trainLevels`、`gacha`、`signin`、`player`。
  字段含义见 [`README-存档修改.md`](README-存档修改.md)。
- **当前存档为了调试抽卡已精简**：角色只留 `2001001` + 看板、`weapons` 清空、`items` 只剩门票 `1000001`、`money` 空。
  想要"全角色/全武器/全物品"用 git 历史或按 `src/data/*` 自行铺。
- **武器下发会过滤掉无突破配置的 10 个 `cfg`**（`5012010,5022010,5032010,5042010,5042020,5042030,5042040,5052010,5052020,5151070`），
  否则客户端 `WeaponDataManager:97 SetRedPointData_Break` 崩、中断登录初始化。
- 未纳入"全解锁"的系统：**镜像(Equip 352)/装备时装、导师头像、符灵(Perk 72)、属性道具**、
  以及副本 `mainPVEInfos(46)`、爬塔 `towerTeam(67)`、战舰任务 `battleshipTasks(66)`、肉鸽/元素塔。

---

## 7. 建议顺序

0. **对齐路 B 假 GS**（分支 `gs-parity`，地基已合）—— 第一档余 **B2 武装 → B3 通关发经验 → B4 挂机 →
   B5 任务 → B6 签到**；每档 `build/selftest` 全绿 + 一轮真机才开下一档。B3 会顺手解掉 §1.1。
1. **通关加经验 / 统御等级成长**（§1.1）—— 让关卡/章节自然解锁，别再靠手改 `player.level`
2. 肉鸽 `9300009` / 元素塔 `9400004` / 乌拉拉 `20001`（补骨架数据）
3. 抽卡做真（概率/保底/UP/消耗）
4. 镜像 / 符灵 / 副本 等其余系统"全解锁"
5. 战场内 `12xxx` 战斗服同步

---

## 8. 怎么验证

- 假服侧：`data/logs/server.log` 看 `req/resp msgId=…`；`data/logs/gs-req-<id>.fields.json` 看请求字段。
- 手机侧：`…/files/clientLog/Thrud<日期>.log` 看 Lua 堆栈。
- 抓包补充：见 [`README-frida抓包.md`](README-frida抓包.md)。
