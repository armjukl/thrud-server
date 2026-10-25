'use strict';
// 反汇编指定方法, 提取其引用的字符串常量 (ADRP+ADD), 用于推断 JSON 键/URL.
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

  var want = {
    'UIHotUpdate': ['SendApiSkipRequest', '<SendApiSkipRequest>b__87_0', 'SendResVersionUpdateRequest', 'VersionCheckFinish', 'ReTrySendApiSkipRequest'],
    'THD.GlobalConfig': ['set_ApiDomain', 'set_ApiSkipDomains', 'set_ApiSkipPrefix']
  };

  function readStrAt(p) {
    try {
      var r = Process.findRangeByAddress(p); if (!r || r.protection.indexOf('r') < 0) return null;
      var s = p.readCString();
      if (!s || s.length < 1 || s.length > 200) return null;
      var ok = true; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c < 9 || (c > 13 && c < 32) || c > 126) { ok = false; break; } }
      return ok ? s : null;
    } catch (e) { return null; }
  }

  function scanMethod(addr) {
    var refs = [];
    try {
      var cur = addr, prev = null;
      for (var step = 0; step < 800; step++) {
        var ins = Instruction.parse(cur);
        if (prev && prev.mnemonic === 'adrp' && ins.mnemonic === 'add' && prev.operands.length >= 2 && ins.operands.length >= 3) {
          var dstP = prev.operands[0].value, dstA = ins.operands[0].value;
          if (dstP === dstA && prev.operands[1].type === 'imm' && ins.operands[2].type === 'imm') {
            var page = prev.address.and(ptr('0xfffffffffffff000')).add(prev.operands[1].value).and(ptr('0xffffffffffffffff'));
            var tgt = prev.address.and(ptr('0xfffffffffffff000')).add(prev.operands[1].value).add(ins.operands[2].value);
            var s = readStrAt(tgt);
            if (s) refs.push(s);
          }
        }
        prev = ins; cur = ins.next;
        if (ins.mnemonic === 'ret' && step > 8) { }
      }
    } catch (e) { refs.push('<scan-err:' + e + '>'); }
    return refs;
  }

  var out = [];
  Object.keys(want).forEach(function (clsFull) {
    var parts = clsFull.split('.'); var ns = parts.length > 1 ? parts[0] : ''; var cn = parts[parts.length - 1];
    var nsP = Memory.allocUtf8String(ns), clP = Memory.allocUtf8String(cn);
    var kl = classFromName(img, nsP, clP);
    if (kl.isNull()) { out.push({ cls: clsFull, miss: true }); return; }
    var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
    while (!(m = clsGetMethods(kl, it)).isNull()) {
      var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
      if (want[clsFull].indexOf(mn) < 0) continue;
      var addr = m.readPointer();
      out.push({ cls: clsFull, fn: mn, refs: scanMethod(addr) });
    }
  });
  emit('disasm', { out: out });
})();
