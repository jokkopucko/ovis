package sh.ovis.push;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.KeyAgreement;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.junit.Test;

public class WebPushDecryptTest {
    private static byte[] b64(String value) {
        return Base64.getUrlDecoder().decode(value);
    }

    /** RFC 8291 section 5 and appendix A: the user agent's keys and the message they open. */
    private static final PushKeys RFC_KEYS = new PushKeys(
        b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
        b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
        b64("BTBZMqHH6r4Tts7J_aSIgg")
    );
    /** the 86-byte header (salt, record size 4096, the sender's key) and the ciphertext, as the RFC gives them */
    private static final String RFC_HEADER =
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    private static final String RFC_CIPHERTEXT = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";

    private static byte[] rfcMessage() {
        byte[] header = b64(RFC_HEADER);
        byte[] ciphertext = b64(RFC_CIPHERTEXT);
        byte[] message = Arrays.copyOf(header, header.length + ciphertext.length);
        System.arraycopy(ciphertext, 0, message, header.length, ciphertext.length);
        return message;
    }

    @Test
    public void opensTheRfcExample() throws GeneralSecurityException {
        byte[] plain = WebPushDecrypt.decrypt(rfcMessage(), RFC_KEYS);
        assertEquals("When I grow up, I want to be a watermelon", new String(plain, StandardCharsets.UTF_8));
    }

    @Test
    public void refusesAChangedCiphertext() {
        byte[] message = rfcMessage();
        message[message.length - 1] ^= 1;
        assertThrows(GeneralSecurityException.class, () -> WebPushDecrypt.decrypt(message, RFC_KEYS));
    }

    @Test
    public void refusesOtherKeys() throws GeneralSecurityException {
        PushKeys other = PushKeys.generate();
        assertThrows(GeneralSecurityException.class, () -> WebPushDecrypt.decrypt(rfcMessage(), other));
    }

    private static void assertInvalid(byte[] message) {
        GeneralSecurityException error = assertThrows(GeneralSecurityException.class,
            () -> WebPushDecrypt.decrypt(message, RFC_KEYS));
        assertEquals(GeneralSecurityException.class, error.getClass());
    }

    @Test
    public void refusesTruncatedHeader() {
        byte[] truncated = Arrays.copyOf(rfcMessage(), 20);
        assertInvalid(truncated);
    }

    @Test
    public void refusesShortBody() {
        byte[] truncated = Arrays.copyOf(rfcMessage(), 102);
        assertInvalid(truncated);
    }

    @Test
    public void refusesWrongKeyIdLength() {
        byte[] malformed = rfcMessage();
        malformed[20] = 64;
        assertInvalid(malformed);
    }

    @Test
    public void refusesCompressedPointMarker() {
        byte[] malformed = rfcMessage();
        malformed[21] = 3;
        assertInvalid(malformed);
    }

    @Test
    public void refusesRecordLargerThanRs() {
        byte[] malformed = rfcMessage();
        java.nio.ByteBuffer.wrap(malformed).putInt(16, 18);
        assertInvalid(malformed);
    }

    /** RFC 8291 appendix A's CEK and nonce produce authenticated delimiter fixtures. */
    private static byte[] sealed(byte[] padded, int recordSize) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(b64("oIhVW04MRdy2XN9CiKLxTg"), "AES"),
            new GCMParameterSpec(128, b64("4h_95klXJ5E_qnoN")));
        byte[] ciphertext = cipher.doFinal(padded);
        byte[] message = Arrays.copyOf(rfcMessage(), 86 + ciphertext.length);
        java.nio.ByteBuffer.wrap(message).putInt(16, recordSize);
        System.arraycopy(ciphertext, 0, message, 86, ciphertext.length);
        return message;
    }

    @Test
    public void refusesRsBelow18EvenForEmptyPayload() throws GeneralSecurityException {
        byte[] malformed = sealed(new byte[] { 2 }, 17);
        assertInvalid(malformed);
    }

    @Test
    public void acceptsMinimumRsAndZeroPadding() throws GeneralSecurityException {
        byte[] padded = sealed(new byte[] { 2, 0 }, 18);
        assertArrayEquals(new byte[0], WebPushDecrypt.decrypt(padded, RFC_KEYS));
    }

    @Test
    public void refusesNonFinalDelimiter() throws GeneralSecurityException {
        byte[] malformed = sealed(new byte[] { 1, 0 }, 18);
        assertInvalid(malformed);
    }

    @Test
    public void refusesMissingDelimiter() throws GeneralSecurityException {
        byte[] malformed = sealed(new byte[] { 0, 0 }, 18);
        assertInvalid(malformed);
    }

    @Test
    public void generatesMatchingHalves() throws GeneralSecurityException {
        PushKeys a = PushKeys.generate();
        PushKeys b = PushKeys.generate();
        assertEquals(65, a.publicPoint.length);
        assertEquals(16, a.auth.length);
        assertArrayEquals(secret(a, b), secret(b, a));
    }

    private static byte[] secret(PushKeys own, PushKeys other) throws GeneralSecurityException {
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(own.privateKey());
        agreement.doPhase(PushKeys.publicKey(other.publicPoint), true);
        return agreement.generateSecret();
    }
}
