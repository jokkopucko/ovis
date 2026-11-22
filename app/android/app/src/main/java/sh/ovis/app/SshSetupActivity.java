package sh.ovis.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.trilead.ssh2.Connection;
import java.security.KeyPair;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Adds a PC over SSH, or sets one up again (EXTRA_ORIGIN: register the phone again, use another key,
 * confirm a host key that was forgotten on purpose). Address and account, then how the phone signs in:
 * its own key, shown to copy or share into authorized_keys; a password used once to add that key there, as
 * Ovis on a PC registers its own key; or, under Advanced, a private key pasted in (OpenSSH or PEM, ed25519,
 * RSA or ECDSA, with a passphrase or not): a private key passing through the clipboard and other apps is
 * the riskiest way, so it is not offered first. The host key's fingerprint is shown and confirmed before anything is sent to the
 * machine. The PC's Ovis is found or started (SshLink), or installed from here when there is none and
 * the person agrees, then checked to answer as Ovis; then the PC opens.
 */
public class SshSetupActivity extends Activity {
    static final String EXTRA_ORIGIN = "origin";

    /** What the screen is doing, for SshSetupFlowTest: "connecting", "confirm-host", "signing-in", "looking", "confirm-install", "installing", "done", "failed:<kind>". */
    interface Steps {
        void step(String what);
    }

    static volatile Steps steps;

    private static final int BACKGROUND = Color.parseColor("#12100e");
    private static final int TEXT = Color.parseColor("#d8d0c3");
    private static final int MUTED = Color.parseColor("#9a9184");
    private static final int ACCENT = Color.parseColor("#f0a830");
    private static final int FIELD = Color.parseColor("#1d1a16");

    private EditText host;
    private EditText port;
    private EditText user;
    private RadioGroup method;
    private View phoneKeyPanel;
    private View passwordPanel;
    private View importPanel;
    private TextView keyLine;
    private EditText password;
    private EditText privateKey;
    private TextView keyState;
    private EditText passphrase;
    private TextView status;
    private ProgressBar spinner;
    private Button connect;
    private final AtomicBoolean busy = new AtomicBoolean();
    /** the PC being set up again, or null for a new one */
    private SshPcs.Pc editing;
    /** the screen was left: its worker asks nothing more, saves nothing, and its SSH connection is closed */
    private volatile boolean left;
    private volatile Connection active;
    private volatile CountDownLatch pending;

    private static void tell(String what) {
        Steps listening = steps;
        if (listening != null) listening.step(what);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // a private key, a passphrase or a password may be on this screen: no screenshots, no Recents thumbnail
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
        getWindow().setStatusBarColor(BACKGROUND);
        getWindow().setNavigationBarColor(BACKGROUND);
        editing = SshPcs.on(this).get(getIntent().getStringExtra(EXTRA_ORIGIN));
        int pad = dp(20);

        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(pad, pad, pad, pad);

        form.addView(heading(editing == null ? getString(R.string.ssh_add_title) : getString(R.string.ssh_edit_title, editing.label())));
        form.addView(note(getString(R.string.ssh_add_note)));
        host = field(form, R.id.ssh_host, R.string.ssh_host_label, "my-server.example.com", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        port = field(form, R.id.ssh_port, R.string.ssh_port_label, "22", InputType.TYPE_CLASS_NUMBER);
        port.setText("22");
        user = field(form, R.id.ssh_user, R.string.ssh_user_label, "me", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        if (editing != null) {
            host.setText(editing.host);
            port.setText(String.valueOf(editing.port));
            user.setText(editing.user);
            // the PC keeps its address on this phone (its origin, and the page's drafts and storage there)
            for (EditText fixed : new EditText[] { host, port, user }) fixed.setEnabled(false);
        }

        form.addView(label(getString(R.string.ssh_method_label)));
        method = new RadioGroup(this);
        method.addView(radio(R.id.ssh_method_phone, R.string.ssh_method_phone));
        method.addView(radio(R.id.ssh_method_password, R.string.ssh_method_password));
        RadioButton pasteWay = radio(R.id.ssh_method_paste, R.string.ssh_method_paste);
        method.addView(pasteWay);
        form.addView(method);
        Button advanced = button(getString(R.string.ssh_advanced), false);
        advanced.setId(R.id.ssh_advanced);
        advanced.setOnClickListener(v -> {
            pasteWay.setVisibility(View.VISIBLE);
            advanced.setVisibility(View.GONE);
        });
        form.addView(advanced);
        boolean imported = editing != null && "imported".equals(editing.auth);
        pasteWay.setVisibility(imported ? View.VISIBLE : View.GONE);
        advanced.setVisibility(imported ? View.GONE : View.VISIBLE);

        LinearLayout keyPanel = panel();
        keyPanel.addView(note(getString(R.string.ssh_phone_key_note)));
        keyLine = new TextView(this);
        keyLine.setId(R.id.ssh_key_line);
        keyLine.setTypeface(Typeface.MONOSPACE);
        keyLine.setTextColor(TEXT);
        keyLine.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        keyLine.setTextIsSelectable(true);
        keyLine.setBackgroundColor(FIELD);
        keyLine.setPadding(pad / 2, pad / 2, pad / 2, pad / 2);
        keyPanel.addView(keyLine);
        Button copy = button(getString(R.string.ssh_copy), false);
        copy.setOnClickListener(v -> copy(keyLine.getText().toString()));
        Button share = button(getString(R.string.ssh_share), false);
        share.setOnClickListener(v -> share(this, keyLine.getText().toString()));
        LinearLayout keyButtons = new LinearLayout(this);
        keyButtons.addView(copy);
        keyButtons.addView(share);
        keyPanel.addView(keyButtons);
        phoneKeyPanel = keyPanel;
        form.addView(keyPanel);
        showPhoneKey(false);

        LinearLayout passPanel = panel();
        password = field(passPanel, R.id.ssh_password, R.string.ssh_password_label, "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        passwordPanel = passPanel;
        form.addView(passPanel);

        LinearLayout pastePanel = panel();
        privateKey = field(pastePanel, R.id.ssh_private_key, R.string.ssh_key_label, "-----BEGIN OPENSSH PRIVATE KEY-----", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        privateKey.setMinLines(4);
        privateKey.setMaxLines(8);
        privateKey.setTypeface(Typeface.MONOSPACE);
        privateKey.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        Button paste = button(getString(R.string.ssh_paste), false);
        paste.setOnClickListener(v -> pasteKey());
        pastePanel.addView(paste);
        keyState = note("");
        keyState.setId(R.id.ssh_key_state);
        pastePanel.addView(keyState);
        privateKey.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable s) { describeKey(s.toString()); }
        });
        passphrase = field(pastePanel, R.id.ssh_passphrase, R.string.ssh_passphrase_label, "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        // a secret is never kept in the screen's saved state, which is not sealed (only SshVault seals)
        for (EditText secretField : new EditText[] { password, privateKey, passphrase }) secretField.setSaveEnabled(false);
        pastePanel.addView(note(getString(R.string.ssh_key_sealed_note)));
        importPanel = pastePanel;
        form.addView(pastePanel);

        method.setOnCheckedChangeListener((group, checked) -> showPanel(checked));
        method.check(imported ? R.id.ssh_method_paste : R.id.ssh_method_phone);

        LinearLayout statusRow = new LinearLayout(this);
        statusRow.setGravity(Gravity.CENTER_VERTICAL);
        spinner = new ProgressBar(this);
        spinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        spinner.setVisibility(View.GONE);
        status = new TextView(this);
        status.setId(R.id.ssh_status);
        status.setTextColor(TEXT);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        status.setTextIsSelectable(true);
        status.setPadding(pad / 2, pad / 2, 0, pad / 2);
        statusRow.addView(spinner, new LinearLayout.LayoutParams(dp(28), dp(28)));
        statusRow.addView(status, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        form.addView(statusRow);

        LinearLayout buttons = new LinearLayout(this);
        connect = button(getString(R.string.ssh_connect), true);
        connect.setId(R.id.ssh_connect);
        Button cancel = button(getString(R.string.ssh_cancel), false);
        buttons.addView(connect);
        buttons.addView(cancel);
        form.addView(buttons);
        connect.setOnClickListener(v -> start());
        cancel.setOnClickListener(v -> finish());

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BACKGROUND);
        scroll.setFillViewport(true);
        scroll.addView(form);
        ViewCompat.setOnApplyWindowInsetsListener(scroll, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        setContentView(scroll);
    }

    @Override
    protected void onDestroy() {
        left = true;
        CountDownLatch waiting = pending;
        if (waiting != null) waiting.countDown();
        Connection open = active;
        // closing it ends an install the person agreed to only while they stay (ssh_install_message)
        if (open != null) new Thread(open::close, "ovis-ssh-leave").start();
        super.onDestroy();
    }

    /** Shows this phone's key line; `renew` makes a new key first (the old one could no longer be read). */
    private void showPhoneKey(boolean renew) {
        new Thread(() -> {
            String line;
            try {
                SshPcs store = SshPcs.on(this);
                if (renew) store.renewPhoneKey();
                line = store.phoneKeyLine(Build.MODEL);
            } catch (SshFailure failed) {
                line = getString(R.string.ssh_phone_key_failed, failed.getMessage());
            }
            String shown = line;
            runOnUiThread(() -> keyLine.setText(shown));
        }, "ovis-ssh-key").start();
    }

    private void copy(String text) {
        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
        if (clipboard == null) return;
        clipboard.setPrimaryClip(ClipData.newPlainText("ssh key", text));
        // Android 13 and later show their own confirmation
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(this, R.string.ssh_copied, Toast.LENGTH_SHORT).show();
    }

    /** Hands this phone's public key line to another app (mail, a messenger, a note that syncs to the PC) through the share sheet. */
    static void share(android.content.Context context, String line) {
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, line);
        Intent chooser = Intent.createChooser(send, context.getString(R.string.ssh_share_title));
        if (!(context instanceof Activity)) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(chooser);
    }

    private void pasteKey() {
        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
        ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) return;
        CharSequence text = clip.getItemAt(0).coerceToText(this);
        if (text == null) return;
        privateKey.setText(text);
        // a private key does not stay on the clipboard for the next app to read
        if (SshKeys.precheck(text.toString()) == null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) clipboard.clearPrimaryClip();
    }

    /** What the pasted text is, at once and without its passphrase (the slow part waits for Connect). */
    private void describeKey(String text) {
        if (text.trim().isEmpty()) {
            keyState.setText("");
            return;
        }
        SshFailure wrong = SshKeys.precheck(text);
        if (wrong != null) keyState.setText(SshWords.describe(this, "", wrong, "imported", null));
        else keyState.setText(SshKeys.encrypted(text) ? R.string.ssh_key_encrypted : R.string.ssh_key_plain);
    }

    private void showPanel(int checked) {
        phoneKeyPanel.setVisibility(checked == R.id.ssh_method_phone ? View.VISIBLE : View.GONE);
        passwordPanel.setVisibility(checked == R.id.ssh_method_password ? View.VISIBLE : View.GONE);
        importPanel.setVisibility(checked == R.id.ssh_method_paste ? View.VISIBLE : View.GONE);
    }

    private TextView heading(String words) {
        TextView view = new TextView(this);
        view.setText(words);
        view.setTextColor(Color.parseColor("#f2ebdf"));
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private TextView note(String words) {
        TextView view = new TextView(this);
        view.setText(words);
        view.setTextColor(MUTED);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        view.setPadding(0, dp(6), 0, dp(6));
        return view;
    }

    private TextView label(String words) {
        TextView view = new TextView(this);
        view.setText(words);
        view.setTextColor(TEXT);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        view.setPadding(0, dp(12), 0, dp(4));
        return view;
    }

    private EditText field(LinearLayout parent, int id, int labelText, String hint, int type) {
        TextView label = label(getString(labelText));
        label.setLabelFor(id);
        parent.addView(label);
        EditText input = new EditText(this);
        input.setId(id);
        input.setInputType(type);
        input.setHint(hint);
        input.setHintTextColor(Color.parseColor("#5d564d"));
        input.setTextColor(Color.parseColor("#f2ebdf"));
        input.setBackgroundColor(FIELD);
        input.setPadding(dp(12), dp(10), dp(12), dp(10));
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        parent.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return input;
    }

    private RadioButton radio(int id, int words) {
        RadioButton button = new RadioButton(this);
        button.setId(id);
        button.setText(words);
        button.setTextColor(TEXT);
        button.setButtonTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        return button;
    }

    private LinearLayout panel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(0, dp(4), 0, dp(4));
        return panel;
    }

    private Button button(String words, boolean primary) {
        Button button = new Button(this);
        button.setText(words);
        button.setAllCaps(false);
        button.setTextColor(primary ? Color.parseColor("#12100e") : Color.parseColor("#f2ebdf"));
        button.setBackgroundColor(primary ? ACCENT : Color.parseColor("#181613"));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, dp(8), dp(12), 0);
        button.setLayoutParams(params);
        return button;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void say(String words, boolean working) {
        runOnUiThread(() -> {
            status.setText(words);
            spinner.setVisibility(working ? View.VISIBLE : View.GONE);
            connect.setEnabled(!working);
        });
    }

    private void start() {
        String address = host.getText().toString().trim();
        String account = user.getText().toString().trim();
        int sshPort;
        try {
            sshPort = Integer.parseInt(port.getText().toString().trim());
        } catch (NumberFormatException notNumber) {
            sshPort = -1;
        }
        if (address.isEmpty() || account.isEmpty() || sshPort < 1 || sshPort > 65535 || address.contains(" ") || account.contains(" ")) {
            say(getString(R.string.ssh_fill_in), false);
            return;
        }
        if (!busy.compareAndSet(false, true)) return;
        int checked = method.getCheckedRadioButtonId();
        String how = checked == R.id.ssh_method_password ? "password" : checked == R.id.ssh_method_paste ? "imported" : "phone-key";
        String secret = how.equals("password") ? password.getText().toString() : how.equals("imported") ? privateKey.getText().toString().trim() : null;
        String secretPassphrase = passphrase.getText().toString();
        // the password is used once: it leaves the screen as soon as it is read, whatever happens next
        password.setText("");
        int finalPort = sshPort;
        new Thread(() -> {
            try {
                add(address, finalPort, account, how, secret, secretPassphrase);
            } finally {
                busy.set(false);
            }
        }, "ovis-ssh-add").start();
    }

    private void fail(String where, SshFailure failed, String how, String publicLine) {
        say(SshWords.describe(this, where, failed, how, publicLine), false);
        tell("failed:" + failed.kind);
    }

    private void add(String address, int sshPort, String account, String how, String secret, String secretPassphrase) {
        String where = account + "@" + address + (sshPort == 22 ? "" : ":" + sshPort);
        SshPcs store = SshPcs.on(this);
        // a pasted key is read before anything goes to the machine: a wrong passphrase is told at once
        SshKeys.Read pasted = null;
        String publicLine = null;
        if (how.equals("imported")) {
            say(getString(R.string.ssh_reading_key), true);
            try {
                pasted = SshKeys.read(secret, secretPassphrase);
                publicLine = pasted.publicLine("");
            } catch (SshFailure unreadable) {
                fail(where, unreadable, how, null);
                return;
            }
        }

        say(getString(R.string.ssh_connecting, address), true);
        tell("connecting");
        SshPcs.Pc before = editing != null ? store.get(editing.origin) : store.find(address, sshPort, account);
        // a PC with a pinned key is asked for that very kind of key, as its tunnel asks (SshLink.connect): one that
        // also offers a kind it prefers has not changed its key
        boolean pinned = before != null && before.hasHostKey();
        SshLink.HostKeyCheck first = new SshLink.HostKeyCheck(pinned ? before.hostKeyAlgorithm : null, null);
        try {
            SshLink.connect(address, sshPort, first).close();
            say(getString(R.string.ssh_no_host_key), false);
            tell("failed:no-host-key");
            return;
        } catch (SshFailure failed) {
            if (pinned && failed.kind.equals("host-key-changed")) {
                // the PC no longer offers the kind of key confirmed for it: the same stop as a different key
                say(getString(R.string.ssh_fail_host_key_pinned, failed.getMessage()), false);
                tell("failed:host-key-changed");
                return;
            }
            if (!failed.kind.equals("host-key-unknown")) {
                fail(where, failed, how, publicLine);
                return;
            }
        }
        String algorithm = first.seenAlgorithm;
        String hostKey = SshHostKeys.encode(first.seenKey);
        boolean known = before != null && SshHostKeys.judge(before.hostKeyAlgorithm, before.hostKey, algorithm, first.seenKey) == SshHostKeys.Verdict.SAME;
        // a pinned key that differs stops here, before anything is sent: only Forget host key under Manage lets a new one in
        if (pinned && !known) {
            say(getString(R.string.ssh_fail_host_key_pinned, SshHostKeys.fingerprint(first.seenKey)), false);
            tell("failed:host-key-changed");
            return;
        }
        // a key confirmed before and shown again is not asked about twice; any other is
        if (!known && !confirm(getString(R.string.ssh_confirm_title, address), getString(R.string.ssh_confirm_message, algorithm, SshHostKeys.fingerprint(first.seenKey)), getString(R.string.ssh_trust), "confirm-host")) {
            say(getString(R.string.ssh_not_confirmed), false);
            tell("failed:not-confirmed");
            return;
        }

        Connection connection = null;
        try {
            say(getString(R.string.ssh_signing_in, account), true);
            tell("signing-in");
            connection = SshLink.connect(address, sshPort, new SshLink.HostKeyCheck(algorithm, hostKey));
            active = connection;
            if (left) throw new SshFailure("internal", "The screen was closed");
            String saveAs = how;
            if (how.equals("phone-key")) {
                SshLink.signIn(connection, account, phoneKey(store));
            } else if (how.equals("imported")) {
                SshLink.signIn(connection, account, pasted.pair);
            } else {
                SshLink.signInWithPassword(connection, account, secret);
                say(getString(R.string.ssh_adding_key, where), true);
                KeyPair mine = phoneKey(store);
                SshLink.authorizeKey(connection, SshKeys.publicLine(mine.getPublic(), SshPcs.phoneComment(Build.MODEL)));
                connection.close();
                // the key, not the password, is what reconnects: prove it works before the password is gone
                connection = SshLink.connect(address, sshPort, new SshLink.HostKeyCheck(algorithm, hostKey));
                active = connection;
                if (left) throw new SshFailure("internal", "The screen was closed");
                SshLink.signIn(connection, account, mine);
                saveAs = "phone-key";
            }
            say(getString(R.string.ssh_looking, address), true);
            tell("looking");
            int ovisPort = findOrInstall(connection, address, where);
            if (!SshLink.answersAsOvis(connection, ovisPort)) throw new SshFailure("not-ovis", "Not Ovis");

            if (left) return;
            SshPcs.Pc pc = before != null ? before : new SshPcs.Pc();
            if (before == null) pc.origin = store.freeOrigin();
            pc.host = address;
            pc.port = sshPort;
            pc.user = account;
            pc.hostKeyAlgorithm = algorithm;
            pc.hostKey = hostKey;
            if (saveAs.equals("imported")) {
                store.sealImported(pc, secret, secretPassphrase, pasted.type.equals("ed25519") ? "ed25519" : pasted.type + " " + pasted.bits);
            } else {
                pc.auth = "phone-key";
                pc.importedKey = "";
                pc.importedPassphrase = "";
                pc.keyType = "";
            }
            store.put(pc);
            // the PC's tunnel starts again with what was saved here, and its new gate, when the app reopens (OvisSshPlugin.listen)
            SshTunnels.closeFor(pc.origin);
            if (before == null) PCStore.setName(this, pc.origin, where + " (SSH)");
            PCStore.open(this, pc.origin, pc.origin + "/");
            PCStore.fail(null, null);
            say(getString(R.string.ssh_connected), true);
            tell("done");
            runOnUiThread(() -> {
                setResult(RESULT_OK);
                finish();
            });
        } catch (SshFailure failed) {
            fail(where, failed, how, publicLine);
        } catch (RuntimeException unexpected) {
            fail(where, new SshFailure("internal", SshFailure.rootMessage(unexpected)), how, publicLine);
        } finally {
            if (connection != null) connection.close();
        }
    }

    /** This phone's key; one it can no longer read is replaced, and the new line shown, as this screen registers it anyway. */
    private KeyPair phoneKey(SshPcs store) throws SshFailure {
        try {
            return store.phoneKey();
        } catch (SshFailure lost) {
            if (!lost.kind.equals("key-lost")) throw lost;
            showPhoneKey(true);
            throw lost;
        }
    }

    /** The port of the PC's Ovis; where none is installed, the official installer runs there once the person agrees. */
    private int findOrInstall(Connection connection, String address, String where) throws SshFailure {
        try {
            return SshLink.ovisPort(connection);
        } catch (SshFailure none) {
            if (!none.kind.equals("no-ovis") && !none.kind.equals("bridge-only")) throw none;
            if (!confirm(getString(R.string.ssh_install_title, where), getString(R.string.ssh_install_message, SshLink.INSTALL_COMMAND), getString(R.string.ssh_install_yes), "confirm-install")) throw none;
            tell("installing");
            say(getString(R.string.ssh_installing, address, ""), true);
            return SshLink.install(connection, line -> say(getString(R.string.ssh_installing, address, line.length() > 160 ? line.substring(0, 160) + "…" : line), true), 120_000, android.os.SystemClock::elapsedRealtime);
        }
    }

    /** Asks on the main thread, and waits for the answer: true for `yes`. */
    private boolean confirm(String title, String message, String yes, String step) {
        if (left) return false;
        CountDownLatch answered = new CountDownLatch(1);
        pending = answered;
        AtomicBoolean agreed = new AtomicBoolean();
        runOnUiThread(() -> {
            if (left) {
                answered.countDown();
                return;
            }
            new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message)
                .setCancelable(false)
                .setPositiveButton(yes, (d, w) -> {
                    agreed.set(true);
                    answered.countDown();
                })
                .setNegativeButton(step.equals("confirm-install") ? getString(R.string.ssh_install_no) : getString(R.string.ssh_cancel), (d, w) -> answered.countDown())
                .show();
            tell(step);
        });
        try {
            answered.await();
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
            return false;
        } finally {
            pending = null;
        }
        return agreed.get() && !left;
    }
}
