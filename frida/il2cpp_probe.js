'use strict';
// 在线 IL2CPP 枚举: 借助 libil2cpp 导出的 il2cpp_* 运行时 API, 列出目标类的方法/字段.
// 输出经 send 回传, python 打印.
var il2 = Process.findModuleByName('libil2cpp.so');
if (!il2) { send({ err: 'no libil2cpp' }); }
else {
  var F = function (name, ret, args) { return new NativeFunction(il2.findExportByName(name), ret, args); };
  var domainGet = F('il2cpp_domain_get', 'pointer', []);
  var getAssemblies = F('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']);
  var asmGetImage = F('il2cpp_assembly_get_image', 'pointer', ['pointer']);
  var imgName = F('il2cpp_image_get_name', 'pointer', ['pointer']);
  var imgClassCount = F('il2cpp_image_get_class_count', 'size_t', ['pointer']);
  var imgGetClass = F('il2cpp_image_get_class', 'pointer', ['pointer', 'size_t']);
  var clsGetName = F('il2cpp_class_get_name', 'pointer', ['pointer']);
  var clsGetNs = F('il2cpp_class_get_namespace', 'pointer', ['pointer']);
  var clsGetMethods = F('il2cpp_class_get_methods', 'pointer', ['pointer', 'pointer']);
  var mGetName = F('il2cpp_method_get_name', 'pointer', ['pointer']);
  var clsGetFields = F('il2cpp_class_get_fields', 'pointer', ['pointer', 'pointer']);
  var fGetName = F('il2cpp_field_get_name', 'pointer', ['pointer']);
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);

  var domain = domainGet();
  threadAttach(domain);

  var cnt = Memory.alloc(8);
  cnt.writeU64(0);
  var asms = getAssemblies(domain, cnt);
  var n = cnt.readU64().toNumber();
  var names = [];
  for (var i = 0; i < n; i++) {
    var img = asmGetImage(asms.add(i * 8).readPointer());
    var nm = imgName(img);
    names.push(nm.isNull() ? '?' : nm.readCString());
  }
  send({ assemblies: names });

  var RE = /Skip|ClientUpdate|HotUpdate|ServerUrl|ServerList|THDNetwork|Login|Http|VersionManager|CDN|Cdn/i;
  var results = [], classCount = 0, matched = 0;
  for (var j = 0; j < n; j++) {
    var img2 = asmGetImage(asms.add(j * 8).readPointer());
    var iname = imgName(img2);
    iname = iname.isNull() ? '' : iname.readCString();
    if (iname.indexOf('Assembly-CSharp') < 0 && iname.indexOf('Thrud') < 0 && iname.indexOf('Game') < 0) continue;
    var cc = imgClassCount(img2);
    for (var k = 0; k < cc; k++) {
      classCount++;
      var kl = imgGetClass(img2, k);
      if (kl.isNull()) continue;
      var cn = clsGetName(kl); cn = cn.isNull() ? '' : cn.readCString();
      var ns = clsGetNs(kl); ns = ns.isNull() ? '' : ns.readCString();
      var full = ns ? ns + '.' + cn : cn;
      if (!RE.test(full)) continue;
      matched++;
      var methods = [];
      try {
        var it = Memory.alloc(8); it.writePointer(ptr(0));
        var m;
        while (!(m = clsGetMethods(kl, it)).isNull()) {
          var mn = mGetName(m); mn = mn.isNull() ? '?' : mn.readCString();
          var mp = m.readPointer();
          methods.push(mn + '@' + mp);
          if (methods.length > 60) break;
        }
      } catch (e) { }
      var fields = [];
      try {
        var it2 = Memory.alloc(8); it2.writePointer(ptr(0));
        var ff;
        while (!(ff = clsGetFields(kl, it2)).isNull()) {
          var fn = fGetName(ff); fn = fn.isNull() ? '?' : fn.readCString();
          fields.push(fn);
          if (fields.length > 60) break;
        }
      } catch (e) { }
      results.push({ img: iname, cls: full, methods: methods, fields: fields });
      if (matched > 120) break;
    }
    if (matched > 120) break;
  }
  send({ classCount: classCount, matched: matched, results: results });
}
