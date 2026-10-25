'use strict';
// 诊断: hook 回调 enter/leave + 常见异常构造函数, 定位 skipAPI 回调里抛了什么
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
  var objectGetClass = F('il2cpp_object_get_class', 'pointer', ['pointer']);
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var imgs = {};
  for (var i = 0; i < n; i++) { var im = asmGetImage(asms.add(i * 8).readPointer()); var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString(); imgs[nm] = im; }

  function cs(p) { try { return p.isNull() ? null : p.readCString(); } catch (e) { return null; } }
  function clsNameOf(p) { try { var c = objectGetClass(p); if (!c || c.isNull()) return null; var nm = classGetName(c); return nm.isNull() ? null : nm.readCString(); } catch (e) { return null; } }

  // 1) 回调 enter/leave
  var imgCS = imgs['Assembly-CSharp.dll'];
  var nsP = Memory.allocUtf8String(''), clP = Memory.allocUtf8String('UIHotUpdate');
  var kl = classFromName(imgCS, nsP, clP);
  var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
  while (!(m = clsGetMethods(kl, it)).isNull()) {
    var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
    if (mn !== '<SendApiSkipRequest>b__87_0') continue;
    Interceptor.attach(m.readPointer(), {
      onEnter: function () { emit('cb', { e: 'enter', tid: Process.getCurrentThreadId() }); },
      onLeave: function () { emit('cb', { e: 'leave', tid: Process.getCurrentThreadId() }); }
    });
    emit('cb-hooked', {});
  }

  // 2) 异常构造函数
  var EXC = [['System', 'Exception'], ['System', 'NullReferenceException'], ['System', 'ArgumentException'],
    ['System', 'InvalidCastException'], ['System.Exception', ''], ['LitJson', 'JsonException'],
    ['System.Collections.Generic', 'KeyNotFoundException'], ['System', 'FormatException'], ['System', 'IndexOutOfRangeException']];
  var hooked = 0;
  [['mscorlib.dll', 'System', 'Exception'], ['mscorlib.dll', 'System', 'NullReferenceException'],
    ['mscorlib.dll', 'System', 'ArgumentException'], ['mscorlib.dll', 'System', 'InvalidCastException'],
    ['mscorlib.dll', 'System', 'FormatException'], ['mscorlib.dll', 'System', 'IndexOutOfRangeException'],
    ['mscorlib.dll', 'System.Collections.Generic', 'KeyNotFoundException'],
    ['Assembly-CSharp-firstpass.dll', 'LitJson', 'JsonException']].forEach(function (t) {
    var img = imgs[t[0]]; if (!img) return;
    var a = Memory.allocUtf8String(t[1]), b = Memory.allocUtf8String(t[2]);
    var k2 = classFromName(img, a, b);
    if (k2.isNull()) return;
    var it2 = Memory.alloc(8); it2.writePointer(ptr(0)); var mm;
    while (!(mm = clsGetMethods(k2, it2)).isNull()) {
      var nmn = mGetName(mm); nmn = nmn.isNull() ? '' : nmn.readCString();
      if (nmn !== '.ctor') continue;
      (function (full) {
        try {
          Interceptor.attach(mm.readPointer(), { onEnter: function (a2) { emit('exc', { type: full, msg: cs(a2[1]), argCount: 0 }); } });
          hooked++;
        } catch (e) { }
      })(t[1] + '.' + t[2]);
    }
  });
  emit('exc-ready', { hooked: hooked });
})();
