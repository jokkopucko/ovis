/**
 * Proof from the PC's own screen (device-row-states rows P11, P20, P22, R8, R10, N4, N6, N7, Q20, and T46/T47 for the
 * proof): one named act, confirmed on one of two screens of this PC, used up once. No test sleeps: the clock is
 * moved by hand and every wait is for the answer its line names.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, openSync, closeSync, fstatSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bounded } from "../relay/test-helpers.ts";
import {
  CONFIRM_MS, LOCAL_CONFIRM_FILE, LocalConfirms, desktopOwnerChannel, dropDesktopOwnerFd, peerUidInTable, openConfirmListener, openOnDesktop, peerUidOnLinux, takeDesktopOwnerFd, unknownServeArgument,
  type ScreenAction,
} from "./local-confirm.ts";

const ends: (() => void)[] = [];
afterEach(() => { for (const end of ends.splice(0)) end(); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-confirm-"));
  ends.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function clocked() {
  let now = 1_000_000;
  const confirms = new LocalConfirms({ now: () => now });
  return { confirms, advance: (ms: number) => { now += ms; } };
}

/** The desktop app's end of the desktop-owner channel: what it was told, and a way to answer. */
function desktop(confirms: LocalConfirms) {
  const told: unknown[] = [];
  let push!: (line: string) => void;
  const input = new ReadableStream<Uint8Array>({ start(controller) { push = (line) => controller.enqueue(new TextEncoder().encode(line)); } });
  const channel = desktopOwnerChannel(confirms, { input, write: (line) => { told.push(JSON.parse(line)); } });
  ends.push(() => channel.stop());
  return { told, send: (message: unknown) => push(`${typeof message === "string" ? message : JSON.stringify(message)}\n`) };
}

const LOCK: ScreenAction = { kind: "lock" };

test("T46: a screen confirmation binds one named lock action and is consumed once", async () => {
  const { confirms } = clocked();
  const screen = desktop(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  screen.send({ approve: id });
  expect(await bounded(confirms.answer(id))).toBe("approved");
  expect(confirms.consume(id, { kind: "unlock", lock: "l1" })).toBe(false);
  expect(confirms.consume(id, LOCK)).toBe(true);
  expect(confirms.consume(id, LOCK)).toBe(false);
});

test("T46: a confirmation of one key approves no other key", async () => {
  const { confirms } = clocked();
  const screen = desktop(confirms);
  const action: ScreenAction = { kind: "approve_key", pending: "p1", fingerprint: "AAAA-BBBB" };
  const { id } = confirms.request(action, { title: "Approve this device", lines: ["Phone"], fingerprint: "AAAA-BBBB" });
  screen.send({ approve: id });
  expect(await bounded(confirms.answer(id))).toBe("approved");
  expect(confirms.consume(id, { ...action, fingerprint: "AAAA-CCCC" })).toBe(false);
  expect(confirms.consume(id, { ...action, pending: "p2" })).toBe(false);
  expect(confirms.consume(id, action)).toBe(true);
});

test("T46: an act is held as it was asked for, whatever its asker changes afterwards", async () => {
  const { confirms } = clocked();
  const screen = desktop(confirms);
  const action = { kind: "approve_key" as const, pending: "p1", fingerprint: "AAAA-BBBB" };
  const shown = { title: "Approve this device", lines: ["Phone"] };
  const { id } = confirms.request(action, shown);
  action.fingerprint = "CCCC-DDDD";
  shown.lines.push("changed");
  expect(confirms.pending()[0]!.shown.lines).toEqual(["Phone"]);
  screen.send({ approve: id });
  expect(await bounded(confirms.answer(id))).toBe("approved");
  expect(confirms.consume(id, action)).toBe(false);
  expect(confirms.consume(id, { kind: "approve_key", pending: "p1", fingerprint: "AAAA-BBBB" })).toBe(true);
});

test("T46: an act that admits a key shows that key's fingerprint, whatever the asker passed to show", () => {
  const { confirms } = clocked();
  confirms.request({ kind: "approve_key", pending: "p1", fingerprint: "AAAA-BBBB" }, { title: "Approve this device", lines: [], fingerprint: "EEEE-FFFF" });
  confirms.request({ kind: "approve_replacement", row: "r1", fingerprint: "1111-2222" }, { title: "Replace this key", lines: [] });
  expect(confirms.pending().map((open) => open.shown.fingerprint)).toEqual(["AAAA-BBBB", "1111-2222"]);
});

test("T46: a confirmation expires unused and is then neither approved nor consumed", async () => {
  const { confirms, advance } = clocked();
  const screen = desktop(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  advance(CONFIRM_MS + 1);
  expect(confirms.pending().map((open) => open.id)).not.toContain(id);
  screen.send({ approve: id });
  const later = confirms.request({ kind: "leave_account" }, { title: "Leave the account", lines: [] });
  screen.send({ approve: later.id });
  // the channel answers in order: the later act's approval came after the expired one's
  expect(await bounded(confirms.answer(later.id))).toBe("approved");
  expect(confirms.consume(id, LOCK)).toBe(false);
});

test("T46: an approval used after its confirm expired authorizes nothing", async () => {
  const { confirms, advance } = clocked();
  const screen = desktop(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  screen.send({ approve: id });
  expect(await bounded(confirms.answer(id))).toBe("approved");
  advance(CONFIRM_MS + 1);
  expect(confirms.consume(id, LOCK)).toBe(false);
});

test("T46: an unanswered or declined confirmation authorizes nothing", async () => {
  const { confirms } = clocked();
  const screen = desktop(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  expect(confirms.consume(id, LOCK)).toBe(false);
  screen.send({ decline: id });
  expect(await bounded(confirms.answer(id))).toBe("declined");
  expect(confirms.consume(id, LOCK)).toBe(false);
});

test("R8: the desktop-owner channel is told every open act and answers only an open one by its id", async () => {
  const { confirms } = clocked();
  const screen = desktop(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: ["2 devices will be signed out"] });
  expect(screen.told.at(-1)).toEqual({ pending: [{ id, action: LOCK, shown: { title: "Lock this PC", lines: ["2 devices will be signed out"] } }] });
  screen.send("not json");
  screen.send({ approve: "no-such-id" });
  screen.send({ approve: [id] });
  const other = confirms.request({ kind: "leave_account" }, { title: "Leave the account", lines: [] });
  screen.send({ approve: other.id });
  expect(await bounded(confirms.answer(other.id))).toBe("approved");
  expect(confirms.pending().map((open) => open.id)).toEqual([id]);
});

/** A confirm listener whose peer is always this PC's user, unless a test says otherwise. */
function listener(confirms: LocalConfirms, peerUid: (port: number, peer: number) => number | null = () => process.getuid!()) {
  const dir = stateDir();
  const opened = openConfirmListener(confirms, { stateDir: dir, platform: "linux", peerUid });
  if (opened === null) throw new Error("The confirm listener did not open");
  ends.push(() => opened.stop());
  const origin = `http://127.0.0.1:${opened.port}`;
  return { ...opened, dir, origin };
}

async function page(origin: string, id: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}/confirm/${id}`, { headers });
  const html = await response.text();
  return { response, html, nonce: /name="nonce" value="([^"]+)"/.exec(html)?.[1] };
}

function answer(origin: string, id: string, form: Record<string, string>, headers: Record<string, string> = { origin }) {
  return fetch(`${origin}/confirm/${id}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form) });
}

const linux = process.platform === "linux";

test.if(linux)("R8: the local confirm listener approves an act from its own page, which names the act and the key's fingerprint", async () => {
  const { confirms } = clocked();
  const { origin } = listener(confirms);
  const action: ScreenAction = { kind: "approve_key", pending: "p1", fingerprint: "AAAA-BBBB" };
  const { id } = confirms.request(action, { title: "Approve this device", lines: ["Phone"] });
  const shown = await page(origin, id);
  expect(shown.response.status).toBe(200);
  expect(shown.html).toContain("Approve this device");
  expect(shown.html).toContain("AAAA-BBBB");
  expect((await answer(origin, id, { nonce: shown.nonce!, answer: "approve" })).status).toBe(200);
  expect(await bounded(confirms.answer(id))).toBe("approved");
  expect(confirms.consume(id, action)).toBe(true);
});

test.if(linux)("Q20: a page's nonce is used up by one answer", async () => {
  const { confirms } = clocked();
  const { origin } = listener(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  const shown = await page(origin, id);
  expect((await answer(origin, id, { nonce: shown.nonce!, answer: "decline" })).status).toBe(200);
  expect(await bounded(confirms.answer(id))).toBe("declined");
  expect((await answer(origin, id, { nonce: shown.nonce!, answer: "approve" })).status).toBe(403);
  expect(confirms.consume(id, LOCK)).toBe(false);
});

test.if(linux)("Q20: a nonce minted for one confirm answers no other", async () => {
  const { confirms } = clocked();
  const { origin } = listener(confirms);
  const first = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  const second = confirms.request({ kind: "leave_account" }, { title: "Leave the account", lines: [] });
  const shown = await page(origin, first.id);
  expect((await answer(origin, second.id, { nonce: shown.nonce!, answer: "approve" })).status).toBe(403);
  expect(confirms.pending().map((open) => open.id).sort()).toEqual([first.id, second.id].sort());
});

test.if(linux)("Q20: opening a confirm's page again ends the nonce its earlier page was given", async () => {
  const { confirms } = clocked();
  const { origin } = listener(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  const earlier = await page(origin, id);
  const later = await page(origin, id);
  expect((await answer(origin, id, { nonce: earlier.nonce!, answer: "approve" })).status).toBe(403);
  expect((await answer(origin, id, { nonce: later.nonce!, answer: "approve" })).status).toBe(200);
});

test.if(linux)("Q20: a nonce expires with its confirm", async () => {
  const { confirms, advance } = clocked();
  const { origin } = listener(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  const shown = await page(origin, id);
  advance(CONFIRM_MS + 1);
  expect((await answer(origin, id, { nonce: shown.nonce!, answer: "approve" })).status).toBe(403);
  expect(confirms.consume(id, LOCK)).toBe(false);
});

test.if(linux)("Q20: the listener refuses a request that came through a proxy", async () => {
  const { confirms } = clocked();
  const { origin } = listener(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  for (const header of ["x-forwarded-for", "forwarded", "via", "x-real-ip", "tailscale-user-login", "cf-connecting-ip"]) {
    expect((await page(origin, id, { [header]: "100.64.0.9" })).response.status).toBe(403);
  }
  const shown = await page(origin, id);
  expect((await answer(origin, id, { nonce: shown.nonce!, answer: "approve" }, { origin, "x-forwarded-for": "100.64.0.9" })).status).toBe(403);
  expect(confirms.pending().map((open) => open.id)).toEqual([id]);
});

test.if(linux)("Q20: the listener refuses a Host that is a name or another address", async () => {
  const { confirms } = clocked();
  const { origin, port } = listener(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  for (const host of [`localhost:${port}`, `rebound.example:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`]) {
    expect((await page(origin, id, { host })).response.status).toBe(403);
  }
});

test.if(linux)("Q20: an answer must come from the listener's own page origin", async () => {
  const { confirms } = clocked();
  const { origin, port } = listener(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  for (const headers of [{} as Record<string, string>, { origin: "http://evil.example" }, { origin: `http://localhost:${port}` }, { origin: "null" }]) {
    const shown = await page(origin, id);
    expect((await answer(origin, id, { nonce: shown.nonce!, answer: "approve" }, headers)).status).toBe(403);
  }
  expect(confirms.pending().map((open) => open.id)).toEqual([id]);
});

test.if(linux)("Q20: the listener refuses a peer of another user, and one whose user it cannot tell", async () => {
  const { confirms } = clocked();
  const own = process.getuid!();
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  for (const uid of [own + 1, null]) {
    const { origin } = listener(confirms, () => uid);
    expect((await page(origin, id)).response.status).toBe(403);
  }
});

test.if(linux)("Q20: the listener sends no CORS header and cannot be framed", async () => {
  const { confirms } = clocked();
  const { origin } = listener(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  const preflight = await fetch(`${origin}/confirm/${id}`, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
  const shown = await page(origin, id);
  for (const response of [preflight, shown.response]) {
    expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
  }
  expect(shown.response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(shown.response.headers.get("x-frame-options")).toBe("DENY");
});

test.if(linux)("Q20: the listener's port is written only to a file of this user in the state folder", () => {
  const { confirms } = clocked();
  const { dir, port, stop } = listener(confirms);
  const path = join(dir, LOCAL_CONFIRM_FILE);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ port });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  stop();
  expect(existsSync(path)).toBe(false);
});

test("Q20: no listener opens where the system cannot name the peer's user", () => {
  const { confirms } = clocked();
  for (const platform of ["darwin", "win32"] as const) {
    const dir = stateDir();
    expect(openConfirmListener(confirms, { stateDir: dir, platform })).toBeNull();
    expect(existsSync(join(dir, LOCAL_CONFIRM_FILE))).toBe(false);
  }
});

test.if(linux)("Q20: on Linux the peer's user is read from the kernel's socket table", async () => {
  let seen: number | null | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, bun) {
    seen = peerUidOnLinux(server.port!, bun.requestIP(request)!.port);
    return new Response("ok");
  } });
  ends.push(() => server.stop(true));
  await fetch(`http://127.0.0.1:${server.port}/`);
  expect(seen).toBe(process.getuid!());
  expect(peerUidOnLinux(server.port!, 1)).toBeNull();
});

test.if(linux)("N6: the desktop-owner descriptor and its argument reach no child", async () => {
  const script = join(import.meta.dir, "local-confirm.child.fixture.ts");
  const parent = `const { spawn } = require("node:child_process");
    const c = spawn(process.execPath, [${JSON.stringify(script)}], { stdio: ["ignore", "pipe", "inherit", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => { out += d; }); c.on("exit", () => { process.stdout.write(out); process.exit(0); });`;
  const run = Bun.spawn([process.execPath, "-e", parent], { stdout: "pipe", stderr: "inherit" });
  const report = JSON.parse(await bounded(new Response(run.stdout).text())) as { channel: string; taken: boolean; argv: string[]; inherited: boolean };
  expect(report.channel).toStartWith("socket:");
  expect(report.taken).toBe(true);
  expect(report.argv).toEqual(["ovis-server"]);
  expect(report.inherited).toBe(false);
});

test("N6: a descriptor that is not a pipe or a socket gives no channel", () => {
  const dir = stateDir();
  const fd = openSync(join(dir, "plain"), "w");
  ends.push(() => closeSync(fd));
  for (const argv of [["serve", "--desktop-owner-fd", String(fd)], ["serve", `--desktop-owner-fd=${fd}`], ["serve", "--desktop-owner-fd", "1"],
    ["serve", "--desktop-owner-fd"], ["serve", "--desktop-owner-fd=x"], ["serve", "--desktop-owner-fd=1e3"], ["serve", "--desktop-owner-fd=99999"]]) {
    expect(takeDesktopOwnerFd(argv)).toBeNull();
    expect(argv).toEqual(["serve"]);
  }
});

test("N6: serve takes the desktop owner argument and no other", () => {
  for (const args of [[], ["--desktop-owner-fd", "5"], ["--desktop-owner-fd=5"], ["--desktop-owner-fd"], ["--desktop-owner-fd=x"]]) {
    expect(unknownServeArgument(args)).toBeUndefined();
  }
  expect(unknownServeArgument(["--port", "8080"])).toBe("--port");
  expect(unknownServeArgument(["8080"])).toBe("8080");
  expect(unknownServeArgument(["--desktop-owner-fd", "5", "extra"])).toBe("extra");
});

test.if(linux)("N6: a process that is not the server drops the argument and closes only a socket it names", async () => {
  const dir = stateDir();
  const fd = openSync(join(dir, "plain"), "w");
  ends.push(() => closeSync(fd));
  const argv = ["supervisor", "--desktop-owner-fd", String(fd), "--other"];
  dropDesktopOwnerFd(argv);
  expect(argv).toEqual(["supervisor", "--other"]);
  expect(fstatSync(fd).isFile()).toBe(true);
  const script = `const { dropDesktopOwnerFd } = await import(${JSON.stringify(join(import.meta.dir, "local-confirm.ts"))});
    const { fstatSync } = await import("node:fs");
    dropDesktopOwnerFd(["supervisor", "--desktop-owner-fd", "3"]);
    let open = true; try { fstatSync(3); } catch { open = false; }
    process.stdout.write(JSON.stringify({ open }));`;
  const parent = `const { spawn } = require("node:child_process");
    const c = spawn(process.execPath, ["-e", ${JSON.stringify(script)}], { stdio: ["ignore", "pipe", "inherit", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => { out += d; }); c.on("exit", () => { process.stdout.write(out); process.exit(0); });`;
  const run = Bun.spawn([process.execPath, "-e", parent], { stdout: "pipe", stderr: "inherit" });
  expect(JSON.parse(await bounded(new Response(run.stdout).text()))).toEqual({ open: false });
});

test.if(linux)("Q20: a page's nonce is used up even by an answer that was refused", async () => {
  const { confirms } = clocked();
  const { origin } = listener(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  const shown = await page(origin, id);
  expect((await answer(origin, id, { nonce: shown.nonce!, answer: "maybe" })).status).toBe(403);
  expect((await answer(origin, id, { nonce: shown.nonce!, answer: "approve" })).status).toBe(403);
  expect(confirms.pending().map((open) => open.id)).toEqual([id]);
});

test("N6: a channel that fails ends loudly and answers nothing more", async () => {
  const { confirms } = clocked();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { logged.push(parts.join(" ")); };
  try {
    let fail = false;
    const input = new ReadableStream<Uint8Array>({ start() {} });
    desktopOwnerChannel(confirms, { input, write: () => { if (fail) throw new Error("EPIPE"); } });
    fail = true;
    confirms.request(LOCK, { title: "Lock this PC", lines: [] });
    expect(logged.join("\n")).toContain("EPIPE");
  } finally { console.error = original; }
});

const TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const tcpRow = (local: string, remote: string, uid: number, state = "01") => `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 1`;

test("Q20: the peer's user is the one of the exact connection, not of another loopback address on the same ports", () => {
  const listener = 0x9c40;
  const peer = 0xa000;
  const table = [TCP_HEADER,
    tcpRow(`0200007F:${peer.toString(16).toUpperCase()}`, `0100007F:${listener.toString(16).toUpperCase()}`, 2000),
    tcpRow(`0100007F:${peer.toString(16).toUpperCase()}`, `0100007F:${listener.toString(16).toUpperCase()}`, 1000)].join("\n");
  expect(peerUidInTable(table, listener, peer)).toBe(1000);
  expect(peerUidInTable([TCP_HEADER, tcpRow(`0200007F:${peer.toString(16).toUpperCase()}`, `0100007F:${listener.toString(16).toUpperCase()}`, 2000)].join("\n"), listener, peer)).toBeNull();
});

test.if(linux)("Q20: the confirm page lets a browser's own form send its origin", async () => {
  const { confirms } = clocked();
  const { origin } = listener(confirms);
  const { id } = confirms.request(LOCK, { title: "Lock this PC", lines: [] });
  expect((await page(origin, id)).response.headers.get("referrer-policy")).toBe("same-origin");
});

test("N6: a switch with no number after it leaves the next argument alone", () => {
  const argv = ["serve", "--desktop-owner-fd", "--other"];
  expect(takeDesktopOwnerFd(argv)).toBeNull();
  expect(argv).toEqual(["serve", "--other"]);
});

test("Q20: only an established connection names the peer, and two exact rows name nobody", () => {
  const hex = (port: number) => port.toString(16).toUpperCase();
  const local = `0100007F:${hex(0xa000)}`;
  const remote = `0100007F:${hex(0x9c40)}`;
  expect(peerUidInTable([TCP_HEADER, tcpRow(local, remote, 2000, "06"), tcpRow(local, remote, 1000)].join("\n"), 0x9c40, 0xa000)).toBe(1000);
  expect(peerUidInTable([TCP_HEADER, tcpRow(local, remote, 1000, "06")].join("\n"), 0x9c40, 0xa000)).toBeNull();
  expect(peerUidInTable([TCP_HEADER, tcpRow(local, remote, 1000), tcpRow(local, remote, 2000)].join("\n"), 0x9c40, 0xa000)).toBeNull();
});

test("Q20: a read of the socket table that missed the live row, or showed it twice, is read again, a bounded number of times; rows naming two users are final", () => {
  const hex = (port: number) => port.toString(16).toUpperCase();
  const row = tcpRow(`0100007F:${hex(0xa000)}`, `0100007F:${hex(0x9c40)}`, 1000);
  const other = tcpRow(`0100007F:${hex(0xa000)}`, `0100007F:${hex(0x9c40)}`, 1001);
  const reads = (tables: string[][]) => {
    let count = 0;
    const uid = peerUidOnLinux(0x9c40, 0xa000, () => [TCP_HEADER, ...(tables[count++] ?? [])].join("\n"));
    return { uid, count };
  };
  expect(reads([[], [row, row], [row]])).toEqual({ uid: 1000, count: 3 });
  expect(reads([[], [], [], [row]])).toEqual({ uid: null, count: 3 });
  expect(reads([[other]])).toEqual({ uid: 1001, count: 1 });
  expect(reads([[row, other], [row]])).toEqual({ uid: null, count: 1 });
});

test("R8: the confirm page counts as opened only once xdg-open started; a desktop without it is told so", async () => {
  const bin = stateDir();
  const env = { DISPLAY: ":0", PATH: bin };
  expect(await bounded(openOnDesktop("http://127.0.0.1:1/", env, "linux"))).toBe(false);
  writeFileSync(join(bin, "xdg-open"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "xdg-open"), 0o755);
  expect(await bounded(openOnDesktop("http://127.0.0.1:1/", env, "linux"))).toBe(true);
  expect(await openOnDesktop("http://127.0.0.1:1/", {}, "linux")).toBe(false);
});
