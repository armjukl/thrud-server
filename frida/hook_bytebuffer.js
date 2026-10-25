'use strict';
// 观察 ByteBuffer.WriteInt/WriteBytes/WriteBuffer: 看 HandleResult 往 completedList/replenishList 写了什么
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
  function hexOf(p, len) { var s = ''; try { for (var i = 0; i < Math.min(len, 48); i++) s += ('0' + p.add(i).readU8().toString(16)).slice(-2) + ' '; } catch (e) { } return s; }
  var nsP = Memory.allocUtf8String('LuaFramework'), clP = Memory.allocUtf8String('ByteBuffer');
  var kl = classFromName(img, nsP, clP);
  if (kl.isNull()) { emit('err', { m: 'no ByteBuffer' }); return; }
  var it = Memory.alloc(8); it.writePointer(ptr(0)); var m, hooked = 0;
  while (!(m = clsGetMethods(kl, it)).isNull()) {
    var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
    var addr = m.readPointer(); if (addr.isNull()) continue;
    if (mn === 'WriteInt') {
      (function () { try { Interceptor.attach(addr, { onEnter: function (a) { emit('bb', { fn: 'WriteInt', v: a[1].toInt32() }); } }); hooked++; } catch (e) { } })();
    } else if (mn === 'WriteBytes') {
      (function () { try { Interceptor.attach(addr, { onEnter: function (a) { var len = a[1].isNull() ? -1 : a[1].add(0x18).readU32(); emit('bb', { fn: 'WriteBytes', len: len, hex: a[1].isNull() ? '' : hexOf(a[1].add(0x20), len) }); } }); hooked++; } catch (e) { } })();
    } else if (mn === 'WriteBuffer') {
      (function () { try { Interceptor.attach(addr, { onEnter: function (a) { emit('bb', { fn: 'WriteBuffer', arg: a[1].toString() }); } }); hooked++; } catch (e) { } })();
    }
  }
  emit('bb-ready', { hooked: hooked });
})();
