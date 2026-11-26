/**
 * The SSH an account add vouches with (docs/account.md, "Adding a PC over SSH"), against a throwaway OpenSSH server on
 * 127.0.0.1 with its own host key and authorized keys: a host key is trusted only on the person's yes (never accepted
 * silently), a changed one is refused, no password is ever asked, and the PC's owner socket is reached only through the
 * connection's own folder.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { askRecoverySocket, openRecoverySocket } from "./account/recovery.ts";
import { shellQuote } from "./machine-security.ts";
import { SshConnection, stdioSocketForward } from "./ssh.ts";

const SSHD = "/usr/sbin/sshd";
const available = process.platform !== "win32" && existsSync(SSHD);
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function keygen(path: string): void {
  const made = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path]);
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
}

/** A throwaway sshd for this user only, on a port of its own; resolves once sshd says it listens. */
async function sshd(root: string, hostKey: string, options: { password?: boolean; port?: number } = {}): Promise<{ port: number; stop(): Promise<void> }> {
  const home = join(root, "remote");
  Bun.spawnSync(["mkdir", "-p", home]);
  const shell = join(root, "remote-shell");
  writeFileSync(shell, `#!/bin/sh\nexport HOME=${shellQuote(home)}\ncd "$HOME"\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`, { mode: 0o755 });
  const config = join(root, "sshd_config");
  // sshd takes no port 0: a free one is found first, as machines.ts freePort does
  let port = options.port;
  if (port === undefined) {
    const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    port = free.port;
    free.stop(true);
  }
  writeFileSync(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${join(root, "sshd.pid")}\nAuthorizedKeysFile ${join(root, "authorized_keys")}\nStrictModes no\nUsePAM no\nPasswordAuthentication ${options.password ? "yes" : "no"}\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nAllowUsers ${userInfo().username}\nAllowStreamLocalForwarding yes\nPermitTTY no\nForceCommand ${shell}\nLogLevel VERBOSE\n`);
  const daemon = Bun.spawn([SSHD, "-D", "-e", "-f", config], { stdout: "ignore", stderr: "pipe" });
  const stop = async () => { daemon.kill(); await daemon.exited; };
  cleanups.push(stop);
  const decoder = new TextDecoder();
  let said = "";
  const timeout = setTimeout(() => daemon.kill(), 15_000);
  try {
    for await (const chunk of daemon.stderr) {
      said += decoder.decode(chunk, { stream: true });
      if (said.includes(`Server listening on 127.0.0.1 port ${port}`)) {
        // the rest of its log is drained, or a chatty sshd would block on a full pipe
        void (async () => { for await (const _ of daemon.stderr) { /* drained */ } })().catch(() => {});
        return { port, stop };
      }
    }
  } finally { clearTimeout(timeout); }
  throw new Error(`sshd did not listen: ${said}`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "osa-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  keygen(join(root, "host"));
  keygen(join(root, "client"));
  writeFileSync(join(root, "authorized_keys"), readFileSync(join(root, "client.pub")), { mode: 0o600 });
  const state = join(root, "state");
  const connect = (port: number, identity = join(root, "client"), multiplexed = true) => {
    const ssh = new SshConnection({ destination: `${userInfo().username}@127.0.0.1`, port, identity_file: identity }, state, undefined, false, multiplexed);
    ssh.publicKeyOnly = true;
    cleanups.push(() => ssh.close());
    return ssh;
  };
  const asked: { hostKey: boolean; prompt: string }[] = [];
  const answering = (hostKey: "yes" | "no") => async (prompt: string, isHostKey: boolean) => { asked.push({ hostKey: isHostKey, prompt }); return isHostKey ? hostKey : "a-password"; };
  return { root, state, connect, asked, answering };
}

test.skipIf(!available)("an unknown host key the person does not confirm: no connection, nothing remembered", async () => {
  const { root, state, connect, asked, answering } = fixture();
  const { port } = await sshd(root, join(root, "host"));
  await expect(connect(port).start(answering("no"))).rejects.toThrow();
  expect(asked.map((entry) => entry.hostKey)).toEqual([true]);
  expect(readFileSync(join(state, "known_hosts"), "utf8")).toBe("");
});

test.skipIf(!available)("a confirmed host key connects, and the PC's owner socket answers through the connection's own folder; a changed key is refused unasked", async () => {
  const { root, connect, asked, answering } = fixture();
  const first = await sshd(root, join(root, "host"));
  const port = first.port;
  const owner = mkdtempSync(join(root, "owner-"));
  const socket = openRecoverySocket({ stateDir: owner, handle: async (request) => ({ heard: request }) });
  if ("refused" in socket) throw new Error(socket.refused);
  cleanups.push(() => socket.stop());
  const ssh = connect(port);
  await ssh.start(answering("yes"));
  expect(asked.map((entry) => entry.hostKey)).toEqual([true]);
  const local = await ssh.forwardSocket(socket.path);
  expect(local.startsWith(join("/tmp", "herdr-ssh-"))).toBe(true);
  expect(await askRecoverySocket(local, { act: "account_add_inspect" })).toEqual({ heard: { act: "account_add_inspect" } });
  // closed, the forward is gone from the master: nothing reaches the PC's socket through it any more
  await ssh.closeSocketForward(local);
  expect(existsSync(local)).toBe(false);
  await expect(askRecoverySocket(local, { act: "account_add_inspect" })).rejects.toThrow();
  expect(ssh.connected()).toBe(true);
  ssh.close();
  // the same address now shows another key: refused by ssh, never asked about again
  keygen(join(root, "changed-host"));
  await first.stop();
  await sshd(root, join(root, "changed-host"), { port });
  asked.length = 0;
  await expect(connect(port).start(answering("yes"))).rejects.toThrow(/IDENTIFICATION HAS CHANGED|Host key verification failed/);
  expect(asked).toEqual([]);
});

// OpenSSH reaches a Unix socket with -W from 9.4 on; an older ssh here is refused with words of its own (ssh.test.ts)
const stdioSockets = available && stdioSocketForward(Bun.spawnSync(["ssh", "-V"]).stderr.toString());

test.skipIf(!stdioSockets)("as on Windows, with no connection sharing: the PC's owner socket answers on an ssh of its own for each request", async () => {
  const { root, connect, answering } = fixture();
  const { port } = await sshd(root, join(root, "host"));
  const socket = openRecoverySocket({ stateDir: mkdtempSync(join(root, "o-")), handle: async (request) => ({ heard: request }) });
  if ("refused" in socket) throw new Error(socket.refused);
  cleanups.push(() => socket.stop());
  const ssh = connect(port, join(root, "client"), false);
  await ssh.start(answering("yes"));
  for (const act of ["account_add_inspect", "account_add_take"]) {
    expect(JSON.parse(await ssh.askSocket(socket.path, JSON.stringify({ act })))).toEqual({ heard: { act } });
  }
  await expect(ssh.askSocket(join(root, "nothing-here.sock"), JSON.stringify({ act: "account_add_inspect" }))).rejects.toThrow();
  expect(ssh.connected()).toBe(true);
});

test.skipIf(!available)("a key the PC does not accept fails: no password is ever asked, even where the server takes one", async () => {
  const { root, connect, asked, answering } = fixture();
  keygen(join(root, "stranger"));
  const { port } = await sshd(root, join(root, "host"), { password: true });
  await expect(connect(port, join(root, "stranger")).start(answering("yes"))).rejects.toThrow(/Permission denied/);
  expect(asked.every((entry) => entry.hostKey)).toBe(true);
});
