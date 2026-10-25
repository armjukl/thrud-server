'use strict';
// 打印指定类的 方法+字段
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
  var clsGetFields = F('il2cpp_class_get_fields', 'pointer', ['pointer', 'pointer']);
  var fGetName = F('il2cpp_field_get_name', 'pointer', ['pointer']);
  var fGetType = F('il2cpp_field_get_type', 'pointer', ['pointer']);
  var typeGetName = il2.findExportByName('il2cpp_type_get_name') ? F('il2cpp_type_get_name', 'pointer', ['pointer']) : null;
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var img = null;
  for (var i = 0; i < n; i++) {
    var im = asmGetImage(asms.add(i * 8).readPointer());
    var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString();
    if (nm.indexOf('Assembly-CSharp.dll') >= 0) { img = im; break; }
  }
  var targets = [['', 'CheckResponse'], ['', 'ConfigResponse'], ['THD', 'VersionUpdateManager'],
    ['THD', 'GlobalConfig'], ['THD', 'UpdateInstance'], ['THD', 'InterfaceUpdate'], ['THD', 'UnzipResult'], ['THD', 'IUpdateInterface']];
  var res = [];
  targets.forEach(function (t) {
    var nsP = Memory.allocUtf8String(t[0]), clP = Memory.allocUtf8String(t[1]);
    var kl = classFromName(img, nsP, clP);
    if (kl.isNull()) { res.push({ cls: (t[0] ? t[0] + '.' : '') + t[1], miss: true }); return; }
    var methods = [];
    var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
    while (!(m = clsGetMethods(kl, it)).isNull()) { var mn = mGetName(m); methods.push(mn.isNull() ? '?' : mn.readCString()); }
    var fields = [];
    var it2 = Memory.alloc(8); it2.writePointer(ptr(0)); var ff;
    while (!(ff = clsGetFields(kl, it2)).isNull()) {
      var fn = fGetName(ff); fn = fn.isNull() ? '?' : fn.readCString();
      var tn = '';
      if (fGetType && typeGetName) { try { var ty = fGetType(ff); var nmp = typeGetName(ty); tn = nmp.isNull() ? '' : nmp.readCString(); } catch (e) { } }
      fields.push(fn + (tn ? ':' + tn : ''));
    }
    res.push({ cls: (t[0] ? t[0] + '.' : '') + t[1], methods: methods, fields: fields });
  });
  emit('detail', { res: res });
})();
