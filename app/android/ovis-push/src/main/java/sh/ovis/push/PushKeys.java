package sh.ovis.push;

import java.math.BigInteger;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECFieldFp;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import java.util.Base64;

/**
 * This phone's push keys, as a browser makes them for a subscription (RFC 8291 section 2): a
 * P-256 key pair whose public half and an authentication secret go to each PC, which encrypts its
 * pushes for them. One set serves every PC: each PC's endpoint takes only that PC's pushes (the
 * relay pins its VAPID key), and only this phone holds the private half.
 */
final class PushKeys {
    static final class Damaged extends GeneralSecurityException {
        Damaged() { super("damaged push keys"); }
    }

    final byte[] privateScalar;
    /** the uncompressed point, 65 bytes: what a PC gets as p256dh */
    final byte[] publicPoint;
    /** 16 bytes: what a PC gets as auth */
    final byte[] auth;

    PushKeys(byte[] privateScalar, byte[] publicPoint, byte[] auth) {
        this.privateScalar = privateScalar;
        this.publicPoint = publicPoint;
        this.auth = auth;
    }

    static PushKeys decode(String scalar, String point, String auth) throws GeneralSecurityException {
        if (scalar == null && point == null && auth == null) return null;
        if (scalar == null || point == null || auth == null) throw new Damaged();
        PushKeys keys;
        try {
            Base64.Decoder decoder = Base64.getDecoder();
            keys = new PushKeys(decoder.decode(scalar), decoder.decode(point), decoder.decode(auth));
        } catch (IllegalArgumentException damaged) {
            throw new Damaged();
        }
        if (keys.privateScalar.length != 32 || keys.publicPoint.length != 65 || keys.auth.length != 16
            || keys.publicPoint[0] != 4) throw new Damaged();
        ECParameterSpec parameters = p256();
        BigInteger value = new BigInteger(1, keys.privateScalar);
        if (value.signum() == 0 || value.compareTo(parameters.getOrder()) >= 0) throw new Damaged();
        // Prove malformed point bytes directly: providers need not reject them at key import.
        BigInteger x = new BigInteger(1, Arrays.copyOfRange(keys.publicPoint, 1, 33));
        BigInteger y = new BigInteger(1, Arrays.copyOfRange(keys.publicPoint, 33, 65));
        BigInteger prime = ((ECFieldFp) parameters.getCurve().getField()).getP();
        BigInteger right = x.multiply(x).multiply(x).add(parameters.getCurve().getA().multiply(x))
            .add(parameters.getCurve().getB()).mod(prime);
        if (x.compareTo(prime) >= 0 || y.compareTo(prime) >= 0
            || !y.multiply(y).mod(prime).equals(right)) throw new Damaged();
        // Only a completed check returning false proves that otherwise valid halves mismatch.
        Signature proof = Signature.getInstance("SHA256withECDSA");
        proof.initSign(keys.privateKey());
        proof.update(new byte[] { 0 });
        byte[] signature = proof.sign();
        proof.initVerify(publicKey(keys.publicPoint));
        proof.update(new byte[] { 0 });
        if (!proof.verify(signature)) throw new Damaged();
        return keys;
    }

    static PushKeys generate() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();
        ECPoint point = ((ECPublicKey) pair.getPublic()).getW();
        byte[] publicPoint = new byte[65];
        publicPoint[0] = 4;
        System.arraycopy(unsigned32(point.getAffineX()), 0, publicPoint, 1, 32);
        System.arraycopy(unsigned32(point.getAffineY()), 0, publicPoint, 33, 32);
        byte[] auth = new byte[16];
        new SecureRandom().nextBytes(auth);
        return new PushKeys(unsigned32(((ECPrivateKey) pair.getPrivate()).getS()), publicPoint, auth);
    }

    PrivateKey privateKey() throws GeneralSecurityException {
        return KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(new BigInteger(1, privateScalar), p256()));
    }

    /** A P-256 public key from its uncompressed point (a sender's key in a push's header). */
    static PublicKey publicKey(byte[] point) throws GeneralSecurityException {
        if (point.length != 65 || point[0] != 4) throw new GeneralSecurityException("not an uncompressed P-256 point");
        ECPoint w = new ECPoint(new BigInteger(1, Arrays.copyOfRange(point, 1, 33)), new BigInteger(1, Arrays.copyOfRange(point, 33, 65)));
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(w, p256()));
    }

    private static ECParameterSpec p256() throws GeneralSecurityException {
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        return parameters.getParameterSpec(ECParameterSpec.class);
    }

    private static byte[] unsigned32(BigInteger value) {
        byte[] bytes = value.toByteArray();
        if (bytes.length == 32) return bytes;
        byte[] fixed = new byte[32];
        if (bytes.length > 32) System.arraycopy(bytes, bytes.length - 32, fixed, 0, 32);
        else System.arraycopy(bytes, 0, fixed, 32 - bytes.length, bytes.length);
        return fixed;
    }
}
