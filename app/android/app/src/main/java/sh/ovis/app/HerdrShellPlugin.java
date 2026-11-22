package sh.ovis.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "HerdrShell")
public class HerdrShellPlugin extends Plugin {
    private final PCStore.Openings openings = new PCStore.Openings();
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
        state.put("failure", PCStore.failure == null ? "" : PCStore.failure);
        state.put("kind", PCStore.failureKind == null ? "" : PCStore.failureKind);
        state.put("command", PCStore.failureCommand == null ? "" : PCStore.failureCommand);
        call.resolve(state);
    }

    /** url: an http or https address, the first page (a pairing link's code or a relay pairing offer's fragment included). */
    @PluginMethod
    public void open(PluginCall call) {
        String text = call.getString("url");
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

    private void openChecked(PluginCall call, String key, String text, String name, int mine, long answerBy) {
        synchronized (openings) {
            android.app.Activity activity = getActivity();
            if (!openings.current(mine) || activity == null || activity.isFinishing() || activity.isDestroyed()) {
                call.reject("Cancelled", "cancelled");
                return;
            }
            if (name != null && !name.isEmpty()) PCStore.setName(getContext(), key, name.length() > 64 ? name.substring(0, 64) : name);
            PCStore.open(getContext(), key, text);
            PCStore.fail(null, null);
            PCStore.redirects = 0;
            PCStore.answerBy = answerBy;
        }
        call.resolve();
        android.app.Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            synchronized (openings) {
                if (!openings.current(mine)) {
                    PCStore.setCurrent(getContext(), null);
                    PCStore.answerBy = 0;
                    return;
                }
            }
            ((MainActivity) activity).reopen();
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

    @PluginMethod
    public void disconnect(PluginCall call) {
        PCStore.setCurrent(getContext(), null);
        call.resolve();
        reopen();
    }

    @PluginMethod
    public void retry(PluginCall call) {
        PCStore.fail(null, null);
        PCStore.redirects = 0;
        call.resolve();
        reopen();
    }

    private void reopen() {
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).reopen());
    }
}
