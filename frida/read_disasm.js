'use strict';
// 只读: 反汇编回调, 找 adrp+ldr 加载的 MethodInfo/类型指针 (不挂钩子)
function emit(ev, m) { try { send(Object.assign({ ev: ev }, m)); } catch (e) { } }
(function () {
  var il2 = Process.findModuleByName('libil2cpp.so');
  if (!il2) { emit('err', { m: 'no il2' }); return; }
  var base = il2.base;
  var addr = base.add(0xa58e98); // UIHotUpdate.<SendApiSkipRequest>b__87_0 rva

  function rdCStr(p) {
    try { var r = Process.findRangeByAddress(p); if (!r || r.protection.indexOf('r') < 0) return null; var s = p.readCString(); if (!s || s.length < 2 || s.length > 60) return null; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c < 32 || c > 126) return null; } return s; } catch (e) { return null; }
  }
  function tryMethodInfo(p) {
    // MethodInfo: name@+24, klass@+32
    var nm = rdCStr(p.add(24));
    if (!nm) return null;
    var klas = null;
    try { klas = p.add(32).readPointer(); } catch (e) { return null; }
    var kn = rdCStr(klas.add(0x10)); // Il2CppClass.name at +0x10
    return { method: nm, klass: kn };
  }
  function tryClass(p) {
    var kn = rdCStr(p.add(0x10)); // Il2CppClass name
    if (!kn) return null;
    return { class: kn };
  }

  var found = [], regs = {}, cur = addr;
  try {
    for (var i = 0; i < 400; i++) {
      var ins = Instruction.parse(cur);
      var ops = ins.operands || [];
      if (ins.mnemonic === 'adrp' && ops.length >= 2 && ops[0].type === 'reg') regs[ops[0].value] = ptr(ops[1].value);
      else if (ins.mnemonic === 'ldr' && ops.length >= 2 && ops[0].type === 'reg' && ops[1].type === 'mem') {
        var b = ops[1].value.base, disp = ops[1].value.disp;
        if (b && regs[b]) {
          var a = regs[b].add(disp);
          try {
            var val = a.readPointer();
            if (val && !val.isNull() && val.compare(base) >= 0 && val.compare(base.add(il2.size)) < 0) {
              var mi = tryMethodInfo(val); if (mi) found.push({ off: '0x' + (cur.sub(base)).toString(16), kind: 'method', v: mi });
              var ci = tryClass(val); if (ci && !mi) found.push({ off: '0x' + (cur.sub(base)).toString(16), kind: 'class?', v: ci });
            } else {
              var mi2 = tryMethodInfo(val); if (mi2) found.push({ off: '0x' + (cur.sub(base)).toString(16), kind: 'method(data)', v: mi2 });
            }
          } catch (e) { }
        }
      }
      cur = ins.next;
    }
  } catch (e) { emit('err', { m: String(e) }); }
  var seen = {};
  var uniq = found.filter(function (x) { var k = x.kind + JSON.stringify(x.v); if (seen[k]) return false; seen[k] = 1; return true; });
  emit('disasm-scan', { count: uniq.length, items: uniq.slice(0, 60) });
})();
