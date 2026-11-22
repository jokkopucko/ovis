package sh.ovis.push;

import android.content.Context;
import android.content.Intent;

/**
 * Tells the tap of an alert this app showed from another app's intent. MainActivity is exported, so
 * any app can send it OvisMessagingService.ACTION_OPEN_ALERT with any extras; only this app's own
 * PendingIntents carry its proof (PushStore.alertProof) in EXTRA.
 */
public final class AlertProof {
    public static final String EXTRA = "sh.ovis.push.proof";

    private AlertProof() {}

    public static boolean own(Context context, Intent intent) {
        return PushStore.provesAlert(context, intent.getStringExtra(EXTRA));
    }
}
