'use strict';
// 在 skipAPI 回调(主线程)里, 找到 UIHotUpdate 实例, 主动 invoke 后续方法
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
  var clsGetName = F('il2cpp_class_get_name', 'pointer', ['pointer']);
  var classGetFieldFromName = F('il2cpp_class_get_field_from_name', 'pointer', ['pointer', 'pointer']);
  var fieldGetOffset = F('il2cpp_field_get_offset', 'uint32', ['pointer']);
  var objectGetClass = F('il2cpp_object_get_class', 'pointer', ['pointer']);
  var runtimeInvoke = F('il2cpp_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
  var methodFromName = F('il2cpp_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
  var threadAttach = F('il2cpp_thread_attach', 'pointer', ['pointer']);
  var d = domainGet(); if (!d || d.isNull()) { emit('err', { m: 'no domain' }); return; }
  threadAttach(d);
  var cnt = Memory.alloc(8); cnt.writeU64(0);
  var asms = getAssemblies(d, cnt); var n = cnt.readU64().toNumber();
  var img = null;
  for (var i = 0; i < n; i++) { var im = asmGetImage(asms.add(i * 8).readPointer()); var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString(); if (nm.indexOf('Assembly-CSharp.dll') >= 0) { img = im; break; } }
  var nsP = Memory.allocUtf8String(''), clP = Memory.allocUtf8String('UIHotUpdate');
  var kl = classFromName(img, nsP, clP);
  if (kl.isNull()) { emit('err', { m: 'no UIHotUpdate' }); return; }

  function clsNameOf(p) { try { var c = objectGetClass(p); if (!c || c.isNull()) return null; var nm = clsGetName(c); return nm.isNull() ? null : nm.readCString(); } catch (e) { return null; } }
  function clsOf(p) { try { return objectGetClass(p); } catch (e) { return null; } }

  function invokeOn(targetKl, obj, name, argc) {
    try {
      var mp = Memory.allocUtf8String(name);
      var meth = methodFromName(targetKl, mp, argc);
      if (meth.isNull()) { emit('force-miss', { name: name }); return; }
      var exc = Memory.alloc(8); exc.writePointer(ptr(0));
      runtimeInvoke(meth, obj, ptr(0), exc);
      var e = exc.readPointer();
      emit('force-ok', { name: name, exc: e.isNull() ? null : e.toString() });
    } catch (e) { emit('force-err', { name: name, msg: String(e) }); }
  }

  var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
  while (!(m = clsGetMethods(kl, it)).isNull()) {
    var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
    if (mn !== '<SendApiSkipRequest>b__87_0') continue;
    Interceptor.attach(m.readPointer(), {
      onEnter: function (a) {
        var cn = clsNameOf(a[0]);
        var c = clsOf(a[0]);
        var inst = null, off = null;
        try { var fp = Memory.allocUtf8String('<>4__this'); var f = classGetFieldFromName(c, fp); if (!f.isNull()) { off = fieldGetOffset(f); inst = a[0].add(off).readPointer(); } } catch (e) { }
        emit('cb', { thisCls: cn, has4this: off !== null, inst: inst ? inst.toString() : null, instCls: inst && !inst.isNull() ? clsNameOf(inst) : null });
        this.inst = inst;
        this.arg0 = a[0];
      },
      onLeave: function () {
        var target = this.inst && !this.inst.isNull() ? this.inst : this.arg0;
        emit('cb-leave', { target: target.toString(), targetCls: clsNameOf(target) });
        // 主线程里推流程
        invokeOn(kl, target, 'SendResVersionUpdateRequest', 0);
        invokeOn(kl, target, 'VersionCheckFinish', 0);
      }
    });
    emit('cb-hooked', { addr: String(m.readPointer()) });
  }
})();
