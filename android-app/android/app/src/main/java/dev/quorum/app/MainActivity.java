package dev.quorum.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;
import com.getcapacitor.Logger;
import com.getcapacitor.WebViewListener;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import org.json.JSONObject;

/**
 * The Quorum shell. Two modes, chosen in onCreate from the stored hub URL:
 *
 * - First run (no hub stored): the default config from capacitor.config.json, which serves the bundled
 *   www/index.html at https://localhost. That page asks for the hub URL and stores it through HubShellPlugin.
 * - Hub: a CapConfig built here with server.url set to the hub origin. Capacitor then loads the hub and
 *   injects its bridge into documents of that origin (WebViewCompat.addDocumentStartJavaScript with the
 *   server URL's origin, and the androidBridge message listener allows that origin too), so the web app
 *   served by the hub sees window.Capacitor.isNativePlatform() === true and can use the native plugins.
 *   If the hub cannot be loaded, the bundled www/offline.html is shown (server.errorPath, plus a parallel
 *   /api/ping probe so an unreachable tailnet does not wait for the WebView's own timeout).
 *
 * The hub URL lives in the @capacitor/preferences storage (SharedPreferences "CapacitorStorage", key
 * "hubUrl"), so the web app's "Change hub" (Preferences.remove) and the first-run page share it with this
 * class. Any change to it restarts the activity in the matching mode.
 */
public class MainActivity extends BridgeActivity {

    static final String CHANNEL_ID = "sessions";
    static final String CHANNEL_NAME = "Sessions";
    static final String ERROR_PATH = "offline.html";
    static final String SHELL_SCHEME = "quorum-shell";

    /** The hub this instance runs, or null in first-run mode. */
    private String hub;
    private boolean restarting;
    private volatile boolean hubLoaded;
    private SharedPreferences storage;
    // Held in a field: SharedPreferences keeps its listeners in a weak map.
    private final SharedPreferences.OnSharedPreferenceChangeListener onStorage = (prefs, key) -> {
        if (key != null && !Hub.KEY_URL.equals(key)) return;
        if (!Objects.equals(Hub.stored(this), hub)) restart();
    };

    static final String KEY_PUSH = "pushAvailable";

    /** True when the APK was built with google-services.json (its plugin generates google_app_id). */
    private boolean pushAvailable() {
        return getResources().getIdentifier("google_app_id", "string", getPackageName()) != 0;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(HubShellPlugin.class);
        createNotificationChannel();
        storage = Hub.storage(this);
        // The web app reads this before registering for push: without google-services.json there is no
        // Firebase, and PushNotifications.register() would crash the app.
        storage.edit().putString(KEY_PUSH, pushAvailable() ? "true" : "false").apply();
        hub = Hub.stored(this);
        if (hub != null) config = hubConfig(hub);
        super.onCreate(savedInstanceState);
        storage.registerOnSharedPreferenceChangeListener(onStorage);
        if (bridge == null) return; // no WebView on this device: BridgeActivity shows its own error layout
        bridge.setWebViewClient(new ShellWebViewClient());
        if (hub != null) probeHub();
    }

    @Override
    public void onDestroy() {
        if (storage != null) storage.unregisterOnSharedPreferenceChangeListener(onStorage);
        super.onDestroy();
    }

    /** Server URL = the hub; the plugin settings still come from the bundled capacitor.config.json. */
    private CapConfig hubConfig(String hub) {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        return new CapConfig.Builder(this)
            .setServerUrl(hub)
            .setErrorPath(ERROR_PATH)
            // The hub is plain http on the tailnet; the page is on that origin, this only relaxes subresources.
            .setAllowMixedContent(true)
            .setWebContentsDebuggingEnabled(debuggable)
            .setLoggingEnabled(debuggable)
            .setPluginsConfiguration(bundledPluginsConfig())
            .create();
    }

    private JSONObject bundledPluginsConfig() {
        try (InputStream in = getAssets().open("capacitor.config.json")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            JSONObject plugins = new JSONObject(out.toString(StandardCharsets.UTF_8.name())).optJSONObject("plugins");
            return plugins != null ? plugins : new JSONObject();
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /**
     * Pings the hub while the WebView loads it. If the ping fails before the hub page has loaded, the
     * fallback page is shown right away. The stored hub URL is kept either way.
     */
    private void probeHub() {
        final String target = hub;
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                String url = webView.getUrl();
                if (url != null && url.startsWith(target)) hubLoaded = true;
            }
        });
        Thread t = new Thread(() -> {
            if (Hub.reachable(Hub.ping(target))) return;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || restarting || hubLoaded || bridge == null) return;
                String errorUrl = bridge.getErrorUrl();
                WebView webView = bridge.getWebView();
                if (errorUrl == null || errorUrl.equals(webView.getUrl())) return;
                webView.stopLoading();
                webView.loadUrl(errorUrl);
            });
        }, "quorum-hub-probe");
        t.setDaemon(true);
        t.start();
    }

    /** Starts over in the mode that matches the stored hub URL. */
    private void restart() {
        if (restarting || isFinishing()) return;
        restarting = true;
        if (hub != null && Hub.stored(this) == null) {
            // "Change hub": remember the old one to prefill the first-run page.
            Hub.shell(this).edit().putString(Hub.KEY_LAST, hub).apply();
        }
        runOnUiThread(this::recreate);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("A session needs you or has finished");
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(channel);
    }

    /**
     * The fallback page is not on the hub origin, so the bridge is not injected there; its Retry and
     * Change hub buttons navigate to quorum-shell://retry and quorum-shell://change-hub instead.
     */
    private class ShellWebViewClient extends BridgeWebViewClient {

        ShellWebViewClient() {
            super(bridge);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!SHELL_SCHEME.equals(url.getScheme())) return super.shouldOverrideUrlLoading(view, request);
            String action = url.getHost();
            if ("retry".equals(action)) {
                restart();
            } else if ("change-hub".equals(action)) {
                storage.edit().remove(Hub.KEY_URL).commit(); // the listener restarts in first-run mode
            } else {
                Logger.warn("Quorum", "unknown shell link: " + url);
            }
            return true;
        }
    }
}
