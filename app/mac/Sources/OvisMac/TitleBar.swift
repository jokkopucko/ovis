import AppKit
import WebKit

/// The main window's title bar, folded away while the window shows the Ovis page: the page's header
/// takes its place (`Resources/title-bar.js`), as the Codex and Claude apps draw their own. An empty
/// compact toolbar gives the bar its height and centres the traffic lights on it; the page is handed
/// that height and the lights' right edge, so its header matches the bar and starts clear of them.
/// The setup, and a window the page opened, keep a title bar of their own.
@MainActor
enum TitleBar {
    private static let source = Bundle.main.url(forResource: "title-bar", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    /// The page that folded each window's bar: when the server moves, the next page can join the window
    /// before the last one leaves it, and only the one that folded the bar gives it back.
    private static let folders = NSMapTable<NSWindow, NSView>.weakToWeakObjects()

    struct Folded {
        let script: String
        let height: CGFloat
    }

    /// Folds the window's bar away for `page` and returns the page's script and bar height; nil leaves
    /// the bar as it was (a build without the script, or a bar AppKit did not lay out as expected).
    static func fold(_ window: NSWindow, for page: NSView) -> Folded? {
        guard let source else { return nil }
        folders.setObject(page, forKey: window)
        window.styleMask.insert(.fullSizeContentView)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        addToolbar(window)
        window.layoutIfNeeded()
        guard let zoom = window.standardWindowButton(.zoomButton), let bar = zoom.superview?.superview else {
            unfold(window, for: page)
            return nil
        }
        let height = bar.frame.height, inset = zoom.frame.maxX
        // a page joining a window already in full screen: measured with the toolbar, which full screen does
        // without until the window leaves it (the window's exit handler adds it back)
        if window.styleMask.contains(.fullScreen) { window.toolbar = nil }
        let post = "(ask) => window.webkit?.messageHandlers?.ovisTitleBar?.postMessage(ask)"
        return Folded(script: "(() => {\n\(source)\novisTitleBar(document, \(height), \(inset), \(post));\n})();", height: height)
    }

    /// Whether a press at `y` points from the view's top lies inside the folded title-bar band.
    nonisolated static func inBarBand(y: CGFloat, height: CGFloat, fullScreen: Bool) -> Bool {
        !fullScreen && height > 0 && y >= 0 && y <= height
    }

    /// Has AppKit look again for the views under the bar that take its clicks. It looks as the bar turns
    /// transparent, finding the page; but as the window comes on screen (its first showing at a restored
    /// frame, after Hide or the Dock) it asks only SwiftUI's view around the page, which takes none, and
    /// the bar then takes every click on the header.
    static func refresh(_ window: NSWindow) {
        window.titlebarAppearsTransparent = false
        window.titlebarAppearsTransparent = true
    }

    /// The window's own bar back as `page` leaves it, for the setup that takes the page's place.
    static func unfold(_ window: NSWindow, for page: NSView) {
        guard folders.object(forKey: window) === page else { return }
        folders.removeObject(forKey: window)
        window.toolbar = nil
        window.isMovable = true
        window.titlebarAppearsTransparent = false
        window.titleVisibility = .visible
        window.styleMask.remove(.fullSizeContentView)
    }

    /// In full screen the bar is a window of its own over the page, and a toolbar keeps it there: it goes
    /// for full screen, so the bar hides with the menu bar, and comes back after.
    static func addToolbar(_ window: NSWindow) {
        window.toolbar = NSToolbar()
        window.toolbarStyle = .unifiedCompact
    }

    /// A double click on a title bar does what System Settings › Desktop & Dock says.
    static func doubleClick(_ window: NSWindow) {
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize": window.performMiniaturize(nil)
        case "None": break
        default: window.performZoom(nil)
        }
    }
}

/// The page's asks from its header (`title-bar.js`), taken only from the main window's page and its own
/// frame: a window the page opened, and a web panel's frame of any site, can post them too.
final class TitleBarMessages: NSObject, WKScriptMessageHandler {
    private weak var webView: OvisWebView?

    init(_ webView: OvisWebView) {
        self.webView = webView
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let webView, message.webView === webView, message.frameInfo.isMainFrame, let window = webView.window else { return }
            guard let body = message.body as? [String: Any] else { return }
            switch body["ask"] as? String {
            case "drag":
                guard let x = body["x"] as? Double, let y = body["y"] as? Double else { return }
                webView.armDrag(at: CGPoint(x: x, y: y))
            case "zoom": TitleBar.doubleClick(window)
            default: break
            }
        }
    }
}
