package com.distribox.distrilogmobile.prototype;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.MediaType;
import java.util.concurrent.TimeUnit;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native HTTPS connector. The local prototype never navigates to production HTML.
 * Only /api/ requests can reach the backend. Session cookies remain in Android's
 * app-private CookieManager, and the server remains the authorization authority.
 */
public final class BackendBridge {
    private final MainActivity activity;
    private final WebView webView;
    private final ExecutorService queue = Executors.newFixedThreadPool(4);
    private final SharedPreferences prefs;
    private final OkHttpClient http = new OkHttpClient.Builder().followRedirects(false)
        .followSslRedirects(false).connectTimeout(11, TimeUnit.SECONDS)
        .readTimeout(27, TimeUnit.SECONDS).build();
    private volatile String endpoint;

    public BackendBridge(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.prefs = activity.getSharedPreferences("distrilog_native_backend_v1", Context.MODE_PRIVATE);
        String saved = prefs.getString("endpoint", "");
        this.endpoint = validEndpoint(saved) ? saved : "";
    }

    @JavascriptInterface public String endpoint() {
        return endpoint;
    }

    @JavascriptInterface public boolean configure(String candidate) {
        String trimmed = candidate == null ? "" : candidate.trim().replaceAll("/+$", "");
        if (!validEndpoint(trimmed)) return false;
        if (!trimmed.equals(endpoint)) {
            // Never send credentials from one configured server to another.
            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
        }
        endpoint = trimmed;
        prefs.edit().putString("endpoint", trimmed).apply();
        return true;
    }

    private static boolean validEndpoint(String raw) {
        if (raw == null || raw.length() > 250) return false;
        try {
            URI u = new URI(raw);
            String host = u.getHost();
            if (!"https".equalsIgnoreCase(u.getScheme())
                    || host == null || u.getPort() != -1 || u.getUserInfo() != null
                    || u.getRawQuery() != null || u.getRawFragment() != null
                    || !(u.getRawPath() == null || u.getRawPath().isEmpty() || u.getRawPath().equals("/")))
                return false;
            host = host.toLowerCase(Locale.ROOT);
            return host.matches("[a-z0-9.-]+") && host.contains(".")
                && !host.startsWith("-") && !host.endsWith(".")
                && !host.contains("..") && !host.endsWith(".localhost")
                && !host.endsWith(".local") && !host.endsWith(".internal")
                && !host.matches("[0-9.]+");
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean validApiPath(String raw) {
        if (raw == null || raw.length() < 5 || raw.length() > 900
                || !raw.startsWith("/api/") || raw.startsWith("//")
                || raw.contains("\\") || raw.contains("\r") || raw.contains("\n"))
            return false;
        try {
            URI u = new URI(raw);
            String path = u.getPath();
            if (u.isAbsolute() || u.getHost() != null || u.getRawFragment() != null
                || path == null || !path.startsWith("/api/")
                || path.contains("..") || path.contains("//")
                || !raw.startsWith(path) && u.getRawPath() == null)
                return false;
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    @JavascriptInterface public void request(int id, String method, String path, String body) {
        if (id < 1 || id > 2_000_000_000) return;
        String m = method == null ? "" : method.toUpperCase(Locale.ROOT);
        if (!(m.equals("GET") || m.equals("POST") || m.equals("PATCH"))
                || !validApiPath(path) || endpoint.isEmpty()) {
            deliver(id, 0, false, null, "Endereço do servidor ou chamada inválidos.");
            return;
        }
        final String selectedEndpoint = endpoint;
        final String json = body == null ? "" : body;
        queue.execute(() -> performRequest(id, selectedEndpoint, m, path, json));
    }

    private void performRequest(int id, String host, String method, String path, String json) {
        try {
            Request.Builder builder = new Request.Builder()
                .url(host + path)
                .header("Accept", "application/json")
                .header("Accept-Encoding", "identity");
            String cookies = CookieManager.getInstance().getCookie(host);
            if (cookies != null && !cookies.isEmpty()) builder.header("Cookie", cookies);
            RequestBody body = null;
            if (!method.equals("GET")) {
                byte[] bytes = (json.isEmpty() ? "{}" : json).getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 512 * 1024) throw new IOException("Requisição excede tamanho máximo.");
                body = RequestBody.create(MediaType.parse("application/json; charset=utf-8"), bytes);
            }
            builder.method(method, body);
            try (Response response = http.newCall(builder.build()).execute()) {
                int status = response.code();
                for (String cookie : response.headers("Set-Cookie")) {
                    CookieManager.getInstance().setCookie(host, cookie);
                }
                CookieManager.getInstance().flush();
                String raw = readBounded(response.body() == null ? null : response.body().byteStream(), 5 * 1024 * 1024);
                Object data;
                try { data = raw.isEmpty() ? JSONObject.NULL : new JSONTokener(raw).nextValue(); }
                catch (Exception e) { throw new IOException("Resposta JSON inválida."); }
                String error = null;
                if (status < 200 || status >= 300) {
                    if (data instanceof JSONObject) {
                        Object detail = ((JSONObject) data).opt("detail");
                        error = detail instanceof String ? (String) detail : null;
                    }
                    if (error == null) error = "Falha HTTP " + status + ". Confira o sistema e tente novamente.";
                }
                deliver(id, status, status >= 200 && status < 300, data, error);
            }
        } catch (Exception e) {
            deliver(id, 0, false, null,
                "Não foi possível conversar com o DISTRILOG. Verifique sua internet e o Render.");
        }
    }

    private static String readBounded(InputStream in, int limit) throws IOException {
        if (in == null) return "";
        try (InputStream input = in; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int bytes;
            while ((bytes = input.read(buf)) != -1) {
                if (output.size() + bytes > limit) throw new IOException("Resposta excede tamanho máximo.");
                output.write(buf, 0, bytes);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private void deliver(int id, int status, boolean ok, Object data, String error) {
        try {
            JSONObject result = new JSONObject();
            result.put("id", id);
            result.put("status", status);
            result.put("ok", ok);
            result.put("data", data == null ? JSONObject.NULL : data);
            result.put("error", error == null ? JSONObject.NULL : error);
            String js = "window.DM_NATIVE_RESULT(" + result.toString() + ");";
            activity.runOnUiThread(() -> webView.evaluateJavascript(js, null));
        } catch (Exception ignored) { /* activity may have been destroyed */ }
    }

    @JavascriptInterface public void scan() { activity.launchScanner(); }

    public void close() { queue.shutdownNow(); }
}
