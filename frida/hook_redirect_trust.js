'use strict';
// 合并: (1) getaddrinfo 把死域名重定向到假服 IP; (2) sockaddr 端口就地改写; (3) 绕过 Java 侧 TLS 证书校验.
//
// 两条网络路二选一。设备侧脚本文件名写死在 gadget 配置里(hook_redirect_trust.js), 所以模式做在
// 这份文件内: 换模式就是换这个文件的内容再推上去。
//   tunnel: PC 上跑假服, frpc 把公网 443 转到本机 9443 —— 现状, 默认, 不用改端口
//   local : 手机自己的 APK 假服, 全在 127.0.0.1; 非 root 绑不了 443, 于是把 sockaddr 里的 443 改成 9443
var MODE = 'tunnel';
var TUNNEL_IP = '<YOUR_SERVER_IP>';
var LOCAL_IP = '127.0.0.1';
var REDIR = MODE === 'local' ? LOCAL_IP : TUNNEL_IP;
// 只改"目标是 REDIR"的那条: 别的 IP/端口一个字节都不碰
var SA_RULE = MODE === 'local' ? { ip: LOCAL_IP, from: 443, to: 9443 } : null;
var MATCH = /bili-api-thrud\.bilibiligame\.net$|armorgirls[a-z0-9-]*\.bilibiligame\.net$|thrud[a-z0-9-]*\.accessgames\.com$/i;

var seenHosts = {}, rewritten = {}, patched = {}, installed = false, redirStr = null, lastHost = {};

function emit(ev, meta) { try { send(Object.assign({ ev: ev }, meta)); } catch (e) { } }
function fmtSa(sa) {
  try {
    var fam = sa.readU16();
    if (fam === 2) { var port = (sa.add(2).readU8() << 8) | sa.add(3).readU8(); return sa.add(4).readU8() + '.' + sa.add(5).readU8() + '.' + sa.add(6).readU8() + '.' + sa.add(7).readU8() + ':' + port; }
    if (fam === 10) { var b = []; for (var i = 0; i < 16; i++) b.push(('0' + sa.add(8 + i).readU8().toString(16)).slice(-2)); return '[' + b.join('') + ']:' + ((sa.add(2).readU8() << 8) | sa.add(3).readU8()); }
    return 'fam' + fam;
  } catch (e) { return '?'; }
}

/* SLD_SA_START */
// 纯字节运算, 不碰 Frida API —— test/selftest.mjs 会把这段原样抽出去用 Uint8Array 断言,
// 改这里的偏移就等于改那条自检的前提。
// sockaddr_in: [0..1] sin_family(小端) [2..3] sin_port(网络序=大端) [4..7] sin_addr
function sldSaV4(sa) {
  return sa[4] + '.' + sa[5] + '.' + sa[6] + '.' + sa[7] + ':' + ((sa[2] << 8) | sa[3]);
}
function sldPatchSaPort(sa, rule) {
  if (!sa || sa.length < 16 || !rule) return 0;
  if ((sa[0] | (sa[1] << 8)) !== 2) return 0; // 只管 AF_INET, v6/unix 一律不动
  if (rule.ip && sldSaV4(sa).split(':')[0] !== rule.ip) return 0;
  if (((sa[2] << 8) | sa[3]) !== rule.from) return 0;
  sa[2] = (rule.to >> 8) & 0xff;
  sa[3] = rule.to & 0xff;
  return 1;
}
/* SLD_SA_END */

// 就地改一块 sockaddr: 读 16 字节 -> 纯函数 -> 写回。返回改了几次(0/1)。
function patchSa(ptr, addrlen, where) {
  if (!SA_RULE || ptr.isNull()) return 0;
  try {
    if (addrlen < 16) return 0; // 不足一个 sockaddr_in: 宁可不动, 也别越界读
    var sa = new Uint8Array(Memory.readByteArray(ptr, 16));
    if (!sldPatchSaPort(sa, SA_RULE)) return 0;
    var out = [];
    for (var i = 0; i < 16; i++) out.push(sa[i]);
    Memory.writeByteArray(ptr, out);
    patched[where] = (patched[where] || 0) + 1;
    return 1;
  } catch (e) { emit('err', { where: where, msg: String(e) }); return 0; }
}

// addrinfo 链上的偏移按指针宽度算(x64 有 4 字节对齐垫, armv7 没有)
var AI_ADDR_OFF = Process.pointerSize === 8 ? 24 : 20;
var AI_NEXT_OFF = Process.pointerSize === 8 ? 40 : 28;

function installRedirect() {
  var libc = Process.findModuleByName('libc.so');
  if (!libc) return false;
  redirStr = Memory.allocUtf8String(REDIR);
  var gai = libc.findExportByName('getaddrinfo');
  if (gai) Interceptor.attach(gai, {
    onEnter: function (a) {
      this.res = a[3];
      var host = null; try { host = a[0].readCString(); } catch (e) { }
      if (!host) return;
      seenHosts[host] = (seenHosts[host] || 0) + 1;
      lastHost[Process.getCurrentThreadId()] = host;
      if (MATCH.test(host)) { a[0] = redirStr; rewritten[host] = (rewritten[host] || 0) + 1; }
    },
    // 客户端可能拿 res 直接 sendto/sendmsg(KCP 走 UDP 就是这条), 不经过 connect() ——
    // 所以解析结果本身也要改。
    onLeave: function (ret) {
      if (!SA_RULE || !this.res || ret.toInt32() !== 0) return;
      try {
        var ai = this.res.readPointer();
        while (ai && !ai.isNull()) {
          patchSa(ai.add(AI_ADDR_OFF).readPointer(), ai.add(16).readU32(), 'getaddrinfo');
          ai = ai.add(AI_NEXT_OFF).readPointer();
        }
      } catch (e) { emit('err', { where: 'getaddrinfo-leave', msg: String(e) }); }
    }
  });
  var conn = libc.findExportByName('connect');
  if (conn) Interceptor.attach(conn, {
    onEnter: function (a) {
      this.dst = fmtSa(a[1]);
      this.host = lastHost[Process.getCurrentThreadId()] || '';
      patchSa(a[1], a[2].toInt32(), 'connect');
    },
    onLeave: function (ret) { if (this.dst && this.dst.indexOf(REDIR) === 0) emit('connect', { host: this.host, dst: this.dst, rc: ret.toInt32() }); }
  });
  installed = true;
  return true;
}

function installTrustAll() {
  if (!Java.available) { emit('trust', { java: false }); return; }
  Java.perform(function () {
    try {
      var X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');
      var TrustAll = Java.registerClass({
        name: 'com.sld.offline.TrustAll',
        implements: [X509TrustManager],
        methods: {
          checkClientTrusted: function (chain, authType) { },
          checkServerTrusted: function (chain, authType) { },
          getAcceptedIssuers: function () { return []; }
        }
      });
      var SSLContext = Java.use('javax.net.ssl.SSLContext');
      var init = SSLContext.init.overload('[Ljavax.net.ssl.KeyManager;', '[Ljavax.net.ssl.TrustManager;', 'java.security.SecureRandom');
      init.implementation = function (km, tm, sr) {
        return init.call(this, km, [TrustAll.$new()], sr);
      };
      emit('trust', { ctx: true });
    } catch (e) { emit('err', { where: 'sslcontext', msg: String(e) }); }

    try {
      var HttpsURLConnection = Java.use('javax.net.ssl.HttpsURLConnection');
      var HostnameVerifier = Java.use('javax.net.ssl.HostnameVerifier');
      var TrustAllHV = Java.registerClass({
        name: 'com.sld.offline.TrustAllHV',
        implements: [HostnameVerifier],
        methods: { verify: function (host, session) { return true; } }
      });
      HttpsURLConnection.setDefaultHostnameVerifier.implementation = function (hv) { return this.setDefaultHostnameVerifier(TrustAllHV.$new()); };
      emit('trust', { hv: true });
    } catch (e) { emit('err', { where: 'hostname', msg: String(e) }); }
  });
}

installRedirect();
installTrustAll();
setInterval(function () { emit('hosts', { data: seenHosts }); emit('rewritten', { data: rewritten }); emit('sa-patch', { data: patched }); }, 3000);
emit('combined-loaded', { redir: installed, mode: MODE, rule: SA_RULE });
