// 管理页: 单文件 HTML+JS, 由 admin.ts 的 GET / 下发(不另开静态目录, 免得 dist/dist-cjs/APK assets
// 三处都要拷资源文件)。写这里的 JS 不许用反引号和 ${} —— 整段是外层模板字符串。
export const ADMIN_PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>sld 假服管理</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#12151a;color:#dfe4ea;font:14px/1.5 system-ui,sans-serif}
header{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#1a1f26;border-bottom:1px solid #2a3138;flex-wrap:wrap}
header b{font-size:15px}
nav{display:flex;gap:6px;margin-left:auto}
button,select,input,textarea{font:inherit;background:#232a33;color:#dfe4ea;border:1px solid #35404d;border-radius:6px;padding:6px 10px}
button{cursor:pointer}
button:active{transform:translateY(1px)}
.badge{padding:2px 8px;border-radius:999px;background:#3a2b12;color:#f0b429;font-size:12px}
.badge.on{background:#12331f;color:#4ade80}
main{padding:12px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
table{border-collapse:collapse;width:100%}
td{padding:4px 8px;border-bottom:1px solid #262d35;vertical-align:top}
td:first-child{color:#8a97a6;width:130px;white-space:nowrap}
textarea,pre{width:100%;background:#0d1014;border:1px solid #2a3138;border-radius:6px;padding:8px;overflow:auto}
textarea{height:52vh;white-space:pre;font-family:ui-monospace,Menlo,monospace;font-size:12px}
pre{height:56vh;font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all}
.hint{color:#8a97a6;font-size:12px;margin:6px 0}
#saveMsg{margin-top:8px;font-size:13px}
#saveMsg.err{color:#f87171}
#saveMsg.ok{color:#4ade80}
#toast{position:fixed;right:12px;bottom:12px;background:#2b3a4b;padding:8px 12px;border-radius:6px;opacity:0;transition:.2s}
#toast.show{opacity:1}
h4{margin:14px 0 6px;color:#8a97a6;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
</style></head>
<body>
<header><b>sld 假服</b><span id="run" class="badge">停止</span>
<nav><button data-tab="status">状态</button><button data-tab="save">存档</button><button data-tab="log">日志</button></nav></header>
<main>
<section id="tab-status">
  <div class="row"><button id="start">启动假服</button><button id="stop">停止假服</button><button id="restart">重启</button></div>
  <table id="st"></table>
</section>
<section id="tab-save" hidden>
  <div class="row">
    <select id="moneySel"></select><input id="moneyVal" type="number" min="0" step="1" style="width:110px">
    <button id="setMoney">设为该值</button><button id="addMoney">加到余额</button>
  </div>
  <div class="row"><button id="reload">重读存档</button><button id="patch">保存(整段 JSON)</button></div>
  <p class="hint">顶层 18 个键一个都不能少; items/money 的 id 必须是客户端 Items_Xls 里有的。改坏了一行会被拒并原样退回, 不碰盘。</p>
  <textarea id="saveJson" spellcheck="false"></textarea>
  <div id="saveMsg"></div>
</section>
<section id="tab-log" hidden>
  <div class="row">级别
    <select id="level"><option>debug</option><option selected>info</option><option>warn</option><option>error</option></select>
    <label><input type="checkbox" id="auto" checked> 跟随(2s)</label><button id="clear">清屏</button>
  </div>
  <pre id="log">加载中…</pre>
</section>
</main>
<div id="toast"></div>
<script>
(function () {
  var token = '';
  function readTok() {
    var m = location.search.match(/[?&]token=([0-9a-f]+)/);
    if (m) { token = m[1]; try { localStorage.setItem('sldAdminToken', token); } catch (e) {} }
    else { try { token = localStorage.getItem('sldAdminToken') || ''; } catch (e) {} }
  }
  readTok();

  function api(p, method, body) {
    var opt = { method: method || 'GET', headers: {} };
    if (token) opt.headers['X-Admin-Token'] = token;
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(p, opt).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = JSON.parse(t); } catch (e) {}
        if (!r.ok) { var err = new Error((data && data.error) || (r.status + ' ' + t.slice(0, 120))); err.status = r.status; throw err; }
        return data;
      });
    });
  }

  var toastTimer = 0;
  function toast(msg, ok) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show';
    el.style.background = ok === false ? '#5b2323' : '#2b3a4b';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ''; }, 2600);
  }

  // ---- 状态页
  var stRows = [
    ['运行', 'running'], ['网关', 'gateway'], ['HTTP', 'http'], ['对端', 'peers'],
    ['处理器', 'handlers'], ['存档', 'save'], ['Node', 'node'], ['内存', 'rss'], ['日志', 'logs'], ['表缺列', 'tables']
  ];
  function renderStatus(s) {
    document.getElementById('run').textContent = s.running ? '运行中' : '停止';
    document.getElementById('run').className = 'badge' + (s.running ? ' on' : '');
    var vals = {
      running: s.running ? '是' : '否',
      gateway: s.gateway.host + ':' + s.gateway.port + ' (' + s.gateway.mode + ')',
      http: (s.http.tls ? 'https' : 'http') + '://' + s.http.host + ':' + s.http.port,
      peers: s.peers.length ? s.peers.map(function (p) { return p.id + ' ' + p.mode + ' frames=' + p.frames; }).join(' · ') : '无',
      handlers: s.handlers.join(', ') || '(仅兜底)',
      save: s.save ? s.save.bytes + 'B · ' + s.save.mtime : '无',
      node: s.node + ' · 已起 ' + Math.round(s.uptimeSec / 60) + ' 分',
      rss: s.rssMb + ' MB',
      logs: s.logs,
      tables: s.tables || '无'
    };
    // 一律 textContent: 值里有尖括号/路径也不当标签解析
    var tb = document.getElementById('st');
    tb.textContent = '';
    for (var i = 0; i < stRows.length; i++) {
      var tr = document.createElement('tr');
      var k = document.createElement('td');
      k.textContent = stRows[i][0];
      var v = document.createElement('td');
      v.textContent = String(vals[stRows[i][1]]);
      tr.appendChild(k);
      tr.appendChild(v);
      tb.appendChild(tr);
    }
  }
  function refreshStatus() {
    return api('/api/status').then(renderStatus).catch(function (e) { toast('读状态失败: ' + e.message, false); });
  }
  ['start', 'stop', 'restart'].forEach(function (op) {
    document.getElementById(op).onclick = function () {
      api('/api/' + op, 'POST').then(function () { toast(op + ' 完成'); refreshStatus(); })
        .catch(function (e) { toast(op + ' 失败: ' + e.message, false); });
    };
  });

  // ---- 存档页
  var ta = document.getElementById('saveJson');
  function loadSave() {
    return api('/api/save').then(function (s) {
      ta.value = JSON.stringify(s, null, 2);
      msg('', '');
      return s;
    }).catch(function (e) { toast('读存档失败: ' + e.message, false); });
  }
  function msg(text, ok) {
    var el = document.getElementById('saveMsg');
    el.textContent = text;
    el.className = ok === false ? 'err' : 'ok';
  }
  document.getElementById('reload').onclick = function () { loadSave().then(function () { toast('已重读'); }); };
  document.getElementById('patch').onclick = function () {
    var body;
    try { body = JSON.parse(ta.value); } catch (e) { msg('JSON 语法就不对: ' + e.message, false); return; }
    api('/api/save', 'PATCH', body).then(function (r) {
      ta.value = JSON.stringify(r.save, null, 2);
      msg('已写盘, 改前副本 ' + r.backup, true);
      toast('存档已更新');
    }).catch(function (e) { msg('被拒: ' + e.message, false); });
  };
  function loadMoney() {
    return api('/api/items?kind=money').then(function (list) {
      var sel = document.getElementById('moneySel');
      sel.innerHTML = '';
      list.forEach(function (it) {
        var o = document.createElement('option');
        o.value = it.id;
        o.textContent = it.name + ' (' + it.id + ') 现有 ' + it.owned;
        sel.appendChild(o);
      });
    });
  }
  function patchMoney(add) {
    var id = document.getElementById('moneySel').value;
    var v = Number(document.getElementById('moneyVal').value);
    if (!id || !isFinite(v) || v < 0) { toast('先选货币并填个非负数', false); return; }
    api('/api/save').then(function (s) {
      s.money[id] = add ? Number(s.money[id] || 0) + v : v;
      return api('/api/save', 'PATCH', { money: s.money });
    }).then(function (r) {
      ta.value = JSON.stringify(r.save, null, 2);
      msg('已写盘, 改前副本 ' + r.backup, true);
      loadMoney();
      toast('改好了');
    }).catch(function (e) { msg('被拒: ' + e.message, false); });
  }
  document.getElementById('setMoney').onclick = function () { patchMoney(0); };
  document.getElementById('addMoney').onclick = function () { patchMoney(1); };

  // ---- 日志页
  var offset = 0, logEl = document.getElementById('log'), firstPull = true;
  function pullLogs() {
    var q = firstPull ? '?tail=300' : '?offset=' + offset;
    return api('/api/logs' + q).then(function (r) {
      if (firstPull) logEl.textContent = r.text; else logEl.textContent += r.text;
      offset = r.nextOffset;
      firstPull = false;
      if (document.getElementById('auto').checked) logEl.scrollTop = logEl.scrollHeight;
    }).catch(function () {});
  }
  document.getElementById('level').onchange = function () {
    var lv = this.value;
    api('/api/loglevel', 'POST', { level: lv }).then(function () { toast('级别 -> ' + lv); }).catch(function (e) { toast(e.message, false); });
  };
  document.getElementById('clear').onclick = function () { logEl.textContent = ''; };

  // ---- tab + 轮询
  var tab = 'status', timer = 0;
  function show(name) {
    tab = name;
    ['status', 'save', 'log'].forEach(function (t) { document.getElementById('tab-' + t).hidden = t !== name; });
    if (name === 'save') { loadSave(); loadMoney(); }
    if (name === 'log') pullLogs();
  }
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) { b.onclick = function () { show(b.dataset.tab); }; });
  setInterval(function () {
    if (tab === 'status') refreshStatus();
    else if (tab === 'log' && document.getElementById('auto').checked) pullLogs();
  }, 2000);
  refreshStatus();
})();
</script>
</body></html>
`;
