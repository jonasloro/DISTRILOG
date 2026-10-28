package com.distribox.distrilogmobile.prototype;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.content.Intent;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebChromeClient;
import android.view.WindowManager;
import android.widget.Toast;
import androidx.webkit.WebViewAssetLoader;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
    private WebView page;
    private BackendBridge bridge;
    private final String origin = "https://appassets.androidplatform.net";
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(13,18,21));
        getWindow().setNavigationBarColor(Color.rgb(13,18,21));
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        page = new WebView(this);
        page.setBackgroundColor(Color.rgb(13,18,21));
        page.getSettings().setJavaScriptEnabled(true);
        page.getSettings().setDomStorageEnabled(true);
        page.getSettings().setAllowFileAccess(false);
        page.getSettings().setAllowContentAccess(false);
        page.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
        page.getSettings().setSupportMultipleWindows(false);
        page.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        page.getSettings().setMediaPlaybackRequiresUserGesture(true);
        page.setWebChromeClient(new WebChromeClient());
        CookieManager.getInstance().setAcceptCookie(true);
        bridge = new BackendBridge(this, page);
        page.addJavascriptInterface(bridge, "DISTRILOG");
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
        page.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                if (origin.equals(req.getUrl().getScheme()+"://"+req.getUrl().getHost())) {
                    return assetLoader.shouldInterceptRequest(req.getUrl());
                }
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked",
                    java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return !(origin.equals(req.getUrl().getScheme()+"://"+req.getUrl().getHost())
                    && req.getUrl().getPath().startsWith("/assets/mobile/"));
            }
        });
        setContentView(page);
        page.loadUrl(origin+"/assets/mobile/index.html");
    }
    public void launchScanner() {
        runOnUiThread(() -> new IntentIntegrator(MainActivity.this)
            .setDesiredBarcodeFormats(IntentIntegrator.ALL_CODE_TYPES)
            .setPrompt("Leia o QR ou código da Rack do DISTRILOG")
            .setBeepEnabled(false)
            .setOrientationLocked(false)
            .initiateScan());
    }
    public void emitScan(String code) {
        runOnUiThread(() -> {
            if (page != null) page.evaluateJavascript("window.DM_SCAN_RETURN("+JSONObject.quote(code)+")", null);
        });
    }
    @Override protected void onActivityResult(int req, int result, Intent data) {
        IntentResult scan = IntentIntegrator.parseActivityResult(req, result, data);
        if (scan != null) {
            emitScan(scan.getContents() == null ? "" : scan.getContents());
        } else super.onActivityResult(req, result, data);
    }
    @Override public void onBackPressed() {
        if (page != null) page.evaluateJavascript("window.DM_BACK && window.DM_BACK()", null);
        else super.onBackPressed();
    }
    @Override protected void onDestroy() {
        if (bridge != null) bridge.close();
        if (page != null) { page.removeJavascriptInterface("DISTRILOG"); page.destroy(); page = null; }
        super.onDestroy();
    }
}
