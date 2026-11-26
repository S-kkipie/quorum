package dev.quorum.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Used by the bundled first-run page (www/index.html). Plugin methods run on Capacitor's plugin thread,
 * so the blocking reachability check does not touch the UI thread.
 */
@CapacitorPlugin(name = "HubShell")
public class HubShellPlugin extends Plugin {

    /** {hub, last}: the stored hub (null on the first run) and the one used before "Change hub". */
    @PluginMethod
    public void get(PluginCall call) {
        JSObject r = new JSObject();
        r.put("hub", Hub.stored(getContext()));
        r.put("last", Hub.normalize(Hub.shell(getContext()).getString(Hub.KEY_LAST, null)));
        call.resolve(r);
    }

    /** {url} -> {ok, status}: GET <url>/api/ping natively (no CORS or mixed-content rules apply). */
    @PluginMethod
    public void check(PluginCall call) {
        String hub = Hub.normalize(call.getString("url"));
        if (hub == null) {
            call.reject("The URL must start with http:// or https://");
            return;
        }
        int status = Hub.ping(hub);
        JSObject r = new JSObject();
        r.put("ok", Hub.reachable(status));
        r.put("status", status);
        call.resolve(r);
    }

    /** {url}: stores the hub; MainActivity sees the change and restarts with the hub as its server URL. */
    @PluginMethod
    public void save(PluginCall call) {
        String hub = Hub.normalize(call.getString("url"));
        if (hub == null) {
            call.reject("The URL must start with http:// or https://");
            return;
        }
        Hub.storage(getContext()).edit().putString(Hub.KEY_URL, hub).commit();
        call.resolve();
    }

    /** {url}: opens an http(s) URL in the device's browser (an ACTION_VIEW intent). */
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            call.reject("The URL must start with http:// or https://");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app can open this link");
        }
    }
}
