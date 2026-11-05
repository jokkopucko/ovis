import UIKit
import WebKit
import Capacitor

/// The PCs this app knows, kept in UserDefaults. The WebView's cookies (a paired device's
/// sign-in) live in WebKit's own store, not here.
enum PCStore {
    private static let defaults = UserDefaults.standard

    /// PCs opened before, the latest first, each by its key: the origin of a PC opened at its own
    /// address, or the scope of one opened through the Ovis relay (`https://app.ovis.sh/s/<server_id>/`),
    /// as every relay PC shares the hosted shell's origin. Entries saved before relay PCs are origins
    /// and stay as they are.
    static var saved: [String] {
        get { defaults.stringArray(forKey: "herdr.saved") ?? [] }
        set { defaults.set(newValue, forKey: "herdr.saved") }
    }

    /// Labels of saved PCs by key, from a relay pairing offer's name.
    static var names: [String: String] {
        get { defaults.dictionary(forKey: "herdr.names") as? [String: String] ?? [:] }
        set { defaults.set(newValue, forKey: "herdr.names") }
    }

    /// The PC the app opens at launch, a key (see `saved`); nil shows the connect screen.
    static var current: String? {
        get { defaults.string(forKey: "herdr.current") }
        set { defaults.set(newValue, forKey: "herdr.current") }
    }

    /// The PC opened last, even after "Change PC", for the pages that name it.
    static var last: String? {
        get { defaults.string(forKey: "herdr.last") }
        set { defaults.set(newValue, forKey: "herdr.last") }
    }

    /// The address to open instead of the bare origin until a PC page loads: a pairing link keeps
    /// its `?pair=` code through Try again. In memory only, as it can hold that code.
    static var pendingStart: String?

    /// Why the last load failed, for the error page.
    static var failure: String?

    /// Redirects in a row that made another origin the PC (NavigationFailureProxy), so two servers
    /// that redirect to each other stop.
    static var redirects = 0

    /// Redirects in a row the app follows, in the web view and in `ovisOrigin`; past it the error
    /// page says so.
    static let maxRedirects = 5

    /// How long `ovisOrigin` may take in all, its redirects included: the screen stays blank meanwhile.
    static let probeBudget: TimeInterval = 10

    /// The bridge protocols this app knows, the `bridge_protocol` /api/health?scope=bridge names
    /// (BRIDGE_PROTOCOL in shared/machines.ts).
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
        saved = saved.filter { $0 != key }
        names[key] = nil
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

    /// The origin of a PC's key.
    static func origin(ofKey key: String) -> String? {
        URL(string: key).flatMap { origin(of: $0) }
    }

    /// The address a PC's key opens at: its scope, or its origin's root.
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

    /// `scheme://host[:port]` of an http or https URL, the host in lowercase as WebKit reports it, or nil.
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let shownHost = host.contains(":") ? "[\(host)]" : host
        return url.port.map { "\(scheme)://\(shownHost):\($0)" } ?? "\(scheme)://\(shownHost)"
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

/// Hands a redirect back to `ovisOrigin` instead of following it.
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
    /// Covers the web view, which stays blank until the PC's page has loaded.
    private var openingView: UIView?
    /// Gives up on a PC that has not answered, instead of WebKit's own wait of a minute or more.
    private var answerTimeout: DispatchWorkItem?
    /// The cover's spinner, text and Try again, which change when the PC does not open in time.
    private var openingSpinner: UIActivityIndicatorView?
    private var openingLabel: UILabel?
    private var openingRetry: UIButton?
    /// A page has finished loading in this one: later failures are left to the page.
    private var firstPageDone = false
    /// How long a PC may take to answer the first request.
    private static let answerSeconds = 20

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if let origin = PCStore.current, let host = URL(string: origin)?.host {
            // what server.url sets; the pairing link until a PC page has loaded, the PC's first page
            // after it (a relay PC's scope keeps a pairing offer's `#offer=` fragment through here)
            descriptor.serverURL = PCStore.pendingStart ?? PCStore.firstPage(origin)
            // the whole PC is the app: its own links stay in the WebView, others go to Safari. For a
            // relay PC that host is the hosted shell's (app.ovis.sh), the one the app then allows
            descriptor.allowedNavigationHostnames = descriptor.allowedNavigationHostnames + [host]
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

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(HerdrShellPlugin())
        bridge?.registerPluginInstance(OvisPushPlugin())
    }

    override func viewDidLoad() {
        // before super, which starts the first load
        if let webView = webView, PCStore.current != nil {
            let proxy = NavigationFailureProxy(inner: webView.navigationDelegate) { [weak self] webView, reason in
                self?.showFailure(in: webView, reason: reason)
            }
            // the PC answered: WebKit shows its page from here, as it did before the cover existed
            proxy.onAnswer = { [weak self] in self?.hideOpening() }
            proxy.onLoaded = { [weak self] in
                self?.firstPageDone = true
                self?.hideOpening()
            }
            // a first page that broke off after it started: the error page; one cancelled on purpose
            // leaves the cover up, which the timeout turns into Try again. Only the PC's answer or a
            // finished page takes the cover away: while a PC's connection hangs, WebKit showed
            // error.html half-loaded, its script not run and its buttons dead.
            proxy.onPageFailed = { [weak self] webView, reason in
                // the PC's first page only (the cover may be gone once the PC answered), never the
                // bundled error page, which would load itself again
                guard let self, !self.firstPageDone, let reason,
                      ["http", "https"].contains(webView.url?.scheme?.lowercased() ?? "") else { return }
                self.showFailure(in: webView, reason: reason)
            }
            failureProxy = proxy
            webView.navigationDelegate = proxy
        }
        super.viewDidLoad()
        if let webView = webView, let origin = PCStore.current {
            showOpening(origin)
            let timeout = DispatchWorkItem { [weak self, weak webView] in
                // said on the cover itself: while the PC's connection hangs, WebKit did not show the
                // error page either (it stayed unpainted), in this web view or a new one
                webView?.stopLoading()
                self?.showNoAnswer(origin)
            }
            answerTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(Self.answerSeconds), execute: timeout)
        }
    }

    deinit { answerTimeout?.cancel() }

    private static var korean: Bool { Locale.preferredLanguages.first?.lowercased().hasPrefix("ko") ?? false }

    /// What shows while a PC opens: which PC, and Change PC, so a PC that never answers does not
    /// leave a blank screen.
    private func showOpening(_ origin: String) {
        let host = PCStore.names[origin] ?? URL(string: origin)?.host ?? origin
        let cover = UIView(frame: view.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = UIColor(red: 0x12 / 255, green: 0x10 / 255, blue: 0x0e / 255, alpha: 1)

        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = .white
        spinner.startAnimating()
        let label = UILabel()
        label.text = Self.korean ? "\(host) 여는 중…" : "Opening \(host)…"
        label.textColor = UIColor(white: 0.85, alpha: 1)
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        label.textAlignment = .center
        let change = UIButton(type: .system, primaryAction: UIAction(title: Self.korean ? "PC 바꾸기" : "Change PC") { _ in
            PCStore.current = nil
            HerdrBridgeViewController.reopen()
        })
        change.tintColor = .white
        change.titleLabel?.font = .preferredFont(forTextStyle: .body)
        let retry = UIButton(type: .system, primaryAction: UIAction(title: Self.korean ? "다시 시도" : "Try again") { _ in
            PCStore.failure = nil
            HerdrBridgeViewController.reopen()
        })
        retry.tintColor = UIColor(red: 0xf0 / 255, green: 0xa8 / 255, blue: 0x30 / 255, alpha: 1)
        retry.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retry.isHidden = true

        let stack = UIStackView(arrangedSubviews: [spinner, label, retry, change])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        // scrolls when large text makes it taller than the screen, so both buttons stay reachable
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = false
        scroll.addSubview(stack)
        cover.addSubview(scroll)
        let content = scroll.contentLayoutGuide, frame = scroll.frameLayoutGuide
        // the content is the screen's height, or taller when the text needs it, with the stack centered
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
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24)
        ])
        view.addSubview(cover)
        openingView = cover
        openingSpinner = spinner
        openingLabel = label
        openingRetry = retry
    }

    /// The cover once the PC has not answered in time: why, what to check, Try again and Change PC.
    private func showNoAnswer(_ origin: String) {
        let host = URL(string: origin)?.host ?? origin
        // a load that already failed keeps its reason
        var text = PCStore.failure.map { "\(host): \($0)" } ?? (Self.korean
            ? "\(host)이(가) \(Self.answerSeconds)초 안에 응답하지 않았습니다."
            : "\(host) did not answer within \(Self.answerSeconds) seconds.")
        if Self.tailnet(host) {
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
        answerTimeout?.cancel()
        openingView?.removeFromSuperview()
        openingView = nil
    }

    private func showFailure(in webView: WKWebView, reason: String) {
        guard let local = bridge?.config.localURL else { return }
        // the timeout stays armed: if WebKit does not get the error page up either, the cover says it
        PCStore.failure = reason
        webView.load(URLRequest(url: local.appendingPathComponent("error.html")))
    }

    /// Replaces the app's view controller, so the next page (a PC, or the connect screen) is a
    /// first load. The old one goes with its web view and the page in it (the barcode scanner
    /// plugin, which kept it alive, is patched in app/patches).
    static func reopen() {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard let window = (scene?.delegate as? SceneDelegate)?.window else { return }
        window.rootViewController = HerdrBridgeViewController()
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

/// Passes every navigation callback to Capacitor's own delegate and reports a main-frame load
/// that failed, such as a PC that is off or one that answers with an HTTP error, with its reason.
/// A load cancelled on purpose (a link handed to Safari, a new navigation) is not a failure.
final class NavigationFailureProxy: NSObject, WKNavigationDelegate {
    private weak var inner: WKNavigationDelegate?
    private let onFailure: (WKWebView, String) -> Void
    /// The PC itself answered the first page (http or https), with any status.
    var onAnswer: (() -> Void)?
    /// A page (the PC's or the error page) finished loading.
    var onLoaded: (() -> Void)?
    /// A page broke off after it started loading, with the reason, or nil when that was on purpose.
    var onPageFailed: ((WKWebView, String?) -> Void)?

    /// Whether a failed load was cancelled or handed off on purpose: a new navigation, WebKit's
    /// "frame load interrupted" (102) or "plug-in handled load" (204).
    private static func onPurpose(_ error: Error) -> Bool {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return true }
        return nsError.domain == "WebKitErrorDomain" && (nsError.code == 102 || nsError.code == 204)
    }

    /// Whether the main frame's navigation has started and not committed yet.
    private var provisional = false
    /// Whether the main frame's first page has committed: from then on a user could have followed a
    /// link from it.
    private var pageShown = false

    init(inner: WKNavigationDelegate?, onFailure: @escaping (WKWebView, String) -> Void) {
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
        // the PC's own answer, not the bundled error page's
        if navigationResponse.isForMainFrame, ["http", "https"].contains(navigationResponse.response.url?.scheme?.lowercased() ?? "") { onAnswer?() }
        guard navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse,
              response.statusCode >= 400 else {
            decisionHandler(.allow)
            return
        }
        // the cancelled load ends in WebKit's "frame load interrupted", which is not reported
        decisionHandler(.cancel)
        onFailure(webView, "HTTP \(response.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: response.statusCode).capitalized)")
    }

    /// WebKit has no public mark for a redirect: it comes as a main-frame action, of the type of the
    /// navigation it redirects, while that navigation has not committed. Until the first page
    /// commits, such an action to another origin is held back for `follow`: no page is there yet to
    /// follow a link from, so it comes from the address being opened. After that Capacitor decides,
    /// as a link could lead to a page that is not the PC's (another port on its host), which must not
    /// choose the PC.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if !pageShown, provisional, navigationAction.targetFrame?.isMainFrame == true,
           let current = PCStore.current, let url = navigationAction.request.url,
           let next = PCStore.origin(of: url), next != PCStore.origin(ofKey: current) {
            decisionHandler(.cancel)
            follow(url, from: current, in: webView)
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
            guard let self, let webView, webView.window != nil else { return }
            if let ovis, let insecure = PCStore.insecureHop(from: from, path: probe.path) {
                self.onFailure(webView, "It redirected over plain http to \(insecure), which the app does not follow on its own. If \(ovis) is your PC, open it itself.")
            } else if let ovis {
                PCStore.redirects += 1
                PCStore.current = ovis
                PCStore.last = ovis
                PCStore.pendingStart = PCStore.start(on: ovis, for: target)
                HerdrBridgeViewController.reopen()
            } else {
                let place = PCStore.origin(of: target) ?? target.absoluteString
                let reason = tooMany ? "Too many redirects" : "It redirected to \(place), which did not answer as Ovis. If that is your PC, open \(place) itself."
                self.onFailure(webView, reason)
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
        inner?.webView?(webView, didCommit: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        inner?.webView?(webView, didFinish: navigation)
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
        if !Self.onPurpose(error) { onFailure(webView, error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        inner?.webView?(webView, didFail: navigation, withError: error)
        onPageFailed?(webView, Self.onPurpose(error) ? nil : error.localizedDescription)
    }
}
