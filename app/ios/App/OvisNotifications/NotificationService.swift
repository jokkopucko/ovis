import Foundation
import OvisPushCore
import UserNotifications

/// The relay's mutable-content alert carries the PC's ciphertext in "ovis"
/// (RFC 8291, aes128gcm), opened here with the phone's keys from the keychain group shared with the
/// app; the relay never holds a key that could read it.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNNotificationContent?

    private struct Payload: Decodable {
        let title: String?
        let body: String?
        let tag: String?
    }

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        content.title = "Ovis"
        content.body = Locale.preferredLanguages.first?.hasPrefix("ko") == true
            ? "herdr가 확인을 기다리고 있습니다" : "herdr needs you"
        content.threadIdentifier = "herdr"
        lock.lock()
        handler = contentHandler
        bestAttempt = content.copy() as? UNNotificationContent
        lock.unlock()
        if let sealed = request.content.userInfo["ovis"] as? String,
           let message = Data(base64Encoded: sealed),
           let group = Bundle.main.object(forInfoDictionaryKey: "OvisPushKeychainGroup") as? String {
            do {
                if let keys = try PushKeyStore(accessGroup: group).read() {
                    let plain = try WebPushDecrypt.decrypt(message, keys: keys)
                    let payload = try JSONDecoder().decode(Payload.self, from: plain)
                    content.title = payload.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Ovis"
                    content.body = payload.body ?? ""
                    content.threadIdentifier = payload.tag.flatMap { $0.isEmpty ? nil : $0 } ?? "herdr"
                }
            } catch {
            }
        }
        lock.lock()
        bestAttempt = content.copy() as? UNNotificationContent
        lock.unlock()
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { [self] delivered in
            let ids = delivered.filter {
                $0.request.content.threadIdentifier == content.threadIdentifier
            }.map { $0.request.identifier }
            center.removeDeliveredNotifications(withIdentifiers: ids)
            deliverOnce()
        }
    }

    override func serviceExtensionTimeWillExpire() { deliverOnce() }

    private func deliverOnce() {
        lock.lock()
        let callback = handler
        let content = bestAttempt
        handler = nil
        lock.unlock()
        if let content = content { callback?(content) }
    }
}
