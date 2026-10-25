'use strict';
// 运行时 IL2CPP dump: 逐类导出 命名空间/类名/方法(含参数与返回类型/RVA)/字段(类型/偏移)
function emit(ev, m) { try { send(Object.assign({ ev: ev }, m)); } catch (e) { } }
(function () {
  var il2 = Process.findModuleByName('libil2cpp.so');
  if (!il2) { emit('dump-err', { m: 'no il2' }); return; }
  var F = function (n, r, a) { return new NativeFunction(il2.findExportByName(n), r, a); };
  var domainGet = F('il2cpp_domain_get', 'pointer', []);
  var getAssemblies = F('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']);
  var asmGetImage = F('il2cpp_assembly_get_image', 'pointer', ['pointer']);
  var imgName = F('il2cpp_image_get_name', 'pointer', ['pointer']);
  var imgClassCount = F('il2cpp_image_get_class_count', 'size_t', ['pointer']);
  var imgGetClass = F('il2cpp_image_get_class', 'pointer', ['pointer', 'size_t']);
  var clsGetName = F('il2cpp_class_get_name', 'pointer', ['pointer']);
  var clsGetNs = F('il2cpp_class_get_namespace', 'pointer', ['pointer']);
  var clsGetMethods = F('il2cpp_class_get_methods', 'pointer', ['pointer', 'pointer']);
  var clsGetFields = F('il2cpp_class_get_fields', 'pointer', ['pointer', 'pointer']);
  var clsGetParent = F('il2cpp_class_get_parent', 'pointer', ['pointer']);
  var mGetName = F('il2cpp_method_get_name', 'pointer', ['pointer']);
  var mGetParamCount = F('il2cpp_method_get_param_count', 'uint32', ['pointer']);
  var mGetParam = F('il2cpp_method_get_param', 'pointer', ['pointer', 'uint32']);
  var mGetReturn = F('il2cpp_method_get_return_type', 'pointer', ['pointer']);
  var fGetName = F('il2cpp_field_get_name', 'pointer', ['pointer']);
  var fGetType = F('il2cpp_field_get_type', 'pointer', ['pointer']);
  var fGetOffset = F('il2cpp_field_get_offset', 'uint32', ['pointer']);
  var typeGetName = F('il2cpp_type_get_name', 'pointer', ['pointer']);
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var base = il2.base;

  var d = domainGet(); if (!d || d.isNull()) { emit('dump-err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();

  function cs(p) { try { var x = p; if (!x || x.isNull()) return ''; var s = x.readCString(); return s === null ? '' : s; } catch (e) { return ''; } }
  function tn(t) { try { var p = typeGetName(t); return cs(p); } catch (e) { return '?'; } }

  var total = 0;
  for (var i = 0; i < n; i++) {
    var img = asmGetImage(asms.add(i * 8).readPointer());
    var inm = cs(imgName(img));
    if (inm.indexOf('Assembly-CSharp') < 0 && inm.indexOf('kcp2k') < 0) continue;
    var cc = imgClassCount(img);
    for (var k = 0; k < cc; k++) {
      var kl = imgGetClass(img, k); if (kl.isNull()) continue;
      var cn = cs(clsGetName(kl)), ns = cs(clsGetNs(kl));
      var par = clsGetParent(kl); var parName = '';
      if (par && !par.isNull()) { var pn = cs(clsGetName(par)), pns = cs(clsGetNs(par)); parName = (pns ? pns + '.' : '') + pn; }
      var methods = [];
      var it = Memory.alloc(8); it.writePointer(ptr(0)); var m; var mc = 0;
      while (!(m = clsGetMethods(kl, it)).isNull() && mc < 400) {
        mc++;
        var mn = cs(mGetName(m));
        var pc = mGetParamCount(m); var ps = [];
        for (var q = 0; q < pc && q < 12; q++) ps.push(tn(mGetParam(m, q)));
        var ret = tn(mGetReturn(m));
        var mp = m.readPointer();
        var rva = mp.isNull() ? '' : '0x' + (mp.sub(base)).toString(16);
        methods.push({ n: mn, p: ps, r: ret, rva: rva });
      }
      var fields = [];
      var it2 = Memory.alloc(8); it2.writePointer(ptr(0)); var ff; var fc = 0;
      while (!(ff = clsGetFields(kl, it2)).isNull() && fc < 400) {
        fc++;
        fields.push({ n: cs(fGetName(ff)), t: tn(fGetType(ff)), o: fGetOffset(ff) });
      }
      emit('cls', { img: inm, ns: ns, name: cn, parent: parName, methods: methods, fields: fields });
      total++;
    }
  }
  emit('dump-done', { classes: total });
})();
