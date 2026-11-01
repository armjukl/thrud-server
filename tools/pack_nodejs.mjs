#!/usr/bin/env node
// 把 CJS 产物 + 运行必需的数据铺成 APK 的 assets 布局:
//
//   assets/code/<buildCode>/   <- dist-cjs/** + main.js + package.json(带 name, 让 findRoot 停在这)
//   assets/seed/               <- <DATA>/data/{save,header-rule,frame_prefix,skipapi,getclientupdatedata} + certs/
//   assets/code/manifest.json  <- Java 侧靠它挑 code 目录(buildCode)
//
// 铁律: 代码目录与数据目录彻底分开。code/ 允许 APK 更新整目录覆盖; seed/ 只在目标缺失时铺,
// 这条由 bootstrap.seedOnce 实现、selftest 断言。清单排除 logs/ capture/ *.bak *.tmp .seedver
// admin.token —— 把 PC 上的运行垃圾带进 APK, 轻则多几十 MB, 重则覆盖玩家存档。
//
//   node tools/pack_nodejs.mjs                       # 铺到 android/app/src/main/assets
//   node tools/pack_nodejs.mjs --out /home/tmp/androidsim/assets --check
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith("--") ? String(args[i + 1]) : dflt;
};
const flag = (name) => args.includes("--" + name);

const ASSETS = path.resolve(opt("out", path.join(ROOT, "android", "app", "src", "main", "assets")));
// --main 让同一套产物布局服务两种入口: 真壳用 android/main.js, 探针 APK 用 android/probe.js
const MAIN = path.resolve(opt("main", path.join(ROOT, "android", "main.js")));
/** 相对 DATA 的必需铺盘清单; 少一个就意味着假服起来缺东西 */
const SEED_FILES = ["data/save.json", "data/header-rule.json", "data/frame_prefix.txt", "data/skipapi.json", "data/getclientupdatedata.json"];
/** 永不进包: 运行时自己长出来的、上一版留下的、原子写的中间文件 */
const JUNK = /(^|\/)(logs|capture)(\/|$)|\.bak$|\.tmp$|\.seedver$|admin\.token$|save\.pre-admin\.|unknown-msgids\.json|global-metadata\.dat$/;

function buildCode() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  let sha = "dirty";
  try {
    sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim() || "dirty";
  } catch {
    /* 没 git 也能打包, 只是版本号写 dirty */
  }
  return opt("build-code", `${pkg.version}-g${sha}`);
}

/** 整目录拷, skip 命中的(按文件名判)不动; 返回拷了几个文件 */
function copyTree(src, dst, skip) {
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip.test(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) n += copyTree(from, to, skip);
    else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      n++;
    }
  }
  return n;
}

function treeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let sum = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    sum += e.isDirectory() ? treeBytes(p) : fs.statSync(p).size;
  }
  return sum;
}

/** 递归找出不该进包的文件(相对 base 的路径) */
function findJunk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findJunk(p, base));
    else if (JUNK.test(path.relative(base, p).replace(/\\/g, "/"))) out.push(path.relative(base, p));
  }
  return out;
}

const bc = buildCode();
const codeDir = path.join(ASSETS, "code", bc);
const seedDir = path.join(ASSETS, "seed");
const kb = (n) => `${Math.round(n / 1024)}KB`;

if (flag("check")) {
  const problems = [];
  const need = [`code/${bc}/main.js`, `code/${bc}/bootstrap.js`, `code/${bc}/admin.js`, `code/${bc}/package.json`, "code/manifest.json", "seed/data/save.json", "seed/certs/server.key", "seed/certs/server.crt"];
  for (const rel of need) if (!fs.existsSync(path.join(ASSETS, rel))) problems.push(`缺 ${rel}`);
  if (fs.existsSync(path.join(codeDir, "package.json"))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(codeDir, "package.json"), "utf8"));
    if (pkg.name !== "sld-offline-server") problems.push(`code/package.json 的 name 不对(${pkg.name}) —— findRoot 会越界找到仓库根`);
    if (pkg.type !== "commonjs") problems.push("code/package.json 要 type=commonjs, nodejs-mobile 只吃 CJS");
  }
  const junk = findJunk(seedDir);
  if (junk.length) problems.push(`seed 里混进运行垃圾: ${junk.slice(0, 3).join(", ")}${junk.length > 3 ? `…共 ${junk.length} 个` : ""}`);
  if (!fs.existsSync(path.join(codeDir, "data", "tbl", "Items.js"))) problems.push("code 里没有整表(dist-cjs/data/tbl), 假服起来会缺数据面");
  if (problems.length) {
    console.error("产物树不合格:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  console.log(`产物树合格: ${ASSETS}\n  code/${bc}: ${kb(treeBytes(codeDir))} · seed: ${kb(treeBytes(seedDir))} · seed 无运行垃圾`);
} else {
  const distCjs = path.resolve(opt("dist", path.join(ROOT, "dist-cjs")));
  if (!fs.existsSync(path.join(distCjs, "bootstrap.js"))) {
    console.error(`没有 ${path.join(distCjs, "bootstrap.js")} —— 先跑 npm run build:cjs`);
    process.exit(1);
  }
  fs.rmSync(codeDir, { recursive: true, force: true }); // 代码目录整目录换 = 手机上"APK 更新覆盖"的语义
  fs.rmSync(seedDir, { recursive: true, force: true });
  let codeN = copyTree(distCjs, codeDir);
  fs.copyFileSync(MAIN, path.join(codeDir, "main.js"));
  // 带 name 的 package.json: findRoot() 从 code 目录往上找的就是它; 少 name 会一路找到天上去
  fs.writeFileSync(path.join(codeDir, "package.json"), JSON.stringify({ name: "sld-offline-server", version: bc, type: "commonjs" }, null, 2) + "\n");
  codeN += 2; // main.js + package.json
  for (const rel of SEED_FILES) {
    const src = path.join(ROOT, rel); // SEED_FILES 已带 data/ 前缀, PC 上 DATA 就是仓库根
    if (!fs.existsSync(src)) {
      console.error(`seed 少了 ${rel} —— 假服起来会缺这块(存档/帧规则/版本应答)`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(path.join(seedDir, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(seedDir, rel));
  }
  // 只带 http.ts 真读的那两个: 其余(ca.* / *.srl)是签发用的, 铺进 APK 只是把私键到处搬
  let seedN = 0;
  for (const f of ["server.key", "server.crt"]) {
    const src = path.join(ROOT, "certs", f);
    if (!fs.existsSync(src)) {
      console.error(`seed 少了 certs/${f} —— SLD_TLS=1 起不来`);
      process.exit(1);
    }
    fs.mkdirSync(path.join(seedDir, "certs"), { recursive: true });
    fs.copyFileSync(src, path.join(seedDir, "certs", f));
    seedN++;
  }
  seedN += SEED_FILES.length;
  const manifest = { buildCode: bc, node: "18.20.4", abi: "arm64-v8a", packedAt: new Date().toISOString(), codeFiles: codeN, seedFiles: seedN };
  fs.mkdirSync(path.join(ASSETS, "code"), { recursive: true });
  fs.writeFileSync(path.join(ASSETS, "code", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`铺好 ${ASSETS}\n  code/${bc}: ${codeN} 个文件 ${kb(treeBytes(codeDir))}\n  seed: ${seedN} 个文件 ${kb(treeBytes(seedDir))}`);
}
