// proto/*.proto 的离线解析器: 给自检用, 不进 dist/、不参与运行.
//
// 为什么要它: 假服是手写 wire format (src/proto.ts), 只认字段号, 发漏一个 required 字段
// 编译和自检都不会响 —— 只有客户端 protobuf 库解析时才炸, 而那时看到的是"面板空白"或崩.
// 这里把 `required` 从 .proto 里抽出来当断言的输入, 让"漏必填"在 selftest 阶段就是红灯.
//
// 只解析自检需要的三件事: message 的字段表 / CmdDefine 的命令号 / 谁在哪个文件.
// 同名消息在多份 proto (msg.proto 与 Msg.proto 是两套近似副本) 里并成一张表;
// 嵌套在消息里的 message/enum 块整块跳过, 不作为顶层消息收 (实测 proto/ 里没有 map<>).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'proto');

const SCALARS = new Set(['double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
  'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes']);

// 字段号 -> 字段描述. repeated 不进 required 集 (proto2 里 repeated 恒可缺).
/** @typedef {{name:string, type:string, label:string, required:boolean, file:string}} FieldDef */

/** 去掉行注释与块注释; 单引号字符串里的 // 不当注释 (option java_package 那种). */
function stripComments(text) {
  const out = [];
  let inBlock = false;
  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    if (inBlock) {
      const e = line.indexOf('*/');
      if (e < 0) continue;
      inBlock = false;
      line = line.slice(e + 2);
    }
    let cut = -1, quote = '';
    for (let i = 0; i < line.length - 1; i++) {
      const c = line[i];
      if (quote) { if (c === '\\' && line[i + 1] === quote) i++; else if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '/' && line[i + 1] === '/') { cut = i; break; }
      if (c === '/' && line[i + 1] === '*') { cut = i; inBlock = true; break; }
    }
    if (cut >= 0) line = line.slice(0, cut);
    out.push(line);
  }
  return out.join('\n');
}

const FIELD_RE = /^(?:(required|optional|repeated)\s+)?([A-Za-z_][\w.]*)\s+([A-Za-z_][\w]*)\s*=\s*(\d+)\s*(\[[^\]]*\])?\s*;?\s*$/;

/** `message X {` 的左括号常另起一行, 所以按花括号配对切块, 不按行认头. */
function messageBlocks(text, file) {
  const out = [];
  const re = /\bmessage\s+([A-Za-z_]\w*)\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let i = re.lastIndex, depth = 1;
    while (i < text.length && depth) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    out.push({ name: m[1], file, body: text.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;                       // 跳过整块: 嵌套 message 不当顶层消息收
  }
  return out;
}

/** 消息体 -> Map<字段号, FieldDef[]>; 只收深度 0 的字段行(嵌套 enum/message 里的不算). */
function bodyFields(body, file) {
  const fields = new Map();
  let depth = 0;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t) {
      if (depth === 0) {
        const fm = t.match(FIELD_RE);
        if (fm) {
          const [, label, type, name, no] = fm;
          const n = Number(no);
          if (!fields.has(n)) fields.set(n, []);
          fields.get(n).push({ name, type, label: label || 'optional', required: label === 'required', file });
        }
      }
      for (const c of t) { if (c === '{') depth++; else if (c === '}') depth--; }
    }
  }
  return fields;
}

/** 解析全部 .proto -> { msgs: Map<名称, Map<字段号, FieldDef[]>>, cmds: Map<号, 名>, cmdByName: Map<名, 号> }. */
function parseAll() {
  const msgs = new Map();
  const cmds = new Map();
  const cmdByName = new Map();
  for (const fn of fs.readdirSync(DIR).filter((f) => f.endsWith('.proto')).sort()) {
    const text = stripComments(fs.readFileSync(path.join(DIR, fn), 'utf8'));
    if (fn === 'CmdDefine.proto') {
      for (const m of text.matchAll(/([A-Za-z_][\w]*)\s*=\s*(\d+)\s*;/g)) {
        const no = Number(m[2]);
        if (!cmds.has(no)) cmds.set(no, m[1]);
        if (!cmdByName.has(m[1])) cmdByName.set(m[1], no);
      }
    }
    const blocks = messageBlocks(text, fn);
    for (const b of blocks) {
      const fields = bodyFields(b.body, fn);
      const cur = msgs.get(b.name);
      if (!cur) msgs.set(b.name, fields);
      else for (const [no, defs] of fields) {           // 同名消息在多文件重复定义(msg.proto/Msg.proto)时并到一处
        if (!cur.has(no)) cur.set(no, defs);
        else for (const d of defs) if (!cur.get(no).some((x) => x.name === d.name && x.type === d.type)) cur.get(no).push(d);
      }
    }
  }
  return { msgs, cmds, cmdByName };
}

let cache = null;
function db() { if (!cache) cache = parseAll(); return cache; }

/** 命令名 -> msgId (找不到抛错: 名字写错比断言假绿好暴露). */
export function msgIdOf(cmd) {
  const no = db().cmdByName.get(cmd);
  if (no === undefined) throw new Error(`proto: CmdDefine 里没有命令 ${cmd}`);
  return no;
}

/** msgId -> 命令名. */
export function cmdOf(msgId) { return db().cmds.get(msgId); }

/** 消息名 -> Map<字段号, FieldDef[]>. 未定义返回 null (调用点决定是跳过还是报错). */
export function fieldsOf(msg) { return db().msgs.get(msg) ?? null; }

export function hasMsg(msg) { return db().msgs.has(msg); }

/** 消息名 -> 必填字段数组 (repeated 不算). 消息不存在返回 null. */
export function requiredOf(msg) {
  const fields = fieldsOf(msg);
  if (!fields) return null;
  return [...fields.entries()].filter(([, defs]) => defs.some((d) => d.required))
    .map(([no, defs]) => ({ no, ...defs[0] })).sort((a, b) => a.no - b.no);
}

/** 字段号 -> 该号上的类型 (同名可能多处定义, 取列表). */
export function fieldType(msg, no) {
  return fieldsOf(msg)?.get(no) ?? [];
}

const WIRE_NAME = { 0: 'varint', 1: '64-bit', 2: 'length-delimited', 5: '32-bit' };
function expectedWire(type) {
  if (type === 'string' || type === 'bytes') return 2;
  if (!SCALARS.has(type)) return 2;             // message: 嵌套
  if (type === 'double' || type === 'fixed64' || type === 'sfixed64') return 1;
  if (type === 'float' || type === 'fixed32' || type === 'sfixed32') return 5;
  return 0;
}

/**
 * 断言 body (Buffer 或 pb.decodeFields 的结果) 覆盖了 msg 的全部 required 字段.
 * proto2 里子消息的 required 同样必须齐 (repeated 的每个元素也算), 所以按类型递归,
 * maxDepth/seen 防自引用图. 失败抛 Error, 文案带消息名/字段号/类型, 直接对着 .proto 改构造器.
 */
export function assertRequired(label, msg, body, opts = {}) {
  const { pb, maxDepth = 3, chain = '' } = opts;
  const decode = (b) => (Array.isArray(b) ? b : pb.decodeFields(b));
  const fields = decode(body);
  const req = requiredOf(msg);
  if (req === null) return [];                    // 消息名不在 proto 里(枚举/外部类型), 不管
  const present = new Map();
  for (const f of fields) if (!present.has(f.field)) present.set(f.field, f);
  const bad = [];
  for (const r of req) {
    const got = present.get(r.no);
    if (!got) { bad.push(`${r.no} ${r.type} ${r.name} 缺失`); continue; }
    const want = expectedWire(r.type);
    if (got.wire !== want) bad.push(`${r.no} ${r.name} 是 wire=${got.wire}, ${r.type} 应为 wire=${want}`);
  }
  if (bad.length) throw new Error(`${label}: ${msg} required 不齐 -> ${bad.join('; ')}`);
  if (maxDepth > 0) {
    for (const [no, defs] of (fieldsOf(msg) ?? new Map())) {
      const child = defs.find((d) => !SCALARS.has(d.type) && hasMsg(d.type));
      if (!child || chain.includes(`|${child.type}|`)) continue;
      for (const f of fields.filter((x) => x.field === no && x.wire === 2)) {
        assertRequired(label, child.type, decode(f.value), { pb, maxDepth: maxDepth - 1, chain: `${chain}|${msg}|` });
      }
    }
  }
  return req;
}

/** 自检: 解析器本身的健康度 (被 selftest 直接断言). */
export function stats() {
  const d = db();
  let nreq = 0;
  for (const fields of d.msgs.values()) for (const defs of fields.values()) if (defs.some((x) => x.required)) nreq++;
  return { messages: d.msgs.size, cmds: d.cmds.size, requiredFields: nreq };
}

/** 字段号是否存在于 body (手写"1-vs-2"这类防串号断言用). */
export function hasField(fields, no) { return fields.some((f) => f.field === no); }

/** 取某号的第一条值. */
export function fieldValue(fields, no) { return fields.find((f) => f.field === no)?.value; }
