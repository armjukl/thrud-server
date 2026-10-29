# 斯露德假服 · 存档修改

> 最后更新：2026-10-29 ｜ 数据文件都在 [`offline-server/data/`](../data/) ｜ 当前方案 [`README.md`](README.md)

斯露德没有一份客户端「玩家存档文件」可改：客户端自己维护本地进度，服务器每次登录按收到的请求现算。
假服里能持久化并被读回的玩家数据，全部集中在**一份** `data/save.json`（可读可写）。读写在
[`src/save.ts`](../src/save.ts)：

- **读**：每次请求 `loadSave()` 重读 → 手工改 JSON **改完即生效，不用重启**；
- **写**：游戏内变化（改名 / 改性别 / 换看板 / 换装 / 升级 / 序章推进 / 通关 / 抽卡 / 签到 + 武装一族：
  换武装、突破、强化、分解、上锁、精炼、洗练保留）由服务端改完 `saveSave()` **回写**。
- 缺字段/格式错由 `normalizeSave()` 补默认值，不会导致启动失败。
- `saveSave()` **原子写**：`save.json.tmp` → 旧的 `save.json` 复制成 `save.json.bak` → `rename`。
  `loadSave()` 的回退链是 `save.json` → `save.json.bak` → 默认档，**不会**因为一次写盘中断就把整档滚回新号
  （坏档会打 `save` 告警 `save.json 解析失败，已回退 .bak`）。
- 老档缺新块时由 `migrateSave()` 按 `bgVersion < BG_SCHEMA` 补一次锚点（`regTime` /
  `player.strengthRealTime` / `bg.open` / `tasks.rollDay` / `tasks.rollWeek`）并立刻落盘。
  判据只用这个哨兵，**不靠"字段值是不是 0"** —— 老档的 `regTime` 可能恰好等于当时那一秒。

---

## 1. 结构总览

```json
{
  "prologue":  { "done": true, "id": "" },
  "player":    { "uid": 10000, "name": "指挥官", "sex": 0, "level": 45, "exp": 0, "maxExp": 100,
                 "strength": 120, "maxStrength": 120, "shipStrength": 100, "maxShipStrength": 100,
                 "secretary": 2001001, "strengthRealTime": 1793201542089 },
  "characters": [ { "id": 2001001, "level": 1, "exp": 0, "star": 0, "starLevel": 0, "breach": 0,
                    "attrs": {}, "favorabilityLevel": 1, "favorabilityExp": 0,
                    "clothingId": 0, "weaponId": "", "signLv": 0, "perkId": "",
                    "activeLv": {}, "talentLv": {}, "stick": {}, "stickLv": {} } ],
  "weapons":   [ { "onlyId": "7000001", "cfg": 5021010, "leaderId": 2001001, "level": 1, "breach": 0,
                   "exp": 0, "refine": 0, "lock": 0, "skin": 0,
                   "recastingTime": 0, "recastingSkillTime": 0,
                   "rand": { "skill": [], "key": [], "val": [], "poolIdx": [], "attrIdx": [], "scope": 0 },
                   "last": { "skill": [], "key": [], "val": [], "poolIdx": [], "attrIdx": [], "scope": 0 } } ],
  "items":     { "1000001": 9999 },
  "money":     { "11": 9999999 },
  "cloths":    [ 4001101 ],
  "wskin":     [ 6011010 ],
  "levels":    { "101101": [1,2,3] },
  "trainLevels": { "100101": { "id": 100101, "passTime": 30, "todayAttackNum": 1, "attackNum": 1,
                               "lastAttackTime": 1793201542089 } },
  "gacha":     { "5001": 10 },
  "signin":    { "month": 0, "times": 0, "day": -1, "lastTime": 0 },
  "tasks":     { "taskChapter": 101, "dayGroupIndex": 10001, "dayTaskPoint": 0, "weekTaskPoint": 0,
                 "passedTasks": {}, "progress": {}, "passedDayPoints": [], "passedWeekPoints": [],
                 "rollDay": 1793201542000, "rollWeek": 1793201542000 },
  "bg":        { "open": 1793201542, "sign": 0, "signTime": 0, "bingo": [], "redDot": false },
  "bgVersion": 1,
  "hangUp":    { "type": 0, "levelId": 0, "times": 0, "startTime": 0, "endTime": 0, "state": 0 },
  "wSeq":      0,
  "regTime":   1793201542
}
```

> **改存档不用写全**：上面是"归一化后的完整形状"，少写的键由 `normalizeSave()` 补默认。
> 但**服务端加新块时必须四处同步** —— 接口 / `DEFAULT_SAVE` / `normalizeSave` / 本文件字段表。
> 漏了 `normalizeSave` 的表现是"写盘成功、读回即丢"（静默），所以
> `npm run selftest` 里有两条守卫：全字段档往返必须 deep-equal、顶层键集必须相等。

## 2. 字段说明

| 路径 | 含义 | 落到哪个协议 |
|---|---|---|
| `prologue.done` / `id` | 序章/创角是否完成 / 续播步（空=从头） | `PlayerLogin_S2C.beginnerModeProgress`（true→2 直插大厅）/ `GetPrologue_S2C.data` |
| `player.uid` / `name` / `sex` | uid / 指挥官名 / 性别（0 女 1 男，`ChangePlayerName`/`ChangeSex` 回写） | `PlayerLogin` + `playerLiveInfo` |
| `player.level` / `exp` / `maxExp` | 统御等级 / 经验 / 升级所需 —— **章节解锁要求 `MainChapter.unlockLevel ≤ level`（最高 45）** | `PlayerLogin_S2C.levelExp` + `playerLiveInfo` |
| `player.strength` / `maxStrength` | 体力 / 上限 | `playerLiveInfo.strength` |
| `player.shipStrength` / `maxShipStrength` | 舰船耐久 / 上限 | `PlayerLoginGetInfo_S2C` 字段 78 / 79 |
| `player.secretary` | 大厅看板 `leaderId`（`ChangeSecretary` 回写；必须在 `characters[]` 里） | `playerLiveInfo.secretary` |
| `player.strengthRealTime` | 上次权威结算体力的**秒**锚点；服务端按 `(now-anchor)/回体周期` 把 `strength` 追平后再下发，**只补不削**（奖励发的溢出体力不能钳回上限） | `playerLiveInfo.lastStrengthTime(19)`（客户端自己也按 `GetServerTime()-它` 逐帧回体） |
| `characters[]` | 武将列表，每项一条 `LeaderInfo` | `PlayerLoginGetInfo_S2C.leaderInfo`（字段4） |
| `characters[].level/star/starLevel/breach` | 等级 / 位阶 / 位阶等级 / 突破 —— 参与属性成长计算。**`star` 从 0 起**（`star*3+starLevel` 是节点索引） | `LeaderInfo` + `calcPropModelInfo` |
| `characters[].attrs` | **属性覆盖**：属性id(字符串)→值，直接覆盖按等级/突破算出的终值 | `LeaderInfo.calcPropModelInfo` |
| `characters[].clothingId` | 当前穿戴战装(皮肤)（`SwitchClothing` 回写） | `LeaderInfo.clothingId` |
| `characters[].activeLv` | 主动/极奏/普攻技能等级：`skillId→等级`（`UpgradeLeaderActiveSkill` 1008）；缺席按 1 级 | `LeaderInfo.activeSkills(17)` `ActiveSkillInfo{id,level,type}` |
| `characters[].talentLv` | 被动(天赋)技能等级：`skillId→等级`（1004） | `LeaderInfo.talentSkills(11)` `TalentSkill{id,level,state}` |
| `characters[].stick` | 式杖技能槽：`槽位id→LeaderWandSkill 行id`（1010 换槽；`ResetStickSkill` 1011 **只清这一项**） | `LeaderInfo.stickSkills(23)` `ProtoHashInt2Int` |
| `characters[].stickLv` | 式杖技能等级：`skillId→等级`（1016；上限取 `TalentSkill_Xls` 里该 skillId 的最大 `skillLevel`，**不是 `Skill_Xls.maxLevel`**——它恒为 1） | `LeaderInfo.stickSkillLevel(27)` `StickSkillLevel{id,level,state}` |
| `weapons[]` | 式仗实例列表（`onlyId` 唯一；`leaderId`=穿戴者，0=闲置）；缺装备的角色由 `materializeWeapons` 当场补一把默认式仗。`onlyId` **三套并存**（见「武装 onlyId 三套号」）：派生号 `"7000000"+leaderId` / 早期抽卡的 `"7g<cfg>-<n>"` / `wSeq` 新发的 `"7000000"+n`，都不迁移 —— 客户端按 onlyId 索引，换号等于全丢 | `PlayerLoginGetInfo_S2C.weaponInfos(32)` + `GetWeaponListPage(10007)` |
| `weapons[].recastingTime` / `recastingSkillTime` | **已洗属性/技能次数**（不是时刻！）：客户端 `NeedRecastingTips` 判 `grate==5 且 ==0` 才提示"该洗了"，所以从 0 起、每洗 +1；1208 也是按"次数 +1"再播种摇下一组 | `WeaponInfo` required 19 / 20 |
| `weapons[].rand` | 当前生效的随机结果（`key/val/poolIdx/attrIdx` **四列长度必须一一对应**，`normalizeSave` 会按最短截齐；属性 id 只能取自 `EquipAttribute_Xls`，取值落在 `attributeRange` 内）。空档时按 **onlyId 播种**的 LCG 现摇，所以手改 `onlyId` 会换一组数 | `WeaponInfo.weaponRandomInfo(17)` |
| `weapons[].last` | 洗出来还没保留的那组，**只存被重摇的那一半**：洗属性→只有 `key/val/poolIdx/attrIdx`（`skill` 留空），洗技能→只有 `skill`。两半都填等于存两份真相，客户端 `IsRecastingOver` 会同时判成"属性和技能都待确认"。手改档时宁可乐空，别造半个 | `WeaponInfo.lastWeaponRandomInfo(18)` |
| `items` | 背包道具 `itemId→数量`（只发客户端 `Items_Xls` 里存在的 id） | `PlayerLoginGetInfo_S2C.parts(12)` |
| `money` | 货币 `itemId→数量` | `PlayerLoginGetInfo_S2C.moneyPart(62)` |
| `cloths` | 已拥有角色战装(皮肤) id | `clothingInfo(41)` |
| `wskin` | 已拥有武装涂装 id | `weaponSkinInfo(45)` |
| `levels` | 主线通关：`关卡id→星级数组` | `mainLevelInfo(63)`（`OverMainLevel` 胜利自动写回） |
| `trainLevels` | 训练本通关：`关卡id→记录`。**老档的 `[100101]` 会自动升上来**（`passTime` 兜 30 秒） | `trainLevelInfo(64)` |
| `trainLevels[].passTime` | 单局秒数 —— 挂机/扫荡按它折算单位产出，**给 0 等于"瞬间打完"，奖励池会被算空** | `TrainLevelInfo` required 8 + `HangUpInfo` |
| `gacha` | 抽卡：`卡池id→已抽次数` | 登录 `swearInfo(20)` |
| `signin` | 月签到：`month`/`times`/`day`/`lastTime`（当天已签时不再弹面板） | 登录 `monthSign(80)` + `GetSignReward(10051)` |
| `tasks` | 任务/活跃度：`taskChapter` **默认 101**、`dayGroupIndex` **默认 10001**（144 条 `condition=3100` 的任务选错组会打死 `PatrolDataManager`）、`dayTaskPoint`/`weekTaskPoint`、`passedTasks`(taskId→1)、`progress`(taskId→进度)、`passedDayPoints`/`passedWeekPoints`(已领的活跃度箱 id)、`rollDay`/`rollWeek`(上次跨日/跨周刷新的**ms**锚点) | `taskProgress`(登录) + `SubmitTask`/`GetActivePointReward` |
| `bg` | 初心者+七日签到：`open`(**秒**时间戳，活动开启时刻)、`sign`(已签天数)、`signTime`(**秒**，上次签到)、`bingo`(已领的 bingo 行 id)、`redDot`(bool) | `FirstThought_S2C.thoughtInfo` + `SignBingoReward` |
| `bgVersion` | 结构迁移哨兵（`< BG_SCHEMA` 才补锚点），**手改它只会让迁移再跑一遍**，别当开关用 | — |
| `hangUp` | 挂机/外派会话：`type`/`levelId`/`times`/`startTime`(**秒**)/`endTime`(**秒**)/`state`（0=没在挂；`HangUpInfo.state` 是 required **int64**） | `GetHangUpInfo(30400)` 一族 |
| `wSeq` | 武装 `onlyId` 发号器（当前值 +1 拼成号） | — |
| `regTime` | 建档时刻(**秒**)，七日/体力回算的锚点 | `FirstThought` 的 `signTimeStamp` 等 |

### 武装 onlyId 三套号（2026-10-29，B2）

| 形态 | 例子 | 怎么来的 | 编进协议时 |
|---|---|---|---|
| 派生号 | `"7000000" + leaderId` | 老实现给每个角色合成的默认式仗，客户端早已按它索引 | `WeaponInfo.defleaderId(9) = leaderId` → `CheckIsDefaultWeapon` 为真，**从武装仓库列表里摘出去**、也不可分解 |
| 抽卡号 | `"7g5041010-3"` | 早期 `payloads.ts` 直接拼的（现档 27 把） | `defleaderId = 0` |
| `wSeq` 号 | `"7000000" + ++wSeq` | `econ.grantWeapon` / `materializeWeapons` 给空号、撞号、新实例发 | `defleaderId = 0` |

`defleaderId` **认号不认人**：只有"派生号 == 穿戴者"才算默认式仗。手改档时把 `leaderId` 挪给别人，
派生号就自动降级成普通库存（这才对得上客户端 `359/383` 那两处过滤）。反过来，给一把 `wSeq` 号写
`defleaderId>0` 会让它在仓库里**凭空消失**。

10007（`GetWeaponListPage`）是"发号 + 落盘"的时机：物化当场编出来的号必须留在档里，
否则下次登录又换一套号，客户端按 onlyId 建的索引全乱。

### 时间戳口径（混用是挂机/签到最容易错的点）

| 键 | 单位 |
|---|---|
| `trainLevels[].lastAttackTime`、`tasks.rollDay/rollWeek` | **毫秒** |
| `player.strengthRealTime`（= 协议 `lastStrengthTime`）、`bg.open`、`bg.signTime`、`hangUp.startTime/endTime`、`regTime`、`signin.lastTime` | **秒** |

`weapons[].recasting*Time` 名字带 Time 但**是次数**（见上表）。日界/周界统一走 `payloads.ts` 里那套
**4:00 UTC+8** 的算法，不再新建第二套。

> `characters[]` 有两条下发路径：登录 `PlayerLoginGetInfo_S2C.leaderInfo`，以及运行中
> `Data_Push(900011).leaderAttrChanged`（升级武将 `1001`、抽卡 `2000` 出新角色时后置推送）。
> 手改 `characters[]` 后**重登**即可；不重登就看大厅角色表的话，得靠上面那条推送。

### 属性 id 对照（`characters[].attrs` 的 key）

`100`=生命 `101`=攻击 `102`=防御 `103`=能量 `104`=暴击 `305`=击破 `201`=暴击率% `200`=暴击伤害%

### 可用 id

- 角色：`src/data/leader.ts`（41 个，2xxxxxx）
- 角色/武器品质（1..5，5=金）：`src/data/rarity.ts`（`LEADER_QUALITY` / `WEAPON_GRATE`）
- 武器配置：`src/data/weapon.ts`（90 个；**下发时会过滤掉无突破配置的 10 个**，否则客户端崩）
- 道具：`src/data/items.ts`（`ITEM_IDS`）、货币 `MONEY_IDS`
- 战装/涂装：`src/data/skins.ts`
- 抽卡门票：`src/data/lottery.ts` 各池的 `itemId`（当前只有 `1000001` 聆听圣钥）

### prologue 三种用法

| 值 | 效果 |
|---|---|
| `done:true` | 直接进大厅（`beginnerModeProgress=2`） |
| `done:false, id:""` | 从头播序章 |
| `done:false, id:"101013"` | 从 101014 前一步续播（卡在某步时用它跳过） |

### 例：只留初始角色 + 满等级 + 稀有属性

```json
{
  "prologue": { "done": true, "id": "" },
  "player": { "uid": 10000, "name": "指挥官", "sex": 0, "level": 45, "exp": 0, "maxExp": 100,
              "strength": 999, "maxStrength": 999, "shipStrength": 999, "maxShipStrength": 999,
              "secretary": 2001001 },
  "characters": [
    { "id": 2001001, "level": 60, "exp": 0, "star": 6, "starLevel": 6, "breach": 5,
      "attrs": { "100": 999999, "101": 88888 }, "favorabilityLevel": 10, "favorabilityExp": 0,
      "clothingId": 0, "weaponId": "", "signLv": 0, "perkId": "" }
  ]
}
```

---

### 例：给武装 B2 的真机轮备料

假服的洗练/突破/强化是**真扣费**的，档里没料就每条都拒单 —— 现象像"没实现"，其实是 `deny`。
`data/save.json` 里补这几项（改完即生效，不用重启）：

```json
{
  "money": { "10": 999999 },
  "items": { "1030011": 60, "1030012": 60,
             "1090101": 100, "1090102": 100, "1090001": 50 }
}
```

| id | 用处 | 单笔量 |
|---|---|---|
| `10`（金币，走 `money`） | 突破 27000 起 / 洗练每笔 7500 | 强化**不收金币**（`WeaponGrow.parNum` 全空） |
| `1030011` / `1030012` | 突破材料（按 `WeaponBreak[...].consumeId` 的档位） | 5041010 首突 20 个 |
| `1090101` 改组零件 | 洗练本体花费（`WeaponRefining[grate]`） | 每笔 10 个 |
| `1090102` 定向固锁零件 | 锁定花费（`WeaponRefiningLock[锁数]`） | 属性页 `5×锁数`、技能页 `5×(锁数+1)`；锁数 >4 客户端直接崩 |
| `1090001` 式仗经验料 | 强化经验 | 每份 200 经验 |

精炼（1207）**不收任何材料**，但要喂同配置的闲置武装实例当卡 —— 想试它就往 `weapons[]` 里多塞几把同 `cfg` 的。

---

## 3. 内存态（重启即清）

| 状态 | 位置 | 说明 |
|---|---|---|
| 新手引导流 `guideData` | [`src/payloads.ts`](../src/payloads.ts) 模块级变量 | `ChangeStep` 上报时存、登录 `GuideInfo` 回填；重启从空开始 |
| 战斗 `lastBattleLevelId` | 同上 | 记最近一次 `StartSoloBattle` 的关卡，供 `OverMainLevel` 结算用；重启清零 |

---

## 4. 运行时写出的文件

| 文件 | 内容 |
|---|---|
| `data/logs/http-requests.jsonl` | 每条 HTTP 请求 |
| `data/logs/gs-req-<msgId>.fields.json` | 每个 GS 请求解出的 protobuf 字段 |
| `data/logs/unknown-msgids.json` | 未识别 msgId 频次 |
| `data/logs/framing-locked.json` / `peers.json` | 帧规则锁定 / 在线 peer |
| `data/logs/server.log` | 运行日志 |
| `data/capture/*.bin` + `*.txt` | 收发原始报文 |
| `data/header-rule.json` | 帧规则（`"le32-len+id"`）；改回 `"auto"` 重新试探 |
| `data/frame_prefix.txt` | push 前导字节 |
| `data/save.json.tmp` | `saveSave()` 原子写的中间文件，rename 后不残留 |
| `data/save.json.bak` | 上一版存档（`loadSave()` 遇到坏 `save.json` 时读它）；`.tmp`/`.bak` 都不入库 |

> `data/logs/`、`data/capture/` 都可重建，不进版本库。

---

## 5. 想改别的？

协议骨架（`serverInfos` 聊天服地址、`cdnInfo`、`taskProgress` 章节、`battleEnterInfo` 细节等）仍写死在
[`src/payloads.ts`](../src/payloads.ts)，改完必须 `npm run build`（`./run.sh` 会先 build）**并重启**假服。

---

## 6. 注意

- 服务器**不会**把背包 / 货币 / 角色等写回客户端本地存档；改服务端只影响服务器回给你的那份。
- 重启假服会断开当前连接。
