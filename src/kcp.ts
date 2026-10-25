// KCP (ikcp / kcp2k) 段编解码 + 最小可靠服务端.
//
// 线上格式: 每个 UDP 数据报可含 N 个段, 每段 = 24 字节头 + len 字节数据, 全小端.
//   +0  conv  u32   会话 ID
//   +4  cmd   u8    81=PUSH 82=ACK 83=WASK 84=WAS, kcp2k 另有 0..3 控制命令
//   +5  frg   u8    分片序号 (0 = 最后一片)
//   +6  wnd   u16   接收窗口
//   +8  ts    u32   发送时刻 (相对会话起点的毫秒)
//   +12 sn    u32   发送序号
//   +16 una   u32   已确认序号
//   +20 len   u32   数据长度
// 依据: metadata 中的 kcp2k 程序集 + KcpClient/KcpServer/KcpConnection/KcpTransport 等类型名.

export const CMD = {
  PUSH: 81,
  ACK: 82,
  WASK: 83,
  WAS: 84,
  CTRL_PING: 0,
  CTRL_CHOKE: 1,
  CTRL_STAT: 2,
  MSG_PING: 3,
} as const;

const OVERHEAD = 24;

export interface KcpSegment {
  conv: number;
  cmd: number;
  frg: number;
  wnd: number;
  ts: number;
  sn: number;
  una: number;
  len: number;
  data: Buffer;
}

export interface KcpSegmentInit {
  conv: number;
  cmd: number;
  frg?: number;
  wnd?: number;
  ts?: number;
  sn?: number;
  una?: number;
  data?: Buffer;
}

export function encodeSegment(seg: KcpSegmentInit): Buffer {
  const data = seg.data ?? Buffer.alloc(0);
  const buf = Buffer.alloc(OVERHEAD + data.length);
  buf.writeUInt32LE(seg.conv >>> 0, 0);
  buf.writeUInt8(seg.cmd, 4);
  buf.writeUInt8(seg.frg ?? 0, 5);
  buf.writeUInt16LE((seg.wnd ?? 0) & 0xffff, 6);
  buf.writeUInt32LE((seg.ts ?? 0) >>> 0, 8);
  buf.writeUInt32LE((seg.sn ?? 0) >>> 0, 12);
  buf.writeUInt32LE((seg.una ?? 0) >>> 0, 16);
  buf.writeUInt32LE(data.length >>> 0, 20);
  data.copy(buf, OVERHEAD);
  return buf;
}

// 返回 {segments, rest}: 一个数据报里的完整段 + 无法解析的尾字节.
export function decodePacket(packet: Buffer): { segments: KcpSegment[]; rest: Buffer } {
  const segments: KcpSegment[] = [];
  let off = 0;
  while (off + OVERHEAD <= packet.length) {
    const cmd = packet.readUInt8(off + 4);
    const len = packet.readUInt32LE(off + 20);
    if (len > packet.length - off - OVERHEAD) break;
    segments.push({
      conv: packet.readUInt32LE(off),
      cmd,
      frg: packet.readUInt8(off + 5),
      wnd: packet.readUInt16LE(off + 6),
      ts: packet.readUInt32LE(off + 8),
      sn: packet.readUInt32LE(off + 12),
      una: packet.readUInt32LE(off + 16),
      len,
      data: packet.subarray(off + OVERHEAD, off + OVERHEAD + len),
    });
    off += OVERHEAD + len;
  }
  return { segments, rest: packet.subarray(off) };
}

export const looksLikeKcp = (packet: Buffer): boolean =>
  packet.length >= OVERHEAD && decodePacket(packet).segments.length > 0 && decodePacket(packet).rest.length === 0;

// ---------------------------------------------------------------- 会话
// 只保证 "收数据 + 回 ACK + 有序交付 + 我方重传", 不做拥塞控制.
export interface KcpSessionOpts {
  mtu?: number;
  sndWnd?: number;
  rcvWnd?: number;
  now?: () => number;
  output?: (buf: Buffer) => void;
}

interface PendingItem {
  seg: KcpSegment;
  sent: number;
  tries: number;
}

export class KcpSession extends EventTarget {
  conv: number;
  mtu: number;
  mss: number;
  sndWnd: number;
  rcvWnd: number;
  now: () => number;
  output: (buf: Buffer) => void;
  start: number;
  rcvNxt = 0;
  rcvBuf = new Map<number, Buffer>();
  sndNxt = 0;
  sndUna = 0;
  pending = new Map<number, PendingItem>();
  timer: NodeJS.Timeout | null = null;

  constructor(conv: number, { mtu = 1400, sndWnd = 128, rcvWnd = 128, now = () => Date.now(), output }: KcpSessionOpts = {}) {
    super();
    this.conv = conv >>> 0;
    this.mtu = mtu;
    this.mss = mtu - OVERHEAD;
    this.sndWnd = sndWnd;
    this.rcvWnd = rcvWnd;
    this.now = now;
    this.output = output ?? (() => {});
    this.start = now();
  }

  ticks(): number {
    return (this.now() - this.start) >>> 0;
  }

  // 收到一个 UDP 数据报, 解析并处理其中的段
  input(packet: Buffer): number {
    const { segments, rest } = decodePacket(packet);
    for (const seg of segments) this.#handle(seg);
    if (rest.length) this.dispatchEvent(new CustomEvent("garbage", { detail: { bytes: rest } }));
    return segments.length;
  }

  #handle(seg: KcpSegment): void {
    if (seg.cmd === CMD.ACK) {
      for (let sn = seg.una; sn < this.sndNxt; sn++) this.pending.delete(sn);
      this.sndUna = Math.max(this.sndUna, seg.una);
      return;
    }
    if (seg.cmd === CMD.WASK) return this.#reply(seg, CMD.WAS);
    if (seg.cmd === CMD.CTRL_PING) return this.#reply(seg, CMD.MSG_PING);
    if (seg.cmd === CMD.PUSH) {
      if (seg.sn < this.rcvNxt) return this.#ack(seg); // 重复包, 只补 ACK
      if (seg.sn >= this.rcvNxt + this.rcvWnd * 4) return; // 远超窗口, 丢弃
      this.rcvBuf.set(seg.sn, seg.data);
      this.#drain();
      return this.#ack(seg);
    }
    this.dispatchEvent(new CustomEvent("control", { detail: seg }));
  }

  #drain(): void {
    while (this.rcvBuf.has(this.rcvNxt)) {
      const data = this.rcvBuf.get(this.rcvNxt++)!;
      this.rcvBuf.delete(this.rcvNxt - 1);
      if (data.length) this.dispatchEvent(new CustomEvent("data", { detail: data }));
    }
  }

  #ack(seg: KcpSegment): void {
    this.#send({ cmd: CMD.ACK, sn: seg.sn, data: Buffer.alloc(0) });
  }

  #reply(seg: KcpSegment, cmd: number): void {
    this.#send({ cmd, sn: seg.sn, data: Buffer.alloc(0) });
  }

  #send({ cmd, sn = 0, frg = 0, data }: { cmd: number; sn?: number; frg?: number; data: Buffer }): void {
    this.output(encodeSegment({
      conv: this.conv, cmd, frg, wnd: this.rcvWnd, ts: this.ticks(), sn, una: this.rcvNxt, data,
    }));
  }

  // 有序字节流 -> 若干 PUSH 段 (每段最多 mss 字节, frg 倒序标记分片)
  send(payload: Buffer): void {
    const chunks: Buffer[] = [];
    for (let i = 0; i < payload.length; i += this.mss) chunks.push(payload.subarray(i, i + this.mss));
    if (!chunks.length) chunks.push(Buffer.alloc(0));
    const total = chunks.length;
    const now = this.ticks();
    chunks.forEach((data, idx) => {
      const sn = this.sndNxt++;
      const seg: KcpSegment = {
        conv: this.conv,
        cmd: CMD.PUSH,
        frg: total - idx - 1,
        wnd: this.rcvWnd,
        ts: now,
        sn,
        una: this.rcvNxt,
        len: data.length,
        data,
      };
      this.pending.set(sn, { seg, sent: this.now(), tries: 0 });
    });
    this.#flush();
    this.#armTimer();
  }

  flush(): void {
    const now = this.now();
    for (const [, item] of [...this.pending].sort((a, b) => a[0] - b[0])) {
      this.output(encodeSegment(item.seg));
      item.sent = now;
    }
  }

  #flush(): void {
    this.flush();
  }

  // 简单超时重传; 真机抓包确认对端 RTO 后再调
  #armTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = this.now();
      let alive = false;
      for (const [, item] of this.pending) {
        alive = true;
        if (now - item.sent > 250 && item.tries < 8) {
          item.tries++;
          item.seg.ts = this.ticks();
          item.seg.una = this.rcvNxt;
          this.output(encodeSegment(item.seg));
          item.sent = now;
        }
      }
      if (!alive) {
        clearInterval(this.timer!);
        this.timer = null;
      }
    }, 120);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pending.clear();
    this.rcvBuf.clear();
  }
}
