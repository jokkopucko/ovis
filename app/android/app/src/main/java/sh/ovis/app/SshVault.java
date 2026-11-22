package sh.ovis.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Seals the SSH secrets the app keeps (its own private key's seed, a pasted private key and its
 * passphrase) with an AES-GCM key that lives in the Android Keystore and never leaves it. A sealed
 * value is only usable on this phone, by this app: a backup or a copy of the app's files holds
 * nothing that signs in anywhere (backups are off anyway, AndroidManifest's allowBackup).
 */
final class SshVault {
    private static final String ALIAS = "ovis-ssh-vault";

    static final SshPcs.Sealer SEALER = new SshPcs.Sealer() {
        @Override
        public String seal(byte[] plain) throws GeneralSecurityException {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] sealed = cipher.doFinal(plain);
            return Base64.getEncoder().encodeToString(cipher.getIV()) + ":" + Base64.getEncoder().encodeToString(sealed);
        }

        @Override
        public byte[] open(String sealed) throws GeneralSecurityException {
            int colon = sealed == null ? -1 : sealed.indexOf(':');
            if (colon < 0) throw new GeneralSecurityException("damaged sealed value");
            byte[] iv;
            byte[] body;
            try {
                iv = Base64.getDecoder().decode(sealed.substring(0, colon));
                body = Base64.getDecoder().decode(sealed.substring(colon + 1));
            } catch (IllegalArgumentException damaged) {
                throw new GeneralSecurityException("damaged sealed value");
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            return cipher.doFinal(body);
        }
    };

    private SshVault() {}

    private static synchronized SecretKey key() throws GeneralSecurityException {
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(
                new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            );
            return generator.generateKey();
        } catch (java.io.IOException storeUnreadable) {
            throw new GeneralSecurityException(storeUnreadable);
        } catch (java.security.ProviderException keystoreFailed) {
            // a Keystore that cannot make or give the key throws this unchecked: it is the vault's failure all the same
            throw new GeneralSecurityException(keystoreFailed);
        }
    }
}
