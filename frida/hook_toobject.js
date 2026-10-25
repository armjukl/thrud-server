'use strict';
// hook LitJson.JsonMapper.ToObject: 打印输入 JSON 与返回对象的类名
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
  var classGetNs = F('il2cpp_class_get_namespace', 'pointer', ['pointer']);
  var objectGetClass = il2.findExportByName('il2cpp_object_get_class') ? F('il2cpp_object_get_class', 'pointer', ['pointer']) : null;
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var img = null;
  for (var i = 0; i < n; i++) { var im = asmGetImage(asms.add(i * 8).readPointer()); var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString(); if (nm.indexOf('firstpass') >= 0) { img = im; break; } }
  if (!img) { emit('err', { m: 'no firstpass' }); return; }

  function csStr(p) {
    if (!p || p.isNull()) return null;
    try { var len = p.add(16).readS32(); if (len < 0 || len > 4000) return null; var ch = p.add(20); var s = ''; for (var k = 0; k < len; k++) s += String.fromCharCode(ch.add(k * 2).readU16()); return s; } catch (e) { return null; }
  }
  function clsName(p) {
    if (!p || p.isNull() || !objectGetClass) return null;
    try { var c = objectGetClass(p); if (!c || c.isNull()) return null; var nm = classGetName(c); var ns = classGetNs(c); var a = nm.isNull() ? '?' : nm.readCString(); var b = ns.isNull() ? '' : ns.readCString(); return b ? b + '.' + a : a; } catch (e) { return null; }
  }

  var nsP = Memory.allocUtf8String('LitJson'), clP = Memory.allocUtf8String('JsonMapper');
  var kl = classFromName(img, nsP, clP);
  if (kl.isNull()) { emit('err', { m: 'no JsonMapper' }); return; }
  var hooked = 0;
  var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
  while (!(m = clsGetMethods(kl, it)).isNull()) {
    var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
    if (mn !== 'ToObject') continue;
    var addr = m.readPointer(); if (addr.isNull()) continue;
    (function (fn) {
      try {
        Interceptor.attach(addr, {
          onEnter: function (a) { this.json = csStr(a[1]); },
          onLeave: function (ret) { emit('toobject', { json: this.json, retCls: clsName(ret) }); }
        });
        hooked++;
      } catch (e) { }
    })(mn);
  }
  emit('toobject-ready', { hooked: hooked });
})();
