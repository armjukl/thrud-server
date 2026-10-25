'use strict';
// 合并: (1) getaddrinfo 把死域名重定向到隧道 IP; (2) 绕过 Java 侧 TLS 证书校验.
// 用于让客户端连上我们的 HTTPS 假服并把明文请求打过来.
var REDIR = '23.147.232.29';
var MATCH = /bili-api-thrud\.bilibiligame\.net$|armorgirls[a-z0-9-]*\.bilibiligame\.net$|thrud[a-z0-9-]*\.accessgames\.com$/i;

var seenHosts = {}, rewritten = {}, installed = false, redirStr = null, lastHost = {};

function emit(ev, meta) { try { send(Object.assign({ ev: ev }, meta)); } catch (e) { } }
function fmtSa(sa) {
  try {
    var fam = sa.readU16();
    if (fam === 2) { var port = (sa.add(2).readU8() << 8) | sa.add(3).readU8(); return sa.add(4).readU8() + '.' + sa.add(5).readU8() + '.' + sa.add(6).readU8() + '.' + sa.add(7).readU8() + ':' + port; }
    if (fam === 10) { var b = []; for (var i = 0; i < 16; i++) b.push(('0' + sa.add(8 + i).readU8().toString(16)).slice(-2)); return '[' + b.join('') + ']:' + ((sa.add(2).readU8() << 8) | sa.add(3).readU8()); }
    return 'fam' + fam;
  } catch (e) { return '?'; }
}

function installRedirect() {
  var libc = Process.findModuleByName('libc.so');
  if (!libc) return false;
  redirStr = Memory.allocUtf8String(REDIR);
  var gai = libc.findExportByName('getaddrinfo');
  if (gai) Interceptor.attach(gai, {
    onEnter: function (a) {
      var host = null; try { host = a[0].readCString(); } catch (e) { }
      if (!host) return;
      seenHosts[host] = (seenHosts[host] || 0) + 1;
      lastHost[Process.getCurrentThreadId()] = host;
      if (MATCH.test(host)) { a[0] = redirStr; rewritten[host] = (rewritten[host] || 0) + 1; }
    }
  });
  var conn = libc.findExportByName('connect');
  if (conn) Interceptor.attach(conn, {
    onEnter: function (a) { this.dst = fmtSa(a[1]); this.host = lastHost[Process.getCurrentThreadId()] || ''; },
    onLeave: function (ret) { if (this.dst && this.dst.indexOf('147.232.29') >= 0) emit('connect', { host: this.host, dst: this.dst, rc: ret.toInt32() }); }
  });
  return true;
}

function installTrustAll() {
  if (!Java.available) { emit('trust', { java: false }); return; }
  Java.perform(function () {
    try {
      var X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');
      var TrustAll = Java.registerClass({
        name: 'com.sld.offline.TrustAll',
        implements: [X509TrustManager],
        methods: {
          checkClientTrusted: function (chain, authType) { },
          checkServerTrusted: function (chain, authType) { },
          getAcceptedIssuers: function () { return []; }
        }
      });
      var SSLContext = Java.use('javax.net.ssl.SSLContext');
      var init = SSLContext.init.overload('[Ljavax.net.ssl.KeyManager;', '[Ljavax.net.ssl.TrustManager;', 'java.security.SecureRandom');
      init.implementation = function (km, tm, sr) {
        return init.call(this, km, [TrustAll.$new()], sr);
      };
      emit('trust', { ctx: true });
    } catch (e) { emit('err', { where: 'sslcontext', msg: String(e) }); }

    try {
      var HttpsURLConnection = Java.use('javax.net.ssl.HttpsURLConnection');
      var HostnameVerifier = Java.use('javax.net.ssl.HostnameVerifier');
      var TrustAllHV = Java.registerClass({
        name: 'com.sld.offline.TrustAllHV',
        implements: [HostnameVerifier],
        methods: { verify: function (host, session) { return true; } }
      });
      HttpsURLConnection.setDefaultHostnameVerifier.implementation = function (hv) { return this.setDefaultHostnameVerifier(TrustAllHV.$new()); };
      emit('trust', { hv: true });
    } catch (e) { emit('err', { where: 'hostname', msg: String(e) }); }
  });
}

installRedirect();
installTrustAll();
setInterval(function () { emit('hosts', { data: seenHosts }); emit('rewritten', { data: rewritten }); }, 3000);
emit('combined-loaded', { redir: installed });

// ─── 追加段: 登录视频探针(冷启动安全). 上面 redirect/trust 一个字节都没动 ───────────────
// 老脚本在 gadget 里空转的原因: script 模式在进程一起来就执行, 那时 libil2cpp.so 还没映射,
// 首句 findModuleByName('libil2cpp.so') 拿到 null 就退出. 这里改成轮询等它 + domain 就绪.
// 旋钮:
//   WATCH = true  只读 PreLoadVideo 的入参并落盘, 不改任何代码页   ← 撤资源那轮看报错用这个
//   SKIP  = true  Interceptor.replace 换掉 PreLoadVideo, 手动 Invoke CSPrepareCallback ← 验证跳过用这个
//   POOL  = true  劫 liblua54.so/libtolua.so 的 load 导出, 编译前把卡池 63 个开放时间改宽
//   ZAXIS = true  同一条钩子, 改 NewLevelInstance_Xls 的 controlMode: 0(水平面) → 1(自由飞行) ← 战斗里给升降
// 落盘位置是游戏自己的外部目录(untrusted_app 读写都没问题), 因为 gadget 没有 host 端收 send().
var WATCH = false;
var SKIP = true;
var POOL = true;
var ZAXIS = true;
var POOL_LOGFLOW = false;  // true = 每次 lua*load* 调用逐个打(排查期用). 10-18 已定案, 平时关掉
var EXPECT_RVA = 0xf6fb54;   // 1.0.7 / appVersion 1426: THD.VideoManager.PreLoadVideo
var LOG_FILE = '/storage/emulated/0/Android/data/com.wth.thrud.bilibili/files/gadget.log';

(function () {
  var libc = Process.findModuleByName('libc.so');
  if (!libc) return;
  // O_WRONLY|O_CREAT|O_APPEND = 1|64|1024 = 1089, 0644. 每行都 open/write/close:
  // Criware Error 会让进程直接退, 任何缓冲都会跟着丢。
  // 注意 O_APPEND 是 1024 不是 2048(那是 O_NONBLOCK); 写成 2048 等于没 append, 每行都从 0 覆写。
  var O_WRONLY_CREAT_APPEND = 1089;
  var fOpen = new NativeFunction(libc.getExportByName('open'), 'int', ['pointer', 'int', 'int']);
  var fWrite = new NativeFunction(libc.getExportByName('write'), 'int', ['int', 'pointer', 'int']);
  var fClose = new NativeFunction(libc.getExportByName('close'), 'int', ['int']);

  function u8len(s) {           // write 的长度是字节数, 中文按 UTF-8 是 3 字节, 不能用 s.length
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  function line(msg) {
    var s = 'tid=' + Process.getCurrentThreadId() + ' ' + msg + '\n';
    try { console.log('sld ' + s.trim()); } catch (e) { }
    var fd = fOpen(Memory.allocUtf8String(LOG_FILE), O_WRONLY_CREAT_APPEND, 0x1a4);
    if (fd >= 0) { fWrite(fd, Memory.allocUtf8String(s), u8len(s)); fClose(fd); }
    emit('log', { m: msg });
  }

  function il2str(p) {          // System.String: length@+16(int32), 其后 UTF-16 字符
    try {
      if (!p || p.isNull()) return '<null>';
      var n = p.add(16).readS32();
      if (n < 0 || n > 4096) return '<bad len ' + n + '>';
      var s = '';
      for (var i = 0; i < n; i++) s += String.fromCharCode(p.add(20 + i * 2).readU16());
      return s;
    } catch (e) { return '<read err>'; }
  }

  var tries = 0;
  line('==== 脚本装载 mode=' + (SKIP ? 'SKIP' : (WATCH ? 'WATCH' : 'IDLE')) + ' ====');

  // ── 替 gadget 补发载体的「已加载」广播 ─────────────────────────────────────
  // 载体状态卡只认 payload 库自己 sendBroadcast 的那个 action(smali 里的 ACTION 常量;
  // onReceive 只比 getAction(), 且 SDK>=33 时 registerReceiver 传 0x2=RECEIVER_EXPORTED,
  // 所以跨进程能收到). gadget 不会发 → 永远走 15s 超时分支, 是个假阴性, 这里补一发.
  // 两个时间约束: 接收者只在 waiting=true 时响应(所以得赶在 15 秒内);
  // 而脚本装载时 ActivityThread 可能还没 handleBindApplication, Context 拿不到(所以要重试).
  var CARRIER = 'com.hitmargin.cve_2025_59489';
  var PREINIT_ACTION = 'com.example.example.cve_2025_59489.PREINIT_LOADED';
  var bcTimer = null, bcDone = false, bcTried = 0, bcLast = '';

  function pickContext() {        // 三个来源挨个试, 返回 [标签, Context] 或 [标签, null]
    var AT = Java.use('android.app.ActivityThread');
    var at = AT.currentActivityThread();
    if (at === null) return ['no ActivityThread', null];
    var cands = [
      ['systemContext', function () { return at.getSystemContext(); }],
      ['application', function () { return AT.currentApplication(); }],
      ['unityActivity', function () { return Java.use('com.unity3d.player.UnityPlayer').currentActivity.value; }]
    ];
    for (var i = 0; i < cands.length; i++) {
      try { var c = cands[i][1](); if (c !== null) return [cands[i][0], c]; } catch (e) { }
    }
    return ['no context', null];
  }

  function stopBc() { if (bcTimer !== null) { clearInterval(bcTimer); bcTimer = null; } }

  function sendLoaded() {
    if (bcDone) return;
    bcTried++;
    var st = 'java 不可用';
    if (Java.available) {
      try {
        Java.perform(function () {
          var r = pickContext();
          if (!r[1]) { st = r[0]; return; }
          var it = Java.use('android.content.Intent').$new(PREINIT_ACTION);
          it.setPackage(CARRIER);          // 接收者是运行时注册的, 显式定向才稳
          r[1].sendBroadcast(it);
          st = 'sent via ' + r[0];
        });
      } catch (e) { st = 'err ' + e; }
    } else bcTried = 60;
    if (st !== bcLast) { line('广播#' + bcTried + ': ' + st); bcLast = st; }
    if (st.indexOf('sent') === 0) { bcDone = true; stopBc(); }
    else if (bcTried >= 60) {            // 60*300ms = 18s, 已盖过载体 15s 窗口
      bcDone = true; stopBc();
      line('广播放弃, 最后状态: ' + st);
    }
  }

  sendLoaded();
  bcTimer = setInterval(sendLoaded, 300);

  var timer = setInterval(function () {
    tries++;
    var il2 = Process.findModuleByName('libil2cpp.so');
    if (!il2) return;
    var d = null;
    try {
      var dg = new NativeFunction(il2.findExportByName('il2cpp_domain_get'), 'pointer', []);
      d = dg();
    } catch (e) { return; }        // 导出还没就绪
    if (!d || d.isNull()) { if (tries % 30 === 0) line('等 il2cpp domain... ' + tries); return; }
    clearInterval(timer);
    boot(il2, d);
  }, 500);

  function boot(il2, d) {
    var G = function (n, r, a) { return new NativeFunction(il2.findExportByName(n), r, a); };
    var getAssemblies = G('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']);
    var asmGetImage = G('il2cpp_assembly_get_image', 'pointer', ['pointer']);
    var imgName = G('il2cpp_image_get_name', 'pointer', ['pointer']);
    var classFromName = G('il2cpp_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']);
    var methodFromName = G('il2cpp_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
    var objGetClass = G('il2cpp_object_get_class', 'pointer', ['pointer']);
    var clsGetMethods = G('il2cpp_class_get_methods', 'pointer', ['pointer', 'pointer']);
    var mGetName = G('il2cpp_method_get_name', 'pointer', ['pointer']);
    var runtimeInvoke = G('il2cpp_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
    var threadAttach = G('il2cpp_thread_attach', 'pointer', ['pointer']);
    line('il2cpp 就绪, base=' + il2.base + ' tries=' + tries);
    try { threadAttach(d); } catch (e) { line('threadAttach err ' + e); }

    var cnt = Memory.alloc(8); cnt.writeU64(0);
    var asms = getAssemblies(d, cnt);
    var n = cnt.readU64().toNumber();
    var img = null;
    for (var i = 0; i < n; i++) {
      var im = asmGetImage(asms.add(i * 8).readPointer());
      var nm = imgName(im); nm = nm.isNull() ? '' : nm.readCString();
      if (nm.indexOf('Assembly-CSharp.dll') >= 0) { img = im; break; }
    }
    if (!img) { line('没找到 Assembly-CSharp.dll'); return; }

    var kl = classFromName(img, Memory.allocUtf8String('THD'), Memory.allocUtf8String('VideoManager'));
    if (kl.isNull()) { line('没有 THD.VideoManager'); return; }
    // System.Void PreLoadVideo(System.String, System.Boolean, THD.VideoManager.CSPrepareCallback, System.Int32)
    var meth = methodFromName(kl, Memory.allocUtf8String('PreLoadVideo'), 4);
    if (meth.isNull()) { line('没有 PreLoadVideo(4 参)'); return; }
    var addr = meth.readPointer();
    var rva = addr.sub(il2.base).toInt32();
    line('PreLoadVideo addr=' + addr + ' rva=0x' + rva.toString(16) + ' (文档记 0x' + EXPECT_RVA.toString(16) + ')');

    function invokeOnce(cbObj) {
      try {
        var cls = objGetClass(cbObj);
        var it = Memory.alloc(8); it.writePointer(ptr(0));
        var m;
        while (!(m = clsGetMethods(cls, it)).isNull()) {
          var name = mGetName(m); name = name.isNull() ? '' : name.readCString();
          if (name !== 'Invoke') continue;
          try { threadAttach(d); } catch (e) { }
          var exc = Memory.alloc(8); exc.writePointer(ptr(0));
          runtimeInvoke(m, cbObj, ptr(0), exc);
          var e2 = exc.readPointer();
          line('CSPrepareCallback.Invoke 已触发 exc=' + (e2.isNull() ? 'null' : e2.toString()));
          return;
        }
        line('回调类型上没有 Invoke 方法');
      } catch (e) { line('invoke err ' + e); }
    }

    if (SKIP) {
      if (rva !== EXPECT_RVA) { line('SKIP 拒绝执行: 反射拿到的 rva 和文档记的对不上, 版本变了'); return; }
      var noop = new NativeCallback(function (self, path, loop, cbp, id) {
        line('PreLoadVideo(NOOP) path=' + il2str(path) + ' cb=' + (cbp.isNull() ? 'none' : 'yes'));
        if (!cbp.isNull()) setTimeout(function () { invokeOnce(cbp); }, 50);
      }, 'void', ['pointer', 'pointer', 'int', 'pointer', 'int']);
      Interceptor.replace(addr, noop);
      line('PreLoadVideo 已 replace');
    } else if (WATCH) {
      Interceptor.attach(addr, {
        onEnter: function (a) {
          line('PreLoadVideo path=' + il2str(a[1]) + ' loop=' + a[2].toInt32() +
            ' cb=' + (a[3].isNull() ? 'none' : 'yes') + ' id=' + a[4].toInt32());
        }
      });
      line('PreLoadVideo 已挂观测');
    }
  }

  // ── 卡池常驻(POOL) ───────────────────────────────────────────────────────
  // 卡池表 LotteryInstance_Xls(129 行)每行用 timeId 指到 CommonTime_Xls 的开放窗口,
  // 过点就判"已结束"、整个池子不显示。下面 63 个就是被卡池引用到的全部 timeId
  // (9999 是官方常驻模板、0 是不看时间、9203 没被任何池引用), 把它们的 begin/over
  // 换成 9999 那一行的原值 = 全开。
  // 手法: 在这个 chunk 交给 VM 编译前做字节级替换。不追加新 Lua(没有 lua 解释器可验语法,
  // 写错一个字符整张 CommonTime_Xls 就没了), 也不动 APK / 外部 .lua 文件。
  var POOL_IDS = [9000, 9201, 9202,
    9204, 9205, 9206, 9207, 9208, 9209, 9210, 9211, 9212, 9213, 9214, 9215, 9216, 9217, 9218, 9219,
    9220, 9221, 9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229, 9230, 9231, 9232, 9233, 9234, 9235,
    9236, 9237, 9238, 9239, 9240, 9241, 9242, 9243, 9244, 9245, 9246, 9247, 9248, 9249, 9250, 9251,
    9252, 9253, 9254, 9255, 9256, 9257, 9258, 9259, 9260, 9261, 9262, 9263];
  var POOL_B = '2020-10-10 10:00:00';      // 抄 CommonTime_Xls["9999"] 那行(官方常驻窗口)
  var POOL_O = '2029-9-27 10:00:00';
  var POOL_SIG = '---@class CommonTime_Xls : table';   // 只出现在定义处, 认它不认引用
  var POOL_KEEP = [];                       // 改写后的 buffer 必须自己留住, 否则被 frida 回收

  function toLatin1(u8) {                   // 逐字节 1 字符: 表里有 UTF-8 中文, 不能按字符串解码
    var s = '', CH = 8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return s;
  }
  function toBytes(s) {
    var a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
    return a;
  }

  // 返回 {text, hits(改成目标值的行数), same(本来就是目标值), bad(格式没认出来)}
  function poolPatchText(txt) {
    var parts = [], pos = 0, hits = 0, same = 0, bad = 0;
    for (var i = 0; i < POOL_IDS.length; i++) {
      var key = '["' + POOL_IDS[i] + '"]=setmetatable({';
      var a = txt.indexOf(key);
      if (a < 0 || txt.indexOf(key, a + 1) >= 0) { bad++; continue; }   // 找不到 / 不唯一 → 整行不动
      var b = txt.indexOf('},mt)', a);
      if (b < 0) { bad++; continue; }
      var row = txt.slice(a, b);
      var nr = row.replace(/beginTime=\{\[1\]="[^"]*"\}/, 'beginTime={[1]="' + POOL_B + '"}')
        .replace(/overTime=\{\[1\]="[^"]*"\}/, 'overTime={[1]="' + POOL_O + '"}');
      var wb = '"' + POOL_B + '"', wo = '"' + POOL_O + '"';
      if (nr.indexOf(wb) < 0 || nr.indexOf(wo) < 0) { bad++; continue; }  // 字段形状不是预期
      if (nr === row) same++; else hits++;
      parts.push(txt.slice(pos, a)); parts.push(nr); pos = b;
    }
    parts.push(txt.slice(pos));
    return { text: parts.join(''), hits: hits, same: same, bad: bad };
  }

  // ── 战斗高度轴(ZAXIS) ─────────────────────────────────────────────────────
  // NewLevelInstance_Xls 每行的 controlMode 就是玩家飞行模式(fightLua Enum_MoveControlType:
  // 0 水平面 / 1 自由飞行 / 2 轨道), 只有 ==1 才发"升降键"那一路输入(控件显隐 toLua/4f52bc70…:45-58,
  // 输入掐断 toLua/f9b4d055…:106-111)。完整链路见 docs/README-战斗移动轴与高度解锁.md §1/§3。
  // 这张表有两个版本在跑, 都得能吃: 1583 增量(1,494,415 B / 2038 行, controlMode 210 个 0 + 1394 个 1
  // + 11 个 2)和 1.0.7 包内(812,314 B / 791 处, 649 个 0 + 142 个 1, 没有 2)。
  // 没写 controlMode 的行继承 local default 里的 controlMode=0, 所以 default 那一处也必须翻 ——
  // 只翻显式的那一半等于没解锁完。2(轨道, 关卡设计里就锁深度)不动。
  // 等长替换(改一个字符, 尺寸不变), 不追加新 Lua。
  var Z_HEAD = 'local default = {id=0,stageLevel=0,';   // 两个版本的第一行都一样
  var Z_ROW0 = '["1000101"]=setmetatable({';             // 第1章第1关, 认"这是那张表"用
  var Z_KEY = 'controlMode=';

  function looksLikeNewLevel(txt) {
    return txt.indexOf(Z_HEAD) === 0 && txt.indexOf(Z_ROW0) >= 0 && txt.indexOf(Z_KEY) >= 0;
  }
  function zCount(txt) {
    var n = 0, i = txt.indexOf(Z_KEY);
    while (i >= 0) { n++; i = txt.indexOf(Z_KEY, i + Z_KEY.length); }
    return n;
  }
  // 值只可能是 0/1/2 一个字符: 0 → 1(记 hits), 1 → 不动(same), 2 → 不动(track), 其他形状 → bad(整轮不写回)
  function zaxisPatchText(txt) {
    var parts = [], pos = 0, hits = 0, same = 0, track = 0, bad = 0;
    var i = txt.indexOf(Z_KEY);
    while (i >= 0) {
      var j = i + Z_KEY.length, c = txt.charAt(j);
      if (c === '0') { parts.push(txt.slice(pos, j)); parts.push('1'); pos = j + 1; hits++; }
      else if (c === '1') same++;
      else if (c === '2') track++;
      else bad++;
      i = txt.indexOf(Z_KEY, j);
    }
    parts.push(txt.slice(pos));
    return { text: parts.join(''), hits: hits, same: same, track: track, bad: bad };
  }

  var poolTried = 0, poolDone = 0;
  var poolCalls = 0, poolLog = 0, poolSeen = {};     // 流水: 哪个导出被调了几次
  var POOL_MAXLOG = 40;                               // 前 40 次逐个打, 之后只报增量
  // 两套 VM: liblua54.so(Lua 5.4) 与 libtolua.so(LuaJIT)。第一版只挂 liblua54.so,
  // 真机跑出来一条 load 都没有 → 配置表根本不走它。两个都扫, 谁先加载好就先把谁挂上。
  var POOL_MODS = ['liblua54.so', 'libtolua.so'];
  // 参数布局决定能不能改。'buf' = (L, buff, sz, name[, mode]) → 换 buffer 是安全的;
  // 其余只让它现形(记数/记名字), 不许碰指针。
  var POOL_KIND = {
    luaL54_loadbufferx: 'buf', luaL_loadbufferx: 'buf', luaL_loadbuffer: 'buf',
    luaL54_loadstring: 'str', luaL_loadstring: 'str',
    luaL54_loadfilex: 'file', luaL_loadfilex: 'file', luaL_loadfile: 'file',
    lua54_load: 'load', lua_load: 'load', lua_loadx: 'load',
    tolua_loadbuffer: 'raw'                           // 布局未知, 只数次数
  };

  // 认内容不认 chunk 名: 安卓这边还没实测过运行时给出的 name 长什么样,
  // 而"buffer 里有多少个 POOL_IDS 的行键"是无论如何骗不了人的证据。
  function looksLikeCommonTime(txt) {
    return txt.indexOf('beginTime=') >= 0 && txt.indexOf('setmetatable(') >= 0;
  }
  function rowKeyCount(txt) {
    var n = 0;
    for (var i = 0; i < POOL_IDS.length; i++) if (txt.indexOf('["' + POOL_IDS[i] + '"]=setmetatable({') >= 0) n++;
    return n;
  }

  function armedTargets() {
    var s = [];
    if (POOL) s.push(POOL_IDS.length + ' 个 timeId 的开放时间');
    if (ZAXIS) s.push('controlMode 0→1');
    return s.join(' + ');
  }

  function noteCall(tag, sz, name) {
    poolCalls++;
    poolSeen[tag] = (poolSeen[tag] || 0) + 1;
    if (!POOL_LOGFLOW) { if (poolCalls % 2000 === 0) poolTally(); return; }
    if (poolLog < POOL_MAXLOG) {
      poolLog++;
      line('load  #' + poolCalls + ' ' + tag + ' sz=' + (sz < 0 ? '?' : sz) + ' name=' + name);
      if (poolLog === POOL_MAXLOG) line('load: 前 ' + POOL_MAXLOG + ' 次已列完, 之后只报增量');
    } else if (poolCalls % 200 === 0) poolTally();
  }
  function poolTally() {
    var s = [];
    for (var k in poolSeen) s.push(k + '=' + poolSeen[k]);
    line('load: 累计 ' + poolCalls + ' 次  ' + s.join(' ') + '  Lua 改写 ' + poolDone + ' 次');
  }

  function readStr(p) { try { return p.isNull() ? '<null>' : p.readCString(); } catch (e) { return '<读不出>'; } }

  // 换 buffer 那五行, 两个目标共用。顺序不能省: NUL 结尾 + POOL_KEEP 留住, 否则 frida 回收后游戏读到飞掉的内存。
  function swapIn(newText, oldLen, name, tag) {
    var out = toBytes(newText);
    var buf = Memory.alloc(out.length + 1);
    buf.writeByteArray(out);
    buf.add(out.length).writeU8(0);
    POOL_KEEP.push(buf);
    poolDone++;
    line(tag + ': 第 ' + poolDone + ' 次改写 (' + oldLen + 'B -> ' + out.length + 'B) ' + name);
    return { buf: buf, len: out.length };
  }

  function poolTarget(txt, name) {
    var sig = txt.indexOf(POOL_SIG) >= 0;
    var n = rowKeyCount(txt);
    if (n < 5) { line('卡池: 像时间表但不是那 63 行(行键 ' + n + ' 个, sig=' + sig + ') name=' + name); return null; }
    var r = poolPatchText(txt);
    line('卡池: 行键 ' + n + ' 命中 ' + r.hits + ' / 已是目标 ' + r.same + ' / 没认出 ' + r.bad + '  sig=' + sig + ' name=' + name);
    if (!r.hits || r.bad) { line('卡池: 不改写(要求 hits>0 且 bad=0)'); return null; }
    return swapIn(r.text, txt.length, name, '卡池');
  }

  function zTarget(txt, name) {
    var r = zaxisPatchText(txt);
    line('高度轴: ' + Z_KEY + ' 共 ' + zCount(txt) + ' 处 → 命中 ' + r.hits + ' / 本来就是 1 的 ' + r.same +
      ' / 轨道 2 不动 ' + r.track + ' / 没认出 ' + r.bad + ' name=' + name);
    if (!r.hits || r.bad) { line('高度轴: 不改写(要求 hits>0 且 bad=0)'); return null; }
    return swapIn(r.text, txt.length, name, '高度轴');
  }

  // 命中就返回新 buffer, 否则 null。不改的情况: 不是目标表 / 形状没认出来 / 已经是目标值。
  function tryPatch(txt, name) {
    if (POOL && looksLikeCommonTime(txt)) { var h = poolTarget(txt, name); if (h) return h; }
    if (ZAXIS && looksLikeNewLevel(txt)) return zTarget(txt, name);
    return null;
  }

  function onBuf(tag, a) {
    var sz = a[2].toUInt32();
    if (sz <= 0 || sz > 0x4000000) { noteCall(tag, -1, '<sz 不像长度, 参数布局不对>'); return; }
    var nm = readStr(a[3]);
    noteCall(tag, sz, nm);
    if (sz < 2048) return;                                   // 63 行的表不可能这么小, 省掉绝大多数 memcpy
    var hit = tryPatch(toLatin1(new Uint8Array(a[1].readByteArray(sz))), nm);
    if (hit) { a[1] = hit.buf; a[2] = ptr(hit.len); }
  }

  function makeEnter(tag, kind) {
    return function (a) {
      try {
        if (kind === 'buf') { onBuf(tag, a); return; }
        if (kind === 'raw') { noteCall(tag, -1, '(布局未知, 不碰指针)'); return; }
        if (kind === 'load') { noteCall(tag, -1, readStr(a[3])); return; }   // lua_load(L,reader,dt,name)
        if (kind === 'file') { noteCall(tag, -1, readStr(a[1])); return; }   // 只有路径, 内容改不了
        var s = readStr(a[1]);                                               // loadstring: 整段源码, 只截前 120 字
        noteCall(tag, s.length, s.slice(0, 120));
      } catch (e) { line('卡池 hook err ' + tag + ' ' + e); }
    };
  }

  function armMod(m) {
    var tag0 = m.name, armed = [];
    try {
      m.enumerateExports().forEach(function (x) {
        var kind = POOL_KIND[x.name];
        if (!kind) return;
        var tag = tag0 + '!' + x.name;
        Interceptor.attach(x.address, { onEnter: makeEnter(tag, kind) });
        armed.push(x.name + ':' + kind);
      });
    } catch (e) { line('枚举 ' + tag0 + ' 导出失败 ' + e); return false; }
    if (!armed.length) { line(tag0 + ' 里没有已知布局的 load 导出'); return false; }
    line('POOL 就位: ' + tag0 + ' @ ' + m.base + ' 挂了[' + armed.join(' ') + '] (盯 ' + armedTargets() + ')');
    return true;
  }

  function armPool() {
    var done = {};
    var t = setInterval(function () {
      poolTried++;
      var all = true;
      POOL_MODS.forEach(function (nm) {
        if (done[nm]) return;
        var m = Process.findModuleByName(nm);
        if (!m) { all = false; return; }
        all = false;                                   // 先记下, 下一轮再看别的
        if (armMod(m)) done[nm] = 1; else done[nm] = 2; // 2 = 挂过但没挂成, 不再重试
      });
      if (POOL_MODS.every(function (nm) { return done[nm]; })) { clearInterval(t); line('POOL: 两个模块都处理完了'); }
      else if (poolTried % 100 === 0) {
        var s = [];
        POOL_MODS.forEach(function (nm) { s.push(nm + (done[nm] ? '=已挂' : ':未加载')); });
        line('POOL 等待 ' + poolTried + ' 轮: ' + s.join(' '));
      }
    }, 300);
  }


  // armPool 挂的是"Lua 加载钩子"本身, 具体要不要改哪张表由 POOL / ZAXIS 决定; 两个都关就别挂。
  if (POOL || ZAXIS) armPool();
})();
