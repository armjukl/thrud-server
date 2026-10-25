'use strict';
// 重定向: 在 getaddrinfo 入口把已死域名替换成 REDIR_IP(隧道入口), 使解析成功并连到我们.
// 记录 hosts / connect 目标端口 / sendto 目标, 轻量聚合上报.
var REDIR = '23.147.232.29';
var MATCH = /bili-api-thrud\.bilibiligame\.net$|armorgirls[a-z0-9-]*\.bilibiligame\.net$|thrud[a-z0-9-]*\.accessgames\.com$/i;

var seenHosts = {}, rewritten = {}, connects = {}, sendtoDst = {}, lastHost = {}, installed = false;
var redirStr = null;

function emit(ev, meta) { try { send(Object.assign({ ev: ev }, meta)); } catch (e) { } }

function fmtSa(sa) {
  try {
    var fam = sa.readU16();
    if (fam === 2) {
      var port = (sa.add(2).readU8() << 8) | sa.add(3).readU8();
      return sa.add(4).readU8() + '.' + sa.add(5).readU8() + '.' + sa.add(6).readU8() + '.' + sa.add(7).readU8() + ':' + port;
    }
    if (fam === 10) {
      var b = []; for (var i = 0; i < 16; i++) b.push(('0' + sa.add(8 + i).readU8().toString(16)).slice(-2));
      return '[' + b.join('') + ']:' + ((sa.add(2).readU8() << 8) | sa.add(3).readU8());
    }
    return 'fam' + fam;
  } catch (e) { return '?'; }
}

function install() {
  if (installed) return true;
  var libc = Process.findModuleByName('libc.so');
  if (!libc) return false;
  installed = true;
  var ex = function (n) { try { return libc.findExportByName(n); } catch (e) { return null; } };

  var gai = ex('getaddrinfo');
  if (gai) {
    redirStr = Memory.allocUtf8String(REDIR);
    Interceptor.attach(gai, {
      onEnter: function (a) {
        var host = null;
        try { host = a[0].readCString(); } catch (e) { }
        if (!host) return;
        try { this.service = a[1].isNull() ? null : a[1].readCString(); } catch (e) { this.service = null; }
        this.host = host;
        seenHosts[host] = (seenHosts[host] || 0) + 1;
        lastHost[Process.getCurrentThreadId()] = host;
        if (MATCH.test(host)) {
          a[0] = redirStr;   // 改参数: 让真实 getaddrinfo 解析成 REDIR_IP
          rewritten[host] = (rewritten[host] || 0) + 1;
          this.matched = true;
          this.res = a[3];
        }
      },
      onLeave: function (ret) {
        if (!this.matched) return;
        var info = { host: this.host, service: this.service, rc: ret.toInt32() };
        try {
          var head = this.res.readPointer();
          if (!head.isNull()) {
            var c = [32, 24];
            for (var i = 0; i < c.length; i++) {
              var p = head.add(c[i]).readPointer();
              if (!p.isNull() && (p.readU16() === 2 || p.readU16() === 10)) { info.addr = fmtSa(p); break; }
            }
          }
        } catch (e) { }
        emit('resolve', info);
      }
    });
  }

  var conn = ex('connect');
  if (conn) Interceptor.attach(conn, {
    onEnter: function (a) {
      this.dst = fmtSa(a[1]);
      this.host = lastHost[Process.getCurrentThreadId()] || '';
    },
    onLeave: function (ret) {
      if (this.dst && this.dst.indexOf('147.232.29') >= 0) {
        emit('connect', { host: this.host, dst: this.dst, rc: ret.toInt32() });
      }
    }
  });

  var st = ex('sendto');
  if (st) Interceptor.attach(st, {
    onEnter: function (a) { var d = fmtSa(a[4]); sendtoDst[d] = (sendtoDst[d] || 0) + 1; }
  });

  emit('redirect-hooks', { getaddrinfo: !!gai, connect: !!conn, sendto: !!st, redir: REDIR });
  return true;
}

install();
setInterval(function () {
  emit('hosts', { data: seenHosts });
  emit('rewritten', { data: rewritten });
  emit('connects', { data: connects });
  emit('sendto', { data: sendtoDst });
}, 1500);
emit('redirect-loaded', { ok: installed });
