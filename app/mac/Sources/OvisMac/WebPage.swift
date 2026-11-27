import AppKit
import Combine
import SwiftUI
import WebKit

struct WebPage: View {
    @StateObject private var page: WebPageController

    init(origin: URL, model: Model) {
        _page = StateObject(wrappedValue: WebPageController(origin: origin, model: model))
    }

    var body: some View {
        ZStack {
            WebViewHost(webView: page.webView)
            switch page.state {
            case .shown:
                EmptyView()
            case .loading:
                cover { ProgressView() }
            case let .failed(reason):
                cover {
                    VStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text(L("Waiting for Ovis to answer…", "Ovis의 응답을 기다리는 중…")).font(.headline)
                        Text(reason).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        // up to the window's top, where the page's header takes the title bar's place (TitleBar.swift)
        .ignoresSafeArea(.container, edges: .top)
    }

    /// Hides the web view's empty white frame, which a dark window would flash.
    private func cover<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content().frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct WebViewHost: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

final class OvisWebView: WKWebView {
    /// The main window's page, rather than the page of a window it opened.
    var drawsTitleBar = false
    /// The page's part of the folded bar, while its window has the bar folded.
    private var titleBarScript: String?
    private var titleBarHeight: CGFloat = 0
    private var windowWatch: [NSObjectProtocol] = []
    private var transparencyWatch: NSKeyValueObservation?
    /// Whether a cover hides the page (loading, or waiting for the server). The window server would move the
    /// window from a drag anywhere in the folded bar, a header tab or button included, so over the page only
    /// its asks (`title-bar.js`) move it, through `performDrag`; a cover asks nothing, and the bar moves it.
    var pageCovered = true {
        didSet { if titleBarScript != nil { window?.isMovable = pageCovered } }
    }
    /// The press under way, and whether the page found it on its header's bare surface.
    private var press: NSEvent?
    private var dragArmed = false

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if let window, newWindow !== window, titleBarScript != nil {
            windowWatch.forEach(NotificationCenter.default.removeObserver)
            windowWatch = []
            transparencyWatch = nil
            TitleBar.unfold(window, for: self)
            titleBarScript = nil
            titleBarHeight = 0
        }
        super.viewWillMove(toWindow: newWindow)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.makeFirstResponder(self)
        guard drawsTitleBar, let window, titleBarScript == nil, let folded = TitleBar.fold(window, for: self) else { return }
        titleBarScript = folded.script
        titleBarHeight = folded.height
        window.isMovable = pageCovered
        let center = NotificationCenter.default
        windowWatch = [
            center.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { [weak window] _ in
                MainActor.assumeIsolated {
                    guard let window, window.occlusionState.contains(.visible) else { return }
                    TitleBar.refresh(window)
                }
            },
            center.addObserver(forName: NSWindow.willEnterFullScreenNotification, object: window, queue: .main) { [weak window] _ in
                MainActor.assumeIsolated { window?.toolbar = nil }
            },
            center.addObserver(forName: NSWindow.didExitFullScreenNotification, object: window, queue: .main) { [weak window] _ in
                MainActor.assumeIsolated {
                    guard let window else { return }
                    TitleBar.addToolbar(window)
                    TitleBar.refresh(window)
                }
            },
        ]
        // SwiftUI sets the bar's look again as it updates the window (as the page joins it, as the window turns
        // inactive): an opaque bar over the header, which WebKit then moves the page below. Folding it back at
        // once also has AppKit find the page under the bar again.
        transparencyWatch = window.observe(\.titlebarAppearsTransparent) { window, _ in
            MainActor.assumeIsolated {
                if !window.titlebarAppearsTransparent { window.titlebarAppearsTransparent = true }
            }
        }
        showHeaderInTitleBar()
    }

    /// Lets a drag on the folded header move a background window on the first press, without waking
    /// clicks in the chat or terminal below the bar.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        if drawsTitleBar, let event, let window {
            var at = convert(event.locationInWindow, from: nil)
            if !isFlipped { at.y = bounds.height - at.y }
            if TitleBar.inBarBand(y: at.y, height: titleBarHeight, fullScreen: window.styleMask.contains(.fullScreen)) {
                return true
            }
        }
        return super.acceptsFirstMouse(for: event)
    }

    /// Hands the page in the window its part of the folded bar: once the bar is folded, and as each page commits.
    func showHeaderInTitleBar() {
        if let titleBarScript { evaluateJavaScript(titleBarScript) }
    }

    /// The press under way may move the window, if it is the one the page found on a bar: its ask comes
    /// after the press, and can come after a later one. It moves the window once the mouse moves, so a
    /// click or a double click on the bar stays the page's. `point` is where the page saw the press, in
    /// CSS pixels from the page's top left.
    func armDrag(at point: CGPoint) {
        guard let press else { return }
        var at = convert(press.locationInWindow, from: nil)
        if !isFlipped { at.y = bounds.height - at.y }
        dragArmed = abs(at.x / pageZoom - point.x) <= 1.5 && abs(at.y / pageZoom - point.y) <= 1.5
    }

    override func mouseDown(with event: NSEvent) {
        press = event
        dragArmed = false
        super.mouseDown(with: event)
    }

    override func mouseDragged(with event: NSEvent) {
        guard dragArmed, let press, let window else { return super.mouseDragged(with: event) }
        dragArmed = false
        self.press = nil
        window.performDrag(with: press)
        // the drag took the mouse-up, which the page still waits for to end its press
        if let up = NSEvent.mouseEvent(with: .leftMouseUp, location: window.mouseLocationOutsideOfEventStream, modifierFlags: [],
                                       timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                       context: nil, eventNumber: 0, clickCount: 1, pressure: 0) {
            super.mouseUp(with: up)
        }
    }

    override func mouseUp(with event: NSEvent) {
        press = nil
        dragArmed = false
        super.mouseUp(with: event)
    }
}

/// The Ovis server's own pages stay in the app; any other address goes to the default browser.
@MainActor
final class WebPageController: NSObject, ObservableObject {
    enum State: Equatable {
        case loading
        case shown
        case failed(String)
    }

    @Published private(set) var state: State = .loading {
        didSet { webView.pageCovered = state != .shown }
    }
    let webView: OvisWebView
    private let origin: URL
    private weak var model: Model?
    private let isPopup: Bool
    private var window: NSWindow?
    private var closed = false
    private static var popups: [WebPageController] = []
    private static var reserved: Set<String> = []
    private var destinations: [ObjectIdentifier: URL] = [:]
    private var reloads: AnyCancellable?
    private var carryToken: String?
    private var carryShared = false
    private var carryBefore: [String: Any]?

    /// Nothing here is sent by itself; it waits in the page for the user's Send or Discard.
    /// A chat send on its way keeps its lease, as across a reload: until it runs out (2 minutes) the new
    /// page does not offer that text again, which the old server may have taken.
    static let draftPrefixes = ["ovis:composer-draft:", "ovis:composer-sending:", "ovis:terminal-draft:", "ovis:terminal-line:", "ovis:queue:", "ovis:pending:"]

    /// A popup gets the configuration WebKit hands over for it; the main window's page makes its own.
    init(origin: URL, model: Model, popupConfiguration: WKWebViewConfiguration? = nil) {
        self.origin = origin
        self.model = model
        isPopup = popupConfiguration != nil
        webView = OvisWebView(frame: .zero, configuration: popupConfiguration ?? Self.configuration())
        webView.drawsTitleBar = !isPopup
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = .windowBackgroundColor
        // a popup is loaded by WebKit, with the request that opened it
        guard !isPopup else { return }
        model.page = self
        reloads = model.$reloads.dropFirst().sink { [weak self] _ in self?.reload() }
        webView.configuration.userContentController.add(TitleBarMessages(webView), name: "ovisTitleBar")
        // drafts go only to this Mac's own server, as they came only from it
        if Self.isLoopback(origin) {
            let shared = Self.popups.contains { !$0.closed && $0.webView.url.map(self.isOvis) == true }
            let token = UUID().uuidString
            if let script = Self.carryScript(model.carriedDrafts, shared: shared, token: token, loaded: false, before: nil) {
                webView.configuration.userContentController.addUserScript(script)
                webView.configuration.userContentController.add(CarryBaselines(page: self), name: "ovisCarry")
                carryToken = token
                carryShared = shared
            }
        }
        // Settings → Browser for links (LinkBrowsers.swift); a popup shares this configuration, and with it the bridge
        let controller = webView.configuration.userContentController
        controller.addUserScript(LinkBrowsers.script)
        controller.addScriptMessageHandler(LinkBrowsersHandler(isOvis: { [weak self] in self?.isOvis($0) ?? false },
                                                               openDefault: { [weak self] in self?.openElsewhere($0) }),
                                           contentWorld: .page, name: "ovisBrowsers")
        webView.load(URLRequest(url: origin))
    }

    static func configuration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        // the page's sign-in cookie and its drafts stay across launches
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = userAgentSuffix
        return configuration
    }

    /// Safari's own end of the user agent, then this app's name. A web view sends neither by itself, and
    /// the terminal's Korean input goes by "Safari" (xterm.js's Hangul handling, patches/), as do the
    /// client's device names; "OvisMac" tells the client it runs in this app (src/lib/nativeApp.ts).
    /// The web view is the system's WebKit, the one the installed Safari uses, so it reports that version.
    static let userAgentSuffix: String = {
        let safari = Bundle(path: "/Applications/Safari.app")?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let version = safari.map { $0.split(separator: ".").prefix(2).joined(separator: ".") } ?? "17.0"
        let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
        return "Version/\(version) Safari/605.1.15 OvisMac/\(app)"
    }()

    func reloadIfNotStarted() {
        webView.evaluateJavaScript("document.getElementById('root')?.childElementCount ?? 0") { [weak self] result, _ in
            if (result as? Int ?? 0) == 0 { self?.reload() }
        }
    }

    /// The page's unsent drafts, read before it goes for a page at another address (another port is
    /// another origin, whose storage holds none of them).
    func unsentDrafts() async -> [String: String] {
        let prefixes = String(data: (try? JSONSerialization.data(withJSONObject: Self.draftPrefixes)) ?? Data(), encoding: .utf8) ?? "[]"
        let source = """
        (() => { const found = {}; try { for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i);
          if (key && \(prefixes).some((prefix) => key.startsWith(prefix))) found[key] = localStorage.getItem(key); } } catch {}
          return JSON.stringify(found); })()
        """
        // a page whose code hangs never answers: the window must still move on
        let json: String? = await withCheckedContinuation { done in
            var answered = false
            let answer = { (value: String?) in
                if !answered { answered = true; done.resume(returning: value) }
            }
            webView.evaluateJavaScript(source) { result, _ in answer(result as? String) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { answer(nil) }
        }
        guard let data = json?.data(using: .utf8),
              let drafts = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return [:] }
        return drafts
    }

    private static let carrySource = Bundle.main.url(forResource: "carry-drafts", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }

    private static func carryScript(_ drafts: [String: String], shared: Bool, token: String, loaded: Bool, before: [String: Any]?) -> WKUserScript? {
        guard !drafts.isEmpty, let carrySource, let data = try? JSONSerialization.data(withJSONObject: drafts),
              let json = String(data: data, encoding: .utf8) else { return nil }
        let given = before.flatMap { try? JSONSerialization.data(withJSONObject: $0) }.flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        let post = "(baselines) => window.webkit?.messageHandlers?.ovisCarry?.postMessage(baselines)"
        let source = "(() => {\n\(carrySource)\novisCarryDrafts(window.localStorage, \(json), \(shared), \"\(token)\", \(loaded), \(given), \(post));\n})();"
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    fileprivate func keepBaselines(_ before: [String: Any], token: String) {
        guard token == carryToken, carryBefore == nil else { return }
        carryBefore = before
    }

    /// This Mac's own server, which the app reaches without pairing: the only addresses drafts move between.
    static func isLoopback(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "http" || url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased() else { return false }
        return host == "localhost" || host == "::1"
            || host.range(of: #"^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$"#, options: .regularExpression) != nil
    }

    func reload() {
        if state != .shown { state = .loading }
        let current = webView.url.flatMap { isOvis($0) ? $0 : nil }
        webView.load(URLRequest(url: current ?? origin))
    }

    private func isOvis(_ url: URL) -> Bool {
        url.scheme?.lowercased() == origin.scheme?.lowercased() && url.host?.lowercased() == origin.host?.lowercased()
            && Self.port(url.port, scheme: url.scheme) == Self.port(origin.port, scheme: origin.scheme)
    }

    private func isOvis(_ origin: WKSecurityOrigin) -> Bool {
        origin.protocol.lowercased() == self.origin.scheme?.lowercased() && origin.host.lowercased() == self.origin.host?.lowercased()
            && Self.port(origin.port, scheme: origin.protocol) == Self.port(self.origin.port, scheme: self.origin.scheme)
    }

    /// The port an address means: none (a URL) or 0 (WebKit's origin) is the scheme's own, which an
    /// address may also spell out (`http://host:80`).
    private static func port(_ port: Int?, scheme: String?) -> Int {
        if let port, port != 0 { return port }
        return scheme?.lowercased() == "https" ? 443 : 80
    }

    /// Another app's link (a site in a web
    /// panel can make any) asks first, as Safari does. A file (one dropped where the page takes none,
    /// which would replace the page) and the page's own data stay where they are.
    private func openElsewhere(_ url: URL) {
        guard let scheme = url.scheme?.lowercased() else { return }
        if ["http", "https", "mailto"].contains(scheme) {
            NSWorkspace.shared.open(url)
            return
        }
        guard !["file", "data", "blob", "javascript", "about"].contains(scheme),
              let app = NSWorkspace.shared.urlForApplication(toOpen: url) else { return }
        let name = FileManager.default.displayName(atPath: app.path)
        let alert = NSAlert()
        alert.messageText = L("Open this link in “\(name)”?", "이 링크를 “\(name)”에서 열까요?")
        alert.informativeText = String(url.absoluteString.prefix(300))
        alert.addButton(withTitle: L("Open", "열기"))
        alert.addButton(withTitle: L("Cancel", "취소"))
        guard let window = webView.window else {
            if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(url) }
            return
        }
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn { NSWorkspace.shared.open(url) }
        }
    }

    private func failed(_ error: Error) {
        let error = error as NSError
        // a load stopped on purpose: a newer one, a link handed to the browser, a download
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
        // WebKit's "frame load interrupted" (102) and "plug-in handled load" (204)
        if error.domain == "WebKitErrorDomain" && (error.code == 102 || error.code == 204) { return }
        guard !isPopup else {
            if window == nil { closePopup() }
            return
        }
        state = .failed(error.localizedDescription)
        model?.pageFailed()
    }

    private func showWindow() {
        guard window == nil else { return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 720), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Ovis"
        window.contentView = webView
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    /// Ends a popup: its window closes, or one that never got a window lets go once its downloads end.
    /// Later, not inside the WebKit callback that asked for it.
    private func closePopup() {
        DispatchQueue.main.async { [self] in
            if let window, !closed {
                window.close()
            } else if destinations.isEmpty {
                Self.popups.removeAll { $0 === self }
            }
        }
    }
}

extension WebPageController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            // only an Ovis page saves into Downloads by itself; a site's (a web panel's) download goes to
            // the browser, which asks as it does for any site
            if let source = navigationAction.sourceFrame as WKFrameInfo?, isOvis(source.securityOrigin) {
                decisionHandler(.download)
            } else {
                decisionHandler(.cancel)
                navigationAction.request.url.map(openElsewhere)
            }
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        // a frame inside the page (a web panel) may show any site; only the page itself is kept to Ovis
        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(url.isFileURL ? .cancel : .allow)
            return
        }
        if isOvis(url) || url.absoluteString == "about:blank" {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        openElsewhere(url)
        if isPopup && window == nil { closePopup() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        guard disposition.lowercased().hasPrefix("attachment") || !navigationResponse.canShowMIMEType else {
            decisionHandler(.allow)
            return
        }
        // a page (main frame) is always Ovis's own; a file a frame inside it shows is saved only when it
        // comes from the Ovis server, and a site's goes to the browser
        let url = navigationResponse.response.url
        if navigationResponse.isForMainFrame || url.map(isOvis) == true {
            decisionHandler(.download)
        } else {
            decisionHandler(.cancel)
            url.map(openElsewhere)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if isPopup, let url = webView.url, isOvis(url) { showWindow() }
        if !isPopup { self.webView.showHeaderInTitleBar() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        state = .shown
        if let window, let title = webView.title, !title.isEmpty { window.title = title }
        if !isPopup {
            model?.pageLoaded()
            // again once loaded: at its commit a page can have no root yet, and the script waits for one
            self.webView.showHeaderInTitleBar()
        }
        if let token = carryToken {
            let shared = carryShared
            let before = carryBefore
            let landed = """
            (() => { try { const mark = JSON.parse(localStorage.getItem("ovis-mac:carried") ?? "null");
              return mark && mark.token === "\(token)" && Array.isArray(mark.done) ? mark.done : []; } catch { return []; } })()
            """
            webView.evaluateJavaScript(landed) { [weak self] result, _ in
                guard let self, let model = self.model, let keys = result as? [String] else { return }
                model.draftsCarried(Set(keys))
                let controller = self.webView.configuration.userContentController
                controller.removeAllUserScripts()
                // the carry's script is the one replaced; Browser for links' bridge stays for every later load
                controller.addUserScript(LinkBrowsers.script)
                if let script = Self.carryScript(model.carriedDrafts, shared: shared, token: token, loaded: true, before: before) {
                    controller.addUserScript(script)
                } else {
                    self.carryToken = nil
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reload()
    }
}

extension WebPageController: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let url = navigationAction.request.url
        if let url, !url.absoluteString.isEmpty, url.absoluteString != "about:blank", !isOvis(url) {
            openElsewhere(url)
            return nil
        }
        // only the Ovis page itself opens app windows: a site in a web panel could otherwise fill a blank
        // one by script, and it would stay hidden
        let source = navigationAction.sourceFrame
        guard let model, source.isMainFrame, isOvis(source.securityOrigin) else { return nil }
        let popup = WebPageController(origin: origin, model: model, popupConfiguration: configuration)
        Self.popups.append(popup)
        return popup.webView
    }

    func webViewDidClose(_ webView: WKWebView) {
        if isPopup { closePopup() }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        guard let window = webView.window else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
            return
        }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    /// Dictation in the Ovis page: macOS asks once whether the app may use the microphone
    /// (NSMicrophoneUsageDescription). Anything else, such as a site in a web panel, is asked about.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(frame.isMainFrame && isOvis(origin) && type == .microphone ? .grant : .prompt)
    }
}

extension WebPageController: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = (suggestedFilename as NSString).lastPathComponent
        let destination = Self.freeName(name.isEmpty ? "download" : name, in: folder)
        Self.reserved.insert(destination.path)
        destinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = ended(download) else { return }
        // the Dock's Downloads stack bounces, as it does for a browser's download
        DistributedNotificationCenter.default().post(name: Notification.Name("com.apple.DownloadFileFinished"), object: file.path)
    }

    /// A download that goes on to another site is that site's: the browser has it, as for a site's own.
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        guard let url = request.url, !isOvis(url) else {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        openElsewhere(url)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        _ = ended(download)
        // a redirect handed to the browser cancels the download: nothing went wrong
        if (error as NSError).domain == NSURLErrorDomain && (error as NSError).code == NSURLErrorCancelled { return }
        guard let window = (closed ? nil : webView.window) ?? model?.page?.webView.window else { return }
        NSAlert(error: error).beginSheetModal(for: window)
    }

    private func ended(_ download: WKDownload) -> URL? {
        let file = destinations.removeValue(forKey: ObjectIdentifier(download))
        if let file { Self.reserved.remove(file.path) }
        if isPopup && (window == nil || closed) { closePopup() }
        return file
    }

    static func freeName(_ name: String, in folder: URL) -> URL {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var candidate = folder.appendingPathComponent(name)
        var number = 2
        while FileManager.default.fileExists(atPath: candidate.path) || reserved.contains(candidate.path) {
            candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(number)" : "\(base) \(number).\(ext)")
            number += 1
        }
        return candidate
    }
}

extension WebPageController: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        closed = true
        closePopup()
    }
}

/// The carry's baselines, posted before it writes anything (`carry-drafts.js`). Held weakly: the web view's
/// configuration keeps its message handlers, and the page must not keep itself alive through them.
@MainActor
private final class CarryBaselines: NSObject, WKScriptMessageHandler {
    private weak var page: WebPageController?

    init(page: WebPageController) {
        self.page = page
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let token = body["token"] as? String,
              let before = body["before"] as? [String: Any] else { return }
        page?.keepBaselines(before, token: token)
    }
}
