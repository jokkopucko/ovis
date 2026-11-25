package sh.ovis.app;

import android.Manifest;
import com.getcapacitor.JSArray;
import com.getcapacitor.PermissionState;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "HerdrShell", permissions = { @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }) })
public class HerdrShellPlugin extends Plugin {
    private final PCStore.Openings openings = new PCStore.Openings();

    /** Capacitor loads its plugins before the WebView's first page: what that page must have from its start is added here. */
    @Override
    public void load() {
        if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).beforeFirstPage(getBridge());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        JSObject state = new JSObject();
        state.put("saved", new JSArray(PCStore.saved(getContext())));
        state.put("names", PCStore.names(getContext()));
        String current = PCStore.current(getContext());
        String last = PCStore.last(getContext());
        state.put("name", last == null ? "" : PCStore.names(getContext()).optString(last, ""));
        state.put("current", current == null ? "" : current);
        state.put("last", last == null ? "" : last);
        state.put("choosing", PCStore.choosing && current != null);
        MainActivity activity = (MainActivity) getActivity();
        // the page asking is the hosted Connect a PC screen, opened without being the current PC (Home)
        state.put("home", activity != null && activity.atHome());
        // the page asking is the app's own, standing in for the hosted screen that did not load: Try again is goHome
        state.put("fallback", activity != null && activity.fallback());
        // where the page's own way back leads, as the phone's Back does with nothing behind the page: "current"
        // (backToCurrent), "home" (goHome) or nowhere
        state.put("back", activity == null ? "" : activity.backWay());
        // the app's own page was asked for to manage an SSH PC (Change PC where one did not open): it opens on SSH
        state.put("manage", activity != null && activity.manages());
        state.put("failure", PCStore.failure == null ? "" : PCStore.failure);
        state.put("kind", PCStore.failureKind == null ? "" : PCStore.failureKind);
        state.put("command", PCStore.failureCommand == null ? "" : PCStore.failureCommand);
        // the relay ID each saved PC's own page said it has, for My PCs to list a PC saved by several ways once: only to
        // the app's own pages, never to a PC's page, which has this bridge too
        org.json.JSONObject ids = Home.shownIds(loadedUrl(), showingConnectScreen(), BuildConfig.APP_ORIGIN, PCStore.ids(getContext()));
        if (ids != null) state.put("ids", ids);
        call.resolve(state);
    }

    /** The address of the page loaded now, read on the UI thread, or null when it does not answer in time. */
    private String loadedUrl() {
        if (getActivity() == null) return null;
        java.util.concurrent.CompletableFuture<String> loaded = new java.util.concurrent.CompletableFuture<>();
        getActivity().runOnUiThread(() -> loaded.complete(getBridge().getWebView().getUrl()));
        try {
            return loaded.get(5, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception unanswered) {
            return null;
        }
    }

    /**
     * The application id this build was made as. The client turns the waits of a move onto the account's signed list
     * down only in the QA twin (sh.ovis.app.previewqa; src/lib/account/listMigrate.ts migrationScale), never elsewhere.
     */
    @PluginMethod
    public void appId(PluginCall call) {
        JSObject answer = new JSObject();
        answer.put("id", getContext().getPackageName());
        call.resolve(answer);
    }

    /**
     * A PC's own page says which PC it is: `server_id`, its relay ID as its own /api/health gave it to that page, and
     * `name`. Kept only for the saved PC the app shows when the page loaded now is on that PC's own address
     * (Home.identifiedKey), so a page speaks for its own PC alone, never for another saved one; My PCs then lists that PC
     * once with the relay row of the same ID.
     */
    @PluginMethod
    public void identify(PluginCall call) {
        String key = Home.identifiedKey(loadedUrl(), PCStore.current(getContext()), BuildConfig.APP_ORIGIN);
        if (key == null) {
            call.reject("Only a saved PC's own page says which PC it is.");
            return;
        }
        PCStore.identify(getContext(), key, call.getString("server_id"), call.getString("name"));
        call.resolve();
    }

    /** url: an http or https address, the first page (a pairing link's code or a relay pairing offer's fragment included). */
    @PluginMethod
    public void open(PluginCall call) {
        String text = call.getString("url");
        MainActivity shown = (MainActivity) getActivity();
        // the word "demo" as the hosted screen's address field sends it: the bundled demo, as on the app's own page.
        // Only there: anywhere else that address is a PC's, as it always was
        if (Home.opensDemo(text, shown != null && shown.atHome())) {
            openDemo(call);
            return;
        }
        // the hosted app's front page (a sign-in from the app's own page, its saved row): an attempt at the hosted
        // screen, which makes nothing the current PC before it loaded
        String start = BuildConfig.HOME_HOSTED ? Home.homeStart(text, BuildConfig.APP_ORIGIN) : null;
        if (start != null && shown != null) {
            openings.cancel();
            call.resolve();
            shown.runOnUiThread(() -> shown.homeAttempt(start));
            return;
        }
        String key = text == null ? null : PCStore.origin(text);
        if (key == null) {
            call.reject("That is not an http or https address.");
            return;
        }
        if (SshPcs.otherLoopbackPort(text)) {
            call.reject("That address on this phone is kept for PCs added over SSH. Open the PC from Your PCs.");
            return;
        }
        String scope = call.getString("scope");
        if (scope != null) {
            key = PCStore.scopeKey(scope, text);
            if (key == null) {
                call.reject("That relay link is not within its PC's scope.");
                return;
            }
        }
        String name = call.getString("name");
        int mine = openings.start();
        if (!Boolean.TRUE.equals(call.getBoolean("check", false))) {
            openChecked(call, key, text, name, mine, 0);
            return;
        }
        String pc = key;
        String cookies = android.webkit.CookieManager.getInstance().getCookie(PCStore.origin(text));
        long answerBy = android.os.SystemClock.elapsedRealtime() + PCStore.ANSWER_SECONDS * 1000L;
        new Thread(() -> {
            PCStore.Check found = PCStore.check(text, cookies, PCStore.ANSWER_SECONDS * 1000L);
            if (found.opens()) openChecked(call, pc, text, name, mine, answerBy);
            else call.reject(found.detail == null ? found.kind : found.detail, found.kind);
        }, "ovis-check").start();
    }

    /**
     * Opens the PC, on the UI thread in one turn with the activity's leaving, so nothing the page still does (a relay
     * PC's page landing in the hosted screen) can be written over it in between. An open that was cancelled, or that
     * answers once the app is already going elsewhere (Try again, another open), writes nothing.
     */
    private void openChecked(PluginCall call, String key, String text, String name, int mine, long answerBy) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) {
            call.reject("Cancelled", "cancelled");
            return;
        }
        activity.runOnUiThread(() -> {
            synchronized (openings) {
                if (!openings.current(mine) || activity.isFinishing() || activity.isDestroyed() || activity.leaving()) {
                    call.reject("Cancelled", "cancelled");
                    return;
                }
                if (name != null && !name.isEmpty()) PCStore.setName(getContext(), key, Home.capped(name, 64));
                PCStore.open(getContext(), key, text);
                PCStore.fail(null, null);
                PCStore.redirects = 0;
                PCStore.answerBy = answerBy;
            }
            call.resolve();
            activity.reopen();
        });
    }

    @PluginMethod
    public void cancelOpen(PluginCall call) {
        openings.cancel();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        openings.cancel();
        super.handleOnDestroy();
    }

    private boolean showingConnectScreen() {
        return getBridge().getServerUrl() == null;
    }

    /**
     * A PC's page has the bridge too: an activity showing a PC (its
     * server URL is the PC's) never hands the link out, as it may hold another PC's pairing code.
     */
    @PluginMethod
    public void takeLink(PluginCall call) {
        String link = null;
        if (showingConnectScreen()) {
            link = PCStore.link;
            PCStore.link = null;
        }
        JSObject result = new JSObject();
        result.put("url", link == null ? "" : link);
        call.resolve(result);
    }

    /** For the connect screen's Tailscale tab: `on`, Tailscale's VPN is up on this phone (Tailnet.on). */
    @PluginMethod
    public void tailscale(PluginCall call) {
        JSObject result = new JSObject();
        result.put("on", Tailnet.on());
        call.resolve(result);
    }

    /** Opens the Tailscale app to turn it on, or its store page when it is not installed (the manifest's queries). */
    @PluginMethod
    public void openTailscale(PluginCall call) {
        android.content.Intent open = getContext().getPackageManager().getLaunchIntentForPackage(Tailnet.PACKAGE);
        if (open == null) {
            open = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("https://play.google.com/store/apps/details?id=" + Tailnet.PACKAGE));
        }
        try {
            getActivity().startActivity(open);
            call.resolve();
        } catch (android.content.ActivityNotFoundException e) {
            call.reject("Tailscale could not be opened on this phone.");
        }
    }

    @PluginMethod
    public void forget(PluginCall call) {
        String key = call.getString("url");
        // an SSH PC forgotten takes its sealed key and host key with it (OvisSshPlugin.forgetRemoved): only the app's
        // own pages do that, never a PC's page, which has this bridge too
        if (key != null && getBridge().getServerUrl() != null && SshPcs.on(getContext()).get(key) != null) {
            call.reject("Only the app's own pages manage SSH PCs.");
            return;
        }
        if (key != null) PCStore.forget(getContext(), key);
        call.resolve();
    }

    /**
     * From the hosted app (Add a PC's SSH) or the app's own page: the SSH setup screen over that page, with `target` (an
     * SSH login, user@host[:port], or empty) filled in (MainActivity.openSshSetup). Nothing is added here, and the page
     * is given no OvisSsh: the person adds the PC on the setup screen, and Back there returns to the page as it was.
     */
    @PluginMethod
    public void openSshSetup(PluginCall call) {
        // only the connect screen and the hosted app (Add a PC's SSH): a PC's own page may not drop the person off it
        // to stage a login of its choosing
        // the page loaded now, not the one the app last chose: the WebView may have gone elsewhere since
        java.util.concurrent.CompletableFuture<String> loaded = new java.util.concurrent.CompletableFuture<>();
        getActivity().runOnUiThread(() -> loaded.complete(getBridge().getWebView().getUrl()));
        String url;
        try {
            url = loaded.get(5, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception unanswered) {
            url = null;
        }
        if (!SshPcs.setupOpener(url, showingConnectScreen(), BuildConfig.APP_ORIGIN)) {
            call.reject("Only the app's own pages open the SSH setup.");
            return;
        }
        String target = call.getString("target", "");
        if (target == null || target.length() > 300) {
            call.reject("That is not an SSH login.");
            return;
        }
        openings.cancel();
        call.resolve();
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).openSshSetup(target));
    }

    /**
     * Whether the app may use the camera, asked for when it may not: the QR scanner (ionbarcode) asks too, but answers a
     * refusal in English alone, so the pages ask here first and say it themselves (connect.js, RelayAddPc scanQr).
     */
    @PluginMethod
    public void camera(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            cameraAnswered(call);
            return;
        }
        requestPermissionForAlias("camera", call, "cameraAnswered");
    }

    @PermissionCallback
    private void cameraAnswered(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("camera") == PermissionState.GRANTED);
        call.resolve(result);
    }

    /** Change PC: in the demo the app opened (openDemo) it leaves the demo alone, and the PC it was opened over stays current. */
    @PluginMethod
    public void disconnect(PluginCall call) {
        openings.cancel();
        call.resolve();
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).disconnect());
    }

    /** A PC page's Connect a PC: the connect screen, the current PC kept until another opens (PCStore.choosing). */
    @PluginMethod
    public void chooseAnother(PluginCall call) {
        // an address still being asked whether it is Ovis must not open over the screen this goes to
        openings.cancel();
        call.resolve();
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).chooseAnother());
    }

    /** The connect screen's way back to the PC it was opened from to choose another way. */
    @PluginMethod
    public void backToCurrent(PluginCall call) {
        // an address still being asked whether it is Ovis must not open over the screen this goes to
        openings.cancel();
        call.resolve();
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).backToCurrent());
    }

    /** The hosted Connect a PC screen again: Try again on the app's own page standing in for it (getState's `fallback`). */
    @PluginMethod
    public void goHome(PluginCall call) {
        // an address still being asked whether it is Ovis must not open over the screen this goes to
        openings.cancel();
        call.resolve();
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).goHome());
    }

    /** The bundled demo, which only the app can open: a page of another origin cannot reach the app's own files. */
    @PluginMethod
    public void openDemo(PluginCall call) {
        // an address still being asked whether it is Ovis must not open over the screen this goes to
        openings.cancel();
        call.resolve();
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).openDemo());
    }

    @PluginMethod
    public void retry(PluginCall call) {
        // a Tailscale check the person has just approved: the PC's tunnel signs in again
        SshTunnels.resume(PCStore.current(getContext()));
        openings.cancel();
        PCStore.fail(null, null);
        PCStore.redirects = 0;
        call.resolve();
        reopen();
    }

    private void reopen() {
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).reopen());
    }
}
