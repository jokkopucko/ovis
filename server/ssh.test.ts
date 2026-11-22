import { afterEach, describe, expect, it } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, watch, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeDescriptor } from "./bridge.ts";
import type { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { forwardSaysReady, refusalHint, SshConnection, sshClient, sshVerboseLine, sweepSshDirs } from "./ssh.ts";
import { posixHost, type HostInspection } from "./remote-host.ts";

// The direct mode Windows uses (its OpenSSH has no connection sharing), run here against a
// stand-in ssh. Windows itself runs it against real hosts; this sh stand-in needs a POSIX shell.
const FAKE_SSH = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DIR/calls"
kh=""; batch=""; learn=""; config=""; tunnel=""; forward=""; verbose=""; prev=""; last=""
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
  [ "$a" = "-v" ] && verbose=1
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
  rport=$(printf '%s' "$forward" | cut -d: -f4)
  # a ProxyJump's ssh gets -v too, shares stderr and enters its own session in the jump host first
  [ -n "$verbose" ] && [ -n "$FAKE_JUMP" ] && printf 'debug1: Entering interactive session.\r\n' >&2
  # a ProxyCommand child that outlives ssh and keeps its stderr open
  [ -n "$FAKE_HOLD_STDERR" ] && { sleep 600 & echo $! > "$FAKE_DIR/holder.pid"; }
  [ -n "$FAKE_AUTH_GATE" ] && read -r _ < "$FAKE_AUTH_GATE"
  # what OpenSSH 10.2 says: the first lines come before its bind, the last once its forwards stand;
  # with LogVerbose each debug line carries its source location after the level
  exec "$FAKE_BUN" -e "
const say = (line) => require('node:fs').writeSync(2, line + '\r\n');
const debug = (where, message) => say('debug1: ' + ('$FAKE_LOG_VERBOSE' ? where + ' ' : '') + message);
if ('$verbose') debug('ssh.c:2015 ssh_init_forwarding():', 'Local connections to 127.0.0.1:$port forwarded to remote address 127.0.0.1:$rport');
if ('$verbose') debug('channels.c:3810 channel_setup_fwd_listener_tcpip():', 'Local forwarding listening on 127.0.0.1 port $port.');
let opened = 0;
try { Bun.listen({ hostname: '127.0.0.1', port: $port, socket: { open() { if (++opened === Number(process.env.FAKE_TUNNEL_ENDS_AT)) process.exit(0); }, data() {} } }); }
catch { say('bind [127.0.0.1]:$port: Address already in use'); say('channel_setup_fwd_listener_tcpip: cannot listen to port: $port'); say('Could not request local forwarding.'); process.exit(255); }
if ('$verbose') debug('clientloop.c:1470 client_loop():', 'Entering interactive session.');
"
fi
[ "$last" = "exit" ] && exit 0
case "$FAKE_FLOOD" in
  whitespace) head -c 8388608 /dev/zero | tr '\0' ' '; printf '[]'; exit 0 ;;
  stdout) exec yes ;;
  stderr) exec yes >&2 ;;
esac
echo ran
`;

// CI's runner image has no OpenSSH, so the real one cannot be relied on.
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

const FAKE_KEYS = ["FAKE_DIR", "FAKE_BUN", "FAKE_PASSPHRASE", "FAKE_PROMPT", "FAKE_HOSTKEY_LINE", "FAKE_INTRUDER", "FAKE_CONFIG_FORWARD", "FAKE_TUNNEL_ENDS_AT", "FAKE_FLOOD", "FAKE_AUTH_GATE", "FAKE_JUMP", "FAKE_LOG_VERBOSE", "FAKE_HOLD_STDERR"];

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

  // a PC's discovery answer is read only up to its cap: past it the command is stopped, and nothing it said is taken, so a
  // PC cannot pad a list nor stream until the command's timeout
  it.each(["whitespace", "stdout", "stderr"])("stops reading a PC's herdr discovery past its cap: %s", async (flood) => {
    const { ssh, ask } = fixture({ FAKE_FLOOD: flood });
    await ssh.start(ask("unused"));
    await expect(posixHost.discoverSessions!(ssh, { runtimeDir: "/fixture/runtime" } as HostInspection)).rejects.toThrow("more output than expected");
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
    for (const [how, extra] of [["", {}], [" behind a ProxyJump", { FAKE_JUMP: "1" }], [" with LogVerbose", { FAKE_LOG_VERBOSE: "1" }]] as const) it(`opens the loopback port, and its ending ends the connection${how}`, async () => {
      const { ssh, ask } = fixture({ FAKE_TUNNEL_ENDS_AT: "1", ...extra });
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

    // freePort() closes the port it found before ssh binds it, and another process on this PC may
    // take it in between: the bridge's token must never reach that process.
    it("ends a forward still waiting for ssh at once when the connection closes, though a child holds ssh's stderr", async () => {
      const { root, ssh, ask } = fixture({ FAKE_HOLD_STDERR: "1" });
      await ssh.start(ask("unused"));
      const gate = join(root, "auth");
      await Bun.$`mkfifo ${gate}`;
      process.env["FAKE_AUTH_GATE"] = gate;
      const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const port = free.port;
      free.stop(true);
      // the second holder's pid: the fake's `echo $! > holder.pid` makes the file before the pid is in it, and
      // process.kill(0) (an empty file's Number) would signal this test's own process group
      const holderPid = (): number | null => {
        try { const pid = Number(readFileSync(join(root, "holder.pid"), "utf8")); return Number.isInteger(pid) && pid > 0 ? pid : null; } catch { return null; }
      };
      cleanups.push(() => { const pid = holderPid(); if (pid !== null) try { process.kill(pid); } catch {} });
      const holding = Promise.withResolvers<void>();
      const watcher = watch(root, (_event, name) => { if (name === "holder.pid" && holderPid() !== null) holding.resolve(); });
      cleanups.push(() => watcher.close());
      const forwarding = ssh.forward(port, 7317);
      forwarding.catch(() => {});
      await holding.promise;
      ssh.close();
      await expect(forwarding).rejects.toThrow("Connection cancelled");
    }, 5_000);

    // a ProxyJump's ssh enters its own session before this ssh has even authenticated
    for (const [how, extra] of [["", {}], [", behind a ProxyJump", { FAKE_JUMP: "1" }], [", with LogVerbose", { FAKE_LOG_VERBOSE: "1" }]] as const) it(`never hands the bridge token to a process that took the port before ssh bound it${how}`, async () => {
      const { root, ssh, ask } = fixture({ ...extra });
      await ssh.start(ask("unused"));
      const gate = join(root, "auth");
      await Bun.$`mkfifo ${gate}`;
      process.env["FAKE_AUTH_GATE"] = gate;
      const token = "b".repeat(64);
      let heard = "";
      const forward = ssh.forward.bind(ssh);
      ssh.forward = async (port: number, remotePort: number) => {
        const squatter = Bun.listen({ hostname: "127.0.0.1", port, socket: { data(socket, data) {
          heard += data.toString();
          socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}");
        } } });
        cleanups.push(() => squatter.stop(true));
        const opened = forward(port, remotePort);
        await writeFile(gate, "\n");
        return opened;
      };
      const manager = new MachineManager(join(root, "manager"), {} as PushService, {} as CompletionTracker);
      cleanups.push(() => manager.stop());
      const descriptor = { port: 7317, token, pid: process.pid, socket_path: "/s", bridge_protocol: 0, bundle_version: "" } as BridgeDescriptor;
      const verify = (manager as unknown as { verify(ssh: SshConnection, descriptor: BridgeDescriptor, socket: string): Promise<unknown> }).verify.bind(manager);
      const told = await verify(ssh, descriptor, "/s").then(() => "verified", (error: Error) => error.message);
      expect(heard).not.toContain(token);
      expect(told).toContain("Could not request local forwarding.");
    });

    it("refuses a host whose SSH config adds forwards of its own", async () => {
      const { ssh, ask } = fixture({ FAKE_CONFIG_FORWARD: "1" });
      await ssh.start(ask("unused"));
      await expect(ssh.forward(40_000, 7317)).rejects.toThrow("LocalForward, RemoteForward or DynamicForward");
    });
  });

  it("leaves no folder behind for connections that never start, and removes a started one's on close", async () => {
    const { root, ssh, ask } = fixture();
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

describe("which ssh says a forward is bound", () => {
  // Windows' own OpenSSH writes no -v line to a pipe: forward() must not wait for one from it, or every
  // Windows connect without Git for Windows times out after 25 s
  it("waits for the word from Git for Windows' ssh and from OpenSSH outside Windows, never from Windows' own", () => {
    expect(forwardSaysReady({ git: true }, "win32")).toBe(true);
    expect(forwardSaysReady({}, "win32")).toBe(false);
    expect(forwardSaysReady({ git: false }, "win32")).toBe(false);
    expect(forwardSaysReady({}, "linux")).toBe(true);
    expect(forwardSaysReady({}, "darwin")).toBe(true);
  });

  // a failed forward's error is ssh's own words: the lines -v adds, prefixed or not, stay out of it
  it("keeps ssh's own words and drops what -v adds", () => {
    const stderr = [
      "OpenSSH_10.0p2, OpenSSL 3.5.1 1 Jul 2025",
      "debug1: Reading configuration data /etc/ssh/ssh_config",
      "Authenticated to example.test ([192.0.2.7]:22) using \"publickey\".",
      "bind [127.0.0.1]:41234: Address already in use",
      "channel_setup_fwd_listener_tcpip: cannot listen to port: 41234",
      "Could not request local forwarding.",
      "Transferred: sent 2944, received 2792 bytes, in 0.1 seconds",
      "Bytes per second: sent 29440.0, received 27920.0",
    ];
    expect(stderr.filter((line) => !sshVerboseLine(line))).toEqual([
      "bind [127.0.0.1]:41234: Address already in use",
      "channel_setup_fwd_listener_tcpip: cannot listen to port: 41234",
      "Could not request local forwarding.",
    ]);
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
