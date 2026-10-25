'use strict';
// 合并: (1) getaddrinfo 把死域名重定向到隧道 IP; (2) 绕过 Java 侧 TLS 证书校验.
// 用于让客户端连上我们的 HTTPS 假服并把明文请求打过来.
var REDIR = '23.147.232.29';
var MATCH = /bili-api-thrud\.bilibiligame\.net$|armorgirls[a-z0-9-]*\.bilibiligame\.net$|thrud[a-z0-9-]*\.accessgames\.com$/i;

var seenHosts = {}, rewritten = {}, installed = false, redirStr = null, lastHost = {};

function emit(ev, meta) { try { send(Object.assign({ ev: ev }, meta)); } catch (e) { } }
function fmtSa(sa) {
  try {
    var fam = sa.readU16();
    if (fam === 2) { var port = (sa.add(2).readU8() << 8) | sa.add(3).readU8(); return sa.add(4).readU8() + '.' + sa.add(5).readU8() + '.' + sa.add(6).readU8() + '.' + sa.add(7).readU8() + ':' + port; }
    if (fam === 10) { var b = []; for (var i = 0; i < 16; i++) b.push(('0' + sa.add(8 + i).readU8().toString(16)).slice(-2)); return '[' + b.join('') + ']:' + ((sa.add(2).readU8() << 8) | sa.add(3).readU8()); }
    return 'fam' + fam;
  } catch (e) { return '?'; }
}

function installRedirect() {
  var libc = Process.findModuleByName('libc.so');
  if (!libc) return false;
  redirStr = Memory.allocUtf8String(REDIR);
  var gai = libc.findExportByName('getaddrinfo');
  if (gai) Interceptor.attach(gai, {
    onEnter: function (a) {
      var host = null; try { host = a[0].readCString(); } catch (e) { }
      if (!host) return;
      seenHosts[host] = (seenHosts[host] || 0) + 1;
      lastHost[Process.getCurrentThreadId()] = host;
      if (MATCH.test(host)) { a[0] = redirStr; rewritten[host] = (rewritten[host] || 0) + 1; }
    }
  });
  var conn = libc.findExportByName('connect');
  if (conn) Interceptor.attach(conn, {
    onEnter: function (a) { this.dst = fmtSa(a[1]); this.host = lastHost[Process.getCurrentThreadId()] || ''; },
    onLeave: function (ret) { if (this.dst && this.dst.indexOf('147.232.29') >= 0) emit('connect', { host: this.host, dst: this.dst, rc: ret.toInt32() }); }
  });
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
setInterval(function () { emit('hosts', { data: seenHosts }); emit('rewritten', { data: rewritten }); }, 3000);
emit('combined-loaded', { redir: installed });
