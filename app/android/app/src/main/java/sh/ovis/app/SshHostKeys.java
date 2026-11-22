package sh.ovis.app;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;

/**
 * The host-key rule, plain Java so JVM tests run it (SshHostKeysTest). A PC's host key is confirmed by
 * the person once, when the PC is added (its SHA-256 fingerprint, as `ssh-keygen -lf` prints it), and
 * saved with its algorithm. After that:
 *
 * <ul>
 *   <li>the same algorithm and the same bytes: SAME, the only verdict that lets a connection go on;</li>
 *   <li>no saved key (a new PC, or one whose key was forgotten on purpose): UNKNOWN, which never signs
 *       in on its own; only the setup screen, after the person confirms the fingerprint, saves one;</li>
 *   <li>anything else, a saved key that cannot be read included: CHANGED, which fails closed with no
 *       way past it but forgetting the key on purpose and confirming the new one.</li>
 * </ul>
 */
final class SshHostKeys {
    enum Verdict { SAME, UNKNOWN, CHANGED }

    private SshHostKeys() {}

    static Verdict judge(String expectedAlgorithm, String expectedKey, String algorithm, byte[] key) {
        if (expectedKey == null || expectedKey.isEmpty()) return Verdict.UNKNOWN;
        byte[] expected;
        try {
            expected = Base64.getDecoder().decode(expectedKey);
        } catch (IllegalArgumentException damaged) {
            return Verdict.CHANGED;
        }
        boolean same = algorithm != null && algorithm.equals(expectedAlgorithm) && key != null && MessageDigest.isEqual(expected, key);
        return same ? Verdict.SAME : Verdict.CHANGED;
    }

    /** How a host key is saved: its wire bytes in Base64. */
    static String encode(byte[] key) {
        return Base64.getEncoder().encodeToString(key);
    }

    /** `SHA256:<unpadded Base64>`, as `ssh-keygen -lf` and OpenSSH's own prompt print it. */
    static String fingerprint(byte[] key) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(key);
            return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** The fingerprint of a saved key, or "" when none is saved or it cannot be read. */
    static String fingerprint(String savedKey) {
        if (savedKey == null || savedKey.isEmpty()) return "";
        try {
            return fingerprint(Base64.getDecoder().decode(savedKey.getBytes(StandardCharsets.US_ASCII)));
        } catch (IllegalArgumentException damaged) {
            return "";
        }
    }
}
