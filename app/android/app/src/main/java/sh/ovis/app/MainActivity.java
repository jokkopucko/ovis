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
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
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
import com.getcapacitor.Bridge;
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
     * The hosted shell this build carries, when this activity opens the hosted origin (home, or a relay PC under it) and
     * answers it from that copy (BundledShell); null where the shell comes from the network, or the page is another.
     */
    private BundledShell shell;

    /** Whether the bundled shell's first page here is its boot page, which clears the workers the network's copy left. */
    private boolean booting;

    /** What this activity opened as its first page (Home.screen). */
    private Home.Screen screen = Home.Screen.BUNDLED;

    /**
     * Where the hosted Connect a PC screen is, in an activity that opened it (Home.Phase); null in any other. It is
     * the hosted app opened as the first page, as a PC is, without being the current PC: its failures give way to the
     * app's own page, never to error.html, and a relay PC's page coming up in it makes the hosted app the current PC.
     */
    private volatile Home.Phase home;

    /** How long home has been loading with the app in front (watchOpening). */
    private Home.Clock homeClock = new Home.Clock(0);

    /** The PC that was current when home opened: a relay PC's page landing later makes the hosted app the PC only over that one. */
    private String homeOver;

    /**
     * Asked of home's page while its cover is up: what the page is, as facts for Home.drawn to judge, so an empty
     * answer or another page of the hosted origin never counts as the hosted screen.
     */
    private static final String HOME_SCRIPT =
        "(() => {" +
        "  const root = document.getElementById('root');" +
        "  return JSON.stringify({" +
        "    shell: document.querySelector('meta[name=\"ovis-shell\"]') !== null," +
        "    root: root !== null," +
        "    boot: root !== null && root.querySelector(':scope > .boot') !== null," +
        "    children: root === null ? 0 : root.childElementCount," +
        "    loading: document.readyState === 'loading'" +
        "  });" +
        "})()";

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

    /** The page's own theme-color, painted on the bars once no cover is over the page (showOpening, hideOpening). */
    private Integer pageBarColor;

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
    private Button openingChange;

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
     * Back while the page has an entry behind it goes to that entry in the WebView: a pane before, a sheet closing, or the
     * page a relay PC's More left for the hosted app's Add a PC (`#add`, a new document, BackToPageTest). With nothing
     * behind it, Back is the system's (leave the app). Always on, so no navigation has to be seen first to turn it on:
     * Android 15 and 16 left the app when the enabled state lagged a new document.
     */
    private final OnBackPressedCallback pageBack = new OnBackPressedCallback(true) {
        @Override
        public void handleOnBackPressed() {
            // the app's own page opened to choose another way goes back to the PC it was opened from at once
            if (back(true) == Home.Back.CURRENT) {
                backToCurrent();
                return;
            }
            WebView view = bridge.getWebView();
            long now = SystemClock.uptimeMillis();
            // a press while the step back an earlier press took is still landing is that same press (BackRacesTest): a
            // second step would pass the page meant, or, landing on a first page still loading, leave the app
            if (stepAt >= 0 && (now - stepAt < STEP_COALESCE_MS || (!stepLanded && now - stepAt < STEP_WAIT_MS))) return;
            // a press while the page goes elsewhere (Add a PC opening) and before that has an entry: stays on the page,
            // whose entry is often the first, with nothing behind it that would keep Back in the app. Only once a page
            // is on screen: a freshly launched page still leaves the app on Back
            if (pageShown && navigatingAt >= 0 && now - navigatingAt < NAVIGATION_WAIT_MS) {
                navigatingAt = -1;
                view.stopLoading();
                return;
            }
            if (view.canGoBack()) {
                stepped(now);
                view.goBack();
                return;
            }
            // Add a PC left its page by script, which Chromium marks skippable for the browser's Back (canGoBack and
            // goBackOrForward pass over it, with the page still behind): on #add the page itself steps back, which no such
            // mark skips
            if (view.copyBackForwardList().getCurrentIndex() > 0 && "add".equals(Uri.parse(String.valueOf(view.getUrl())).getFragment())) {
                stepped(now);
                view.evaluateJavascript("history.back()", null);
                return;
            }
            // nothing behind the page: the PC the hosted screen was opened from, or the hosted screen the app's own page
            // or the demo was opened from (Home.back)
            Home.Back last = back(false);
            if (last == Home.Back.CURRENT) {
                backToCurrent();
                return;
            }
            if (last == Home.Back.HOME) {
                goHome();
                return;
            }
            if (last == Home.Back.DEMO_EXIT) {
                leaveDemo();
                return;
            }
            // the system's own Back, once: on Android 12 and later it may only send the app to the background, which
            // must find this on again when the app comes back
            setEnabled(false);
            getOnBackPressedDispatcher().onBackPressed();
            setEnabled(true);
        }
    };

    /** Presses this soon after a step back are that step's, whether or not it has landed yet. */
    private static final long STEP_COALESCE_MS = 300;
    /** How long an unlanded step holds later presses at most, so a step whose landing is never reported cannot hold Back. */
    private static final long STEP_WAIT_MS = 1_000;
    /** How long a navigation the page started counts as going on at most, for one that ends with no report (a download). */
    private static final long NAVIGATION_WAIT_MS = 15_000;
    /** When Back last stepped back in the WebView (uptime), or -1. */
    private long stepAt = -1;
    /** Whether the WebView reported the entry that step landed on (landed). */
    private boolean stepLanded = true;
    /** When the page started a navigation that has no entry yet (uptime), or -1. */
    private long navigatingAt = -1;

    private void stepped(long now) {
        stepAt = now;
        stepLanded = false;
    }

    /** What Back does here (Home.back): a relay PC's page that came up in the hosted screen is a PC's page. */
    private Home.Back back(boolean pageHasBack) {
        boolean current = PCStore.current(this) != null;
        return Home.back(home == Home.Phase.PC ? Home.Screen.PC : screen, BuildConfig.HOME_HOSTED, PCStore.homeFailed, current, PCStore.choosing && current, pageHasBack);
    }

    /** For the page's own back control (HerdrShell getState `back`): "current", "home" or "". */
    String backWay() {
        Home.Back back = back(false);
        return back == Home.Back.CURRENT ? "current" : back == Home.Back.HOME ? "home" : "";
    }

    /** Whether the page of the PC `origin` is what this activity shows (Home.pcShown): where an SSH tunnel's failure may put its error page. */
    boolean showsPc(String origin) {
        return Home.pcShown(screen, home) && origin != null && origin.equals(PCStore.current(this));
    }

    /** Whether this activity is on its way out to another screen (reopen). */
    boolean leaving() {
        return leaving;
    }

    /** Whether the app's own page was asked for to manage an SSH PC (PCStore.manage), which opens it on SSH. */
    boolean manages() {
        return screen == Home.Screen.BUNDLED && PCStore.manage;
    }

    /** Whether the hosted Connect a PC screen is what this activity shows or is opening. */
    boolean atHome() {
        Home.Phase phase = home;
        return phase == Home.Phase.LOADING || phase == Home.Phase.SHOWN;
    }

    /** Whether this activity shows the app's own page in place of the hosted screen, which did not load. */
    boolean fallback() {
        return screen == Home.Screen.BUNDLED && BuildConfig.HOME_HOSTED && PCStore.homeFailed;
    }

    /** Something happened to the hosted screen: what Home decides is carried out here, and nowhere else. */
    private void home(Home.Event happened) {
        Home.Phase phase = home;
        if (phase == null) return;
        // once the app is going elsewhere, nothing this page still does counts
        Home.Event event = leaving ? Home.Event.LEFT : happened;
        // nor does a relay PC's page landing after something else became the PC (a notification's, another screen's)
        if (event == Home.Event.RELAY_PC && !java.util.Objects.equals(homeOver, PCStore.current(this))) return;
        Home.Action action = Home.on(phase, event);
        home = Home.after(phase, event);
        if (action == Home.Action.LIFT_COVER) {
            hideOpening();
        } else if (action == Home.Action.FALL_BACK) {
            // this activity goes with its WebView, so a load that still finishes cannot bring the hosted screen back
            // over what the person types on the app's own page
            PCStore.homeFailed = true;
            bridge.getWebView().stopLoading();
            // at once: no page of a PC is up that would have text to hand over first (reopen)
            leaving = true;
            restart();
        } else if (action == Home.Action.KEEP_HOSTED) {
            PCStore.keepHosted(this, BuildConfig.APP_ORIGIN);
            // a cover still up is a PC's from here on, with its Change PC
            if (openingChange != null) openingChange.setVisibility(View.VISIBLE);
        }
    }

    /** A main-frame load failed: true when it was the hosted screen's, which gives way to the app's own page instead of error.html. */
    private boolean gaveWayAtHome() {
        Home.Phase phase = home;
        if (phase == null || phase == Home.Phase.PC) return false;
        home(Home.Event.FAILED);
        return true;
    }

    /** The WebView reported its current entry (doUpdateVisitedHistory, onPageCommitVisible): a step or navigation landed. */
    private void landed() {
        stepLanded = true;
        navigatingAt = -1;
    }

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
        // choosing another way (PCStore.choosing): the connect screen, the current PC kept for Back
        String saved = PCStore.choosing ? null : OvisSshPlugin.opening(this, PCStore.link != null ? null : PCStore.current(this));
        screen = Home.screen(BuildConfig.HOME_HOSTED, saved != null && PCStore.origin(saved) != null, PCStore.demo, PCStore.bundledAsked(), PCStore.homeFailed);
        // #pcs: the hosted app's front page as the app's own way there, not a launch that goes on to the PC opened last;
        // or the fragment the app's own page asked for (a sign-in), which this one attempt takes
        String homeStart = PCStore.homeStart == null ? "#pcs" : PCStore.homeStart;
        if (screen == Home.Screen.HOME) {
            home = Home.Phase.LOADING;
            homeOver = PCStore.current(this);
            PCStore.homeStart = null;
        }
        // the hosted screen opens as a PC's first page does, at the hosted app's origin, which is not made the current PC
        String pc = screen == Home.Screen.PC ? saved : screen == Home.Screen.HOME ? BuildConfig.APP_ORIGIN : null;
        String origin = pc == null ? null : PCStore.origin(pc);
        String host = origin == null ? null : Uri.parse(origin).getHost();
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        boolean hostedOrigin = origin != null && PCStore.sameOrigin(origin, BuildConfig.APP_ORIGIN);
        shell = hostedOrigin && BuildConfig.SHELL_BUNDLED ? BundledShell.at(this, BuildConfig.APP_ORIGIN) : null;
        if (hostedOrigin && !BuildConfig.SHELL_BUNDLED) BundledShell.loadedFromNetwork(this);
        booting = shell != null && BundledShell.needsBoot(this);
        // a build that carries the shell and cannot serve it (a WebView without what that needs, a damaged copy) shows the
        // app's own error page, never the shell from the network; its Change PC leads to the app's own page (homeFailed)
        boolean shellMissing = hostedOrigin && BuildConfig.SHELL_BUNDLED && shell == null;
        if (shellMissing) {
            PCStore.fail(BundledShell.missingReason(BundledShell.supported(), korean()), "app-shell");
            PCStore.homeFailed = true;
            home = null;
            screen = Home.Screen.BUNDLED;
        }
        String pageHost = shellMissing ? null : host;
        if (pageHost != null) {
            String start = home != null ? "/" + homeStart : PCStore.startPath(PCStore.pendingStart, pc);
            // Capacitor makes server.url the bridge's origin rule, which takes no path, query or
            // trailing slash: such a rule throws, and Capacitor falls back to a bridge that every
            // frame (a preview's iframe included) can call. So server.url is the bare origin, and a
            // pairing link's path, query and fragment (a relay offer's `#offer=`) come in as the start
            // path until a PC page has loaded; a relay PC starts at its scope after that.
            // The bundled shell keeps this server.url, so the bridge's origin rules and every gate that reads them decide as
            // with the shell from the network: only its answers come from the app (BundledShell.serve below)
            config = new CapConfig.Builder(this)
                .setServerUrl(origin)
                .setStartPath(booting ? BundledShell.bootStart(start) : start)
                // Capacitor's own client for a worker's fetches would take the network for the hosted origin: the
                // bundled shell sets its own (beforeFirstPage)
                .setResolveServiceWorkerRequests(shell == null)
                // No allowNavigation: the PC's own pages stay in the WebView already, and Capacitor
                // turns each entry into another bridge origin rule (https://host, or a host starting
                // with "http" as is: invalid, which again drops the bridge's origin check). Links to
                // any other origin, another port on the PC's host included, go to the browser
                // (shouldOverrideUrlLoading below).
                .setErrorPath("error.html")
                .setBackgroundColor(pageColor())
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
        } else if (screen == Home.Screen.DEMO || shellMissing) {
            // the bundled demo, or the app's own error page, as the first page, with what capacitor.config.json sets for the
            // app's own pages
            config = new CapConfig.Builder(this)
                .setStartPath(shellMissing ? "/error.html" : "/demo/index.html")
                .setBackgroundColor(pageColor())
                .setWebContentsDebuggingEnabled(debuggable)
                .setLoggingEnabled(false)
                .setPluginsConfiguration(new JSObject().put("SystemBars", new JSObject().put("style", "DARK")))
                .create();
        }
        super.onCreate(savedInstanceState);
        // behind every first page before it paints, the app's own page included (capacitor.config.json has one colour),
        // and the bars to suit it until the page gives its own theme-color: after SystemBars, which sets its configured
        // style in a task of its own
        bridge.getWebView().setBackgroundColor(getColor(R.color.ovis_page));
        bridge.executeOnMainThread(() -> paintBars(barColor != null ? barColor : getColor(R.color.ovis_page)));
        // CapacitorCookies makes the WebView's cookies the process's CookieHandler, so the native
        // CapacitorHttp would carry them, an SSH PC's tunnel gate among them, for any page with the
        // bridge to any address; nothing in the app uses it, and the WebView keeps its own cookies
        java.net.CookieHandler.setDefault(null);
        keepClearOfNavigationButtons();
        String appOrigin = bridge.getScheme() + "://" + bridge.getHost();
        BundledShell served = shell;
        getOnBackPressedDispatcher().addCallback(this, pageBack);
        if (pageHost == null) {
            bridge.setWebViewClient(
                new BridgeWebViewClient(bridge) {
                    @Override
                    public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                        super.doUpdateVisitedHistory(view, url, isReload);
                        landed();
                    }
                }
            );
        }
        followThemeColor(pageHost == null ? Collections.singleton(appOrigin) : new HashSet<>(Arrays.asList(appOrigin, origin)));
        if (pageHost != null) {
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
                            // the hosted app's origin: a failure of the hosted app itself is no PC's (error.html)
                            state.put("app", BuildConfig.APP_ORIGIN);
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
                                // the hosted screen led elsewhere (a network's sign-in page): it is not up, and no
                                // other origin becomes the PC in its place
                                if (!gaveWayAtHome()) followRedirect(origin, url.toString());
                                return true;
                            }
                        }
                        // Capacitor keeps a link in the WebView when only its scheme and host match the PC's,
                        // so another server on the PC's host (a dev server on another port) would replace Ovis
                        // with no way back. A page of another origin, port included, goes to the browser.
                        if (
                            request.isForMainFrame() &&
                            ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) &&
                            // read from the URL's parts: one java.net.URI refuses (a raw `|` in its query) is still this origin
                            !BundledShell.onOrigin(url.getScheme(), url.getHost(), url.getPort(), origin) &&
                            !BundledShell.onOrigin(url.getScheme(), url.getHost(), url.getPort(), appOrigin)
                        ) {
                            Intent browse = new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE);
                            try {
                                startActivity(browse);
                            } catch (ActivityNotFoundException noBrowser) {
                            }
                            return true;
                        }
                        boolean taken = super.shouldOverrideUrlLoading(view, request);
                        // a page of the PC's the WebView goes on to: going on until its entry is reported (landed)
                        if (!taken && request.isForMainFrame() && !request.isRedirect()) navigatingAt = SystemClock.uptimeMillis();
                        return taken;
                    }

                    // every entry the page adds or leaves (a sheet's, a pane's, Add a PC's) comes through here
                    @Override
                    public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                        super.doUpdateVisitedHistory(view, url, isReload);
                        landed();
                        // a PC's row on the hosted screen is the page's own link, which the app is not asked to open
                        if (Home.relayPc(url, BuildConfig.APP_ORIGIN)) home(Home.Event.RELAY_PC);
                    }

                    // WebView does not ask shouldOverrideUrlLoading about a form's POST: a sign-in form
                    // posting over plain http is held here, before anything is sent, and a POST that goes
                    // on is where the next step is judged from. WebView follows a POST's redirects with
                    // no callback, so those stay unchecked (the check is best effort)
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        // the hosted origin from the shell this build carries, never the network (BundledShell)
                        if (served != null) return served.serve(request, () -> pageRequest(view, request));
                        return pageRequest(view, request);
                    }

                    private WebResourceResponse pageRequest(WebView view, WebResourceRequest request) {
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
                            if (gaveWayAtHome()) return;
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
                            if (gaveWayAtHome()) return;
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
                        String url = webView.getUrl();
                        // the bundled shell's boot page is the app's own step before the page asked for
                        if (served != null && BundledShell.isBoot(url, BuildConfig.APP_ORIGIN)) return;
                        pageFailed = false;
                        // WebView reports a main-frame page as started once its response has come: the
                        // PC answered, and the page is on its way however slowly
                        if (watch != null && url != null && PCStore.belongs(url, pc)) watch.answered(SystemClock.elapsedRealtime());
                    }

                    @Override
                    public void onPageCommitVisible(WebView webView, String url) {
                        if (served != null && BundledShell.isBoot(url, BuildConfig.APP_ORIGIN)) return;
                        // the main frame's first page is on screen, before its pictures or scripts finish:
                        // the PC's, a sign-in's or the error page. The PC's own page keeps the cover, with
                        // its bar, until the client is up (watchOpening): until then it shows only its
                        // loading spinner, for minutes on a slow link
                        pageShown = true;
                        landed();
                        if (url != null && PCStore.belongs(url, pc)) answerTimer.post(MainActivity.this::pollPage);
                        // the hosted screen's cover lifts over the hosted screen alone, never over a page that failed
                        else if (home == null || home == Home.Phase.PC) hideOpening();
                    }

                    @Override
                    public void onPageLoaded(WebView webView) {
                        // Chromium reports a page that failed as loaded too, before the error page;
                        // only a page of this very PC (its scheme, host and port, and its scope for a relay PC) counts
                        String url = webView.getUrl();
                        // a page that finishes once this activity is leaving (reopen) is not the page the app shows next
                        if (leaving || pageFailed || url == null || !PCStore.belongs(url, pc) || (served != null && BundledShell.isBoot(url, BuildConfig.APP_ORIGIN))) return;
                        pageLoaded = true;
                        // the hosted screen is no PC yet: nothing is kept or saved until a PC's page comes up in it
                        if (atHome()) return;
                        signingIn = false;
                        PCStore.startLoaded(pc);
                        PCStore.fail(null, null);
                        PCStore.redirects = 0;
                        // a PC is up: the next Connect a PC tries the hosted screen again
                        PCStore.homeFailed = false;
                        keepIfOvis(pc, url);
                        // a relay PC picked on the hosted screen is kept by its own scope too, as one opened from a
                        // pairing link is, so an alert's tap and a link to one of its views find it (PCStore.alertLink)
                        String scope = home == Home.Phase.PC ? Home.relayScope(url, BuildConfig.APP_ORIGIN) : null;
                        if (scope != null) PCStore.remember(MainActivity.this, scope);
                    }
                }
            );
            showOpening(pc, home != null);
        }
    }

    /**
     * Before the WebView's first page (HerdrShellPlugin.load: Capacitor loads its plugins before it loads a page), where
     * this activity answers the hosted origin from the shell this build carries: the clients that keep its requests and
     * its workers' off the network from the first one; the contract the shell's pages get at document start
     * (window.__ovisAppShell, BundledShell.contractScript), on that origin alone (never a PC's own page, and the render
     * host's sandbox has no origin); and the boot page's word that it cleared the workers. Where the shell comes from the
     * network, or the page is another, none of them.
     */
    void beforeFirstPage(Bridge bridge) {
        BundledShell served = shell;
        if (served == null) return;
        // Capacitor asks for the first page as it loads it, before this activity's own client is in place (onCreate, which
        // answers the hosted origin the same way): until then this one keeps that request off the network
        bridge.setWebViewClient(
            new BridgeWebViewClient(bridge) {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    return served.serve(request, () -> super.shouldInterceptRequest(view, request));
                }
            }
        );
        // and a worker the network's copy registered asks the bundled shell too, never the network
        ServiceWorkerController.getInstance().setServiceWorkerClient(
            new ServiceWorkerClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    return served.serve(request, () -> bridge.getLocalServer().shouldInterceptRequest(request));
                }
            }
        );
        WebView view = bridge.getWebView();
        try {
            WebViewCompat.addDocumentStartJavaScript(view, BundledShell.contractScript(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE), Collections.singleton(BuildConfig.APP_ORIGIN));
            if (!booting) return;
            // only the boot page's main frame is heard (another page of the origin saying so would only spare the next start
            // a clean-up), and once: the pages after it go without the listener
            WebViewCompat.addWebMessageListener(view, "OvisBoot", Collections.singleton(BuildConfig.APP_ORIGIN), (frame, message, source, mainFrame, reply) -> {
                if (!mainFrame || !"cleaned".equals(message.getData()) || !BundledShell.isBoot(frame.getUrl(), BuildConfig.APP_ORIGIN)) return;
                BundledShell.booted(this);
                WebViewCompat.removeWebMessageListener(frame, "OvisBoot");
            });
        } catch (IllegalArgumentException rejectedOrigin) {
            // an origin WebView refuses as a rule: the pages go without
        }
    }

    /**
     * Keeps the PC `pc`, whose page `url` has loaded, unless it is not Ovis: a web server that is not
     * Ovis would otherwise be saved and opened at every start, with no Change PC and Back closing the
     * app.
     */
    private void keepIfOvis(String pc, String url) {
        // the bundled shell is the app's own copy, asked nothing over the network
        if (PCStore.scoped(pc) || shell != null) {
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

    /** The app's own page's colour (res/values/colors.xml ovis_page), light or dark as the phone is, as Capacitor takes it. */
    private String pageColor() {
        return String.format("#%06X", getColor(R.color.ovis_page) & 0xFFFFFF);
    }

    private static boolean korean() {
        return "ko".equals(Locale.getDefault().getLanguage());
    }

    /** The cover until the first page shows. `home`: over the hosted screen, which is no PC: "Opening Ovis…", and no Change PC. */
    private void showOpening(String pc, boolean home) {
        String origin = PCStore.origin(pc);
        String label = home ? "Ovis" : PCStore.names(this).optString(pc, "");
        if (label.isEmpty()) label = origin == null ? pc : Uri.parse(origin).getAuthority();
        float density = getResources().getDisplayMetrics().density;
        int pad = Math.round(24 * density);

        ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(1000);
        bar.setProgressTintList(android.content.res.ColorStateList.valueOf(getColor(R.color.ovis_accent)));
        bar.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(getColor(R.color.ovis_accent)));
        bar.setVisibility(View.GONE);
        ProgressBar spinner = new ProgressBar(this);
        spinner.setIndeterminate(true);
        spinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(getColor(R.color.ovis_accent)));
        TextView text = new TextView(this);
        text.setText(korean() ? label + " 여는 중…" : "Opening " + label + "…");
        text.setTextColor(getColor(R.color.ovis_text));
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        text.setGravity(Gravity.CENTER);
        text.setPadding(0, pad / 2, 0, pad);
        Button keep = new Button(this);
        keep.setText(korean() ? "계속 기다리기" : "Keep waiting");
        keep.setAllCaps(false);
        keep.setTextColor(getColor(R.color.ovis_primary_text));
        keep.setBackgroundColor(getColor(R.color.ovis_primary));
        keep.setPadding(pad, pad / 2, pad, pad / 2);
        keep.setVisibility(View.GONE);
        keep.setOnClickListener(v -> {
            if (watch != null) watch.keepWaiting(SystemClock.elapsedRealtime());
            showStage();
        });
        Button retry = new Button(this);
        retry.setText(korean() ? "다시 시도" : "Try again");
        retry.setAllCaps(false);
        retry.setTextColor(getColor(R.color.ovis_strong));
        retry.setBackgroundColor(getColor(R.color.ovis_elevated));
        retry.setPadding(pad, pad / 2, pad, pad / 2);
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(v -> retry());
        Button change = new Button(this);
        change.setText(korean() ? "PC 바꾸기" : "Change PC");
        change.setAllCaps(false);
        change.setTextColor(getColor(R.color.ovis_strong));
        change.setBackgroundColor(getColor(R.color.ovis_elevated));
        change.setPadding(pad, pad / 2, pad, pad / 2);
        change.setOnClickListener(v -> changePc());
        if (home) change.setVisibility(View.GONE);

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
        // the hosted Connect a PC screen's colours (res/values/colors.xml), light or dark as the phone is
        cover.setBackgroundColor(getColor(R.color.ovis_page));
        cover.setClickable(true);
        cover.addView(stack, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        addContentView(cover, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        openingView = cover;
        // the bars take the cover's colour while it is up, whatever the page under it says (pageBarColor)
        paintBars(getColor(R.color.ovis_page));
        openingSpinner = spinner;
        openingText = text;
        openingKeep = keep;
        openingRetry = retry;
        openingChange = change;
        openingBar = bar;
        openingPc = pc;
        openingLabel = label;
        openingHost = origin == null ? pc : Uri.parse(origin).getAuthority();
        long now = SystemClock.elapsedRealtime();
        homeClock = new Home.Clock(now);
        watch = new OpeningWatch(now, answerDelay(), TrafficStats.getUidRxBytes(Process.myUid()));
        answerTimer.postDelayed(this::watchOpening, 1000);
    }

    private void watchOpening() {
        if (openingView == null || isFinishing() || isDestroyed()) return;
        long now = SystemClock.elapsedRealtime();
        watch.received(now, TrafficStats.getUidRxBytes(Process.myUid()));
        if (home == Home.Phase.LOADING) {
            // only time in front counts (Home.Clock): a page that came up while the app was away is asked (askPage)
            // before the time it was away could count against it
            if (Home.timedOut(homeClock.tick(now), watch.isAnswered(), shell != null)) {
                home(Home.clockRanOut(shell != null));
                return;
            }
        } else if (watch.stage(now) == OpeningWatch.Stage.NO_ANSWER) {
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
        if (home == Home.Phase.LOADING) {
            view.evaluateJavascript(HOME_SCRIPT, (value) -> {
                if (openingView == null || value == null || "null".equals(value)) return;
                try {
                    // the script's answer comes as a JSON string holding its JSON
                    if (Home.drawn(new org.json.JSONArray("[" + value + "]").getString(0))) home(Home.Event.LOADED);
                } catch (org.json.JSONException unreadable) {
                }
            });
            return;
        }
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
            // the time the app was away does not count against the hosted screen
            homeClock.resumed(SystemClock.elapsedRealtime());
            answerTimer.removeCallbacksAndMessages(null);
            answerTimer.post(this::watchOpening);
            if (pageShown) answerTimer.post(this::pollPage);
        }
        PreviewUpdater.offer(this, korean());
    }

    @Override
    public void onStop() {
        homeClock.away(SystemClock.elapsedRealtime());
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
        if (pageBarColor != null) paintBars(pageBarColor);
    }

    @Override
    public void onDestroy() {
        answerTimer.removeCallbacksAndMessages(null);
        super.onDestroy();
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
                    pageBarColor = Color.parseColor(color);
                    if (openingView == null) paintBars(pageBarColor);
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
            if (PCStore.showsHostedShell(PCStore.current(this), BuildConfig.APP_ORIGIN)) {
                PCStore.open(this, PCStore.appScope(link, BuildConfig.APP_ORIGIN), link);
                PCStore.fail(null, null);
                PCStore.redirects = 0;
                return true;
            }
            PCStore.link = link;
            return true;
        }
        String scope = PCStore.appScope(link, BuildConfig.APP_ORIGIN);
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
        String link = PCStore.appLink(intent.getAction(), data == null ? null : data.toString(), BuildConfig.APP_ORIGIN);
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
            intent.getStringExtra(OvisMessagingService.EXTRA_PANE),
            BuildConfig.APP_ORIGIN
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

    /** Change PC on the cover or on error.html: the PC that did not open is left. */
    void changePc() {
        PCStore.leave(this, true);
        reopen();
    }

    /** Change PC from a page that is up (HerdrShell disconnect): out of the demo the app opened, else the PC is left. */
    void disconnect() {
        if (PCStore.demo) PCStore.demo = false;
        else PCStore.setCurrent(this, null);
        reopen();
    }

    /** Out of the demo, to the screen it was opened over: the PC it was opened over stays current. */
    void leaveDemo() {
        PCStore.demo = false;
        reopen();
    }

    /** The hosted app's front page asked for by its address (HerdrShell open): an attempt at the hosted screen at `start`. */
    void homeAttempt(String start) {
        PCStore.homeAttempt(this, start);
        reopen();
    }

    /**
     * The SSH setup screen over the page that asked for it (HerdrShell openSshSetup: the hosted app's Add a PC › SSH, or
     * the app's own page), with `target` (an SSH login, or empty) filled in. Back or Cancel there returns to that page as
     * it was, nothing loaded again; a PC added opens (the setup made it the current PC), as one added from the app's own
     * page does.
     */
    void openSshSetup(String target) {
        Intent setup = new Intent(this, SshSetupActivity.class);
        String[] login = SshPcs.login(target);
        if (login != null) setup.putExtra(SshSetupActivity.EXTRA_USER, login[0]).putExtra(SshSetupActivity.EXTRA_HOST, login[1]).putExtra(SshSetupActivity.EXTRA_PORT, Integer.parseInt(login[2]));
        sshSetup.launch(setup);
    }

    private final androidx.activity.result.ActivityResultLauncher<Intent> sshSetup = registerForActivityResult(
        new androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult(),
        (result) -> { if (result.getResultCode() == RESULT_OK) reopen(); }
    );

    /** The connect screen, the current PC kept until another opens (PCStore.choosing). */
    void chooseAnother() {
        PCStore.choosing = true;
        PCStore.demo = false;
        reopen();
    }

    /** The hosted Connect a PC screen again: Try again on the app's own page standing in for it, Back from that page or the demo. */
    void goHome() {
        PCStore.goHome();
        reopen();
    }

    /** The bundled demo, until Back or its own Change PC leaves it (HerdrShell openDemo). */
    void openDemo() {
        PCStore.demo = true;
        reopen();
    }

    /** Back from choosing another way: the current PC again. */
    void backToCurrent() {
        PCStore.choosing = false;
        PCStore.demo = false;
        reopen();
    }

    private static final String LEAVING_SCRIPT = "window.dispatchEvent(new Event('ovis-page-leaving'))";

    private static final long LEAVING_WAIT_MS = 1000;

    private boolean leaving;

    void reopen() {
        if (leaving) return;
        leaving = true;
        // the hosted screen still up counts for nothing from here on, and its clock stops
        if (home != null) {
            home = Home.after(home, Home.Event.LEFT);
            answerTimer.removeCallbacksAndMessages(null);
        }
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
