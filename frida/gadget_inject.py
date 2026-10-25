#!/usr/bin/env python3
"""把落在目标包解包目录里的 frida-gadget(libTool.so) 注入目标进程.

前提: gadget 本体 + libTool.config.so 已由 root 铺到 <pkg>/lib/arm64/ , 例如

  /data/app/com.bilibili.gcg2.bili-XXXX==/lib/arm64/libTool.so
  /data/app/com.bilibili.gcg2.bili-XXXX==/lib/arm64/libTool.config.so

本脚本只做一件事: 让目标进程 dlopen 它. 之后 gadget 按自己的 config(listen/script)干活,
与 frida-server 无关.

两条踩过的坑, 别改回去:
- 不用 frida spawn: 它在 MIUI 上解析 launcher 会超时, 把进程停在 zygote 里占住 pid.
  所以用 root 的 am start 正常拉起, 再 attach 已运行的进程.
- dlopen 会卡住不返回: gadget 的 constructor 就在调用它的 JS 线程上跑, 而同一个进程里
  已经有 frida-agent 的 Gum, 等于两个 Gum 核. 因此这里"投后即走", 到点 os._exit 硬断
  (实测: 硬断后 gadget 独立存活; 优雅 detach 反而会让 agent 代码在未映射处继续跑 -> SIGSEGV).
  成不成不看返回值, 用 root 通道看 maps / 27043 / logcat.

  python3 frida/gadget_inject.py com.bilibili.gcg2.bili \\
      /data/app/com.bilibili.gcg2.bili-PXiFLH_LSwZQBdKlOI08_Q==/lib/arm64/libTool.so
"""
import sys
import threading
import time

import frida

REMOTE = "23.147.232.29:27049"   # 手机 frida-server, 经 frpc 暴露

JS = r"""
var p = PROMISE_PATH;
Module.load(p);          // 正常情况下这行不会返回, 是预期的
send('dlopen 返回了: ' + p);
""".replace("PROMISE_PATH", "%r")


def find(dev, pkg):
    """Android 上 frida 的 process.name 是应用标签(如"双生视界"), 包名要靠 applications.identifier."""
    for a in dev.enumerate_applications():
        if a.identifier == pkg and a.pid:
            return a.pid
    for p in dev.enumerate_processes():
        if p.name == pkg or (len(p.name) > 6 and (p.name in pkg or pkg in p.name)):
            return p.pid
    return None


def main():
    pkg, path = sys.argv[1], sys.argv[2]
    hold = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0

    dev = frida.get_device_manager().add_remote_device(REMOTE)
    pid = int(pkg) if pkg.isdigit() else find(dev, pkg)
    if pid is None:
        sys.exit("目标进程没在跑: %s (先 am start 或桌面点开)" % pkg)
    print("attach %s pid=%d" % (pkg, pid))

    sess = dev.attach(pid)
    sc = sess.create_script(JS % path)
    sc.on("message", lambda m, d: print("  msg:", m))
    threading.Thread(target=sc.load, daemon=True).start()

    time.sleep(hold)
    print("硬断 frida 会话(agent 消失, gadget 留在进程里); 请用 root 通道核对:")
    print("  grep -c libTool /proc/%d/maps   |  netstat -ltn | grep 2704  |  logcat | grep gadget" % pid)
    sys.stdout.flush()
    import os
    os._exit(0)


main()
