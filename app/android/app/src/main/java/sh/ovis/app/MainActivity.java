package sh.ovis.app;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.core.graphics.ColorUtils;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;
import com.getcapacitor.JSObject;
import com.getcapacitor.WebViewListener;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Capacitor's activity with the chosen PC as the WebView's first page, as HerdrBridgeViewController
 * does on iOS: opening or leaving a PC starts the activity again (reopen), so the next page is a
 * first load too.
 */
public class MainActivity extends BridgeActivity {
    /**
     * Sends the page's theme-color (the client keeps it at its top bar's color, the app's own pages
     * at theirs) to OvisBars, now and whenever it changes, so the system bars match the page.
     */
    private static final String BAR_COLOR_SCRIPT =
        "(() => {" +
        "  if (window !== window.top) return;" +
        "  const apply = () => {" +
        "  const meta = document.querySelector('meta[name=\"theme-color\"]');" +
        "  if (!meta) return;" +
        "  const send = () => { if (meta.content && window.OvisBars) OvisBars.postMessage(meta.content); };" +
        "  new MutationObserver(send).observe(meta, { attributes: true, attributeFilter: ['content'] });" +
        "  send();" +
        "  };" +
        "  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', apply, { once: true });" +
        "  else apply();" +
        "})();";

    /** Whether the page itself (not a picture or a frame in it) failed since it started. */
    private boolean pageFailed;

    /** Whether a page has shown in this activity: from then on a user could have followed a link from it. */
    private boolean pageShown;

    /** The page's theme-color the system bars took, put back after a configuration change. */
    private Integer barColor;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(HerdrShellPlugin.class);
        // the PC's key: its origin, or its scope on the hosted shell's origin for a relay PC
        String pc = PCStore.current(this);
        String origin = pc == null ? null : PCStore.origin(pc);
        String host = origin == null ? null : Uri.parse(origin).getHost();
        if (host != null) {
            boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            // Capacitor makes server.url the bridge's origin rule, which takes no path, query or
            // trailing slash: such a rule throws, and Capacitor falls back to a bridge that every
            // frame (a preview's iframe included) can call. So server.url is the bare origin, and a
            // pairing link's path, query and fragment (a relay offer's `#offer=`) come in as the start
            // path until a PC page has loaded; a relay PC starts at its scope after that.
            config = new CapConfig.Builder(this)
                .setServerUrl(origin)
                .setStartPath(PCStore.startPath(PCStore.pendingStart, pc))
                // No allowNavigation: the PC's own links (its host and scheme, any port) stay in the
                // WebView already, and Capacitor turns each entry into another bridge origin rule
                // (https://host, or a host starting with "http" as is: invalid, which again drops the
                // bridge's origin check). Other links go to the browser.
                .setErrorPath("error.html")
                .setBackgroundColor("#12100e")
                .setWebContentsDebuggingEnabled(debuggable)
                // Capacitor's log has "Loading app at" with a pairing link's code, and every plugin
                // call's arguments; logcat keeps them on the phone (capacitor.config.json turns it
                // off for the connect screen)
                .setLoggingEnabled(false)
                // light icons on the app's dark background until a page gives its theme-color, as
                // capacitor.config.json does for the connect screen: Capacitor's SystemBars would
                // otherwise follow the phone's light mode with dark icons
                .setPluginsConfiguration(new JSObject().put("SystemBars", new JSObject().put("style", "DARK")))
                .create();
        }
        super.onCreate(savedInstanceState);
        keepClearOfNavigationButtons();
        String appOrigin = bridge.getScheme() + "://" + bridge.getHost();
        followThemeColor(host == null ? Collections.singleton(appOrigin) : new HashSet<>(Arrays.asList(appOrigin, origin)));
        if (host != null) {
            // Capacitor injects its bridge only into the PC's origin, so error.html (served from the
            // app while a PC is open) reaches the app through this listener instead. It answers only
            // the app's own origin in the main frame: a PC page or a frame it opens gets nothing.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.addWebMessageListener(
                    bridge.getWebView(),
                    "HerdrErrorPage",
                    Collections.singleton(appOrigin),
                    (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                        if (!isMainFrame) return;
                        String asked = message.getData();
                        if ("state".equals(asked)) {
                            String last = PCStore.last(this);
                            JSObject state = new JSObject();
                            state.put("last", last == null ? "" : last);
                            state.put("name", last == null ? "" : PCStore.names(this).optString(last, ""));
                            state.put("failure", PCStore.failure == null ? "" : PCStore.failure);
                            replyProxy.postMessage(state.toString());
                        } else if ("retry".equals(asked)) {
                            retry();
                        } else if ("changePc".equals(asked)) {
                            changePc();
                        }
                    }
                );
            }
            bridge.setWebViewClient(
                new BridgeWebViewClient(bridge) {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        // error.html on a WebView without HerdrErrorPage (no WEB_MESSAGE_LISTENER)
                        // asks by navigating to one of these app addresses instead
                        Uri url = request.getUrl();
                        if (
                            request.isForMainFrame() &&
                            (appOrigin + "/error.html").equals(view.getUrl()) &&
                            appOrigin.equals(url.getScheme() + "://" + url.getHost())
                        ) {
                            if ("/_ovis/retry".equals(url.getPath())) {
                                retry();
                                return true;
                            }
                            if ("/_ovis/change-pc".equals(url.getPath())) {
                                changePc();
                                return true;
                            }
                        }
                        // Capacitor gives the browser any other host or scheme, redirects included. Until the
                        // first page shows, a redirect can only come from the address being opened
                        if (!pageShown && request.isForMainFrame() && request.isRedirect()) {
                            String next = PCStore.origin(url.toString());
                            if (next != null && !next.equals(origin)) {
                                followRedirect(origin, url.toString());
                                return true;
                            }
                        }
                        return super.shouldOverrideUrlLoading(view, request);
                    }

                    // Capacitor tells its listeners of every failed request, a picture or a frame
                    // included, and not which one or why: only a failure of the page itself keeps the
                    // PC out of the saved list, and its reason goes to error.html, which Capacitor
                    // shows for both.
                    @Override
                    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                        if (request.isForMainFrame()) {
                            pageFailed = true;
                            PCStore.failure = String.valueOf(error.getDescription());
                        }
                        super.onReceivedError(view, request, error);
                    }

                    @Override
                    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                        // a PC that answers but not with Ovis, such as tailscale serve's 502 while Ovis
                        // is stopped there
                        if (request.isForMainFrame()) {
                            pageFailed = true;
                            String reason = response.getReasonPhrase();
                            PCStore.failure = "HTTP " + response.getStatusCode() + (reason == null || reason.isEmpty() ? "" : " " + reason);
                        }
                        super.onReceivedHttpError(view, request, response);
                    }
                }
            );
            bridge.addWebViewListener(
                new WebViewListener() {
                    @Override
                    public void onPageStarted(WebView webView) {
                        pageFailed = false;
                    }

                    @Override
                    public void onPageCommitVisible(WebView webView, String url) {
                        // the main frame's first page is on screen, before its pictures or scripts finish
                        pageShown = true;
                    }

                    @Override
                    public void onPageLoaded(WebView webView) {
                        // Chromium reports a page that failed as loaded too, before the error page;
                        // only a page of this very PC (its scheme, host and port, and its scope for a relay PC) counts
                        String url = webView.getUrl();
                        if (pageFailed || url == null || !PCStore.belongs(url, pc)) return;
                        // the PC's page is up: a pairing link has done its work, and the PC is one worth keeping
                        PCStore.pendingStart = null;
                        PCStore.failure = null;
                        PCStore.redirects = 0;
                        PCStore.remember(MainActivity.this, pc);
                    }
                }
            );
        }
    }

    /**
     * Lets the pages of `origins` color the status and navigation bars with their theme-color.
     * Without it the bars keep the app's dark background and light icons.
     */
    private void followThemeColor(Set<String> origins) {
        if (
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) return;
        try {
            WebViewCompat.addWebMessageListener(
                bridge.getWebView(),
                "OvisBars",
                origins,
                (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    if (!isMainFrame || message.getData() == null) return;
                    String color = message.getData().trim();
                    if (!color.matches("#[0-9a-fA-F]{6}")) return;
                    paintBars(Color.parseColor(color));
                }
            );
            WebViewCompat.addDocumentStartJavaScript(bridge.getWebView(), BAR_COLOR_SCRIPT, origins);
        } catch (IllegalArgumentException rejectedOrigin) {
            return; // Keep the default bars when WebView rejects an origin rule.
        }
        bridge.getWebView().evaluateJavascript(BAR_COLOR_SCRIPT, null);
    }

    /**
     * Keeps the page clear of navigation buttons (3-button navigation: the bottom bar, or the side bar
     * of a phone in landscape). On a WebView that gives the page its safe areas itself (140 and
     * later), Capacitor's SystemBars lets the page draw under the system bars and leaves the room to
     * the page's CSS, and the client lets its message box and key bar sit partly into the bottom safe
     * area, as an iPhone's home indicator allows: there the buttons cover them. The client's layout
     * pads its sides for a side bar; the page is kept clear of one too, so that nothing on it has to.
     * A gesture bar has no tappable inset, so the page stays under it. A docked
     * keyboard covers a bottom bar, and SystemBars keeps the page above both. A floating keyboard
     * takes no bottom inset, so on WebView 144 and later the bar is kept clear under it; before 144
     * SystemBars passes the page no bottom inset while any keyboard shows, so nothing is padded then.
     * On an older WebView SystemBars keeps the page out from under the bars itself, so the page gets
     * no such insets and nothing changes.
     */
    private void keepClearOfNavigationButtons() {
        View page = (View) bridge.getWebView().getParent();
        int bars = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
        ViewCompat.setOnApplyWindowInsetsListener(page, (view, insets) -> {
            Insets under = insets.getInsets(bars);
            Insets buttons = insets.getInsets(WindowInsetsCompat.Type.tappableElement());
            boolean keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom > 0;
            Insets clear = Insets.of(
                Math.min(buttons.left, under.left),
                0,
                Math.min(buttons.right, under.right),
                keyboard ? 0 : Math.min(buttons.bottom, under.bottom)
            );
            // the strip shows the window's background: the page's theme-color once it has sent one
            // (paintBars), the app's dark background before
            view.setPadding(clear.left, 0, clear.right, clear.bottom);
            if (clear.equals(Insets.NONE)) return insets;
            return new WindowInsetsCompat.Builder(insets).setInsets(bars, Insets.subtract(under, clear)).build();
        });
    }

    /**
     * The color behind the system bars (the strip Capacitor leaves when the page does not draw under
     * them) and icons that stand out on it, light or dark.
     */
    private void paintBars(int color) {
        barColor = color;
        Window window = getWindow();
        window.getDecorView().setBackgroundColor(color);
        boolean lightBars = ColorUtils.calculateLuminance(color) > 0.18;
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
        bars.setAppearanceLightStatusBars(lightBars);
        bars.setAppearanceLightNavigationBars(lightBars);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        // Capacitor's SystemBars puts the theme's bars back on a change (dark mode, rotation)
        super.onConfigurationChanged(newConfig);
        if (barColor != null) paintBars(barColor);
    }

    @Override
    public void onPause() {
        super.onPause();
        // WebView writes cookies to disk on its own schedule: a paired device's sign-in set a moment
        // ago would be lost if the app were swiped away now
        CookieManager.getInstance().flush();
    }

    /**
     * A redirect of the address being opened to another origin, held back: when that origin answers as
     * Ovis it becomes the PC and opens as the first page, with the bridge (http to https, an IP address
     * to the PC's name, another port). Anything else, such as a sign-in page, gets no bridge and the
     * error page names it: a PC address that leads elsewhere is not a PC. The address's own page would
     * get the bridge too, so the place it leads to gets nothing more. Once the first page shows,
     * Capacitor decides on redirects again: one could then come from a link to a page that is not the
     * PC's (another port on its host), which must not choose the PC. A way that goes over public plain
     * http, or from https to http, does not switch on its own: the connect screen warns before a
     * public http address.
     */
    private void followRedirect(String from, String target) {
        boolean tooMany = PCStore.redirects >= PCStore.MAX_REDIRECTS;
        new Thread(() -> {
            List<String> path = new ArrayList<>();
            String ovis = tooMany ? null : PCStore.ovisOrigin(target, PCStore.PROBE_BUDGET_MS, path);
            String insecure = ovis == null ? null : PCStore.insecureHop(from, path);
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (insecure != null) {
                    PCStore.failure = "It redirected over plain http to " + insecure + ", which the app does not follow on its own. If " + ovis + " is your PC, open it itself.";
                    bridge.getWebView().loadUrl(bridge.getErrorUrl());
                } else if (ovis != null) {
                    PCStore.redirects++;
                    PCStore.open(this, ovis, PCStore.startOn(ovis, target));
                    reopen();
                } else {
                    String place = PCStore.origin(target);
                    PCStore.failure = tooMany ? "Too many redirects" : "It redirected to " + place + ", which did not answer as Ovis. If that is your PC, open " + place + " itself.";
                    bridge.getWebView().loadUrl(bridge.getErrorUrl());
                }
            });
        }, "ovis-redirect").start();
    }

    /** Opens the current PC again from its first page. */
    void retry() {
        PCStore.failure = null;
        PCStore.redirects = 0;
        reopen();
    }

    /** Back to the connect screen; the PC stays in the list. */
    void changePc() {
        PCStore.setCurrent(this, null);
        reopen();
    }

    /** Starts this activity again, so the next page (a PC, or the connect screen) is a first load. */
    void reopen() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        finish();
        overridePendingTransition(0, 0);
        startActivity(intent);
    }
}
