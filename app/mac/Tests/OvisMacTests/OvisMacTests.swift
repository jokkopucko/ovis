import Foundation
import XCTest
@testable import OvisMac

final class InstallerSourceTests: XCTestCase {
    func testTakesTheInstallerOnlyOverHTTPSFromItsOwnHosts() {
        XCTAssertTrue(Ovis.isInstallerSource(URL(string: "https://ovis.sh/install.sh")!))
        XCTAssertTrue(Ovis.isInstallerSource(URL(string: "https://herdrweb.dev/install.sh")!))
        XCTAssertFalse(Ovis.isInstallerSource(URL(string: "http://herdrweb.dev/install.sh")!))
        XCTAssertFalse(Ovis.isInstallerSource(URL(string: "https://herdrweb.dev.example.com/install.sh")!))
        XCTAssertFalse(Ovis.isInstallerSource(URL(string: "https://example.com/install.sh")!))
        XCTAssertFalse(Ovis.isInstallerSource(URL(string: "https://ovis.sh@example.com/install.sh")!))
    }
}

final class StatusAddressTests: XCTestCase {
    func testDrawsTheQRCodeOnlyForTailscalesHTTPSName() {
        XCTAssertEqual(Status.phoneAddress("https://mac.tail1e211e.ts.net")?.absoluteString, "https://mac.tail1e211e.ts.net")
        XCTAssertEqual(Status.phoneAddress("https://mac.tail1e211e.ts.net:8443/")?.port, 8443)
        for refused in ["http://mac.tail1e211e.ts.net", "https://example.com", "https://mac.ts.net.example.com", "https://.ts.net",
                        "https://me@mac.tail1e211e.ts.net", "https://mac.tail1e211e.ts.net/elsewhere", "https://mac.tail1e211e.ts.net/?next=x",
                        "javascript:alert(1)", "https://100.64.0.1"] {
            XCTAssertNil(Status.phoneAddress(refused), refused)
        }
    }

    func testTakesOnlyAWebAddressAsTheServersOrigin() {
        XCTAssertEqual(Status.serverOrigin("http://127.0.0.1:7317")?.port, 7317)
        XCTAssertNil(Status.serverOrigin("file:///etc/passwd"))
        XCTAssertNil(Status.serverOrigin("x-other-app://open"))
        XCTAssertNil(Status.serverOrigin("(pid"))
    }
}

final class RunningCodeTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("ovis-tests-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: dir)
    }

    private func code(_ name: String) throws -> String {
        let code = dir.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: code.appendingPathComponent("scripts"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: code.appendingPathComponent("server"), withIntermediateDirectories: true)
        try Data("\"phone\"".utf8).write(to: code.appendingPathComponent("scripts/plugin.ts"))
        return code.path
    }

    func testTakesTheBridgesDirWhenItIsTheCheckoutOrARelease() throws {
        let root = try code("plugin")
        let release = try code("state/updates/8e64ff3e5eb22439/release-2")
        XCTAssertEqual(Model.codeDir(release, root: root), release)
        XCTAssertEqual(Model.codeDir(root, root: root), root)
    }

    func testTakesNoOtherDir() throws {
        let root = try code("plugin")
        let other = try code("elsewhere")
        let release = try code("release-3")
        XCTAssertNil(Model.codeDir(other, root: root))
        XCTAssertNil(Model.codeDir("release-3", root: root))
        // a release whose plugin.ts is a link out of it, as scripts/plugin-runtime.ts refuses
        try FileManager.default.removeItem(atPath: "\(release)/scripts/plugin.ts")
        try FileManager.default.createSymbolicLink(atPath: "\(release)/scripts/plugin.ts", withDestinationPath: "\(other)/scripts/plugin.ts")
        XCTAssertNil(Model.codeDir(release, root: root))
        try FileManager.default.removeItem(atPath: "\(release)/scripts/plugin.ts")
        XCTAssertNil(Model.codeDir(release, root: root))
    }

    func testTakesOnlyThisCheckoutsLauncher() throws {
        let root = try code("plugin")
        let other = try code("other")
        XCTAssertTrue(Model.isLauncher(["/bun", "\(root)/server/managed.ts"], root: root))
        XCTAssertFalse(Model.isLauncher(["/bun", "\(other)/server/managed.ts"], root: root))
        XCTAssertFalse(Model.isLauncher(["/bun", "\(root)/server/supervisor.ts"], root: root))
        XCTAssertFalse(Model.isLauncher(["/bun", "server/managed.ts"], root: root))
        XCTAssertFalse(Model.isLauncher(["\(root)/server/managed.ts"], root: root))
    }

    func testParsesTheKernelsArgumentsOnlyWhenEachEnds() {
        let header: [UInt8] = [2, 0, 0, 0] + Array("/bin/bun".utf8) + [0, 0, 0]
        XCTAssertEqual(Model.parseArguments(header + Array("bun".utf8) + [0] + Array("/r/server/managed.ts".utf8) + [0, 0]), ["bun", "/r/server/managed.ts"])
        XCTAssertNil(Model.parseArguments(header + Array("bun".utf8) + [0] + Array("/r/release-x/server/supervisor.ts".utf8)))
        XCTAssertNil(Model.parseArguments(header + Array("bun".utf8) + [0]))
        XCTAssertNil(Model.parseArguments([2, 0, 0]))
    }

    func testReadsAProcesssArgumentsAndDirFromTheKernel() throws {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        child.currentDirectoryURL = dir
        try child.run()
        defer { child.terminate(); child.waitUntilExit() }
        XCTAssertEqual(Model.processArguments(child.processIdentifier), ["/bin/sleep", "30"])
        XCTAssertEqual(Model.processDirectory(child.processIdentifier).map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }, dir.path)
        XCTAssertNil(Model.processArguments(-1))
        XCTAssertNil(Model.processDirectory(-1))
    }

    @MainActor
    func testFindsTheReleaseTheBridgeRunsUnderThisCheckoutsLauncher() async throws {
        let root = try code("plugin")
        let release = try code("state/updates/8e64ff3e5eb22439/release-2")
        try Data("/bin/sh \(root)/server/supervisor.ts\n:\n".utf8).write(to: URL(fileURLWithPath: "\(root)/server/managed.ts"))
        try Data("cd \(release) && /bin/sh server/index.ts\n:\n".utf8).write(to: URL(fileURLWithPath: "\(root)/server/supervisor.ts"))
        try Data("echo ready\nread line\n".utf8).write(to: URL(fileURLWithPath: "\(release)/server/index.ts"))
        let stdin = Pipe()
        let stdout = Pipe()
        let launcher = Process()
        launcher.executableURL = URL(fileURLWithPath: "/bin/sh")
        launcher.arguments = ["\(root)/server/managed.ts"]
        launcher.standardInput = stdin
        launcher.standardOutput = stdout
        try launcher.run()
        defer { try? stdin.fileHandleForWriting.close(); launcher.waitUntilExit() }
        XCTAssertEqual(String(decoding: stdout.fileHandleForReading.availableData, as: UTF8.self), "ready\n")
        let found = await Model.runningCode(launcher: launcher.processIdentifier, root: root)
        XCTAssertEqual(found, release)
        let another = try code("another")
        let notOurs = await Model.runningCode(launcher: launcher.processIdentifier, root: another)
        XCTAssertNil(notOurs)
    }

    func testReadsTheLaunchersPidFromTheStatusLine() {
        let up = Status.parse("running http://127.0.0.1:7317 (pid 4242)")
        XCTAssertEqual(up.pid, 4242)
        XCTAssertEqual(up.origin?.port, 7317)
        XCTAssertTrue(up.running)
        XCTAssertNil(Status.parse("down http://127.0.0.1:7317").pid)
        XCTAssertNil(Status.parse("running http://127.0.0.1:7317 (pid x)").pid)
    }
}

final class PluginLookupTests: XCTestCase {
    func testTellsAFailedListFromAPluginThatIsGone() {
        let list = { (plugins: String) in "{\"result\": {\"plugins\": [\(plugins)]}}" }
        XCTAssertEqual(Model.plugin(in: list("{\"plugin_id\": \"devswha.herdr-web-ui\", \"plugin_root\": \"/old\"}"), status: 0), .found(id: "devswha.herdr-web-ui", root: "/old"))
        XCTAssertEqual(Model.plugin(in: list("{\"plugin_id\": \"someone.else\", \"plugin_root\": \"/x\"}"), status: 0), .none)
        XCTAssertEqual(Model.plugin(in: list(""), status: 1), .failed)
        XCTAssertEqual(Model.plugin(in: "herdr: not running", status: 0), .failed)
        XCTAssertEqual(Model.plugin(in: "", status: 15), .failed)
    }
}

final class ServedPortsTests: XCTestCase {
    func testFindsTheHTTPSPortsThatServeTheAppsPort() {
        let json = """
        {"TCP": {"443": {"HTTPS": true}, "8443": {"HTTPS": true}, "10000": {"HTTPS": true}, "8080": {"HTTP": true}},
         "Web": {"mac.tail1e211e.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3000"}}},
                 "mac.tail1e211e.ts.net:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:7317"}}},
                 "mac.tail1e211e.ts.net:10000": {"Handlers": {"/": {"Proxy": "http://localhost:7317/"}}},
                 "mac.tail1e211e.ts.net:8080": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:7317"}}}}}
        """
        XCTAssertEqual(Model.servedHTTPSPorts(Data(json.utf8), appPort: 7317), [8443, 10000])
        XCTAssertEqual(Model.servedHTTPSPorts(Data("{}".utf8), appPort: 7317), [])
        XCTAssertEqual(Model.servedHTTPSPorts(Data("not json".utf8), appPort: 7317), [])
    }
}

final class LogRotationTests: XCTestCase {
    func testMovesALongLogAsideAndLaunchdsAppendsStartAgainAtItsBeginning() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ovis-log-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = dir.appendingPathComponent("herdr-server.log").path
        try Data("0123456789abcdef\n".utf8).write(to: URL(fileURLWithPath: log))
        // launchd opens the log for appending and keeps it open while herdr runs
        let launchd = open(log, O_WRONLY | O_APPEND)
        XCTAssertGreaterThanOrEqual(launchd, 0)
        defer { close(launchd) }

        LaunchAgent.rotateLog(log, limit: 100)
        XCTAssertEqual(try String(contentsOfFile: log, encoding: .utf8), "0123456789abcdef\n", "under the limit it stays")

        LaunchAgent.rotateLog(log, limit: 8)
        XCTAssertEqual(try String(contentsOfFile: "\(log).1", encoding: .utf8), "0123456789abcdef\n")
        XCTAssertEqual(try String(contentsOfFile: log, encoding: .utf8), "")
        _ = "after\n".withCString { write(launchd, $0, 6) }
        XCTAssertEqual(try String(contentsOfFile: log, encoding: .utf8), "after\n")
    }

    func testRotatesTheFileALinkedLogPointsAt() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ovis-log-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let target = dir.appendingPathComponent("real.log").path
        let link = dir.appendingPathComponent("herdr-server.log").path
        try Data(String(repeating: "x", count: 64).utf8).write(to: URL(fileURLWithPath: target))
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: target)
        LaunchAgent.rotateLog(link, limit: 8)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: target)[.size] as? Int, 0)
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: link), target)
        XCTAssertEqual(try String(contentsOfFile: "\(target).1", encoding: .utf8).count, 64)
    }
}

final class LinkBrowsersTests: XCTestCase {
    func testHandsOnlyAWebAddressToTheChosenBrowser() {
        XCTAssertEqual(LinkBrowsers.webAddress("https://example.com/a?b=c")?.host, "example.com")
        XCTAssertNotNil(LinkBrowsers.webAddress("HTTP://example.com"))
        for refused in ["mailto:team@ovis.sh", "file:///etc/passwd", "javascript:alert(1)", "ovis://open?pane=t3", "x-other-app://open", "not an address"] {
            XCTAssertNil(LinkBrowsers.webAddress(refused), refused)
        }
    }

    func testFindsAgentBrowserOnThePathOrWhereNpmBunAndHomebrewPutIt() {
        let at = { (paths: [String]) in { (path: String) in paths.contains(path) } }
        XCTAssertEqual(LinkBrowsers.agentBrowserProgram(path: "/usr/bin:/opt/bin", home: "/Users/u", isProgram: at(["/opt/bin/agent-browser", "/opt/homebrew/bin/agent-browser"]))?.path, "/opt/bin/agent-browser")
        XCTAssertEqual(LinkBrowsers.agentBrowserProgram(path: "/usr/bin", home: "/Users/u", isProgram: at(["/Users/u/.bun/bin/agent-browser"]))?.path, "/Users/u/.bun/bin/agent-browser")
        XCTAssertNil(LinkBrowsers.agentBrowserProgram(path: "", home: "/Users/u", isProgram: at([])))
    }
}
