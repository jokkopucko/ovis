import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PortalStatus } from "../shared/protocol.ts";
import { NO_PORTAL_AUTH, PORTAL_AUTH_PROBLEMS, type PortalAuth } from "../shared/portal.ts";
import { atLeast, authArgs, handlePortalRequest, PortalService, proofMatches, readyUrl, relayOrigin, shortReadyUrl } from "./portal.ts";

/**
 * The service runs a stand-in portal here, a shell script, and asks a relay through an injected
 * fetch: no test reaches a real relay.
 */
const root = mkdtempSync(join(tmpdir(), "herdr-portal-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ADDRESS = "https://herdr-test-0123456789abcdef0123456789abcdef01234567.relay.example";
const RELAY = "https://relay.example";
/** the short host Portal also serves for a `--name` (`<name>.<relay>`), printed on the same ready line */
const SHORT = "https://herdr-test.relay.example";
const open = { tokenSet: true, serveOnly: false };

/** The flags a `portal expose --help` lists, in Go's layout: `-auth string`, with its words on the next line. */
const PROOF_FLAG = "auth-identity-proof string";
const SIGN_IN_FLAGS = ["auth string", "auth-allow value", "auth-identity-headers", PROOF_FLAG];
const OIDC_FLAGS = ["auth-oidc-issuer string", "auth-oidc-client-id string", "auth-oidc-client-secret string"];
const credential = (...allow: string[]): PortalAuth => ({ method: "credential", allow, issuer: null, client_id: null });
const OIDC: PortalAuth = { method: "oidc", allow: ["me@example.com", "@example.com"], issuer: "https://accounts.google.com", client_id: "client-1.apps.example" };
const SIWE_AUTH: PortalAuth = { method: "siwe", allow: ["0x52908400098527886E0F7030069857D2E4169EE7"], issuer: null, client_id: null };
/** what the stand-in's `expose` finds in the environment, on its `seen` line before the proof */
const NO_SECRET = "secret=unset ovis=unset";
/** the arguments of the last `expose`: its `seen` lines but the last, which is its environment */
const argsOf = (seen: string[]): string[] => seen.slice(0, -1);
/** the environment of the last `expose`, without its proof */
const envOf = (seen: string[]): string => seen.at(-1)!.replace(/ proof=\S+$/, "");
/** the proof the last `expose` was given in its environment, or null */
const proofOf = (seen: string[]): string | null => {
  const proof = /proof=(\S+)$/.exec(seen.at(-1)!)?.[1];
  return proof === undefined || proof === "unset" ? null : proof;
};

interface StandIn {
  path: string;
  /** the last `expose`'s arguments, one a line, then what it saw of the environment */
  seen: () => string[];
  /** the pid of every `expose` so far */
  pids: () => number[];
  /** the last `auth issue`'s arguments, one a line */
  issued: () => string[];
}

/**
 * A portal whose `expose` writes its identity file as Portal does, prints `says`, then the ready
 * line unless `ready` is false, and runs until stopped. SIGUSR1 makes it end on its own (exit 3).
 */
function standIn(options: { version?: string; ready?: boolean; says?: string; ignoreTerm?: boolean; exitAfter?: boolean; flags?: string[]; issue?: "fail" } = {}): StandIn {
  const dir = mkdtempSync(join(root, "bin-"));
  const path = join(dir, "portal");
  const seen = join(dir, "seen");
  const pids = join(dir, "pids");
  const issued = join(dir, "issued");
  writeFileSync(path, [
    "#!/bin/sh",
    'case "$1" in',
    `  version) echo '${options.version ?? "v2.6.1"}' ;;`,
    "  expose)",
    // a question about its flags, not a service
    `    [ "$2" = --help ] && { printf '%s\\n' 'Flags:' ${(options.flags ?? [...SIGN_IN_FLAGS, ...OIDC_FLAGS]).map((flag) => `'  -${flag}' '    \t'`).join(" ")}; exit 0; }`,
    `    echo $$ >> '${pids}'`,
    `    { printf '%s\\n' "$@"; echo "token=\${OVIS_TOKEN-unset} identity=\${IDENTITY_PATH-unset} secret=\${AUTH_OIDC_CLIENT_SECRET-unset} ovis=\${OVIS_PORTAL_OIDC_CLIENT_SECRET-unset} proof=\${AUTH_IDENTITY_PROOF-unset}"; } > '${seen}'`,
    "    id=''; previous=''; for arg in \"$@\"; do [ \"$previous\" = --identity-path ] && id=\"$arg\"; previous=\"$arg\"; done",
    "    [ -z \"$id\" ] || [ -f \"$id\" ] || echo '{\"fixture\":true}' > \"$id\"",
    options.ignoreTerm ? "    trap '' TERM" : "    trap 'exit 0' TERM",
    "    trap 'exit 3' USR1",
    options.says ? `    echo '${options.says}' >&2` : "    :",
    // Portal v2.7.0's ready line: the address-bound host, then the short one for its --name
    options.ready === false ? "    :" : `    echo '2026-10-11T00:00:00Z INF service ready at ${ADDRESS}:443 (short URL: ${SHORT}:443) address=0x0123 alias_url=${SHORT}:443 event=relay_status'`,
    options.exitAfter ? "    exit 3 ;;" : "    while :; do sleep 0.05; done ;;",
    // Portal's own words: the credential, then the address that redeems it
    "  auth)",
    `    printf '%s\\n' "$@" > '${issued}'`,
    options.issue === "fail"
      ? `    echo 'Credential: ${LINK}'; echo 'load tunnel identity: no such file' >&2; exit 1 ;;`
      : `    echo 'Credential: ${LINK}'; echo "Redeem URL: https://$3/_portal/auth/login#credential=${LINK}" ;;`,
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return {
    path,
    issued: () => existsSync(issued) ? readFileSync(issued, "utf8").trim().split("\n") : [],
    seen: () => existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n") : [],
    pids: () => existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").map(Number) : [],
  };
}

/** A relay that answers its version the way Portal's /sdk/domain does. */
function relay(version = "v2.6.1"): typeof fetch {
  return (async (url: string | URL | Request) => {
    if (!String(url).endsWith("/sdk/domain")) return new Response(null, { status: 404 });
    return Response.json({ data: { protocol_version: "10", release_version: version } });
  }) as unknown as typeof fetch;
}

async function until(service: PortalService, done: (status: PortalStatus) => boolean, what: string): Promise<PortalStatus> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = await service.status(open);
    if (done(status)) return status;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${what} (phase ${status.phase}, error ${status.error})`);
    await Bun.sleep(20);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(20);
  return !alive(pid);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, what: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${what}`)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// A child process starting or stopping is waited for by its own signal (its READY line, its exit). The
// bound only names a child that hangs: a loaded runner can take seconds to start a Bun process, so it is
// far above a loaded runner's start time. A case that uses it sets its own timeout above it (CASE_MS).
const CHILD_MS = 20_000;
const CASE_MS = CHILD_MS + 10_000;

async function waitFor(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${what}`);
    await Bun.sleep(10);
  }
}

function seedSavedPortal(stateDir: string, pid: number | null = process.pid): void {
  const directory = join(stateDir, "portal");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "state.json"), JSON.stringify({ enabled: true, relay: RELAY, port: 7317, pid }));
}

// what a server started by the herdr plugin may carry: its own token, and Portal's own settings
const SECRET = "client-secret-that-only-the-environment-holds";
/** the bearer secret a stand-in `auth issue` prints, which nothing may keep */
const LINK = "credential-for-one-visitor-only";
const AMBIENT_PROOF = "an-ambient-proof-the-server-was-started-with";
const inherited = { OVIS_TOKEN: "do-not-pass-this-on", IDENTITY_PATH: "/somewhere/else.json", OVIS_PORTAL_OIDC_CLIENT_SECRET: SECRET, AUTH_IDENTITY_PROOF: AMBIENT_PROOF };
const previous: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [name, value] of Object.entries(inherited)) { previous[name] = process.env[name]; process.env[name] = value; }
});
afterEach(() => {
  for (const name of Object.keys(inherited)) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

describe("what Portal is given and says", () => {
  it("takes one relay as an https origin, a bare host included, and nothing else", () => {
    expect(relayOrigin("relay.example")).toBe(RELAY);
    expect(relayOrigin(" https://relay.example/ ")).toBe(RELAY);
    expect(relayOrigin("https://relay.example:8443")).toBe("https://relay.example:8443");
    // `--relays` reads a comma as a second relay
    for (const refused of ["", "http://relay.example", "https://user:pass@relay.example", "https://relay.example/path", "https://relay.example/?x=1", "relay.example --hide", "relay.example,evil.example", "https://a.example,b.example", 7, null]) {
      expect(relayOrigin(refused)).toBeNull();
    }
  });

  it("reads the address off the ready line, without the default port", () => {
    expect(readyUrl(`2026-10-11T00:00:00Z INF service ready at ${ADDRESS}:443`)).toBe(ADDRESS);
    expect(readyUrl("2026-10-11T00:00:00Z WRN relay operation failed")).toBeNull();
  });

  it("reads the short address of a --name off the ready line, when Portal prints one", () => {
    expect(shortReadyUrl(`INF service ready at ${ADDRESS}:443 (short URL: ${SHORT}:443) address=0x0123 alias_url=${SHORT}:443`)).toBe(SHORT);
    expect(shortReadyUrl(`INF service ready at ${ADDRESS}:443`)).toBeNull();
    expect(shortReadyUrl(`INF service ready at ${ADDRESS}:443 (short URL: http://plain.example)`)).toBeNull();
    expect(shortReadyUrl("WRN relay operation failed (short URL: https://x.example:443)")).toBeNull();
  });

  it("compares versions by number", () => {
    expect(atLeast("v2.6.1", "v2.6.1")).toBe(true);
    expect(atLeast("v2.10.0", "v2.6.1")).toBe(true);
    expect(atLeast("v2.6.0", "v2.6.1")).toBe(false);
    expect(atLeast("devel", "v2.6.1")).toBe(false);
  });
});

describe("running Portal", () => {
  it("opens nothing without a token, or while tailscale serve is declared the only way in", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    expect(service.start({ relay: RELAY, port: 7317, tokenSet: false, serveOnly: false })).toBe("token_required");
    expect(service.start({ relay: RELAY, port: 7317, tokenSet: true, serveOnly: true })).toBe("serve_only");
    expect((await service.status({ tokenSet: false, serveOnly: false })).blocked).toBe("token_required");
    expect(portal.pids()).toEqual([]);
  });

  it("does not follow redirects when checking the relay version", async () => {
    const requests: RequestInit[] = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return Response.json({ data: { release_version: "v2.6.1" } });
    }) as unknown as typeof globalThis.fetch;
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch });
    try {
      service.start({ relay: RELAY, port: 7317, ...open });
      await until(service, (status) => status.phase === "running", "Portal was ready");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.redirect).toBe("error");
    } finally {
      service.stop();
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });

  it("exposes this server in routed mode on the one relay given, without a visitor's Tailscale login or this server's secrets", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const service = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    expect(service.start({ relay: RELAY, port: 7317, ...open })).toBe("started");
    const status = await until(service, (s) => s.phase !== "starting", "Portal was ready");
    expect(status).toMatchObject({ phase: "running", url: ADDRESS, short_url: SHORT, relay: RELAY });
    const seen = portal.seen();
    const flag = (name: string) => seen[seen.indexOf(name) + 1];
    expect(seen[0]).toBe("expose");
    expect(flag("--http-route")).toBe("/=7317");
    expect(flag("--strip-request-header")).toBe("Tailscale-User-Login");
    expect(flag("--relays")).toBe(RELAY);
    expect(flag("--identity-path")).toBe(join(stateDir, "portal", "identity.json"));
    expect(seen).toContain("--discovery=false");
    expect(seen).toContain("--hide");
    // the OIDC secret is set on this server and goes only to a Portal that signs in with OIDC
    expect(envOf(seen)).toBe(`token=unset identity=unset ${NO_SECRET}`);
    expect(proofOf(seen)).toBeNull();
    expect(seen.slice(0, -1).filter((line) => line.startsWith("--auth"))).toEqual([]);
    expect(seen.filter((arg, index) => seen[index - 1] === "--strip-request-header")).toEqual(["Tailscale-User-Login", "X-Portal-User", "X-Portal-Auth"]);

    service.stop();
    expect((await until(service, (s) => s.phase === "idle", "Portal stopped")).url).toBeNull();
    expect(alive(portal.pids()[0]!)).toBe(false);
    // stopped is remembered: the next server leaves it off
    const next = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    await next.resume({ port: 7317, ...open });
    expect(await next.status(open)).toMatchObject({ phase: "idle", relay: RELAY });
    expect(portal.pids()).toHaveLength(1);
  });

  it("creates the private identity directory before spawning Portal", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portalDir = join(stateDir, "portal");
    const portal = standIn();
    const service = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    const spawn = Bun.spawn;
    const observed = spyOn(Bun, "spawn").mockImplementation(((command: string[], options?: Parameters<typeof Bun.spawn>[1]) => {
      if (Array.isArray(command) && command[1] === "expose" && command[2] !== "--help") {
        expect(existsSync(portalDir)).toBe(true);
        expect(statSync(portalDir).mode & 0o777).toBe(0o700);
      }
      return spawn(command, options);
    }) as typeof Bun.spawn);
    try {
      service.start({ relay: RELAY, port: 7317, ...open });
      await until(service, (s) => s.phase === "running", "Portal was ready");
      expect(observed).toHaveBeenCalled();
      service.stop();
      await until(service, (s) => s.phase === "idle", "Portal stopped");
    } finally {
      observed.mockRestore();
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });

  it("ends with its server, and comes back with the next one", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const first = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    first.start({ relay: RELAY, port: 7317, ...open });
    await until(first, (s) => s.phase === "running", "the first Portal was ready");
    await first.shutdown();
    expect(alive(portal.pids()[0]!)).toBe(false);
    const next = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    await next.resume({ port: 7317, ...open });
    expect(await until(next, (s) => s.phase !== "starting", "the next Portal was ready")).toMatchObject({ phase: "running", url: ADDRESS });
    await next.shutdown();
  });

  it("does not restart a resumed Portal after stop while leftover cleanup is pending", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    seedSavedPortal(stateDir);
    const portal = standIn();
    const service = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    const entered = deferred();
    const release = deferred();
    const cleanup = spyOn(service as unknown as { stopLeftover(pid: number | null): Promise<void> }, "stopLeftover")
      .mockImplementation(async () => { entered.resolve(); await release.promise; });
    const resumed = service.resume({ port: 7317, ...open });
    try {
      await bounded(entered.promise, "resume entered leftover cleanup");
      service.stop();
      release.resolve();
      await bounded(resumed, "resume completed after stop");
      expect((await service.status(open)).phase).toBe("idle");
      expect(portal.pids()).toEqual([]);
      expect(JSON.parse(readFileSync(join(stateDir, "portal", "state.json"), "utf8"))).toMatchObject({ enabled: false });
    } finally {
      release.resolve();
      cleanup.mockRestore();
      await bounded(resumed, "resume cleanup settled").catch(() => undefined);
    }
  });

  it("waits for leftover cleanup during shutdown and permanently prevents a later start", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    seedSavedPortal(stateDir);
    const portal = standIn();
    const service = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    const entered = deferred();
    const release = deferred();
    const cleanup = spyOn(service as unknown as { stopLeftover(pid: number | null): Promise<void> }, "stopLeftover")
      .mockImplementation(async () => { entered.resolve(); await release.promise; });
    const resumed = service.resume({ port: 7317, ...open });
    try {
      await bounded(entered.promise, "resume entered leftover cleanup");
      let shutdownSettled = false;
      const stopped = service.shutdown().then(() => { shutdownSettled = true; });
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);
      release.resolve();
      await bounded(stopped, "shutdown waited for leftover cleanup");
      await bounded(resumed, "resume completed after shutdown");
      expect(service.start({ relay: RELAY, port: 7317, ...open })).toBe("busy");
      expect((await service.status(open)).phase).toBe("idle");
      expect(portal.pids()).toEqual([]);
    } finally {
      release.resolve();
      cleanup.mockRestore();
      await bounded(resumed, "resume cleanup settled").catch(() => undefined);
    }
  });

  it("still finishes shutdown when pending leftover cleanup fails", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    seedSavedPortal(stateDir);
    const service = new PortalService({ stateDir, fetch: relay() });
    const entered = deferred();
    const release = deferred();
    const cleanup = spyOn(service as unknown as { stopLeftover(pid: number | null): Promise<void> }, "stopLeftover")
      .mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        throw new Error("fixture cleanup failure");
      });
    const resumed = service.resume({ port: 7317, ...open });
    const failed = resumed.catch((error: unknown) => error);
    try {
      await bounded(entered.promise, "cleanup entered");
      const stopped = service.shutdown();
      release.resolve();
      await bounded(stopped, "shutdown settled despite cleanup failure");
      expect(await failed).toMatchObject({ message: "fixture cleanup failure" });
      expect(service.start({ relay: RELAY, port: 7317, ...open })).toBe("busy");
    } finally {
      release.resolve();
      await failed;
      cleanup.mockRestore();
    }
  });

  it("rejects damaged saved state without overwriting it or assuming no tunnel exists", async () => {
    for (const contents of [
      "{", "null", "{}",
      JSON.stringify({ enabled: true, relay: RELAY, port: 7317, pid: "invalid" }),
      JSON.stringify({ enabled: true, relay: null, port: null, pid: null }),
    ]) {
      const stateDir = mkdtempSync(join(root, "state-"));
      seedSavedPortal(stateDir);
      const path = join(stateDir, "portal", "state.json");
      writeFileSync(path, contents);
      const service = new PortalService({ stateDir, fetch: relay() });
      await expect(service.resume({ port: 7317, tokenSet: false, serveOnly: false })).rejects.toThrow();
      expect(() => service.start({ port: 7317, relay: RELAY, ...open })).toThrow();
      expect(readFileSync(path, "utf8")).toBe(contents);
    }
    const stateDir = mkdtempSync(join(root, "state-"));
    mkdirSync(join(stateDir, "portal", "state.json"), { recursive: true });
    const service = new PortalService({ stateDir, fetch: relay() });
    await expect(service.resume({ port: 7317, ...open })).rejects.toThrow("Could not read saved Portal state");
  });

  it("rechecks cancellation after awaiting the version before examining leftovers", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    const internals = service as unknown as {
      version(fresh?: boolean): Promise<string | null>;
      stopLeftover(pid: number | null): Promise<void>;
      launching: boolean;
    };
    const versionStarted = deferred();
    const versionGate = deferred<string | null>();
    const version = spyOn(internals, "version").mockImplementation(async () => {
      versionStarted.resolve();
      return versionGate.promise;
    });
    const leftover = spyOn(internals, "stopLeftover").mockResolvedValue();
    try {
      service.start({ relay: RELAY, port: 7317, ...open });
      await bounded(versionStarted.promise, "Portal version check started");
      service.stop();
      versionGate.resolve("v2.6.1");
      await waitFor(() => !internals.launching, "cancelled start settled");
      expect(leftover).not.toHaveBeenCalled();
      expect(portal.pids()).toEqual([]);
    } finally {
      versionGate.resolve("v2.6.1");
      version.mockRestore();
      leftover.mockRestore();
    }
  });

  it("rechecks cancellation after awaiting the relay before examining leftovers", async () => {
    const relayStarted = deferred();
    const relayGate = deferred();
    const portal = standIn();
    const fetch = (async () => {
      relayStarted.resolve();
      await relayGate.promise;
      return Response.json({ data: { protocol_version: "10", release_version: "v2.6.1" } });
    }) as unknown as typeof globalThis.fetch;
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch });
    const internals = service as unknown as { stopLeftover(pid: number | null): Promise<void>; launching: boolean };
    const leftover = spyOn(internals, "stopLeftover").mockResolvedValue();
    try {
      service.start({ relay: RELAY, port: 7317, ...open });
      await bounded(relayStarted.promise, "relay check started");
      service.stop();
      relayGate.resolve();
      await waitFor(() => !internals.launching, "cancelled start settled");
      expect(leftover).not.toHaveBeenCalled();
      expect(portal.pids()).toEqual([]);
    } finally {
      relayGate.resolve();
      leftover.mockRestore();
    }
  });

  it("takes over from a Portal a server killed outright left running", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const first = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    first.start({ relay: RELAY, port: 7317, ...open });
    await until(first, (s) => s.phase === "running", "the first Portal was ready");
    // no shutdown: two processes with one identity would take the address from each other
    const next = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    await next.resume({ port: 7317, ...open });
    expect(await until(next, (s) => s.phase !== "starting", "the next Portal was ready")).toMatchObject({ phase: "running" });
    const [left, own] = portal.pids();
    expect(alive(left!)).toBe(false);
    expect(alive(own!)).toBe(true);
    await next.shutdown();
  });

  it("stops a Portal the last server left running even when it may not open the address itself", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const first = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    first.start({ relay: RELAY, port: 7317, ...open });
    await until(first, (s) => s.phase === "running", "the first Portal was ready");
    const tokenless = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    await tokenless.resume({ port: 7317, tokenSet: false, serveOnly: false });
    expect(await gone(portal.pids()[0]!)).toBe(true);
    expect((await tokenless.status({ tokenSet: false, serveOnly: false })).phase).toBe("idle");
    expect(portal.pids()).toHaveLength(1);
  });

  it("leaves alone the Portal of a server on another port", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const first = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    first.start({ relay: RELAY, port: 7317, ...open });
    await until(first, (s) => s.phase === "running", "the first Portal was ready");
    const other = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    await other.resume({ port: 7318, ...open });
    expect(alive(portal.pids()[0]!)).toBe(true);
    expect((await other.status(open)).phase).toBe("idle");
    const statePath = join(stateDir, "portal", "state.json");
    const ownerState = JSON.parse(readFileSync(statePath, "utf8"));
    expect(ownerState).toMatchObject({ enabled: true, port: 7317 });
    other.stop();
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(ownerState);
    expect(alive(portal.pids()[0]!)).toBe(true);
    await first.shutdown();
  });

  it("refuses an explicit start from another port without changing the owning Portal state", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const first = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    first.start({ relay: RELAY, port: 7317, ...open });
    await until(first, (s) => s.phase === "running", "the first Portal was ready");
    const pid = portal.pids()[0]!;
    const other = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    const response = await handlePortalRequest(
      new Request("http://127.0.0.1:7318/api/portal/start", {
        method: "POST",
        headers: { "x-herdr-update": "1", origin: "http://127.0.0.1:7318", "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ relay: "relay.example" }),
      }), "/api/portal/start", other, { port: 7318, ...open },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "portal_state_in_use", message: expect.stringContaining("OVIS_STATE_DIR") },
    });
    expect(alive(pid)).toBe(true);
    expect(readFileSync(join(stateDir, "portal", "state.json"), "utf8")).toContain('"port":7317');
    expect(portal.pids()).toHaveLength(1);
    await bounded(first.shutdown(), "the owning Portal stopped");
  });

  it("does not stop an unrelated process whose argv merely mentions expose and the identity path", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portalDir = join(stateDir, "portal");
    mkdirSync(portalDir, { recursive: true, mode: 0o700 });
    const identityPath = join(portalDir, "identity.json");
    const unrelated = Bun.spawn(["sh", "-c", "echo READY; while :; do sleep 0.1; done", "sh", "expose", "--identity-path", identityPath], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    writeFileSync(join(portalDir, "state.json"), JSON.stringify({ enabled: true, relay: RELAY, port: 7317, pid: unrelated.pid }));
    const service = new PortalService({ stateDir, fetch: relay() });
    try {
      // until the shell runs its script, /proc/<pid>/cmdline can still show the parent's argv or be empty mid-exec
      const reader = unrelated.stdout.getReader();
      try {
        const ready = await bounded(reader.read(), "unrelated shell executed its script", CHILD_MS);
        expect(new TextDecoder().decode(ready.value)).toBe("READY\n");
      } finally { reader.releaseLock(); }
      await service.resume({ port: 7317, tokenSet: false, serveOnly: false });
      expect(alive(unrelated.pid)).toBe(true);
    } finally {
      unrelated.kill("SIGTERM");
      await bounded(unrelated.exited, "unrelated process stopped", CHILD_MS);
    }
  }, CASE_MS);

  it("does not treat an arbitrary interpreter as a Portal script", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portalDir = join(stateDir, "portal");
    mkdirSync(portalDir, { recursive: true, mode: 0o700 });
    const identityPath = join(portalDir, "identity.json");
    const scriptPath = join(portalDir, "portal");
    writeFileSync(scriptPath, 'process.stdout.write("READY\\n"); await new Promise(() => {});\n');
    const unrelated = Bun.spawn([process.execPath, scriptPath, "expose", "--identity-path", identityPath], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    writeFileSync(join(portalDir, "state.json"), JSON.stringify({ enabled: true, relay: RELAY, port: 7317, pid: unrelated.pid }));
    const service = new PortalService({ stateDir, fetch: relay() });
    const internals = service as unknown as { processArgv(pid: number): Promise<string[] | null> };
    try {
      const reader = unrelated.stdout.getReader();
      try {
        const ready = await bounded(reader.read(), "unrelated interpreter executed its script", CHILD_MS);
        expect(new TextDecoder().decode(ready.value)).toBe("READY\n");
      } finally { reader.releaseLock(); }
      expect((await internals.processArgv(unrelated.pid))?.slice(1, 3)).toEqual([scriptPath, "expose"]);
      await service.resume({ port: 7317, tokenSet: false, serveOnly: false });
      expect(alive(unrelated.pid)).toBe(true);
    } finally {
      if (alive(unrelated.pid)) unrelated.kill("SIGTERM");
      await bounded(unrelated.exited, "unrelated interpreter stopped", CHILD_MS);
    }
  }, CASE_MS);

  it("rejects resume when a live saved PID has unreadable identity", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    seedSavedPortal(stateDir, process.pid);
    const service = new PortalService({ stateDir, fetch: relay() });
    const internals = service as unknown as { processArgv(pid: number): Promise<string[] | null> };
    const argv = spyOn(internals, "processArgv").mockResolvedValue(null);
    try {
      await expect(service.resume({ port: 7317, ...open })).rejects.toThrow("Could not verify the identity");
      expect(argv).toHaveBeenCalledWith(process.pid, expect.any(Number));
    } finally {
      argv.mockRestore();
    }
  });

  it("rejects resume when termination of the recorded Portal fails", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    seedSavedPortal(stateDir, process.pid);
    const service = new PortalService({ stateDir, fetch: relay() });
    const internals = service as unknown as { processArgv(pid: number): Promise<string[] | null> };
    const identityPath = join(stateDir, "portal", "identity.json");
    const argv = spyOn(internals, "processArgv").mockResolvedValue([
      "/usr/bin/portal", "expose", "--identity-path", identityPath,
    ]);
    const killProcess = process.kill.bind(process);
    const kill = spyOn(process, "kill").mockImplementation(((pid, signal) => {
      if (pid === process.pid && signal === 0) return true;
      if (pid === process.pid && signal === "SIGTERM") throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      return killProcess(pid, signal);
    }) as typeof process.kill);
    try {
      await expect(service.resume({ port: 7317, ...open })).rejects.toThrow("permission denied");
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    } finally {
      kill.mockRestore();
      argv.mockRestore();
    }
  });

  it("waits for the recorded PID to disappear after SIGKILL", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const pid = 987654321;
    seedSavedPortal(stateDir, pid);
    const service = new PortalService({ stateDir, fetch: relay(), stopGraceMs: 0 });
    const internals = service as unknown as { processArgv(pid: number): Promise<string[] | null> };
    const identityPath = join(stateDir, "portal", "identity.json");
    const argv = spyOn(internals, "processArgv").mockResolvedValue([
      "/usr/bin/portal", "expose", "--identity-path", identityPath,
    ]);
    const killProcess = process.kill.bind(process);
    let sentSigkill = false;
    let probesAfterSigkill = 0;
    const kill = spyOn(process, "kill").mockImplementation(((target, signal) => {
      if (target !== pid) return killProcess(target, signal);
      if (signal === "SIGKILL") { sentSigkill = true; return true; }
      if (signal === "SIGTERM") return true;
      if (signal === 0) {
        if (sentSigkill && ++probesAfterSigkill === 3) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return true;
      }
      return killProcess(target, signal);
    }) as typeof process.kill);
    try {
      await service.resume({ port: 7317, tokenSet: false, serveOnly: false });
      expect(sentSigkill).toBe(true);
      expect(probesAfterSigkill).toBe(3);
      expect(argv).toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      argv.mockRestore();
    }
  });

  it("refuses a relay older than the tunnel needs before anything runs", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay("v2.6.0") });
    service.start({ relay: RELAY, port: 7317, ...open });
    const status = await until(service, (s) => s.phase !== "starting", "the start ended");
    expect(status.phase).toBe("error");
    expect(status.error).toContain("v2.6.1");
    expect(portal.pids()).toEqual([]);
  });

  it("offers no start without a portal recent enough, and says which", async () => {
    const old = standIn({ version: "v2.5.1" });
    const outdated = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: old.path, fetch: relay() });
    expect(await outdated.status(open)).toMatchObject({ version: "v2.5.1", usable: false });
    outdated.start({ relay: RELAY, port: 7317, ...open });
    expect((await until(outdated, (s) => s.phase !== "starting", "the start ended")).error).toContain("v2.5.1");
    expect(old.pids()).toEqual([]);

    const missing = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: join(root, "no-such-portal"), fetch: relay() });
    expect(await missing.status(open)).toMatchObject({ supported: true, version: null, usable: false });
  });

  it("gives up on a relay that never takes the tunnel, and says what Portal said", async () => {
    const portal = standIn({ ready: false, says: "2026-10-11T00:00:00Z WRN lease registration failed" });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay(), readyTimeoutMs: 300 });
    service.start({ relay: RELAY, port: 7317, ...open });
    const status = await until(service, (s) => s.phase !== "starting", "the start gave up");
    expect(status.phase).toBe("error");
    expect(status.error).toContain("lease registration failed");
    expect(await gone(portal.pids()[0]!)).toBe(true);
  });

  it("stops a Portal a relay refused for good", async () => {
    const portal = standIn({ ready: false, says: "2026-10-11T00:00:00Z ERR relay operation failed permanently error=\"name taken\"" });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    service.start({ relay: RELAY, port: 7317, ...open });
    const status = await until(service, (s) => s.phase !== "starting", "the start ended");
    expect(status.phase).toBe("error");
    expect(status.error).toContain("name taken");
  });

  it("tells of a Portal that ended on its own again after its one restart, in its last words", async () => {
    const portal = standIn({ exitAfter: true, says: "2026-10-11T00:00:00Z ERR listener closed" });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    service.authorize(() => open);
    const watch = observe(service);
    try {
      const ended = watch.when(() => watch.internals.phase === "error", "Portal ended twice");
      service.start({ relay: RELAY, port: 7317, ...open });
      await ended;
      const status = await service.status(open);
      expect(status.error).toContain("again after one restart (exit 3)");
      expect(status.error).toContain("listener closed");
      expect(status.url).toBeNull();
      expect(portal.pids()).toHaveLength(2);
    } finally {
      watch.dispose();
    }
  });

  it("kills a Portal that does not stop when asked", async () => {
    const portal = standIn({ ignoreTerm: true });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay(), stopGraceMs: 200 });
    service.start({ relay: RELAY, port: 7317, ...open });
    await until(service, (s) => s.phase === "running", "Portal was ready");
    service.stop();
    await until(service, (s) => s.phase === "idle", "Portal was killed");
    expect(alive(portal.pids()[0]!)).toBe(false);
  });
});

describe("who may open the address", () => {

  it("builds each sign-in's arguments, with nothing a visitor or the secret could change", () => {
    // no sign-in: a visitor's own identity headers are dropped, so none can pass for Portal's
    expect(authArgs({ method: "none", allow: [], issuer: null, client_id: null })).toEqual(["--strip-request-header", "X-Portal-User", "--strip-request-header", "X-Portal-Auth"]);
    expect(authArgs(credential())).toEqual(["--auth=credential", "--auth-identity-headers=true"]);
    // a name with spaces, or one that starts like a flag, stays one argument and never reads as a flag
    expect(authArgs(credential("Alice Smith", "-bob", "--hide"))).toEqual(["--auth=credential", "--auth-identity-headers=true", "--auth-allow=Alice Smith", "--auth-allow=-bob", "--auth-allow=--hide"]);
    expect(authArgs(SIWE_AUTH)).toEqual(["--auth=siwe", "--auth-identity-headers=true", `--auth-allow=${SIWE_AUTH.allow[0]}`]);
    expect(authArgs(OIDC)).toEqual([
      "--auth=oidc", "--auth-identity-headers=true", "--auth-allow=me@example.com", "--auth-allow=@example.com",
      "--auth-oidc-issuer=https://accounts.google.com", "--auth-oidc-client-id=client-1.apps.example",
    ]);
    // Portal refuses to strip the identity headers it sets itself
    for (const auth of [credential(), SIWE_AUTH, OIDC]) expect(authArgs(auth)).not.toContain("--strip-request-header");
  });

  it("gives the OIDC client secret to an OIDC Portal's environment only, and keeps it out of its arguments, the saved state and every answer", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const service = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    try {
      expect(service.start({ relay: RELAY, port: 7317, auth: OIDC, ...open })).toBe("started");
      const status = await until(service, (s) => s.phase === "running", "Portal was ready");
      const seen = portal.seen();
      expect(envOf(seen)).toBe(`token=unset identity=unset secret=${SECRET} ovis=unset`);
      expect(argsOf(seen).some((arg) => arg.includes(SECRET))).toBe(false);
      for (const arg of authArgs(OIDC)) expect(seen).toContain(arg);
      expect(seen).toContain("Tailscale-User-Login");
      expect(status).toMatchObject({ oidc_secret: true, auth: OIDC });
      expect(JSON.stringify(status)).not.toContain(SECRET);
      const saved = readFileSync(join(stateDir, "portal", "state.json"), "utf8");
      expect(saved).not.toContain(SECRET);
      expect(JSON.parse(saved)).toMatchObject({ enabled: true, auth: OIDC });
    } finally {
      service.stop();
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });

  it("says whether the secret is set without saying what it is", async () => {
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: standIn().path, fetch: relay() });
    expect((await service.status(open)).oidc_secret).toBe(true);
    delete process.env["OVIS_PORTAL_OIDC_CLIENT_SECRET"];
    expect((await service.status(open)).oidc_secret).toBe(false);
    process.env["OVIS_PORTAL_OIDC_CLIENT_SECRET"] = "  ";
    expect((await service.status(open)).oidc_secret).toBe(false);
  });

  it("offers the sign-ins whose flags the installed Portal lists, and refuses to start one it does not", async () => {
    const offered = async (options: Parameters<typeof standIn>[0]) => (await new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: standIn(options).path, fetch: relay() }).status(open)).auth_methods;
    expect(await offered({})).toEqual(["credential", "siwe", "oidc"]);
    expect(await offered({ flags: SIGN_IN_FLAGS })).toEqual(["credential", "siwe"]);
    // a Portal that signs visitors in but cannot prove the identity it states offers nothing, whatever else it lists
    expect(await offered({ flags: [...SIGN_IN_FLAGS.filter((flag) => flag !== PROOF_FLAG), ...OIDC_FLAGS] })).toEqual([]);
    expect(await offered({ flags: [PROOF_FLAG, "auth-identity-headers", "auth-allow value"] })).toEqual([]);
    expect(await offered({ flags: ["auth string", PROOF_FLAG, "auth-allow value"] })).toEqual([]);
    expect(await offered({ flags: ["auth string", "auth-allow value"] })).toEqual([]);
    expect(await offered({ flags: [] })).toEqual([]);
    // a Portal too old to run the tunnel, and none at all, offer nothing
    expect(await offered({ version: "v2.5.1" })).toEqual([]);
    expect((await new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: join(root, "no-such-portal"), fetch: relay() }).status(open)).auth_methods).toEqual([]);

    for (const [flags, auth, said] of [[SIGN_IN_FLAGS, OIDC, "--auth oidc"], [[], credential(), "--auth credential"], [SIGN_IN_FLAGS.filter((flag) => flag !== PROOF_FLAG), credential(), "--auth credential"]] as const) {
      const portal = standIn({ flags: [...flags] });
      const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
      service.start({ relay: RELAY, port: 7317, auth, ...open });
      const status = await until(service, (s) => s.phase !== "starting", "the start ended");
      expect(status).toMatchObject({ phase: "error", url: null });
      expect(status.error).toContain(said);
      expect(portal.pids()).toEqual([]);
    }
  });

  it("keeps the choice across stops and restarts", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const first = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    first.start({ relay: RELAY, port: 7317, auth: credential("alice", "bob"), ...open });
    await until(first, (s) => s.phase === "running", "Portal was ready");
    expect(argsOf(portal.seen())).toEqual(expect.arrayContaining(["--auth=credential", "--auth-identity-headers=true", "--auth-allow=alice", "--auth-allow=bob"]));
    first.stop();
    await until(first, (s) => s.phase === "idle", "Portal stopped");
    // what is shown in the panel once stopped is the choice the next start offers
    expect((await first.status(open)).auth).toEqual(credential("alice", "bob"));

    // a restart of the app brings the address back with the same sign-in
    const next = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    expect((await next.status(open)).auth.method).toBe("none");
    await next.resume({ port: 7317, ...open });
    expect(await next.status(open)).toMatchObject({ phase: "idle", auth: credential("alice", "bob") });
    next.start({ relay: RELAY, port: 7317, ...open });
    await until(next, (s) => s.phase === "running", "Portal was ready again");
    // a start without a sign-in is the app's own token or a paired device again
    expect(portal.seen().some((arg) => arg.startsWith("--auth"))).toBe(false);
    expect(savedState(stateDir)).toMatchObject({ auth: { method: "none", allow: [] } });
    await next.shutdown();

    const resumed = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    first.start({ relay: RELAY, port: 7317, auth: SIWE_AUTH, ...open });
    await until(first, (s) => s.phase === "running", "Portal was ready with a wallet");
    await first.shutdown();
    await resumed.resume({ port: 7317, ...open });
    await until(resumed, (s) => s.phase === "running", "the resumed Portal was ready");
    expect(argsOf(portal.seen())).toEqual(expect.arrayContaining(["--auth=siwe", `--auth-allow=${SIWE_AUTH.allow[0]}`]));
    await resumed.shutdown();
  });

  it("relaunches a sign-in it served with, with the same arguments", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    service.authorize(() => open);
    const watch = observe(service);
    try {
      const ready = watch.when(() => watch.internals.url !== null, "Portal was ready");
      service.start({ relay: RELAY, port: 7317, auth: OIDC, ...open });
      await ready;
      const [first] = watch.exposes;
      const back = watch.when(() => watch.internals.url !== null && watch.internals.child?.pid !== first, "the replacement was ready");
      process.kill(first!, "SIGUSR1");
      await back;
      expect(watch.exposes).toHaveLength(2);
      expect(portal.seen()).toEqual(expect.arrayContaining(authArgs(OIDC)));
      expect(envOf(portal.seen())).toBe(`token=unset identity=unset secret=${SECRET} ovis=unset`);
    } finally {
      watch.dispose();
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });

  it("refuses a sign-in no request could make before anything runs", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    const server = { port: 7317, ...open };
    const own = { "x-herdr-update": "1", origin: "http://127.0.0.1:7317", "sec-fetch-site": "same-origin", "content-type": "application/json" };
    const start = (auth: unknown) => handlePortalRequest(new Request("http://127.0.0.1:7317/api/portal/start", { method: "POST", headers: own, body: JSON.stringify({ relay: "relay.example", auth }) }), "/api/portal/start", service, server);
    const refused: [unknown, keyof typeof PORTAL_AUTH_PROBLEMS][] = [
      ["credential", "invalid"],
      [{ method: "saml" }, "invalid"],
      [{ method: "credential", allow: "alice" }, "invalid"],
      [{ method: "credential", allow: ["bad\u0001name"] }, "name"],
      [{ method: "credential", allow: ["x".repeat(257)] }, "name"],
      [{ method: "siwe", allow: [] }, "no_wallet"],
      [{ method: "siwe", allow: ["0x1234"] }, "wallet"],
      [{ method: "oidc", allow: [], issuer: "https://accounts.google.com", client_id: "c" }, "no_principal"],
      [{ method: "oidc", allow: ["me"], issuer: "https://accounts.google.com", client_id: "c" }, "principal"],
      [{ method: "oidc", allow: ["me@example.com"], issuer: "http://accounts.example", client_id: "c" }, "issuer"],
      [{ method: "oidc", allow: ["me@example.com"], issuer: "https://accounts.example/?x=1", client_id: "c" }, "issuer"],
      [{ method: "oidc", allow: ["me@example.com"], issuer: "https://accounts.example", client_id: "" }, "client_id"],
    ];
    for (const [auth, problem] of refused) {
      const response = await start(auth);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_portal_auth", message: PORTAL_AUTH_PROBLEMS[problem] } });
    }
    expect(portal.pids()).toEqual([]);
    expect((await service.status(open)).phase).toBe("idle");
    // no sign-in named is none: an older panel starts as before
    expect((await start(undefined)).status).toBe(202);
    await until(service, (s) => s.phase === "running", "Portal was ready");
    await bounded(service.shutdown(), "Portal shutdown settled");
  });

  it("does not take damaged saved sign-in settings for none", async () => {
    for (const auth of [{ method: "siwe", allow: [] }, { method: "saml" }, "credential", { method: "oidc", allow: ["me@example.com"], issuer: "http://x.example", client_id: "c" }]) {
      const stateDir = mkdtempSync(join(root, "state-"));
      mkdirSync(join(stateDir, "portal"), { recursive: true, mode: 0o700 });
      writeFileSync(join(stateDir, "portal", "state.json"), JSON.stringify({ enabled: true, relay: RELAY, port: 7317, pid: process.pid, auth }));
      const service = new PortalService({ stateDir, fetch: relay() });
      await expect(service.resume({ port: 7317, ...open })).rejects.toThrow("Saved Portal state is invalid");
    }
  });
});

describe("the proof of a Portal with a sign-in", () => {
  const PROOF = /^[0-9a-f]{64}$/;
  const started = async (service: PortalService, auth: PortalAuth | undefined) => {
    service.start({ relay: RELAY, port: 7317, auth, ...open });
    await until(service, (s) => s.phase === "running", "Portal was ready");
  };

  it("matches only the proof itself, and a length that differs is no match rather than a throw", () => {
    const proof = "a1".repeat(32);
    expect(proofMatches(proof, proof)).toBe(true);
    for (const given of [null, "", "a", proof.slice(1), proof.slice(0, -1), `${proof}0`, `${proof}${proof}`, proof.replace(/.$/, "b"), proof.toUpperCase(), ` ${proof}`, "x".repeat(10_000)]) {
      expect(proofMatches(proof, given)).toBe(false);
    }
    // no proof made: nothing matches
    for (const given of [null, "", proof]) expect(proofMatches(null, given)).toBe(false);
  });

  it("is made for a Portal with a sign-in and given to its environment alone: no argument, state, answer or log has it", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const service = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    const logs = (["log", "info", "warn", "error"] as const).map((level) => spyOn(console, level).mockImplementation(() => undefined));
    try {
      expect(service.vouches(null)).toBe(false);
      await started(service, credential());
      const proof = proofOf(portal.seen())!;
      expect(proof).toMatch(PROOF);
      expect(service.vouches(proof)).toBe(true);
      // the one made here, never one this server's own environment had
      expect(service.vouches(AMBIENT_PROOF)).toBe(false);
      for (const wrong of [null, "", proof.slice(1), proof.slice(0, -1), `${proof}0`, "0".repeat(64), proof.toUpperCase()]) expect(service.vouches(wrong)).toBe(false);
      expect(argsOf(portal.seen()).some((arg) => arg.includes(proof))).toBe(false);
      const status = JSON.stringify(await service.status(open));
      expect(status).not.toContain(proof);
      expect(readFileSync(join(stateDir, "portal", "state.json"), "utf8")).not.toContain(proof);
      service.stop();
      await until(service, (s) => s.phase === "idle", "Portal stopped");
      expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(proof);
    } finally {
      for (const log of logs) log.mockRestore();
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });

  it("is not made for a Portal without a sign-in, whatever an earlier one had", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    await started(service, credential());
    const earlier = proofOf(portal.seen())!;
    service.stop();
    await until(service, (s) => s.phase === "idle", "Portal stopped");
    await started(service, undefined);
    expect(proofOf(portal.seen())).toBeNull();
    for (const given of [null, "", earlier]) expect(service.vouches(given)).toBe(false);
    await bounded(service.shutdown(), "Portal shutdown settled");
  });

  it("is a new one for each launch, and the one before stops counting", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    service.authorize(() => open);
    const watch = observe(service);
    try {
      const ready = watch.when(() => watch.internals.url !== null, "Portal was ready");
      service.start({ relay: RELAY, port: 7317, auth: credential(), ...open });
      await ready;
      const [first] = watch.exposes;
      const before = proofOf(portal.seen())!;
      expect(service.vouches(before)).toBe(true);
      const back = watch.when(() => watch.internals.url !== null && watch.internals.child?.pid !== first, "the replacement was ready");
      process.kill(first!, "SIGUSR1");
      await back;
      const after = proofOf(portal.seen())!;
      expect(after).toMatch(PROOF);
      expect(after).not.toBe(before);
      expect(service.vouches(after)).toBe(true);
      expect(service.vouches(before)).toBe(false);
    } finally {
      watch.dispose();
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });

  it("stops counting with its Portal: when it is stopped, when the server shuts down, when it ends on its own, when it cannot be spawned", async () => {
    const stopped = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: standIn().path, fetch: relay() });
    const first = standIn();
    const one = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: first.path, fetch: relay() });
    await started(one, credential());
    const stoppedProof = proofOf(first.seen())!;
    one.stop();
    // at once, not when the process has gone
    expect(one.vouches(stoppedProof)).toBe(false);
    await until(one, (s) => s.phase === "idle", "Portal stopped");
    expect(stopped.vouches(stoppedProof)).toBe(false);

    const second = standIn();
    const shut = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: second.path, fetch: relay() });
    await started(shut, credential());
    const shutProof = proofOf(second.seen())!;
    const done = shut.shutdown();
    expect(shut.vouches(shutProof)).toBe(false);
    await bounded(done, "Portal shutdown settled");

    // ended on its own with no relaunch allowed (nothing authorized one)
    const third = standIn({ exitAfter: true });
    const ended = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: third.path, fetch: relay() });
    ended.start({ relay: RELAY, port: 7317, auth: credential(), ...open });
    await until(ended, (s) => s.phase === "error", "Portal ended");
    expect(ended.vouches(proofOf(third.seen()))).toBe(false);

    // a spawn that fails: whatever was made for it counts for nothing
    const fourth = standIn();
    const failing = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: fourth.path, fetch: relay() });
    const spawn = Bun.spawn;
    let made: string | undefined;
    const refusing = spyOn(Bun, "spawn").mockImplementation(((command: string[], options?: Parameters<typeof Bun.spawn>[1]) => {
      if (Array.isArray(command) && command[1] === "expose" && command[2] !== "--help") {
        made = (options?.env as Record<string, string> | undefined)?.["AUTH_IDENTITY_PROOF"];
        throw new Error("fixture: cannot spawn");
      }
      return spawn(command, options);
    }) as typeof Bun.spawn);
    try {
      failing.start({ relay: RELAY, port: 7317, auth: credential(), ...open });
      const status = await until(failing, (s) => s.phase !== "starting", "the start ended");
      expect(status.error).toContain("fixture: cannot spawn");
      expect(made).toMatch(PROOF);
      expect(failing.vouches(made!)).toBe(false);
    } finally { refusing.mockRestore(); }
  });
});

describe("private links", () => {
  const own = { "x-herdr-update": "1", origin: "http://127.0.0.1:7317", "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const server = { port: 7317, ...open };
  const invite = (service: PortalService, body: unknown, headers: Record<string, string> = own) =>
    handlePortalRequest(new Request("http://127.0.0.1:7317/api/portal/invite", { method: "POST", headers, body: JSON.stringify(body) }), "/api/portal/invite", service, server);
  const code = async (response: Response) => (await response.json() as { error: { code: string } }).error.code;
  const running = async (auth: PortalAuth | undefined, options: Parameters<typeof standIn>[0] = {}) => {
    const portal = standIn(options);
    const stateDir = mkdtempSync(join(root, "state-"));
    const service = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    service.start({ relay: RELAY, port: 7317, auth, ...open });
    await until(service, (s) => s.phase === "running", "Portal was ready");
    return { portal, service, stateDir };
  };

  it("issues a link for this app's own identity and address, and hands it back once", async () => {
    const { portal, service, stateDir } = await running(credential());
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    const info = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await invite(service, { name: " Alice Smith ", days: 7 });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ redeem_url: `${ADDRESS}/_portal/auth/login#credential=${LINK}` });
      expect(portal.issued()).toEqual(["auth", "issue", new URL(ADDRESS).host, "--subject=Alice Smith", "--expires=168h", "--identity-path", join(stateDir, "portal", "identity.json")]);
      for (const [days, hours] of [[1, 24], [30, 720], [90, 2160]]) {
        await invite(service, { name: "bob", days });
        expect(portal.issued()).toContain(`--expires=${hours}h`);
      }
      expect(savedState(stateDir)).toMatchObject({ invites: [{ name: "Alice Smith", role: "watch" }, { name: "bob", role: "watch" }] });
      expect(service.roleFor("Alice Smith", "credential")).toBe("watch");
      // the link is a bearer secret: no status, saved file, Portal output or log keeps it
      expect(JSON.stringify(await service.status(open))).not.toContain(LINK);
      expect(readFileSync(join(stateDir, "portal", "state.json"), "utf8")).not.toContain(LINK);
      expect(JSON.stringify([...log.mock.calls, ...info.mock.calls])).not.toContain(LINK);
    } finally {
      log.mockRestore();
      info.mockRestore();
      service.stop();
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });

  it("loads invitation roles across restarts without treating an unknown or legacy visitor as the owner", async () => {
    const stateDir = mkdtempSync(join(root, "roles-"));
    mkdirSync(join(stateDir, "portal"));
    const path = join(stateDir, "portal", "state.json");
    const state = { enabled: false, relay: RELAY, port: 7317, pid: null, auth: credential() };
    writeFileSync(path, JSON.stringify({ ...state, invites: [{ name: "alice" }, { name: "owner-link", role: "drive" }] }));
    const service = new PortalService({ stateDir });
    await service.resume({ port: 7317, ...open });
    expect(service.roleFor("alice", "credential")).toBe("watch");
    expect(service.roleFor("unknown", "credential")).toBe("watch");
    expect(service.roleFor("owner-link", "credential")).toBe("drive");
    expect(service.roleFor("owner-link", "oidc")).toBe("watch");
    writeFileSync(path, JSON.stringify(state));
    const legacy = new PortalService({ stateDir });
    await legacy.resume({ port: 7317, ...open });
    expect(legacy.roleFor("owner-link", "credential")).toBe("watch");
    writeFileSync(path, JSON.stringify({ ...state, invites: [{ name: "alice", role: "admin" }] }));
    await expect(new PortalService({ stateDir }).resume({ port: 7317, ...open })).rejects.toThrow();
  });

  it("issues only while Portal runs with the private-link sign-in and its address is known", async () => {
    for (const auth of [undefined, SIWE_AUTH, OIDC]) {
      const { portal, service } = await running(auth);
      expect(await code(await invite(service, { name: "alice", days: 30 }))).toBe("portal_not_credential");
      expect(portal.issued()).toEqual([]);
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
    // stopped, or not started: there is no address to name
    const portal = standIn();
    const idle = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    expect(await code(await invite(idle, { name: "alice", days: 30 }))).toBe("portal_not_credential");
    const { service } = await running(credential());
    service.stop();
    await until(service, (s) => s.phase === "idle", "Portal stopped");
    expect(await code(await invite(service, { name: "alice", days: 30 }))).toBe("portal_not_credential");
    expect(await code(await invite(undefined as unknown as PortalService, { name: "alice", days: 30 }))).toBe("portal_unsupported");
  });

  it("issues only for a name on the list when there is one, and only in the lengths offered", async () => {
    const { portal, service } = await running(credential("alice", "bob smith"));
    try {
      expect((await invite(service, { name: "bob smith", days: 30 })).status).toBe(200);
      expect(portal.issued()).toContain("--subject=bob smith");
      const unlisted = await invite(service, { name: "mallory", days: 30 });
      expect(unlisted.status).toBe(400);
      expect(await code(unlisted)).toBe("invite_name_not_listed");
      for (const [body, problem] of [
        [{ days: 30 }, "invalid_invite"], [{ name: "", days: 30 }, "invalid_invite"], [{ name: "x".repeat(257), days: 30 }, "invalid_invite"], [{ name: "김철수", days: 30 }, "invalid_invite"],
        [{ name: "alice" }, "invalid_invite"], [{ name: "alice", days: 2 }, "invalid_invite"], [{ name: "alice", days: "30" }, "invalid_invite"], [{ name: "alice", days: 0 }, "invalid_invite"], ["alice", "invalid_invite"],
      ] as const) {
        const response = await invite(service, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await code(response)).toBe(problem);
      }
      expect(portal.issued()).toContain("--subject=bob smith");
    } finally {
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });

  it("refuses anything but this app's own controls before issuing", async () => {
    const { portal, service } = await running(credential());
    try {
      for (const headers of [{ ...own, "x-herdr-update": "0" }, { ...own, origin: "https://evil.example" }, { ...own, "sec-fetch-site": "cross-site" }]) {
        expect(await code(await invite(service, { name: "alice", days: 30 }, headers))).toBe("invalid_portal_request");
      }
      expect(portal.issued()).toEqual([]);
    } finally {
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });

  it("tells when Portal could not issue it, without a word of the link", async () => {
    const { service } = await running(credential(), { issue: "fail" });
    try {
      const response = await invite(service, { name: "alice", days: 30 });
      expect(response.status).toBe(502);
      const body = await response.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("portal_invite_failed");
      expect(body.error.message).toContain("exit 1");
      expect(body.error.message).toContain("load tunnel identity: no such file");
      // even a credential it printed before failing is not repeated
      expect(JSON.stringify(body)).not.toContain(LINK);
    } finally {
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });
});

interface Internals {
  phase: PortalStatus["phase"];
  url: string | null;
  child: { pid: number } | null;
  line(raw: string, child: unknown): void;
  exited(child: { pid: number }, code: number | null, request: unknown, operation: number): void;
  fail(text: string): void;
  save(change: { pid?: number | null }): void;
  launch(request: unknown, operation: number, recovery: unknown): Promise<void>;
  version(fresh?: boolean): Promise<string | null>;
  stopLeftover(pid: number | null): Promise<void>;
}

/**
 * Follows the service's own steps (a line read, an exit handled, a failure, a save, a launch, an
 * `expose` spawned) so a test waits for the step itself: every wait is registered before the
 * action that sets it off.
 */
function observe(service: PortalService, options: { refuseSave?: (pid: number) => boolean } = {}) {
  const internals = service as unknown as Internals;
  const waiters = new Set<() => void>();
  const events: string[] = [];
  const phases: string[] = [internals.phase];
  const launches: Promise<void>[] = [];
  const exposes: number[] = [];
  /** whether every earlier `expose` had exited when the next one was spawned */
  const earlierGone: boolean[] = [];
  const notify = () => {
    if (phases.at(-1) !== internals.phase) phases.push(internals.phase);
    for (const waiter of [...waiters]) waiter();
  };
  const line = internals.line.bind(service);
  const exited = internals.exited.bind(service);
  const fail = internals.fail.bind(service);
  const save = internals.save.bind(service);
  const launch = internals.launch.bind(service);
  const spawn = Bun.spawn;
  const spies = [
    spyOn(internals, "line").mockImplementation((raw, child) => {
      const before = internals.url;
      line(raw, child);
      if (before === null && internals.url !== null) events.push(`url:${(child as { pid: number }).pid}`);
      notify();
    }),
    spyOn(internals, "exited").mockImplementation((child, code, request, operation) => {
      events.push(`exit:${child.pid}`);
      exited(child, code, request, operation);
      notify();
    }),
    spyOn(internals, "fail").mockImplementation((text) => { fail(text); notify(); }),
    spyOn(internals, "save").mockImplementation((change) => {
      if (typeof change.pid === "number" && options.refuseSave?.(change.pid)) throw new Error("fixture: the disk is full");
      save(change);
      if (typeof change.pid === "number") events.push(`save:${change.pid}`);
    }),
    spyOn(internals, "launch").mockImplementation((request, operation, recovery) => {
      const launched = launch(request, operation, recovery);
      launches.push(launched.catch(() => undefined));
      return launched;
    }),
    spyOn(Bun, "spawn").mockImplementation(((command: string[], spawnOptions?: Parameters<typeof Bun.spawn>[1]) => {
      // `expose --help` is the status asking which sign-ins this Portal offers, not a tunnel
      const expose = Array.isArray(command) && command[1] === "expose" && command[2] !== "--help";
      if (expose) earlierGone.push(exposes.every((pid) => !alive(pid)));
      const child = spawn(command, spawnOptions);
      if (expose) {
        exposes.push(child.pid);
        events.push(`spawn:${child.pid}`);
        notify();
      }
      return child;
    }) as typeof Bun.spawn),
  ];
  const when = (check: () => boolean, what: string): Promise<void> => bounded(new Promise<void>((resolve) => {
    const waiter = () => {
      if (!check()) return;
      waiters.delete(waiter);
      resolve();
    };
    waiters.add(waiter);
    waiter();
  }), what, 10_000);
  return { internals, events, phases, launches, exposes, earlierGone, when, dispose: () => { for (const spy of spies) spy.mockRestore(); } };
}

/** A relay whose `gated`th question waits until released. */
function gatedRelay(gated: number) {
  const asked = deferred();
  const release = deferred();
  const answer = relay();
  let calls = 0;
  const fetch = (async (input: string | URL | Request) => {
    calls += 1;
    if (calls === gated) {
      asked.resolve();
      await release.promise;
    }
    return answer(input);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked, release };
}

function savedState(stateDir: string): unknown {
  return JSON.parse(readFileSync(join(stateDir, "portal", "state.json"), "utf8"));
}

describe("recovering Portal", () => {
  it("recovers exactly once after a ready child exits", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const identityPath = join(stateDir, "portal", "identity.json");
    const portal = standIn();
    const gate = gatedRelay(2);
    const service = new PortalService({ stateDir, bin: portal.path, fetch: gate.fetch });
    service.authorize(() => open);
    const watch = observe(service);
    try {
      const ready = watch.when(() => watch.internals.url !== null, "the first Portal was ready");
      expect(service.start({ relay: RELAY, port: 7317, ...open })).toBe("started");
      await ready;
      const [first] = watch.exposes;
      const identity = readFileSync(identityPath, "utf8");
      const recovering = watch.when(() => watch.internals.phase === "recovering", "the recovery began");
      process.kill(first!, "SIGUSR1");
      await recovering;
      await bounded(gate.asked.promise, "the relay was asked again");
      expect(await service.status(open)).toMatchObject({ phase: "recovering", url: null, error: null, relay: RELAY });
      expect(watch.exposes).toEqual([first!]);

      const replaced = watch.when(() => watch.internals.url !== null, "the replacement was ready");
      gate.release.resolve();
      await replaced;
      const [, second] = watch.exposes;
      expect(watch.exposes).toHaveLength(2);
      // the old child was gone before the new one was spawned
      expect(watch.earlierGone).toEqual([true, true]);
      expect(alive(first!)).toBe(false);
      expect(await service.status(open)).toMatchObject({ phase: "running", url: ADDRESS, relay: RELAY, error: null });
      const seen = portal.seen();
      const flag = (name: string) => seen[seen.indexOf(name) + 1];
      expect(flag("--relays")).toBe(RELAY);
      expect(flag("--http-route")).toBe("/=7317");
      expect(flag("--identity-path")).toBe(identityPath);
      expect(readFileSync(identityPath, "utf8")).toBe(identity);
      expect(savedState(stateDir)).toEqual({ enabled: true, relay: RELAY, port: 7317, pid: second, auth: NO_PORTAL_AUTH });
      // the replacement's pid was saved before its address was shown
      expect(watch.events.indexOf(`save:${second}`)).toBeGreaterThan(watch.events.indexOf(`spawn:${second}`));
      expect(watch.events.indexOf(`save:${second}`)).toBeLessThan(watch.events.indexOf(`url:${second}`));
      expect(watch.phases).toEqual(["idle", "starting", "running", "recovering", "running"]);

      const failed = watch.when(() => watch.internals.phase === "error", "the replacement's exit was an error");
      process.kill(second!, "SIGUSR1");
      await failed;
      const status = await service.status(open);
      expect(status).toMatchObject({ phase: "error", url: null });
      expect(status.error).toContain("again after one restart (exit 3)");
      // no third launch was begun: two expose processes at most for one start
      expect(watch.launches).toHaveLength(2);
      expect(watch.exposes).toHaveLength(2);
      expect(portal.pids()).toEqual(watch.exposes);
    } finally {
      gate.release.resolve();
      watch.dispose();
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });

  it("does not restart a child that never reached ready", async () => {
    const portal = standIn({ ready: false, exitAfter: true, says: "2026-10-11T00:00:00Z ERR listener closed" });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    service.authorize(() => open);
    const watch = observe(service);
    try {
      const failed = watch.when(() => watch.internals.phase === "error", "the start ended");
      service.start({ relay: RELAY, port: 7317, ...open });
      await failed;
      const status = await service.status(open);
      expect(status.error).toContain("Portal stopped on its own (exit 3).");
      expect(status.error).toContain("listener closed");
      expect(status.url).toBeNull();
      expect(watch.launches).toHaveLength(1);
      expect(portal.pids()).toHaveLength(1);
    } finally {
      watch.dispose();
    }
  });

  it("cancels recovery when stopped during relay verification", async () => {
    // the relaunch held at each of its waits: the relay, the version, the proof that no leftover runs
    for (const hold of ["relay", "version", "proof"] as const) {
      for (const action of ["stop", "shutdown"] as const) {
        const stateDir = mkdtempSync(join(root, "state-"));
        const portal = standIn();
        const gate = gatedRelay(hold === "relay" ? 2 : 0);
        const service = new PortalService({ stateDir, bin: portal.path, fetch: gate.fetch });
        service.authorize(() => open);
        const watch = observe(service);
        const held = deferred();
        const release = deferred();
        const internals = service as unknown as Internals;
        const version = internals.version.bind(service);
        const stopLeftover = internals.stopLeftover.bind(service);
        let fresh = 0;
        let proofs = 0;
        const versionSpy = spyOn(internals, "version").mockImplementation(async (isFresh) => {
          if (isFresh && ++fresh === 2 && hold === "version") { held.resolve(); await release.promise; }
          return version(isFresh);
        });
        const proofSpy = spyOn(internals, "stopLeftover").mockImplementation(async (pid) => {
          if (++proofs === 2 && hold === "proof") { held.resolve(); await release.promise; }
          return stopLeftover(pid);
        });
        try {
          const ready = watch.when(() => watch.internals.url !== null, "Portal was ready");
          service.start({ relay: RELAY, port: 7317, ...open });
          await ready;
          const [first] = watch.exposes;
          process.kill(first!, "SIGUSR1");
          await bounded(hold === "relay" ? gate.asked.promise : held.promise, `the relaunch held at the ${hold}`);
          expect(watch.internals.phase).toBe("recovering");
          const stopped = action === "stop" ? (service.stop(), Promise.resolve()) : service.shutdown();
          gate.release.resolve();
          release.resolve();
          await bounded(stopped, `${action} settled`);
          await bounded(watch.launches[1]!, "the cancelled relaunch settled");
          expect(watch.exposes).toEqual([first!]);
          expect(await service.status(open)).toMatchObject({ phase: "idle", url: null, error: null });
          // a stop is remembered as off; a shutdown leaves the choice for the next server
          expect(savedState(stateDir)).toEqual({ enabled: action === "shutdown", relay: RELAY, port: 7317, pid: first, auth: NO_PORTAL_AUTH });
        } finally {
          gate.release.resolve();
          release.resolve();
          versionSpy.mockRestore();
          proofSpy.mockRestore();
          watch.dispose();
          await bounded(service.shutdown(), "Portal shutdown settled");
        }
      }
    }
  });

  it("rechecks exposure and saved identity before recovery", async () => {
    interface Case { name: string; at: "exit" | "spawn"; change: (context: { guards: typeof open; stateDir: string; identityPath: string; authorize: boolean }) => void; says: string }
    const rewrite = (stateDir: string, change: Record<string, unknown>) => {
      const path = join(stateDir, "portal", "state.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...change }));
    };
    const cases: Case[] = [
      { name: "no recovery authority", at: "exit", change: (c) => { c.authorize = false; }, says: "no authority" },
      { name: "token removed", at: "exit", change: (c) => { c.guards.tokenSet = false; }, says: "OVIS_TOKEN" },
      { name: "token removed before the spawn", at: "spawn", change: (c) => { c.guards.tokenSet = false; }, says: "OVIS_TOKEN" },
      { name: "serve-only", at: "exit", change: (c) => { c.guards.serveOnly = true; }, says: "OVIS_TAILSCALE_SERVE_ONLY" },
      { name: "serve-only before the spawn", at: "spawn", change: (c) => { c.guards.serveOnly = true; }, says: "OVIS_TAILSCALE_SERVE_ONLY" },
      { name: "saved port changed", at: "exit", change: (c) => rewrite(c.stateDir, { port: 7318 }), says: "saved state changed" },
      { name: "saved relay changed before the spawn", at: "spawn", change: (c) => rewrite(c.stateDir, { relay: "https://other.example" }), says: "saved state changed" },
      { name: "saved pid taken over before the spawn", at: "spawn", change: (c) => rewrite(c.stateDir, { pid: 987654321 }), says: "saved state changed" },
      { name: "saved sign-in loosened", at: "exit", change: (c) => rewrite(c.stateDir, { auth: credential() }), says: "sign-in settings" },
      { name: "saved sign-in changed before the spawn", at: "spawn", change: (c) => rewrite(c.stateDir, { auth: credential("mallory") }), says: "sign-in settings" },
      { name: "saved sign-in removed", at: "exit", change: (c) => rewrite(c.stateDir, { auth: { method: "none", allow: [], issuer: null, client_id: null } }), says: "sign-in settings" },
      { name: "identity changed", at: "exit", change: (c) => writeFileSync(c.identityPath, '{"other":true}'), says: "identity file" },
      { name: "identity removed before the spawn", at: "spawn", change: (c) => rmSync(c.identityPath), says: "identity file" },
    ];
    for (const testCase of cases) {
      const stateDir = mkdtempSync(join(root, "state-"));
      const context = { guards: { ...open }, stateDir, identityPath: join(stateDir, "portal", "identity.json"), authorize: true };
      const portal = standIn();
      const service = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
      const watch = observe(service);
      const internals = service as unknown as Internals;
      const stopLeftover = internals.stopLeftover.bind(service);
      const held = deferred();
      const release = deferred();
      let proofs = 0;
      // the last wait before a relaunch spawns: what changes during it is seen
      const proofSpy = spyOn(internals, "stopLeftover").mockImplementation(async (pid) => {
        if (++proofs === 2 && testCase.at === "spawn") { held.resolve(); await release.promise; }
        return stopLeftover(pid);
      });
      service.authorize(() => context.authorize ? context.guards : (undefined as unknown as typeof open));
      try {
        const ready = watch.when(() => watch.internals.url !== null, `${testCase.name}: Portal was ready`);
        service.start({ relay: RELAY, port: 7317, auth: credential("alice"), ...open });
        await ready;
        const [first] = watch.exposes;
        const failed = watch.when(() => watch.internals.phase === "error", `${testCase.name}: the recovery was refused`);
        if (testCase.at === "exit") testCase.change(context);
        process.kill(first!, "SIGUSR1");
        if (testCase.at === "spawn") {
          await bounded(held.promise, `${testCase.name}: the relaunch reached its last wait`);
          testCase.change(context);
          release.resolve();
        }
        await failed;
        const status = await service.status(open);
        expect(status.url).toBeNull();
        expect(status.error).toContain("Portal stopped on its own (exit 3). It was not restarted:");
        expect(status.error).toContain(testCase.says);
        expect(watch.exposes).toEqual([first!]);
        expect(watch.events.filter((event) => event.startsWith("url:"))).toEqual([`url:${first}`]);
      } finally {
        release.resolve();
        proofSpy.mockRestore();
        watch.dispose();
        await bounded(service.shutdown(), `${testCase.name}: Portal shutdown settled`);
      }
    }
  });

  it("kills a replacement whose PID cannot be recorded", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const service = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    service.authorize(() => open);
    let refuse = false;
    const watch = observe(service, { refuseSave: () => refuse });
    try {
      const ready = watch.when(() => watch.internals.url !== null, "Portal was ready");
      service.start({ relay: RELAY, port: 7317, ...open });
      await ready;
      const [first] = watch.exposes;
      refuse = true;
      const failed = watch.when(() => watch.internals.phase === "error", "the unrecorded replacement failed");
      process.kill(first!, "SIGUSR1");
      await failed;
      const [, second] = watch.exposes;
      expect(second).toBeNumber();
      // stopped and awaited before the failure was told; its address was never read, let alone shown
      expect(alive(second!)).toBe(false);
      expect(watch.events).not.toContain(`url:${second}`);
      expect(watch.internals.child).toBeNull();
      const status = await service.status(open);
      expect(status).toMatchObject({ phase: "error", url: null });
      expect(status.error).toContain("could not record its process");
      // the saved record still names the pid it had, and no more were started
      expect(savedState(stateDir)).toEqual({ enabled: true, relay: RELAY, port: 7317, pid: first, auth: NO_PORTAL_AUTH });
      expect(watch.exposes).toHaveLength(2);
      expect(watch.launches).toHaveLength(2);
    } finally {
      watch.dispose();
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });

  it("resets recovery on an explicit new start and boot resume", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const service = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    service.authorize(() => open);
    const watch = observe(service);
    const crashAndRecover = async (what: string) => {
      const pid = watch.internals.child!.pid;
      const back = watch.when(() => watch.internals.url !== null && watch.internals.child?.pid !== pid, `${what}: the replacement was ready`);
      process.kill(pid, "SIGUSR1");
      await back;
    };
    try {
      let ready = watch.when(() => watch.internals.url !== null, "Portal was ready");
      service.start({ relay: RELAY, port: 7317, ...open });
      await ready;
      await crashAndRecover("the first start");
      const idle = watch.when(() => watch.internals.phase === "idle", "Portal stopped");
      service.stop();
      await idle;
      ready = watch.when(() => watch.internals.url !== null, "Portal was ready again");
      expect(service.start({ relay: RELAY, port: 7317, ...open })).toBe("started");
      await ready;
      await crashAndRecover("the explicit new start");
      expect(watch.exposes).toHaveLength(4);
      expect(watch.launches).toHaveLength(4);
    } finally {
      watch.dispose();
      await bounded(service.shutdown(), "Portal shutdown settled");
    }

    // the shutdown kept the choice: the next server resumes it with a recovery of its own
    const next = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    next.authorize(() => open);
    const nextWatch = observe(next);
    try {
      const ready = nextWatch.when(() => nextWatch.internals.url !== null, "the resumed Portal was ready");
      await next.resume({ port: 7317, ...open });
      await ready;
      const pid = nextWatch.internals.child!.pid;
      const back = nextWatch.when(() => nextWatch.internals.url !== null && nextWatch.internals.child?.pid !== pid, "the resumed Portal recovered");
      process.kill(pid, "SIGUSR1");
      await back;
      expect(nextWatch.exposes).toHaveLength(2);
      expect(await next.status(open)).toMatchObject({ phase: "running", url: ADDRESS });
    } finally {
      nextWatch.dispose();
      await bounded(next.shutdown(), "the resumed Portal shutdown settled");
    }
    expect(portal.pids()).toHaveLength(6);
  });
});

describe("the Portal endpoint", () => {
  const url = "http://127.0.0.1:7317/api/portal";
  const own = { "x-herdr-update": "1", origin: "http://127.0.0.1:7317", "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const server = { port: 7317, ...open };
  const post = (action: string, body: unknown = { relay: "relay.example" }, headers: Record<string, string> = own) =>
    new Request(`${url}/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
  const code = async (response: Response) => (await response.json() as { error: { code: string } }).error.code;

  it("answers the status without caching, and offers nothing without the service", async () => {
    const response = await handlePortalRequest(new Request(url), "/api/portal", undefined, server);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ supported: false });
    expect(await code(await handlePortalRequest(post("stop"), "/api/portal/stop", undefined, server))).toBe("portal_unsupported");
  });

  it("starts and stops Portal only for this app's own controls, and starts it only with a token", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    for (const headers of [{ ...own, "x-herdr-update": "0" }, { ...own, origin: "https://evil.example" }, { ...own, "sec-fetch-site": "cross-site" }]) {
      expect(await code(await handlePortalRequest(post("start", undefined, headers), "/api/portal/start", service, server))).toBe("invalid_portal_request");
    }
    for (const relayInput of ["http://relay.example", "relay.example,evil.example"]) {
      expect(await code(await handlePortalRequest(post("start", { relay: relayInput }), "/api/portal/start", service, server))).toBe("invalid_relay");
    }
    expect(await code(await handlePortalRequest(post("start"), "/api/portal/start", service, { ...server, tokenSet: false }))).toBe("token_required");
    expect(await code(await handlePortalRequest(post("start"), "/api/portal/start", service, { ...server, serveOnly: true }))).toBe("serve_only");
    expect(portal.pids()).toEqual([]);

    expect((await handlePortalRequest(post("start"), "/api/portal/start", service, server)).status).toBe(202);
    expect(await until(service, (s) => s.phase !== "starting", "Portal was ready")).toMatchObject({ phase: "running", relay: RELAY });
    expect((await handlePortalRequest(post("stop", {}), "/api/portal/stop", service, server)).status).toBe(202);
    await until(service, (s) => s.phase === "idle", "Portal stopped");
    expect((await handlePortalRequest(new Request(url, { method: "DELETE" }), "/api/portal", service, server)).status).toBe(405);
    expect((await handlePortalRequest(post("install"), "/api/portal/install", service, server)).status).toBe(405);
  });

  it("answers recovering without an address, refuses a start meanwhile and lets Stop end it", async () => {
    const portal = standIn();
    const gate = gatedRelay(2);
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: gate.fetch });
    service.authorize(() => open);
    const watch = observe(service);
    const status = async () => await (await handlePortalRequest(new Request(url), "/api/portal", service, server)).json() as PortalStatus;
    try {
      const ready = watch.when(() => watch.internals.url !== null, "Portal was ready");
      expect((await handlePortalRequest(post("start"), "/api/portal/start", service, server)).status).toBe(202);
      await ready;
      expect(await status()).toMatchObject({ phase: "running", url: ADDRESS });
      process.kill(watch.exposes[0]!, "SIGUSR1");
      await bounded(gate.asked.promise, "the relaunch asked the relay");
      expect(await status()).toMatchObject({ phase: "recovering", url: null, error: null, relay: RELAY });
      expect(await code(await handlePortalRequest(post("start"), "/api/portal/start", service, server))).toBe("portal_busy");
      expect((await handlePortalRequest(post("stop", {}), "/api/portal/stop", service, server)).status).toBe(202);
      gate.release.resolve();
      await bounded(watch.launches[1]!, "the cancelled relaunch settled");
      expect(await status()).toMatchObject({ phase: "idle", url: null, error: null });
      expect(watch.exposes).toHaveLength(1);
    } finally {
      gate.release.resolve();
      watch.dispose();
      await bounded(service.shutdown(), "Portal shutdown settled");
    }
  });
});
