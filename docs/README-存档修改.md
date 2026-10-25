# 斯露德假服 · 存档修改

> 最后更新：2026-10-11 ｜ 数据文件都在 [`offline-server/data/`](../data/) ｜ 当前方案 [`README.md`](README.md)

斯露德没有一份客户端「玩家存档文件」可改：客户端自己维护本地进度，服务器每次登录按收到的请求现算。
假服里能持久化并被读回的玩家数据，全部集中在**一份** `data/save.json`（可读可写）。读写在
[`src/save.ts`](../src/save.ts)：

- **读**：每次请求 `loadSave()` 重读 → 手工改 JSON **改完即生效，不用重启**；
- **写**：游戏内变化（改名 / 改性别 / 换看板 / 换装 / 换武器 / 升级 / 序章推进 / 通关 / 抽卡 / 签到）由服务端改完 `saveSave()` **回写**。
- 缺字段/格式错由 `normalizeSave()` 补默认值，不会导致启动失败。

---

## 1. 结构总览

```json
{
  "prologue":  { "done": true, "id": "" },
  "player":    { "uid": 10000, "name": "指挥官", "sex": 0, "level": 45, "exp": 0, "maxExp": 100,
                 "strength": 120, "maxStrength": 120, "shipStrength": 100, "maxShipStrength": 100,
                 "secretary": 2001001 },
  "characters": [ { "id": 2001001, "level": 1, "exp": 0, "star": 0, "starLevel": 0, "breach": 0,
                    "attrs": {}, "favorabilityLevel": 1, "favorabilityExp": 0,
                    "clothingId": 0, "weaponId": "", "signLv": 0, "perkId": "" } ],
  "weapons":   [ { "onlyId": "7...", "cfg": 5021010, "leaderId": 2001001, "level": 1, "breach": 0,
                   "exp": 0, "refine": 0, "lock": 0, "skin": 0 } ],
  "items":     { "1000001": 9999 },
  "money":     { "11": 9999999 },
  "cloths":    [ 4001101 ],
  "wskin":     [ 6011010 ],
  "levels":    { "101101": [1,2,3] },
  "trainLevels": [ 100101 ],
  "gacha":     { "5001": 10 },
  "signin":    { "month": 0, "times": 0, "day": -1, "lastTime": 0 }
}
```

## 2. 字段说明

| 路径 | 含义 | 落到哪个协议 |
|---|---|---|
| `prologue.done` / `id` | 序章/创角是否完成 / 续播步（空=从头） | `PlayerLogin_S2C.beginnerModeProgress`（true→2 直插大厅）/ `GetPrologue_S2C.data` |
| `player.uid` / `name` / `sex` | uid / 指挥官名 / 性别（0 女 1 男，`ChangePlayerName`/`ChangeSex` 回写） | `PlayerLogin` + `playerLiveInfo` |
| `player.level` / `exp` / `maxExp` | 统御等级 / 经验 / 升级所需 —— **章节解锁要求 `MainChapter.unlockLevel ≤ level`（最高 45）** | `PlayerLogin_S2C.levelExp` + `playerLiveInfo` |
| `player.strength` / `maxStrength` | 体力 / 上限 | `playerLiveInfo.strength` |
| `player.shipStrength` / `maxShipStrength` | 舰船耐久 / 上限 | `PlayerLoginGetInfo_S2C` 字段 78 / 79 |
| `player.secretary` | 大厅看板 `leaderId`（`ChangeSecretary` 回写；必须在 `characters[]` 里） | `playerLiveInfo.secretary` |
| `characters[]` | 武将列表，每项一条 `LeaderInfo` | `PlayerLoginGetInfo_S2C.leaderInfo`（字段4） |
| `characters[].level/star/starLevel/breach` | 等级 / 位阶 / 位阶等级 / 突破 —— 参与属性成长计算 | `LeaderInfo` + `calcPropModelInfo` |
| `characters[].attrs` | **属性覆盖**：属性id(字符串)→值，直接覆盖按等级/突破算出的终值 | `LeaderInfo.calcPropModelInfo` |
| `characters[].clothingId` | 当前穿戴战装(皮肤)（`SwitchClothing` 回写） | `LeaderInfo.clothingId` |
| `weapons[]` | 式仗实例列表（`onlyId` 唯一；`leaderId`=穿戴者，0=闲置）；空则按角色补默认 | `PlayerLoginGetInfo_S2C.weaponInfos(32)` + `GetWeaponListPage(10007)` |
| `items` | 背包道具 `itemId→数量`（只发客户端 `Items_Xls` 里存在的 id） | `PlayerLoginGetInfo_S2C.parts(12)` |
| `money` | 货币 `itemId→数量` | `PlayerLoginGetInfo_S2C.moneyPart(62)` |
| `cloths` | 已拥有角色战装(皮肤) id | `clothingInfo(41)` |
| `wskin` | 已拥有武装涂装 id | `weaponSkinInfo(45)` |
| `levels` | 主线通关：`关卡id→星级数组` | `mainLevelInfo(63)`（`OverMainLevel` 胜利自动写回） |
| `trainLevels` | 已通关训练本 id | `trainLevelInfo(64)` |
| `gacha` | 抽卡：`卡池id→已抽次数` | 登录 `swearInfo(20)` |
| `signin` | 月签到：`month`/`times`/`day`/`lastTime`（当天已签时不再弹面板） | 登录 `monthSign(80)` + `GetSignReward(10051)` |

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

> `data/logs/`、`data/capture/` 都可重建，不进版本库。

---

## 5. 想改别的？

协议骨架（`serverInfos` 聊天服地址、`cdnInfo`、`taskProgress` 章节、`battleEnterInfo` 细节等）仍写死在
[`src/payloads.ts`](../src/payloads.ts)，改完必须 `npm run build`（`./run.sh` 会先 build）**并重启**假服。

---

## 6. 注意

- 服务器**不会**把背包 / 货币 / 角色等写回客户端本地存档；改服务端只影响服务器回给你的那份。
- 重启假服会断开当前连接。
