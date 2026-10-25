#!/usr/bin/env python3
"""驱动 hook_sld.js: spawn/attach 斯露德, 把 Lua 明文与 UDP 包落盘.

用法:
  python3 run_hook.py spawn  30   # 冷启动抓 30 秒
  python3 run_hook.py attach 30   # 附着当前进程抓 30 秒
"""
import frida, json, os, sys, time, datetime

REMOTE = os.environ.get("SLD_FRIDA", "23.147.232.29:27049")
PKG = "com.wth.thrud.bilibili"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get("SLD_OUT", os.path.join(HERE, "..", "..", "frida_dump"))
AGENT = os.environ.get("SLD_AGENT") or os.path.join(HERE, "hook_sld.js")
AGENTS = [a for a in (os.environ.get("SLD_AGENTS") or "").split(",") if a]
AGENTS2 = [a for a in (os.environ.get("SLD_AGENTS2") or "").split(",") if a]
DELAY2 = float(os.environ.get("SLD_DELAY2", "12"))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "attach"
    dur = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0
    outdir = os.path.abspath(OUT)
    os.makedirs(outdir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%m%d-%H%M%S")
    lua_dir = os.path.join(outdir, "lua-" + stamp)
    net_dir = os.path.join(outdir, "net-" + stamp)
    os.makedirs(lua_dir, exist_ok=True)
    os.makedirs(net_dir, exist_ok=True)

    dev = frida.get_device_manager().add_remote_device(REMOTE)
    if AGENTS:
        code = "\n;\n".join(open(os.path.join(HERE, a) if not os.path.isabs(a) else a, "r", encoding="utf-8").read() for a in AGENTS)
    else:
        code = open(AGENT, "r", encoding="utf-8").read()

    if mode == "spawn":
        pid = dev.spawn([PKG])
        print("[*] spawned", PKG, "pid", pid)
        session = dev.attach(pid)
        script = session.create_script(code)
        counters = {"lua": 0, "net": 0, "lua_bytes": 0, "net_bytes": 0}

        def on_msg(msg, data):
            if msg.get("type") == "error":
                print("[agent-error]", msg.get("description"))
                return
            if msg.get("type") != "send":
                print("[log]", msg.get("payload"))
                return
            p = msg.get("payload") or {}
            ev = p.get("ev")
            if ev == "lua":
                counters["lua"] += 1
                counters["lua_bytes"] += p.get("len", 0)
                name = "%05d-%s-%d.bin" % (counters["lua"], p.get("tag", "lua"), p.get("len", 0))
                with open(os.path.join(lua_dir, name), "wb") as f:
                    f.write(data or b"")
                if counters["lua"] <= 40 or counters["lua"] % 100 == 0:
                    print("[lua] %s head=%s" % (name, p.get("head")))
            elif ev == "net":
                counters["net"] += 1
                counters["net_bytes"] += p.get("len", 0)
                name = "%05d-%s-fd%s-%s.bin" % (counters["net"], p.get("tag", "net"), p.get("fd"), p.get("len", 0))
                with open(os.path.join(net_dir, name), "wb") as f:
                    f.write(data or b"")
                meta = {k: v for k, v in p.items() if k != "ev"}
                print("[net] %s %s" % (name, json.dumps(meta, ensure_ascii=False)))
            else:
                print("[ev]", json.dumps(p, ensure_ascii=False)[:300])

        script.on("message", on_msg)
        script.load()
        dev.resume(pid)
        print("[*] resumed, capturing %ss ..." % dur)
        if AGENTS2:
            time.sleep(DELAY2)
            code2 = "\n;\n".join(open(os.path.join(HERE, a) if not os.path.isabs(a) else a, "r", encoding="utf-8").read() for a in AGENTS2)
            script2 = session.create_script(code2)
            script2.on("message", on_msg)
            script2.load()
            print("[*] agent2 loaded at +%ss" % DELAY2)
            try:
                time.sleep(max(0, dur - DELAY2))
            except KeyboardInterrupt:
                pass
        else:
            try:
                time.sleep(dur)
            except KeyboardInterrupt:
                pass
        print("[*] stats:", json.dumps(counters))
        try:
            script.unload()
        except Exception:
            pass
        session.detach()
    else:
        target = None
        for p in dev.enumerate_processes():
            if p.name == "斯露德" or getattr(p,"identifier",None) == PKG or "thrud" in (p.name or "").lower():
                target = p.pid
        if not target:
            print("找不到游戏进程; 请先打开游戏, 或用 spawn 模式")
            return 1
        print("[*] attach pid", target)
        session = dev.attach(target)
        script = session.create_script(code)
        script.on("message", lambda m, d: print("[ev]", (m.get("payload") if m.get("type") != "error" else m.get("description"))))
        script.load()
        print("[*] capturing %ss ..." % dur)
        time.sleep(dur)

    print("[*] lua dumps ->", lua_dir)
    print("[*] net dumps ->", net_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
