package sh.ovis.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The preview build's own updates (build type "preview" in build.gradle): only that build has a feed,
 * BuildConfig.PREVIEW_FEED (OVIS_PREVIEW_FEED when it was built), and the permission to hand an APK to the system
 * installer (src/preview/AndroidManifest.xml). Every other build has neither, and its state is "off". The feed is a
 * folder with version.json, {"versionCode": 1021, "versionName": "1.0.6-preview.21", "apk": "<file>", "sha256":
 * "<hex>"}, beside the APK it names.
 */
final class PreviewUpdater {
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final int TIMEOUT_MS = 20_000;
    private static final int VERSION_FILE_MAX = 16 * 1024;
    private static final long CHECK_EVERY_MS = 30L * 60 * 1000;

    static final class Release {
        final int code;
        final String name;
        final String apk;
        final String sha256;

        Release(int code, String name, String apk, String sha256) {
            this.code = code;
            this.name = name;
            this.apk = apk;
            this.sha256 = sha256;
        }
    }

    private PreviewUpdater() {}

    /** The feed `value` names when it is an https folder (ending in "/"), else null. */
    static String feedOf(String value) {
        if (value == null || value.isEmpty() || !value.endsWith("/")) return null;
        try {
            URI uri = new URI(value);
            return "https".equals(uri.getScheme()) && uri.getHost() != null ? value : null;
        } catch (URISyntaxException e) {
            return null;
        }
    }

    static boolean enabled() {
        return feedOf(BuildConfig.PREVIEW_FEED) != null;
    }

    /** version.json read against `feed`: the APK it names resolves beside it and must stay on the feed's origin. */
    static Release parse(String json, String feed) throws JSONException {
        JSONObject body = new JSONObject(json);
        String sha = body.getString("sha256").toLowerCase(Locale.ROOT);
        if (!SHA256.matcher(sha).matches()) throw new JSONException("sha256 is not 64 hex digits");
        URI base = URI.create(feed);
        URI apk = base.resolve(body.getString("apk"));
        if (!"https".equals(apk.getScheme()) || !base.getHost().equals(apk.getHost()) || base.getPort() != apk.getPort()) {
            throw new JSONException("the APK is not on the feed's origin");
        }
        return new Release(body.getInt("versionCode"), body.getString("versionName"), apk.toString(), sha);
    }

    static boolean newer(Release release, int current) {
        return release.code > current;
    }

    // The one update in flight, shared by the check when the app opens (offer) and Settings (HerdrShellPlugin)
    private static String phase = "idle";
    private static String update;
    private static String error;
    private static File downloaded;
    private static boolean running;
    private static long checkedAt;
    private static String offered;
    private static final List<Consumer<JSObject>> waiting = new ArrayList<>();

    /** The state in Settings → About's shape (src/lib/desktopUpdate.ts AppUpdate). */
    static synchronized JSObject state() {
        JSObject state = new JSObject();
        state.put("version", BuildConfig.VERSION_NAME);
        state.put("phase", enabled() ? phase : "off");
        if (update != null) state.put("update", update);
        if (error != null) state.put("error", error);
        return state;
    }

    /**
     * Reads the feed and downloads a newer preview, then hands the state to `done` on the main thread. A check asked
     * for while one runs waits for it.
     */
    static void check(Activity activity, Consumer<JSObject> done) {
        String feed = feedOf(BuildConfig.PREVIEW_FEED);
        synchronized (PreviewUpdater.class) {
            waiting.add(done);
            if (running) return;
            if (feed == null) {
                finish(activity);
                return;
            }
            running = true;
            phase = "checking";
            error = null;
            checkedAt = System.currentTimeMillis();
        }
        File folder = new File(activity.getCacheDir(), "preview-update");
        new Thread(() -> {
            String next;
            String nextUpdate = null;
            String nextError = null;
            File file = null;
            try {
                Release release = parse(fetch(feed + "version.json"), feed);
                if (!newer(release, BuildConfig.VERSION_CODE)) {
                    next = "latest";
                } else {
                    synchronized (PreviewUpdater.class) {
                        phase = "downloading";
                        update = release.name;
                    }
                    file = download(release, folder);
                    next = "ready";
                    nextUpdate = release.name;
                }
            } catch (IOException | JSONException | IllegalArgumentException e) {
                next = "failed";
                nextError = String.valueOf(e.getMessage());
            }
            synchronized (PreviewUpdater.class) {
                phase = next;
                update = nextUpdate;
                error = nextError;
                downloaded = file;
                running = false;
                finish(activity);
            }
        }).start();
    }

    private static void finish(Activity activity) {
        JSObject state = state();
        List<Consumer<JSObject>> answer = new ArrayList<>(waiting);
        waiting.clear();
        activity.runOnUiThread(() -> answer.forEach((each) -> each.accept(state)));
    }

    /** On opening: a check at most every half hour, and once a newer preview is downloaded, one offer to install it. */
    static void offer(Activity activity, boolean korean) {
        if (!enabled()) return;
        synchronized (PreviewUpdater.class) {
            if (System.currentTimeMillis() - checkedAt < CHECK_EVERY_MS) return;
        }
        check(activity, (state) -> {
            String version = state.optString("update", "");
            if (!"ready".equals(state.optString("phase")) || version.isEmpty() || version.equals(offered) || activity.isFinishing()) return;
            offered = version;
            new AlertDialog.Builder(activity)
                .setTitle(korean ? "Ovis Preview " + version + " 준비됨" : "Ovis Preview " + version + " is ready")
                .setMessage(korean ? "새 미리보기 버전을 설치할까요?" : "Install the new preview now?")
                .setPositiveButton(korean ? "업데이트" : "Update", (dialog, which) -> install(activity))
                .setNegativeButton(korean ? "나중에" : "Later", null)
                .show();
        });
    }

    /**
     * Hands the downloaded APK to the system installer; until this app may install apps, opens the setting that
     * allows it instead (the user comes back and installs).
     */
    static void install(Activity activity) {
        File file;
        synchronized (PreviewUpdater.class) {
            file = downloaded;
        }
        if (file == null || !file.isFile()) return;
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())));
            return;
        }
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
        activity.startActivity(new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
    }

    private static HttpURLConnection open(String address) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        // a redirect would leave the feed's origin that parse() checked: it fails as any answer but 200
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);
        connection.setUseCaches(false);
        if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
            int status = connection.getResponseCode();
            connection.disconnect();
            throw new IOException(address + " answered " + status);
        }
        return connection;
    }

    private static String fetch(String address) throws IOException {
        HttpURLConnection connection = open(address);
        try (InputStream in = connection.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            for (int read; (read = in.read(buffer)) != -1; ) {
                out.write(buffer, 0, read);
                if (out.size() > VERSION_FILE_MAX) throw new IOException("version.json is too large");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }

    private static File download(Release release, File folder) throws IOException {
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("cannot make " + folder);
        // written to a part file and kept under its digest only once it matches: the installer URI of an earlier
        // download never names bytes still being written or not yet checked
        File part = new File(folder, "download.part");
        File file = new File(folder, "ovis-preview-" + release.sha256 + ".apk");
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        HttpURLConnection connection = open(release.apk);
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(part)) {
            byte[] buffer = new byte[64 * 1024];
            for (int read; (read = in.read(buffer)) != -1; ) {
                digest.update(buffer, 0, read);
                out.write(buffer, 0, read);
            }
        } finally {
            connection.disconnect();
        }
        StringBuilder hex = new StringBuilder();
        for (byte each : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", each));
        if (!hex.toString().equals(release.sha256)) {
            part.delete();
            throw new IOException("the downloaded APK does not match its sha256");
        }
        if (!part.renameTo(file)) throw new IOException("cannot keep " + file);
        File[] old = folder.listFiles();
        if (old != null) for (File each : old) if (!each.equals(file)) each.delete();
        return file;
    }
}
