package app.souldew;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.Manifest;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.net.HttpURLConnection;
import java.net.URL;

/** Full-screen WebView on the local souldew server. Landscape, immersive, ROM files through the system picker. */
public class MainActivity extends Activity {
    private static final String URL_BASE = "http://127.0.0.1:" + NodeService.PORT + "/";
    private static final int PICK = 1;

    private FrameLayout root;
    private WebView web;
    private TextView status;
    private ValueCallback<Uri[]> pending;
    private View customView;
    private WebChromeClient.CustomViewCallback customCb;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile boolean closing;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);

        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(16);
        status.setGravity(Gravity.CENTER);
        status.setVisibility(View.GONE); // only for an error: while the server starts the screen stays black, the web app's own loader follows
        root.addView(status, new FrameLayout.LayoutParams(-1, -1));

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setVisibility(View.INVISIBLE);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("127.0.0.1".equals(u.getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u)); // external links open in the browser
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (pending != null) pending.onReceiveValue(null);
                pending = cb;
                try {
                    // No type filter: createIntent() turns the page's ".gba,.nds,…" list into MIME types, and only ".zip"
                    // has one – the picker would then grey out every ROM. The page checks the extensions itself.
                    Intent pick = new Intent(Intent.ACTION_GET_CONTENT)
                            .addCategory(Intent.CATEGORY_OPENABLE)
                            .setType("*/*")
                            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                    startActivityForResult(pick, PICK);
                } catch (Exception e) {
                    pending = null;
                    return false;
                }
                return true;
            }

            @Override public void onShowCustomView(View v, CustomViewCallback cb) {
                customView = v;
                customCb = cb;
                root.addView(v, new FrameLayout.LayoutParams(-1, -1));
            }

            @Override public void onHideCustomView() {
                if (customView != null) root.removeView(customView);
                customView = null;
                if (customCb != null) customCb.onCustomViewHidden();
            }

            @Override public void onPermissionRequest(PermissionRequest r) { r.deny(); }
        });
        // for the page (loaded from the local server only – other addresses open in the browser): the files permission the
        // device search needs
        web.addJavascriptInterface(new FilesAccess(), "SouldewApp");
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        startForegroundService(new Intent(this, NodeService.class));
        waitForServer();
    }

    /** "All files access" (Android 11+) / the storage permission (older): what the device search needs to see game files. */
    private final class FilesAccess {
        @JavascriptInterface public boolean hasFilesAccess() {
            if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
            return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
        }

        /** The Android app's own version (android/version.properties), for Settings › About and bug reports. */
        @JavascriptInterface public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface public void requestFilesAccess() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT < 30) {
                    requestPermissions(new String[] {Manifest.permission.READ_EXTERNAL_STORAGE}, 2);
                    return;
                }
                try {
                    startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName())));
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)); // the list of all apps
                }
            });
        }
    }

    private void waitForServer() {
        new Thread(() -> {
            while (!closing) {
                if (NodeService.state < 0) {
                    final String msg = "souldew can't start: " + NodeService.error;
                    ui.post(() -> {
                        status.setText(msg);
                        status.setVisibility(View.VISIBLE);
                    });
                    return;
                }
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(URL_BASE + "api/status").openConnection();
                    c.setConnectTimeout(500);
                    c.setReadTimeout(1500);
                    int code = c.getResponseCode();
                    c.disconnect();
                    if (code > 0) {
                        ui.post(() -> {
                            if (closing) return;
                            status.setVisibility(View.GONE);
                            web.setVisibility(View.VISIBLE);
                            web.loadUrl(URL_BASE);
                        });
                        return;
                    }
                } catch (Exception ignore) {
                    // not up yet
                }
                try { Thread.sleep(400); } catch (InterruptedException e) { return; }
            }
        }, "wait-server").start();
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req == PICK && pending != null) {
            pending.onReceiveValue(res == RESULT_OK && data != null
                    ? WebChromeClient.FileChooserParams.parseResult(res, data) : null);
            pending = null;
        }
    }

    @Override public void onBackPressed() {
        if (customView != null) { web.getWebChromeClient().onHideCustomView(); return; }
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // keep the server running
    }

    @Override public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) immersive();
    }

    private void immersive() {
        getWindow().setDecorFitsSystemWindows(false);
        WindowInsetsController c = getWindow().getInsetsController();
        if (c != null) {
            c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
    }

    @Override protected void onPause() { super.onPause(); web.onPause(); web.pauseTimers(); }

    @Override protected void onResume() { super.onResume(); web.onResume(); web.resumeTimers(); }

    @Override protected void onDestroy() { closing = true; super.onDestroy(); }
}
