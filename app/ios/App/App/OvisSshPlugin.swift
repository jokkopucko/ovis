import Capacitor
import CryptoKit
import Foundation
import Network
import UIKit
import OvisHomeCore
import OvisSshCore
import Security
import UIKit
import WebKit

/// The app's SSH key store and tunnels (OvisSshCore), over UserDefaults and a sealing key in the Keychain.
enum OvisSsh {
    static let store = SshPcs(prefs: DefaultsPrefs(), sealer: KeychainSealer())
    static let tunnels: SshTunnels = {
        let tunnels = SshTunnels(store: store)
        tunnels.listener = { pc, failure in DispatchQueue.main.async { failed(pc, failure) } }
        return tunnels
    }()
    private static var networkWatch: NWPathMonitor?

    /// SSH needs WebKit's Sec-Fetch-Site (iOS 16.4), which the tunnel reads to refuse another page's requests.
    static var supported: Bool {
        if #available(iOS 16.4, *) { return true }
        return false
    }

    /// The web view's rule that no page loads anything from this phone's 127.0.0.1 but the saved SSH PCs' ports: cookies
    /// do not separate ports, so a request there would carry every SSH PC's gate to whatever else listens on it (a
    /// picture a PC's page shows included, which no navigation rule sees). Made again as SSH PCs come and go.
    private static var rules: (ports: Set<Int>, list: WKContentRuleList)?

    /// The rule for the next web view: every saved SSH PC listens first, and only the ports this app holds now are let
    /// through; a port another app took stays blocked, and its PC opens nothing.
    @MainActor
    static func loopbackRules() async -> WKContentRuleList? {
        let ports = await tunnels.listenAll()
        if let rules, rules.ports == ports { return rules.list }
        // WebKit's rule patterns have no alternation: each case is a rule of its own, and a URL always has "/" after its host
        // web schemes only: the app's own pages are capacitor://localhost, which must load
        var json: [[String: Any]] = []
        for host in ["127\\.0\\.0\\.1", "localhost"] {
            for scheme in ["https?", "wss?"] {
                json.append(["trigger": ["url-filter": "^\(scheme)://\(host)[:/]"], "action": ["type": "block"]])
            }
        }
        for port in ports.sorted() {
            for scheme in ["http", "ws"] {
                json.append(["trigger": ["url-filter": "^\(scheme)://127\\.0\\.0\\.1:\(port)/"], "action": ["type": "ignore-previous-rules"]])
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: json), let text = String(data: data, encoding: .utf8) else { return nil }
        let list: WKContentRuleList?
        do {
            list = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "ovis-ssh-loopback", encodedContentRuleList: text)
        } catch {
            NSLog("Ovis: the loopback rule did not compile: %@ %@", String(describing: error), text)
            return nil
        }
        guard let list else { return nil }
        rules = (ports, list)
        return list
    }

    /// The SSH PC saved under `key`, or nil for any other PC.
    static func pc(_ key: String?) -> SshPcs.Pc? { store.get(key.flatMap { PCStore.origin(ofKey: $0) }) }

    /// Makes `pc` listen on its address on this phone and puts its gate in the WebView's cookie store, before its
    /// page loads. Throws when another app holds the address: the PC must not open then, as the page answering there
    /// would be that app's, with the app's bridge.
    @MainActor
    static func prepare(_ pc: SshPcs.Pc) async throws {
        watchNetwork()
        let tunnel = try await tunnels.open(pc)
        await setGate(origin: pc.origin, name: tunnel.cookieName, gate: tunnel.gate)
    }

    /// The WebView's pass to the tunnel: an HttpOnly cookie on the PC's own loopback origin, which no page script reads.
    @MainActor
    static func setGate(origin: String, name: String, gate: String) async {
        guard let url = URL(string: origin), let cookie = HTTPCookie(properties: [
            .originURL: url, .path: "/", .name: name, .value: gate,
            .expires: Date().addingTimeInterval(365 * 24 * 3600),
            HTTPCookiePropertyKey("HttpOnly"): "TRUE", .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict
        ]) else { return }
        await WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie)
    }

    @MainActor
    static func dropGate(origin: String, name: String) async {
        let store = WKWebsiteDataStore.default().httpCookieStore
        for cookie in await store.allCookies() where cookie.name == name && cookie.domain == URL(string: origin)?.host {
            await store.deleteCookie(cookie)
        }
    }

    /// A tunnel's failure: the error page names it (kind `ssh-<kind>`, the command that fixes it). A stop on the PC
    /// that is open takes the page there now, as the page alone would only keep reconnecting.
    @MainActor
    private static func failed(_ pc: SshPcs.Pc, _ failure: SshFailure) {
        guard pc.origin == PCStore.current.flatMap({ PCStore.origin(ofKey: $0) }) else { return }
        PCStore.fail("\(failure.kind): \(failure.message)", kind: "ssh-\(failure.kind)", command: failure.command)
        if failure.stops { HerdrBridgeViewController.showSshStop() }
    }

    /// The phone's network changed: every SSH connection is dropped (one made over the old network may never hear it
    /// is gone), and the next request makes a new one.
    private static func watchNetwork() {
        guard networkWatch == nil else { return }
        let monitor = NWPathMonitor()
        var first = true
        var last: [NWInterface.InterfaceType] = []
        monitor.pathUpdateHandler = { path in
            let now = path.availableInterfaces.map(\.type)
            defer { first = false; last = now }
            if !first && (path.status != .satisfied || now != last) { tunnels.dropAll() }
        }
        monitor.start(queue: DispatchQueue(label: "sh.ovis.ssh.network"))
        networkWatch = monitor
    }

    static var model: String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        return machine.isEmpty ? UIDevice.current.model : machine
    }
}

/// UserDefaults under "ovis-ssh.".
final class DefaultsPrefs: SshPcs.Prefs {
    private let defaults = UserDefaults.standard

    func get(_ name: String) -> String? { defaults.string(forKey: "ovis-ssh." + name) }

    func put(_ values: [String: String?]) -> Bool {
        for (name, value) in values {
            if let value { defaults.set(value, forKey: "ovis-ssh." + name) } else { defaults.removeObject(forKey: "ovis-ssh." + name) }
        }
        return true
    }
}

/// AES-GCM under a 256-bit key kept in the Keychain for this device only (never synced, never in a backup), made on
/// first use: what SshPcs seals with.
final class KeychainSealer: SshPcs.Sealer {
    private static let service = "sh.ovis.ssh"
    private static let account = "vault"
    private let lock = NSLock()

    private func key() throws -> SymmetricKey {
        lock.lock()
        defer { lock.unlock() }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account, kSecReturnData as String: true
        ]
        var found: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        if status == errSecSuccess, let data = found as? Data, data.count == 32 { return SymmetricKey(data: data) }
        // only a key that is not there is made anew: any other answer (locked, a passing error) leaves the one there,
        // as a new key would make every sealed secret unreadable for good
        guard status == errSecItemNotFound else { throw SshFailure("internal", "The Keychain did not give the key (\(status))") }
        let made = SymmetricKey(size: .bits256)
        query[kSecReturnData as String] = nil
        query[kSecValueData as String] = made.withUnsafeBytes { Data($0) }
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(query as CFDictionary, nil)
        guard added == errSecSuccess else { throw SshFailure("internal", "The Keychain refused the key (\(added))") }
        return made
    }

    func seal(_ plain: Data) throws -> String {
        guard let combined = try AES.GCM.seal(plain, using: try key()).combined else { throw SshFailure("internal", "Sealing failed") }
        return combined.base64EncodedString()
    }

    func open(_ sealed: String) throws -> Data {
        guard let data = Data(base64Encoded: sealed) else { throw SshFailure("key-unreadable", "A damaged sealed value") }
        return try AES.GCM.open(try AES.GCM.SealedBox(combined: data), using: try key())
    }
}

/// PCs added over SSH: the connect screen (app/web/connect.js) adds one through `add`, lists them with `list`, and
/// manages each: `rename`, `phoneKey` with `copy` and `share`, `setUp` (register again, another key, a forgotten host
/// key confirmed), `forgetHostKey`, and `remove`, which can also take this phone's key out of the PC's
/// authorized_keys. Only the app's own pages call it (DirectCallGate drops a PC page's calls; `fromAppPage` answers
/// any that come through anyway), as on Android: a PC's page must not reach another PC's keys.
@objc(OvisSshPlugin)
public class OvisSshPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OvisSshPlugin"
    public let jsName = "OvisSsh"
    public let pluginMethods: [CAPPluginMethod] = ["add", "setUp", "list", "phoneKey", "copy", "share", "rename", "forgetHostKey", "remove", "known"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    override public func load() {
        forgetRemoved()
    }

    /// By the page that asked, as the gate in front of the bridge saw it (DirectCallGate.sender).
    private func fromAppPage(_ call: CAPPluginCall) -> Bool {
        if Home.bundledPage(DirectCallGate.sender(call.callbackId)) { return true }
        call.reject("Only the app's own pages manage SSH PCs.")
        return false
    }

    /// `user`, `host`, `port`: what Direct's field held (user@host), filled in on the setup screen.
    @objc func add(_ call: CAPPluginCall) {
        let user = call.getString("user"), host = call.getString("host"), port = call.getInt("port")
        // the hosted app's front page of a release before HerdrShell openSshSetup calls this itself (DirectCallGate
        // lets that one call through): it gets what that gives, the setup sheet over the page. Any other PC's page is
        // refused
        let page = DirectCallGate.sender(call.callbackId)
        if !Home.bundledPage(page) {
            let target = SshPcs.target(user: user, host: host, port: port)
            guard target.count <= 300, SshPcs.setupOpener(page, appOrigin: PCStore.shellOrigin) else {
                call.reject("Only the app's own pages manage SSH PCs.")
                return
            }
            call.resolve()
            Self.presentSetup(target, over: bridge?.viewController)
            return
        }
        present(call) { SshSetupModel(editing: nil, user: user, host: host, port: port) }
    }

    @objc func setUp(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let pc = OvisSsh.store.get(call.getString("origin")) else {
            call.reject("That SSH PC is not saved on this phone.")
            return
        }
        present(call) { SshSetupModel(editing: pc, user: nil, host: nil, port: nil) }
    }

    private func present(_ call: CAPPluginCall, _ make: @escaping @MainActor () -> SshSetupModel) {
        Task { @MainActor in
            let model = make()
            model.finished = { added in
                call.resolve(["added": added])
                if added { HerdrBridgeViewController.reopen() }
            }
            self.bridge?.viewController?.present(SshSetupController(model: model), animated: true)
        }
    }

    /// The setup sheet over the page that asked for it (HerdrShell openSshSetup: the hosted app's Add a PC › SSH), with
    /// `target` (an SSH login, or empty) filled in: Cancel returns to that page as it was, nothing loaded again; a PC
    /// added opens (the setup made it the current PC), as one added from the app's own page does.
    static func presentSetup(_ target: String, over controller: UIViewController?) {
        Task { @MainActor in
            let login = SshPcs.login(target)
            let model = SshSetupModel(editing: nil, user: login?.user, host: login?.host, port: login?.port)
            model.finished = { added in if added { HerdrBridgeViewController.reopen() } }
            controller?.present(SshSetupController(model: model), animated: true)
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        call.resolve(["pcs": OvisSsh.store.list().map { pc -> [String: Any] in
            ["origin": pc.origin, "label": pc.label, "host": pc.host, "port": pc.port, "user": pc.user, "auth": pc.auth,
             "keyType": pc.keyType, "hostKeyAlgorithm": pc.hostKeyAlgorithm, "fingerprint": SshHostKeys.fingerprint(saved: pc.hostKey)]
        }])
    }

    @objc func phoneKey(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        do {
            call.resolve(["line": try OvisSsh.store.phoneKeyLine(model: OvisSsh.model)])
        } catch let failure as SshFailure {
            call.reject(failure.message, failure.kind)
        } catch {
            call.reject(String(describing: error), "internal")
        }
    }

    @objc func copy(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        let text = call.getString("text") ?? ""
        DispatchQueue.main.async {
            UIPasteboard.general.string = text
            call.resolve()
        }
    }

    @objc func share(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        let text = call.getString("text") ?? ""
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController else { return call.resolve() }
            SshSetupController.share(text, from: controller, anchor: controller.view)
            call.resolve()
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let pc = OvisSsh.store.get(call.getString("origin")) else { return call.reject("That SSH PC is not saved on this phone.") }
        let name = String((call.getString("name") ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(64))
        PCStore.names[pc.origin] = name.isEmpty ? pc.label + " (SSH)" : name
        call.resolve()
    }

    /// What the SSH PC `origin` knows of other PCs (its ssh config's hosts, its Tailscale login's PCs, the PCs it
    /// added), as its own Ovis answers over its tunnel: `candidates` and `machines`, each that JSON or null.
    @objc func known(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let pc = OvisSsh.store.get(call.getString("origin")), pc.hasHostKey else { return call.reject("That SSH PC is not saved on this phone.") }
        Task {
            do {
                let (candidates, machines) = try await OvisSsh.tunnels.known(pc)
                func json(_ data: Data?) -> Any { data.flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? NSNull() }
                call.resolve(["candidates": json(candidates), "machines": json(machines)])
            } catch {
                let failure = SshFailure.from(error)
                call.reject(failure.message, failure.kind)
            }
        }
    }

    /// Forgets the PC's host key on purpose: it opens again only once the setup screen confirms the key it shows then.
    @objc func forgetHostKey(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        let origin = call.getString("origin") ?? ""
        do {
            try OvisSsh.store.forgetHostKey(origin)
        } catch {
            return call.reject(String(describing: error), "internal")
        }
        Task {
            await OvisSsh.tunnels.closeFor(origin)
            call.resolve()
        }
    }

    /// Forgets the PC on this phone: its host key, its sealed key and gate, its tunnel and its place in the list. With
    /// `cleanRemote`, this phone's key line is first taken out of the PC's authorized_keys (only when no other saved PC
    /// signs in to that account with it): `remote` "removed", "absent", "kept" or "failed" (with `reason`).
    @objc func remove(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let pc = OvisSsh.store.get(call.getString("origin")) else { return call.reject("That SSH PC is not saved on this phone.") }
        let cleanRemote = call.getBool("cleanRemote") ?? false
        Task { @MainActor in
            var answer: [String: Any] = ["remote": "kept"]
            if cleanRemote && pc.auth == "phone-key" && pc.hasHostKey && !SshPcs.sharedAccount(OvisSsh.store.list(), pc) {
                do {
                    let key = try OvisSsh.store.phoneKey()
                    let connection = try await SshConnection.open(host: pc.host, port: pc.port, check: .init(expectedAlgorithm: pc.hostKeyAlgorithm, expectedKey: pc.hostKey),
                                                                  user: pc.user, key: .init(ed25519Key: key))
                    defer { connection.close() }
                    let blob = String(try OvisSsh.store.phoneKeyLine(model: OvisSsh.model).split(separator: " ")[1])
                    answer["remote"] = try await SshLink.unauthorizeKey(connection, blob: blob)
                } catch {
                    let failure = SshFailure.from(error)
                    answer["remote"] = "failed"
                    answer["reason"] = "\(failure.kind): \(failure.message)"
                }
            }
            await OvisSsh.tunnels.closeFor(pc.origin)
            try? OvisSsh.store.remove(pc.origin)
            PCStore.forget(pc.origin)
            await OvisSsh.dropGate(origin: pc.origin, name: SshTunnel.cookieName(port: pc.localPort))
            call.resolve(answer)
            // the web view's loopback rule still lets the removed PC's port through: a new one leaves it out
            HerdrBridgeViewController.reopen()
        }
    }

    /// An SSH PC forgotten on the connect screen takes its saved way in (host key, sealed key, gate) with it.
    private func forgetRemoved() {
        let kept = Set(PCStore.saved + [PCStore.current, PCStore.last].compactMap { $0 })
        for pc in OvisSsh.store.list() where !kept.contains(pc.origin) {
            try? OvisSsh.store.remove(pc.origin)
            Task { await OvisSsh.tunnels.closeFor(pc.origin) }
        }
    }
}
