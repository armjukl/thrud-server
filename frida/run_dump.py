#!/usr/bin/env python3
"""运行时 IL2CPP dump 驱动: 附着已跑的斯露德, 写出 dump.cs 风格文件."""
import frida, json, os, sys, time

REMOTE = os.environ.get("SLD_FRIDA", "23.147.232.29:27049")
OUT = os.environ.get("SLD_DUMP", "/home/qkzx/offline/sld/dump/il2cpp_runtime_dump.cs")
HERE = os.path.dirname(os.path.abspath(__file__))

dev = frida.get_device_manager().add_remote_device(REMOTE)
pid = None
for p in dev.enumerate_processes():
    if p.name == '斯露德':
        pid = p.pid
if not pid:
    pid = dev.spawn(["com.wth.thrud.bilibili"]); dev.resume(pid); time.sleep(12)
print("[*] attach", pid, flush=True)
sess = dev.attach(pid)
s = sess.create_script(open(os.path.join(HERE, "il2cpp_dump.js"), encoding="utf-8").read())

os.makedirs(os.path.dirname(OUT), exist_ok=True)
f = open(OUT, "w", encoding="utf-8")
counts = {"cls": 0, "m": 0, "f": 0}

def w(s):
    f.write(s + "\n")

def on(m, d):
    if m.get("type") == "error":
        print("[err]", m.get("description")[:200], flush=True); return
    p = m.get("payload") or {}
    ev = p.get("ev")
    if ev == "cls":
        counts["cls"] += 1
        counts["m"] += len(p["methods"]); counts["f"] += len(p["fields"])
        full = (p["ns"] + "." if p["ns"] else "") + p["name"]
        w("// image: %s  parent: %s" % (p["img"], p["parent"]))
        w("class %s {" % full)
        for mth in p["methods"]:
            w("    %s %s(%s); // rva %s" % (mth["r"], mth["n"], ", ".join(mth["p"]), mth["rva"]))
        for fld in p["fields"]:
            w("    %s %s; // off 0x%x" % (fld["t"], fld["n"], fld["o"]))
        w("}")
        w("")
    elif ev == "dump-done":
        print("[*] done classes", p["classes"], flush=True)
    elif ev in ("dump-err",):
        print("[dump-err]", p, flush=True)

s.on("message", on)
s.load()
time.sleep(90)
f.close()
print("[*] wrote", OUT, counts, flush=True)
