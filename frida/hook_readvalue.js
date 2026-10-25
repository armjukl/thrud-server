'use strict';
// hook LitJson.JsonMapper.ReadValue(System.Type, JsonReader): 打印 inst_type, 找响应目标类型
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
  var classFromSystemType = il2.findExportByName('il2cpp_class_from_system_type') ? F('il2cpp_class_from_system_type', 'pointer', ['pointer']) : null;
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var img = null;
  for (var i = 0; i < n; i++) { var im = asmGetImage(asms.add(i * 8).readPointer()); var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString(); if (nm.indexOf('firstpass') >= 0) { img = im; break; } }

  function tname(tobj) {
    if (!tobj || tobj.isNull() || !classFromSystemType) return null;
    try { var c = classFromSystemType(tobj); if (!c || c.isNull()) return null; var nm = classGetName(c); var ns = clsGetNs(c); var a = nm.isNull() ? '?' : nm.readCString(); var b = ns.isNull() ? '' : ns.readCString(); return b ? b + '.' + a : a; } catch (e) { return null; }
  }
  var nsP = Memory.allocUtf8String('LitJson'), clP = Memory.allocUtf8String('JsonMapper');
  var kl = classFromName(img, nsP, clP);
  if (kl.isNull()) { emit('err', { m: 'no JsonMapper' }); return; }
  var count = 0;
  var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
  while (!(m = clsGetMethods(kl, it)).isNull()) {
    var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
    if (mn !== 'ReadValue') continue;
    var addr = m.readPointer(); if (addr.isNull()) continue;
    Interceptor.attach(addr, {
      onEnter: function (a) {
        count++;
        if (count <= 40) emit('readvalue', { n: count, type: tname(a[1]) });
      }
    });
    emit('rv-hooked', { addr: String(addr) });
  }
})();
