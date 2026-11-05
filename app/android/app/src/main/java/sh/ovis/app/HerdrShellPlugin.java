package sh.ovis.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * What the app's own pages (app/web) and the client's Change PC (src/lib/nativeApp.ts) ask of the
 * app: open a PC, forget one, go back to the connect screen. The iOS twin is HerdrShellPlugin.swift.
 */
@CapacitorPlugin(name = "HerdrShell")
public class HerdrShellPlugin extends Plugin {
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
        call.resolve(state);
    }

    /**
     * url: an http or https address, the first page (a pairing link's code or a relay pairing offer's
     * fragment included). Its origin is remembered, or `scope` for a PC opened through the Ovis relay
     * (`https://app.ovis.sh/s/<server_id>/`, labelled `name`).
     */
    @PluginMethod
    public void open(PluginCall call) {
        String text = call.getString("url");
        String key = text == null ? null : PCStore.origin(text);
        if (key == null) {
            call.reject("That is not an http or https address.");
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
        if (name != null && !name.isEmpty()) PCStore.setName(getContext(), key, name.length() > 64 ? name.substring(0, 64) : name);
        PCStore.open(getContext(), key, text);
        PCStore.failure = null;
        PCStore.redirects = 0;
        call.resolve();
        reopen();
    }

    @PluginMethod
    public void forget(PluginCall call) {
        String key = call.getString("url");
        if (key != null) PCStore.forget(getContext(), key);
        call.resolve();
    }

    /** Back to the connect screen; the PC stays in the list. */
    @PluginMethod
    public void disconnect(PluginCall call) {
        PCStore.setCurrent(getContext(), null);
        call.resolve();
        reopen();
    }

    /** Opens the current PC again from its first page. */
    @PluginMethod
    public void retry(PluginCall call) {
        PCStore.failure = null;
        PCStore.redirects = 0;
        call.resolve();
        reopen();
    }

    private void reopen() {
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).reopen());
    }
}
