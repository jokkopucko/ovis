package sh.ovis.push;

import android.content.Context;
import android.content.SharedPreferences;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * This phone's push keys and the relay endpoint each PC was given, in the app's private
 * preferences. An endpoint is kept with the FCM token and PC key it was made for: a new token or
 * key means a new endpoint, which the PC gets at its next subscribe.
 */
final class PushStore {
    private static final String PREFS = "ovis_push";

    /** a PC's relay endpoint, the FCM token behind it and the PC key the relay pinned it to */
    static final class Endpoint {
        final String endpoint;
        final String token;
        final String vapidKey;

        Endpoint(String endpoint, String token, String vapidKey) {
            this.endpoint = endpoint;
            this.token = token;
            this.vapidKey = vapidKey;
        }
    }

    private PushStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Receiving a notification never creates or replaces keys. */
    static synchronized PushKeys read(Context context) throws GeneralSecurityException {
        PushKeys keys = read(prefs(context));
        if (keys == null) throw new GeneralSecurityException("push keys are missing");
        return keys;
    }

    /** The keys as stored, or null when there are none; never creates or replaces them. */
    static synchronized PushKeys stored(Context context) throws GeneralSecurityException {
        return read(prefs(context));
    }

    static PushKeys read(SharedPreferences prefs) throws GeneralSecurityException {
        try {
            return PushKeys.decode(prefs.getString("private", null), prefs.getString("public", null),
                prefs.getString("auth", null));
        } catch (ClassCastException damaged) {
            throw new PushKeys.Damaged();
        }
    }

    /** Only app subscription setup repairs a damaged store. Endpoints stay for key replacement. */
    static synchronized PushKeys keys(Context context) throws GeneralSecurityException {
        return getOrCreate(prefs(context));
    }

    static synchronized PushKeys getOrCreate(SharedPreferences prefs) throws GeneralSecurityException {
        try {
            PushKeys keys = read(prefs);
            if (keys != null) return keys;
        } catch (PushKeys.Damaged damaged) {
            // Replace all three fields together; each PC receives the new p256dh and auth on its next app load.
        }
        PushKeys keys = PushKeys.generate();
        Base64.Encoder encoder = Base64.getEncoder();
        boolean saved = prefs.edit()
            .putString("private", encoder.encodeToString(keys.privateScalar))
            .putString("public", encoder.encodeToString(keys.publicPoint))
            .putString("auth", encoder.encodeToString(keys.auth))
            .commit();
        if (!saved) {
            // commit() has already updated memory even when the disk write fails.
            prefs.edit().remove("private").remove("public").remove("auth").apply();
            throw new GeneralSecurityException("could not save push keys");
        }
        return keys;
    }

    static synchronized Endpoint endpoint(Context context, String origin) {
        JSONObject entry = endpoints(context).optJSONObject(origin);
        if (entry == null) return null;
        return new Endpoint(entry.optString("endpoint"), entry.optString("token"), entry.optString("vapidKey"));
    }

    static synchronized String originOf(Context context, String endpoint) {
        return originOf(endpoints(context), endpoint);
    }

    static String originOf(JSONObject all, String endpoint) {
        if (endpoint == null) return null;
        for (java.util.Iterator<String> keys = all.keys(); keys.hasNext(); ) {
            String origin = keys.next();
            JSONObject entry = all.optJSONObject(origin);
            if (entry != null && endpoint.equals(entry.optString("endpoint", null))) return origin;
        }
        return null;
    }

    /**
     * The random value this app's own alert taps carry (AlertProof.EXTRA), made once
     * and kept only here: MainActivity is exported, so any app can send it an alert's intent, but
     * none can read this one's preferences or the extras of its notifications' PendingIntents.
     */
    static synchronized String alertProof(Context context) {
        return alertProof(prefs(context));
    }

    static synchronized String alertProof(SharedPreferences prefs) {
        String proof = prefs.getString("alert_proof", null);
        if (proof != null) return proof;
        byte[] random = new byte[32];
        new SecureRandom().nextBytes(random);
        proof = Base64.getUrlEncoder().withoutPadding().encodeToString(random);
        prefs.edit().putString("alert_proof", proof).commit();
        return proof;
    }

    /** Whether `proof` is alertProof, compared in constant time; false while no alert has made one. */
    static synchronized boolean provesAlert(Context context, String proof) {
        return provesAlert(prefs(context), proof);
    }

    static synchronized boolean provesAlert(SharedPreferences prefs, String proof) {
        String kept = prefs.getString("alert_proof", null);
        return kept != null && proof != null
            && MessageDigest.isEqual(kept.getBytes(StandardCharsets.UTF_8), proof.getBytes(StandardCharsets.UTF_8));
    }

    static synchronized void saveEndpoint(Context context, String origin, String endpoint, String token, String vapidKey) throws JSONException {
        JSONObject all = endpoints(context);
        all.put(origin, new JSONObject().put("endpoint", endpoint).put("token", token).put("vapidKey", vapidKey));
        prefs(context).edit().putString("endpoints", all.toString()).apply();
    }

    static synchronized void forget(Context context, String origin) {
        JSONObject all = endpoints(context);
        all.remove(origin);
        prefs(context).edit().putString("endpoints", all.toString()).apply();
    }

    private static JSONObject endpoints(Context context) {
        try {
            return new JSONObject(prefs(context).getString("endpoints", "{}"));
        } catch (JSONException damaged) {
            return new JSONObject();
        }
    }
}
