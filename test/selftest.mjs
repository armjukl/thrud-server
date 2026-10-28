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

// ---------------------------------------------------------------- 4d. 整表取数面 (src/tbl.ts)
// 这一条钉的是"值从客户端真表来"这个口径本身, 不是某张表的内容: 换资源包后数字会变, 所以
// 只断言三件事 —— 能取到值/式杖上限的坑不复发/生成器还能跑。
await check('tbl: 整表取数面可用, 式杖上限只认 TalentSkill 不信 Skill.maxLevel', async () => {
  const t = await import('../dist/tbl.js');
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
  levels: { '101101': [1, 2, 3] },
  trainLevels: { '101101': { id: 101101, passTime: 45, todayAttackNum: 2, attackNum: 7, lastAttackTime: 1700000000000 } },
  gacha: { '3116': 20 },
  signin: { month: 20016, times: 5, day: 4, lastTime: 1700000000000 },
  tasks: {
    taskChapter: 102, dayGroupIndex: 10002, dayTaskPoint: 30, weekTaskPoint: 80,
    passedTasks: { '3100': 1 }, progress: { '3100': 2 },
    passedDayPoints: [1, 2], passedWeekPoints: [3], rollDay: 1700000000000, rollWeek: 1700000000000,
  },
  bg: { open: 1700000000, sign: 3, signTime: 1700000000, bingo: [1, 2], redDot: true },
  bgVersion: 1,
  hangUp: { type: 2, levelId: 101101, times: 5, startTime: 1700000000, endTime: 1700003000, state: 1 },
  wSeq: 7, regTime: 1700000000,
});

await check('save: normalizeSave 全字段往返不丢 (漏登记即红灯)', async () => {
  const { normalizeSave } = await import('../dist/save.js');
  const fx = saveFixture();
  const got = normalizeSave(fx);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(fx).sort(), '顶层键集必须相等');
  assert.deepEqual(got, fx, 'normalizeSave 丢字段或改值');
  // 落盘 -> 读回的真实链路就是 JSON 文本, 再过一遍必须幂等.
  assert.deepEqual(normalizeSave(JSON.parse(JSON.stringify(got))), fx, '经 JSON 文本往返不幂等');
});

// 老档(只有 A4 之前的那些键, trainLevels 还是 number[])必须被 loadSave 升上来, 且第二次读不再改.
// 这条会写真档 data/save.json(+.bak), 已整体备份还原; 别和常驻假服同时跑.
await check('save: 老档经 loadSave 升级 + 原子写留 .bak', async () => {
  const { loadSave, BG_SCHEMA } = await import('../dist/save.js');
  const dir = path.join(ROOT, 'data');
  const files = ['save.json', 'save.json.bak'].map((n) => path.join(dir, n));
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
  const { normalizeSave } = await import('../dist/save.js');
  const e = await import('../dist/econ.js');
  const t = await import('../dist/tbl.js');
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
  const { dropAll } = await import('../dist/gacha.js');
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
  const { normalizeSave, characterById } = await import('../dist/save.js');
  const e = await import('../dist/econ.js');
  const sk = await import('../dist/skills.js');
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
const SAVE_FILE = path.join(ROOT, 'data', 'save.json');

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
async function checkHandler(title, msgId, opt = {}) {
  await check(title, async () => {
    const { HANDLERS } = await import('../dist/payloads.js');
    const pb = await import('../dist/proto.js');
    const { loadSave } = await import('../dist/save.js');
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
      const body = Buffer.isBuffer(res) ? res : res.body;
      assert.ok(Buffer.isBuffer(body), `${cmd} 的回包不是 Buffer`);
      const dec = pb.decodeFields(body);
      if (s2c) ps.assertRequired(`${cmd}(${msgId}) 回包`, s2c, dec, { pb, maxDepth: depth });
      for (const [head, msg] of opt.push ?? []) {
        const p = (res.extra ?? []).find(([hh]) => hh === head);
        assert.ok(p, `extra 里没有推送 ${head} (${msg})`);
        ps.assertRequired(`${cmd}(${msgId}) 推送 ${head}`, msg, pb.decodeFields(p[1]), { pb, maxDepth: depth });
      }
      if (opt.fields) opt.fields(dec, { pb, ps, res, body, has: (n) => ps.hasField(dec, n) });
      if (opt.after) opt.after(loadSave(), { pb, ps, dec, res });
    } finally {
      restore();
    }
  });
}

await check('proto: .proto 解析器读得出 required, 少发一个就红灯', async () => {
  const pb = await import('../dist/proto.js');
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

// 已注册的 41 条全部过一遍 required: 空请求是最坏输入(走各 handler 的兜底分支), 兜底包也得合规.
await check('proto: 已注册 41 条 handler 的回包 required 全覆盖', async () => {
  const { HANDLERS } = await import('../dist/payloads.js');
  const pb = await import('../dist/proto.js');
  const ACK_ONLY = {                       // proto 里本就没有回体消息, 只回通用 ack
    11018: 'BattleSettle 无消息体',
    11019: 'BattleLeave 无 _S2C(BattleLeave 是请求体)',
  };
  const NAMING = {                         // 不守 `<cmd>_S2C` 命名的少数: 写死, 免得靠猜把断言猜空
    11032: 'BattleLeaveFinish_S2C',        // CmdDefine 的号名本身就以 _S2C 结尾
    21001: 'GetAllActivity_s2c',           // 全 proto 里唯一的小写 s2c
  };
  const restore = useSave(undefined);
  let checked = 0, withReq = 0;
  try {
    for (const id of Object.keys(HANDLERS).map(Number).sort((a, b) => a - b)) {
      const cmd = ps.cmdOf(id);
      assert.ok(cmd, `HANDLERS[${id}] 在 CmdDefine 里查不到号`);
      if (ACK_ONLY[id]) continue;
      const s2c = NAMING[id] ?? `${cmd}_S2C`;
      assert.ok(ps.hasMsg(s2c), `${id} ${cmd}: 回体消息 ${s2c} 不在 proto 里(改名或解析退化)`);
      const res = HANDLERS[id]({ msgId: id, packetUUid: 1, proto: Buffer.alloc(0), headerHex: '' });
      const body = Buffer.isBuffer(res) ? res : res.body;
      ps.assertRequired(`${cmd}(${id}) 空请求回包`, s2c, pb.decodeFields(body), { pb, maxDepth: 2 });
      checked++;
      if ((ps.requiredOf(s2c) ?? []).length) withReq++;
    }
  } finally {
    restore();
  }
  assert.equal(checked, 39, `应有 39 条带消息体的 handler(41 - ${Object.keys(ACK_ONLY).length} 条纯 ack)`);
  assert.ok(withReq >= 12, `带 required 的回包只有 ${withReq} 条被真查过, 覆盖面退化`);
});

await check('proto: 注册表完整 (基线 handler 不掉 / 第一档进度对得上)', async () => {
  const { HANDLERS } = await import('../dist/payloads.js');
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
  const TIER1_DONE = [];
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
  req: (await import('../dist/proto.js')).vfield(1, 0),
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
