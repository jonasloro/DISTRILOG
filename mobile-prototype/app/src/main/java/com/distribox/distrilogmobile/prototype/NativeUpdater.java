package com.distribox.distrilogmobile.prototype;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * Signed APK updater for company-managed sideload installs.
 *
 * Only DISTRILOG's public GitHub Releases channel is considered.
 * The APK is checked for matching package name, an INCREASED versionCode
 * and exactly the same APK signing certificate before offering installation.
 * Never downloads to public storage and never installs silently.
 */
public final class NativeUpdater {
    private static final String RELEASES_API =
        "https://api.github.com/repos/jonasloro/DISTRILOG/releases?per_page=30";
    private static final String RELEASE_URL =
        "https://github.com/jonasloro/DISTRILOG/releases/download/";
    private static final String ASSET_NAME = "DISTRILOG-Mobile-PROTOTIPO-INTEGRADO.apk";
    private static final String HASH_NAME = ASSET_NAME + ".sha256";
    private static final Pattern RELEASE_TAG =
        Pattern.compile("^mobile-prototipo-(\\d+)\\.(\\d+)\\.(\\d+)$");
    private static final Pattern PILOT_TAG =
        Pattern.compile("^mobile-piloto-(\\\\d+)\\\\.(\\\\d+)\\\\.(\\\\d+)$");
    private static final Pattern VERSION =
        Pattern.compile("(\\d+)\\.(\\d+)\\.(\\d+)");
    private static final Pattern CHECKSUM = Pattern.compile("^([0-9a-fA-F]{64})\\s+\\*?DISTRILOG-Mobile-PROTOTIPO-INTEGRADO\\.apk\\s*$");
    private static final long MAX_APK_BYTES = 80L * 1024 * 1024;
    private final MainActivity activity;
    private final WebView view;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final AtomicBoolean working = new AtomicBoolean(false);
    private final OkHttpClient http = new OkHttpClient.Builder()
        .followRedirects(true).followSslRedirects(false)
        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(45, java.util.concurrent.TimeUnit.SECONDS)
        .build();
    private volatile Release latest;
    private volatile File downloaded;

    static final class Release {
        final String tag;
        final String name;
        final long size;
        final boolean checksumAvailable;
        Release(String tag, String name, long size, boolean checksumAvailable) {
            this.tag = tag;
            this.name = name;
            this.size = size;
            this.checksumAvailable = checksumAvailable;
        }
        String url(String filename) { return RELEASE_URL + tag + "/" + filename; }
    }

    NativeUpdater(MainActivity activity, WebView view) {
        this.activity = activity;
        this.view = view;
    }

    String installedVersion() {
        try {
            PackageInfo info = activity.getPackageManager()
                .getPackageInfo(activity.getPackageName(), 0);
            return info.versionName == null ? "Desconhecida" : info.versionName;
        } catch (Exception e) {
            return "Desconhecida";
        }
    }

    private long installedCode() throws Exception {
        PackageInfo info = activity.getPackageManager()
            .getPackageInfo(activity.getPackageName(), 0);
        return code(info);
    }

    private static long code(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private void emit(String type, String message, int percent, String version) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", type);
            event.put("message", message);
            event.put("percent", percent);
            event.put("version", version == null ? "" : version);
            activity.runOnUiThread(() -> {
                if (view.getParent() != null) {
                    view.evaluateJavascript("window.DM_UPDATE_EVENT && window.DM_UPDATE_EVENT(" +
                        event.toString() + ");", null);
                }
            });
        } catch (Exception ignored) {
            // The activity may have been destroyed while downloading.
        }
    }

    private void runExclusive(Runnable action) {
        if (!working.compareAndSet(false, true)) {
            emit("error", "Já existe uma verificação ou download em andamento.", 0, null);
            return;
        }
        io.execute(() -> {
            try { action.run(); }
            finally { working.set(false); }
        });
    }

    void check() {
        runExclusive(() -> {
            emit("checking", "Procurando atualizações oficiais do DISTRILOG...", 0, null);
            try {
                JSONArray releases;
                Request req = new Request.Builder().url(RELEASES_API)
                    .header("Accept", "application/vnd.github+json")
                    .header("User-Agent", "DISTRILOG-Mobile-Android")
                    .build();
                try (Response response = http.newCall(req).execute()) {
                    if (!response.isSuccessful() || response.body() == null) {
                        throw new IllegalStateException("O GitHub não respondeu (HTTP " + response.code() + ").");
                    }
                    if (response.body().contentLength() > 1024 * 1024) {
                        throw new IllegalStateException("Catálogo de versões muito grande.");
                    }
                    releases = new JSONArray(response.body().string());
                }
                Release best = null;
                Release pilotBest = null;
                for (int i = 0; i < releases.length(); i++) {
                    JSONObject entry = releases.optJSONObject(i);
                    if (entry == null || entry.optBoolean("draft")) continue;
                    String tag = entry.optString("tag_name", "");
                    boolean signedChannel = RELEASE_TAG.matcher(tag).matches();
                    boolean pilotChannel = PILOT_TAG.matcher(tag).matches();
                    if (!signedChannel && !pilotChannel) continue;
                    JSONArray assets = entry.optJSONArray("assets");
                    if (assets == null) continue;
                    boolean apk = false;
                    boolean checksum = false;
                    long size = 0;
                    for (int j = 0; j < assets.length(); j++) {
                        JSONObject a = assets.optJSONObject(j);
                        if (a == null) continue;
                        String name = a.optString("name", "");
                        if (ASSET_NAME.equals(name)) {
                            long bytes = a.optLong("size", 0);
                            String url = a.optString("browser_download_url", "");
                            if (bytes > 0 && bytes <= MAX_APK_BYTES
                                && url.equals(RELEASE_URL + tag + "/" + ASSET_NAME)) {
                                apk = true;
                                size = bytes;
                            }
                        }
                        if (HASH_NAME.equals(name) &&
                            a.optString("browser_download_url", "")
                                .equals(RELEASE_URL + tag + "/" + HASH_NAME)) {
                            checksum = true;
                        }
                    }
                    if (!apk || !checksum) continue; // Only verified channels.
                    if (signedChannel && (best == null || compareTags(tag, best.tag) > 0)) {
                        best = new Release(tag, entry.optString("name", tag), size, true);
                    }
                    if (pilotChannel && (pilotBest == null || compareTags(tag, pilotBest.tag) > 0)) {
                        pilotBest = new Release(tag, entry.optString("name", tag), size, true);
                    }
                }
                String current = installedVersion();
                if (best == null || compareVersions(best.tag, current) <= 0) {
                    latest = null;
                    downloaded = null;
                    if (pilotBest != null && compareVersions(pilotBest.tag, current) > 0) {
                        String version = pilotBest.tag.replace("mobile-piloto-", "");
                        emit("pilot", "Existe uma versão piloto " + version + ", mas ela foi assinada com chave temporária. " +
                            "Não é possível instalar por cima da versão atual. Para atualização pelo próprio aplicativo, " +
                            "a empresa precisa primeiro configurar uma chave permanente no GitHub Actions.", 0, version);
                    } else {
                        emit("current", "Nenhuma atualização assinada compatível disponível (" + current + ").", 100, current);
                    }
                } else {
                    latest = best;
                    downloaded = null;
                    String version = best.tag.replace("mobile-prototipo-", "");
                    emit("available", "Nova versão " + version + " disponível. Baixe dentro do aplicativo.", 0, version);
                }
            } catch (Exception ex) {
                emit("error", "Não foi possível consultar as atualizações: " + ex.getMessage(), 0, null);
            }
        });
    }

    private static int compareTags(String a, String b) {
        return compareVersions(a, b);
    }

    static int compareVersions(String a, String b) {
        Matcher left = VERSION.matcher(a == null ? "" : a);
        Matcher right = VERSION.matcher(b == null ? "" : b);
        if (!left.find() || !right.find()) return -1;
        for (int i = 1; i <= 3; i++) {
            int x = Integer.parseInt(left.group(i));
            int y = Integer.parseInt(right.group(i));
            if (x != y) return Integer.compare(x, y);
        }
        return 0;
    }

    private void checkTrustedDownloadUrl(Response response) throws Exception {
        Uri u = Uri.parse(response.request().url().toString());
        String host = u.getHost();
        if (!"https".equalsIgnoreCase(u.getScheme())
            || host == null || !(host.equals("github.com") || host.equals("objects.githubusercontent.com")
            || host.equals("release-assets.githubusercontent.com") ||
            host.endsWith(".githubusercontent.com"))) {
            throw new SecurityException("O download foi redirecionado a um domínio não autorizado.");
        }
    }

    private String expectedSha256(Release release) throws Exception {
        Request request = new Request.Builder().url(release.url(HASH_NAME))
            .header("User-Agent", "DISTRILOG-Mobile-Android").build();
        try (Response response = http.newCall(request).execute()) {
            checkTrustedDownloadUrl(response);
            if (!response.isSuccessful() || response.body() == null ||
                response.body().contentLength() > 2048) {
                throw new IllegalStateException("Não foi possível verificar o checksum oficial.");
            }
            String text = response.body().string().trim();
            Matcher m = CHECKSUM.matcher(text);
            if (!m.matches()) throw new SecurityException("Checksum oficial inválido.");
            return m.group(1).toLowerCase(Locale.ROOT);
        }
    }

    void download() {
        Release release = latest;
        if (release == null) {
            emit("error", "Primeiro use 'Verificar atualizações'.", 0, null);
            return;
        }
        runExclusive(() -> {
            File temp = null;
            try {
                emit("downloading", "Preparando download seguro...", 0,
                    release.tag.replace("mobile-prototipo-", ""));
                final String expectedSha = expectedSha256(release);
                File dir = new File(activity.getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Sem espaço para criar área temporária.");
                temp = new File(dir, "distrilog-download.part");
                File finalFile = new File(dir, "distrilog-" + release.tag + ".apk");
                if (temp.exists() && !temp.delete()) throw new IllegalStateException("Não foi possível reiniciar o download.");
                Request req = new Request.Builder().url(release.url(ASSET_NAME))
                    .header("User-Agent", "DISTRILOG-Mobile-Android").build();
                try (Response response = http.newCall(req).execute()) {
                    checkTrustedDownloadUrl(response);
                    if (!response.isSuccessful() || response.body() == null) {
                        throw new IllegalStateException("Falha ao baixar APK (HTTP " + response.code() + ").");
                    }
                    long size = response.body().contentLength();
                    if (size > MAX_APK_BYTES || (size > 0 && size != release.size)) {
                        throw new SecurityException("Tamanho de download inesperado.");
                    }
                    MessageDigest sha = MessageDigest.getInstance("SHA-256");
                    long count = 0;
                    int prev = -1;
                    try (InputStream input = response.body().byteStream();
                         FileOutputStream out = new FileOutputStream(temp)) {
                        byte[] block = new byte[16384];
                        int n;
                        while ((n = input.read(block)) != -1) {
                            count += n;
                            if (count > MAX_APK_BYTES) throw new SecurityException("APK excede limite permitido.");
                            out.write(block, 0, n);
                            sha.update(block, 0, n);
                            int percent = (int)Math.min(100, 100 * count / release.size);
                            if (percent != prev && (percent % 5 == 0 || percent == 100)) {
                                emit("downloading", "Baixando versão oficial...", percent, null);
                                prev = percent;
                            }
                        }
                        out.getFD().sync();
                    }
                    if (count != release.size) throw new SecurityException("APK incompleto.");
                    StringBuilder actual = new StringBuilder();
                    for (byte by : sha.digest()) actual.append(String.format(Locale.ROOT, "%02x", by & 0xff));
                    if (!expectedSha.equals(actual.toString())) {
                        throw new SecurityException("Verificação SHA-256 falhou. Download descartado.");
                    }
                }
                verifyArchive(temp);
                if (finalFile.exists() && !finalFile.delete()) throw new IllegalStateException("Não foi possível limpar APK antigo.");
                if (!temp.renameTo(finalFile)) throw new IllegalStateException("Não foi possível finalizar o arquivo de atualização.");
                downloaded = finalFile;
                emit("ready", "Download verificado. Toque em 'Instalar atualização'.", 100,
                    release.tag.replace("mobile-prototipo-", ""));
            } catch (Exception ex) {
                downloaded = null;
                if (temp != null && temp.exists()) temp.delete();
                emit("error", "Atualização não instalada: " + ex.getMessage(), 0, null);
            }
        });
    }

    private static Signature[] signers(PackageInfo info) {
        if (info == null) return new Signature[0];
        if (Build.VERSION.SDK_INT >= 28) {
            return info.signingInfo == null ? new Signature[0] :
                info.signingInfo.getApkContentsSigners();
        }
        return info.signatures == null ? new Signature[0] : info.signatures;
    }

    private void verifyArchive(File apk) throws Exception {
        PackageManager pm = activity.getPackageManager();
        int flag = Build.VERSION.SDK_INT >= 28 ?
            PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo candidate = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flag);
        if (candidate == null || !activity.getPackageName().equals(candidate.packageName)) {
            throw new SecurityException("O arquivo não pertence ao DISTRILOG Mobile.");
        }
        if (code(candidate) <= installedCode()) {
            throw new SecurityException("O APK não é mais recente que o instalado.");
        }
        PackageInfo current = pm.getPackageInfo(activity.getPackageName(), flag);
        Signature[] trusted = signers(current);
        Signature[] offered = signers(candidate);
        if (trusted.length != 1 || offered.length != 1 ||
            !Arrays.equals(trusted[0].toByteArray(), offered[0].toByteArray())) {
            throw new SecurityException(
                "Assinatura diferente. Para atualizar sem desinstalar, todas as versões " +
                "precisam ser assinadas pela mesma chave permanente.");
        }
    }

    void install() {
        File file = downloaded;
        if (file == null || !file.exists()) {
            emit("error", "Baixe a versão antes de instalar.", 0, null);
            return;
        }
        runExclusive(() -> {
            try {
                // Verify again after cache storage, before granting installer access.
                verifyArchive(file);
                activity.runOnUiThread(() -> {
                    try {
                        if (Build.VERSION.SDK_INT >= 26 &&
                            !activity.getPackageManager().canRequestPackageInstalls()) {
                            emit("permission", "Autorize 'Instalar apps desconhecidos' para o DISTRILOG e toque novamente em Instalar.", 100, null);
                            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + activity.getPackageName()));
                            activity.startActivity(settings);
                            return;
                        }
                        Uri uri = FileProvider.getUriForFile(activity,
                            activity.getPackageName() + ".updater", file);
                        Intent intent = new Intent(Intent.ACTION_VIEW);
                        intent.setDataAndType(uri, "application/vnd.android.package-archive");
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK |
                            Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        activity.startActivity(intent);
                        emit("installing", "Confirme a instalação na tela do Android. Seus dados do WMS permanecem no servidor.", 100, null);
                    } catch (Exception e) {
                        emit("error", "Não foi possível abrir a instalação: " + e.getMessage(), 0, null);
                    }
                });
            } catch (Exception e) {
                emit("error", "O APK não passou na verificação: " + e.getMessage(), 0, null);
            }
        });
    }

    void close() { io.shutdownNow(); }
}
