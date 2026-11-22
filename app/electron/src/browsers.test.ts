import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { agentBrowser, desktopCommand, findProgram, linuxBrowsers, linuxEntries, macBrowsers, parseDesktopEntry, parseRegQuery, readLinkBrowser, runsInterpreter, webAddress, windowsBrowsers, windowsCommand, windowsCommandWords, writeLinkBrowser } from "./browsers.ts";

const URL_ = "https://example.com/a b?q=\"x\"&y=%41 'z' $(id)";
const ADDRESS = webAddress(URL_)!;

const desktop = (lines: string[]) => ["[Desktop Entry]", "Type=Application", ...lines, "[Desktop Action new-window]", "Name=New Window", "Exec=/bin/false"].join("\n");

describe("webAddress", () => {
  it("takes http(s) alone, written so a quote or a space in it cannot end the argument", () => {
    expect(ADDRESS).toBe("https://example.com/a%20b?q=%22x%22&y=%41%20%27z%27%20$(id)");
    for (const url of ["mailto:team@ovis.sh", "file:///etc/passwd", "javascript:alert(1)", "ovis://open", "not an address"]) expect(webAddress(url)).toBeNull();
  });
});

describe("parseDesktopEntry", () => {
  it("reads the [Desktop Entry] group only, and whether it takes https and is shown", () => {
    expect(parseDesktopEntry(desktop(["Name=Brave Web Browser", "Exec=/usr/bin/brave %U", "MimeType=text/html;x-scheme-handler/https;"]))).toEqual({ name: "Brave Web Browser", exec: "/usr/bin/brave %U", icon: null, location: null, web: true, shown: true });
    expect(parseDesktopEntry(desktop(["Name=Chrome", "Exec=chrome %U", "MimeType=x-scheme-handler/http;", "NoDisplay=true"]))).toMatchObject({ web: true, shown: false });
    expect(parseDesktopEntry(desktop(["Name=Editor", "Exec=edit %F", "MimeType=text/plain;"]))).toMatchObject({ web: false });
    expect(parseDesktopEntry(["[Desktop Entry]", "Type=Link", "Name=Site", "URL=https://ovis.sh"].join("\n"))).toBeNull();
  });
});

describe("desktopCommand", () => {
  it("fills the field codes itself, the address always one argument", () => {
    const entry = (exec: string, icon: string | null = null) => ({ exec, name: "Web", icon, location: "/usr/share/applications/web.desktop" });
    const cases: [string, string[]][] = [
      ["/usr/bin/brave %U", ["/usr/bin/brave", ADDRESS]],
      ["firefox --new-tab %u", ["firefox", "--new-tab", ADDRESS]],
      ["browser --desktop-entry %k %u", ["browser", "--desktop-entry", "/usr/share/applications/web.desktop", ADDRESS]],
      ["\"/opt/My Browser/run\" %U", ["/opt/My Browser/run", ADDRESS]],
      ["\"/opt/a\\\"b\" %f", ["/opt/a\"b", ADDRESS]],
      ["web %i --class %c %d %% %U", ["web", "--icon", "web-icon", "--class", "Web", "%", ADDRESS]],
      ["/usr/bin/flatpak run --file-forwarding org.mozilla.firefox @@u %u @@", ["/usr/bin/flatpak", "run", "--file-forwarding", "org.mozilla.firefox", "@@u", ADDRESS, "@@"]],
      ["/usr/bin/plain", ["/usr/bin/plain", ADDRESS]],
    ];
    for (const [exec, command] of cases) expect(desktopCommand(entry(exec, "web-icon"), ADDRESS)).toEqual(command);
    expect(desktopCommand(entry("web %i %U"), ADDRESS)).toEqual(["web", ADDRESS]);
  });

  it("refuses an Exec line it cannot read", () => {
    expect(desktopCommand({ exec: "\"/opt/unclosed %U", name: "Web", icon: null }, ADDRESS)).toBeNull();
    expect(desktopCommand({ exec: "   ", name: "Web", icon: null }, ADDRESS)).toBeNull();
  });

  it("refuses an Exec line where the address would not be an argument of its own, or a program would read it as code", () => {
    for (const exec of ["sh -c \"browser %u\"", "/bin/bash -c \"exec firefox '%U'\"", "web \"--url=%f\"", "browser --url=%u", "sh -c browser%u", "/usr/bin/env browser %u", "python3 open.py %u", "web %u %U", "web --desktop-entry %k %u", "%u", "%c --flag %u", "/usr/bin/%i %u"]) {
      expect(desktopCommand({ exec, name: "Web", icon: null }, webAddress("https://a.example/x$(id)?q=$(id)")!)).toBeNull();
    }
    expect(desktopCommand({ exec: "\"/opt/My Browser/run\" --class \"%c\" %u", name: "Web", icon: null }, ADDRESS)).toEqual(["/opt/My Browser/run", "--class", "Web", ADDRESS]);
  });
});

describe("Linux browsers", () => {
  const files: Record<string, string> = {
    "/home/u/.local/share/applications/firefox.desktop": desktop(["Name=Firefox (mine)", "Exec=/home/u/firefox/firefox %u", "MimeType=x-scheme-handler/https;"]),
    "/usr/share/applications/firefox.desktop": desktop(["Name=Firefox", "Exec=firefox %u", "MimeType=x-scheme-handler/https;"]),
    "/usr/share/applications/google-chrome.desktop": desktop(["Name=Google Chrome", "Exec=/usr/bin/google-chrome-stable %U", "MimeType=x-scheme-handler/https;"]),
    "/usr/share/applications/com.google.Chrome.desktop": desktop(["Name=Google Chrome", "Exec=/usr/bin/google-chrome-stable %U", "MimeType=x-scheme-handler/https;", "NoDisplay=true"]),
    "/usr/share/applications/kde/konqueror.desktop": desktop(["Name=Konqueror", "Exec=kfmclient openURL %u", "MimeType=x-scheme-handler/http;"]),
    "/usr/share/applications/gedit.desktop": desktop(["Name=Text Editor", "Exec=gedit %U", "MimeType=text/plain;"]),
  };
  const dirs = ["/home/u/.local/share/applications", "/usr/share/applications"];
  const list = (dir: string) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`));
  const entries = linuxEntries(dirs, (path) => files[path]!, list);

  it("takes each desktop file id from the first data dir that has it, a subfolder joined with a dash", () => {
    expect([...entries.keys()].sort()).toEqual(["com.google.Chrome.desktop", "firefox.desktop", "google-chrome.desktop", "kde-konqueror.desktop"]);
    expect(entries.get("firefox.desktop")?.name).toBe("Firefox (mine)");
  });

  it("lists the shown ones once each, and names the default even when its entry is hidden", () => {
    const found = linuxBrowsers(entries, "com.google.Chrome.desktop");
    expect(found.browsers.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "desktop:firefox.desktop", name: "Firefox (mine)" },
      { id: "desktop:google-chrome.desktop", name: "Google Chrome" },
      { id: "desktop:kde-konqueror.desktop", name: "Konqueror" },
    ]);
    expect(found.systemDefault).toBe("Google Chrome");
    expect(found.browsers[2]!.command(ADDRESS)).toEqual(["kfmclient", "openURL", ADDRESS]);
    expect(entries.get("firefox.desktop")?.location).toBe("/home/u/.local/share/applications/firefox.desktop");
    expect(linuxBrowsers(entries, null).systemDefault).toBeNull();
  });
});

describe("Windows browsers", () => {
  const machine = [
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome",
    "    (기본값)    REG_SZ    Google Chrome",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\Capabilities",
    "    ApplicationName    REG_SZ    Google Chrome",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\Capabilities\\URLAssociations",
    "    http    REG_SZ    ChromeHTML",
    "    https    REG_SZ    ChromeHTML",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\shell\\open\\command",
    "    (Default)    REG_SZ    \"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\"",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Microsoft Edge",
    "    (Default)    REG_SZ    Microsoft Edge",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Microsoft Edge\\Capabilities",
    "    ApplicationName    REG_SZ    @C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe,-1",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Microsoft Edge\\shell\\open\\command",
    "    (Default)    REG_SZ    \"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe\" --profile-directory=\"Work Profile\" \"%1\" --new-window",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Broken",
    "    (Default)    REG_SZ    Broken",
  ].join("\r\n");
  const user = [
    "HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet\\egolite",
    "    (Default)    REG_SZ    ego lite",
    "",
    "HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet\\egolite\\Capabilities\\URLAssociations",
    "    https    REG_SZ    egoliteURL",
    "",
    "HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet\\egolite\\shell\\open\\command",
    "    (Default)    REG_SZ    C:\\Users\\u\\AppData\\Local\\egolite\\egolite.exe",
  ].join("\r\n");

  it("reads each client's command whatever the system calls the default value, the user's clients first", () => {
    const found = windowsBrowsers([parseRegQuery(user), parseRegQuery(machine)], "ChromeHTML");
    expect(found.browsers.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "windows:egolite", name: "egolite" },
      { id: "windows:google chrome", name: "Google Chrome" },
      { id: "windows:microsoft edge", name: "Microsoft Edge" },
    ]);
    expect(found.systemDefault).toBe("Google Chrome");
    expect(found.browsers[1]!.command(ADDRESS)).toEqual(["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ADDRESS]);
    expect(found.browsers[2]!.command(ADDRESS)).toEqual(["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "--profile-directory=Work Profile", ADDRESS, "--new-window"]);
    expect(windowsBrowsers([parseRegQuery(machine)], "egoliteURL").systemDefault).toBeNull();
  });

  it("splits a command line as Windows does, a quote inside a word kept to that word", () => {
    expect(windowsCommandWords("\"C:\\a b\\x.exe\" -osint -url \"%1\"")).toEqual(["C:\\a b\\x.exe", "-osint", "-url", "%1"]);
    expect(windowsCommandWords("x.exe --name=\"a \\\"b\\\" c\" C:\\dir\\ end")).toEqual(["x.exe", "--name=a \"b\" c", "C:\\dir\\", "end"]);
    expect(windowsCommandWords("firefox.exe -P \"\"\"Work\"\"\" -osint -url \"%1\"")).toEqual(["firefox.exe", "-P", "\"Work\"", "-osint", "-url", "%1"]);
    // shell32's CommandLineToArgvW on Windows 11 (winvm): "" in quotes is a quote, and the quotes end
    expect(windowsCommandWords("firefox.exe -P \"\\\"Work\"\" -no-remote")).toEqual(["firefox.exe", "-P", "\"Work\"", "-no-remote"]);
    // the program is read as it stands, backslashes and inner quotes included
    expect(windowsCommandWords("\"C:\\a\\\"b.exe\" x")).toEqual(["C:\\a\\", "b.exe x"]);
    expect(windowsCommandWords("C:\\a\"b c\".exe y")).toEqual(["C:\\a\"b", "c.exe y"]);
    expect(windowsCommandWords("\"C:\\dir\\\\\" z")).toEqual(["C:\\dir\\\\", "z"]);
  });

  it("puts the address where %1 stands, at the end without one, and refuses what would not keep it an argument", () => {
    expect(windowsCommand(["x.exe", "-url", "%1", "--flag"], ADDRESS)).toEqual(["x.exe", "-url", ADDRESS, "--flag"]);
    expect(windowsCommand(["x.exe", "%*"], ADDRESS)).toEqual(["x.exe", ADDRESS]);
    for (const words of [["x.exe", "-url=%1"], ["C:\\Windows\\System32\\cmd.exe", "/c", "start", "%1"], ["powershell.exe", "-c", "%1"], ["C:\\tools\\open.bat", "%1"], ["%1"], ["%1", "--flag"], []]) {
      expect(windowsCommand(words, ADDRESS)).toBeNull();
    }
  });
});

describe("runsInterpreter", () => {
  it("names shells, interpreters and Windows scripts, and not browsers", () => {
    for (const program of ["sh", "/bin/bash", "/usr/bin/env", "python3.12", "C:\\Windows\\System32\\cmd.exe", "pwsh.exe", "C:\\a\\open.bat", "run.ps1"]) expect(runsInterpreter(program)).toBe(true);
    for (const program of ["/usr/bin/firefox", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "kfmclient", "/usr/bin/flatpak"]) expect(runsInterpreter(program)).toBe(false);
  });
});

describe("macOS browsers", () => {
  it("lists LaunchServices' https handlers once per bundle id, opened by their path", () => {
    const found = macBrowsers(JSON.stringify({
      apps: [
        { path: "/Applications/Safari.app", id: "com.apple.Safari", name: "Safari" },
        { path: "/Applications/ego lite.app", id: "app.ego.lite", name: null },
        { path: "/Users/u/Applications/Safari.app", id: "com.apple.Safari", name: "Safari" },
        { path: 3, id: "broken" },
      ],
      preferred: "/Applications/ego lite.app",
    }));
    expect(found.browsers.map(({ id, name }) => ({ id, name }))).toEqual([{ id: "mac:com.apple.Safari", name: "Safari" }, { id: "mac:app.ego.lite", name: "ego lite" }]);
    expect(found.systemDefault).toBe("ego lite");
    expect(found.browsers[1]!.command(ADDRESS)).toEqual(["/usr/bin/open", "-a", "/Applications/ego lite.app", ADDRESS]);
  });
});

describe("agent-browser", () => {
  it("is found on the PATH or where npm, Bun and Homebrew put it; on Windows only as an .exe", () => {
    const at = (paths: string[]) => (path: string) => paths.includes(path);
    const PATH = ["/usr/bin", "/opt/bin"].join(delimiter);
    expect(findProgram("agent-browser", { PATH }, "/home/u", "linux", at([join("/opt/bin", "agent-browser"), join("/home/u", ".bun", "bin", "agent-browser")]))).toBe(join("/opt/bin", "agent-browser"));
    expect(findProgram("agent-browser", { PATH: "/usr/bin" }, "/home/u", "linux", at([join("/home/u", ".bun", "bin", "agent-browser")]))).toBe(join("/home/u", ".bun", "bin", "agent-browser"));
    expect(findProgram("agent-browser", { PATH }, "/home/u", "win32", at([join("/opt/bin", "agent-browser"), join("/opt/bin", "agent-browser.cmd")]))).toBeNull();
    expect(findProgram("agent-browser", { PATH: "" }, "/home/u", "darwin", at([]))).toBeNull();
  });

  it("opens the address headed in a session of its own, never an agent's", () => {
    expect(agentBrowser("/bin/agent-browser").command(ADDRESS)).toEqual(["/bin/agent-browser", "--session", "ovis-links", "--headed", "open", ADDRESS]);
  });
});

describe("the chosen browser", () => {
  it("is saved and read back, and anything else reads as the system default", () => {
    const dir = mkdtempSync(join(tmpdir(), "link-browser-"));
    try {
      const path = join(dir, "nested", "link-browser.json");
      expect(readLinkBrowser(path)).toBeNull();
      writeLinkBrowser(path, "desktop:firefox.desktop");
      expect(readLinkBrowser(path)).toBe("desktop:firefox.desktop");
      writeLinkBrowser(path, null);
      expect(readLinkBrowser(path)).toBeNull();
      writeLinkBrowser(path, 7 as unknown as string);
      expect(readLinkBrowser(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
