'use strict';
// 观察 protobuf 反序列化器 0xdd74f4(ReturnPackagePush) / 0xdd5788(PushMsg2Client) 的输入与是否返回
function emit(ev, m) { try { send(Object.assign({ ev: ev }, m)); } catch (e) { } }
(function () {
  var il2 = Process.findModuleByName('libil2cpp.so');
  if (!il2) { emit('err', { m: 'no il2' }); return; }
  var base = il2.base;
  function arrLen(p) { try { return p.add(0x18).readU32(); } catch (e) { return -1; } }
  function arrData(p) { try { return p.add(0x20); } catch (e) { return p; } }
  function hexOf(p, len) { var s = ''; try { for (var i = 0; i < Math.min(len, 80); i++) s += ('0' + p.add(i).readU8().toString(16)).slice(-2) + ' '; } catch (e) { } return s; }

  function hookFn(rva, tag) {
    try {
      Interceptor.attach(base.add(rva), {
        onEnter: function (a) {
          try {
            var b = a[0];
            var len = (b.isNull() ? -1 : arrLen(b));
            emit('des-in', { tag: tag, a0: b.toString(), len: len, hex: b.isNull() ? '' : hexOf(arrData(b), len) });
          } catch (e) { emit('des-in', { tag: tag, err: String(e) }); }
        },
        onLeave: function (r) { emit('des-out', { tag: tag, ret: r.toString() }); }
      });
      emit('des-hooked', { tag: tag, addr: String(base.add(rva)) });
    } catch (e) { emit('des-err', { tag: tag, m: String(e) }); }
  }
  hookFn(0xdd74f4, 'ReturnPackagePush');
  hookFn(0xdd5788, 'PushMsg2Client');
  // 反序列化前那个 helper, 看它是不是 reader
  try {
    Interceptor.attach(base.add(0xfb1a60), {
      onEnter: function (a) { try { emit('helper-in', { a0: a[0].toString(), len: arrLen(a[0]) }); } catch (e) { } },
      onLeave: function (r) { emit('helper-out', { ret: r.toString() }); }
    });
    emit('des-hooked', { tag: 'helper', addr: String(base.add(0xfb1a60)) });
  } catch (e) { }
  emit('des-ready', {});
})();
