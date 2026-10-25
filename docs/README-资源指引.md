# 斯露德假服 · 项目资源指引

> 最后更新：2026-10-10 ｜ 当前方案 [`README.md`](README.md)

资源**不在 git 仓库里**（`offline-server/` 之外），全部在 `/home/sld/res/`。

---

## 1. 目录

```
/home/sld/res/
├── apk/
│   ├── sld_1.0.7.1426_bilibili.apk    1.8G  ← 装这个（B服）
│   └── sld_1.0.7.1428_nearme.apk      1.9G  ← 渠道服，不用装
├── phone/                              手机渠道服完整资源 dump
│   ├── files/thd/                      真正复制进手机的：kvl.kvl / newkvl.kvl / res / toLua / fightLua / media / cdnTextures
│   ├── files.zip                       6.0G 原始包（顶层 = files/）
│   ├── files.list.txt                  zip 清单
│   ├── luaplain/{toLua,fightLua}       明文 Lua（逆向用）
│   ├── msg.proto / other.proto         全量 protobuf
│   └── push_pkg/thd/res/data/*         补包（4 个哈希文件 + MD5SUMS）
└── backup/                             归档：apk-old / offline-old / old-logs / old-scratch / old-scripts / pc-remaster / probe
```

---

## 2. 客户端只需要两样

1. **装 APK**：`res/apk/sld_1.0.7.1426_bilibili.apk`
   （`com.wth.thrud.bilibili`，versionCode 1426，versionName 1.0.7，Unity 2021.3.18f1 + IL2CPP v29，arm64）。
   **不碰、不重签。**
2. **铺资源**：把 `res/phone/files.zip` 解到包名目录，让 `files/thd/` 落在：

```
/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/thd/
```

> zip 顶层就是 `files/`，别多解一层成 `.../files/files/`。

服务端只报 `resVersion=1583`（= `kvl.kvl` 里的 ResVersion），客户端判定无需更新，直接读盘上资源。

### 校验

| 项 | 期望 |
|---|---|
| `files/thd/kvl.kvl` | 4,508,995 字节（`ResVersion 1583 / AppVersion 1428`） |
| `files/thd/res/data/` | 6,150 个文件 |
| `files/thd/res/abIndex.json` | `mAbList` 5,925 条 |

---

## 3. 假服怎么用资源

假服**运行**时不需要 `phone/` 的资源——客户端读自己盘上那份。代码里唯一引用资源的是：

- [`config.paths.apk`](../src/config.ts)：默认 `<项目根>/../res/apk/sld_1.0.7.1426_bilibili.apk`，
  只给工具链 / selftest 取 `global-metadata.dat` 用，可用 `SLD_APK` 覆盖。

> 曾经用于假 CDN 的 `files/phone` 软链 + 1.0.7 APK 展开基线，已随热更 / `/res` 兜底一起删除。

---

## 4. 分析用资源

- **明文 Lua**：`res/phone/luaplain/{toLua,fightLua}`；运行时也能用 frida 抓（见 [`README-frida抓包.md`](README-frida抓包.md)）。
- **全量 protobuf**：`res/phone/msg.proto` / `other.proto`；工程内 `proto/*.proto` 是同一套的子集。
- **补包**：`push_pkg/thd/res/data/*` 是 4 个 MD5 命名的文件，配 `MD5SUMS` 校验。
- **IL2CPP 全量 metadata（可反汇编）**：`res/phone/files/il2cpp/Metadata/global-metadata.dat`
  （7,637,236 B，**完整**）。配合 `res/backup/offline-old/dump/il2cpp_runtime_dump.cs`（含方法 RVA）
  用 `aarch64-linux-gnu-objdump` / `radare2` 可把 C# 还原到指令级。
  注意区分：`offline-server/data/logs/global-metadata.dat`（7,625,500 B，运行期 dump）是被擦过的残件。

---

## 5. 关键结论

1. 客户端读「APK ∪ 外部目录」合并层，**外部优先**。
2. 1583 台账 44,841 条 = 手机外部 10,231 + APK 自带 34,610，**逐条 md5 全中**（0 不一致）；
   `abIndex.json` 5,925 条引用 100% 覆盖。
3. 客户端启动后会自己重写盘上的 `kvl.kvl`（只把 `AppVersion 1428` 改成 1426，条目 / md5 不变）——这是正常的。
4. 资源**整包铺**，别混版本、别只铺一半。
5. **别把"运行期 dump 的 metadata 被擦"当成"资源包里没有完整 metadata"**——
   完整件在 `res/phone/files/il2cpp/Metadata/`，抽卡两个根因就是靠反汇编它定位的。

---

## 6. 铁律

- APK 不碰、不重签；改动只落在外部数据目录 / 假服 / hosts。
- 别单独替换资源包里的 `res/*.json` 索引（客户端自己维护）。
- `res/` 不进版本库。
