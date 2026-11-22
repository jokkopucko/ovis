import Foundation

enum Ovis {
    static let pluginID = "devswha.ovis"
    static let legacyPluginID = "devswha.herdr-web-ui"
    static let agentLabel = "sh.ovis.herdr-server"
    static let installScript = URL(string: "https://ovis.sh/install.sh")!
    /// Where the installer may come from: ovis.sh redirects to its copy on herdrweb.dev.
    static let installerHosts: Set<String> = ["ovis.sh", "herdrweb.dev"]
    static let support = URL(string: "https://ovis.sh/support/")!
    static let tailscaleDownload = URL(string: "https://tailscale.com/download/mac")!

    static func isInstallerSource(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && installerHosts.contains(url.host?.lowercased() ?? "")
            && url.user == nil && url.password == nil
    }
}

enum Paths {
    static let home = FileManager.default.homeDirectoryForCurrentUser.path
    static var herdr: String { which("herdr") ?? "\(home)/.local/bin/herdr" }
    static var bun: String { which("bun") ?? "\(home)/.bun/bin/bun" }
    static let launchAgent = "\(home)/Library/LaunchAgents/\(Ovis.agentLabel).plist"
    static let logDir = "\(home)/Library/Logs/Ovis"
    /// herdr's output, written by launchd from the LaunchAgent.
    static let serverLog = "\(logDir)/herdr-server.log"
    /// An app opened from Finder gets launchd's bare PATH; the installer and the tools it adds need these.
    static let path = ["\(home)/.local/bin", "\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
    private static func which(_ name: String) -> String? {
        path.split(separator: ":").map { "\($0)/\(name)" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
    static var tailscale: String? {
        let candidates = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
}

func L(_ en: String, _ ko: String) -> String {
    Locale.preferredLanguages.first?.hasPrefix("ko") == true ? ko : en
}

struct RunResult {
    let status: Int32
    let output: String
}

/// Splits a child's output into lines as it arrives; the pipe's handler and the exit handler run on different threads.
final class LineCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()
    private var lines: [String] = []
    private let onLine: (@Sendable (String) -> Void)?

    init(onLine: (@Sendable (String) -> Void)?) {
        self.onLine = onLine
    }

    func append(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            emit(buffer[buffer.startIndex..<newline])
            buffer = Data(buffer[buffer.index(after: newline)...])
        }
    }

    func finish() -> String {
        lock.lock()
        defer { lock.unlock() }
        if !buffer.isEmpty {
            emit(buffer)
            buffer = Data()
        }
        return lines.joined(separator: "\n")
    }

    private func emit(_ data: Data) {
        let line = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\r", with: "")
        lines.append(line)
        onLine?(line)
    }
}

/// With a timeout, a program still running after it is terminated (killed 5 s later if it ignores that), so a
/// hung check cannot hold the window.
func run(_ executable: String, _ arguments: [String], env extra: [String: String] = [:], keepStderr: Bool = true, timeout: TimeInterval? = nil, onLine: (@Sendable (String) -> Void)? = nil) async -> RunResult {
    await withCheckedContinuation { continuation in
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = Paths.path
        for (key, value) in extra { environment[key] = value }
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = keepStderr ? pipe : FileHandle.nullDevice
        let collector = LineCollector(onLine: onLine)
        let reader = pipe.fileHandleForReading
        let done = DispatchGroup()
        done.enter()
        reader.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                done.leave()
            } else {
                collector.append(data)
            }
        }
        process.terminationHandler = { finished in
            // The output can still be in the pipe when the process exits: wait for its end of file, but
            // briefly. A background child the program left behind (the installer's) can hold the pipe
            // open for good, and the window would wait with it.
            DispatchQueue.global().async {
                _ = done.wait(timeout: .now() + 2)
                reader.readabilityHandler = nil
                continuation.resume(returning: RunResult(status: finished.terminationStatus, output: collector.finish()))
            }
        }
        do {
            try process.run()
            if let timeout {
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                    guard process.isRunning else { return }
                    process.terminate()
                    // a program that ignores SIGTERM still has to end, or the window waits with it
                    DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
                        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                    }
                }
            }
        } catch {
            reader.readabilityHandler = nil
            continuation.resume(returning: RunResult(status: -1, output: error.localizedDescription))
        }
    }
}
