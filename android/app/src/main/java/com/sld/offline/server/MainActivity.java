package com.sld.offline.server;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生面板: 状态卡 + 启停 + 日志尾 + 存档读写, 全部打本机管理端口 19080 的 /api/*。
 *
 * 为什么不默认用 WebView —— 屏上控件不依赖 node 起来(首次铺盘那半分钟也能看到重试到第几次),
 * 也少一类"白屏 / onReceivedError"的排查面。网页版留一个按钮当备用: 同一组接口、同一份数据,
 * PC 浏览器打开同一地址看到的东西一模一样, 反馈时能直接截图。
 */
public class MainActivity extends Activity {

    private static final long POLL_MS = 2000;
    private static final int BOOT_TRIES = 20; // 首次铺 7 个 seed + 展开 36 张表, 给到 ~40s
    private static final int LOG_MAX_CHARS = 60_000; // 屏上只留最近的, 老日志在文件里
    private static final int EDIT_MAX_CHARS = 120_000; // 整档 pretty 出来 400KB, EditText 一次铺不完
    private static final String[] LEVELS = {"debug", "info", "warn", "error"};

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final String base = "http://127.0.0.1:" + NodeBridge.ADMIN_PORT;

    private TextView statusView;
    private TextView logView;
    private ScrollView logScroll;
    private EditText saveEdit;
    private Button followBtn;
    private Button levelBtn;
    private LinearLayout panel;
    private WebView page;

    /** 取不到状态的次数(铺盘期是正常的), 只在 io 线程动。 */
    private int misses;
    /** 日志读到哪: 只在 io 线程读写, 清屏也排进同一条队列, 所以不用加锁。 */
    private int logOffset;
    private volatile boolean followLog = true;
    private int levelIdx = 1; // 服务端默认 info

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            refresh();
            ui.postDelayed(this, POLL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        ensureService();
        setContentView(buildUi());
    }

    @Override
    protected void onResume() {
        super.onResume();
        ui.removeCallbacks(tick);
        ui.post(tick);
    }

    @Override
    protected void onPause() {
        super.onPause();
        ui.removeCallbacks(tick); // 界面不在眼前就别 2 秒一次读日志
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        io.shutdownNow();
        if (page != null) page.destroy();
    }

    /** 返回键: 从网页面板退回原生面板; 本来就在原生面板上就是退应用(假服继续在前台服务里跑)。 */
    @Override
    public void onBackPressed() {
        if (page != null && page.getParent() != null) {
            setContentView(panel);
            ui.removeCallbacks(tick);
            ui.post(tick);
            return;
        }
        finish();
    }

    private View buildUi() {
        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        int p = dp(8);
        panel.setPadding(p, p, p, p);

        statusView = new TextView(this);
        statusView.setTextSize(13f);
        statusView.setTextIsSelectable(true);
        statusView.setText("等 node 起来(首次要铺 seed 并展开 36 张表)…");
        add(panel, statusView, -1, 0f);

        LinearLayout ops = newRow();
        add(panel, ops, -1, 0f);
        addTo(ops, button("启动", v -> server("start")));
        addTo(ops, button("停止", v -> server("stop")));
        addTo(ops, button("重启", v -> server("restart")));
        addTo(ops, button("刷新", v -> refresh()));

        LinearLayout logRow = newRow();
        add(panel, logRow, -1, 0f);
        followBtn = button("日志跟随:开", v -> {
            followLog = !followLog;
            followBtn.setText(followLog ? "日志跟随:开" : "日志跟随:关");
        });
        addTo(logRow, followBtn);
        addTo(logRow, button("清屏", v -> clearLog()));
        levelBtn = button("级别:" + LEVELS[levelIdx], v -> cycleLevel());
        addTo(logRow, levelBtn);

        logScroll = new ScrollView(this);
        logView = new TextView(this);
        logView.setTextSize(11f);
        logView.setTextIsSelectable(true);
        logScroll.addView(logView, matchWrap());
        logScroll.setMinimumHeight(dp(140));
        add(panel, logScroll, -1, 2f);

        LinearLayout saveRow = newRow();
        add(panel, saveRow, -1, 0f);
        addTo(saveRow, button("读存档", v -> loadSave()));
        addTo(saveRow, button("写存档", v -> writeSave()));
        addTo(saveRow, button("网页面板", v -> showWeb()));

        saveEdit = new EditText(this);
        saveEdit.setTextSize(11f);
        saveEdit.setSingleLine(false);
        saveEdit.setHorizontallyScrolling(false);
        saveEdit.setTypeface(android.graphics.Typeface.MONOSPACE);
        saveEdit.setHint("“读存档”取当前 data/save.json, 改完“写存档”整档 PUT 回去");
        ScrollView saveScroll = new ScrollView(this);
        saveScroll.addView(saveEdit, matchWrap());
        saveScroll.setMinimumHeight(dp(90));
        add(panel, saveScroll, -1, 1f);

        return panel;
    }

    // ---- 与 /api/* 的往返: 网络全在 io 线程, 主线程只贴文字

    private void refresh() {
        io.execute(() -> {
            try {
                final JSONObject st = new JSONObject(get("/api/status"));
                misses = 0;
                final String text = render(st);
                final Tail tail = followLog ? readLogs() : null;
                ui.post(() -> {
                    statusView.setText(text);
                    if (tail != null) appendLog(tail);
                });
            } catch (Exception e) {
                reportDead(e);
            }
        });
    }

    /** 连不上的前 20 次当"还在铺盘", 之后把 node 侧最后一条错误摊到屏上。 */
    private void reportDead(Exception e) {
        misses++;
        final int n = misses;
        final String why = String.valueOf(e.getMessage());
        ui.post(() -> statusView.setText("连不上管理面 " + base + "(第 " + n + " 次)\n" + why
                + (n >= BOOT_TRIES
                    ? "\n错误记录: " + NodeBridge.lastError()
                        + "\nlogcat 过滤 " + NodeBridge.TAG + " 看 node 侧原始报错。"
                    : "\n假服可能还在铺盘, 继续重试…")));
    }

    /** 日志按 offset 增量取; 文件变小(换档/清盘)就先清屏, 不然会留着上一轮的。 */
    private Tail readLogs() throws Exception {
        int from = logOffset;
        String q = from == 0 ? "/api/logs?tail=200" : "/api/logs?offset=" + from;
        JSONObject r = new JSONObject(get(q));
        if (from != 0 && r.getInt("size") < from) {
            logOffset = 0;
            return new Tail(true, "");
        }
        logOffset = r.getInt("nextOffset");
        return new Tail(false, r.getString("text"));
    }

    private void appendLog(Tail tail) {
        if (tail.reset) {
            logView.setText("");
            return;
        }
        if (tail.text.isEmpty()) return;
        logView.setText(cap(logView.getText().toString() + tail.text));
        logScroll.post(() -> logScroll.fullScroll(View.FOCUS_DOWN));
    }

    private static String cap(String text) {
        return text.length() <= LOG_MAX_CHARS ? text : text.substring(text.length() - LOG_MAX_CHARS);
    }

    /** 清屏只清屏: 文件一个字不动, 下一轮从头 tail 200 行重新起。 */
    private void clearLog() {
        io.execute(() -> {
            logOffset = 0;
            ui.post(() -> logView.setText(""));
        });
    }

    private void cycleLevel() {
        levelIdx = (levelIdx + 1) % LEVELS.length;
        final String level = LEVELS[levelIdx];
        levelBtn.setText("级别:" + level);
        io.execute(() -> {
            try {
                post("/api/loglevel", "{\"level\":\"" + level + "\"}");
                toast("日志级别 -> " + level);
            } catch (Exception e) {
                toast("改级别失败: " + e.getMessage());
            }
        });
    }

    private void server(String op) {
        io.execute(() -> {
            try {
                post("/api/" + op, null);
                toast(op + " 已执行");
                refresh();
            } catch (Exception e) {
                toast(op + " 失败: " + e.getMessage());
            }
        });
    }

    private void loadSave() {
        io.execute(() -> {
            try {
                final String text = shown(get("/api/save"));
                ui.post(() -> saveEdit.setText(text));
            } catch (Exception e) {
                toast("读档失败: " + e.getMessage());
            }
        });
    }

    /**
     * 整档 pretty 出来 400KB, EditText 一次铺这么多会卡住主线程, 所以超长只给开头。
     * 截断处 JSON 必然不完整, 真去写档会被服务端 JSON.parse 挡在 400, 一个字节都不落盘。
     */
    private static String shown(String compact) throws Exception {
        String pretty = new JSONObject(compact).toString(2);
        if (pretty.length() <= EDIT_MAX_CHARS) return pretty;
        return pretty.substring(0, EDIT_MAX_CHARS) + "\n…(只展开前 " + EDIT_MAX_CHARS + " 字符, 整档改动请用网页面板)";
    }

    /**
     * 写档用 PUT(整档替换), 不用 PATCH —— java.net.HttpURLConnection 会拒 "PATCH" 这个方法名,
     * 而服务端 /api/save 两个方法都收, 语义上"整份贴回去"本来就该是 PUT。
     * 校验全在服务端: normalizeSave 不认的 400 回来, 一个字都不落盘。
     */
    private void writeSave() {
        final String body = saveEdit.getText().toString();
        io.execute(() -> {
            try {
                String text = send(open("PUT", "/api/save"), body);
                toast("已落盘, 改前副本 " + new JSONObject(text).optString("backup"));
                refresh();
            } catch (Exception e) {
                toast("写档被拒: " + e.getMessage());
            }
        });
    }

    private String render(JSONObject s) throws Exception {
        StringBuilder b = new StringBuilder();
        b.append(s.getBoolean("running") ? "● 运行中" : "○ 已停止")
         .append("  node ").append(s.getString("node"))
         .append("  已起 ").append(Math.round(s.optLong("uptimeSec") / 60)).append(" 分\n");
        JSONObject gw = s.getJSONObject("gateway"), http = s.getJSONObject("http");
        b.append("网关 ").append(gw.getString("host")).append(":").append(gw.getInt("port"))
         .append(" (").append(gw.getString("mode")).append(")  ")
         .append(http.getBoolean("tls") ? "https" : "http").append("://")
         .append(http.getString("host")).append(":").append(http.getInt("port")).append('\n');
        b.append("对端 ").append(s.getJSONArray("peers").length())
         .append("  包 ").append(s.getInt("packets"))
         .append("  处理器 ").append(s.getJSONArray("handlers").length()).append(" 条\n");
        JSONObject save = s.optJSONObject("save");
        if (save != null) {
            b.append("存档 ").append(save.getLong("bytes")).append("B  ")
             .append(save.optString("mtime")).append('\n');
        }
        b.append("内存 RSS ").append(s.getInt("rssMb")).append("  heap ").append(s.getInt("heapMb"))
         .append(" MB  系统可用 ").append(s.getInt("sysFreeMb")).append('/').append(s.getInt("sysTotalMb"))
         .append(" MB\n");
        String tables = s.optString("tables");
        b.append("表缺列 ").append(tables.isEmpty() ? "无" : tables).append('\n');
        b.append("日志 ").append(s.getString("logs"));
        return b.toString();
    }

    /** offset 推进和"要不要清屏"得跟文字一起交给主线程, 拆两次 post 会交错。 */
    private static final class Tail {
        final boolean reset;
        final String text;
        Tail(boolean reset, String text) {
            this.reset = reset;
            this.text = text;
        }
    }

    // ---- 极小的 HTTP 客户端

    private String get(String path) throws Exception {
        return send(open("GET", path), null);
    }

    private String post(String path, String body) throws Exception {
        return send(open("POST", path), body);
    }

    private HttpURLConnection open(String method, String path) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(3000);
        c.setReadTimeout(15000);
        return c;
    }

    private static String send(HttpURLConnection c, String body) throws IOException {
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            byte[] raw = body.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(raw.length);
            try (OutputStream os = c.getOutputStream()) {
                os.write(raw);
            }
        }
        int code = c.getResponseCode();
        String text = read(code >= 400 ? c.getErrorStream() : c.getInputStream());
        c.disconnect();
        if (code >= 400) throw new IOException(code + " " + errOf(text));
        return text;
    }

    /** 服务端 400/500 都回 {"error":"…"}, 直接把那句话给用户, 别甩一坨 JSON。 */
    private static String errOf(String text) {
        try {
            return new JSONObject(text).getString("error");
        } catch (Exception e) {
            return text;
        }
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        try {
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        } finally {
            in.close();
        }
        return out.toString("UTF-8");
    }

    private void showWeb() {
        ui.removeCallbacks(tick); // 网页自己会轮询, 原生这边别同时抢日志 offset
        if (page == null) {
            page = new WebView(this);
            WebSettings s = page.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true); // 页面用 localStorage 存管理令牌
        }
        setContentView(page);
        page.loadUrl(base + "/");
    }

    private void toast(String text) {
        ui.post(() -> Toast.makeText(this, text, Toast.LENGTH_LONG).show());
    }

    // ---- 布局小工具: 竖排 add()(weight>0 时高度从 0 起按权重分), 横排 addTo()(等宽)

    private void add(ViewGroup parent, View child, int heightDp, float weight) {
        int h = heightDp < 0 ? ViewGroup.LayoutParams.WRAP_CONTENT
                : (weight > 0 ? 0 : dp(heightDp));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, h, weight);
        lp.bottomMargin = dp(4);
        parent.addView(child, lp);
    }

    private static ScrollView.LayoutParams matchWrap() {
        return new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout newRow() {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        return r;
    }

    private void addTo(LinearLayout row, View child) {
        row.addView(child, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
    }

    private Button button(String label, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(12f);
        b.setOnClickListener(onClick);
        return b;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void ensureService() {
        askNotifications();
        Intent i = new Intent(this, OfflineServerService.class).setAction(OfflineServerService.ACTION_START);
        // Android 8 之后后台起不了普通 service, 前台服务是唯一一条能把 node 留住的路
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
        else startService(i);
    }

    private void askNotifications() {
        if (Build.VERSION.SDK_INT < 33) return; // Android 13+ 才要运行时申请
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }
}
