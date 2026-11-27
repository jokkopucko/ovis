# Test-only SSH keys

Made for SshKeysTest and SshHostKeysTest, and authorized nowhere.
The passphrase of the `-pass` keys is `test-only-passphrase`. Each `.fingerprint` is
`ssh-keygen -lf <key>.pub`'s SHA-256 fingerprint of that key.

| File | Made with |
| --- | --- |
| `ed25519` | `-t ed25519` |
| `ed25519-pass` | `-t ed25519`, with a passphrase |
| `rsa-pass` | `-t rsa -b 3072`, with a passphrase (OpenSSH format) |
| `rsa-pem`, `rsa-pem-pass` | `-t rsa -b 2048 -m PEM`, without and with a passphrase |
| `rsa-pem-utf8` | `ssh-keygen -t rsa -b 2048 -m PEM`, with the UTF-8 passphrase `시험용-암호` |
| `ec-pem-latin1` | `ssh-keygen -t ecdsa -b 256 -m PEM`, then `openssl ec -aes128` with `café` encoded as Latin-1 |
| `ecdsa` | `-t ecdsa -b 256` |
| `rsa-pkcs8` | `-t rsa -b 2048 -m PKCS8`, a format the app refuses with a command to convert it |
