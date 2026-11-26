package sh.ovis.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.UnaryOperator;

/**
 * Download in the chat's image viewer and the file viewer (src/lib/saveImage.ts). The WebView has no download handler
 * and no Web Share, so a download link did nothing (#3153). The page hands the file's bytes over
 * instead, already read through its own transport (a relay PC's blob: pictures, a PC's signed-in
 * file route), and the file lands in Downloads, as a download in Chrome does. Android 8 and 9
 * write to Downloads only with the storage permission, which the app does not ask for: there the
 * file goes to the share sheet. Only the PC's own page has the bridge; still, one save runs at a
 * time and SavedImage caps their size and number for each instance of this plugin (up to 500 MiB),
 * so a page cannot write without limit. It is a budget, not a guarantee: a phone with less free
 * space can still fill, and a new instance (the activity restarted) starts a new budget.
 */
@CapacitorPlugin(name = "OvisSave")
public class SaveImagePlugin extends Plugin {
    private static final long SHARE_KEPT_MS = 60 * 60 * 1000;

    private final AtomicBoolean saving = new AtomicBoolean();

    private final SavedImage.Budget budget = new SavedImage.Budget();

    @PluginMethod
    public void saveImage(PluginCall call) {
        String type = call.getString("type");
        if (!SavedImage.isImageType(type)) {
            call.reject("Only a picture can be saved.");
            return;
        }
        save(call, name -> type, "image");
    }

    /**
     * Download in the file viewer (src/components/FileViewer.tsx): any file the page read, of any
     * type, as Chrome would download it. Its type is the one its name's extension stands for (or
     * application/octet-stream), not the PC's: Downloads appends the extension of a type that does
     * not match the name, so `notes.md` sent as text/plain would land as `notes.md.txt`.
     */
    @PluginMethod
    public void saveFile(PluginCall call) {
        MimeTypeMap types = MimeTypeMap.getSingleton();
        save(call, name -> SavedImage.typeForName(name, types::getMimeTypeFromExtension), "file");
    }

    private void save(PluginCall call, UnaryOperator<String> typeOf, String fallbackName) {
        if (!saving.compareAndSet(false, true)) {
            call.reject("Another file is being saved.");
            return;
        }
        boolean handedOn = false;
        try {
            byte[] bytes = SavedImage.decode(call.getString("data"));
            if (bytes == null) {
                call.reject("The file is empty, too large or not base64.");
                return;
            }
            if (!budget.take(SystemClock.elapsedRealtime(), bytes.length)) {
                call.reject("Too many files saved; try again later.");
                return;
            }
            String name = SavedImage.fileName(call.getString("name"), fallbackName);
            String type = typeOf.apply(name);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                toDownloads(name, type, bytes);
                JSObject result = new JSObject();
                result.put("saved", "downloads");
                call.resolve(result);
            } else {
                toShareSheet(call, name, type, bytes);
                handedOn = true;
            }
        } catch (IOException | RuntimeException failed) {
            call.reject("The file could not be saved.", failed);
        } finally {
            if (!handedOn) saving.set(false);
        }
    }

    private void toDownloads(String name, String type, byte[] bytes) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, type);
        // hidden from other apps until it is whole
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("Downloads refused the file");
        try {
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new IOException("Downloads gave nothing to write to");
                out.write(bytes);
            }
            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            if (resolver.update(uri, values, null, null) != 1) throw new IOException("Downloads did not take the file");
        } catch (IOException | RuntimeException failed) {
            try {
                resolver.delete(uri, null, null);
            } catch (RuntimeException cleanup) {
                failed.addSuppressed(cleanup);
            }
            throw failed;
        }
    }

    /**
     * Each picture in a folder of its own under cache/saved (of the cache, res/xml/file_paths.xml
     * shares only that folder), so the address an app was granted never shows another picture; the
     * next share tries to remove those shared over an hour ago.
     */
    private void toShareSheet(PluginCall call, String name, String type, byte[] bytes) throws IOException {
        File root = new File(getContext().getCacheDir(), "saved");
        File[] earlier = root.listFiles();
        long now = System.currentTimeMillis();
        if (earlier != null) for (File folder : earlier) if (now - folder.lastModified() > SHARE_KEPT_MS) remove(folder);
        File folder = new File(root, UUID.randomUUID().toString());
        if (!folder.mkdirs()) throw new IOException("no folder for the file");
        File file = new File(folder, name);
        Uri uri;
        try {
            try (OutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        } catch (IOException | RuntimeException failed) {
            remove(folder);
            throw failed;
        }
        Intent send = new Intent(Intent.ACTION_SEND)
            .setType(type)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri(name, uri));
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(Intent.createChooser(send, null));
                JSObject result = new JSObject();
                result.put("saved", "shared");
                call.resolve(result);
            } catch (RuntimeException failed) {
                remove(folder);
                call.reject("The share sheet did not open.", failed);
            } finally {
                saving.set(false);
            }
        });
    }

    private static void remove(File folder) {
        File[] files = folder.listFiles();
        if (files != null) for (File file : files) file.delete();
        folder.delete();
    }
}
