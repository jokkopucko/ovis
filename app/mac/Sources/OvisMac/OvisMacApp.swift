import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI

@main
struct OvisMacApp: App {
    @NSApplicationDelegateAdaptor private var delegate: AppDelegate
    @StateObject private var model = Model()

    var body: some Scene {
        // not "main", the setup window's id before: macOS keeps a window's frame by its id, and that one is 520 wide
        Window("Ovis", id: "ovis") {
            MainView()
                .environmentObject(model)
        }
        .defaultSize(width: 1200, height: 800)
        .windowResizability(.contentMinSize)
        .commands { OvisCommands(model: model) }

        Window(L("Phone Setup", "휴대폰 연결"), id: "setup") {
            ContentView()
                .environmentObject(model)
                .frame(width: 520)
                .task { if !model.busy { await model.refresh() } }
        }
        .windowResizability(.contentSize)
    }
}

struct MainView: View {
    @EnvironmentObject private var model: Model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            if let origin = model.webOrigin {
                WebPage(origin: origin, model: model).id(origin)
            } else if model.phase == .checking {
                ProgressView(L("Checking this Mac…", "이 Mac을 확인하는 중…"))
            } else {
                ScrollView { ContentView().frame(width: 520).padding(.vertical, 24) }
            }
        }
        .frame(minWidth: 520, maxWidth: .infinity, minHeight: 420, maxHeight: .infinity)
        .task {
            LaunchAgent.rotateLog()
            await model.refresh()
            await model.monitor()
        }
        .onChange(of: model.phoneSetupRequested) { requested in
            guard requested else { return }
            model.phoneSetupRequested = false
            openWindow(id: "setup")
        }
    }
}

struct OvisCommands: Commands {
    let model: Model

    var body: some Commands {
        CommandGroup(after: .appInfo) { PhoneSetupItem() }
        CommandGroup(replacing: .newItem) { OpenInBrowserItem(model: model) }
        CommandGroup(before: .toolbar) { ReloadItem(model: model) }
    }
}

/// No Cmd+Shift letter here or below: the page's own shortcuts are Cmd+Shift ones (src/lib/shortcuts.ts).
private struct PhoneSetupItem: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button(L("Phone Setup…", "휴대폰 연결…")) { openWindow(id: "setup") }
    }
}

private struct OpenInBrowserItem: View {
    @ObservedObject var model: Model

    var body: some View {
        Button(L("Open in Browser", "브라우저에서 열기")) { model.openInBrowser() }
            .disabled(model.webOrigin == nil)
    }
}

private struct ReloadItem: View {
    @ObservedObject var model: Model

    var body: some View {
        Button(L("Reload", "새로고침")) { model.reload() }
            .keyboardShortcut("r")
            .disabled(model.webOrigin == nil)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

struct ContentView: View {
    @EnvironmentObject private var model: Model
    @State private var confirmRemove = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 14) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Ovis").font(.title.bold())
                    Text(L("Your coding agents, on your phone", "코딩 에이전트를 휴대폰에서")).foregroundStyle(.secondary)
                }
            }
            Divider()
            switch model.phase {
            case .checking:
                ProgressView(L("Checking this Mac…", "이 Mac을 확인하는 중…")).frame(maxWidth: .infinity, minHeight: 160)
            case .notInstalled:
                notInstalled
            case let .working(title):
                working(title)
            case let .failed(message):
                failed(message)
            case .installed:
                installed
            }
        }
        .padding(24)
        .confirmationDialog(L("Remove the Ovis server from this Mac?", "이 Mac에서 Ovis 서버를 제거할까요?"), isPresented: $confirmRemove) {
            Button(L("Remove", "제거"), role: .destructive) { Task { await model.uninstall() } }
        } message: {
            Text(L("herdr, Bun and Node stay, and herdr keeps running with your agents.", "herdr, Bun, Node는 남고, herdr와 에이전트는 계속 실행됩니다."))
        }
    }

    private var notInstalled: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L("Set up this Mac for Ovis", "이 Mac을 Ovis에 연결할 준비를 합니다")).font(.headline)
            Text(L("This installs herdr, Bun, Node and the Ovis server for your user only, with no administrator password, and starts herdr when you log in. Then scan the QR code with Ovis on your phone.",
                   "herdr, Bun, Node, Ovis 서버를 내 사용자 계정에만 설치합니다(관리자 비밀번호 필요 없음). 로그인할 때 herdr가 자동으로 켜집니다. 설치가 끝나면 휴대폰의 Ovis로 QR 코드를 찍으면 됩니다."))
                .fixedSize(horizontal: false, vertical: true)
            Button(L("Install", "설치")) { Task { await model.install() } }
                .buttonStyle(.borderedProminent).controlSize(.large).keyboardShortcut(.defaultAction)
        }
    }

    private func working(_ title: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text(title).font(.headline)
            }
            logView
        }
    }

    private func failed(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.headline)
            logView
            HStack {
                Button(L("Try again", "다시 시도")) { Task { await model.retry() } }.buttonStyle(.borderedProminent)
                Button(L("Copy the log", "오류 내용 복사")) { model.copyLog() }
                Spacer()
                Button(L("Get help", "도움 받기")) { model.open(Ovis.support) }
            }
        }
    }

    private var logView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(model.logText.isEmpty ? " " : model.logText)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                Color.clear.frame(height: 1).id("end")
            }
            .frame(height: 220)
            .background(Color(nsColor: .textBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .onChange(of: model.log.count) { _ in proxy.scrollTo("end") }
        }
    }

    private var installed: some View {
        let status = model.status
        return VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Circle().fill(status?.running == true ? .green : .orange).frame(width: 10, height: 10)
                Text(status?.running == true ? L("Running on this Mac", "이 Mac에서 실행 중") : L("Not running", "꺼져 있음")).font(.headline)
                Spacer()
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .help(L("Check again", "다시 확인"))
                    .accessibilityLabel(L("Check again", "다시 확인"))
            }
            if status?.running == true { phone(status) }
            HStack {
                Button(status?.running == true ? L("Restart", "다시 시작") : L("Start", "시작")) { Task { await model.restart() } }
                Spacer()
                Button(L("Remove…", "제거…")) { confirmRemove = true }
            }
        }
    }

    @ViewBuilder
    private func phone(_ status: Status?) -> some View {
        if let url = status?.phoneURL {
            HStack(alignment: .top, spacing: 18) {
                if let image = qrImage(url.absoluteString) {
                    Image(nsImage: image).interpolation(.none).resizable().frame(width: 180, height: 180)
                        .padding(8).background(.white).clipShape(RoundedRectangle(cornerRadius: 10))
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text(L("Connect your phone", "휴대폰 연결")).font(.headline)
                    Text(L("Open Ovis on your phone, tap Scan QR code, and point it here. Your phone needs Tailscale, signed in to the same account.",
                           "휴대폰에서 Ovis를 열고 Scan QR code를 눌러 이 화면을 찍으세요. 휴대폰에도 같은 계정으로 로그인한 Tailscale이 있어야 합니다."))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(url.absoluteString).font(.caption.monospaced()).textSelection(.enabled).foregroundStyle(.secondary)
                }
            }
        } else if status?.tailscale == "running" {
            VStack(alignment: .leading, spacing: 8) {
                Text(L("Your phone needs an address for this Mac", "휴대폰이 열 주소가 아직 없습니다")).font(.headline)
                Text(L("Tailscale runs here: let it serve the app to your own devices.", "이 Mac에 Tailscale이 있습니다. 내 기기들에서만 열리는 주소를 만듭니다."))
                Button(L("Make the phone address", "휴대폰 주소 만들기")) { Task { await model.makePhoneAddress() } }
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text(L("Your phone needs a way to reach this Mac", "휴대폰에서 이 Mac에 올 길이 필요합니다")).font(.headline)
                Text(status?.tailscale == "stopped"
                     ? L("Tailscale is installed but not signed in. Sign in to it, then check again.", "Tailscale이 설치돼 있지만 로그인되지 않았습니다. 로그인한 뒤 다시 확인해 주세요.")
                     : L("Install Tailscale on this Mac and on your phone, sign in to both with the same account, then check again.", "이 Mac과 휴대폰에 Tailscale을 설치하고 같은 계정으로 로그인한 뒤 다시 확인해 주세요."))
                    .fixedSize(horizontal: false, vertical: true)
                if status?.tailscale != "stopped" {
                    Button(L("Get Tailscale", "Tailscale 받기")) { model.open(Ovis.tailscaleDownload) }
                }
            }
        }
    }
}

func qrImage(_ text: String) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else { return nil }
    let rep = NSCIImageRep(ciImage: output)
    let image = NSImage(size: rep.size)
    image.addRepresentation(rep)
    return image
}
