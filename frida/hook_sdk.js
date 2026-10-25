'use strict';
// 枚举 SDK 桥接类 + hook 其关键方法
function emit(ev, m) { try { send(Object.assign({ ev: ev }, m)); } catch (e) { } }
(function () {
  if (!Java.available) { emit('sdk', { m: 'no java' }); return; }
  Java.perform(function () {
    var all = Java.enumerateLoadedClassesSync();
    var cand = all.filter(function (c) { return /thrud|SDKMgr|sdk/i.test(c) && !/^\$|android\.|java\.|kotlin|com\.google|okhttp|com\.squareup|org\./i.test(c); });
    emit('sdk-classes', { n: cand.length, list: cand.slice(0, 80) });

    function hookCls(name, methods) {
      try {
        var C = Java.use(name);
        methods.forEach(function (mn) {
          try {
            var overloads = C[mn].overloads;
            overloads.forEach(function (ov) {
              ov.implementation = function () {
                var args = [].slice.call(arguments).map(function (x) { return String(x).slice(0, 120); });
                emit('sdk-call', { cls: name, fn: mn, args: args });
                return ov.apply(this, arguments);
              };
            });
            emit('sdk-hooked', { cls: name, fn: mn });
          } catch (e) { }
        });
      } catch (e) { emit('sdk-err', { cls: name, m: String(e) }); }
    }

    // 常见桥接: 找出含 login 的类
    cand.forEach(function (name) {
      try {
        var C = Java.use(name);
        var ms = C.class.getDeclaredMethods();
        var names = ms.map(function (x) { return x.getName(); });
        var hasLogin = names.some(function (n) { return /login/i.test(n); });
        if (hasLogin) {
          emit('sdk-login-class', { cls: name, methods: names.slice(0, 60) });
          hookCls(name, names.filter(function (n) { return /login/i.test(n); }));
        }
      } catch (e) { }
    });
    emit('sdk-ready', {});
  });
})();
