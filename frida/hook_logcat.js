'use strict';
// hook Android 日志, 过滤出游戏/网络/更新相关行
function emit(ev, m) { try { send(Object.assign({ ev: ev }, m)); } catch (e) { } }
(function () {
  var liblog = Process.findModuleByName('liblog.so');
  if (!liblog) { emit('logcat', { m: 'no liblog' }); return; }
  var KW = /Skip|skip|Update|update|Version|version|Cdn|CDN|Hot|hot|Server|server|Login|login|Error|error|Exception|HTTP|http|token|sdk|SDK|url|Url/;
  var flt = function (tag, msg) {
    if (!msg) return false;
    if (KW.test(msg)) return true;
    if (tag && /Unity|THD|Thrud|thrud|sld|SDK|Network/i.test(tag)) return true;
    return false;
  };
  var readS = function (p) { try { var s = p.readCString(); return s && s.length < 600 ? s : null; } catch (e) { return null; } };

  var w = liblog.findExportByName('__android_log_write');
  if (w) Interceptor.attach(w, {
    onEnter: function (a) { var t = readS(a[1]), m = readS(a[2]); if (flt(t, m)) emit('log', { tag: t, msg: m }); }
  });
  var pr = liblog.findExportByName('__android_log_print');
  if (pr) Interceptor.attach(pr, {
    onEnter: function (a) { var t = readS(a[1]), m = readS(a[2]); if (flt(t, m)) emit('log', { tag: t, fmt: m }); }
  });
  emit('logcat-ready', { write: !!w, print: !!pr });
})();
