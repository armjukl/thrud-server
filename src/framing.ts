// 消息帧层. 真实布局要等抓到包才能定, 所以这里做成"规则驱动 + 自动试探":
//   - 规则文件 data/header-rule.json 描述字段偏移/宽度/字节序, 对应客户端的
//     _InitMsgHeaderRule / CMsgHeaders / UdpMessageHeader 这套机制;
//   - rule=auto 时按顺序试候选规则, 能连续框出两条不越界的一律锁定并记录.
// 解析不出来的原始字节一律落盘, 不让信息从指缝里漏掉.
import fs from "node:fs";

import { config } from "./config.js";
import { log, record, hex } from "./logger.js";

type FieldType = "u8" | "u16" | "u32" | "u64" | "u16be" | "u32be";
type RuleField = [name: string, type: FieldType, at: number];

export interface FrameRule {
  name: string;
  headerSize: number;
  fields: RuleField[];
  lengthField: string | null;
  lengthIsBody?: boolean;
  raw?: boolean;
}

export interface Frame {
  msgId: number | null;
  seq: number | null;
  body: Buffer;
  raw: boolean;
  [k: string]: unknown;
}

const FIELD: Record<FieldType, (b: Buffer, o: number) => number | null> = {
  u8: (b, o) => (b.length >= o + 1 ? b.readUInt8(o) : null),
  u16: (b, o) => (b.length >= o + 2 ? b.readUInt16LE(o) : null),
  u32: (b, o) => (b.length >= o + 4 ? b.readUInt32LE(o) : null),
  u64: (b, o) => (b.length >= o + 8 ? Number(b.readBigUInt64LE(o)) : null),
  u16be: (b, o) => (b.length >= o + 2 ? b.readUInt16BE(o) : null),
  u32be: (b, o) => (b.length >= o + 4 ? b.readUInt32BE(o) : null),
};

export const CANDIDATE_RULES: FrameRule[] = [
  { name: "le32-len+id", headerSize: 12, fields: [["bodyLen", "u32", 0], ["msgId", "u32", 4], ["seq", "u32", 8]], lengthField: "bodyLen", lengthIsBody: true },
  { name: "be32-len+id", headerSize: 12, fields: [["bodyLen", "u32be", 0], ["msgId", "u32be", 4], ["seq", "u32be", 8]], lengthField: "bodyLen", lengthIsBody: true },
  { name: "id+le32-len", headerSize: 12, fields: [["msgId", "u32", 0], ["bodyLen", "u32", 4], ["seq", "u32", 8]], lengthField: "bodyLen", lengthIsBody: true },
  { name: "le16-len+id", headerSize: 8, fields: [["bodyLen", "u16", 0], ["msgId", "u16", 2], ["seq", "u32", 4]], lengthField: "bodyLen", lengthIsBody: true },
  { name: "le32-total", headerSize: 8, fields: [["totalLen", "u32", 0], ["msgId", "u32", 4]], lengthField: "totalLen", lengthIsBody: false },
  { name: "raw", headerSize: 0, fields: [], lengthField: null, raw: true },
];

export function loadRule(): FrameRule | null {
  try {
    const raw = JSON.parse(fs.readFileSync(config.paths.headerRule, "utf8")) as string | FrameRule;
    const named = typeof raw === "string" ? CANDIDATE_RULES.find((r) => r.name === raw) : raw;
    return { ...(named ?? (raw as FrameRule)) };
  } catch {
    return null; // -> auto
  }
}

export interface FramerOpts {
  maxFrame?: number;
  onRaw?: (b: Buffer) => void;
}

export class Framer {
  maxFrame: number;
  onRaw: (b: Buffer) => void;
  locked: FrameRule | null;
  tried: string[] = [];
  buffer: Buffer = Buffer.alloc(0);
  parsed = 0;

  constructor(rule?: FrameRule | null, { maxFrame = 1 << 20, onRaw }: FramerOpts = {}) {
    this.maxFrame = maxFrame;
    this.onRaw = onRaw ?? ((b) => record.packet("frame:unparsed", b, `无法框帧, 需抓包确认头格式: ${hex(b)}`));
    this.locked = rule ?? null;
  }

  feed(chunk: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.locked) this.#probe();
    if (!this.locked) return [];
    return this.#drain();
  }

  #probe(): void {
    if (this.buffer.length < 8) return;
    for (const rule of CANDIDATE_RULES) {
      const frames = this.#try(rule, 2);
      if (frames === true) {
        this.locked = rule;
        log("info", "framing", `锁定帧格式规则: ${rule.name} (auto 试探 ${this.tried.length} 个候选失败)`);
        record.json("framing-locked.json", { rule: rule.name, at: new Date().toISOString() });
        return;
      }
      this.tried.push(rule.name);
    }
    if (this.buffer.length > 4096) {
      this.onRaw(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
  }

  // 连续两条都能框住才算命中
  #try(rule: FrameRule, want: number): boolean {
    let off = 0;
    for (let i = 0; i < want; i++) {
      if (rule.raw) return off > 0;
      if (off + rule.headerSize > this.buffer.length) return i > 0;
      const h: Record<string, number | null> = {};
      for (const [name, type, at] of rule.fields) h[name] = FIELD[type](this.buffer, off + at);
      const size = rule.lengthField ? h[rule.lengthField] ?? null : null;
      if (size === null) return false;
      const total = rule.lengthIsBody ? rule.headerSize + size : size;
      if (size < 0 || total > this.maxFrame) return false;
      if (off + total > this.buffer.length) return i > 0;
      off += total;
    }
    return off === this.buffer.length || this.buffer.length - off >= rule.headerSize;
  }

  #drain(): Frame[] {
    const rule = this.locked;
    if (!rule) return [];
    const out: Frame[] = [];
    if (rule.raw) {
      const body = this.buffer;
      this.buffer = Buffer.alloc(0);
      out.push({ msgId: null, seq: null, body, raw: true });
      return out;
    }
    while (this.buffer.length >= rule.headerSize) {
      const h: Record<string, number | null> = {};
      for (const [name, type, at] of rule.fields) h[name] = FIELD[type](this.buffer, at);
      const size = rule.lengthField ? h[rule.lengthField] ?? null : null;
      const total = rule.lengthIsBody ? rule.headerSize + (size ?? 0) : (size ?? 0);
      if (size === null || size < 0 || total > this.maxFrame) {
        this.onRaw(this.buffer);
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (this.buffer.length < total) break;
      const body = this.buffer.subarray(rule.headerSize, total);
      this.buffer = this.buffer.subarray(total);
      out.push({ ...h, msgId: h.msgId ?? null, seq: h.seq ?? null, body, raw: false });
      this.parsed++;
    }
    return out;
  }
}

// 出站编码: 用已锁定的规则(或指定规则)拼一帧
export function encode(
  rule: FrameRule | null | undefined,
  { msgId = 0, seq = 0, body = Buffer.alloc(0) }: { msgId?: number; seq?: number; body?: Buffer },
  extra: Record<string, number> = {},
): Buffer {
  if (!rule || rule.raw) return Buffer.concat([Buffer.alloc(0), body]);
  const buf = Buffer.alloc(rule.headerSize);
  for (const [name, type, at] of rule.fields) {
    const value = name === "bodyLen" ? body.length
      : name === "totalLen" ? rule.headerSize + body.length
        : (extra[name] ?? { msgId, seq }[name] ?? 0);
    if (type === "u8") buf.writeUInt8(value & 0xff, at);
    else if (type === "u16") buf.writeUInt16LE(value, at);
    else if (type === "u32") buf.writeUInt32LE(value >>> 0, at);
    else if (type === "u16be") buf.writeUInt16BE(value, at);
    else if (type === "u32be") buf.writeUInt32BE(value >>> 0, at);
  }
  return Buffer.concat([buf, body]);
}
