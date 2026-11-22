import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as listenOn } from "node:net";
import { tmpdir } from "node:os";
import { readProcessBirth } from "./process-owner.ts";
import { join } from "node:path";
import { quietPort } from "../scripts/quiet-port.ts";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type Machine, type PcInstallFailure, type PcInstallJob } from "../shared/machines.ts";
import type { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { birthNow, bornAs, captureServer, type InstallConnect, installerRun, installPlanFor, PcInstaller, processIdentity, registeredAs, restoreServer, runs, SAVED_SERVER } from "./pc-install.ts";
import { SshConnection } from "./ssh.ts";

const SOCKET = "/home/fx/.config/herdr/herdr.sock";
interface Descriptor { pid: number; port: number; token: string; socket_path: string; managed_remote: boolean; bridge_protocol: number; bundle_version: string; birth?: { platform: string; value: string } }
const descriptor = (pid: number, managed = false, token = "a".repeat(64)): Descriptor => ({ pid, port: 7317, token, socket_path: SOCKET, managed_remote: managed, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION });
interface Pc {
  refused?: string;
  os?: string;
  tools?: string[];
  freeKb?: number;
  writable?: boolean;
  herdrRunning?: boolean;
  launcher?: "plugin" | "systemd";
  command?: string;
  newPid?: number;
  besideLauncher?: boolean;
  ovisSocket?: string;
  probeFails?: boolean;
  installer?: { exit: number; output: string };
  neverStarts?: boolean;
  uncapturable?: boolean;
  restoreFails?: boolean;
  captureFails?: boolean;
  unfaithful?: boolean;
  headlessFails?: boolean;
  reusedAfterReads?: number;
  addressTaken?: boolean;
  restoreOff?: boolean;
  births?: Record<number, string>;
  startedLate?: number[];
  onLaunch?: () => void;
  unreadable?: number[];
  zombies?: number[];
  onProbe?: () => void;
  otherRegistersOnRestore?: boolean;
  otherPrograms?: number[];
  killIgnored?: boolean;
  exitAfterChecks?: number;
  launcherFails?: string;
  installerDrops?: string;
  installerHeld?: { started(): void; gate: Promise<void> };
  descriptors?: Descriptor[];
}

const cleanups: (() => void)[] = [];
/**
 * A port nothing listens on now, for a stand-in server's own address, which no stand-in ever binds: outside the ports the
 * system hands out for port 0. One taken with port 0 and let go is handed to the next `port: 0` server (this file's relay,
 * or another test file's beside it in `bun run check`), and the restore then finds its address taken.
 */
const freePort = quietPort;
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(pc: Pc) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pc-install-"));
  const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close };
  cleanups.push(() => { Object.assign(SshConnection.prototype, real); rmSync(dir, { recursive: true, force: true }); });
  const listed: Descriptor[] = [...(pc.descriptors ?? [])];
  const alive = new Set(listed.map((d) => d.pid));
  let identityReads = 0;
  const identity = (pid: number) => pid === 4242 && pc.reusedAfterReads !== undefined && identityReads > pc.reusedAfterReads ? "Mon Nov  9 09:00:00 2026 1000" : `Sun Nov  8 08:00:00 2026 1000 ${pid}`;
  const bornAsShown = (script: string) => [...script.matchAll(/born_of=(\d+);[\s\S]*?\)" = '([^']*)' \]/g)].every((m) => (pc.births?.[Number(m[1])] ?? m[2]) === m[2])
    && [...script.matchAll(/reg_of=(\d+);/g)].every((m) => !pc.startedLate?.includes(Number(m[1])));
  const sameAsShown = (script: string) => { const m = /\[ "\$\(id_of=(\d+);[\s\S]*?fi\)" = '([^']*)' \]/.exec(script); if (!m) return true; identityReads++; return identity(Number(m[1])) === m[2]; };
  const dying = new Map<number, number>();
  const commands: string[] = [];
  const challenges: unknown[] = [];
  const register = (socket = SOCKET) => { if (pc.neverStarts) return; const next = { ...descriptor(pc.newPid ?? 5555, false, "b".repeat(64)), socket_path: socket }; listed.push(next); alive.add(next.pid); };
  const registerInstalled = () => register(pc.ovisSocket);
  SshConnection.prototype.start = async (challenge?: unknown) => { challenges.push(challenge); if (pc.refused) throw new Error(pc.refused); };
  SshConnection.prototype.close = () => {};
  SshConnection.prototype.run = async (script: string) => {
    commands.push(script);
    if (script.includes("free_kb=")) {
      if (pc.probeFails) throw new Error("Connection to lab.invalid closed by remote host.");
      const tools = pc.tools ?? ["curl", "git", "tar"];
      return [`os=${pc.os ?? "Linux"}`, "arch=x86_64", ...tools.map((tool) => `has=${tool}`), ...(pc.writable === false ? [] : ["writable=1"]), `free_kb=${pc.freeKb ?? 50_000_000}`,
        "herdr=1", ...(pc.herdrRunning === false ? [] : ["herdr_running=1"]), `launcher=${pc.launcher ?? "none"}`].join("\n") + "\n";
    }
    if (script.startsWith("id_of=")) { identityReads++; return identity(Number(/^id_of=(\d+)/.exec(script)![1])) + "\n"; }
    if (script.includes("ovis-restore.XXXXXXXX") && !sameAsShown(script)) return "changed\n";
    if (script.includes("ovis-restore.XXXXXXXX")) return pc.uncapturable ? "" : pc.captureFails ? "error\n" : pc.unfaithful ? "unfaithful\n" : "/tmp/ovis-restore.Ab12Cd34\n";
    if (script.includes('[ -L "$d/exe" ]') && pc.addressTaken) return "taken\n";
    if (script.includes('[ -L "$d/exe" ]') && pc.otherRegistersOnRestore) { const other = descriptor(4500, true, "f".repeat(64)); listed.push(other); alive.add(other.pid); }
    if (script.includes('[ -L "$d/exe" ]')) { pc.onLaunch?.(); if (!pc.restoreFails) { const back = { ...descriptor(4243, false, "d".repeat(64)), birth: { platform: "linux", value: pc.births?.[4243] ?? "1b4e28ba-2fa1-41d2-883f-0016d3cca427:4243" } }; listed.push(back); alive.add(back.pid); } return "4243 1b4e28ba-2fa1-41d2-883f-0016d3cca427:4243\n"; }
    if (script.endsWith("|| echo dead")) {
      pc.onProbe?.();
      const pid = Number(/kill -0 (\d+)/.exec(script)?.[1]);
      if (!alive.has(pid) || pc.zombies?.includes(pid)) return "dead\n";
      if (pc.unreadable?.includes(pid)) return "\n";
      const recorded = listed.find((d) => d.pid === pid)?.birth?.value;
      return (pc.births?.[pid] ?? recorded ?? `1b4e28ba-2fa1-41d2-883f-0016d3cca427:${pid}`) + "\n";
    }
    if (script.endsWith("&& echo live || true")) {
      pc.onProbe?.();
      if (script.includes(" && false && ")) return "";
      const pid = Number((/ps -o stat= -p (\d+)/.exec(script) ?? /born_of=(\d+)/.exec(script))?.[1]);
      // a zombie shows only to ps's state: a probe that does not ask it takes one as running
      const zombie = /ps -o stat= -p /.test(script) && pc.zombies?.includes(pid);
      return alive.has(pid) && !zombie && bornAsShown(script) ? "live\n" : "";
    }
    if (script.endsWith("&& echo same || true")) { const pid = Number(/born_of=(\d+)/.exec(script)?.[1]); return alive.has(pid) && bornAsShown(script) ? "same\n" : ""; }
    if (script.startsWith("rm -rf '") && script.includes("ovis-restore.")) return "";
    if (script.includes("/install.sh -o")) {
      if (pc.installerHeld) { pc.installerHeld.started(); await pc.installerHeld.gate; }
      if (pc.installerDrops) throw new Error(pc.installerDrops);
      const answer = pc.installer ?? { exit: 0, output: "Ovis: installing the herdr plugin" };
      if (answer.exit === 0 && pc.herdrRunning !== false) register();
      return `${answer.output}\novis-install-exit=${answer.exit}\n`;
    }
    if (script.includes("uname -s") && script.includes("bundle-ready")) return `Linux\nx86_64\n/home/fx\n/home/fx/.config\n/usr/bin/herdr\n${listed.map((d) => JSON.stringify(d)).join("\n")}\n`;
    if (script.includes("socket=")) return SOCKET;
    if (script.startsWith("ps -o args=") && pc.otherPrograms?.includes(Number(/-p (\d+)/.exec(script)![1]))) return "/usr/bin/vim notes.txt";
    if (script.startsWith("ps -o args=")) return pc.command ?? "/home/fx/.bun/bin/bun /home/fx/ovis/server/index.ts";
    if (script.includes("kill -0")) {
      const pid = Number(/kill -0 (\d+)/.exec(script)![1]);
      if (dying.has(pid)) { const left = dying.get(pid)! - 1; if (left <= 0) { dying.delete(pid); alive.delete(pid); } else dying.set(pid, left); }
      return alive.has(pid) ? "live" : "";
    }
    if (script.endsWith("&& echo born || true")) return !/(?:^|&& )false(?:[ ;]|$)/.test(script) && bornAsShown(script) ? "born\n" : "";
    if (script.includes("kill -TERM")) {
      const pid = Number(/kill -TERM (\d+)/.exec(script)![1]);
      if (/(?:^|&& )false(?:[ ;]|$)/.test(script) || !bornAsShown(script) || !sameAsShown(script)) return "changed\n";
      if (pc.exitAfterChecks) dying.set(pid, pc.exitAfterChecks); else if (!pc.killIgnored) alive.delete(pid);
      return script.includes("echo stopping") ? "stopping\n" : "";
    }
    if (script.includes('for f in "$HOME/.config/herdr-web-ui/bridges/"')) return listed.map((d) => JSON.stringify(d)).join("\n") + "\n";
    if (script.includes(" server </dev/null")) { if (pc.headlessFails) throw new Error("herdr: could not start the server"); if (pc.launcher) registerInstalled(); else register(); return ""; }
    if (pc.launcherFails && (script.includes("devswha.ovis.start") || script.includes("ovis.service"))) throw new Error(pc.launcherFails);
    if (script.includes("devswha.ovis.start") || script.includes("ovis.service")) { if (!pc.besideLauncher && (script.includes("devswha.ovis.stop") || script.includes("restart"))) for (const d of listed) alive.delete(d.pid); registerInstalled(); return ""; }
    throw new Error(`Unexpected remote command: ${script}`);
  };
  const connects: Parameters<InstallConnect>[0][] = [];
  let answer: string | null = null;
  let held: Promise<void> | null = null;
  let cancelled = 0;
  const followUps: ((id: string) => void)[] = [];
  const connect: InstallConnect = (request) => { const { onJob, ...asked } = request; connects.push(asked); if (onJob) followUps.push(onJob); return { job_id: "setup-job", cancel: () => { cancelled++; }, finished: (held ?? Promise.resolve()).then(() => answer) }; };
  const waiters: { phase: string; resolve(): void }[] = [];
  const onChange = (job: PcInstallJob) => { for (const waiter of waiters.splice(0)) if (waiter.phase === job.phase) waiter.resolve(); else waiters.push(waiter); };
  const reached = (phase: string) => new Promise<void>((resolve) => { waiters.push({ phase, resolve }); });
  const installer = new PcInstaller({ sshDir: join(dir, "ssh"), connect, release: "v9.9.9", pollMs: 1, startMs: 200, stopMs: 100, onChange, restore: () => !pc.restoreOff });
  cleanups.push(() => installer.stop());
  const settled = async (job: PcInstallJob) => { await installer.finished(job.id); return installer.job(job.id)!; };
  return { installer, commands, challenges, connects, settled, alive, registerNew: register, failConnect: (words: string) => { answer = words; }, holdConnect: (gate: Promise<void>) => { held = gate; }, cancelled: () => cancelled, reached, followUps, installerAnswer: (answer: { exit: number; output: string }) => { pc.installer = answer; } };
}

const target = { destination: "me@lab.invalid" };
const installs = (commands: string[]) => commands.filter((command) => command.includes("install.sh"));

describe("which PCs an install over SSH is offered for", () => {
  it("offers one on Linux and macOS, never on Windows, where the installer and its checks are not the ones used", () => {
    const target = { destination: "me@pc.invalid" };
    expect(installPlanFor("replace", "posix", 4242, target)).toEqual({ mode: "replace", pid: 4242, target });
    expect(installPlanFor("restart", "posix", 4242, target)).toEqual({ mode: "restart", pid: 4242, target });
    expect(installPlanFor("replace", "posix", 4242, target, undefined, "/home/u/.local/state/ovis/herdr-core.sock")).toEqual({ mode: "replace", pid: 4242, socket: "/home/u/.local/state/ovis/herdr-core.sock", target });
    expect(installPlanFor("replace", "windows", 4242, target)).toBeUndefined();
    expect(installPlanFor(undefined, "posix", 4242, target)).toBeUndefined();
  });
});

describe("installing Ovis on a PC over SSH", () => {
  it("runs the official installer pinned to this app's release with keys only, waits for it to answer, then connects it", async () => {
    const pc = fixture({});
    const job = await pc.settled(pc.installer.start({ target, name: "Lab" }));
    expect(job).toMatchObject({ phase: "connected", error: null, error_code: null, connect_job: "setup-job", mode: "install", machine_id: null });
    expect(pc.challenges).toEqual([undefined]);
    expect(installs(pc.commands)).toHaveLength(1);
    // downloaded to a file and run from it: piped into a sh whose stdin is /dev/null, nothing would run at all
    expect(installs(pc.commands)[0]).toContain("curl -fsSL --max-time 120 https://raw.githubusercontent.com/devswha/ovis/v9.9.9/install.sh -o \"$script\"");
    expect(installs(pc.commands)[0]).toContain("OVIS_REF=v9.9.9 OVIS_RUNTIME=herdr OVIS_NO_OPEN=1 sh \"$script\" </dev/null");
    expect(installs(pc.commands)[0]).not.toContain("| OVIS_REF");
    expect(pc.connects).toEqual([{ target, name: "Lab", update: false }]);
  });

  it("starts herdr without a terminal when the installed plugin waits for it", async () => {
    const pc = fixture({ herdrRunning: false });
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job.phase).toBe("connected");
    expect(pc.commands.some((command) => command.includes("nohup herdr server </dev/null"))).toBe(true);
  });

  const refusals: [string, Pc, PcInstallFailure, RegExp][] = [
    ["keys are not let in", { refused: "me@lab.invalid: Permission denied (publickey,password)." }, "ssh_refused", /did not let this app in with SSH keys/],
    ["its host key is unknown", { refused: "Host key verification failed." }, "ssh_host_key", /host key is not known here/],
    ["it cannot be reached", { refused: "ssh: Could not resolve hostname lab.invalid: Name or service not known" }, "ssh_unreachable", /could not be reached over SSH: ssh: Could not resolve hostname/],
    ["it runs Windows", { os: "MINGW64_NT-10.0" }, "unsupported", /Linux and macOS/],
    ["it has no curl", { tools: ["git", "tar"] }, "missing_tool", /has no curl/],
    ["its disk is full", { freeKb: 200_000 }, "disk", /only 195 MB free/],
    ["its home is not writable", { writable: false }, "permission", /cannot write to its own home folder/],
    ["this app's bridge serves it", { descriptors: [descriptor(4242, true)] }, "bridge_there", /runs this app's bridge/],
    ["Ovis already runs there", { descriptors: [descriptor(4242)] }, "ovis_there", /Ovis already runs on that PC/],
  ];
  for (const [when, pcState, code, words] of refusals) it(`says in plain words why it cannot install when ${when}, and installs nothing`, async () => {
    const pc = fixture(pcState);
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job.phase).toBe("failed");
    expect(job.error_code).toBe(code);
    expect(job.error).toMatch(words);
    expect(installs(pc.commands)).toEqual([]);
    expect(pc.connects).toEqual([]);
  });

  it("refuses a named herdr session, which the installer does not serve", async () => {
    const pc = fixture({});
    const job = await pc.settled(pc.installer.start({ target: { ...target, session: "work" } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "unsupported" });
    expect(pc.commands).toEqual([]);
  });

  it("tells the installer's own last words when it fails there", async () => {
    const pc = fixture({ installer: { exit: 1, output: "Ovis: needs herdr 0.9.0 or newer; this is 0.8.1." } });
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job).toMatchObject({ phase: "failed", error_code: "installer_failed" });
    expect(job.error).toBe("The Ovis installer failed on that PC: Ovis: needs herdr 0.9.0 or newer; this is 0.8.1.");
  });

  it("fails in plain words when the installed Ovis never starts, or the connect after it fails", async () => {
    const silent = fixture({ neverStarts: true });
    expect(await silent.settled(silent.installer.start({ target }))).toMatchObject({ phase: "failed", error_code: "not_started" });
    const refused = fixture({});
    refused.failConnect("This PC needs a password.");
    expect(await refused.settled(refused.installer.start({ target }))).toMatchObject({ phase: "failed", error_code: "connect_failed", error: "This PC needs a password." });
  });

  it("replaces a server started by hand: stops that very process, installs, and connects the PC it was for", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", mode: "replace", machine_id: "pc-1" });
    expect(pc.alive.has(4242)).toBe(false);
    expect(pc.commands.findIndex((command) => command.includes("kill -TERM 4242"))).toBeLessThan(pc.commands.findIndex((command) => command.includes("install.sh")));
    expect(pc.connects).toEqual([{ target, machine_id: "pc-1", update: false }]);
  });

  it("restarts a too-old supervisor through its own launcher, stopping it there rather than by its pid, then asks for the update", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], launcher: "plugin" });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", mode: "restart" });
    expect(installs(pc.commands)).toEqual([]);
    expect(pc.commands.some((command) => command.includes("kill -TERM"))).toBe(false);
    expect(pc.commands.some((command) => command.includes("herdr plugin action invoke devswha.ovis.stop") && command.includes("devswha.ovis.start"))).toBe(true);
    expect(pc.connects).toEqual([{ target, machine_id: "pc-1", update: true }]);
  });

  it("stops nothing for a restart when no launcher there could start it again", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "no_launcher" });
    expect(pc.alive.has(4242)).toBe(true);
    expect(pc.commands.some((command) => command.includes("kill") && !command.includes("kill -0"))).toBe(false);
  });

  it("stops nothing when the pid of the server shown now runs another program", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], command: "/usr/bin/vim notes.txt" });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(pc.alive.has(4242)).toBe(true);
  });

  it("starts an Ovis already installed there through its launcher and updates it, instead of an installer that would keep its release", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], launcher: "systemd" });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", mode: "replace" });
    expect(installs(pc.commands)).toEqual([]);
    expect(pc.connects).toEqual([{ target, machine_id: "pc-1", update: true }]);
  });

  it("knows the new Ovis by its new token even when it reuses an old process id", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], newPid: 4242 });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.phase).toBe("connected");
  });

  it("cancels the connect it handed over to, and never reports a cancelled install as connected", async () => {
    const pc = fixture({});
    const gate = Promise.withResolvers<void>();
    pc.holdConnect(gate.promise);
    const handedOver = pc.reached("connecting_pc");
    const started = pc.installer.start({ target });
    await handedOver;
    pc.installer.cancel(started.id);
    gate.resolve();
    expect(await pc.settled(started)).toMatchObject({ phase: "cancelled" });
    expect(pc.cancelled()).toBe(1);
  });

  it("stops nothing when the server it was asked to replace is no longer the one there", async () => {
    const pc = fixture({ descriptors: [descriptor(4343)] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(pc.commands.some((command) => command.includes("kill -TERM"))).toBe(false);
  });

  it("ends a cancelled install before anything more runs there", async () => {
    const pc = fixture({ neverStarts: true });
    const started = pc.installer.start({ target });
    pc.installer.cancel(started.id);
    const job = await pc.settled(started);
    expect(job.phase).toBe("cancelled");
    expect(pc.connects).toEqual([]);
  });

  it("says the server it stopped is gone when the install then fails, and installs on a retry with nothing left to stop", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], uncapturable: true, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const failed = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(failed).toMatchObject({ phase: "failed", error_code: "installer_failed" });
    expect(failed.error).toContain("already stopped, so none runs there now");
    pc.installerAnswer({ exit: 0, output: "Ovis: installing the herdr plugin" });
    const retried = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(retried).toMatchObject({ phase: "connected", error: null });
    expect(pc.commands.filter((command) => command.includes("kill -TERM 4242"))).toHaveLength(1);
  });

  it("restarts through the launcher on a retry after a restart whose launcher stopped the server and failed to start one", async () => {
    const pc = fixture({ launcher: "systemd" });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", error: null });
    expect(pc.commands.some((command) => command.includes("ovis.service"))).toBe(true);
  });

  it("restarts through the launcher on a retry when the planned server is gone and its pid now runs something else", async () => {
    const pc = fixture({ launcher: "systemd" });
    pc.alive.add(4242);
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "connected", error: null });
    expect(pc.commands.some((command) => /kill -TERM 5555/.test(command))).toBe(false);
  });

  it("fails with a code when the installer's SSH command ends without its answer", async () => {
    const pc = fixture({ installerDrops: "Connection to lab.invalid closed by remote host." });
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job).toMatchObject({ phase: "failed", error_code: "ssh_unreachable", error: expect.stringContaining("closed by remote host") });
  });

  it("fails in plain words, with its code, when the launcher's start fails there", async () => {
    const pc = fixture({ launcher: "systemd", launcherFails: "Failed to start ovis.service: Unit not found." });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "not_started", error: expect.stringContaining("Ovis could not be started on that PC: Failed to start ovis.service") });
  });

  it("says the server it stopped is gone only while nothing was started in its place", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)] });
    pc.failConnect("refused by that PC");
    const failed = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(failed).toMatchObject({ phase: "failed", error_code: "connect_failed" });
    expect(failed.error).not.toContain("none runs there now");
    expect(failed.error).toContain("installed in its place");
  });

  it("stops nothing when the shown server's pid now belongs to another Ovis server, by its token", async () => {
    const pc = fixture({ descriptors: [descriptor(4242, false, "c".repeat(64))] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242, token: "a".repeat(64) } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(pc.commands.some((command) => command.includes("kill -TERM 4242"))).toBe(false);
  });

  it("says another may have been installed when it is cancelled while the installer still runs there", async () => {
    const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const pc = fixture({ descriptors: [descriptor(4242)], uncapturable: true, installerHeld: { started: () => started.resolve(), gate: gate.promise } });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await started.promise;
    pc.installer.cancel(job.id);
    gate.reject(new Error("Connection cancelled"));
    const ended = await pc.settled(job);
    expect(ended.phase).toBe("cancelled");
    expect(ended.error).not.toContain("none runs there now");
    expect(ended.error).toContain("being installed in its place");
  });

  it("stops nothing when the shown server ended and another Ovis took its pid, the setting off: its registration's birth differs", async () => {
    const pc = fixture({ descriptors: [{ ...descriptor(4242), birth: { platform: "linux", value: "1b4e28ba-2fa1-41d2-883f-0016d3cca427:100" } }], births: { 4242: "1b4e28ba-2fa1-41d2-883f-0016d3cca427:900" }, restoreOff: true });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(pc.commands.some((command) => /kill -TERM 4242$/.test(command) || command.includes("&& kill -TERM 4242"))).toBe(false);
    expect(pc.alive.has(4242)).toBe(true);
  });

  it("stops a server whose registration recorded no birth (0.5.x) only if it started before that registration, the setting off", async () => {
    const late = fixture({ descriptors: [descriptor(4242)], startedLate: [4242], restoreOff: true });
    const job = await late.settled(late.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(job.error).toContain("started after that Ovis registered");
    expect(late.alive.has(4242)).toBe(true);
    const genuine = fixture({ descriptors: [descriptor(4242)], restoreOff: true });
    expect((await genuine.settled(genuine.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }))).phase).toBe("connected");
    expect(genuine.alive.has(4242)).toBe(false);
  });

  it("never takes a registration with a birth out of its shape for the server it names", async () => {
    const pc = fixture({ descriptors: [{ ...descriptor(4242), birth: { platform: "linux", value: 7 } as unknown as { platform: string; value: string } }], restoreOff: true });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(pc.alive.has(4242)).toBe(true);
  });

  it("starts the stopped server again past a registration left behind whose pid another process took, and waits for the one it started", async () => {
    const leftover = { ...descriptor(4300, false, "e".repeat(64)), birth: { platform: "linux", value: "1b4e28ba-2fa1-41d2-883f-0016d3cca427:100" } };
    const pc = fixture({ descriptors: [descriptor(4242), leftover], births: { 4300: "1b4e28ba-2fa1-41d2-883f-0016d3cca427:900" }, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.error).toContain("has been started again as it was");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]') && command.includes(` '${descriptor(4242).port}' `))).toBe(true);
    const silent = fixture({ descriptors: [descriptor(4242), leftover], births: { 4300: "1b4e28ba-2fa1-41d2-883f-0016d3cca427:900" }, restoreFails: true, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const two = await silent.settled(silent.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(two.error).toContain("starting it again as it was failed: it did not start within");
    const other = fixture({ descriptors: [descriptor(4242)], restoreFails: true, otherRegistersOnRestore: true, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const three = await other.settled(other.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(three.error).toContain("starting it again as it was failed: it did not start within");
  });

  it("fails closed on a registration whose identity cannot be told: it counts as a server there", async () => {
    const unknown = { ...descriptor(4300, true, "e".repeat(64)), birth: { platform: "linux", value: 7 } as unknown as { platform: string; value: string } };
    const pc = fixture({ descriptors: [descriptor(4242), unknown], installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.error).toContain("another already runs in its place");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
  });

  it("never says started for the one it started once that ended (a zombie), or once another took its pid", async () => {
    for (const options of [{ zombies: [4243] }, { births: { 4243: "1b4e28ba-2fa1-41d2-883f-0016d3cca427:9999" } }]) {
      const pc = fixture({ descriptors: [descriptor(4242)], ...options, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
      const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
      expect(job.error).toContain("starting it again as it was failed: it did not start within");
    }
  });

  it("starts nothing when this app stops while the restore looks at who serves the socket", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" }, onProbe: () => pc.installer.stop() });
    await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
  });

  it("takes a live registration whose birth cannot be read now for a server there, never as gone", async () => {
    const other = { ...descriptor(4300, true, "e".repeat(64)), birth: { platform: "linux", value: "1b4e28ba-2fa1-41d2-883f-0016d3cca427:100" } };
    const pc = fixture({ descriptors: [descriptor(4242), other], unreadable: [4300], installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.error).toContain("another already runs in its place");
  });

  it("never takes a registration left before the launch for the server it started, even at the pid it got", async () => {
    const stale = descriptor(4243, false, "c".repeat(64));
    const pc: ReturnType<typeof fixture> = fixture({ descriptors: [descriptor(4242), stale], restoreFails: true, onLaunch: () => { pc.alive.add(4243); }, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    pc.alive.delete(4243);
    const ended = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(ended.error).toContain("starting it again as it was failed: it did not start within");
  });

  it("only removes the copy when this app stops during an install, starting nothing there", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], exitAfterChecks: 3 });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await pc.reached("stopping");
    const connections = pc.challenges.length;
    pc.installer.stop();
    await pc.settled(job);
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    // no new SSH connection while this app shuts down (an unreachable PC would hold it): the copy's own lease removes it
    expect(pc.challenges.length).toBe(connections);
    expect(pc.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(false);
  });

  it("never puts the planned server's token on a command line there, with or without a recorded birth", async () => {
    const token = "a".repeat(64);
    for (const birth of [undefined, { platform: "linux", value: "1b4e28ba-2fa1-41d2-883f-0016d3cca427:100" }]) for (const mode of ["replace", "restart"] as const) {
      const pc = fixture({ descriptors: [{ ...descriptor(4242, false, token), ...(birth ? { birth } : {}) }], restoreOff: true, ...(mode === "restart" ? { launcher: "systemd" as const } : {}) });
      const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode, pid: 4242, token } }));
      expect(job).toMatchObject({ phase: "connected", mode });
      expect(pc.alive.has(4242)).toBe(false);
      expect(pc.commands.some((command) => command.endsWith("&& echo born || true"))).toBe(true);
      for (const command of pc.commands) expect(command).not.toContain(token);
    }
  });

  it("looks for a herdr-core server the plan names on its own adapter socket, never on herdr's default one", async () => {
    const socket = "/home/fx/.local/state/ovis/herdr-core.sock";
    const live = fixture({ descriptors: [{ ...descriptor(4242), socket_path: socket }], launcher: "systemd", restoreOff: true, ovisSocket: socket });
    const replaced = await live.settled(live.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242, socket } }));
    expect(replaced).toMatchObject({ phase: "failed", error_code: "no_launcher" });
    expect(live.commands.some((command) => command.includes("kill -TERM"))).toBe(false);
    expect(live.commands.some((command) => command.includes("ovis.service </dev/null"))).toBe(false);
    expect(live.alive.has(4242)).toBe(true);
    expect(live.connects).toEqual([]);
    const gone = fixture({ descriptors: [{ ...descriptor(4242), socket_path: socket }], launcher: "systemd", restoreOff: true, ovisSocket: socket });
    gone.alive.delete(4242);
    const started = await gone.settled(gone.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242, socket } }));
    expect(started.phase).toBe("connected");
    expect(gone.commands.some((command) => command.includes("kill -TERM 4242"))).toBe(false);
  });

  it.each(["replace", "restart"] as const)("refuses a herdr-core %s through a herdr plugin left there, starting no headless herdr", async (mode) => {
    const socket = "/home/fx/.local/state/ovis/herdr-core.sock";
    const pc = fixture({ descriptors: [{ ...descriptor(4242), socket_path: socket }], launcher: "plugin", herdrRunning: false, restoreOff: true });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode, pid: 4242, socket } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "no_launcher" });
    expect(pc.commands.some((command) => command.includes(" server </dev/null"))).toBe(false);
    expect(pc.commands.some((command) => command.includes("herdr plugin action invoke"))).toBe(false);
    expect(pc.commands.some((command) => command.includes("kill -TERM"))).toBe(false);
    expect(installs(pc.commands)).toEqual([]);
    expect(pc.alive.has(4242)).toBe(true);
    expect(pc.connects).toEqual([]);
  });

  it("refuses a herdr-core plan whose server is gone while another Ovis runs on herdr's default socket", async () => {
    const socket = "/home/fx/.local/state/ovis/herdr-core.sock";
    const pc = fixture({ descriptors: [{ ...descriptor(4242), socket_path: socket }, descriptor(4300, false, "c".repeat(64))], launcher: "systemd", restoreOff: true, ovisSocket: socket });
    pc.alive.delete(4242);
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242, socket } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "changed" });
    expect(installs(pc.commands)).toEqual([]);
    expect(pc.commands.some((command) => command.includes("systemctl --user start ovis.service"))).toBe(false);
    expect(pc.commands.some((command) => command.includes("kill -TERM"))).toBe(false);
    expect(pc.alive.has(4300)).toBe(true);
    expect(pc.connects).toEqual([]);
  });

  it("refuses to replace a herdr-core Ovis started by hand before stopping anything, through the card's install", async () => {
    const socket = "/home/fx/.local/state/ovis/herdr-core.sock";
    const token = "a".repeat(64);
    const pc = fixture({ descriptors: [{ ...descriptor(4242, false, token), socket_path: socket }], restoreOff: true });
    const dir = mkdtempSync(join(tmpdir(), "ovis-core-install-"));
    const id = "00000000-0000-4000-8000-0000000000cc";
    const saved = { destination: "me@lab.invalid", own_ovis: socket };
    writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "Lab", target: saved, enabled: true }]));
    const reconnect = spyOn(MachineManager.prototype as unknown as { reconnect(runtime: unknown): Promise<void> }, "reconnect").mockImplementation(async () => {});
    const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("isolated local offline"); });
    cleanups.push(() => { manager.stop(); reconnect.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
    const runtime = (manager as unknown as { machines: Map<string, { machine: Machine; installFix?: unknown }> }).machines.get(id)!;
    Object.assign(runtime.machine, { state: "error", action_required: "setup", remote_ovis: { version: "0.4.9", latest_version: null, updatable: false, reason: "not started by its updater", address: "lab.invalid:7317", url: null } });
    runtime.installFix = { mode: "replace", pid: 4242, token, socket, target: saved };
    expect(manager.list().find((machine) => machine.id === id)?.ovis_update).toMatchObject({ how: "install", updatable: true });
    const started = manager.install({ machine_id: id });
    await (manager as unknown as { installer: { finished(id: string): Promise<void> } }).installer.finished(started.id);
    const job = manager.installJob(started.id)!;
    expect(job).toMatchObject({ phase: "failed", error_code: "no_launcher", error: "Ovis on that PC was started by hand; update it there, or start it with its launcher first." });
    expect(pc.commands.some((command) => command.includes("kill -TERM"))).toBe(false);
    expect(installs(pc.commands)).toEqual([]);
    expect(pc.commands.some((command) => command.includes(" server </dev/null"))).toBe(false);
    expect(pc.alive.has(4242)).toBe(true);
    expect(job.connect_job).toBeNull();
  });

  const coreSocket = "/home/fx/.local/state/ovis/herdr-core.sock";
  const core = { ...descriptor(4242), socket_path: coreSocket };
  it("waits for a herdr-core Ovis its launcher restarts at its own adapter socket", async () => {
    const restarted = fixture({ descriptors: [core], launcher: "systemd", ovisSocket: coreSocket, restoreOff: true });
    expect(await restarted.settled(restarted.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242, socket: coreSocket } }))).toMatchObject({ phase: "connected", mode: "restart" });
  });

  it("never stops a herdr-core Ovis started by hand beside a launcher that may not bring it back at its adapter socket", async () => {
    const replaced = fixture({ descriptors: [core], launcher: "systemd", ovisSocket: SOCKET, restoreOff: true });
    expect(await replaced.settled(replaced.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242, socket: coreSocket } }))).toMatchObject({ phase: "failed", error_code: "no_launcher" });
    expect(replaced.commands.some((command) => command.includes("kill -TERM"))).toBe(false);
    expect(replaced.commands.some((command) => command.includes("ovis.service </dev/null"))).toBe(false);
    expect(replaced.alive.has(4242)).toBe(true);
  });

  it("restarts the Ovis of a chosen herdr session through its plugin, which no herdr-core rule refuses", async () => {
    const socket = "/home/fx/.config/herdr/sessions/work/herdr.sock";
    const pc = fixture({ descriptors: [{ ...descriptor(4242), socket_path: socket }], launcher: "plugin", ovisSocket: socket, restoreOff: true });
    expect(await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242, socket } }))).toMatchObject({ phase: "connected", mode: "restart" });
  });

  it("stops a second herdr-core Ovis a launcher's restart started at the planned server's adapter socket", async () => {
    const socket = coreSocket;
    const beside = fixture({ descriptors: [core], launcher: "systemd", ovisSocket: socket, besideLauncher: true, restoreOff: true });
    expect(await beside.settled(beside.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242, socket } }))).toMatchObject({ phase: "failed", error_code: "not_stopped" });
    expect(beside.commands).toContain("kill -TERM 5555 2>/dev/null || true");
    expect(beside.alive.has(5555)).toBe(false);
    expect(beside.alive.has(4242)).toBe(true);
    expect(beside.connects).toEqual([]);
  });

  it("stops the shown server when its birth still matches its registration", async () => {
    const pc = fixture({ descriptors: [{ ...descriptor(4242), birth: { platform: "linux", value: "1b4e28ba-2fa1-41d2-883f-0016d3cca427:100" } }], restoreOff: true });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.phase).toBe("connected");
    expect(pc.alive.has(4242)).toBe(false);
  });

  it("never copies or starts again the server it stopped while that setting is off (the default): it stays stopped, as before", async () => {
    for (const how of ["failed", "cancelled"] as const) {
      const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
      const pc = fixture({ descriptors: [descriptor(4242)], restoreOff: true,
        ...(how === "failed" ? { installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } } : { installerHeld: { started: () => started.resolve(), gate: gate.promise } }) });
      const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
      if (how === "cancelled") { await started.promise; pc.installer.cancel(job.id); gate.reject(new Error("Connection cancelled")); }
      const ended = await pc.settled(job);
      expect(ended.phase).toBe(how);
      expect(pc.commands.some((command) => command.includes("kill -TERM 4242"))).toBe(true);
      expect(pc.commands.some((command) => command.includes("ovis-restore."))).toBe(false);
      expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
      expect(pc.alive.has(4243)).toBe(false);
    }
  });

  it("starts the server it stopped again as it was when the installer then fails", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "installer_failed" });
    expect(job.error).toContain("has been started again as it was");
    const at = (pattern: RegExp) => pc.commands.findIndex((command) => pattern.test(command));
    expect(at(/ovis-restore\.XXXXXXXX/)).toBeLessThan(at(/kill -TERM 4242/));
    expect(at(/\[ -L "\$d\/exe" \]/)).toBeGreaterThan(at(/install\.sh -o/));
    expect(pc.alive.has(4243)).toBe(true);
  });

  it("starts nothing again once its replacement is installed, even before that one answers: its start may still be on its way", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], neverStarts: true });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await pc.reached("starting");
    pc.installer.cancel(job.id);
    const ended = await pc.settled(job);
    expect(ended.phase).toBe("cancelled");
    expect(ended.error).toContain("installed in its place");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    expect(pc.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(true);
  });

  it("waits for a server still stopping when the install is cancelled, then starts it again as it was, over a new connection", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], exitAfterChecks: 3 });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await pc.reached("stopping");
    pc.installer.cancel(job.id);
    const ended = await pc.settled(job);
    expect(ended.phase).toBe("cancelled");
    expect(ended.error).toBe("Cancelled. The Ovis started by hand on that PC was stopped for the install, and has been started again as it was.");
    expect(pc.alive.has(4243)).toBe(true);
  });

  it("removes the copy and starts nothing again once the new Ovis is installed", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)] });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.phase).toBe("connected");
    expect(pc.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(true);
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
  });

  it("starts nothing beside an Ovis that already came up in its place, and says when starting it again fails", async () => {
    const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const pc = fixture({ descriptors: [descriptor(4242)], installerHeld: { started: () => started.resolve(), gate: gate.promise } });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await started.promise;
    pc.registerNew();
    pc.installer.cancel(job.id);
    gate.reject(new Error("Connection cancelled"));
    const ended = await pc.settled(job);
    expect(ended.error).toContain("being installed in its place");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    const failing = fixture({ descriptors: [descriptor(4242)], restoreFails: true, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const failed = await failing.settled(failing.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(failed.error).toContain("starting it again as it was failed: it did not start within");
  });

  it("stops nothing when /proc is there but the server could not be copied first", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], captureFails: true });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "not_stopped", error: expect.stringContaining("could not be copied first") });
    expect(pc.commands.some((command) => command.includes("kill -TERM 4242"))).toBe(false);
  });

  it("starts nothing again, but removes the copy, when cancelled while the installer still ran there", async () => {
    const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const pc = fixture({ descriptors: [descriptor(4242)], installerHeld: { started: () => started.resolve(), gate: gate.promise } });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await started.promise;
    pc.installer.cancel(job.id);
    gate.reject(new Error("Connection cancelled"));
    const ended = await pc.settled(job);
    expect(ended.error).toContain("being installed in its place");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    expect(pc.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(true);
  });

  it("starts nothing again when cancelled while the server it signalled still runs, and removes the copy", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], killIgnored: true });
    const job = pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } });
    await pc.reached("stopping");
    pc.installer.cancel(job.id);
    const ended = await pc.settled(job);
    expect(ended.phase).toBe("cancelled");
    expect(ended.error ?? "").not.toContain("stopped");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    expect(pc.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(true);
  });

  it("replaces a server that can never be copied faithfully, as on macOS, and says it stays stopped when the install then fails", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], unfaithful: true, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "installer_failed" });
    expect(pc.commands.some((command) => command.includes("kill -TERM 4242"))).toBe(true);
    expect(job.error).toContain("none runs there now");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
  });

  it("starts nothing again when herdr was started headless for its plugin, or the installer itself failed: either may have started one", async () => {
    const headless = fixture({ descriptors: [descriptor(4242)], launcher: "plugin", herdrRunning: false, headlessFails: true });
    const one = await headless.settled(headless.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(one.phase).toBe("failed");
    expect(headless.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    const late = fixture({ descriptors: [descriptor(4242)], installer: { exit: 1, output: "Ovis: building failed" } });
    const two = await late.settled(late.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(two.phase).toBe("failed");
    expect(late.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
    expect(late.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(true);
  });

  it("copies and stops nothing once the planned pid belongs to another process: at the check, before the copy, or before the stop", async () => {
    for (const [after, copied] of [[1, false], [2, false], [3, true]] as const) {
      const pc = fixture({ descriptors: [descriptor(4242)], reusedAfterReads: after });
      const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
      expect([after, job.phase, job.error_code]).toEqual([after, "failed", "changed"]);
      // never signalled: the process at that pid is not the one shown
      expect(pc.alive.has(4242)).toBe(true);
      expect(pc.commands.some((command) => command.startsWith("rm -rf '/tmp/ovis-restore."))).toBe(copied);
    }
  });

  it("starts nothing beside any live server on the session's socket, a managed bridge on another port included", async () => {
    const pc = fixture({ descriptors: [descriptor(4242), descriptor(4300, true, "e".repeat(64))], installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.error).toContain("another already runs in its place");
    expect(pc.commands.some((command) => command.includes('[ -L "$d/exe" ]'))).toBe(false);
  });

  it("says another may have been installed when the installer fails after its download, the setting off", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], restoreOff: true, installer: { exit: 1, output: "Ovis: building failed" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "installer_failed" });
    expect(job.error).toContain("another may have been installed in its place");
  });

  it("starts nothing beside a live server that holds the address, and says so", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], addressTaken: true, installer: { exit: 1, output: "Ovis: could not download the installer of v9.9.9 from github.com" } });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "replace", pid: 4242 } }));
    expect(job.phase).toBe("failed");
    expect(job.error).toContain("another already runs in its place");
    expect(pc.alive.has(4243)).toBe(false);
  });

  it("starts herdr headless for an installed plugin when herdr is not running, instead of a plugin action that needs it", async () => {
    const pc = fixture({ launcher: "plugin", herdrRunning: false });
    const job = await pc.settled(pc.installer.start({ target }));
    expect(job.phase).toBe("connected");
    expect(pc.commands.some((command) => command.includes("herdr plugin action invoke"))).toBe(false);
    expect(pc.commands.some((command) => command.includes("nohup herdr server </dev/null"))).toBe(true);
  });

  it("connects nothing when the launcher's restart leaves the planned server running beside it", async () => {
    const pc = fixture({ descriptors: [descriptor(4242)], launcher: "plugin", besideLauncher: true });
    const job = await pc.settled(pc.installer.start({ target, machine_id: "pc-1", plan: { mode: "restart", pid: 4242 } }));
    expect(job).toMatchObject({ phase: "failed", error_code: "not_stopped" });
    expect(pc.connects).toEqual([]);
    expect(pc.alive.has(5555)).toBe(false);
    expect(pc.alive.has(4242)).toBe(true);
  });

  it("tells a connection dropped while it looks at the PC as one, not as an unsupported PC", async () => {
    const pc = fixture({ probeFails: true });
    expect(await pc.settled(pc.installer.start({ target }))).toMatchObject({ phase: "failed", error_code: "ssh_unreachable" });
  });

  it("follows the connect that updates it when the first one found it still older", async () => {
    const pc = fixture({});
    const gate = Promise.withResolvers<void>();
    pc.holdConnect(gate.promise);
    const handedOver = pc.reached("connecting_pc");
    const started = pc.installer.start({ target });
    await handedOver;
    expect(pc.installer.job(started.id)?.connect_job).toBe("setup-job");
    pc.followUps[0]!("update-job");
    expect(pc.installer.job(started.id)?.connect_job).toBe("update-job");
    gate.resolve();
    expect((await pc.settled(started)).phase).toBe("connected");
  });

  it("keeps the PC busy after a cancel until the install's own run has ended", async () => {
    const pc = fixture({});
    const gate = Promise.withResolvers<void>();
    pc.holdConnect(gate.promise);
    const handedOver = pc.reached("connecting_pc");
    const started = pc.installer.start({ target });
    await handedOver;
    pc.installer.cancel(started.id);
    expect(pc.installer.job(started.id)?.phase).toBe("cancelled");
    expect(pc.installer.runningAt(target)?.id).toBe(started.id);
    gate.resolve();
    await pc.settled(started);
    expect(pc.installer.runningAt(target)).toBeUndefined();
  });
});

// the installer's own command, run by a real shell in a session of its own (as sshd runs a command), its output read
// through a pipe as SSH reads it. Linux CI has setsid; elsewhere this is skipped
describe.skipIf(!Bun.which("setsid") || !Bun.which("curl"))("the installer's run on that PC", () => {
  const fakeInstaller = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-installer-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "install.sh");
    writeFileSync(path, "#!/bin/sh\n" + body.replaceAll("$DIR", dir));
    return { dir, url: "file://" + path };
  };

  it("tells the installer's exit status as its last line, and ends with it", async () => {
    const { url } = fakeInstaller("echo installing\nexit 3\n");
    const run = Bun.spawn(["setsid", "-w", "sh", "-c", installerRun("v0.5.1", url)], { stdout: "pipe", stderr: "ignore" });
    const lines = (await new Response(run.stdout).text()).split("\n").map((line) => line.trim()).filter(Boolean);
    expect(await run.exited).toBe(0);
    expect(lines).toEqual(["installing", "ovis-install-exit=3"]);
  });

  it("stops the installer once nobody reads its output any more, as when a cancel closes the SSH connection", async () => {
    const { dir, url } = fakeInstaller("echo started\nexec sleep 60 3>$DIR/held\n");
    expect(await Bun.spawn(["mkfifo", join(dir, "held")]).exited).toBe(0);
    const held = new Promise<void>((resolve) => createReadStream(join(dir, "held")).on("close", () => resolve()).resume());
    const run = Bun.spawn(["setsid", "-w", "sh", "-c", 'sh -c "$1" | { while IFS= read -r line; do [ "$line" = started ] && break; done; }', "ssh", installerRun("v0.5.1", url)], { stdout: "ignore", stderr: "ignore" });
    cleanups.push(() => run.kill());
    await held;
    await run.exited;
  }, 20_000);

  it("starts no installer once nobody reads, even when the connection closed while it was still downloading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-installer-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pipe = join(dir, "install.sh");
    expect(await Bun.spawn(["mkfifo", pipe]).exited).toBe(0);
    const download = createWriteStream(pipe).on("error", () => {});
    download.write("#!/bin/sh\necho ran > " + join(dir, "ran") + "\n");
    const run = Bun.spawn(["setsid", "-w", "sh", "-c", 'sh -c "$1" | { IFS= read -r line; }', "ssh", installerRun("v0.5.1", "file://" + pipe)], { stdout: "ignore", stderr: "ignore" });
    cleanups.push(() => run.kill());
    await run.exited;
    download.end();
    expect(existsSync(join(dir, "ran"))).toBe(false);
  }, 20_000);

  it("starts no installer when the connection closed just before the download ended, before the watcher writes again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-installer-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pipe = join(dir, "install.sh"), source = join(dir, "source.sh");
    writeFileSync(source, "#!/bin/sh\necho ran > " + join(dir, "ran") + "\n");
    expect(await Bun.spawn(["mkfifo", pipe]).exited).toBe(0);
    const run = Bun.spawn(["setsid", "-w", "sh", "-c", 'sh -c "$1" | { IFS= read -r line; exec 0<&-; cat "$2" > "$3"; }', "ssh", installerRun("v0.5.1", "file://" + pipe), source, pipe], { stdout: "ignore", stderr: "ignore" });
    cleanups.push(() => run.kill());
    await run.exited;
    expect(existsSync(join(dir, "ran"))).toBe(false);
  }, 20_000);
});

describe.skipIf(!existsSync("/proc/self/environ") || !Bun.which("setsid"))("starting a stopped server again as it was", () => {
  const shell = async (script: string, env: Record<string, string>) => {
    const run = Bun.spawn(["sh", "-c", script], { env: { PATH: process.env.PATH!, ...env }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);
    return out.trim();
  };

  it("copies a server's program, arguments, folder and environment before it is stopped, and starts it again exactly so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const home = join(dir, "home"), work = join(dir, "work\n"), mark = join(dir, "mark");
    mkdirSync(home); mkdirSync(work); mkdirSync(join(dir, "x=y"));
    let bun = join(dir, "x=y", "bun");
    try { linkSync(process.execPath, bun); } catch { bun = process.execPath; }
    const env: Record<string, string> = { PATH: process.env.PATH!, HOME: home, OVIS_TOKEN: "tok'en with space", MARK: mark, PORT: String(await freePort()) };
    for (let i = 0; i < 60; i++) env[`OVIS_PAD_${i}`] = "x".repeat(4000);
    const server = Bun.spawn([bun, "-e", 'require("node:fs").writeFileSync(process.env.MARK, [process.pid, process.env.OVIS_TOKEN, process.cwd()].join("|")); console.log("up"); setInterval(() => {}, 1000);', "--flag=value"], { cwd: work, env, stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => server.kill());
    await server.stdout.getReader().read();
    const before = { environ: readFileSync(join("/proc", String(server.pid), "environ")), cmdline: readFileSync(join("/proc", String(server.pid), "cmdline")) };
    const saved = await shell(captureServer(server.pid, await shell(processIdentity(server.pid), {})), { HOME: home, TMPDIR: dir });
    expect(saved).toMatch(SAVED_SERVER);
    expect(statSync(saved).mode & 0o777).toBe(0o700);
    server.kill();
    await server.exited;
    rmSync(mark);
    expect(await Bun.spawn(["mkfifo", mark]).exited).toBe(0);
    const told = new Promise<string>((resolve) => { let said = ""; createReadStream(mark).on("data", (chunk) => { said += chunk; }).on("close", () => resolve(said)); });
    const pid = (await shell(restoreServer(saved), { HOME: home, XDG_STATE_HOME: join(dir, "state") })).split(" ")[0]!;
    cleanups.push(() => { try { process.kill(Number(pid)); } catch { /* gone already */ } });
    const [toldPid, token, where] = (await told).split("|");
    expect(toldPid).toBe(pid);
    expect(token).toBe("tok'en with space");
    expect(where).toBe(realpathSync(work));
    // exactly its environment and arguments, nothing of the SSH session's; the copy holding its token is gone; its log
    // is this account's alone
    expect(readFileSync(join("/proc", pid, "environ"))).toEqual(before.environ);
    expect(readFileSync(join("/proc", pid, "cmdline"))).toEqual(before.cmdline);
    expect(existsSync(saved)).toBe(false);
    expect(statSync(join(dir, "state", "ovis", "restored-server.log")).mode & 0o077).toBe(0);
  });

  it("says no faithful copy can be made where its environment cannot be read, its program is deleted, or a byte would not survive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(await shell(captureServer(2 ** 22 + 1, "Sun Nov  8 08:00:00 2026 1000"), { TMPDIR: dir })).toBe("changed");
    const serve = async (command: string[]) => {
      const server = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
      cleanups.push(() => server.kill());
      await server.stdout.getReader().read();
      return server;
    };
    const up = 'console.log("up"); setInterval(() => {}, 1000);';
    // an environment value that is not UTF-8: JavaScript would change it
    const latin = await serve(["sh", "-c", `exec env OVIS_ODD="$(printf '\\377')" "${process.execPath}" -e '${up}'`]);
    expect(await shell(captureServer(latin.pid, "another process"), { TMPDIR: dir })).toBe("changed");
    expect(await shell(captureServer(latin.pid, await shell(processIdentity(latin.pid), {})), { TMPDIR: dir })).toBe("unfaithful");
    const program = join(dir, "bun-copy");
    // a copy of Bun (a hard link may cross filesystems): the case always runs
    copyFileSync(process.execPath, program); chmodSync(program, 0o755);
    const orphan = await serve([program, "-e", up]);
    rmSync(program);
    expect(await shell(captureServer(orphan.pid, await shell(processIdentity(orphan.pid), {})), { TMPDIR: dir })).toBe("unfaithful");
    const gone = join(dir, "gone");
    mkdirSync(gone);
    const homeless = Bun.spawn([process.execPath, "-e", up], { cwd: gone, stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => homeless.kill());
    await homeless.stdout.getReader().read();
    rmSync(gone, { recursive: true });
    expect(await shell(captureServer(homeless.pid, await shell(processIdentity(homeless.pid), {})), { TMPDIR: dir })).toBe("unfaithful");
    expect(readdirSync(dir).filter((name) => name.startsWith("ovis-restore."))).toEqual([]);
  });

  it("starts nothing when its address is taken by a live server, and keeps its log this account's alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const home = join(dir, "home"), state = join(dir, "state"), mark = join(dir, "mark");
    mkdirSync(home);
    const port = await freePort();
    const copy = async () => {
      const server = Bun.spawn([process.execPath, "-e", 'require("node:fs").appendFileSync(process.env.MARK, "x"); console.log("up"); setInterval(() => {}, 1000);'], { cwd: dir, env: { PATH: process.env.PATH!, HOME: home, MARK: mark, PORT: String(port) }, stdout: "pipe", stderr: "ignore" });
      cleanups.push(() => server.kill());
      await server.stdout.getReader().read();
      const saved = await shell(captureServer(server.pid, await shell(processIdentity(server.pid), {})), { HOME: home, TMPDIR: dir });
      server.kill(); await server.exited;
      return saved;
    };
    const taken = await copy();
    const replacement = listenOn(() => {});
    await new Promise<void>((resolve) => replacement.listen(port, "127.0.0.1", () => resolve()));
    try { expect(await shell(restoreServer(taken), { HOME: home, XDG_STATE_HOME: state })).toBe("taken"); }
    finally { replacement.close(); }
    expect(existsSync(taken)).toBe(false);
    expect(readFileSync(mark, "utf8")).toBe("x");
    // a log anybody could read is made this account's alone; a link in its place is never followed
    mkdirSync(join(state, "ovis"), { recursive: true });
    writeFileSync(join(state, "ovis", "restored-server.log"), "", { mode: 0o644 });
    const pid = (await shell(restoreServer(await copy()), { HOME: home, XDG_STATE_HOME: state })).split(" ")[0]!;
    cleanups.push(() => { try { process.kill(Number(pid)); } catch { /* gone already */ } });
    expect(statSync(join(state, "ovis", "restored-server.log")).mode & 0o777).toBe(0o600);
    process.kill(Number(pid));
    rmSync(join(state, "ovis", "restored-server.log"));
    symlinkSync(join(dir, "elsewhere"), join(state, "ovis", "restored-server.log"));
    const linked = Bun.spawn(["sh", "-c", restoreServer(await copy())], { env: { PATH: process.env.PATH!, HOME: home, XDG_STATE_HOME: state }, stdout: "pipe", stderr: "ignore" });
    expect(await linked.exited).not.toBe(0);
    expect(existsSync(join(dir, "elsewhere"))).toBe(false);
  });

  it("tells a process by its start in clock ticks and its owner, and leaves no copy when nobody reads its path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const server = Bun.spawn([process.execPath, "-e", 'console.log("up"); setInterval(() => {}, 1000);'], { stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => server.kill());
    await server.stdout.getReader().read();
    const stat = readFileSync(join("/proc", String(server.pid), "stat"), "utf8");
    const ticks = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
    const identity = await shell(processIdentity(server.pid), {});
    expect(identity).toBe(`${ticks} ${process.getuid!()}`);
    const lost = Bun.spawn(["sh", "-c", 'sh -c "$1" | true', "ssh", captureServer(server.pid, identity)], { env: { PATH: process.env.PATH!, TMPDIR: dir }, stdout: "ignore", stderr: "ignore" });
    await lost.exited;
    expect(readdirSync(dir).filter((name) => name.startsWith("ovis-restore."))).toEqual([]);
  });

  it("fails the restore, never says taken, when its address cannot be used at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // an address this PC does not have (TEST-NET-1)
    const server = Bun.spawn([process.execPath, "-e", 'console.log("up"); setInterval(() => {}, 1000);'], { cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, HOST: "192.0.2.1", PORT: String(await freePort()) }, stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => server.kill());
    await server.stdout.getReader().read();
    const saved = await shell(captureServer(server.pid, await shell(processIdentity(server.pid), {})), { HOME: dir, TMPDIR: dir });
    server.kill(); await server.exited;
    const run = Bun.spawn(["sh", "-c", restoreServer(saved)], { env: { PATH: process.env.PATH!, HOME: dir, XDG_STATE_HOME: join(dir, "state") }, stdout: "pipe", stderr: "pipe" });
    const [said, why, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    expect([said.trim(), code]).toEqual(["", 1]);
    expect(why).toContain("cannot be used");
    expect(existsSync(saved)).toBe(false);
  });

  it("tells a process's birth as server/process-owner.ts records it, and another birth from it", async () => {
    const server = Bun.spawn([process.execPath, "-e", 'console.log("up"); setInterval(() => {}, 1000);'], { stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => server.kill());
    await server.stdout.getReader().read();
    const reading = readProcessBirth(server.pid);
    if (reading.state !== "identified") throw new Error("no birth here");
    expect(await shell(`${bornAs(server.pid, reading.birth)} && echo born || true`, {})).toBe("born");
    expect(await shell(`${bornAs(server.pid, { ...reading.birth, value: reading.birth.value + "0" })} && echo born || true`, {})).toBe("");
  });

  it("tells a process that started before its birth-less registration was written from one that started after it", async () => {
    const home = mkdtempSync(join(tmpdir(), "ovis-registry-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const bridges = join(home, ".config", "herdr-web-ui", "bridges");
    mkdirSync(bridges, { recursive: true });
    const server = Bun.spawn([process.execPath, "-e", 'console.log("up"); setInterval(() => {}, 1000);'], { stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => server.kill());
    await server.stdout.getReader().read();
    const token = "c".repeat(64), socket = "/home/fx/.config/herdr/herdr.sock", file = join(bridges, createHash("sha256").update(socket).digest("hex") + ".json");
    const check = () => shell(`${registeredAs(server.pid, { socket_path: socket })} && echo before || true`, { HOME: home });
    writeFileSync(file, JSON.stringify({ pid: server.pid, token }));
    expect(await check()).toBe("before");
    writeFileSync(file, JSON.stringify({ pid: Number(`${server.pid}0`), token }));
    expect(await check()).toBe("");
    writeFileSync(file, JSON.stringify({ pid: server.pid, token }));
    const past = new Date(Date.now() - 600_000);
    utimesSync(file, past, past);
    expect(await check()).toBe("");
    utimesSync(file, new Date(), new Date());
    expect(await check()).toBe("before");
    expect(await shell(`${registeredAs(server.pid, { socket_path: socket, birth: { platform: "linux", value: 7 } })} && echo before || true`, { HOME: home })).toBe("");
    rmSync(file);
    expect(await check()).toBe("");
  });

  it("probes its own PORT, not its registration's port, for a server bound to another address than loopback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const port = await freePort();
    const relay = listenOn(() => {});
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => { relay.close(); });
    const registered = (relay.address() as { port: number }).port;
    const server = Bun.spawn([process.execPath, "-e", 'console.log("up"); setInterval(() => {}, 1000);'], { cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, HOST: "0.0.0.0", PORT: String(port) }, stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => server.kill());
    await server.stdout.getReader().read();
    const saved = await shell(captureServer(server.pid, await shell(processIdentity(server.pid), {})), { HOME: dir, TMPDIR: dir });
    server.kill(); await server.exited;
    const said = await shell(restoreServer(saved, registered), { HOME: dir, XDG_STATE_HOME: join(dir, "state") });
    const [pid, birth] = said.split(" ");
    cleanups.push(() => { try { process.kill(Number(pid)); } catch { /* gone already */ } });
    expect(said).not.toBe("taken");
    expect(Number(pid)).toBeGreaterThan(0);
    const reading = readProcessBirth(Number(pid));
    expect(reading.state === "identified" ? reading.birth.value : null).toBe(birth!);
  });

  it("reads a process's birth now only on the platform it was recorded on, as server/process-owner.ts records it", async () => {
    const reading = readProcessBirth(process.pid);
    if (reading.state !== "identified") throw new Error("no birth here");
    expect(await shell(birthNow(process.pid, "linux"), {})).toBe(reading.birth.value);
    // a macOS birth is never read on Linux (ps's start time there would differ from it, and prove nothing)
    expect(await shell(birthNow(process.pid, "darwin"), {})).toBe("");
    expect(await shell(birthNow(2 ** 22 + 1, "linux"), {})).toBe("");
  });

  it("takes a process as ended only on evidence: gone, or a zombie; a ps that cannot say leaves it running", async () => {
    const live = await shell(`${runs(process.pid)} && echo runs || echo ended`, {});
    expect(live).toBe("runs");
    expect(await shell(`${runs(2 ** 22 + 1)} && echo runs || echo ended`, {})).toBe("ended");
    const zombie = Bun.spawn(["sh", "-c", "sleep 0.05 & exec sleep 30"], { stdout: "ignore" });
    cleanups.push(() => zombie.kill());
    const child = Number((await shell(`for i in $(seq 1 100); do c=$(pgrep -P ${zombie.pid} sleep | head -n 1); case "$(ps -o stat= -p "$c" 2>/dev/null)" in *Z*) echo $c; exit 0;; esac; sleep 0.05; done; echo 0`, {})).trim());
    if (child > 0) expect(await shell(`${runs(child)} && echo runs || echo ended`, {})).toBe("ended");
    // a ps that fails (BusyBox without -o) never makes a running process look ended
    const dir = mkdtempSync(join(tmpdir(), "ovis-ps-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await shell(`${runs(process.pid)} && echo runs || echo ended`, { PATH: `${dir}:${process.env.PATH}` })).toBe("runs");
  });
});
