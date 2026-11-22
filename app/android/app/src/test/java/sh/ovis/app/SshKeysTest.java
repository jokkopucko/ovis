package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class SshKeysTest {
    static final String PASSPHRASE = "test-only-passphrase";

    /** A file of src/test/resources/ssh-test-keys, made by ssh-keygen (its README). */
    static String key(String name) {
        try (InputStream in = SshKeysTest.class.getResourceAsStream("/ssh-test-keys/" + name)) {
            if (in == null) throw new IllegalStateException("no test key " + name);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException unreadable) {
            throw new IllegalStateException(unreadable);
        }
    }

    private static SshFailure failure(String text, String passphrase) {
        try {
            SshKeys.read(text, passphrase);
        } catch (SshFailure failed) {
            return failed;
        }
        fail("the key was read");
        return null;
    }

    /** The key line the app writes for `name` is the one ssh-keygen wrote beside it, comment and all. */
    private static void readsAs(String name, String passphrase, String type, int bits, boolean encrypted) throws SshFailure {
        SshKeys.Read read = SshKeys.read(key(name), passphrase);
        assertEquals(name, type, read.type);
        assertEquals(name, bits, read.bits);
        assertEquals(name, encrypted, read.encrypted);
        assertEquals(name, key(name + ".pub").trim(), read.publicLine("ovis-test-only"));
    }

    @Test
    public void readsEveryFormatSshKeygenWritesThatOpenSshAccepts() throws SshFailure {
        readsAs("ed25519", null, "ed25519", 256, false);
        readsAs("ed25519-pass", PASSPHRASE, "ed25519", 256, true);
        readsAs("rsa-pass", PASSPHRASE, "rsa", 3072, true);
        readsAs("rsa-pem", "", "rsa", 2048, false);
        readsAs("rsa-pem-pass", PASSPHRASE, "rsa", 2048, true);
        readsAs("ecdsa", null, "ecdsa", 256, false);
    }

    @Test
    public void readsAKeyPastedWithSpaceAroundIt() throws SshFailure {
        assertEquals("ed25519", SshKeys.read("\n  " + key("ed25519") + "\n\n", null).type);
    }

    @Test
    public void asksForThePassphraseOfAnEncryptedKeyBeforeTryingIt() {
        for (String name : new String[] { "ed25519-pass", "rsa-pass", "rsa-pem-pass" }) {
            assertTrue(name, SshKeys.encrypted(key(name)));
            assertEquals(name, "key-needs-passphrase", failure(key(name), null).kind);
            assertEquals(name, "key-needs-passphrase", failure(key(name), "").kind);
        }
        assertFalse(SshKeys.encrypted(key("ed25519")));
        assertFalse(SshKeys.encrypted(key("rsa-pem")));
    }

    @Test
    public void tellsAWrongPassphraseApartFromAKeyItCannotRead() {
        for (String name : new String[] { "ed25519-pass", "rsa-pass", "rsa-pem-pass" }) {
            assertEquals(name, "key-wrong-passphrase", failure(key(name), "not-the-passphrase").kind);
        }
    }

    @Test
    public void sendsAPkcs8KeyToSshKeygenToConvert() {
        SshFailure failed = failure(key("rsa-pkcs8"), null);
        assertEquals("key-format", failed.kind);
        assertEquals("ssh-keygen -p -f key", failed.command);
    }

    @Test
    public void namesWhatWasPastedInsteadOfAPrivateKey() {
        assertEquals("key-public", failure(key("ed25519.pub"), null).kind);
        assertEquals("key-public", failure(key("rsa-pass.pub"), null).kind);
        assertEquals("key-missing", failure("   \n", null).kind);
        assertEquals("key-missing", failure(null, null).kind);
        assertEquals("key-format", failure("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n", null).kind);
        assertEquals("key-not-a-key", failure("hello, this is not a key", null).kind);
        String cut = key("ed25519");
        assertEquals("key-not-a-key", failure(cut.substring(0, cut.indexOf("-----END")), null).kind);
    }

    @Test
    public void refusesDsa() {
        assertEquals("key-unsupported", failure("-----BEGIN DSA PRIVATE KEY-----\nAAAA\n-----END DSA PRIVATE KEY-----\n", null).kind);
    }

    @Test
    public void precheckIsNullOnlyForAKeyItCanTry() {
        assertNull(SshKeys.precheck(key("ed25519")));
        assertNull(SshKeys.precheck(key("rsa-pem-pass")));
        assertNotNull(SshKeys.precheck(key("ecdsa.pub")));
        assertNotNull(SshKeys.precheck(""));
    }

    @Test
    public void keyLineCommentsAreLimitedToWhatAShellQuoteCannotBreak() throws SshFailure {
        SshKeys.Read read = SshKeys.read(key("ed25519"), null);
        assertTrue(read.publicLine("ovis-phone:Pixel_8.a").endsWith(" ovis-phone:Pixel_8.a"));
        for (String bad : new String[] { "it's", "a b", "x;rm", "$(id)", null }) {
            try {
                read.publicLine(bad);
                fail("took the comment " + bad);
            } catch (SshFailure refused) {
                assertEquals("internal", refused.kind);
            }
        }
    }
}
