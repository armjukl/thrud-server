#!/usr/bin/env python3
"""sld(Thrud) global-metadata.dat 解密器 —— 直接吃 APK 里那个原文件。

保护方案(逐页比对 APK 原文与结果还原出来的, 已实测):

1. 文件头前 8 字节( Il2CppMetadataHeader 的 magic + version )被换成假值,
   不参与任何真解密 —— 直接写回 magic=0xFAB11BAF / version=29 即可。
2. 页 0 的 [8, 0x1000) 段, 以及页号 % 16 ∈ {1,2,3,4} 的整页, 逐字节 XOR 0x66。
   其余全部明文(包括页 16/32/48 … 这些 % 16 == 0 的页)。

注:APK 里页 1..4 的内容本身就是被清零的填充页, 解出来仍是残渣,
所以整份 metadata 的**有效内容全部在页 0 和页 5..15**, 而页 0 的头部偏移表
需要按第 1 条补回来才能被 Il2CppDumper 之类工具读。

用法:
  meta_decrypt.py <in.dat> <out.dat> [--version N]
  meta_decrypt.py <in.dat> --check             # 只解密校验并打印头部信息
"""
import struct
import sys

XOR = 0x66
PAGE = 0x1000
MAGIC = 0xFAB11BAF


def encrypted_page(idx: int) -> bool:
    return idx == 0 or idx % 16 in (1, 2, 3, 4)


def decrypt(data: bytes, version: int = 29) -> bytearray:
    out = bytearray(data)
    struct.pack_into('<II', out, 0, MAGIC, version)
    for j in range(8, min(PAGE, len(out))):
        out[j] ^= XOR
    for i in range(1, len(out) // PAGE):
        if i % 16 not in (1, 2, 3, 4):
            continue
        start = i * PAGE
        end = min((i + 1) * PAGE, len(out))
        for j in range(start, end):
            out[j] ^= XOR
    return out


def describe(out: bytes) -> int:
    magic, version = struct.unpack_from('<II', out, 0)
    if magic != MAGIC:
        print('magic 不对: %08X (期望 FAB11BAF)' % magic)
        return 1
    fields = ['stringLiteral', 'stringLiteralData', 'string', 'events', 'properties', 'methods']
    print('metadata version =', version, ' size =', len(out))
    prev_end = None
    for i, name in enumerate(fields):
        off, size = struct.unpack_from('<II', out, 8 + 8 * i)
        flag = '' if prev_end is None or off >= prev_end else '  <-- 重叠'
        print('  %-18s off=%-9d size=%-9d%s' % (name, off, size, flag))
        prev_end = off + size
    sample = out[struct.unpack_from('<I', out, 8 + 4)[0]:][:32]
    print('  string 区样本:', sample)
    return 0


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    version = 29
    for a in sys.argv[1:]:
        if a.startswith('--version'):
            version = int(a.split('=', 1)[1]) if '=' in a else version
    if len(args) < 1:
        print(__doc__)
        return 2
    src = args[0]
    data = open(src, 'rb').read()
    out = decrypt(data, version)
    if len(args) == 1 or args[1] == '--check':
        return describe(bytes(out))
    open(args[1], 'wb').write(out)
    print('written', args[1], len(out))
    return describe(bytes(out))


if __name__ == '__main__':
    sys.exit(main())
