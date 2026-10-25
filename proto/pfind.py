#!/usr/bin/env python3
"""在恢复出的 proto 源里查 message 定义 / 在 CmdDefine 里查 msgId。
用法: pfind.py GetSignReward_S2C [...]      # 打印 message 体
      pfind.py -id GetSignReward            # 按名字模糊查 msgId
      pfind.py -msg 10051                   # 按 msgId 查名字
"""
import re, sys, os

D = os.path.dirname(os.path.abspath(__file__))


def msgs():
    out = {}
    for fn in sorted(os.listdir(D)):
        if not fn.endswith('.proto'):
            continue
        txt = open(os.path.join(D, fn)).read()
        for m in re.finditer(r'message\s+([A-Za-z0-9_]+)\s*\{', txt):
            name = m.group(1)
            i = m.end()
            depth = 1
            while i < len(txt) and depth:
                if txt[i] == '{':
                    depth += 1
                elif txt[i] == '}':
                    depth -= 1
                i += 1
            out.setdefault(name, []).append((fn, txt[m.end():i - 1].strip()))
    return out


def cmdlines():
    p = os.path.join(D, 'CmdDefine.proto')
    out = {}
    if not os.path.exists(p):
        return out
    for m in re.finditer(r'([A-Za-z0-9_]+)\s*=\s*(\d+)\s*;?\s*(//.*)?', open(p).read()):
        if m.group(2):
            out[int(m.group(2))] = (m.group(1), (m.group(3) or '').strip())
    return out


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return
    M = msgs()
    if a[0] == '-id':
        for num, (n, c) in sorted(cmdlines().items()):
            if a[1].lower() in n.lower():
                print('%-8d %-40s %s' % (num, n, c))
        return
    if a[0] == '-msg':
        n, c = cmdlines().get(int(a[1]), ('?', ''))
        print('%s  %s' % (n, c))
        for f, body in M.get(n, []) + M.get(n + '_S2C', []):
            print('--- %s (%s)\n%s' % (n, f, body))
        return
    for name in a:
        hits = M.get(name)
        if not hits:
            like = [k for k in M if name.lower() in k.lower()]
            print('### %s 未找到; 相近: %s' % (name, ', '.join(like[:12])))
            continue
        for f, body in hits:
            print('### %s  (%s)' % (name, f))
            print(re.sub(r'\n\s*\n+', '\n', body))


main()
