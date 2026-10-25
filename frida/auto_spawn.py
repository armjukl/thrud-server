#!/usr/bin/env python3
"""auto_spawn.py —— 斯露德自动 hook 守护进程.

作用: 不用再手动跑 run_hook.py。守护进程会
  1) 轮询设备上的游戏进程;
  2) 发现游戏是手动启动的 / 不是我们挂的 -> kill 掉, 用 frida spawn 重新拉起;
  3) 每次拉起都自动挂上 hook 脚本 (SLD_AGENTS + SLD_AGENTS2);
  4) 游戏崩溃 / 退出后自动重开, 保证 hook 一直在.

环境变量:
  SLD_FRIDA          远端 frida server (默认 23.147.232.29:27049)
  SLD_AGENTS         spawn 阶段就要挂的脚本 (逗号分隔, 支持绝对路径)
  SLD_AGENTS2        resume 之后 DELAY2 秒再挂的脚本
  SLD_DELAY2         默认 14
  SLD_AUTO_KILL_MANUAL  1=发现手动启动的游戏就杀掉重开 (默认 1)
  SLD_AUTO_RESTART_MAX  连续重启上限, 超过就停 (默认 200)
  SLD_AUTO_LOG       日志文件 (默认 /home/qkzx/sld/probe-tmp/auto_spawn.log)

用法:
  SLD_AGENTS=hook_redirect_trust.js SLD_AGENTS2=... setsid nohup python3 auto_spawn.py > /home/qkzx/sld/probe-tmp/auto_spawn.out 2>&1 &
"""
import datetime
import json
import os
import signal
import sys
import threading
import time

import frida

REMOTE = os.environ.get("SLD_FRIDA", "23.147.232.29:27049")
PKG = "com.wth.thrud.bilibili"
HERE = os.path.dirname(os.path.abspath(__file__))
AGENTS = [a for a in (os.environ.get("SLD_AGENTS") or "").split(",") if a]
AGENTS2 = [a for a in (os.environ.get("SLD_AGENTS2") or "").split(",") if a]
DELAY2 = float(os.environ.get("SLD_DELAY2", "14"))
KILL_MANUAL = os.environ.get("SLD_AUTO_KILL_MANUAL", "1") != "0"
RESTART_MAX = int(os.environ.get("SLD_AUTO_RESTART_MAX", "200"))
LOGFILE = os.environ.get("SLD_AUTO_LOG", "/home/qkzx/sld/probe-tmp/auto_spawn.log")

_lock = threading.Lock()
_stop = False


def log(msg):
    line = "%s %s" % (datetime.datetime.now().strftime("%H:%M:%S"), msg)
    with _lock:
        print(line, flush=True)
        try:
            os.makedirs(os.path.dirname(LOGFILE), exist_ok=True)
            with open(LOGFILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass


def read_agent(path):
    full = path if os.path.isabs(path) else os.path.join(HERE, path)
    with open(full, "r", encoding="utf-8") as f:
        return f.read()


def join_agents(paths):
    return "\n;\n".join(read_agent(a) for a in paths)


def find_game(dev):
    for p in dev.enumerate_processes():
        name = p.name or ""
        ident = getattr(p, "identifier", None)
        if name == "斯露德" or ident == PKG or "thrud" in name.lower():
            return p.pid
    return None


def on_signal(signum, frame):
    global _stop
    log("[signal] %s -> 退出" % signum)
    _stop = True


def run_once(dev, code, code2):
    """spawn + attach + 挂 hooks, 阻塞到进程结束. 返回 True 表示需要重开."""
    pid = dev.spawn([PKG])
    log("[spawn] %s pid=%s" % (PKG, pid))
    session = dev.attach(pid)
    state = {"done": False, "reason": "unknown"}

    def on_detached(reason, crash=None):
        state["done"] = True
        state["reason"] = "%s%s" % (reason, "" if not crash else " " + str(crash))
        log("[detached] pid=%s reason=%s" % (pid, state["reason"]))

    session.on("detached", on_detached)

    script = session.create_script(code)

    def on_msg(msg, data):
        if msg.get("type") == "error":
            log("[agent-error] " + str(msg.get("description")))
            return
        if msg.get("type") == "send":
            p = msg.get("payload")
            if not isinstance(p, dict):
                log("[msg] " + str(p)[:400])
                return
            if p.get("ev") in ("lua", "net"):
                return
            log("[ev] " + json.dumps(p, ensure_ascii=False)[:400])
        else:
            log("[log] " + str(msg.get("payload"))[:400])

    script.on("message", on_msg)
    script.load()
    dev.resume(pid)
    log("[resume] pid=%s 开始运行" % pid)

    timer = None
    if code2:
        def arm2():
            if state["done"]:
                return
            try:
                s2 = session.create_script(code2)
                s2.on("message", on_msg)
                s2.load()
                log("[agent2] +%ss 已挂载" % DELAY2)
            except Exception as e:  # noqa: BLE001
                log("[agent2-err] %s" % e)

        timer = threading.Timer(DELAY2, arm2)
        timer.daemon = True
        timer.start()

    # 等待进程结束 (物理断开或进程消失)
    while not state["done"] and not _stop:
        time.sleep(1)
        try:
            if find_game(dev) != pid:
                state["done"] = True
                state["reason"] = "process-gone"
        except Exception:
            pass

    if timer:
        timer.cancel()
    # 远程会话的 detach 会在隧道上永久阻塞, 丢给后台线程即可: 进程已死, 这个会话没有价值
    try:
        t = threading.Thread(target=session.detach, daemon=True)
        t.start()
        t.join(3)
    except Exception:
        pass
    return not _stop


def main():
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    code = join_agents(AGENTS) if AGENTS else ""
    code2 = join_agents(AGENTS2) if AGENTS2 else ""
    log("[boot] remote=%s agents=%s agents2=%s delay2=%s kill_manual=%s"
        % (REMOTE, AGENTS, AGENTS2, DELAY2, KILL_MANUAL))
    if not code and not code2:
        log("[boot] 警告: 没有配置任何 hook 脚本 (SLD_AGENTS/SLD_AGENTS2)")

    restarts = 0
    while not _stop and restarts < RESTART_MAX:
        try:
            dev = frida.get_device_manager().add_remote_device(REMOTE)
        except Exception as e:  # noqa: BLE001
            log("[conn-err] %s -> 5s 后重试" % e)
            time.sleep(5)
            continue

        # 手动启动的游戏: 杀掉, 交给 frida spawn
        try:
            pid = find_game(dev)
        except Exception as e:  # noqa: BLE001
            log("[enum-err] %s" % e)
            pid = None
        if pid and KILL_MANUAL:
            log("[manual] 发现游戏 pid=%s 未挂 hook -> kill" % pid)
            try:
                dev.kill(pid)
            except Exception as e:  # noqa: BLE001
                log("[kill-err] %s" % e)
            time.sleep(2)

        restarts += 1
        try:
            run_once(dev, code, code2)
        except Exception as e:  # noqa: BLE001
            log("[run-err] %s" % e)
        if _stop:
            break
        log("[restart] 第 %s 次重开, 3s 后..." % restarts)
        time.sleep(3)

    log("[exit] 守护结束 (restarts=%s stop=%s)" % (restarts, _stop))
    return 0


if __name__ == "__main__":
    sys.exit(main())
