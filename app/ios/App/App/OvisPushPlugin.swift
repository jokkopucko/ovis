import Capacitor
import Foundation
import OvisPushCore
import UIKit
import UserNotifications

/// The endpoint is the relay's for this phone's APNs token, one
/// per PC, as the relay pins each endpoint to the PC's key; the token itself stays at the relay.
/// The keys are the phone's (OvisPushCore), shared with the extension that decrypts
/// (OvisNotifications).
@objc(OvisPushPlugin)
public class OvisPushPlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
    public let identifier = "OvisPushPlugin"
    public let jsName = "OvisPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "subscribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSubscription", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unsubscribe", returnType: CAPPluginReturnPromise)
    ]

    private struct Endpoint: Codable {
        let endpoint: String
        let token: String
        let vapidKey: String
        let environment: String
    }

    private enum Failure: Error { case registration, relay, configuration }
    private var tokenWaiters: [CheckedContinuation<String, Error>] = []
    private var tokenTimeout: DispatchWorkItem?

    public override func load() {
        bridge?.notificationRouter.pushNotificationHandler = self
        NotificationCenter.default.addObserver(self, selector: #selector(registered(_:)),
                                               name: .capacitorDidRegisterForRemoteNotifications, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(registrationFailed(_:)),
                                               name: .capacitorDidFailToRegisterForRemoteNotifications, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    public func didReceive(response: UNNotificationResponse) {}

    private func permission(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "prompt"
        case .denied: return "denied"
        case .authorized, .provisional, .ephemeral: return "granted"
        @unknown default: return "denied"
        }
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            call.resolve(["notifications": permission(settings.authorizationStatus)])
        }
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        Task {
            do {
                _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
                let settings = await UNUserNotificationCenter.current().notificationSettings()
                call.resolve(["notifications": permission(settings.authorizationStatus)])
            } catch { call.reject("Could not request notifications", "failed") }
        }
    }

    @objc func subscribe(_ call: CAPPluginCall) {
        guard let origin = PCStore.current else {
            call.reject("Push needs an open PC", "no_pc")
            return
        }
        guard let vapidKey = call.getString("applicationServerKey"),
              vapidKey.range(of: "^[A-Za-z0-9_-]+={0,2}$", options: .regularExpression) != nil,
              let point = decodeURL(vapidKey), point.count == 65, point.first == 4 else {
            call.reject("applicationServerKey must be the PC's VAPID public key", "invalid_key")
            return
        }
        Task { @MainActor in
            do {
                let center = UNUserNotificationCenter.current()
                var settings = await center.notificationSettings()
                if settings.authorizationStatus == .notDetermined {
                    _ = try await center.requestAuthorization(options: [.alert, .sound])
                    settings = await center.notificationSettings()
                }
                guard permission(settings.authorizationStatus) == "granted" else {
                    call.reject("Notifications are off for Ovis", "permission")
                    return
                }
                let keys = try keyStore().getOrCreate()
                let token = try await deviceToken()
                let environment = try apnsEnvironment()
                let saved = savedEndpoint(origin)
                let endpoint: String
                if let saved = saved, saved.token == token, saved.vapidKey == vapidKey,
                   saved.environment == environment {
                    endpoint = saved.endpoint
                } else {
                    endpoint = try await register(token: token, vapidKey: vapidKey, environment: environment)
                }
                let entry = Endpoint(endpoint: endpoint, token: token, vapidKey: vapidKey, environment: environment)
                UserDefaults.standard.set(try JSONEncoder().encode(entry), forKey: storageKey(origin))
                call.resolve(["subscription": subscription(endpoint, keys)])
            } catch { call.reject("Could not set up push", "failed") }
        }
    }

    @objc func getSubscription(_ call: CAPPluginCall) {
        do {
            guard let origin = PCStore.current, let saved = savedEndpoint(origin) else {
                call.resolve(["subscription": NSNull()])
                return
            }
            if call.getBool("endpointOnly") == true {
                call.resolve(["subscription": ["endpoint": saved.endpoint]])
                return
            }
            guard let keys = try keyStore().read() else {
                call.resolve(["subscription": NSNull()])
                return
            }
            call.resolve(["subscription": subscription(saved.endpoint, keys)])
        } catch PushKeyStore.Failure.damaged {
            call.resolve(["subscription": NSNull()])
        } catch { call.reject("The push keys could not be read", "failed") }
    }

    @objc func unsubscribe(_ call: CAPPluginCall) {
        if let origin = PCStore.current { UserDefaults.standard.removeObject(forKey: storageKey(origin)) }
        call.resolve()
    }

    private func storageKey(_ origin: String) -> String { "ovis.push.endpoint." + origin }

    private func savedEndpoint(_ origin: String) -> Endpoint? {
        guard let data = UserDefaults.standard.data(forKey: storageKey(origin)) else { return nil }
        return try? JSONDecoder().decode(Endpoint.self, from: data)
    }

    private func keyStore() throws -> PushKeyStore {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "OvisPushKeychainGroup") as? String,
              !group.isEmpty else { throw Failure.configuration }
        return PushKeyStore(accessGroup: group)
    }

    private func subscription(_ endpoint: String, _ keys: PushKeys) -> [String: Any] {
        [
            "endpoint": endpoint,
            "expirationTime": NSNull(),
            "keys": ["p256dh": encodeURL(keys.publicPoint), "auth": encodeURL(keys.auth)]
        ]
    }

    private func encodeURL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private func decodeURL(_ text: String) -> Data? {
        let base = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: base + String(repeating: "=", count: (4 - base.count % 4) % 4))
    }

    /// Register each time subscribe is asked: APNs can rotate the token since the last launch.
    @MainActor private func deviceToken() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            tokenWaiters.append(continuation)
            guard tokenWaiters.count == 1 else { return }
            let timeout = DispatchWorkItem { [weak self] in
                self?.finishToken(.failure(Failure.registration))
            }
            tokenTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    @objc private func registered(_ notification: Notification) {
        guard let data = notification.object as? Data else { return }
        let token = data.map { String(format: "%02x", $0) }.joined()
        DispatchQueue.main.async { self.finishToken(.success(token)) }
    }

    @objc private func registrationFailed(_ notification: Notification) {
        DispatchQueue.main.async { self.finishToken(.failure(Failure.registration)) }
    }

    private func finishToken(_ result: Result<String, Error>) {
        tokenTimeout?.cancel()
        tokenTimeout = nil
        let waiters = tokenWaiters
        tokenWaiters.removeAll()
        for waiter in waiters { waiter.resume(with: result) }
    }

    private func register(token: String, vapidKey: String, environment: String) async throws -> String {
        let relay = (Bundle.main.object(forInfoDictionaryKey: "OvisPushRelay") as? String) ?? "https://push.ovis.sh"
        guard let url = URL(string: relay + "/v1/register") else { throw Failure.configuration }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "token": token, "environment": environment, "vapid_key": vapidKey
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 201,
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let endpoint = json["endpoint"] as? String,
              endpoint.hasPrefix(relay + "/v1/push/") else { throw Failure.relay }
        return endpoint
    }

    private func apnsEnvironment() throws -> String {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision") else {
            return "production"
        }
        // The signed provisioning envelope contains one XML plist with its entitlements.
        let data = try Data(contentsOf: url)
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8)),
              let profile = try PropertyListSerialization.propertyList(
                from: data.subdata(in: start.lowerBound..<end.upperBound), format: nil
              ) as? [String: Any],
              let entitlements = profile["Entitlements"] as? [String: Any],
              let environment = entitlements["aps-environment"] as? String else {
            throw Failure.configuration
        }
        return environment == "development" ? "sandbox" : "production"
        #endif
    }
}
