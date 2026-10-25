'use strict';
// 读 UIHotUpdate 实例字段状态, 看流程卡在哪
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
  var classGetFieldFromName = F('il2cpp_class_get_field_from_name', 'pointer', ['pointer', 'pointer']);
  var fieldGetOffset = F('il2cpp_field_get_offset', 'uint32', ['pointer']);
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var img = null;
  for (var i = 0; i < n; i++) { var im = asmGetImage(asms.add(i * 8).readPointer()); var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString(); if (nm.indexOf('Assembly-CSharp.dll') >= 0) { img = im; break; } }

  function fieldOff(kl, name) {
    var p = Memory.allocUtf8String(name);
    var f = classGetFieldFromName(kl, p);
    if (f.isNull()) return null;
    return fieldGetOffset(f);
  }
  function readState(kl, obj, names) {
    var o = {};
    names.forEach(function (nm) {
      var off = fieldOff(kl, nm);
      if (off === null) { o[nm] = 'n/f'; return; }
      try { o[nm] = obj.add(off).readS32(); } catch (e) { o[nm] = '?'; }
    });
    return o;
  }

  var nsP = Memory.allocUtf8String(''), clP = Memory.allocUtf8String('UIHotUpdate');
  var kl = classFromName(img, nsP, clP);
  if (kl.isNull()) { emit('err', { m: 'no UIHotUpdate' }); return; }
  var FIELDS = ['requestTryCount', 'maxRequestTryCount', 'urlDomainIndex', 'needUpdateRes', 'needUpdateApp',
    'startDownload', 'isRepairing', 'cdnIndex', 'hot_version', 'DownLoadAllBytes', 'DownLoadCurBytes'];
  emit('fields-present', { names: FIELDS.map(function (f) { return f + '=' + fieldOff(kl, f); }) });

  var self = null;
  var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
  while (!(m = clsGetMethods(kl, it)).isNull()) {
    var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
    if (mn === 'SendApiSkipRequest') {
      Interceptor.attach(m.readPointer(), { onEnter: function (a) { if (!self) self = a[0]; } });
    }
  }
  var ticks = 0;
  setInterval(function () {
    ticks++;
    if (self && ticks % 3 === 0) emit('state', { t: ticks, s: readState(kl, self, FIELDS) });
  }, 2000);
  emit('state-ready', {});
})();
