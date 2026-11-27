import XCTest
@testable import OvisHomeCore

/// Android's twins: PCStoreTest opensATappedAlertOnItsPaneInThePcThatSentIt and the two after it.
final class AlertTests: XCTestCase {
    private let id = "0123456789abcdef0123456789abcdef"
    private let home = "http://desktop.lan:7317", laptop = "https://laptop.example.ts.net"
    private let hosted = URL(string: "https://app.ovis.sh")!, inApp = URL(string: "capacitor://app.ovis.sh")!
    private var scope: String { "https://app.ovis.sh/s/\(id)/" }
    private var inAppScope: String { "capacitor://app.ovis.sh/s/\(id)/" }

    private func link(_ saved: [String], _ stored: String?, _ serverId: String?, machine: String? = nil, workspace: String? = nil,
                      pane: String? = "w1:p1", shell: URL? = nil) -> Alert.Link? {
        Alert.link(saved: saved, stored: stored, alert: .init(pane: pane, machine: machine, workspace: workspace, serverId: serverId), shell: shell ?? hosted)
    }

    private func selection(_ link: Alert.Link?) throws -> [String: String] {
        let data = try XCTUnwrap(link?.selection.data(using: .utf8))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
    }

    func testATappedAlertOpensItsPaneOnThePcThatSentIt() {
        let saved = [home, scope, laptop]
        XCTAssertEqual(link(saved, home, id, workspace: "w1")?.pc, home)
        XCTAssertEqual(link(saved, home, id, workspace: "w1")?.address, home + "/?machine=local&ws=w1&pane=w1%3Ap1&view=chat")
        XCTAssertEqual(link(saved, home, nil, machine: "build box", pane: "w2:p3")?.address, home + "/?machine=build%20box&pane=w2%3Ap3&view=chat")
        // a relay PC by its relay ID, its pane in its scope's fragment, from the hosted app's or that scope's endpoint
        for stored in ["https://app.ovis.sh", scope] {
            XCTAssertEqual(link(saved, stored, id, machine: "local", workspace: "w1")?.pc, scope, stored)
            XCTAssertEqual(link(saved, stored, id, machine: "local", workspace: "w1")?.address, scope + "#machine=local&ws=w1&pane=w1%3Ap1&view=chat", stored)
        }
        XCTAssertEqual(link(saved, laptop, id)?.pc, laptop)
        // no pane (the confirmation push), or no PC this phone keeps
        XCTAssertNil(link(saved, home, id, pane: nil))
        XCTAssertNil(link(saved, home, id, pane: ""))
        XCTAssertNil(link(saved, "http://forgotten.lan:7317", nil))
        XCTAssertNil(link(saved, "https://app.ovis.sh", "fedcba9876543210fedcba9876543210"))
        XCTAssertNil(link(saved, "https://app.ovis.sh", "../evil"))
        XCTAssertNil(link(saved, "https://app.ovis.sh", id.uppercased()))
        XCTAssertNil(link(saved, nil, nil))
        // a relay ID never moves an alert from a saved address, nor from another relay PC's scope, to a scope
        XCTAssertNil(link([scope], "http://forgotten.lan:7317", id))
        XCTAssertNil(link([scope], home, id))
        XCTAssertNil(link([scope, "https://app.ovis.sh/s/fedcba9876543210fedcba9876543210/"], "https://app.ovis.sh/s/fedcba9876543210fedcba9876543210/", id))
        // the hosted app kept as the PC is never the alert's PC itself
        XCTAssertEqual(link([home, scope, "https://app.ovis.sh"], "https://app.ovis.sh", id)?.pc, scope)
        XCTAssertNil(link(["https://app.ovis.sh"], "https://app.ovis.sh", id))
        XCTAssertNil(link(["https://app.ovis.sh"], "https://app.ovis.sh", nil))
    }

    func testARelayIdAloneDoesNotIdentifyTheAlertsPc() {
        XCTAssertNil(link([scope], nil, id))
        XCTAssertNil(link([inAppScope], nil, id, shell: inApp))
    }

    func testAnAlertFromAPreviousOccupantDoesNotOpenAReusedAddress() {
        let alert = Alert.Payload(pane: "w1:p1", serverId: id)
        XCTAssertNil(Alert.link(saved: [home], stored: home, alert: alert, shell: hosted,
                                knownServerId: "fedcba9876543210fedcba9876543210"))
        XCTAssertEqual(Alert.link(saved: [home], stored: home, alert: alert, shell: hosted, knownServerId: id)?.pc, home)
        XCTAssertEqual(Alert.link(saved: [home], stored: home, alert: .init(pane: "w1:p1"), shell: hosted, knownServerId: id)?.pc, home)
    }

    func testABuildThatServesTheShellItselfOpensRelayPcsThereAndNotOnTheNetwork() {
        let saved = [home, inAppScope, "capacitor://app.ovis.sh"]
        for stored in ["capacitor://app.ovis.sh", inAppScope] {
            XCTAssertEqual(link(saved, stored, id, shell: inApp)?.pc, inAppScope, stored)
            XCTAssertEqual(link(saved, stored, id, shell: inApp)?.address, inAppScope + "#machine=local&pane=w1%3Ap1&view=chat", stored)
        }
        XCTAssertEqual(link(saved, home, id, shell: inApp)?.pc, home)
        // an endpoint the update set aside, kept under the hosted origin's key (PCStore.settleShell): not this pairing's
        XCTAssertNil(link(saved, scope, id, shell: inApp))
        XCTAssertNil(link(saved, "https://app.ovis.sh", id, shell: inApp))
        // a scope of the hosted origin, which this build no longer opens
        XCTAssertNil(link([scope], scope, id, shell: inApp))
    }

    func testABuildForAnotherHostedOriginTakesThatOrigin() {
        let preview = URL(string: "https://relay-0510.ovis-app.pages.dev")!
        let previewScope = "https://relay-0510.ovis-app.pages.dev/s/\(id)/"
        XCTAssertEqual(link([home, previewScope, preview.absoluteString], preview.absoluteString, id, shell: preview)?.pc, previewScope)
        XCTAssertEqual(link([home, "https://app.ovis.sh"], home, id, shell: preview)?.pc, home)
        XCTAssertNil(link([scope], scope, id, shell: preview))
        // a shell on a port of its own: that port, and no other
        let local = URL(string: "https://shell.example.ts.net:8443")!
        XCTAssertEqual(link(["https://shell.example.ts.net:8443/s/\(id)/"], local.absoluteString, id, shell: local)?.pc, "https://shell.example.ts.net:8443/s/\(id)/")
        XCTAssertNil(link(["https://shell.example.ts.net/s/\(id)/"], local.absoluteString, id, shell: local))
        // no shell at all: relay PCs are nobody's
        XCTAssertNil(Alert.link(saved: [scope], stored: scope, alert: .init(pane: "w1:p1", serverId: id), shell: nil))
        XCTAssertEqual(Alert.link(saved: [home], stored: home, alert: .init(pane: "w1:p1", serverId: id), shell: nil)?.pc, home)
    }

    func testTheSelectionCarriesThePaneAsItCame() throws {
        let same = try selection(link([home], home, id, workspace: "w1"))
        XCTAssertEqual(same, ["type": "select-pane", "pane_id": "w1:p1", "machine_id": "local", "view": "chat", "workspace_id": "w1"])
        // whatever the values hold, they reach the page as a JSON value
        let odd = "p\"); alert(1); //\u{2028}</script>"
        let relay = try XCTUnwrap(link([scope], "https://app.ovis.sh", id, machine: "build box", pane: odd))
        XCTAssertEqual(try selection(relay), ["type": "select-pane", "pane_id": odd, "machine_id": "build box", "view": "chat"])
        XCTAssertFalse(relay.selection.contains("\u{2028}"))
        XCTAssertTrue(relay.selection.contains("\\u2028"))
        let script = Alert.selectionScript(relay.selection)
        XCTAssertTrue(script.hasPrefix("(() => { const data = " + relay.selection + "; "))
        XCTAssertTrue(script.contains("new MessageEvent('ovis-select-pane', { data, cancelable: true })"))
        XCTAssertTrue(script.hasSuffix("return true; })()"))
    }

    func testThePageOfTheAlertsPcIsHandedThePaneAndAnyOtherOpensItsAddress() {
        let alert = link([home, scope, laptop], home, id)!
        XCTAssertTrue(Alert.handsToPage(alert, shown: home + "/?machine=local&pane=w1%3Ap0", belongs: true))
        // not a page of that PC, or none up: its address opens
        XCTAssertFalse(Alert.handsToPage(alert, shown: laptop + "/", belongs: false))
        XCTAssertFalse(Alert.handsToPage(alert, shown: nil, belongs: true))
        // a relay PC's page in the hosted app kept as the PC is that relay PC's
        let relay = link([scope, "https://app.ovis.sh"], "https://app.ovis.sh", id)!
        XCTAssertTrue(Alert.handsToPage(relay, shown: scope + "#machine=local", belongs: true))
    }

    func testOnlyAnAppPageIsHandedThePaneAndAReaderOrAFileGetsTheAddress() {
        for shown in [home, home + "/", home + "/index.html", home + "/?machine=local&pane=w1%3Ap0", home + "/?read=", home + "/?read=+%20%C2%A0",
                      home + "/?read=%E2%80%A8%EF%BB%BF", home + "/#read=notes.md", home + "/?"] {
            XCTAssertTrue(Alert.appPage(shown, key: home), shown)
        }
        for shown in [scope, scope + "#machine=local&pane=w1%3Ap0", scope + "?machine=local#read=notes.md", "capacitor://app.ovis.sh/s/\(id)/#machine=local"] {
            XCTAssertTrue(Alert.appPage(shown, key: shown.hasPrefix("capacitor") ? inAppScope : scope), shown)
        }
        for shown in [home + "/?read=notes.md", home + "/?machine=local&read=docs%2Fa.md", home + "/?%72ead=notes.md", home + "/?read=%C2%85",
                      home + "/api/file?path=a.html", home + "/ws", home + "/social-preview.png", home + "/notes.md"] {
            XCTAssertFalse(Alert.appPage(shown, key: home), shown)
        }
        for shown in [scope + "#read=notes.md", scope + "#machine=local&read=a.md", scope + "?read=notes.md"] {
            XCTAssertFalse(Alert.appPage(shown, key: scope), shown)
        }
    }

    func testThePayloadIsReadFromThePcsJson() {
        let plain = #"{"title":"t","body":"b","tag":"x","pane_id":"w1:p1","machine_id":"local","workspace_id":"w1","endpoint":"https://push.ovis.sh/v1/push/a","server_id":"\#(id)","actions":[{"option_index":0,"label":"Yes"}]}"#
        XCTAssertEqual(Alert.payload(Data(plain.utf8)), Alert.Payload(pane: "w1:p1", machine: "local", workspace: "w1", endpoint: "https://push.ovis.sh/v1/push/a", serverId: id))
        // the confirmation push, and an older PC's alert
        XCTAssertEqual(Alert.payload(Data(#"{"title":"t","body":"b","tag":"x","pane_id":null}"#.utf8)), Alert.Payload(pane: nil))
        XCTAssertEqual(Alert.payload(Data(#"{"pane_id":"w1:p1"}"#.utf8)), Alert.Payload(pane: "w1:p1"))
        XCTAssertNil(Alert.payload(Data(#"{"pane_id":7}"#.utf8)))
        XCTAssertNil(Alert.payload(Data("not json".utf8)))
    }
}
