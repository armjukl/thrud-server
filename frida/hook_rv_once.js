'use strict';
// 只记录 JsonMapper.ReadValue 顶层调用的 inst_type (最轻量)
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
  var classGetName = F('il2cpp_class_get_name', 'pointer', ['pointer']);
  var clsGetNs = F('il2cpp_class_get_namespace', 'pointer', ['pointer']);
  var classFromSystemType = F('il2cpp_class_from_system_type', 'pointer', ['pointer']);
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var img = null;
  for (var i = 0; i < n; i++) { var im = asmGetImage(asms.add(i * 8).readPointer()); var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString(); if (nm.indexOf('firstpass') >= 0) { img = im; break; } }
  function tname(tobj) {
    try { var c = classFromSystemType(tobj); if (!c || c.isNull()) return null; var a = classGetName(c); var b = clsGetNs(c); var x = a.isNull() ? '?' : a.readCString(); var y = b.isNull() ? '' : b.readCString(); return y ? y + '.' + x : x; } catch (e) { return null; }
  }
  var nsP = Memory.allocUtf8String('LitJson'), clP = Memory.allocUtf8String('JsonMapper');
  var kl = classFromName(img, nsP, clP);
  if (kl.isNull()) { emit('err', { m: 'no JsonMapper' }); return; }
  var depth = 0, emitted = 0;
  var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
  while (!(m = clsGetMethods(kl, it)).isNull()) {
    var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
    if (mn !== 'ReadValue') continue;
    var addr = m.readPointer(); if (addr.isNull()) continue;
    Interceptor.attach(addr, {
      onEnter: function (a) {
        depth++;
        if (depth === 1 && emitted < 10) { emitted++; emit('top', { n: emitted, type: tname(a[1]) }); }
      },
      onLeave: function () { if (depth > 0) depth--; }
    });
    emit('rv-hooked', {});
  }
})();
