#!/usr/bin/env python3
"""sld(Thrud) global-metadata.dat 逐页 XOR key 还原器。

实测出的保护方案(2 层):

1. 头 8 字节(magic + version)被换成假值 —— 直接写回 0xFAB11BAF / 29。
2. 每 16 个 4KiB 页为一组,**只有组内第 1..4 页被加密**,加密方式是
   **整页单字节 XOR**,而且 key 是按组变的(group1=0x66、group2..6=0x46 …),
   不是原先以为的"恒定 0x66"。页 0 的 [8, 0x1000) 段也按组 0 的 key 走。
   组 0 的第 1..4 页(即文件偏移 0x1000..0x5000)单字节解不出来,是另一层密钥,
   落在 stringLiteral 表里 —— 这就是 Il2CppDumper 死在 Il2Cpp.Init 的直接原因。

key 靠统计猜:根据头表算出每页落在哪个区(表区/字符串区),用不同的打分函数,
表区看 "4 字节对齐的高位是否为 0",字符串区看 "可打印 + NUL 占比"。

用法:
  meta_keyhunt.py <global-metadata.dat> [out.dat]
  meta_keyhunt.py <global-metadata.dat> --report     # 只打印每组的 key 与命中情况
"""
import collections
import struct
import sys

PAGE = 0x1000
MAGIC = 0xFAB11BAF
VERSION = 29
N = 5  # 前 4 个头字段不够, 多读几个以便定位 string/stringLiteralData 区间
PRINTABLE = set(range(0x20, 0x7F)) | {0x00, 0x09, 0x0A, 0x0D}
IDENT = PRINTABLE | {0x5F, 0x24, 0x2E, 0x3C, 0x3E, 0x60}


FIELD_NAMES = ['stringLiteral', 'stringLiteralData', 'string', 'events', 'properties',
               'methods', 'mrTypes', 'typeDefinitions', 'methodDefinitions']
STR_FIELDS = {'stringLiteralData', 'string'}


def regions(data: bytes):
    """按头表算出 [(start, end, kind)],kind in {'str','table'}。"""
    spans = []
    for i, name in enumerate(FIELD_NAMES):
        if 8 + 8 * i + 8 > len(data):
            break
        off, size = struct.unpack_from('<II', data, 8 + 8 * i)
        if size and off + size <= len(data) and off >= 8 + 8 * len(FIELD_NAMES):
            spans.append((off, off + size, 'str' if name in STR_FIELDS else 'table'))
    spans.sort()
    return spans


def kind_at(rgs, page_start: int) -> str:
    hits = {k for s, e, k in rgs if s <= page_start < e}
    return 'str' if 'str' in hits else 'table'


def page_key(buf: bytes, kind: str) -> int:
    h = collections.Counter(buf)
    if kind == 'str':
        score = lambda k: sum(h[v] for v in h if v ^ k in IDENT)  # noqa: E731
    else:
        # 表区: 指针/长度字段的高位字节通常是 0x00, 按 4 字节槽位的第 3、7 字节加权
        tail = collections.Counter(buf[j] for j in range(3, len(buf), 4))
        score = lambda k: tail[k] * 4 + sum(h[v] for v in h if v ^ k in PRINTABLE) // 4  # noqa: E731
    return max(range(256), key=score), score


def header_ok(hdr: bytes, total: int) -> int:
    """头表自洽度:字段偏移严格递增且落在文件内的个数。"""
    prev, score = 8 + 8 * len(FIELD_NAMES), 0
    for i in range(len(FIELD_NAMES)):
        off, size = struct.unpack_from('<II', hdr, 8 + 8 * i)
        if off >= prev and size and off + size <= total:
            score += 1
            prev = off + size
        else:
            break
    return score


def page0_key(buf: bytes, total: int) -> int:
    """页 0 的 key:整页 256 个候选里选头表最自洽的那个。"""
    best = (-1, 0)
    for k in range(256):
        hdr = bytes(x ^ k for x in buf)
        hdr = b'\x00' * 8 + hdr[8:]  # 前 8 字节是假 magic/version, 不参与判断
        score = header_ok(hdr, total)
        if score > best[0]:
            best = (score, k)
    return best[1]


def hunt(data: bytes):
    out = bytearray(data)
    keys, failed = {}, []
    k0 = page0_key(bytes(out[:PAGE]), len(out))
    if header_ok(bytes(x ^ k0 for x in out[:8]) + bytes(x ^ k0 for x in out[8:PAGE]), len(out)) < 6:
        k0 = 0x66  # 兜底: 实测值
    out[:PAGE] = bytes(x ^ k0 for x in out[:PAGE])
    struct.pack_into('<II', out, 0, MAGIC, VERSION)  # 头 8 字节是假值, 直接写回
    keys[0] = k0
    rgs = regions(bytes(out))
    for i in range(1, len(out) // PAGE):
        if i % 16 not in (1, 2, 3, 4):
            keys[i] = 0
            continue
        buf = bytes(out[i * PAGE:(i + 1) * PAGE])
        kind = kind_at(rgs, i * PAGE)
        k, score = page_key(buf, kind)
        keys[i] = k
        hit = score(k) / len(buf)
        if hit < 0.55:
            failed.append((i, k, round(hit, 3), kind))
        out[i * PAGE:(i + 1) * PAGE] = bytes(x ^ k for x in buf)
    return bytes(out), keys, rgs, failed


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        print(__doc__)
        return 2
    data = open(args[0], 'rb').read()
    out, keys, rgs, failed = hunt(data)
    print('区间表:', [(s, e - s, k) for s, e, k in rgs][:6])
    bygroup = collections.defaultdict(collections.Counter)
    for i, k in keys.items():
        if k:
            bygroup[i // 16][k] += 1
    print('每组用到的 key(只列非 0):')
    for g in sorted(bygroup)[:24]:
        print('  group %-3d %s' % (g, dict(bygroup[g])))
    magic, version = struct.unpack_from('<II', out, 0)
    print('magic %08X version %d' % (magic, version))
    sample_at = struct.unpack_from('<II', out, 8 + 8 * 2)[0]  # string 区
    print('string 区样本:', out[sample_at:sample_at + 90])
    print('可疑未解页 (page, key, 命中率, 区):', failed[:12], '共', len(failed))
    if len(args) > 1:
        open(args[1], 'wb').write(out)
        print('written', args[1], len(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
