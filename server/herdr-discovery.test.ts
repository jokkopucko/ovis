import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chosenHerdrSocketStatus, discoverHerdrSessions, parseFoundHerdrSessions, profileGroups, throwawayPath } from "./herdr-discovery.ts";
import { harmlessGroups } from "./herdr-core/discovery.ts";

const roots: string[] = [];
const listeners: ReturnType<typeof Bun.listen>[] = [];
afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// macOS reaches its temp folder through a link and caps a socket path at 104 bytes: a short root, by its real path
function tempRoot(prefix: string) {
  const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), prefix)));
  roots.push(root);
  return root;
}
function fixture() {
  const home = tempRoot("herdr-discovery-");
  const procRoot = join(home, "proc");
  mkdirSync(procRoot);
  return { home, procRoot, platform: "linux" as const, uid: process.getuid?.() ?? 0 };
}
function listening(socket: string) {
  mkdirSync(dirname(socket), { recursive: true });
  listeners.push(Bun.listen({ unix: socket, socket: { data() {} } }));
}

describe("running herdr discovery", () => {
  it.each([
    ["/home/u/.local/bin/herdr", [], undefined],
    ["/usr/local/bin/herdr", ["--session", "qa-873df7"], "qa-873df7"],
    ["/usr/local/bin/herdr-real", ["--session", "work"], "work"],
  ] as const)("finds server executable %s", async (binary, flags, session) => {
    const f = fixture();
    const xdg = join(f.home, "desktop");
    const socket = join(xdg, "herdr", ...(session ? ["sessions", session] : []), "herdr.sock");
    listening(socket);
    mkdirSync(join(f.procRoot, "100"));
    writeFileSync(join(f.procRoot, "100/cmdline"), [binary, ...flags, "server", ""].join("\0"));
    writeFileSync(join(f.procRoot, "100/environ"), `HOME=${f.home}\0XDG_CONFIG_HOME=${xdg}\0`);
    expect(await discoverHerdrSessions(f)).toEqual([{ socket_path: socket, ...(session ? { session } : {}), label: session ?? "Default session" }]);
    writeFileSync(join(f.procRoot, "100/cmdline"), [binary, ...flags, "terminal", "attach", "server", ""].join("\0"));
    expect(await discoverHerdrSessions(f)).toEqual([]);
  });

  it("confines proc unix candidates even when HOME is the account home", async () => {
    const f = fixture();
    const outside = tempRoot("herdr discovery xdg-");
    const socket = join(outside, "herdr/sessions/work/herdr.sock");
    listening(socket);
    mkdirSync(join(f.procRoot, "net"));
    writeFileSync(join(f.procRoot, "net/unix"), `Num       RefCount Protocol Flags    Type St Inode Path
0000000000000000: 00000002 00000000 00010000 0001 01 4242 ${socket}
0000000000000000: 00000002 00000000 00000000 0001 03 4243 ${join(outside, "other/herdr.sock")}
`);
    expect(await discoverHerdrSessions(f)).toEqual([]);
    // An explicit XDG root authorizes only its herdr directory, including paths containing spaces.
    expect(await discoverHerdrSessions({ ...f, xdg: outside })).toEqual([{ socket_path: socket, session: "work", label: "work" }]);
    expect(await discoverHerdrSessions({ ...f, home: join(f.home, "sandbox") })).toEqual([]);
  });

  it("accepts a real listening socket on this platform", async () => {
    const home = tempRoot("hd-");
    const socket = join(home, ".config/herdr/sessions/work/herdr.sock"); listening(socket);
    const host = { home, platform: process.platform, uid: process.getuid?.() };
    expect(await chosenHerdrSocketStatus(socket, host)).toBe("usable");
    expect(await discoverHerdrSessions(host)).toEqual([{ socket_path: socket, session: "work", label: "work" }]);
  });

  it("keeps configured sessions when proc is unavailable", async () => {
    const f = fixture();
    const socket = join(f.home, ".config/herdr/herdr.sock"); listening(socket);
    expect(await discoverHerdrSessions({ ...f, procRoot: join(f.home, "missing") })).toEqual([{ socket_path: socket, label: "Default session" }]);
  });

  it("never offers socket or parent symlinks even inside an allowed root", async () => {
    const f = fixture();
    const actual = join(f.home, ".config/herdr/actual.sock"); listening(actual);
    symlinkSync(actual, join(f.home, ".config/herdr/herdr.sock"));
    const named = join(f.home, ".config/herdr/sessions/real/herdr.sock"); listening(named);
    symlinkSync(dirname(named), join(f.home, ".config/herdr/sessions/alias"));
    const found = await discoverHerdrSessions(f);
    expect(found).toEqual([{ socket_path: named, session: "real", label: "real" }]);
    expect(parseFoundHerdrSessions(found)).toEqual(found);
  });

  it("accepts only a server process with matching HOME as authority for desktop XDG", async () => {
    const f = fixture(), outside = fixture();
    const socket = join(outside.home, "herdr/herdr.sock"); listening(socket);
    mkdirSync(join(f.procRoot, "100"));
    writeFileSync(join(f.procRoot, "100/cmdline"), "/usr/bin/herdr-real\0server\0");
    writeFileSync(join(f.procRoot, "100/environ"), `HOME=${f.home}\0XDG_CONFIG_HOME=${outside.home}\0`);
    expect(await discoverHerdrSessions(f)).toEqual([{ socket_path: socket, label: "Default session" }]);
    writeFileSync(join(f.procRoot, "100/environ"), `HOME=${outside.home}\0XDG_CONFIG_HOME=${outside.home}\0`);
    expect(await discoverHerdrSessions(f)).toEqual([]);
  });

  it("never lists this app's test sessions or a session under a throwaway config root", async () => {
    const f = fixture();
    const work = { socket_path: join(f.home, ".config/herdr/sessions/work/herdr.sock"), session: "work", label: "work" };
    for (const session of ["work", "ovis-test", "ovis-test-gate", "ovis-demo", "check-873df7", "check-873df7-2"]) listening(join(f.home, `.config/herdr/sessions/${session}/herdr.sock`));
    const scratch = tempRoot("hd-tmp-");
    const roots = [["trial", join(f.home, ".cache/ovis-tmp/trial/config"), ""], ["scratch", join(scratch, "config"), scratch]] as const;
    for (const [i, [session, xdg, tmp]] of roots.entries()) {
      listening(join(xdg, "herdr/sessions", session, "herdr.sock"));
      mkdirSync(join(f.procRoot, `${100 + i}`));
      writeFileSync(join(f.procRoot, `${100 + i}/cmdline`), ["/usr/local/bin/herdr", "--session", session, "server", ""].join("\0"));
      writeFileSync(join(f.procRoot, `${100 + i}/environ`), `HOME=${f.home}\0XDG_CONFIG_HOME=${xdg}\0TMPDIR=${tmp}\0`);
    }
    expect(await discoverHerdrSessions(f)).toEqual([work]);
    // nor when the throwaway root is the scanner's own
    expect(await discoverHerdrSessions({ ...f, xdg: roots[0][1], procRoot: join(f.home, "missing") })).toEqual([work]);
    // nor a root in another process's own TMPDIR that the scanner reaches as its own
    expect(await discoverHerdrSessions({ ...f, xdg: roots[1][1] })).toEqual([work]);
    // nor a test session behind a linked herdr folder
    const linked = fixture();
    listening(join(linked.home, "dotfiles/herdr-config/sessions/ovis-test/herdr.sock"));
    mkdirSync(join(linked.home, ".config"));
    symlinkSync(join(linked.home, "dotfiles/herdr-config"), join(linked.home, ".config/herdr"));
    expect(await discoverHerdrSessions(linked)).toEqual([]);
    // a config root named sessions holds the default socket, not a session called herdr
    const named = fixture();
    const xdg = join(named.home, "sessions");
    listening(join(xdg, "herdr/herdr.sock"));
    expect(await discoverHerdrSessions({ ...named, xdg })).toEqual([{ socket_path: join(xdg, "herdr/herdr.sock"), label: "Default session" }]);
    // another program's TMPDIR hides nothing; a herdr server's does, whatever order they are listed in
    const order = fixture();
    const other = tempRoot("hd-other-");
    listening(join(order.home, ".config/herdr/sessions/work/herdr.sock"));
    listening(join(other, "config/herdr/sessions/scratch/herdr.sock"));
    listening(join(order.home, "tmp/x/herdr/sessions/trial/herdr.sock"));
    for (const [pid, args, environ] of [["100", ["/usr/bin/make"], `HOME=${order.home}\0TMPDIR=${order.home}/.config\0`], ["98", ["/usr/local/bin/herdr", "--session", "work", "server"], `HOME=${order.home}\0TMPDIR=${order.home}/.config\0`], ["97", ["/usr/local/bin/herdr", "--session", "trial", "server"], `HOME=${order.home}\0TMPDIR=${order.home}/tmp\0XDG_CONFIG_HOME=${order.home}/tmp/x\0`], ["101", ["/usr/local/bin/herdr", "--session", "work", "server"], `HOME=${order.home}\0`], ["99", ["/usr/local/bin/herdr", "--session", "scratch", "server"], `HOME=${order.home}\0XDG_CONFIG_HOME=${join(other, "config")}\0`], ["102", ["/usr/local/bin/herdr", "server"], `HOME=${order.home}\0TMPDIR=${other}\0`]] as const) {
      mkdirSync(join(order.procRoot, pid));
      writeFileSync(join(order.procRoot, pid, "cmdline"), [...args, ""].join("\0"));
      writeFileSync(join(order.procRoot, pid, "environ"), environ);
    }
    expect(await discoverHerdrSessions(order)).toEqual([{ socket_path: join(order.home, ".config/herdr/sessions/work/herdr.sock"), session: "work", label: "work" }]);
    const listed = ["ovis-test", "ovis-test-gate", "check-873df7"].map((session) => ({ socket_path: `/h/.config/herdr/sessions/${session}/herdr.sock`, session, label: session }));
    const cached = { socket_path: "/h/.cache/ovis-tmp/trial/config/herdr/sessions/work/herdr.sock", session: "work", label: "work" };
    const temp = { socket_path: "/tmp/x/config/herdr/herdr.sock", label: "Default session" };
    const kept = { ...work, socket_path: "/h/.config/herdr/sessions/work/herdr.sock" };
    const unnamed = { socket_path: "/h/.config/herdr/sessions/ovis-test/herdr.sock", label: "Default session" };
    expect(parseFoundHerdrSessions([kept, ...listed, cached, temp, unnamed], "/h")).toEqual([kept]);
    // a temp folder named with . or .. is the folder it names; its sibling is not inside it
    expect(throwawayPath("/srv/scratch/trial/herdr/herdr.sock", "/h", "/srv/scratch/.")).toBe(true);
    expect(throwawayPath("/srv/scratch/trial/herdr/herdr.sock", "/h", "/srv/x/../scratch")).toBe(true);
    expect(throwawayPath("/srv/scratch-other/herdr/herdr.sock", "/h", "/srv/scratch/.")).toBe(false);
  });

  it("preserves whitespace in macOS process HOME and XDG values", async () => {
    const f = fixture();
    const home = join(f.home, "My Home"), xdg = join(f.home, "My Config");
    mkdirSync(home);
    const socket = join(xdg, "herdr/sessions/work/herdr.sock"); listening(socket);
    const processList = Bun.spawn([process.execPath, "-e", `console.log(${JSON.stringify(`/usr/local/bin/herdr-real --session work server HOME=${home} XDG_CONFIG_HOME=${xdg} USER=fixture`)})`], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const ps = spyOn(Bun, "spawn").mockReturnValue(processList);
    try { expect(await discoverHerdrSessions({ ...f, home, platform: "darwin" })).toEqual([{ socket_path: socket, session: "work", label: "work" }]); }
    finally { ps.mockRestore(); }
  });

  it("caps discovery at 256 candidates and probes them together", async () => {
    const f = fixture();
    for (let i = 0; i < 260; i++) listening(join(f.home, `.config/herdr/sessions/s${i}/herdr.sock`));
    const release = Promise.withResolvers<boolean>();
    let calls = 0;
    const discovery = discoverHerdrSessions({ ...f, probe: () => { calls++; if (calls === 256) release.resolve(true); return release.promise; } });
    const deadline = setTimeout(() => release.reject(new Error(`only ${calls} probes started; expected 256 in parallel`)), 1500);
    try { expect(await discovery).toHaveLength(256); expect(calls).toBe(256); }
    finally { clearTimeout(deadline); release.resolve(false); }
  });

  it("times out an unsettled probe without losing another live session", async () => {
    const f = fixture();
    const stalled = join(f.home, ".config/herdr/herdr.sock"), live = join(f.home, ".config/herdr/sessions/work/herdr.sock");
    listening(stalled); listening(live);
    const discovery = discoverHerdrSessions({ ...f, probe: (socket) => socket === stalled ? new Promise(() => {}) : Promise.resolve(true) });
    let deadline: ReturnType<typeof setTimeout>;
    try { expect(await Promise.race([discovery, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("discovery never bounded the probe")), 2500); })])).toEqual([{ socket_path: live, session: "work", label: "work" }]); }
    finally { clearTimeout(deadline!); }
  });

  it("rejects sockets owned by another uid even in the inherited XDG root", async () => {
    const f = fixture();
    const xdg = join(f.home, "inherited-xdg");
    listening(join(xdg, "herdr/herdr.sock"));
    expect(await discoverHerdrSessions({ ...f, xdg, uid: f.uid + 1 })).toEqual([]);
  });

  it("rejects a symlink escaping HOME and the configured XDG root", async () => {
    const f = fixture(), outside = fixture();
    const socket = join(outside.home, "herdr/herdr.sock");
    listening(socket);
    const link = join(f.home, ".config/herdr/herdr.sock");
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(socket, link);
    expect(await discoverHerdrSessions(f)).toEqual([]);
  });

  it("does not offer a permission-denied socket", async () => {
    const f = fixture();
    const socket = join(f.home, ".config/herdr/herdr.sock");
    listening(socket); chmodSync(socket, 0);
    try { expect(await discoverHerdrSessions(f)).toEqual([]); }
    finally { chmodSync(socket, 0o600); }
  });

  it("finds a desktop-only XDG root from this user's server process", async () => {
    const f = fixture();
    const xdg = join(f.home, "desktop");
    const socket = join(xdg, "herdr/sessions/work/herdr.sock");
    listening(socket);
    mkdirSync(join(f.procRoot, "100"));
    writeFileSync(join(f.procRoot, "100/cmdline"), "/usr/bin/herdr\0--session\0work\0server\0");
    writeFileSync(join(f.procRoot, "100/environ"), `HOME=${f.home}\0XDG_CONFIG_HOME=${xdg}\0`);
    expect(await discoverHerdrSessions(f)).toEqual([{ socket_path: socket, session: "work", label: "work" }]);
  });

  it("deduplicates live default and named sockets and ignores stale files", async () => {
    const f = fixture();
    const xdg = join(f.home, ".config");
    const socket = join(xdg, "herdr/herdr.sock");
    const named = join(xdg, "herdr/sessions/qa/herdr.sock");
    listening(socket); listening(named);
    mkdirSync(join(xdg, "herdr/sessions/stale"), { recursive: true });
    writeFileSync(join(xdg, "herdr/sessions/stale/herdr.sock"), "stale");
    expect(await discoverHerdrSessions({ ...f, xdg })).toEqual([
      { socket_path: socket, label: "Default session" },
      { socket_path: named, session: "qa", label: "qa" },
    ]);
  });

  it("ignores client processes and processes belonging to another uid", async () => {
    const f = fixture();
    const xdg = join(f.home, "desktop");
    listening(join(xdg, "herdr/herdr.sock"));
    mkdirSync(join(f.procRoot, "100"));
    writeFileSync(join(f.procRoot, "100/cmdline"), "/usr/bin/herdr\0status\0server\0");
    writeFileSync(join(f.procRoot, "100/status"), `Name:\therdr\nUid:\t${f.uid}\t${f.uid}\t${f.uid}\t${f.uid}\n`);
    writeFileSync(join(f.procRoot, "100/environ"), `HOME=${f.home}\0XDG_CONFIG_HOME=${xdg}\0`);
    expect(await discoverHerdrSessions(f)).toEqual([]);
    writeFileSync(join(f.procRoot, "100/cmdline"), "/usr/bin/herdr\0server\0");
    expect(await discoverHerdrSessions({ ...f, uid: f.uid + 1 })).toEqual([]);
  });
});

describe("the machine profile's own folders", () => {
  it("trust this account's private group alone, not macOS's admin group under Homebrew's prefixes", () => {
    const own = () => 20;
    // control: the rule of main's other callers trusts admin (80) there on macOS
    expect(harmlessGroups("darwin", own)(80, "/opt/homebrew/var/herdr")).toBe(true);
    const groups = profileGroups(own);
    expect([groups(80, "/opt/homebrew/var/herdr"), groups(80, "/usr/local/state"), groups(20, "/Users/me/.config"), groups(21, "/Users/me/.config")]).toEqual([false, false, true, false]);
  });
});
