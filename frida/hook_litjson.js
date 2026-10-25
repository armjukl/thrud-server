'use strict';
// hook LitJson: 看客户端从响应里读了哪些键 (JsonData.get_Item / ContainsKey / JsonMapper.ToObject)
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
  for (var i = 0; i < n; i++) { var im = asmGetImage(asms.add(i * 8).readPointer()); var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString(); if (nm.indexOf('firstpass') >= 0) { img = im; break; } }
  if (!img) { emit('err', { m: 'no firstpass' }); return; }

  var seen = {};
  function safeStr(p) {
    if (!p || p.isNull()) return null;
    var r = Process.findRangeByAddress(p); if (!r || r.protection.indexOf('r') < 0) return null;
    try {
      var len = p.add(16).readS32();
      if (len < 0 || len > 200) return null;
      var chars = p.add(20); if (!Process.findRangeByAddress(chars)) return null;
      var s = ''; for (var k = 0; k < len; k++) { var c = chars.add(k * 2).readU16(); if (c < 9 || (c > 13 && c < 32) || c > 126) return null; s += String.fromCharCode(c); }
      return s;
    } catch (e) { return null; }
  }

  var targets = [['LitJson', 'JsonData', ['get_Item', 'ContainsKey', 'get_Keys']], ['LitJson', 'JsonMapper', ['ToObject']]];
  var hooked = 0;
  targets.forEach(function (t) {
    var nsP = Memory.allocUtf8String(t[0]), clP = Memory.allocUtf8String(t[1]);
    var kl = classFromName(img, nsP, clP);
    if (kl.isNull()) { emit('miss', { cls: t[0] + '.' + t[1] }); return; }
    var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
    while (!(m = clsGetMethods(kl, it)).isNull()) {
      var mn = mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
      if (t[2].indexOf(mn) < 0) continue;
      var addr = m.readPointer(); if (addr.isNull()) continue;
      (function (full, fn) {
        try {
          Interceptor.attach(addr, {
            onEnter: function (a) {
              var s = safeStr(a[1]);
              if (s) { var k = full + '.' + fn + ':' + s; if (!seen[k]) { seen[k] = 1; emit('key', { where: full + '.' + fn, key: s }); } }
            }
          });
          hooked++; emit('hooked', { fn: full + '.' + fn, addr: String(addr) });
        } catch (e) { emit('err', { fn: fn, msg: String(e) }); }
      })(t[0] + '.' + t[1], mn);
    }
  });
  emit('litjson-ready', { hooked: hooked });
})();
