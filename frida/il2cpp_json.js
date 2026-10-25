'use strict';
function emit(ev, m) { try { send(Object.assign({ ev: ev }, m)); } catch (e) { } }
(function () {
  var il2 = Process.findModuleByName('libil2cpp.so');
  if (!il2) { emit('err', { m: 'no il2' }); return; }
  var F = function (n, r, a) { return new NativeFunction(il2.findExportByName(n), r, a); };
  var domainGet = F('il2cpp_domain_get', 'pointer', []);
  var getAssemblies = F('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']);
  var asmGetImage = F('il2cpp_assembly_get_image', 'pointer', ['pointer']);
  var imgName = F('il2cpp_image_get_name', 'pointer', ['pointer']);
  var imgClassCount = F('il2cpp_image_get_class_count', 'size_t', ['pointer']);
  var imgGetClass = F('il2cpp_image_get_class', 'pointer', ['pointer', 'size_t']);
  var clsGetName = F('il2cpp_class_get_name', 'pointer', ['pointer']);
  var clsGetNs = F('il2cpp_class_get_namespace', 'pointer', ['pointer']);
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var RE = /json|Json|JSON|mini|Mini|LitJson|Newtonsoft|SimpleJSON|Litjson/;
  var out = [];
  for (var i = 0; i < n; i++) {
    var img = asmGetImage(asms.add(i * 8).readPointer());
    var inm = imgName(img); inm = inm.isNull() ? '' : inm.readCString();
    var cc = imgClassCount(img);
    for (var k = 0; k < cc; k++) {
      var kl = imgGetClass(img, k); if (kl.isNull()) continue;
      var cn = clsGetName(kl); cn = cn.isNull() ? '' : cn.readCString();
      var ns = clsGetNs(kl); ns = ns.isNull() ? '' : ns.readCString();
      var full = ns ? ns + '.' + cn : cn;
      if (RE.test(full)) out.push(inm + ' | ' + full);
    }
  }
  emit('jsoncls', { count: out.length, list: out });
})();
