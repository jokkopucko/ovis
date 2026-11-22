package sh.ovis.app;

import android.content.Context;

/**
 * An SshFailure in the person's words (res/values/ssh_strings.xml and values-ko), each saying what to
 * do about it, with the command to run on the machine where one fixes it. The app's error page says
 * the same for a PC that is open (app/web/error.html, by the failure's kind).
 */
final class SshWords {
    private SshWords() {}

    /** `where` is user@host[:port]; `how` the sign-in that was tried ("phone-key", "password", "imported"); `publicLine` the pasted key's line, or null. */
    static String describe(Context context, String where, SshFailure failure, String how, String publicLine) {
        String detail = failure.getMessage() == null ? failure.kind : failure.getMessage();
        String command = failure.command == null ? SshLink.INSTALL_COMMAND : failure.command;
        switch (failure.kind) {
            case "auth":
                if ("password".equals(how)) return context.getString(R.string.ssh_fail_auth_password, where);
                if ("imported".equals(how)) return context.getString(R.string.ssh_fail_auth_pasted, where, publicLine == null ? "" : publicLine);
                return context.getString(R.string.ssh_fail_auth_phone, where);
            case "key-missing":
                return context.getString(R.string.ssh_fail_key_missing);
            case "key-public":
                return context.getString(R.string.ssh_fail_key_public);
            case "key-format":
                return context.getString(R.string.ssh_fail_key_format, command);
            case "key-not-a-key":
                return context.getString(R.string.ssh_fail_key_not_a_key, detail);
            case "key-needs-passphrase":
                return context.getString(R.string.ssh_fail_key_needs_passphrase);
            case "key-wrong-passphrase":
                return context.getString(R.string.ssh_fail_key_wrong_passphrase);
            case "key-unsupported":
                return context.getString(R.string.ssh_fail_key_unsupported, detail);
            case "key-lost":
                return context.getString(R.string.ssh_fail_key_lost);
            case "key-unreadable":
                return context.getString(R.string.ssh_fail_key_unreadable);
            case "host-key-changed":
                return context.getString(R.string.ssh_fail_host_key_changed);
            case "unreachable":
                return context.getString(R.string.ssh_fail_unreachable, where, detail);
            case "timeout":
                return context.getString(R.string.ssh_fail_timeout, where);
            case "unsupported":
                return context.getString(R.string.ssh_fail_unsupported);
            case "no-ovis":
                return context.getString(R.string.ssh_fail_no_ovis, where, command);
            case "bridge-only":
                return context.getString(R.string.ssh_fail_bridge_only, where, command);
            case "not-started":
                return context.getString(R.string.ssh_fail_not_started, where, command);
            case "not-ovis":
                return context.getString(R.string.ssh_fail_not_ovis);
            case "install-unsupported":
                return context.getString(R.string.ssh_fail_install_unsupported, detail);
            case "install-missing-tool":
                return context.getString(R.string.ssh_fail_install_missing_tool, detail, command);
            case "install-permission":
                return context.getString(R.string.ssh_fail_install_permission);
            case "install-disk":
                return context.getString(R.string.ssh_fail_install_disk, detail);
            case "install-failed":
                return context.getString(R.string.ssh_fail_install_failed, detail, command);
            default:
                return context.getString(R.string.ssh_fail_other, detail);
        }
    }
}
