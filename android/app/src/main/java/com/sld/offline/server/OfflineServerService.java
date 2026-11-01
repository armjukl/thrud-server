package com.sld.offline.server;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * 假服跑在这个前台服务里: 息屏/切后台都不许把 node 带走, 否则手机上的自服就是"打开界面才在、
 * 锁屏就掉线"。VM 由 NodeBridge 起一次, 服务的生死不等于假服的开关(那在管理页里)。
 */
public class OfflineServerService extends Service {

    public static final String ACTION_START = "com.sld.offline.server.START";

    private static final String CHANNEL = "sld-offline";
    private static final int NOTIF = 1;
    private static final long REPORT_AFTER_MS = 8000;

    private PowerManager.WakeLock wakeLock;
    private final Handler handler = new Handler();

    @Override
    public void onCreate() {
        super.onCreate();
        channel();
        startForeground(NOTIF, build("正在铺盘并启动 node…"));
        wakeLock = wakeLock();
        if (wakeLock != null) wakeLock.acquire();
        NodeBridge.start(getApplicationContext());
        // 起不来时 logcat 用户看不到, 管理页也进不去 —— 8s 后把错回填到通知上, 至少有个能读的现象
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                updateNotif(stateText());
            }
        }, REPORT_AFTER_MS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 重复 start 只是把通知刷一下: VM 常驻, 不该因为用户多点两次图标就重启
        updateNotif(stateText());
        return START_STICKY;
    }

    /** 起不来时 logcat 用户看不到, 管理页也进不去 —— 通知上至少给一句能读的现象。 */
    private String stateText() {
        String err = NodeBridge.lastError();
        return err == null ? "假服在跑 https:9443 kcp:19005 · 管理页 19080" : "起不来: " + err;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        handler.removeCallbacksAndMessages(null);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        Log.w("sld-server", "前台服务被销毁: 进程可能随时被回收, 假服跟着没");
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** 手机上启动这条路: 外部(游戏客户端/gadget)只会走回环, 所以端口写死在通知里就够了。 */
    private Notification build(String text) {
        Intent open = new Intent(this, MainActivity.class);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_IMMUTABLE : 0;
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return b.setContentTitle("斯露德假服")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setOngoing(true)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, flags))
                .build();
    }

    private void updateNotif(String text) {
        ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(NOTIF, build(text));
    }

    private void channel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        nm.createNotificationChannel(
                new NotificationChannel(CHANNEL, "假服", NotificationManager.IMPORTANCE_LOW));
    }

    private PowerManager.WakeLock wakeLock() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        return pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sld:offline-server");
    }
}
