import UIKit
import WebKit
import Capacitor
import OvisHomeCore
import OvisSshCore

/// The PCs this app knows, kept in UserDefaults. The WebView's cookies (a paired device's
/// sign-in) live in WebKit's own store, not here.
enum PCStore {
    private static let defaults = UserDefaults.standard

    /// The hosted shell's origin: OvisAppOrigin in Info.plist, the build's (hosted-origin.xcconfig), https://app.ovis.sh
    /// in a store build. Without it nothing is the hosted shell.
    static let appOrigin = (Bundle.main.object(forInfoDictionaryKey: "OvisAppOrigin") as? String).flatMap { URL(string: $0) }

    /// Whether this build serves the shell from inside the app (OvisAppShell in Info.plist, `bundled` in a build made
    /// with OVIS_APP_SHELL=bundled) instead of loading it from `appOrigin`.
    static let shellBundled = appOrigin != nil && (Bundle.main.object(forInfoDictionaryKey: "OvisAppShell") as? String) == "bundled"

    /// Where the shell's pages are, which every gate that asks "is this page the shell's" compares with: `appOrigin`
    /// in a build that loads the shell from there, and in one that serves it itself that origin's host on the app's
    /// own scheme (`capacitor://app.ovis.sh`), while it is served (ShellHost.origin, and no web view found without
    /// ShellHost in front of its handler): never the network's copy.
    static var shellOrigin: URL? { shellBundled ? (ShellHost.failed ? nil : ShellHost.origin) : appOrigin }

    /// `text` as this build opens it (Home.shellForm): an address on the hosted origin is that page of the shell
    /// inside the app, where the build serves it; anything else as it is.
    static func shellForm(_ text: String) -> String {
        Home.shellForm(text, hosted: appOrigin, shell: shellOrigin)
    }

    /// Whether the PC `key` is one the app serves itself: the shell inside the app, or a relay PC's scope there.
    /// Nothing is waited on for its page, and no address explains a page that does not come.
    static func inApp(_ key: String?) -> Bool {
        guard shellBundled, let key, let url = URL(string: key) else { return false }
        return url.scheme?.lowercased() == Home.appScheme && origin(of: url) != nil
    }

    /// The update to a build with the shell inside the app found a sign-in or a PC of the hosted origin on this
    /// phone (settleShell), and the screen that says so (ShellMovedViewController) has not been answered yet.
    static var moveNotice: Bool {
        get { shellBundled && defaults.bool(forKey: "herdr.shell.notice") }
        set { defaults.set(newValue, forKey: "herdr.shell.notice") }
    }

    /// One of the PCs that update set aside sends this phone alerts, which that screen says in one more line: they are
    /// encrypted for the phone's one key whichever pairing they are for, and the app cannot hold back an alert that
    /// has arrived, so they stop only where the PC forgets the phone's old entry.
    static var moveAlerts: Bool {
        get { defaults.bool(forKey: "herdr.shell.notice.alerts") }
        set { defaults.set(newValue, forKey: "herdr.shell.notice.alerts") }
    }

    /// At each start, the saved PCs as this build can open them.
    ///
    /// In a build that serves the shell from inside the app: what the app saved at the hosted origin's host (the
    /// hosted app as the PC a sign-in opened, every relay PC's scope there) no longer opens, as the sign-in and the
    /// pairing keys behind it are the hosted origin's own storage, which the shell's new origin cannot read. Those
    /// entries leave the list, and the person is told once (moveNotice). A PC opened at its own address (Tailscale, a
    /// home network, any other, an SSH PC's on this phone) keeps its entry, its name and its place as the current PC:
    /// its page and its cookie are its own origin's. Nothing is deleted: the entries are kept aside (`herdr.hosted.*`),
    /// their push endpoints stay under their keys, and the hosted origin's storage in the web view is not touched.
    ///
    /// In a build that loads the shell from the network, installed over one that served it (a test build that
    /// switches): the other way round. What that build set aside is back in the list, as it opens again, and what it
    /// saved on the app's own scheme, whose pages this build does not have, is kept aside in its turn (`herdr.inapp.*`)
    /// for the next build that serves the shell.
    static func settleShell() {
        if shellBundled {
            guard shellOrigin != nil else { return }
            putBack("herdr.inapp")
            let kept = Home.withoutHosted(saved: saved, names: names, ids: ids, current: current, last: last, hosted: appOrigin)
            guard !kept.dead.isEmpty else { return }
            setAside(kept.dead, as: "herdr.hosted")
            moveAlerts = kept.dead.contains { defaults.object(forKey: "ovis.push.endpoint." + $0) != nil }
            (saved, names, ids, current, last) = (kept.saved, kept.names, kept.ids, kept.current, kept.last)
            moveNotice = true
        } else {
            putBack("herdr.hosted")
            defaults.removeObject(forKey: "herdr.shell.notice")
            defaults.removeObject(forKey: "herdr.shell.notice.alerts")
            let kept = Home.withoutInApp(saved: saved, names: names, ids: ids, current: current, last: last)
            guard !kept.dead.isEmpty else { return }
            setAside(kept.dead, as: "herdr.inapp")
            (saved, names, ids, current, last) = (kept.saved, kept.names, kept.ids, kept.current, kept.last)
        }
    }

    /// Keeps the entries `keys` with their names and relay IDs under `prefix`, added to what is there.
    private static func setAside(_ keys: [String], as prefix: String) {
        let aside = defaults.stringArray(forKey: prefix + ".saved") ?? []
        defaults.set(aside + keys.filter { !aside.contains($0) }, forKey: prefix + ".saved")
        let asideNames = defaults.dictionary(forKey: prefix + ".names") as? [String: String] ?? [:]
        defaults.set(asideNames.merging(names.filter { keys.contains($0.key) }) { _, new in new }, forKey: prefix + ".names")
        let asideIds = defaults.dictionary(forKey: prefix + ".ids") as? [String: String] ?? [:]
        defaults.set(asideIds.merging(ids.filter { keys.contains($0.key) }) { _, new in new }, forKey: prefix + ".ids")
    }

    /// Puts what is kept under `prefix` back among the saved PCs (Home.restored) and empties it.
    private static func putBack(_ prefix: String) {
        let aside = defaults.stringArray(forKey: prefix + ".saved") ?? []
        guard !aside.isEmpty else { return }
        let back = Home.restored(saved: saved, names: names, ids: ids, aside: aside,
                                 asideNames: defaults.dictionary(forKey: prefix + ".names") as? [String: String] ?? [:],
                                 asideIds: defaults.dictionary(forKey: prefix + ".ids") as? [String: String] ?? [:])
        (saved, names, ids) = (back.saved, back.names, back.ids)
        for key in [".saved", ".names", ".ids"] { defaults.removeObject(forKey: prefix + key) }
    }

    /// PCs opened before, the latest first, each by its key: the origin of a PC opened at its own
    /// address, or the scope of one opened through the Ovis relay (`https://app.ovis.sh/s/<server_id>/`,
    /// `capacitor://app.ovis.sh/s/<server_id>/` in a build that serves the shell itself),
    /// as every relay PC shares the shell's origin.
    static var saved: [String] {
        get { defaults.stringArray(forKey: "herdr.saved") ?? [] }
        set { defaults.set(newValue, forKey: "herdr.saved") }
    }

    static var names: [String: String] {
        get { defaults.dictionary(forKey: "herdr.names") as? [String: String] ?? [:] }
        set { defaults.set(newValue, forKey: "herdr.names") }
    }

    /// The relay ID each saved PC's own page said it has (HerdrShell identify), by its key.
    static var ids: [String: String] {
        get { defaults.dictionary(forKey: "herdr.ids") as? [String: String] ?? [:] }
        set { defaults.set(newValue, forKey: "herdr.ids") }
    }

    static var current: String? {
        get { defaults.string(forKey: "herdr.current") }
        set { defaults.set(newValue, forKey: "herdr.current") }
    }

    static var last: String? {
        get { defaults.string(forKey: "herdr.last") }
        set { defaults.set(newValue, forKey: "herdr.last") }
    }

    /// The address to open instead of the bare origin until a PC page loads: a pairing link keeps
    /// its `?pair=` code through Try again. In memory only, as it can hold that code.
    static var pendingStart: String?

    /// The connect screen is up to pick another way or PC, the current PC kept (HerdrShell chooseAnother): its button
    /// reopens that PC, and opening another replaces it. In memory only, so an app started again opens the current PC.
    static var choosing = false

    /// The PC the app shows: the current one, none while the connect screen is up to choose another way.
    static var shown: String? { choosing ? nil : current }

    /// Why the PC did not open, for the error page; cleared with its kind and command.
    static var failure: String? {
        didSet { if failure == nil { failureKind = nil; failureCommand = nil } }
    }

    /// An SSH PC's failure kind (`ssh-<kind>`, SshFailure) and the command that fixes it there, for error.html.
    static var failureKind: String?
    static var failureCommand: String?

    static func fail(_ reason: String, kind: String?, command: String? = nil) {
        failure = reason
        failureKind = kind
        failureCommand = command
    }

    /// Whether the app's first screen is the hosted Connect a PC screen (Home): OvisAppHome in Info.plist, the build's
    /// (hosted-origin.xcconfig), `bundled` in a build made with OVIS_APP_HOME=bundled, which keeps the app's own page.
    static var homeHosted: Bool { shellOrigin != nil && (Bundle.main.object(forInfoDictionaryKey: "OvisAppHome") as? String) != "bundled" }

    /// The shell inside the app did not open this time: home never drew and the person asked for the app's own page
    /// instead (the cover's Open the connect page). The app's own page says so in place of "no internet", until the
    /// shell draws again (shellDrew) or is asked for again (goHome). In memory only. A shell the build cannot serve
    /// at all is ShellHost.unavailable, which nothing clears.
    static var homeStuck = false

    /// Whether the app's own page says the app's own screens did not open (HerdrShell getState `stuck`, Home.shellStuck).
    static var shellStuck: Bool { Home.shellStuck(carries: shellBundled, serving: !ShellHost.unavailable, attempt: homeStuck) }

    /// A page of the shell inside the app came up: what an earlier attempt left is over.
    static func shellDrew() {
        homeStuck = false
    }

    /// The hosted Connect a PC screen did not load, so the app's own page stands in for it, until the person tries it
    /// again there (Try again) or a PC's page has loaded since: never by itself. In memory only: an app started again
    /// tries the hosted screen.
    static var homeFailed = false

    /// The bundled demo was asked for (HerdrShell openDemo) and is up until it is left. In memory only.
    static var demo = false

    /// Change PC was pressed where an SSH PC did not open: the app's own page, whose Manage holds what mends it
    /// (Forget host key, Set up again), which the hosted screen has not. In memory only.
    static var manage = false

    /// The fragment the next hosted screen starts at instead of `#pcs` (Home.homeStart: a sign-in the app's own page
    /// asked for), taken once by the view controller that opens it. In memory only.
    static var homeStart: String?

    /// How often the app's own page was built again because it did not come up (Home.ownPageStalled), until it does.
    static var ownPageTries = 0

    /// A web content process died under this attempt at the hosted screen, which was started over once (Home `died`);
    /// until that screen comes up or is asked for again.
    static var homeRetried = false

    /// Whether something waits that only the app's own Connect a PC page takes: an SSH PC whose address another app
    /// holds, which that page says, or an SSH PC to manage.
    static var bundledAsked: Bool { manage || failureKind == "ssh-port" }

    /// The hosted screen is to be tried again (Try again on the fallback, the back control of the app's own page):
    /// nothing is left that would keep the app's own page up.
    static func goHome() {
        homeFailed = false
        homeStuck = false
        homeRetried = false
        ownPageTries = 0
        demo = false
        manage = false
        homeStart = nil
        if failureKind == "ssh-port" { failure = nil }
    }

    /// The hosted app's front page asked for by its address (Home.homeStart): an attempt at the hosted screen,
    /// starting at `start`, which makes nothing the current PC. A PC that is current stays the one to go back to.
    static func homeAttempt(_ start: String) {
        goHome()
        homeStart = start
        if current != nil { choosing = true }
    }

    /// `key` becomes the PC the app opens, at `start` (HerdrShell open).
    static func open(_ key: String, start: String) {
        current = key
        last = key
        choosing = false
        demo = false
        manage = false
        homeStart = nil
        pendingStart = start
        failure = nil
        redirects = 0
    }

    /// The PC is left (Change PC): none is current. Where an SSH PC did not open (`unopened`), the app's own page
    /// comes for it (`manage`).
    static func leave(unopened: Bool) {
        manage = unopened && OvisSsh.pc(current) != nil
        current = nil
        choosing = false
    }

    /// A relay PC's page came up in the hosted screen (Home.Event.relayPc), which the app is not asked to open: the
    /// hosted app at `appOrigin` is the current PC from here on, as it is after a sign-in from the app's own page, so
    /// the next start is that PC's.
    static func keepHosted(_ appOrigin: String) {
        choosing = false
        current = appOrigin
        last = appOrigin
        if names[appOrigin] == nil { names[appOrigin] = "Ovis" }
    }

    /// Opens the SSH PC `origin` the setup screen just added or set up again.
    /// Saved at once (not only once its page loads, as other PCs are), so a first load that fails never leaves it to
    /// be forgotten with its host key and keys (OvisSshPlugin.forgetRemoved).
    static func openSsh(_ origin: String) {
        remember(origin)
        current = origin
        last = origin
        choosing = false
        demo = false
        manage = false
        homeStart = nil
        pendingStart = nil
        failure = nil
        redirects = 0
    }

    static var redirects = 0

    static let maxRedirects = 5

    static let probeBudget: TimeInterval = 10

    static let bridgeProtocols: ClosedRange<Int64> = 1...1

    /// The first origin of `path`, the way from the address being opened (`from`) to an Ovis server,
    /// that went over plain http the app should not switch to on its own: a public address (the
    /// connect screen warns before one, as `publicHttp` in app/web/shell.js) or any http after https.
    /// Nil when the whole way is fine.
    static func insecureHop(from: String?, path: [String]) -> String? {
        var https = from?.hasPrefix("https://") ?? false
        for hop in path {
            if hop.hasPrefix("https://") {
                https = true
            } else if https || publicHTTP(hop) {
                return hop
            }
        }
        return nil
    }

    /// Whether `origin` is plain http to an address outside a tailnet or a home network, as
    /// `publicHttp` in app/web/shell.js decides.
    static func publicHTTP(_ origin: String) -> Bool {
        guard origin.hasPrefix("http://") else { return false }
        guard let host = URL(string: origin)?.host?.lowercased() else { return true }
        let name = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        // a host whose last label is a number is an IPv4 address to the web view in any form
        // (134744072, 010.0.0.1, 0x8.8.8.8), which shell.js sees rewritten: only a plain dotted quad
        // is judged here, any other form counts as public
        let last = parts.last ?? ""
        let digits = !last.isEmpty && last.allSatisfy { ("0"..."9").contains($0) }
        let hex = last.lowercased().hasPrefix("0x") && last.dropFirst(2).allSatisfy { $0.isHexDigit && $0.isASCII }
        if digits || hex {
            let quad = parts.compactMap { part -> Int? in
                guard !part.isEmpty, part.count <= 3, part.allSatisfy({ ("0"..."9").contains($0) }), part == "0" || part.first != "0" else { return nil }
                return Int(part).flatMap { $0 <= 255 ? $0 : nil }
            }
            guard parts.count == 4, quad.count == 4 else { return true }
            let a = quad[0], b = quad[1]
            // 10/8, 127/8, 172.16/12, 192.168/16, link-local 169.254/16, and Tailscale's 100.64/10
            return !(a == 10 || a == 127 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) || (a == 169 && b == 254) || (a == 100 && (64...127).contains(b)))
        }
        // ::1, unique local fc00::/7 (Tailscale's fd7a:115c:a1e0::/48 among them) and link-local fe80::/10
        if name.contains(":") {
            return !(name == "::1" || name.hasPrefix("fc") || name.hasPrefix("fd") || ["fe8", "fe9", "fea", "feb"].contains { name.hasPrefix($0) })
        }
        // a one-word name (a MagicDNS short name, localhost) or a tailnet or home network name
        return name.contains(".") && ![".ts.net", ".local", ".lan", ".home.arpa", ".internal"].contains { name.hasSuffix($0) }
    }

    static func remember(_ key: String) {
        saved = [key] + saved.filter { $0 != key }
    }

    static func forget(_ key: String) {
        OvisPushPlugin.forgetEndpoint(key)
        saved = saved.filter { $0 != key }
        names[key] = nil
        ids[key] = nil
        if current == key { current = nil }
        if last == key { last = nil }
    }

    /// The key of a PC opened through the Ovis relay: `scope`, when it is an http or https origin with
    /// a path ending in `/` and `url` is on that origin within that path; nil otherwise.
    static func scopeKey(_ scope: String, for url: URL) -> String? {
        guard let scopeURL = URL(string: scope), let scopeOrigin = origin(of: scopeURL), scopeOrigin == origin(of: url),
              let path = URLComponents(string: scope)?.percentEncodedPath, path.count > 1, path.hasSuffix("/"),
              scope == scopeOrigin + path, belongs(url, to: scope) else { return nil }
        return scope
    }

    static func origin(ofKey key: String) -> String? {
        URL(string: key).flatMap { origin(of: $0) }
    }

    static func firstPage(_ key: String) -> String {
        key.hasSuffix("/") ? key : key + "/"
    }

    /// Whether `url` is a page of the PC `key`: on its origin, and for a relay PC within its scope, path
    /// segment by path segment and only as a browser would load it (ScopePath): `<scope>../<other>/`
    /// resolves to another PC. A PC saved by its origin takes any page of it.
    static func belongs(_ url: URL, to key: String) -> Bool {
        guard let pageOrigin = origin(of: url), pageOrigin == origin(ofKey: key) else { return false }
        let scope = URLComponents(string: key)?.percentEncodedPath ?? ""
        if scope.isEmpty || scope == "/" { return true }
        guard let path = URLComponents(url: url, resolvingAgainstBaseURL: true)?.percentEncodedPath else { return false }
        return ScopePath.within(path, scope: scope)
    }

    /// The key of the origin a page at `url` belongs to, or nil for an address that is no PC's (Home.pcOrigin):
    /// `scheme://host[:port]` of an http or https URL, the host in lowercase as WebKit reports it. In a build that
    /// serves the shell itself, also the shell's origin for a page of it (`capacitor://app.ovis.sh`), and there no web
    /// address at the hosted origin's host is a PC, on any port, so nothing opens the network's copy of the shell.
    static func origin(of url: URL) -> String? {
        Home.pcOrigin(url, hosted: appOrigin, shell: shellOrigin, bundled: shellBundled)
    }

    /// The origin of the Ovis server that `target` leads to, or nil. Asks `/api/health?scope=bridge`,
    /// which Ovis answers to anyone so a client can find its gate, and follows at most `maxRedirects`
    /// redirects of that request: a sign-in page, another site, a loop or no answer is not Ovis. Only
    /// such an origin may become the PC: Capacitor gives its bridge to every page the web view keeps.
    /// Gives up after `probeBudget` in all, however slowly the answers come, and reads at most 64 KB.
    /// `path` is each origin it asked, in order.
    static func ovisOrigin(leadingTo target: URL) async -> (ovis: String?, path: [String]) {
        let deadline = Date().addingTimeInterval(probeBudget)
        var next = origin(of: target)
        var path: [String] = []
        for _ in 0...maxRedirects {
            let left = deadline.timeIntervalSinceNow
            guard left > 0, let current = next, let health = URL(string: current + "/api/health?scope=bridge") else { return (nil, path) }
            path.append(current)
            // the request's own timeout is per pause in the answer; the session's ends it at the deadline
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForResource = left
            let session = URLSession(configuration: configuration)
            defer { session.invalidateAndCancel() }
            var request = URLRequest(url: health, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: min(5, left))
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            guard let (bytes, response) = try? await session.bytes(for: request, delegate: RefuseRedirects()),
                  let http = response as? HTTPURLResponse else { return (nil, path) }
            if (300..<400).contains(http.statusCode) {
                next = http.value(forHTTPHeaderField: "Location")
                    .flatMap { URL(string: $0, relativeTo: health) }
                    .flatMap { origin(of: $0.absoluteURL) }
                continue
            }
            guard http.statusCode == 200 else { return (nil, path) }
            var data = Data()
            do {
                for try await byte in bytes {
                    data.append(byte)
                    if data.count > 64 * 1024 { return (nil, path) }
                }
            } catch {
                return (nil, path)
            }
            return (answersAsOvis(data) ? current : nil, path)
        }
        return (nil, path)
    }

    /// Whether `data` is /api/health?scope=bridge as Ovis gives it: `ok` true, an `auth` object and a
    /// bridge protocol this app knows, in strict JSON (JSONSerialization lets a trailing comma pass and
    /// keeps the first of two equal names). JSON true and numbers both come as NSNumber: only a
    /// boolean true is ok, and only an integer a protocol (a boolean is a CFBoolean, a number too large
    /// for one a decimal number).
    static func answersAsOvis(_ data: Data) -> Bool {
        guard StrictJSON.valid(data), let answer = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ok = answer["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID(), ok.boolValue,
              answer["auth"] is [String: Any],
              let version = answer["bridge_protocol"] as? NSNumber, CFGetTypeID(version) == CFNumberGetTypeID(),
              !CFNumberIsFloatType(version), bridgeProtocols.contains(version.int64Value) else { return false }
        return true
    }

    /// `target`'s path, query and fragment on `origin`: a pairing link keeps its code when its
    /// server's /api/health redirected to another origin.
    static func start(on origin: String, for target: URL) -> String {
        guard let parts = URLComponents(url: target, resolvingAgainstBaseURL: true) else { return origin + "/" }
        let path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
        return origin + path + (parts.percentEncodedQuery.map { "?" + $0 } ?? "") + (parts.percentEncodedFragment.map { "#" + $0 } ?? "")
    }
}

/// Whether `data` is one JSON value (RFC 8259) and nothing more, with ASCII hex in its `\u`
/// escapes, nesting at most 32 deep and each object's names given once, as Android's PCStore reads
/// /api/health: JSONSerialization lets a trailing comma pass and keeps the first of two equal names.
enum StrictJSON {
    static func valid(_ data: Data) -> Bool {
        var reader = Reader(bytes: [UInt8](data))
        guard reader.value(depth: 0) else { return false }
        reader.space()
        return reader.at == reader.bytes.count
    }

    private struct Reader {
        let bytes: [UInt8]
        var at = 0

        mutating func space() {
            while at < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[at]) { at += 1 }
        }

        mutating func next() -> UInt8? {
            guard at < bytes.count else { return nil }
            at += 1
            return bytes[at - 1]
        }

        mutating func word(_ word: String) -> Bool {
            let expected = Array(word.utf8)
            guard bytes.count - at >= expected.count, Array(bytes[at..<at + expected.count]) == expected else { return false }
            at += expected.count
            return true
        }

        mutating func value(depth: Int) -> Bool {
            space()
            guard at < bytes.count else { return false }
            switch bytes[at] {
            case UInt8(ascii: "{"): return depth < 32 && object(depth: depth + 1)
            case UInt8(ascii: "["): return depth < 32 && array(depth: depth + 1)
            case UInt8(ascii: "\""): return string() != nil
            case UInt8(ascii: "t"): return word("true")
            case UInt8(ascii: "f"): return word("false")
            case UInt8(ascii: "n"): return word("null")
            case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return number()
            default: return false
            }
        }

        mutating func object(depth: Int) -> Bool {
            at += 1
            space()
            if at < bytes.count, bytes[at] == UInt8(ascii: "}") {
                at += 1
                return true
            }
            var names = Set<String>()
            while true {
                space()
                guard at < bytes.count, bytes[at] == UInt8(ascii: "\""), let name = string(), names.insert(name).inserted else { return false }
                space()
                guard next() == UInt8(ascii: ":"), value(depth: depth) else { return false }
                space()
                switch next() {
                case UInt8(ascii: "}"): return true
                case UInt8(ascii: ","): continue
                default: return false
                }
            }
        }

        mutating func array(depth: Int) -> Bool {
            at += 1
            space()
            if at < bytes.count, bytes[at] == UInt8(ascii: "]") {
                at += 1
                return true
            }
            while true {
                guard value(depth: depth) else { return false }
                space()
                switch next() {
                case UInt8(ascii: "]"): return true
                case UInt8(ascii: ","): continue
                default: return false
                }
            }
        }

        /// The string that starts at `at`, its escapes read, or nil: control characters only escaped,
        /// and an escape one of JSON's, `\u` with four ASCII hex digits.
        mutating func string() -> String? {
            let start = at
            at += 1
            while let byte = next() {
                switch byte {
                case UInt8(ascii: "\""):
                    // valid JSON from here on: JSONSerialization reads its escapes and its UTF-8
                    return try? JSONSerialization.jsonObject(with: Data(bytes[start..<at]), options: .fragmentsAllowed) as? String
                case 0x00..<0x20:
                    return nil
                case UInt8(ascii: "\\"):
                    switch next() {
                    case UInt8(ascii: "\""), UInt8(ascii: "\\"), UInt8(ascii: "/"), UInt8(ascii: "b"), UInt8(ascii: "f"), UInt8(ascii: "n"), UInt8(ascii: "r"), UInt8(ascii: "t"):
                        continue
                    case UInt8(ascii: "u"):
                        for _ in 0..<4 {
                            guard let hex = next(), (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(hex)
                                || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(hex) || (UInt8(ascii: "A")...UInt8(ascii: "F")).contains(hex) else { return nil }
                        }
                    default:
                        return nil
                    }
                default:
                    continue
                }
            }
            return nil
        }

        mutating func number() -> Bool {
            if bytes[at] == UInt8(ascii: "-") { at += 1 }
            if at < bytes.count, bytes[at] == UInt8(ascii: "0") {
                at += 1
            } else if !digits() {
                return false
            }
            if at < bytes.count, bytes[at] == UInt8(ascii: ".") {
                at += 1
                guard digits() else { return false }
            }
            if at < bytes.count, bytes[at] == UInt8(ascii: "e") || bytes[at] == UInt8(ascii: "E") {
                at += 1
                if at < bytes.count, bytes[at] == UInt8(ascii: "+") || bytes[at] == UInt8(ascii: "-") { at += 1 }
                guard digits() else { return false }
            }
            return true
        }

        mutating func digits() -> Bool {
            let start = at
            while at < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[at]) { at += 1 }
            return at > start
        }
    }
}

private final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Capacitor's view controller with the chosen PC as the WebView's first page. Reaching the PC
/// by navigating from the bundled connect page instead would cost every launch about 1.5 s
/// (docs/native-app.md, Spike results), so opening a PC builds a new one of these.
class HerdrBridgeViewController: CAPBridgeViewController {
    private var failureProxy: NavigationFailureProxy?
    private var openingView: UIView?
    /// Looks at the open five times a second while the cover is up (tick): gives up on a PC that has not
    /// answered, instead of WebKit's own wait of a minute or more, and tells a slow page.
    private var ticker: Timer?
    private var watch: OpeningWatch?
    private var openingSpinner: UIActivityIndicatorView?
    private var openingBar: UIProgressView?
    private var openingLabel: UILabel?
    private var openingRetry: UIButton?
    private var openingName = ""
    private var gaveUp = false

    /// Asked of the PC's page while the cover is up: whether the client is up, its root no longer
    /// holding index.html's loading spinner, or the page is no client at all (no root). The PC
    /// answers before its page commits, and until then the web view holds its first, empty
    /// document (about:blank), which has no root either: only an http(s) page counts, and in a build
    /// that serves the shell itself a page of the shell (its host is letters, digits, dots and hyphens:
    /// Home.shellOrigin).
    private static let clientUpScript: String = {
        let shell = PCStore.shellBundled ? PCStore.shellOrigin?.host : nil
        let inApp = shell.map { "(location.protocol === '\(Home.appScheme):' && location.host === '\($0)')" } ?? "false"
        return """
        (() => {
          if (!(/^https?:$/.test(location.protocol) || \(inApp)) || document.readyState === 'loading') return false;
          const root = document.getElementById('root');
          return !root || !root.querySelector(':scope > .boot');
        })()
        """
    }()
    private var firstPageDone = false
    private static let answerSeconds = 20
    private static let demoPage = "demo/index.html"

    /// What this view controller opens as its first page (Home.screen), decided as it is made, and the key of what it
    /// opens: the PC's, or the hosted app's origin for the hosted Connect a PC screen, which opens as a PC's first page
    /// does without being made the current PC.
    private let screen: Home.Screen
    private let opened: String?

    /// Where the hosted screen is, in a view controller that opened it (Home.Phase); nil in any other. Its failures
    /// give way to the app's own page, never to error.html, and a relay PC's page coming up in it makes the hosted app
    /// the current PC.
    private var phase: Home.Phase?

    /// How long the hosted screen has been loading with the app in front (tick).
    private var homeClock = Home.Clock(now: 0)
    /// The fragment the hosted screen starts at: `#pcs`, the hosted app's front page as the app's own way there (not a
    /// launch that goes on to the PC opened last), or what the app's own page asked for (a sign-in).
    private let homeStart: String
    /// The PC that was current when the hosted screen opened: a relay PC's page landing later makes the hosted app the
    /// PC only over that one.
    private let homeOver: String?
    private var urlWatch: NSKeyValueObservation?
    private var frontWatch: [NSObjectProtocol] = []
    /// Looks twice a second whether the app's own page came up (watchOwnPage), and whether it answered that it did.
    private var ownPageWatch: Timer?
    private var ownPageUp = false
    private var openingChange: UIButton?
    /// On the cover over home in a build that serves the shell itself, once home has not drawn for a while
    /// (Home.ownPageOffer): the app's own page instead.
    private var openingOwnPage: UIButton?

    /// Asked of the hosted screen's page while its cover is up: what the page is, as facts for Home.drawn to judge,
    /// so an empty answer or another page of the hosted origin never counts as the hosted screen.
    private static let homeScript = """
        (() => {
          const root = document.getElementById('root');
          return JSON.stringify({
            shell: document.querySelector('meta[name="ovis-shell"]') !== null,
            root: root !== null,
            boot: root !== null && root.querySelector(':scope > .boot') !== null,
            children: root === null ? 0 : root.childElementCount,
            loading: document.readyState === 'loading'
          });
        })()
        """

    /// What to open now, from what the app holds (PCStore).
    private static func start() -> (screen: Home.Screen, opened: String?) {
        // a key no page of this build has (a relay PC saved by a build that served the shell itself) opens nothing
        let pc = PCStore.shown.flatMap { key in PCStore.origin(ofKey: key) == nil ? nil : key }
        let screen = Home.screen(hosted: PCStore.homeHosted, pc: pc != nil, demo: PCStore.demo, asked: PCStore.bundledAsked, failed: PCStore.homeFailed)
        switch screen {
        case .pc: return (screen, pc)
        case .home: return (screen, PCStore.shellOrigin.flatMap { PCStore.origin(of: $0) })
        case .bundled, .demo: return (screen, nil)
        }
    }

    init() {
        (screen, opened) = Self.start()
        phase = screen == .home ? .loading : nil
        homeStart = PCStore.homeStart ?? "#pcs"
        homeOver = PCStore.current
        if screen == .home { PCStore.homeStart = nil }
        super.init(nibName: nil, bundle: nil)
    }

    /// Main.storyboard names this class too: UIKit makes one there, which never shows (SceneDelegate puts its own
    /// window in), so it takes nothing that is kept for the one that does.
    required init?(coder: NSCoder) {
        (screen, opened) = Self.start()
        phase = screen == .home ? .loading : nil
        homeStart = "#pcs"
        homeOver = PCStore.current
        super.init(coder: coder)
    }

    /// Whether the hosted Connect a PC screen is what this view controller shows or is opening.
    var atHome: Bool { phase == .loading || phase == .shown }

    /// Whether this view controller shows the app's own page in place of the hosted screen, which did not load.
    var fallback: Bool { screen == .bundled && PCStore.homeHosted && PCStore.homeFailed }

    /// Whether the app's own page was asked for to manage an SSH PC (PCStore.manage), which opens it on SSH.
    var manages: Bool { screen == .bundled && PCStore.manage }

    /// Whether a PC's own page is what this view controller shows (Home.pcShown): the PC whose push subscription the
    /// page may read, and where an SSH tunnel's failure may put its error page. While the person chooses another way
    /// that PC is still current, but what is on screen is the hosted screen or the app's own page.
    var showsPc: Bool { !replaced && Home.pcShown(screen: screen, phase: phase) }

    /// The app is replacing this view controller (leave): it is on its way out, though it may stay a moment longer.
    private var replaced = false

    /// The address of a PC's page this view controller shows when it is up: its cover lifted, and the app not on its
    /// way to another screen. Nil for any other (the error page, the hosted screen, the app's own page).
    private var pcPageUp: URL? {
        guard showsPc, openingView == nil, let url = webView?.url, !Home.bundledPage(url) else { return nil }
        return url
    }

    /// For the page's own back control (HerdrShell getState `back`): "current", "home" or "".
    var backWay: String {
        let current = PCStore.current != nil
        switch Home.back(screen: phase == .pc ? .pc : screen, hosted: PCStore.homeHosted, failed: PCStore.homeFailed, current: current, choosing: PCStore.choosing && current, pageHasBack: false) {
        case .current: return "current"
        case .home: return "home"
        case .page, .demoExit, .leave: return ""
        }
    }

    /// Something happened to the hosted screen: what Home decides is carried out here, and nowhere else.
    private func home(_ event: Home.Event) {
        guard let phase else { return }
        // a relay PC's page landing after something else became the PC (another screen's write) counts for nothing
        if event == .relayPc, homeOver != PCStore.current { return }
        let action = Home.on(phase, event, retried: PCStore.homeRetried)
        self.phase = Home.after(phase, event, retried: PCStore.homeRetried)
        switch action {
        case .liftCover:
            PCStore.homeRetried = false
            PCStore.shellDrew()
            hideOpening()
        case .fallBack:
            // this view controller goes with its web view, so a load that still finishes cannot bring the hosted
            // screen back over what the person types on the app's own page
            PCStore.homeFailed = true
            PCStore.homeRetried = false
            ticker?.invalidate()
            webView?.stopLoading()
            HerdrBridgeViewController.reopen()
        case .keepHosted:
            if let opened { PCStore.keepHosted(opened) }
            // a cover still up is a PC's from here on, with its Change PC
            openingChange?.isHidden = false
        case .retry:
            // the hosted screen from the start, in a new web view with its cover and clock: WebKit's own reload of
            // the dead page has nothing timing it
            PCStore.homeRetried = true
            ticker?.invalidate()
            HerdrBridgeViewController.reopen()
        case .none:
            break
        }
    }

    /// The app is going to another screen (reopen): what the hosted screen's page still does counts for nothing, and
    /// its clock stops. Whatever the page, it is handed no alert from here on.
    private func leave() {
        replaced = true
        failureProxy?.left = true
        ticker?.invalidate()
        ownPageWatch?.invalidate()
        urlWatch?.invalidate()
        guard let phase else { return }
        self.phase = Home.after(phase, .left)
    }

    /// What the navigation delegate reports about a main-frame load, while the hosted screen is up: true when it was
    /// the hosted screen's to act on (Home.event), so the PC's own handling (error.html) leaves it alone.
    private func homeSignal(_ signal: Home.Signal) -> Bool {
        guard let phase, phase != .pc else { return false }
        if let event = Home.event(for: signal) { home(event) }
        return true
    }

    private func arrived(_ webView: WKWebView) {
        if Home.relayPc(webView.url, appOrigin: PCStore.shellOrigin) { home(.relayPc) }
    }

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        // behind every first page before it paints, the app's own page included (capacitor.config.json has one colour)
        descriptor.backgroundColor = Self.pageColor
        if let origin = opened, let host = URL(string: origin)?.host {
            // what server.url sets; the pairing link until a PC page has loaded, the PC's first page
            // after it (a relay PC's scope keeps a pairing offer's `#offer=` fragment through here).
            // The hosted screen is the hosted app's front page as the app's own way there (#pcs), not a
            // launch that goes on to the PC opened last. In a build that serves the shell itself these
            // are addresses on the app's own scheme (capacitor://app.ovis.sh/…), which ShellHost answers
            descriptor.serverURL = screen == .home ? origin + "/" + homeStart : PCStore.pendingStart ?? PCStore.firstPage(origin)
            // the whole PC is the app: its own links stay in the WebView, others go to Safari. For a
            // relay PC that host is the hosted shell's (app.ovis.sh), the one the app then allows; where
            // the shell is inside the app, a link to that host over https is turned to its page there
            // (NavigationFailureProxy), never loaded from the network
            descriptor.allowedNavigationHostnames = descriptor.allowedNavigationHostnames + [host]
        } else if screen == .demo, FileManager.default.fileExists(atPath: descriptor.appLocation.appendingPathComponent(Self.demoPage).path) {
            // the bundled demo as the first page (HerdrShell openDemo); Capacitor ends the app on a start page that is missing
            descriptor.appStartPath = Self.demoPage
        }
        return descriptor
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // a PC on a plain http address (a tailnet or LAN IP) is opened as typed: with the system's
        // https-first try, every load of one waited about 2 s before it started
        configuration.upgradeKnownHostsToHTTPS = false
        if #available(iOS 18.2, *) {
            configuration.defaultWebpagePreferences.preferredHTTPSNavigationPolicy = .keepAsRequested
        }
        return configuration
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        WebViewWithoutFormBar(frame: frame, configuration: configuration)
    }

    /// This web view would answer the shell without ShellHost in front (ShellHost.verify): it loads nothing, and the
    /// app's own page comes in its place.
    private var refused = false

    override func capacitorDidLoad() {
        // before the first page loads: what answers the app's scheme in this web view is what ShellHost put there
        // (once: the web views after a refused one are not checked against a shell that is no longer served, so
        // what comes in its place, the app's own page, loads)
        if !ShellHost.verify(webView) {
            refused = true
            DispatchQueue.main.async { HerdrBridgeViewController.reopen() }
        }
        bridge?.registerPluginInstance(HerdrShellPlugin())
        bridge?.registerPluginInstance(OvisPushPlugin())
        bridge?.registerPluginInstance(OvisAuthPlugin())
        bridge?.registerPluginInstance(OvisDirectPlugin())
        if OvisSsh.supported { bridge?.registerPluginInstance(OvisSshPlugin()) }
        // on the web view's own content controller (Capacitor puts its own in the configuration it is given), before
        // the first page loads
        if let rules = Self.loopbackRules { webView?.configuration.userContentController.add(rules) }
        if let handler = (bridge as? CapacitorBridge)?.webViewDelegationHandler { DirectCallGate.install(on: handler) }
        tellShell()
        followPageColor()
    }

    /// In a build that serves the shell itself, every main-frame document of the shell is told so before its first
    /// script runs (`window.__ovisAppShell`, Home.appShellScript): the main frame alone, as a page drawn in a frame
    /// (the render host, on the shell's own origin) is no client, and nothing it reads or writes there counts for
    /// anything. A build that loads the shell from the network says nothing.
    private func tellShell() {
        guard PCStore.shellBundled, let controller = webView?.configuration.userContentController else { return }
        let info = Bundle.main.infoDictionary ?? [:]
        guard let script = Home.appShellScript(shell: PCStore.shellOrigin, version: info["CFBundleShortVersionString"] as? String ?? "",
                                               build: (info["CFBundleVersion"] as? String).flatMap { Int($0) } ?? 0) else { return }
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    /// What the document on show said its colour is, as the status bar icons that stand out on it; nil until it
    /// said: a new document starts with nothing (Bars.page).
    private var pageIcons: Bars.Icons?

    /// Run in every main-frame document as it starts: tells the app the page's `<meta name="theme-color">`, once the
    /// document is read and again whenever it changes (a theme picked in Settings, the phone going dark, a meta
    /// that becomes or stops being the theme-color), as MainActivity's BAR_COLOR_SCRIPT does on Android. A page with
    /// none says so, and gets the app's own icons. Before any of that it says a new document started (null): the
    /// colour of the document before it is not this one's, while a load that has not replaced the page yet says
    /// nothing and the page still on show keeps its icons. A document that comes back from the page cache does
    /// not start again, so it says its colour again.
    private static let barsScript = """
        (() => {
          if (window !== window.top) return;
          const bars = window.webkit.messageHandlers.ovisBars;
          bars.postMessage(null);
          let last = null;
          const send = () => {
            const meta = document.querySelector('meta[name="theme-color"]');
            const color = meta ? meta.content : '';
            if (color === last) return;
            last = color;
            bars.postMessage(color);
          };
          const follow = () => {
            send();
            new MutationObserver(send).observe(document.head ?? document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['content', 'name'] });
          };
          if (document.readyState === 'loading') addEventListener('DOMContentLoaded', follow, { once: true });
          else follow();
          addEventListener('pageshow', (event) => {
            if (!event.persisted) return;
            last = null;
            send();
          });
        })();
        """

    /// The status bar's icons follow the page: light on a dark page, dark on a light one (Bars), where they were
    /// light for every PC and for the hosted app whatever its theme, so white on white in a light one. One way for
    /// every page of the web view, the app's own included; on the web view's own content controller, before the
    /// first page loads.
    private func followPageColor() {
        guard let controller = webView?.configuration.userContentController else { return }
        controller.addUserScript(WKUserScript(source: Self.barsScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(PageColorMessages { [weak self] body in
            guard let self else { return }
            self.pageIcons = Bars.page(self.pageIcons, said: body)
            self.applyBars()
        }, name: "ovisBars")
    }

    /// Sets the icons for what is on screen now: a cover over the page by its own colour, as the page under it does
    /// not show, else the page's, else, for a document that has not said its colour yet, the web view's own, which
    /// is what shows until a page paints (Bars.icons(cover:page:ground:)).
    private func applyBars() {
        let cover = openingView.flatMap { Self.icons(on: $0.backgroundColor, in: traitCollection) }
        let ground = Self.icons(on: webView?.backgroundColor, in: traitCollection)
        let style: UIStatusBarStyle = Bars.icons(cover: cover, page: pageIcons, ground: ground) == .dark ? .darkContent : .lightContent
        if statusBarStyle != style { setStatusBarStyle(style) }
    }

    /// The icons that stand out on a native view of `color`, as it resolves in light or dark mode; nil for none.
    private static func icons(on color: UIColor?, in traits: UITraitCollection) -> Bars.Icons? {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        guard let color, color.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha), alpha > 0 else { return nil }
        return Bars.icons(red: Double(red), green: Double(green), blue: Double(blue))
    }

    /// The phone went light or dark: a cover or a web view whose colour follows it changes under the icons.
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        applyBars()
    }

    override func viewDidLoad() {
        // nothing loads in a web view that would answer the shell without its policy: super is what starts the load
        if refused { return }
        // before super, which starts the first load
        if let webView = webView, opened != nil {
            let proxy = NavigationFailureProxy(inner: webView.navigationDelegate) { [weak self] webView, reason, kind in
                self?.showFailure(in: webView, reason: reason, kind: kind)
            }
            proxy.onAnswer = { [weak self] in self?.watch?.answer(at: ProcessInfo.processInfo.systemUptime) }
            proxy.onLoaded = { [weak self, weak webView] in
                guard let self else { return }
                self.firstPageDone = true
                if self.showsPc, let url = webView?.url, let current = PCStore.current, PCStore.belongs(url, to: current) {
                    // a PC's page is up: the next Connect a PC tries the hosted screen again
                    PCStore.homeFailed = false
                    // a relay PC picked on the hosted screen is kept by its own scope too, as one opened from a
                    // pairing link is
                    if self.phase == .pc, let scope = Home.relayScope(url, appOrigin: PCStore.shellOrigin) { PCStore.remember(scope) }
                }
                self.askPage()
            }
            // a first page that broke off after it started: the error page; one cancelled on purpose
            // leaves the cover up, which the timeout turns into Try again. Only the PC's answer or a
            // finished page takes the cover away: while a PC's connection hangs, WebKit showed
            // error.html half-loaded, its script not run and its buttons dead.
            proxy.onPageFailed = { [weak self] webView, reason, kind in
                // the PC's first page only (the cover may be gone once the PC answered), never the
                // bundled error page, which would load itself again
                guard let self, !self.firstPageDone, let reason, webView.url.flatMap({ PCStore.origin(of: $0) }) != nil else { return }
                self.showFailure(in: webView, reason: reason, kind: kind)
            }
            proxy.opened = opened
            // the hosted screen's failures are its own to act on, whenever they come: before the PC's handling
            proxy.onSignal = { [weak self] signal in self?.homeSignal(signal) ?? false }
            // a PC's row on the hosted screen is the page's own link, which the app is not asked to open: the page
            // that committed says when one came up, and so does the web view's address for a step within the page
            // (while a load is under way that address is the one being tried, which may still fail)
            if phase != nil {
                proxy.onCommitted = { [weak self] webView in self?.arrived(webView) }
                urlWatch = webView.observe(\.url) { [weak self] webView, _ in
                    if !webView.isLoading { self?.arrived(webView) }
                }
            }
            failureProxy = proxy
            webView.navigationDelegate = proxy
        }
        super.viewDidLoad()
        // where this page stands in for the hosted screen; a build whose first screen it is opens it as it always did
        if screen == .bundled, PCStore.homeHosted, webView != nil { watchOwnPage() }
        if webView != nil, let origin = opened {
            showOpening(origin, home: phase != nil)
            let now = ProcessInfo.processInfo.systemUptime
            homeClock = Home.Clock(now: now)
            watch = OpeningWatch(now: now, answerLimit: TimeInterval(Self.answerSeconds))
            // the time the app is away does not count against the hosted screen, though its timer may run on there
            if phase != nil {
                frontWatch = [
                    NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                        self?.homeClock.away(now: ProcessInfo.processInfo.systemUptime)
                    },
                    NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
                        self?.homeClock.resumed(now: ProcessInfo.processInfo.systemUptime)
                    }
                ]
            }
            // often enough that the cover lifts within a fifth of a second of the client's first frame
            ticker = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in self?.tick(origin) }
        }
    }

    /// The app's own page is what stands in when the hosted screen fails, so it must never be a dark screen itself.
    /// Seen in a simulator starved of CPU: after the hosted screen was given up, the new web view committed index.html
    /// and its content process then ran nothing more, for minutes, with this app's main thread idle (and the same on
    /// the cover of a PC, which at least says so). So the page is asked whether it is up: until it answers, a native
    /// cover says the app is opening, with Try again, and the web view is built again, each time with more room
    /// (Home.ownPageCover, Home.ownPageStalled).
    private func watchOwnPage() {
        var clock = Home.Clock(now: ProcessInfo.processInfo.systemUptime)
        let tries = PCStore.ownPageTries
        let look: (Timer?) -> Void = { [weak self] timer in
            guard let self, let webView = self.webView, self.view.window != nil || timer == nil else {
                timer?.invalidate()
                return
            }
            // only in front: a page is neither judged nor built again behind another app
            guard UIApplication.shared.applicationState != .background else {
                clock.resumed(now: ProcessInfo.processInfo.systemUptime)
                return
            }
            if self.ownPageUp {
                timer?.invalidate()
                PCStore.ownPageTries = 0
                self.hideOpening()
                return
            }
            let elapsed = clock.tick(now: ProcessInfo.processInfo.systemUptime)
            if Home.ownPageStalled(elapsed: elapsed, loaded: false, tries: tries) {
                timer?.invalidate()
                PCStore.ownPageTries = tries + 1
                HerdrBridgeViewController.reopen()
                return
            }
            if self.openingView == nil, Home.ownPageCover(elapsed: elapsed, loaded: false, tries: tries) {
                self.showOpening("", home: true)
                // Try again here builds the web view again at once
                self.openingRetry?.isHidden = false
            }
            // a content process that runs answers; one that does not never calls back
            webView.evaluateJavaScript("document.readyState !== 'loading' && location.protocol === 'capacitor:'") { [weak self] up, _ in
                if (up as? Bool) == true { self?.ownPageUp = true }
            }
        }
        look(nil)
        ownPageWatch = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { timer in look(timer) }
    }

    deinit {
        ticker?.invalidate()
        ownPageWatch?.invalidate()
        urlWatch?.invalidate()
        frontWatch.forEach { NotificationCenter.default.removeObserver($0) }
    }

    private func tick(_ origin: String) {
        guard let webView, openingView != nil, !gaveUp, var watch else { return }
        let now = ProcessInfo.processInfo.systemUptime
        watch.progress(webView.estimatedProgress)
        let stage = watch.stage(at: now)
        let shown = watch.shownProgress()
        self.watch = watch
        // a page the app serves itself waits on no network: no clock gives up on it, and Try again is all a cover
        // that stays (a web content process that runs nothing) has to offer
        let inApp = PCStore.inApp(origin)
        if phase == .loading {
            // only time in front counts (Home.Clock): a page that came up while the app was away is asked (askPage)
            // before the time it was away could count against it
            let waited = homeClock.tick(now: now)
            if Home.timedOut(elapsed: waited, answered: watch.answered, inApp: inApp) {
                home(.timedOut)
                return
            }
            // home inside the app that has not drawn: no clock gives up on it, the person may
            if inApp, Home.ownPageOffer(elapsed: waited) { openingOwnPage?.isHidden = false }
        } else if stage == .noAnswer, !inApp {
            // said on the cover itself: while the PC's connection hangs, WebKit did not show the
            // error page either (it stayed unpainted), in this web view or a new one
            gaveUp = true
            webView.stopLoading()
            showNoAnswer(origin)
            return
        }
        showStage(inApp && stage == .noAnswer ? .slow : stage, shown: shown, answered: watch.answered, inApp: inApp)
        askPage()
    }

    private func askPage() {
        guard let webView, openingView != nil, !gaveUp else { return }
        // the hosted screen is no current PC: its own key says which pages are its
        guard let url = webView.url, let key = phase == nil ? PCStore.current : opened, PCStore.belongs(url, to: key) else {
            // the hosted screen's cover lifts over the hosted screen alone
            if firstPageDone, phase == nil || phase == .pc { hideOpening() }
            return
        }
        if phase == .loading {
            webView.evaluateJavaScript(Self.homeScript) { [weak self] page, _ in
                if Home.drawn(page: page as? String) { self?.home(.loaded) }
            }
            return
        }
        guard phase == nil || phase == .pc else { return }
        webView.evaluateJavaScript(Self.clientUpScript) { [weak self] up, _ in
            guard (up as? Bool) == true else { return }
            // a relay PC's page of the shell inside the app is the shell drawing too
            if PCStore.inApp(self?.opened) { PCStore.shellDrew() }
            self?.hideOpening()
        }
    }

    private func showStage(_ stage: OpeningWatch.Stage, shown: Double, answered: Bool, inApp: Bool) {
        let ko = Self.korean
        switch stage {
        case .slow where !inApp:
            openingLabel?.text = ko ? "연결이 느립니다. \(openingName) 여는 중…" : "Slow connection. Still opening \(openingName)…"
        case .opening, .noAnswer, .slow:
            openingLabel?.text = ko ? "\(openingName) 여는 중…" : "Opening \(openingName)…"
        }
        openingBar?.isHidden = !answered
        openingBar?.setProgress(Float(shown), animated: true)
        openingSpinner?.isHidden = answered
        openingRetry?.isHidden = stage != .slow
    }

    private static var korean: Bool { Locale.preferredLanguages.first?.lowercased().hasPrefix("ko") ?? false }

    /// The hosted Connect a PC screen's colours (the Codex theme of src/styles.css, as app/web/shell.css copies them),
    /// light or dark as the phone is: behind the web view before a page paints, and on the covers.
    private static func look(_ light: UInt32, _ dark: UInt32) -> UIColor {
        let rgb = { (value: UInt32) in UIColor(red: CGFloat(value >> 16 & 0xff) / 255, green: CGFloat(value >> 8 & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1) }
        return UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) }
    }
    static let pageColor = look(0xffffff, 0x181818)
    static let textColor = look(0x1a1c1f, 0xececec)
    private static let dimColor = look(0x5d6067, 0xa3a3a3)
    static let strongColor = look(0x0d0d0d, 0xffffff)
    static let accentColor = look(0x3a83f7, 0x3a83f7)
    private static let borderColor = look(0xe5e5e5, 0x2e2e2e)

    /// The cover until the first page shows. `home`: over the hosted screen, which is no PC: "Opening Ovis…", and no Change PC.
    private func showOpening(_ origin: String, home: Bool) {
        let host = home ? "Ovis" : PCStore.names[origin] ?? URL(string: origin)?.host ?? origin
        let cover = UIView(frame: view.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = Self.pageColor

        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = Self.dimColor
        spinner.startAnimating()
        let label = UILabel()
        label.text = Self.korean ? "\(host) 여는 중…" : "Opening \(host)…"
        label.textColor = Self.textColor
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        label.textAlignment = .center
        let change = UIButton(type: .system, primaryAction: UIAction(title: Self.korean ? "PC 바꾸기" : "Change PC") { _ in
            // an SSH PC is mended on the app's own page (its Manage), which the hosted screen has not
            PCStore.leave(unopened: true)
            HerdrBridgeViewController.reopen()
        })
        change.tintColor = Self.strongColor
        change.titleLabel?.font = .preferredFont(forTextStyle: .body)
        change.isHidden = home
        let retry = UIButton(type: .system, primaryAction: UIAction(title: Self.korean ? "다시 시도" : "Try again") { _ in
            PCStore.failure = nil
            HerdrBridgeViewController.reopen()
        })
        retry.tintColor = Self.accentColor
        retry.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retry.isHidden = true
        let ownPage = UIButton(type: .system, primaryAction: UIAction(title: Self.korean ? "연결 화면 열기" : "Open the connect page") { _ in
            // the shell's own screen did not come up: the app's own page, from the app's files, never the network's copy
            PCStore.homeFailed = true
            PCStore.homeStuck = true
            HerdrBridgeViewController.reopen()
        })
        ownPage.tintColor = Self.strongColor
        ownPage.titleLabel?.font = .preferredFont(forTextStyle: .body)
        ownPage.isHidden = true
        let bar = UIProgressView(progressViewStyle: .default)
        bar.progressTintColor = retry.tintColor
        bar.trackTintColor = Self.borderColor
        bar.isHidden = true
        bar.translatesAutoresizingMaskIntoConstraints = false

        let stack = UIStackView(arrangedSubviews: [spinner, bar, label, retry, ownPage, change])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = false
        scroll.addSubview(stack)
        cover.addSubview(scroll)
        let content = scroll.contentLayoutGuide, frame = scroll.frameLayoutGuide
        let fill = content.heightAnchor.constraint(equalTo: frame.heightAnchor)
        fill.priority = .defaultLow
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: cover.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: cover.safeAreaLayoutGuide.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: cover.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: cover.safeAreaLayoutGuide.trailingAnchor),
            content.widthAnchor.constraint(equalTo: frame.widthAnchor),
            content.heightAnchor.constraint(greaterThanOrEqualTo: frame.heightAnchor),
            fill,
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.topAnchor.constraint(greaterThanOrEqualTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            bar.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
        view.addSubview(cover)
        openingView = cover
        openingSpinner = spinner
        openingLabel = label
        openingRetry = retry
        openingChange = change
        openingOwnPage = ownPage
        openingBar = bar
        openingName = host
        applyBars()
    }

    private func showNoAnswer(_ origin: String) {
        let host = URL(string: origin)?.host ?? origin
        var text = PCStore.failure.map { "\(host): \($0)" } ?? (Self.korean
            ? "\(host)이(가) \(Self.answerSeconds)초 안에 응답하지 않았습니다."
            : "\(host) did not answer within \(Self.answerSeconds) seconds.")
        if PCStore.failure == nil, !OpeningWatch.homeHost(host) {
            text += Self.korean
                ? "\n\n서버가 꺼져 있거나, 이 휴대폰의 연결(또는 VPN)이 서버에 닿지 않을 수 있습니다."
                : "\n\nThe server may be down, or this phone's connection (or a VPN on it) may not reach it."
        } else if Self.tailnet(host) {
            text += Self.korean
                ? "\n\nTailscale 주소입니다. 이 휴대폰에서 Tailscale이 꺼져 있을 수 있습니다. Tailscale 앱에서 연결을 켠 뒤 다시 시도를 누르세요."
                : "\n\nThis is a Tailscale address, and Tailscale may be off on this phone. Turn it on in the Tailscale app, then tap Try again."
        } else {
            text += Self.korean
                ? "\n\nPC가 켜져 있는지, 거기서 Ovis가 실행 중인지, 이 휴대폰이 PC에 닿을 수 있는지 확인하세요."
                : "\n\nCheck that the PC is on, that Ovis runs there, and that this phone can reach it."
        }
        openingSpinner?.stopAnimating()
        openingSpinner?.isHidden = true
        openingBar?.isHidden = true
        openingLabel?.text = text
        openingRetry?.isHidden = false
    }

    /// A MagicDNS name or a Tailscale IP (100.64.0.0/10, fd7a:115c:a1e0::/48), which opens only
    /// while Tailscale is connected on the phone; error.html has the same test.
    private static func tailnet(_ host: String) -> Bool {
        let name = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        if name.hasSuffix(".ts.net") || name.hasPrefix("fd7a:115c:a1e0:") { return true }
        let parts = name.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 100 && (64...127).contains(parts[1])
    }

    private func hideOpening() {
        ticker?.invalidate()
        ticker = nil
        openingView?.removeFromSuperview()
        openingView = nil
        applyBars()
    }

    /// `reason` nil keeps the reason an SSH PC's tunnel gave (its 503 says less); `kind` "offline" when the system says
    /// this phone has no internet (Home.failureKind), which error.html says instead of blaming the PC.
    private func showFailure(in webView: WKWebView, reason: String?, kind: String? = nil) {
        // the hosted screen's failures went to Home first (homeSignal): never the error page of a PC over it
        guard !replaced, phase == nil || phase == .pc, let local = bridge?.config.localURL else { return }
        // the timeout stays armed: if WebKit does not get the error page up either, the cover says it
        if let reason { PCStore.fail(reason, kind: kind) }
        webView.load(URLRequest(url: local.appendingPathComponent("error.html")))
    }

    /// An SSH PC's tunnel stopped (its host key changed, its key refused): the error page says so now, as the page
    /// alone would only keep reconnecting.
    static func showSshStop() {
        // only over that PC's own page: while the person chooses another way it is still current, but what is on
        // screen is the hosted screen or the app's own page, which this failure is not about
        guard let shown = window?.rootViewController as? HerdrBridgeViewController, shown.showsPc, let webView = shown.webView,
              let local = shown.bridge?.config.localURL, webView.url?.scheme != local.scheme else { return }
        webView.load(URLRequest(url: local.appendingPathComponent("error.html")))
    }

    private static var window: UIWindow? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        return (scene?.delegate as? SceneDelegate)?.window
    }

    /// Run in a PC's page the app is about to replace: the client keeps the pane state it holds in memory alone in
    /// storage for the next page of its address (src/lib/paneLifetime.ts carry), never sending it.
    private static let leavingScript = "window.dispatchEvent(new Event('ovis-page-leaving'))"
    private static let leavingWait: TimeInterval = 1

    /// The alert whose PC opens once the page on screen has kept what it holds in memory alone (carryThenOpen): a later
    /// tap meanwhile takes its place.
    private static var carrying: Alert.Link?

    /// Only the most recent tap may fall back to loading an address if its JavaScript did not run.
    private static var alertAttempt: UUID?

    /// A tapped alert (OvisPushPlugin.tapped, `stored` the key its endpoint was kept under): its pane on the saved PC
    /// that sent it (Alert.link). The page of that PC on screen and up is handed the pane, nothing loaded; otherwise that
    /// PC opens at the alert's address, as a PC picked does, after a PC's page on screen kept what it holds in memory
    /// alone. Nothing happens for an alert that names no pane or no saved PC, nor while a sheet is over the page (an
    /// SSH setup, the scanner), which stays as the person left it. Before the app's first screen is made (a tap that
    /// launched the app) that PC is only made the one it opens.
    static func openAlert(_ alert: Alert.Payload, stored: String?) {
        guard let link = Alert.link(saved: PCStore.saved, stored: stored, alert: alert, shell: PCStore.shellOrigin,
                                    knownServerId: stored.flatMap { PCStore.ids[$0] }) else { return }
        guard let root = window?.rootViewController else {
            PCStore.open(link.pc, start: link.address)
            return
        }
        if root.presentedViewController != nil { return }
        let attempt = UUID()
        alertAttempt = attempt
        if carrying != nil {
            carrying = link
            return
        }
        let shown = root as? HerdrBridgeViewController
        let page = shown?.pcPageUp
        if let shown, let webView = shown.webView, let page,
           Alert.handsToPage(link, shown: page.absoluteString, belongs: PCStore.belongs(page, to: link.pc)) {
            webView.evaluateJavaScript(Alert.selectionScript(link.selection)) { [weak shown] ran, _ in
                // a page that could not run it (its web content process gone): the alert's address
                guard (ran as? Bool) != true, alertAttempt == attempt, let shown, !shown.replaced,
                      shown.presentedViewController == nil, PCStore.saved.contains(link.pc) else { return }
                PCStore.open(link.pc, start: link.address)
                reopen()
            }
            return
        }
        guard let shown, let webView = shown.webView, page != nil else {
            PCStore.open(link.pc, start: link.address)
            reopen()
            return
        }
        shown.carryThenOpen(link, from: webView)
    }

    /// Opens `link`'s PC once the page in `webView` kept what it holds in memory alone, or a second on, whichever comes
    /// first: a page that does not answer keeps the alert waiting no longer.
    private func carryThenOpen(_ link: Alert.Link, from webView: WKWebView) {
        Self.carrying = link
        var done = false
        let open = { [weak self] in
            guard !done else { return }
            done = true
            guard let self, !self.replaced, let link = Self.carrying else { return }
            Self.carrying = nil
            guard self.presentedViewController == nil, PCStore.saved.contains(link.pc) else { return }
            PCStore.open(link.pc, start: link.address)
            Self.reopen()
        }
        webView.evaluateJavaScript(Self.leavingScript) { _, _ in open() }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.leavingWait, execute: open)
    }

    /// Replaces the app's view controller, so the next page (a PC, or the connect screen) is a
    /// first load. The old one goes with its web view and the page in it (the barcode scanner
    /// plugin, which kept it alive, is patched in app/patches). An SSH PC first listens on its
    /// address on this phone with its gate in the cookie store (OvisSsh.prepare); one whose address
    /// another app holds is not opened, and the connect screen says why.
    static func reopen() {
        carrying = nil
        alertAttempt = nil
        guard let window else { return }
        // the screen that says the shell moved (ShellMovedViewController) stays until its button is pressed
        if PCStore.moveNotice, window.rootViewController is ShellMovedViewController { return }
        // the view controller that goes may stay a moment longer (an SSH PC's tunnel is made first): nothing its
        // page still does counts from here on
        (window.rootViewController as? HerdrBridgeViewController)?.leave()
        open(OvisSsh.pc(PCStore.shown), in: window)
    }

    /// The rule list in force for the next web view (OvisSsh.loopbackRules), made before it is built.
    private static var loopbackRules: WKContentRuleList?

    /// An SSH preparation may finish after another PC has been chosen.
    private static var openingID = UUID()

    /// The app's first view controller: the PC or the connect screen at once, or, for an SSH PC, a blank one of the
    /// app's colour until its tunnel listens (reopen).
    static func first() -> UIViewController {
        if PCStore.moveNotice { return ShellMovedViewController() }
        // with no SSH PC there is no gate to keep from other ports, nor a tunnel to start: the page opens at once
        guard OvisSsh.supported, !OvisSsh.store.list().isEmpty else { return HerdrBridgeViewController() }
        let pc = OvisSsh.pc(PCStore.shown)
        let waiting = UIViewController()
        waiting.view.backgroundColor = pageColor
        let previous = openingID
        DispatchQueue.main.async {
            guard let window = waiting.view.window, window.rootViewController === waiting, openingID == previous else { return }
            open(pc, in: window)
        }
        return waiting
    }

    /// Builds the next web view once the loopback rule for the saved SSH PCs is made and, for an SSH PC, once its
    /// tunnel listens with its gate in the cookie store.
    private static func open(_ pc: SshPcs.Pc?, in window: UIWindow) {
        let attempt = UUID()
        openingID = attempt
        guard OvisSsh.supported, !OvisSsh.store.list().isEmpty else {
            loopbackRules = nil
            window.rootViewController = HerdrBridgeViewController()
            return
        }
        Task { @MainActor in
            let rules = await OvisSsh.loopbackRules()
            guard openingID == attempt else { return }
            if let pc {
                do {
                    try await OvisSsh.prepare(pc)
                } catch {
                    guard openingID == attempt else { return }
                    if let failure = error as? SshFailure {
                        PCStore.fail("\(failure.kind): \(failure.message)", kind: "ssh-\(failure.kind)", command: failure.command)
                    } else {
                        PCStore.fail("127.0.0.1:\(pc.localPort): \(error)", kind: "ssh-port")
                    }
                    PCStore.current = nil
                }
            }
            guard openingID == attempt else { return }
            loopbackRules = rules
            window.rootViewController = HerdrBridgeViewController()
        }
    }
}

/// Takes what a page says of its colour (HerdrBridgeViewController.barsScript), from the main frame alone: a frame
/// inside the page does not colour the screen. What it said is read by Bars.page, which drops nothing a page can
/// write as its colour: an unreadable one is the app's own icons, not the icons of the colour before it. Held by
/// the web view's content controller, so it holds no view controller itself.
private final class PageColorMessages: NSObject, WKScriptMessageHandler {
    private let said: (Any) -> Void

    init(_ said: @escaping (Any) -> Void) {
        self.said = said
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        said(message.body)
    }
}

/// The app's web view, without WebKit's form accessory bar: the up and down arrows and the check
/// mark it puts over the keyboard (#2043). The client has its own key bar, and on a phone the bar
/// took another row of the screen; a page cannot remove it. WebKit asks the web view for the
/// keyboard's accessory view (since iOS 13), so this public override does what
/// @capacitor/keyboard's `hideFormAccessoryBar` does by patching WebKit's private content view.
private final class WebViewWithoutFormBar: WKWebView {
    override var inputAccessoryView: UIView? { nil }
}

/// A load cancelled on purpose (a link handed to Safari, a new navigation) is not a failure.
final class NavigationFailureProxy: NSObject, WKNavigationDelegate {
    private weak var inner: WKNavigationDelegate?
    /// a page's failure: its reason, and its kind where the system tells one (Home.failureKind)
    private let onFailure: (WKWebView, String?, String?) -> Void
    var onAnswer: (() -> Void)?
    var onLoaded: (() -> Void)?
    var onPageFailed: ((WKWebView, String?, String?) -> Void)?
    var onCommitted: ((WKWebView) -> Void)?
    /// The key of what the view controller opened: a PC's, or the hosted app's origin for the hosted Connect a PC screen.
    var opened: String?
    var left = false
    /// What a main-frame load came to, offered first to the hosted screen (Home.Signal): true when it took it, and
    /// the PC's own handling below is skipped.
    var onSignal: ((Home.Signal) -> Bool)?

    /// Whether a failed load was cancelled or handed off on purpose: a new navigation, WebKit's
    /// "frame load interrupted" (102) or "plug-in handled load" (204).
    private static func onPurpose(_ error: Error) -> Bool {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return true }
        return nsError.domain == "WebKitErrorDomain" && (nsError.code == 102 || nsError.code == 204)
    }

    private static func kind(_ error: Error) -> String? {
        let nsError = error as NSError
        return Home.failureKind(domain: nsError.domain, code: nsError.code)
    }

    private var provisional = false
    private var pageShown = false

    init(inner: WKNavigationDelegate?, onFailure: @escaping (WKWebView, String?, String?) -> Void) {
        self.inner = inner
        self.onFailure = onFailure
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (inner?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        inner?.responds(to: aSelector) == true ? inner : nil
    }

    /// A main-frame HTTP error (tailscale serve's 502 while Ovis is stopped on the PC, a 404) is
    /// not a PC worth keeping, and its page would leave the app no way back: the error page shows
    /// instead. Capacitor's delegate does not decide responses; WebKit allows all of them.
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, navigationResponse.response.url.flatMap({ PCStore.origin(of: $0) }) != nil { onAnswer?() }
        guard navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse,
              response.statusCode >= 400 else {
            decisionHandler(.allow)
            return
        }
        // the cancelled load ends in WebKit's "frame load interrupted", which is not reported
        decisionHandler(.cancel)
        if onSignal?(.httpError) == true { return }
        // an SSH PC's tunnel said why itself (OvisSsh), in more words than its 503; the header alone is not enough,
        // as the PC's own servers can send it through the tunnel
        let tunnel = response.value(forHTTPHeaderField: SshTunnel.failureHeader) != nil && PCStore.failureKind?.hasPrefix("ssh-") == true
        onFailure(webView, tunnel ? nil : "HTTP \(response.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: response.statusCode).capitalized)", nil)
    }

    /// WebKit has no public mark for a redirect: it comes as a main-frame action, of the type of the
    /// navigation it redirects, while that navigation has not committed. Until the first page
    /// commits, such an action to another origin is held back for `follow`: no page is there yet to
    /// follow a link from, so it comes from the address being opened. After that Capacitor decides,
    /// as a link could lead to a page that is not the PC's (another port on its host), which must not
    /// choose the PC.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // this phone's loopback at a port no SSH PC listens on would get the SSH PCs' gate cookies (SshPcs.otherLoopbackPort)
        if let url = navigationAction.request.url, SshPcs.otherLoopbackPort(url.absoluteString, sshPorts: OvisSsh.tunnels.ports()) {
            decisionHandler(.cancel)
            return
        }
        // where the shell is inside the app, no web address at the hosted origin's host loads in the main frame, a
        // redirect to one included: behind it is the network's copy of the shell, with the keys the update set aside.
        // A shell page's own link to the hosted origin (a pairing link written for https://app.ovis.sh) is that page
        // inside the app instead; from any other page it goes nowhere
        if PCStore.shellBundled, navigationAction.targetFrame?.isMainFrame == true, let url = navigationAction.request.url,
           Home.hostedHost(url, hosted: PCStore.appOrigin) {
            decisionHandler(.cancel)
            if PCStore.inApp(opened), let inApp = Home.shellNavigation(url, hosted: PCStore.appOrigin, shell: PCStore.shellOrigin) {
                webView.load(URLRequest(url: inApp))
            } else if !pageShown, provisional {
                // the address being opened led there: it is no PC
                onFailure(webView, "It redirected to \(url.host ?? "the hosted app"), which this app opens from inside itself, not as a PC.", nil)
            }
            return
        }
        // a render host is a frame of a shell page and nothing else: the web view does not go there itself
        if navigationAction.targetFrame?.isMainFrame == true, Home.renderHostAddress(navigationAction.request.url, shell: PCStore.shellBundled ? PCStore.shellOrigin : nil) {
            decisionHandler(.cancel)
            return
        }
        // a PC's scope there named without its slash gets it, as the hosted app's host redirects it
        if navigationAction.targetFrame?.isMainFrame == true, PCStore.inApp(opened), let url = navigationAction.request.url,
           let inApp = Home.shellNavigation(url, hosted: PCStore.appOrigin, shell: PCStore.shellOrigin) {
            decisionHandler(.cancel)
            webView.load(URLRequest(url: inApp))
            return
        }
        if !pageShown, provisional, navigationAction.targetFrame?.isMainFrame == true,
           let current = opened, let url = navigationAction.request.url,
           let next = PCStore.origin(of: url), next != PCStore.origin(ofKey: current) {
            decisionHandler(.cancel)
            // the hosted screen led elsewhere (a network's sign-in page): it is not up, and no other origin becomes
            // the PC in its place
            if onSignal?(.redirectedElsewhere) != true { follow(url, from: current, in: webView) }
            return
        }
        if let capacitor = inner as? WebViewDelegationHandler {
            capacitor.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
        } else {
            decisionHandler(.allow)
        }
    }

    /// A redirect of the address being opened to another origin: when that origin answers as Ovis it
    /// becomes the PC and opens as the first page (http to https, an IP address to the PC's name,
    /// another port). Anything else, such as a sign-in page, gets no bridge and the error page names
    /// it: a PC address that leads elsewhere is not a PC. A way that goes over public plain http, or
    /// from https to http, does not switch on its own: the connect screen warns before a public http
    /// address.
    private func follow(_ target: URL, from: String, in webView: WKWebView) {
        let tooMany = PCStore.redirects >= PCStore.maxRedirects
        Task { @MainActor [weak self, weak webView] in
            let probe: (ovis: String?, path: [String]) = tooMany ? (nil, []) : await PCStore.ovisOrigin(leadingTo: target)
            let ovis = probe.ovis
            // a web view no longer on screen (the user changed PC meanwhile) decides nothing
            guard let self, !self.left, let webView, webView.window != nil else { return }
            if let ovis, let insecure = PCStore.insecureHop(from: from, path: probe.path) {
                self.onFailure(webView, "It redirected over plain http to \(insecure), which the app does not follow on its own. If \(ovis) is your PC, open it itself.", nil)
            } else if let ovis {
                PCStore.redirects += 1
                PCStore.current = ovis
                PCStore.last = ovis
                PCStore.pendingStart = PCStore.start(on: ovis, for: target)
                HerdrBridgeViewController.reopen()
            } else {
                let place = PCStore.origin(of: target) ?? target.absoluteString
                let reason = tooMany ? "Too many redirects" : "It redirected to \(place), which did not answer as Ovis. If that is your PC, open \(place) itself."
                self.onFailure(webView, reason, nil)
            }
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        provisional = true
        inner?.webView?(webView, didStartProvisionalNavigation: navigation)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        provisional = false
        pageShown = true
        NotificationCenter.default.post(name: .ovisPageCommitted, object: nil)
        inner?.webView?(webView, didCommit: navigation)
        onCommitted?(webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        inner?.webView?(webView, didFinish: navigation)
        guard !left else { return }
        onLoaded?()
        // the PC's page is up: a pairing link has done its work, and the PC is one worth keeping
        if let url = webView.url, let current = PCStore.current, PCStore.belongs(url, to: current) {
            PCStore.pendingStart = nil
            PCStore.redirects = 0
            PCStore.remember(current)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        provisional = false
        inner?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
        if onSignal?(.provisionalFailed(onPurpose: Self.onPurpose(error))) == true { return }
        if !Self.onPurpose(error) { onFailure(webView, error.localizedDescription, Self.kind(error)) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        inner?.webView?(webView, didFail: navigation, withError: error)
        // the hosted screen's, whenever it comes: a later document of it that broke off is no page to stay on
        if onSignal?(.failed(onPurpose: Self.onPurpose(error))) == true { return }
        onPageFailed?(webView, Self.onPurpose(error) ? nil : error.localizedDescription, Self.kind(error))
    }

    /// Capacitor reloads the page of a web content process that died. The hosted screen starts over instead, with
    /// its cover and clock (Home `died`): nothing times that reload.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if onSignal?(.processDied) == true { return }
        inner?.webViewWebContentProcessDidTerminate?(webView)
    }
}
