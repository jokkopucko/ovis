package sh.ovis.app;

/**
 * Why something over SSH did not work, as a kind the app's pages and messages read (error.html,
 * SshSetupActivity, the connect screen) and a detail for the person: the machine's own words, or a
 * command to run there (`command`, shown to copy). Kinds:
 *
 * <ul>
 *   <li>stops, which a reconnect never tries again until the PC is set up again: `host-key-changed`,
 *       `host-key-unknown` (forgotten on purpose), `auth` (the key refused), `key-unreadable` (a saved
 *       key this phone cannot open any more), `key-lost` (this phone's own key);</li>
 *   <li>a pasted key that cannot be used: `key-missing`, `key-public`, `key-format`, `key-not-a-key`,
 *       `key-needs-passphrase`, `key-wrong-passphrase`, `key-unsupported`;</li>
 *   <li>the machine: `unreachable`, `timeout`, `unsupported` (not Linux or macOS), `no-ovis`,
 *       `bridge-only`, `not-started`, `not-ovis`;</li>
 *   <li>a first install from the phone: `install-unsupported`, `install-missing-tool`,
 *       `install-permission`, `install-disk`, `install-failed`;</li>
 *   <li>`cancelled`, `internal`.</li>
 * </ul>
 */
final class SshFailure extends Exception {
    final String kind;
    /** A command to run on the machine that would fix it, or null. */
    final String command;

    SshFailure(String kind, String message) {
        this(kind, message, null);
    }

    SshFailure(String kind, String message, String command) {
        super(message);
        this.kind = kind;
        this.command = command;
    }

    /** Whether reconnecting stops on it until the PC is set up again (SshTunnel). */
    boolean stops() {
        switch (kind) {
            case "host-key-changed":
            case "host-key-unknown":
            case "auth":
            case "key-unreadable":
            case "key-lost":
                return true;
            default:
                return false;
        }
    }

    /** The innermost cause's message, or its class's name. */
    static String rootMessage(Throwable failed) {
        Throwable cause = failed;
        while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
        String message = cause.getMessage();
        return message == null ? cause.getClass().getSimpleName() : message;
    }
}
