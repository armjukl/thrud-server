# 斯露德假服 · frida 抓包方法

> 最后更新：2026-10-10 ｜ 脚本在 [`frida/`](../frida/) ｜ 历史推演见 [`docs/old/PROGRESS-frida.md`](old/PROGRESS-frida.md)

用途：**假服日志看不到的东西**——明文 Lua chunk、UDP/KCP 原始数据报、运行时 IL2CPP 类结构、死域名 / DNS 行为。
纯 HTTP 抓包**不用 frida**：假服自己就记在 `data/logs/http-requests.jsonl`。

---

## 1. 连接方式（不需要 adb）

> **frida-server 挂了 / 不想依赖它？** 换这条通道：用注入器载体把 frida-gadget 注进游戏进程，
> 脚本在进程内自带落盘 —— 见 [`README-注入器gadget.md`](README-注入器gadget.md)。

手机跑 frida-server，本机通过隧道连它：

```
SLD_FRIDA=23.147.232.29:27049   # 默认值，见各脚本
```

`run_hook.py` / `auto_spawn.py` / `run_dump.py` 都用
`frida.get_device_manager().add_remote_device(...)` 远程连，不依赖 adb。

---

## 2. 常用脚本

| 脚本 | 作用 |
|---|---|
| `frida/run_hook.py spawn <秒>` | 冷启动游戏，挂 `hook_sld.js`，把 Lua 明文与 UDP 包落盘后退出 |
| `frida/run_hook.py attach <秒>` | 附着已跑的进程 |
| `frida/auto_spawn.py` | 守护进程：轮询 → 发现手动启动的游戏就 kill → spawn + 挂 hook；崩溃自动重开 |
| `frida/run_dump.py` | 附着已跑进程，跑 `il2cpp_dump.js` → `il2cpp_runtime_dump.cs`（类 / 方法 / 字段 / 偏移 / RVA） |
| `frida/hook_sld.js` | 默认 agent：`liblua54.so` 加载入口抓 Lua chunk + `libc` UDP 收发抓 KCP 数据报 |
| `frida/hook_redirect_trust.js` | `getaddrinfo` 把死域名改写到隧道 IP + Java 侧 trust-all（让客户端连上假服） |
| `frida/hook_gadget_all.js` · `hook_gadget_all_skip.js` | 上面那份 + il2cpp 块，给 **gadget 冷启动**用（WATCH 观测 / SKIP 跳过登录视频预载），见 [`README-注入器gadget.md`](README-注入器gadget.md) |
| `frida/hook_netflow.js` · `hook_java_net.js` | 只侦察：列出 `getaddrinfo` / `connect` 目标、SDK 打开的所有 URL |
| `frida/il2cpp_*.js` | 运行时 IL2CPP 探针（dump / 按类名挂钩 / 找字段 / 反汇编） |

---

## 3. 落盘位置

`run_hook.py` 默认 `SLD_OUT=<offline-server>/../frida_dump`：

```
frida_dump/
├── lua-<MMDD-HHMMSS>/    Lua chunk（.bin，明文）
└── net-<MMDD-HHMMSS>/    每个 UDP 数据报一个 .bin（KCP/raw）
```

`run_dump.py` 默认 `SLD_DUMP=/home/qkzx/offline/sld/dump/il2cpp_runtime_dump.cs`（可用环境变量改）。

---

## 4. 两段式注入

spawn 太早时 `libil2cpp.so` 还没初始化，直接调 `il2cpp_*` 会**崩进程**。所以：

- `SLD_AGENTS`：spawn 阶段就挂（redirect / trust 这类不依赖 il2cpp 的）；
- `SLD_AGENTS2`：`SLD_DELAY2`（默认 12–16s）后再挂（il2cpp 相关）。

例（重定向 + 网络侦察，跑 60 秒）：

```bash
cd /home/sld/offline-server/frida
SLD_OUT=/tmp/sld_cap \
SLD_AGENTS=hook_redirect_trust.js \
SLD_AGENTS2=hook_netflow.js \
python3 -u run_hook.py spawn 60
```

例（全量 IL2CPP dump）：

```bash
SLD_DUMP=/tmp/il2cpp_dump.cs python3 -u run_dump.py
```

---

## 5. 坑（都踩过）

- **别用 `pgrep/pkill -f auto_hook`**：会匹配调用者自己。杀守护用启动时记录的 PID。
- 别挂 `Debug.LogException` / `System.Exception..ctor`，也别在热 getter（`JsonData.get_Item` 等）的
  `onLeave` 里解引用返回值 → 重入 / 空指针直接闪退。
- 探针自身的 `TypeError`（忘传回调）也能把游戏打挂；探针保持「只读入参」。
- 同一台设备同时只跑一个 spawn 守护，避免互杀。
- 改 smali 时别用 `open(p,'w').write(f(text))`：`'w'` **先截断**，`f()` 抛异常就把文件写成 0 字节。
  先算好新内容再写临时文件 + `os.replace()`（详见 [`README-注入器gadget.md`](README-注入器gadget.md) §4.1）。

---

## 6. 抓完怎么用

- **Lua chunk 明文** → 对照 `res/phone/luaplain/` 里 `toLua/Data/<hash>` 定位逻辑、还原 S2C 字段。
- **`net-*.bin`** → 对照假服 `data/capture/` 里同时刻的收发，一起推 `framing` / msgId / protobuf。
- **IL2CPP dump** → 拿类名 / RVA 写新 hook，或补协议构造（见 [`README-待补功能.md`](README-待补功能.md)）。
