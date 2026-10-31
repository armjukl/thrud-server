# 斯露德假服 · 与路 B 假 GS 的功能对比 + 现状台账

> 最后更新：2026-10-31 ｜ 分支 `gs-parity`（HEAD `5f1ef35`）｜ 协议细节 [协议清单](README-协议清单.md) ｜ 待办 [待补功能](README-待补功能.md) ｜ 存档 [存档修改](README-存档修改.md)

对齐目标是**路 B 的进程内假 GS** [`../../frida-gadget/mockgs_pc.lua`](../../frida-gadget/mockgs_pc.lua)（复刻 PC 纪念版那套）。
本文只回答三件事：**我们新做了什么**、**跟路 B 比还差什么**、**现在到底算做到哪一步**。

**证据等级**（别把占位当结论）：

- `[核]` —— 读过路 B 源码段或客户端 Lua（`/home/tmp/apklua_plain/toLua/`）并做了表实查，行号可回查；
- `[未核]` —— 只按能力域占位，路 B 那侧的具体做法没逐行确认，需要时再去核。

---

## 1. 两者根本不是同一种东西（对比前先摆平的差异）

| | 路 B `mockgs_pc.lua` | 我们 `offline-server/` |
|---|---|---|
| 位置 | **进程内**：frida-gadget 注进客户端，替换 Lua 层看到的"服务器" | **进程外**：HTTP(S) 9443 + UDP/KCP 19005 的假服务端 |
| 拦截点 | `EventManager.PostMsg` 决定派不派发（`:754-762`） | 只能决定**回不回包、回什么字节**；派发是客户端自己的事 |
| 存档 | 进程内字典，重启即清 | `data/save.json` 一份，**可手改、改完即生效**，原子写 + `.bak` |
| 配置表 | 直接读客户端已加载的 Lua 表 | `tools/gen_tables.py` 把整表搬进 `src/data/tbl/`，`tbl.ts` 统一取数面（行存/列存两种形状在这里展开） |
| 失败处理 | 不 PostMsg 就行 | 必须回**合法帧**否则客户端 20 s 超时挂 `210001` → 发明 `deny`（`header=0` 空包：请求收尾、遮罩关掉、一条回调都不跑）。见 [协议清单 §4.1](README-协议清单.md) |
| 载体 | 只在那台被注入的进程里跑 | 手机/PC 客户端都能连，`frpc` 可把 9443 挂公网 443 |
| 自检 | 33 项构建自检 + 39 条真字节断言（`frida-gadget/`） | `npm run selftest` **66 条**（含 proto required 全覆盖 + 帧级端到端 + 落盘回归） |

**结论先说**：路 B 是"语义供体"，不是"可以照抄的实现"。B1/B2 的口径全部**回到客户端 Lua 自己算的那套**，
所以有 §4 那五处"路 B 错、我们对"。

---

## 2. 功能域对比

| 域 | 路 B | 我们 | 等级 |
|---|---|---|---|
| 登录 / 大厅初始化 | 有 | ✅ `10000/10002/10003/10004/10005/10100/10102/10073`；登录大包 required 全配 | [核] |
| 角色养成（升级/突破/大阶小阶/主动被动/式杖） | 有 | ✅ **B1 九条** `1001 1002 1003 1004 1005 1008 1010 1011 1016`，真扣材料真走曲线，失败 `deny` | [核] |
| 武装（突破/强化/分解/上锁/精炼/洗练/选保留/换装） | 有（`:2216-2244, 2419-2594, 2618-2715, 6464-6624` 就是这一族） | ✅ **B2 七条** `1201 1202 1204 1205 1207 1208 1209` + 原有 `1203`；随机数 17/18 真编、实例落盘 | [核] |
| 抽卡 | 有 | ✅ `2000` 按池真实掉落链（`LotteryInstance→Drop→DropSet→DropGroup`），结果走 `ShowItem_Push`，新角色即时入大厅 | [核] |
| 背包 / 货币 / 消耗 | 有 | ✅ 原语齐（`econ.ts`：`checkConsume/payConsume/payItemList/costItem/addItem/addMoney/rewardById/fixedRewardItems`），扣发一律按 `Consume_Xls`/`Items_Xls`；顶栏数量靠 `ChangeMoney_Push`+`ChangePart_Push` | [核] |
| 主线通关**发经验 / 统御等级** | 有 | ⚠ `3004` 只写 `levels[]`（星级/通关记录留得住），**不给 `player.level` 加经验** → 靠它自然解锁章节这条还没通。**B3** | [未核] |
| 挂机 / 外派（`30400..30405`） | 有（PC 版有托管） | ❌ 未接，存档块 `hangUp` 已备好、`passTime` 口径已定。**B4** | [未核] |
| 任务 / 活跃度（`3301..3309`） | 有 | ⚠ 只接了 `3304`（回 errCode=0）；`tasks` 存档块与日/周界锚点在 B1 时已铺好。**B5** | [未核] |
| 签到 / 七日（`3308/3309` + `10051`） | 有 | ⚠ `10051` 与登录 `monthSign` 是骨架（能领、不算真进度），`bg` 七日块已备。**B6** | [未核] |
| 商店 / 邮件 / 战令 / 活动 | 部分 `[未核]` | ⚠ 一律"合法空包或版本号兜住"：`30300/30304` `21001/21015` `890105` `40002` `60003` `10006`。够进大厅、不够用功能 | [核] |
| 战斗 | 进程内直接喂 | ⚠ 进→打→结算→退闭环可用（`11028/11003/11018/11019/11031/11032`），**战场内 `12xxx` 实时同步没做** | [核] |
| 肉鸽 / 元素塔 / 巡逻 | `[未核]` | ❌ 空包（`9300009/9400004/20001`），客户端对应 DataManager 拿 nil | [核] |
| 武装皮肤/涂装（`1206`） | `[未核]` | ❌ 未接（`wskin` 块已备） | [核] |

---

## 3. 本轮（`gs-parity`）新增了什么

### 3.1 地基 A1–A7（`8edea5b`）

- **A1** `proto/` 补齐 `1015/1016` 与 `StickSkillLevel`，`test/proto_schema.mjs` 能从 `.proto` 读出 `required` 集；
- **A2** `tools/gen_tables.py`：整表 → TS 的生成管线（单文件 >4 MB 自动切列存，同批小 3.6×）；
- **A3** `src/tbl.ts`：**客户端配置表的唯一取数面**（`has/row/all/ids/num/str/arr/sorted/maxOf` + 缺行计数）；
- **A4** `save.ts` 新块（`weapons[].rand/last`、`tasks`、`bg`、`hangUp`、`wSeq`…）+ **原子写 + `.bak` 回退** + `normalizeSave` 结构迁移；
- **A5** `src/econ.ts` + `src/skills.ts`：扣费/发奖/升级曲线原语，只改存档、把改动记进 `Effects`，不 import `payloads.ts`（免环）；
- **A6** `test/proto_schema.mjs` + `checkHandler()` 驱动：每条 handler 的公共外壳（required 全覆盖 + 手写"字段号在 1 还是 2"断言 + 落盘回归）；
- **A7** 提交点 A。

### 3.2 B1 养成（`a845dfc` + `fb9d5c2`）

9 条接真逻辑（`1001` 从"每次 +1 级"的简化版重写成读 C2S 素材折经验 + 沿 `LeaderLv`/`PlayerGrow` 曲线连升），
并落地 **`deny` 拒单**这套失败语义（含 gs.ts 的帧级断言：`deny` / 未注册兜底 / 成功回包三种形状互不混淆）。

### 3.3 B2 武装（`5f1ef35`）

- **新建 `src/weapons.ts`**（436 行）：随机数"怎么摇"和"怎么编"同源。四列（`secondaryKeyList`/`ValueList`/
  `randomPropPoolIndex`/`randomEquipAttrIndex`）逐条对齐；`18` 的两种形状就是客户端 `IsRecastingOver` 的判据
  （洗属性不带技能、洗技能照抄 17 且 `scope` 显式 0）；保留项**按原槽位**放回；LCG + onlyId 播种，重启不跳数。
  取值链详见 [协议清单 §4.2](README-协议清单.md)。
- **`materializeWeapons`**：三套 `onlyId` 并存（派生号 / 抽卡 `"7g…"` 号 / `wSeq` 新号）之下，把实例列表变成
  **唯一真相并落盘**；`weaponInstances`/`equippedWeaponOf` 降级成它的只读视图。旧实现"每次现编列表、不落盘"，
  写完就丢 —— B2 的写操作能存住全靠这一步（[协议清单 §4.3](README-协议清单.md)）。
- **7 条 handler**：1201 突破 / 1202 强化 / 1204 分解 / 1205 上锁 / 1207 精炼 / 1208 洗练 / 1209 选保留；
  1204 返还另走 `ShowItem_Push`（客户端 handler 不看 `rewards`），1205/1207 的 `weaponInfo` 在**字段 2**。
- **`weaponInfoFromInst` 修正**：`19/20` 是**终身洗练次数**不是时间戳、补 `17/18`、`getTime` 用秒、
  `defleaderId` 认号不认人、`calcPropModelInfo` 并上随机属性。
- **自检 +20 条（46→66）**：7 条各含成功 + deny、17/18 形状与取值合法性、登录列表总检、物化不跳号、
  一条"故意把 18 编短"的负控；顺手补 `proto_schema` 的**枚举 wire 判定**（`RecastingType`/`SelectRandomType` 是 varint）。

---

## 4. 五处口径：路 B 是错的，我们以客户端 Lua 为准

| # | 议题 | 路 B | 我们 | 依据 |
|---|---|---|---|---|
| 1 | 随机条数 | `mockgs_pc.lua:2458` 把 `value4` 两个下标**写反** → 它发的 5★ 是 3 技能 2 属性，面板按 `[1]=2` 只画 2 格 | `Common["9910"+grate].value4[1]`=技能、`[2]`=属性（1★`[0,0]` 2★`[0,1]` 3★`[0,2]` 4★`[1,2]` 5★`[2,3]`，实测） | `0c5654f2…:479-522` |
| 2 | 精炼上限 | `#weaponRefinePower`（**恒 6**） | `TalentSkill` 里 `skillId==Weapon_Xls[cfg].weaponSkillId[1]` 的最大 `skillLevel-1`；90 把实测 0/2/4/5 档都有 | `0d1dfcfb…:152-172` |
| 3 | `recastingTime(19)`/`recastingSkillTime(20)` | 当**时间戳**发 | **终身次数**（客户端只判 `grate==5 且 ==0` 要不要提示该洗了） | `0379244d…:1244-1249` |
| 4 | `weaponRandomInfo(17)` / `last(18)` 的耦合 | 两组各摇各的 → 长度会漂移 | 四列**逐条等长**，且 `#18.key == #17.key`（PROP）/`#18.skill == #17.skill`（SKILL）；摇不齐就 `deny` | `a205bd07…:127/142/195-196/243-252` |
| 5 | `defleaderId(9)` / `getTime(8)` | `defleaderId` 直接填所属角色；`getTime` 写死一个数 | `defleaderId` **认号不认人**（只有派生号 `7000000+leaderId` 才非 0，否则会被客户端从仓库摘出去）；`getTime` 是**秒**，与 19/20 彻底分开 | `ccf1175a…` / `d7622373…:189` |

另有两处**"贴路 B"但明知是简化**的：`1016` 式杖升级不扣材料（客户端自己按 `consumeId ~= 0` 拦）、
`1207` 精炼不收钱不收物（90 把武器 `weaponRefineCos` 全空、`weaponRefineCosCoin` 全是 `Consume 90000` = 0 金币）。

---

## 5. 我们这边有、路 B 没有的东西

1. **可手改的存档** `data/save.json`（改名/等级/属性覆盖/材料/抽卡次数/七日/挂机…改完即生效，不用重启）。
2. **整表取数面**：36 张表进 TS，业务代码只走 `tbl.ts`，"表里到底有什么"不用猜（`npm run selftest` 有专门的取数面条目）。
3. **`deny` 语义**：路 B 靠不派发，我们靠 `header=0` 的合法空帧 —— 三者（deny / 未注册兜底 / 成功回包）形状互不混淆，有帧级断言守着。
4. **proto required 全覆盖自检**：手写 wire 最容易漏的"少发一个 required"，在 selftest 阶段就是红灯（真机上它表现为面板空白或崩）。
5. **推送链正确性**：`ShowItem_Push` 必须走 `PushMsg2Client`(completedList)，走 `replenishList` 会被 `Ignore_Replenish_MsgID` 过滤 —— 抽卡与 1204 分解都靠这条。
6. **确定性问题**：随机数按 onlyId 播种，同一把武器重启不跳数（路 B 每次现编）。

---

## 6. 现状（具体到哪一步）

| 项 | 数字 / 状态 |
|---|---|
| 分支 / HEAD | `gs-parity` / `5f1ef35`（地基 `8edea5b` → B1 `a845dfc`+`fb9d5c2` → B2 `5f1ef35`） |
| `HANDLERS` 注册 | **56 条**（`node -e "console.log(Object.keys(require('./dist/payloads.js').HANDLERS).length)"`） |
| 自检 | **66/66 通过**，`npm run selftest` 23 s（峰值 RSS 169 MB） |
| typecheck / build | 5.99 s（357 MB）/ 冷编译 6.33 s（371 MB），阈值 8 s / 15 s |
| `dist` / `src/data/tbl` 体积 | 15 MB / 13 MB |
| 第一档进度 | 28 条新命令里 **15 条已接**（B1 8 + B2 7；`1001` 是重构已有 handler，不在这 28 条里 —— 判据见 `selftest.mjs` 的 `TIER1_DONE`，注册表守卫会拦住"偷偷接了不登记"）；余 **13 条：B3 通关发经验 1 / B4 挂机 6 / B5 任务 4 / B6 签到 2** |
| **真机验证** | ⚠ **一轮都没跑**。B1+B2 攒在一起跑，判定点见 [待补功能 §1.3](README-待补功能.md)：武装面板空白（19/20）、点"保留"无反应（17/18）、属性行取不到崩（`EquipAttribute`）、精炼成功但等级没跳（`maxRefine` 口径）、分解后物品凭空消失（没推 `ShowItem_Push`）；两侧看日志的位置在 [待补功能 §8](README-待补功能.md) |
| 真机前的前置 | **先备料**（假服是真扣费，没料就每条 `deny`，现象像"没实现"）：`1090101`/`1090102`/`1030011`/`1030012`/`1090001` + 金币，见 [存档修改「给武装 B2 的真机轮备料」](README-存档修改.md) |
| 运行中的假服 | 若已在跑，它加载的是**旧 `dist`**；用新逻辑要 `./run.sh` 重启，**会断开已连接的客户端** |

---

## 7. 下一档（B3）范围预告

- `3005` 通关发经验 + `3004` 顺手接上 `econ.rollPlayerLv`/`addExp`，解掉 [待补功能 §1.1](README-待补功能.md)（章节/关卡自然解锁不再靠手改 `player.level`）；
- 通关要推 `Data_Push.playerChangeExpandLvl(1)`，否则顶栏等级不跳；
- 同批考虑把 `bumpTask`（升级/通关类任务进度）铺好，给 B5 省一半工作。
