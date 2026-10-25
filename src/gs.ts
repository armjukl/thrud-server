// GS 应用层接线: 请求解析 -> 处理器 -> ReturnPackagePush 回包.
//
// 客户端链路 (来自 Lua):
//   NetWorkManager -> HttpClientForLua -> POST /AppInterface  [二进制头 + protobuf data + appendData]
//   回包 HTTP body = protobuf msg.ReturnPackagePush (裸二进制)
//
// 头部布局(实测): [u32 totalLen][u32 crc][u32 ?=0][u32 msgId] 之后是
// 5 个 length-prefixed 串(uid/platform/pfUid/channel/token), 再往后是
// 一小段定长头, 最后是 protobuf data 与 appendData. 这里用"扫描找能完整解析的
// protobuf 起点"来定位 data, 避免把中间那段不定的头写死.
import fs from "node:fs";
import path from "node:path";

import { ROOT } from "./config.js";
import { log, record, hex } from "./logger.js";
import * as pb from "./proto.js";
import { CMD_NAME, HANDLERS, type GsRequest, type GsResponse } from "./payloads.js";

// push 段的前导"分派/类型"字节, 便于迭代: 读 data/frame_prefix.txt(hex)
function readPrefix(): number {
  try {
    const s = fs.readFileSync(path.join(ROOT, "data", "frame_prefix.txt"), "utf8").trim();
    const v = parseInt(s, 16);
    return Number.isFinite(v) ? (v & 0xff) : 0;
  } catch {
    return 0;
  }
}

// ---- 组包 ----
function packetBodyInfo(header: number, body: Buffer): Buffer {
  return pb.concat(pb.vfield(1, header), pb.bfield(2, body));
}

function returnPackageInfo(packetUUid: number, header: number, body: Buffer, pushes?: Array<[number, Buffer]>): Buffer {
  const parts = [pb.vfield(1, packetUUid), pb.bfield(2, packetBodyInfo(header, body))];
  // packetBodyInfoS=3 (repeated PacketBodyInfo) 是服务器主动推送通道,
  // C# ReturnPackageInfo.PacketBodyInfoS 会把它并进同一次回调派发.
  for (const [h, b] of pushes || []) parts.push(pb.bfield(3, packetBodyInfo(h, b)));
  return pb.concat(...parts);
}

export function returnPackagePush(packetUUid: number, header: number, body: Buffer, pushes?: Array<[number, Buffer]>, extra?: Array<[number, Buffer]>): Buffer {
  // packetList=1 是 repeated ReturnPackageInfo: 主包放 [0], 额外的"后一包"(如 ShowItem_Push)按顺序追加,
  // 让客户端按 list 顺序派发 -> 对齐旧版/PC"先 S2C、后 ShowItem_Push"两条独立投递的时序.
  const parts = [pb.bfield(1, returnPackageInfo(packetUUid, header, body, pushes))];
  for (const [h, b] of extra || []) parts.push(pb.bfield(1, returnPackageInfo(packetUUid, h, b)));
  return pb.concat(...parts);
}

// ---- 请求解析 ----
export function parseRequest(body: Buffer): GsRequest {
  const out: GsRequest = { msgId: null, packetUUid: 0, proto: null, headerHex: hex(body, 64) };
  if (body.length < 20) return out;
  out.msgId = body.readUInt32BE(12);
  // 头部布局 (对 30 条真实抓包验证过):
  //   [u32 totalLen][u32 crc][u32 ?=0][u32 msgId]
  //   5 个 length-prefixed 串: uid / platform / pfUid / channel / token
  //   [u32 httpId]  <- 客户端唯一id, 服务端回包 packetUUid 必须原样带回
  //   [u32 ?=0][u8 ?=0][u32 dataLen]
  //   [protobuf data][u32 appendLen][appendData]
  let p = 16;
  for (let k = 0; k < 5 && p + 4 <= body.length; k++) p += 4 + body.readUInt32BE(p);
  out.stringsEnd = p;
  if (p + 13 > body.length) return out;
  out.packetUUid = body.readUInt32BE(p);
  // 5 个串之后的定长头**长度不固定**(随登录前/后、有无 token 变), 所以不认死偏移:
  // 尾部一定是 [u32 appendLen][append], 其前是 [u32 dataLen][data], 于是找一个 s 使
  //   u32BE@(s-4) === (len-4-appendLen) - s
  // 即闭合。实测 327 条抓包: 299 条唯一命中, 24 条有双命中 —— 双命中是"空 body"和
  // "5 个 0 字节"之争, 用 protobuf 首字节不能为 0(field 0 非法) 消歧.
  const al = body.readUInt32BE(body.length - 4);
  const pe = body.length - 4 - al;
  let dataStart = -1, dataLen = 0;
  if (pe >= p + 4 && pe < body.length) {
    for (let s = p + 4; s <= pe; s++) {
      const dl = pe - s;
      if (dl < 0 || body.readUInt32BE(s - 4) !== dl) continue;
      if (dl > 0 && body[s] === 0x00) continue;   // 非法 protobuf 起点, 是头部残留
      dataStart = s; dataLen = dl;
      if (dl === 0) continue;                      // 继续找非空的更可信命中
      break;
    }
  }
  if (dataStart < 0) {                             // 兜底: 老的固定偏移布局
    dataLen = body.readUInt32BE(p + 9);
    dataStart = p + 13;
    if (dataStart + dataLen > body.length) return out;
  }
  out.proto = body.subarray(dataStart, dataStart + dataLen);
  out.protoStart = dataStart;
  out.appendData = body.subarray(pe, pe + al);
  return out;
}

// 网络字节序(大端) u32
function u32(v: number | bigint): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(Number(BigInt(v) & 0xffffffffn) >>> 0);
  return b;
}

// PushMsg2Client{ repeated PushBody pushBodys=1 }, PushBody{ header=1; bodyBytes=2 }.
// C# HandleResult 把 PushMsg2Client.pushBodys 逐条写进 completedList ->
// 走 Lua 派发器时不会被 Ignore_Replenish_MsgID 过滤 (ShowItem_Push 必须走这里).
export function pushMsg2Client(pushes: Array<[number, Buffer]>): Buffer {
  const parts = pushes.map(([h, b]) => pb.bfield(1, pb.concat(pb.vfield(1, h), pb.bfield(2, b))));
  return parts.length ? pb.concat(...parts) : Buffer.alloc(0);
}

// 回包外层帧 (逐条对着 WebCommunicationHelper.HandleResult @0xfb139c 的汇编还原):
//   [u8 压缩标志(0=不压缩, >=1=剩余部分是 raw deflate)]
//   [i32 errorCode]
//   [i32 pushLen][pushLen 字节 ReturnPackagePush]  -> replenishList (会被 Ignore_Replenish 过滤)
//   [i32 msgId][i32 bodyLen][bodyLen 字节]          -> completedList 单包槽 (真正的主回包)
//   [i32 p2cLen][p2cLen 字节 PushMsg2Client]        -> completedList (推送, 晚于主包)
export function frameReply(push: Buffer, prefix = 0, completed?: { header: number; body: Buffer }, p2c?: Buffer): Buffer {
  const main = completed ?? { header: 0, body: Buffer.alloc(0) };
  const extra = p2c ?? Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from([prefix & 0xff]),
    u32(0),
    u32(push.length),
    push,
    u32(main.header),
    u32(main.body.length),
    main.body,
    u32(extra.length),
    extra,
  ]);
}

export function handleAppInterface(body: Buffer): { body: Buffer; note: string } {
  const req = parseRequest(body);
  const id = req.msgId ?? -1;
  const name = CMD_NAME[id] ?? `#${req.msgId}`;
  log("info", "gs", `req msgId=${req.msgId}(${name}) packetUUid=${req.packetUUid} proto@${req.protoStart ?? "-"} ${req.proto?.length ?? 0}B ${hex(req.proto ?? Buffer.alloc(0), 64)}`);
  if (req.proto) {
    record.json(`gs-req-${req.msgId}.fields.json`, pb.decodeFields(req.proto).map((f) => ({
      field: f.field, wire: f.wire,
      value: Buffer.isBuffer(f.value) ? f.value.toString("latin1") : String(f.value),
    })));
  }
  const build = HANDLERS[id];
  if (!build) log("warn", "gs", `msgId=${req.msgId}(${name}) 无专用 handler -> 回空 body 的合法包`);
  // 注意: 未处理的消息也要组一个带 header 的包, 不能回"零包"的 push —— 客户端 Lua 派发器
  // 按 header 找回调, 收不到就永远等 (签到面板的关闭按钮就是卡在这: SetCanCloseUI 不执行).
  const built = build ? build(req) : null;
  let payload: Buffer = Buffer.alloc(0);
  let pushes: Array<[number, Buffer]> | null = null;
  let extra: Array<[number, Buffer]> | null = null;
  let mainInCompleted = false;
  if (Buffer.isBuffer(built)) payload = built;
  else if (built) {
    const r = built as GsResponse;
    pushes = r.pushes; extra = r.extra ?? null; payload = r.body;
    mainInCompleted = !!r.mainInCompleted;
  }
  const prefix = readPrefix();
  let push: Buffer;
  let reply: Buffer;
  if (mainInCompleted) {
    // 主包进 completedList 单包槽, 推送进 PushMsg2Client; 二者都不经过 replenish 过滤.
    push = Buffer.alloc(0);
    reply = frameReply(push, prefix, { header: id, body: payload }, pushMsg2Client([...(pushes ?? []), ...(extra ?? [])]));
  } else {
    push = returnPackagePush(req.packetUUid, id, payload, pushes ?? undefined, extra ?? undefined);
    reply = frameReply(push, prefix);
  }
  log("info", "gs", `resp msgId=${req.msgId}(${name}) body=${payload.length}B pushPkt=${pushes ? pushes.length : 0} extra=${extra ? extra.length : 0} prefix=0x${prefix.toString(16)} push=${push.length}B framed=${reply.length}B ${hex(reply, 96)}`);
  return { body: reply, note: `reply ${name} ${payload.length}B push=${push.length}B` };
}
