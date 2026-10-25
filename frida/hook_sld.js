'use strict';
// 斯露德(com.wth.thrud.bilibili) 离线逆向 hook
//   1) liblua54.so 的加载入口 -> 抓 Lua 明文 chunk
//   2) libc 的 UDP(INET/INET6) 收发 -> 抓 KCP 原始数据报
// 通过 send(payload, ArrayBuffer) 把二进制回传本机, 由 run_hook.py 落盘.

var SENT = 0;
var LIMIT = 600 * 1024 * 1024;
var seen = {};

function hexPrefix(u8, n) {
  var s = '';
  for (var i = 0; i < n && i < u8.length; i++) s += ('0' + u8[i].toString(16)).slice(-2);
  return s;
}
function emit(ev, meta, ab) {
  if (SENT > LIMIT) return;
  if (ab) SENT += ab.byteLength;
  try { send(Object.assign({ ev: ev }, meta), ab || undefined); } catch (e) { }
}

function dumpLua(tag, ptr, len) {
  try {
    if (!ptr || ptr.isNull() || len <= 0) return;
    if (len > 32 * 1024 * 1024) { emit('lua-big', { tag: tag, len: len }); return; }
    var ab = ptr.readByteArray(len);
    if (!ab) return;
    var u8 = new Uint8Array(ab);
    var key = tag + ':' + hexPrefix(u8, 24) + ':' + len;
    if (seen[key]) return;
    seen[key] = 1;
    emit('lua', { tag: tag, len: len, head: hexPrefix(u8, 16) }, ab);
  } catch (e) { emit('err', { where: 'dumpLua:' + tag, msg: String(e) }); }
}

// ------------------------------------------------------------------ Lua
var luaInstalled = false;
function installLua() {
  if (luaInstalled) return true;
  var m = Process.findModuleByName('liblua54.so');
  if (!m) return false;
  luaInstalled = true;
  var specs = [
    ['luaL54_loadbufferx', function (a) { dumpLua('loadbufferx', a[1], a[2].toInt32()); }],
    ['luaL54_loadstring', function (a) {
      var n = 0; try { n = a[1].readUtf8String().length; } catch (e) { }
      dumpLua('loadstring', a[1], n);
    }],
    ['luaL54_loadfilex', function (a) { try { emit('loadfilex', { name: a[1].readCString() }); } catch (e) { } }],
    ['lua54_load', function (a) { try { emit('lua_load', { name: a[3].readCString() }); } catch (e) { } }]
  ];
  specs.forEach(function (t) {
    var addr = null;
    try { addr = m.findExportByName(t[0]); } catch (e) { }
    if (!addr) { emit('missing', { exp: t[0] }); return; }
    try { Interceptor.attach(addr, { onEnter: t[1] }); emit('hooked', { exp: t[0], addr: String(addr) }); }
    catch (e) { emit('err', { where: 'attach:' + t[0], msg: String(e) }); }
  });
  emit('lua-ready', { base: String(m.base) });
  return true;
}

// ------------------------------------------------------------------ net
var sockType = {};
var netInstalled = false;
function installNet() {
  if (netInstalled) return true;
  var libc = Process.findModuleByName('libc.so');
  if (!libc) return false;
  netInstalled = true;
  var ex = function (n) { try { return libc.findExportByName(n); } catch (e) { return null; } };
  function isInet(fd) { var s = sockType[fd]; return !s || s.d === 2 || s.d === 10; }

  var sSock = ex('socket');
  if (sSock) Interceptor.attach(sSock, {
    onEnter: function (a) { this.domain = a[0].toInt32(); this.type = a[1].toInt32(); },
    onLeave: function (ret) { var fd = ret.toInt32(); if (fd >= 0) sockType[fd] = { d: this.domain, t: this.type }; }
  });

  // DNS 解析: 看游戏想连哪些域名 (服务器地址)
  var sGai = ex('getaddrinfo');
  if (sGai) Interceptor.attach(sGai, {
    onEnter: function (a) { try { this.node = a[0].readCString(); } catch (e) { this.node = '?'; } },
    onLeave: function (ret) { if (this.node && this.node !== '?') emit('dns', { node: this.node, rc: ret.toInt32() }); }
  });

  // connect: 看 TCP/UDP 连接目标
  var sConn = ex('connect');
  if (sConn) Interceptor.attach(sConn, {
    onEnter: function (a) {
      try {
        var sa = a[1], fam = sa.readU16(), ip = '', port = 0;
        if (fam === 2) {
          port = (sa.add(2).readU8() << 8) | sa.add(3).readU8();
          ip = sa.add(4).readU8() + '.' + sa.add(5).readU8() + '.' + sa.add(6).readU8() + '.' + sa.add(7).readU8();
        }
        emit('connect', { fd: a[0].toInt32(), dst: ip + ':' + port, fam: fam });
      } catch (e) { }
    },
    onLeave: function (ret) { emit('connect-ret', { rc: ret.toInt32() }); }
  });

  function dumpNet(tag, fd, ptr, len, extra) {
    if (len < 8 || len > 65536) return;
    if (!isInet(fd)) return;
    var ab = null;
    try { ab = ptr.readByteArray(len); } catch (e) { return; }
    if (!ab) return;
    emit('net', Object.assign({ tag: tag, fd: fd, len: len }, extra || {}), ab);
  }

  var sSendto = ex('sendto');
  if (sSendto) Interceptor.attach(sSendto, {
    onEnter: function (a) {
      var fd = a[0].toInt32();
      var dst = '';
      try {
        var sa = a[4];
        var fam = sa.readU16();
        if (fam === 2) {
          var port = (sa.add(2).readU8() << 8) | sa.add(3).readU8();
          dst = sa.add(4).readU8() + '.' + sa.add(5).readU8() + '.' + sa.add(6).readU8() + '.' + sa.add(7).readU8() + ':' + port;
        }
      } catch (e) { }
      dumpNet('sendto', fd, a[1], a[2].toInt32(), { dst: dst });
    }
  });

  var sRecvfrom = ex('recvfrom');
  if (sRecvfrom) Interceptor.attach(sRecvfrom, {
    onEnter: function (a) { this.fd = a[0].toInt32(); this.buf = a[1]; },
    onLeave: function (ret) { dumpNet('recvfrom', this.fd, this.buf, ret.toInt32()); }
  });

  var sSend = ex('send');
  if (sSend) Interceptor.attach(sSend, {
    onEnter: function (a) { var fd = a[0].toInt32(); var s = sockType[fd]; if (s && s.t === 2) dumpNet('send', fd, a[1], a[2].toInt32()); }
  });
  var sRecv = ex('recv');
  if (sRecv) Interceptor.attach(sRecv, {
    onEnter: function (a) { var fd = a[0].toInt32(); var s = sockType[fd]; if (s && s.t === 2) { this.fd = fd; this.buf = a[1]; } },
    onLeave: function (ret) { if (this.fd !== undefined) dumpNet('recv', this.fd, this.buf, ret.toInt32()); }
  });

  emit('net-ready', { exports: { sendto: !!sSendto, recvfrom: !!sRecvfrom, send: !!sSend, recv: !!sRecv } });
  return true;
}

// ------------------------------------------------------------------ boot
installNet();
installLua();
if (typeof Process.attachModuleObserver === 'function') {
  Process.attachModuleObserver({
    onAdded: function (m) { if (m.name === 'liblua54.so') installLua(); }
  });
}
var poll = setInterval(function () { if (installLua()) { } }, 200);
setInterval(function () { emit('stats', { sent: SENT, lua: luaInstalled, net: netInstalled, chunks: Object.keys(seen).length }); }, 10000);
emit('agent-loaded', { lua: luaInstalled, net: netInstalled, liblua54: !!Process.findModuleByName('liblua54.so'), observer: typeof Process.attachModuleObserver === 'function' });
