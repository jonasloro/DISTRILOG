package com.distribox.distrilogmobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.content.ActivityNotFoundException;
import android.content.pm.PackageInfo;
import android.provider.Settings;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import org.json.JSONObject;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String PREFS = "distrilog_mobile_settings";
    private static final int REQUEST_FILES = 8701;
    private static final int REQUEST_CAMERA = 8702;
    private static final String UPDATE_URL = "https://raw.githubusercontent.com/jonasloro/DISTRILOG/mobile-apk-homologacao/mobile-android/update.json";
    private static final int REQUEST_INSTALL = 8703;
    private volatile boolean checkingUpdate;
    private WebView webView;
    private TextView status;
    private String baseUrl;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(14, 21, 18));
        getWindow().setNavigationBarColor(Color.rgb(14, 21, 18));
        getWindow().getDecorView().setSystemUiVisibility(0);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(14, 21, 18));

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(10), dp(9), dp(10), dp(9));

        TextView title = new TextView(this);
        title.setText("DISTRILOG");
        title.setTextColor(Color.WHITE);
        title.setTextSize(19);
        title.setTypeface(null, 1);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(46), 1f));
        addButton(toolbar, "QR", () -> scanQr());
        addButton(toolbar, "↻", () -> { if (webView != null && baseUrl != null) webView.reload(); });
        addButton(toolbar, "⚙", () -> configureServer());
        root.addView(toolbar);

        status = new TextView(this);
        status.setTextColor(Color.rgb(190, 214, 200));
        status.setTextSize(12);
        status.setPadding(dp(14), dp(8), dp(14), dp(8));
        status.setText("Configure o endereço HTTPS do DISTRILOG no Render.");
        root.addView(status);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(true);
        webView.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
        webView.getSettings().setSupportMultipleWindows(false);
        webView.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String next = request.getUrl().toString();
                if (isAllowedPage(next)) return false;
                if ("https".equalsIgnoreCase(request.getUrl().getScheme())) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                    } catch (Exception ignored) {
                        Toast.makeText(MainActivity.this, "Não foi possível abrir o endereço.", Toast.LENGTH_SHORT).show();
                    }
                }
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (isAllowedPage(url)) status.setVisibility(View.GONE);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest req, android.webkit.WebResourceError error) {
                if (req.isForMainFrame()) {
                    status.setVisibility(View.VISIBLE);
                    status.setText("Não foi possível conectar ao DISTRILOG. Confira o endereço, o Render e sua internet.");
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                   FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    startActivityForResult(intent, REQUEST_FILES);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!isAllowedPage(request.getOrigin().toString())) {
                        request.deny();
                        return;
                    }
                    boolean needsCamera = false;
                    for (String r : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) needsCamera = true;
                    }
                    if (!needsCamera) { request.deny(); return; }
                    if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                        pendingPermission = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA);
                        return;
                    }
                    request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                });
            }
        });
        root.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1f));
        setContentView(root);
        checkForUpdates();

        String saved = getPreferences(MODE_PRIVATE).getString(PREFS, "");
        if (validServer(saved)) {
            openServer(saved);
        } else {
            configureServer();
        }
    }


    private void checkForUpdates() {
        if (checkingUpdate) return;
        checkingUpdate = true;
        new Thread(() -> {
            try {
                HttpURLConnection conn = (HttpURLConnection)new URL(UPDATE_URL).openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setInstanceFollowRedirects(true);
                if (conn.getResponseCode() != 200) throw new IllegalStateException("Manifesto indisponível");
                byte[] data;
                try (InputStream in = conn.getInputStream()) { data = readLimited(in, 16384); }
                conn.disconnect();
                JSONObject manifest = new JSONObject(new String(data, java.nio.charset.StandardCharsets.UTF_8));
                int remoteCode = manifest.getInt("versionCode");
                int localCode = getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
                if (remoteCode <= localCode) return;
                String apkUrl = manifest.getString("apkUrl");
                String checksum = manifest.getString("sha256");
                boolean mandatory = manifest.optBoolean("mandatory", false);
                if (!apkUrl.startsWith("https://") || !checksum.matches("[a-fA-F0-9]{64}"))
                    throw new SecurityException("Metadados inválidos");
                runOnUiThread(() -> new AlertDialog.Builder(this)
                    .setTitle("Atualização disponível")
                    .setMessage("Versão " + manifest.optString("versionName", String.valueOf(remoteCode))
                        + " disponível. Deseja baixar e instalar?" + (mandatory ? "\\nAtualização obrigatória para novas operações." : ""))
                    .setCancelable(!mandatory)
                    .setPositiveButton("Baixar", (d, w) -> downloadUpdate(apkUrl, checksum))
                    .setNegativeButton(mandatory ? "Sair" : "Depois", (d, w) -> { if (mandatory) finish(); })
                    .show()));
            } catch (Exception e) {
                android.util.Log.w("DistrilogUpdate", "Verificação indisponível", e);
            } finally { checkingUpdate = false; }
        }).start();
    }

    private static byte[] readLimited(InputStream input, int max) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = input.read(buffer)) != -1) {
            if (out.size() + n > max) throw new java.io.IOException("Resposta excede limite");
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }

    private void downloadUpdate(String url, String sha256) {
        status.setVisibility(View.VISIBLE);
        status.setText("Baixando atualização...");
        new Thread(() -> {
            File apk = new File(getCacheDir(), "distrilog-update.apk");
            try {
                HttpURLConnection conn = (HttpURLConnection)new URL(url).openConnection();
                conn.setConnectTimeout(12000);
                conn.setReadTimeout(30000);
                if (conn.getResponseCode() != 200) throw new java.io.IOException("Download HTTP " + conn.getResponseCode());
                long length = conn.getContentLengthLong();
                if (length > 150L * 1024 * 1024) throw new java.io.IOException("APK muito grande");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long total = 0;
                try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buffer = new byte[16384];
                    int n;
                    while ((n = in.read(buffer)) != -1) {
                        total += n;
                        if (total > 150L * 1024 * 1024) throw new java.io.IOException("APK excede limite");
                        digest.update(buffer, 0, n);
                        out.write(buffer, 0, n);
                    }
                }
                conn.disconnect();
                StringBuilder hex = new StringBuilder();
                for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b & 0xff));
                if (!hex.toString().equalsIgnoreCase(sha256)) throw new SecurityException("Assinatura de integridade incorreta");
                Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                runOnUiThread(() -> {
                    status.setText("Atualização baixada. Confirme a instalação no Android.");
                    try { startActivity(install); }
                    catch (Exception e) { Toast.makeText(this, "Não foi possível abrir o instalador.", Toast.LENGTH_LONG).show(); }
                });
            } catch (Exception e) {
                apk.delete();
                android.util.Log.e("DistrilogUpdate", "Falha ao atualizar", e);
                runOnUiThread(() -> {
                    status.setText("Não foi possível baixar ou validar a atualização.");
                    Toast.makeText(this, "Atualização indisponível. Tente novamente.", Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    private int dp(int value) { return (int)(value * getResources().getDisplayMetrics().density + 0.5f); }

    private void addButton(LinearLayout bar, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(14);
        button.setAllCaps(false);
        button.setOnClickListener(v -> action.run());
        bar.addView(button, new LinearLayout.LayoutParams(dp(54), dp(46)));
    }

    private boolean validServer(String address) {
        if (address == null || address.length() > 255) return false;
        try {
            URI u = new URI(address.trim());
            String host = u.getHost();
            return "https".equalsIgnoreCase(u.getScheme()) && host != null &&
                   host.matches("[A-Za-z0-9.-]+") && host.contains(".") &&
                   !host.toLowerCase(Locale.ROOT).endsWith(".local") &&
                   u.getPort() == -1 && u.getUserInfo() == null &&
                   (u.getRawPath() == null || u.getRawPath().isEmpty() || "/".equals(u.getRawPath())) &&
                   u.getRawQuery() == null && u.getRawFragment() == null;
        } catch (URISyntaxException ex) { return false; }
    }

    private boolean isAllowedPage(String next) {
        if (baseUrl == null) return false;
        try {
            URI expected = new URI(baseUrl);
            URI target = new URI(next);
            return "https".equalsIgnoreCase(target.getScheme()) &&
                    expected.getHost().equalsIgnoreCase(target.getHost()) &&
                    target.getPort() == -1 && target.getUserInfo() == null;
        } catch (URISyntaxException ex) { return false; }
    }

    private void configureServer() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setHint("https://SEU-SERVICO.onrender.com");
        String last = getPreferences(MODE_PRIVATE).getString(PREFS, "");
        input.setText(last);
        LinearLayout panel = new LinearLayout(this);
        panel.setPadding(dp(20), dp(8), dp(20), dp(2));
        panel.addView(input);
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle("Conectar ao DISTRILOG")
            .setMessage("Digite a URL HTTPS do sistema no Render. Use sua conta normal do DISTRILOG para entrar.")
            .setView(panel)
            .setCancelable(baseUrl != null)
            .setNegativeButton(baseUrl == null ? "Fechar" : "Cancelar", (d, w) -> {
                if (baseUrl == null) finish();
            })
            .setPositiveButton("Conectar", null)
            .create();
        dialog.setOnShowListener(v -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(btn -> {
            String address = input.getText().toString().trim();
            if (!validServer(address)) {
                input.setError("Informe um endereço HTTPS público, sem caminho ou parâmetros.");
                return;
            }
            openServer(address);
            dialog.dismiss();
        }));
        dialog.show();
    }

    private void openServer(String address) {
        baseUrl = address.replaceAll("/+$", "");
        getPreferences(MODE_PRIVATE).edit().putString(PREFS, baseUrl).apply();
        status.setVisibility(View.VISIBLE);
        status.setText("Conectando ao DISTRILOG...");
        webView.loadUrl(baseUrl + "/");
    }

    private void scanQr() {
        new IntentIntegrator(this)
            .setDesiredBarcodeFormats(java.util.Collections.singletonList("QR_CODE"))
            .setPrompt("Aponte a câmera para a etiqueta Rack ou endereço WMS")
            .setBeepEnabled(false)
            .setOrientationLocked(true)
            .initiateScan();
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == REQUEST_FILES) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
                fileCallback = null;
            }
            return;
        }
        IntentResult scanned = IntentIntegrator.parseActivityResult(code, result, data);
        if (scanned != null && scanned.getContents() != null) {
            String qr = scanned.getContents();
            ClipboardManager clipboard = (ClipboardManager)getSystemService(CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText("Código Rack/WMS", qr));
            new AlertDialog.Builder(this)
                .setTitle("QR lido")
                .setMessage(qr + "\n\nO código foi copiado. Cole no campo correspondente do DISTRILOG. Nenhuma movimentação foi executada automaticamente.")
                .setPositiveButton("OK", null)
                .show();
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == REQUEST_CAMERA && pendingPermission != null) {
            PermissionRequest permission = pendingPermission;
            pendingPermission = null;
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                permission.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else permission.deny();
        }
    }

    @Override public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (webView != null) {
            CookieManager.getInstance().flush();
            webView.destroy();
        }
        super.onDestroy();
    }
}
