#!/usr/bin/env python3
"""toLua / fightLua AssetBundle 加密探针.

三个子命令:
  groups   统计密文头部前缀分组 (同一批打包的文件共享一个前缀/密钥)
  crib     用 UnityFS 明文头做已知明文, 推出每组 keystream 并检查周期性
  decrypt  用候选 key + 算法试着解密, 命中 "UnityFS\\0" 即成功, 可导出给 UnityPy

用法示例:
  python3 lua_probe.py groups   --manifest /home/qkzx/sld/sld/assets/toLua/toluaLoader
  python3 lua_probe.py crib     --manifest /home/qkzx/sld/sld/assets/toLua/toluaLoader -n 8
  python3 lua_probe.py decrypt  --manifest /home/qkzx/sld/sld/assets/toLua/toluaLoader \\
             --key 00112233 --algo rc4 --out /home/qkzx/sld/sld/plain_lua
"""
import argparse
import collections
import hashlib
import io
import os
import struct
import sys
import zipfile

APK = "/home/qkzx/sld_1.0.6.1338_20230926_061320_5fb48.apk"
HEADER_LEN = 64
# UnityFS 头部已知明文字节 (版本 8 / Unity 2021.3): 见 README 的字段表
CRIB = b"UnityFS\x00" + struct.pack(">I", 8) + b"5.x.x\x00" + b"2021.3.18f1\x00"


# ---------------------------------------------------------------- utilities
def rc4(key: bytes, nbytes: int, drop: int = 0) -> bytes:
    s = list(range(256))
    j = 0
    klen = len(key)
    for i in range(256):
        j = (j + s[i] + key[i % klen]) & 0xFF
        s[i], s[j] = s[j], s[i]
    out = bytearray()
    i = j = 0
    for _ in range(nbytes + drop):
        i = (i + 1) & 0xFF
        j = (j + s[i]) & 0xFF
        s[i], s[j] = s[j], s[i]
        out.append(s[(s[i] + s[j]) & 0xFF])
    return bytes(out[drop:])


def keystream(algo: str, key: bytes, nbytes: int, drop: int = 0) -> bytes:
    if algo == "xor":
        return (key * (nbytes // len(key) + 1))[:nbytes]
    if algo == "md5":
        raw = hashlib.md5(key).digest()
        return (raw * (nbytes // len(raw) + 1))[:nbytes]
    if algo == "rc4":
        return rc4(key, nbytes, drop)
    raise SystemExit("unknown algo " + algo)


def xor(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


def load_names(manifest_path: str) -> list:
    with open(manifest_path, "r", encoding="utf-8", errors="replace") as f:
        return [line.strip() for line in f if line.strip()]


def open_apk(path: str) -> zipfile.ZipFile:
    if not os.path.exists(path):
        raise SystemExit("APK 不存在: " + path)
    return zipfile.ZipFile(path)


def arc_for(name: str, basedir: str) -> str:
    return "assets/" + basedir.strip("/") + "/" + name


# ------------------------------------------------------------------ groups
def cmd_groups(args):
    z = open_apk(args.apk)
    names = load_names(args.manifest)
    groups = collections.Counter()
    samples = collections.defaultdict(list)
    hit = 0
    for n in names:
        try:
            head = z.read(arc_for(n, args.basedir))[: args.width]
        except KeyError:
            continue
        hit += 1
        bucket = head[: args.bucket].hex()
        groups[bucket] += 1
        if len(samples[bucket]) < args.show:
            samples[bucket].append(n)
    print("清单条目 %d, 命中 %d, 前 %d 字节分组数 %d" % (len(names), hit, args.bucket, len(groups)))
    for k, v in groups.most_common(args.top):
        print("  %-16s %5d   e.g. %s" % (k, v, ", ".join(samples[k][:2])))
    if not groups:
        return 1
    biggest = groups.most_common(1)[0]
    print("最大组占 %.1f%%" % (100.0 * biggest[1] / max(hit, 1)))
    return 0


# -------------------------------------------------------------------- crib
def cmd_crib(args):
    """每组取一个样本, 用 UnityFS 明文 crib 反推 keystream, 检查是否低周期重复."""
    z = open_apk(args.apk)
    names = load_names(args.manifest)
    seen = {}
    for n in names:
        try:
            head = z.read(arc_for(n, args.basedir))[: HEADER_LEN]
        except KeyError:
            continue
        seen.setdefault(head[: args.bucket].hex(), (n, head))
        if len(seen) >= args.n:
            break
    width = len(CRIB)
    for bucket, (n, head) in seen.items():
        ks = xor(head[:width], CRIB[:width])
        period = None
        for p in range(1, 17):
            if all(ks[i] == ks[i % p] for i in range(width)):
                period = p
                break
        # 组内是否共享同一 keystream: 找另一个同组文件比对
        print("%s  %s" % (bucket, n))
        print("  keystream[:%d] = %s" % (width, ks.hex()))
        print("  重复周期 = %s" % ("未知(非短周期, 疑似流/分组密码)" if period is None else period))
        if period is None:
            zeros = sum(1 for b in ks if b == 0)
            print("  零字节 %d/%d, 熵判定: %s" % (zeros, width, "密文" if zeros < 4 else "含明文残留"))
    return 0


# ----------------------------------------------------------------- decrypt
def cmd_decrypt(args):
    z = open_apk(args.apk)
    key = bytes.fromhex(args.key) if args.key else args.key.encode()
    names = load_names(args.manifest)
    targets = [t.strip() for t in args.files.split(",") if t.strip()] if args.files else names
    ok = bad = 0
    for n in targets:
        try:
            blob = z.read(arc_for(n, args.basedir))
        except KeyError:
            continue
        # 先用 64 字节头部筛, 命中才对整文件生成密钥流 (大文件 RC4 很贵)
        head_ks = keystream(args.algo, key, len(CRIB), args.drop)
        plain = xor(blob[:len(head_ks)], head_ks)
        if not plain.startswith(b"UnityFS"):
            bad += 1
            if args.verbose and bad <= 3:
                print("  miss %-40s -> %s" % (n, plain[:12].hex()))
            continue
        plain = xor(blob, keystream(args.algo, key, len(blob), args.drop))
        ok += 1
        if args.out:
            os.makedirs(args.out, exist_ok=True)
            with open(os.path.join(args.out, n), "wb") as f:
                f.write(plain)
        try:
            import UnityPy
            env = UnityPy.load(io.BytesIO(plain))
            types = collections.Counter(o.type.name for o in env.objects)
            print("  OK  %-40s %s" % (n, dict(types)))
        except Exception as e:
            print("  OK? %-40s (UnityPy: %s)" % (n, e))
        if ok >= 4 and not args.out:
            break
    print("命中 %d / 未命中 %d  (algo=%s key=%s drop=%d)" % (ok, bad, args.algo, args.key, args.drop))
    if ok == 0:
        print("=> 该 key/算法不成立。真实密钥需要从运行时取: frida hook "
              "lua_load / AssetBundle.LoadFromMemory, 见 README 第 6 节。")
    return 0 if ok else 1


# -------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apk", default=APK)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--manifest", required=True, help="toluaLoader / fightluaLoader 的本地解出路径")
        p.add_argument("--basedir", default="toLua/Data", help="APK 内目录, 如 toLua/Data 或 fightLua/Data")

    p = sub.add_parser("groups")
    common(p)
    p.add_argument("--bucket", type=int, default=4, help="按前 N 字节分组")
    p.add_argument("--width", type=int, default=HEADER_LEN)
    p.add_argument("--top", type=int, default=15)
    p.add_argument("--show", type=int, default=2)
    p.set_defaults(fn=cmd_groups)

    p = sub.add_parser("crib")
    common(p)
    p.add_argument("--bucket", type=int, default=4)
    p.add_argument("-n", type=int, default=8, help="抽样组数")
    p.set_defaults(fn=cmd_crib)

    p = sub.add_parser("decrypt")
    common(p)
    p.add_argument("--key", required=True)
    p.add_argument("--algo", choices=["xor", "md5", "rc4"], default="rc4")
    p.add_argument("--drop", type=int, default=0)
    p.add_argument("--files", help="逗号分隔, 默认全量")
    p.add_argument("--out", help="解密输出目录")
    p.add_argument("-v", "--verbose", action="store_true")
    p.set_defaults(fn=cmd_decrypt)

    args = ap.parse_args()
    sys.exit(args.fn(args))


if __name__ == "__main__":
    main()
