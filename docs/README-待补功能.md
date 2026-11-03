# 斯露德假服 · 待补功能

> 最后更新：2026-11-03 ｜ 协议现状 [`README-协议清单.md`](README-协议清单.md) ｜ 当前方案 [`README.md`](README.md)

---

## 1. 数值 / 成长（本版新增，最影响体验）

### 1.1 通关加经验 / 统御等级成长 —— 已做（2026-11-01，分支 `apk-server` · B3）

- 章节解锁由客户端 `LevelDataMgr.IsChapterUnlock` 判定，其中一条是
  **`config.unlockLevel > PlayerDataManager.GetPlayLevel()` → 锁**；
  `MainChapter_Xls` 里 `unlockLevel` 最高 **45**。
- `OverMainLevel(3004)` 重构 + `OverTrainLevel(3005)` 新接：胜利读 `MainLevel/TrainLevel.userExpReward`
  （导师经验）→ `econ.addExp` 沿 `PlayerGrow` 曲线连升 → 落 `save.json` → 同包推
  `Data_Push{playerChangeExpandLvl=1, changeStrength=3}`。`overSoloPlayerInfo` 的四个 required
  改成"结算前/结算后"两组值（以前四值同值 → 面板判不出升级）。口径与三件麻烦事见
  [协议清单 §4.4](README-协议清单.md)。
- **遗留**（不是 bug，是有意的范围）：进本**不扣体力**（`powerCost`/`strengthCost` 读了不扣）、
  不发 `leaderExpReward`、不给首通/三星奖励、任务进度不涨（等 B5 的 `bumpTask` 回来在两条成功路径上补调用）。
  `lastBattle`/`settledUniqueId` 是内存态，**假服重启即清零**：重启前未结算的那一场只回包、不写档、不发经验。
- 现档 `player.level = 45` 是历史手改值（当初为全开章节设的）；从现在起等级是打出来的，
  `PlayerGrow` 曲线铺到 **120 级**（第 120 行 `exp=9999999` 就是封顶；体力上限 44 级起恒为 200，
  升级按 `addPower` 实发 —— `econ.addStrength` 不钳上限，`catchUpStrength` 只按 `Common 10042`
  的周期把体力往上限补、**只补不削**），
  要复现"从零自然解锁"得换个新档一路通关。
- **真机一轮还没跑**（自检 114/114 修的是"包对不对 + 落盘对不对"，测不到"顶栏等级跳不跳"）。

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

### 1.3 武装七条（`1201/1202/1204/1205/1207/1208/1209`）—— 已做（2026-10-29，分支 `gs-parity` · B2）

- 新建 [`src/weapons.ts`](../src/weapons.ts)：`WeaponInfo` 的 17/18 第一次真编出来（四列互指的取值链、
  洗练两种"待确认"形状、按 onlyId 播种的确定性摇数），实例列表从"每次现编、不落盘"改成
  `materializeWeapons` 的唯一真相 —— 突破/强化/分解/精炼/洗练写完就丢的那类问题到此为止。
- 收费口径按表真扣：突破 `WeaponBreak`（0 基）、洗练 `WeaponRefining` + `WeaponRefiningLock`（两页签锁数各算各的）、
  强化只吃经验（**不收金币**）、精炼不收钱不收物只吞同名卡。分解的返还走 `ShowItem_Push`（客户端 handler 不看 `rewards`）。
- 上限口径修正两处路 B 的错：随机条数是 `Common["9910"+grate].value4[1]/[2]`（路 B 下标写反）、
  精炼上限是 `TalentSkill` 的最大 `skillLevel-1`（不是恒为 6 的 `#weaponRefinePower`）。
- 已知缺口（不影响 B2 收尾）：洗练不推进任务进度（等 B5 的 `bumpTask(2201/2204)`）；
  `GetWeaponListPage` 仍是整表下发（没真分页）；`WeaponRefiningLock` 的锁定 UI 在 3★ 以下客户端自己算不出锁数，
  所以 1208 对 `grate ∉ Common 99117.value4`（=4/5★）一律拒单；10 把无 `WeaponBreak` 行的武器继续被过滤掉。
- **真机一轮还没跑**：判定点是"武装面板空白（19/20）、点保留无反应（17/18）、属性行取不到崩（`EquipAttribute`）、
  精炼成功但等级没跳（`maxRefine` 口径）、分解后物品凭空消失（没推 `ShowItem_Push`）"—— 都属 §8 里
  "自检修的是包对不对、测不到界面反不反应"那一类。

### 1.4 挂机 / 外派六条（`30400/30401/30402/30403/30404/30405`）—— 已做（2026-11-01，分支 `apk-server` · B4）

- 新建 [`src/hangup.ts`](../src/hangup.ts) 承载会话状态机与数值口径，`payloads.ts` 只管拼帧与推送；
  六条都真改存档（`hangUp` 块 + 场次计数 + 感知 + 导师经验 + 掉落入库）。
- 三条最要命的客户端约束（细节在 [协议清单 §4.5](README-协议清单.md)）：单场时长取**玩家记录里的 `passTime`**
  且不能为 0（客户端拿它做除数）、`state 1→2` 必须在 `GetHangUpInfo` 读的时候翻转并落盘、
  `settleInfo` 只许给空消息（带 `type` 会让客户端去查关卡表并崩在面板上）。
- 为了第一条，`levels` 从 `id → 星级数组` 升成完整记录（带 `passTime`/`stars`）；老档读进来自动升级，
  改档时 `passTime` 给 0 / 负 / 小数都兜 30 秒（见 [存档修改](README-存档修改.md)）。
- **真机判定点（还没跑）**：① 外派界面能不能选到已通关的训练本/主线本、次数上限显示 10；
  ② 开场后感知一次扣够且顶栏跟着动；③ 挂机中退出重进进度连续（靠 `hangUp` 落盘 + `30400` 回显）；
  ④ 到点后红点 89 出现、领奖窗里的东西**确实在包里**（`ShowItem_Push{comeFrom=702}`）；
  ⑤ 召回确认框文案（已完成 X/Y、返还 Z 感知）与实测到账一致。
- **有意没做**：不校验"今日进本次数用完"、扫荡不查扫荡券、加速不扣道具（我们的 `HangUpBattle_Xls`
  没有 `jumpItemId` 两列，六行 `modelSwitch=2` 也让加速按钮不出现）、不发 `leaderExpReward`。

### 1.5 任务 / 活跃度五条（`3302/3303/3304/3308/3309` + 推送 `900007`）—— 已做（2026-11-01，分支 `apk-server` · B5）

- 新建 [`src/tasks.ts`](../src/tasks.ts)：任务集合索引、三口径计数（`day/week/total`）、日/周界清零、
  领取校验；`payloads.ts` 只管拼帧，`econ.ts` 反过来调这里的 `bumpTask`。
- 登录包补 `taskProgress=47`（全量，客户端 `SetTaskProgress` 是整表重建）与 `taskInfo=48`（已领记录，
  不发就能把同一份奖刷第二遍）；`10005` 跨天刷新给的是**同一份**，两个入口有断言绑在一起。
- 被动计数（消耗/获得/养成/洗练/抽卡）没人记得推送，靠 `HANDLERS` 出口的 `withTaskPush` 统一带 `900007`。
- 客户端契约（哪些字段它真读、`1901` 为什么永不发、`InitTaskList` 怎么分流）全在
  [协议清单 §4.6](README-协议清单.md)。
- **真机判定点（还没跑）**：① 日常页签**列表非空**且第一条就是"12 点登录"那类；
  ② 点领取弹"获得物品"窗（`comeFrom=1001`），**顶栏活跃点数跟着涨**、金币/源晶碎数量也当场对得上
  （`changeMoney=2`/`changePart=10` 是本档补的）；③ 活跃宝箱按 20/40/60/80/100 五档逐个能开，
  已开的格子不再亮；④ 一键领取只跳真达标的条目，全部不达标时**点了没反应**（`deny`，不弹假窗）；
  ⑤ 主线第一章领完最后一条 → "本章完成"可领 → 章节号推到 102、`chapterIndex` 与客户端一致；
  ⑥ 重登不出现"已领的任务又变可领取"、跨 04:00 后日常列表与活跃点清零且**新的一天又能领**；
  ⑦ 周常页签：`1802`（登录 3 天）那类靠 `10002` 的 `taskProgress` 显示进度，其余条显示 0/N 是预期。
- **有意没做**：后端观测不到的条件不发进度（巡逻 `2608`、周常 `1609/1621/1626/3102` 玩法未实现）、
  活动任务分支没接、`3304` 的 `errCode` 恒 0。

### 1.6 角色属性覆盖（已有）

- `characters[].attrs`（属性id→值）可**直接覆盖**终值（hp=100/atk=101/def=102/en=103/crit=104/击破=305/暴击率=201/暴击伤害=200）。
- 默认属性按 `level/breach + 武器` 用客户端 `Attribute/GrowAttribute/LeaderBreak/WeaponBreak` 表算（[`src/attrs.ts`](../src/attrs.ts)）；
  武装侧按客户端注释的公式分段累计（各突 `growAttributeID` × 本突那几级 + 各突 `growAddAttributeID`），
  `heroPower` 吃的是角色**成长后**属性与穿戴武装的**真实等级/突破**。仍未计入**星级战力**、未叠加**属性百分比**。

### 1.7 签到 / 七日三条（`3301/3306` + `10051`）—— 已做（2026-11-02，分支 `apk-server` · B6）

- 新建 [`src/sign.ts`](../src/sign.ts)：月签到（`signin`）、七日签到（`bg`）、bingo 格子、登录那份
  `FirstThoughtInfo`。**初心者的领奖不在这里** —— `Task_Xls` 的 `missionType==4` 那 56 行（`400001..400056`）
  直接复用 B5 的 `tasks.claimTask`，`3301/3302/3303/3306/3308` 从此读写同一份 `tasks.passedTasks`。
- 登录包补 `isFirstThoughtAllOver=43` + `firstThoughtInfo=44`（缺 44 一点初心者面板的格子就崩，
  不是"面板空着"）；`monthSign=80` 与 `10005` 的 13 走同一个 `signInfoBody`（有断言绑一起）。
- 顺带修掉三个老错：`SignInfo.days=3` 是**待领格子数(0/1)**（原来发的是"本月第几天"，高亮会被推到月外）、
  日/月界点统一走 `tasks.dayEdgeSec`（**04:00 UTC+8**；原来用自然零点与 UTC 月首，跨 00:00–04:00 会多签一天
  或提前换月）、`10051` 以前只回一个空 `rewards` **一件不发**（现在按 `SignMonth_Xls(月, 第几格)` 真发）。
- 客户端契约（`rewards` 没人读、`taskOverTime` 判 `~= nil`、`10051` 永不拒单、bingo 门槛 8..56、
  `comeFrom` 54/55/68/88）全在 [协议清单 §4.7](README-协议清单.md)。
- **真机判定点（还没跑）**：
  ① 主城的**月签到面板能打开且自动弹出过一次**（`lastGetSignRewardTime` 给 0 会每进一次主城重弹，
  给未来值则永不弹 —— 两种都是这档最容易犯的错，真机只看一次）；
  ② 点"签到"格子弹"获得物品"窗、高亮停在**第 N+1 格**（N=本月已签格数），同一天再点**不涨数**；
  ③ 重登后面板仍停在同一格、次数不清零（`signin.day` 是 04:00 界点秒，跨 00:00–04:00 不该翻）；
  ④ **初心者面板（主城"新手任务"按钮 → `UIBeginnerTask`）能开不崩** —— 这条是 B6 的真验收点，
  因为以前 44 根本没发，`UIBeginnerTaskCtrl` 一读 `m_FirstThoughtInfo` 就炸；入口还有道功能锁
  （`FUNCTIONNAME.Beginner_Task = 292`，`28e9e9b0…:138-141`），锁没开就是"点了没反应"而不是崩；
  ⑤ 领一条七日任务（`3301` `typeId=2`）弹"获得物品"（`comeFrom=68`）、格子变已领、**重登后还是已领**；
  ⑥ 不达标的那条点了没反应（`deny`，例如"登录 1 天"还没记数时领 `400004`），不弹假窗；
  ⑦ bingo：完成数不到 `SignBingo.num` 时格子置灰且发协议被拒；够了以后点开弹"获得物品"
  （`comeFrom=88`），已翻的格子重登后还在（`signBingoList=5`）；
  ⑧ 56 条全清后回包的 `isAllOver=1` → 客户端 post `BeginnerAllFinished`（`294a645…:112-114`，
  判的是 `== 1`，所以这条得发整数）。**界面侧没有可见效果**：唯一的监听者在 `28e9e9b0…:325` 被注掉了，
  真机只能从日志确认。现档不可能走到，要验就手改 `tasks.passedTasks` 铺 56 条。
- **有意没做**：`3307 ChangeFirstThought` 不接（handler 只 `SetFirstThoughtInfo`，不刷界面）；
  `Task.timeUnlock`（1..7）不做服务端门槛（第几天由客户端按 `openTimeStamp` 算）；`bg.redDot` 是
  `required bool` 但客户端没人读，恒发存档值；`typeId=1` 那条七日签到对应的面板在客户端**打不开**
  （`UIBeginner7Days` 只是 `UIBeginner7DaysCtrl:InitTab` 里的一个 tab，其唯一 opener
  `AutoPopupBeginnerSign` 的调用点 `28e9e9b0…:1900` 被注掉了，服务端仍实现完整并接了自测；
  它与 ④ 那个能开的 `UIBeginnerTask` 是两个面板）。

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
  `items`、`money`、`cloths`、`wskin`、`levels`、`trainLevels`、`gacha`、`signin`（月签到）、`bg`（七日/初心者）、
  `tasks`（B5 起的任务计数与已领记录）、`hangUp`（B4 的挂机会话）、`player`。
  字段含义见 [`README-存档修改.md`](README-存档修改.md)。
- **当前存档为了调试抽卡已精简**：角色只留 `2001001` + 看板、`weapons` 清空、`items` 只剩门票 `1000001`、`money` 空。
  想要"全角色/全武器/全物品"用 git 历史或按 `src/data/*` 自行铺。
- **武器下发会过滤掉无突破配置的 10 个 `cfg`**（`5012010,5022010,5032010,5042010,5042020,5042030,5042040,5052010,5052020,5151070`），
  否则客户端 `WeaponDataManager:97 SetRedPointData_Break` 崩、中断登录初始化。
- 未纳入"全解锁"的系统：**镜像(Equip 352)/装备时装、导师头像、符灵(Perk 72)、属性道具**、
  以及副本 `mainPVEInfos(46)`、爬塔 `towerTeam(67)`、战舰任务 `battleshipTasks(66)`、肉鸽/元素塔。

---

## 7. 建议顺序

0. **对齐路 B 假 GS**（迭代线已从 `gs-parity` 换到 **`apk-server`**；地基 + B1 养成 + B2 武装 + B3 通关 +
   B4 挂机 + B5 任务 + **B6 签到**已做）—— **第一档 28 条到此齐了**，不再往下堆新档。
   ⚠ 原计划"每档全绿 + 一轮真机才开下一档"在 B5/B6 这段**由用户明确豁免**（"先写完我再测"），
   所以 B3/B4/B5/B6 是攒着一起测的；**下一件事就是这一轮真机**，判定点按档列在
   §1.1（B3）/§1.4（B4）/§1.5（B5）/§1.7（B6）。
   ⚠ 现在真机轮不再依赖这台 PC 起服：APK 里就是同一份 `dist-cjs`，界面改档 + 看日志都能自己来
   （[安卓 APK 假服 §2.1](README-安卓APK假服.md) 是重出包流程）。**攒着的真机轮**：B1 的
   1204/1205/1207/锁定洗练未覆盖 + B3/B4/B5/B6 整条未跑；
   跑之前按 [存档修改](README-存档修改.md)「给武装 B2 的真机轮备料」补材料。
1. ~~**通关加经验 / 统御等级成长**（§1.1）~~ —— **已由 B3 解掉**（2026-11-01）
2. 肉鸽 `9300009` / 元素塔 `9400004` / 乌拉拉 `20001`（补骨架数据）
3. 抽卡做真（概率/保底/UP/消耗）
4. 镜像 / 符灵 / 副本 等其余系统"全解锁"
5. 战场内 `12xxx` 战斗服同步

---

## 8. 怎么验证

- 假服侧：`data/logs/server.log` 看 `req/resp msgId=…`；`data/logs/gs-req-<id>.fields.json` 看请求字段。
- 手机侧：`…/files/clientLog/Thrud<日期>.log` 看 Lua 堆栈。
- 抓包补充：见 [`README-frida抓包.md`](README-frida抓包.md)。
