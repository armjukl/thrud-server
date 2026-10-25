#!/usr/bin/env python3
"""把 APK 里的资源解到本地目录(人工核对/取用), 不参与假服运行.

顺带产出两张表:
  manifest.json  逻辑名 -> 哈希文件名 -> md5(kvl.kvl 里的校验值) -> 大小
  names/         逻辑名.ab 的副本, 让人不看哈希也能定位资源

toLua/fightLua 的 .ab 仍是密文(密钥待运行时提取), 这里照常导出但会在日志里标注.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APK = os.environ.get("SLD_APK", os.path.join(HERE, "..", "res", "apk", "sld_1.0.7.1426_bilibili.apk"))
OUT = os.environ.get("SLD_WWW", os.path.join(HERE, "data", "www"))
LUA_DIRS = ("toLua/", "fightLua/")


def load_kvl(zf):
    """kvl.kvl: '<path> : <md5(存储字节)> : System.String ; ...' + 头部版本号"""
    raw = zf.read("assets/kvl.kvl").decode("utf-8", "replace")
    ver = re.search(r"ResVersion : (\d+).*?BuildVersion : (\d+)", raw, re.S)
    entries = re.findall(r"([^:;]+) : ([0-9a-f]{32}) : System\.String", raw)
    return {p.strip(): h for p, h in entries}, (int(ver.group(1)), int(ver.group(2))) if ver else (0, 0)


def load_names(zf):
    try:
        data = json.loads(zf.read("assets/res/abIndex.json"))
    except KeyError:
        return {}
    return {e["mAbName"]: e["mOriginName"] for e in data.get("mAbList", []) if "mAbName" in e}


def resolve(arc, names_in_apk):
    for cand in (arc, arc + ".ab"):
        if cand in names_in_apk:
            return cand
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", default=APK)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--only", default="", help="只解这些前缀, 逗号分隔, 如 res/data,toLua")
    ap.add_argument("--names", action="store_true", help="额外按逻辑名复制一份")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.apk):
        sys.exit("APK 不存在: " + args.apk)
    zf = zipfile.ZipFile(args.apk)
    members = set(zf.namelist())
    kvl, (res_ver, build_ver) = load_kvl(zf)
    origins = load_names(zf)
    filters = tuple(f.strip() for f in args.only.split(",") if f.strip())

    total = skipped = encrypted = 0
    nbytes = 0
    manifest = {}
    if not args.dry_run:
        os.makedirs(args.out, exist_ok=True)
    for path, md5 in sorted(kvl.items()):
        if filters and not path.startswith(filters):
            skipped += 1
            continue
        arc = resolve("assets/" + path, members)
        if arc is None:
            skipped += 1
            continue
        info = zf.getinfo(arc)
        total += 1
        nbytes += info.file_size
        enc = any(path.startswith(d) for d in LUA_DIRS)
        encrypted += 1 if enc else 0
        manifest[path] = {
            "origin": origins.get(os.path.basename(path).replace(".ab", "")),
            "md5_stored": md5,
            "size": info.file_size,
            "encrypted": bool(enc),
        }
        if args.dry_run:
            continue
        dst = os.path.join(args.out, path)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with zf.open(arc) as src, open(dst, "wb") as out:
            shutil.copyfileobj(src, out)
        if args.names and manifest[path]["origin"] and not enc:
            ndir = os.path.join(args.out, "names")
            os.makedirs(ndir, exist_ok=True)
            shutil.copyfile(dst, os.path.join(ndir, manifest[path]["origin"] + ".ab"))

    if not args.dry_run:
        with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({"resVersion": res_ver, "buildVersion": build_ver, "files": manifest}, f, ensure_ascii=False, indent=1)
        md5check = 0
        for path in list(manifest)[:50]:
            arc = resolve("assets/" + path, members)
            if arc and hashlib.md5(zf.read(arc)).hexdigest() == manifest[path]["md5_stored"]:
                md5check += 1
        print("抽检 md5 与 kvl 一致: %d/50 (说明字段2 是存储字节的校验值)" % md5check)
    print("可解 %d 个文件 / %.1f MiB, 其中密文(Lua) %d, 跳过 %d%s"
          % (total, nbytes / 1048576, encrypted, skipped, " [dry-run]" if args.dry_run else ""))
    print("输出 %s" % args.out)


if __name__ == "__main__":
    main()
