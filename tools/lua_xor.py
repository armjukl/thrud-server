#!/usr/bin/env python3
"""sld 的 toLua/fightLua chunk 加解密器。

保护方案(实测):整个文件逐字节 XOR 固定 8 字节 key `89 67 45 23 01 ef cd ab`,
从偏移 0 开始循环,无头部、无长度字段、无 per-file 派生。
证据:505 个按文件大小唯一配对的明文(Frida 抓的 889 个 .bin)与 APK 密文相减,
482 个 toLua 文件全长命中同一 key;往返 加密->解密 逐字节一致。

用法:
  lua_xor.py dec <in> [out]     # APK 里的 assets/toLua/Data/<hash> -> 明文 Lua
  lua_xor.py enc <in> [out]     # 改好的明文 -> 可以塞回 APK 的密文
  lua_xor.py probe <in>         # 只判断当前是明文还是密文
"""
import sys

KEY = bytes.fromhex('8967452301efcdab')


def xor(data: bytes) -> bytes:
    return bytes(b ^ KEY[i % 8] for i, b in enumerate(data))


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    mode, src = sys.argv[1], sys.argv[2]
    dst = sys.argv[3] if len(sys.argv) > 3 else None
    data = open(src, 'rb').read()

    if mode == 'probe':
        head = data[:8]
        if head[:4] in (b'\x1bLua', b'-- [') or data[:2] in (b'--', b'lo', b'if', b'pa', b're'):
            print('明文 Lua')
            return 0
        if xor(data[:8]).startswith((b'--', b'\x1bLua', b'local', b'require', b'function')):
            print('密文(XOR 8 字节 key 可解)')
            return 0
        print('未知: 头 8=%s 解出=%r' % (head.hex(), xor(head)))
        return 1

    if mode not in ('enc', 'dec'):
        print(__doc__)
        return 2
    out = xor(data)
    if dst:
        open(dst, 'wb').write(out)
        print('%s -> %s  %d B' % (src, dst, len(out)))
    else:
        sys.stdout.buffer.write(out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
