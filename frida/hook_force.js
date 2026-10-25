'use strict';
// 强制推进更新流程: 抓 UIHotUpdate 实例, 之后主动 invoke 下一步方法
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
  var runtimeInvoke = F('il2cpp_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
  var methodFromName = F('il2cpp_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var img = null;
  for (var i = 0; i < n; i++) { var im = asmGetImage(asms.add(i * 8).readPointer()); var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString(); if (nm.indexOf('Assembly-CSharp.dll') >= 0) { img = im; break; } }

  var nsP = Memory.allocUtf8String(''), clP = Memory.allocUtf8String('UIHotUpdate');
  var kl = classFromName(img, nsP, clP);
  if (kl.isNull()) { emit('err', { m: 'no UIHotUpdate' }); return; }

  function invoke0(name) {
    try {
      var mp = Memory.allocUtf8String(name);
      var meth = methodFromName(kl, mp, 0);
      if (meth.isNull()) { emit('force-miss', { name: name }); return; }
      var exc = Memory.alloc(8); exc.writePointer(ptr(0));
      runtimeInvoke(meth, self, ptr(0), exc);
      var e = exc.readPointer();
      emit('force-ok', { name: name, exc: e.isNull() ? null : e.toString() });
    } catch (e) { emit('force-err', { name: name, msg: String(e) }); }
  }

  var self = null;
  var ticks = 0;
  setInterval(function () {
    ticks++;
    if (!self) return;
    if (ticks === 5) { emit('force-step', { name: 'SendResVersionUpdateRequest', t: ticks }); invoke0('SendResVersionUpdateRequest'); }
    if (ticks === 10) { emit('force-step', { name: 'VersionCheckFinish', t: ticks }); invoke0('VersionCheckFinish'); }
    if (ticks === 15) { emit('force-step', { name: 'ReStart', t: ticks }); invoke0('ReStart'); }
  }, 1000);
  var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
  while (!(m = clsGetMethods(kl, it)).isNull()) {
    var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
    if (mn === 'SendApiSkipRequest') {
      var addr = m.readPointer();
      Interceptor.attach(addr, {
        onEnter: function (a) {
          if (!self) { self = a[0]; emit('force-capture', { self: self.toString() }); }
        }
      });
      emit('force-hooked', { addr: String(addr) });
    }
  }
})();
