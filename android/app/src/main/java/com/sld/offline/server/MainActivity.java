package com.sld.offline.server;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 界面就是管理页本身: 开关假服 / 改存档 / 看日志都由 JS 侧的管理端口下发同一个页面
 * (PC 浏览器打开同一个地址看到的东西一模一样, 用户反馈时能直接截图)。
 */
public class MainActivity extends Activity {

    private static final long RETRY_MS = 1500;
    private static final int RETRY_MAX = 20; // 首次铺盘 + 解析 13MB 整表, 给到 ~30s

    private final Handler ui = new Handler(Looper.getMainLooper());
    private WebView page;
    private int tries;

    private final String url = "http://127.0.0.1:" + NodeBridge.ADMIN_PORT + "/";

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        ensureService();
        page = new WebView(this);
        setContentView(page);
        WebSettings s = page.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // 页面用 localStorage 存管理令牌
        page.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) retry();
            }
        });
        load();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        ui.removeCallbacksAndMessages(null);
        page.destroy();
    }

    /** 返回键在单页面上就是"退应用", 假服继续在前台服务里跑。 */
    @Override
    public void onBackPressed() {
        finish();
    }

    private void load() {
        page.loadUrl(url);
    }

    private void retry() {
        if (tries++ >= RETRY_MAX) {
            page.loadDataWithBaseURL(null,
                    "<meta name=viewport content='width=device-width,initial-scale=1'>"
                            + "<h3>连不上管理页 " + url + "</h3>"
                            + "<p>错误: " + esc(NodeBridge.lastError()) + "</p>"
                            + "<p>logcat 过滤 " + NodeBridge.TAG + " 看 node 侧的原始报错。</p>",
                    "text/html", "utf-8", null);
            return;
        }
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                load();
            }
        }, RETRY_MS);
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

    private static String esc(String s) {
        if (s == null) return "(还没有错误记录 —— 大概率是 node 还在铺盘)";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }
}
