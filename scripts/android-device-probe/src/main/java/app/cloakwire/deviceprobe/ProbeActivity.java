package app.cloakwire.deviceprobe;

import android.app.Activity;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** Separate UID: unlike Cloakwire's excluded WebView, this measures ordinary app traffic.
 * Only fixed HTTPS test endpoints, no user profiles, raw errors, IPs or response bodies on disk.
 * This is an explicit device-test APK, never a product dependency.
 */
public final class ProbeActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Set<HttpsURLConnection> sockets = ConcurrentHashMap.newKeySet();
    private volatile boolean cancelled;
    private TextView text;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        text = new TextView(this);
        text.setPadding(32, 64, 32, 32);
        text.setText("Checking HTTPS and Android VPN routing…");
        setContentView(text);
        new File(getFilesDir(), "result.json").delete();
        worker.execute(this::runCheck);
    }
    private NetworkCapabilities caps(ConnectivityManager cm, Network n) {
        return n == null ? null : cm.getNetworkCapabilities(n);
    }
    private void runCheck() {
        JSONObject result = new JSONObject();
        try {
            ConnectivityManager cm = getSystemService(ConnectivityManager.class);
            Network initial = cm.getActiveNetwork();
            NetworkCapabilities nc = caps(cm, initial);
            result.put("defaultIsVpn", nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
            Network physical = null;
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities c = caps(cm, n);
                if (c == null || !c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ||
                    !c.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)) continue;
                if (physical == null || c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) physical = n;
                if (c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) break;
            }
            result.put("https204", request(null, "https://www.gstatic.com/generate_204", 204, false) != null);
            if (getIntent().getBooleanExtra("compareEgress", false)) {
            String routed = request(null, "https://www.cloudflare.com/cdn-cgi/trace", 200, true);
            String direct = physical == null ? null :
                request(physical, "https://www.cloudflare.com/cdn-cgi/trace", 200, true);
            result.put("defaultTraceOk", routed != null);
            result.put("physicalTraceOk", direct != null);
            if (routed != null && direct != null) result.put("egressDiffers", !routed.equals(direct));
            }
            result.put("networkUnchanged", initial != null && initial.equals(cm.getActiveNetwork()));
        } catch (Exception e) {
            try { result.put("unavailable", true); } catch (Exception ignored) {}
        }
        if (cancelled) return;
        String report = result.toString();
        try (java.io.FileOutputStream out = openFileOutput("result.json", MODE_PRIVATE)) {
            out.write(report.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { return; }
        runOnUiThread(() -> { if (!cancelled) text.setText(report); });
    }
    private String request(Network network, String target, int expected, boolean trace) {
        HttpsURLConnection c = null;
        try {
            if (cancelled) return null;
            URL url = new URL(target);
            c = (HttpsURLConnection) (network == null ? url.openConnection(java.net.Proxy.NO_PROXY) :
                network.openConnection(url, java.net.Proxy.NO_PROXY));
            sockets.add(c);
            c.setConnectTimeout(5000);
            c.setReadTimeout(5000);
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            c.setRequestProperty("Connection", "close");
            if (c.getResponseCode() != expected) return null;
            if (!trace) return "";
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] bytes = new byte[512];
                int count;
                while (!cancelled && (count = in.read(bytes)) >= 0) {
                    if (out.size() + count > 4096) return null;
                    out.write(bytes, 0, count);
                }
            }
            String body = new String(out.toByteArray(), StandardCharsets.UTF_8);
            if (!body.contains("h=www.cloudflare.com\n")) return null;
            for (String line : body.split("\n")) {
                if (line.startsWith("ip=")) {
                    String ip = line.substring(3).trim();
                    if (ip.matches("[0-9a-fA-F:.]{3,64}")) return ip;
                }
            }
            return null;
        } catch (Exception ignored) { return null; }
        finally { if (c != null) { sockets.remove(c); c.disconnect(); } }
    }
    @Override public void onDestroy() {
        cancelled = true;
        sockets.forEach(HttpsURLConnection::disconnect);
        worker.shutdownNow();
        super.onDestroy();
    }
}
