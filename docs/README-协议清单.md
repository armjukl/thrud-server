# 斯露德（Thrud/sld）假服 · 协议清单

> 最后更新：2026-10-28 ｜ 当前方案 [`README.md`](README.md) ｜ 待修 [`README-待补功能.md`](README-待补功能.md)

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
| 10007 | GetWeaponListPage | ✅ | 每个角色下发一把默认式仗实例（`onlyId` 与 `leaderInfo.weaponId` 同源） |
| 10051 | GetSignReward | ✅ | 月签到领奖 |
| 10057 | ChangeSecretary | ✅ | 换看板，落 `data/save.json` |
| 10073 | ChangeStep | ✅ | 原样回显引导流 |
| 10076 · 10077 · 10080 | CheckPlayerName · ChangePlayerName · ChangeSex | ✅ | 改名/改性别落 `data/save.json` |
| 10100 | ClientDataOverLogin | ✅ 空 | |
| 10102 | GetOpenFunctionData | ✅ | 一次下发全部 conditionSet |
| 3304 | SetSpecialTaskProgress | ✅ errCode=0 | |
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
| 3004 | OverMainLevel | ✅ | 主线结算 `OverMainLevel_S2C`；胜利写回 `levels[]`（重登保留） |
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

### 怎么加一个协议

1. 在 `CMD` 里加号；
2. 写返回 `Buffer` 的构造函数（`pb.concat` / `pb.vfield` / `pb.sfield` / `pb.bfield`）；
3. 挂进 `HANDLERS`；
4. 在 `test/selftest.mjs` 加一条 `checkHandler(msgId, ...)`：proto required 全覆盖 + **手写字段号断言**
   （`leader` 在 1 还是 2，各命令不一样，required 自检挡不住串号）+ 落盘断言，并登记进 `TIER1_DONE`；
5. `npm run build && npm run selftest`，再 `./run.sh` 重启（会先 build）。

字段号/类型查 [`proto/msg.proto`](../proto/msg.proto) 与各业务 proto（`PlayerProto` / `WeaponProto` / `Battle.proto` 等）。
