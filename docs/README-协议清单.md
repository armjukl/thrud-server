# 斯露德（Thrud/sld）假服 · 协议清单

> 最后更新：2026-10-29 ｜ 当前方案 [`README.md`](README.md) ｜ 待修 [`README-待补功能.md`](README-待补功能.md)

客户端与假服共三层：HTTP(S) → UDP/KCP → GS(`/AppInterface` protobuf)。
全部协议号定义在 [`proto/CmdDefine.proto`](../proto/CmdDefine.proto)（`enum CmdEnum`，640 项）。

---

## 1. HTTP 侧

监听 `SLD_HTTP_PORT`（默认 9443，`SLD_TLS=1` 走 https），代码 [`src/http.ts`](../src/http.ts)。

| 路由 | 方法 | 行为 |
|---|---|---|
| `*/AppInterface` | POST | GS 应用层，见 §3 |
| `*/skipAPI` | GET/POST | 回 [`data/skipapi.json`](../data/skipapi.json) = `{"urlList":[...]}` |
| `*/getClientUpdateData` | GET | 回 [`data/getclientupdatedata.json`](../data/getclientupdatedata.json)，`resVersion` 强制覆盖为 `config.server.resVersion`（硬编码 1583）→ 客户端判定无需更新 |
| `*/server/clientNotice` | — | `{}`（必须空对象，带字段会走维护分支对 nil 报错） |
| `*/server/clientLogLevel` | — | `{}` |
| `*/server/cdnData` | — | `[]` |
| `*/server/OpenStatus` | — | `[]`（全部关闭） |
| `*/server/serverUrlData` | — | `{serverId, serverVersion, urlList:["https://<publicHost>:443"]}` |
| `*/server/clientAnnounce` | — | `[]` |
| `*/(serverlist\|version\|login\|notice\|…)` | — | 结构合理的猜测桩（列表/版本/登录/公告，见 `ROUTES`） |
| 其它任何路径 | — | 兜底：记 [`data/logs/http-requests.jsonl`](../data/logs/http-requests.jsonl)，回 `{code:0,msg:"ok",data:{}}` |

> 热更与 `/res/<路径>` 静态兜底已于 2026-10-10 删除。

---

## 2. UDP / KCP 侧

网关 [`src/gateway.ts`](../src/gateway.ts)，监听 `SLD_KCP_PORT`（默认 19005），`SLD_NET_MODE=auto|kcp|raw`。

- `auto`：首个数据报像 KCP 就按 KCP，否则按 raw 直通。
- 帧规则 [`src/framing.ts`](../src/framing.ts)（6 种候选自动试探并锁定）；当前锁定 `le32-len+id`，写 [`data/logs/framing-locked.json`](../data/logs/framing-locked.json)。
  - 布局：`[u32le bodyLen][u32le msgId][u32le seq][body]`（`headerSize=12`）。
- KCP：[`src/kcp.ts`](../src/kcp.ts)，24 字节段头，conv 小端 u32。
- 未识别 msgId 不报错，原样落 `data/capture/`，并统计到 `data/logs/unknown-msgids.json`。

---

## 3. GS 应用层（`POST /AppInterface`）

代码 [`src/gs.ts`](../src/gs.ts) / [`src/payloads.ts`](../src/payloads.ts)。

**请求**（实测头布局，30+ 条真实抓包验证）：

```
[u32 totalLen][u32 crc][u32 0][u32 msgId]
5× length-prefixed string：uid / platform / pfUid / channel / token
[u32 httpId]                        ← 回包 packetUUid 必须原样带回
[u32 0][u8 0][u32 dataLen][protobuf data][u32 appendLen][appendData]
```

中间定长头长度不固定，服务端用「尾部闭合 + protobuf 首字节非 0」扫描定位 `data`。

**回包**：HTTP body = 裸 `msg.ReturnPackagePush`：

```
ReturnPackagePush{ packetList:[1] }
  └ ReturnPackageInfo{ packetUUid=1; packetBodyInfo=2{header,body}; packetBodyInfoS=3[]{header,body} }
```

`packetList`（字段 1）**repeated**，可多条（按 `packetUUid` 归组）。C# `WebCommunicationHelper.HandleResult`
把这些包全部写进 `UploadDataCompletedData.replenishList`（见下"外层帧"）。

**外层帧**（对 `HandleResult @0xfb139c` 汇编还原）：

```
[u8 prefix][i32 errorCode][i32 pushLen][ReturnPackagePush]      -> replenishList
[i32 msgId][i32 bodyLen][body]                                  -> completedList 单包槽(真正的主回包)
[i32 p2cLen][PushMsg2Client{ PushBody{header,bodyBytes} }]      -> completedList(推送, 晚于主包)
```

`prefix` 读 [`data/frame_prefix.txt`](../data/frame_prefix.txt)（当前 `00`）。
Lua `HttpClientForLua` 先派发 `completedList` 再派发 `replenishList`，且
**`replenishList` 里 `ShowItem_Push`/`GetShowDetailsData` 会被 `Ignore_Replenish_MsgID` 过滤**——
所以抽卡结果包必须走 `PushMsg2Client`（`GsResponse.mainInCompleted` + `extra`），否则抽卡只扣次数、不弹结果。

### 3.1 抽卡回包的三条硬约束（`2000 SwearHero`，2026-10-11）

1. **`ShowItem_Push(900009)` 必须走 `PushMsg2Client`**（上面的 `completedList`），
   走 `ReturnPackagePush`(`replenishList`) 会被 Lua 过滤 → "扣次数不弹结果"。
2. **`recordInfo.itemId` 只写抽到的本体**（角色 / 律叶），**不能写碎片**。
   客户端 `UIGachaTenResultCtrl` 硬编码等满 10 个特效、`GachaResultItemCtrl:SetView`
   又只对 `ItemType.Leader/Weapon` 建卡；碎片走 `else` 分支 → `itemQuality=nil` →
   `GetEffectNameWithQuality(nil)` 报错 → 第 10 个特效等不到 → **点跳过卡死、结果页转圈**。
   碎片（重复角色）只进 `Rewards[*].rewardParInfo.par`（指回本体，客户端据此回填 `parid/parcount`）。
3. **品质口径 = 客户端 `Leader_Xls.quality` / `Weapon_Xls.grate`**（1..5）：
   `≤3` 蓝 / `4` 紫 / `5` 金（`GachaResultItemCtrl:GetEffectNameWithQuality`）。
   假服侧表在 [`src/data/rarity.ts`](../src/data/rarity.ts)；调试强制金：
   `SLD_GACHA_FORCE_QUALITY=5`（配 `SLD_GACHA_FORCE_TYPE=leader|weapon`）。
4. **新角色要另推 `Data_Push(900011){ leaderAttrChanged=5{ repeated LeaderInfo leaderInfo=1 } }`**。
   大厅角色表只认两条来源：登录 `PlayerLoginGetInfo_S2C.leaderInfo`(字段4) 与
   `Data_Push.leaderAttrChanged`（客户端 `HeroMsg.LeaderAttrChangedHandler` → `HeroDataManager.SetLeaderDataForId`
   → `SetHas(true)`）。抽卡主包不带角色数据，**不补这条推送就要重登才看得到新角色**。

---

## 4. 协议号现状

`HANDLERS`（[`src/payloads.ts`](../src/payloads.ts)）已注册：

| msgId | 名称 | 回包 | 备注 |
|---|---|---|---|
| 9999 | HeartBeat | ✅ | HTTP 侧心跳；UDP 另把 msgId 0 当探活回空包 |
| 10000 | PlayerLogin | ✅ | `beginnerModeProgress` / uid / token / now / levelExp |
| 10002 | PlayerLoginGetInfo | ✅ | 登录大包：leaderInfo/看板/签到/引导/服务器/任务……required 字段缺一不可 |
| 10003 · 10004 | GetPrologue · SetPrologue | ✅ | 序章进度，落 `data/save.json` |
| 10005 | GetNextDayUpdateData | ✅ | 跨天/周/月刷新时间 + 月签到 |
| 10006 | GetRevelationInfoListPage | ✅ 空表 | page=1,next=0 |
| 10007 | GetWeaponListPage | ✅ | 实例来自 `data/save.json` 的 `weapons[]`，缺的角色当场物化一把默认式仗并**落盘**（`onlyId` 与 `leaderInfo.weaponId` 同源，见 §4.3） |
| 10051 | GetSignReward | ✅ | 月签到领奖 |
| 10057 | ChangeSecretary | ✅ | 换看板，落 `data/save.json` |
| 10073 | ChangeStep | ✅ | 原样回显引导流 |
| 10076 · 10077 · 10080 | CheckPlayerName · ChangePlayerName · ChangeSex | ✅ | 改名/改性别落 `data/save.json` |
| 10100 | ClientDataOverLogin | ✅ 空 | |
| 10102 | GetOpenFunctionData | ✅ | 一次下发全部 conditionSet |
| 3302 | GetActivePointReward | ✅ 真发奖 | **B5**：领日常活跃宝箱，按 `TaskDailyActive[dayConditionId==当前日常组].apNum` 比对 `dayTaskPoint`（`econ.rewardById` 真发）→ 格记进 `tasks.passedDayPoints`；回包 `reward=1`（客户端不读）+ **只列本次新领的** `activePointId=2`（客户端把它 `append` 进 `passedDayPoints`，全量重发会重复计入）。一键请求会把所有达标未领的 id 一起发来，逐条判 |
| 3303 | SubmitTask | ✅ 真发奖 | 单条领任务：先过可见性 + 进度门槛，再 `rewardById(fixedRewardId)` 真发、写 `passedTasks[taskId]=秒`、按 `Task.activityPoint` 累加 `dayTaskPoint`/`weekTaskPoint`；回 `reward=1`（客户端**不读**）/ `dayTaskPoint=2` / `chapterIndex=3` / `overTask=4` / `weekTaskPoint=5`。章节奖也走这条（`claimTask` 判本组全清）。不达标 → 拒单 |
| 3304 | SetSpecialTaskProgress | ✅ 真计数 | 前端上报型进度（`type=1`/`num=2`）：`type==3000`（定时登录）由我们自己分 40000/40001 两档（上报里不带档位），其余 `bumpTask(s, type, num)` 照报来的次数记。`type=0` → 拒单；其余一律 `errCode=0`（回非 0 会让客户端弹错误框） |
| 3308 | BatchSubmitTask | ✅ 真发奖 | 一键领取（`type` 1日/2主线/3周/4活动）：逐个走 `claimTask`，**跳掉不达标的**；一条都没领到才拒单。回 `dayTaskPoint=1` / `chapterIndex=2` / `overTask=3`（`repeated ProtoHashInt2Int`，3303 是单个）/ `weekTaskPoint=4`（**与 3303 的 5 同名字不同号**，proto 自检有断言） |
| 3309 | GetWeekActivePointReward | ✅ 真发奖 | 周活跃宝箱，同 3302 但取 `TaskDailyActive` 里 `dayConditionId==0` 的那五格（id 26..30）、门槛是 `weekTaskPoint`、格记进 `tasks.passedWeekPoints`；`GetWeekActivePointReward_S2C` **只有 `id=1`、没有 rewards** → 奖励必须另走 `ShowItem_Push`（§4.6） |
| 900007 | TaskProgressPush | 推送 | 任务进度增量推送（`taskProgress` 同形状）。被动计数（通关、消费、抽卡……）不会有人记得发，所以挂在 `HANDLERS` 出口统一带：`withTaskPush` 包装每条 handler，见 §4.6 |
| 30304 | GetPayShopDataAfterLogin | ✅ | payConfVersion=1 |
| 40002 | GetWaitOrderData | ✅ 空 | |
| 60003 | GetPerkInfoListPage | ✅ 空表 | page/next |
| 9000007 | LoginOpenSmallBattlePanel | ✅ | `state=0` |
| 3912 | GetAllFriendInfo | ⚠️ 空 body | optional/repeated，成包即可 |
| 3913 | GetOtherPlayerInfo | ✅ | 回显 `type` |
| 21001 | GetAllActivity | ✅ | 回显 `activityVersion`（防版本变化死循环） |
| 21015 | ActivityReplayReward | ⚠️ 空 body | 本身就是空 message |
| 890105 | GetBattlePassInfoListPage | ⚠️ 空 body | 待补数据 |
| 9300009 | GetRogueInfoListPage | ⚠️ 空 body | 待补数据 |
| 9400004 | GetElementRuinsLevelGroupList | ⚠️ 空 body | 待补数据 |
| 11003 | BattleLogin | ✅ | 战斗服 KCP 登录：回本网关的 `kcpIp/kcpPort` + `kcpConvId` |
| 11018 | BattleSettle | ⚠️ 空 body | 结算回执（胜负/掉落）待按客户端日志补 |
| 11028 | StartSoloBattle | ✅ | 进战斗最小闭环：回 `StartSoloBattle_S2C{result, battleEnterInfo, server}` |
| 11019 · 11031 · 11032 | BattleLeave · CloseBattleSettle · BattleLeaveFinish | ⚠️ 空 body | 离开/关闭结算，成包即可 |
| 3004 | OverMainLevel | ✅ 真发经验 | **B3 重构**：主线结算，胜利按 `MainLevel.userExpReward` 发导师经验（`econ.addExp` 走 `PlayerGrow` 滚级）+ 写 `levels[]` 星级 + 推 `Data_Push.playerChangeExpandLvl`；关卡 id 从 `11028` 的战斗上下文取，同 `uniqueId` 不重发（§4.4） |
| 3005 | OverTrainLevel | ✅ 新接 | 训练本结算，形状同 3004 但 `passTime` 在**字段 5**、带 `trainLevelInfo=7`（`todayAttackNum`/`attackNum` 落 `trainLevels[]`）；**只认上一场是训练战斗**（`CONST_BattleType` 2/3），否则回 `result=false` 且不落盘（§4.4） |
| 30400 | GetHangUpInfo | ✅ | 读一条会话，但**到点要由它把 `state` 1→2 并落盘**：客户端数到 `endTime` 只会重发这一条，自己不翻状态，红点 89 也认 `state=2`（§4.5） |
| 30401 | StartHangUp | ✅ 真扣费 | 次数按 `HangUpBattle.maxNum=10` 拦；感知按 `costItem(13, 单价×场次)` **开场一次扣满**（客户端的换购弹窗也是按总数拦的）；会话落 `hangUp`（**秒**），`endTime = now + 场次×单场秒`；未通关 / 次数越界 / 感知不足 / 已在挂机 → **拒单**（§4.5） |
| 30402 | HangUpSpeedUp | ✅ | 只做 `endTime -= 场次×单场秒`（`startTime` 不动，客户端的"已进行时间"才连续）；**不扣加速道具**：我们的 `HangUpBattle_Xls` 没有 `jumpItemId` 那两列，六行 `modelSwitch=2` 也让按钮不出现 |
| 30403 | ReceiveHangUpReward | ✅ 真发奖 | 只在 `state=2` 结算：按场次 roll `TrainLevel.reward` / `MainLevel.passDropId` + 发 `userExpReward`；回包 `info=1` + **空的** `settleInfo=2`；奖励走 `ShowItem_Push{comeFrom=702}`；没到点就来领 → 拒单"还差 N 秒" |
| 30404 | HangUpCancel | ✅ 真结算+返还 | 已完成场次（`times - ceil(剩余秒/单场秒)`，与客户端同一个式子）照样发奖，未开始的按 `单价×剩余` 返还感知且不超上限 —— 客户端 8007 确认框就是这个口径 |
| 30405 | HangUpSweep | ✅ 真扣发 | 一次结清 n 场、**不占会话**（挂机中扫荡 → 拒单）；`HangUpSweep_S2C` **只有** `settleInfo=1`（没有 info），客户端 handler 也不读 info，奖励仍靠 `ShowItem_Push(702)` 在横幅 3 秒后弹出 |
| 1001 | UpgradeLeader | ✅ 真扣费 | **B1 重构**：读 C2S `itemInfo=3`（`ProtoHashInt2Int`）→ `Items_Xls.useParam` 折成经验 → `while(lv<本突上限 && exp>=本级需求)` 连升；回空包 + 推 `Data_Push.leaderAttrChanged`(+`changePart`)。材料不足/满级 → **拒单**（§4.1） |
| 1005 | UpgradeLeaderBreach | ✅ 真扣费 | 突破：付 `LeaderBreak[leaderId, breakNum==本突].consumeId`，`breach+1`；S2C 是**空 message**，失败只能拒单 |
| 1002 | UpgradeLeaderStar | ✅ 真扣费 | 大阶（星）：付**当前**档 `LeaderStar[lid][star].consumeID`，前提是小阶已满（`star+1` 档无 `slv+1` 行）→ `star+1, starLevel=0`。`star` **从 0 起**（`star*3+starLevel` 是属性节点索引） |
| 1003 | UpgradeLeaderStarLevel | ✅ 真扣费 | 小阶：付**下一**档 `LeaderStarlevel[lid][star][slv+1].consumeID`；顶档再点 → 拒单 |
| 1004 | UpgradeLeaderTalentSkill | ✅ 真扣费 | 被动技能升级，`leader` 在**字段 2**；被动集合取自 `Leader_Xls.commonSkillId + talentSkill`（武器技能的 `Skill.maxLevel` 恒为 1，用它会全员满级） |
| 1008 | UpgradeLeaderActiveSkill | ✅ 真扣费 | 主动技能升级，`leader` 在**字段 1**；上限双卡：本突 `LeaderBreak.skillLevel` ∧ `Skill_Xls.maxLevel` |
| 1010 | ChangeStickSkill | ✅ 落盘 | 装/换式杖：S2C 三个 required `1/2/3` 原样回显，`LeaderInfo.stickSkills=23`（`key`=槽位、`value`=`LeaderWandSkill` 表 id） |
| 1011 | ResetStickSkill | ✅ 落盘 | 只清槽位关系 `c.stick`，**不删** `c.stickLv`（技能等级是玩家资产）；S2C 只有 required `skillLeaderId=1` |
| 1016 | UpgradeStickSkill | ✅ 落盘 | 式杖升级**不扣材料**（贴路 B；客户端自己按 `consumeId ~= 0` 拦），上限取 `TalentSkill_Xls` 里该 skillId 的最大 `skillLevel`；回包 `leader=1` + `stickSkillLevel=27` |
| 1007 | SwitchClothing | ✅ | 换装，落 `characters[].clothingId`，回 `destinationLeaderBean`（换皮肤必需） |
| 1203 | SwitchWeapon | ✅ | 换武装：改 `weapons[].leaderId`，回 `weaponInfo/oldWeaponInfo/leader/beforeLeader` |
| 1201 | UpgrageWeaponBreach | ✅ 真扣费 | 要**满本突等级上限**才允许；付 `WeaponBreak[weaponId==cfg][breakLevel==当前(0 基)].consumeId`（`consumeId=0` 就是封顶）→ `breach+1`；回 `weaponInfo=1` + `rewards=2` + 已装备时 `leaderInfo=3`。**客户端无条件弹 `UIBreakUpSuccess` → 失败一律拒单**（§4.1） |
| 1202 | UpgrageWeapon | ✅ 真扣费 | 强化只吃经验：`itemInfo=1`（`ProtoHashInt2Int`，注意号是 **1**）折 `Items_Xls.useParam[1]`，按 `WeaponGrow[quality][lv] → LevelConsume.exp` 滚级；**不收金币**（`WeaponGrow.parNum` 全空），`break_lv` 在客户端被注释掉 → 跨突同一条曲线。满级也照回：客户端 `aftLv>befLv` 为假时自己走 notice 605 |
| 1204 | DecomposeWeapon | ✅ 真删实例 | 逐个筛（存在 / 未锁 / `leaderId==0` / `Items_Xls.saleReward≠0`），回体**只列真删掉的 onlyId**；客户端 handler 只 `DeleteWeapon(msg.weaponId)`、**完全不看 `rewards`** → 返还必须另走 `ShowItem_Push(900009)`（同 §3.1 第 1 条：走 `mainInCompleted` + `extra`） |
| 1205 | ChangeWeaponLock | ✅ 落盘 | `weaponInfo` 在**字段 2**（1201/1202/1208/1209 才是 1）；写错号 = `UpdateData(nil)` 静默"点了没反应" |
| 1207 | UpgradeWeaponRefineLevel | ✅ 真吞卡 | 精炼**不收钱不收物**（90 把武器 `weaponRefineCos` 全空、`weaponRefineCosCoin` 全是 `Consume 90000` = 0 金币）；上限 = `TalentSkill_Xls` 里 `skillId == Weapon_Xls[cfg].weaponSkillId[1]` 的最大 `skillLevel-1`（**不是 `#weaponRefinePower`**，那恒为 6）；每张同名卡计 `它的 refine + 1`，一次 ≤4 张；`weaponInfo` 也在**字段 2** + `consumeWeaponIds=3` 让仓库删卡。**无条件弹 `UIRefineUpSuccess` → 失败拒单** |
| 1208 | RecastingWeapon | ✅ 真摇 | 只放行 `Common 99117.value4`（= `[4,5]`）里的星级 —— 3★ 以下连"锁了几个"都算不出（`GetWeaponRecastingLockCount` 无分支回 nil），且确认页要读对侧的 `#weaponRandomSkill`；花费 `WeaponRefining[grate].consume`(SKILL)/`.consume2`(PROP) + `WeaponRefiningLock[锁数].同列`（两页签的锁数**各算各的、不相加**，>4 客户端 index 到 nil）；新结果只进 **18**、17 保持生效值；`lockPropKeyIndex` 是 **0 基下标**、`lockSkillId` 是 **skillID**；`recastingTime=19`/`recastingSkillTime=20` 是**终身次数**不是时间戳 |
| 1209 | SelectWeaponRandomInfo | ✅ 落盘 | NEW(2) 把 18 并进 17 再清 18；OLD(1) 只清 18；三个 required `weaponInfo=1 / recastingType=2 / selectType=3` 原样回显 |
| 2000 | SwearHero | ✅ | 抽卡：按池真实掉落（`LotteryInstance→Drop→DropSet→DropGroup`，链最深 11 层，`MAX_DEPTH=32`）；重复角色转意识碎片；`number`=实际出货数；后置 `ShowItem_Push`（结果）+ `Data_Push`（新角色入大厅表）；`recordInfo.itemId` 只写本体（见 §3.1） |
| 2001 · 2002 | SelectSwearChange · GetSwearRecord | ⚠️ 空 | 选 UP / 抽卡记录 |
| 30300 | GetPayShopData | ✅ | 回 `GetPayShopData_S2C{payShopData{payConfVersion:1}}` |
| 900009 | ShowItem_Push | 推送 | 获得物品展示（服务端主动推；抽卡结果靠它弹） |
| 900011 | Data_Push | 推送 | 武将/装备/货币等变更推送；抽卡新角色靠 `leaderAttrChanged` 入大厅角色表（见 §3.1 第 4 条） |

未注册的 msgId（含已抓到的 `50006`）走通用兜底：
**组一个带 header 的合法空包**——客户端 Lua 按 header 找回调，不回包会永远等。

### 4.1 拒单（`deny`）：合法帧 + 不派发（2026-10-28，B1）

"升级失败"在假服里**不能**回一个正常 ack：养成面板是**收到包就刷新/弹窗**的，
`UpgradeLeaderTalentSkillHandler` 甚至无条件 `UIHeroLevelUp` 弹"升级成功"。也不能干脆不回：
不回 → 客户端 20 s 超时挂出 `210001` 网络异常提示。

路 B 的做法是"只准不收包"（进程内用 `EventManager.PostMsg` 决定派不派发，`mockgs_pc.lua:754-762`）；
HTTP 层的等价物就是 **`GsResponse.deny`**：`gs.ts` 回 `header=0` 的空包。两条实测依据：

- `UploadDataCompletedEventHandler` 只要 `udd.error == 0` 就清 `CurSend` 并 `CloseMsgBlock()`，
  **不看 header**（客户端 `a47222f1…:116-216`）→ 请求正常收尾、遮罩关掉、不超时。
- 派发是 `EventManager` 按 header 找注册回调（`HeroMsg.RegisterMsgHandlers`，`5262026f…:21-45`），
  **header=0 没有监听者** → 一条回调都不跑，面板纹丝不动 = "没升上去"。

所以 B1 的九条失败路径（无此角色 / 材料不足 / 满级 / 顶档再点）一律 `deny(reason)`，
`server.log` 留一行 `deny msgId=… reason=…`；自检里 deny 用例**额外断言零推送 + 存档未被改动**。
B2 的七条同理：1201/1207/1208/1209 的成功路径上客户端挂着**无条件弹窗**（突破成功窗 /
`UIRefineUpSuccess` / 洗练确认页），失败时只能拒单；1202 是唯一"满级也能回包"的（notice 605 那条路）。

### 4.2 武装随机数据（`WeaponInfo` 的 17/18）取值链（2026-10-29，B2）

`WeaponProto.proto`：`WeaponInfo{ WeaponRandomInfo weaponRandomInfo=17; WeaponRandomInfo lastWeaponRandomInfo=18 }`，
`WeaponRandomInfo{ repeated int32 weaponRandomSkill=1; SecondaryPropInfo secondaryPropInfo=2 }`，
`SecondaryPropInfo{ repeated int32 secondaryKeyList=1; repeated double secondaryValueList=2; repeated int32 randomPropPoolIndex=5; repeated int32 randomEquipAttrIndex=6; double weaponPropScope=4 }`
（`growMap=3` 客户端从不读，假服不发）。

四列是**互指**的，造数时按这条链取（客户端 `WeaponDataManager:1044-1082` + 确认页 `a205bd07…:243-258`）：

```
Weapon_Xls[cfg].randomstrength / .randomskill      →  WeaponLibrary_Xls[lib].weaponRandomID[]
WeaponRandom_Xls[pool].valueType==2                →  属性池（==1 是技能池），skillID 指向一行 EquipAttribute
EquipAttribute_Xls[skillID].attributeType[k]       →  secondaryKeyList[i]   = 属性 id（与 calcPropModelInfo.attributeMap 同域）
EquipAttribute_Xls[skillID].attributeRange[k]      →  secondaryValueList[i] ∈ [min, max]（double → wire=1）
k-1                                                →  randomEquipAttrIndex[i]  （**0 基**，客户端读时 +1）
pool 行 id                                         →  randomPropPoolIndex[i]   （不是 lib、不是 skillID）
weaponRandomSkill[i]                               →  WeaponRandom[pool].skillID（**别换成 skillIdExpand**，
                                                       4★/5★ 那些 raw id 不在 TalentSkill 里，客户端改用 expand+grate 查文案）
```

**条数**来自 `Common["9910"+grate].value4`：`[1]` = 随机技能数、`[2]` = 随机属性数
（1★`[0,0]` 2★`[0,1]` 3★`[0,2]` 4★`[1,2]` 5★`[2,3]`）。⚠ 路 B `mockgs_pc.lua:2458` 把这两个下标写反了。

**17/18 的四列长度必须逐条对齐**：确认页 `AttrItem`/`SkillItem` 用同一个 `index` 读两边的数组，短一格就 `nil` 崩
（`a205bd07…:127/142/195-196/243-252`）；洗出来的那一半保留项**按原槽位放回**，挪位等于把玩家锁的那条换格。

**18 的形状本身就是"待确认"的判据**（`WeaponData:662-669` 的 `IsRecastingOver` 反推）：

| 待确认的是 | 18 的写法 | 判据 |
|---|---|---|
| 属性（PROP） | 只带 `secondaryPropInfo`，`weaponPropScope ~= 0`，**不带技能** | `not(18 且 18.secondaryPropInfo.weaponPropScope ~= 0)` |
| 技能（SKILL） | 带新技能 + 属性四列**照抄 17**，`weaponPropScope` 显式发 **0** | `not(18 且 18.weaponRandomSkill 存在)` |

`weaponPropScope` 缺字段解码出来是 `nil`，`nil ~= 0` 为真 → **必须显式发**（假服侧 `pb.dblfield(4, …)`）。
存档里 `last` 只存**被重摇的那一半**，另一半留在 `rand` 里（避免两份真相）。

### 4.3 三套 onlyId 并存（2026-10-29，B2）

| 形态 | 来源 | `defleaderId=9` |
|---|---|---|
| `"7000000" + leaderId` | 派生的默认式仗（客户端早就按它索引，不迁移） | `= leaderId`，客户端 `CheckIsDefaultWeapon` 据此把它从仓库列表摘出去 |
| `"7g<cfg>-<n>"` | 早期抽卡直接编的号（现档 27 把） | `0`（不迁移，换号等于全丢） |
| `"7000000" + s.wSeq` | `econ.grantWeapon` / `materializeWeapons` 新发的号 | `0` |

`weaponInstances(s)` 与 `equippedWeaponOf(s, leaderId)` 都是 `materializeWeapons(s)` 的只读视图
（[`src/weapons.ts`](../src/weapons.ts)）：空号/撞号走 `wSeq` 重新发号、每个角色补一把默认式仗、缺随机数的补一组
**按 onlyId 播种**的确定性结果。旧实现是"每次现编列表、不落盘"，B2 的写操作（突破/强化/分解/精炼/洗练）
若继续走它就全丢，所以列表页（10007）也顺手 `saveSave` —— 发给客户端的号必须留在档里。

### 4.4 通关结算的三件麻烦事（2026-11-01，B3）

`OverMainLevel(3004)` / `OverTrainLevel(3005)` 看着是最简单的两条，实做时撞了三个坑，
口径都记在这里（[`src/payloads.ts`](../src/payloads.ts) 的 `// ---- 战斗结算 ----` 那一段注释就是按这三条写的）：

- **① C2S 不带关卡 id。** `OverMainLevel_C2S` 只有 `result=1 / starArray=2(repeated) / fightPar=3`，
  `OverTrainLevel_C2S` 更狠，只有 `result=1 / fightPar=2` —— **连星级都没有**。id 只能从进本那条
  `StartSoloBattle(11028)` 记下来：内存里一个 `lastBattle = {levelId, type, uniqueId}`，
  由 11028 写入、3004/3005 读取。**代价**：假服重启后还没结算的那一场，结算包会被当成"关卡 id=0"，
  只回包、不写档、不发经验（回包仍 required 合规，客户端不会卡遮罩）。
- **② 主线与训练的行 id 会重叠**（两边都有 `100101`）。所以**不能"先查 MainLevel 查不到再查 TrainLevel"**，
  只能按 `CONST_BattleType` 分流：`1=主线 2=训练 3=多人训练 5=爬塔`，`isTrainBattle()` 认 2/3。
  非训练战斗来的 3005 一律当"认不出关卡"处理。实例 id 也分表取：主线走
  `MAIN_LEVEL[levelId] → {levelInstanceId, levelStageId}`，训练走 `TrainLevel.newLevelId / stageLevel`。
  查无此关时**宁回 `result=false`、不带 `trainLevelInfo`**：客户端
  `OverTrainLevelHandler` 是 `if msg.result then PassTrainLevel(msg.trainLevelInfo)`，
  回一个 `id=0` 的 info 会让它去查表并崩在面板上。**3004 同病**（B4 才补上）：
  `OverMainLevelHandler` 见 `msg.result` 为真就**无条件** index `msg.mainLevelInfo.id`，
  所以 `result` 与 `mainLevelInfo` 必须同进同出 —— 假服重启后 `lastBattle` 清零、这一场认不出关卡时，
  连 `result` 也要回假。
- **③ 同一场结算会来好几次。** 客户端 `ClockRequestMsg` 约每 22 s 轮询一次结算，抓到过的真帧序列里
  同一场先 `result=0`（还没打完/中途退出）后 `result=2`；`BattleResult` 是
  `0=无 / 1=平 / 2=胜 / 3=负`，**只有 2 算通关**。幂等靠 `uniqueId`：`BattleOver` 的 `uniqueId`
  由 11028 那一次分配并存在 `lastBattle`，结算只在 `uniqueId ≠ settledUniqueId` 时发经验，
  发过就记账 —— 否则 `player.exp` 会随轮询次数翻倍。
  `BattleOver_L2V(13014)` 是客户端**内部**的 Logic→View 通道（战斗结果由客户端本地产生），
  不经服务端，所以结算是否生效只能看 3004/3005 的日志行。

回包形状（`proto/Battle.proto` + `PveProto`）：

| 命令 | body 用到的字段 | 备注 |
|---|---|---|
| `OverMainLevel_S2C` | `uniqueId=1` `battleId=2` `result=3(0/1)` `passTime=6` `playerInfo=7` `mainLevelInfo=8` `firstPass=9` `multipleValue=10` | `stars` 原样回显 C2S 的 `starArray`，并**并进 `levels[id]` 落盘**（取并集排序，重登仍保留历史最好星级）；缺 `playerInfo` → 结算面板 `UIBattleSettlementNewMainLevel:144` 索引 nil、退不出战斗，缺 `uniqueId` → `UIBattleMsg.CheckSameUniqueId` 报"没有结算数据" |
| `OverTrainLevel_S2C` | `uniqueId=1` `battleId=2` `result=3` `passTime=5` `playerInfo=6` `trainLevelInfo=7` `firstPass=8` `multipleValue=10` | `passTime` 在**字段 5**（主线是 6）；`trainLevelInfo` = `{id=1, todayAttackNum=2, attackNum=3, lastAttackTime=4, passTime=8}`，`attackNum` 是**累计进本次数**、`todayAttackNum` 客户端只 `>0` 判成"今天来过" |
| 两者共用 `OverSoloPlayerInfo`（`Msg.proto:2575`） | `oldExp=1` `oldLevel=2` `newExp=3` `newLevel=4`（`formationInfos=5` 暂不给） | 是"结算前 / 结算后"两套值；旧实现四个值全填当前档，客户端 `newLevel == oldLevel` 判不出升级 → **等级条不动**（B3 修掉）。四个都是 required，少一个直接不成帧 |

推送：`player.exp/level` 变了发 `Data_Push{playerChangeExpandLvl=1{curLevel,curExp}}`；
升级附带加体力（`PlayerGrow.addPower`）时同包补 `changeStrength=3{curStrength}`，
两个都**没**变化就不发 —— 多余的 `changePart` 会让客户端白刷一次属性面板。

**B3 有意没做的事**（做之前先想清楚代价）：进本**不扣体力**（`MainLevel.powerCost` /
`TrainLevel.strengthCost` 读了但没扣，扣了就回不了退不掉的账）、不发 `leaderExpReward`
（武将经验是客户端本地结算）、不给首通/三星奖励、任务进度 `bumpTask` 留到 B5。

### 4.5 挂机的三条地雷与"单场时长"口径（2026-11-01，B4）

挂机六条的状态机在 [`src/hangup.ts`](../src/hangup.ts)（只碰存档与表，不碰 GS 帧），
GS 帧的拼法留在 `payloads.ts`。口径全从客户端 Lua 反推（`HangUpBattleDataMgr` / `HangUpBattleMsg` /
`UIHangUpBattleCtrl`），三条最要命的：

- **① `passTime` 是除数，不是展示值。** 单场时长 = `GetPassedMinTime(levelId, type)`，读的是
  **玩家自己那条通关记录**的 `passTime` —— 也就是我们登录大包里 `MainLevelInfo.passTime=10` /
  `TrainLevelInfo.passTime=8`。客户端 `GetCurRemainHangUpNum = math.ceil(剩余秒 / 单场秒)`，
  给 0 就是 `ceil(x/0) = inf`，进度条、剩余场次、召回文案全废。原先 `mainLevelInfoBody` 恒发 0，
  所以主线挂机根本不可能成立。B4 的修法：`levels` 从 `id → 星级数组` 升成
  `SaveMainLevel{ 通关记录…, stars }`（真耗时由 3004 的 C2S `passTime=6` 写进去），
  读档统一过 `safePassTime()`（取整后不足 1 秒就兜 30）。于是**服务端永远发不出 0 的单场时长**，
  挂机侧不必再防除零 —— 只有"会话还挂着但记录被改档删了"这一种情况还需要防（`speedUp` 拒、
  `cancel` 按全部场次结算，不能凭空吞奖励）。
- **② `state` 靠读请求翻转。** `HangUpBattleState` 是 `0=未挂机或已领 / 1=挂机中 / 2=完成未领`；
  `state=1` 时客户端跑一个 1 秒 tick，**到 `endTime` 只是重发 `GetHangUpInfo`**，不自己改状态。
  所以 30400 除了回 `info` 还要 `refreshState()` + 落盘（领取、召回也各补一次，防"到点却没读过"）。
  红点 89 认的也是 `state=2`。
- **③ `settleInfo` 只许给空消息。** `HangUpBattleDataMgr.UpdateLevelInfo(settle)` 只在
  `settleInfo.type` 有值时动作（`type=2` → `PassTrainLevel(trainLevelInfo)`，`type=1` →
  `LevelDataMgr.UpdateLevelInfo(mainLevelInfo)`），这两条都会拿 id 去查关卡表，而挂机**不产生"新通关一关"**
  —— 带 type 就是送崩。`HangUpSettle` 全字段 optional，所以 `pb.bfield(2, Buffer.alloc(0))`
  既满足 required 又没有 type。

奖励只有一条通道能看见：`ShowItem_Push{ comeFrom = ActionEnum.HangUpGet = 702 }` → 事件
`HangUp_HangUpRewardsPush(16004)` → 挂机自己的发奖窗；`700/701/703/704` 在 Lua 里**没有**挂机分支，
发过去只会走通用"获得物品"窗。`ShowItem_Push` 在客户端的 `Ignore_Replenish_MsgID` 里，
所以必须走 `mainInCompleted` + `extra`（同 §3.1 第 1 条），顶栏数值则靠同包的 `Data_Push{changeStrength=3, changeExp=…}`。

失败一律 **`deny`**（§4.1），不走 `errorCode`：客户端的重试循环只认
`errorCode == -1 && msgId == GetHangUpInfo` 这一种组合，通用错误另有 `ErrorMsg_S2C` 那条通道
（`errorCode<=50000` 打断 + 确认框，否则 `OpenNetWorkNotice`），而我们从不写那条 ——
把 471001/471017 这类码发出去，等于把请求推进一条没人监听的分支。

**入口不需要补表**：`HangUpBattle_Xls` 六行的 `functionId` 294/295/296/297/298/4610，
经 `OpenFuction_Xls` 解出的解锁条件是 `6101110 / 6102103 / 6102106 / 0 / …`，这些 id 全在
`COMMON_CONDITION_IDS` 里，`GetOpenFunctionData(10102)` 一次全下发 → 外派入口天然开着。
`unlockCondition==1` 的"必须已通关"由服务端 `recordOf()` 拦（客户端也会自己拦，notice 400006）。
时间基准同样不用对时：`HeartManager.GetServerTime() = os.time() + deltaTime`，APK 与客户端在同一台机器上，
`deltaTime` 恒 0，直接用本地秒。

**B4 有意没做的事**：不校验"今日进本次数用完"（`todayAttackNum` 只累加）、不发 `leaderExpReward`、
不给首通/三星奖励、扫荡不查扫荡券、加速不扣道具。

### 4.6 任务/活跃度：进度是"服务端 + 客户端本地"两本账（2026-11-01，B5）

实现集中在 [`src/tasks.ts`](../src/tasks.ts)（集合、进度口径、日/周界、领取），
[`src/payloads.ts`](../src/payloads.ts) 只负责协议形状。四条契约是这一档的全部风险点：

- **① 回包里能读的字段比 proto 少得多。** 客户端 `TaskMsg` 只注册了 `3303/3302/900007/3308/3309`
  ——`3304` 与 `900010` 连回调都没有（发了也不派发）。`SubmitTask/BatchSubmitTask` 的 handler
  只取 `overTask`（单条 vs `ipairs` 由 `isOneClick` 决定）、`dayTaskPoint`、`weekTaskPoint`、`chapterIndex`，
  **`reward=1` 从来没被读过**：发奖只能靠 `ShowItem_Push`。`3302` 只把 `activePointId` `append` 进
  `passedDayPoints`、`3309` 只把 `id` `append` 进 `passedWeekPoints`，所以回包**只能带本次新领的那几个 id**，
  带全量等于让同一个宝箱在客户端里累加两次。
- **② 进度是混合口径。** `TaskDataMgr.UpdateTaskProgress`（`748180cd…:305`）只在
  `taskProgressData[missionId] ~= nil` **且** `pbNew.enum('msg.ServerTaskType', condition)` 命中时才用服务端值，
  其余条件一律本地算。而 `SetTaskProgress` 是**整张 map 清空后重建**，所以登录包里的 `taskProgress`
  必须是全量；`900007` 只是增量。我们只给自己真记过数的条件号发值（`progressOf` 返回 `null` 的行**不进列表**），
  没记过的一律不发 —— `TaskTools.GetTaskProgress`（`9efdb781…`）开头是 `local progress = 0`，
  不在表里的行读成 0，不会崩。
- **③ `1901`（全章节完成）例外，永远不发。** `UpdateTaskProgress` 对这一条件会就地重写
  `v.conditionNum = max(#mainTaskData - 1, 0)`；我们发 0 下去，客户端的章节领取按钮就没了。
  领取门槛同理：`GATED` 集合（= 我们真会 `bumpTask` 的条件号）按"没记过就是 0"拦，
  `1901` 不在 `GATED` 里，靠"本组还有没领的就拒绝章节奖"来兜。
- **④ 列表可见性由 `InitTaskList` 决定，不在我们手里。**（`748180cd…:267-283`，逐条命中即止）
  `chapterId == chapterIndex` → 主线；elseif `dayConditionId == dayGroupIndex` → 日常；
  elseif `missionType == beginTaskGroupIndex(4)` → 新手；`== weekGroupIndex(7)` → 周；
  `== NormalActivityTask` → 活动。四条都不中的行在界面上**不存在**（例：mission `1005001`，
  `chapterId=0/dayConditionId=0/type=1` 是死行）。`rollTasks()` 因此还要防两件事：
  存档里的 `taskChapter`/`dayGroupIndex` 被手改成一个表里没有的组 → 整个列表空白，
  所以入档前各校验一次并回落到 101/10001；章节推进也只接受表里真存在的 `chapterId`。

日/周界走 `dayEdgeSec/weekEdgeSec/nextDayRefresh/nextWeekRefresh`（**04:00 UTC+8**，与登录包
`refreshTimes=65` 里那个 4 同源），`rollDay/rollWeek` 记最近一次翻脸的界点；登录 `10002` 与
跨天 `10005` 共用这套函数、也共用 `taskProgressBody`/`taskInfoBody`，自测里有一条断言两者必须一致。

被动计数的投递靠 `HANDLERS` 出口的一个包装：`withTaskPush` 在每条 handler 返回后把 `bumpTask`
攒下的 `pending` 排干成一条 `900007`。`900007` 放 `pushes`（replenish 通道）是安全的 ——
客户端的 `Ignore_Replenish_MsgID` 只过滤 `ShowItem_Push`；但**同包一旦带 `ShowItem_Push`，
主包就必须改走 `mainInCompleted`**（同 §3.1 第 1 条）。`deny` 的包会把 `pending` 排干后丢弃，
不补发：那些计数会在下次登录/跨天随全量 `taskProgress` 回来。

`3303/3308/3302/3309` 的发奖都走同一个式子：`econ.rewardById`（同一 id 既可能指 `FixedReward_Xls` 的
固定组，也可能直接就是 `Drop_Xls` 的行，两种都认）
→ 物品落 `save.json` → `ShowItem_Push{comeFrom = 1001 提交任务 / 1002 日常活跃点}` + 同包 `Data_Push`
（`playerChangeExpandLvl=1`/`changeStrength=3`/`changeMoney=2`/`changePart=10` —— 任务奖励里有
`11` 源晶碎、`10` 贡献点数这些货币（`Items_Xls.itemType=1`，只能进 `changeMoney`，不推顶栏要等下次登录才对得上）。
日常组 `10001` 的活跃度天花板是 **180**、宝箱最高档 **100**，所以完全离线也能把五档领满。

**B5 有意没做的事**：后端观测不到的条件一律**不发进度**，行就显示成 0/N 且永远领不了
（巡逻 `2608`、周常的 `1609/1621/1626/3102` 那几条玩法未实现、成就/活动那些靠本地
`TaskTools.GetTaskProgress` 算的我们也一样不发）；`1002`（秘书互动）只能靠客户端发 `3304` 上报，
我们没法替它点；活动任务（`NormalActivityTask`）那条分支没接；`3304` 的 `errCode` 恒 0。

### 怎么加一个协议

1. 在 `CMD` 里加号；
2. 写返回 `Buffer` 的构造函数（`pb.concat` / `pb.vfield` / `pb.sfield` / `pb.bfield`）；
3. 挂进 `HANDLERS`；
4. 在 `test/selftest.mjs` 加一条 `checkHandler(msgId, ...)`：proto required 全覆盖 + **手写字段号断言**
   （`leader` 在 1 还是 2，各命令不一样，required 自检挡不住串号）+ 落盘断言，并登记进 `TIER1_DONE`；
5. `npm run build && npm run selftest`，再 `./run.sh` 重启（会先 build）。

字段号/类型查 [`proto/msg.proto`](../proto/msg.proto) 与各业务 proto（`PlayerProto` / `WeaponProto` / `Battle.proto` 等）。
