'use strict';
// hook Java 网络层, 打印 SDK 打开的所有 URL
function emit(ev, m) { try { send(Object.assign({ ev: ev }, m)); } catch (e) { } }
(function () {
  if (!Java.available) { emit('jnet', { m: 'no java' }); return; }
  Java.perform(function () {
    var seen = {};
    function once(u) { if (!u || seen[u]) return; seen[u] = 1; emit('url', { u: u }); }
    try {
      var URL = Java.use('java.net.URL');
      URL.$init.overload('java.lang.String').implementation = function (u) { once(u); return this.$init(u); };
    } catch (e) { emit('jnet-err', { w: 'URL', m: String(e) }); }
    try {
      var URLc = Java.use('java.net.URLConnection');
      // openConnection 无参, URL 已打印
    } catch (e) { }
    try {
      var RB = Java.use('okhttp3.Request$Builder');
      RB.url.overload('java.lang.String').implementation = function (u) { once('ok:' + u); return this.url(u); };
    } catch (e) { }
    try {
      var HttpURLConnection = Java.use('java.net.HttpURLConnection');
      HttpURLConnection.connect.implementation = function () { try { emit('connect', { u: this.getURL().toString() }); } catch (e) { } return this.connect(); };
    } catch (e) { }
    emit('jnet-ready', {});
  });
})();
