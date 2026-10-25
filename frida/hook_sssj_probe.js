// 双生视界(com.bilibili.gcg2.bili) gadget 探针: 证明 gadget 脚本真的在跑, 并摸清可钩的面.
// 由 libTool.config.so 的 script 模式从外部路径加载, 改这个文件不需要重推 libTool.so.
// gadget 的 script 模式里 console.log 不落 logcat, 所以自己写文件日志.
'use strict';

var LOG = '/storage/emulated/0/Android/data/com.bilibili.gcg2.bili/files/gadget.log';
var fopen = new NativeFunction(Module.findExportByName(null, 'fopen'), 'pointer', ['pointer', 'pointer']);
var fprintf = new NativeFunction(Module.findExportByName(null, 'fprintf'), 'int', ['pointer', 'pointer', 'pointer']);
var fclose = new NativeFunction(Module.findExportByName(null, 'fclose'), 'int', ['pointer']);

function log(s) {
  var f = fopen(Memory.allocUtf8String(LOG), Memory.allocUtf8String('a'));
  if (!f.isNull()) {
    fprintf(f, Memory.allocUtf8String('%s\n'), Memory.allocUtf8String('[sssj-gadget] ' + s));
    fclose(f);
  }
}

var WATCH = ['libunity.so', 'libil2cpp.so', 'libxlua.so', 'lua', 'libtersafe2.so', 'libTool.so'];

log('pid=' + Process.id + ' arch=' + Process.arch);
Process.enumerateModules().forEach(function (m) {
  if (WATCH.some(function (n) { return m.name.toLowerCase().indexOf(n.toLowerCase()) >= 0; })) {
    log('loaded ' + m.name + ' base=' + m.base + ' size=' + m.size);
  }
});

// 记录后续再 dlopen 进来的库(Lua VM 常在进游戏时才加载)
var dlopen = Module.findExportByName(null, 'android_dlopen_ext') || Module.findExportByName(null, 'dlopen');
if (dlopen) {
  Interceptor.attach(dlopen, {
    onEnter: function (a) { this.p = a[0] ? a[0].readCString() : null; },
    onLeave: function (r) {
      if (this.p && !r.isNull()) log('dlopen ok ' + this.p);
    }
  });
  log('dlopen 监视已挂上');
}

// 出站连接: 登录/资源域名从这里过, 后面做重定向就改这里
var connect = Module.findExportByName(null, 'connect');
if (connect) {
  Interceptor.attach(connect, {
    onEnter: function (a) {
      var sa = a[1], fam = sa.readU16();
      if (fam === 2) { // AF_INET
        var port = (sa.add(2).readU8() << 8) | sa.add(3).readU8();
        var ip = sa.add(4);
        var s = ip.readU8() + '.' + ip.add(1).readU8() + '.' + ip.add(2).readU8() + '.' + ip.add(3).readU8();
        if (port === 80 || port === 443) log('connect ' + s + ':' + port);
      }
    }
  });
  log('connect 监视已挂上');
}

log('ready');
