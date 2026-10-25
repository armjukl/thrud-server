'use strict';
// 最小 Agent: 只挂 liblua54.so 的加载入口, 抓 Lua 明文 chunk.
// 不碰 libc (socket/getaddrinfo/connect/send/recv 会高频且拖死游戏).
// 二进制经 send(payload, ArrayBuffer) 回传, run_hook.py 落盘.

var SENT = 0, LIMIT = 800 * 1024 * 1024, seen = {}, installed = false;

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

function installLua() {
  if (installed) return true;
  var m = Process.findModuleByName('liblua54.so');
  if (!m) return false;
  installed = true;
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

installLua();
var poll = setInterval(installLua, 150);
setInterval(function () { emit('stats', { sent: SENT, chunks: Object.keys(seen).length, lua: installed }); }, 10000);
emit('agent-loaded', { lua: installed, liblua54: !!Process.findModuleByName('liblua54.so') });
