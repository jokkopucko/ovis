package sh.ovis.app;

import com.trilead.ssh2.crypto.PEMDecoder;
import com.trilead.ssh2.crypto.PEMStructure;
import com.trilead.ssh2.crypto.PublicKeyUtils;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.PublicKey;
import java.security.interfaces.DSAPublicKey;
import java.security.interfaces.ECPublicKey;
import java.security.interfaces.RSAPublicKey;
import java.util.Locale;

/**
 * Private keys pasted into the app, read with ConnectBot's sshlib: OpenSSH's own format (what
 * `ssh-keygen` writes since 7.8, ed25519, RSA or ECDSA, with or without a passphrase) and the older
 * PEM files (`BEGIN RSA PRIVATE KEY`, `BEGIN EC PRIVATE KEY`, encrypted or not). Each way a paste can
 * fail has its own kind (SshFailure), so the screen says what to do about it. Plain Java: SshKeysTest
 * reads real keys made by ssh-keygen.
 */
final class SshKeys {
    private SshKeys() {}

    static final class Read {
        final KeyPair pair;
        /** "ed25519", "rsa" or "ecdsa" */
        final String type;
        /** bits of an RSA key, the curve's size of an ECDSA one, 256 for ed25519 */
        final int bits;
        final boolean encrypted;

        Read(KeyPair pair, String type, int bits, boolean encrypted) {
            this.pair = pair;
            this.type = type;
            this.bits = bits;
            this.encrypted = encrypted;
        }

        /** Its line for authorized_keys, with `comment` (letters, digits and . _ - : only). */
        String publicLine(String comment) throws SshFailure {
            return SshKeys.publicLine(pair.getPublic(), comment);
        }
    }

    /** What a paste looks like without its passphrase: null when it is a key this class reads, else why not. */
    static SshFailure precheck(String text) {
        String key = text == null ? "" : text.trim();
        if (key.isEmpty()) return new SshFailure("key-missing", "No private key was pasted");
        if (key.startsWith("PuTTY-User-Key-File")) {
            return new SshFailure("key-format", "A PuTTY key", "puttygen key.ppk -O private-openssh -o key");
        }
        if (key.contains("BEGIN PRIVATE KEY") || key.contains("BEGIN ENCRYPTED PRIVATE KEY")) {
            return new SshFailure("key-format", "A PKCS#8 key", "ssh-keygen -p -f key");
        }
        if (key.matches("(?s)^(ssh-|ecdsa-|sk-).*") && !key.contains("PRIVATE KEY")) {
            return new SshFailure("key-public", "A public key, not the private one");
        }
        if (key.contains("BEGIN DSA PRIVATE KEY")) return new SshFailure("key-unsupported", "DSA keys are no longer accepted by OpenSSH");
        try {
            PEMDecoder.parsePEM(key.toCharArray());
            return null;
        } catch (IOException | RuntimeException notPem) {
            return new SshFailure("key-not-a-key", SshFailure.rootMessage(notPem));
        }
    }

    /** Whether a paste that passes precheck needs a passphrase. */
    static boolean encrypted(String text) {
        try {
            return PEMDecoder.isPEMEncrypted(PEMDecoder.parsePEM(text.trim().toCharArray()));
        } catch (IOException | RuntimeException unreadable) {
            return false;
        }
    }

    /** The key in `text`, opened with `passphrase` (null or "" for none). Slow for an encrypted OpenSSH key (bcrypt): never on the main thread. */
    static Read read(String text, String passphrase) throws SshFailure {
        SshFailure early = precheck(text);
        if (early != null) throw early;
        String pass = passphrase == null || passphrase.isEmpty() ? null : passphrase;
        char[] key = text.trim().toCharArray();
        PEMStructure pem;
        boolean encrypted;
        try {
            pem = PEMDecoder.parsePEM(key);
            encrypted = PEMDecoder.isPEMEncrypted(pem);
        } catch (IOException | RuntimeException damaged) {
            throw new SshFailure("key-not-a-key", SshFailure.rootMessage(damaged));
        }
        if (encrypted && pass == null) throw new SshFailure("key-needs-passphrase", "The key is protected by a passphrase");
        KeyPair pair;
        try {
            pair = decode(pem, key, pass);
        } catch (IOException | RuntimeException failed) {
            String why = SshFailure.rootMessage(failed);
            if (why.toLowerCase(Locale.ROOT).contains("unknown key type") || why.contains("Unsupported encryption") || why.contains("Only one key")) {
                throw new SshFailure("key-unsupported", why);
            }
            if (encrypted) throw new SshFailure("key-wrong-passphrase", "The passphrase does not open this key");
            throw new SshFailure("key-not-a-key", why);
        }
        PublicKey pub = pair.getPublic();
        if (pub instanceof RSAPublicKey) return new Read(pair, "rsa", ((RSAPublicKey) pub).getModulus().bitLength(), encrypted);
        if (pub instanceof ECPublicKey) return new Read(pair, "ecdsa", ((ECPublicKey) pub).getParams().getOrder().bitLength(), encrypted);
        if (pub instanceof DSAPublicKey) throw new SshFailure("key-unsupported", "DSA keys are no longer accepted by OpenSSH");
        if (PublicKeyUtils.isEd25519Key(pub)) return new Read(pair, "ed25519", 256, encrypted);
        throw new SshFailure("key-unsupported", pub.getAlgorithm());
    }

    private static KeyPair decode(PEMStructure pem, char[] key, String pass) throws IOException {
        if (pass == null || pem.pemType == PEMDecoder.PEM_OPENSSH_PRIVATE_KEY
                || StandardCharsets.US_ASCII.newEncoder().canEncode(pass)) {
            return PEMDecoder.decode(pem, pass);
        }
        // sshlib 2.2.51 takes a String and encodes traditional PEM passwords as Latin-1.
        // Carry the UTF-8 bytes through that conversion without changing them.
        String utf8Bytes = new String(pass.getBytes(StandardCharsets.UTF_8), StandardCharsets.ISO_8859_1);
        try {
            return PEMDecoder.decode(pem, utf8Bytes);
        } catch (IOException | RuntimeException failed) {
            if (!StandardCharsets.ISO_8859_1.newEncoder().canEncode(pass)) throw failed;
            // Decoding can modify the PEM in place, so retry the original bytes.
            return PEMDecoder.decode(key, pass);
        }
    }

    /** `public` as a line for authorized_keys. */
    static String publicLine(PublicKey pub, String comment) throws SshFailure {
        if (comment == null || !comment.matches("[A-Za-z0-9._:-]*")) throw new SshFailure("internal", "Unexpected characters in the key's comment");
        try {
            return PublicKeyUtils.toAuthorizedKeysFormat(pub, comment).trim();
        } catch (Exception unexpected) {
            throw new SshFailure("internal", SshFailure.rootMessage(unexpected));
        }
    }
}
