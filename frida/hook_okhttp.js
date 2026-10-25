'use strict';
// hook Java HTTP 响应码, 判断 SDK 请求是否失败
function emit(ev, m) { try { send(Object.assign({ ev: ev }, m)); } catch (e) { } }
(function () {
  if (!Java.available) { emit('http', { m: 'no java' }); return; }
  Java.perform(function () {
    var seen = {};
    function once(k, o) { if (seen[k]) return; seen[k] = 1; emit('http', o); }
    try {
      var Response = Java.use('okhttp3.Response');
      Response.code.implementation = function () {
        var c = this.code();
        try {
          var u = this.request().url().toString();
          var mth = this.request().method();
          var key = c + ' ' + mth + ' ' + u.split('?')[0];
          once(key, { lib: 'okhttp', code: c, method: mth, url: u.split('?')[0] });
        } catch (e) { }
        return c;
      };
    } catch (e) { emit('http-err', { w: 'okhttp', m: String(e) }); }
    try {
      var HUC = Java.use('java.net.HttpURLConnection');
      HUC.getResponseCode.implementation = function () {
        var c = this.getResponseCode();
        try { once('huc' + c + this.getURL().toString().split('?')[0], { lib: 'huc', code: c, url: this.getURL().toString().split('?')[0] }); } catch (e) { }
        return c;
      };
    } catch (e) { emit('http-err', { w: 'huc', m: String(e) }); }
    emit('http-ready', {});
  });
})();
