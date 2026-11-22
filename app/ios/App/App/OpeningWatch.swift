import Foundation

/// What HerdrBridgeViewController's cover says while a PC opens, as OpeningWatch.java does on
/// Android. iOS has no count of the bytes the app receives: the web view's estimatedProgress fills
/// the bar once the PC has answered, but it does not move while one large file arrives (it held at
/// about 40 % through the client's script on a 10 KB/s link), so it cannot tell a stalled link from a
/// slow one and the cover never claims a stall. Before the answer nothing is seen, so the open gives
/// up when the answer limit passes. A PC that answered is never called off: after
/// `slowAfterSeconds` the cover says the link is slow, with Try again. Times are seconds on one clock
/// (ProcessInfo.systemUptime in the app).
struct OpeningWatch {
    enum Stage: Equatable {
        case opening
        case slow
        case noAnswer
    }

    static let slowAfterSeconds: TimeInterval = 5
    static let maxShown = 0.95

    private let startedAt: TimeInterval
    private let answerLimit: TimeInterval
    private(set) var answered = false
    private var lastProgress = 0.0
    private var shown = 0.0

    init(now: TimeInterval, answerLimit: TimeInterval) {
        startedAt = now
        self.answerLimit = answerLimit
    }

    mutating func answer(at now: TimeInterval) {
        answered = true
    }

    mutating func progress(_ fraction: Double) {
        guard answered else { return }
        lastProgress = max(lastProgress, fraction)
    }

    mutating func shownProgress() -> Double {
        shown = max(shown, min(Self.maxShown, lastProgress))
        return shown
    }

    /// Whether `host` (a URL's host, IPv6 in brackets or not) is an address of a home network or a
    /// tailnet, which opens only from inside it, as homeHost in app/web/shell.js decides: only there
    /// do the PC, the home network and its firewall explain no answer.
    static func homeHost(_ host: String) -> Bool {
        let name = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        if name == "localhost" || name.hasSuffix(".localhost") || name == "::1" || name.hasSuffix(".ts.net") || name.hasPrefix("fd7a:115c:a1e0:") { return true }
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count == 4, let last = parts.last, Int(last) != nil {
            let numbers = parts.compactMap { Int($0) }
            guard numbers.count == 4 else { return false }
            let (a, b) = (numbers[0], numbers[1])
            return a == 10 || a == 127 || (a == 100 && (64...127).contains(b)) || (a == 172 && (16...31).contains(b))
                || (a == 192 && b == 168) || (a == 169 && b == 254)
        }
        if name.contains(":") { return name.hasPrefix("fc") || name.hasPrefix("fd") || ["fe8", "fe9", "fea", "feb"].contains { name.hasPrefix($0) } }
        return !name.contains(".") || [".local", ".lan", ".home.arpa", ".internal"].contains { name.hasSuffix($0) }
    }

    func stage(at now: TimeInterval) -> Stage {
        let elapsed = now - startedAt
        if !answered { return elapsed >= answerLimit ? .noAnswer : .opening }
        return elapsed >= Self.slowAfterSeconds ? .slow : .opening
    }
}
