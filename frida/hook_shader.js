'use strict';
// 查紫色方框来源: Shader.Find 是否找不到 + UI 文本材质用的 shader
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
  var methodFromName = F('il2cpp_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
  var runtimeInvoke = F('il2cpp_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
  var objectGetClass = F('il2cpp_object_get_class', 'pointer', ['pointer']);
  var classGetName = F('il2cpp_class_get_name', 'pointer', ['pointer']);
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var imgs = {};
  for (var i = 0; i < n; i++) { var im = asmGetImage(asms.add(i * 8).readPointer()); var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString(); imgs[nm] = im; }
  function cs(p) { try { if (!p || p.isNull()) return null; var len = p.add(16).readS32(); if (len < 0 || len > 500) return null; var s = ''; for (var k = 0; k < len; k++) s += String.fromCharCode(p.add(20 + k * 2).readU16()); return s; } catch (e) { return null; } }
  function invokeStr(obj, name) {
    try { var c = objectGetClass(obj); var mp = Memory.allocUtf8String(name); var mm = methodFromName(c, mp, 0); if (mm.isNull()) return null; var ex = Memory.alloc(8); ex.writePointer(ptr(0)); return cs(runtimeInvoke(mm, obj, ptr(0), ex)); } catch (e) { return null; }
  }
  function clsOf(p) { try { var c = objectGetClass(p); if (!c || c.isNull()) return null; var nm = classGetName(c); return nm.isNull() ? null : nm.readCString(); } catch (e) { return null; } }

  // Shader.Find(string)
  var core = imgs['UnityEngine.CoreModule.dll'] || imgs['UnityEngine.dll'];
  if (core) {
    var kl = classFromName(core, Memory.allocUtf8String('UnityEngine'), Memory.allocUtf8String('Shader'));
    if (!kl.isNull()) {
      var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
      while (!(m = clsGetMethods(kl, it)).isNull()) {
        var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
        if (mn === 'Find') {
          (function (addr) {
            try { Interceptor.attach(addr, { onEnter: function (a) { this.n = cs(a[0]); }, onLeave: function (r) { emit('shader-find', { name: this.n, found: r.isNull() ? false : true }); } }); emit('sf-hooked', {}); } catch (e) { }
          })(m.readPointer());
        }
      }
    }
  }
  // Graphic.get_material
  var ui = imgs['UnityEngine.UI.dll'];
  if (ui) {
    var kl2 = classFromName(ui, Memory.allocUtf8String('UnityEngine.UI'), Memory.allocUtf8String('Graphic'));
    if (!kl2.isNull()) {
      var it2 = Memory.alloc(8); it2.writePointer(ptr(0)); var m2;
      while (!(m2 = clsGetMethods(kl2, it2)).isNull()) {
        var mn2 = mGetName(m2); mn2 = mn2.isNull() ? '' : mn2.readCString();
        if (mn2 === 'get_material') {
          (function (addr) {
            try {
              Interceptor.attach(addr, { onLeave: function (r) {
                try { var sh = invokeStr(r, 'get_shader'); var matName = invokeStr(r, 'get_name'); var shName = sh; emit('graphic-mat', { mat: matName, shader: shName, shNull: sh === null }); } catch (e) { }
              } });
              emit('gm-hooked', {});
            } catch (e) { }
          })(m2.readPointer());
        }
      }
    }
  }
  emit('shader-ready', {});
})();
