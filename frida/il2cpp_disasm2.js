'use strict';
// 反汇编方法: 解析 adrp+ldr 加载的全局指针, 读出其指向的字符串/对象, 以及 adrp+add 的字符串.
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

  function readStr(p) {
    if (!p || p.isNull()) return null;
    var r = Process.findRangeByAddress(p); if (!r || r.protection.indexOf('r') < 0) return null;
    // 先当 C 字符串
    try {
      var cs = p.readCString(); if (cs && cs.length >= 1 && cs.length < 300) {
        var ok = true; for (var i = 0; i < cs.length; i++) { var c = cs.charCodeAt(i); if (c < 9 || (c > 13 && c < 32) || c > 126) { ok = false; break; } }
        if (ok) return cs;
      }
    } catch (e) { }
    // 再当 Il2CppString (len@16, chars@20)
    try {
      var len = p.add(16).readS32();
      if (len > 0 && len < 300 && Process.findRangeByAddress(p.add(20))) {
        var s = '';
        for (var k = 0; k < len; k++) s += String.fromCharCode(p.add(20 + k * 2).readU16());
        return s;
      }
    } catch (e) { }
    return null;
  }

  function scan(addr) {
    var refs = [], regs = {}, cur = addr;
    try {
      for (var step = 0; step < 500; step++) {
        var ins = Instruction.parse(cur);
        var ops = ins.operands || [];
        if (ins.mnemonic === 'adrp' && ops.length >= 2 && ops[0].type === 'reg') {
          regs[ops[0].value] = ptr(ops[1].value);
        } else if (ins.mnemonic === 'ldr' && ops.length >= 2 && ops[0].type === 'reg' && ops[1].type === 'mem') {
          var base = ops[1].value.base;
          var disp = ops[1].value.disp;
          if (base && regs[base]) {
            var ga = regs[base].add(disp);
            try { var p = ga.readPointer(); var s = readStr(p); if (s) refs.push(s); } catch (e) { }
          }
        } else if (ins.mnemonic === 'add' && ops.length >= 3 && ops[0].type === 'reg' && regs[ops[0].value] && ops[2].type === 'imm') {
          var t = regs[ops[0].value].add(ops[2].value);
          var s2 = readStr(t); if (s2) refs.push(s2);
        }
        cur = ins.next;
      }
    } catch (e) { }
    return refs;
  }

  var want = { 'UIHotUpdate': ['SendApiSkipRequest', '<SendApiSkipRequest>b__87_0', 'SendResVersionUpdateRequest', 'VersionCheckFinish'] };
  var out = [];
  Object.keys(want).forEach(function (clsFull) {
    var nsP = Memory.allocUtf8String(''), clP = Memory.allocUtf8String(clsFull);
    var kl = classFromName(img, nsP, clP);
    if (kl.isNull()) { out.push({ cls: clsFull, miss: true }); return; }
    var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
    while (!(m = clsGetMethods(kl, it)).isNull()) {
      var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
      if (want[clsFull].indexOf(mn) < 0) continue;
      out.push({ cls: clsFull, fn: mn, refs: scan(m.readPointer()) });
    }
  });
  emit('disasm', { out: out });
})();
