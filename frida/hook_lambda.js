'use strict';
// hook <SendApiSkipRequest>b__87_0: 打印 arg1(整数, 成功/失败标志) 与 arg2(响应串)
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
  function csStr(p) {
    if (!p || p.isNull()) return null;
    var r = Process.findRangeByAddress(p); if (!r || r.protection.indexOf('r') < 0) return null;
    try { var len = p.add(16).readS32(); if (len < 0 || len > 4000) return null; var ch = p.add(20); var s = ''; for (var k = 0; k < len; k++) s += String.fromCharCode(ch.add(k * 2).readU16()); return s; } catch (e) { return null; }
  }
  var nsP = Memory.allocUtf8String(''), clP = Memory.allocUtf8String('UIHotUpdate');
  var kl = classFromName(img, nsP, clP);
  if (kl.isNull()) { emit('err', { m: 'no UIHotUpdate' }); return; }
  var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
  while (!(m = clsGetMethods(kl, it)).isNull()) {
    var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
    if (mn !== '<SendApiSkipRequest>b__87_0') continue;
    var addr = m.readPointer();
    Interceptor.attach(addr, {
      onEnter: function (a) {
        emit('lambda', {
          numArgs: 2,
          i1: '0x' + a[1].toUInt32().toString(16),
          i1low: a[1].and(0xffff).toInt32(),
          str2: csStr(a[2]),
          str1: csStr(a[1]),
          arg0: a[0].toString()
        });
      },
      onLeave: function (ret) { emit('lambda-ret', { ret: ret.toString() }); }
    });
    emit('lambda-hooked', { addr: String(addr) });
  }
})();
