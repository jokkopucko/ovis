package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.concurrent.TimeUnit;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** What SshLink reads from a machine's answers, and the cleanup it runs there (with this machine's sh), without a machine. */
public class SshLinkTest {
    private static String descriptor(int port, String socket, boolean managed) {
        return "D {\"port\":" + port + ",\"pid\":42,\"token\":\"t\",\"socket_path\":\"" + socket + "\"" + (managed ? ",\"managed_remote\":true" : "") + "}";
    }

    @Test
    public void picksTheOvisOfHerdrsDefaultSession() {
        SshLink.Found found = SshLink.parseDiscovery(String.join("\n",
            "Linux", "x86_64",
            descriptor(7400, "/home/me/.config/herdr/sessions/work/herdr.sock", false),
            descriptor(7317, "/home/me/.config/herdr/herdr.sock", false),
            "herdr_running=1", "launcher=plugin", ""));
        assertEquals(7317, found.port);
        assertEquals("Linux", found.system);
        assertEquals("x86_64", found.arch);
        assertTrue(found.herdrRunning);
        assertEquals("plugin", found.launcher);
    }

    @Test
    public void takesAnotherSessionsOvisWhenTheDefaultHasNone() {
        SshLink.Found found = SshLink.parseDiscovery("Darwin\narm64\n" + descriptor(7400, "/Users/me/.config/herdr/sessions/work/herdr.sock", false) + "\nlauncher=launchd\n");
        assertEquals(7400, found.port);
        assertFalse(found.herdrRunning);
        assertEquals("launchd", found.launcher);
    }

    @Test
    public void neverTakesABridgeAnotherPcStarted() {
        SshLink.Found found = SshLink.parseDiscovery("Linux\nx86_64\n" + descriptor(7500, "/home/me/.config/herdr/herdr.sock", true) + "\nlauncher=none\n");
        assertEquals(0, found.port);
        assertTrue(found.bridgeOnly);
    }

    @Test
    public void skipsDescriptorsItCannotRead() {
        SshLink.Found found = SshLink.parseDiscovery("Linux\nx86_64\nD {\"port\":\nD {\"port\":70000,\"socket_path\":\"/x/herdr/herdr.sock\"}\nD {\"port\":0}\nlauncher=systemd\n");
        assertEquals(0, found.port);
        assertFalse(found.bridgeOnly);
        assertEquals("systemd", found.launcher);
    }

    @Test
    public void startsEachLauncherWithItsOwnCommand() {
        assertEquals("herdr plugin action invoke devswha.ovis.start", SshLink.startCommand("plugin"));
        assertEquals("herdr plugin action invoke devswha.herdr-web-ui.start", SshLink.startCommand("plugin-legacy"));
        assertEquals("systemctl --user start ovis.service", SshLink.startCommand("systemd"));
        assertEquals("launchctl kickstart gui/$(id -u)/sh.ovis.server", SshLink.startCommand("launchd"));
        assertNull(SshLink.startCommand("none"));
    }

    private static final String READY = "os=Linux\narch=x86_64\nhas=curl\nhas=git\nhas=tar\nhas=unzip\nwritable=1\nfree_kb=52428800\n";

    @Test
    public void installsWhereTheInstallerRuns() {
        assertNull(SshLink.cannotInstall(READY));
        assertNull(SshLink.cannotInstall(READY.replace("x86_64", "aarch64").replace("free_kb=52428800", "free_kb=")));
        assertNull(SshLink.cannotInstall("os=Darwin\narch=arm64\nhas=curl\nhas=git\nhas=tar\nhas=unzip\nwritable=1\nfree_kb=2097152"));
        SshFailure noUnzip = SshLink.cannotInstall(READY.replace("has=unzip\n", ""));
        assertEquals("unzip", noUnzip.getMessage());
        assertTrue(noUnzip.command, noUnzip.command.startsWith("sudo apt install unzip"));
    }

    @Test
    public void saysWhatAMachineLacksForAnInstall() {
        assertEquals("install-unsupported", SshLink.cannotInstall(READY.replace("Linux", "FreeBSD")).kind);
        assertEquals("install-unsupported", SshLink.cannotInstall(READY.replace("x86_64", "armv7l")).kind);
        assertEquals("install-unsupported", SshLink.cannotInstall("").kind);
        SshFailure noGit = SshLink.cannotInstall(READY.replace("has=git\n", ""));
        assertEquals("install-missing-tool", noGit.kind);
        assertEquals("git", noGit.getMessage());
        assertTrue(noGit.command, noGit.command.startsWith("sudo apt install git"));
        SshFailure macNoGit = SshLink.cannotInstall("os=Darwin\narch=arm64\nhas=curl\nhas=tar\nwritable=1\n");
        assertEquals("xcode-select --install", macNoGit.command);
        assertEquals("install-permission", SshLink.cannotInstall(READY.replace("writable=1\n", "")).kind);
        SshFailure full = SshLink.cannotInstall(READY.replace("52428800", "204800"));
        assertEquals("install-disk", full.kind);
        assertEquals("200 MB free", full.getMessage());
    }

    @Test
    public void readsTheInstallersLastStatus() {
        assertEquals(0, SshLink.installerExit("Installing…\n\n\novis-install-exit=0\n"));
        assertEquals(1, SshLink.installerExit("ovis-install-exit=1"));
        assertEquals(3, SshLink.installerExit("a line naming ovis-install-exit=0 in passing\novis-install-exit=3\n"));
        assertEquals(-1, SshLink.installerExit("the connection ended before the end"));
        assertEquals(-1, SshLink.installerExit("ovis-install-exit=x"));
    }

    @Test
    public void readsAChunkedHealthAnswer() {
        assertEquals("{\"ok\":true}", SshLink.unchunk("5\r\n{\"ok\"\r\n6\r\n:true}\r\n0\r\n\r\n"));
        assertEquals("", SshLink.unchunk("zz\r\n"));
    }

    @Test
    public void namesWhyAConnectionFailed() {
        assertEquals("timeout", SshLink.unreachable(new java.net.SocketTimeoutException("read timed out")).kind);
        SshFailure unknown = SshLink.unreachable(new java.io.IOException("wrapped", new java.net.UnknownHostException("nowhere.example")));
        assertEquals("unreachable", unknown.kind);
        assertTrue(unknown.getMessage(), unknown.getMessage().contains("nowhere.example"));
        assertTrue(SshLink.unreachable(new java.net.ConnectException("Connection refused")).getMessage().contains("Connection refused"));
    }

    @Rule
    public final TemporaryFolder homes = new TemporaryFolder();

    private static final String PHONE = "AAAAC3NzaC1lZDI1NTE5AAAAIPhoneKeyBlob0123456789abcdefghijklmnopqrstuv";
    private static final String OTHER = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYOtherKey0123456789abcdefghijklmnop";

    /** Runs the command unauthorizeKey sends to the PC, with `home` as HOME: its answer. */
    private static String unauthorize(Path home) throws IOException, InterruptedException {
        ProcessBuilder builder = new ProcessBuilder("sh", "-c", SshLink.unauthorizeCommand(PHONE)).redirectErrorStream(true);
        builder.environment().put("HOME", home.toString());
        Process sh = builder.start();
        sh.getOutputStream().close();
        String answer = new String(sh.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue("the command did not end", sh.waitFor(20, TimeUnit.SECONDS));
        assertEquals(answer, 0, sh.exitValue());
        return answer.trim();
    }

    private Path keys(String... lines) throws IOException {
        Path home = homes.newFolder().toPath();
        Files.createDirectories(home.resolve(".ssh"));
        Path file = home.resolve(".ssh/authorized_keys");
        Files.write(file, (String.join("\n", lines) + "\n").getBytes(StandardCharsets.UTF_8));
        return home;
    }

    @Test
    public void removeTakesOutOnlyLinesWhoseKeyFieldIsThePhonesKey() throws Exception {
        String plain = "ssh-ed25519 " + PHONE + " ovis-phone:Pixel";
        String withOptions = "from=\"10.0.2.0/24\",command=\"echo hi there\" ssh-ed25519 " + PHONE + " pasted";
        String agentOption = "command=\"ssh-agent -D\" ssh-ed25519 " + PHONE + " agent";
        String mentionsInComment = "ecdsa-sha2-nistp256 " + OTHER + " " + PHONE;
        String mentionsInOption = "command=\"echo ssh-ed25519 " + PHONE + "\" ecdsa-sha2-nistp256 " + OTHER + " note";
        String unrelated = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUnrelated0123456789abcdefghijklmnopqrstuvwx keep";
        Path home = keys(plain, withOptions, agentOption, mentionsInComment, mentionsInOption, unrelated);
        Path file = home.resolve(".ssh/authorized_keys");
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("r--------"));

        assertEquals("removed", unauthorize(home));
        assertEquals(mentionsInComment + "\n" + mentionsInOption + "\n" + unrelated + "\n", new String(Files.readAllBytes(file), StandardCharsets.UTF_8));
        assertEquals("a read-only file stays read-only", "r--------", PosixFilePermissions.toString(Files.getPosixFilePermissions(file)));
        assertEquals("absent", unauthorize(home));
    }

    @Test
    public void removeChangesASymlinkedFileWhereItLives() throws Exception {
        Path home = keys("ssh-ed25519 " + PHONE + " phone", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUnrelated0123456789abcdefghijklmnopqrstuvwx keep");
        Path real = home.resolve("dotfiles-authorized_keys");
        Files.move(home.resolve(".ssh/authorized_keys"), real);
        Files.createSymbolicLink(home.resolve(".ssh/authorized_keys"), real);

        assertEquals("removed", unauthorize(home));
        assertTrue(Files.isSymbolicLink(home.resolve(".ssh/authorized_keys")));
        assertFalse(new String(Files.readAllBytes(real), StandardCharsets.UTF_8).contains(PHONE));
    }
}
