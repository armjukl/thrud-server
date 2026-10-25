'use strict';
// 观察 WebCommunicationHelper 收发链: 看响应走到哪一步断掉
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
  function cs(p) { try { return p.isNull() ? '' : p.readCString(); } catch (e) { return ''; } }
  var WANT = ['SendMessage', 'AsyncSendMessage', 'AsyncCallbackSuccess', 'StreamToBytes', 'HandleResult',
    'GetCompleteData', 'AbortRequest', 'DisPosRequestTimer', 'Encode', 'WriteBinaryHeader'];
  var nsP = Memory.allocUtf8String('THD'), clP = Memory.allocUtf8String('WebCommunicationHelper');
  var kl = classFromName(img, nsP, clP);
  if (kl.isNull()) { emit('err', { m: 'no WebCommunicationHelper' }); return; }
  var it = Memory.alloc(8); it.writePointer(ptr(0)); var m, hooked = 0;
  while (!(m = clsGetMethods(kl, it)).isNull()) {
    var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
    if (WANT.indexOf(mn) < 0) continue;
    var addr = m.readPointer(); if (addr.isNull()) continue;
    (function (fn) {
      try { Interceptor.attach(addr, { onEnter: function () { emit('wch', { fn: fn, tid: Process.getCurrentThreadId() }); } }); hooked++; } catch (e) { }
    })(mn);
  }
  emit('wch-ready', { hooked: hooked });
})();
