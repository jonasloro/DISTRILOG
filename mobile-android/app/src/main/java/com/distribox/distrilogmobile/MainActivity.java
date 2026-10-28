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

        String saved = getPreferences(MODE_PRIVATE).getString(PREFS, "");
        if (validServer(saved)) {
            openServer(saved);
        } else {
            configureServer();
        }
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
