// 自测: 不需要真客户端, 用合成 KCP 包验证 假服务端 能解析/回 ACK/按帧派发, 并验证
// HTTP 桩与两个 python 工具可运行. 跑法: node test/selftest.mjs
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// import.meta.dirname 要 Node 20.11+; 自检也得能在 Node 18(与 nodejs-mobile 同版本)上跑, 故用 URL 解。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 被测产物目录: 默认 ESM 的 dist/, SLD_DIST=dist-cjs 时复跑 CommonJS 产物。
const DIST = process.env.SLD_DIST || 'dist';
const PY_CANDIDATES = [process.env.SLD_PY, '/home/tmp/venv/bin/python', 'python3'].filter(Boolean);
const py = PY_CANDIDATES.find((p) => (p.includes('/') ? fs.existsSync(p) : true)) || 'python3';

// global-metadata.dat 从 APK 里现取, 不依赖 /home/tmp 的工作目录
async function ensureMetadata() {
  const dst = path.join(config.paths.logs, 'global-metadata.dat');
  if (fs.existsSync(dst) && fs.statSync(dst).size > 1_000_000) return dst;
  const apk = process.env.SLD_APK || config.paths.apk;
  if (!fs.existsSync(apk)) return null;
  await exec(py, [
    '-c',
    'import sys,zipfile;open(sys.argv[2],"wb").write(zipfile.ZipFile(sys.argv[1]).read("assets/bin/Data/Managed/Metadata/global-metadata.dat"))',
    apk,
    dst,
  ]);
  return dst;
}


// 必须在 import config 之前设置端口
process.env.SLD_KCP_PORT = '19105';
process.env.SLD_HTTP_PORT = '19106';
process.env.SLD_NET_MODE = 'kcp';
process.env.SLD_NO_COLOR = '1';

const { encodeSegment, decodePacket, CMD, KcpSession } = await import(`../${DIST}/kcp.js`);
const { Framer, encode, CANDIDATE_RULES } = await import(`../${DIST}/framing.js`);
const { createGateway, on } = await import(`../${DIST}/gateway.js`);
const { createHttpServer } = await import(`../${DIST}/http.js`);
const { config, DATA: DATA_DIR } = await import(`../${DIST}/config.js`);
// handler 会真写档 -> 备份/还原用的现场路径(admin 那组 check 也要, 故提到最早)
const SAVE_FILE = config.paths.save;

const exec = promisify(execFile);
const results = [];
const check = async (name, fn) => {
  const n = results.length;
  try {
    await fn();
    if (results.length === n) results.push(['PASS', name]);
  } catch (e) {
    results.length = n;
    results.push(['FAIL', name, String(e.message || e).split('\n')[0]]);
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rule = CANDIDATE_RULES[0]; // le32-len+id: bodyLen u32 | msgId u32 | seq u32
const frameOf = (msgId, body, seq = 1) => encode(rule, { msgId, seq, body });

// ---------------------------------------------------------------- 1. KCP 编解码
await check('kcp 段编解码 24 字节头往返', () => {
  const seg = { conv: 0xdeadbeef, cmd: CMD.PUSH, frg: 0, wnd: 32, ts: 12345, sn: 7, una: 6, data: Buffer.from('hello-kcp') };
  const buf = encodeSegment(seg);
  assert.equal(buf.length, 24 + 9);
  assert.deepEqual(buf.readUInt32LE(0), 0xdeadbeef);
  const { segments, rest } = decodePacket(buf);
  assert.equal(rest.length, 0);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].cmd, CMD.PUSH);
  assert.equal(segments[0].sn, 7);
  assert.equal(segments[0].data.toString(), 'hello-kcp');
});

await check('一个数据报内多段可全部解析', () => {
  const a = encodeSegment({ conv: 1, cmd: CMD.PUSH, frg: 1, wnd: 16, ts: 1, sn: 0, una: 0, data: Buffer.alloc(3) });
  const b = encodeSegment({ conv: 1, cmd: CMD.ACK, frg: 0, wnd: 16, ts: 2, sn: 1, una: 1, data: Buffer.alloc(0) });
  const { segments } = decodePacket(Buffer.concat([a, b]));
  assert.equal(segments.length, 2);
  assert.equal(segments[1].cmd, CMD.ACK);
});

await check('KcpSession 分片按序交付 + 主动回 ACK', async () => {
  const out = [];
  const s = new KcpSession(9, { mtu: 64, output: (b) => out.push(b) });
  const got = [];
  s.on('data', (buf) => got.push(buf.toString()));
  s.input(encodeSegment({ conv: 9, cmd: CMD.PUSH, frg: 0, wnd: 32, ts: 0, sn: 1, una: 0, data: Buffer.from('B') }));
  s.input(encodeSegment({ conv: 9, cmd: CMD.PUSH, frg: 0, wnd: 32, ts: 1, sn: 0, una: 0, data: Buffer.from('A') }));
  assert.deepEqual(got, ['A', 'B'], '乱序包必须按 sn 重排');
  const acks = out.flatMap((p) => decodePacket(p).segments).filter((x) => x.cmd === CMD.ACK);
  assert.equal(acks.length, 2, '每个 PUSH 都要回 ACK');
  assert.equal(acks[0].una, 0, 'sn=1 先到时不可交付, una 仍为 0');
  assert.equal(acks[1].una, 2, 'sn=0 补齐后 una 应推进到 2');
  assert.deepEqual(acks.map((a) => a.sn), [1, 0], 'ACK 的 sn 回显被确认的段');
  const ctrl = [];
  s.on('control', (seg) => ctrl.push(seg.cmd));
  // CTRL_PING 是静默回 MSG_PING 的, 不落事件面; 未收录的命令(CTRL_STAT)才走 control
  s.input(encodeSegment({ conv: 9, cmd: CMD.CTRL_STAT, frg: 0, wnd: 32, ts: 2, sn: 2, una: 0, data: Buffer.alloc(0) }));
  assert.deepEqual(ctrl, [CMD.CTRL_STAT], 'data/control 都走 EventEmitter, 事件面不能漏');
  s.close();
});

// ---------------------------------------------------------------- 2. 帧层
await check('帧层 auto 能锁定 le32-len+id', () => {
  const f = new Framer(null);
  const frames = f.feed(Buffer.concat([frameOf(1001, Buffer.from('aa')), frameOf(1002, Buffer.from('bbbb'))]));
  assert.equal(f.locked?.name, 'le32-len+id', `实际锁定 ${f.locked?.name}`);
  assert.deepEqual(frames.map((x) => x.msgId), [1001, 1002]);
  assert.deepEqual(frames.map((x) => x.body.toString()), ['aa', 'bbbb']);
});

await check('帧层跨包粘包/半包正确', () => {
  const f = new Framer(rule);
  const buf = Buffer.concat([frameOf(7, Buffer.from('payload-1')), frameOf(8, Buffer.from('payload-2'))]);
  let acc = [];
  for (const byte of buf) acc = acc.concat(f.feed(Buffer.from([byte])));
  assert.deepEqual(acc.map((x) => x.msgId), [7, 8]);
});

await check('无法框帧时落盘而不是崩溃', () => {
  let dumped = 0;
  const f = new Framer(null, { onRaw: () => { dumped++; } });
  f.feed(Buffer.alloc(5000, 0xff));
  assert.equal(dumped, 1);
});

// ---------------------------------------------------------------- 3. 端到端
await check('端到端: 合成客户端 -> KCP 网关 -> 派发 -> 回程', async () => {
  // header-rule.json 是生产配置, 这里覆盖前先备份, 结束后还原(别删).
  fs.mkdirSync(path.dirname(config.paths.headerRule), { recursive: true });
  const hrBackup = fs.existsSync(config.paths.headerRule) ? fs.readFileSync(config.paths.headerRule) : null;
  fs.writeFileSync(config.paths.headerRule, JSON.stringify(rule.name));
  const gw = createGateway({ mode: 'kcp', port: 19105, host: '127.0.0.1' });
  await gw.start();
  let gotHandler = null;
  on(4321, (frame, peer) => { gotHandler = frame.body.toString(); return [4322, Buffer.from('world')]; });

  const cli = dgram.createSocket('udp4');
  await new Promise((r) => cli.bind(0, '127.0.0.1', r));
  const rx = [];
  cli.on('message', (m) => rx.push(m));
  const conv = 0x1234;
  cli.send(encodeSegment({ conv, cmd: CMD.PUSH, frg: 0, wnd: 32, ts: 0, sn: 0, una: 0, data: frameOf(4321, Buffer.from('hello')) }),
    19105, '127.0.0.1', () => {});
  await wait(400);
  const segs = rx.flatMap((p) => decodePacket(p).segments);
  assert.equal(gotHandler, 'hello', '服务端应把 body 交到注册的 msgId 处理器');
  assert.ok(segs.some((s) => s.cmd === CMD.ACK && s.sn === 0), '必须回 ACK');
  const pushed = segs.find((s) => s.cmd === CMD.PUSH);
  assert.ok(pushed, '处理器返回值应以 PUSH 段回送');
  const back = new Framer(rule).feed(pushed.data);
  assert.equal(back[0].msgId, 4322);
  assert.equal(back[0].body.toString(), 'world');
  cli.close();
  gw.stop();
  if (hrBackup) fs.writeFileSync(config.paths.headerRule, hrBackup);
  else fs.rmSync(config.paths.headerRule);
});

await check('端到端: raw UDP 模式同样可派发', async () => {
  const gw = createGateway({ mode: 'raw', port: 19107, host: '127.0.0.1' });
  await gw.start();
  let hit = null;
  on(555, (frame) => { hit = frame.body.toString(); return false; });
  const cli = dgram.createSocket('udp4');
  await new Promise((r) => cli.bind(0, '127.0.0.1', r));
  cli.send(frameOf(555, Buffer.from('raw-mode')), 19107, '127.0.0.1', () => {});
  await wait(250);
  assert.equal(hit, 'raw-mode');
  const peer = [...gw.peers.values()][0];
  assert.equal(peer.mode, 'raw', 'raw 模式下不做 KCP 解析');
  cli.close();
  gw.stop();
});

// ---------------------------------------------------------------- 3b. 生命周期(安卓侧的前提)
// APK 里的开关就是 createOfflineServer 的 start/stop, 而 node::Start 起来的 VM 不会跟着
// 服务重启 —— 所以"关"必须是真关: 端口释放、对端清零、停后一个包都不许再被处理。
// 更要命的是模块级注册: 每开一次多挂一个兜底记录器, 同一报文就落两遍盘, 比起不来难查得多。
await check('offline: start/stop 三轮 —— 真停真起、兜底记录不翻倍、停后不收包', async () => {
  const { createOfflineServer } = await import(`../${DIST}/offline.js`);
  const { handlerIds } = await import(`../${DIST}/gateway.js`);
  const hrBackup = fs.existsSync(config.paths.headerRule) ? fs.readFileSync(config.paths.headerRule) : null;
  fs.mkdirSync(path.dirname(config.paths.headerRule), { recursive: true });
  fs.writeFileSync(config.paths.headerRule, JSON.stringify(rule.name));
  const logFile = path.join(config.paths.logs, 'server.log');
  const txt = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
  const unknowns = () => (txt().match(/未注册 msgId=990808/g) || []).length;
  const boots = () => (txt().match(/Thrud\(sld\) 离线服务端 \| resVersion=/g) || []).length;
  const UMSG = 990808;
  const push = (sn, note) => encodeSegment({
    conv: 0x2468, cmd: CMD.PUSH, frg: 0, wnd: 32, ts: sn * 10, sn, una: 0, data: frameOf(UMSG, Buffer.from(note)),
  });
  const cli = dgram.createSocket('udp4');
  await new Promise((r) => cli.bind(0, '127.0.0.1', r));
  const sendTo = (seg) => new Promise((r) => cli.send(seg, config.gateway.port, '127.0.0.1', r));
  let H0 = 0; // 第一轮 start 之后再取: 默认注册(wireDefaults 的 on(0))就是在 start 里做的
  const srv = createOfflineServer();
  try {
    const b0 = boots();
    const u0 = unknowns();
    for (let r = 1; r <= 3; r++) {
      await srv.start();
      assert.equal(srv.running, true, `第 ${r} 轮 start 后 running 要为 true`);
      if (r === 1) {
        assert.ok(handlerIds().includes(0), 'start 要把默认装配(msgId 0 探活)挂上');
        H0 = handlerIds().length;
      }
      assert.equal(boots(), b0 + r, `第 ${r} 轮启动日志只该多 1 行 —— 多行说明 start 被重复装配`);
      await sendTo(push(0, `round${r}`));
      await wait(300);
      assert.equal(unknowns(), u0 + r, `第 ${r} 轮的未注册包应恰好记 1 条(累计 ${r}), 翻倍=兜底记录器随重启越挂越多`);
      await srv.stop();
      assert.equal(srv.running, false, `第 ${r} 轮 stop 后 running 要为 false`);
      await sendTo(push(1, 'after-stop'));
      await wait(250);
      assert.equal(unknowns(), u0 + r, 'stop 之后一个包都不许再被处理(端口没真关)');
      // 停服后 HTTP 侧也该彻底断: 再连一次应当失败
      await assert.rejects(fetch(`http://127.0.0.1:${config.http.port}/server/cdnData`),
        `第 ${r} 轮 stop 后 HTTP 端口必须已释放`);
    }
    assert.equal(handlerIds().length, H0, '三轮启停不该往 handlers 里多塞东西');
    await srv.start();
    assert.deepEqual(srv.status().peers, [], 'status().peers 是网关对端表, 供管理页显示');
    await srv.stop();
  } finally {
    await srv.stop();
    cli.close();
    if (hrBackup) fs.writeFileSync(config.paths.headerRule, hrBackup);
    else fs.rmSync(config.paths.headerRule, { force: true });
  }
});

// ---------------------------------------------------------------- 3c. 管理面 (admin.ts)
// 手机上的开关/改档/看日志全走这里, 判据只能是 HTTP 回包: 状态对不对、启停有没有真把端口
// 放开、写档被拒时盘上一个字节都不能动。
// 每条 check 一个端口: admin.close() 会 closeAllConnections(), 共用端口时 undici 池里的
// keep-alive 套接字会变成"对端已 reset 但客户端不知道"的僵尸, 下一条 check 第一跳就 fetch failed。
const adminClient = (port) => {
  const base = `http://127.0.0.1:${port}`;
  const reqJ = (p, method, body) => fetch(base + p, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  }).then(async (r) => ({ code: r.status, body: await r.json().catch(() => null) }));
  return {
    base,
    reqJ,
    getJ: (p) => reqJ(p, 'GET'),
    postJ: (p) => reqJ(p, 'POST'),
    patchJ: (obj) => reqJ('/api/save', 'PATCH', obj),
    putSave: (text) => reqJ('/api/save', 'PUT', text),
  };
};

await check('admin: 状态/开关/日志尾读/页面 一条链跑通', async () => {
  const { createOfflineServer } = await import(`../${DIST}/offline.js`);
  const { createAdminServer } = await import(`../${DIST}/admin.js`);
  const A = adminClient(19328);
  const off = createOfflineServer();
  const admin = createAdminServer(off, { host: '127.0.0.1', port: 19328 });
  try {
    await admin.ready;
    const page = await (await fetch(A.base + '/')).text();
    assert.ok(page.includes('<textarea id="saveJson"'), '页面得是完整 HTML, 不是半截模板');
    assert.ok(page.trim().endsWith('</html>') && page.length > 4000, '单页要自带样式与脚本, 不能靠外部文件');

    const s0 = await A.getJ('/api/status');
    assert.equal(s0.code, 200);
    assert.equal(s0.body.running, false, '刚建好没 start, status 要如实报停');
    assert.equal(s0.body.gateway.port, config.gateway.port, 'status 里的端口就是假服本体的端口');
    assert.ok(s0.body.node.startsWith('v'), 'node 版本给管理页显示');

    assert.equal((await A.postJ('/api/start')).body.running, true, 'start 后 status.running 要翻上来');
    const started = await A.getJ('/api/status');
    assert.equal(started.body.running, true);
    assert.equal((await A.postJ('/api/stop')).body.running, false, 'stop 后 running 要翻下去');

    const t = await A.getJ('/api/logs?tail=5');
    assert.equal(t.code, 200);
    assert.ok(t.body.text.includes('admin'), '启停本身就写进 server.log, 尾读要看得见');
    assert.ok(typeof t.body.nextOffset === 'number' && t.body.nextOffset > 0, '尾读要带 nextOffset 给 2s 轮询');
    const inc = await A.getJ('/api/logs?offset=' + t.body.nextOffset);
    assert.equal(inc.body.text, '', '从 nextOffset 增量读, 不该重吐已给过的内容');
    await A.reqJ('/api/loglevel', 'POST', { level: 'debug' });
    assert.equal((await A.reqJ('/api/loglevel', 'POST', { level: 'nope' })).code, 400, '级别只能四选一');
    await A.reqJ('/api/loglevel', 'POST', { level: 'info' });
    const items = await A.getJ('/api/items?kind=money');
    assert.equal(items.code, 200);
    assert.ok(items.body.length >= 6 && items.body.every((i) => i.name), '六种货币都要有中文名, 界面才能选');
    assert.equal((await fetch(A.base + '/api/nope')).status, 404, '未知管理端点别装成功');
  } finally {
    await admin.close();
  }
});

await check('admin: 写档 —— 合法 200 立即可读, 四种非法 400 且盘上逐字节不动', async () => {
  const { createOfflineServer } = await import(`../${DIST}/offline.js`);
  const { createAdminServer } = await import(`../${DIST}/admin.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const before = fs.readFileSync(SAVE_FILE);
  const A = adminClient(19329);
  const off = createOfflineServer();
  const admin = createAdminServer(off, { host: '127.0.0.1', port: 19329 });
  const unchanged = () => assert.equal(fs.readFileSync(SAVE_FILE).equals(before), true, '被拒的请求不许把盘写脏');
  try {
    await admin.ready;
    const doc = (await A.getJ('/api/save')).body;
    const keys = Object.keys(doc).sort();
    assert.ok(keys.includes('characters') && keys.includes('money') && keys.length >= 18, `GET /api/save 要给出完整 ${keys.length} 键档`);

    const legal = JSON.parse(before.toString('utf8'));
    // 先把该拒的试干净: 每一步都对照 before, 证明确实一个字节没动
    const noChars = { ...legal };
    delete noChars.characters;
    assert.equal((await A.putSave(JSON.stringify(noChars))).code, 400, 'PUT 是整档替换, 缺 characters 必须拒');
    await unchanged();

    assert.equal((await A.patchJ({ characters: null })).code, 400, 'characters:null 必须拒 —— normalizeSave 会把它当"没给"静默重置成初始号');
    await unchanged();

    const badItem = { ...legal, items: { ...(legal.items || {}), '99999999': 5 } };
    assert.equal((await A.patchJ(badItem)).code, 400, '客户端不认识的道具 id 必须拒');
    await unchanged();

    assert.equal((await A.putSave('{"player":{')).code, 400, 'JSON 截断要 400 而不是 500');
    await unchanged();

    assert.equal((await A.patchJ({ ...legal, nopeBlock: 1 })).code, 400, '多出来的顶层键也要拒, 否则手滑打错键名等于没改');
    await unchanged();

    assert.equal((await A.patchJ({ money: '不是对象' })).code, 400, '顶层键类型不对也得拒');
    await unchanged();

    legal.money['10'] = Number(legal.money['10'] || 0) + 7;
    const okRes = await A.patchJ(legal);
    assert.equal(okRes.code, 200, `合法档该 200, 实际 ${okRes.code}: ${okRes.body && okRes.body.error}`);
    assert.equal(loadSave().money['10'], legal.money['10'], 'loadSave 每请求重读盘 -> 不重启就生效');
    assert.ok(/save\.pre-admin\..*\.json$/.test(okRes.body.backup), '写前必须先留一份现状副本');
    assert.ok(fs.existsSync(path.join(config.paths.logs, path.basename(okRes.body.backup))), '副本要真在 logs 里');
    assert.ok(!fs.readFileSync(SAVE_FILE).equals(before), '合法写盘后档就该变了');

    // PATCH 少键 = "不改它"(货币快捷改档就靠这条), 所以不该拒 —— 放在所有负例之后, 免得污染 unchanged() 的对照
    assert.equal((await A.patchJ({ money: legal.money })).code, 200, 'PATCH 只给 money 是合法的部分更新');

    assert.equal((await A.putSave(JSON.stringify(legal))).code, 200, 'PUT 给全档该收');
  } finally {
    await admin.close();
    fs.writeFileSync(SAVE_FILE, before);
  }
});

await check('admin: 绑到 0.0.0.0 就必须有令牌, 首启生成 admin.token(0600)', async () => {
  const { createOfflineServer } = await import(`../${DIST}/offline.js`);
  const { createAdminServer } = await import(`../${DIST}/admin.js`);
  const tokenFile = path.join(DATA_DIR, 'admin.token');
  fs.rmSync(tokenFile, { force: true });
  const A = adminClient(19330);
  const off = createOfflineServer();
  const admin = createAdminServer(off, { host: '0.0.0.0', port: 19330 });
  try {
    await admin.ready;
    assert.equal(admin.needsToken, true, '非回环要开 token');
    assert.equal((await (await fetch(A.base + '/api/status')).status), 401, '没令牌绑公网面该 401');
    assert.ok(fs.existsSync(tokenFile), '首次启动要生成 admin.token');
    const mode = fs.statSync(tokenFile).mode & 0o777;
    assert.equal(mode, 0o600, `admin.token 权限要 0600, 实际 ${mode.toString(8)}`);
    const tok = fs.readFileSync(tokenFile, 'utf8').trim();
    assert.equal((await (await fetch(A.base + '/api/status?token=' + tok)).status), 200, '?token= 要能进(WebView 首屏这么带)');
    assert.equal((await (await fetch(A.base + '/api/status', { headers: { 'X-Admin-Token': tok } })).status), 200, 'X-Admin-Token 要能进(页面后续请求走这条)');
    assert.equal((await (await fetch(A.base + '/', { headers: { 'x-admin-token': 'wrong' } })).status), 401, '错令牌不许放过');
  } finally {
    await admin.close();
    fs.rmSync(tokenFile, { force: true });
  }
});

// ---------------------------------------------------------------- 3d. APK 打包与铺盘
// 拿不到 adb, "手机那套布局能不能跑"就只能在这里定: 用 Node 18(与 nodejs-mobile 同版本)
// 按 assets/code/<buildCode>/main.js --data 独立目录 真起一次, 看管理端口回不回状态。
const SIM = '/home/tmp/androidsim-selftest';
const NODE18 = process.env.SLD_NODE18 || '/home/tmp/node18/bin/node';
const readFile = (p) => fs.readFileSync(p);

await check('seed: 只在缺失时铺, 已有存档一个字节都不动', async () => {
  const { seedOnce, walkFiles } = await import(`../${DIST}/bootstrap.js`);
  const tag = 'seed-' + Date.now();
  const seed = path.join(SIM, tag, 'seed');
  const data = path.join(SIM, tag, 'data');
  fs.mkdirSync(path.join(seed, 'data'), { recursive: true });
  fs.mkdirSync(path.join(seed, 'certs'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'data', 'save.json'), '{"seeded":true}');
  fs.writeFileSync(path.join(seed, 'data', 'header-rule.json'), '{"seed":1}');
  fs.writeFileSync(path.join(seed, 'certs', 'server.crt'), 'SEED-CRT');
  try {
    const r1 = seedOnce(seed, data, 'test-1');
    assert.deepEqual(r1.copied.slice().sort(), ['certs/server.crt', 'data/header-rule.json', 'data/save.json'], '首启要把 seed 全铺下去');
    assert.equal(r1.seedver, 'test-1', '.seedver 要记下这档是哪版铺的');
    assert.equal(JSON.parse(readFile(path.join(data, 'data', 'save.json')).toString('utf8')).seeded, true);

    // 玩家已经玩了一会儿: 再装一次 APK(又铺一遍盘)绝不许把进度刷回 seed
    fs.writeFileSync(path.join(data, 'data', 'save.json'), '{"mine":"进度"}');
    const r2 = seedOnce(seed, data, 'test-2');
    assert.equal(r2.copied.length, 0, '第二次铺盘不该再动任何文件');
    assert.deepEqual(r2.kept.slice().sort(), ['certs/server.crt', 'data/header-rule.json', 'data/save.json']);
    assert.equal(JSON.parse(readFile(path.join(data, 'data', 'save.json')).toString('utf8')).mine, '进度', '已有存档必须原样留着 —— 这条挂了就是"更新 APK 把号练回初始"');
    assert.equal(r2.seedver, 'test-1', '.seedver 已存在就不改写: 它记的是首启那版');

    assert.deepEqual(walkFiles(seed).slice().sort(), ['certs/server.crt', 'data/header-rule.json', 'data/save.json'], 'walkFiles 要连子目录一起给');
    assert.deepEqual(walkFiles(path.join(SIM, tag, '不存在')), [], 'seed 目录不存在不该炸');
  } finally {
    fs.rmSync(path.join(SIM, tag), { recursive: true, force: true });
  }
});

await check('pack+node18: 按手机布局起假服(铺盘/管理面/HTTPS/存档落数据目录)', async () => {
  const assets = path.join(SIM, 'assets');
  const dataDir = path.join(SIM, 'slddata');
  fs.rmSync(assets, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  const pack = path.join(ROOT, 'tools', 'pack_nodejs.mjs');
  await exec(process.execPath, [pack, '--out', assets]); // 真产物不合格时 exec 会带着 stderr 抛
  await exec(process.execPath, [pack, '--out', assets, '--check']); // 同一条断言独立跑一遍, 证明 --check 有牙
  const bc = JSON.parse(readFile(path.join(assets, 'code', 'manifest.json')).toString('utf8')).buildCode;
  const codeDir = path.join(assets, 'code', bc);
  const seedDir = path.join(assets, 'seed');
  assert.ok(fs.existsSync(path.join(codeDir, 'main.js')), 'code 里要有 main.js(nodejs-mobile 的入口)');
  assert.ok(fs.existsSync(path.join(codeDir, 'data', 'tbl', 'Items.js')), '整表要跟着进 APK(假服起来要读它)');
  assert.equal(JSON.parse(readFile(path.join(codeDir, 'package.json')).toString('utf8')).name, 'sld-offline-server', 'code/package.json 的 name 是 findRoot 的停车牌');
  const seededFiles = ['data/save.json', 'data/header-rule.json', 'data/frame_prefix.txt', 'data/skipapi.json', 'data/getclientupdatedata.json', 'certs/server.key', 'certs/server.crt'];
  assert.deepEqual(seededFiles.map((f) => fs.existsSync(path.join(seedDir, f))), seededFiles.map(() => true), 'seed 清单要齐');
  const junk = ['data/save.json.bak', 'data/logs', 'data/capture', 'data/admin.token'].filter((f) => fs.existsSync(path.join(seedDir, f)));
  assert.deepEqual(junk, [], `seed 里混进运行垃圾: ${junk}`);
  // code/ 只许留当前 buildCode: manifest 只认一个号, 旧的是纯粹的死重量(v1 那次真留了 13 MB)
  const stale = path.join(assets, 'code', '0.0.0-gSTALE');
  fs.mkdirSync(stale, { recursive: true });
  await assert.rejects(exec(process.execPath, [pack, '--out', assets, '--check']), /buildCode 残留/,
    'code/ 里留着别的 buildCode 时 --check 必须不合格');
  await exec(process.execPath, [pack, '--out', assets]); // 重铺一次, 旧的应当被整目录换掉
  assert.deepEqual(fs.readdirSync(path.join(assets, 'code')).sort(), ['manifest.json', bc].sort(),
    'pack 后 code/ 只该有 manifest.json + 当前 buildCode');
  if (!fs.existsSync(NODE18)) {
    console.log(`  · 没有 node18(${NODE18}), 跳过实启, 只断言产物树`);
    return;
  }
  const A = 19341, H = 19342, K = 19343;
  const argv = [path.join(codeDir, 'main.js'), '--root', codeDir, '--data', dataDir, '--seed', seedDir, '--admin', String(A), '--http-port', String(H), '--kcp-port', String(K), '--build-code', bc];
  const spawnBoot = async (expect) => {
    const child = spawn(NODE18, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const deadline = Date.now() + 40000; // 13MB 整表在 2 核小机上解析要几秒
    while (!out.includes(expect) && Date.now() < deadline && child.exitCode === null) await wait(100);
    return { child, out };
  };
  const kill = async (child) => {
    if (child.exitCode === null) child.kill('SIGTERM');
    const until = Date.now() + 5000;
    while (child.exitCode === null && Date.now() < until) await wait(50);
    if (child.exitCode === null) child.kill('SIGKILL');
    // 端口真放开没有: 直连一次必须连不上(否则下一轮自启会撞 EADDRINUSE, 那是更难查的故障)
    const refused = await fetch(`http://127.0.0.1:${A}/api/status`).then(() => false, () => true);
    assert.equal(refused, true, '进程退了管理端口就该放开');
  };
  let b1;
  try {
    b1 = await spawnBoot('READY');
    assert.match(b1.out, /READY/, `main.js 没起来自:\n${b1.out.slice(-500)}`);
    assert.match(b1.out, /铺7\/留0/, '首启该铺 7 个文件');
    assert.equal(b1.child.exitCode, null, 'READY 之后进程不该自己退出: ' + b1.out.slice(-300));
    const st = await (await fetch(`http://127.0.0.1:${A}/api/status`)).json();
    assert.equal(st.running, true, '管理面要说假服在跑');
    assert.equal(st.node, 'v18.20.4', '实启必须与 nodejs-mobile 同版本, 否则这条证据不算数');
    assert.equal(st.gateway.port, K);
    assert.equal(st.logs, path.join(dataDir, 'data', 'logs'), '日志/存档都得落在 --data 指定的数据目录');
    assert.equal(readFile(path.join(dataDir, 'data', 'save.json')).equals(readFile(SAVE_FILE)), true, '铺出来的存档要和仓库那份逐字节一致');
    assert.equal(readFile(path.join(dataDir, '.seedver')).toString('utf8').trim(), bc);
    assert.ok(!fs.existsSync(path.join(codeDir, 'data', 'save.json')), '代码目录里不许有存档: APK 更新会连档带码一起覆盖');
    const { get } = await import('node:https');
    // rejectUnauthorized:false 只针对本机这个自签证书(整个方案的前提就是客户端放水信任它),
    // 这条断言要的是"seed 出来的 certs 真能被 https.createServer 用起来", 不是校验链。
    const body = await new Promise((resolve, reject) => {
      const rq = get({ host: '127.0.0.1', port: H, path: '/server/serverUrlData', rejectUnauthorized: false }, (r) => {
        let s = '';
        r.on('data', (c) => { s += c; });
        r.on('end', () => resolve(s));
      });
      rq.on('error', reject);
    });
    assert.match(body, /"urlList":\["https:\/\/127\.0\.0\.1:443"\]/, '手机上的 GS 域名必须是 127.0.0.1:443, 由 gadget 改端口');
    await kill(b1.child);

    // 同一个数据目录再起: 铺 0 留 7, 存档字节不动 —— 这就是"更新 APK 不掉档"
    const before = readFile(path.join(dataDir, 'data', 'save.json'));
    const b2 = await spawnBoot('READY');
    try {
      assert.match(b2.out, /铺0\/留7/, `再起不该铺任何文件:\n${b2.out.slice(0, 300)}`);
      assert.equal(readFile(path.join(dataDir, 'data', 'save.json')).equals(before), true);
    } finally {
      await kill(b2.child);
    }
  } finally {
    if (b1) await kill(b1.child).catch(() => {});
    fs.rmSync(SIM, { recursive: true, force: true });
  }
});

// 探针脚本(probe.js)是"手机上看那几行字"的唯一凭据, 所以它自己也得有离线判据:
// 按探针布局铺一份 assets, 用 node18(和 libnode 同版本)真跑一遍, 逐行核对屏上该出现什么。
await check('probe: 探针脚本在 node18 上跑出预期读数(CustomEvent/dgram/整表/依赖图)', async () => {
  const assets = path.join(SIM, 'probe-assets');
  const out = path.join(SIM, 'probe-out.txt');
  const pack = path.join(ROOT, 'tools', 'pack_nodejs.mjs');
  const main = path.join(ROOT, 'android', 'probe.js');
  fs.rmSync(assets, { recursive: true, force: true });
  fs.rmSync(out, { force: true });
  await exec(process.execPath, [pack, '--main', main, '--out', assets]);
  await exec(process.execPath, [pack, '--main', main, '--out', assets, '--check']);
  const bc = JSON.parse(readFile(path.join(assets, 'code', 'manifest.json')).toString('utf8')).buildCode;
  const entry = path.join(assets, 'code', bc, 'main.js');
  assert.equal(readFile(entry).toString('utf8'), readFile(main).toString('utf8'), '--main 要把探针脚本铺成 code/<bc>/main.js');
  if (!fs.existsSync(NODE18)) {
    console.log(`  · 没有 node18(${NODE18}), 跳过实跑探针, 只断言产物树`);
    fs.rmSync(SIM, { recursive: true, force: true });
    return;
  }
  const child = spawn(NODE18, [entry, '--out', out], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const deadline = Date.now() + 40000;
  while ((!fs.existsSync(out) || readFile(out).toString('utf8').indexOf('hold=') < 0) && Date.now() < deadline && child.exitCode === null) await wait(100);
  const text = fs.existsSync(out) ? readFile(out).toString('utf8') : '';
  try {
    const kv = Object.fromEntries(text.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.equal(child.exitCode, null, `探针末尾的定时器该把进程钉住(node::Start 会 exit()): ${text}\nstderr=${err}`);
    assert.equal(kv.ok, '1', `探针该跑到 ok=1:\n${text}\nstderr=${err}`);
    assert.equal(kv.node, 'v18.20.4', '实跑必须与 nodejs-mobile 同版本, 否则下面的读数不算数');
    assert.equal(kv.CustomEvent, 'undefined', 'Node 18 没有全局 CustomEvent —— kcp.ts/gateway.ts 因此用 node:events');
    assert.match(kv.dgram, /旧socket复用=ERR_SOCKET/, '已 close 的 socket 再 bind 要真的抛, 这条是"每次 start 换新 socket"的依据');
    assert.match(kv.dgram, /新socket占回同端口=ok/, '换新 socket 占回同端口必须成, 否则假服重启起不来');
    assert.ok(Number((kv.tables.match(/\/(\d+)行/) || [])[1]) > 20000, `整表要真展开(25193 行量级), 读到 ${kv.tables}`);
    assert.equal(kv.modules, 'ok/8', `假服的依赖图在 CJS 产物里要能全 require: ${text}`);
    assert.ok(Number(kv.rssMb) > 40 && Number(kv.rssMb) < 400, `全表展开后的 RSS 该在合理区间, 读到 ${kv.rssMb}MB`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(SIM, { recursive: true, force: true }); // probe-assets 与 probe-out.txt 都在 SIM 下
  }
});

// Java/C++/CMake/main.js 四处名字必须对上, 而这些错**只在真机上炸**(UnsatisfiedLinkError
// 或"参数被静默忽略"), Gradle 编译与 npm selftest 都不会报 —— 所以在这里按源码文本核一遍。
await check('android: 壳的接线(JNI 符号 / loadLibrary 名 / argv 标志 / 清单)对得上', () => {
  const mangle = (s) => s.replace(/_/g, '_1');
  const mods = [
    { java: 'android/app/src/main/java/com/sld/offline/server/NodeBridge.java', cpp: 'android/app/src/main/cpp/native-lib.cpp', cmake: 'android/app/src/main/cpp/CMakeLists.txt', entry: 'android/main.js' },
    { java: 'android/probe/src/main/java/com/sld/offline/probe/ProbeActivity.java', cpp: 'android/probe/src/main/cpp/node_start.cpp', cmake: 'android/probe/src/main/cpp/CMakeLists.txt', entry: 'android/probe.js' },
  ];
  for (const m of mods) {
    const src = readFile(path.join(ROOT, m.java)).toString('utf8');
    const cpp = readFile(path.join(ROOT, m.cpp)).toString('utf8');
    const cmake = readFile(path.join(ROOT, m.cmake)).toString('utf8');
    const pkg = (src.match(/^package\s+([\w.]+);/m) || [])[1];
    const cls = path.basename(m.java, '.java');
    assert.ok(pkg, `${m.java} 要声明 package`);
    const natives = [...src.matchAll(/native\s+\w+\s+(\w+)\s*\(/g)].map((x) => x[1]);
    assert.ok(natives.length >= 1, `${m.java} 里该有 native 方法`);
    for (const fn of natives) {
      const sym = `Java_${mangle(pkg).replace(/\./g, '_')}_${mangle(cls)}_${mangle(fn)}`;
      assert.ok(cpp.includes(sym), `${m.cpp} 里找不到 JNI 符号 ${sym}(真机上就是 UnsatisfiedLinkError)`);
    }
    const lib = (src.match(/loadLibrary\("([^"]+)"\)/) || [])[1];
    assert.ok(lib, `${m.java} 要 System.loadLibrary(...)`);
    assert.ok(new RegExp(`add_library\\(${lib}\\s+SHARED`).test(cmake), `${m.cmake} 的 target 得叫 ${lib}(装载找的是 lib${lib}.so)`);

    // main.js 的 parseArgv 对不认识的 --xxx 是静默忽略: 少一个 --data 就变成"存档铺进代码目录"
    const entry = readFile(path.join(ROOT, m.entry)).toString('utf8');
    if (!entry.includes('parseArgv')) continue; // 探针不解析参数, 那条规则只约束真壳
    const envBlock = (entry.match(/const FLAG_ENV = \{([\s\S]*?)\n\};/) || [])[1] || '';
    const known = new Set([...envBlock.matchAll(/"?([\w-]+)"?\s*:/g)].map((x) => x[1]));
    for (const k of ['seed', 'build-code', 'no-start']) known.add(k); // main.js 直接读的三个
    const given = [...src.matchAll(/"(--[\w-]+)"/g)].map((x) => x[1].slice(2));
    assert.ok(given.length >= 4, `${m.java} 要显式传 root/data/seed/admin 这类参数`);
    const unknown = given.filter((f) => !known.has(f));
    assert.deepEqual(unknown, [], `${m.entry} 认不出的参数会被静默丢掉: ${unknown}`);
  }

  const mf = readFile(path.join(ROOT, 'android/app/src/main/AndroidManifest.xml')).toString('utf8');
  for (const p of ['INTERNET', 'WAKE_LOCK', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_SPECIAL_USE', 'POST_NOTIFICATIONS']) {
    assert.ok(mf.includes(`android.permission.${p}`), `清单少了 ${p}(Android 14 上 specialUse 前台服务没这条起不来)`);
  }
  assert.ok(/foregroundServiceType="specialUse"/.test(mf), '服务要声明 foregroundServiceType');
  assert.ok(/networkSecurityConfig="@xml\/network_security_config"/.test(mf), '明文要由 network_security_config 精确放行');
  const nsc = readFile(path.join(ROOT, 'android/app/src/main/res/xml/network_security_config.xml')).toString('utf8');
  assert.match(nsc, /base-config cleartextTrafficPermitted="false"/, '默认不许明文');
  assert.ok(!nsc.includes('0.0.0.0'), '不许把明文放到整个网面上');
});

// 非 root 绑不了 443, 全靠 gadget 在 connect()/getaddrinfo 里就地改 sockaddr 端口。
// 这段字节运算错了不会有任何报错, 只会"客户端连 443 连不上", 所以把纯函数圈出来抽进 node 断言。
await check('gadget: sockaddr 端口改写(443->9443)字节对且改出来的端口真能连上', async () => {
  const src = readFile(path.join(ROOT, 'frida', 'hook_redirect_trust.js')).toString('utf8');
  assert.match(src, /^var MODE = 'tunnel';$/m, "默认模式必须是 tunnel: 推上去就把用户的隧道流程换了");
  assert.match(src, /MODE === 'local' \? \{ ip: LOCAL_IP, from: 443, to: 9443 \} : null/, 'local 模式的规则要写成 443->9443 且只认 127.0.0.1');
  assert.match(src, /patchSa\(a\[1\], a\[2\]\.toInt32\(\), 'connect'\)/, "connect() 里要真改写(先验 addrlen 再动)");
  assert.match(src, /patchSa\(ai\.add\(AI_ADDR_OFF\)\.readPointer\(\)/, 'getaddrinfo 的结果链也要改: KCP 走 UDP 时用 sendto, 根本不经过 connect()');

  // 手机上真正跑的是 hook_gadget_all.js 生成的变体, 不是这份文件; "两段是原样复制的"这句话
  // 之前只写在文档里靠人记得去 cmp —— 改一处忘一处就变成"隧道能用、本地那套悄悄失效"。
  const seam = (t, name) => {
    const i = t.indexOf("emit('combined-loaded'");
    assert.ok(i > 0, `${name} 里找不到 combined-loaded 那行, 共享块的分界变了, 这条断言要跟着改`);
    return t.slice(0, t.indexOf('\n', i) + 1);
  };
  const gad = readFile(path.join(ROOT, 'frida', 'hook_gadget_all.js')).toString('utf8');
  assert.equal(seam(gad, 'hook_gadget_all.js'), seam(src, 'hook_redirect_trust.js'), 'gadget 真源的 redirect/trust 段必须逐字节等于 hook_redirect_trust.js');
  // MODE 本身是 make_variants.sh 会 sed 的旋钮, 比"有没有漂移"时得把它挖掉
  const seamKnobFree = (t) => seam(t).replace(/^var MODE = '(?:tunnel|local)';$/m, 'var MODE = <旋钮>;');
  for (const [file, mode] of [['hook_gadget_pool_zaxis_skip.js', 'tunnel'], ['hook_gadget_local_pool_zaxis_skip.js', 'local']]) {
    const v = readFile(path.join(ROOT, 'frida', file)).toString('utf8');
    assert.equal(seamKnobFree(v), seamKnobFree(gad), `${file} 是 make_variants.sh 生成的, 和基线漂移就说明忘了重生成`);
    assert.match(v, new RegExp(`^var MODE = '${mode}';$`, 'm'), `${file} 的 MODE 应当是 ${mode}`);
    if (mode === 'local') assert.match(v, /SA_RULE = MODE === 'local' \? \{ ip: LOCAL_IP, from: 443, to: 9443 \}/, '本地那份要带着 443->9443 的规则');
  }

  const block = (src.match(/\/\* SLD_SA_START \*\/([\s\S]*?)\/\* SLD_SA_END \*\//) || [])[1];
  assert.ok(block, 'frida 脚本里要有 SLD_SA_START/SLD_SA_END 圈出的纯字节函数(这条自检抽的就是它)');
  assert.ok(!/Memory\.|readU8|\.add\(|Process\./.test(block), '圈出来的函数只能做字节运算, 碰了 Frida API 这段断言就成了假的');
  // 在空上下文里跑这段: 段内不许 require/process/宿主全局, 万一源文件被改坏也伤不到自检进程
  const vm = await import('node:vm');
  const f = vm.runInNewContext(block + '\n({ sldPatchSaPort, sldSaV4 })', vm.createContext({}));
  const mk = (ip, port, fam) => {
    const b = new Uint8Array(16);
    b[0] = (fam || 2) & 0xff;
    b[2] = (port >> 8) & 0xff; // sin_port 是网络序(大端)
    b[3] = port & 0xff;
    ip.split('.').forEach((x, i) => { b[4 + i] = Number(x); });
    return b;
  };
  const rule = { ip: '127.0.0.1', from: 443, to: 9443 };

  const sa = mk('127.0.0.1', 443);
  assert.equal(f.sldSaV4(sa), '127.0.0.1:443', 'sockaddr_in 的读法: family@0 小端, port@2 大端, addr@4');
  assert.equal(f.sldPatchSaPort(sa, rule), 1);
  assert.deepEqual([sa[2], sa[3]], [0x24, 0xe3], '9443=0x24E3, 网络序要写成 24 E3');
  assert.equal(f.sldSaV4(sa), '127.0.0.1:9443');

  // 不该动的一个都不许动
  const untouched = [
    [mk('127.0.0.1', 8080), rule, '端口不是 from'],
    [mk('<YOUR_SERVER_IP>', 443), rule, 'IP 不是我们的'],
    [mk('127.0.0.1', 443, 10), rule, 'AF_INET6 不碰'],
    [mk('127.0.0.1', 443), null, 'tunnel 模式规则是 null'],
  ];
  for (const [b, r, why] of untouched) {
    const before = Buffer.from(b).toString('hex');
    assert.equal(f.sldPatchSaPort(b, r), 0, why + ' 时不该改');
    assert.equal(Buffer.from(b).toString('hex'), before, why + ' 却不许把字节写脏');
  }
  assert.equal(f.sldPatchSaPort(new Uint8Array(15), rule), 0, '不足一个 sockaddr_in 就返回, 别越界');

  // 真连一次: 从改写后的字节里读回端口去 connect —— 字节序写反了这一步就挂
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ephemeral = server.address().port;
  const live = mk('127.0.0.1', 443);
  assert.equal(f.sldPatchSaPort(live, { ip: '127.0.0.1', from: 443, to: ephemeral }), 1);
  const decoded = Number(f.sldSaV4(live).split(':')[1]);
  assert.equal(decoded, ephemeral, '解出来的端口要和真正在听的端口一致');
  const sock = net.connect(decoded, '127.0.0.1');
  try {
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  } finally {
    sock.destroy();
    server.close();
  }
});

// ---------------------------------------------------------------- 4. HTTP 桩
await check('HTTP 桩: 服务器列表/版本/登录/公告/未实现端点', async () => {
  const { server } = createHttpServer();
  await new Promise((r) => server.listen(19106, '127.0.0.1', r));
  const base = 'http://127.0.0.1:19106';
  const list = await (await fetch(`${base}/serverlist?channel=bilibili`)).json();
  assert.equal(list.code, 0);
  assert.equal(list.data[0].port, 19105, '列表里的网关端口要和实际监听一致');
  const ver = await (await fetch(`${base}/res_version`)).json();
  assert.equal(ver.data.buildVersion, config.server.buildVersion);
  const login = await (await fetch(`${base}/sdk/login`, { method: 'POST', body: '{"userId":"x"}' })).json();
  assert.equal(login.data.accessToken, 'offline-token');
  await (await fetch(`${base}/any/unknown/endpoint`)).json();
  const res = await (await fetch(`${base}/res/nope/x.ab`)).json();
  assert.equal(res.code, 0, '已删除 /res 兜底: 静态资源路径走未实现端点桩');
  const logFile = path.join(config.paths.logs, 'http-requests.jsonl');
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(lines.some((l) => l.path === '/any/unknown/endpoint'), '未实现端点必须被记录下来');
  server.close();
});

// ---------------------------------------------------------------- 4b. 战斗 (11028 进战斗最小闭环)
await check('GS 战斗: 11028 回 StartSoloBattle_S2C 含 battleEnterInfo', async () => {
  const { handleAppInterface } = await import(`../${DIST}/gs.js`);
  const pb = await import(`../${DIST}/proto.js`);
  // handleAppInterface 会落盘 gs-req-11028.fields.json(真实抓包记录), 备份后还原.
  const fieldsFile = path.join(config.paths.logs, 'gs-req-11028.fields.json');
  const backup = fs.existsSync(fieldsFile) ? fs.readFileSync(fieldsFile) : null;
  try {
    const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
    // StartSoloBattle{ battleId=101101, battleType=1, leaderSquadInfo{leaderSet:[2001001,2010001]}, multiRatio=1 }
    const squad = pb.concat(
      pb.vfield(1, 1),
      pb.bfield(2, pb.concat(pb.vfield(1, 1), pb.vfield(2, 2001001))),
      pb.bfield(2, pb.concat(pb.vfield(1, 2), pb.vfield(2, 2010001))),
    );
    const data = pb.concat(pb.vfield(1, 101101), pb.vfield(2, 1), pb.bfield(3, squad), pb.vfield(7, 1));
    const req = Buffer.concat([
      u32(0), u32(0), u32(0), u32(11028),
      u32(0), u32(0), u32(0), u32(0), u32(0), // 5 空串
      u32(4321), u32(data.length), data, u32(0),
    ]);
    const { body: reply } = handleAppInterface(req);
    const push = reply.subarray(9, 9 + reply.readInt32BE(5)); // [u8 prefix][i32 err][i32 pushLen]
    const rp = pb.decodeFields(push).find((f) => f.field === 1).value; // ReturnPackageInfo
    const core = pb.decodeFields(pb.decodeFields(rp).find((f) => f.field === 2).value).find((f) => f.field === 2).value;
    const s2c = pb.decodeFields(core);
    assert.equal(Number(s2c.find((f) => f.field === 1).value), 1, 'result 必须为 true');
    const bei = s2c.find((f) => f.field === 2)?.value;
    assert.ok(Buffer.isBuffer(bei), 'battleEnterInfo 必给');
    assert.equal(Number(pb.decodeFields(bei).find((f) => f.field === 4).value), 1, 'battleType 回显请求值');
    const bp = pb.decodeFields(bei).find((f) => f.field === 6).value;
    const leaderIds = pb.decodeFields(bp).filter((f) => f.field === 5)
      .map((f) => Number(pb.decodeFields(f.value).find((x) => x.field === 1).value));
    assert.deepEqual(leaderIds, [2001001, 2010001], '武将取自请求 leaderSet');
    assert.ok(s2c.find((f) => f.field === 3), 'server(战斗服) 必给');
  } finally {
    if (backup) fs.writeFileSync(fieldsFile, backup);
  }
});

// ---------------------------------------------------------------- 4c. 抽卡掉落链
await check('抽卡: 池 3116 掉落链完整解析, 不因递归深度误判返回 null', async () => {
  const { poolDraw } = await import(`../${DIST}/gacha.js`);
  // 真实链 Drop->DropSet->DropGroup 多层嵌套最深约 11 层; 上限过小会让约 1.6% 的
  // 单抽静默失败 -> SwearHero_S2C.number 与 rewards 数量不一致 (客户端结果不弹).
  let nulls = 0;
  const distinct = new Set();
  for (let i = 0; i < 20000; i++) {
    const r = poolDraw(3116);
    if (!r) nulls++;
    else distinct.add(r.itemId);
  }
  assert.equal(nulls, 0, 'poolDraw(3116) 不应返回 null');
  assert.ok(distinct.size > 1, '应能 roll 出多种奖励');
});

// ShowItem_Push 必须走 completedList: C# HandleResult 把 ReturnPackageInfo.bodyInfo 写进
// replenishList, 而 Lua HttpClientForLua.Ignore_Replenish_MsgID 会把 ShowItem_Push 过滤掉.
await check('抽卡: ShowItem_Push 走 completedList(PushMsg2Client), 主包在单包槽', async () => {
  const gs = await import(`../${DIST}/gs.js`);
  const pb = await import(`../${DIST}/proto.js`);
  const showItem = pb.concat(pb.vfield(1, 56), pb.bfield(2, pb.bfield(1, pb.concat(pb.vfield(1, 5033010), pb.vfield(2, 1)))));
  const p2c = gs.pushMsg2Client([[900009, showItem]]);
  const body = Buffer.from([0x08, 0x0a]);
  const frame = gs.frameReply(Buffer.alloc(0), 0, { header: 2000, body }, p2c);
  let o = 0;
  assert.equal(frame.readUInt8(o), 0); o += 1;                 // 压缩标志
  assert.equal(frame.readInt32BE(o), 0); o += 4;               // errorCode
  assert.equal(frame.readInt32BE(o), 0, 'replenish(ReturnPackagePush) 段应为空'); o += 4;
  assert.equal(frame.readInt32BE(o), 2000); o += 4;            // completed 单包槽 msgId
  const bodyLen = frame.readInt32BE(o); o += 4;
  assert.deepEqual([...frame.subarray(o, o + bodyLen)], [...body]); o += bodyLen;
  const p2cLen = frame.readInt32BE(o); o += 4;
  assert.equal(p2cLen, p2c.length);
  assert.equal(o + p2cLen, frame.length);
  const outer = pb.decodeFields(frame.subarray(o));
  assert.equal(Number(outer[0].field), 1, 'PushMsg2Client.pushBodys');    // pushBodys=1
  const pbBody = pb.decodeFields(outer[0].value);
  assert.equal(Number(pbBody[0].value), 900009, 'PushBody.header=ShowItem_Push'); // header=1
});

// 注意: 这条会真调 HANDLERS[2000](会写 data/save.json), 已备份/还原; 别和常驻假服同时跑抽卡.
// 十连结果页 UIGachaTenResultCtrl 硬编码等 10 个特效 (itemEffLoadCount==10 才 PlayShowAnim),
// 且 GachaResultItemCtrl 只对 Leader/Weapon 建卡 (其它类型 itemQuality=nil -> 崩). 所以 recordInfo.itemId
// 只能是抽到的本体; 重复角色的意识碎片必须只出现在 Rewards 里(par 指回本体).
await check('抽卡: recordInfo.itemId 恒为角色/律叶(碎片只进 Rewards.par)', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const pb = await import(`../${DIST}/proto.js`);
  const { LEADER } = await import(`../${DIST}/data/leader.js`);
  const { WEAPON } = await import(`../${DIST}/data/weapon.js`);
  const saveFile = config.paths.save;
  const backup = fs.existsSync(saveFile) ? fs.readFileSync(saveFile) : null;
  try {
    for (let t = 0; t < 40; t++) {
      const req = { msgId: 2000, packetUUid: t, proto: pb.concat(pb.vfield(1, 3116), pb.vfield(2, 10)) };
      const recs = pb.decodeFields(HANDLERS[2000](req).body).filter((f) => f.field === 5);
      assert.equal(recs.length, 10, '十连应回 10 条 recordInfo');
      for (const rec of recs) {
        const itemId = Number(pb.decodeFields(rec.value).find((f) => f.field === 1).value);
        assert.ok(LEADER[itemId] || WEAPON[itemId], `recordInfo.itemId=${itemId} 不是角色/律叶`);
      }
    }
  } finally {
    if (backup) fs.writeFileSync(saveFile, backup);
    else if (fs.existsSync(saveFile)) fs.unlinkSync(saveFile);
  }
});

// SLD_GACHA_FORCE_QUALITY=5: 出货强制金色本体(调试用). 断言十连 10 条 recordInfo 品质都为 5.
await check('抽卡: SLD_GACHA_FORCE_QUALITY=5 十连全金', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const pb = await import(`../${DIST}/proto.js`);
  const { config } = await import(`../${DIST}/config.js`);
  const { itemQuality } = await import(`../${DIST}/data/rarity.js`);
  const saveFile = config.paths.save;
  const backup = fs.existsSync(saveFile) ? fs.readFileSync(saveFile) : null;
  const prev = config.gacha.forceQuality;
  const prevType = config.gacha.forceType;
  config.gacha.forceQuality = 5;
  try {
    for (let t = 0; t < 5; t++) {
      const req = { msgId: 2000, packetUUid: t, proto: pb.concat(pb.vfield(1, 3116), pb.vfield(2, 10)) };
      const recs = pb.decodeFields(HANDLERS[2000](req).body).filter((f) => f.field === 5);
      assert.equal(recs.length, 10, '十连应回 10 条 recordInfo');
      for (const rec of recs) {
        const itemId = Number(pb.decodeFields(rec.value).find((f) => f.field === 1).value);
        assert.equal(itemQuality(itemId), 5, `强制金: recordInfo.itemId=${itemId} 品质应为 5`);
      }
    }
    const { LEADER } = await import(`../${DIST}/data/leader.js`);
    config.gacha.forceType = 'leader';
    const req = { msgId: 2000, packetUUid: 99, proto: pb.concat(pb.vfield(1, 3116), pb.vfield(2, 10)) };
    const recs = pb.decodeFields(HANDLERS[2000](req).body).filter((f) => f.field === 5);
    assert.equal(recs.length, 10, '十连应回 10 条 recordInfo');
    for (const rec of recs) {
      const itemId = Number(pb.decodeFields(rec.value).find((f) => f.field === 1).value);
      assert.equal(itemQuality(itemId), 5, `强制金角色: itemId=${itemId} 品质应为 5`);
      assert.ok(LEADER[itemId], `强制金角色: itemId=${itemId} 应是角色`);
    }
  } finally {
    config.gacha.forceQuality = prev;
    config.gacha.forceType = prevType;
    if (backup) fs.writeFileSync(saveFile, backup);
    else if (fs.existsSync(saveFile)) fs.unlinkSync(saveFile);
  }
});

// 抽到新角色时必须在 extra 里后置 Data_Push(900011){ leaderAttrChanged=5{ leaderInfo=1[...] } },
// 否则大厅角色表只会走登录的 PlayerLoginGetInfo.leaderInfo —— 抽完不重登看不到新角色.
await check('抽卡: 新角色后置 Data_Push(leaderAttrChanged)', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const pb = await import(`../${DIST}/proto.js`);
  const { config } = await import(`../${DIST}/config.js`);
  const { LEADER } = await import(`../${DIST}/data/leader.js`);
  const { DEFAULT_SAVE } = await import(`../${DIST}/save.js`);
  const saveFile = config.paths.save;
  const backup = fs.existsSync(saveFile) ? fs.readFileSync(saveFile) : null;
  const prevQ = config.gacha.forceQuality, prevT = config.gacha.forceType;
  try {
    // 清空已拥有角色 -> 保证这一抽全是"新获得".
    const base = backup ? JSON.parse(backup.toString('utf8')) : DEFAULT_SAVE;
    fs.writeFileSync(saveFile, JSON.stringify({ ...base, characters: [], weapons: [] }, null, 2));
    config.gacha.forceQuality = 5;
    config.gacha.forceType = 'leader';
    const req = { msgId: 2000, packetUUid: 1, proto: pb.concat(pb.vfield(1, 3116), pb.vfield(2, 10)) };
    const res = HANDLERS[2000](req);
    const dataPush = (res.extra || []).find(([h]) => h === 900011);
    assert.ok(dataPush, 'extra 应含 Data_Push(900011)');
    const dp = pb.decodeFields(dataPush[1]);
    const lac = dp.find((f) => f.field === 5);            // leaderAttrChanged=5
    assert.ok(lac, 'Data_Push 应有 leaderAttrChanged=5');
    const infos = pb.decodeFields(lac.value).filter((f) => f.field === 1); // repeated LeaderInfo
    assert.ok(infos.length >= 1, 'leaderAttrChanged.leaderInfo 至少 1 条');
    const drawn = new Set(pb.decodeFields(res.body).filter((f) => f.field === 5)
      .map((r) => Number(pb.decodeFields(r.value).find((f) => f.field === 1).value)));
    for (const i of infos) {
      const id = Number(pb.decodeFields(i.value).find((f) => f.field === 1).value); // LeaderInfo.id=1
      assert.ok(LEADER[id], `leaderInfo.id=${id} 应是角色`);
      assert.ok(drawn.has(id), `leaderInfo.id=${id} 应是本次抽到的角色`);
    }
  } finally {
    config.gacha.forceQuality = prevQ;
    config.gacha.forceType = prevT;
    if (backup) fs.writeFileSync(saveFile, backup);
    else if (fs.existsSync(saveFile)) fs.unlinkSync(saveFile);
  }
});

// ---------------------------------------------------------------- 4d. 整表取数面 (src/tbl.ts)
// 这一条钉的是"值从客户端真表来"这个口径本身, 不是某张表的内容: 换资源包后数字会变, 所以
// 只断言三件事 —— 能取到值/式杖上限的坑不复发/生成器还能跑。
await check('tbl: 整表取数面可用, 式杖上限只认 TalentSkill 不信 Skill.maxLevel', async () => {
  const t = await import(`../${DIST}/tbl.js`);
  assert.ok(t.has('TalentSkill') && t.has('SignActivity'), 'src/data/tbl 没生成? 跑 python3 tools/gen_tables.py --tier 1');
  assert.equal(t.num('PlayerGrow', 7, 'exp'), 20, 'PlayerGrow[7].exp 应是 20 (对过 Lua 明文)');
  assert.deepEqual(t.arr('LeaderWandSkill', '20010011', 'skillId'), [6311053, 6311050],
    '数组列必须归一成 list, 否则调用点取不到 [1]/[2]');
  // 式杖技能每级的行在 TalentSkill_Xls 里; Skill_Xls.maxLevel 对式杖恒为 1, 拿它判上限会把
  // 每个技能都判成满级 -> 升级永远被拒(路 B mockgs_pc.lua:4070 的同一坑)。
  assert.equal(t.maxOf('TalentSkill', 'skillLevel', (r) => r.skillId === 1800000), 10,
    '式杖 1800000 在 TalentSkill 应有 1..10 级');
  assert.equal(t.num('Skill', 1800000, 'maxLevel', 1), 1, 'Skill.maxLevel 对式杖恒为 1 —— 别拿它当上限');
  t.row('Skill', 99999999999);
  assert.match(t.missReport(), /Skill:1/, '取不到的行必须被计数');
  t.resetMissed();
  assert.equal(t.missReport(), '');
});

await check('tbl: tools/gen_tables.py 能重跑(--check, 不落盘)', async () => {
  if (!fs.existsSync('/home/tmp/apklua_plain/toLua') || !fs.existsSync('/home/sld/res/phone/luaplain/toLua')) {
    return results.push(['SKIP', '两棵 toLua 树不全, 跳过整表生成器自检']);
  }
  const { stderr } = await exec(py, [path.join(ROOT, 'tools/gen_tables.py'), '--tier', '1', '--check'],
    { maxBuffer: 8 << 20 });
  assert.match(stderr, /SignActivity_Xls\s+rows=7/, '签到表应能解析(它是 APK-only)');
  assert.match(stderr, /TalentSkill_Xls\s+rows=\d+\s+EXT=\d+\s+APK=\d+\s+merged=/, '合并口径要报 merged');
});

// ---------------------------------------------------------------- 4e. 存档层 (A4)
// normalizeSave 是逐键白名单重建: 新块只在 DEFAULT_SAVE/接口里加了、忘了登记这里, 写盘会成功而
// 读回即丢(静默). 这两条守卫把"漏登记"变成红灯: 全字段档往返必须一条不掉, 顶层键集必须相等.
const saveFixture = () => ({
  prologue: { done: true, id: 'pro1' },
  player: {
    uid: 10002, name: '测试', sex: 1, level: 30, exp: 1200, maxExp: 1300,
    strength: 88, maxStrength: 240, shipStrength: 66, maxShipStrength: 120,
    secretary: 2010001, strengthRealTime: 1700000000,
  },
  characters: [{
    id: 2001001, level: 42, exp: 999, star: 0, starLevel: 2, breach: 5,
    attrs: { '100': 999999 }, favorabilityLevel: 3, favorabilityExp: 120,
    clothingId: 30001, weaponId: '7000001', signLv: 2, perkId: 'perk1',
    activeLv: { '10001': 2 }, talentLv: { '20001': 1 },
    stick: { '6311053': 1 }, stickLv: { '6311053': 3 },
  }],
  weapons: [{
    onlyId: '7000001', cfg: 5001001, leaderId: 2001001, level: 20, breach: 3, exp: 100,
    refine: 2, lock: 1, skin: 5, recastingTime: 3, recastingSkillTime: 1,
    rand: { skill: [6311053], key: [100, 101], val: [55, 66], poolIdx: [1, 2], attrIdx: [0, 1], scope: 3 },
    last: { skill: [], key: [102], val: [77], poolIdx: [3], attrIdx: [2], scope: 0 },
  }],
  items: { '1020004': 3 }, money: { '1': 9 }, cloths: [30001], wskin: [40001],
  // B4 起主线关记录也是完整记录(挂机要读 passTime 当单场时长), 不再是"id -> 星级数组"
  levels: { '101101': { id: 101101, passTime: 42, todayAttackNum: 3, attackNum: 5, lastAttackTime: 1700000000000, stars: [1, 2, 3] } },
  trainLevels: { '101101': { id: 101101, passTime: 45, todayAttackNum: 2, attackNum: 7, lastAttackTime: 1700000000000 } },
  gacha: { '3116': 20 },
  signin: { month: 20016, times: 5, day: 4, lastTime: 1700000000000 },
  tasks: {
    taskChapter: 102, dayGroupIndex: 10002, dayTaskPoint: 30, weekTaskPoint: 80,
    passedTasks: { '3100': 1 }, counters: { 'day:1502:13': 20, 'total:1802': 3 },
    passedDayPoints: [1, 2], passedWeekPoints: [3], rollDay: 1700000000000, rollWeek: 1700000000000,
  },
  bg: { open: 1700000000, sign: 3, signTime: 1700000000, bingo: [1, 2], redDot: true },
  bgVersion: 1,
  hangUp: { type: 2, levelId: 101101, times: 5, startTime: 1700000000, endTime: 1700003000, state: 1 },
  wSeq: 7, regTime: 1700000000,
});

await check('save: normalizeSave 全字段往返不丢 (漏登记即红灯)', async () => {
  const { normalizeSave } = await import(`../${DIST}/save.js`);
  const fx = saveFixture();
  const got = normalizeSave(fx);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(fx).sort(), '顶层键集必须相等');
  assert.deepEqual(got, fx, 'normalizeSave 丢字段或改值');
  // 落盘 -> 读回的真实链路就是 JSON 文本, 再过一遍必须幂等.
  assert.deepEqual(normalizeSave(JSON.parse(JSON.stringify(got))), fx, '经 JSON 文本往返不幂等');
  // 老档的 levels 是 "id -> 星级数组", 升级成记录时必须补一个能用的单场时长(30), 星级不能丢
  const legacy = normalizeSave({ levels: { '101101': [3] } });
  assert.equal(legacy.levels['101101'].passTime, 30, '老档主线关该兜 30 秒单场时长');
  assert.deepEqual(legacy.levels['101101'].stars, [3], '老档的星级不能因为换形状就丢了');
});

// 老档(只有 A4 之前的那些键, trainLevels 还是 number[])必须被 loadSave 升上来, 且第二次读不再改.
// 这条会写真档 data/save.json(+.bak), 已整体备份还原; 别和常驻假服同时跑.
await check('save: 老档经 loadSave 升级 + 原子写留 .bak', async () => {
  const { loadSave, BG_SCHEMA } = await import(`../${DIST}/save.js`);
  const files = [config.paths.save, config.paths.save + '.bak'];
  const backup = files.map((p) => (fs.existsSync(p) ? fs.readFileSync(p) : null));
  const oldShape = {
    prologue: { done: true, id: 'pro1' },
    player: { uid: 10002, name: '旧号', sex: 1, level: 12, exp: 5, maxExp: 100, strength: 60, maxStrength: 100, shipStrength: 50, maxShipStrength: 100, secretary: 2001001 },
    characters: [{ id: 2001001, level: 7 }],
    weapons: [{ onlyId: '70000002001001', cfg: 5001001, leaderId: 2001001, level: 1 }],
    items: { '1020004': 2 }, money: { '1': 3 }, cloths: [], wskin: [],
    levels: { '101101': [3] }, trainLevels: [101101], gacha: { '3116': 5 },
    signin: { month: 20016, times: 1, day: 1, lastTime: 1 },
  };
  try {
    fs.writeFileSync(files[0], JSON.stringify(oldShape, null, 2) + '\n');
    const s = loadSave();
    assert.equal(s.player.name, '旧号', '老档的值不能被回退成默认');
    assert.equal(s.bgVersion, BG_SCHEMA, 'migrateSave 没跑');
    assert.ok(s.regTime > 0 && s.bg.open > 0, '锚点 regTime/bg.open 没补');
    assert.ok(s.player.strengthRealTime > 0 && s.tasks.rollDay > 0, '体力回算/任务刷新锚点没补');
    assert.deepEqual(Object.keys(s.trainLevels), ['101101'], '老档的 number[] 要升成 { id: 记录 }');
    assert.equal(s.trainLevels['101101'].passTime, 30, 'passTime 兜底必须是 30 秒(给 0 会算空奖励池)');
    assert.ok(s.characters[0].activeLv && s.weapons[0].rand, '新增的子字段没补齐');
    assert.ok(fs.existsSync(files[0]), 'migrate 命中就得落盘, 光在内存里补等于没补');
    assert.ok(fs.existsSync(files[1]), 'saveSave 要把上一版留成 .bak');
    assert.equal(loadSave().bgVersion, BG_SCHEMA, '第二次读不该再改结构');
    // 半截文件: 老实现一口回默认档 = 整档静默回滚成新号; 现在必须吃 .bak.
    fs.writeFileSync(files[0], '{"player":{"name":"截到此');
    assert.equal(loadSave().player.name, '旧号', 'save.json 坏了要回退 .bak, 不能回新号');
  } finally {
    files.forEach((p, i) => { if (backup[i]) fs.writeFileSync(p, backup[i]); else if (fs.existsSync(p)) fs.unlinkSync(p); });
  }
});

// ---------------------------------------------------------------- 4f. 经济/技能原语 (A5)
// 全部喂内存档(normalizeSave 出来的), 不碰 data/save.json —— 原语的签名就是 (s, ...).
// 断言里每个数都取自客户端表本身, 不是拍脑袋: 见行内注释的表/行.
await check('econ: 扣费/发奖只认客户端表, 不足一分不扣', async () => {
  const { normalizeSave } = await import(`../${DIST}/save.js`);
  const e = await import(`../${DIST}/econ.js`);
  const t = await import(`../${DIST}/tbl.js`);
  const s = normalizeSave({
    player: { level: 10, exp: 0, strength: 50, maxStrength: 158, strengthRealTime: Math.floor(Date.now() / 1000) },
    items: { '1020004': 5 }, money: { '10': 5000 },
  });
  const eff = e.newEffects();
  // 类型分流 (ItemTypes_Xls): 13=感知(9/4) 1=精神冗余(9/5) 2001001=角色(5) 5011010=武装(3)
  assert.deepEqual(e.itemType(13), { type: 9, sub: 4 }, '感知必须是 Hero_Prop/体力');
  assert.equal(e.itemType(1).sub, 5, '精神冗余必须是导师经验');
  assert.equal(e.itemType(2001001).type, 5);
  assert.equal(e.itemType(5011010).type, 3);
  // 体力量读 player.strength —— 它不在 items 里, 按道具条目查会永远查不到.
  assert.equal(e.countItem(s, 13), 50, 'countItem 对感知要回体力值');
  // 不足一分不扣 (路 B "先全验再扣")
  assert.equal(e.costItem(s, 1020004, 6, eff), false);
  assert.equal(s.items['1020004'], 5, '扣不动时不能改动存档');
  assert.equal(e.costItem(s, 1020004, 2, eff), true);
  assert.equal(s.items['1020004'], 3);
  // payItemList: 一条不够 -> 全单不扣; 够 -> 按 Items_Xls.useParam[1] 折经验(战斗评估报告IV=2000/份)
  const [badExp, why] = e.payItemList(s, [{ key: 1020004, value: 1 }, { key: 1020001, value: 9999 }], eff);
  assert.equal(badExp, 0);
  assert.match(why, /^lack /);
  assert.equal(s.items['1020004'], 3, '校验失败不能已经扣掉前面那条');
  const [exp] = e.payItemList(s, [{ key: 1020004, value: 2 }], eff);
  assert.equal(exp, 2000 * 2, 'useParam[1] 折经验');
  assert.equal(s.items['1020004'], 1);
  // Consume_Xls 1002 = { itemId:[10], num:[1000] }
  assert.deepEqual(t.arr('Consume', 1002, 'itemId'), [10]);
  assert.equal(e.payConsume(s, 1002, eff), true);
  assert.equal(s.money['10'], 4000, '货币从 money 表里扣');
  // 发奖多态: 501001 是 FixedReward_Xls 行, 501100 是 Drop_Xls 行 —— 只查前者会让后者一分钱不发
  const r1 = e.rewardById(s, 501001, eff);
  assert.equal(r1.length, 4, '固定组应发满 4 条');
  assert.ok(r1.some((x) => x.itemId === 10 && x.count === 2650));
  assert.equal(s.money['10'], 4000 + 2650, 'type=Money 的条目必须进 money');
  const r2 = e.rewardById(s, 501100, eff);
  assert.deepEqual(r2, [{ itemId: 10, count: 1000 }], 'Drop 单条必掉');
  const { dropAll } = await import(`../${DIST}/gacha.js`);
  assert.equal(dropAll(100101).length, 2, '两条 probability=10000 的行要整批发');
  // 路由: 角色进 characters / 武装建实例并换 wSeq 号 / 皮肤进 cloths / 精神冗余加导师经验
  const before = s.characters.length;
  e.addItem(s, 2002001, 1, eff);
  assert.equal(s.characters.length, before + 1, '新角色要进 characters[]');
  assert.deepEqual(eff.leaders, [2002001]);
  e.addItem(s, 5011010, 2, eff);
  assert.equal(s.weapons.length, 2, '武装必须实例化(教程 10713 的替换列表读的就是它)');
  assert.equal(s.weapons[0].onlyId, '70000001');
  assert.notEqual(s.weapons[0].onlyId, s.weapons[1].onlyId, 'wSeq 发号不能撞');
  assert.equal(s.wSeq, 2);
  e.addItem(s, 4001101, 1, eff);
  assert.deepEqual(s.cloths, [4001101], '战装不入 items, 进 cloths 才算拥有');
  // 喂"当前级所需经验"而不是 PlayerGrow[1].exp: 本级 10 要 40, 给 20 根本不滚级, 下面两条断言就是空转
  s.player.strength = 50;
  const need = t.num('PlayerGrow', s.player.level, 'exp', 0);
  const [olv, nlv] = e.addExp(s, need, eff);
  assert.ok(nlv > olv, `PlayerGrow 曲线升级: 给本级需要的 ${need} 经验却没滚级`);
  assert.equal(s.player.strength, 50 + t.num('PlayerGrow', nlv, 'addPower', 0), '升级送的那笔体力必须真入账(客户端只改上限)');
  // 回算只补不削: 溢出上限的体力不能被钳回去
  s.player.strength = 999;
  s.player.strengthRealTime = Math.floor(Date.now() / 1000) - 86400;
  e.catchUpStrength(s);
  assert.equal(s.player.strength, 999, 'catchUpStrength 不能把溢出体力抹回上限');
});

await check('skills: 式杖上限只读 TalentSkill, 满级/材料不足不推进', async () => {
  const { normalizeSave, characterById } = await import(`../${DIST}/save.js`);
  const e = await import(`../${DIST}/econ.js`);
  const sk = await import(`../${DIST}/skills.js`);
  const s = normalizeSave({ player: { level: 10, strength: 200, strengthRealTime: Math.floor(Date.now() / 1000) } });
  const c = characterById(s, 2001001);
  s.characters = [c];
  const eff = e.newEffects();
  // 式杖 1800000: TalentSkill_Xls 里 skillLevel 1..10 -> 上限 10; Skill_Xls.maxLevel 恒 1, 用了就全判满级
  assert.equal(sk.stickMaxLv(1800000), 10);
  assert.equal(sk.skillLv(c, 1800000, 'stick'), 1, '没登记按 1 级起');
  assert.deepEqual(sk.upgradeSkill(s, c, 1800000, 'stick', eff), [true, '']);
  assert.equal(sk.skillLv(c, 1800000, 'stick'), 2);
  sk.setSkillLv(c, 1800000, 'stick', 10);
  const [okMax, whyMax] = sk.upgradeSkill(s, c, 1800000, 'stick', eff);
  assert.equal(okMax, false, '满级必须拒绝(客户端只靠"有没有 push"判未升级)');
  assert.match(whyMax, /stickMax/);
  assert.equal(sk.skillLv(c, 1800000, 'stick'), 10, '拒绝时不能改等级');
  // 主动技能: 上限双卡 = LeaderBreak_Xls[本突].skillLevel(2001001: 0突=1, 1突=4) 与 Skill_Xls.maxLevel(=10).
  // 用 20010120 (法尼娅的主动技)而不是随手一个 id: 102 那行 Skill.maxLevel=1, 按真服口径本就不可升.
  assert.equal(sk.skillBreakCap(2001001, 0), 1);
  assert.equal(sk.skillBreakCap(2001001, 1), 4);
  assert.equal(sk.skillConsumeId(20010120, 1, 'active'), 20011201);
  assert.ok(sk.skillRow(20010120, 1, 'active'), 'SkillValue_Xls 里 (skillId,1) 那行必须查得到');
  const [okCap, whyCap] = sk.upgradeSkill(s, c, 20010120, 'active', eff);
  assert.equal(okCap, false, '0 突时主动技能上限 1, 不该升');
  assert.match(whyCap, /breakCap/);
  c.breach = 1;
  s.items = {}; // 材料清零
  const [okNo, whyNo] = sk.upgradeSkill(s, c, 20010120, 'active', eff);
  assert.equal(okNo, false, '材料不足必须拒绝');
  assert.match(whyNo, /^cost lack /);
  assert.equal(sk.skillLv(c, 20010120, 'active'), 1, '材料不足不能先把等级升上去');
  // 补齐 Consume_Xls[20011201] = {货币10 x20000, 1070001 x24} 后应升上去, 且真扣到东西
  s.items['1070001'] = 24;
  s.money['10'] = 20000;
  const [okUp] = sk.upgradeSkill(s, c, 20010120, 'active', eff);
  assert.equal(okUp, true, '补齐材料后应升级成功');
  assert.equal(sk.skillLv(c, 20010120, 'active'), 2);
  assert.equal(s.money['10'], 0, '消耗要真扣');
  assert.equal(s.items['1070001'], 0);
});

// ---------------------------------------------------------------- 4g. proto required 自检 + handler 驱动 (A6)
// 手写 wire format 的失败模式是"少发一个 required": 编译不响、端到端不响, 只有客户端解析那一刻
// 才崩或面板空白。proto_schema.mjs 把 proto/*.proto 的 required 集读出来当断言输入;
// checkHandler() 是 B1~B6 每条新 handler 的公共外壳(查回体 required + 手写串号断言 + 落盘回读)。
const ps = await import('./proto_schema.mjs');

// handler 会真写档 -> 每条用例自己备份/还原, 跑完 data/save.json 必须回到原样。
function useSave(content) {
  const backup = fs.existsSync(SAVE_FILE) ? fs.readFileSync(SAVE_FILE) : null;
  if (content !== undefined) {
    fs.writeFileSync(SAVE_FILE, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return () => {
    if (backup) fs.writeFileSync(SAVE_FILE, backup);
    else if (fs.existsSync(SAVE_FILE)) fs.unlinkSync(SAVE_FILE);
  };
}

// 通用驱动: 不起 socket, 直接调 HANDLERS[msgId](req) 再拿 proto 对回包。
// opt: cmd(默认按 CmdDefine 反查) · s2c(默认 `${cmd}_S2C`, 显式传 null 表示"proto 里没有回体消息")
//      req(C2S Buffer) · save(跑前写进 data/save.json 的档) · fields(dec,ctx) 手写字段号断言(防 1-vs-2 串号)
//      push([[推送头, 消息名]]) · after(loadSave() 的结果, ctx) 断言真落盘了
//      deny(RegExp|true): 期望 handler 拒单 —— 拒单**不该有回体也不该改档**, 所以这时跳过
//      required 断言、改跑 opt.after 去断言"什么都没变"(材料没扣、等级没动)。
async function checkHandler(title, msgId, opt = {}) {
  await check(title, async () => {
    const { HANDLERS } = await import(`../${DIST}/payloads.js`);
    const pb = await import(`../${DIST}/proto.js`);
    const { loadSave } = await import(`../${DIST}/save.js`);
    const h = HANDLERS[msgId];
    assert.ok(h, `HANDLERS[${msgId}] 未注册`);
    const cmd = opt.cmd ?? ps.cmdOf(msgId);
    assert.ok(cmd, `CmdDefine 里查不到 ${msgId} 这条命令`);
    const s2c = opt.s2c === undefined ? `${cmd}_S2C` : opt.s2c;
    if (s2c) assert.ok(ps.hasMsg(s2c), `proto 里没有 ${s2c} —— 消息名写错的断言等于没写`);
    const depth = opt.depth ?? 3;
    const restore = useSave(opt.save);
    try {
      const res = h({ msgId, packetUUid: opt.uid ?? 1, proto: opt.req ?? Buffer.alloc(0), headerHex: '' });
      const ctx = {
        pb, ps, res,
        // 推送在 pushes(随主包的 packetBodyInfoS) 或 extra(后一包), 两处都找得到才算数。
        push: (head) => {
          const p = (res.pushes ?? []).find(([hh]) => hh === head) ?? (res.extra ?? []).find(([hh]) => hh === head);
          return p ? pb.decodeFields(p[1]) : null;
        },
      };
      if (opt.deny) {
        assert.ok(!Buffer.isBuffer(res) && res.deny, `期望拒单, 实际回了 body=${(res.body ?? res).length}B`);
        if (opt.deny !== true) assert.match(res.deny, opt.deny, `拒单原因不对: ${res.deny}`);
        assert.equal((res.pushes ?? []).length + (res.extra ?? []).length, 0, '拒单不该带任何推送(推送会让客户端刷新/弹窗)');
        if (opt.after) opt.after(loadSave(), { ...ctx, dec: [] });
        return;
      }
      const body = Buffer.isBuffer(res) ? res : res.body;
      assert.ok(Buffer.isBuffer(body), `${cmd} 的回包不是 Buffer`);
      const dec = pb.decodeFields(body);
      if (s2c) ps.assertRequired(`${cmd}(${msgId}) 回包`, s2c, dec, { pb, maxDepth: depth });
      for (const [head, msg] of opt.push ?? []) {
        const d = ctx.push(head);
        assert.ok(d, `pushes/extra 里没有推送 ${head} (${msg})`);
        ps.assertRequired(`${cmd}(${msgId}) 推送 ${head}`, msg, d, { pb, maxDepth: depth });
      }
      if (opt.fields) opt.fields(dec, { ...ctx, body, has: (n) => ps.hasField(dec, n) });
      if (opt.after) opt.after(loadSave(), { ...ctx, dec });
    } finally {
      restore();
    }
  });
}

await check('proto: .proto 解析器读得出 required, 少发一个就红灯', async () => {
  const pb = await import(`../${DIST}/proto.js`);
  const st = ps.stats();
  // 数字是实测值(1305 消息 / 643 命令 / 2069 required), 留三成余量: 解析器退化或 proto 被动过会掉穿
  assert.ok(st.messages > 900 && st.cmds > 450 && st.requiredFields > 1400, `解析结果异常: ${JSON.stringify(st)}`);
  assert.equal(ps.msgIdOf('UpgradeStickSkill'), 1016, '1016 只存在于客户端明文, A1 补进 CmdDefine 后必须查得到');
  assert.equal(ps.msgIdOf('GetLeaderInfo'), 1015);
  // Step 0 里"不能共用同一个回体构造器"的三处, 全部固化成断言:
  const reqOf = (m) => ps.requiredOf(m).map((r) => `${r.no}:${r.type} ${r.name}`);
  assert.deepEqual(reqOf('SubmitTask_S2C'), ['5:int32 weekTaskPoint']);
  assert.deepEqual(reqOf('BatchSubmitTask_S2C'), ['4:int32 weekTaskPoint'], '同名字段在两条任务协议里号不同');
  assert.deepEqual(reqOf('HangUpInfo'), ['6:int64 state'], '兜底空包会漏掉这个 required');
  assert.deepEqual(ps.requiredOf('HangUpSweep_S2C').map((r) => r.name), ['settleInfo'], '扫荡回包没有 info 字段');
  assert.deepEqual(ps.requiredOf('LeaderInfo').map((r) => r.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 22, 25]);
  // 负控 A: 齐 -> 过 (TrainLevelInfo required = id=1, passTime=8)
  const good = pb.concat(pb.vfield(1, 101101), pb.vfield(2, 3), pb.vfield(8, 30));
  assert.ok(ps.assertRequired('负控A', 'TrainLevelInfo', pb.decodeFields(good), { pb }).length === 2);
  // 负控 B: 少发 passTime -> 必须抛 (这正是 selftest 结构上抓不到、真机表现为"秒数为 0"的那类)
  assert.throws(() => ps.assertRequired('负控B', 'TrainLevelInfo',
    pb.decodeFields(pb.concat(pb.vfield(1, 101101))), { pb }), /8 int32 passTime 缺失/);
  // 负控 C: 类型/字段号串了 -> wire 型对不上也抛
  assert.throws(() => ps.assertRequired('负控C', 'TrainLevelInfo',
    pb.decodeFields(pb.concat(pb.vfield(1, 101101), pb.sfield(8, '30'))), { pb }), /8 passTime 是 wire=2/);
  // 负控 D: 子消息里的 required 同样要抓到 (Data_Push 的 leaderAttrChanged -> LeaderInfo 缺 weaponId)
  const liShort = pb.concat(pb.vfield(1, 2001001), pb.vfield(2, 1), pb.vfield(3, 0), pb.vfield(4, 0),
    pb.vfield(5, 0), pb.vfield(6, 0), pb.vfield(7, 0), pb.vfield(8, 0)); // 故意不写 9 weaponId
  const liFull = pb.concat(liShort, pb.sfield(9, ''), pb.vfield(22, 0), pb.sfield(25, ''));
  assert.ok(ps.assertRequired('负控D', 'LeaderInfo', pb.decodeFields(liFull), { pb }).length > 0);
  assert.throws(() => ps.assertRequired('负控D', 'LeaderInfo', pb.decodeFields(liShort), { pb }), /9 string weaponId 缺失/);
});

// 已注册的全部 handler 过一遍 required: 空请求是最坏输入(走各 handler 的兜底分支), 兜底包也得合规.
await check('proto: 已注册 handler 的回包 required 全覆盖 (空请求兜底)', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const pb = await import(`../${DIST}/proto.js`);
  const ACK_ONLY = {                       // proto 里本就没有回体消息, 只回通用 ack
    11018: 'BattleSettle 无消息体',
    11019: 'BattleLeave 无 _S2C(BattleLeave 是请求体)',
  };
  const NAMING = {                         // 不守 `<cmd>_S2C` 命名的少数: 写死, 免得靠猜把断言猜空
    11032: 'BattleLeaveFinish_S2C',        // CmdDefine 的号名本身就以 _S2C 结尾
    21001: 'GetAllActivity_s2c',           // 全 proto 里唯一的小写 s2c
  };
  const restore = useSave(undefined);
  let checked = 0, withReq = 0, denied = 0;
  try {
    for (const id of Object.keys(HANDLERS).map(Number).sort((a, b) => a - b)) {
      const cmd = ps.cmdOf(id);
      assert.ok(cmd, `HANDLERS[${id}] 在 CmdDefine 里查不到号`);
      if (ACK_ONLY[id]) continue;
      const s2c = NAMING[id] ?? `${cmd}_S2C`;
      assert.ok(ps.hasMsg(s2c), `${id} ${cmd}: 回体消息 ${s2c} 不在 proto 里(改名或解析退化)`);
      const res = HANDLERS[id]({ msgId: id, packetUUid: 1, proto: Buffer.alloc(0), headerHex: '' });
      // 空请求 = 没有 leaderId, 养成类必须**拒单**(gs.ts 回 header=0), 而不是编一个等级没变的回体.
      if (!Buffer.isBuffer(res) && res.deny) {
        assert.match(res.deny, /.+/, `${id} ${cmd}: deny 原因是空串`);
        assert.equal((res.pushes ?? []).length, 0, `${id} ${cmd}: 拒单还带推送`);
        denied++;
        continue;
      }
      const body = Buffer.isBuffer(res) ? res : res.body;
      ps.assertRequired(`${cmd}(${id}) 空请求回包`, s2c, pb.decodeFields(body), { pb, maxDepth: 2 });
      checked++;
      if ((ps.requiredOf(s2c) ?? []).length) withReq++;
    }
  } finally {
    restore();
  }
  assert.equal(checked + denied, Object.keys(HANDLERS).length - Object.keys(ACK_ONLY).length,
    '有条 handler 既没回合规包也没拒单(从这条检查里漏出去了)');
  assert.ok(checked >= 38, `应有 38 条以上带消息体的 handler, 现在只有 ${checked}`);
  assert.ok(denied >= 16,
    `养成 9 条(1001/1002/1003/1004/1005/1008/1010/1011/1016) + 武装 7 条(1201/1202/1204/1205/1207/1208/1209)`
    + ` 空请求都该拒单, 实际拒了 ${denied} 条`);
  assert.ok(withReq >= 12, `带 required 的回包只有 ${withReq} 条被真查过, 覆盖面退化`);
});

await check('proto: 注册表完整 (基线 handler 不掉 / 第一档进度对得上)', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const registered = new Set(Object.keys(HANDLERS).map(Number));
  // 主线独有(登录/创角/战斗握手) + 第一档要重构的两条: 任何时候掉出注册表都是事故.
  // (9999 心跳不在 HANDLERS 里, 由 gs.ts 直接回, 所以不进这张表)
  const MUST_KEEP = [10000, 10002, 10003, 10004, 10100, 11003, 11018, 11019, 11028, 11031, 11032, 1001, 3004];
  for (const id of MUST_KEEP) assert.ok(registered.has(id), `${id}(${ps.cmdOf(id) ?? '?'}) 不该从注册表里消失`);
  // 第一档 28 条新命令 (号逐条取自 proto/CmdDefine.proto, 上面已核)
  const TIER1_NEW = [1002, 1003, 1004, 1005, 1008, 1010, 1011, 1016,          // B1 养成
    1201, 1202, 1204, 1205, 1207, 1208, 1209,                                 // B2 武装
    3005,                                                                     // B3 通关
    30400, 30401, 30402, 30403, 30404, 30405,                                  // B4 挂机
    3301, 3302, 3303, 3306, 3308, 3309];                                       // B5 任务 + B6 签到
  assert.equal(TIER1_NEW.length, 28, '第一档清单必须正好 28 条');
  assert.equal(new Set(TIER1_NEW).size, 28, '清单里有重复号');
  for (const id of TIER1_NEW) assert.ok(ps.cmdOf(id), `${id} 不是 CmdDefine 里的合法号`);
  // TIER1_DONE 每批做完往里加; "未注册数" 必须等于"声明还没做的数量" —— 偷偷接了不登记就红灯
  const TIER1_DONE = [1002, 1003, 1004, 1005, 1008, 1010, 1011, 1016,   // B1 养成(1001 重构不在此列)
    1201, 1202, 1204, 1205, 1207, 1208, 1209,                            // B2 武装
    3005,                                                                 // B3 通关
    30400, 30401, 30402, 30403, 30404, 30405,                          // B4 挂机
    3302, 3303, 3308, 3309,                                              // B5 任务 (3304 基线就有, 不在此列)
    3301, 3306];                                                        // B6 签到/七日
  const stillMissing = TIER1_NEW.filter((id) => !registered.has(id)).sort((a, b) => a - b);
  const declared = TIER1_NEW.filter((id) => !TIER1_DONE.includes(id)).sort((a, b) => a - b);
  assert.deepEqual(stillMissing, declared,
    `注册表与 TIER1_DONE 对不上: 实际缺 ${stillMissing.length} 条, 声明缺 ${declared.length} 条`);
  for (const id of TIER1_DONE) assert.ok(registered.has(id), `TIER1_DONE 里的 ${id} 其实没注册`);
});

// 驱动本身也得被跑一遍, 否则等 B1 用的时候才知道它写错了: 拿三条现有 handler 当样本.
await checkHandler('checkHandler: 现有 10002 PlayerLoginGetInfo 回体合规', 10002, {
  fields: (dec, { has }) => {
    assert.ok(has(4), 'PlayerLoginGetInfo_S2C 必须有 leaderInfo=4');
    assert.ok(has(64), '必须有 trainLevelInfo=64');
  },
  after: (s) => assert.ok(s.characters.length > 0, '读档口径: handler 看到的存档非空'),
});
await checkHandler('checkHandler: 现有 10007 GetWeaponListPage 分页回包含 onlyId', 10007, {
  req: (await import(`../${DIST}/proto.js`)).vfield(1, 0),
  fields: (dec, { has, pb }) => {
    assert.ok(has(1), 'weaponInfos=1 才是列表本体(2 是 page, 3 是 next)');
    for (const w of dec.filter((f) => f.field === 1)) {
      assert.ok(pb.decodeFields(w.value).some((x) => x.field === 6), '每条 WeaponInfo 都要带 onlyId=6 (required string)');
    }
  },
});
await checkHandler('checkHandler: 现有 10051 GetSignReward 空请求不炸', 10051, {
  after: (s, { res }) => assert.ok(Buffer.isBuffer(res.body ?? res), '回包是 Buffer'),
});

// ---------------------------------------------------------------- 4h. B1 养成 (8 新 + 1001 重构)
// 这九条是全档里最容易"回得出去、客户端不动"的一类: required 只有 LeaderInfo 那一坨,
// 而 leader 的**字段号每条都不一样**(ActiveSkill/Stick=1, Talent/Star/StarLevel=2),
// optional 字段串号 required 自检抓不到 -> 每条手写 has(1)/has(2) 断言。
const GProto = await import(`../${DIST}/proto.js`);
const DPUSH = 900011;                     // CMD.DataPush
const LID = 2001001;                      // 底档里一定有的角色
const ACT = 20010120;                     // LEADER[2001001].activeSkillId
const COMMON = 1601010;                   // Leader.commonSkillId[1] —— 唯一能升级的"被动"(1..10 级)
const LOCKED_TALENT = 1701010;            // 突破解锁的被动, Skill.maxLevel=1 -> 升一次就该被拒
const STICK = 1800000;                    // 式杖技能, TalentSkill 里确有 1..10 级
const WAND_ROW = 200101;                  // LeaderWandSkill 表id (skillId=[1800000], skillOrder=1)
const hash = (k, v) => GProto.bfield(3, GProto.concat(GProto.vfield(1, k), GProto.vfield(2, v)));

// 养成用例的底档: 拿仓库里的 data/save.json, 把 2001001 归零 + 把各条 consume 的材料备齐.
// (10=金币 1070001=技能材料 3001001=位阶材料 1080031/32=突破材料 1020004=经验素材 2000exp/份)
const trainSave = (mut) => {
  const s = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  const c = s.characters.find((x) => x.id === LID);
  assert.ok(c, `data/save.json 里要有角色 ${LID} (养成用例的底档)`);
  Object.assign(c, { level: 1, exp: 0, star: 0, starLevel: 0, breach: 0, activeLv: {}, talentLv: {}, stick: {}, stickLv: {} });
  s.items = { ...s.items, 1020004: 5, 1070001: 50, 3001001: 50, 1080031: 20, 1080032: 20 };
  s.money = { ...s.money, 10: 999999 };
  if (mut) mut(s, c);
  return s;
};

// 回包/推送里那条 LeaderInfo: 从 Data_Push(5) 或裸 leader 字段里挖出来
const leaderFromPush = (dec) => {
  const attr = dec.find((f) => f.field === 5);
  if (!attr) return null;
  const inner = GProto.decodeFields(attr.value).find((f) => f.field === 1);
  return inner ? GProto.decodeFields(inner.value) : null;
};

await checkHandler('B1 1001 UpgradeLeader: 扣素材换经验并按 LeaderLv 曲线滚级', 1001, {
  save: trainSave(),
  req: GProto.concat(GProto.vfield(1, LID), hash(1020004, 3)),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { res }) => {
    assert.equal(dec.length, 0, 'UpgradeLeader_S2C 是空 message, 任何字段都是编出来的');
    const ddec = GProto.decodeFields(res.pushes.find(([h]) => h === DPUSH)[1]);
    assert.ok(leaderFromPush(ddec), 'Data_Push 里要有 leaderAttrChanged=5');
    assert.ok(ddec.some((f) => f.field === 10), '扣了材料必须同推 changePart=10, 否则客户端背包数量不动');
  },
  after: (s, { res }) => {
    const c = s.characters.find((x) => x.id === LID);
    assert.ok(c.level > 1, `3 份报告 6000 经验该滚好几级, 现在还是 ${c.level}`);
    assert.ok(c.level <= 20, `本突(breach=0)上限 20, 升到 ${c.level} 是越顶`);
    assert.equal(s.items['1020004'], 2, '素材要真扣');
    assert.ok(c.exp >= 0, '剩余经验要落账(不能吞掉)');
    assert.deepEqual(res.pushes.map(([h]) => h), [DPUSH, 900007], '养成推一条 Data_Push, 外加一条任务进度推送(消耗计入 1502)');
  },
});

await checkHandler('B1 1001 UpgradeLeader: 素材不够 -> 拒单且一分不扣', 1001, {
  save: trainSave((s) => { s.items['1020004'] = 1; }),
  req: GProto.concat(GProto.vfield(1, LID), hash(1020004, 3)),
  deny: /材料不足.*lack 1020004<3/,
  after: (s) => {
    const c = s.characters.find((x) => x.id === LID);
    assert.equal(c.level, 1, '拒单后等级不许动');
    assert.equal(s.items['1020004'], 1, 'payItemList 必须先全验再扣: 不足时一分不扣');
  },
});

await checkHandler('B1 1005 UpgradeLeaderBreach: 扣本突材料 -> breach+1 (空 S2C + 推送)', 1005, {
  save: trainSave((s, c) => { c.breach = 1; c.level = 40; }),
  req: GProto.vfield(1, LID),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec) => assert.equal(dec.length, 0, 'UpgradeLeaderBreach_S2C 是空 message'),
  after: (s) => {
    const c = s.characters.find((x) => x.id === LID);
    assert.equal(c.breach, 2, '突破要真落盘(客户端弹窗靠 leaderAttrChanged 里的 breachLevel)');
    assert.ok(s.money['10'] < 999999, '突破的金币要真扣');
  },
});

await checkHandler('B1 1005 UpgradeLeaderBreach: 没有下一突的行 -> 拒单', 1005, {
  save: trainSave((s, c) => { c.breach = 6; }),
  req: GProto.vfield(1, LID),
  deny: /breachRow\?/,
  after: (s) => assert.equal(s.characters.find((x) => x.id === LID).breach, 6, '拒单不许改突破'),
});

await checkHandler('B1 1003 UpgradeLeaderStarLevel: 扣"目标档" -> starLevel+1, leader 在字段 2', 1003, {
  save: trainSave(),
  req: GProto.vfield(1, LID),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has }) => {
    assert.ok(has(2), 'UpgradeLeaderStarLevel_S2C 的 leader 是 2 号字段');
    assert.ok(!has(1), '1 号是 UpgradeLeaderActiveSkill 的写法, 串到这里 required 自检不响');
  },
  after: (s) => {
    const c = s.characters.find((x) => x.id === LID);
    assert.equal(c.starLevel, 1, '小阶要 +1');
    assert.equal(c.star, 0, '大阶不动');
    assert.equal(s.items['3001001'], 45, 'LeaderStarlevel[0][1].consumeID=2001001 要扣 5 个 3001001');
  },
});

await checkHandler('B1 1003 UpgradeLeaderStarLevel: 本大阶小阶已满 -> 拒单不动档', 1003, {
  save: trainSave((s, c) => { c.starLevel = 2; }),
  req: GProto.vfield(1, LID),
  deny: /starLevel 顶档/,
  after: (s) => assert.equal(s.characters.find((x) => x.id === LID).starLevel, 2),
});

await checkHandler('B1 1002 UpgradeLeaderStar: 小阶已满时扣"当前档" -> star+1 且 starLevel 归 0', 1002, {
  save: trainSave((s, c) => { c.starLevel = 2; }),
  req: GProto.vfield(1, LID),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has }) => {
    assert.ok(has(2), 'UpgradeLeaderStar_S2C 的 leader 是 2 号字段');
    assert.ok(!has(1));
  },
  after: (s) => {
    const c = s.characters.find((x) => x.id === LID);
    assert.equal(c.star, 1, '大阶 +1');
    assert.equal(c.starLevel, 0, '"坐在大位阶上" —— 不清零等于白送一个小阶');
    assert.equal(s.items['3001001'], 35, 'LeaderStar[star=0].consumeID=2001003 扣 15 个');
  },
});

await checkHandler('B1 1002 UpgradeLeaderStar: 小阶没满就点大阶 -> 拒单', 1002, {
  save: trainSave((s, c) => { c.starLevel = 1; }),
  req: GProto.vfield(1, LID),
  deny: /starNeedMaxLv/,
  after: (s) => {
    const c = s.characters.find((x) => x.id === LID);
    assert.equal(c.star, 0);
    assert.equal(c.starLevel, 1);
  },
});

await checkHandler('B1 1008 UpgradeLeaderActiveSkill: leader 在字段 1 且回包带出新等级', 1008, {
  save: trainSave((s, c) => { c.breach = 1; }),   // 本突 skillLevel 上限=4, 1 级可升
  req: GProto.concat(GProto.vfield(1, LID), GProto.vfield(2, ACT)),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has }) => {
    assert.ok(has(1), 'UpgradeLeaderActiveSkill_S2C 的 leader 是 1 号字段');
    assert.ok(!has(2), '2 号是 Talent/Star 的写法');
    // 客户端 UpgradeLeaderActiveSkillHandler 无条件读 msg.leader.activeSkills -> 回包必须真带技能
    const lvOf = dec.filter((f) => f.field === 1)
      .flatMap((li) => GProto.decodeFields(li.value).filter((x) => x.field === 17))
      .map((sk) => GProto.decodeFields(sk.value))
      .find((k) => Number(k.find((x) => x.field === 1)?.value) === ACT);
    assert.ok(lvOf, '回包 leader 的 activeSkills 里没有这条技能');
    assert.equal(Number(lvOf.find((x) => x.field === 2)?.value), 2, 'activeSkills.level 要跟着涨');
  },
  after: (s) => {
    const c = s.characters.find((x) => x.id === LID);
    assert.equal(c.activeLv[String(ACT)], 2, '技能等级要落盘(重登靠它)');
    assert.equal(s.items['1070001'], 50 - 24, 'SkillValue[1].consumeId=20011201 扣 24 个材料');
  },
});

await checkHandler('B1 1008 UpgradeLeaderActiveSkill: 本突上限卡住(0 突 cap=1) -> 拒单', 1008, {
  save: trainSave(),
  req: GProto.concat(GProto.vfield(1, LID), GProto.vfield(2, ACT)),
  deny: /breakCap/,
  after: (s) => {
    const c = s.characters.find((x) => x.id === LID);
    assert.ok(!c.activeLv[String(ACT)], '被拒的技能不该留下等级');
    assert.equal(s.items['1070001'], 50, '材料不能预扣');
  },
});

// 1004 的拒单是 B1 里最要紧的一条: UpgradeLeaderTalentSkillHandler **无条件**弹 UIHeroLevelUp,
// 回一个等级没变的包 = 客户端弹"升级成功"假窗(路 B :4036 同结论).
await checkHandler('B1 1004 UpgradeLeaderTalentSkill: 普攻可升, leader 在字段 2', 1004, {
  save: trainSave((s, c) => { c.breach = 4; }),
  req: GProto.concat(GProto.vfield(1, LID), GProto.vfield(2, COMMON)),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has }) => {
    assert.ok(has(2), 'UpgradeLeaderTalentSkill_S2C 的 leader 是 2 号字段');
    assert.ok(!has(1), '写成 1 号客户端拿到的是 undefined -> handler 当场崩');
    const tal = dec.filter((f) => f.field === 2)
      .flatMap((li) => GProto.decodeFields(li.value).filter((x) => x.field === 11))
      .map((sk) => GProto.decodeFields(sk.value))
      .find((k) => Number(k.find((x) => x.field === 1)?.value) === COMMON);
    assert.ok(tal, 'talentSkills 里必须有普攻 1601010 —— 面板取不到这行就没有升级按钮');
  },
  after: (s) => assert.equal(s.characters.find((x) => x.id === LID).talentLv[String(COMMON)], 2),
});

await checkHandler('B1 1004 UpgradeLeaderTalentSkill: maxLevel=1 的被动 -> 必须拒单(否则弹假窗)', 1004, {
  save: trainSave((s, c) => { c.breach = 4; }),
  req: GProto.concat(GProto.vfield(1, LID), GProto.vfield(2, LOCKED_TALENT)),
  deny: /maxLevel/,
  after: (s) => assert.ok(!s.characters.find((x) => x.id === LID).talentLv[String(LOCKED_TALENT)]),
});

await checkHandler('B1 1016 UpgradeStickSkill: 上限取 TalentSkill 的 skillLevel, 回包带 stickSkillLevel=27', 1016, {
  save: trainSave(),
  req: GProto.concat(GProto.vfield(1, LID), GProto.vfield(2, STICK), GProto.vfield(3, WAND_ROW)),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has }) => {
    assert.ok(has(1), 'UpgradeStickSkill_S2C 的 leader 是 1 号字段');
    assert.ok(!has(2));
    const li = dec.find((f) => f.field === 1);
    const lv27 = GProto.decodeFields(li.value).find((x) => x.field === 27);
    assert.ok(lv27, 'stickSkillLevel=27 缺了 -> 重登式杖等级全丢(客户端只认这一项)');
    const k = GProto.decodeFields(lv27.value);
    assert.equal(Number(k.find((x) => x.field === 1)?.value), STICK, '27 号里的 id 是**技能id**, 不是表id');
    assert.equal(Number(k.find((x) => x.field === 2)?.value), 2);
    assert.equal(Number(k.find((x) => x.field === 3)?.value), 1, 'state=1 已解锁');
  },
  after: (s) => assert.equal(s.characters.find((x) => x.id === LID).stickLv[String(STICK)], 2),
});

await checkHandler('B1 1010 ChangeStickSkill: 三个 required 原样回显 + stickSkills=23 落盘', 1010, {
  save: trainSave(),
  req: GProto.concat(GProto.vfield(1, LID), GProto.vfield(2, 1), GProto.vfield(3, WAND_ROW)),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has }) => {
    assert.ok(has(1) && has(2) && has(3), 'ChangeStickSkill_S2C 三个字段全是 required');
    assert.deepEqual(dec.map((f) => f.field), [1, 2, 3], '回显顺序外的字段都是多余的');
  },
  after: (s, { res }) => {
    const c = s.characters.find((x) => x.id === LID);
    assert.equal(c.stick['1'], WAND_ROW, '槽位->表id 的映射要落盘');
    const li = leaderFromPush(GProto.decodeFields(res.pushes.find(([h]) => h === DPUSH)[1]));
    const slot = li.find((f) => f.field === 23);
    assert.ok(slot, 'stickSkills=23 缺了重登式杖装配全丢');
    const k = GProto.decodeFields(slot.value);
    assert.equal(Number(k.find((x) => x.field === 1)?.value), 1, 'key=技能槽Id');
    assert.equal(Number(k.find((x) => x.field === 2)?.value), WAND_ROW, 'value=LeaderWandSkill 表id');
  },
});

await checkHandler('B1 1011 ResetStickSkill: 只清槽位关系, 技能等级是玩家资产', 1011, {
  save: trainSave((s, c) => { c.stick = { 1: WAND_ROW }; c.stickLv = { [String(STICK)]: 3 }; }),
  req: GProto.vfield(1, LID),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has }) => {
    assert.ok(has(1), 'ResetStickSkill_S2C 只有 required skillLeaderId=1');
    assert.ok(!has(2) && !has(3), '这条没有 2/3 号字段, 多发是串号');
  },
  after: (s) => {
    const c = s.characters.find((x) => x.id === LID);
    assert.deepEqual(c.stick, {}, '槽位要清空');
    assert.equal(c.stickLv[String(STICK)], 3, 'stickLv **不能**跟着清 —— 升级过的等级不能被重置吞掉');
  },
});

// 式杖技能集合的取数口径: 普攻/被动来自 Leader 表, 不是武器表 (武器的 weaponSkillId 在
// Skill_Xls 里 maxLevel 恒为 1, 拿它当被动的结果就是"每个被动都满级、永远升不动").
await check('B1 养成面板的被动集合取自 Leader 表而非武器表', async () => {
  const t = await import(`../${DIST}/tbl.js`);
  const common = t.arr('Leader', LID, 'commonSkillId').map(Number);
  const talent = t.arr('Leader', LID, 'talentSkill').map(Number);
  const restore = useSave(trainSave((s, c) => { c.breach = 4; }));
  try {
    const { HANDLERS } = await import(`../${DIST}/payloads.js`);
    const res = HANDLERS[10002]({ msgId: 10002, packetUUid: 1, proto: Buffer.alloc(0), headerHex: '' });
    const body = Buffer.isBuffer(res) ? res : res.body;
    const li = GProto.decodeFields(body).filter((f) => f.field === 4)
      .map((f) => GProto.decodeFields(f.value))
      .find((x) => Number(x.find((k) => k.field === 1)?.value) === LID);
    assert.ok(li, 'PlayerLoginGetInfo 里没有这个角色的 LeaderInfo');
    const ids = li.filter((f) => f.field === 11)
      .map((f) => Number(GProto.decodeFields(f.value).find((k) => k.field === 1)?.value));
    for (const sid of [...common, ...talent]) assert.ok(ids.includes(sid), `talentSkills 少了 ${sid}`);
    assert.ok(!ids.includes(5011010), '武器被动(5011010)不该出现在养成面板的技能列表里');
  } finally { restore(); }
});

// 具相面板按 HeroData:GetActiveSkill(type) 取技能, 养成侧只认 1=主动 / 2=极奏 (普攻由客户端从
// talentSkills 里挑 commonSkillId[1] 合成). 武器射击技能混进 activeSkills 时: 它在 SkillValue 里只有
// 1 级且 consumeId=0 -> 下一级配置取不到, 潜能觉醒按钮永不出现(1008 也就发不出来); 红点判据又拿
// consumeId=0 去 index Consume 表 -> Lua 报错, 面板整个卡死. 真机上就是"满级点具相卡住".
await check('B1 具相面板 activeSkills 只有 主动(type=1)/极奏(type=2) 两条', async () => {
  const { LEADER } = await import(`../${DIST}/data/leader.js`);
  const { WEAPON } = await import(`../${DIST}/data/weapon.js`);
  const act = LEADER[LID][1], jizou = LEADER[LID][2];
  const shooting = WEAPON[LEADER[LID][0]][0];
  const restore = useSave(trainSave((s, c) => { c.breach = 4; }));
  try {
    const { HANDLERS } = await import(`../${DIST}/payloads.js`);
    const res = HANDLERS[10002]({ msgId: 10002, packetUUid: 1, proto: Buffer.alloc(0), headerHex: '' });
    const body = Buffer.isBuffer(res) ? res : res.body;
    const li = GProto.decodeFields(body).filter((f) => f.field === 4)
      .map((f) => GProto.decodeFields(f.value))
      .find((x) => Number(x.find((k) => k.field === 1)?.value) === LID);
    assert.ok(li, 'PlayerLoginGetInfo 里没有这个角色的 LeaderInfo');
    const slots = li.filter((f) => f.field === 17)
      .map((f) => GProto.decodeFields(f.value))
      .map((k) => ({
        id: Number(k.find((x) => x.field === 1)?.value),
        level: Number(k.find((x) => x.field === 2)?.value),
        type: Number(k.find((x) => x.field === 3)?.value),
      }));
    assert.equal(slots.length, 2, `activeSkills 只能两条(主动/极奏), 实得 ${JSON.stringify(slots)}`);
    assert.deepEqual(slots.map((s) => [s.type, s.id]), [[1, act], [2, jizou]], 'type 与技能 id 的配对不能移位');
    assert.ok(!slots.some((s) => s.id === shooting), `武器射击技能 ${shooting} 不该出现在 activeSkills 里`);
    assert.ok(!slots.some((s) => s.type === 3), 'type=3(QTE/支援) 是战斗侧口径, 养成侧没人读');
  } finally { restore(); }
});

// 百分比属性在 Attribute 表里存的是**小数**(0.02 = 暴击率 2%, 0.4 = 暴击伤害 40%), 跟着 hp/atk 一起
// 取整会全归 0 —— 真机上表现为"式仗的暴击伤害/暴击率永远是 0". 全表 542 行里这两列的非零值没有一行是整数.
await check('attrs: 暴击率(201)/暴击伤害(200) 保持小数, 其余属性仍取整', async () => {
  const A = await import(`../${DIST}/attrs.js`);
  const w = A.weaponAttr(5051030, 1, 0);
  assert.equal(w.get(201), 0.02, '武装暴击率 0.02 被取整成 0');
  assert.equal(w.get(200), 0.4, '武装暴击伤害 0.4 被取整成 0');
  assert.equal(w.get(101), 120, '攻击这类整数属性仍要取整');
  const merged = Object.fromEntries(A.heroAttrMap(2027001, 1, 0, 5051030, 1, 0));
  assert.equal(merged[201], 0.07, `角色 0.05 + 武装 0.02 合并要清掉浮点尾差, 实得 ${merged[201]}`);
  assert.ok(Number.isInteger(merged[102]), '防御仍取整');

  // 端到端: 值经 dblfield 上线后仍是小数(客户端按 attributeMap 画面板与战斗数值).
  const restore = useSave(trainSave((s, c) => { c.breach = 4; }));
  try {
    const { HANDLERS } = await import(`../${DIST}/payloads.js`);
    const res = HANDLERS[10002]({ msgId: 10002, packetUUid: 1, proto: Buffer.alloc(0), headerHex: '' });
    const body = Buffer.isBuffer(res) ? res : res.body;
    const li = GProto.decodeFields(body).filter((f) => f.field === 4)
      .map((f) => GProto.decodeFields(f.value))
      .find((x) => Number(x.find((k) => k.field === 1)?.value) === LID);
    const prop = GProto.decodeFields(li.find((f) => f.field === 10).value);
    const map = Object.fromEntries(prop.filter((f) => f.field === 1)
      .map((f) => GProto.decodeFields(f.value))
      .map((e) => [Number(e.find((k) => k.field === 1)?.value), e.find((k) => k.field === 2)?.value.readDoubleLE(0)]));
    assert.ok(map[201] > 0 && map[201] < 1, `回包 attributeMap[201] 应是 (0,1) 的小数, 实得 ${map[201]}`);
    assert.ok(map[200] > 0 && map[200] < 1, `回包 attributeMap[200] 应是 (0,1) 的小数, 实得 ${map[200]}`);
  } finally { restore(); }
});

// 客户端自己写着的武装属性公式(8c78c6be:1069): 基础 + Σ各突等级属性×本突那几级 + Σ各突突破属性.
// 早先 weaponAttr 只有"当前突的成长行 ×(等级-1)", 且**完全没读 growAddAttributeID** -> 突破白送的那一坨
// (5★ 突1 = +114 攻/+2%暴击率/+2.5%暴伤)凭空消失, 真机上就是"升级突破属性不动".
await check('attrs: 武装等级成长分段累计 + 突破附加属性都算进终值', async () => {
  const A = await import(`../${DIST}/attrs.js`);
  const atk = (lv, br) => A.weaponAttr(5151010, lv, br).get(101);
  assert.equal(atk(1, 0), 120, '1 级 0 突 = 基础行');
  assert.equal(atk(20, 0), 296, '本突 20 级: 120 + 9.26316*19');
  assert.equal(atk(40, 1), 597, '分段: 120 + 9.26316*19 + 9.35*20 + 突破附加 114');
  assert.equal(atk(50, 2), 838, '两突的附加属性要累加(114+136.8), 每突按各自成长行(9.26/9.35/10.45)计');
  assert.equal(atk(80, 2), atk(50, 2), '等级超本突上限(2 突 cap=50)要夹住, 不能继续涨');
  assert.ok(atk(21, 1) > atk(20, 0), '突破本身就该让属性跳一截');
  const crit = A.weaponAttr(5151010, 40, 1);
  assert.equal(crit.get(201), 0.04, '暴击率随突破加 0.02(小数, 不能被取整吃掉)');
  assert.equal(crit.get(200), 0.425, '暴击伤害随突破加 0.025');
  // 强化/突破回包里那把武装真的带着新数值(面板与战力同源).
  const w = A.weaponPower(5151010, 40, 1);
  assert.ok(w > A.weaponPower(5151010, 1, 0), '武装战力要随等级/突破涨');
  const p = (lv, wl, wb) => A.heroPower(2001001, lv, 3, 5151010, wl, wb);
  assert.ok(p(60, 1, 0) > p(1, 1, 0), '角色战力要随**角色等级**涨(早先只读基础行)');
  assert.ok(p(60, 40, 1) > p(60, 1, 0), '角色战力要随穿戴武装的等级/突破涨');
});

// ---------------------------------------------------------------- 4i. deny 的**帧级**行为 (gs.ts)
// checkHandler 直调 HANDLERS, 而"拒单"是 gs.ts 装配回包时的一个分支 —— 不端到端过一遍
// handleAppInterface, 自检对"header=0 空包到底成不成帧、有没有误伤正常包"是盲的。
await check('GS 帧: 养成 deny 回全零合法帧, 与"未注册兜底""成功回包"三种形状互不混淆', async () => {
  const gs = await import(`../${DIST}/gs.js`);
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const reqOf = (msgId, data) => Buffer.concat([
    u32(0), u32(0), u32(0), u32(msgId),
    u32(0), u32(0), u32(0), u32(0), u32(0),   // uid/platform/pfUid/channel/token
    u32(4321), u32(0), Buffer.from([0]), u32(data.length), data, u32(0),
    //       packetUUid  [u32 ?=0][u8 ?=0][u32 dataLen]   data  [u32 appendLen]
  ]);
  const parse = (f) => {
    const pushLen = f.readInt32BE(5);
    const bodyLen = f.readInt32BE(13 + pushLen);
    return {
      err: f.readInt32BE(1), pushLen, push: f.subarray(9, 9 + pushLen),
      header: f.readInt32BE(9 + pushLen), bodyLen,
      p2cLen: f.readInt32BE(17 + pushLen + bodyLen), total: f.length,
    };
  };
  // 客户端只看 udd.error 就清 CurSend, 所以 err 必须为 0 —— 非 0 会变成超时/异常提示.
  const fields = (b) => GProto.decodeFields(b);
  // 底档同 B1: breach=4 才让普攻有升级空间(0 突的 skillLevel 上限会把升级判死 -> 那是另一条用例)
  const restore = useSave(trainSave((s, c) => { c.breach = 4; }));
  const ff = path.join(config.paths.logs, 'gs-req-1004.fields.json');
  const ffBackup = fs.existsSync(ff) ? fs.readFileSync(ff) : null;
  try {
    // 1) 拒单: 角色不存在 -> 整帧一个字节的数据段都没有, 存档一分不动
    const before = fs.readFileSync(SAVE_FILE, 'utf8');
    const denied = parse(gs.handleAppInterface(reqOf(1004, GProto.vfield(1, 9999999))).body);
    assert.equal(denied.err, 0, 'deny 必须是 error=0, 否则客户端走超时/异常分支');
    assert.equal(denied.pushLen, 0, 'deny 不该带 ReturnPackagePush(里面会有 header=1004 -> 面板照样刷新)');
    assert.equal(denied.header, 0, 'deny 的主回包槽 header 必须是 0 (EventManager 里没有监听者)');
    assert.equal(denied.bodyLen, 0, 'deny 的主回包必须是空 body');
    assert.equal(denied.p2cLen, 0, 'deny 不该带 PushMsg2Client');
    assert.equal(denied.total, 21, `纯定长头 21B(1+4*5), 实际 ${denied.total}B`);
    assert.equal(fs.readFileSync(SAVE_FILE, 'utf8'), before, '拒单不许把存档写脏');

    // 2) 对照: 未注册的 msgId 仍回"带 header 的合法空包"(客户端不能永远等)
    const orphan = parse(gs.handleAppInterface(reqOf(50006, Buffer.alloc(0))).body);
    assert.ok(orphan.pushLen > 0, '未注册消息必须有 ReturnPackagePush, 否则客户端等超时');
    const pInfo = fields(fields(orphan.push).find((f) => f.field === 1).value);
    assert.equal(Number(pInfo.find((f) => f.field === 1).value), 4321, 'packetUUid 必须原样带回');
    assert.equal(Number(fields(pInfo.find((f) => f.field === 2).value).find((f) => f.field === 1).value),
      50006, '未注册兜底的 header 是请求号');

    // 3) 成功路径: 同一命令材料齐 -> 主包(leader) + 推送(DataPush) 都在 push 里
    const okReq = GProto.concat(GProto.vfield(1, LID), GProto.vfield(2, COMMON));
    const ok = parse(gs.handleAppInterface(reqOf(1004, okReq)).body);
    assert.ok(ok.pushLen > 0, '成功的 UpgradeLeaderTalentSkill 必须回包');
    const oInfo = fields(fields(ok.push).find((f) => f.field === 1).value);
    assert.equal(Number(fields(oInfo.find((f) => f.field === 2).value).find((f) => f.field === 1).value),
      1004, '主包 header 必须是 1004, 客户端才有回调可派');
    assert.ok(oInfo.filter((f) => f.field === 3).some((f) =>
      Number(fields(f.value).find((x) => x.field === 1).value) === DPUSH), `push 里要有 DataPush(${DPUSH})`);
  } finally {
    restore();
    if (ffBackup) fs.writeFileSync(ff, ffBackup);
    else if (fs.existsSync(ff)) fs.unlinkSync(ff);
  }
});

// ---------------------------------------------------------------- 4j. B2 武装 (7 条)
// 这七条的风险不在"回不回得出去", 而在回体里那两组随机数: 洗练确认页用**同一个下标**读 WeaponInfo
// 的 17(生效) 与 18(待确认) 的四列数组, 短一格就 index 到 nil; 而 18 的"形状"本身又是客户端
// IsRecastingOver 的判据(洗属性不许带技能、洗技能必须照抄 17 的属性列且 scope 发 0).
// 所以每条既断言 required/字段号, 也断言 17/18 的条数与取值合法性.
const WEAP = await import(`../${DIST}/weapons.js`);
const SAVEM = await import(`../${DIST}/save.js`);
const TBL = await import(`../${DIST}/tbl.js`);
const WCFG = 5041010;                 // 4★: 1 技能位 + 2 属性位, 精炼上限 4, 有突破行
const WLOW = 5021010;                 // 2★: 0 技能位 -> 洗练必须被拒(且精炼上限 0)
const WID = '7TEST0001';              // 穿在 LID 身上的测试武装
const WMAT1 = '7TEST0002';            // 同配置闲置卡: 精炼素材 / 分解对象
const WMAT2 = '7TEST0003';
const WBR0 = 20;                      // weaponMaxLv(5041010, breach=0)
const wInst = (onlyId, cfg, over = {}) => ({
  onlyId, cfg, leaderId: 0, level: 1, breach: 0, exp: 0, refine: 0, lock: 0, skin: 0,
  recastingTime: 0, recastingSkillTime: 0, ...over,
});
// 底档: 换掉整个 weapons(避免和真档里那 27 把 "7g…" 号混), 并把突破/洗练材料备齐.
// 1030011/12=突破料 1090101=改组零件(洗练) 1090102=定向固锁零件(锁定) 1090001=式仗经验料(强化)
const armSave = (mut) => {
  const s = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  s.weapons = [
    wInst(WID, WCFG, { leaderId: LID, level: WBR0 }),
    wInst(WMAT1, WCFG),
    wInst(WMAT2, WCFG),
    wInst('7TEST0004', WLOW),
  ];
  s.items = { ...s.items, 1030011: 60, 1030012: 60, 1090101: 100, 1090102: 100, 1090001: 50 };
  s.money = { ...s.money, 10: 999999 };
  if (mut) mut(s);
  return s;
};
const wOf = (dec, no) => dec.find((f) => f.field === no) ?? null;
// UpgrageWeapon.itemInfo=1 才是素材列表(顶层那个 hash() 把外层号写成了 3 —— 那是 UpgradeLeader 的字段号).
const whash = (k, v) => GProto.bfield(1, GProto.concat(GProto.vfield(1, k), GProto.vfield(2, v)));
const wSub = (f) => (f ? GProto.decodeFields(f.value) : null);
const randShape = (infoDec, no) => {
  const f = wOf(infoDec, no);
  if (!f) return null;
  const r = { skill: [], key: [], val: [], pool: [], attr: [], scope: null, hasProp: false };
  for (const g of GProto.decodeFields(f.value)) {
    if (g.field === 1) r.skill.push(Number(g.value));
    else if (g.field === 2) {
      r.hasProp = true;
      for (const h of GProto.decodeFields(g.value)) {
        if (h.field === 1) r.key.push(Number(h.value));
        else if (h.field === 2) r.val.push(h.value.readDoubleLE(0));
        else if (h.field === 4) r.scope = h.value.readDoubleLE(0);
        else if (h.field === 5) r.pool.push(Number(h.value));
        else if (h.field === 6) r.attr.push(Number(h.value));
      }
    }
  }
  return r;
};
// 一把武器的合法域: 池来自 WeaponLibrary, 技能取 WeaponRandom.skillID, 属性取 EquipAttribute 的列.
const libRows = (lib) => TBL.arr('WeaponLibrary', lib, 'weaponRandomID').map(Number);
const legalRand = (cfg) => {
  const prop = libRows(TBL.num('Weapon', cfg, 'randomstrength', 0))
    .map((id) => TBL.row('WeaponRandom', id)).filter((x) => x && Number(x.valueType) === 2);
  const skill = libRows(TBL.num('Weapon', cfg, 'randomskill', 0))
    .map((id) => TBL.row('WeaponRandom', id)).filter((x) => x && Number(x.valueType) === 1);
  return { prop, skill };
};
function assertRandLegal(label, r, cfg) {
  assert.ok(r, `${label}: 整组缺失`);
  assert.ok(r.key.length === r.val.length && r.key.length === r.pool.length && r.key.length === r.attr.length,
    `${label}: 四列不等长 key=${r.key.length} val=${r.val.length} pool=${r.pool.length} attr=${r.attr.length}`);
  const slots = WEAP.randSlotCount(cfg);
  assert.ok(r.skill.length <= slots.skill && r.key.length <= slots.prop,
    `${label}: 超出 ${slots.skill}技能/${slots.prop}属性 的格子数`);
  const { prop, skill } = legalRand(cfg);
  for (const id of r.skill) {
    assert.ok(skill.some((x) => Number(x.skillID) === id), `${label}: 技能 ${id} 不在 ${cfg} 的技能池里`);
  }
  for (let i = 0; i < r.key.length; i++) {
    const wr = prop.find((x) => Number(x.id) === r.pool[i]);
    assert.ok(wr, `${label}: 池 ${r.pool[i]} 不是 ${cfg} 的属性池行`);
    const sid = Number(wr.skillID);
    const types = TBL.arr('EquipAttribute', sid, 'attributeType').map(Number);
    const ranges = TBL.arr('EquipAttribute', sid, 'attributeRange');
    assert.ok(r.attr[i] >= 0 && r.attr[i] < types.length, `${label}: attrIdx ${r.attr[i]} 越界(该池只有 ${types.length} 列)`);
    assert.equal(r.key[i], types[r.attr[i]], `${label}: key ${r.key[i]} != attributeType[${r.attr[i] + 1}]`);
    const rg = ranges[r.attr[i]];
    assert.ok(Array.isArray(rg), `${label}: 属性 ${r.key[i]} 没有 attributeRange`);
    assert.ok(r.val[i] >= Number(rg[0]) && r.val[i] <= Number(rg[1]),
      `${label}: 值 ${r.val[i]} 不在 [${rg[0]}, ${rg[1]}] 内`);
  }
}
/**
 * 洗练回体的形状断言 (1208 用). kind=1 洗属性 / kind=2 洗技能, 与客户端 IsRecastingOver 反推的
 * 两种形状一致: 属性待确认 <=> 18.secondaryPropInfo.weaponPropScope ~= 0 (且 18 不带技能);
 * 技能待确认 <=> 18.weaponRandomSkill 存在 (且属性列照抄 17, scope 必须发 0).
 */
function assertRecastShape(label, infoDec, cfg, kind) {
  const cur = randShape(infoDec, 17);
  const pend = randShape(infoDec, 18);
  assertRandLegal(`${label}/17`, cur, cfg);
  assert.ok(pend, `${label}: 18 整个缺失 -> 客户端判"无待确认", 成功窗里没东西可留`);
  assertRandLegal(`${label}/18`, pend, cfg);
  if (kind === 1) {
    assert.equal(pend.skill.length, 0, `${label}: 洗属性的 18 带了技能 -> 技能页也被判成待确认`);
    assert.ok(pend.scope !== 0, `${label}: PROP 待确认的标志就是 scope~=0, 现在发了 ${pend.scope}`);
    assert.equal(pend.key.length, cur.key.length, `${label}: 18 属性 ${pend.key.length} 条 != 17 的 ${cur.key.length} 条`);
  } else {
    assert.ok(pend.skill.length > 0, `${label}: 洗技能的 18 必须带新技能`);
    assert.equal(pend.key.length, cur.key.length, `${label}: 洗技能时 18 要照抄 17 的属性列(确认页同下标读)`);
    assert.deepEqual(pend.key, cur.key, `${label}: 18 的属性列与 17 不同`);
    assert.equal(pend.scope, 0, `${label}: 技能待确认时 scope 必须显式发 0, 否则属性页也被判成待确认`);
  }
  return { cur, pend };
}

await checkHandler('B2 1201 UpgrageWeaponBreach: 满级才突破, breach+1 且带 weaponInfo=1', 1201, {
  save: armSave(),
  req: GProto.sfield(2, WID),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has, pb }) => {
    assert.ok(has(1), 'weaponInfo 在字段 1 (1205/1207 才在 2)');
    const wi = pb.decodeFields(wOf(dec, 1).value);
    assert.equal(Number(wOf(wi, 5).value), 1, 'breachLevel=5 要已经是 +1 之后的值');
    assert.ok(wOf(wi, 17), '武装面板靠 17/18 画随机行, 突破回包也得带着');
    assert.ok(has(2), 'rewards=2 消耗回显');
    assert.ok(has(3), '已装备 -> leaderInfo=3 必须带上, 角色面板才刷得出新属性');
  },
  after: (s) => {
    const w = s.weapons.find((x) => x.onlyId === WID);
    assert.equal(w.breach, 1, '突破要真落盘');
    assert.equal(s.items['1030011'], 40, '本突扣 20 个 1030011');
    assert.ok(s.money['10'] < 999999, '金币要扣(27000)');
  },
});

await checkHandler('B2 1201 UpgrageWeaponBreach: 没满本突等级上限 -> 拒单(客户端无条件弹突破成功窗)', 1201, {
  save: armSave((s) => { s.weapons[0].level = 5; }),
  req: GProto.sfield(2, WID),
  deny: /1201 未满级/,
  after: (s) => {
    assert.equal(s.weapons.find((x) => x.onlyId === WID).breach, 0, '拒单后突破等级不许动');
    assert.equal(s.items['1030011'], 60, '拒单后材料不许扣');
  },
});

await checkHandler('B2 1202 UpgrageWeapon: 1090001 折 200 经验/份, 按 WeaponGrow 曲线滚级', 1202, {
  save: armSave((s) => { s.weapons[0].level = 1; }),
  req: GProto.concat(GProto.sfield(3, WID), whash(1090001, 3)),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has, pb }) => {
    assert.ok(has(1) && has(2), 'weaponInfo=1 + rewards=2');
    const wi = pb.decodeFields(wOf(dec, 1).value);
    assert.equal(Number(wOf(wi, 4).value), 2, '600 经验 / 每级 400 -> 只该滚到 2 级');
    assert.equal(Number(wOf(wi, 3).value), 200, '余下的 200 经验要留在 exp=3 里');
    assert.ok(has(3), '已装备 -> leaderInfo=3');
  },
  after: (s) => {
    const w = s.weapons.find((x) => x.onlyId === WID);
    assert.equal(w.level, 2, '强化要真落盘');
    assert.equal(s.items['1090001'], 47, '三份经验料要真扣');
  },
});

await checkHandler('B2 1202 UpgrageWeapon: 材料不够 -> 拒单且一分不扣', 1202, {
  save: armSave((s) => { s.weapons[0].level = 1; s.items['1090001'] = 1; }),
  req: GProto.concat(GProto.sfield(3, WID), whash(1090001, 3)),
  deny: /1202 材料不足.*lack 1090001<3/,
  after: (s) => {
    assert.equal(s.items['1090001'], 1, '不足时一分不扣');
    assert.equal(s.weapons.find((x) => x.onlyId === WID).level, 1, '等级不许动');
  },
});

await checkHandler('B2 1204 DecomposeWeapon: 只列真删掉的 onlyId + ShowItem_Push 发返还', 1204, {
  save: armSave(),
  req: GProto.concat(GProto.sfield(1, WMAT1), GProto.sfield(1, WID)), // WID 已装备 -> 不该被删
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has, pb }) => {
    const ids = dec.filter((f) => f.field === 1).map((f) => f.value.toString());
    assert.deepEqual(ids, [WMAT1], '已装备的那把不许出现在删除列表里');
    assert.ok(has(2), 'rewards=2 返还集合');
    const wi = pb.decodeFields(wOf(dec, 1) ? wOf(dec, 2).value : Buffer.alloc(0));
    assert.ok(wi.some((f) => f.field === 1), 'Rewards 里至少要有固定组 9004 的 1090101');
  },
  after: (s, { res }) => {
    assert.equal(s.weapons.filter((x) => x.onlyId === WMAT1).length, 0, '实例要真删(旧实现是每次现编列表, 写完就丢)');
    assert.ok(s.weapons.some((x) => x.onlyId === WID), '穿戴中的那把要留着');
    assert.ok(s.items['1090101'] >= 160, '固定组 9004 = 60 个改组零件(100-40+60)');
    const show = (res.extra ?? []).find(([h]) => h === 900009);
    assert.ok(show, '1204 的 handler 不看 rewards, 返还必须另走 ShowItem_Push(900009)');
    assert.ok((res.pushes ?? []).some(([h]) => h === DPUSH), '扣/发的数量靠 Data_Push 刷');
  },
});

await checkHandler('B2 1204 DecomposeWeapon: 全是上锁/已装备 -> 拒单且一把不删', 1204, {
  save: armSave((s) => { s.weapons[1].lock = 1; }),
  req: GProto.concat(GProto.sfield(1, WMAT1), GProto.sfield(1, WID)),
  deny: /1204 没有可分解/,
  after: (s) => {
    assert.equal(s.weapons.length, 4, '拒单不许删任何实例');
    assert.equal(s.items['1090101'], 100, '拒单不许发返还');
  },
});

await checkHandler('B2 1205 ChangeWeaponLock: 上锁状态落盘, weaponInfo 在字段 2 (不是 1)', 1205, {
  save: armSave(),
  req: GProto.concat(GProto.sfield(1, WMAT1), GProto.vfield(2, 1)),
  fields: (dec, { has }) => {
    assert.ok(has(2), 'ChangeWeaponLock_S2C 的 weaponInfo 是 2');
    assert.ok(!has(1), '字段 1 是 DecomposeWeapon 的写法, 这里发了等于没发(客户端 UpdateData(nil))');
  },
  after: (s) => {
    assert.equal(s.weapons.find((x) => x.onlyId === WMAT1).lock, 1, '锁状态要真落盘, 否则重启就解锁了');
  },
});

await checkHandler('B2 1207 UpgradeWeaponRefineLevel: 吞同名卡换精炼等级, 卡真删', 1207, {
  save: armSave(),
  req: GProto.concat(GProto.sfield(1, WID), GProto.sfield(2, WMAT1), GProto.sfield(2, WMAT2)),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has, pb }) => {
    assert.ok(has(2) && !has(1), 'UpgradeWeaponRefineLevel_S2C 的 weaponInfo 也是 2');
    const wi = pb.decodeFields(wOf(dec, 2).value);
    assert.equal(Number(wOf(wi, 12).value), 2, '两张 0 炼卡 = +2 (每张按 它的精炼等级+1 计)');
    assert.deepEqual(dec.filter((f) => f.field === 3).map((f) => f.value.toString()), [WMAT1, WMAT2],
      'consumeWeaponIds=3 少一条, 客户端仓库就留着已经吞掉的卡');
  },
  after: (s) => {
    const w = s.weapons.find((x) => x.onlyId === WID);
    assert.equal(w.refine, 2, '精炼等级要真落盘');
    // 只数测试实例: 物化会顺手给每个角色补一把默认式仗, 拿总长断言等于在测角色数.
    assert.equal(s.weapons.filter((x) => x.onlyId.startsWith('7TEST')).length, 2,
      '两张素材卡要真删, 剩下的应是 WID + 2★ 那把');
    assert.ok(!s.weapons.some((x) => x.onlyId === WMAT1 || x.onlyId === WMAT2), '素材卡要从存档里消失');
  },
});

await checkHandler('B2 1207 UpgradeWeaponRefineLevel: 超上限 / 素材已装备 -> 拒单不吞卡', 1207, {
  save: armSave((s) => { s.weapons[0].refine = 3; s.weapons[1].leaderId = 2002001; }),
  req: GProto.concat(GProto.sfield(1, WID), GProto.sfield(2, WMAT1)),
  deny: /1207 (超上限|素材不合法)/,
  after: (s) => {
    assert.equal(s.weapons.find((x) => x.onlyId === WID).refine, 3, '拒单后精炼等级不许动');
    assert.equal(s.weapons.filter((x) => x.onlyId.startsWith('7TEST')).length, 4, '拒单不许吞卡');
  },
});

await checkHandler('B2 1208 RecastingWeapon(PROP): 新属性进 18, 17 保持生效值', 1208, {
  save: armSave(),
  req: GProto.concat(GProto.sfield(1, WID), GProto.vfield(4, 1)),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has, pb }) => {
    assert.ok(has(1) && has(2), 'required weaponInfo=1 + recastingType=2');
    assert.equal(Number(wOf(dec, 2).value), 1, 'recastingType 原样回显');
    assertRecastShape('1208/PROP', pb.decodeFields(wOf(dec, 1).value), WCFG, 1);
  },
  after: (s) => {
    const w = s.weapons.find((x) => x.onlyId === WID);
    assert.equal(w.rand.key.length, 2, '4★ 生效组是 2 条属性');
    assert.equal(w.rand.skill.length, 1, '4★ 生效组是 1 条技能');
    assert.equal(w.last.skill.length, 0, '落盘的 last 只存重摇的那一半(属性), 别存两份真相');
    assert.equal(w.recastingTime, 1, '1208 要 +1 次**属性**洗练计数(它是终身计数, 不是时间戳)');
    assert.equal(w.recastingSkillTime, 0, '技能侧计数不许跟着涨');
    assert.equal(s.items['1090101'], 90, '扣 10 个改组零件');
    assert.equal(s.money['10'], 999999 - 7500, '扣 7500 金币');
  },
});

await checkHandler('B2 1208 RecastingWeapon(SKILL): 18 带新技能 + 照抄 17 的属性列(scope 显式 0)', 1208, {
  save: armSave(),
  req: GProto.concat(GProto.sfield(1, WID), GProto.vfield(4, 2)),
  fields: (dec, { pb }) => {
    const { cur, pend } = assertRecastShape('1208/SKILL', pb.decodeFields(wOf(dec, 1).value), WCFG, 2);
    assert.equal(pend.skill.length, cur.skill.length, '技能条数要与 17 对齐, 否则确认页 SkillItem 取到 nil');
  },
  after: (s) => {
    const w = s.weapons.find((x) => x.onlyId === WID);
    assert.equal(w.recastingSkillTime, 1, '技能侧计数 +1');
    assert.equal(w.recastingTime, 0, '属性侧计数不动');
    assert.equal(w.last.key.length, 0, 'last 只存技能那半');
  },
});

// 洗属性时锁 1 条: 锁定项必须原样出现在 18 里 (客户端送的是 0 基下标).
await checkHandler('B2 1208 RecastingWeapon(PROP) 锁定 1 条: 锁的那条原样保留, 另加 5 个固锁零件', 1208, {
  save: armSave(),
  req: GProto.concat(GProto.sfield(1, WID), GProto.vfield(2, 1), GProto.vfield(4, 1)),
  after: (s, { res }) => {
    const body = Buffer.isBuffer(res) ? res : res.body;
    const wi = GProto.decodeFields(GProto.decodeFields(body).find((f) => f.field === 1).value);
    const cur = randShape(wi, 17), pend = randShape(wi, 18);
    assert.ok(cur.key.includes(pend.key[1]) && cur.attr.includes(pend.attr[1]),
      `锁定的第 2 条没被原样带过去: 17=${JSON.stringify(cur.key)} 18=${JSON.stringify(pend.key)}`);
    assert.equal(pend.key[1], cur.key[1], '0 基下标 1 锁的应当正好是 17 的第 2 条');
    const w = s.weapons.find((x) => x.onlyId === WID);
    assert.equal(s.items['1090102'], 95, 'WeaponRefiningLock[1].consume2 = 5 个定向固锁零件');
    assert.equal(w.rand.key[1], cur.key[1], '17 在确认之前不许变');
  },
});

await checkHandler('B2 1208 RecastingWeapon: 2★ 没有技能位 -> 拒单(确认页会读对侧 #weaponRandomSkill)', 1208, {
  save: armSave(),
  req: GProto.concat(GProto.sfield(1, '7TEST0004'), GProto.vfield(4, 1)),
  deny: /1208 4|1208 2★ 不可洗练/,
  after: (s) => {
    const w = s.weapons.find((x) => x.onlyId === '7TEST0004');
    assert.equal(w.recastingTime, 0, '2★ 洗练被拒, 计数不许涨');
    assert.equal(s.items['1090101'], 100, '拒单不许扣洗练料');
  },
});

await checkHandler('B2 1208 RecastingWeapon: 零件不够 -> 拒单且不产生待确认', 1208, {
  save: armSave((s) => { s.items['1090101'] = 3; }),
  req: GProto.concat(GProto.sfield(1, WID), GProto.vfield(4, 1)),
  deny: /1208 消耗不足/,
  after: (s) => {
    const w = s.weapons.find((x) => x.onlyId === WID);
    assert.equal(w.last.key.length, 0, '扣不到钱就不许留下半个洗练结果');
    assert.equal(s.items['1090101'], 3, '一条都不扣');
  },
});

// 1209 需要先有"待确认": 用与 1208 同一套种子造一份(last 只存属性那半).
const armPending = (s) => {
  const w = s.weapons.find((x) => x.onlyId === WID);
  const base = WEAP.rollWeapon(WCFG, WEAP.seedOf(WID), SAVEM.emptyRand());
  w.rand = base;
  w.last = WEAP.pendingHalf(WEAP.rollWeapon(WCFG, WEAP.seedOf(WID, 1), base, WEAP.keepFor(base, 1)), 1);
  w.recastingTime = 1;
};

await checkHandler('B2 1209 SelectWeaponRandomInfo(NEW): 18 并进 17 后清空, 回体不再带 18', 1209, {
  save: armSave(armPending),
  req: GProto.concat(GProto.sfield(1, WID), GProto.vfield(2, 1), GProto.vfield(3, 2)),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { has, pb }) => {
    assert.ok(has(1) && has(2) && has(3), '三个 required 都得回显');
    const wi = pb.decodeFields(wOf(dec, 1).value);
    const cur = randShape(wi, 17);
    assertRandLegal('1209/17', cur, WCFG);
    assert.equal(wOf(wi, 18), null, '确认过之后 18 必须整个消失(留着客户端就一直挂在"未保存"状态)');
    assert.equal(Number(wOf(dec, 3).value), 2, 'selectType 原样回显');
  },
  after: (s, { dec, pb }) => {
    const w = s.weapons.find((x) => x.onlyId === WID);
    const cur = randShape(pb.decodeFields(wOf(dec, 1).value), 17);
    assert.deepEqual(w.rand.key, cur.key, '落盘的 rand 就是刚确认下来的一组');
    assert.equal(w.last.key.length, 0, 'last 要清空');
    assert.equal(w.rand.skill.length, 1, '技能那一半没被属性洗练动过');
  },
});

await checkHandler('B2 1209 SelectWeaponRandomInfo(OLD): 只清 18, 17 保持原值', 1209, {
  save: armSave(armPending),
  req: GProto.concat(GProto.sfield(1, WID), GProto.vfield(2, 1), GProto.vfield(3, 1)),
  fields: (dec, { pb }) => {
    const base = WEAP.rollWeapon(WCFG, WEAP.seedOf(WID), SAVEM.emptyRand());
    const wi = pb.decodeFields(wOf(dec, 1).value);
    const cur = randShape(wi, 17);
    assert.deepEqual(cur.key, base.key, '保留旧的 -> 17 必须还是进洗练前那一组');
    assert.equal(wOf(wi, 18), null, '18 要消失');
  },
  after: (s) => {
    assert.equal(s.weapons.find((x) => x.onlyId === WID).last.key.length, 0, 'OLD 也要把待确认清掉');
  },
});

await checkHandler('B2 1209 SelectWeaponRandomInfo: 没有待确认 / 类型不符 -> 拒单', 1209, {
  save: armSave(armPending),
  req: GProto.concat(GProto.sfield(1, WID), GProto.vfield(2, 2), GProto.vfield(3, 2)), // 请求技能, 待确认是属性
  deny: /1209 类型不符/,
  after: (s) => {
    const w = s.weapons.find((x) => x.onlyId === WID);
    assert.equal(w.last.key.length, 2, '拒单后待确认还得原样留着, 玩家可以重开确认页再选');
  },
});

// 登录列表是所有武装用例的"总检": 每把都要有 17、19/20 是计数、默认式仗的 defleaderId 才藏得住.
await check('B2 登录/仓库列表: 17 齐、19/20 不是时间戳、默认式仗 defleaderId=穿戴者', async () => {
  const restore = useSave(armSave());
  try {
    const { HANDLERS } = await import(`../${DIST}/payloads.js`);
    const res = HANDLERS[10007]({ msgId: 10007, packetUUid: 1, proto: GProto.vfield(1, 0), headerHex: '' });
    const body = Buffer.isBuffer(res) ? res : res.body;
    const list = GProto.decodeFields(body).filter((f) => f.field === 1);
    assert.ok(list.length >= 4, `列表应有测试的 4 把 + 各角色默认式仗, 现在 ${list.length}`);
    for (const f of list) {
      const wi = GProto.decodeFields(f.value);
      const only = wOf(wi, 6).value.toString();
      const cfg = Number(wOf(wi, 1).value);
      assert.ok(wOf(wi, 17), `${only}: 已装备/在仓库里的武装必须带 17(面板与确认页都读它)`);
      assertRandLegal(`列表 ${only}`, randShape(wi, 17), cfg);
      assert.equal(wOf(wi, 18), null, `${only}: 没洗过就不该有 18`);
      const t19 = Number(wOf(wi, 19).value);
      assert.ok(t19 < 1e6, `${only}: recastingTime 是终身计数, 现在发成了时间戳 ${t19}`);
      // defleaderId 认号不认人: 只有"派生号 7000000+穿戴者"才是默认式仗, 才该非 0(客户端据此摘出仓库).
      const isDefault = only === '7000000' + Number(wOf(wi, 2).value);
      assert.equal(Number(wOf(wi, 9).value) !== 0, isDefault,
        `${only}: defleaderId=${Number(wOf(wi, 9).value)} 与"是否默认式仗"(${isDefault})不一致 `
        + '(非默认式仗被标成默认 -> 仓库里看不见; 默认式仗标 0 -> 能被误分解)');
    }
    const w = list.map((f) => GProto.decodeFields(f.value)).find((wi) => wi.find((x) => x.field === 6)?.value.toString() === WID);
    assert.equal(Number(wOf(w, 9).value), 0, '测试武装不是派生号 -> defleaderId 必须 0(否则仓库里看不见)');
    // 其余角色没有装备行, 物化要按历史派生号 7000000+leaderId 补出默认式仗(客户端早就按它索引).
    const defs = list.map((f) => GProto.decodeFields(f.value)).filter((wi) => {
      const lv = Number(wOf(wi, 2).value);
      return lv > 0 && wOf(wi, 6).value.toString() === '7000000' + lv;
    });
    assert.ok(defs.length, '没装备的角色要物化出默认式仗');
    for (const d of defs) {
      assert.equal(Number(wOf(d, 9).value), Number(wOf(d, 2).value),
        '派生号的 defleaderId = 穿戴者, 客户端才把它从仓库列表里摘出去');
    }
  } finally {
    restore();
  }
});

// 物化必须"写一次就落得住": 三套 onlyId 并存时最容易写出"改了内存、重启就回原样"的假成功.
await check('B2 物化: 空/撞号 onlyId 走 wSeq 发号, 落盘后重启不跳号不跳数', async () => {
  const base = armSave();
  base.weapons.push(wInst('', WCFG), wInst(WMAT1, WCFG)); // 空号 + 撞号
  const restore = useSave(base);
  try {
    const { HANDLERS } = await import(`../${DIST}/payloads.js`);
    const run = () => {
      const r = HANDLERS[10007]({ msgId: 10007, packetUUid: 1, proto: GProto.vfield(1, 0), headerHex: '' });
      return Buffer.isBuffer(r) ? r : r.body;
    };
    run();
    const afterFirst = SAVEM.loadSave();
    const ids = afterFirst.weapons.map((w) => w.onlyId);
    assert.equal(new Set(ids).size, ids.length, `物化后 onlyId 必须唯一: ${ids.join(',')}`);
    assert.ok(afterFirst.wSeq >= 2, `两个坏号该发 2 个新 wSeq, 现在 ${afterFirst.wSeq}`);
    const randOfFirst = afterFirst.weapons.map((w) => w.rand.key.join('|')).join('/');
    run();                                       // 再走一遍(相当于重开客户端/重登)
    const again = SAVEM.loadSave().weapons.map((w) => w.rand.key.join('|')).join('/');
    assert.equal(again, randOfFirst, '随机数必须由 onlyId 播种, 同一把武器重启不跳数');
  } finally {
    restore();
  }
});

// 负控: 上面那批 17/18 断言不是空跑 —— 故意把 18 编短一条, 必须变红.
await check('B2 负控: 18 少编一条属性, 形状断言必须抛(这正是真机上"确认页崩"的形状)', () => {
  const cur = WEAP.rollWeapon(WCFG, WEAP.seedOf(WID), SAVEM.emptyRand());
  const pend = WEAP.pendingHalf(WEAP.rollWeapon(WCFG, WEAP.seedOf(WID, 1), cur, WEAP.keepFor(cur, 1)), 1);
  // WeaponRandomInfo 的手写编码: 存档形状(SaveWeaponRand)直接铺成 wire, 四列各自一条 tag.
  const enc = (r) => GProto.concat(
    ...r.skill.map((id) => GProto.vfield(1, id)),
    r.key.length ? GProto.bfield(2, GProto.concat(
      ...r.key.map((k) => GProto.vfield(1, k)),
      ...r.val.map((v) => GProto.dblfield(2, v)),
      GProto.dblfield(4, r.scope || 1),
      ...r.poolIdx.map((p) => GProto.vfield(5, p)),
      ...r.attrIdx.map((a) => GProto.vfield(6, a)),
    )) : Buffer.alloc(0),
  );
  const short = { ...pend, key: pend.key.slice(0, 1), val: pend.val.slice(0, 1),
    poolIdx: pend.poolIdx.slice(0, 1), attrIdx: pend.attrIdx.slice(0, 1) };
  const info = GProto.decodeFields(GProto.concat(
    GProto.bfield(17, enc(cur)),
    GProto.bfield(18, enc(short)),
  ));
  assert.ok(cur.key.length === 2 && short.key.length === 1, '负控得真的少一条, 否则这条检查是空跑');
  assert.throws(() => assertRecastShape('负控', info, WCFG, 1), /!=|条数/);
});

// ---------------------------------------------------------------- B3 通关结算 (3004/3005)
// 结算包不带关卡 id: 真机抓来的 3004 只有 result(1)/starArray(2)/fightPar(3), 3005 更少(1/2),
// 上下文全在 11028 里 -> B3 的用例一律"先进本再结算". 用 checkHandler 单调一条会把上一条用例
// 留下的战斗上下文当输入, 测到的不是真场景.
const battleSave = (mut) => {
  const s = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  Object.assign(s.player, { level: 1, exp: 0, maxExp: 20, strength: 100, maxStrength: 100 });
  delete s.levels['101101'];      // MainLevel 101101: userExpReward=10, 实例 [1000101,10101]
  delete s.trainLevels['100101']; // TrainLevel 100101: userExpReward=25, newLevelId=2000001, stageLevel=40201
  if (mut) mut(s);
  return s;
};
const fld = (dec, n) => dec.find((f) => f.field === n);
const num1 = (dec, n) => { const f = fld(dec, n); return f === undefined ? undefined : Number(f.value); };
const settleReq = (result, extra) => GProto.concat(GProto.vfield(1, result), ...(extra ?? []));
const enterBattle = (run, levelId, type) =>
  GProto.decodeFields(run(11028, GProto.concat(GProto.vfield(1, levelId), GProto.vfield(2, type))));

await check('B3 3004 OverMainLevel: 胜利按表发经验并推 playerChangeExpandLvl, 星级落盘', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (id, req) => HANDLERS[id]({ msgId: id, packetUUid: 1, proto: req, headerHex: '' });
  const restore = useSave(battleSave());
  try {
    const bei = GProto.decodeFields(fld(enterBattle(run, 101101, 1), 2).value);
    assert.equal(num1(bei, 2), 1000101, '主线的 levelInstanceId 要查 MainLevel.levelId(客户端拿它查 NewLevelInstance)');
    assert.equal(num1(bei, 3), 10101, 'levelStageId 要查 MainLevel.stageLevel');
    const req = settleReq(2, [GProto.vfield(2, 1), GProto.vfield(2, 2), GProto.vfield(2, 3), GProto.bfield(3, GProto.vfield(5, 42))]);
    const res = run(3004, req);
    const dec = GProto.decodeFields(res.body);
    ps.assertRequired('B3 3004 回包', 'OverMainLevel_S2C', dec, { pb: GProto, maxDepth: 3 });
    assert.equal(num1(dec, 2), 101101, 'battleId 取上下文里的关卡: 结算包自己不带');
    assert.equal(num1(dec, 3), 1, 'result=2(胜) 要回 true');
    assert.equal(num1(dec, 6), 42, 'passTime 取 fightPar.attackTime');
    assert.equal(num1(dec, 9), 1, '底档删了这条记录 -> firstPass=1');
    const pi = GProto.decodeFields(fld(dec, 7).value);
    assert.deepEqual([num1(pi, 1), num1(pi, 2), num1(pi, 3), num1(pi, 4)], [0, 1, 10, 1],
      'OverSoloPlayerInfo 四个值必须"结算前/结算后"成对: 四个同值等于告诉面板这一场没涨');
    const pl = GProto.decodeFields(fld(GProto.decodeFields(res.pushes.find(([h]) => h === DPUSH)[1]), 1).value);
    assert.deepEqual([num1(pl, 1), num1(pl, 2)], [1, 10], '顶栏经验条只认 Data_Push.playerChangeExpandLvl');
    assert.equal(loadSave().player.exp, 10, '10 经验 < PlayerGrow 1 级要的 20 -> 只进账不升级');
    const lv = loadSave().levels['101101'];
    assert.deepEqual(lv.stars, [1, 2, 3], '星级要落盘, 否则重登又变没打');
    assert.equal(lv.passTime, 42, '主线的 passTime 要落盘: 挂机拿它当单场时长(0 会让客户端除零)');
    // 客户端拿 ClockRequestMsg 轮询同一场结算: uniqueId 变了会被当新一场重铺面板, 经验还会发第二遍
    const again = run(3004, req);
    const againDec = GProto.decodeFields(again.body);
    assert.equal(num1(againDec, 1), num1(dec, 1), '同一场的 uniqueId 必须不变');
    assert.equal(num1(againDec, 9), 0, '第二遍不许还算首通');
    assert.equal(again.pushes.length, 0, '同场重复结算不许有推送');
    assert.equal(loadSave().player.exp, 10, '同场重复结算不许再发经验');
  } finally { restore(); }
});

await check('B3 3004: 打败/无结果 -> 不写星级不发经验, 但回包照样合规(客户端在轮询)', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (id, req) => HANDLERS[id]({ msgId: id, packetUUid: 1, proto: req, headerHex: '' });
  const restore = useSave(battleSave());
  try {
    enterBattle(run, 101101, 1);
    for (const result of [3, 0]) {
      const res = run(3004, settleReq(result, [GProto.bfield(3, GProto.vfield(5, 7))]));
      const dec = GProto.decodeFields(res.body);
      ps.assertRequired(`B3 3004 result=${result} 回包`, 'OverMainLevel_S2C', dec, { pb: GProto, maxDepth: 3 });
      assert.equal(num1(dec, 3), 0, `result=${result} 不许回成胜利`);
      assert.equal(res.pushes.length, 0, '没赢不许推经验/等级');
    }
    assert.equal(loadSave().levels['101101'], undefined, '打败了不许记通关');
    assert.equal(loadSave().player.exp, 0, '没赢不许发经验');
  } finally { restore(); }
});

await check('B3 3005 OverTrainLevel: 实例查 TrainLevel, 次数/passTime 落盘, 升级补的体力同包推', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (id, req) => HANDLERS[id]({ msgId: id, packetUUid: 1, proto: req, headerHex: '' });
  const restore = useSave(battleSave());
  try {
    const bei = GProto.decodeFields(fld(enterBattle(run, 100101, 2), 2).value);
    assert.equal(num1(bei, 2), 2000001, '训练本的实例 id 来自 TrainLevel.newLevelId —— 给主线的会卡在进战斗加载');
    assert.equal(num1(bei, 3), 40201, '训练本的 levelStageId 来自 TrainLevel.stageLevel');
    const res = run(3005, settleReq(2, [GProto.bfield(2, GProto.vfield(5, 31))]));
    const dec = GProto.decodeFields(res.body);
    ps.assertRequired('B3 3005 回包', 'OverTrainLevel_S2C', dec, { pb: GProto, maxDepth: 3 });
    assert.equal(num1(dec, 2), 100101);
    assert.equal(num1(dec, 5), 31, 'passTime 是 required 5(主线那条是 6), 串号就变成"秒数为 0"');
    assert.equal(num1(dec, 8), 1, '底档没这条训练记录 -> firstPass=1');
    const tli = GProto.decodeFields(fld(dec, 7).value);
    assert.deepEqual([num1(tli, 1), num1(tli, 2), num1(tli, 3), num1(tli, 8)], [100101, 1, 1, 31],
      'TrainLevelInfo: 新记录起算 1 次, passTime 不许给 0(挂机按它算单场时长)');
    const rec = loadSave().trainLevels['100101'];
    assert.equal(rec.passTime, 31, '通关记录要落盘');
    assert.equal(rec.attackNum, 1);
    assert.deepEqual([loadSave().player.level, loadSave().player.exp], [2, 5], '25 经验 >= 1 级的 20 -> 升一级余 5');
    const dp = GProto.decodeFields(res.pushes.find(([h]) => h === DPUSH)[1]);
    assert.deepEqual([num1(GProto.decodeFields(fld(dp, 1).value), 1), num1(GProto.decodeFields(fld(dp, 1).value), 2)], [2, 5]);
    assert.ok(fld(dp, 3), '升级送的那笔体力要同包推 changeStrength=3, 否则"弹了 +10 却没到账"');
    assert.equal(num1(GProto.decodeFields(fld(dp, 3).value), 1), loadSave().player.strength);
    // 第二场(新 uniqueId): 次数累加, 首通归 0
    enterBattle(run, 100101, 2);
    const two = GProto.decodeFields(run(3005, settleReq(2, [GProto.bfield(2, GProto.vfield(5, 20))])).body);
    assert.equal(num1(GProto.decodeFields(fld(two, 7).value), 3), 2, '第二场的 attackNum 该涨到 2');
    assert.equal(num1(two, 8), 0, '第二场不是首通');
  } finally { restore(); }
});

await check('B3 3005: 上一场是主线战斗 -> 训练结算不认关卡(两边行 id 重叠, 只能按类型分流)', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (id, req) => HANDLERS[id]({ msgId: id, packetUUid: 1, proto: req, headerHex: '' });
  const restore = useSave(battleSave());
  try {
    enterBattle(run, 101101, 1);            // 主线 1 级本
    const res = run(3005, settleReq(2, [GProto.bfield(2, GProto.vfield(5, 15))]));
    const dec = GProto.decodeFields(res.body);
    ps.assertRequired('B3 3005 非训练场回包', 'OverTrainLevel_S2C', dec, { pb: GProto, maxDepth: 3 });
    assert.equal(num1(dec, 2), 0, '认不出关卡就不许瞎给 battleId');
    assert.equal(num1(dec, 3), 0, 'result 必须为假: 客户端 msg.result 为真才 PassTrainLevel(查表)');
    assert.ok(!fld(dec, 7), '不许回 id=0 的 trainLevelInfo 让客户端去查表');
    assert.equal(loadSave().trainLevels['101101'], undefined, '主线的 101101 不许被写成训练记录');
    assert.equal(loadSave().levels['101101'], undefined, '训练结算也不许写主线进度');
  } finally { restore(); }
});

// 假服重启后 lastBattle 清零(内存态)，此时客户端把这一场判成胜利并来结算：
// 客户端 OverMainLevelHandler 见 msg.result 为真就**无条件** index msg.mainLevelInfo.id —— 认不出关卡
// 就必须连 result 一起回假，否则会崩在结算面板上（与 3005 那条同口径）。
await check('B3 3004: 认不出关卡(重启后 lastBattle 清零) -> result 与 mainLevelInfo 同进同出', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (id, req) => HANDLERS[id]({ msgId: id, packetUUid: 1, proto: req, headerHex: '' });
  const restore = useSave(battleSave());
  try {
    enterBattle(run, 0, 1);                 // 上下文里关卡 id = 0, 等价于"重启后没记下这一场"
    const dec = GProto.decodeFields(run(3004, settleReq(2, [GProto.vfield(2, 3), GProto.bfield(3, GProto.vfield(5, 20))])).body);
    ps.assertRequired('B3 3004 无上下文回包', 'OverMainLevel_S2C', dec, { pb: GProto, maxDepth: 3 });
    assert.equal(num1(dec, 3), 0, '给不出 mainLevelInfo 就不许回 result=1');
    assert.ok(!fld(dec, 8), '不许回 id=0 的 mainLevelInfo 让客户端去查表');
    assert.equal(loadSave().levels['0'], undefined, '认不出关卡不许写档');
  } finally { restore(); }
});

// ---------------------------------------------------------------- B4 挂机/外派 (30400-30405)// 会话时间挂在真实时钟上, 用例的 startTime/endTime 一律按"现在"推出来写, 不写死秒数。
// 数值口径(实测表值): TrainLevel 100101 单场 30 秒(取通关记录 passTime)、每场 25 感知、
// 每场掉 590001 -> Drop -> 物品 10 ×28500、每场 25 导师经验。
// 等级取 50 而不是 1: lv1 只要 20 经验就升级, 而升级会附带一笔 addPower 感知, 那样"扣了多少体力"
// 就断言不准了; lv50 升一级要 700 经验, 用例最多发 100, 滚不到级。
const HU_LID = 100101;
const HU_PER = 30;
const HU_COST = 25;
const HU_DROP = 28500;
const HU_LV = 50;
const nowSecOf = () => Math.floor(Date.now() / 1000);
const hangSave = (mut) => {
  const s = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  Object.assign(s.player, { level: HU_LV, exp: 0, maxExp: 700, strength: 120, maxStrength: 200, strengthRealTime: nowSecOf() });
  s.money = { ...s.money, '10': 0 };
  s.items = {}; // 断言"拒单不许发奖励"要看干净的数量, 别留别的用例的余货
  s.hangUp = { type: 0, levelId: 0, times: 0, startTime: 0, endTime: 0, state: 0 };
  s.trainLevels[String(HU_LID)] = { id: HU_LID, passTime: HU_PER, todayAttackNum: 1, attackNum: 1, lastAttackTime: 1700000000000 };
  if (mut) mut(s);
  return s;
};
/** 起一个会话: startAgo 秒前开始, 计划 times 场, 单场 HU_PER 秒. 返回的档可以读 hangUp 做时间断言. */
const sessionSave = ({ state, startAgo, times = 4, strength = 20 }) => hangSave((s) => {
  const now = nowSecOf();
  s.player.strength = strength;
  s.hangUp = { type: 2, levelId: HU_LID, times, startTime: now - startAgo, endTime: now - startAgo + times * HU_PER, state };
});
const huReq = (type, levelId, times) =>
  GProto.concat(GProto.vfield(1, type), GProto.vfield(2, levelId), GProto.vfield(3, times));
const infoOf = (dec) => GProto.decodeFields(fld(dec, 1).value);
const rewardOfPush = (res) => {
  const p = (res.extra ?? []).concat(res.pushes ?? []).find(([h]) => h === 900009);
  assert.ok(p, '奖励必须有 ShowItem_Push(900009), 客户端只认这一条弹窗');
  const dec = GProto.decodeFields(p[1]);
  assert.equal(num1(dec, 1), 702, 'comeFrom 必须是 ActionEnum.HangUpGet=702: 其它挂机 Action 在 Lua 里没有分支');
  return GProto.decodeFields(fld(dec, 2).value).map((r) => GProto.decodeFields(r.value));
}

await checkHandler('B4 30401 StartHangUp: 一次扣满全场感知, 会话按记录的 passTime 排时间', 30401, {
  save: hangSave(),
  req: huReq(2, HU_LID, 2),
  push: [[DPUSH, 'Data_Push']],
  fields: (dec, { res }) => {
    const info = infoOf(dec);
    assert.equal(num1(info, 1), 2, 'info.type 回显 CONST_BattleType=2(训练本): 客户端拿它查 GetPassedMinTime');
    assert.equal(num1(info, 2), HU_LID, 'info.levelId 回显关卡表 id');
    assert.equal(num1(info, 3), 2, 'info.times 回显计划场次');
    assert.equal(num1(info, 6), 1, 'state=1 挂机中');
    assert.equal(num1(info, 4), Math.floor(Date.now() / 1000), 'startTime 就是服务端此刻(HeartManager 的服务器时间=本地秒, 客户端拿它算已进行时间)');
    assert.equal(num1(info, 5) - num1(info, 4), 2 * HU_PER, 'endTime-startTime 必须等于 场次×单场秒数(客户端按它算进度)');
    const dp = GProto.decodeFields(res.pushes.find(([h]) => h === DPUSH)[1]);
    assert.equal(num1(GProto.decodeFields(fld(dp, 3).value), 1), 120 - 2 * HU_COST, '扣了感知要推 changeStrength, 顶栏才动');
  },
  after: (s) => {
    assert.equal(s.player.strength, 120 - 2 * HU_COST, '挂机的体力按计划场次一次性扣(客户端也是按总数拦的)');
    assert.equal(s.hangUp.state, 1, '会话要落盘: 重启后 GetHangUpInfo 还得能读出来');
  },
});

await check('B4 30401 五种不许开始: 没通关 / 次数超上限 / 感知不足 / 已在挂机 / 类型不是挂机 -> 拒单且不动档', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (req, save) => {
    const restore = useSave(save);
    try {
      const res = HANDLERS[30401]({ msgId: 30401, packetUUid: 1, proto: req, headerHex: '' });
      assert.ok(res && res.deny, `期望拒单, 实际回了 body=${(res.body ?? res).length ?? 0}B: ${JSON.stringify(res)}`);
      assert.equal((res.pushes ?? []).length + (res.extra ?? []).length, 0, '拒单不许带推送(推送会让客户端刷新/弹窗)');
      const s = loadSave();
      assert.equal(s.hangUp.state, save.hangUp.state, '拒单不许动会话(在挂机的那条要还是 1)');
      assert.equal(s.player.strength, save.player.strength, '拒单不许扣体力');
      assert.equal(s.money['10'], 0, '拒单不许发奖励');
      return res.deny;
    } finally { restore(); }
  };
  const cases = [
    [huReq(2, HU_LID, 1), hangSave((s) => delete s.trainLevels[String(HU_LID)]), /还没通关/, '未通关要按 471001 拒'],
    [huReq(2, HU_LID, 11), hangSave(), /1\.\.10/, '次数要按 HangUpBattle.maxNum 拦'],
    [huReq(2, HU_LID, 5), hangSave(), /感知不足/, '5 场要 125 感知, 只有 120 -> 该拒'],
    [huReq(2, HU_LID, 2), sessionSave({ state: 1, startAgo: 10 }), /已有挂机/, '挂机中不许再开一场'],
    [huReq(5, HU_LID, 1), hangSave(), /不是主线\(1\)/, '战斗类型 5(塔)不是挂机类型'],
    [huReq(2, 999999, 1), hangSave(), /表里没/, '不存在的关卡 id 要拦住(客户端不会发, 但假服不能崩)'],
  ];
  for (const [req, save, re, why] of cases) assert.match(run(req, save), re, `${why}`);
});

// 客户端拿 passTime 当除数, 所以"假服永远不会把 0 秒的单场时长发出去"是挂机成立的前提。
// 读档时 safePassTime 已经把 0/负/小数兜成 30, 于是这条只能从存档层断言, 不该由 handler 再防一遍。
await check('B4 兜底: 存档里 passTime 为 0 或畸形的记录, 读档就变成 30 秒(客户端才不会除零)', async () => {
  const { loadSave } = await import(`../${DIST}/save.js`);
  const restore = useSave(hangSave((s) => {
    s.trainLevels['100102'] = { id: 100102, passTime: 0, todayAttackNum: 1, attackNum: 1, lastAttackTime: 0 };
    s.trainLevels['100103'] = { id: 100103, passTime: -5, todayAttackNum: 1, attackNum: 1, lastAttackTime: 0 };
    s.trainLevels['100104'] = { id: 100104, passTime: 0.4, todayAttackNum: 1, attackNum: 1, lastAttackTime: 0 };
    s.levels['101102'] = { id: 101102, passTime: 0, todayAttackNum: 1, attackNum: 1, lastAttackTime: 0, stars: [1] };
  }));
  try {
    const s = loadSave();
    for (const k of ['100102', '100103', '100104']) assert.equal(s.trainLevels[k].passTime, 30, `训练本 ${k} 的耗时该兜到 30`);
    assert.equal(s.levels['101102'].passTime, 30, '主线关同样要兜住');
    assert.deepEqual(s.levels['101102'].stars, [1], '兜耗时不许顺手吃掉星级');
  } finally { restore(); }
});

await check('B4 30400 GetHangUpInfo: 到点自己把 state 1->2 并落盘(客户端只会重发这一条)', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const read = (save) => {
    const restore = useSave(save);
    try {
      const res = HANDLERS[30400]({ msgId: 30400, packetUUid: 1, proto: Buffer.alloc(0), headerHex: '' });
      return { dec: GProto.decodeFields(res.body ?? res), after: loadSave() };
    } finally { restore(); }
  };
  const due = read(sessionSave({ state: 1, startAgo: 200, times: 4 })); // endTime 在 80 秒前就到点
  ps.assertRequired('B4 30400 到点回包', 'GetHangUpInfo_S2C', due.dec, { pb: GProto, maxDepth: 3 });
  assert.equal(num1(infoOf(due.dec), 6), 2, '到点了必须回 state=2(完成未领), 红点 89 也靠它');
  assert.equal(due.after.hangUp.state, 2, '翻转要落盘, 不然每次读都重算一遍');
  const early = read(sessionSave({ state: 1, startAgo: 30, times: 4 })); // 还剩 90 秒
  assert.equal(num1(infoOf(early.dec), 6), 1, '没到点不许偷翻状态');
  assert.equal(early.after.hangUp.state, 1, '没到点不许改档');
  const idle = read(hangSave());
  assert.equal(num1(infoOf(idle.dec), 6), 0, '新号读挂机 -> state=0, 客户端据此走"未挂机"分支');
});

await checkHandler('B4 30403 ReceiveHangUpReward: 按场真发掉落+经验, 奖励走 ShowItem_Push(702)', 30403, {
  save: sessionSave({ state: 2, startAgo: 200, times: 4 }),
  fields: (dec, { res }) => {
    assert.equal(num1(infoOf(dec), 6), 0, '领完清会话: state=0');
    const settle = fld(dec, 2);
    assert.ok(settle, 'settleInfo 是 required, 缺席客户端 pbNew.decode 就报错');
    assert.equal(GProto.decodeFields(settle.value).length, 0, 'settleInfo 带 type 客户端就会去查关卡表, 挂机不产生新通关 -> 只许空');
    const items = rewardOfPush(res);
    assert.equal(items.length, 1, '训练本每场只掉一种(物品 10)');
    assert.equal(num1(items[0], 1), 10, '掉的物品 id');
    assert.equal(num1(items[0], 3), 4 * HU_DROP, '4 场要按 4 次 roll 累加');
  },
  after: (s) => {
    assert.equal(s.money['10'], 4 * HU_DROP, '奖励要真进账');
    assert.equal(s.trainLevels[String(HU_LID)].attackNum, 1 + 4, '挂机场次计入进本次数');
    assert.ok(s.player.exp > 0 || s.player.level > 1, '4 场 ×25 导师经验要真发');
    assert.equal(s.hangUp.times, 0, '会话清了');
  },
});

await checkHandler('B4 30403: 还没挂完就来领 -> 拒单, 不发奖励', 30403, {
  save: sessionSave({ state: 1, startAgo: 30, times: 4 }),
  deny: /还差/,
  after: (s) => {
    assert.equal(s.hangUp.state, 1, '拒单不许动会话');
    assert.equal(s.money['10'], 0, '拒单不许发奖励');
  },
});

await checkHandler('B4 30404 HangUpCancel: 已完成场次照样结算, 未开始的场次返还感知', 30404, {
  save: sessionSave({ state: 1, startAgo: 70, times: 4 }),
  fields: (dec, { res }) => {
    assert.equal(num1(infoOf(dec), 6), 0, '召回后会话清掉');
    assert.equal(GProto.decodeFields(fld(dec, 2).value).length, 0, 'settleInfo 只许空');
    assert.equal(num1(rewardOfPush(res)[0], 3), 2 * HU_DROP, '70 秒/单场 30 秒 -> ceil 剩 2 场, 完成的 2 场要发');
  },
  after: (s) => {
    assert.equal(s.money['10'], 2 * HU_DROP, '已完成场次的奖励不能凭空丢');
    assert.equal(s.player.strength, 20 + 2 * HU_COST, '未开始的 2 场体力要返还(客户端确认框就是这个口径)');
    assert.equal(s.trainLevels[String(HU_LID)].attackNum, 1 + 2, '只计已完成的场次');
  },
});

await checkHandler('B4 30405 HangUpSweep: 当场结清 n 场, 回包只有 settleInfo(没有 info)', 30405, {
  save: hangSave(),
  req: huReq(2, HU_LID, 3),
  fields: (dec, { res }) => {
    assert.equal(dec.length, 1, 'HangUpSweep_S2C 只有 settleInfo=1, 多回一个字段就是编的');
    assert.equal(GProto.decodeFields(fld(dec, 1).value).length, 0, 'settleInfo 只许空');
    assert.equal(num1(rewardOfPush(res)[0], 3), 3 * HU_DROP, '扫 3 场发 3 场');
  },
  after: (s) => {
    assert.equal(s.player.strength, 120 - 3 * HU_COST, '扫荡按场次扣体力');
    assert.equal(s.hangUp.state, 0, '扫荡不占挂机会话');
    assert.equal(s.money['10'], 3 * HU_DROP, '扫荡的奖励真进账');
  },
});

const huSpeed = sessionSave({ state: 1, startAgo: 30, times: 4 });
await checkHandler('B4 30402 HangUpSpeedUp: endTime 前移 场次×单场, 不扣道具(表里没有加速道具)', 30402, {
  save: huSpeed,
  req: GProto.vfield(1, 2),
  fields: (dec) => {
    const info = infoOf(dec);
    assert.equal(num1(info, 5), huSpeed.hangUp.endTime - 2 * HU_PER, '加速 2 场 = 剩余时间少 2×单场秒');
    assert.equal(num1(info, 4), huSpeed.hangUp.startTime, 'startTime 不动, 客户端的已进行时间才连续');
    assert.equal(num1(info, 6), 1, '还剩 30 秒, 不许偷翻成完成');
  },
  after: (s) => assert.equal(s.hangUp.endTime, huSpeed.hangUp.endTime - 2 * HU_PER, '加速要落盘'),
});

await check('B4 30402/30404/30405 的越界: 不在挂机中不许加速 / 没挂机不许召回 / 挂机中不许扫荡', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (id, req, save) => {
    const restore = useSave(save);
    try { return { res: HANDLERS[id]({ msgId: id, packetUUid: 1, proto: req, headerHex: '' }), after: loadSave() }; }
    finally { restore(); }
  };
  assert.match(run(30402, GProto.vfield(1, 1), hangSave()).res.deny ?? '', /不在挂机中/);
  assert.match(run(30404, Buffer.alloc(0), hangSave()).res.deny ?? '', /没在挂机/);
  assert.match(run(30405, huReq(2, HU_LID, 1), sessionSave({ state: 1, startAgo: 10 })).res.deny ?? '', /挂机进行中/);

  // 会话还挂着, 但通关记录被改档改掉了 -> 单场时长无从计算: 加速该拒, 召回该全结(那几场是开场时就付过钱的)
  const gone = sessionSave({ state: 1, startAgo: 30, times: 4 });
  delete gone.trainLevels[String(HU_LID)];
  assert.match(run(30402, GProto.vfield(1, 1), gone).res.deny ?? '', /算不出单场时长/, '记录没了不许瞎改 endTime');
  const cancel = run(30404, Buffer.alloc(0), gone);
  assert.ok(!cancel.res.deny, `召回不该被记录缺失卡住: ${cancel.res.deny}`);
  assert.equal(num1(rewardOfPush(cancel.res)[0], 3), 4 * HU_DROP, '记录没了按全部场次结算, 不能凭空吞奖励');
  assert.equal(cancel.after.player.strength, 20, '计划场次都算完成了, 没有可返还的');
  assert.equal(cancel.after.hangUp.state, 0, '会话清掉');
});

// ---------------------------------------------------------------- 4i. B5 任务/活跃度 (3302/3303/3304/3308/3309)
// 底档: 任务块清空, 章节 101 / 日常组 10001, rollDay/rollWeek 钉在"此刻"(毫秒) —— 不然
// rollTasks 会把这份档当跨天档先清一遍, 用例里写的计数与已领记录凭空消失.
const MAIN_TASK = 2000101;       // 第 101 章第一条: cond 1401(通关), 真值在客户端本地 -> 服务端不该拦
const MAIN_REST = [2000102, 2000103, 2000104, 2000105, 2000106];
const CHAPTER_OVER = 2000113;    // 第 101 章的 cond 1901"本章全部完成"
const D_SEC = 1000004;           // 日常 cond 1002 秘书互动 1 次 (ap10)
const D_STRENGTH = 1000013;      // 日常 cond 1502 累计消耗 50 点感知 (param=13, ap20)
const D_TIMED = [1000001, 1000002];   // 日常 cond 3000 两档时段登录 (12 点 / 16 点)

const taskSave = (mut) => {
  const s = trainSave();
  const sec = Math.floor(Date.now() / 1000);
  s.player.level = 1;
  s.tasks = {
    taskChapter: 101, dayGroupIndex: 10001, dayTaskPoint: 0, weekTaskPoint: 0,
    passedTasks: {}, counters: {}, passedDayPoints: [], passedWeekPoints: [],
    rollDay: sec * 1000, rollWeek: sec * 1000,
  };
  if (mut) mut(s);
  return s;
};
const idReq = (id) => GProto.vfield(1, id);
const taskOfPush = (res, head) => {
  const p = (res.pushes ?? []).concat(res.extra ?? []).find(([h]) => h === head);
  assert.ok(p, `推送里找不到 ${head}`);
  return GProto.decodeFields(p[1]);
};
/** ProtoHashInt2Int{key=1,value=2} 摊成 [[key,value],..] */
const kvList = (dec, field) => dec.filter((f) => f.field === field)
  .map((f) => GProto.decodeFields(f.value))
  .map((x) => [Number(fld(x, 1)?.value), Number(fld(x, 2)?.value)]);

await checkHandler('B5 3303 SubmitTask: 客户端本地算的那类(通关)不拦, overTask 回 id+秒, 奖走 ShowItem_Push(1001)', 3303, {
  save: taskSave(),
  req: idReq(MAIN_TASK),
  push: [[900009, 'ShowItem_Push']],
  fields: (dec, { res }) => {
    assert.equal(num1(dec, 2), 0, 'dayTaskPoint=2: 主线任务不给活跃度点');
    assert.equal(num1(dec, 3), 101, 'chapterIndex=3 要回(和客户端不一致才会 InitTaskList)');
    assert.equal(num1(dec, 5), 0, 'weekTaskPoint=5 是 required, 没涨也得回 0');
    const over = kvList(dec, 4);
    assert.equal(over.length, 1, 'overTask 只列刚领的这条');
    assert.equal(over[0][0], MAIN_TASK, 'overTask.key 是任务 id');
    const secNow = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(over[0][1] - secNow) <= 2, `overTask.value 是完成时间(秒), 现在 ${over[0][1]}`);
    assert.equal(num1(taskOfPush(res, 900009), 1), 1001, 'comeFrom=ActionEnum.ComminTask');
    const dp = taskOfPush(res, DPUSH);
    const money = dp.filter((f) => f.field === 2).flatMap((f) => kvList(GProto.decodeFields(f.value), 1));
    assert.ok(money.some(([, itemId]) => itemId === 10), '奖励含贡献点数(10) -> changeMoney=2 要带上, 否则顶栏要等重登才对得上');
    assert.ok(dp.some((f) => f.field === 10), '奖励含素材 -> changePart=10 要带上, 否则背包数量不动');
  },
  after: (s) => {
    assert.ok(s.tasks.passedTasks[String(MAIN_TASK)] > 0, '领奖要落盘: 重登靠 taskInfo=48 认它');
    assert.equal(s.tasks.counters['total:2502:2'], 1, '完成次数按 missionType 记一笔 2502');
  },
});

await checkHandler('B5 3303: 已领过的再发一次 -> 拒单, 完成时间与奖都不动', 3303, {
  save: taskSave((s) => { s.tasks.passedTasks[String(MAIN_TASK)] = 1700000000; }),
  req: idReq(MAIN_TASK),
  deny: /已领过/,
  after: (s) => {
    assert.equal(s.tasks.passedTasks[String(MAIN_TASK)], 1700000000, '拒单不能改写完成时间');
    assert.deepEqual(s.tasks.counters, {}, '拒单不该顺带记完成次数');
  },
});

await check('B5 3303: 后端型条件按计数拦 (day:1502:13 要 50 点), 数够了才发并把 ap 点计进日常', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (save) => {
    const restore = useSave(save);
    try {
      return { res: HANDLERS[3303]({ msgId: 3303, packetUUid: 1, proto: idReq(D_STRENGTH), headerHex: '' }), after: loadSave() };
    } finally { restore(); }
  };
  const noKey = run(taskSave());
  assert.match(noKey.res.deny ?? '', /进度 0\/50/, '一次都没消耗过 -> 就是 0, 不能当"看不见"放行');
  const short = run(taskSave((s) => { s.tasks.counters['day:1502:13'] = 49; }));
  assert.match(short.res.deny ?? '', /进度 49\/50/);
  assert.equal(short.after.tasks.passedTasks[String(D_STRENGTH)], undefined, '拦下时不能把这条标成已领');
  const ok = run(taskSave((s) => { s.tasks.counters['day:1502:13'] = 50; }));
  assert.ok(!ok.res.deny, `数够了该放行, 实际 ${ok.res.deny}`);
  assert.equal(ok.after.tasks.dayTaskPoint, 20, 'ap20 进日常活跃点');
  assert.equal(ok.after.tasks.counters['day:2303'], 20, '活跃点数本身也是 2303 的一条计数');
});

await checkHandler('B5 3308 BatchSubmitTask: 逐条判, overTask 只列领到的那条', 3308, {
  save: taskSave((s) => {
    s.tasks.passedTasks[String(MAIN_TASK)] = 1700000000;   // 已领 -> 跳过
    s.tasks.counters['day:1002'] = 1;                      // 秘书互动那条达标
  }),
  req: GProto.concat(idReq(MAIN_TASK), idReq(CHAPTER_OVER), idReq(D_SEC), GProto.vfield(2, 1)),
  fields: (dec, { res }) => {
    assert.deepEqual(kvList(dec, 3).map(([k]) => k), [D_SEC], '两条不成立的不能混进 overTask');
    assert.equal(num1(dec, 1), 10, 'dayTaskPoint=1 是那条日常任务的 ap');
    assert.equal(num1(dec, 4), 0, 'weekTaskPoint=4 是 required');
    assert.equal(num1(taskOfPush(res, 900009), 1), 1001);
  },
  after: (s) => {
    assert.ok(s.tasks.passedTasks[String(D_SEC)], '达标那条要落盘');
    assert.equal(Object.keys(s.tasks.passedTasks).length, 2, '跳过的那条不能新增');
  },
});

await checkHandler('B5 3308: 一条都不成立 -> 拒单且不新增已领', 3308, {
  save: taskSave(),
  req: GProto.concat(idReq(D_SEC), idReq(D_STRENGTH), GProto.vfield(2, 1)),
  deny: /没有一条可领/,
});

await checkHandler('B5 3302 GetActivePointReward: 达标格全领, activePointId 只回这次新领的', 3302, {
  save: taskSave((s) => { s.tasks.dayTaskPoint = 45; }),
  req: GProto.concat(idReq(1), idReq(2), idReq(3)),
  push: [[900009, 'ShowItem_Push']],
  fields: (dec, { res }) => {
    assert.deepEqual(dec.filter((f) => f.field === 2).map((f) => Number(f.value)), [1, 2],
      '45 点够 20/40 两格, 60 那格不许混进来');
    assert.ok(dec.some((f) => f.field === 1), 'reward=1 带 Rewards(留给抓包对账)');
    assert.equal(num1(taskOfPush(res, 900009), 1), 1002, 'comeFrom=ActionEnum.DayTaskPoint');
  },
  after: (s) => assert.deepEqual(s.tasks.passedDayPoints, [1, 2], '已领格子要落盘, 重登靠 taskInfo=48 认'),
});

await checkHandler('B5 3302: 点数不够 -> 拒单且不动格子', 3302, {
  save: taskSave((s) => { s.tasks.dayTaskPoint = 10; }),
  req: idReq(1),
  deny: /没一条达标/,
  after: (s) => assert.deepEqual(s.tasks.passedDayPoints, []),
});

await checkHandler('B5 3309 GetWeekActivePointReward: 回体只有 repeated id, 奖靠 ShowItem_Push', 3309, {
  save: taskSave((s) => { s.tasks.weekTaskPoint = 25; }),
  req: idReq(26),
  push: [[900009, 'ShowItem_Push']],
  fields: (dec) => {
    assert.deepEqual(dec.map((f) => f.field), [1], 'GetWeekActivePointReward_S2C 只有 id=1, 别塞 reward 进去');
    assert.equal(Number(fld(dec, 1).value), 26);
  },
  after: (s) => assert.deepEqual(s.tasks.passedWeekPoints, [26]),
});

await checkHandler('B5 3304 SetSpecialTaskProgress: 记日常组那条并推 900007', 3304, {
  save: taskSave(),
  req: GProto.concat(idReq(1002), GProto.vfield(2, 1)),
  push: [[900007, 'TaskProgress_Push']],
  fields: (dec) => assert.equal(num1(dec, 1), 0, 'errCode=1 是 required, 缺了 pbNew.decode 直接报错'),
  after: (s, { res }) => {
    assert.equal(s.tasks.counters['day:1002'], 1, '三个口径各记一份, 日常行取 day:');
    assert.equal(s.tasks.counters['total:1002'], 1);
    assert.deepEqual(kvList(taskOfPush(res, 900007), 1), [[D_SEC, 1]],
      '只推"客户端此刻看得见"的那一条(10002 组的秘书互动不在当前日常组)');
  },
});

await check('B5 3304 时段登录: 上报不带档位, 按 40000/40001 两档各补一次, 第三发不再涨', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const restore = useSave(taskSave());
  try {
    const req3000 = idReq(3000);
    const call = () => kvList(taskOfPush(HANDLERS[3304]({ msgId: 3304, packetUUid: 1, proto: req3000, headerHex: '' }), 900007), 1);
    assert.deepEqual(call(), [[D_TIMED[0], 1]], '第一发补 12 点档, 只推那一条');
    const c1 = loadSave().tasks.counters;
    assert.equal(c1['day:3000:40000'], 1, '该补上 40000 档');
    assert.equal(c1['day:3000:40001'], undefined, '16 点档这发不该一起补');
    assert.deepEqual(call(), [[D_TIMED[0], 1], [D_TIMED[1], 1]],
      '第二发把 16 点档也记上; 按 cond 找可见行, 所以两条都进推送(值幂等, 客户端覆盖同一份数)');
    assert.equal(loadSave().tasks.counters['day:3000:40001'], 1, '该补上 40001 档');
    const third = HANDLERS[3304]({ msgId: 3304, packetUUid: 2, proto: req3000, headerHex: '' });
    assert.ok(Buffer.isBuffer(third) || !third.deny, '两档都满了只是不再涨, 不该报错');
    assert.ok(Buffer.isBuffer(third) || !third.pushes?.length, '没有变化就不挂 900007');
    const c = loadSave().tasks.counters;
    assert.equal(c['day:3000'], 2, '两档满了就到顶, 狂发 3304 也刷不出第三条');
  } finally { restore(); }
});

await check('B5 3303: 本章没领完不许领"章节完成", 领完才把 chapterIndex 推到 102', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (save) => {
    const restore = useSave(save);
    try {
      return { res: HANDLERS[3303]({ msgId: 3303, packetUUid: 1, proto: idReq(CHAPTER_OVER), headerHex: '' }), after: loadSave() };
    } finally { restore(); }
  };
  const early = run(taskSave((s) => { s.tasks.passedTasks[String(MAIN_TASK)] = 1700000000; }));
  assert.match(early.res.deny ?? '', /第 101 章还有 5 条没领/, 'cond 1901 要按"同章其余行都领了"判');
  assert.equal(early.after.tasks.taskChapter, 101, '拦下时不能把章号推走');
  const full = run(taskSave((s) => {
    for (const id of [MAIN_TASK, ...MAIN_REST]) s.tasks.passedTasks[String(id)] = 1700000000;
  }));
  assert.ok(!full.res.deny, `该放行, 实际 ${full.res.deny}`);
  assert.equal(num1(GProto.decodeFields(full.res.body), 3), 102, '回包 chapterIndex 要给新章号');
  assert.equal(full.after.tasks.taskChapter, 102, '章号推进要落盘');
});

await check('B5 登录包 47/48: 跨天界点先清日常, 已领记录只留非日常的, 顺带补登录天数', async () => {
  const { playerLoginGetInfoS2C } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const sec = Math.floor(Date.now() / 1000);
  const restore = useSave(taskSave((s) => {
    s.tasks.counters = { 'day:1502:13': 60, 'week:1802': 2, 'total:1802': 2 };
    s.tasks.dayTaskPoint = 30;
    s.tasks.passedDayPoints = [1];
    s.tasks.passedTasks = { [D_STRENGTH]: 1700000000, [MAIN_TASK]: 1700000001 };
    s.tasks.rollDay = (sec - 86400) * 1000;   // 昨天 -> 该跨天
    s.tasks.rollWeek = sec * 1000;            // 本周内 -> 不动
  }));
  try {
    const dec = GProto.decodeFields(playerLoginGetInfoS2C());
    const tp = GProto.decodeFields(fld(dec, 47).value);
    assert.equal(num1(tp, 1), 0, '跨天后 dayTaskPoint 归零');
    assert.equal(num1(tp, 3), 101, 'chapterIndex 从存档来');
    assert.equal(num1(tp, 4), 10001, 'dayGroupIndex 从存档来');
    const listed = kvList(tp, 2);
    assert.ok(listed.every(([, v]) => v > 0), '列出来的进度必须 >0: 列一个 0 会把客户端本地算出的进度压没');
    assert.ok(listed.map(([k]) => k).includes(7000001), 'week:1802 还在 -> 周常"累计登录3天"该列出来');
    assert.ok(!listed.map(([k]) => k).includes(D_STRENGTH), 'day: 计数被清掉了, 这条日常任务不该再列');
    const ti = GProto.decodeFields(fld(dec, 48).value);
    assert.deepEqual(kvList(ti, 1).map(([k]) => k), [MAIN_TASK], '日常那条的已领记录跨天作废, 主线那条要留着');
    assert.equal(ti.filter((f) => f.field === 2).length, 0, 'passedDayPoints 清空');
    const after = loadSave().tasks;
    assert.equal(after.counters['day:1502:13'], undefined, 'day: 计数整片删掉');
    assert.equal(after.counters['total:1802'], 3, '跨天补一次登录天数(同一天重登不补)');
    assert.equal(after.counters['day:1802'], 1);
  } finally { restore(); }
});

await check('B5 登录包 47/48 + 10005: 两个入口给的是同一份任务状态', async () => {
  const payloads = await import(`../${DIST}/payloads.js`);
  const { HANDLERS } = payloads;
  const restore = useSave(taskSave((s) => {
    s.tasks.counters = { 'day:1002': 1 };
    s.tasks.dayTaskPoint = 10;
    s.tasks.passedTasks = { [D_SEC]: 1700000000 };
  }));
  try {
    const login = GProto.decodeFields(payloads.playerLoginGetInfoS2C());
    const res = HANDLERS[10005]({ msgId: 10005, packetUUid: 1, proto: Buffer.alloc(0), headerHex: '' });
    const day = GProto.decodeFields(Buffer.isBuffer(res) ? res : res.body);
    assert.deepEqual(kvList(GProto.decodeFields(fld(day, 6).value), 2),
      kvList(GProto.decodeFields(fld(login, 47).value), 2), 'taskProgress 两处必须同源');
    assert.deepEqual(kvList(GProto.decodeFields(fld(day, 7).value), 1),
      kvList(GProto.decodeFields(fld(login, 48).value), 1), 'taskInfo 两处必须同源');
    assert.ok(Number(fld(day, 19).value) > Math.floor(Date.now() / 1000), 'nextDayRefreshTime 是将来那一刻');
    assert.equal(Number(fld(day, 19).value) % 86400, 4 * 3600 - 8 * 3600 + 86400, '日界点=UTC+8 的 04:00');
  } finally { restore(); }
});

// ---------------------------------------------------------------- 4j. B6 签到/七日 (3301/3306/10051 + 登录 43/44/80)
// 状态在 src/sign.ts, 初心者任务的领奖仍走 tasks.claimTask(Task_Xls 里 missionType=4 那 56 行).
// 日界/月界都是 04:00(UTC+8) 口径, 只有界点能算不能写死, 所以底档里的 signin.day 用 dayEdgeSec(now).
const B_FIRST = 400001;    // 初心者第一条: cond 1101, 真值在客户端本地 -> 服务端不拦
const B_LOGIN = 400004;    // 初心者 cond 1802 累计登录 1 天 -> 后端计数型, 该拦
const { dayEdgeSec: bEdge } = await import(`../${DIST}/tasks.js`);
const { gameMonthDay, beginnerTotal } = await import(`../${DIST}/sign.js`);
const NOW_SEC = Math.floor(Date.now() / 1000);
const B_EDGE = bEdge(NOW_SEC);
const B_MONTH_KEY = gameMonthDay(NOW_SEC).key;

const ftReq = (type, taskId) => GProto.concat(GProto.vfield(1, type), ...(taskId ? [GProto.vfield(2, taskId)] : []));
const signSave = (mut) => {
  const s = taskSave();
  s.signin = { month: B_MONTH_KEY, times: 3, day: B_EDGE, lastTime: NOW_SEC };   // 今天已签, 本月第 3 格
  s.bg = { open: 1700000000, sign: 0, signTime: 0, bingo: [], redDot: false };
  if (mut) mut(s);
  return s;
};
/** 前 n 条初心者置成"已领"(400001..400056 是连号的). */
const beginnerDone = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(400001 + i), 1700000000 + i]));

await check('B6 登录包 43/44/80: 初心者两条一起发, FirstThoughtInfo 四个 required 全带', async () => {
  const payloads = await import(`../${DIST}/payloads.js`);
  const restore = useSave(signSave());
  try {
    const dec = GProto.decodeFields(payloads.playerLoginGetInfoS2C());
    assert.ok(fld(dec, 43), 'isFirstThoughtAllOver=43 必须带: 它和 44 只发一条, 客户端点未解锁页签会 nil index 崩');
    assert.equal(num1(dec, 43), 0, '一条都没领 -> 0');
    const info = GProto.decodeFields(fld(dec, 44).value);
    for (const n of [1, 2, 3, 4]) {
      assert.ok(fld(info, n), `FirstThoughtInfo 的 required ${n} 不能缺(signNumber/redDot/signTimeStamp/openTimeStamp), 缺一个整包解不出来`);
    }
    assert.equal(num1(info, 4), 1700000000, 'openTimeStamp 从存档 bg.open 来, 单位秒');
    assert.ok(num1(info, 4) < NOW_SEC, 'openTimeStamp 得早于现在, 给未来值客户端算出"第 0 天", 面板开着但列表空');
    assert.equal(num1(info, 2), 0, 'redDot 是 required bool: 关掉也要显式发 0');
    assert.equal(info.filter((f) => f.field === 5).length, 0, '没领过 bingo 就不该列 signBingoList');
    const ms = GProto.decodeFields(fld(dec, 80).value);
    assert.equal(num1(ms, 1), 3, 'monthGetSignRewardTimes 从存档来');
    assert.equal(num1(ms, 3), 0, '今天已签 -> days 必须 0: 客户端格子序号 = 已签次数 + days, 给 1 会把今天推到后一格');
    assert.ok(fld(ms, 2), 'lastGetSignRewardTime 缺或给 0 会让面板每次进主城重弹');
  } finally { restore(); }
});

await checkHandler('B6 3301 typeId=2: 领一条初心者, taskOverTime 必带(缺了客户端当没完成), 奖走 ShowItem_Push(68)', 3301, {
  save: signSave(),
  req: ftReq(2, B_FIRST),
  push: [[900009, 'ShowItem_Push']],
  fields: (dec, { res }) => {
    assert.equal(num1(dec, 1), 2, 'typeId=1 要回显, 客户端据此走 Task 那一支');
    assert.equal(num1(dec, 4), B_FIRST, 'taskId=4: ChangeBeginTaskDataState 按它把行标成 Finish');
    assert.ok(fld(dec, 6), 'taskOverTime=6 不能缺: passedTaskIds[missionId] 存的就是它, nil 等于这条没完成');
    assert.equal(num1(dec, 5), 0, 'isAllOver=5 没全清就是 0');
    const info = GProto.decodeFields(fld(dec, 3).value);
    for (const n of [1, 2, 3, 4]) assert.ok(fld(info, n), 'thoughtInfo=3 里四个 required 都得在');
    assert.equal(num1(taskOfPush(res, 900009), 1), 68, 'comeFrom=ActionEnum.FirstThoughtTask');
  },
  after: (s) => {
    assert.ok(s.tasks.passedTasks[String(B_FIRST)] > 0, '领奖要落盘: 重登靠 taskInfo=48, bingo 门槛也数它');
    assert.equal(s.bg.sign, 0, 'typeId=2 不该动七日签到计数');
  },
});

await checkHandler('B6 3301 typeId=2: 日常任务不许从这条通道领(它走 3302) -> 拒单且不动状态', 3301, {
  save: signSave(),
  req: ftReq(2, D_SEC),
  deny: /不是初心者任务/,
  after: (s) => assert.deepEqual(s.tasks.passedTasks, {}, '拒单不能写已领记录'),
});

await check('B6 3301: 后端条件那条(400004 累计登录 1 天)没计数就拦, 领过的再发也拦', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (save) => {
    const restore = useSave(save);
    try {
      return { res: HANDLERS[3301]({ msgId: 3301, packetUUid: 1, proto: ftReq(2, B_LOGIN), headerHex: '' }), after: loadSave() };
    } finally { restore(); }
  };
  const none = run(signSave());
  assert.match(none.res.deny ?? '', /进度 0\/1/, '一次登录都没记过 -> 就是 0, 不能当"看不见"放行');
  const done = run(signSave((s) => { s.tasks.passedTasks[String(B_LOGIN)] = 1700000000; }));
  assert.match(done.res.deny ?? '', /已领过/);
  assert.equal(done.after.tasks.passedTasks[String(B_LOGIN)], 1700000000, '拒单不能改写完成时间');
  const ok = run(signSave((s) => { s.tasks.counters['total:1802'] = 1; }));
  assert.ok(!ok.res.deny, `登录天数记过了该放行, 实际 ${ok.res.deny}`);
});

await check('B6 3306 SignBingoReward: 门槛是已完成初心者任务数(8..56), 没到拦、到了领并落 bg.bingo', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (save) => {
    const restore = useSave(save);
    try {
      return { res: HANDLERS[3306]({ msgId: 3306, packetUUid: 1, proto: idReq(1), headerHex: '' }), after: loadSave() };
    } finally { restore(); }
  };
  assert.equal(beginnerTotal(), 56, '表里初心者 56 行, 正好是 bingo 顶格(num=56)的门槛');
  const short = run(signSave((s) => { s.tasks.passedTasks = beginnerDone(7); }));
  assert.match(short.res.deny ?? '', /已完成初心者任务 7\/8/, '差一条也不能领: 客户端只会把格子置灰, 这里挡的是直接发协议的路子');
  assert.deepEqual(short.after.bg.bingo, [], '拦下时不能把格子记成已领');
  const ok = run(signSave((s) => { s.tasks.passedTasks = beginnerDone(8); }));
  assert.ok(!ok.res.deny, `满 8 条该放行, 实际 ${ok.res.deny}`);
  assert.deepEqual(GProto.decodeFields(ok.res.body).map((f) => Number(f.value)), [1], 'SignBingoReward_S2C 只有 signId=1');
  assert.equal(num1(taskOfPush(ok.res, 900009), 1), 88, 'comeFrom=ActionEnum.SignBingo, 奖只靠推送展示');
  assert.deepEqual(ok.after.bg.bingo, [1], '已领格子随 signBingoList=5 在下次登录的 44 里回去');
  const again = run(signSave((s) => { s.tasks.passedTasks = beginnerDone(8); s.bg.bingo = [1]; }));
  assert.match(again.res.deny ?? '', /已领过/);
});

await check('B6 10051 GetSignReward: 未签才推进并发奖, 已签过照样成包回(面板等回包才让关)', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (save) => {
    const restore = useSave(save);
    try {
      return { res: HANDLERS[10051]({ msgId: 10051, packetUUid: 1, proto: Buffer.alloc(0), headerHex: '' }), after: loadSave() };
    } finally { restore(); }
  };
  const fresh = run(signSave((s) => { s.signin = { month: B_MONTH_KEY, times: 2, day: -1, lastTime: 1 }; }));
  const dec = GProto.decodeFields(fresh.res.body);
  assert.equal(num1(dec, 2), 3, 'monthGetSignRewardTimes=2 要推进到 3, 客户端拿它覆盖本地那份次数');
  assert.ok(num1(dec, 3) >= NOW_SEC - 5, 'lastGetSignRewardTime=3 给现在这一秒: 给 0 或留着没签过的值会每次进主城重弹');
  assert.equal(num1(taskOfPush(fresh.res, 900009), 1), 54, 'comeFrom=ActionEnum.MonthSign');
  assert.ok(fresh.after.signin.day === B_EDGE, '签到记的是 04:00 那个界点, 不是自然零点');
  const again = run(fresh.after);
  assert.ok(!again.res.deny, '这条不能拒单: 面板打开时 SetCanCloseUI(false), 回包不来就关不掉');
  assert.equal(num1(GProto.decodeFields(again.res.body), 2), 3, '同一天再发一次不能推进');
  assert.equal(again.after.signin.times, 3, '也不能把次数写进存档');
  assert.equal((again.res.extra ?? []).filter(([h]) => h === 900009).length, 0, '没发奖就不该弹"获得物品"');
});

await check('B6 3301 typeId=1: 七日签到推 bg.sign 且当日不重复; 没见过的 typeId 不拒单, 只回 thoughtInfo', async () => {
  const { HANDLERS } = await import(`../${DIST}/payloads.js`);
  const { loadSave } = await import(`../${DIST}/save.js`);
  const run = (proto, save) => {
    const restore = useSave(save);
    try {
      return { res: HANDLERS[3301]({ msgId: 3301, packetUUid: 1, proto, headerHex: '' }), after: loadSave() };
    } finally { restore(); }
  };
  const one = run(ftReq(1), signSave());
  assert.equal(one.after.bg.sign, 1, '七日签到天数 +1, 随 signNumber=1 下发');
  assert.ok(one.after.bg.signTime >= B_EDGE, '记下这一格的时刻, 用来判"今天还签不签"');
  assert.equal(num1(taskOfPush(one.res, 900009), 1), 55, 'comeFrom=ActionEnum.DaySign');
  const two = run(ftReq(1), one.after);
  assert.match(two.res.deny ?? '', /今天已签过/);
  const three = run(ftReq(3), signSave());
  assert.ok(!three.res.deny, `typeId=3 不该拒单(这版客户端发不出, 接住是为了好排查): ${three.res.deny}`);
  const back = GProto.decodeFields(three.res.body);
  assert.equal(num1(back, 1), 3, 'typeId 回显');
  assert.equal(num1(GProto.decodeFields(fld(back, 3).value), 1), 0, '没签到就是 signNumber=0: 回的是当前那一份 info');
  assert.equal((three.res.extra ?? []).length, 0, '没发奖不该带后一包');
});

await check('B6 月界的口径: 1 号 00:00~04:00 在客户端还是上个月, 登录 80 与 10005 13 同源', async () => {
  const payloads = await import(`../${DIST}/payloads.js`);
  const { HANDLERS } = payloads;
  const { gameMonthDay: gmd, rollMonth, signedToday } = await import(`../${DIST}/sign.js`);
  const nov1 = Math.floor(Date.UTC(2026, 10, 1) / 1000) - 8 * 3600;    // 2026-11-01 00:00 (UTC+8)
  assert.deepEqual(gmd(nov1 + 2 * 3600), { key: 24322, month: 10, day: 31 }, '1 号 02:00 还该算 10 月第 31 天(差的就是那 4 小时)');
  assert.deepEqual(gmd(nov1 + 4 * 3600 + 60), { key: 24323, month: 11, day: 1 }, '04:00 一过才是 11 月第 1 格');
  const s = signSave((x) => { x.signin = { month: 24322, times: 5, day: -1, lastTime: 1 }; });
  assert.equal(rollMonth(s, nov1 + 4 * 3600 + 60), true, '跨月要归零');
  assert.deepEqual(s.signin, { month: 24323, times: 0, day: -1, lastTime: 0 }, '归零后从本月第 1 格重来');
  assert.equal(rollMonth(s, nov1 + 4 * 3600 + 60), false, '第二次不动状态');
  assert.equal(signedToday(s, nov1 + 4 * 3600 + 60), false, '刚归零 -> 今天还没签');
  const restore = useSave(signSave());
  try {
    const login = GProto.decodeFields(payloads.playerLoginGetInfoS2C());
    const res = HANDLERS[10005]({ msgId: 10005, packetUUid: 1, proto: Buffer.alloc(0), headerHex: '' });
    const day = GProto.decodeFields(Buffer.isBuffer(res) ? res : res.body);
    assert.deepEqual(fld(day, 13).value, fld(login, 80).value, 'monthSign 两个入口必须同源');
  } finally { restore(); }
});

// ---------------------------------------------------------------- 5. 工具链
await check('tools/meta_decrypt.py 能重解 global-metadata.dat', async () => {
  const src = await ensureMetadata();
  if (!src) return results.push(['SKIP', 'APK 不在, 无法取 metadata']);
  const { stdout } = await exec(py, [path.join(ROOT, 'tools/meta_decrypt.py'), src, '--check']);
  assert.match(stdout, /version = 29|version: 29/);
});

await check('tools/extract_res.py 可 dry-run', async () => {
  const { stdout } = await exec(py, [path.join(ROOT, 'tools/extract_res.py'), '--dry-run']);
  assert.match(stdout, /可解/);
});

// ---------------------------------------------------------------- 汇总
const fail = results.filter((r) => r[0] === 'FAIL');
process.stdout.write('\n');
for (const [st, name, err] of results) process.stdout.write(`${st === 'PASS' ? '✓' : st === 'SKIP' ? '-' : '✗'} ${name}${err ? `  <- ${err}` : ''}\n`);
process.stdout.write(`\n${results.length - fail.length}/${results.length} 通过 (被测产物 ${DIST}, node ${process.version})\n`);
process.exit(fail.length ? 1 : 0);
