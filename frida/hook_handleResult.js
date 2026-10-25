'use strict';
// hook THD.WebCommunicationHelper.HandleResult(byte[], bool, UploadDataCompletedData): 看输入与解析结果
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
  function dumpArray(p) {
    // Il2CppArray: bounds@0x10, max_length@0x18 (uintptr), data@0x20
    try {
      var len = p.add(0x18).readU32();
      if (len < 0 || len > 65536) return null;
      var data = p.add(0x20);
      var s = '';
      for (var i = 0; i < Math.min(len, 160); i++) s += ('0' + data.add(i).readU8().toString(16)).slice(-2) + ' ';
      return { len: len, hex: s };
    } catch (e) { return null; }
  }
  var nsP = Memory.allocUtf8String('THD'), clP = Memory.allocUtf8String('WebCommunicationHelper');
  var kl = classFromName(img, nsP, clP);
  if (kl.isNull()) { emit('err', { m: 'no WebCommunicationHelper' }); return; }
  var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
  while (!(m = clsGetMethods(kl, it)).isNull()) {
    var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
    if (mn !== 'HandleResult') continue;
    Interceptor.attach(m.readPointer(), {
      onEnter: function (a) { this.arr = a[1]; this.udd = a[3]; },
      onLeave: function () {
        var du = dumpArray(this.arr);
        var err = null, code = null;
        try { err = this.udd.add(0x14).readS32(); code = this.udd.add(0x18).readS32(); } catch (e) { }
        emit('hr', { inLen: du && du.len, inHex: du && du.hex, error: err, errorCode: code, udd: this.udd.toString() });
      }
    });
    emit('hr-hooked', { addr: String(m.readPointer()) });
  }
})();
