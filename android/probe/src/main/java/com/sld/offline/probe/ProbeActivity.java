package com.sld.offline.probe;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Button;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 运行时探针: 把 assets 里的 code/&lt;buildCode&gt; 解到 filesDir, 交给 libnode 跑 probe.js,
 * 结果逐行显示在屏上。装不上 adb 的机器, 这几行字就是唯一的证据。
 */
public class ProbeActivity extends Activity {

    private static final long POLL_MS = 500;
    private static final long LIMIT_MS = 90_000;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final AtomicBoolean running = new AtomicBoolean();

    private TextView text;
    private ScrollView scroll;
    private volatile File outFile;
    private volatile String failure;

    private static native int nativeRun(String[] argv);

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(buildUi());
        start();
    }

    private android.view.View buildUi() {
        android.widget.LinearLayout box = new android.widget.LinearLayout(this);
        box.setOrientation(android.widget.LinearLayout.VERTICAL);

        Button again = new Button(this);
        again.setText("重跑（会退出应用，再从桌面点开）");
        again.setOnClickListener(v -> { finish(); android.os.Process.killProcess(android.os.Process.myPid()); });
        box.addView(again);

        scroll = new ScrollView(this);
        android.widget.LinearLayout.LayoutParams lp = new android.widget.LinearLayout.LayoutParams(
                android.widget.LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        scroll.setLayoutParams(lp);

        text = new TextView(this);
        text.setTextIsSelectable(true);
        text.setTextColor(0xFF222222);
        scroll.addView(text);
        box.addView(scroll);
        return box;
    }

    private void start() {
        running.set(true);
        show("准备中…\n", true);
        worker();
        poll(System.currentTimeMillis());
    }

    /** node::Start 阻塞且吃栈(V8 对栈深敏感)，所以给独立线程 + 8MB 栈。 */
    private void worker() {
        Thread t = new Thread(null, () -> {
            try {
                File code = extractAssets();
                File out = new File(getFilesDir(), "probe-out.txt");
                if (out.exists() && !out.delete()) throw new IOException("删不掉旧的 " + out);
                outFile = out;
                show("libnode 加载完成，起跑 " + code.getName() + "/main.js\n", true);
                System.loadLibrary("node_start");
                nativeRun(new String[]{"node", new File(code, "main.js").getAbsolutePath(), "--out", out.getAbsolutePath()});
                failure = "node::Start 已返回（事件循环排空 = 探针没挂住进程）";
            } catch (Throwable e) {
                failure = e.getClass().getSimpleName() + ": " + e.getMessage();
            } finally {
                running.set(false);
            }
        }, "node", 8 << 20);
        t.start();
    }

    /** assets/code/manifest.json 里写死了本次打包的 buildCode，靠它挑目录，不在 Java 侧复制版本号。 */
    private File extractAssets() throws IOException {
        String bc;
        try {
            bc = new JSONObject(slurp(getAssets().open("code/manifest.json"))).optString("buildCode", "");
        } catch (IOException e) {
            throw new IOException("没有 assets/code/manifest.json —— 先跑 node tools/pack_nodejs.mjs --main android/probe.js --out android/probe/src/main/assets");
        } catch (JSONException e) {
            throw new IOException("assets/code/manifest.json 不是合法 JSON: " + e.getMessage());
        }
        if (bc.isEmpty()) throw new IOException("manifest.json 里没有 buildCode");
        File dst = new File(getFilesDir(), "code/" + bc);
        copyAssets("code/" + bc, dst);
        if (!new File(dst, "main.js").exists()) throw new IOException(dst + "/main.js 没解出来");
        return dst;
    }

    private void copyAssets(String path, File dir) throws IOException {
        String[] kids = ls(path);
        if (kids.length == 0) return;
        dir.mkdirs();
        for (String kid : kids) {
            String child = path + "/" + kid;
            if (ls(child).length > 0) copyAssets(child, new File(dir, kid));
            else {
                File to = new File(dir, kid);
                to.getParentFile().mkdirs();
                try (InputStream in = getAssets().open(child); FileOutputStream out = new FileOutputStream(to)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
            }
        }
    }

    private void poll(long beganAt) {
        ui.postDelayed(() -> {
            File f = outFile;
            if (f != null && f.length() > 0) {
                try {
                    show(slurp(new java.io.FileInputStream(f)), true);
                } catch (IOException e) {
                    show("读不出 " + f + ": " + e.getMessage() + "\n", true);
                }
                running.set(false);
                return;
            }
            if (failure != null) {
                show("FATAL " + failure + "\n", true);
                return;
            }
            long waited = System.currentTimeMillis() - beganAt;
            if (waited > LIMIT_MS) {
                show("超时 " + waited / 1000 + "s 没出结果：要么 libnode 卡在起 V8，要么脚本没跑起来。\n", true);
                return;
            }
            if (running.get()) {
                show("已等 " + waited / 1000 + "s…\n", false);
                poll(beganAt);
            }
        }, POLL_MS);
    }

    private void show(String s, boolean replace) {
        ui.post(() -> {
            if (replace) text.setText(s);
            else text.setText("运行中\n" + s);
            scroll.post(() -> scroll.fullScroll(android.view.View.FOCUS_DOWN));
        });
    }

    private static String slurp(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
        }
        return sb.toString();
    }

    /** 有些 ROM 对文件路径调 list() 返回 null 而不是空数组。 */
    private String[] ls(String path) throws IOException {
        String[] r = getAssets().list(path);
        return r == null ? new String[0] : r;
    }
}
