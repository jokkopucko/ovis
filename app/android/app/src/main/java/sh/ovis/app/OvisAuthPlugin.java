package sh.ovis.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Signing in to the account from the app (docs/account.md, "Signing in"; src/lib/account/native.ts):
 * the sign-in opens in the system browser, and the account service sends it back to
 * ovis://account/callback, which the manifest routes to MainActivity and Capacitor hands here. The
 * page finishes the sign-in itself; nothing here keeps a token. Sign in with Apple has no native
 * form on Android, so Apple takes the same browser route. The iOS twin: app/ios/App/App/OvisAuthPlugin.swift.
 */
@CapacitorPlugin(name = "OvisAuth")
public class OvisAuthPlugin extends Plugin {
    private PluginCall waiting;
    /** the state of the sign-in waiting: only a return naming it is taken */
    private String expectedState;

    private void release(PluginCall call) {
        call.setKeepAlive(false);
        getBridge().releaseCall(call);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("Sign in at an https address", "invalid_url");
            return;
        }
        String state = Uri.parse(url).getQueryParameter("state");
        if (state == null || state.isEmpty()) {
            call.reject("That sign-in names no state", "invalid_url");
            return;
        }
        if (waiting != null) {
            PluginCall replaced = waiting;
            release(replaced);
            replaced.reject("The sign-in was replaced", "cancelled");
        }
        waiting = call;
        expectedState = state;
        call.setKeepAlive(true);
        try {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException error) {
            waiting = null;
            expectedState = null;
            release(call);
            call.reject("No browser could open the sign-in", "failed");
        }
    }

    @PluginMethod
    public void signInWithApple(PluginCall call) {
        call.reject("Sign in with Apple runs in the browser on Android", "unavailable");
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        Uri data = intent.getData();
        if (data == null) return;
        PluginCall call = waiting;
        if (call == null || !isOwnReturn(data.toString(), expectedState)) return;
        waiting = null;
        expectedState = null;
        JSObject result = new JSObject();
        result.put("url", data.toString());
        release(call);
        call.resolve(result);
    }

    /**
     * Whether `url` is the return of the sign-in waiting on `expectedState`. Another app can send
     * this address too: only ovis://account/callback naming that state, with a code or an error,
     * counts. The account service puts the fields in the fragment; as in native.ts, a non-empty
     * fragment is read, else the query.
     */
    static boolean isOwnReturn(String url, String expectedState) {
        if (expectedState == null) return false;
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException error) {
            return false;
        }
        if (!"ovis".equals(uri.getScheme()) || !"account".equals(uri.getHost()) || !"/callback".equals(uri.getPath())) return false;
        String fragment = uri.getRawFragment();
        String fields = fragment != null && !fragment.isEmpty() ? fragment : uri.getRawQuery();
        if (fields == null) return false;
        String state = null;
        boolean answered = false;
        for (String pair : fields.split("&")) {
            int equals = pair.indexOf('=');
            String name;
            String value;
            try {
                name = URLDecoder.decode(equals < 0 ? pair : pair.substring(0, equals), "UTF-8");
                value = URLDecoder.decode(equals < 0 ? "" : pair.substring(equals + 1), "UTF-8");
            } catch (UnsupportedEncodingException | IllegalArgumentException error) {
                return false;
            }
            if ("state".equals(name) && state == null) state = value;
            if ("code".equals(name) || "error".equals(name)) answered = true;
        }
        return answered && expectedState.equals(state);
    }
}
