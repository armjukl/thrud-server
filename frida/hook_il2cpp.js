'use strict';
// 在线 IL2CPP 方法 hook. 关键: 必须等 il2cpp 运行时初始化完成 (domain != null) 才能调用,
// 否则 il2cpp_thread_attach(null) 会让进程崩溃.
function emit(ev, m) { try { send(Object.assign({ ev: ev }, m)); } catch (e) { } }

var done = false, F = null, initHooked = false;
function installIl2() {
  if (done) return true;
  var il2 = Process.findModuleByName('libil2cpp.so');
  if (!il2) return false;
  if (!F) {
    try {
      F = {
        domainGet: new NativeFunction(il2.findExportByName('il2cpp_domain_get'), 'pointer', []),
        getAssemblies: new NativeFunction(il2.findExportByName('il2cpp_domain_get_assemblies'), 'pointer', ['pointer', 'pointer']),
        asmGetImage: new NativeFunction(il2.findExportByName('il2cpp_assembly_get_image'), 'pointer', ['pointer']),
        imgName: new NativeFunction(il2.findExportByName('il2cpp_image_get_name'), 'pointer', ['pointer']),
        classFromName: new NativeFunction(il2.findExportByName('il2cpp_class_from_name'), 'pointer', ['pointer', 'pointer', 'pointer']),
        clsGetMethods: new NativeFunction(il2.findExportByName('il2cpp_class_get_methods'), 'pointer', ['pointer', 'pointer']),
        mGetName: new NativeFunction(il2.findExportByName('il2cpp_method_get_name'), 'pointer', ['pointer']),
        threadAttach: new NativeFunction(il2.findExportByName('il2cpp_thread_attach'), 'pointer', ['pointer']),
        classGetName: new NativeFunction(il2.findExportByName('il2cpp_class_get_name'), 'pointer', ['pointer']),
        objectGetClass: il2.findExportByName('il2cpp_object_get_class') ? new NativeFunction(il2.findExportByName('il2cpp_object_get_class'), 'pointer', ['pointer']) : null,
        classGetFieldFromName: new NativeFunction(il2.findExportByName('il2cpp_class_get_field_from_name'), 'pointer', ['pointer', 'pointer']),
        fieldGetOffset: new NativeFunction(il2.findExportByName('il2cpp_field_get_offset'), 'uint32', ['pointer']),
        runtimeInvoke: new NativeFunction(il2.findExportByName('il2cpp_runtime_invoke'), 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']),
        methodFromName: new NativeFunction(il2.findExportByName('il2cpp_class_get_method_from_name'), 'pointer', ['pointer', 'pointer', 'int'])
      };
    } catch (e) { emit('il2-err', { where: 'nativefunc', msg: String(e) }); return false; }
  }
  var domain;
  try { domain = F.domainGet(); } catch (e) { return false; }
  if (!domain || domain.isNull()) return false; // 运行时还没起来
  done = true;
  try {
    F.threadAttach(domain);
    var cnt = Memory.alloc(8); cnt.writeU64(0);
    var asms = F.getAssemblies(domain, cnt); var n = cnt.readU64().toNumber();
    var images = {};
    for (var i = 0; i < n; i++) {
      var img = F.asmGetImage(asms.add(i * 8).readPointer());
      var nm = F.imgName(img); images[nm.isNull() ? '' : nm.readCString()] = img;
    }
    var img = images['Assembly-CSharp.dll'];
    emit('il2-images', { count: Object.keys(images).length, asmcs: !!img });
    if (!img) return true;

    var safeStr = function (p) {
      if (!p || p.isNull()) return null;
      var r = Process.findRangeByAddress(p);
      if (!r || r.protection.indexOf('r') < 0) return null;
      try {
        var len = p.add(16).readS32();
        if (len < 0 || len > 4000) return null;
        var chars = p.add(20);
        if (!Process.findRangeByAddress(chars)) return null;
        var s = '';
        for (var k = 0; k < Math.min(len, 400); k++) s += String.fromCharCode(chars.add(k * 2).readU16());
        return s;
      } catch (e) { return null; }
    };

    var clsNameOf = function (p) {
      if (!p || p.isNull() || !F.objectGetClass) return null;
      var r = Process.findRangeByAddress(p);
      if (!r || r.protection.indexOf('r') < 0) return null;
      try {
        var c = F.objectGetClass(p);
        if (!c || c.isNull()) return null;
        var nm = F.classGetName(c);
        return nm.isNull() ? null : nm.readCString();
      } catch (e) { return null; }
    };

    var TARGETS = [
      ['', 'UIHotUpdate', ['SendApiSkipRequest', 'SendResVersionUpdateRequest', 'VersionCheckFinish',
        'GetCDNFilesCallBack', 'ReTrySendApiSkipRequest', 'ReTrySendResVersionUpdateRequest', 'ForceUpdate',
        '<SendApiSkipRequest>b__87_0']],
      ['', 'UIHotUpdateWrap', ['SendApiSkipRequest']],
      ['THD', 'HttpClientPost', ['SendHttp', 'HandleResult', 'HandleOtherThreadQueue', 'UploadDataCompletedEventHandler']],
      ['THD', 'THDNetwork', ['ConnectKcpChannel', 'ConnectMainChannel', 'SendMessage', '_OnReceiveCMsg']],
      ['THD', 'THDNetworkUtil', ['_InitMsgHeaderRule']],
      ['THD', 'GlobalConfig', ['set_ApiDomain', 'set_ApiSkipDomains', 'set_ApiSkipPrefix', 'set_ResVersion',
        'set_AppVersion', 'set_BuildVersion', 'set_ChannelId', 'set_OsType', 'set_SdkType']],
      ['THD', 'VersionUpdateManager', ['Init', 'Start', 'CheckVersion', 'VersionUpdateSuccess', 'OnInitialize', 'CheckExtractResource', 'Awake']]
    ];

    var uiKl = null, forced = false;
    function forceNext(klass, obj, name) {
      try {
        var mp = Memory.allocUtf8String(name);
        var meth = F.methodFromName(klass, mp, 0);
        if (meth.isNull()) { emit('force-miss', { name: name }); return; }
        var exc = Memory.alloc(8); exc.writePointer(ptr(0));
        F.runtimeInvoke(meth, obj, ptr(0), exc);
        var e = exc.readPointer();
        emit('force-ok', { name: name, exc: e.isNull() ? null : e.toString() });
      } catch (e) { emit('force-err', { msg: String(e) }); }
    }

    var hooked = 0;
    TARGETS.forEach(function (t) {
      var ns = t[0], cls = t[1], wants = t[2];
      var nsP = Memory.allocUtf8String(ns), clP = Memory.allocUtf8String(cls);
      var kl = F.classFromName(img, nsP, clP);
      if (kl.isNull()) { emit('il2-miss', { cls: (ns ? ns + '.' : '') + cls }); return; }
      if (cls === 'UIHotUpdate') uiKl = kl;
      var it = Memory.alloc(8); it.writePointer(ptr(0)); var m;
      while (!(m = F.clsGetMethods(kl, it)).isNull()) {
        var mn = F.mGetName(m); mn = mn.isNull() ? '' : mn.readCString();
        if (wants.indexOf(mn) < 0) continue;
        var addr = m.readPointer();
        if (addr.isNull()) continue;
        (function (full, fn, klass, addr) {
          try {
            Interceptor.attach(addr, {
              onEnter: function (args) {
                emit('il2', { cls: full, fn: fn, a1: safeStr(args[1]), a2: safeStr(args[2]), a3: safeStr(args[3]),
                  c1: clsNameOf(args[1]), c2: clsNameOf(args[2]), c3: clsNameOf(args[3]) });
                if (full === 'UIHotUpdate' && fn === 'SendApiSkipRequest' && !forced) {
                  forced = true;
                  var self = args[0];
                  setTimeout(function () {
                    emit('force-try', {});
                    forceNext(klass, self, 'SendResVersionUpdateRequest');
                  }, 2500);
                }
              }
            });
            hooked++;
            emit('il2-hook', { cls: full, fn: fn, addr: String(addr) });
          } catch (e) { emit('il2-err', { fn: fn, msg: String(e) }); }
        })((ns ? ns + '.' : '') + cls, mn, kl, addr);
      }
    });
    emit('il2-ready', { hooked: hooked });
  } catch (e) { emit('il2-err', { where: 'install', msg: String(e) }); }
  return true;
}

// 只在 il2cpp 运行时初始化完成后(il2cpp_init 返回)才挂载, 避免早期调用导致崩溃
function ensureInitHook() {
  if (initHooked) return true;
  var il2 = Process.findModuleByName('libil2cpp.so');
  if (!il2) return false;
  var ok = false;
  ['il2cpp_init', 'il2cpp_init_utf16'].forEach(function (n) {
    var p = null; try { p = il2.findExportByName(n); } catch (e) { }
    if (!p) return;
    try {
      Interceptor.attach(p, {
        onLeave: function () {
          emit('il2-init', { fn: n });
          setTimeout(function () { installIl2(); }, 800);
        }
      });
      ok = true;
    } catch (e) { }
  });
  if (ok) { initHooked = true; emit('il2-init-hooked', {}); }
  return ok;
}

// 优先直接装(两种场景: attach 时运行时已就绪); 否则挂 il2cpp_init 等就绪. 不在早期盲调 il2cpp.
installIl2();
ensureInitHook();
var hb = 0;
setInterval(function () { hb++; emit('il2-hb', { n: hb, done: done, initHooked: initHooked, hasMod: !!Process.findModuleByName('libil2cpp.so') }); }, 3000);
if (typeof Process.attachModuleObserver === 'function') {
  Process.attachModuleObserver({ onAdded: function (m) { if (m.name === 'libil2cpp.so') ensureInitHook(); } });
}
