'use strict';
// 全部网络目标: getaddrinfo 的域名 + connect 的目标(不论是不是隧道 IP), 聚合上报
function emit(ev, m) { try { send(Object.assign({ ev: ev }, m)); } catch (e) { } }
(function () {
  var libc = Process.findModuleByName('libc.so');
  if (!libc) { emit('net', { m: 'no libc' }); return; }
  var ex = function (n) { try { return libc.findExportByName(n); } catch (e) { return null; } };
  var hosts = {}, conns = {};
  var g = ex('getaddrinfo');
  if (g) Interceptor.attach(g, {
    onEnter: function (a) { try { var h = a[0].readCString(); if (h) hosts[h] = (hosts[h] || 0) + 1; } catch (e) { } }
  });
  function fmt(sa) {
    try {
      var fam = sa.readU16();
      if (fam === 2) { var p = (sa.add(2).readU8() << 8) | sa.add(3).readU8(); return sa.add(4).readU8() + '.' + sa.add(5).readU8() + '.' + sa.add(6).readU8() + '.' + sa.add(7).readU8() + ':' + p; }
      if (fam === 10) { var b = []; for (var i = 0; i < 16; i++) b.push(('0' + sa.add(8 + i).readU8().toString(16)).slice(-2)); return '[' + b.join('') + ']:' + ((sa.add(2).readU8() << 8) | sa.add(3).readU8()); }
      return 'fam' + fam;
    } catch (e) { return '?'; }
  }
  var c = ex('connect');
  if (c) Interceptor.attach(c, {
    onEnter: function (a) { var d = fmt(a[1]); if (d !== '?') conns[d] = (conns[d] || 0) + 1; }
  });
  setInterval(function () { emit('hosts', { data: hosts }); emit('conns', { data: conns }); }, 2000);
  emit('netflow-ready', {});
})();
