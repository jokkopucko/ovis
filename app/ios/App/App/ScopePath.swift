import Foundation

/// The path checks a relay PC's scope rests on (PCStore.belongs), with Foundation only so a test can
/// compile them without the app: `swiftc ScopePath.swift <test>.swift`. The Android twin is
/// PCStore.cleanPath in app/android.
enum ScopePath {
    /// `path` (percent-encoded, as a URL carries it) when a browser loads it as written, else nil: no
    /// `.` or `..` segment, plain or percent-encoded (once or twice), no encoded `/` and no `\`, which
    /// a browser reads as `/`. A page within a scope never needs any of them.
    static func clean(_ path: String) -> String? {
        if path.contains("\\") { return nil }
        let lower = path.lowercased()
        if lower.contains("%2f") || lower.contains("%5c") { return nil }
        guard let decoded = path.removingPercentEncoding, !decoded.contains("\\") else { return nil }
        let twice = decoded.lowercased()
        if twice.contains("%2e") || twice.contains("%2f") || twice.contains("%5c") { return nil }
        if decoded.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) { return nil }
        return path
    }

    /// Whether `path` is within `scope` (a path ending in `/`), segment by segment (`/s/A/` is not
    /// within `/s/AB/`), and both load as written (`clean`); the scope's own path without its slash counts.
    static func within(_ path: String, scope: String) -> Bool {
        guard scope.hasPrefix("/"), scope.hasSuffix("/"), clean(scope) != nil, let path = clean(path) else { return false }
        return (path.hasSuffix("/") ? path : path + "/").hasPrefix(scope)
    }
}
