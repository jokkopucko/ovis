package sh.ovis.app;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.action.ViewActions.closeSoftKeyboard;
import static androidx.test.espresso.action.ViewActions.replaceText;
import static androidx.test.espresso.action.ViewActions.scrollTo;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.RootMatchers.isDialog;
import static androidx.test.espresso.matcher.ViewMatchers.withId;
import static androidx.test.espresso.matcher.ViewMatchers.withText;
import static org.hamcrest.Matchers.containsString;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The setup screen with a private key pasted in, the path the prototype never ran: a passphrase-
 * protected ed25519 key, typed into the real screen, the host key confirmed in its dialog, and the PC
 * saved sealed. The screen's own steps (SshSetupActivity.Steps) say when a dialog is up or it is done;
 * each wait is for one of them, bounded.
 */
@RunWith(AndroidJUnit4.class)
public class SshSetupFlowTest {
    private final BlockingQueue<String> steps = new LinkedBlockingQueue<>();

    @Before
    public void listen() {
        SshSetupActivity.steps = steps::add;
    }

    @After
    public void stopListening() {
        SshSetupActivity.steps = null;
    }

    private void awaitStep(String expected) throws InterruptedException {
        while (true) {
            String step = steps.poll(120, TimeUnit.SECONDS);
            assertNotNull("the screen never got to " + expected, step);
            if (step.equals(expected)) return;
            if (step.startsWith("failed:") || step.equals("done")) assertEquals(expected, step);
        }
    }

    private static void fillIn(String key, String passphrase) {
        onView(withId(R.id.ssh_host)).perform(replaceText(SshFixtureTest.host()));
        onView(withId(R.id.ssh_port)).perform(replaceText(String.valueOf(SshFixtureTest.port())));
        onView(withId(R.id.ssh_user)).perform(replaceText(SshFixtureTest.user()), closeSoftKeyboard());
        onView(withId(R.id.ssh_advanced)).perform(scrollTo(), click());
        onView(withId(R.id.ssh_method_paste)).perform(scrollTo(), click());
        onView(withId(R.id.ssh_private_key)).perform(scrollTo(), replaceText(key));
        onView(withId(R.id.ssh_passphrase)).perform(scrollTo(), replaceText(passphrase), closeSoftKeyboard());
    }

    /** Taps Connect through the screen itself: on a phone-sized window it can sit under the keyboard's inset, where Espresso cannot scroll to it. */
    private static void connect(ActivityScenario<SshSetupActivity> screen) {
        screen.onActivity(activity -> activity.findViewById(R.id.ssh_connect).performClick());
    }

    /**
     * The screen's worker waits on its dialogs and hands its result to this instance: turning the phone, or a theme
     * or language change, must not recreate it, which would leave the worker waiting on a dialog that is gone.
     */
    @Test
    public void theScreenIsNotRecreatedByARotationOrAThemeOrLanguageChange() throws Exception {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ActivityInfo info = app.getPackageManager().getActivityInfo(new ComponentName(app, SshSetupActivity.class), 0);
        int needed = ActivityInfo.CONFIG_ORIENTATION | ActivityInfo.CONFIG_SCREEN_SIZE | ActivityInfo.CONFIG_UI_MODE | ActivityInfo.CONFIG_LOCALE | ActivityInfo.CONFIG_LAYOUT_DIRECTION;
        assertEquals(needed, info.configChanges & needed);
    }

    @Test
    public void aPastedKeyWithAWrongPassphraseIsToldBeforeAnythingIsSent() throws InterruptedException {
        SshFixtureTest.host();
        try (ActivityScenario<SshSetupActivity> screen = ActivityScenario.launch(SshSetupActivity.class)) {
            fillIn(SshFixtureTest.testKey("ed25519-pass"), "not-the-passphrase");
            onView(withId(R.id.ssh_key_state)).check(matches(withText(R.string.ssh_key_encrypted)));
            connect(screen);
            awaitStep("failed:key-wrong-passphrase");
            onView(withId(R.id.ssh_status)).check(matches(withText(R.string.ssh_fail_key_wrong_passphrase)));
        }
    }

    @Test
    public void aPastedKeyWithItsPassphraseAddsThePc() throws InterruptedException {
        SshFixtureTest.host();
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SshPcs store = SshPcs.on(app);
        SshPcs.Pc before = store.find(SshFixtureTest.host(), SshFixtureTest.port(), SshFixtureTest.user());
        if (before != null) {
            store.remove(before.origin);
            PCStore.forget(app, before.origin);
        }
        try (ActivityScenario<SshSetupActivity> screen = ActivityScenario.launchActivityForResult(SshSetupActivity.class)) {
            fillIn(SshFixtureTest.testKey("ed25519-pass"), "test-only-passphrase");
            connect(screen);
            awaitStep("confirm-host");
            onView(withText(containsString("SHA256:"))).inRoot(isDialog()).check(matches(withText(containsString("SHA256:"))));
            onView(withText(R.string.ssh_trust)).inRoot(isDialog()).perform(click());
            awaitStep("done");
            assertEquals(Activity.RESULT_OK, screen.getResult().getResultCode());
        }
        SshPcs.Pc added = store.find(SshFixtureTest.host(), SshFixtureTest.port(), SshFixtureTest.user());
        assertNotNull(added);
        assertEquals("imported", added.auth);
        assertEquals("ed25519", added.keyType);
        assertEquals(added.origin, PCStore.current(app));

        // set up again: the confirmed host key is not asked about twice, and the PC keeps its address
        Intent again = new Intent(app, SshSetupActivity.class).putExtra(SshSetupActivity.EXTRA_ORIGIN, added.origin);
        try (ActivityScenario<SshSetupActivity> screen = ActivityScenario.launch(again)) {
            onView(withId(R.id.ssh_private_key)).perform(scrollTo(), replaceText(SshFixtureTest.testKey("ecdsa")), closeSoftKeyboard());
            connect(screen);
            awaitStep("signing-in");
            awaitStep("done");
        }
        SshPcs.Pc changed = store.get(added.origin);
        assertEquals("ecdsa 256", changed.keyType);
        assertEquals(added.origin, changed.origin);

        store.remove(added.origin);
        PCStore.forget(app, added.origin);
    }
}
