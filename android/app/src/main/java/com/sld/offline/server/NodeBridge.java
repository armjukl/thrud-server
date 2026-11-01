package com.sld.offline.server;

import android.content.Context;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Java 侧唯一的 node 入口: 铺盘 + 起 VM。
 *
 * 一个进程只起一次 VM(8MB 栈的线程), 之后"开/关假服"都是 JS 层启停监听器 —— node::Start
 * 阻塞且排空后会走到 exit(), 在 Java 侧重启 VM 等于自杀, 也不比管理页上的开关更可靠。
 */
final class NodeBridge {

    static final String TAG = "sld-server";
    /** 管理面端口: 通知栏、WebView、main.js 三处都引用这一个数。 */
    static final int ADMIN_PORT = 19080;

    private static volatile boolean started;
    private static volatile String lastError;
    private static volatile String buildCode = "";

    private NodeBridge() {
    }

    static native int nativeRun(String[] argv);

    static String lastError() {
        return lastError;
    }

    static String buildCode() {
        return buildCode;
    }

    static synchronized void start(final Context ctx) {
        if (started) return;
        started = true;
        final Context app = ctx.getApplicationContext();
        // 4 参构造是 (ThreadGroup, Runnable, name, stackSize): V8 吃栈深, 默认 1MB 不够
        Thread t = new Thread(null, new Runnable() {
            @Override
            public void run() {
                boot(app);
            }
        }, "sld-node", 8 << 20);
        t.setDaemon(true);
        t.start();
    }

    private static void boot(Context ctx) {
        try {
            System.loadLibrary("node_shell");
            File code = prepare(ctx);
            Log.i(TAG, "起跑 " + code.getName() + "/main.js, 数据目录 " + dataDir(ctx));
            nativeRun(new String[]{
                    "node", new File(code, "main.js").getAbsolutePath(),
                    "--root", code.getAbsolutePath(),
                    "--data", dataDir(ctx).getAbsolutePath(),
                    "--seed", new File(ctx.getFilesDir(), "seed").getAbsolutePath(),
                    "--admin", String.valueOf(ADMIN_PORT),
                    "--admin-host", "127.0.0.1",
                    "--build-code", buildCode,
            });
            lastError = "node::Start 已返回: 事件循环排空, 假服不会再有响应";
            Log.e(TAG, lastError);
        } catch (Throwable e) {
            // UnsatisfiedLinkError 也走这里: libnode/libc++_shared 加载失败的原始信息只在异常里
            lastError = e.getClass().getSimpleName() + ": " + e.getMessage();
            Log.e(TAG, "起不来: " + lastError, e);
        }
    }

    /** 数据目录放外部 files: USB 一拉就能拿存档, 接上现成的 docs/README-存档修改.md 流程。 */
    static File dataDir(Context ctx) {
        File ext = ctx.getExternalFilesDir(null);
        File base = ext != null ? ext : ctx.getFilesDir(); // 工作资料/存储未挂载时外部目录会是 null
        return new File(base, "slddata");
    }

    /**
     * assets -> 内部目录, 返回代码目录。
     * 代码与数据分家是铁律: code/ 允许整目录覆盖(APK 更新换代), 存档只在 seedOnce 缺失时才铺。
     */
    private static File prepare(Context ctx) throws IOException {
        String bc = manifestBuildCode(ctx);
        buildCode = bc;
        File code = new File(ctx.getFilesDir(), "code/" + bc);
        copyAssets(ctx, "code/" + bc, code);
        dropOtherCodeDirs(ctx, bc);
        File seed = new File(ctx.getFilesDir(), "seed");
        copyAssets(ctx, "seed", seed);
        if (!new File(code, "main.js").exists()) throw new IOException(code + "/main.js 没铺出来(assets/code/" + bc + " 空了?)");
        if (!new File(seed, "data/save.json").exists()) throw new IOException(seed + "/data/save.json 没铺出来(assets/seed 空了?)");
        return code;
    }

    /** assets 不能当 File 读, 所以 buildCode 从 manifest.json 拿, 不在 Java 里抄一份版本号。 */
    private static String manifestBuildCode(Context ctx) throws IOException {
        byte[] raw = read(ctx.getAssets().open("code/manifest.json"));
        try {
            String bc = new JSONObject(new String(raw, StandardCharsets.UTF_8)).optString("buildCode", "");
            if (bc.isEmpty()) throw new IOException("assets/code/manifest.json 里没有 buildCode");
            return bc;
        } catch (JSONException e) {
            throw new IOException("assets/code/manifest.json 不是合法 JSON: " + e.getMessage());
        }
    }

    /** 旧 buildCode 的代码目录留着就是几百个文件的坟: 换版就删掉不等于当前版的那些。 */
    private static void dropOtherCodeDirs(Context ctx, String keep) {
        File[] kids = new File(ctx.getFilesDir(), "code").listFiles();
        if (kids == null) return;
        for (File f : kids) {
            if (f.isDirectory() && !f.getName().equals(keep)) deleteTree(f);
        }
    }

    /**
     * 整目录覆盖式解包。seed/ 也覆盖: 它是"首启铺盘"的源, 不是玩家数据,
     * 玩家数据在 dataDir 下, 由 main.js 的 seedOnce 保证已存在的文件一个都不动。
     */
    private static void copyAssets(Context ctx, String path, File dir) throws IOException {
        String[] kids = ls(ctx, path);
        if (kids.length == 0) throw new IOException("assets/" + path + " 是空的 —— 先跑 npm run pack:android");
        dir.mkdirs();
        for (String kid : kids) {
            String child = path + "/" + kid;
            if (ls(ctx, child).length > 0) copyAssets(ctx, child, new File(dir, kid));
            else {
                File to = new File(dir, kid);
                to.getParentFile().mkdirs();
                FileOutputStream out = new FileOutputStream(to);
                try {
                    out.write(read(ctx.getAssets().open(child)));
                } finally {
                    out.close();
                }
            }
        }
    }

    /** 有些 ROM 对文件路径调 list() 返回 null 而不是空数组。 */
    private static String[] ls(Context ctx, String path) throws IOException {
        String[] r = ctx.getAssets().list(path);
        return r == null ? new String[0] : r;
    }

    private static byte[] read(InputStream in) throws IOException {
        try {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[64 * 1024];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toByteArray();
        } finally {
            in.close();
        }
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteTree(k);
        }
        f.delete();
    }
}
