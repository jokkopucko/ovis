package sh.ovis.app;

import com.trilead.ssh2.crypto.keys.Ed25519KeyPairGenerator;
import com.trilead.ssh2.crypto.keys.Ed25519PrivateKey;
import com.trilead.ssh2.crypto.keys.Ed25519PublicKey;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The PCs added over SSH and this phone's own SSH key: the key store. Each PC is saved in PCStore under
 * its own loopback origin on this phone (`http://127.0.0.<n>:47317`, where SshTunnel listens); this
 * store keeps how to reach it: address, account, the host key confirmed when it was added, and how
 * the app signs in (the gate cookie is the tunnel's, new each time it listens: SshTunnels). A distinct 127.0.0.n per PC keeps each PC's cookies and storage
 * apart, as cookies do not separate ports.
 *
 * <p>Secrets never rest in the clear: this phone's ed25519 seed, a pasted private key and its
 * passphrase are sealed (`Sealer`, on the phone SshVault: AES-GCM under a key in the Android
 * Keystore that never leaves it). A password is never stored. Plain Java over two small seams
 * (`Prefs`, `Sealer`), so SshPcsTest runs it on the JVM; `on(Context)` is the phone's.
 */
final class SshPcs {
    static final int LOCAL_PORT = 47317;

    /** Text values by name, written together. The phone's is SharedPreferences "ovis-ssh". */
    interface Prefs {
        String get(String name);

        /** Writes every entry at once, a null value removing its name; false when the write did not land. */
        boolean put(Map<String, String> values);
    }

    /** Seals and opens secrets; the phone's is SshVault. */
    interface Sealer {
        String seal(byte[] plain) throws GeneralSecurityException;

        byte[] open(String sealed) throws GeneralSecurityException;
    }

    /** One lock for every store over the same preferences: the plugin, the setup screen and the tunnels' threads share them. */
    private static final Object LOCK = new Object();

    private final Prefs prefs;
    private final Sealer sealer;

    SshPcs(Prefs prefs, Sealer sealer) {
        this.prefs = prefs;
        this.sealer = sealer;
    }

    /** The phone's store: SharedPreferences "ovis-ssh", sealed by SshVault. */
    static SshPcs on(android.content.Context context) {
        android.content.SharedPreferences shared = context.getApplicationContext().getSharedPreferences("ovis-ssh", android.content.Context.MODE_PRIVATE);
        return new SshPcs(
            new Prefs() {
                @Override
                public String get(String name) {
                    return shared.getString(name, null);
                }

                @Override
                public boolean put(Map<String, String> values) {
                    android.content.SharedPreferences.Editor edit = shared.edit();
                    for (Map.Entry<String, String> entry : values.entrySet()) {
                        if (entry.getValue() == null) edit.remove(entry.getKey());
                        else edit.putString(entry.getKey(), entry.getValue());
                    }
                    return edit.commit();
                }
            },
            SshVault.SEALER
        );
    }

    static final class Pc {
        String origin;
        String host;
        int port;
        String user;
        String hostKeyAlgorithm = "";
        String hostKey = "";
        /** "phone-key" or "imported" */
        String auth = "phone-key";
        /** sealed, "" unless auth is "imported" */
        String importedKey = "";
        /** sealed, "" when the key has none */
        String importedPassphrase = "";
        /** what the imported key is, for the screens: "ed25519", "rsa 3072", "ecdsa 256"; "" for the phone's key */
        String keyType = "";

        String loopbackHost() {
            return java.net.URI.create(origin).getHost();
        }

        String label() {
            return user + "@" + host + (port == 22 ? "" : ":" + port);
        }

        boolean hasHostKey() {
            return hostKey != null && !hostKey.isEmpty();
        }

        JSONObject json() throws JSONException {
            return new JSONObject()
                .put("origin", origin)
                .put("host", host)
                .put("port", port)
                .put("user", user)
                .put("hostKeyAlgorithm", hostKeyAlgorithm)
                .put("hostKey", hostKey)
                .put("auth", auth)
                .put("importedKey", importedKey)
                .put("importedPassphrase", importedPassphrase)
                .put("keyType", keyType);
        }

        static Pc of(JSONObject json) {
            Pc pc = new Pc();
            pc.origin = json.optString("origin");
            pc.host = json.optString("host");
            pc.port = json.optInt("port", 22);
            pc.user = json.optString("user");
            pc.hostKeyAlgorithm = json.optString("hostKeyAlgorithm");
            pc.hostKey = json.optString("hostKey");
            pc.auth = json.optString("auth", "phone-key");
            pc.importedKey = json.optString("importedKey", "");
            pc.importedPassphrase = json.optString("importedPassphrase", "");
            pc.keyType = json.optString("keyType", "");
            return pc;
        }
    }

    private JSONObject all() {
        String saved = prefs.get("pcs");
        try {
            return new JSONObject(saved == null ? "{}" : saved);
        } catch (JSONException damaged) {
            return new JSONObject();
        }
    }

    private void write(JSONObject pcs) {
        Map<String, String> values = new HashMap<>();
        values.put("pcs", pcs.toString());
        if (!prefs.put(values)) throw new IllegalStateException("This phone could not save its SSH PCs");
    }

    Pc get(String origin) {
        if (origin == null) return null;
        synchronized (LOCK) {
            JSONObject json = all().optJSONObject(origin);
            return json == null ? null : Pc.of(json);
        }
    }

    void put(Pc pc) {
        synchronized (LOCK) {
            JSONObject pcs = all();
            try {
                pcs.put(pc.origin, pc.json());
            } catch (JSONException impossible) {
                throw new IllegalStateException(impossible);
            }
            write(pcs);
        }
    }

    /** Forgets the PC, its sealed key and passphrase with it. */
    void remove(String origin) {
        synchronized (LOCK) {
            JSONObject pcs = all();
            pcs.remove(origin);
            write(pcs);
        }
    }

    /**
     * Forgets the PC's host key on purpose (Manage on the connect screen): nothing connects to it
     * until the setup screen shows the key it has now and the person confirms it.
     */
    void forgetHostKey(String origin) {
        synchronized (LOCK) {
            Pc pc = get(origin);
            if (pc == null) return;
            pc.hostKeyAlgorithm = "";
            pc.hostKey = "";
            put(pc);
        }
    }

    Pc find(String host, int port, String user) {
        for (Pc pc : list()) {
            if (pc.host.equalsIgnoreCase(host) && pc.port == port && pc.user.equals(user)) return pc;
        }
        return null;
    }

    List<Pc> list() {
        List<Pc> list = new ArrayList<>();
        synchronized (LOCK) {
            JSONObject pcs = all();
            for (Iterator<String> keys = pcs.keys(); keys.hasNext(); ) {
                JSONObject json = pcs.optJSONObject(keys.next());
                if (json != null) list.add(Pc.of(json));
            }
        }
        return list;
    }

    /**
     * A loopback origin for a new PC: 127.0.0.2 upward (127.0.0.1 stays for whatever else runs on the
     * phone), after the last one handed out, so a PC added after another was removed never gets that
     * one's address (its storage, drafts and service worker); only once all 253 were handed out does it
     * come back round to the lowest free one.
     */
    String freeOrigin() {
        synchronized (LOCK) {
            JSONObject pcs = all();
            int last;
            try {
                last = Integer.parseInt(String.valueOf(prefs.get("lastLoopback")));
            } catch (NumberFormatException none) {
                last = 1;
            }
            for (int step = 1; step <= 253; step++) {
                int n = 2 + (last - 2 + step + 253) % 253;
                String origin = "http://127.0.0." + n + ":" + LOCAL_PORT;
                if (pcs.has(origin)) continue;
                Map<String, String> values = new HashMap<>();
                values.put("lastLoopback", String.valueOf(n));
                if (!prefs.put(values)) throw new IllegalStateException("This phone could not save its SSH PCs");
                return origin;
            }
        }
        throw new IllegalStateException("No loopback address is left for another SSH PC");
    }

    /**
     * Whether `url` is on an SSH PC's loopback host (127.0.0.2 to 127.0.0.254) at a port other than its tunnel's:
     * cookies are not kept apart by port, so a request there would carry that PC's gate to whatever else listens
     * on it. The app neither opens nor loads such an address.
     */
    static boolean otherLoopbackPort(String url) {
        int colon = url.indexOf("://");
        if (colon <= 0) return false;
        String scheme = url.substring(0, colon).toLowerCase(Locale.ROOT);
        String rest = url.substring(colon + 3);
        int end = rest.length();
        for (char stop : new char[] { '/', '?', '#', '\\' }) {
            int at = rest.indexOf(stop);
            if (at >= 0 && at < end) end = at;
        }
        String authority = rest.substring(0, end);
        authority = authority.substring(authority.lastIndexOf('@') + 1);
        String hostPart = authority;
        int port = "https".equals(scheme) ? 443 : 80;
        int portAt = authority.lastIndexOf(':');
        if (portAt >= 0 && !authority.startsWith("[")) {
            hostPart = authority.substring(0, portAt);
            String digits = authority.substring(portAt + 1);
            if (!digits.isEmpty()) {
                try {
                    port = Integer.parseInt(digits);
                } catch (NumberFormatException unreadable) {
                    return false;
                }
            }
        }
        long address = ipv4(hostPart);
        // 127.0.0.2 to 127.0.0.254, as the WebView reads the host (any spelling of it)
        if (address < 0x7f000002L || address > 0x7f0000feL) return false;
        return port != LOCAL_PORT || !"http".equals(scheme);
    }

    /**
     * The IPv4 address a host names as a browser reads it (the WHATWG URL rules: percent-escapes, a trailing
     * dot, one to four parts in decimal, octal or hex), or -1 for a host that is not one.
     */
    static long ipv4(String host) {
        String text;
        try {
            text = java.net.URLDecoder.decode(host.replace("+", "%2B"), "UTF-8").toLowerCase(Locale.ROOT);
        } catch (java.io.UnsupportedEncodingException | IllegalArgumentException unreadable) {
            return -1;
        }
        if (text.endsWith(".")) text = text.substring(0, text.length() - 1);
        String[] parts = text.split("\\.", -1);
        if (parts.length == 0 || parts.length > 4) return -1;
        long[] numbers = new long[parts.length];
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            int radix = 10;
            if (part.startsWith("0x")) {
                radix = 16;
                part = part.substring(2);
            } else if (part.length() > 1 && part.startsWith("0")) {
                radix = 8;
                part = part.substring(1);
            }
            if (part.isEmpty()) {
                if (radix != 16) return -1;
                numbers[i] = 0;
                continue;
            }
            try {
                numbers[i] = Long.parseLong(part, radix);
            } catch (NumberFormatException notANumber) {
                return -1;
            }
            if (numbers[i] < 0) return -1;
        }
        long address = 0;
        for (int i = 0; i < parts.length - 1; i++) {
            if (numbers[i] > 255) return -1;
            address = address * 256 + numbers[i];
        }
        long last = numbers[parts.length - 1];
        int left = 5 - parts.length;
        if (last >= (1L << (8 * left))) return -1;
        return (address << (8 * left)) + last;
    }

    static String newGate() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format(Locale.ROOT, "%02x", b));
        return hex.toString();
    }

    /** Seals a pasted key and its passphrase into `pc` (auth "imported"). */
    void sealImported(Pc pc, String pem, String passphrase, String keyType) throws SshFailure {
        try {
            pc.importedKey = sealer.seal(pem.getBytes(StandardCharsets.UTF_8));
            pc.importedPassphrase = passphrase == null || passphrase.isEmpty() ? "" : sealer.seal(passphrase.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException failed) {
            throw new SshFailure("internal", "This phone could not seal the key: " + SshFailure.rootMessage(failed));
        }
        pc.auth = "imported";
        pc.keyType = keyType;
    }

    /** The pasted key saved for `pc`, opened: `key-unreadable` when this phone can no longer open it. */
    KeyPair importedKey(Pc pc) throws SshFailure {
        String pem;
        String passphrase;
        try {
            pem = new String(sealer.open(pc.importedKey), StandardCharsets.UTF_8);
            passphrase = pc.importedPassphrase.isEmpty() ? null : new String(sealer.open(pc.importedPassphrase), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException lost) {
            throw new SshFailure("key-unreadable", SshFailure.rootMessage(lost));
        }
        return SshKeys.read(pem, passphrase).pair;
    }

    /**
     * This phone's own ed25519 key, made on first use. Its seed is sealed; only the public key ever
     * leaves the app (shown to paste into authorized_keys, or added there after a password sign-in).
     * A seed this phone can no longer open fails with `key-lost` (renewPhoneKey makes another).
     */
    KeyPair phoneKey() throws SshFailure {
        synchronized (LOCK) {
            String sealed = prefs.get("phoneKeySeed");
            String pub = prefs.get("phoneKeyPublic");
            if (sealed == null && pub == null) return renewPhoneKey();
            // half a key is a key lost, never a reason to make another one quietly
            if (sealed == null || pub == null) throw new SshFailure("key-lost", "Half of this phone's key is missing");
            try {
                return new KeyPair(new Ed25519PublicKey(Base64.getDecoder().decode(pub)), new Ed25519PrivateKey(sealer.open(sealed)));
            } catch (GeneralSecurityException | IllegalArgumentException lost) {
                throw new SshFailure("key-lost", SshFailure.rootMessage(lost));
            }
        }
    }

    /** Replaces this phone's key with a new one: every PC that knew the old one has to be registered again. */
    KeyPair renewPhoneKey() throws SshFailure {
        synchronized (LOCK) {
            KeyPair made = new Ed25519KeyPairGenerator().generateKeyPair();
            byte[] seed = ((Ed25519PrivateKey) made.getPrivate()).getSeed();
            byte[] raw = ((Ed25519PublicKey) made.getPublic()).getAbyte();
            Map<String, String> values = new HashMap<>();
            // the seed is the key's own array (getSeed): it stays as it is, or the key made here signs nothing
            try {
                values.put("phoneKeySeed", sealer.seal(seed));
            } catch (GeneralSecurityException failed) {
                throw new SshFailure("internal", "This phone could not seal its key: " + SshFailure.rootMessage(failed));
            }
            values.put("phoneKeyPublic", Base64.getEncoder().encodeToString(raw));
            if (!prefs.put(values)) throw new SshFailure("internal", "This phone could not save its key");
            return made;
        }
    }

    /** The comment on this phone's key line: `ovis-phone:<model>`, so it can be told apart in authorized_keys. */
    static String phoneComment(String model) {
        String name = model == null || model.isEmpty() ? "phone" : model.replaceAll("[^A-Za-z0-9._-]", "-");
        return "ovis-phone:" + name;
    }

    String phoneKeyLine(String model) throws SshFailure {
        return SshKeys.publicLine(phoneKey().getPublic(), phoneComment(model));
    }
}
