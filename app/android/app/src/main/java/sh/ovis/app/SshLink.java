package sh.ovis.app;

import com.trilead.ssh2.ChannelCondition;
import com.trilead.ssh2.Connection;
import com.trilead.ssh2.LocalStreamForwarder;
import com.trilead.ssh2.ServerHostKeyVerifier;
import com.trilead.ssh2.Session;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.LongSupplier;
import org.json.JSONObject;

/**
 * One SSH connection to a PC and what the app does over it, following what Ovis on a PC does to add a
 * PC over SSH (server/remote-host.ts, server/pc-install.ts): read the bridge descriptors under
 * ~/.config/herdr-web-ui/bridges for a running Ovis, start an installed one through its own launcher,
 * run the official installer where there is none, and add or take away a key line in authorized_keys.
 * Only an Ovis that serves its own app (not a bridge another PC's Ovis started, which serves that PC
 * alone) can be opened from the phone.
 */
final class SshLink {
    static final String REMOTE_PATH = "export PATH=\"$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; ";
    static final String INSTALL_COMMAND = "curl -fsSL https://ovis.sh/install.sh | sh";

    private SshLink() {}

    /**
     * Checks the host key with SshHostKeys. With no expected key the connection is refused as soon as
     * the key is read (nothing is sent to an unconfirmed host, a password least of all), and the key is
     * kept to show; with one, any other key fails closed.
     */
    static final class HostKeyCheck implements ServerHostKeyVerifier {
        final String expectedAlgorithm;
        final String expectedKey;
        String seenAlgorithm;
        byte[] seenKey;
        SshHostKeys.Verdict verdict;

        HostKeyCheck(String expectedAlgorithm, String expectedKey) {
            this.expectedAlgorithm = expectedAlgorithm;
            this.expectedKey = expectedKey;
        }

        @Override
        public boolean verifyServerHostKey(String hostname, int port, String algorithm, byte[] key) {
            seenAlgorithm = algorithm;
            seenKey = key;
            verdict = SshHostKeys.judge(expectedAlgorithm, expectedKey, algorithm, key);
            return verdict == SshHostKeys.Verdict.SAME;
        }
    }

    static Connection connect(String host, int port, HostKeyCheck check) throws SshFailure {
        Connection connection = new Connection(host, port);
        boolean pinned = check.expectedAlgorithm != null && !check.expectedAlgorithm.isEmpty();
        // the server must show the very kind of key that was confirmed, or the comparison means nothing
        if (pinned) connection.setServerHostKeyAlgorithms(new String[] { check.expectedAlgorithm });
        try {
            connection.connect(check, 10_000, 15_000);
            return connection;
        } catch (IOException failed) {
            connection.close();
            if (check.verdict == SshHostKeys.Verdict.CHANGED) throw new SshFailure("host-key-changed", "The host key changed");
            if (check.verdict == SshHostKeys.Verdict.UNKNOWN) throw new SshFailure("host-key-unknown", "The host key is not confirmed");
            // the PC no longer offers the kind of key that was confirmed: sshlib says the proposals do not match
            if (check.seenKey == null && pinned && offersOtherKinds(failed)) {
                throw new SshFailure("host-key-changed", "The machine no longer offers the host key type confirmed before");
            }
            throw unreachable(failed);
        }
    }

    private static boolean offersOtherKinds(Throwable failed) {
        for (Throwable cause = failed; cause != null; cause = cause.getCause()) {
            String message = String.valueOf(cause.getMessage());
            if (message.contains("host key") || message.contains("proposals do not match") || message.contains("Cannot negotiate")) return true;
            if (cause == cause.getCause()) break;
        }
        return false;
    }

    /** A connection that failed before or after signing in, in words a person can act on. */
    static SshFailure unreachable(IOException failed) {
        for (Throwable cause = failed; cause != null; cause = cause.getCause()) {
            if (cause instanceof java.net.UnknownHostException) return new SshFailure("unreachable", "No such host name: " + cause.getMessage());
            if (cause instanceof java.net.SocketTimeoutException) return new SshFailure("timeout", "No answer in time");
            if (cause instanceof java.net.ConnectException) return new SshFailure("unreachable", "Nothing answers on that SSH port (" + cause.getMessage() + ")");
            if (cause == cause.getCause()) break;
        }
        return new SshFailure("unreachable", SshFailure.rootMessage(failed));
    }

    /** How long signing in may take once the key exchange is done: sshlib's own waits there have no limit. */
    static final long SIGN_IN_MS = 30_000;

    private static final ScheduledExecutorService DEADLINES = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "ovis-ssh-deadline");
        thread.setDaemon(true);
        return thread;
    });

    interface Step<T> {
        T run() throws SshFailure;
    }

    /**
     * `step` on `connection`, which is closed if it takes longer than `limitMs` (sshlib's waits for a session,
     * a forwarded stream or an answer to authentication have no limit of their own): a step cut that way fails
     * with `timeout`.
     */
    static <T> T within(Connection connection, long limitMs, Step<T> step) throws SshFailure {
        AtomicBoolean expired = new AtomicBoolean();
        ScheduledFuture<?> alarm = DEADLINES.schedule(() -> {
            expired.set(true);
            connection.close();
        }, limitMs, TimeUnit.MILLISECONDS);
        try {
            return step.run();
        } catch (SshFailure | RuntimeException failed) {
            if (expired.get()) throw new SshFailure("timeout", "The machine did not answer in time");
            throw failed;
        } finally {
            alarm.cancel(false);
        }
    }

    static void signIn(Connection connection, String user, KeyPair pair) throws SshFailure {
        within(connection, SIGN_IN_MS, () -> {
            signInNow(connection, user, pair);
            return null;
        });
    }

    private static void signInNow(Connection connection, String user, KeyPair pair) throws SshFailure {
        try {
            if (!connection.authenticateWithPublicKey(user, pair)) throw new SshFailure("auth", "The machine refused the key");
        } catch (IOException failed) {
            throw unreachable(failed);
        }
    }

    static void signInWithPassword(Connection connection, String user, String password) throws SshFailure {
        within(connection, SIGN_IN_MS, () -> {
            signInWithPasswordNow(connection, user, password);
            return null;
        });
    }

    private static void signInWithPasswordNow(Connection connection, String user, String password) throws SshFailure {
        try {
            if (connection.isAuthMethodAvailable(user, "password") && connection.authenticateWithPassword(user, password)) return;
            if (connection.isAuthMethodAvailable(user, "keyboard-interactive")) {
                // only a lone password prompt gets the password: never a one-time code or another backend's question
                boolean done = connection.authenticateWithKeyboardInteractive(user, (name, instruction, count, prompts, echo) -> {
                    String[] answers = new String[count];
                    java.util.Arrays.fill(answers, "");
                    if (count == 1 && !echo[0] && prompts[0].toLowerCase(Locale.ROOT).contains("password")) answers[0] = password;
                    return answers;
                });
                if (done) return;
            }
        } catch (IOException failed) {
            throw unreachable(failed);
        }
        throw new SshFailure("auth", "The machine refused that password");
    }

    /** `command`'s output (stdout only), at most 512 KiB, each line also handed to `lines` as it comes when given. */
    static String run(Connection connection, String command, long timeoutMs, Consumer<String> lines) throws SshFailure {
        return run(connection, command, timeoutMs, lines, false);
    }

    /** As run, failing with `internal` unless the command exits 0: for what edits the machine's files. */
    static String runOk(Connection connection, String command, long timeoutMs) throws SshFailure {
        return run(connection, command, timeoutMs, null, true);
    }

    private static String run(Connection connection, String command, long timeoutMs, Consumer<String> lines, boolean mustSucceed) throws SshFailure {
        // the loop below keeps its own time once the command runs; opening the session and starting it have none
        return within(connection, timeoutMs + 10_000, () -> runNow(connection, command, timeoutMs, lines, mustSucceed));
    }

    private static String runNow(Connection connection, String command, long timeoutMs, Consumer<String> lines, boolean mustSucceed) throws SshFailure {
        Session session = null;
        try {
            session = connection.openSession();
            session.execCommand(command);
            InputStream out = session.getStdout();
            InputStream err = session.getStderr();
            ByteArrayOutputStream text = new ByteArrayOutputStream();
            StringBuilder line = new StringBuilder();
            byte[] buffer = new byte[8192];
            long end = System.currentTimeMillis() + timeoutMs;
            while (true) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) throw new SshFailure("timeout", "The machine did not answer in time");
                int state = session.waitForCondition(ChannelCondition.STDOUT_DATA | ChannelCondition.STDERR_DATA | ChannelCondition.EOF, left);
                if ((state & ChannelCondition.TIMEOUT) != 0) throw new SshFailure("timeout", "The machine did not answer in time");
                while (out.available() > 0) {
                    int read = out.read(buffer);
                    if (read <= 0) continue;
                    if (text.size() < 512 * 1024) text.write(buffer, 0, read);
                    if (lines != null) {
                        for (String piece : new String(buffer, 0, read, StandardCharsets.UTF_8).split("(?<=\n)", -1)) {
                            line.append(piece);
                            if (piece.endsWith("\n")) {
                                String whole = line.toString().trim();
                                line.setLength(0);
                                if (!whole.isEmpty()) lines.accept(whole);
                            }
                        }
                    }
                }
                while (err.available() > 0) err.read(buffer);
                if ((state & ChannelCondition.EOF) != 0 && out.available() == 0 && err.available() == 0) break;
            }
            session.waitForCondition(ChannelCondition.EXIT_STATUS, 2_000);
            if (mustSucceed) {
                Integer status = session.getExitStatus();
                if (status == null || status != 0) throw new SshFailure("internal", "The command failed there (exit " + status + ")");
            }
            return text.toString("UTF-8");
        } catch (IOException failed) {
            throw unreachable(failed);
        } catch (IllegalStateException closed) {
            // sshlib's word for a connection that was closed meanwhile (a drop, a network change)
            throw new SshFailure("unreachable", "The connection ended");
        } finally {
            if (session != null) session.close();
        }
    }

    static String run(Connection connection, String command, long timeoutMs) throws SshFailure {
        return run(connection, command, timeoutMs, null);
    }

    static final class Found {
        int port;
        String launcher = "none";
        String system = "";
        String arch = "";
        boolean herdrRunning;
        boolean bridgeOnly;
    }

    /**
     * The live descriptors (their PID answers kill -0, as server/remote-host.ts checks), whether herdr
     * runs, and the launcher test of server/pc-install.ts.
     */
    static final String DISCOVER =
        REMOTE_PATH +
        "uname -s; uname -m; " +
        "for f in \"$HOME/.config/herdr-web-ui/bridges/\"*.json; do test -f \"$f\" && test ! -L \"$f\" || continue; " +
        "c=$(head -c 16384 \"$f\" | tr -d '\\n'); pid=$(printf '%s' \"$c\" | sed -n 's/.*\"pid\":\\([0-9][0-9]*\\).*/\\1/p'); " +
        "test -n \"$pid\" && kill -0 \"$pid\" 2>/dev/null && printf 'D %s\\n' \"$c\"; done; " +
        "herdr status server --json 2>/dev/null </dev/null | grep -q '\"running\":true' && echo herdr_running=1; " +
        "plugins=$(herdr plugin list 2>/dev/null </dev/null); " +
        "if printf '%s\\n' \"$plugins\" | grep -q 'devswha.ovis '; then echo launcher=plugin; " +
        "elif printf '%s\\n' \"$plugins\" | grep -q 'devswha.herdr-web-ui '; then echo launcher=plugin-legacy; " +
        "elif systemctl --user cat ovis.service >/dev/null 2>&1; then echo launcher=systemd; " +
        "elif test -f \"$HOME/Library/LaunchAgents/sh.ovis.server.plist\"; then echo launcher=launchd; " +
        "else echo launcher=none; fi";

    static Found parseDiscovery(String answer) {
        Found found = new Found();
        String[] lines = answer.split("\n");
        if (lines.length > 0) found.system = lines[0].trim();
        if (lines.length > 1) found.arch = lines[1].trim();
        int fallback = 0;
        for (String line : lines) {
            if (line.startsWith("launcher=")) found.launcher = line.substring("launcher=".length()).trim();
            if (line.trim().equals("herdr_running=1")) found.herdrRunning = true;
            if (!line.startsWith("D ") || found.port > 0) continue;
            try {
                JSONObject descriptor = new JSONObject(line.substring(2));
                int port = descriptor.optInt("port", 0);
                if (port <= 0 || port > 65535) continue;
                // a bridge another PC's Ovis started serves that PC, with a token the phone never has
                if (descriptor.optBoolean("managed_remote", false)) {
                    found.bridgeOnly = true;
                    continue;
                }
                if (descriptor.optString("socket_path").endsWith("/herdr/herdr.sock")) found.port = port;
                else if (fallback == 0) fallback = port;
            } catch (org.json.JSONException unreadable) {
                // a descriptor being rewritten; the next look reads it whole
            }
        }
        if (found.port == 0) found.port = fallback;
        return found;
    }

    static Found discover(Connection connection) throws SshFailure {
        return parseDiscovery(run(connection, DISCOVER, 20_000));
    }

    /** The one command that starts an installed Ovis there through its launcher, as server/pc-install.ts viaLauncher; null for none. */
    static String startCommand(String launcher) {
        switch (launcher) {
            case "plugin":
                return "herdr plugin action invoke devswha.ovis.start";
            case "plugin-legacy":
                return "herdr plugin action invoke devswha.herdr-web-ui.start";
            case "systemd":
                return "systemctl --user start ovis.service";
            case "launchd":
                return "launchctl kickstart gui/$(id -u)/sh.ovis.server";
            default:
                return null;
        }
    }

    /** herdr started headless, in a session of its own so it outlives this SSH connection; it starts its plugins, Ovis among them */
    static final String HEADLESS_HERDR = REMOTE_PATH + "if command -v setsid >/dev/null 2>&1; then setsid nohup herdr server </dev/null >/dev/null 2>&1 & else nohup herdr server </dev/null >/dev/null 2>&1 & fi";

    /** Starts an installed Ovis: a plugin's actions need a running herdr, so without one herdr is started headless and starts it. */
    static void startOvis(Connection connection, Found found) throws SshFailure {
        String start = startCommand(found.launcher);
        if (start == null) throw new SshFailure("no-ovis", "Ovis is not installed there", INSTALL_COMMAND);
        boolean plugin = found.launcher.startsWith("plugin");
        String command = plugin && !found.herdrRunning ? HEADLESS_HERDR : REMOTE_PATH + start + " >/dev/null </dev/null";
        run(connection, command + " 2>&1; true", 30_000);
    }

    /**
     * The port of the PC's own Ovis: a running one, else an installed one started through its launcher,
     * waiting up to `waitMs` for it to register. A PC with none fails with `no-ovis` (or `bridge-only`),
     * one whose Ovis does not come up with `not-started` and the command that starts it there.
     */
    static int ovisPort(Connection connection, long waitMs, LongSupplier clock) throws SshFailure {
        Found found = discover(connection);
        if (!found.system.equals("Linux") && !found.system.equals("Darwin")) {
            throw new SshFailure("unsupported", "Only Linux and macOS machines can be opened from the phone for now (this one says " + (found.system.isEmpty() ? "nothing" : found.system) + ")");
        }
        if (found.port > 0) return found.port;
        if (found.launcher.equals("none")) {
            throw found.bridgeOnly
                ? new SshFailure("bridge-only", "Only a bridge another PC's Ovis started runs there", INSTALL_COMMAND)
                : new SshFailure("no-ovis", "Ovis is not installed there", INSTALL_COMMAND);
        }
        startOvis(connection, found);
        String start = startCommand(found.launcher);
        long end = clock.getAsLong() + waitMs;
        while (clock.getAsLong() < end) {
            try {
                Thread.sleep(1_000);
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
                throw new SshFailure("cancelled", "Cancelled");
            }
            found = discover(connection);
            if (found.port > 0) return found.port;
        }
        throw new SshFailure("not-started", "Ovis did not start there within " + (waitMs / 1000) + " seconds", start);
    }

    static int ovisPort(Connection connection) throws SshFailure {
        return ovisPort(connection, 30_000, System::currentTimeMillis);
    }

    /** Adds `keyLine` to the account's authorized_keys once, as server/remote-host.ts authorizeKey does. */
    static void authorizeKey(Connection connection, String keyLine) throws SshFailure {
        checkKeyLine(keyLine);
        runOk(
            connection,
            "set -eu; umask 077; mkdir -p \"$HOME/.ssh\"; touch \"$HOME/.ssh/authorized_keys\"; key='" + keyLine + "'; " +
            "grep -qxF \"$key\" \"$HOME/.ssh/authorized_keys\" || printf '\\n%s\\n' \"$key\" >> \"$HOME/.ssh/authorized_keys\"; chmod 600 \"$HOME/.ssh/authorized_keys\"",
            20_000
        );
    }

    /**
     * Takes every line whose key is `blob` (its Base64: the field after the line's key type, so a line pasted
     * with another comment or with options counts too, and a line that only mentions it, in its comment or
     * anywhere else, does not) out of the account's authorized_keys, keeping every other line and the file's
     * mode (a symlinked file is changed where it lives): "removed", or "absent" when none was there. A file
     * that cannot be read whole is left as it is.
     */
    static String unauthorizeKey(Connection connection, String blob) throws SshFailure {
        if (!blob.matches("[A-Za-z0-9+/]{40,}={0,2}")) throw new SshFailure("internal", "Unexpected characters in the key");
        String answer = runOk(connection, unauthorizeCommand(blob), 20_000).trim();
        if (!answer.equals("removed") && !answer.equals("absent")) throw new SshFailure("internal", "Unexpected answer: " + answer);
        return answer;
    }

    /** The shell command unauthorizeKey runs on the PC, for a `blob` already checked. */
    static String unauthorizeCommand(String blob) {
        // the key field follows the first field that names a key type; options, if any, come before it, and a
        // quoted option value (which may hold spaces, a key type's name or a key) is never a field of its own
        String has = "{ s = $0; gsub(/\"[^\"]*\"/, \"Q\", s); n = split(s, w, /[ \\t]+/); " +
            "for (i = 1; i < n; i++) if (w[i] ~ /^(ssh-|ecdsa-sha2-|sk-)/) { if (w[i + 1] == k) { found = 1; next } break } } ";
        return
            "set -eu; f=\"$HOME/.ssh/authorized_keys\"; key='" + blob + "'; " +
            "test -f \"$f\" || { echo absent; exit 0; }; f=$(readlink -f \"$f\" 2>/dev/null || printf %s \"$f\"); " +
            "if ! awk -v k=\"$key\" '" + has + "END { exit !found }' \"$f\"; then echo absent; exit 0; fi; " +
            "m=$(stat -c %a \"$f\" 2>/dev/null || stat -f %Lp \"$f\"); t=$(mktemp \"$f.XXXXXX\"); " +
            "if ! awk -v k=\"$key\" '" + has.replace("found = 1; next", "next") + "{ print }' \"$f\" > \"$t\"; then rm -f \"$t\"; exit 1; fi; " +
            "chmod \"$m\" \"$t\"; mv \"$t\" \"$f\"; echo removed";
    }

    private static void checkKeyLine(String keyLine) throws SshFailure {
        if (!keyLine.matches("[A-Za-z0-9+/=:._@ -]+")) throw new SshFailure("internal", "Unexpected characters in the key line");
    }

    /**
     * Asks the PC's Ovis for /api/health through the connection itself, as PCStore.check asks an address:
     * true when it answers as Ovis.
     */
    static boolean answersAsOvis(Connection connection, int port) throws SshFailure {
        // a port that takes the request and never answers would hold the read below for good
        return within(connection, 20_000, () -> answersAsOvisNow(connection, port));
    }

    private static boolean answersAsOvisNow(Connection connection, int port) throws SshFailure {
        try {
            LocalStreamForwarder stream = connection.createLocalStreamForwarder("127.0.0.1", port);
            try {
                OutputStream out = stream.getOutputStream();
                out.write(("GET /api/health?scope=bridge HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nConnection: close\r\nAccept: application/json\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                out.flush();
                InputStream in = stream.getInputStream();
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) > 0 && body.size() < 256 * 1024) body.write(buffer, 0, read);
                String response = body.toString("UTF-8");
                int start = response.indexOf("\r\n\r\n");
                if (start < 0) return false;
                String head = response.substring(0, start);
                String text = response.substring(start + 4);
                if (head.toLowerCase(Locale.ROOT).contains("transfer-encoding: chunked")) text = unchunk(text);
                return PCStore.answersAsServer(text);
            } finally {
                stream.close();
            }
        } catch (IOException failed) {
            throw unreachable(failed);
        } catch (IllegalStateException closed) {
            throw new SshFailure("unreachable", "The connection ended");
        }
    }

    static String unchunk(String chunked) {
        StringBuilder out = new StringBuilder();
        int at = 0;
        while (at < chunked.length()) {
            int line = chunked.indexOf("\r\n", at);
            if (line < 0) break;
            int size;
            try {
                size = Integer.parseInt(chunked.substring(at, line).split(";")[0].trim(), 16);
            } catch (NumberFormatException damaged) {
                break;
            }
            if (size == 0) break;
            int from = line + 2;
            int to = Math.min(chunked.length(), from + size);
            out.append(chunked, from, to);
            at = to + 2;
        }
        return out.toString();
    }

    // First install from the phone. The PC flow's remote bundle (scripts/build-remote-bundle.ts) is no use
    // here: it starts a bridge-only server (bridgeOnly, a token only that PC's Ovis has), with no app of its
    // own to open. What a phone can drive is the PC flow's other path, the official installer as one shell
    // command (server/pc-install.ts installerRun), which installs the full Ovis as a herdr plugin.

    /** One look at the machine before an install, as server/pc-install.ts PROBE. */
    static final String PROBE = REMOTE_PATH +
        "printf 'os=%s\\narch=%s\\n' \"$(uname -s)\" \"$(uname -m)\"; " +
        "for tool in curl git tar unzip; do command -v \"$tool\" >/dev/null 2>&1 && printf 'has=%s\\n' \"$tool\"; done; " +
        "test -w \"$HOME\" && printf 'writable=1\\n'; " +
        "printf 'free_kb=%s\\n' \"$(df -Pk \"$HOME\" 2>/dev/null | awk 'NR==2 { print $4 }')\"; true";

    /** The space server/pc-install.ts asks for (MIN_FREE_KB). */
    static final long MIN_FREE_KB = 1024L * 1024L;

    /** Why the install cannot start on the machine `probe` describes, or null. */
    static SshFailure cannotInstall(String probe) {
        String os = value(probe, "os");
        String arch = value(probe, "arch");
        if (!(os.equals("Linux") || os.equals("Darwin")) || !java.util.Arrays.asList("x86_64", "amd64", "aarch64", "arm64").contains(arch)) {
            return new SshFailure("install-unsupported", os.isEmpty() ? "No POSIX shell answered" : os + " " + arch);
        }
        // unzip: a release without a compiled server installs from source, and Bun's installer unzips
        for (String tool : new String[] { "curl", "git", "tar", "unzip" }) {
            if (!probe.contains("has=" + tool + "\n") && !probe.endsWith("has=" + tool)) {
                return new SshFailure("install-missing-tool", tool, os.equals("Darwin") ? "xcode-select --install" : "sudo apt install " + tool + "   # or: sudo dnf install " + tool);
            }
        }
        if (!probe.contains("writable=1")) return new SshFailure("install-permission", "This account cannot write to its home folder");
        try {
            long free = Long.parseLong(value(probe, "free_kb"));
            if (free < MIN_FREE_KB) return new SshFailure("install-disk", (free / 1024) + " MB free");
        } catch (NumberFormatException unknown) {
            // df said nothing readable: the installer finds out itself
        }
        return null;
    }

    private static String value(String text, String key) {
        for (String line : text.split("\n")) if (line.startsWith(key + "=")) return line.substring(key.length() + 1).trim();
        return "";
    }

    /**
     * The official installer's run, for one SSH command, as server/pc-install.ts installerRun: downloaded
     * first (a failed download is told as one), run with nothing on stdin on herdr, and its exit status
     * printed. A watcher writes an empty line every two seconds and, once nobody reads (the phone gone),
     * stops the command's whole process group: an install whose phone left ends instead of running on
     * unseen. The latest release, as the one-line install on the website installs it.
     */
    static final String INSTALLER_RUN =
        REMOTE_PATH + "script=$(mktemp) || exit 1; trap 'rm -f \"$script\"' EXIT; trap 'exit 143' HUP INT TERM; " +
        "( trap '' PIPE; while printf '\\n' 2>/dev/null; do sleep 2 >/dev/null 2>&1; done; kill -TERM 0 ) </dev/null 2>/dev/null & watch=$!; " +
        "if ! curl -fsSL --max-time 120 https://ovis.sh/install.sh -o \"$script\" || ! head -n 1 \"$script\" | grep -q '^#!/bin/sh'; then " +
        "kill \"$watch\" 2>/dev/null; echo 'The installer could not be downloaded from ovis.sh'; printf '\\novis-install-exit=1\\n'; exit 0; fi; " +
        "printf '\\n' || exit 141; " +
        "OVIS_RUNTIME=herdr OVIS_NO_OPEN=1 sh \"$script\" </dev/null 2>&1; status=$?; " +
        "kill \"$watch\" 2>/dev/null; printf '\\novis-install-exit=%s\\n' \"$status\"";

    /** The exit status INSTALLER_RUN printed, or -1 when it printed none (the connection ended). */
    static int installerExit(String output) {
        int at = output.lastIndexOf("ovis-install-exit=");
        if (at < 0) return -1;
        String rest = output.substring(at + "ovis-install-exit=".length()).trim().split("\\s")[0];
        try {
            return Integer.parseInt(rest);
        } catch (NumberFormatException damaged) {
            return -1;
        }
    }

    /**
     * Installs Ovis for this account with the official installer, then starts it (a headless herdr
     * when none runs) and waits for it, up to `startMs`: its port. `progress` hears each line the
     * installer prints. About 10 minutes at most for the run itself.
     */
    static int install(Connection connection, Consumer<String> progress, long startMs, LongSupplier clock) throws SshFailure {
        SshFailure cannot = cannotInstall(run(connection, PROBE, 20_000));
        if (cannot != null) throw cannot;
        StringBuilder tail = new StringBuilder();
        // the status line comes last, past the 512 KiB run keeps of a long install's output: it is kept on its own
        String[] status = { "" };
        String output = run(connection, INSTALLER_RUN, 10 * 60_000, raw -> {
            // the installer colours its lines for a terminal; the phone shows them as text
            String line = raw.replaceAll("\u001B\\[[0-9;?]*[A-Za-z]", "").trim();
            if (line.startsWith("ovis-install-exit=")) status[0] = line;
            if (line.isEmpty() || line.startsWith("ovis-install-exit=")) return;
            tail.append(line).append('\n');
            if (tail.length() > 4000) tail.delete(0, tail.length() - 4000);
            progress.accept(line);
        });
        int exit = installerExit(status[0].isEmpty() ? output : status[0]);
        if (exit != 0) {
            String last = tail.toString().trim();
            int cut = last.lastIndexOf('\n', Math.max(0, last.length() - 600));
            throw new SshFailure("install-failed", "The installer ended with " + (exit < 0 ? "no status" : "status " + exit) + (last.isEmpty() ? "" : ":\n" + last.substring(cut < 0 ? 0 : cut + 1)), INSTALL_COMMAND);
        }
        return ovisPort(connection, startMs, clock);
    }

    /** SshTunnel's Link over a signed-in connection, to the Ovis on `port` there. */
    static SshTunnel.Link link(Connection connection, int port) {
        return new SshTunnel.Link() {
            private volatile int remotePort = port;

            @Override
            public SshTunnel.Channel open() throws IOException {
                LocalStreamForwarder stream;
                try {
                    stream = connection.createLocalStreamForwarder("127.0.0.1", remotePort);
                } catch (IllegalStateException closed) {
                    throw new IOException("The connection ended", closed);
                }
                return new SshTunnel.Channel() {
                    @Override
                    public InputStream input() throws IOException {
                        return stream.getInputStream();
                    }

                    @Override
                    public OutputStream output() throws IOException {
                        return stream.getOutputStream();
                    }

                    @Override
                    public void close() {
                        try {
                            stream.close();
                        } catch (IOException ignored) {
                            // already closed by the other direction
                        }
                    }
                };
            }

            @Override
            public void relocate() throws SshFailure {
                remotePort = ovisPort(connection);
            }

            @Override
            public boolean alive() {
                final boolean[] answered = { false };
                Thread ping = new Thread(() -> {
                    try {
                        connection.ping();
                        answered[0] = true;
                    } catch (IOException | IllegalStateException gone) {
                        // not answered, or closed meanwhile
                    }
                }, "ovis-ssh-ping");
                ping.setDaemon(true);
                ping.start();
                try {
                    ping.join(4_000);
                } catch (InterruptedException stopped) {
                    Thread.currentThread().interrupt();
                }
                return answered[0];
            }

            @Override
            public void close() {
                connection.close();
            }

            @Override
            public void onEnd(Runnable ended) {
                connection.addConnectionMonitor(reason -> ended.run());
            }
        };
    }
}
