package com.distribox.distrilogmobile.prototype;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.print.PageRange;
import android.webkit.CookieManager;
import android.webkit.WebView;

import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONObject;

/**
 * Android spooler for a server-generated authenticated Rack label.
 * The JavaScript side can supply only a numeric card ID, never a remote URL,
 * arbitrary file path, HTML fragment or printer address. An Android print
 * service (Wi-Fi, Bluetooth, corporate print service, etc.) selects printer.
 * The operator confirms the print job in the OS system dialog.
 */
final class RackPrinter {
    private static final int MAX_PDF_BYTES = 3 * 1024 * 1024;
    private final MainActivity activity;
    private final WebView view;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final OkHttpClient http = new OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)
        .connectTimeout(12, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
        .build();

    RackPrinter(MainActivity activity, WebView view) {
        this.activity = activity;
        this.view = view;
    }

    private void notifyUi(String type, String message) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", type);
            event.put("message", message);
            activity.runOnUiThread(() -> {
                if (view.getParent() != null) {
                    view.evaluateJavascript("window.DM_RACK_PRINT_EVENT && window.DM_RACK_PRINT_EVENT(" +
                        event.toString() + ");", null);
                }
            });
        } catch (Exception ignored) {
            // UI can be destroyed during asynchronous download.
        }
    }

    void print(int cardId, String endpoint) {
        if (cardId < 1 || endpoint == null || endpoint.isEmpty()) {
            notifyUi("error", "Conecte ao DISTRILOG e selecione um Card válido.");
            return;
        }
        io.execute(() -> {
            notifyUi("loading", "Buscando a etiqueta Rack oficial no servidor...");
            try {
                final String url = endpoint + "/api/racks/cards/" + cardId + ".pdf?copies=1";
                Request.Builder builder = new Request.Builder().get()
                    .url(url).header("Accept", "application/pdf");
                String cookies = CookieManager.getInstance().getCookie(endpoint);
                if (cookies != null && !cookies.isEmpty()) builder.header("Cookie", cookies);
                byte[] pdf;
                try (Response response = http.newCall(builder.build()).execute()) {
                    if (!response.isSuccessful() || response.body() == null) {
                        throw new IOException(
                            response.code() == 409 ?
                            "Confirme a chegada do Card no Recebimento antes de imprimir a Rack." :
                            response.code() == 401 ?
                            "Sua sessão expirou. Entre novamente no DISTRILOG." :
                            "Não foi possível gerar Rack (HTTP " + response.code() + ")."
                        );
                    }
                    String type = response.header("Content-Type", "");
                    if (!type.toLowerCase(java.util.Locale.ROOT).startsWith("application/pdf")) {
                        throw new IOException("O servidor não devolveu um PDF de Rack válido.");
                    }
                    long length = response.body().contentLength();
                    if (length > MAX_PDF_BYTES) throw new IOException("Etiqueta excede o limite de tamanho.");
                    try (InputStream stream = response.body().byteStream();
                         ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = stream.read(buf)) != -1) {
                            if (bytes.size() + n > MAX_PDF_BYTES)
                                throw new IOException("Documento PDF grande demais.");
                            bytes.write(buf, 0, n);
                        }
                        pdf = bytes.toByteArray();
                    }
                }
                if (pdf.length < 8 || pdf[0] != '%' || pdf[1] != 'P'
                    || pdf[2] != 'D' || pdf[3] != 'F' || pdf[4] != '-')
                    throw new IOException("Arquivo de impressão não é um PDF.");
                final byte[] document = pdf;
                activity.runOnUiThread(() -> {
                    try {
                        PrintManager manager = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
                        if (manager == null) throw new IllegalStateException("Serviço de impressão indisponível.");
                        PrintAttributes attrs = new PrintAttributes.Builder()
                            .setMediaSize(new PrintAttributes.MediaSize("RACK_100X85", "Etiqueta Rack 100 x 85 mm", 3937, 3346))
                            .setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME)
                            .setMinMargins(new PrintAttributes.Margins(0, 0, 0, 0))
                            .build();
                        manager.print("DISTRILOG RACK-" + cardId,
                            new RackPdfAdapter(document, cardId), attrs);
                        notifyUi("ready", "Selecione a impressora e confirme na janela do Android.");
                    } catch (Exception e) {
                        notifyUi("error", "Falha ao abrir impressão: " + e.getMessage());
                    }
                });
            } catch (Exception e) {
                notifyUi("error", e.getMessage());
            }
        });
    }

    void close() { io.shutdownNow(); }

    /** One pre-rendered 100x85 mm PDF page. Never redraws server data. */
    private static final class RackPdfAdapter extends PrintDocumentAdapter {
        private final byte[] pdf;
        private final int id;

        RackPdfAdapter(byte[] pdf, int id) {
            this.pdf = pdf.clone();
            this.id = id;
        }

        @Override public void onLayout(PrintAttributes oldAttrs, PrintAttributes newAttrs,
                                       CancellationSignal cancelled, LayoutResultCallback cb,
                                       Bundle extras) {
            if (cancelled.isCanceled()) { cb.onLayoutCancelled(); return; }
            PrintDocumentInfo info = new PrintDocumentInfo.Builder("RACK-" + id + ".pdf")
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .setPageCount(1).build();
            cb.onLayoutFinished(info, true);
        }

        @Override public void onWrite(PageRange[] pages, ParcelFileDescriptor destination,
                                      CancellationSignal cancelled, WriteResultCallback cb) {
            if (cancelled.isCanceled()) { cb.onWriteCancelled(); return; }
            boolean requested = false;
            for (PageRange range : pages) {
                if (range.getStart() <= 0 && range.getEnd() >= 0) requested = true;
            }
            if (!requested) { cb.onWriteFinished(new PageRange[0]); return; }
            try (FileOutputStream file = new FileOutputStream(destination.getFileDescriptor())) {
                file.write(pdf);
                file.flush();
                if (cancelled.isCanceled()) { cb.onWriteCancelled(); return; }
                cb.onWriteFinished(new PageRange[]{PageRange.ALL_PAGES});
            } catch (IOException ex) {
                cb.onWriteFailed("Falha ao gravar o PDF no sistema de impressão.");
            }
        }
    }
}
