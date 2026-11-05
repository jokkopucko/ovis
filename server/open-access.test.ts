import { afterAll, beforeAll, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { DeviceStore } from "./devices.ts";
import { forgetAuthAttempts } from "./auth.ts";
import { PortalService } from "./portal.ts";

/**
 * The access gate at the HTTP seam: what this PC needs to reach, and what a watching
 * device does not. `decideAccess` itself (loopback, Tailscale, token, device, open mode)
 * is covered in server/access.test.ts, and pairing initiation in server/devices.test.ts.
 */

const root = mkdtempSync(join(tmpdir(), "herdr-open-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("this PC, with no token and no configuration", () => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  let rejectionListeners = 0;
  beforeAll(() => {
    forgetAuthAttempts();
    rejectionListeners = process.listenerCount("unhandledRejection");
    server = createServer({ port: 0, stateDir: root });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop());

  it("leaves an unhandled rejection to Bun, which exits so the supervisor sees the crash", () => {
    expect(process.listenerCount("unhandledRejection")).toBe(rejectionListeners);
  });

  it("is let in with nothing set up: the local-dev path", async () => {
    expect((await fetch(`${base}/api/devices`)).status).toBe(200);
    const started = await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1" } });
    expect(started.status).toBe(200);
    expect((await started.json() as { code: string }).code).toMatch(/^\d{6}$/);
    // the gate is still open to strangers here: nothing is paired and no token exists,
    // which is why the address is refused outside this PC (server/access.ts)
    expect(new DeviceStore(root).gated).toBe(false);
  });
});

describe("a paired watch device", () => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  let cookie: string;
  let interactCookie: string;
  beforeAll(() => {
    // paired before the server starts, so its own store holds the device
    const devices = new DeviceStore(root);
    const paired = devices.pair(devices.startPairing().code, "Watch", "watch")!;
    expect(devices.match(paired.token)).not.toBeNull();
    cookie = `ovis_device=${encodeURIComponent(paired.token)}`;
    // and one that may drive, for what the watcher is refused
    const driver = devices.pair(devices.startPairing().code, "Driver", "drive")!;
    interactCookie = `ovis_device=${encodeURIComponent(driver.token)}`;
    server = createServer({ port: 0, stateDir: root });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop());

  const asWatcher = (path: string, method = "GET") => fetch(`${base}${path}`, {
    method,
    headers: { cookie, origin: base, "x-herdr-machine": "1", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
  });

  it("is refused an agent's commands for a folder before any read, on this PC's path and the proxy's; a driving device gets them", async () => {
    // a folder with one Codex skill: its description is file text the terminal never showed
    const folder = join(root, "commands-folder");
    mkdirSync(join(folder, ".codex", "skills", "watch-sentinel"), { recursive: true });
    writeFileSync(join(folder, ".codex", "skills", "watch-sentinel", "SKILL.md"), "---\nname: watch-sentinel\ndescription: SENTINEL-NEVER-FOR-A-WATCHER\n---\nBody.\n");
    for (const path of ["/api/agent/commands", "/api/machines/local/agent/commands"]) {
      const refused = await asWatcher(`${path}?agent=codex&cwd=${encodeURIComponent(folder)}`);
      expect(refused.status).toBe(403);
      const body = await refused.text();
      expect(JSON.parse(body).error.code).toBe("read_only");
      expect(body).not.toContain("SENTINEL");
      // a folder that is not there would answer invalid_cwd after a read: the refusal comes before any
      const unread = await asWatcher(`${path}?agent=codex&cwd=${encodeURIComponent(join(root, "never-made"))}`);
      expect(unread.status).toBe(403);
      expect((await unread.json() as { error: { code: string } }).error.code).toBe("read_only");
    }
    for (const path of ["/api/agent/commands", "/api/machines/local/agent/commands"]) {
      const listed = await fetch(`${base}${path}?agent=codex&cwd=${encodeURIComponent(folder)}`, { headers: { cookie: interactCookie, origin: base } });
      expect(listed.status).toBe(200);
      expect((await listed.json() as { commands: { name: string; description: string }[] }).commands).toContainEqual(expect.objectContaining({ name: "watch-sentinel", description: "SENTINEL-NEVER-FOR-A-WATCHER" }));
    }
  });

  it("keeps the filesystem, the directory listing and push/test out of reach", async () => {
    // its own credentials are a preference of that device, so signing out keeps working
    expect((await asWatcher("/api/auth", "DELETE")).status).toBe(204);
    // the filesystem and the directory listing are shape the terminal never shows it
    expect((await asWatcher("/api/fs/file?path=/etc/hostname")).status).toBe(403);
    expect((await asWatcher("/api/workspace/directories?cwd=/tmp")).status).toBe(403);
    expect((await asWatcher("/api/machines/local/workspace/directories?cwd=/tmp")).status).toBe(403);
    // nor make a folder there
    expect((await asWatcher("/api/workspace/directories", "POST")).status).toBe(403);
    expect((await asWatcher("/api/machines/local/workspace/directories", "POST")).status).toBe(403);
    // sending an alert is not a preference: it makes the server POST somewhere
    expect((await asWatcher("/api/push/test", "POST")).status).toBe(403);
    // watching is the role's whole point
    expect((await asWatcher("/api/devices")).status).toBe(200);
  });

  it("is refused a pane read outside the enums, and the route's own method check", async () => {
    const read = await asWatcher("/api/pane/read?pane_id=w9999:p9999&source=bogus");
    expect(read.status).toBe(400);
    expect((await read.json() as { error: { code: string } }).error.code).toBe("invalid_source");
    const format = await asWatcher("/api/pane/read?pane_id=w9999:p9999&format=markdown");
    expect((await format.json() as { error: { code: string } }).error.code).toBe("invalid_format");
    // the same check on this PC, where the method is the only thing wrong
    const posted = await fetch(`${base}/api/pane/read?pane_id=w9999:p9999&source=visible`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1" } });
    expect(posted.status).toBe(400);
    expect((await posted.json() as { error: { code: string } }).error.code).toBe("method_not_allowed");
  });

  it("keeps its own session's paths open with no Origin, and refuses every other mutation that carries one", async () => {
    // A cookie-bearing client that cannot state an origin — a non-browser one, or a WS
    // handshake — keeps the endpoints its own session needs, while every other mutation is
    // now read as cross-site rather than same-origin.
    const read = () => fetch(`${base}/api/pane/read?pane_id=w9999:p9999&source=visible`, { method: "POST", headers: { cookie } });
    expect((await read()).status).toBe(403);
    expect((await (await read()).json() as { error: { code: string } }).error.code).toBe("invalid_origin");
    // the custom mutation header is that client's proof, and it still passes the origin gate:
    // what answers next is this device's own role, not the origin check
    const cli = await fetch(`${base}/api/pane/read?pane_id=w9999:p9999&source=visible`, { method: "POST", headers: { cookie, "x-herdr-machine": "1" } });
    expect(cli.status).toBe(403);
    expect((await cli.json() as { error: { code: string } }).error.code).toBe("read_only");
  });

  it("refuses an agent's folder commands to a watcher however the path is spelled, here and through another PC", async () => {
    const folder = encodeURIComponent(root);
    for (const path of ["/api/agent/commands", "/api/machines/m1/agent/commands"]) {
      const response = await fetch(`${base}${path}?agent=claude&cwd=${folder}`, { headers: { cookie, origin: base } });
      expect(response.status, path).toBe(403);
      expect((await response.json() as { error: { code: string } }).error.code, path).toBe("read_only");
    }
    // a trailing slash or an empty segment is no route at all, for anyone (nonCanonicalPath)
    for (const path of ["/api/agent/commands/", "/api/machines/m1/agent/commands/", "/api/agent//commands", "/api/machines/m1//agent/commands", "/api/machines//m1/agent/commands", "/api/machines/m1/agent/commands///"]) {
      const response = await fetch(`${base}${path}?agent=claude&cwd=${folder}`, { headers: { cookie, origin: base } });
      expect(response.status, path).toBe(404);
      expect((await response.json() as { error: { code: string } }).error.code, path).toBe("not_found");
    }
    // an encoded slash names no route here or on another PC: nothing is listed, to the watcher or anyone
    for (const path of ["/api/agent%2Fcommands", "/api/agent%2fcommands/", "/api/machines/m1/agent%2Fcommands", "/api/machines/m1%2Fagent/commands"]) {
      for (const who of [cookie, interactCookie]) {
        const response = await fetch(`${base}${path}?agent=claude&cwd=${folder}`, { headers: { cookie: who, origin: base } });
        expect(response.status, path).toBeGreaterThanOrEqual(400);
        expect(await response.text(), path).not.toContain('"commands"');
      }
    }
    // the device that may drive still reads them
    expect((await fetch(`${base}/api/agent/commands?agent=claude&cwd=${folder}`, { headers: { cookie: interactCookie, origin: base } })).status).toBe(200);
  });

});
describe("a token set: guessing it", () => {
  const TOKEN = "the-right-token-for-this-test";
  let server: ReturnType<typeof createServer>;
  let base: string;
  const stateDir = mkdtempSync(join(root, "token-"));
  let watchToken = "";
  beforeAll(() => {
    forgetAuthAttempts();
    // a held answer is a wait of one second: the clock stands still, so a slow run cannot outlast it
    setSystemTime(Date.now());
    // paired before the server starts, so its own store holds the device
    const store = new DeviceStore(stateDir);
    watchToken = store.pair(store.startPairing().code, "Watch", "watch")!.token;
    expect(store.match(watchToken)).not.toBeNull();
    server = createServer({ port: 0, stateDir, token: TOKEN });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => { server.stop(); setSystemTime(); });
  const devices = (bearer: string, via?: string): Promise<Response> =>
    fetch(`${base}/api/devices`, { headers: { authorization: `Bearer ${bearer}`, ...(via ? { "x-forwarded-for": via } : {}) } });

  it("holds a run of wrong Bearer tokens back on every route, not only the sign-in form", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await devices(`wrong-${attempt}`, "100.64.0.1")).status).toBe(401);
    // inside the wait even the right token is not compared, so a guess learns nothing
    const held = await devices(TOKEN, "100.64.0.1");
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("counts guesses that arrive together", async () => {
    const statuses = (await Promise.all(Array.from({ length: 12 }, (_, attempt) => devices(`together-${attempt}`, "100.64.0.4")))).map((response) => response.status);
    expect(statuses.filter((status) => status === 401).length).toBe(5);
    expect(statuses.filter((status) => status === 429).length).toBe(7);
  });

  it("counts a paired watch device's guesses, so it cannot guess its way up to drive", async () => {
    const watcher = (bearer: string): Promise<Response> => fetch(`${base}/api/push/test`, {
      method: "POST",
      headers: { cookie: `ovis_device=${encodeURIComponent(watchToken)}`, authorization: `Bearer ${bearer}`, origin: base, "content-type": "application/json", "x-forwarded-for": "100.64.0.5" },
      body: "{}",
    });
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await watcher(`guess-${attempt}`)).status).toBe(403);
    // inside its wait the right token is not compared: the device stays a watcher
    expect((await watcher(TOKEN)).status).toBe(403);
  });

  it("keeps each visitor behind a proxy on this PC apart, by the address the proxy saw", async () => {
    expect((await devices(TOKEN, "100.64.0.2")).status).toBe(200);
  });

  it("lets the owner sign in while their cookie's wait runs, and the sign-in spends it", async () => {
    const cookie = { cookie: "ovis_token=stale-token", "x-forwarded-for": "100.64.0.3" };
    for (let attempt = 0; attempt < 6; attempt += 1) await fetch(`${base}/api/health`, { headers: cookie });
    const signIn = await fetch(`${base}/api/auth`, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-forwarded-for": "100.64.0.3" }, body: JSON.stringify({ token: TOKEN }) });
    expect(signIn.status).toBe(204);
    expect((await devices(TOKEN, "100.64.0.3")).status).toBe(200);
  });
});

describe("a Portal that signs its visitors in", () => {
  const TOKEN = "the-token-only-the-owner-holds";
  const HOST = "herdr-test-0123.relay.example";
  const servers: ReturnType<typeof createServer>[] = [];
  afterAll(() => { for (const server of servers) server.stop(); });

  // a portal that lists the sign-in flags, notes the proof in its environment, says it is ready and runs until stopped
  const dir = mkdtempSync(join(root, "bin-"));
  const bin = join(dir, "portal");
  const noted = join(dir, "proof");
  writeFileSync(bin, [
    "#!/bin/sh",
    'case "$1" in',
    "  version) echo v2.6.1 ;;",
    "  expose)",
    `    [ "$2" = --help ] && { printf '%s\\n' '  -auth string' '  -auth-allow value' '  -auth-identity-headers' '  -auth-identity-proof string'; exit 0; }`,
    `    printf '%s' "\${AUTH_IDENTITY_PROOF-}" > '${noted}'`,
    "    id=''; previous=''; for arg in \"$@\"; do [ \"$previous\" = --identity-path ] && id=\"$arg\"; previous=\"$arg\"; done",
    "    [ -f \"$id\" ] || echo '{}' > \"$id\"",
    "    trap 'exit 0' TERM",
    `    echo 'INF service ready at https://${HOST}:443'`,
    "    while :; do sleep 0.05; done ;;",
    `  auth) echo "Redeem URL: https://$3/_portal/auth/login#credential=a-link" ;;`,
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);
  const relay = (async () => Response.json({ data: { release_version: "v2.6.1" } })) as unknown as typeof fetch;
  const credential = { method: "credential", allow: [] };

  /** a server whose Portal can be started on a sign-in, and asked for the proof it was given */
  function serving(recheckMs?: number, savedDrive = false) {
    const stateDir = mkdtempSync(join(root, "portal-"));
    if (savedDrive) {
      mkdirSync(join(stateDir, "portal"));
      writeFileSync(join(stateDir, "portal", "state.json"), JSON.stringify({
        enabled: false, relay: "relay.example", port: null, pid: null, auth: credential,
        invites: [{ name: "alice", role: "drive" }],
      }));
    }
    const service = new PortalService({ stateDir, bin, fetch: relay, ...(recheckMs === undefined ? {} : { recheckMs }) });
    const server = createServer({ port: 0, stateDir, token: TOKEN, portal: service });
    servers.push(server);
    const main = `http://127.0.0.1:${server.port}`;
    const owner = { authorization: `Bearer ${TOKEN}` };
    const post = (action: string, body: unknown) => fetch(`${main}/api/portal/${action}`, { method: "POST", headers: { ...owner, "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    const phase = async () => ((await (await fetch(`${main}/api/portal`, { headers: owner })).json()) as { phase: string }).phase;
    const until = async (want: string) => {
      const deadline = Date.now() + 10_000;
      while ((await phase()) !== want) {
        if (Date.now() > deadline) throw new Error(`Timed out: Portal was ${want}`);
        await Bun.sleep(20);
      }
    };
    return {
      server, main, owner, post, stateDir, service,
      /** starts Portal and returns the proof it was given, or "" when it was given none */
      async start(auth: unknown): Promise<string> {
        rmSync(noted, { force: true });
        expect((await post("start", { relay: "relay.example", auth })).status).toBe(202);
        await until("running");
        return readFileSync(noted, "utf8");
      },
      async stop(): Promise<void> {
        expect((await post("stop", {})).status).toBe(202);
        await until("idle");
      },
    };
  }
  /** what Portal sends with a visitor it vouches for: the visitor's Host kept, Forwarded-Proto https, the identity and the proof */
  const identity = { host: HOST, "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9", "x-portal-user": "alice", "x-portal-auth": "credential" };
  const health = async (base: string, headers: Record<string, string>) => ((await (await fetch(`${base}/api/health?scope=bridge`, { headers })).json()) as { auth: unknown }).auth;
  const signedIn = { required: false, authenticated: true, via: "portal", role: "watch", portal: { user: "alice", method: "credential" } };
  const refused = { authenticated: false, reason: "token_required" };

  it("does not consult invitation roles for an unproven identity", async () => {
    const portal = serving();
    const roles = spyOn(portal.service, "roleFor");
    try {
      expect(await health(portal.main, { ...identity, "x-portal-proof": "forged" })).toMatchObject(refused);
      expect(roles).not.toHaveBeenCalled();
    } finally {
      roles.mockRestore();
    }
  });

  it("refuses pairing redemption by a saved-drive visitor without creating a device or spending the owner's code", async () => {
    const portal = serving(undefined, true);
    const visitor = { ...identity, "x-portal-proof": await portal.start(credential) };
    expect(await health(portal.main, visitor)).toMatchObject({ via: "portal", role: "drive" });
    const start = () => fetch(`${portal.main}/api/devices/pair/start`, {
      method: "POST", headers: { ...portal.owner, "x-herdr-machine": "1" },
    });
    const issued = await start();
    expect(issued.status).toBe(200);
    const { code } = await issued.json() as { code: string };
    const redeem = (headers: Record<string, string>, code: string) => fetch(`${portal.main}/api/devices/pair`, {
      method: "POST", headers: { ...headers, origin: `https://${HOST}`, "content-type": "application/json" }, body: JSON.stringify({ code }),
    });
    const denied = await redeem(visitor, code);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "owner_only" } });
    expect(denied.headers.get("set-cookie")).toBeNull();
    const listed = await fetch(`${portal.main}/api/devices`, { headers: portal.owner });
    expect(await listed.json()).toMatchObject({ devices: [] });
    // The same Portal headers do not restrict a request authenticated by the owner's token.
    const owner = await redeem({ ...visitor, ...portal.owner }, code);
    expect(owner.status).toBe(204);
    const cookie = owner.headers.getSetCookie().find((value) => value.startsWith("ovis_device="))?.split(";")[0];
    expect(cookie).toBeDefined();
    if (!cookie) throw new Error("Pairing did not return a device cookie");
    // A paired driving device takes precedence too.
    const next = await start();
    expect(next.status).toBe(200);
    const nextCode = await next.json() as { code: string };
    expect((await redeem({ ...visitor, cookie }, nextCode.code)).status).toBe(204);
  });

  it("refuses relay controls to a saved-drive visitor, so a relay offer cannot pair a device", async () => {
    const portal = serving(undefined, true);
    const visitor = { ...identity, "x-portal-proof": await portal.start(credential) };
    expect(await health(portal.main, visitor)).toMatchObject({ via: "portal", role: "drive" });
    for (const target of ["/api/relay/offer", "/api/relay/reset-identity", "/api/relay/stop"]) {
      const denied = await fetch(`${portal.main}${target}`, {
        method: "POST", headers: { ...visitor, origin: `https://${HOST}`, "x-herdr-update": "1" },
      });
      expect(denied.status, target).toBe(403);
      expect(await denied.json()).toMatchObject({ error: { code: "owner_only" } });
    }
  });

  it("refuses push status before handling a Portal visitor's subscription", async () => {
    const portal = serving();
    const visitor = { ...identity, "x-portal-proof": await portal.start(credential), "content-type": "application/json" };
    const status = (headers: Record<string, string>) => fetch(`${portal.main}/api/push/status`, {
      method: "POST", headers, body: "{}",
    });
    const denied = await status(visitor);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "owner_only" } });
    // The owner still reaches input validation in the push handler.
    const owner = await status({ ...visitor, ...portal.owner });
    expect(owner.status).toBe(400);
    expect(await owner.json()).toMatchObject({ error: { code: "invalid_subscription" } });
  });

  it("lets an invited visitor watch with no token, while the owner's setup credential still drives", async () => {
    const portal = serving();
    const proof = await portal.start(credential);
    expect((await portal.post("invite", { name: "alice", days: 30, role: "drive" })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(portal.stateDir, "portal", "state.json"), "utf8"))).toMatchObject({ invites: [{ name: "alice", role: "watch" }] });
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    const vouched = { ...identity, "x-portal-proof": proof, "x-portal-role": "drive" };
    expect(await health(portal.main, vouched)).toEqual(signedIn);
    expect((await fetch(`${portal.main}/api/devices`, { headers: vouched })).status).toBe(200);
    // the proof is nowhere the app answers
    for (const path of ["/api/portal", "/api/access", "/api/health"]) {
      expect(await (await fetch(`${portal.main}${path}`, { headers: { ...portal.owner, ...vouched } })).text()).not.toContain(proof);
    }
    // the token still means the token, and without either it is refused
    expect(await health(portal.main, { ...vouched, ...portal.owner })).toMatchObject({ via: "token", role: "drive" });
    expect(await health(portal.main, {})).toMatchObject(refused);
  });

  it("says a request Portal vouched for came through Portal, the token's and a paired device's too, and no request without the proof", async () => {
    const portal = serving();
    const vouched = { ...identity, "x-portal-proof": await portal.start(credential) };
    const ingress = async (headers: Record<string, string>) =>
      ((await (await fetch(`${portal.main}/api/health?scope=bridge`, { headers })).json()) as { security?: { observed_ingress: string } }).security?.observed_ingress;
    expect(await ingress({ ...vouched, ...portal.owner })).toBe("portal");
    expect(await ingress(vouched)).toBe("portal");
    expect(await ingress({ ...identity, "x-portal-proof": "0".repeat(64), ...portal.owner })).toBe("proxy");
  });

  it("believes nothing of those headers without the proof, from loopback or through another proxy, whatever Host or forwarding headers come with them", async () => {
    const portal = serving();
    const proof = await portal.start(credential);
    const ignored = async (headers: Record<string, string>) => {
      expect((await fetch(`${portal.main}/api/devices`, { headers })).status).toBe(401);
      expect(await health(portal.main, headers)).toMatchObject(refused);
    };
    // another proxy on this PC, a tagged tailscale serve or a local client typing the identity
    await ignored(identity);
    await ignored({ ...identity, host: `127.0.0.1:${new URL(portal.main).port}` });
    await ignored({ ...identity, host: "pc.tail5cc90b.ts.net" });
    await ignored({ "x-portal-user": "alice", "x-portal-auth": "credential" });
    // a proof that is wrong, in any way: other, shorter, longer, in another case, empty, twice
    for (const given of ["0".repeat(64), proof.slice(1), proof.slice(0, -1), `${proof}0`, proof.toUpperCase(), "", `${proof}, ${proof}`]) {
      await ignored({ ...identity, "x-portal-proof": given });
    }
    // the proof alone says nothing of who it is for
    await ignored({ host: HOST, "x-portal-proof": proof });
    expect((await fetch(`${portal.main}/api/devices`, { headers: portal.owner })).status).toBe(200);
  });

  it("ignores values Portal does not make, even with the proof", async () => {
    const portal = serving();
    const vouched = { ...identity, "x-portal-proof": await portal.start(credential) };
    for (const headers of [{ ...vouched, "x-portal-user": "" }, { ...vouched, "x-portal-auth": "saml" }, { ...vouched, "x-portal-auth": "siwe" }, { ...vouched, "x-portal-user": "a".repeat(261) }]) {
      expect(await health(portal.main, headers)).toMatchObject(refused);
    }
  });

  it("believes nothing while its Portal runs no sign-in, and nothing when it has no Portal", async () => {
    const portal = serving();
    expect(await portal.start(undefined)).toBe("");
    const guess = { ...identity, "x-portal-proof": "a".repeat(64) };
    expect(await health(portal.main, guess)).toMatchObject(refused);
    // not even the empty proof a Portal without one was started with
    expect(await health(portal.main, { ...identity, "x-portal-proof": "" })).toMatchObject(refused);
    const stateDir = mkdtempSync(join(root, "portal-"));
    const alone = createServer({ port: 0, stateDir, token: TOKEN });
    servers.push(alone);
    expect(await health(`http://127.0.0.1:${alone.port}`, guess)).toMatchObject(refused);
  });

  it("stops believing a proof when its Portal stops, and a Portal started again has a proof of its own", async () => {
    const portal = serving();
    const first = await portal.start(credential);
    const vouched = (proof: string) => ({ ...identity, "x-portal-proof": proof });
    expect(await health(portal.main, vouched(first))).toEqual(signedIn);
    await portal.stop();
    expect(await health(portal.main, vouched(first))).toMatchObject(refused);
    const second = await portal.start(credential);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(await health(portal.main, vouched(second))).toEqual(signedIn);
    expect(await health(portal.main, vouched(first))).toMatchObject(refused);
    // and a Portal started without a sign-in after one with it does not take the old proof either
    await portal.stop();
    await portal.start(undefined);
    expect(await health(portal.main, vouched(second))).toMatchObject(refused);
  });

  it("serves the terminal's WebSocket to what carries the proof, and refuses it without", async () => {
    const portal = serving();
    const proof = await portal.start(credential);
    const open = (headers: Record<string, string>) => new Promise<WebSocket | null>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${new URL(portal.main).port}/ws`, { headers } as unknown as string[]);
      socket.onopen = () => resolve(socket);
      // a refused upgrade ends in a close, with or without an error
      socket.onclose = () => resolve(null);
      socket.onerror = () => resolve(null);
    });
    expect(await open(identity)).toBeNull();
    const socket = (await open({ ...identity, "x-portal-proof": proof }))!;
    expect(socket).not.toBeNull();
    const exchange = (sent: object, type: string) => new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { socket.removeEventListener("message", receive); reject(new Error(`No ${type} frame`)); }, 4000);
      const receive = (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type !== type || (type === "error" && frame.code !== "read_only")) return;
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
        resolve(frame);
      };
      socket.addEventListener("message", receive);
      socket.send(JSON.stringify(sent));
    });
    try {
      expect(await exchange({ type: "ping", id: 7 }, "pong")).toEqual({ type: "pong", id: 7 });
      expect(await exchange({ type: "role", mode: "interact" }, "role-ack")).toMatchObject({ mode: "observe" });
      expect(await exchange({ type: "input", pane_id: "not-a-real-pane", text: "whoami\n" }, "error")).toMatchObject({ code: "read_only" });
    } finally {
      socket.close();
    }
  });

  it("ends a visitor's WebSocket after a while, so its reconnect meets Portal's sign-in again, and leaves the owner's open", async () => {
    // Portal checks its sign-in on each request, so a link that expires or a sign-out ends a visitor's HTTP at once;
    // a socket opened before that would otherwise watch the terminals for as long as it stays open
    const portal = serving(300);
    const proof = await portal.start(credential);
    const port = new URL(portal.main).port;
    const open = (headers: Record<string, string>) => new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers } as unknown as string[]);
      socket.onopen = () => resolve(socket);
      socket.onerror = () => reject(new Error("the upgrade was refused"));
    });
    const owner = await open({ ...portal.owner, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` });
    const ownerClosed = new Promise<void>((resolve) => owner.addEventListener("close", () => resolve()));
    const visitor = await open({ ...identity, "x-portal-proof": proof });
    const visitorClosed = new Promise<number>((resolve) => visitor.addEventListener("close", (event) => resolve(event.code)));
    const code = await Promise.race([visitorClosed, Bun.sleep(3_000).then(() => "still open" as const)]);
    expect(code).toBe(1000);
    expect(owner.readyState).toBe(WebSocket.OPEN);
    owner.close();
    await ownerClosed;
    // the PCs' event stream too: it ends, and the page opens it again through Portal
    const events = await fetch(`${portal.main}/api/machines/events`, { headers: { ...identity, "x-portal-proof": proof } });
    expect(events.status).toBe(200);
    const drained = events.body!.pipeTo(new WritableStream()).then(() => "ended" as const, () => "ended" as const);
    expect(await Promise.race([drained, Bun.sleep(3_000).then(() => "still open" as const)])).toBe("ended");
  });

  it("does not let a visitor it signed in use the app's controls to decide who else gets in or leave access behind, while the owner's token may", async () => {
    const portal = serving();
    const proof = await portal.start(credential);
    expect((await portal.post("invite", { name: "alice", days: 30 })).status).toBe(200);
    const visitor = { ...identity, "x-portal-proof": proof, "x-herdr-update": "1", "x-herdr-machine": "1", "content-type": "application/json" };
    const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
      fetch(`${portal.main}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const code = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;
    // what outlives the link or lets others in: links, Portal's own controls, pairing, revoking and push alerts
    const standing: [string, string, unknown?][] = [
      ["POST", "/api/portal/invite", { name: "alice", days: 30 }],
      ["POST", "/api/portal/stop", {}],
      ["POST", "/api/portal/start", { relay: "relay.example", auth: credential }],
      ["POST", "/api/devices/pair/start", {}],
      ["POST", "/api/devices/revoke-all", {}],
      ["PATCH", "/api/devices/0123456789abcdef", { label: "mine" }],
      ["DELETE", "/api/devices/0123456789abcdef"],
      ["POST", "/api/push/subscribe", { subscription: { endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" } } }],
      ["POST", "/api/pane/input", { pane_id: "not-a-real-pane", text: "whoami\n" }],
      ["POST", "/api/workspace/create", { cwd: portal.stateDir }],
      ["POST", "/api/machines/local/pane/input", { pane_id: "not-a-real-pane", text: "whoami\n" }],
      ["POST", "/api/machines/remote/pane/input", { pane_id: "not-a-real-pane", text: "whoami\n" }],
      ["GET", "/api/fs/file?path=/etc/passwd"],
    ];
    for (const [method, path, body] of standing) {
      const refused = await send(method, path, visitor, body);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await code(refused), `${method} ${path}`).toBe(path === "/api/push/subscribe" ? "owner_only" : "read_only");
    }
    // Safe reads stay open, but a visitor cannot upgrade itself by redeeming a pairing code.
    expect((await send("GET", "/api/devices", visitor)).status).toBe(200);
    expect((await send("GET", "/api/portal", visitor)).status).toBe(200);
    const redeemed = await send("POST", "/api/devices/pair", visitor, { code: "000000" });
    expect(redeemed.status).toBe(403);
    expect(await code(redeemed)).toBe("read_only");
    // none of that touched Portal
    expect(((await (await send("GET", "/api/portal", portal.owner)).json()) as { phase: string }).phase).toBe("running");
    // the same requests without the proof are no visitor at all
    const { "x-portal-proof": _proof, ...anonymous } = visitor;
    expect((await send("POST", "/api/portal/invite", anonymous, { name: "alice", days: 30 })).status).toBe(401);
    // the owner's token may
    const ownerHeaders = { ...portal.owner, "x-herdr-update": "1", "x-herdr-machine": "1", "content-type": "application/json" };
    const issued = await send("POST", "/api/portal/invite", ownerHeaders, { name: "alice", days: 30 });
    expect(issued.status).toBe(200);
    expect(((await issued.json()) as { redeem_url: string }).redeem_url).toBe(`https://${HOST}/_portal/auth/login#credential=a-link`);
    expect((await send("POST", "/api/devices/pair/start", ownerHeaders, {})).status).toBe(200);
  });
});
