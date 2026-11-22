package sh.ovis.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.os.Build;
import android.webkit.CookieManager;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.trilead.ssh2.Connection;
import java.io.IOException;
import java.util.List;

/**
 * PCs added over SSH. Capacitor loads its plugins before the WebView's first page, so when the PC
 * about to open is an SSH PC its tunnel already listens on that page's address (SshTunnels). The
 * connect screen (app/web/connect.js) adds one through `add`, lists them with `list`, and manages
 * each: `rename`, `phoneKey` with `copy` and `share` (this phone's key line again), `setUp` (register again, another
 * key, a forgotten host key confirmed), `forgetHostKey`, and `remove`, which can also take this phone's
 * key out of the PC's authorized_keys.
 *
 * <p>A tunnel's failure while its PC is open goes to the app's error page (app/web/error.html), with
 * its kind and the command that fixes it where there is one (PCStore.fail): the page's own load fails
 * there by itself (503 from the tunnel); a stop that comes later (the host key changed, the key
 * refused) takes the page there too, as the page alone would only keep reconnecting.
 */
@CapacitorPlugin(name = "OvisSsh")
public class OvisSshPlugin extends Plugin {
    @Override
    public void load() {
        forgetRemoved();
        SshTunnels.listener = this::failed;
        // every saved SSH PC listens (SSH itself waits for a request): the connect screen checks a PC it opens
        for (SshPcs.Pc pc : SshPcs.on(getContext()).list()) listen(getContext(), pc.origin);
    }

    /**
     * Makes sure the SSH PC `origin` (any other origin passes) listens on its address on this phone, and
     * only then gives the WebView that tunnel's gate. False when another app holds the address: the PC
     * must not open then, as the page that answers there would be that app's, with the app's bridge.
     * MainActivity asks before it opens the PC; the failure is kept for the connect screen (`ssh-port`).
     */
    static boolean listen(android.content.Context context, String origin) {
        SshPcs.Pc pc = SshPcs.on(context).get(origin);
        if (pc == null) return true;
        try {
            setGate(pc.origin, SshTunnels.open(context, pc).gate());
            return true;
        } catch (IOException taken) {
            PCStore.fail(pc.loopbackHost() + ":" + SshPcs.LOCAL_PORT + ": " + taken.getMessage(), "ssh-port");
            return false;
        }
    }

    /** `pc` (the PC about to open), or null when it is an SSH PC whose address another app holds: the connect screen shows instead, saying so. */
    static String opening(android.content.Context context, String pc) {
        if (pc == null || listen(context, pc)) return pc;
        PCStore.setCurrent(context, null);
        return null;
    }

    /** Only the app's own pages manage SSH PCs: a PC's page has the bridge too, and must not reach another PC's keys. */
    private boolean fromAppPage(PluginCall call) {
        if (getBridge().getServerUrl() == null) return true;
        call.reject("Only the app's own pages manage SSH PCs.");
        return false;
    }

    @Override
    protected void handleOnResume() {
        SshTunnels.wakeAll();
    }

    @PluginMethod
    public void add(PluginCall call) {
        if (!fromAppPage(call)) return;
        startActivityForResult(call, new Intent(getContext(), SshSetupActivity.class), "added");
    }

    /** Sets the PC `origin` up again on the setup screen, its address kept. */
    @PluginMethod
    public void setUp(PluginCall call) {
        if (!fromAppPage(call)) return;
        SshPcs.Pc pc = SshPcs.on(getContext()).get(call.getString("origin"));
        if (pc == null) {
            call.reject("That SSH PC is not saved on this phone.");
            return;
        }
        startActivityForResult(call, new Intent(getContext(), SshSetupActivity.class).putExtra(SshSetupActivity.EXTRA_ORIGIN, pc.origin), "added");
    }

    @ActivityCallback
    private void added(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject answer = new JSObject();
        answer.put("added", result.getResultCode() == Activity.RESULT_OK);
        call.resolve(answer);
        if (result.getResultCode() == Activity.RESULT_OK) getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).reopen());
    }

    /** The SSH PCs, by origin: how each is reached and signs in, and its host key's fingerprint ("" once forgotten). */
    @PluginMethod
    public void list(PluginCall call) {
        if (!fromAppPage(call)) return;
        JSArray pcs = new JSArray();
        for (SshPcs.Pc pc : SshPcs.on(getContext()).list()) {
            JSObject item = new JSObject();
            item.put("origin", pc.origin);
            item.put("label", pc.label());
            item.put("host", pc.host);
            item.put("port", pc.port);
            item.put("user", pc.user);
            item.put("auth", pc.auth);
            item.put("keyType", pc.keyType);
            item.put("hostKeyAlgorithm", pc.hostKeyAlgorithm);
            item.put("fingerprint", SshHostKeys.fingerprint(pc.hostKey));
            pcs.put(item);
        }
        JSObject answer = new JSObject();
        answer.put("pcs", pcs);
        call.resolve(answer);
    }

    /** This phone's own key line, for authorized_keys. */
    @PluginMethod
    public void phoneKey(PluginCall call) {
        if (!fromAppPage(call)) return;
        new Thread(() -> {
            try {
                JSObject answer = new JSObject();
                answer.put("line", SshPcs.on(getContext()).phoneKeyLine(Build.MODEL));
                call.resolve(answer);
            } catch (SshFailure failed) {
                call.reject(failed.getMessage(), failed.kind);
            } catch (RuntimeException keystore) {
                call.reject(SshFailure.rootMessage(keystore), "internal");
            }
        }, "ovis-ssh-key").start();
    }

    /** Puts `text` on the clipboard: the page's own clipboard is not open to the app's pages. */
    @PluginMethod
    public void copy(PluginCall call) {
        if (!fromAppPage(call)) return;
        String text = call.getString("text", "");
        getActivity().runOnUiThread(() -> {
            ClipboardManager clipboard = getContext().getSystemService(ClipboardManager.class);
            if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("ssh", text));
            call.resolve();
        });
    }

    /** Opens the share sheet with `text` (this phone's public key line), to send it to the PC another way. */
    @PluginMethod
    public void share(PluginCall call) {
        if (!fromAppPage(call)) return;
        String text = call.getString("text", "");
        getActivity().runOnUiThread(() -> {
            SshSetupActivity.share(getActivity(), text);
            call.resolve();
        });
    }

    /** The PC's name in the list; an empty one goes back to user@host. */
    @PluginMethod
    public void rename(PluginCall call) {
        if (!fromAppPage(call)) return;
        SshPcs.Pc pc = SshPcs.on(getContext()).get(call.getString("origin"));
        if (pc == null) {
            call.reject("That SSH PC is not saved on this phone.");
            return;
        }
        String name = call.getString("name", "").trim();
        if (name.length() > 64) name = name.substring(0, 64);
        PCStore.setName(getContext(), pc.origin, name.isEmpty() ? pc.label() + " (SSH)" : name);
        call.resolve();
    }

    /** Forgets the PC's host key on purpose: it opens again only once the setup screen confirms the key it shows then. */
    @PluginMethod
    public void forgetHostKey(PluginCall call) {
        if (!fromAppPage(call)) return;
        String origin = call.getString("origin");
        SshPcs.on(getContext()).forgetHostKey(origin);
        SshTunnels.closeFor(origin);
        call.resolve();
    }

    /**
     * Forgets the PC on this phone: its host key, its sealed key, its tunnel and its place in the list.
     * With `cleanRemote`, this phone's key line is first taken out of the PC's authorized_keys (only when
     * no other saved PC signs in to that account with it); the answer says whether that happened
     * (`remote`: "removed", "absent", "kept" or "failed", with `reason`). The PC is forgotten either way.
     */
    @PluginMethod
    public void remove(PluginCall call) {
        if (!fromAppPage(call)) return;
        String origin = call.getString("origin");
        boolean cleanRemote = Boolean.TRUE.equals(call.getBoolean("cleanRemote", false));
        SshPcs store = SshPcs.on(getContext());
        SshPcs.Pc pc = store.get(origin);
        if (pc == null) {
            call.reject("That SSH PC is not saved on this phone.");
            return;
        }
        new Thread(() -> {
            JSObject answer = new JSObject();
            String remote = "kept";
            if (cleanRemote && "phone-key".equals(pc.auth) && pc.hasHostKey() && !sharedAccount(store.list(), pc)) {
                Connection connection = null;
                try {
                    connection = SshLink.connect(pc.host, pc.port, new SshLink.HostKeyCheck(pc.hostKeyAlgorithm, pc.hostKey));
                    SshLink.signIn(connection, pc.user, store.phoneKey());
                    remote = SshLink.unauthorizeKey(connection, store.phoneKeyLine(Build.MODEL).split(" ")[1]);
                } catch (SshFailure failed) {
                    remote = "failed";
                    answer.put("reason", failed.kind + ": " + failed.getMessage());
                } catch (RuntimeException unexpected) {
                    remote = "failed";
                    answer.put("reason", SshFailure.rootMessage(unexpected));
                } finally {
                    if (connection != null) connection.close();
                }
            }
            SshTunnels.closeFor(pc.origin);
            store.remove(pc.origin);
            PCStore.forget(getContext(), pc.origin);
            CookieManager.getInstance().setCookie(pc.origin, SshTunnel.GATE_COOKIE + "=; Path=/; Max-Age=0");
            // the page's storage there (drafts, its service worker) goes with the PC
            getActivity().runOnUiThread(() -> android.webkit.WebStorage.getInstance().deleteOrigin(pc.origin));
            answer.put("remote", remote);
            call.resolve(answer);
        }, "ovis-ssh-remove").start();
    }

    /**
     * Whether another saved PC may sign in with this phone's key to the same account: the same user
     * name on the same host name (any port), or on a machine that shows the same host key (the same
     * machine under another name or address). When in doubt the key stays there.
     */
    static boolean sharedAccount(List<SshPcs.Pc> pcs, SshPcs.Pc pc) {
        for (SshPcs.Pc other : pcs) {
            if (other.origin.equals(pc.origin) || !"phone-key".equals(other.auth) || !other.user.equals(pc.user)) continue;
            if (other.host.equalsIgnoreCase(pc.host) || (pc.hasHostKey() && pc.hostKey.equals(other.hostKey))) return true;
        }
        return false;
    }

    /** The WebView's pass to the tunnel: an HttpOnly cookie on the PC's own loopback origin, which no page script or other app reads. */
    static void setGate(String origin, String gate) {
        CookieManager cookies = CookieManager.getInstance();
        cookies.setCookie(origin, SshTunnel.GATE_COOKIE + "=" + gate + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000");
        cookies.flush();
    }

    /** An SSH PC forgotten on the connect screen takes its saved way in (host key, sealed key) with it. */
    private void forgetRemoved() {
        List<String> saved = PCStore.saved(getContext());
        String current = PCStore.current(getContext());
        String last = PCStore.last(getContext());
        SshPcs store = SshPcs.on(getContext());
        for (SshPcs.Pc pc : store.list()) {
            if (saved.contains(pc.origin) || pc.origin.equals(current) || pc.origin.equals(last)) continue;
            store.remove(pc.origin);
            SshTunnels.closeFor(pc.origin);
        }
    }

    /**
     * A tunnel's failure: the error page names it (kind `ssh-<kind>`, the command that fixes it). A stop
     * on the PC that is open takes the page there now, as the page alone would only keep reconnecting.
     */
    private void failed(SshPcs.Pc pc, SshFailure failure) {
        if (!pc.origin.equals(PCStore.current(getContext()))) return;
        PCStore.fail(failure.getMessage(), "ssh-" + failure.kind, failure.command);
        if (!failure.stops()) return;
        Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (activity.isFinishing() || activity.isDestroyed()) return;
            String errorUrl = getBridge().getErrorUrl();
            String shown = getBridge().getWebView().getUrl();
            if (errorUrl != null && (shown == null || !shown.startsWith(errorUrl))) getBridge().getWebView().loadUrl(errorUrl);
        });
    }
}
