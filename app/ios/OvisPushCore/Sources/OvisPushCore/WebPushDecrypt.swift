import CryptoKit
import Foundation

/// Opens the single aes128gcm record the PC sends (RFC 8291 over RFC 8188).
public enum WebPushDecrypt {
    public enum Failure: Error { case invalidRecord }

    public static func decrypt(_ message: Data, keys: PushKeys) throws -> Data {
        let bytes = [UInt8](message)
        guard bytes.count >= 103, bytes[20] == 65, bytes[21] == 4 else {
            throw Failure.invalidRecord
        }
        let recordSize = bytes[16..<20].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        guard recordSize >= 18 else { throw Failure.invalidRecord }
        guard UInt64(bytes.count - 86) <= recordSize else { throw Failure.invalidRecord }
        let sender = Data(bytes[21..<86])
        let publicKey = try P256.KeyAgreement.PublicKey(x963Representation: sender)
        let shared = try keys.privateKey.sharedSecretFromKeyAgreement(with: publicKey)
        let secret = shared.withUnsafeBytes { Data($0) }
        let info = Data("WebPush: info\0".utf8) + keys.publicPoint + sender
        let ikm = expandOneBlock(hmac(keys.auth, secret), info, 32)
        let prk = hmac(Data(bytes[0..<16]), ikm)
        let cek = expandOneBlock(prk, Data("Content-Encoding: aes128gcm\0".utf8), 16)
        let nonce = expandOneBlock(prk, Data("Content-Encoding: nonce\0".utf8), 12)
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce),
            ciphertext: Data(bytes[86..<(bytes.count - 16)]),
            tag: Data(bytes.suffix(16))
        )
        var plain = try AES.GCM.open(box, using: SymmetricKey(data: cek))
        while plain.last == 0 { plain.removeLast() }
        guard plain.popLast() == 2 else { throw Failure.invalidRecord }
        return plain
    }

    private static func hmac(_ key: Data, _ value: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: value, using: SymmetricKey(data: key)))
    }

    /// All the HKDF expansions here fit in one SHA-256 block.
    private static func expandOneBlock(_ key: Data, _ info: Data, _ count: Int) -> Data {
        Data(hmac(key, info + Data([1])).prefix(count))
    }
}
