import AppKit
import WebKit

/// Settings → Browser for links in the Mac app: the bridge the desktop app gives its pages too
/// (`ovisBrowsers`, src/lib/externalLink.ts). The page lists the apps that open https, chooses one by
/// its id and hands it its web links (`kind` link); sign-ins, Ovis pages and mail stay with the
/// default browser (`openElsewhere`). The page names an app by its id alone: what opens is only an
/// app LaunchServices listed, or agent-browser's own program, run without a shell.
enum LinkBrowsers {
    struct Browser {
        let id: String
        let name: String
        let open: (URL, @escaping (Bool) -> Void) -> Void
    }

    static let chosenKey = "linkBrowser"

    static var chosen: String? {
        get { UserDefaults.standard.string(forKey: chosenKey) }
        set { UserDefaults.standard.set(newValue, forKey: chosenKey) }
    }

    private static let probe = URL(string: "https://example.com/")!

    static func found() -> (browsers: [Browser], systemDefault: String?) {
        var seen = Set<String>()
        var browsers: [Browser] = []
        for app in NSWorkspace.shared.urlsForApplications(toOpen: probe) {
            guard let bundle = Bundle(url: app), let id = bundle.bundleIdentifier, id != Bundle.main.bundleIdentifier,
                  seen.insert(id).inserted else { continue }
            browsers.append(Browser(id: "mac:\(id)", name: name(of: bundle)) { url, done in
                NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                    DispatchQueue.main.async { done(error == nil) }
                }
            })
        }
        if let program = agentBrowserProgram() {
            browsers.append(Browser(id: "agent-browser", name: "agent-browser") { url, done in
                let process = Process()
                process.executableURL = program
                // a session of its own, so an agent's tab is never taken
                process.arguments = ["--session", "ovis-links", "--headed", "open", url.absoluteString]
                process.terminationHandler = { ended in DispatchQueue.main.async { done(ended.terminationStatus == 0) } }
                do { try process.run() } catch { done(false) }
            })
        }
        let preferred = NSWorkspace.shared.urlForApplication(toOpen: probe).flatMap(Bundle.init(url:)).map(name(of:))
        return (browsers, preferred)
    }

    static func name(of bundle: Bundle) -> String {
        for key in ["CFBundleDisplayName", "CFBundleName"] {
            if let name = bundle.object(forInfoDictionaryKey: key) as? String, !name.isEmpty { return name }
        }
        return bundle.bundleURL.deletingPathExtension().lastPathComponent
    }

    /// An app started from Finder has a short PATH: where npm, Bun and Homebrew put the program too.
    static func agentBrowserProgram(path: String = ProcessInfo.processInfo.environment["PATH"] ?? "", home: String = NSHomeDirectory(),
                                    isProgram: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) -> URL? {
        let dirs = path.split(separator: ":").map(String.init) + ["\(home)/.bun/bin", "\(home)/.local/bin", "\(home)/.npm-global/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        return dirs.lazy.map { "\($0)/agent-browser" }.first(where: isProgram).map(URL.init(fileURLWithPath:))
    }

    /// An http(s) address, or nil: nothing else goes to the chosen browser.
    static func webAddress(_ text: String) -> URL? {
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host != nil else { return nil }
        return url
    }

    /// The page's side, before its own code runs: each call is one message to the app, answered there.
    static let script = WKUserScript(source: """
        (() => {
          const post = (body) => window.webkit.messageHandlers.ovisBrowsers.postMessage(body);
          window.ovisBrowsers = Object.freeze({
            list: () => post({ op: "list" }),
            choose: (id) => post({ op: "choose", id }),
            open: (url) => { post({ op: "open", url }).catch(() => {}); },
          });
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
}

/// Answers the page's `ovisBrowsers` calls, from the Ovis page's own main frame only. The web view's
/// configuration keeps its message handlers, so the closures given here hold the page weakly.
@MainActor
final class LinkBrowsersHandler: NSObject, WKScriptMessageHandlerWithReply {
    private let isOvis: (WKSecurityOrigin) -> Bool
    private let openDefault: (URL) -> Void
    private var browsers: [LinkBrowsers.Browser] = []

    init(isOvis: @escaping (WKSecurityOrigin) -> Bool, openDefault: @escaping (URL) -> Void) {
        self.isOvis = isOvis
        self.openDefault = openDefault
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, isOvis(message.frameInfo.securityOrigin), let body = message.body as? [String: Any] else {
            return replyHandler(nil, "Choosing a browser is not offered here")
        }
        switch body["op"] as? String {
        case "list":
            let found = LinkBrowsers.found()
            browsers = found.browsers
            replyHandler(["browsers": found.browsers.map { ["id": $0.id, "name": $0.name] }, "systemDefault": found.systemDefault ?? NSNull(), "chosen": LinkBrowsers.chosen ?? NSNull()] as [String: Any], nil)
        case "choose":
            // null resets to the default; anything but null or a browser found here is refused and changes nothing
            if body["id"] is NSNull {
                LinkBrowsers.chosen = nil
                return replyHandler(nil, nil)
            }
            guard let id = body["id"] as? String, known().contains(where: { $0.id == id }) else { return replyHandler(nil, "That browser is not on this Mac") }
            LinkBrowsers.chosen = id
            replyHandler(nil, nil)
        case "open":
            replyHandler(nil, nil)
            guard let text = body["url"] as? String, let url = URL(string: text) else { return }
            guard let address = LinkBrowsers.webAddress(text), let chosen = LinkBrowsers.chosen else { return openDefault(url) }
            guard let browser = known().first(where: { $0.id == chosen }) else { return openDefault(address) }
            browser.open(address) { [openDefault] opened in if !opened { openDefault(address) } }
        default:
            replyHandler(nil, "Unknown call")
        }
    }

    private func known() -> [LinkBrowsers.Browser] {
        if browsers.isEmpty { browsers = LinkBrowsers.found().browsers }
        return browsers
    }
}
