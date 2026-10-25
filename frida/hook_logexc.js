'use strict';
// hook UnityEngine.Debug.LogException: 抓出回调里抛的异常 类型/消息/堆栈
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
  var objectGetClass = F('il2cpp_object_get_class', 'pointer', ['pointer']);
  var classGetName = F('il2cpp_class_get_name', 'pointer', ['pointer']);
  var clsGetNs = F('il2cpp_class_get_namespace', 'pointer', ['pointer']);
  var methodFromName = F('il2cpp_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
  var runtimeInvoke = F('il2cpp_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var img = null;
  for (var i = 0; i < n; i++) { var im = asmGetImage(asms.add(i * 8).readPointer()); var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString(); if (nm.indexOf('CoreModule') >= 0 || nm.indexOf('UnityEngine.dll') >= 0) { img = im; break; } }
  if (!img) { emit('err', { m: 'no coremodule' }); return; }

  function cs(p) {
    if (!p || p.isNull()) return null;
    var r = Process.findRangeByAddress(p); if (!r || r.protection.indexOf('r') < 0) return null;
    try { var len = p.add(16).readS32(); if (len < 0 || len > 8000) return null; var ch = p.add(20); var s = ''; for (var k = 0; k < len; k++) s += String.fromCharCode(ch.add(k * 2).readU16()); return s; } catch (e) { return null; }
  }
  function invokeStr(obj, name) {
    try {
      var cls = objectGetClass(obj);
      var mp = Memory.allocUtf8String(name);
      var meth = methodFromName(cls, mp, 0);
      if (meth.isNull()) return null;
      var exc = Memory.alloc(8); exc.writePointer(ptr(0));
      var ret = runtimeInvoke(meth, obj, ptr(0), exc);
      return cs(ret);
    } catch (e) { return null; }
  }
  function clsFull(obj) {
    try { var c = objectGetClass(obj); if (!c || c.isNull()) return null; var a = classGetName(c); var b = clsGetNs(c); var x = a.isNull() ? '?' : a.readCString(); var y = b.isNull() ? '' : b.readCString(); return y ? y + '.' + x : x; } catch (e) { return null; }
  }

  var nsP = Memory.allocUtf8String('UnityEngine'), clP = Memory.allocUtf8String('Debug');
  var kl = classFromName(img, nsP, clP);
  if (kl.isNull()) { emit('err', { m: 'no Debug' }); return; }
  var hooked = 0;
  var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
  while (!(m = clsGetMethods(kl, it)).isNull()) {
    var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
    if (mn.indexOf('LogException') < 0 && mn.indexOf('LogError') < 0) continue;
    var addr = m.readPointer(); if (addr.isNull()) continue;
    (function (fn) {
      try {
        Interceptor.attach(addr, {
          onEnter: function (a) {
            var exc = a[0];
            emit('logexc', { fn: fn, cls: clsFull(exc), msg: invokeStr(exc, 'get_Message'), stack: invokeStr(exc, 'get_StackTrace') });
          }
        }); hooked++;
      } catch (e) { }
    })(mn);
  }
  emit('logexc-ready', { hooked: hooked });
})();
