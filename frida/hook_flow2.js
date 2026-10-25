'use strict';
// hook UIGameStart / THD.VideoManager / UILogin 全部方法, 打印调用序列
function emit(ev, m) { try { send(Object.assign({ ev: ev }, m)); } catch (e) { } }
(function () {
  var il2 = Process.findModuleByName('libil2cpp.so');
  if (!il2) { emit('err', { m: 'no il2' }); return; }
  var F = function (n, r, a) { return new NativeFunction(il2.findExportByName(n), r, a); };
  var domainGet = F('il2cpp_domain_get', 'pointer', []);
  var getAssemblies = F('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']);
  var asmGetImage = F('il2cpp_assembly_get_image', 'pointer', ['pointer']);
  var imgName = F('il2cpp_image_get_name', 'pointer', ['pointer']);
  var classFromName = F('il2cpp_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']);
  var clsGetMethods = F('il2cpp_class_get_methods', 'pointer', ['pointer', 'pointer']);
  var mGetName = F('il2cpp_method_get_name', 'pointer', ['pointer']);
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var img = null;
  for (var i = 0; i < n; i++) { var im = asmGetImage(asms.add(i * 8).readPointer()); var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString(); if (nm.indexOf('Assembly-CSharp.dll') >= 0) { img = im; break; } }
  var skip = /^(get_|set_|\.ctor$)/;
  var hooked = 0;
  [['', 'UIHotUpdate'], ['', 'UIHotUpdateWrap'], ['', 'UIGameStart'], ['THD', 'VideoManager'], ['', 'UILogin'], ['', 'UIReCheckHotUpdate'],
   ['', 'LuaFramework.LuaABLoader'], ['', 'LuaFramework.LuaFightABLoader'], ['', 'Fight.FightManger']].forEach(function (t) {
    var nsP = Memory.allocUtf8String(t[0]), clP = Memory.allocUtf8String(t[1].indexOf('.') >= 0 ? t[1].split('.')[1] : t[1]);
    var ns2 = t[1].indexOf('.') >= 0 ? t[1].split('.')[0] : t[0];
    var nsQ = Memory.allocUtf8String(ns2);
    var kl = classFromName(img, nsQ, clP);
    if (kl.isNull()) { emit('miss', { cls: t[1] }); return; }
    var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
    while (!(m = clsGetMethods(kl, it)).isNull()) {
      var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
      if (skip.test(mn)) continue;
      var addr = m.readPointer(); if (addr.isNull()) continue;
      (function (full, fn) {
        try { Interceptor.attach(addr, { onEnter: function () { emit('call', { fn: full + '.' + fn }); } }); hooked++; } catch (e) { }
      })(t[1], mn);
    }
  });
  emit('flow2-ready', { hooked: hooked });
})();
