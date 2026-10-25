// frida -U -f com.wth.thrud.bilibili -l tools/hook_lua.js --no-pause
//
// 目标: 一次运行同时拿到 (a) Lua chunk 明文 -> 反推批次密钥流, (b) UDP 原始包 -> 帧格式.
// 落盘到 /data/local/tmp/sld/ , 跑完 adb pull 回 /home/qkzx/sld/sld/frida/ .
//
// 说明: liblua54.so 里有 lua_load/luaL_loadbufferx/luaL_newstate (NLua 侧),
//       libtolua.so 是 LuaJIT/ToLua, 用 luaL_loadbuffer/lua_load 同名符号 + jit 特有
//       lua_load(jit, ...) 路径. 两处都挂钩子, 谁先响谁知道.
'use strict';

var OUT = '/data/local/tmp/sld';
var seen = {};
var count = 0;

function dump(tag, buf, len) {
  try {
    if (!buf || buf.isNull() || len <= 0 || len > 0x400000) return;
    var head = buf.readByteArray(Math.min(len, 8));
    var key = tag + ':' + Array.from(new Uint8Array(head)).join(',') + ':' + len;
    if (seen[key]) return;           // 同一个 chunk 会被多次加载, 去重
    seen[key] = 1;
    var path = OUT + '/' + (count++) + '-' + tag + '-' + len + '.bin';
    var f = new File(path, 'wb');
    f.write(buf.readByteArray(len));
    f.flush();
    f.close();
    console.log('[dump] ' + path + '  head=' + hexdump(buf, { length: 32, header: false, ansi: false }).split('\n')[0]);
  } catch (e) {
    console.log('[dump-error] ' + e);
  }
}

function hookExport(mod, name, onEnter, onLeave) {
  var addr = Module.findExportByName(mod, name);
  if (!addr) { console.log('  (缺) ' + (mod || 'libc') + '!' + name); return null; }
  Interceptor.attach(addr, { onEnter: onEnter, onLeave: onLeave });
  console.log('  hooked ' + mod + '!' + name + ' @ ' + addr);
  return addr;
}

// ---- Lua 侧: 各种"把一段 buffer 交给 VM"的入口 ----------------------------
function hookLua(mod) {
  console.log('== ' + mod);
  // int luaL_loadbufferx(lua_State*, const char* buff, size_t sz, const char* name, const char* mode)
  hookExport(mod, 'luaL_loadbufferx', function (a) { dump(mod + '.loadbufferx', a[1], a[2].toInt32()); });
  hookExport(mod, 'luaL_loadbuffer', function (a) { dump(mod + '.loadbuffer', a[1], a[2].toInt32()); });
  // int luaL_loadfilex(lua_State*, const char* filename, const char* mode) —— 明文落盘后再加载的情形
  hookExport(mod, 'luaL_loadfilex', function (a) { console.log('[luaL_loadfilex] ' + a[1].readCString()); });
  hookExport(mod, 'lua_load', function (a) {
    // lua_load(lua_State*, lua_Reader r, void* dt, const char* chunkname, const char* mode)
    // reader 不好直接取长度, 记录 chunkname 即可, 便于和 buffer 对应
    try { console.log('[lua_load] chunk=' + a[3].readCString()); } catch (e) {}
  });
  hookExport(mod, 'lua_gettop', null); // 探活: 确认这个 so 真的被加载
}

// ---- UDP 侧: 拿到 KCP 原始数据报 (含握手/控制命令) ------------------------
function hookUdp() {
  console.log('== libc (udp)');
  var pkt = 0;
  hookExport(null, 'sendto', function (a) {
    var len = a[2].toInt32();
    if (len > 0 && len < 65536 && pkt++ < 4000) dump('sendto#' + pkt, a[1], len);
  });
  hookExport(null, 'recvfrom', function (a) { this.buf = a[1]; }, function (ret) {
    var len = ret.toInt32();          // 长度只有返回时才拿到
    if (len > 0 && len < 65536) dump('recvfrom', this.buf, len);
  });
  // 若 sendto 不响(走 .NET Socket -> epoll_send), 再补 connect/write 路径
  hookExport(null, 'write', function (a) {
    var len = a[2].toInt32();
    if (len > 20 && len < 2000) dump('write-fd' + a[0].toInt32(), a[1], len);
  });
}

var installed = {};

function install() {
  ['liblua54.so', 'libtolua.so'].forEach(function (m) {
    if (Process.findModuleByName(m) && !installed[m]) { installed[m] = 1; hookLua(m); }
  });
  if (!installed.udp && Process.findModuleByName('libc.so')) { installed.udp = 1; hookUdp(); }
  if (installed['liblua54.so'] && installed['libtolua.so'] && installed.udp) {
    clearInterval(poll);
    console.log('挂好了, 继续启动流程 (点登录/进服) 直到看到 dump');
  }
}

var poll = setInterval(install, 500);
install();
