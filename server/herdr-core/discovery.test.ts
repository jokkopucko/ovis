import { afterEach, expect, it } from "bun:test";
import { chmodSync, existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAbsolute, relative } from "node:path";
import { aclReader, coreSocket, discoverHc, findHc, harmlessGroups, macAclGrantsWrite, ownedByUser, plainSession, privateGroup, trustRefusal } from "./discovery.ts";

const unix = process.platform !== "win32";
let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function scratch(): { root: string; log: string } {
  // under root's sticky /tmp: a candidate is run only when every folder above it is safe, which a
  // shared, group-writable TMPDIR need not be
  const root = mkdtempSync(join(unix ? "/tmp" : tmpdir(), "ovis-hc-discovery-"));
  cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, log: join(root, "argv.log") };
}

/** a stand-in executable that logs every argument list it is run with, then says `output` */
function fake(dir: string, name: string, output: string, log: string, exit = 0): string {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf '%s\\n' '${output}'\nexit ${exit}\n`, { mode: 0o755 });
  return path;
}

/** a stand-in whose whole script is `body`, logging its argument lists */
function script(dir: string, name: string, body: string, log: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${body}\n`, { mode: 0o755 });
  return path;
}

function runs(log: string): string[] {
  try { return readFileSync(log, "utf8").split("\n").filter((line) => line !== ""); } catch { return []; }
}

it.skipIf(!unix)("looks in OVIS_HC_BIN, the usual places, the PATH, then the login shell's PATH", async () => {
  const { root, log } = scratch();
  const named = fake(join(root, "named"), "my-hc", "hc 0.1.20", log);
  const onPath = fake(join(root, "path"), "hc", "hc 0.1.19", log);
  const onLogin = fake(join(root, "login"), "hc", "hc 0.1.18", log);
  const usual = fake(join(root, "usual"), "hc", "hc 0.1.17", log);
  const options = (env: Record<string, string>, login: string | null) => ({
    env, home: root, loginShellPath: async () => login, usualDirs: [join(root, "usual")],
  });
  expect(await findHc(options({ OVIS_HC_BIN: named, PATH: join(root, "path") }, join(root, "login")))).toEqual({ bin: named, version: "0.1.20" });
  // the usual place wins over the PATH: what an earlier PATH folder holds is not asked first
  expect(await findHc(options({ PATH: join(root, "path") }, join(root, "login")))).toEqual({ bin: usual, version: "0.1.17" });
  rmSync(usual);
  expect(await findHc(options({ PATH: join(root, "path") }, join(root, "login")))).toEqual({ bin: onPath, version: "0.1.19" });
  expect(await findHc(options({ PATH: join(root, "empty") }, join(root, "login")))).toEqual({ bin: onLogin, version: "0.1.18" });
  expect(await findHc(options({ PATH: join(root, "empty") }, null))).toBeNull();
});

/** a stand-in that leaves `marker` behind when it is run at all */
function planted(dir: string, mode: number, marker: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  writeFileSync(join(dir, "hc"), `#!/bin/sh\n: > '${marker}'\nprintf 'hc 0.1.99\\n'\n`, { mode: 0o755 });
  chmodSync(dir, mode);
}

it.skipIf(!unix)("never runs an hc from a folder another account can write, earlier on the PATH", async () => {
  const { root, log } = scratch();
  const marker = join(root, "ran");
  planted(join(root, "open"), 0o777, marker);
  planted(join(root, "others"), 0o757, marker);
  // sticky lets anybody add a name beside it: the folder holding hc is the user's alone
  planted(join(root, "stickybin"), 0o1777, marker);
  // a folder of the user's own inside one anybody can rename or replace
  planted(join(root, "shared", "bin"), 0o755, marker);
  chmodSync(join(root, "shared"), 0o777);
  // a link from a folder of the user's own to a stand-in in an open one
  planted(join(root, "open2"), 0o777, marker);
  mkdirSync(join(root, "linked"), { mode: 0o755 });
  symlinkSync(join(root, "open2", "hc"), join(root, "linked", "hc"));
  // a file anybody can rewrite, in a folder of the user's own
  planted(join(root, "loose"), 0o755, marker);
  chmodSync(join(root, "loose", "hc"), 0o777);
  const real = fake(join(root, "real"), "hc", "hc 0.1.17", log);
  chmodSync(join(root, "real"), 0o755);
  const PATH = ["open", "others", "stickybin", "shared/bin", "linked", "loose", "real"].map((dir) => join(root, dir)).join(":");
  try {
    expect(await findHc({ env: { PATH }, home: root, loginShellPath: async () => PATH, usualDirs: [join(root, "open")] })).toEqual({ bin: real, version: "0.1.17" });
    expect(existsSync(marker)).toBe(false);
  } finally {
    for (const dir of ["open", "others", "stickybin", "shared", "open2"]) chmodSync(join(root, dir), 0o755);
  }
});

it.skipIf(!unix)("runs one in the user's own folder, through a sticky shared one and a link, and an explicit OVIS_HC_BIN anywhere", async () => {
  const { root, log } = scratch();
  // like /tmp: anybody may add to it, nobody may replace what is the user's
  mkdirSync(join(root, "sticky"), { mode: 0o755 });
  chmodSync(join(root, "sticky"), 0o1777);
  const mine = fake(join(root, "sticky", "mine"), "hc", "hc 0.1.17", log);
  chmodSync(join(root, "sticky", "mine"), 0o755);
  const look = (env: Record<string, string>) => findHc({ env, home: root, loginShellPath: async () => null, usualDirs: [] });
  expect(await look({ PATH: join(root, "sticky", "mine") })).toEqual({ bin: mine, version: "0.1.17" });
  mkdirSync(join(root, "links"), { mode: 0o755 });
  symlinkSync(mine, join(root, "links", "herdr-core"));
  expect(await look({ PATH: join(root, "links") })).toEqual({ bin: join(root, "links", "herdr-core"), version: "0.1.17" });
  // the user named it: theirs to trust
  const named = fake(join(root, "open"), "my-hc", "hc 0.1.20", log);
  chmodSync(join(root, "open"), 0o777);
  try {
    expect(await look({ OVIS_HC_BIN: named, PATH: join(root, "links") })).toEqual({ bin: named, version: "0.1.20" });
    // a bare name is looked up on the PATH, where the same rule holds, and one refused leaves the next folder
    expect(await look({ OVIS_HC_BIN: "my-hc", PATH: join(root, "open") })).toBeNull();
    const later = fake(join(root, "later"), "my-hc", "hc 0.1.21", log);
    expect(await look({ OVIS_HC_BIN: "my-hc", PATH: [join(root, "open"), join(root, "later")].join(":") })).toEqual({ bin: later, version: "0.1.21" });
  } finally { chmodSync(join(root, "open"), 0o755); }
});

it("counts group write as harmless only in the user's own private group, known from local files alone", () => {
  const passwd = "root:x:0:0::/root:/bin/sh\nme:x:1000:1000::/home/me:/bin/sh\nyou:x:1001:100::/home/you:/bin/sh\n";
  const local = "passwd: files systemd\ngroup: files [SUCCESS=merge] systemd\n";
  expect(privateGroup("me", 1000, "root:x:0:\nme:x:1000:\nusers:x:100:me,you\n", passwd, local)).toBe(1000);
  expect(privateGroup("me", 1000, "me:x:1000:me\n", passwd, local)).toBe(1000);
  // another member, another name, another account's primary group, or a group not listed
  expect(privateGroup("me", 1000, "me:x:1000:you\n", passwd, local)).toBeNull();
  expect(privateGroup("me", 1000, "staff:x:1000:\n", passwd, local)).toBeNull();
  expect(privateGroup("me", 1000, "me:x:1000:\n", passwd + "other:x:1002:1000::/:/bin/sh\n", local)).toBeNull();
  expect(privateGroup("me", 100, "users:x:100:\n", passwd, local)).toBeNull();
  expect(privateGroup("me", 1000, "", passwd, local)).toBeNull();
  // a directory service may add a member /etc never shows, and an unread passwd shows no one
  expect(privateGroup("me", 1000, "me:x:1000:\n", passwd, "passwd: files systemd sss\ngroup: files systemd sss\n")).toBeNull();
  expect(privateGroup("me", 1000, "me:x:1000:\n", passwd, "group: files ldap\n")).toBeNull();
  expect(privateGroup("me", 1000, "me:x:1000:\n", "", local)).toBeNull();
  // no group line (glibc's default may reach further), none at all, or compat's NIS entries: unproven
  expect(privateGroup("me", 1000, "me:x:1000:\n", passwd, "passwd: files\n")).toBeNull();
  expect(privateGroup("me", 1000, "me:x:1000:\n", passwd, "")).toBeNull();
  expect(privateGroup("me", 1000, "me:x:1000:\n", passwd, "passwd: compat\ngroup: compat\n")).toBeNull();
  expect(privateGroup("me", 1000, "me:x:1000:\n", passwd, "passwd: files\ngroup: files\ninitgroups: files ldap\n")).toBeNull();
});

it("trusts no root or admin group write but Homebrew's", () => {
  const linux = harmlessGroups("linux", () => 1000);
  expect([linux(1000, "/home/me/.local/bin"), linux(0, "/usr/local/bin"), linux(80, "/opt/homebrew/bin")]).toEqual([true, false, false]);
  const mac = harmlessGroups("darwin", () => null);
  expect([mac(80, "/opt/homebrew/bin"), mac(80, "/opt/homebrew"), mac(80, "/usr/local/bin"), mac(80, "/Users/me/bin"), mac(80, "/opt/homebrewx/bin"), mac(0, "/opt/homebrew/bin")])
    .toEqual([true, true, true, false, false, false]);
});

it("reads a macOS ACL that lets anybody but the user write", () => {
  const head = "drwxr-x---+ 75 me staff 2400 Nov  8 13:57 /Users/me\n";
  expect(macAclGrantsWrite(head + " 0: group:everyone deny delete\n", "me")).toBe(false);
  expect(macAclGrantsWrite(head + " 0: user:me allow add_file,delete_child\n", "me")).toBe(false);
  expect(macAclGrantsWrite(head + " 0: group:everyone deny delete\n 1: user:you allow list,add_file\n", "me")).toBe(true);
  expect(macAclGrantsWrite(head + " 0: group:staff inherited allow write,append\n", "me")).toBe(true);
  expect(macAclGrantsWrite(head + " 0: group:staff allow list,search,readattr\n", "me")).toBe(false);
  // a principal with spaces, and an entry not read at all, that grants a write right
  expect(macAclGrantsWrite(head + " 0: group:Domain Users allow add_file,delete_child\n", "me")).toBe(true);
  expect(macAclGrantsWrite(head + " 0: group:Domain Users deny add_file\n", "me")).toBe(false);
  expect(macAclGrantsWrite(head + " 0: something new: write\n", "me")).toBe(true);
  expect(macAclGrantsWrite(head + " 0: user:me inherited allow write,append\n", "me")).toBe(false);
});

const setfacl = Bun.which("setfacl");
it.skipIf(process.platform !== "linux" || setfacl === null)("refuses a group-writable folder whose ACL lets another account write, even in a harmless group", () => {
  const { root, log } = scratch();
  const bin = fake(join(root, "bin"), "hc", "hc 0.1.17", log);
  chmodSync(join(root, "bin"), 0o775);
  const anyGroup = () => true;
  expect(ownedByUser(bin, anyGroup)).toBe(true);
  // a named entry that only reads leaves it the user's
  expect(Bun.spawnSync([setfacl!, "-m", "u:nobody:r-x", join(root, "bin")]).exitCode).toBe(0);
  expect(ownedByUser(bin, anyGroup)).toBe(true);
  expect(Bun.spawnSync([setfacl!, "-m", "u:nobody:rwx", join(root, "bin")]).exitCode).toBe(0);
  expect(ownedByUser(bin, anyGroup)).toBe(false);
  // a named group the check does not trust
  expect(Bun.spawnSync([setfacl!, "-x", "u:nobody", "-m", "g:nogroup:rwx", join(root, "bin")]).exitCode).toBe(0);
  expect(ownedByUser(bin, (gid) => gid === process.getgid!())).toBe(false);
});

it.skipIf(process.platform !== "linux" || setfacl === null)("without getfacl, trusts a group-writable private folder that has no ACL, and refuses one that has", async () => {
  const { root, log } = scratch();
  // umask 002 on Debian and Ubuntu: the installer's ~/.local/bin is 775
  const bin = fake(join(root, "bin"), "hc", "hc 0.1.17", log);
  chmodSync(join(root, "bin"), 0o775);
  const ownGroup = (gid: number) => gid === process.getgid!();
  const noGetfacl = () => aclReader({ platform: "linux", getfacl: null });
  expect(ownedByUser(bin, ownGroup, false, noGetfacl())).toBe(true);
  // an ACL there, even one that only reads, cannot be read without getfacl
  expect(Bun.spawnSync([setfacl!, "-m", "u:nobody:r-x", join(root, "bin")]).exitCode).toBe(0);
  expect(ownedByUser(bin, ownGroup, false, noGetfacl())).toBe(false);
  // gone again: trusted again
  expect(Bun.spawnSync([setfacl!, "-b", join(root, "bin")]).exitCode).toBe(0);
  expect(ownedByUser(bin, ownGroup, false, noGetfacl())).toBe(true);
});

it.skipIf(process.platform !== "linux")("checks with the platform it is given: none on Windows", async () => {
  const { root } = scratch();
  const marker = join(root, "ran");
  planted(join(root, "open"), 0o755, marker);
  writeFileSync(join(root, "open", "hc.exe"), readFileSync(join(root, "open", "hc")), { mode: 0o755 });
  chmodSync(join(root, "open"), 0o777);
  try {
    // a Windows look reads no modes, so this PC's 0777 folder is not refused for it
    expect((await findHc({ env: { PATH: join(root, "open") }, home: root, platform: "win32", loginShellPath: async () => null, usualDirs: [] }))?.version).toBe("0.1.99");
  } finally { chmodSync(join(root, "open"), 0o755); }
});

it.skipIf(!unix)("says which entry a refused candidate fails on, and which rule", () => {
  const { root, log } = scratch();
  const bin = fake(join(root, "bin"), "hc", "hc 0.1.17", log);
  chmodSync(join(root, "bin"), 0o775);
  const gid = statSync(join(root, "bin")).gid;
  // a private group this PC cannot prove, as on Fedora with sss
  expect(trustRefusal(bin, () => false)).toBe(`${join(root, "bin")} is group-writable by gid ${gid}, not trusted as your own private group (it has other members, or /etc/nsswitch.conf reads accounts from more than files and systemd, as sss does)`);
  chmodSync(join(root, "bin"), 0o755);
  chmodSync(bin, 0o757);
  expect(trustRefusal(bin, () => false)).toBe(`${bin} is writable by everyone`);
  chmodSync(bin, 0o755);
  expect(trustRefusal(bin, () => false)).toBeNull();
});

it.skipIf(!unix)("tells the caller each candidate it refuses", async () => {
  const { root, log } = scratch();
  const marker = join(root, "ran");
  planted(join(root, "open"), 0o777, marker);
  const real = fake(join(root, "real"), "hc", "hc 0.1.17", log);
  const refused: string[] = [];
  try {
    expect(await findHc({ env: { PATH: [join(root, "open"), join(root, "real")].join(":") }, home: root, loginShellPath: async () => null, usualDirs: [], onRefused: (bin, reason) => refused.push(`${bin}: ${reason}`) })).toEqual({ bin: real, version: "0.1.17" });
  } finally { chmodSync(join(root, "open"), 0o755); }
  expect(refused).toEqual([`${join(root, "open", "hc")}: ${join(root, "open")} is writable by everyone`]);
});

it.skipIf(!unix)("gives the probe only absolute, checked PATH folders, never an empty PATH that would search the server's folder", async () => {
  const { root } = scratch();
  const seenPath = join(root, "path.seen");
  mkdirSync(join(root, "real"), { mode: 0o755 });
  writeFileSync(join(root, "real", "hc"), `#!/bin/sh\nprintf '%s' "$PATH" > '${seenPath}'\nprintf 'hc 0.1.17\\n'\n`, { mode: 0o755 });
  const look = (PATH: string, usualDirs: string[]) => findHc({ env: { PATH }, home: root, loginShellPath: async () => null, usualDirs });
  // a relative PATH folder is handed on resolved, so a wrapper that changes folder finds the same one
  expect((await look(relative(process.cwd(), join(root, "real")), []))?.version).toBe("0.1.17");
  expect(readFileSync(seenPath, "utf8")).toBe(join(root, "real"));
  // every PATH folder refused: still a PATH, of absolute folders only
  mkdirSync(join(root, "open"), { mode: 0o755 });
  chmodSync(join(root, "open"), 0o777);
  try {
    expect((await look(join(root, "open"), [join(root, "real")]))?.version).toBe("0.1.17");
  } finally { chmodSync(join(root, "open"), 0o755); }
  const given = readFileSync(seenPath, "utf8").split(":");
  expect(given.length).toBeGreaterThan(0);
  expect(given.every((dir) => isAbsolute(dir) && dir !== join(root, "open"))).toBe(true);
});

it.skipIf(!unix)("runs a candidate with only the PATH folders that pass the same check", async () => {
  const { root, log } = scratch();
  const marker = join(root, "ran");
  // a user-owned wrapper that runs a helper by name
  const real = script(join(root, "real"), "hc", "helper\nprintf 'hc 0.1.17\\n'", log);
  mkdirSync(join(root, "open"), { mode: 0o755 });
  writeFileSync(join(root, "open", "helper"), `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o755 });
  chmodSync(join(root, "open"), 0o777);
  try {
    expect(await findHc({ env: { PATH: [join(root, "open"), join(root, "real")].join(":") }, home: root, loginShellPath: async () => null, usualDirs: [] })).toEqual({ bin: real, version: "0.1.17" });
    expect(existsSync(marker)).toBe(false);
  } finally { chmodSync(join(root, "open"), 0o755); }
});

it.skipIf(!unix)("takes herdr-core before hc in the same folder, as the app does", async () => {
  const { root, log } = scratch();
  fake(join(root, "bin"), "hc", "hc 0.1.17", log);
  const core = fake(join(root, "bin"), "herdr-core", "hc 0.1.17", log);
  expect(await findHc({ env: { PATH: join(root, "bin") }, home: root, loginShellPath: async () => null, usualDirs: [] })).toEqual({ bin: core, version: "0.1.17" });
});

it.skipIf(!unix)("passes over an hc that is not herdr-core's, and one that fails, for the next candidate", async () => {
  const { root, log } = scratch();
  fake(join(root, "wm"), "hc", "herbstclient 0.9.5", log);
  fake(join(root, "broken"), "hc", "hc 0.1.17", log, 1);
  const named = fake(join(root, "named"), "hc", "hcx 2", log);
  const real = fake(join(root, "login"), "hc", "hc 0.1.17", log);
  const found = await findHc({
    env: { OVIS_HC_BIN: named, PATH: [join(root, "wm"), join(root, "broken")].join(":") },
    home: root, loginShellPath: async () => join(root, "login"), usualDirs: [],
  });
  expect(found).toEqual({ bin: real, version: "0.1.17" });
  // nothing that answers otherwise is ever taken
  expect(await findHc({ env: { PATH: join(root, "wm") }, home: root, loginShellPath: async () => null, usualDirs: [] })).toBeNull();
});

it.skipIf(!unix)("never runs any hc command but --version: any other one can start a core", async () => {
  const { root, log } = scratch();
  fake(join(root, "wm"), "hc", "herbstclient 0.9.5", log);
  fake(join(root, "path"), "herdr-core", "hc 0.1.17", log);
  fake(join(root, "path"), "hc", "hc 0.1.17", log);
  await findHc({ env: { PATH: [join(root, "wm"), join(root, "path")].join(":") }, home: root, loginShellPath: async () => null, usualDirs: [] });
  await findHc({ env: { PATH: join(root, "wm") }, home: root, loginShellPath: async () => join(root, "path"), usualDirs: [join(root, "path")] });
  expect(runs(log).length).toBeGreaterThan(0);
  expect(new Set(runs(log))).toEqual(new Set(["--version"]));
});

it("finds the core's socket the way hc does, and calls it running only when the file is there", () => {
  const { root } = scratch();
  const home = join(root, "home");
  const run = join(root, "run");
  const base = { home, platform: "linux" as NodeJS.Platform, userRuntimeDir: null };
  // the session: HC_SESSION without spaces around it, else default
  expect(coreSocket({ ...base, env: { XDG_RUNTIME_DIR: run, HC_SESSION: " work " } })).toEqual({ session: "work", path: join(run, "herdr-core", "work.sock"), running: false });
  // no runtime dir from the environment: /run/user/<uid> when it exists, else beside the state
  expect(coreSocket({ ...base, env: {}, userRuntimeDir: run }).path).toBe(join(run, "herdr-core", "default.sock"));
  expect(coreSocket({ ...base, env: {} }).path).toBe(join(home, ".local", "state", "herdr-core", "default", "default.sock"));
  expect(coreSocket({ ...base, env: { XDG_STATE_HOME: join(root, "state"), HC_SESSION: "" } }).path).toBe(join(root, "state", "herdr-core", "default", "default.sock"));
  // `socket` in hc's config, then HC_SOCKET, win over the runtime dir
  const config = join(root, "config");
  mkdirSync(join(config, "herdr-core"), { recursive: true });
  writeFileSync(join(config, "herdr-core", "config.toml"), `# hc\nsocket = "${join(root, "configured.sock")}"\n`);
  expect(coreSocket({ ...base, env: { XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: run } }).path).toBe(join(root, "configured.sock"));
  const chosen = join(root, "chosen.sock");
  writeFileSync(chosen, "");
  expect(coreSocket({ ...base, env: { HC_SOCKET: chosen, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: run } })).toEqual({ session: "default", path: chosen, running: true });
});

it.skipIf(!unix)("takes only output that starts with hc and a version, never a path or junk after a blank line", async () => {
  const { root, log } = scratch();
  const look = (dir: string) => findHc({ env: { PATH: join(root, dir) }, home: root, loginShellPath: async () => null, usualDirs: [] });
  script(join(root, "blank"), "hc", "printf '\\nhc 0.1.17\\n'", log);
  script(join(root, "path"), "hc", "printf 'hc /home/someone/bin\\n'", log);
  script(join(root, "real"), "hc", "printf 'hc 0.1.17-rc.1\\n'", log);
  expect(await look("blank")).toBeNull();
  expect(await look("path")).toBeNull();
  expect((await look("real"))?.version).toBe("0.1.17-rc.1");
});

it.skipIf(!unix)("looks a bare OVIS_HC_BIN up on the PATH, before anything else there", async () => {
  const { root, log } = scratch();
  fake(join(root, "bin"), "herdr-core", "hc 0.1.16", log);
  const named = fake(join(root, "bin"), "my-hc", "hc 0.1.17", log);
  expect(await findHc({ env: { OVIS_HC_BIN: "my-hc", PATH: join(root, "bin") }, home: root, loginShellPath: async () => null, usualDirs: [] })).toEqual({ bin: named, version: "0.1.17" });
});

it.skipIf(!unix)("does not wait on what a candidate left holding its output, and kills it", async () => {
  const { root, log } = scratch();
  const pidFile = join(root, "left.pid");
  script(join(root, "bin"), "hc", `/bin/sleep 30 & echo $! > '${pidFile}'\nprintf 'hc 0.1.17\\n'`, log);
  const found = await findHc({ env: { PATH: join(root, "bin") }, home: root, loginShellPath: async () => null, usualDirs: [], timeoutMs: 10_000 });
  expect(found?.version).toBe("0.1.17");
  const left = Number(readFileSync(pidFile, "utf8"));
  // the group was killed once the answer was in: signalling the leftover now finds nothing
  let alive = true;
  for (let attempt = 0; attempt < 50 && alive; attempt++) {
    try { process.kill(left, 0); await Bun.sleep(20); } catch { alive = false; }
  }
  expect(alive).toBe(false);
});

it.skipIf(!unix)("passes over a candidate that does not answer in time", async () => {
  const { root, log } = scratch();
  script(join(root, "slow"), "hc", "exec /bin/sleep 30", log);
  const real = fake(join(root, "real"), "hc", "hc 0.1.17", log);
  expect(await findHc({ env: { PATH: [join(root, "slow"), join(root, "real")].join(":") }, home: root, loginShellPath: async () => null, usualDirs: [], timeoutMs: 200 })).toEqual({ bin: real, version: "0.1.17" });
});

it.skipIf(!unix)("waits for a candidate that closed its output to exit, within the time it is given", async () => {
  const { root, log } = scratch();
  const slow = script(join(root, "bin"), "hc", "printf 'hc 0.1.17\\n'\nexec 1>&-\n/bin/sleep 1", log);
  expect(await findHc({ env: { PATH: join(root, "bin") }, home: root, loginShellPath: async () => null, usualDirs: [], timeoutMs: 5_000 })).toEqual({ bin: slow, version: "0.1.17" });
});

it("reads the configured socket as TOML, escapes and all", () => {
  const { root } = scratch();
  const config = join(root, "config");
  mkdirSync(join(config, "herdr-core"), { recursive: true });
  writeFileSync(join(config, "herdr-core", "config.toml"), `socket = "${join(root, "core")}\\u002Dsock"\n[other]\nsocket = "no"\n`);
  expect(coreSocket({ env: { XDG_CONFIG_HOME: config }, home: root, platform: "linux", userRuntimeDir: null }).path).toBe(join(root, "core-sock"));
});

it("tells a session only when it is a plain name, as hc takes one", () => {
  expect(plainSession("default")).toBe("default");
  expect(plainSession("work.2_a-b")).toBe("work.2_a-b");
  for (const name of ["/home/someone/private", "a\\b", "..", ".", "a b", ""]) expect(plainSession(name)).toBeNull();
});

it.skipIf(!unix)("looks for the Settings facts without running the login shell: its profile could start a core", async () => {
  const { root, log } = scratch();
  const shell = script(join(root, "shell"), "sh", "printf 'login\\n' >> '" + join(root, "shell.log") + "'", log);
  const core = fake(join(root, "bin"), "herdr-core", "hc 0.1.17", log);
  expect(await discoverHc({ env: { SHELL: shell, PATH: join(root, "empty") }, home: root, usualDirs: [join(root, "bin")] })).toEqual({ bin: core, version: "0.1.17" });
  expect(runs(join(root, "shell.log"))).toEqual([]);
});

it.skipIf(!unix)("answers the hc it found as an absolute path, whatever folder the server runs in", async () => {
  const { root, log } = scratch();
  fake(join(root, "bin"), "hc", "hc 0.1.17", log);
  const found = await findHc({ env: { PATH: relative(process.cwd(), join(root, "bin")) }, home: root, loginShellPath: async () => null, usualDirs: [] });
  expect(found?.bin).toBe(join(root, "bin", "hc"));
  expect(isAbsolute(found!.bin)).toBe(true);
});

it("takes no socket from a config.toml too big to be a config, so a health poll never reads it whole", () => {
  const { root } = scratch();
  const config = join(root, "config");
  mkdirSync(join(config, "herdr-core"), { recursive: true });
  writeFileSync(join(config, "herdr-core", "config.toml"), `socket = "${join(root, "configured.sock")}"\n# ${"x".repeat(2 * 1024 * 1024)}\n`);
  expect(coreSocket({ env: { XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: join(root, "run") }, home: root, platform: "linux", userRuntimeDir: null }).path).toBe(join(root, "run", "herdr-core", "default.sock"));
});
