// 极简 protobuf 编码器: 只实现 GS 回包需要的 wire type 0(varint) 与 2(length-delimited)。
// 字段编号/类型来自 frida_dump 里 Lua 的 proto 文本 (proto/msg.proto, proto/PlayerProto.proto)。

export type PbValue = bigint | Buffer;

export interface DecodedField {
  field: number;
  wire: number;
  value: bigint | Buffer;
}

export type DecodedFields = DecodedField[] & { end: number; ok: boolean };

const buf = (b: Buffer | Uint8Array): Buffer => (Buffer.isBuffer(b) ? b : Buffer.from(b));

export function varint(value: number | bigint): Buffer {
  let v = typeof value === "bigint" ? value : BigInt(value);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
}

const tag = (field: number, wire: number): Buffer => varint((BigInt(field) << 3n) | BigInt(wire));

export function vfield(field: number, value: number | bigint | null | undefined): Buffer {
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.concat([tag(field, 0), varint(value)]);
}

export function sfield(field: number, value: string | null | undefined): Buffer {
  if (value === undefined || value === null) return Buffer.alloc(0);
  return bfield(field, Buffer.from(String(value), "utf8"));
}

/**
 * bool -> varint 0/1. 必须显式用这个: vfield 走 BigInt(true) 会直接抛.
 * 客户端 proto2 里 required bool (如 FirstThoughtInfo.redDot=2) 缺字段 = 解不出整包.
 */
export function boolfield(field: number, value: boolean | null | undefined): Buffer {
  if (value === undefined || value === null) return Buffer.alloc(0);
  return vfield(field, value ? 1 : 0);
}

export function dblfield(field: number, value: number | null | undefined): Buffer {
  if (value === undefined || value === null) return Buffer.alloc(0);
  const b = Buffer.alloc(8);
  b.writeDoubleLE(Number(value));
  return Buffer.concat([tag(field, 1), b]);
}

export function bfield(field: number, value: Buffer | Uint8Array | null | undefined): Buffer {
  if (value === undefined || value === null) return Buffer.alloc(0);
  const b = buf(value);
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
}

export function concat(...parts: Array<Buffer | Uint8Array | null | undefined>): Buffer {
  return Buffer.concat(parts.filter((p): p is Buffer | Uint8Array => !!p && p.length > 0).map(buf));
}

// ---- 反序列化: 读出字段号/值, 用于解析客户端请求 ----
export function decodeFields(data: Buffer | Uint8Array): DecodedFields {
  let ok = true;
  const b = buf(data);
  const out = [] as unknown as DecodedFields;
  let i = 0;
  while (i < b.length) {
    let shift = 0n;
    let key = 0n;
    while (i < b.length) {
      const c = b[i++]!;
      key |= BigInt(c & 0x7f) << shift;
      shift += 7n;
      if (!(c & 0x80)) break;
    }
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      let shift2 = 0n;
      let v = 0n;
      while (i < b.length) {
        const c = b[i++]!;
        v |= BigInt(c & 0x7f) << shift2;
        shift2 += 7n;
        if (!(c & 0x80)) break;
      }
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      let shift2 = 0n;
      let len = 0n;
      while (i < b.length) {
        const c = b[i++]!;
        len |= BigInt(c & 0x7f) << shift2;
        shift2 += 7n;
        if (!(c & 0x80)) break;
      }
      const n = Number(len);
      out.push({ field, wire, value: b.subarray(i, i + n) });
      i += n;
    } else if (wire === 5) {
      out.push({ field, wire, value: b.subarray(i, i + 4) });
      i += 4;
    } else if (wire === 1) {
      out.push({ field, wire, value: b.subarray(i, i + 8) });
      i += 8;
    } else {
      ok = false;
      break;
    }
  }
  out.end = i;
  out.ok = ok;
  return out;
}
