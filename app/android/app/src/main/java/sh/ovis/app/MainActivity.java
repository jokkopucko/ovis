package sh.ovis.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.net.TrafficStats;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.webkit.CookieManager;
import android.webkit.WebBackForwardList;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
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
import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import sh.ovis.push.AlertProof;
import sh.ovis.push.OvisMessagingService;

public class MainActivity extends BridgeActivity {
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

    private boolean pageFailed;

    private boolean pageShown;

    /**
     * Whether the address being opened led to something in front of the PC, such as a sign-in page:
     * until a page of the PC loads, main-frame navigations (the sign-in's pages, its identity
     * provider's, the way back to the PC) stay in the WebView, so the sign-in's cookie lands in the
     * WebView's store, which onPause flushes, rather than in the browser's.
     */
    private volatile boolean signingIn;

    /** The origin the sign-in is on, so each of its steps is judged against the one before (PCStore.refusedHop). */
    private volatile String signInAt;

    private Integer barColor;

    private View openingView;

    /**
     * Looks at the open once a second while the cover is up (watchOpening): gives up on a PC from
     * which nothing arrived in ANSWER_SECONDS, where Chromium alone waits about two minutes, and
     * tells a slow or stalled link on the cover.
     */
    private final Handler answerTimer = new Handler(Looper.getMainLooper());

    private OpeningWatch watch;

    private ProgressBar openingSpinner;
    private TextView openingText;
    private Button openingKeep;
    private Button openingRetry;

    private ProgressBar openingBar;

    private String openingPc;
    private long pageBytes = -1;

    private boolean pageLoaded;

    private static final long PAGE_POLL_MS = 200;

    /**
     * Asked of the PC's page each second while the cover is up: whether the client is up (its root
     * no longer holds index.html's loading spinner; null when the page has no root, so it is not
     * the client), and the sum of the sizes of the page and the files it starts with, from a HEAD of
     * each (0 when any of them gives no Content-Length, as a proxy that streams compressed files
     * does; -1 until they answer).
     */
    private static final String PAGE_SCRIPT =
        "(() => {" +
        "  const root = document.getElementById('root');" +
        "  const loading = document.readyState === 'loading';" +
        "  if (!loading && window.__ovisOpeningSize === undefined) {" +
        "    window.__ovisOpeningSize = -1;" +
        "    const files = [location.origin + location.pathname, ...Array.from(document.querySelectorAll('script[src], link[rel=stylesheet][href], link[rel=modulepreload][href]'), (e) => e.src || e.href)];" +
        "    Promise.all(files.map((file) => fetch(file, { method: 'HEAD', credentials: 'include', cache: 'no-store' }).then((r) => {" +
        "      const size = Number(r.headers.get('content-length'));" +
        "      if (!r.ok || !(size > 0)) throw new Error('no size');" +
        "      return size;" +
        "    }))).then((sizes) => { window.__ovisOpeningSize = sizes.reduce((a, b) => a + b, 0); }, () => { window.__ovisOpeningSize = 0; });" +
        "  }" +
        "  return JSON.stringify({ client: root ? !root.querySelector(':scope > .boot') && !loading : loading ? false : null, size: window.__ovisOpeningSize ?? -1 });" +
        "})()";

    private String openingLabel;
    private String openingHost;

    /** Whether the app gave up on the first page: the load it dropped may still report its end. */
    private boolean gaveUp;

    private boolean checked;

    /**
     * Takes Back for the page while the entry behind the one shown is a page of the same place
     * (syncBack): the page closes what is open, or shows the pane before. While it is off, Back is
     * the system's: it leaves the app, and draws its own way out (predictive back).
     */
    private final OnBackPressedCallback pageBack = new OnBackPressedCallback(false) {
        @Override
        public void handleOnBackPressed() {
            WebView view = bridge.getWebView();
            if (view.canGoBack()) {
                view.goBack();
                return;
            }
            setEnabled(false);
            getOnBackPressedDispatcher().onBackPressed();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(HerdrShellPlugin.class);
        registerPlugin(OvisAuthPlugin.class);
        registerPlugin(SaveImagePlugin.class);
        registerPlugin(OvisDirectPlugin.class);
        registerPlugin(OvisSshPlugin.class);
        String link = takeAppLink(getIntent(), savedInstanceState == null);
        if (link != null) openAppLink(link);
        else openAlert(getIntent(), savedInstanceState == null);
        String pc = OvisSshPlugin.opening(this, PCStore.link != null ? null : PCStore.current(this));
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
                // No allowNavigation: the PC's own pages stay in the WebView already, and Capacitor
                // turns each entry into another bridge origin rule (https://host, or a host starting
                // with "http" as is: invalid, which again drops the bridge's origin check). Links to
                // any other origin, another port on the PC's host included, go to the browser
                // (shouldOverrideUrlLoading below).
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
        // CapacitorCookies makes the WebView's cookies the process's CookieHandler, so the native
        // CapacitorHttp would carry them, an SSH PC's tunnel gate among them, for any page with the
        // bridge to any address; nothing in the app uses it, and the WebView keeps its own cookies
        java.net.CookieHandler.setDefault(null);
        keepClearOfNavigationButtons();
        String appOrigin = bridge.getScheme() + "://" + bridge.getHost();
        getOnBackPressedDispatcher().addCallback(this, pageBack);
        if (host == null) {
            bridge.setWebViewClient(
                new BridgeWebViewClient(bridge) {
                    @Override
                    public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                        super.doUpdateVisitedHistory(view, url, isReload);
                        syncBack(appOrigin);
                    }
                }
            );
        }
        followThemeColor(host == null ? Collections.singleton(appOrigin) : new HashSet<>(Arrays.asList(appOrigin, origin)));
        if (host != null) {
            // CapacitorCookies is off (not in the plugins configuration), yet its load() still adds a
            // JavaScript interface whose setCookie writes a cookie for any origin, open to every page
            // and frame: a sign-in page in front of the PC must not reach it. Capacitor's page script
            // looks for it before use. Pages loaded from now on no longer see it.
            bridge.getWebView().removeJavascriptInterface("CapacitorCookiesAndroidInterface");
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
                            state.put("kind", PCStore.failureKind == null ? "" : PCStore.failureKind);
                            state.put("command", PCStore.failureCommand == null ? "" : PCStore.failureCommand);
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
                        if (
                            signingIn &&
                            request.isForMainFrame() &&
                            ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) &&
                            !appOrigin.equals(url.getScheme() + "://" + url.getHost())
                        ) {
                            if (refuseSignInStep(url.toString(), pc)) return true;
                            signInAt = PCStore.origin(url.toString());
                            return false;
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
                        // Capacitor keeps a link in the WebView when only its scheme and host match the PC's,
                        // so another server on the PC's host (a dev server on another port) would replace Ovis
                        // with no way back. A page of another origin, port included, goes to the browser.
                        if (
                            request.isForMainFrame() &&
                            ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) &&
                            !PCStore.sameOrigin(url.toString(), origin) &&
                            !PCStore.sameOrigin(url.toString(), appOrigin)
                        ) {
                            Intent browse = new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE);
                            try {
                                startActivity(browse);
                            } catch (ActivityNotFoundException noBrowser) {
                            }
                            return true;
                        }
                        return super.shouldOverrideUrlLoading(view, request);
                    }

                    // every entry the page adds or leaves (a sheet's, a pane's) comes through here,
                    // as a page load does
                    @Override
                    public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                        super.doUpdateVisitedHistory(view, url, isReload);
                        syncBack(pc);
                    }

                    // WebView does not ask shouldOverrideUrlLoading about a form's POST: a sign-in form
                    // posting over plain http is held here, before anything is sent, and a POST that goes
                    // on is where the next step is judged from. WebView follows a POST's redirects with
                    // no callback, so those stay unchecked (the check is best effort)
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        Uri url = request.getUrl();
                        // an SSH PC's host at another port would get that PC's gate cookie (SshPcs.otherLoopbackPort)
                        if (SshPcs.otherLoopbackPort(url.toString())) {
                            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, new ByteArrayInputStream(new byte[0]));
                        }
                        if (
                            signingIn &&
                            request.isForMainFrame() &&
                            "POST".equalsIgnoreCase(request.getMethod()) &&
                            ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) &&
                            !appOrigin.equals(url.getScheme() + "://" + url.getHost())
                        ) {
                            if (refuseSignInStep(url.toString(), pc)) {
                                return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
                            }
                            signInAt = PCStore.origin(url.toString());
                        }
                        return super.shouldInterceptRequest(view, request);
                    }

                    // Capacitor tells its listeners of every failed request, a picture or a frame
                    // included, and not which one or why: only a failure of the page itself keeps the
                    // PC out of the saved list, and its reason goes to error.html, which Capacitor
                    // shows for both.
                    @Override
                    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                        if (request.isForMainFrame()) {
                            if (gaveUp && !pageShown) return;
                            pageFailed = true;
                            PCStore.fail(String.valueOf(error.getDescription()), null);
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
                            // an SSH PC's tunnel said why itself (OvisSshPlugin), in more words than its 503
                            if (!sshFailure(response)) PCStore.fail("HTTP " + response.getStatusCode() + (reason == null || reason.isEmpty() ? "" : " " + reason), null);
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
                        // WebView reports a main-frame page as started once its response has come: the
                        // PC answered, and the page is on its way however slowly
                        String url = webView.getUrl();
                        if (watch != null && url != null && PCStore.belongs(url, pc)) watch.answered(SystemClock.elapsedRealtime());
                    }

                    @Override
                    public void onPageCommitVisible(WebView webView, String url) {
                        // the main frame's first page is on screen, before its pictures or scripts finish:
                        // the PC's, a sign-in's or the error page. The PC's own page keeps the cover, with
                        // its bar, until the client is up (watchOpening): until then it shows only its
                        // loading spinner, for minutes on a slow link
                        pageShown = true;
                        if (url == null || !PCStore.belongs(url, pc)) hideOpening();
                        else answerTimer.post(MainActivity.this::pollPage);
                    }

                    @Override
                    public void onPageLoaded(WebView webView) {
                        // Chromium reports a page that failed as loaded too, before the error page;
                        // only a page of this very PC (its scheme, host and port, and its scope for a relay PC) counts
                        String url = webView.getUrl();
                        // a page that finishes once this activity is leaving (reopen) is not the page the app shows next
                        if (leaving || pageFailed || url == null || !PCStore.belongs(url, pc)) return;
                        signingIn = false;
                        PCStore.startLoaded(pc);
                        PCStore.fail(null, null);
                        PCStore.redirects = 0;
                        pageLoaded = true;
                        keepIfOvis(pc, url);
                    }
                }
            );
            showOpening(pc);
        }
    }

    /**
     * Keeps the PC `pc`, whose page `url` has loaded, unless it is not Ovis: a web server that is not
     * Ovis would otherwise be saved and opened at every start, with no Change PC and Back closing the
     * app.
     */
    private void keepIfOvis(String pc, String url) {
        if (PCStore.scoped(pc)) {
            PCStore.remember(this, pc);
            return;
        }
        if (checked) return;
        checked = true;
        String cookies = CookieManager.getInstance().getCookie(url);
        android.content.Context app = getApplicationContext();
        long since = PCStore.forgetCount();
        new Thread(() -> {
            PCStore.Check found = PCStore.check(url, cookies, PCStore.ANSWER_SECONDS * 1000L);
            if (!found.kind.equals("not-ovis")) {
                PCStore.rememberUnlessForgotten(app, pc, since);
                return;
            }
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                PCStore.fail(found.detail == null ? "It answered, but not as Ovis." : "It answered " + found.detail + ", not as Ovis.", "not-ovis");
                bridge.getWebView().loadUrl(bridge.getErrorUrl());
            });
        }, "ovis-check").start();
    }

    private static boolean korean() {
        return "ko".equals(Locale.getDefault().getLanguage());
    }

    private void showOpening(String pc) {
        String origin = PCStore.origin(pc);
        String label = PCStore.names(this).optString(pc, "");
        if (label.isEmpty()) label = origin == null ? pc : Uri.parse(origin).getAuthority();
        float density = getResources().getDisplayMetrics().density;
        int pad = Math.round(24 * density);

        ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(1000);
        bar.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.parseColor("#f0a830")));
        bar.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(Color.parseColor("#f0a830")));
        bar.setVisibility(View.GONE);
        ProgressBar spinner = new ProgressBar(this);
        spinner.setIndeterminate(true);
        spinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(Color.parseColor("#f0a830")));
        TextView text = new TextView(this);
        text.setText(korean() ? label + " 여는 중…" : "Opening " + label + "…");
        text.setTextColor(Color.parseColor("#d8d0c3"));
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        text.setGravity(Gravity.CENTER);
        text.setPadding(0, pad / 2, 0, pad);
        Button keep = new Button(this);
        keep.setText(korean() ? "계속 기다리기" : "Keep waiting");
        keep.setAllCaps(false);
        keep.setTextColor(Color.parseColor("#12100e"));
        keep.setBackgroundColor(Color.parseColor("#f0a830"));
        keep.setPadding(pad, pad / 2, pad, pad / 2);
        keep.setVisibility(View.GONE);
        keep.setOnClickListener(v -> {
            if (watch != null) watch.keepWaiting(SystemClock.elapsedRealtime());
            showStage();
        });
        Button retry = new Button(this);
        retry.setText(korean() ? "다시 시도" : "Try again");
        retry.setAllCaps(false);
        retry.setTextColor(Color.parseColor("#f2ebdf"));
        retry.setBackgroundColor(Color.parseColor("#181613"));
        retry.setPadding(pad, pad / 2, pad, pad / 2);
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(v -> retry());
        Button change = new Button(this);
        change.setText(korean() ? "PC 바꾸기" : "Change PC");
        change.setAllCaps(false);
        change.setTextColor(Color.parseColor("#f2ebdf"));
        change.setBackgroundColor(Color.parseColor("#181613"));
        change.setPadding(pad, pad / 2, pad, pad / 2);
        change.setOnClickListener(v -> changePc());

        LinearLayout stack = new LinearLayout(this);
        stack.setOrientation(LinearLayout.VERTICAL);
        stack.setGravity(Gravity.CENTER);
        stack.setPadding(pad, pad, pad, pad);
        stack.addView(spinner);
        stack.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        stack.addView(text);
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        gap.bottomMargin = pad / 2;
        stack.addView(keep, gap);
        stack.addView(retry, gap);
        stack.addView(change);
        FrameLayout cover = new FrameLayout(this);
        cover.setBackgroundColor(Color.parseColor("#12100e"));
        cover.setClickable(true);
        cover.addView(stack, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        addContentView(cover, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        openingView = cover;
        openingSpinner = spinner;
        openingText = text;
        openingKeep = keep;
        openingRetry = retry;
        openingBar = bar;
        openingPc = pc;
        openingLabel = label;
        openingHost = origin == null ? pc : Uri.parse(origin).getAuthority();
        watch = new OpeningWatch(SystemClock.elapsedRealtime(), answerDelay(), TrafficStats.getUidRxBytes(Process.myUid()));
        answerTimer.postDelayed(this::watchOpening, 1000);
    }

    private void watchOpening() {
        if (openingView == null || isFinishing() || isDestroyed()) return;
        long now = SystemClock.elapsedRealtime();
        watch.received(now, TrafficStats.getUidRxBytes(Process.myUid()));
        if (watch.stage(now) == OpeningWatch.Stage.NO_ANSWER) {
            gaveUp = true;
            PCStore.fail(
                watch.connectedOnly()
                    ? openingHost + " accepted the connection but sent no page."
                    : openingHost + " did not answer within " + PCStore.ANSWER_SECONDS + " seconds.",
                "timeout"
            );
            bridge.getWebView().stopLoading();
            bridge.getWebView().loadUrl(bridge.getErrorUrl());
            return;
        }
        showStage();
        askPage();
        answerTimer.postDelayed(this::watchOpening, 1000);
    }

    private void pollPage() {
        if (openingView == null || isFinishing() || isDestroyed()) return;
        askPage();
        answerTimer.postDelayed(this::pollPage, PAGE_POLL_MS);
    }

    private void askPage() {
        WebView view = bridge.getWebView();
        String url = view.getUrl();
        if (!watch.isAnswered() || url == null || !PCStore.belongs(url, openingPc)) return;
        view.evaluateJavascript(PAGE_SCRIPT, (value) -> {
            if (openingView == null || value == null || "null".equals(value)) return;
            try {
                org.json.JSONObject page = new org.json.JSONObject(new org.json.JSONArray("[" + value + "]").getString(0));
                long size = page.optLong("size", -1);
                if (size >= 0) pageBytes = size;
                if (page.isNull("client") ? pageShown : page.optBoolean("client")) hideOpening();
            } catch (org.json.JSONException unreadable) {
            }
        });
    }

    @Override
    public void onStart() {
        super.onStart();
        if (openingView != null && watch != null) {
            answerTimer.removeCallbacksAndMessages(null);
            answerTimer.post(this::watchOpening);
            if (pageShown) answerTimer.post(this::pollPage);
        }
    }

    @Override
    public void onStop() {
        answerTimer.removeCallbacksAndMessages(null);
        super.onStop();
    }

    private void showStage() {
        if (openingView == null) return;
        OpeningWatch.Stage stage = watch.stage(SystemClock.elapsedRealtime());
        boolean ko = korean();
        long kb = watch.bytesSoFar() / 1024;
        long totalKb = pageBytes > 0 ? (pageBytes + 1023) / 1024 : 0;
        int permille = watch.permille(pageBytes);
        String amount = kb <= 0 ? "" : totalKb > 0
            ? (ko ? String.format(Locale.getDefault(), "\n%,dKB / %,dKB 받음", Math.min(kb, totalKb), totalKb) : String.format(Locale.getDefault(), "\n%,d KB of %,d KB", Math.min(kb, totalKb), totalKb))
            : (ko ? String.format(Locale.getDefault(), "\n%,dKB 받음", kb) : String.format(Locale.getDefault(), "\n%,d KB so far", kb));
        String text;
        if (stage == OpeningWatch.Stage.SLOW) {
            text = (ko ? "연결이 느립니다. " + openingLabel + " 여는 중…" : "Slow connection. Still opening " + openingLabel + "…") + amount;
        } else if (stage == OpeningWatch.Stage.STALLED && pageLoaded) {
            text = ko
                ? openingLabel + "의 페이지는 받았지만 앱이 시작되지 않았습니다."
                : "The page from " + openingLabel + " arrived, but the app did not start.";
        } else if (stage == OpeningWatch.Stage.STALLED) {
            long seconds = OpeningWatch.STALL_MS / 1000;
            text = ko
                ? openingLabel + "에서 " + seconds + "초 동안 아무것도 오지 않았습니다. 연결이 끊겼을 수 있습니다."
                : "Nothing has come from " + openingLabel + " for " + seconds + " seconds. The connection may have dropped.";
        } else {
            text = ko ? openingLabel + " 여는 중…" : "Opening " + openingLabel + "…";
        }
        openingText.setText(text);
        boolean bar = watch.isAnswered() && stage != OpeningWatch.Stage.STALLED;
        openingBar.setVisibility(bar ? View.VISIBLE : View.GONE);
        openingBar.setIndeterminate(permille < 0);
        if (permille >= 0) openingBar.setProgress(permille);
        openingSpinner.setVisibility(bar ? View.GONE : stage == OpeningWatch.Stage.STALLED ? View.INVISIBLE : View.VISIBLE);
        openingKeep.setVisibility(stage == OpeningWatch.Stage.STALLED && !pageLoaded ? View.VISIBLE : View.GONE);
        openingRetry.setVisibility(stage == OpeningWatch.Stage.STALLED ? View.VISIBLE : View.GONE);
    }

    private static long answerDelay() {
        long by = PCStore.answerBy;
        PCStore.answerBy = 0;
        if (by == 0) return PCStore.ANSWER_SECONDS * 1000L;
        return Math.max(PCStore.PAGE_FLOOR_MS, by - android.os.SystemClock.elapsedRealtime());
    }

    private void hideOpening() {
        answerTimer.removeCallbacksAndMessages(null);
        if (openingView == null) return;
        ((ViewGroup) openingView.getParent()).removeView(openingView);
        openingView = null;
    }

    @Override
    public void onDestroy() {
        answerTimer.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    /**
     * Gives Back to the page or to the system, by where the WebView's history stands: the page's while
     * the page shown and the entry behind it are pages of `place`, the PC or the app's own origin
     * (PCStore.pageTakesBack). Told before the next Back, so the system knows which way out to draw.
     */
    private void syncBack(String place) {
        WebView view = bridge.getWebView();
        WebBackForwardList entries = view.copyBackForwardList();
        int at = entries.getCurrentIndex();
        String here = at < 0 ? null : entries.getItemAtIndex(at).getUrl();
        String before = at < 1 ? null : entries.getItemAtIndex(at - 1).getUrl();
        pageBack.setEnabled(view.canGoBack() && PCStore.pageTakesBack(here, before, place));
    }

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
            return;
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
     * to the PC's name, another port). Anything else is taken for a sign-in in front of the PC (an
     * authenticating proxy such as Cloudflare Access): it loads without the bridge and is never saved
     * or made the PC, and the way back to the PC stays in the WebView (signingIn). The address's own
     * page would get the bridge too, so the place it leads to gets nothing more. Once the first page shows,
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
            String insecure = tooMany ? null : PCStore.refusedHop(from, target, ovis, path);
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || gaveUp) return;
                if (tooMany) {
                    PCStore.fail("Too many redirects", null);
                    bridge.getWebView().loadUrl(bridge.getErrorUrl());
                } else if (insecure != null) {
                    PCStore.fail("It redirected over plain http to " + insecure + ", which the app does not follow on its own." + (ovis == null ? "" : " If " + ovis + " is your PC, open it itself."), null);
                    bridge.getWebView().loadUrl(bridge.getErrorUrl());
                } else if (ovis != null) {
                    PCStore.redirects++;
                    PCStore.open(this, ovis, PCStore.startOn(ovis, target));
                    reopen();
                } else if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                    // without it Capacitor's bridge is a JavaScript interface every page can call
                    String place = PCStore.origin(target);
                    PCStore.fail("It redirected to " + place + ", which did not answer as Ovis. If that is your PC, open " + place + " itself.", null);
                    bridge.getWebView().loadUrl(bridge.getErrorUrl());
                } else {
                    signingIn = true;
                    signInAt = PCStore.origin(target);
                    bridge.getWebView().loadUrl(target);
                }
            });
        }, "ovis-redirect").start();
    }

    /**
     * Whether the sign-in's next step, to `url`, is refused: over public plain http, or from https to
     * http (PCStore.refusedHop). The way back to the PC itself is never refused, as the user chose its
     * address.
     */
    private boolean refuseSignInStep(String url, String pc) {
        if (PCStore.belongs(url, pc)) return false;
        String insecure = PCStore.refusedHop(signInAt, url, null, null);
        if (insecure == null) return false;
        signingIn = false;
        PCStore.fail("The sign-in went over plain http to " + insecure + ", which the app does not follow on its own.", null);
        runOnUiThread(() -> bridge.getWebView().loadUrl(bridge.getErrorUrl()));
        return true;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        String link = takeAppLink(intent, true);
        if ((link != null && openAppLink(link)) || openAlert(intent, true)) {
            reopen();
            return;
        }
        super.onNewIntent(intent);
    }

    /**
     * A link to pair from opens at its PC's page when the app shows the hosted shell (its account's
     * list), so a scanned QR code lands on that PC; otherwise it waits for the connect screen
     * (PCStore.link). A view of a PC (a file, a pane) opens that PC at that view when the app has it
     * saved, as the browser would have; for any other PC the app has nothing to show.
     */
    private boolean openAppLink(String link) {
        if (PCStore.pairingLink(link)) {
            if (PCStore.showsHostedShell(PCStore.current(this))) {
                PCStore.open(this, PCStore.appScope(link), link);
                PCStore.fail(null, null);
                PCStore.redirects = 0;
                return true;
            }
            PCStore.link = link;
            return true;
        }
        String scope = PCStore.appScope(link);
        if (!PCStore.saved(this).contains(scope)) return false;
        PCStore.open(this, scope, link);
        PCStore.fail(null, null);
        PCStore.redirects = 0;
        return true;
    }

    /**
     * The app link (PCStore.appLink) `intent` carries, taken out of it so it is opened once: Capacitor's
     * load() passes the starting intent to onNewIntent again. Null for any other intent, and for a
     * link the system hands back with the activity restored or started again from Recents, which the
     * user opened before.
     */
    private static String takeAppLink(Intent intent, boolean fresh) {
        if (intent == null) return null;
        Uri data = intent.getData();
        String link = PCStore.appLink(intent.getAction(), data == null ? null : data.toString());
        if (link == null) return null;
        intent.setData(null);
        boolean fromRecents = (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
        return fresh && !fromRecents ? link : null;
    }

    /**
     * Whether `response` is an SSH PC tunnel's failure (SshTunnel.FAILURE_HEADER) whose reason the tunnel already
     * gave (OvisSshPlugin.failed). The header alone is not enough: the PC's own servers can send it through the tunnel.
     */
    private static boolean sshFailure(WebResourceResponse response) {
        String kind = PCStore.failureKind;
        if (kind == null || !kind.startsWith("ssh-")) return false;
        Map<String, String> headers = response.getResponseHeaders();
        if (headers == null) return false;
        for (String name : headers.keySet()) if (SshTunnel.FAILURE_HEADER.equalsIgnoreCase(name)) return true;
        return false;
    }

    /**
     * False, leaving the open page alone, for any other intent, an alert that names no saved PC, one the
     * system hands back with the activity restored or started from Recents, which was opened before,
     * and one without this app's proof (AlertProof): this activity is exported, and
     * another app's alert is a bare launch, which switches nothing and keeps a pairing link waiting.
     */
    private boolean openAlert(Intent intent, boolean fresh) {
        if (intent == null || !OvisMessagingService.ACTION_OPEN_ALERT.equals(intent.getAction())) return false;
        boolean own;
        try {
            own = AlertProof.own(this, intent);
            intent.removeExtra(AlertProof.EXTRA);
        } catch (RuntimeException unreadable) {
            // another app's intent with an extra of a class this app lacks: Android 8 to 12 unparcel
            // every extra at the first read and throw, which would crash the app. Its extras go
            intent.replaceExtras((Bundle) null);
            own = false;
        }
        intent.setAction(Intent.ACTION_MAIN);
        intent.setData(null);
        boolean fromRecents = (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
        if (!own || !fresh || fromRecents) return false;
        WebView view = bridge == null ? null : bridge.getWebView();
        String url = view == null ? null : view.getUrl();
        String shown = openingView != null || url == null || url.equals(bridge.getErrorUrl()) ? null : url;
        PCStore.AlertTap alert = PCStore.alertTap(
            PCStore.saved(this),
            PCStore.current(this),
            shown,
            intent.getStringExtra(OvisMessagingService.EXTRA_ORIGIN),
            intent.getStringExtra(OvisMessagingService.EXTRA_SERVER_ID),
            intent.getStringExtra(OvisMessagingService.EXTRA_MACHINE),
            intent.getStringExtra(OvisMessagingService.EXTRA_WORKSPACE),
            intent.getStringExtra(OvisMessagingService.EXTRA_PANE)
        );
        if (alert == null) return false;
        if (alert.selection != null) {
            // as public/sw.js posts it to the open window, through a page event a page on plain http hears too
            view.evaluateJavascript(PCStore.selectionScript(alert.selection), null);
            return false;
        }
        PCStore.link = null;
        PCStore.open(this, alert.pc, alert.address);
        PCStore.fail(null, null);
        PCStore.redirects = 0;
        return true;
    }

    void retry() {
        PCStore.fail(null, null);
        PCStore.redirects = 0;
        reopen();
    }

    void changePc() {
        PCStore.setCurrent(this, null);
        reopen();
    }

    private static final String LEAVING_SCRIPT = "window.dispatchEvent(new Event('ovis-page-leaving'))";

    private static final long LEAVING_WAIT_MS = 1000;

    private boolean leaving;

    void reopen() {
        if (leaving) return;
        leaving = true;
        WebView view = bridge == null ? null : bridge.getWebView();
        if (view == null) {
            restart();
            return;
        }
        Runnable once = new Runnable() {
            private boolean done;

            @Override
            public void run() {
                if (done) return;
                done = true;
                restart();
            }
        };
        view.evaluateJavascript(LEAVING_SCRIPT, (value) -> once.run());
        view.postDelayed(once, LEAVING_WAIT_MS);
    }

    private void restart() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        finish();
        overridePendingTransition(0, 0);
        startActivity(intent);
    }
}
