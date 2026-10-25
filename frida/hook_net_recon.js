'use strict';
// 网络侦察(极轻量): 聚合 getaddrinfo 的域名 与 connect 的目标, 每 1.5s 上报一次.
// 不逐条 send, 避免拖死游戏.
var hosts = {}, conns = {}, installed = false;

function emit(ev, meta) { try { send(Object.assign({ ev: ev }, meta)); } catch (e) { } }

function install() {
  if (installed) return true;
  var libc = Process.findModuleByName('libc.so');
  if (!libc) return false;
  installed = true;
  var ex = function (n) { try { return libc.findExportByName(n); } catch (e) { return null; } };

  var g = ex('getaddrinfo');
  if (g) Interceptor.attach(g, {
    onEnter: function (a) { try { this.node = a[0].readCString(); } catch (e) { this.node = null; } },
    onLeave: function (ret) { if (this.node) hosts[this.node] = (hosts[this.node] || 0) + 1; }
  });

  var c = ex('connect');
  if (c) Interceptor.attach(c, {
    onEnter: function (a) {
      try {
        var sa = a[1], fam = sa.readU16(), s = '';
        if (fam === 2) {
          var port = (sa.add(2).readU8() << 8) | sa.add(3).readU8();
          s = sa.add(4).readU8() + '.' + sa.add(5).readU8() + '.' + sa.add(6).readU8() + '.' + sa.add(7).readU8() + ':' + port;
        } else if (fam === 10) {
          var b = []; for (var i = 0; i < 16; i++) b.push(('0' + sa.add(8 + i).readU8().toString(16)).slice(-2));
          s = '[' + b.join('') + ']';
        } else { s = 'fam' + fam; }
        conns[s] = (conns[s] || 0) + 1;
      } catch (e) { }
    }
  });
  emit('recon-hooks', { getaddrinfo: !!g, connect: !!c });
  return true;
}

install();
setInterval(function () {
  emit('hosts', { data: hosts });
  emit('conns', { data: conns });
}, 1500);
emit('recon-loaded', { ok: installed });
