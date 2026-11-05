import { afterEach, describe, expect, it } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refusalHint, SshConnection, sshClient, sweepSshDirs } from "./ssh.ts";

// The direct mode Windows uses (its OpenSSH has no connection sharing), run here against a
// stand-in ssh. Windows itself runs it against real hosts; this sh stand-in needs a POSIX shell.
const FAKE_SSH = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DIR/calls"
kh=""; batch=""; learn=""; config=""; tunnel=""; forward=""; prev=""; last=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then
    case "$a" in
      UserKnownHostsFile=*) [ -z "$kh" ] && kh="${"${a#UserKnownHostsFile=}"}" ;;
      BatchMode=*) [ -z "$batch" ] && batch="${"${a#BatchMode=}"}" ;;
      PreferredAuthentications=none) learn=1 ;;
    esac
  fi
  [ "$prev" = "-L" ] && forward="$a"
  [ "$a" = "-G" ] && config=1
  [ "$a" = "-N" ] && tunnel=1
  prev="$a"; last="$a"
done
if [ -n "$config" ]; then
  echo "hostname pc.example"
  [ -n "$FAKE_CONFIG_FORWARD" ] && echo "localforward 8080 127.0.0.1:80"
  exit 0
fi
known=$(printf '%s' "$kh" | sed "s/^'\([^']*\)'.*/\1/")
if [ -n "$learn" ]; then
  printf '%s\n' "$FAKE_HOSTKEY_LINE" >> "$known"
  echo "pc@pc.example: Permission denied (publickey)." >&2; exit 255
fi
if [ -n "$FAKE_HOSTKEY_LINE" ] && ! grep -qF "$FAKE_HOSTKEY_LINE" "$known" 2>/dev/null; then
  echo "No ED25519 host key is known for pc.example and you have requested strict checking." >&2
  echo "Host key verification failed." >&2; exit 255
fi
if [ -n "$FAKE_INTRUDER" ]; then
  HERDR_ASKPASS_TOKEN=forged "$SSH_ASKPASS" "Enter passphrase for key 'k': " > "$FAKE_DIR/intruder" 2>/dev/null
  echo $? > "$FAKE_DIR/intruder.code"
fi
if [ -n "$FAKE_PASSPHRASE" ]; then
  if [ "$batch" = "yes" ]; then echo "pc@pc.example: Permission denied (publickey)." >&2; exit 255; fi
  answer=$("$SSH_ASKPASS" "${"${FAKE_PROMPT:-Enter passphrase for key 'k': }"}") || { echo "pc@pc.example: Permission denied (publickey)." >&2; exit 255; }
  [ "$answer" = "$FAKE_PASSPHRASE" ] || { echo "pc@pc.example: Permission denied (publickey)." >&2; exit 255; }
fi
if [ -n "$tunnel" ]; then
  [ -z "$forward" ] && exec sleep 30
  port=$(printf '%s' "$forward" | cut -d: -f2)
  exec "$FAKE_BUN" -e "let opened = 0; Bun.listen({ hostname: '127.0.0.1', port: $port, socket: { open() { if (++opened === Number(process.env.FAKE_TUNNEL_ENDS_AT)) process.exit(0); }, data() {} } });"
fi
[ "$last" = "exit" ] && exit 0
echo ran
`;

// `ssh-keygen -l -f <known_hosts>` for the ed25519 lines the stand-in ssh learns. CI's runner
// image has no OpenSSH, so the real one cannot be relied on.
const FAKE_SSH_KEYGEN = String.raw`#!/bin/sh
for file; do :; done
exec "$FAKE_BUN" -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
for (const line of readFileSync(process.argv.at(-1), "utf8").trim().split("\n")) {
  const [host, , key] = line.split(" ");
  console.log("256 SHA256:" + createHash("sha256").update(Buffer.from(key, "base64")).digest("base64").replace(/=+$/, "") + " " + host + " (ED25519)");
}' "$file"
`;

const FAKE_KEYS = ["FAKE_DIR", "FAKE_BUN", "FAKE_PASSPHRASE", "FAKE_PROMPT", "FAKE_HOSTKEY_LINE", "FAKE_INTRUDER", "FAKE_CONFIG_FORWARD", "FAKE_TUNNEL_ENDS_AT"];

describe.skipIf(process.platform === "win32")("SSH without connection sharing", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  function fixture(env: Record<string, string> = {}, { onPath = true } = {}) {
    const root = mkdtempSync(join(tmpdir(), "herdr-ssh-direct-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ssh"), FAKE_SSH);
    chmodSync(join(bin, "ssh"), 0o755);
    writeFileSync(join(bin, "ssh-keygen"), FAKE_SSH_KEYGEN);
    chmodSync(join(bin, "ssh-keygen"), 0o755);
    writeFileSync(join(bin, "sftp"), `#!/bin/sh\nprintf 'sftp %s\\n' "$*" >> "$FAKE_DIR/calls"\ncat > /dev/null\n`);
    chmodSync(join(bin, "sftp"), 0o755);
    const saved = Object.fromEntries(["PATH", "OVIS_SSH", ...FAKE_KEYS].map((key) => [key, process.env[key]]));
    if (onPath) process.env["PATH"] = `${bin}:${saved["PATH"]}`;
    else process.env["OVIS_SSH"] = join(bin, "ssh");
    Object.assign(process.env, { FAKE_DIR: root, FAKE_BUN: process.execPath }, env);
    const state = join(root, "state");
    const ssh = new SshConnection({ destination: "pc" }, state, undefined, false, false);
    const prompts: { prompt: string; hostKey: boolean }[] = [];
    cleanups.push(() => {
      ssh.close();
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    });
    const calls = () => readFileSync(join(root, "calls"), "utf8").trim().split("\n");
    const ask = (answer: string) => async (prompt: string, hostKey: boolean) => { prompts.push({ prompt, hostKey }); return answer; };
    return { root, state, ssh, prompts, calls, ask };
  }

  it("lets the agent sign without a prompt and keeps every command non-interactive", async () => {
    const { ssh, prompts, calls, ask } = fixture();
    await ssh.start(ask("unused"));
    expect(await ssh.run("true")).toBe("ran\n");
    expect(prompts).toEqual([]);
    expect(ssh.usedSecret).toBe(false);
    const run = calls().find((line) => line.endsWith("sh -c 'true'"))!;
    expect(run).toContain("BatchMode=yes");
    expect(run).toContain("StrictHostKeyChecking=yes");
    expect(ssh.connected()).toBe(true);
  });

  it("runs the ssh OVIS_SSH names instead of the one on PATH", async () => {
    const { root, ssh, calls, ask } = fixture({}, { onPath: false });
    await ssh.start(ask("unused"));
    expect(await ssh.run("true")).toBe("ran\n");
    expect(calls().some((line) => line.endsWith("sh -c 'true'"))).toBe(true);
    // the sftp beside it, told to start that ssh rather than its own build's
    await ssh.upload(join(root, "calls"), String.raw`C:\Users\pc\bundle`);
    expect(calls().some((line) => line.startsWith(`sftp -S ${join(root, "bin", "ssh")} `))).toBe(true);
  });

  it("adds nothing to a refusal when OVIS_SSH names the ssh, which may be Windows' own", async () => {
    const { ssh } = fixture({ FAKE_PASSPHRASE: "secret" }, { onPath: false });
    await expect(ssh.start()).rejects.toThrow(/^pc@pc\.example: Permission denied \(publickey\)\.$/);
  });

  it("tells a refused connection through Git's ssh that Windows' agent service is not read", async () => {
    const { ssh } = fixture({ FAKE_PASSPHRASE: "secret" }, { onPath: false });
    // what discovery marks on Windows, which this POSIX stand-in cannot reach
    const own = ssh as unknown as { client: { git?: true } };
    own.client = { ...own.client, git: true };
    await expect(ssh.start()).rejects.toThrow("does not read Windows' ssh-agent service");
  });

  it("adds nothing to a refusal when the plain ssh on PATH runs", async () => {
    const { ssh } = fixture({ FAKE_PASSPHRASE: "secret" });
    await expect(ssh.start()).rejects.toThrow(/^pc@pc\.example: Permission denied \(publickey\)\.$/);
  });

  it("asks for a passphrase once and answers it to the commands after connecting", async () => {
    const { ssh, prompts, calls, ask } = fixture({ FAKE_PASSPHRASE: "secret" });
    await ssh.start(ask("secret"));
    expect(await ssh.run("true")).toBe("ran\n");
    expect(await ssh.run("true")).toBe("ran\n");
    expect(prompts).toEqual([{ prompt: "Enter passphrase for key 'k': ", hostKey: false }]);
    expect(ssh.usedSecret).toBe(true);
    expect(calls().filter((line) => line.endsWith("sh -c 'true'")).every((line) => line.includes("BatchMode=no"))).toBe(true);
    // a keyboard-interactive prompt is the server's text, and cmd would parse it as a command line
    expect(calls().filter((line) => !line.includes("PreferredAuthentications=none") && !line.includes(" -G ")).every((line) => line.includes("KbdInteractiveAuthentication=no"))).toBe(true);
  });

  it("refuses a prompt it was not asked while connecting, without asking the user", async () => {
    const { ssh, prompts, ask } = fixture({ FAKE_PASSPHRASE: "secret" });
    await ssh.start(ask("secret"));
    process.env["FAKE_PROMPT"] = "pc@pc.example's password: ";
    await expect(ssh.run("true")).rejects.toThrow("Permission denied");
    expect(prompts).toHaveLength(1);
  });

  it("never replays an answer that did not authenticate", async () => {
    const { ssh, ask } = fixture({ FAKE_PASSPHRASE: "secret" });
    await expect(ssh.start(ask("wrong"))).rejects.toThrow("Permission denied");
  });

  it("answers no helper that lacks this connection's token", async () => {
    const { root, ssh, prompts, ask } = fixture({ FAKE_PASSPHRASE: "secret", FAKE_INTRUDER: "1" });
    await ssh.start(ask("secret"));
    expect(readFileSync(join(root, "intruder"), "utf8")).toBe("");
    expect(readFileSync(join(root, "intruder.code"), "utf8").trim()).not.toBe("0");
    expect(prompts).toHaveLength(1);
  });

  describe("an unknown host", () => {
    function hostKey(): { line: string; fingerprint: string } {
      const raw = Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!, "base64url");
      const field = (bytes: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
      const blob = Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]);
      const fingerprint = "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
      return { line: `pc.example ssh-ed25519 ${blob.toString("base64")}`, fingerprint };
    }

    it("shows the fingerprint before any authenticating connection and trusts it on yes", async () => {
      const { state, ssh, prompts, calls, ask } = fixture();
      const key = hostKey();
      process.env["FAKE_HOSTKEY_LINE"] = key.line;
      await ssh.start(ask("yes"));
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.hostKey).toBe(true);
      expect(prompts[0]!.prompt).toContain(`ED25519 key fingerprint is ${key.fingerprint}.`);
      expect(readFileSync(join(state, "known_hosts"), "utf8")).toContain(key.line);
      // the learning connection offered no authentication at all
      expect(calls().find((line) => line.includes("PreferredAuthentications=none"))).toContain("IdentityAgent=none");
    });

    it("trusts nothing on no", async () => {
      const { state, ssh, ask } = fixture();
      process.env["FAKE_HOSTKEY_LINE"] = hostKey().line;
      await expect(ssh.start(ask("no"))).rejects.toThrow("Host key verification failed.");
      expect(readFileSync(join(state, "known_hosts"), "utf8")).toBe("");
    });

    it("is not learned without someone to ask", async () => {
      const { root, ssh } = fixture();
      process.env["FAKE_HOSTKEY_LINE"] = hostKey().line;
      await expect(ssh.start()).rejects.toThrow("Host key verification failed.");
      expect(existsSync(join(root, "calls")) && readFileSync(join(root, "calls"), "utf8").includes("PreferredAuthentications=none")).toBe(false);
    });
  });

  describe("forwards", () => {
    it("opens the loopback port, and its ending ends the connection", async () => {
      // the tunnel ends at its second connection: the first is forward()'s own readiness check
      const { ssh, ask } = fixture({ FAKE_TUNNEL_ENDS_AT: "2" });
      await ssh.start(ask("unused"));
      const ended = Promise.withResolvers<void>();
      ssh.onExit = () => ended.resolve();
      const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const port = free.port;
      free.stop(true);
      await ssh.forward(port, 7317);
      const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
      socket.end();
      await ended.promise;
      expect(ssh.connected()).toBe(false);
    });

    it("refuses a host whose SSH config adds forwards of its own", async () => {
      const { ssh, ask } = fixture({ FAKE_CONFIG_FORWARD: "1" });
      await ssh.start(ask("unused"));
      await expect(ssh.forward(40_000, 7317)).rejects.toThrow("LocalForward, RemoteForward or DynamicForward");
    });
  });

  it("leaves no folder behind for connections that never start, and removes a started one's on close", async () => {
    const { root, ssh, ask } = fixture();
    // a setup that was cancelled before connecting, or a test that stubs start and close
    const idle = Array.from({ length: 20 }, () => new SshConnection({ destination: "pc" }, join(root, "state"), undefined, false, false));
    expect(idle.map((connection) => connection["dir"]).filter((dir) => dir && existsSync(dir))).toEqual([]);
    await ssh.start(ask("unused"));
    const dir = ssh["dir"];
    expect(existsSync(join(dir, "askpass"))).toBe(true);
    ssh.close();
    expect(existsSync(dir)).toBe(false);
    const cancelled = new SshConnection({ destination: "pc" }, join(root, "state"), undefined, false, false);
    cancelled.close();
    await expect(cancelled.start(ask("unused"))).rejects.toThrow("Connection cancelled");
    expect(cancelled["dir"]).toBe("");
  });
});

describe("sweeping connection folders an earlier server left", () => {
  it("removes only this prefix's empty folders older than the limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-ssh-sweep-"));
    try {
      const old = (Date.now() - 2 * 60 * 60_000) / 1000;
      for (const name of ["herdr-ssh-old1", "herdr-ssh-old2", "herdr-ssh-busy", "herdr-ssh-new", "other-old"]) mkdirSync(join(root, name));
      writeFileSync(join(root, "herdr-ssh-busy", "askpass"), "");
      for (const name of ["herdr-ssh-old1", "herdr-ssh-old2", "herdr-ssh-busy", "other-old"]) utimesSync(join(root, name), old, old);
      expect(await sweepSshDirs(root)).toBe(2);
      expect(["herdr-ssh-old1", "herdr-ssh-old2", "herdr-ssh-busy", "herdr-ssh-new", "other-old"].filter((name) => existsSync(join(root, name)))).toEqual(["herdr-ssh-busy", "herdr-ssh-new", "other-old"]);
      expect(await sweepSshDirs(join(root, "missing"))).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("which OpenSSH runs", () => {
  const git = String.raw`C:\Program Files\Git\usr\bin`;
  const gitClient = { ssh: String.raw`${git}\ssh.exe`, sftp: String.raw`${git}\sftp.exe`, keygen: String.raw`${git}\ssh-keygen.exe` };
  const only = (...paths: string[]) => (path: string) => paths.includes(path);
  const plain = { ssh: "ssh", sftp: "sftp", keygen: "ssh-keygen" };
  const programFiles = { ProgramFiles: String.raw`C:\Program Files` };
  const noRegistry = () => null;
  const found = { ...gitClient, git: true as const };

  it("is Git for Windows' on Windows, whose ssh exits after a command that printed something", () => {
    expect(sshClient({ platform: "win32", env: programFiles, which: () => null, registry: noRegistry, exists: only(...Object.values(gitClient)) })).toEqual(found);
  });

  it("finds Git where its installer recorded it", () => {
    const dir = String.raw`D:\Tools\Git\usr\bin`;
    const client = { ssh: String.raw`${dir}\ssh.exe`, sftp: String.raw`${dir}\sftp.exe`, keygen: String.raw`${dir}\ssh-keygen.exe` };
    expect(sshClient({ platform: "win32", env: programFiles, which: () => null, registry: () => String.raw`D:\Tools\Git`, exists: only(...Object.values(client), ...Object.values(gitClient)) })).toEqual({ ...client, git: true as const });
  });

  it("never takes an ssh from a Git-shaped folder on PATH, which anybody may be able to write", () => {
    const planted = String.raw`C:\Users\Public\planted`;
    const which = () => String.raw`${planted}\cmd\git.exe`;
    const plantedSsh = String.raw`${planted}\usr\bin\ssh.exe`;
    expect(sshClient({ platform: "win32", env: programFiles, which, registry: noRegistry, exists: only(plantedSsh, ...Object.values(gitClient)) })).toEqual(found);
    expect(sshClient({ platform: "win32", env: programFiles, which, registry: noRegistry, exists: only(plantedSsh) })).toEqual(plain);
  });

  it("is the one OVIS_SSH names, with the sftp and ssh-keygen beside it where they exist", () => {
    const env = { ...programFiles, OVIS_SSH: String.raw`D:\OpenSSH\ssh.exe` };
    const exists = only(...Object.values(gitClient), String.raw`D:\OpenSSH\sftp.exe`);
    expect(sshClient({ platform: "win32", env, which: () => null, registry: noRegistry, exists }))
      .toEqual({ ssh: String.raw`D:\OpenSSH\ssh.exe`, sftp: String.raw`D:\OpenSSH\sftp.exe`, keygen: "ssh-keygen" });
  });

  it("takes OVIS_SSH in quotes, or as a name on PATH, with that folder's sftp and ssh-keygen", () => {
    const dir = String.raw`D:\OpenSSH`;
    const client = { ssh: String.raw`${dir}\ssh.exe`, sftp: String.raw`${dir}\sftp.exe`, keygen: String.raw`${dir}\ssh-keygen.exe` };
    const exists = only(...Object.values(client));
    expect(sshClient({ platform: "win32", env: { OVIS_SSH: `"${client.ssh}"` }, which: () => null, registry: noRegistry, exists })).toEqual(client);
    expect(sshClient({ platform: "win32", env: { OVIS_SSH: "ssh.exe" }, which: (name) => name === "ssh.exe" ? client.ssh : null, registry: noRegistry, exists })).toEqual(client);
  });

  it("finds a Scoop Git in the account's own profile", () => {
    const env = { USERPROFILE: String.raw`C:\Users\pc` };
    const scoop = String.raw`C:\Users\pc\scoop\apps\git\current\usr\bin`;
    const client = { ssh: String.raw`${scoop}\ssh.exe`, sftp: String.raw`${scoop}\sftp.exe`, keygen: String.raw`${scoop}\ssh-keygen.exe` };
    expect(sshClient({ platform: "win32", env, which: () => null, registry: noRegistry, exists: only(...Object.values(client)) })).toEqual({ ...client, git: true as const });
  });

  it("tells a refused connection that Git's ssh does not read Windows' agent service, and only Git's", () => {
    const refused = "pc@pc.example: Permission denied (publickey).";
    expect(refusalHint(found, refused)).toContain("does not read Windows' ssh-agent service");
    expect(refusalHint(found, "ssh: connect to host pc.example port 22: Connection timed out")).toBe("");
    expect(refusalHint({ ssh: String.raw`C:\Windows\System32\OpenSSH\ssh.exe`, sftp: "sftp", keygen: "ssh-keygen" }, refused)).toBe("");
  });

  it("stays the one on PATH without Git, and on other systems", () => {
    expect(sshClient({ platform: "win32", env: programFiles, which: () => null, registry: noRegistry, exists: () => false })).toEqual(plain);
    expect(sshClient({ platform: "linux", env: {}, which: () => "/usr/bin/git", registry: () => "/opt/git", exists: () => true })).toEqual(plain);
  });
});
