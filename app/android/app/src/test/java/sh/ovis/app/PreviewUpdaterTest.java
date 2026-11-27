package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import org.json.JSONException;
import org.junit.Test;

public class PreviewUpdaterTest {
    private static final String FEED = "https://preview.example:17512/android/";
    private static final String SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private static String version(String apk, String sha) {
        return "{\"versionCode\":1021,\"versionName\":\"1.0.6-preview.21\",\"apk\":\"" + apk + "\",\"sha256\":\"" + sha + "\"}";
    }

    @Test
    public void readsTheFeedsVersionFileAndFindsItsApkBesideIt() throws JSONException {
        PreviewUpdater.Release release = PreviewUpdater.parse(version("Ovis-Preview-21.apk", SHA.toUpperCase()), FEED);
        assertEquals(1021, release.code);
        assertEquals("1.0.6-preview.21", release.name);
        assertEquals("https://preview.example:17512/android/Ovis-Preview-21.apk", release.apk);
        assertEquals(SHA, release.sha256);
        assertTrue(PreviewUpdater.newer(release, 1020));
        assertFalse(PreviewUpdater.newer(release, 1021));
    }

    @Test
    public void refusesAnApkOffTheFeedsOriginOrWithoutAChecksum() {
        assertThrows(JSONException.class, () -> PreviewUpdater.parse(version("https://elsewhere.example/a.apk", SHA), FEED));
        assertThrows(JSONException.class, () -> PreviewUpdater.parse(version("http://preview.example:17512/android/a.apk", SHA), FEED));
        assertThrows(JSONException.class, () -> PreviewUpdater.parse(version("a.apk", "not-a-checksum"), FEED));
    }

    @Test
    public void takesOnlyAnHttpsFolderAsAFeed() {
        assertEquals(FEED, PreviewUpdater.feedOf(FEED));
        assertNull(PreviewUpdater.feedOf("http://preview.example/android/"));
        assertNull(PreviewUpdater.feedOf("https://preview.example/android"));
        assertNull(PreviewUpdater.feedOf(""));
    }

    @Test
    public void aBuildThatIsNotThePreviewHasNoFeedAndNoInstallPermission() throws IOException {
        // the preview variant's own unit run carries OVIS_PREVIEW_FEED when it is set
        if (!"preview".equals(BuildConfig.BUILD_TYPE)) {
            assertEquals("", BuildConfig.PREVIEW_FEED);
            assertFalse(PreviewUpdater.enabled());
        }
        String main = new String(Files.readAllBytes(Paths.get("src/main/AndroidManifest.xml")), StandardCharsets.UTF_8);
        String preview = new String(Files.readAllBytes(Paths.get("src/preview/AndroidManifest.xml")), StandardCharsets.UTF_8);
        assertFalse(main.contains("REQUEST_INSTALL_PACKAGES"));
        assertTrue(preview.contains("android.permission.REQUEST_INSTALL_PACKAGES"));
    }
}
