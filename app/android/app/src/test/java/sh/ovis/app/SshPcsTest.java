package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.trilead.ssh2.crypto.keys.Ed25519PrivateKey;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.junit.Test;

/** The key store over memory and a software AES-GCM sealer (SshVault's cipher, its key outside a Keystore). */
public class SshPcsTest {
    private static final class MemoryPrefs implements SshPcs.Prefs {
        final Map<String, String> values = new HashMap<>();
        /** a disk that refuses the write */
        boolean full;

        @Override
        public String get(String name) {
            return values.get(name);
        }

        @Override
        public boolean put(Map<String, String> changes) {
            if (full) return false;
            for (Map.Entry<String, String> change : changes.entrySet()) {
                if (change.getValue() == null) values.remove(change.getKey());
                else values.put(change.getKey(), change.getValue());
            }
            return true;
        }

        /** Everything stored, as one text: what a copy of the app's files would hold. */
        String all() {
            return String.join("\n", values.values());
        }
    }

    private static final class SoftwareSealer implements SshPcs.Sealer {
        private final SecretKey key;
        /** a Keystore key gone (a reset, a restore on another phone): nothing opens */
        boolean lost;

        SoftwareSealer() throws GeneralSecurityException {
            KeyGenerator generator = KeyGenerator.getInstance("AES");
            generator.init(256);
            key = generator.generateKey();
        }

        @Override
        public String seal(byte[] plain) throws GeneralSecurityException {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            return Base64.getEncoder().encodeToString(cipher.getIV()) + ":" + Base64.getEncoder().encodeToString(cipher.doFinal(plain));
        }

        @Override
        public byte[] open(String sealed) throws GeneralSecurityException {
            if (lost) throw new GeneralSecurityException("the Keystore key is gone");
            String[] parts = sealed.split(":");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.getDecoder().decode(parts[0])));
            return cipher.doFinal(Base64.getDecoder().decode(parts[1]));
        }
    }

    private final MemoryPrefs prefs = new MemoryPrefs();
    private final SoftwareSealer sealer;
    private final SshPcs store;

    public SshPcsTest() throws GeneralSecurityException {
        sealer = new SoftwareSealer();
        store = new SshPcs(prefs, sealer);
    }

    private SshPcs.Pc pc(String origin, String host, String user) {
        SshPcs.Pc pc = new SshPcs.Pc();
        pc.origin = origin;
        pc.host = host;
        pc.port = 22;
        pc.user = user;
        pc.hostKeyAlgorithm = "ssh-ed25519";
        pc.hostKey = "AAAAC3NzaC1lZDI1NTE5AAAAIA==";
        return pc;
    }

    @Test
    public void thePhoneKeyIsMadeOnceAndItsSeedNeverRestsInTheClear() throws SshFailure {
        KeyPair first = store.phoneKey();
        byte[] seed = ((Ed25519PrivateKey) first.getPrivate()).getSeed();
        KeyPair again = new SshPcs(prefs, sealer).phoneKey();
        assertTrue(Arrays.equals(seed, ((Ed25519PrivateKey) again.getPrivate()).getSeed()));
        assertEquals(first.getPublic(), again.getPublic());
        String stored = prefs.all();
        assertFalse(stored.contains(Base64.getEncoder().encodeToString(seed)));
        assertFalse(stored.contains(Base64.getEncoder().withoutPadding().encodeToString(seed)));
        StringBuilder hex = new StringBuilder();
        for (byte b : seed) hex.append(String.format("%02x", b));
        assertFalse(stored.contains(hex.toString()));
    }

    @Test
    public void thePhoneKeyLineNamesThePhoneSafely() throws SshFailure {
        String line = store.phoneKeyLine("Pixel 8 Pro");
        assertTrue(line, line.matches("ssh-ed25519 [A-Za-z0-9+/=]+ ovis-phone:Pixel-8-Pro"));
        assertEquals("ovis-phone:a-b-c", SshPcs.phoneComment("a'b;c"));
        assertEquals("ovis-phone:phone", SshPcs.phoneComment(null));
    }

    @Test
    public void aSeedThatCanNoLongerBeOpenedIsLostUntilANewKeyIsMade() throws SshFailure {
        KeyPair before = store.phoneKey();
        sealer.lost = true;
        try {
            store.phoneKey();
            fail("opened a seed whose key is gone");
        } catch (SshFailure lost) {
            assertEquals("key-lost", lost.kind);
        }
        sealer.lost = false;
        KeyPair renewed = store.renewPhoneKey();
        assertNotEquals(before.getPublic(), renewed.getPublic());
        assertEquals(renewed.getPublic(), store.phoneKey().getPublic());
    }

    @Test
    public void halfAPhoneKeyIsLostNotQuietlyReplaced() throws SshFailure {
        KeyPair made = store.phoneKey();
        prefs.values.remove("phoneKeyPublic");
        try {
            store.phoneKey();
            fail("made a new key over half of the old one");
        } catch (SshFailure lost) {
            assertEquals("key-lost", lost.kind);
        }
        assertTrue(prefs.values.containsKey("phoneKeySeed"));
        assertNotEquals(made.getPublic(), store.renewPhoneKey().getPublic());
    }

    @Test
    public void aWriteThatDidNotLandIsAFailureNotASave() {
        prefs.full = true;
        try {
            store.phoneKey();
            fail("a key the disk refused was handed out");
        } catch (SshFailure refused) {
            assertEquals("internal", refused.kind);
        }
        try {
            store.put(pc("http://127.0.0.2:47317", "studio", "me"));
            fail("a PC the disk refused was taken as saved");
        } catch (IllegalStateException refused) {
            // the setup screen says it could not finish
        }
        assertTrue(prefs.values.isEmpty());
    }

    @Test
    public void keepsFindsAndRemovesPcsByTheirOrigin() {
        store.put(pc("http://127.0.0.2:47317", "Studio.example", "me"));
        store.put(pc("http://127.0.0.3:47317", "laptop", "me"));
        assertEquals(2, store.list().size());
        assertEquals("http://127.0.0.2:47317", store.find("studio.EXAMPLE", 22, "me").origin);
        assertNull(store.find("studio.example", 2222, "me"));
        assertNull(store.find("studio.example", 22, "Me"));
        store.remove("http://127.0.0.2:47317");
        assertNull(store.get("http://127.0.0.2:47317"));
        assertEquals("laptop", store.get("http://127.0.0.3:47317").host);
        assertNull(store.get(null));
    }

    @Test
    public void forgettingAHostKeyKeepsEverythingElse() {
        SshPcs.Pc saved = pc("http://127.0.0.2:47317", "studio", "me");
        store.put(saved);
        store.forgetHostKey(saved.origin);
        SshPcs.Pc after = store.get(saved.origin);
        assertFalse(after.hasHostKey());
        assertEquals("", after.hostKeyAlgorithm);
        assertEquals("me", after.user);
        assertEquals("studio", after.host);
        assertEquals(SshHostKeys.Verdict.UNKNOWN, SshHostKeys.judge(after.hostKeyAlgorithm, after.hostKey, "ssh-ed25519", new byte[] { 1 }));
        store.forgetHostKey("http://127.0.0.9:47317");
        assertEquals(1, store.list().size());
    }

    @Test
    public void eachPcGetsALoopbackAddressOfItsOwnNeverOneARemovedPcHad() {
        String first = store.freeOrigin();
        assertEquals("http://127.0.0.2:47317", first);
        store.put(pc(first, "a", "me"));
        String second = store.freeOrigin();
        assertEquals("http://127.0.0.3:47317", second);
        store.put(pc(second, "b", "me"));
        store.remove(first);
        assertEquals("a removed PC's address (its storage) is not handed out again", "http://127.0.0.4:47317", store.freeOrigin());
        for (int n = 2; n < 255; n++) store.put(pc("http://127.0.0." + n + ":47317", "h" + n, "me"));
        store.remove("http://127.0.0.7:47317");
        assertEquals("once all were handed out, round to a free one", "http://127.0.0.7:47317", store.freeOrigin());
        store.put(pc("http://127.0.0.7:47317", "again", "me"));
        try {
            store.freeOrigin();
            fail("gave out a used address");
        } catch (IllegalStateException full) {
            // every 127.0.0.2-254 is taken
        }
    }

    @Test
    public void aPastedKeyAndItsPassphraseAreSealedAndOpenOnlyWithTheVault() throws SshFailure {
        String pem = SshKeysTest.key("ed25519-pass");
        SshPcs.Pc saved = pc("http://127.0.0.2:47317", "studio", "me");
        store.sealImported(saved, pem, SshKeysTest.PASSPHRASE, "ed25519");
        store.put(saved);
        String stored = prefs.all();
        assertFalse(stored.contains("OPENSSH PRIVATE KEY"));
        assertFalse(stored.contains(pem.split("\n")[1]));
        assertFalse(stored.contains(SshKeysTest.PASSPHRASE));

        SshPcs.Pc again = store.get(saved.origin);
        assertEquals("imported", again.auth);
        assertEquals("ed25519", again.keyType);
        KeyPair opened = store.importedKey(again);
        assertEquals(SshKeys.read(pem, SshKeysTest.PASSPHRASE).pair.getPublic(), opened.getPublic());

        sealer.lost = true;
        try {
            store.importedKey(again);
            fail("opened a key whose vault is gone");
        } catch (SshFailure lost) {
            assertEquals("key-unreadable", lost.kind);
        }
    }

    @Test
    public void removingAPcTakesItsSealedKeyWithIt() throws SshFailure {
        SshPcs.Pc saved = pc("http://127.0.0.2:47317", "studio", "me");
        store.sealImported(saved, SshKeysTest.key("ed25519"), "", "ed25519");
        store.put(saved);
        assertTrue(prefs.all().contains(saved.importedKey));
        store.remove(saved.origin);
        assertFalse(prefs.all().contains(saved.importedKey));
    }

    @Test
    public void aDamagedListStartsEmptyAndTakesNewPcs() {
        prefs.values.put("pcs", "{not json");
        assertTrue(store.list().isEmpty());
        store.put(pc("http://127.0.0.2:47317", "studio", "me"));
        assertEquals(1, store.list().size());
    }

    @Test
    public void gatesAreLongAndUnguessable() {
        String gate = SshPcs.newGate();
        assertTrue(gate.matches("[0-9a-f]{64}"));
        assertNotEquals(gate, SshPcs.newGate());
    }

    @Test
    public void theRemoteKeyIsKeptWhileAnotherPcMaySignInToTheSameAccountWithIt() {
        SshPcs.Pc one = pc("http://127.0.0.2:47317", "studio", "me");
        SshPcs.Pc sameName = pc("http://127.0.0.3:47317", "STUDIO", "me");
        sameName.port = 2222;
        SshPcs.Pc sameMachine = pc("http://127.0.0.4:47317", "192.168.1.20", "me");
        SshPcs.Pc otherMachine = pc("http://127.0.0.5:47317", "laptop", "me");
        otherMachine.hostKey = "AAAAC3NzaC1lZDI1NTE5AAAAIB==";
        SshPcs.Pc otherUser = pc("http://127.0.0.6:47317", "studio", "you");
        assertTrue("the same name on another port", OvisSshPlugin.sharedAccount(Arrays.asList(one, sameName), one));
        assertTrue("the same machine under its address", OvisSshPlugin.sharedAccount(Arrays.asList(one, sameMachine), one));
        assertFalse(OvisSshPlugin.sharedAccount(Arrays.asList(one, otherMachine, otherUser), one));
        sameName.auth = "imported";
        assertFalse("a pasted key is not this phone's", OvisSshPlugin.sharedAccount(Arrays.asList(one, sameName), one));
    }

    @Test
    public void aPcReadsBackAsItWasSaved() {
        SshPcs.Pc saved = pc("http://127.0.0.2:47317", "studio", "me");
        saved.port = 2222;
        saved.keyType = "rsa 3072";
        store.put(saved);
        SshPcs.Pc read = store.get(saved.origin);
        assertEquals(2222, read.port);
        assertEquals("rsa 3072", read.keyType);
        assertEquals("me@studio:2222", read.label());
        assertEquals("127.0.0.2", read.loopbackHost());
    }

    @Test
    public void anSshPcsHostAtAnotherPortIsNeitherOpenedNorLoaded() {
        assertFalse(SshPcs.otherLoopbackPort("http://127.0.0.2:" + SshPcs.LOCAL_PORT + "/"));
        assertFalse(SshPcs.otherLoopbackPort("http://127.0.0.254:" + SshPcs.LOCAL_PORT + "/api/x"));
        assertTrue(SshPcs.otherLoopbackPort("http://127.0.0.2:8080/"));
        assertTrue(SshPcs.otherLoopbackPort("http://127.0.0.3/"));
        assertTrue(SshPcs.otherLoopbackPort("https://127.0.0.2:" + SshPcs.LOCAL_PORT + "/"));
        // 127.0.0.1 and every other host stay as they were
        assertFalse(SshPcs.otherLoopbackPort("http://127.0.0.1:8080/"));
        assertFalse(SshPcs.otherLoopbackPort("http://127.0.0.255:8080/"));
        assertFalse(SshPcs.otherLoopbackPort("https://my-pc.tailnet.ts.net/"));
        assertFalse(SshPcs.otherLoopbackPort("http://192.168.1.20:8080/"));
        // every spelling a browser reads as 127.0.0.2
        for (String host : new String[] { "127.2", "2130706434", "0x7f.0.0.2", "0177.0.0.2", "127.000.000.002", "127.0.0.2.", "127.0.0.%32", "0x7F000002", "user@127.0.0.2" }) {
            assertTrue(host, SshPcs.otherLoopbackPort("http://" + host + ":8080/x"));
        }
        assertFalse(SshPcs.otherLoopbackPort("http://2130706434:" + SshPcs.LOCAL_PORT + "/"));
        assertFalse(SshPcs.otherLoopbackPort("http://my-pc.local:8080/"));
    }
}
