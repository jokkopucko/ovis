package sh.ovis.push;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Base64;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The relay sends FCM a data message whose "ovis" field is the PC's ciphertext
 * (standard base64); it is decrypted here with this phone's keys and shown as the browser's
 * service worker shows it (public/sw.js): the PC's title and body, one notification per tag.
 */
public class OvisMessagingService extends FirebaseMessagingService {
    public static final String ACTION_OPEN_ALERT = "sh.ovis.push.OPEN_ALERT";
    public static final String EXTRA_ORIGIN = "sh.ovis.push.origin";
    public static final String EXTRA_SERVER_ID = "sh.ovis.push.server_id";
    public static final String EXTRA_MACHINE = "sh.ovis.push.machine_id";
    public static final String EXTRA_WORKSPACE = "sh.ovis.push.workspace_id";
    public static final String EXTRA_PANE = "sh.ovis.push.pane_id";

    private static final String CHANNEL = "agent-alerts";
    private static final String TAG = "OvisPush";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        String title = "Ovis";
        String body = getString(R.string.ovis_push_fallback);
        String tag = "herdr";
        JSONObject alert = null;
        String sealed = message.getData().get("ovis");
        if (sealed != null) {
            try {
                byte[] plain = WebPushDecrypt.decrypt(Base64.getDecoder().decode(sealed), PushStore.read(this));
                JSONObject payload = new JSONObject(new String(plain, StandardCharsets.UTF_8));
                title = payload.optString("title", "").isEmpty() ? title : payload.getString("title");
                body = payload.optString("body", "");
                tag = payload.optString("tag", "").isEmpty() ? tag : payload.getString("tag");
                alert = payload;
            } catch (GeneralSecurityException | IllegalArgumentException | JSONException e) {
                Log.w(TAG, "a push could not be read: " + e.getClass().getSimpleName());
            }
        }
        show(title, body, tag, alert);
    }

    private static String field(JSONObject payload, String name) {
        if (payload == null || payload.isNull(name)) return null;
        String value = payload.optString(name, "");
        return value.isEmpty() ? null : value;
    }

    private void show(String title, String body, String tag, JSONObject alert) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, getString(R.string.ovis_push_channel), NotificationManager.IMPORTANCE_HIGH)
        );
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        String pane = field(alert, "pane_id");
        if (open != null && pane != null) {
            String endpoint = field(alert, "endpoint");
            open.setAction(ACTION_OPEN_ALERT)
                .putExtra(EXTRA_ORIGIN, endpoint == null ? null : PushStore.originOf(this, endpoint))
                .putExtra(EXTRA_SERVER_ID, field(alert, "server_id"))
                .putExtra(EXTRA_MACHINE, field(alert, "machine_id"))
                .putExtra(EXTRA_WORKSPACE, field(alert, "workspace_id"))
                .putExtra(EXTRA_PANE, pane)
                .putExtra(AlertProof.EXTRA, PushStore.alertProof(this));
        }
        // one tap per notification: Android tells PendingIntents apart by their intent's action, data
        // and component, never its extras, so a shared one would open the latest alert's pane from
        // every notification. The tag, in the data, is what the notification is shown under, so the
        // same alert again replaces both; a request code alone (a hash of the tag) could collide.
        if (open != null && pane != null) open.setData(Uri.fromParts("ovis-alert", tag, null));
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_ovis)
            .setColor(0xFF2E3A59)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(tap);
        NotificationManagerCompat.from(this).notify(tag, 0, notification.build());
    }
}
