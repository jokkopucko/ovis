import Foundation

/// A tapped alert (docs/native-app.md, Push in the app): the saved PC it is about and its pane's chat there, and
/// whether the page on screen is handed the pane or the alert's address opens. The decisions alone, which
/// OvisPushPlugin and HerdrBridgeViewController carry out (AlertTests); PCStore.alertLink, alertTap and appPage are
/// the Android twins.
public enum Alert {
    /// What the app reads of a PC's decrypted alert (shared/push.ts PushPayload) to open it: the rest is the
    /// extension's to show. `endpoint` and `serverId` say which PC sent it, where the PC names them.
    public struct Payload: Decodable, Equatable {
        public let pane: String?
        public let machine: String?
        public let workspace: String?
        public let endpoint: String?
        public let serverId: String?

        public init(pane: String?, machine: String? = nil, workspace: String? = nil, endpoint: String? = nil, serverId: String? = nil) {
            self.pane = pane
            self.machine = machine
            self.workspace = workspace
            self.endpoint = endpoint
            self.serverId = serverId
        }

        enum CodingKeys: String, CodingKey {
            case pane = "pane_id", machine = "machine_id", workspace = "workspace_id", endpoint, serverId = "server_id"
        }
    }

    /// The alert in `plain`, the PC's decrypted JSON, or nil for anything else.
    public static func payload(_ plain: Data) -> Payload? {
        try? JSONDecoder().decode(Payload.self, from: plain)
    }

    /// Where an alert leads: the saved PC `pc`, the address of its pane's chat there (`address`), and the
    /// "select-pane" message its page takes in place of loading that address (`selection`, JSON, as public/sw.js posts
    /// it to an open window).
    public struct Link: Equatable {
        public let pc: String
        public let address: String
        public let selection: String
    }

    /// The saved PC an alert is about, or nil: one that names no pane (the confirmation push) or no PC this phone
    /// keeps. `stored`: the key the alert's endpoint was kept under (OvisPushPlugin), the PC whose page subscribed.
    /// A relay ID by itself does not identify the sender.
    /// A PC saved by its own address is that key. A relay PC shares the shell's origin (`shell`, PCStore.shellOrigin)
    /// with every other, and with the hosted app the person may have kept as the PC: it is named by its relay ID
    /// (`serverId`) instead, and its pane rides in its scope's fragment, which the hosted app's host never hears. A
    /// relay ID never moves an alert from a PC's own address, nor from one relay PC's scope, to another scope.
    public static func link(saved: [String], stored: String?, alert: Payload, shell: URL?, knownServerId: String? = nil) -> Link? {
        guard let stored, let pane = alert.pane, !pane.isEmpty else { return nil }
        let machine = alert.machine.flatMap { $0.isEmpty ? nil : $0 } ?? "local"
        let workspace = alert.workspace.flatMap { $0.isEmpty ? nil : $0 }
        let query = "machine=" + encoded(machine) + (workspace.map { "&ws=" + encoded($0) } ?? "") + "&pane=" + encoded(pane) + "&view=chat"
        guard let selection = selection(pane: pane, machine: machine, workspace: workspace) else { return nil }
        if saved.contains(stored), !scoped(stored), !Home.sameOrigin(URL(string: stored), shell) {
            if let knownServerId, let serverId = alert.serverId, knownServerId != serverId { return nil }
            return Link(pc: stored, address: (stored.hasSuffix("/") ? stored : stored + "/") + "?" + query, selection: selection)
        }
        guard let id = Home.relayId(alert.serverId), let shell,
              let scope = Home.relayScope(URL(string: "/s/\(id)/", relativeTo: shell)?.absoluteURL, appOrigin: shell),
              saved.contains(scope) else { return nil }
        guard stored == scope || (!scoped(stored) && Home.sameOrigin(URL(string: stored), shell)) else { return nil }
        return Link(pc: scope, address: scope + "#" + query, selection: selection)
    }

    /// Whether the page on screen is handed the alert's pane, nothing loaded: `shown`, the address of the page that is
    /// up (nil while a cover is over it, or for the error page or another screen), is a page of the alert's PC
    /// (`belongs`, PCStore.belongs) that runs the app itself (`appPage`). Its PC need not be the current one: a relay
    /// PC's page in the hosted app the person kept as the PC is that relay PC's. Otherwise the alert's address opens.
    public static func handsToPage(_ link: Link, shown: String?, belongs: Bool) -> Bool {
        guard let shown, belongs else { return false }
        return appPage(shown, key: link.pc)
    }

    /// Whether `url`, a page of the PC `key`, runs the app itself and so takes a "select-pane" message: not a reader
    /// (`?read=`, or `#read=` in a relay PC's scope, where the shell reads its fragment), an API answer, the socket, or
    /// a file.
    public static func appPage(_ url: String, key: String) -> Bool {
        guard let parts = URLComponents(string: url) else { return false }
        let path = parts.percentEncodedPath
        if path.hasPrefix("/api/") || path == "/ws" { return false }
        let last = path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        if last.contains("."), last != "index.html" { return false }
        let search = parts.percentEncodedQuery ?? ""
        let fragment = parts.percentEncodedFragment ?? ""
        let fromFragment = scoped(key) && search.isEmpty && !fragment.isEmpty
        guard let read = value(of: "read", in: fromFragment ? fragment : search) else { return true }
        return read.trimmingCharacters(in: jsSpace).isEmpty
    }

    /// The script that hands the page on screen a Link's `selection`, which goes in as a JSON value, never as code: it
    /// is dispatched on the page's window as "ovis-select-pane" (SELECT_PANE_EVENT in src/lib/notificationTarget.ts),
    /// which a page on plain http, with no navigator.serviceWorker, hears too, and which that page cancels; a page from
    /// an older Ovis gets it as its worker's message. It answers true once it ran: a page that could not run it (its
    /// web content process gone) gets the alert's address instead.
    public static func selectionScript(_ selection: String) -> String {
        "(() => { const data = \(selection); "
            + "if (window.dispatchEvent(new MessageEvent('ovis-select-pane', { data, cancelable: true }))) { "
            + "const worker = navigator.serviceWorker; if (worker) worker.dispatchEvent(new MessageEvent('message', { data })); } "
            + "return true; })()"
    }

    private static func selection(pane: String, machine: String, workspace: String?) -> String? {
        var message = ["type": "select-pane", "pane_id": pane, "machine_id": machine, "view": "chat"]
        if let workspace { message["workspace_id"] = workspace }
        guard let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return nil }
        // JSON is not all JavaScript: U+2028 and U+2029 end a line there
        return json.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    /// Whether `key` is a relay PC's scope, a path within its origin, rather than a PC's origin.
    private static func scoped(_ key: String) -> Bool {
        let path = URLComponents(string: key)?.percentEncodedPath ?? ""
        return !path.isEmpty && path != "/"
    }

    /// `text` as a query value, as Android's URLEncoder writes it (a space as %20): letters, digits and `.-*_` as they are.
    private static func encoded(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: queryKept) ?? text
    }

    private static let queryKept = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-*_")

    /// What JavaScript's trim() takes away (the client reads `read` so): every space and line end Unicode names, and
    /// U+FEFF, but not U+0085, which Foundation counts as a line end.
    private static let jsSpace = CharacterSet.whitespacesAndNewlines.subtracting(CharacterSet(charactersIn: "\u{85}"))
        .union(CharacterSet(charactersIn: "\u{FEFF}"))

    /// The first value of `name` in `query` (raw, a leading `?` optional), decoded as URLSearchParams decodes it, or nil.
    private static func value(of name: String, in query: String) -> String? {
        let body = query.hasPrefix("?") ? String(query.dropFirst()) : query
        for pair in body.split(separator: "&", omittingEmptySubsequences: false) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            if formDecoded(String(parts[0])) == name { return formDecoded(parts.count > 1 ? String(parts[1]) : "") }
        }
        return nil
    }

    private static func formDecoded(_ text: String) -> String {
        let spaced = text.replacingOccurrences(of: "+", with: " ")
        return spaced.removingPercentEncoding ?? spaced
    }
}
