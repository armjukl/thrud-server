// 自测: 不需要真客户端, 用合成 KCP 包验证 假服务端 能解析/回 ACK/按帧派发, 并验证
// HTTP 桩与两个 python 工具可运行. 跑法: node test/selftest.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const ROOT = path.resolve(import.meta.dirname, '..');
const PY_CANDIDATES = [process.env.SLD_PY, '/home/tmp/venv/bin/python', 'python3'].filter(Boolean);
const py = PY_CANDIDATES.find((p) => (p.includes('/') ? fs.existsSync(p) : true)) || 'python3';

// global-metadata.dat 从 APK 里现取, 不依赖 /home/tmp 的工作目录
async function ensureMetadata() {
  const dst = path.join(ROOT, 'data', 'logs', 'global-metadata.dat');
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

const { encodeSegment, decodePacket, CMD, KcpSession } = await import('../dist/kcp.js');
const { Framer, encode, CANDIDATE_RULES } = await import('../dist/framing.js');
const { createGateway, on } = await import('../dist/gateway.js');
const { createHttpServer } = await import('../dist/http.js');
const { config } = await import('../dist/config.js');

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
  s.addEventListener('data', (e) => got.push(e.detail.toString()));
  s.input(encodeSegment({ conv: 9, cmd: CMD.PUSH, frg: 0, wnd: 32, ts: 0, sn: 1, una: 0, data: Buffer.from('B') }));
  s.input(encodeSegment({ conv: 9, cmd: CMD.PUSH, frg: 0, wnd: 32, ts: 1, sn: 0, una: 0, data: Buffer.from('A') }));
  assert.deepEqual(got, ['A', 'B'], '乱序包必须按 sn 重排');
  const acks = out.flatMap((p) => decodePacket(p).segments).filter((x) => x.cmd === CMD.ACK);
  assert.equal(acks.length, 2, '每个 PUSH 都要回 ACK');
  assert.equal(acks[0].una, 0, 'sn=1 先到时不可交付, una 仍为 0');
  assert.equal(acks[1].una, 2, 'sn=0 补齐后 una 应推进到 2');
  assert.deepEqual(acks.map((a) => a.sn), [1, 0], 'ACK 的 sn 回显被确认的段');
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
  const { handleAppInterface } = await import('../dist/gs.js');
  const pb = await import('../dist/proto.js');
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
  const { poolDraw } = await import('../dist/gacha.js');
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
  const gs = await import('../dist/gs.js');
  const pb = await import('../dist/proto.js');
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
  const { HANDLERS } = await import('../dist/payloads.js');
  const pb = await import('../dist/proto.js');
  const { LEADER } = await import('../dist/data/leader.js');
  const { WEAPON } = await import('../dist/data/weapon.js');
  const saveFile = path.join(ROOT, 'data', 'save.json');
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
  const { HANDLERS } = await import('../dist/payloads.js');
  const pb = await import('../dist/proto.js');
  const { config } = await import('../dist/config.js');
  const { itemQuality } = await import('../dist/data/rarity.js');
  const saveFile = path.join(ROOT, 'data', 'save.json');
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
    const { LEADER } = await import('../dist/data/leader.js');
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
  const { HANDLERS } = await import('../dist/payloads.js');
  const pb = await import('../dist/proto.js');
  const { config } = await import('../dist/config.js');
  const { LEADER } = await import('../dist/data/leader.js');
  const { DEFAULT_SAVE } = await import('../dist/save.js');
  const saveFile = path.join(ROOT, 'data', 'save.json');
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
process.stdout.write(`\n${results.length - fail.length}/${results.length} 通过\n`);
process.exit(fail.length ? 1 : 0);
