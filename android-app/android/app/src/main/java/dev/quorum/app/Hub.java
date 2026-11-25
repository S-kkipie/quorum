package dev.quorum.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import java.net.HttpURLConnection;
import java.net.URL;

/** The stored hub URL and the reachability check, shared by MainActivity and HubShellPlugin. */
final class Hub {

    /** The @capacitor/preferences group: the web app removes KEY_URL there on "Change hub". */
    static final String STORAGE = "CapacitorStorage";
    static final String KEY_URL = "hubUrl";
    /** The shell's own preferences: the last hub, to prefill the first-run page after "Change hub". */
    static final String SHELL = "QuorumShell";
    static final String KEY_LAST = "lastHubUrl";
    /** The hub's unauthenticated health route. */
    static final String HEALTH_PATH = "/api/ping";
    static final int TIMEOUT_MS = 5000;

    private Hub() {}

    static SharedPreferences storage(Context context) {
        return context.getSharedPreferences(STORAGE, Context.MODE_PRIVATE);
    }

    static SharedPreferences shell(Context context) {
        return context.getSharedPreferences(SHELL, Context.MODE_PRIVATE);
    }

    /** The stored hub origin, or null before the first run (or after "Change hub"). */
    static String stored(Context context) {
        return normalize(storage(context).getString(KEY_URL, null));
    }

    /**
     * Returns the origin (scheme://host[:port]) of an http:// or https:// URL, or null if it is not one.
     * The hub serves the app at "/", and Capacitor needs a bare origin for its allowed-origin rules.
     */
    static String normalize(String raw) {
        if (raw == null) return null;
        Uri u = Uri.parse(raw.trim());
        String scheme = u.getScheme();
        String host = u.getHost();
        if (scheme == null || host == null || host.isEmpty()) return null;
        scheme = scheme.toLowerCase();
        if (!scheme.equals("http") && !scheme.equals("https")) return null;
        if (host.contains(":")) host = "[" + host + "]"; // IPv6 literal
        int port = u.getPort();
        return scheme + "://" + host.toLowerCase() + (port > 0 ? ":" + port : "");
    }

    /** GET <hub>/api/ping. Returns the HTTP status, or 0 when the hub cannot be reached. Blocking. */
    static int ping(String hub) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(hub + HEALTH_PATH).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            return conn.getResponseCode();
        } catch (Exception e) {
            return 0;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static boolean reachable(int status) {
        return status >= 200 && status < 300;
    }
}
