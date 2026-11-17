package app.souldew;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.AssetManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Runs the souldew server (server/index.mjs on nodejs-mobile) inside the app, as a foreground service. */
public class NodeService extends Service {
    public static final int PORT = 7373;
    private static final String TAG = "souldew";
    private static final String CHANNEL = "server";
    /** 0 = not started, 1 = starting, 2 = running, -1 = runtime missing, -2 = failed */
    public static volatile int state = 0;
    public static volatile String error = "";
    private static boolean started = false; // node::Start works once per process

    static {
        try {
            System.loadLibrary("souldew_node");
        } catch (Throwable t) {
            state = -1;
            error = "the Node runtime is not bundled in this build (see docs/ANDROID.md)";
        }
    }

    private static native int startNode(String[] args, String[] env);

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Server", NotificationManager.IMPORTANCE_LOW));
        Notification n = new Notification.Builder(this, CHANNEL)
                .setContentTitle("souldew is running")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1, n);

        synchronized (NodeService.class) {
            if (!started && state != -1) {
                started = true;
                state = 1;
                final File files = getFilesDir();
                final AssetManager assets = getAssets();
                final String version = BuildConfigStamp.version(this);
                final File cache = getCacheDir();
                final String nativeDir = getApplicationInfo().nativeLibraryDir; // the 3DS host and core are packed there
                // big stack: Node needs more than a default Java thread has
                new Thread(null, () -> run(files, cache, assets, version, nativeDir), "node", 4L * 1024 * 1024).start();
            }
        }
        return START_STICKY;
    }

    private static void run(File files, File cache, AssetManager assets, String version, String nativeDir) {
        try {
            File app = new File(files, "souldew-app");
            File stamp = new File(app, ".stamp");
            if (!stamp.exists() || !readText(stamp).equals(version)) {
                deleteTree(app);
                copyAssets(assets, "souldew", app);
                writeText(stamp, version);
            }
            File data = new File(files, "data");
            data.mkdirs();
            String[] env = {
                    "PORT=" + PORT,
                    "SLS_DATA_DIR=" + data.getAbsolutePath(),
                    "NO_OPEN=1",
                    "HOME=" + files.getAbsolutePath(),
                    "TMPDIR=" + cache.getAbsolutePath(),
                    "SLS_NATIVE_DIR=" + nativeDir,
            };
            String[] args = {"node", new File(app, "server/index.mjs").getAbsolutePath()};
            state = 2;
            int rc = startNode(args, env);
            state = -2;
            error = "Node exited (" + rc + ")";
        } catch (Throwable t) {
            Log.e(TAG, "server failed", t);
            state = -2;
            error = String.valueOf(t);
        }
    }

    private static void copyAssets(AssetManager am, String from, File to) throws IOException {
        String[] kids = am.list(from);
        if (kids != null && kids.length > 0) {
            to.mkdirs();
            for (String k : kids) copyAssets(am, from + "/" + k, new File(to, k));
        } else {
            to.getParentFile().mkdirs();
            try (InputStream in = am.open(from); OutputStream out = new FileOutputStream(to)) {
                byte[] buf = new byte[64 * 1024];
                int r;
                while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
            }
        }
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    private static String readText(File f) {
        try (InputStream in = new FileInputStream(f)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private static void writeText(File f, String s) throws IOException {
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(s.getBytes(StandardCharsets.UTF_8));
        }
    }
}
