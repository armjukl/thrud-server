'use strict';
// 读 THD.GlobalConfig 的静态字段值 + UIHotUpdate 静态/实例相关
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
  var classGetFieldFromName = F('il2cpp_class_get_field_from_name', 'pointer', ['pointer', 'pointer']);
  var fieldGetOffset = F('il2cpp_field_get_offset', 'uint32', ['pointer']);
  var classGetStaticFieldData = F('il2cpp_class_get_static_field_data', 'pointer', ['pointer']);
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var img = null;
  for (var i = 0; i < n; i++) { var im = asmGetImage(asms.add(i * 8).readPointer()); var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString(); if (nm.indexOf('Assembly-CSharp.dll') >= 0) { img = im; break; } }

  function csStr(p) {
    if (!p || p.isNull()) return null;
    try { var len = p.add(16).readS32(); if (len < 0 || len > 2000) return null; var ch = p.add(20); var s = ''; for (var k = 0; k < len; k++) s += String.fromCharCode(ch.add(k * 2).readU16()); return s; } catch (e) { return null; }
  }
  function readStatic(cls, ns, name, fields) {
    var nsP = Memory.allocUtf8String(ns), clP = Memory.allocUtf8String(name);
    var kl = classFromName(img, nsP, clP);
    if (kl.isNull()) return { miss: true };
    var base = classGetStaticFieldData(kl);
    var out = {};
    fields.forEach(function (fn) {
      var fp = Memory.allocUtf8String(fn);
      var f = classGetFieldFromName(kl, fp);
      if (f.isNull()) { out[fn] = 'n/f'; return; }
      var off = fieldGetOffset(f);
      try {
        var val = base.add(off).readPointer();
        var s = csStr(val);
        out[fn] = s !== null ? ('str:' + s) : ('ptr:' + val.toString());
      } catch (e) { out[fn] = 'err'; }
    });
    return out;
  }
  var gc = readStatic('THD', 'GlobalConfig', ['apiDomain', 'apiSkipPrefix', 'osType', 'buildVersion', 'appVersion', 'sdkType', 'channelId', 'resVersion', 'debugServerId']);
  emit('global-config', { gc: gc });
})();
