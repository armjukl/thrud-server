// UDP 网关: 每条对端连接一个 KCP 会话(或 raw 直通), 收流 -> 框帧 -> 按 msgId 派发.
//
// mode:
//   kcp  —— 只按 24 字节 KCP 段解析
//   raw  —— 一个 UDP 数据报 = 一条消息 (THDNetwork 的 UdpMessageHeader 形态)
//   auto —— 首个数据报像 KCP 就走 KCP, 否则按 raw; 判定结果写日志
//
// 未识别的 msgId 不报错, 全部落盘到 data/capture/, 这就是抓包前能拿到东西的地方.
import dgram from "node:dgram";

import { config, type NetMode } from "./config.js";
import { log, record, hex } from "./logger.js";
import { KcpSession, looksLikeKcp, type KcpSegment } from "./kcp.js";
import { Framer, encode, loadRule, type Frame, type FrameRule } from "./framing.js";

export type Handler = (frame: Frame, peer: Peer) => unknown;
export type UnknownHook = (frame: Frame & { id: string; peer: Peer }) => void;
export type FrameHook = (peer: Peer, frame: Frame) => void;
export type ControlHook = (peer: Peer, seg: KcpSegment) => void;

const handlers = new Map<number, Handler>();
const hooks: { unknown: UnknownHook[]; frame: FrameHook[]; control: ControlHook[] } = {
  unknown: [], frame: [], control: [],
};

export const on = (msgId: number, fn: Handler): void => { handlers.set(msgId >>> 0, fn); };
export const onUnknown = (fn: UnknownHook): void => { hooks.unknown.push(fn); };
export const onFrame = (fn: FrameHook): void => { hooks.frame.push(fn); };
export const handlerIds = (): number[] => [...handlers.keys()].sort((a, b) => a - b);

export interface GatewayCfg {
  mode: NetMode;
  port: number;
  host: string;
}

export interface Gateway {
  socket: dgram.Socket;
  peers: Map<string, Peer>;
  cfg: GatewayCfg;
  start: () => Promise<dgram.Socket>;
  stop: () => void;
}

export class Peer {
  gw: Gateway;
  rinfo: dgram.RemoteInfo;
  id: string;
  rule: FrameRule | null;
  framer: Framer;
  session: KcpSession | null = null;
  mode: NetMode | null = null;
  seq = 0;
  stats = { packets: 0, bytes: 0, frames: 0, unknown: 0, sent: 0 };
  created = new Date().toISOString();

  constructor(gw: Gateway, rinfo: dgram.RemoteInfo) {
    this.gw = gw;
    this.rinfo = rinfo;
    this.id = `${rinfo.address}:${rinfo.port}`;
    this.rule = loadRule();
    this.framer = new Framer(this.rule, {
      onRaw: (b) => record.packet(`${this.tag()}:unframed`, b, `无法框帧, 需要抓包确认头格式 peer=${this.id}`),
    });
  }

  tag(): string {
    return this.id.replace(/[^0-9a-z]+/gi, "_");
  }

  write(buf: Buffer): void {
    this.stats.sent++;
    this.gw.socket.send(buf, this.rinfo.port, this.rinfo.address, () => {});
  }

  snapshot(): Record<string, unknown> {
    return { id: this.id, mode: this.mode, conv: this.session?.conv, framing: this.framer.locked?.name ?? null, since: this.created, ...this.stats };
  }

  send(msgId: number, body: Buffer = Buffer.alloc(0), extra: Record<string, number> = {}): Buffer {
    const rule = this.rule ?? this.framer.locked;
    const frame = encode(rule, { msgId, seq: ++this.seq, body }, extra);
    if (this.mode === "kcp") this.session!.send(frame);
    else this.write(frame);
    record.packet(`${this.tag()}-sent#${msgId}`, frame, `peer=${this.id} mode=${this.mode} msgId=${msgId}`);
    log("info", "gateway", `-> ${this.id} msgId=${msgId} len=${frame.length}B`);
    return frame;
  }

  input(packet: Buffer): void {
    this.stats.packets++;
    this.stats.bytes += packet.length;
    if (!this.mode) this.#detect(packet);
    if (this.mode === "kcp") this.session!.input(packet);
    else this.#stream(packet);
  }

  #detect(packet: Buffer): void {
    const want = this.gw.cfg.mode;
    this.mode = want === "raw" || want === "kcp" ? want : (looksLikeKcp(packet) ? "kcp" : "raw");
    if (this.mode === "kcp") {
      const conv = packet.readUInt32LE(0);
      this.session = new KcpSession(conv, {
        mtu: config.kcp.mtu,
        rcvWnd: config.kcp.rcvWnd,
        output: (buf) => this.write(buf),
      });
      this.session.addEventListener("data", (e) => this.#stream((e as CustomEvent<Buffer>).detail));
      this.session.addEventListener("control", (e) => {
        const seg = (e as CustomEvent<KcpSegment>).detail;
        hooks.control.forEach((f) => f(this, seg));
        record.packet(`${this.tag()}-kcp-cmd${seg.cmd}`, seg.data,
          `KCP 控制命令 cmd=${seg.cmd} sn=${seg.sn} —— 握手 conv/cookie 规则待抓包确认`);
        log("warn", "kcp", `${this.id} 收到控制命令 cmd=${seg.cmd}, 若握手失败请对照 README 第 5 节`);
      });
      log("info", "kcp", `${this.id} 判定为 KCP, conv=0x${conv.toString(16)}`);
    } else {
      log("info", "gateway", `${this.id} 判定为 raw UDP ${hex(packet, 24)}`);
    }
    record.json("peers.json", Object.fromEntries([...this.gw.peers].map(([k, p]) => [k, p.snapshot()])));
  }

  #stream(chunk: Buffer): void {
    for (const frame of this.framer.feed(chunk)) {
      this.stats.frames++;
      hooks.frame.forEach((f) => f(this, frame));
      const msgId = (frame.msgId ?? 0) >>> 0;
      const fn = handlers.get(msgId);
      record.packet(`${this.tag()}-recv#${frame.msgId ?? "raw"}`, frame.body,
        `peer=${this.id} msgId=${frame.msgId} seq=${frame.seq} framing=${this.framer.locked?.name ?? "none"}`);
      log("info", "gateway", `<- ${this.id} msgId=${frame.msgId} seq=${frame.seq} body=${frame.body.length}B ${hex(frame.body, 32)}`);
      if (!fn) {
        this.stats.unknown++;
        hooks.unknown.forEach((f) => f({ id: this.id, peer: this, ...frame }));
        continue;
      }
      Promise.resolve(fn(frame, this))
        .then((res) => {
          if (res === undefined || res === null || res === false) return;
          const [id, body] = Array.isArray(res) ? (res as [number, Buffer]) : [msgId + 1, res as Buffer];
          this.send(id, Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
        })
        .catch((e: unknown) => log("error", "handler", `msgId=${msgId} ${(e as Error).stack || String(e)}`));
    }
  }
}

export function createGateway(overrides: Partial<GatewayCfg> = {}): Gateway {
  const cfg: GatewayCfg = { ...config.gateway, ...overrides };
  const socket = dgram.createSocket("udp4");
  const gw = { socket, peers: new Map<string, Peer>(), cfg } as Gateway;

  socket.on("message", (msg, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`;
    let peer = gw.peers.get(key);
    if (!peer) {
      peer = new Peer(gw, rinfo);
      gw.peers.set(key, peer);
      log("info", "gateway", `新连接 ${key} (已知 msgId 处理器 ${handlerIds().length} 个)`);
    }
    peer.rinfo = rinfo;
    try {
      peer.input(msg);
    } catch (e) {
      log("error", "gateway", `${key} ${(e as Error).stack || String(e)}`);
    }
  });
  socket.on("error", (e) => log("error", "gateway", String(e.message || e)));
  gw.start = () => new Promise((r) => socket.bind(cfg.port, cfg.host, () => {
    log("info", "gateway", `网关监听 udp://${cfg.host}:${cfg.port} mode=${cfg.mode}`);
    r(socket);
  }));
  gw.stop = () => {
    for (const p of gw.peers.values()) p.session?.close();
    socket.close();
  };
  return gw;
}
