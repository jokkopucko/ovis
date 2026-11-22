package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;
import static org.junit.Assume.assumeTrue;

import android.content.Context;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.trilead.ssh2.Connection;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The SSH path on a phone, against the disposable fixture (scripts/fixtures/phone-ssh, run by
 * emulator-run.sh): the real Keystore, sshlib, sshd and Ovis. Its address comes in as instrumentation
 * arguments (sshHost, sshPort, sshUser, sshPassword; bareSshPort for the first install), and a test
 * without them is skipped. The fixture authorizes every test key of ssh-test-keys but rsa-pem.
 */
@RunWith(AndroidJUnit4.class)
public class SshFixtureTest {
    static final String TAG = "OvisSshTest";

    static Bundle args() {
        return InstrumentationRegistry.getArguments();
    }

    static String host() {
        String host = args().getString("sshHost");
        assumeTrue("no fixture address (run scripts/fixtures/phone-ssh/emulator-run.sh)", host != null);
        return host;
    }

    static int port() {
        return Integer.parseInt(args().getString("sshPort", "2290"));
    }

    static String user() {
        return args().getString("sshUser", "fixture");
    }

    static String password() {
        return args().getString("sshPassword", "phone-ssh-test-only");
    }

    static String testKey(String name) {
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("ssh-test-keys/" + name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            for (int read; (read = in.read(buffer)) > 0; ) out.write(buffer, 0, read);
            return out.toString("UTF-8");
        } catch (IOException missing) {
            throw new IllegalStateException(missing);
        }
    }

    private static Context app() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    /** The fixture's host key, as the setup screen sees it before it is confirmed. */
    static SshLink.HostKeyCheck hostKey(String host, int port) throws SshFailure {
        SshLink.HostKeyCheck first = new SshLink.HostKeyCheck(null, null);
        try {
            SshLink.connect(host, port, first).close();
            fail("connected to a host whose key was never confirmed");
        } catch (SshFailure unknown) {
            assertEquals("host-key-unknown", unknown.kind);
        }
        assertNotNull(first.seenKey);
        return first;
    }

    static Connection connected(String host, int port) throws SshFailure {
        SshLink.HostKeyCheck seen = hostKey(host, port);
        return SshLink.connect(host, port, new SshLink.HostKeyCheck(seen.seenAlgorithm, SshHostKeys.encode(seen.seenKey)));
    }

    @Test
    public void aHostKeyIsUnknownUntilConfirmedAndAnotherOneFailsClosed() throws SshFailure {
        SshLink.HostKeyCheck seen = hostKey(host(), port());
        SshLink.connect(host(), port(), new SshLink.HostKeyCheck(seen.seenAlgorithm, SshHostKeys.encode(seen.seenKey))).close();
        byte[] other = seen.seenKey.clone();
        other[other.length - 1] ^= 1;
        try {
            SshLink.connect(host(), port(), new SshLink.HostKeyCheck(seen.seenAlgorithm, SshHostKeys.encode(other))).close();
            fail("connected with another host key");
        } catch (SshFailure changed) {
            assertEquals("host-key-changed", changed.kind);
        }
        Log.i(TAG, "host key " + seen.seenAlgorithm + " " + SshHostKeys.fingerprint(seen.seenKey));
    }

    @Test
    public void pastedKeysOfEveryFormatSignInAndReachOvis() throws Exception {
        List<String> signedIn = new ArrayList<>();
        for (String name : new String[] { "ed25519", "ed25519-pass", "rsa-pass", "rsa-pem-pass", "ecdsa" }) {
            long started = SystemClock.elapsedRealtime();
            SshKeys.Read read = SshKeys.read(testKey(name), name.endsWith("-pass") ? "test-only-passphrase" : null);
            long opened = SystemClock.elapsedRealtime() - started;
            Connection connection = connected(host(), port());
            try {
                SshLink.signIn(connection, user(), read.pair);
                int ovis = SshLink.ovisPort(connection);
                assertTrue(name, SshLink.answersAsOvis(connection, ovis));
            } finally {
                connection.close();
            }
            signedIn.add(name + " (" + read.type + " " + read.bits + ", opened in " + opened + " ms)");
        }
        Log.i(TAG, "signed in with " + signedIn);
    }

    @Test
    public void aKeyThePcDoesNotKnowIsRefused() throws SshFailure {
        Connection connection = connected(host(), port());
        try {
            SshLink.signIn(connection, user(), SshKeys.read(testKey("rsa-pem"), null).pair);
            fail("signed in with a key the PC does not know");
        } catch (SshFailure refused) {
            assertEquals("auth", refused.kind);
        } finally {
            connection.close();
        }
    }

    @Test
    public void aPasswordOnceRegistersThePhoneKeyWhichRemoveTakesBack() throws SshFailure {
        SshPcs store = SshPcs.on(app());
        KeyPair phone = store.phoneKey();
        String line = store.phoneKeyLine(android.os.Build.MODEL);
        Connection connection = connected(host(), port());
        try {
            SshLink.signInWithPassword(connection, user(), password());
            SshLink.authorizeKey(connection, line);
            SshLink.authorizeKey(connection, line);
        } finally {
            connection.close();
        }
        String blob = line.split(" ")[1];
        // the same key with options goes too; a line that only mentions it in its comment stays
        String withOptions = "from=\"10.0.2.0/24\",no-pty ssh-ed25519 " + blob + " pasted-by-hand";
        // another key's line that names the phone's key as a whole word of its comment stays too
        String mentions = testKey("ecdsa.pub").trim() + " " + blob;
        connection = connected(host(), port());
        try {
            SshLink.signIn(connection, user(), phone);
            // a mode other than 600 that sshd accepts is kept
            SshLink.runOk(connection, "printf '%s\\n%s\\n' '" + withOptions + "' '" + mentions + "' >> ~/.ssh/authorized_keys; chmod 640 ~/.ssh/authorized_keys", 20_000);
            assertEquals("removed", SshLink.unauthorizeKey(connection, blob));
            String after = SshLink.run(connection, "cat ~/.ssh/authorized_keys; stat -c %a ~/.ssh/authorized_keys", 20_000);
            assertFalse(after, after.contains(" " + blob + " "));
            assertFalse(after, after.contains("pasted-by-hand"));
            assertTrue(after, after.contains(mentions));
            assertTrue(after, after.contains(testKey("ed25519.pub").trim()));
            assertTrue(after, after.trim().endsWith("640"));
            assertEquals("absent", SshLink.unauthorizeKey(connection, blob));
        } finally {
            connection.close();
        }
        connection = connected(host(), port());
        try {
            SshLink.signIn(connection, user(), phone);
            fail("the key still signs in after it was taken out");
        } catch (SshFailure refused) {
            assertEquals("auth", refused.kind);
        } finally {
            connection.close();
        }
    }

    @Test
    public void theKeystoreVaultSealsAndOpensAPastedKey() throws SshFailure {
        SshPcs store = SshPcs.on(app());
        SshPcs.Pc pc = new SshPcs.Pc();
        pc.origin = "http://127.0.0.250:" + SshPcs.LOCAL_PORT;
        store.sealImported(pc, testKey("ed25519-pass"), "test-only-passphrase", "ed25519");
        assertFalse(pc.importedKey.contains("OPENSSH"));
        assertEquals(SshKeys.read(testKey("ed25519-pass"), "test-only-passphrase").pair.getPublic(), store.importedKey(pc).getPublic());
    }

    /** One request to a tunnel on this phone, read to its end. */
    static String get(String loopback, String cookie) throws IOException {
        try (Socket socket = new Socket(InetAddress.getByName(loopback), SshPcs.LOCAL_PORT)) {
            socket.setSoTimeout(30_000);
            socket.getOutputStream().write(("GET /api/health?scope=bridge HTTP/1.1\r\nHost: " + loopback + ":" + SshPcs.LOCAL_PORT + "\r\nConnection: close\r\n" + (cookie == null ? "" : "Cookie: " + cookie + "\r\n") + "\r\n").getBytes(StandardCharsets.US_ASCII));
            ByteArrayOutputStream answer = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            InputStream in = socket.getInputStream();
            for (int read; (read = in.read(buffer)) >= 0; ) answer.write(buffer, 0, read);
            return answer.toString("UTF-8");
        }
    }

    @Test
    public void theTunnelPassesTheGateAndStopsOnAChangedHostKey() throws Exception {
        SshLink.HostKeyCheck seen = hostKey(host(), port());
        SshPcs store = SshPcs.on(app());
        SshPcs.Pc pc = new SshPcs.Pc();
        pc.origin = "http://127.0.0.251:" + SshPcs.LOCAL_PORT;
        pc.host = host();
        pc.port = port();
        pc.user = user();
        pc.hostKeyAlgorithm = seen.seenAlgorithm;
        pc.hostKey = SshHostKeys.encode(seen.seenKey);
        store.sealImported(pc, testKey("ed25519"), "", "ed25519");
        store.put(pc);
        try {
            String gate = SshTunnels.open(app(), pc).gate();
            assertTrue(get("127.0.0.251", null).startsWith("HTTP/1.1 403 "));
            String answer = get("127.0.0.251", SshTunnel.GATE_COOKIE + "=" + gate);
            assertTrue(answer, answer.startsWith("HTTP/1.1 200 ") && answer.contains("\"ok\":true"));

            byte[] other = seen.seenKey.clone();
            other[other.length - 1] ^= 1;
            pc.hostKey = SshHostKeys.encode(other);
            store.put(pc);
            String stoppedGate = SshTunnels.open(app(), pc).gate();
            String stopped = get("127.0.0.251", SshTunnel.GATE_COOKIE + "=" + stoppedGate);
            assertTrue(stopped, stopped.startsWith("HTTP/1.1 503 ") && stopped.contains("X-Ovis-Ssh: host-key-changed"));
        } finally {
            SshTunnels.closeFor(pc.origin);
            store.remove(pc.origin);
        }
    }

    /**
     * The first install from the phone, on the bare fixture (no herdr, no Ovis): the official installer
     * runs over SSH, herdr is started headless, and Ovis answers. Its time and lines are logged for
     * emulator-run.sh's numbers. Skipped without bareSshPort.
     */
    @Test
    public void installsOvisWhereThereIsNone() throws Exception {
        String bare = args().getString("bareSshPort");
        assumeTrue("no bare fixture", bare != null);
        int port = Integer.parseInt(bare);
        Connection connection = connected(host(), port);
        try {
            SshLink.signInWithPassword(connection, user(), password());
            try {
                SshLink.ovisPort(connection);
                fail("the bare fixture already has Ovis");
            } catch (SshFailure none) {
                assertEquals("no-ovis", none.kind);
            }
            long started = SystemClock.elapsedRealtime();
            List<String> lines = new ArrayList<>();
            int ovis = SshLink.install(connection, lines::add, 180_000, SystemClock::elapsedRealtime);
            long took = SystemClock.elapsedRealtime() - started;
            assertTrue(SshLink.answersAsOvis(connection, ovis));
            Log.i(TAG, "installed in " + took + " ms, " + lines.size() + " lines, Ovis on " + ovis);
            for (String line : lines) Log.i(TAG, "install: " + line);
        } finally {
            connection.close();
        }
    }
}
