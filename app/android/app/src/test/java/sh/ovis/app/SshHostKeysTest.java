package sh.ovis.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Base64;
import org.junit.Test;

public class SshHostKeysTest {
    /** The wire bytes of a test key's public half (the Base64 field of its .pub line). */
    private static byte[] blob(String name) {
        return Base64.getDecoder().decode(SshKeysTest.key(name + ".pub").trim().split(" ")[1]);
    }

    private static final byte[] KEY = blob("ed25519");
    private static final byte[] OTHER = blob("ed25519-pass");
    private static final String SAVED = SshHostKeys.encode(KEY);

    @Test
    public void onlyTheConfirmedKeyOfTheConfirmedTypeLetsAConnectionOn() {
        assertEquals(SshHostKeys.Verdict.SAME, SshHostKeys.judge("ssh-ed25519", SAVED, "ssh-ed25519", KEY));
        assertEquals(SshHostKeys.Verdict.CHANGED, SshHostKeys.judge("ssh-ed25519", SAVED, "ssh-ed25519", OTHER));
        assertEquals(SshHostKeys.Verdict.CHANGED, SshHostKeys.judge("ssh-ed25519", SAVED, "rsa-sha2-512", KEY));
        assertEquals(SshHostKeys.Verdict.CHANGED, SshHostKeys.judge("ssh-ed25519", SAVED, null, KEY));
        assertEquals(SshHostKeys.Verdict.CHANGED, SshHostKeys.judge("ssh-ed25519", SAVED, "ssh-ed25519", null));
    }

    @Test
    public void noSavedKeyIsUnknownNeverTrusted() {
        assertEquals(SshHostKeys.Verdict.UNKNOWN, SshHostKeys.judge(null, null, "ssh-ed25519", KEY));
        assertEquals(SshHostKeys.Verdict.UNKNOWN, SshHostKeys.judge("", "", "ssh-ed25519", KEY));
        // a key forgotten on purpose keeps no algorithm either (SshPcs.forgetHostKey)
        assertEquals(SshHostKeys.Verdict.UNKNOWN, SshHostKeys.judge("ssh-ed25519", "", "ssh-ed25519", KEY));
    }

    @Test
    public void aSavedKeyThatCannotBeReadFailsClosed() {
        assertEquals(SshHostKeys.Verdict.CHANGED, SshHostKeys.judge("ssh-ed25519", "not base64!", "ssh-ed25519", KEY));
        assertEquals("", SshHostKeys.fingerprint("not base64!"));
        assertEquals("", SshHostKeys.fingerprint(""));
        assertEquals("", SshHostKeys.fingerprint((String) null));
    }

    @Test
    public void fingerprintsAreTheOnesSshKeygenPrints() {
        for (String name : new String[] { "ed25519", "rsa-pass", "ecdsa" }) {
            String expected = SshKeysTest.key(name + ".fingerprint").trim();
            assertEquals(name, expected, SshHostKeys.fingerprint(blob(name)));
            assertEquals(name, expected, SshHostKeys.fingerprint(SshHostKeys.encode(blob(name))));
        }
    }

    @Test
    public void theVerifierRefusesAnUnconfirmedHostAndKeepsItsKeyToShow() {
        SshLink.HostKeyCheck first = new SshLink.HostKeyCheck(null, null);
        assertFalse(first.verifyServerHostKey("pc", 22, "ssh-ed25519", KEY));
        assertEquals(SshHostKeys.Verdict.UNKNOWN, first.verdict);
        assertEquals("ssh-ed25519", first.seenAlgorithm);
        assertArrayEquals(KEY, first.seenKey);

        SshLink.HostKeyCheck saved = new SshLink.HostKeyCheck("ssh-ed25519", SAVED);
        assertTrue(saved.verifyServerHostKey("pc", 22, "ssh-ed25519", KEY));
        assertEquals(SshHostKeys.Verdict.SAME, saved.verdict);

        SshLink.HostKeyCheck changed = new SshLink.HostKeyCheck("ssh-ed25519", SAVED);
        assertFalse(changed.verifyServerHostKey("pc", 22, "ssh-ed25519", OTHER));
        assertEquals(SshHostKeys.Verdict.CHANGED, changed.verdict);
    }

    @Test
    public void onlyTheHostKeyAndKeyFailuresStopReconnecting() {
        for (String kind : new String[] { "host-key-changed", "host-key-unknown", "auth", "key-unreadable", "key-lost" }) {
            assertTrue(kind, new SshFailure(kind, "").stops());
        }
        for (String kind : new String[] { "unreachable", "timeout", "no-ovis", "not-started", "bridge-only", "unsupported", "internal" }) {
            assertFalse(kind, new SshFailure(kind, "").stops());
        }
        assertNull(new SshFailure("auth", "").command);
    }
}
