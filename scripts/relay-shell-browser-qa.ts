/**
 * The hosted shell in a real browser against a real PC: dist-shell/ served as Cloudflare Pages
 * would serve it (pages-static.ts) under its enforced policy, a real `createServer` on the
 * isolated herdr test session with its relay turned on, and the Bun relay (relay/bun.ts) between
 * them.
 *
 * The shell accepts only a wss: relay, and the PC's server only a wss: relay origin, so both name
 * `wss://relay.test`: the server's outbound sockets reach the local relay through the service's
 * `connect` seam, and the browser's through Playwright's WebSocket routing, bridged here frame by
 * frame to the same relay.
 *
 * The sign-in screen and the signed-in Add a PC need the account service, which the shell offers on app.ovis.sh alone
 * (lib/account/service.ts shellAccountServiceOf): that part routes https://app.ovis.sh to the same built shell and
 * https://account.ovis.sh to the in-memory account service (shared/account-service-fake.ts), which its PCs use too.
 *
 * Headless Chrome has no push service: each PC's server pushes to a fake one (server/push.fake.ts,
 * which decrypts what it gets as a browser would), and the page's PushManager hands over that
 * fake's subscription for its PC's scope.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import type { BunRelay } from "../relay/bun.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { startFakePushService } from "../server/push.fake.ts";
import type { FakePushService } from "../server/push.fake.ts";
import { shellContentSecurityPolicy } from "../server/static.ts";
import { REGIONAL_APPS } from "../shared/relay-regions.ts";
import type { UpdateService } from "../server/update-api.ts";
import { MIN_SERVER_VERSION } from "../shared/relay-mux.ts";
import { noInstalledNotes, noUpdateNotes, INSTALL_ID } from "../shared/update.ts";
import type { UpdateRequest, UpdateStatus } from "../shared/update.ts";
import { version as shellVersion } from "../package.json";
import { exportPublicKey, generateKeyPair, openDaemonSecureChannel } from "../shared/relay-e2ee.ts";
import type { SecureChannel, Transport } from "../shared/relay-e2ee.ts";
import { encodeFrame, FrameType } from "../shared/relay-mux.ts";
import { decodeOffer, encodeOffer } from "../shared/relay-offer.ts";
import type { RelayOffer } from "../shared/relay-offer.ts";
import { ADMISSION_MS, ASSIGNMENT_MS, PC_ANSWER_MS } from "../src/lib/relay/channel.ts";
import { chromePath } from "./chrome-path.ts";
import { assertCspClean, watchCsp } from "./csp-violations.ts";
import type { CspWatch } from "./csp-violations.ts";
import { servePagesSite } from "./pages-static.ts";
import { relayBrowserSocket, relayServerTree } from "./relay-browser-bridge.ts";
import { closeMarked, whileOpen } from "./relay-qa-teardown.ts";
import type { RelayServerTree } from "./relay-browser-bridge.ts";
import { relayShellQaVersions } from "./relay-shell-qa-versions.ts";
import { openSettingsFolds, openSettingsPage } from "./settings-page.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import { answerServerChallenge, deriveServerId } from "../shared/relay-server-proof.ts";

export async function defaultStep2BrowserQa({ createServer }: RelayServerTree): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-default-step2-qa-"));
  const prior = process.env["OVIS_ACCOUNT_OPENS_ALL"];
  delete process.env["OVIS_ACCOUNT_OPENS_ALL"];
  try {
    const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null,
      sidecar: false, accountService: { url: "off" } });
    try {
      const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await page.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
        await page.goto(`http://127.0.0.1:${app.port}`);
        await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
        const lockState = () => page.waitForResponse(response => new URL(response.url()).pathname === "/api/account/lock" && response.request().method() === "GET");
        const unbound = lockState();
        await openSettingsPage(page, "Devices and PCs");
        assert.ok((await unbound).status() >= 400);
        assert.equal(await page.locator(".strict-mode").count(), 0);
        assert.equal(await page.getByText("Strict mode needs this PC signed in to an Ovis account.", { exact: true }).count(), 0);
        app.context.services.devices.bindByService("acct_browser_qa");
        await page.reload();
        await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
        await openSettingsPage(page, "Devices and PCs");
        // one row of More settings, its switch; what it ends is named once it is turned on
        await openSettingsFolds(page);
        await page.getByRole("switch", { name: "Strict mode (Linux)", exact: true }).waitFor();
        console.log("default Step 2: only the bound PC offers to turn on strict mode");
      } finally { await closeMarked(browser); }
    } finally { await app.stop(); }
  } finally {
    if (prior === undefined) delete process.env["OVIS_ACCOUNT_OPENS_ALL"];
    else process.env["OVIS_ACCOUNT_OPENS_ALL"] = prior;
    rmSync(stateDir, { recursive: true, force: true });
  }
}

export async function relayShellQa(tree: RelayServerTree): Promise<void> {
  if (resolve(tree.dir) === resolve(import.meta.dir, "..")) await defaultStep2BrowserQa(tree);
  // The remaining cross-version paths require direct pairing, without PC fingerprint confirmation.
  const prior = process.env["OVIS_ACCOUNT_OPENS_ALL"];
  process.env["OVIS_ACCOUNT_OPENS_ALL"] = "0";
  try { await legacyRelayShellQa(tree); }
  finally {
    if (prior === undefined) delete process.env["OVIS_ACCOUNT_OPENS_ALL"];
    else process.env["OVIS_ACCOUNT_OPENS_ALL"] = prior;
  }
}

async function legacyRelayShellQa(tree: RelayServerTree): Promise<void> {
  const { createServer, RelayService } = tree;
  const repo = join(import.meta.dir, "..");
  const evidence = process.env["UI_EVIDENCE_DIR"] || null;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const keep = (name: string, text: string): void => { if (evidence) writeFileSync(join(evidence, name), text); };
  const shot = async (page: Page, name: string): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `task-16-${name}.png`) }); };

  const RELAY = "wss://relay.test";
  const OTHER_KEY = generateKeyPair().publicKey;
  const OTHER_ID = deriveServerId(OTHER_KEY);

  function deferred<T>() {
    let resolve = (_value: T): void => {};
    let reject = (_error: unknown): void => {};
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  async function bounded<T>(promise: Promise<T>, what: string, ms = 20_000): Promise<T> {
    const late = deferred<T>();
    const timer = setTimeout(() => late.reject(new Error(`${what}: not within ${ms} ms`)), ms);
    try { return await Promise.race([promise, late.promise]); } finally { clearTimeout(timer); }
  }

  // Many reconnect scenarios share one loopback address and deliberately exceed production's minute budget.
  const relayOptions = { port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } };
  let relay: BunRelay | null = startBunRelay(relayOptions);
  let relayPort = relay.port;
  const relayUrl = (url: string): string => { const target = new URL(url); return `ws://127.0.0.1:${relayPort}${target.pathname}${target.search}`; };
  let synced = deferred<void>();
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-shell-qa-"));
  const herdrConfigPath = join(stateDir, "config.toml");
  writeFileSync(herdrConfigPath, "[ui]\ncopy_on_select = true\n");
  const dataSockets = new Set<WebSocket>();
  const socketsChanged = new EventTarget();
  const service = new RelayService({ stateDir, relay: RELAY, connect: (url) => {
    const socket = new WebSocket(relayUrl(url));
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve();
    });
    const counted = (): void => {
      dataSockets.add(socket);
      socketsChanged.dispatchEvent(new Event("change"));
      socket.addEventListener("close", () => { dataSockets.delete(socket); socketsChanged.dispatchEvent(new Event("change")); });
    };
    if (new URL(url).searchParams.has("connection_id")) counted();
    // a warm socket is a phone's connection from the moment the relay binds it to one
    else if (new URL(url).searchParams.has("warm")) {
      socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"bound"')) counted(); });
    }
    return socket;
  } });
  const pcConnections = (count: number, what: string): Promise<void> => bounded(new Promise<void>((resolve) => {
    const check = (): void => { if (dataSockets.size === count) { socketsChanged.removeEventListener("change", check); resolve(); } };
    socketsChanged.addEventListener("change", check);
    check();
  }), what);
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, relay: service, pushLoopbackHttp: true, herdrConfigPath });
  const base = `http://127.0.0.1:${app.port}`;
  const devices = app.context.services.devices;
  const relayApi = (path: string) => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
  const startPcRelay = async (): Promise<void> => {
    synced = deferred<void>();
    const response = await relayApi("/start");
    const body = await response.text();
    assert.equal(response.status, 200, `relay start: ${body}`);
    await bounded(synced.promise, "the PC's control socket synced with the relay");
    assert.equal(service.status().phase, "online");
  };
  const stopPcRelay = async (): Promise<void> => {
    assert.equal((await relayApi("/stop")).status, 200);
    assert.equal(service.status().phase, "off");
  };
  const restartRelay = async (): Promise<void> => {
    synced = deferred<void>();
    relay = startBunRelay(relayOptions);
    relayPort = relay.port;
    await bounded(synced.promise, "the PC reconnected to the restarted relay", 45_000);
  };

  const shellDir = mkdtempSync(join(tmpdir(), "ovis-relay-shell-qa-site-"));
  const built = Bun.spawnSync([process.execPath, "--bun", join(repo, "node_modules/.bin/vite"), "build", "--mode", "shell", "--outDir", shellDir, "--emptyOutDir", "--logLevel", "warn"], { cwd: repo, stdout: "inherit", stderr: "inherit" });
  if (built.exitCode !== 0) throw new Error(`the shell build failed with exit code ${built.exitCode}`);
  const hostRequests: string[] = [];
  const site = servePagesSite(shellDir, 0, "127.0.0.1", (request) => {
    const url = new URL(request.url);
    const referer = request.headers.get("referer");
    hostRequests.push(`${request.method} ${url.pathname}${url.search}${referer ? ` referer=${referer}` : ""}`);
  });
  const origin = `http://127.0.0.1:${site.port}`;

  const serverOffer = async (name = "Desk PC"): Promise<RelayOffer> => {
    const response = await relayApi("/offer");
    const body = await response.text();
    assert.equal(response.status, 200, `offer: ${body}`);
    const offer = decodeOffer((JSON.parse(body) as { url: string }).url);
    if (!offer) throw new Error("the PC gave no offer");
    return { ...offer, name };
  };
  const offerUrl = (offer: RelayOffer): string => encodeOffer(offer, origin);
  const scopeOf = (serverId: string): string => `${origin}/s/${serverId}/`;

  interface BridgeSocket { url: string; assigned: Promise<void>; pcAnswered: Promise<void>; answeredRelay: Promise<void>; answeredPc: Promise<void> }
  class Bridge {
    mode: "carry" | "hold" | "silent" = "carry";
    release = deferred<void>();
    readonly sockets: BridgeSocket[] = [];
    private readonly waiters: ((socket: BridgeSocket) => void)[] = [];
    private readonly pending: BridgeSocket[] = [];
    opened(socket: BridgeSocket): void {
      this.sockets.push(socket);
      const waiter = this.waiters.shift();
      if (waiter) waiter(socket); else this.pending.push(socket);
    }
    next(): Promise<BridgeSocket> {
      const ready = this.pending.shift();
      return ready ? Promise.resolve(ready) : new Promise((resolve) => this.waiters.push(resolve));
    }
  }

  async function bridgeRelay(context: BrowserContext, bridge: Bridge): Promise<void> {
    await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => {
      const assigned = deferred<void>();
      const pcAnswered = deferred<void>();
      const answeredRelay = deferred<void>();
      const answeredPc = deferred<void>();
      bridge.opened({ url: ws.url(), assigned: assigned.promise, pcAnswered: pcAnswered.promise, answeredRelay: answeredRelay.promise, answeredPc: answeredPc.promise });
      if (bridge.mode === "silent") return;
      let frames = 0;
      let sent = 0;
      relayBrowserSocket(ws, () => relayUrl(ws.url()), () => {
        frames += 1;
        if (frames === 1) assigned.resolve(); else pcAnswered.resolve();
      }, bridge.mode === "hold" ? bridge.release.promise : undefined, () => {
        sent += 1;
        if (sent === 1) answeredRelay.resolve(); else answeredPc.resolve();
      });
    });
  }

  async function scriptedPc(behaviour: "refuse" | "stall", name: string) {
    const keys = generateKeyPair();
    const serverId = deriveServerId(keys.publicKey);
    const proofQuery = `proof=1&public_key=${bytesToHex(keys.publicKey)}`;
    const sockets: WebSocket[] = [];
    const dataFor = (connectionId: string): void => {
      const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/ws?server_id=${serverId}&role=server&connection_id=${connectionId}&v=1&${proofQuery}`);
      socket.binaryType = "arraybuffer";
      sockets.push(socket);
      const transport: Transport = {
        onmessage: null, onclose: null, onerror: null,
        send: (data) => { socket.send(data); }, close: (code, reason) => socket.close(code, reason),
      };
      let proved = false;
      socket.onmessage = (event) => {
        if (!proved) {
          const answer = answerServerChallenge(event.data, keys.secretKey, { server_id: serverId, role: "data", connection_id: connectionId });
          assert.ok(answer, "scripted PC received its proof challenge");
          proved = true;
          socket.send(answer);
          return;
        }
        transport.onmessage?.({ data: event.data as string | ArrayBuffer, isBinary: typeof event.data !== "string" });
      };
      socket.onclose = (event) => transport.onclose?.(event.code, event.reason);
      let channel: SecureChannel | undefined;
      let incoming = Promise.resolve();
      const opening = openDaemonSecureChannel(transport, { daemonKeyPair: keys, events: {
        onmessage: () => {
          if (behaviour === "stall") return;
          incoming = incoming.then(async () => {
            await opening;
            await channel?.send(encodeFrame({ type: FrameType.SESSION_ERROR, flags: 0, stream_id: 0,
              payload: { code: "unsupported_version", message: "This PC speaks another relay protocol" } }).slice().buffer);
          }).catch(() => socket.close());
        },
      } }).then((opened) => { channel = opened; return opened; });
      opening.catch(() => socket.close());
    };
    const control = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/ws?server_id=${serverId}&role=server&v=1&${proofQuery}`);
    sockets.push(control);
    control.onmessage = (event) => {
      const answer = answerServerChallenge(event.data, keys.secretKey, { server_id: serverId, role: "control", connection_id: null });
      if (answer) { control.send(answer); return; }
      const value = JSON.parse(String(event.data)) as { type: string; connection_id?: string; connection_ids?: string[] };
      if (value.type === "sync") for (const id of value.connection_ids ?? []) dataFor(id);
      else if (value.type === "connected" && value.connection_id) dataFor(value.connection_id);
    };
    await bounded(new Promise<void>((resolve, reject) => { control.onopen = () => resolve(); control.onerror = () => reject(new Error("scripted PC: relay refused")); }), "scripted PC control socket");
    const offer: RelayOffer = { v: 1, server_id: serverId, server_public_key: exportPublicKey(keys.publicKey), relay: RELAY, code: "123456", name };
    return { offer, serverId, stop: () => { for (const socket of sockets) socket.close(); } };
  }

  const stateDir2 = mkdtempSync(join(tmpdir(), "ovis-relay-shell-qa-2-"));
  let synced2 = deferred<void>();
  const service2 = new RelayService({ stateDir: stateDir2, relay: RELAY, connect: (url) => {
    const socket = new WebSocket(relayUrl(url));
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string" && event.data.includes('"sync"')) synced2.resolve();
    });
    return socket;
  } });
  const app2 = createServer({ port: 0, hostname: "127.0.0.1", stateDir: stateDir2, token: "", tailscaleOwner: null, sidecar: false, relay: service2, pushLoopbackHttp: true });
  const base2 = `http://127.0.0.1:${app2.port}`;
  const fakes: FakePushService[] = [];

  const fakePushManager = async (context: BrowserContext, subscriptions: Record<string, FakePushService["subscription"]>): Promise<void> => {
    await context.addInitScript((subscriptions) => {
      const id = /^\/s\/([0-9a-f]{32})\//.exec(location.pathname)?.[1];
      if (id === undefined || subscriptions[id] === undefined) return;
      const held = `qa-push:${id}`;
      const current = (): { endpoint: string; keys: { p256dh: string; auth: string } } => {
        const rotated = localStorage.getItem(`qa-push-json:${id}`);
        return rotated === null ? subscriptions[id]! : JSON.parse(rotated) as { endpoint: string; keys: { p256dh: string; auth: string } };
      };
      const bytes = (key: BufferSource): number[] => [...new Uint8Array(ArrayBuffer.isView(key) ? key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) : key)];
      const made = (key: number[], json = current()) => ({
        endpoint: json.endpoint, expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: new Uint8Array(key).buffer },
        toJSON: () => ({ endpoint: json.endpoint, expirationTime: null, keys: json.keys }),
        unsubscribe: async () => { localStorage.removeItem(held); return true; },
      });
      PushManager.prototype.getSubscription = async function () {
        const key = localStorage.getItem(held);
        return (key === null ? null : made(JSON.parse(key) as number[])) as unknown as PushSubscription;
      };
      PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
        const key = bytes(options!.applicationServerKey as BufferSource);
        localStorage.setItem(held, JSON.stringify(key));
        return made(key) as unknown as PushSubscription;
      };
      const settings = JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as Record<string, unknown>;
      localStorage.setItem("ovis:settings", JSON.stringify({ ...settings, alertsOn: true }));
    }, subscriptions);
  };

  let browser: Browser | undefined;
  const csp: CspWatch[] = [];
  const report: string[] = [];
  const started = Date.now();
  const note = (line: string): void => { report.push(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`); };

  interface Seeded { server_id: string; server_public_key: string; name: string; device_id?: string }
  /** Saved PCs, written as lib/relay/device.ts writes them, with a real non-extractable key. */
  const seed = async (page: Page, entries: Seeded[]): Promise<void> => {
    await page.evaluate(async (entries) => {
      const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("ovis-relay", 2);
        request.onupgradeneeded = () => {
          for (const name of ["devices", "pending-push"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "server_id" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("devices", "readwrite");
        for (const entry of entries) {
          tx.objectStore("devices").put({ ...entry, relay: "wss://relay.test", device_id: entry.device_id ?? "stale-device", private_key: keys.privateKey, public_spki: "spki", label: "QA phone" });
        }
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    }, entries);
  };
  const saved = (page: Page, serverId: string): Promise<{ device_id: string | null; enrollment: string | null } | null> => page.evaluate(async (serverId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ovis-relay", 2);
      request.onupgradeneeded = () => {
        for (const name of ["devices", "pending-push"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "server_id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ device_id: string | null; enrollment: string | null } | null>((resolve, reject) => {
        const request = db.transaction("devices", "readonly").objectStore("devices").get(serverId);
        request.onsuccess = () => resolve(request.result ? { device_id: request.result.device_id ?? null, enrollment: request.result.account_enrollment?.state ?? null } : null);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }, serverId);

  interface Opened { context: BrowserContext; page: Page; bridge: Bridge }
  const open = async (options: { width?: number; height?: number; theme?: "dark" | "light"; clock?: boolean; mode?: Bridge["mode"] } = {}): Promise<Opened> => {
    if (!browser) throw new Error("no browser");
    const mobile = (options.width ?? 390) < 600;
    const context = await browser.newContext({ viewport: { width: options.width ?? 390, height: options.height ?? 844 }, colorScheme: options.theme ?? "dark", deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
    const bridge = new Bridge();
    bridge.mode = options.mode ?? "carry";
    await bridgeRelay(context, bridge);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    if (options.clock) {
      const time = new Date("2026-10-30T00:00:00Z");
      await page.clock.install({ time });
      await page.clock.pauseAt(new Date(time.getTime() + 1000));
    }
    // a test that sets qa-language in the tab's sessionStorage reloads in that language
    await page.addInitScript((theme) => localStorage.setItem("ovis:settings", JSON.stringify({ language: sessionStorage.getItem("qa-language") ?? "en", theme })), options.theme ?? "dark");
    csp.push(await watchCsp(page));
    return { context, page, bridge };
  };
  const state = (page: Page, name: string) => page.locator(`main[data-relay-state="${name}"]`);
  const inApp = async (page: Page): Promise<void> => {
    await page.locator(".app").waitFor();
    assert.equal(await page.locator("main[data-relay-state]").count(), 0, "the shell's screen is gone once the app is up");
  };
  const pairedStraightIn = async (page: Page): Promise<void> => {
    await page.locator(".app").waitFor();
    assert.equal(await page.locator('[role=dialog][data-add-pc-phase="ready"]').count(), 0, "no Ready checkpoint stands before the app after a pairing");
  };
  const pairFrom = async (page: Page, offer: RelayOffer): Promise<void> => {
    await page.goto(offerUrl(offer));
    await state(page, "confirm").waitFor();
    await page.getByRole("heading", { name: `Pair with ${offer.name ?? "this PC"}?` }).waitFor();
    assert.ok(!(await page.evaluate(() => location.href)).includes("#offer"), "the offer left the address before the question");
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await state(page, "connecting").waitFor();
  };

  async function accountQa(): Promise<void> {
    const APP = "https://app.ovis.sh";
    const ACCOUNT_SERVICE = "https://account.ovis.sh";
    const ACCT = "acct_github";
    const { FakeAccountService } = await import("../shared/account-service-fake.ts");
    const fake = new FakeAccountService();
    const lines: string[] = [];
    const log9 = (line: string): void => { lines.push(line); note(`account: ${line}`); };
    const shot9 = async (page: Page, name: string): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `task-9-${name}.png`) }); };
    const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> => {
      for (const deadline = Date.now() + ms; !(await check());) {
        if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
        await Bun.sleep(50);
      }
    };
    const accountSeen = new EventTarget();
    const accountRequest = (line: string, what: string): Promise<void> => bounded(new Promise<void>((resolve) => {
      const hear = (event: Event): void => {
        if ((event as CustomEvent<string>).detail !== line) return;
        accountSeen.removeEventListener("request", hear);
        resolve();
      };
      accountSeen.addEventListener("request", hear);
    }), what);
    const capture = async (page: Page, name: string): Promise<void> => {
      const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, inner: window.innerWidth }));
      assert.ok(size.scroll <= size.client && size.inner === size.client, `${name}: no horizontal overflow (${JSON.stringify(size)})`);
      await shot9(page, name);
      log9(`capture ${name}: scrollWidth ${size.scroll} <= clientWidth ${size.client}, innerWidth ${size.inner}`);
    };
    const settledSheet = async (page: Page): Promise<void> => {
      await page.waitForFunction(() => {
        const sheet = document.querySelector("[role=dialog]");
        const finite = document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getTiming().iterations ?? 1));
        return sheet !== null && finite.every((animation) => animation.playState === "finished") && sheet.getBoundingClientRect().bottom <= window.innerHeight + 0.5;
      });
    };

    const pcs9: { stop: () => Promise<void> }[] = [];
    const accountPc = async (name: string) => {
      const dir = mkdtempSync(join(tmpdir(), "ovis-relay-account-qa-"));
      let ready = deferred<void>();
      const pcRelay = new RelayService({ stateDir: dir, relay: RELAY, connect: (url) => {
        const socket = new WebSocket(relayUrl(url));
        socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) ready.resolve(); });
        return socket;
      } });
      const pcHerdrConfig = join(dir, "config.toml");
      writeFileSync(pcHerdrConfig, "[ui]\ncopy_on_select = true\n");
      const pc = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: "", tailscaleOwner: null, sidecar: false, relay: pcRelay, herdrConfigPath: pcHerdrConfig,
        accountService: { url: ACCOUNT_SERVICE, fetch: (request) => fake.fetch(request) } });
      const stop = async (): Promise<void> => { await pcRelay.shutdown(); pc.stop(); rmSync(dir, { recursive: true, force: true }); };
      pcs9.push({ stop });
      const at = `http://127.0.0.1:${pc.port}`;
      const local = (path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) => fetch(`${at}${path}`, {
        method: "POST", headers: { origin: at, "x-herdr-update": "1", "content-type": "application/json", ...options.headers },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      assert.equal((await local("/api/relay/start")).status, 200);
      await bounded(ready.promise, `${name} synced with the relay`);
      const response = await local("/api/relay/offer");
      const body = await response.text();
      assert.equal(response.status, 200, `${name} offer: ${body}`);
      const offer: RelayOffer = { ...decodeOffer((JSON.parse(body) as { url: string }).url)!, name };
      const services = pc.context.services;
      return {
        offer, id: offer.server_id, local, mailbox: services.accountMailbox,
        joined: (): boolean => services.devices.account() === ACCT && !services.accountHolds.enrolling(),
        pairings: async () => (await (await fetch(`${at}/api/relay/pairings`, { headers: { origin: at } })).json() as { pairings: { id: string; digits: string }[] }).pairings,
        resync: (): Promise<void> => { ready = deferred<void>(); return ready.promise; },
        lastSeen: (): string | null => fake.pcs(ACCT).find((entry) => entry.server_id === offer.server_id)?.last_seen_at ?? null,
      };
    };

    const contexts: BrowserContext[] = [];
    const consoleLines: string[] = [];
    /**
     * The PC's own page from its row on My PCs, recording the sheet's phases from its load: its join sheet waits for
     * one press (`confirm`).
     */
    const joinFromFront = async (page: Page, name: string, serverId: string, mode: "new" | "join"): Promise<Locator> => {
      await page.addInitScript(() => {
        const seen: string[] = [];
        Object.assign(window, { qaAddPcPhases: seen });
        const note = (node: Node): void => {
          if (!(node instanceof Element)) return;
          for (const element of [node, ...node.querySelectorAll("[data-add-pc-phase]")]) {
            const phase = element.getAttribute("data-add-pc-phase");
            if (phase !== null && seen.at(-1) !== phase) seen.push(phase);
          }
        };
        new MutationObserver((records) => { for (const record of records) { if (record.type === "attributes") note(record.target); else record.addedNodes.forEach(note); } })
          .observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-add-pc-phase"] });
      });
      await pcLink(page, name).click();
      const sheet = page.locator(`[role=dialog][data-add-pc-mode="${mode}"][data-add-pc-phase="confirm"]`);
      await sheet.waitFor({ timeout: 45_000 });
      assert.equal(new URL(page.url()).pathname, `/s/${serverId}/`, `${mode}: ${name}'s join sheet is on its own page`);
      return sheet;
    };
    /** The sheet's one press: what the page shows from here on is the pairing it started. */
    const pressOnce = async (page: Page, primary: Locator): Promise<void> => {
      await page.evaluate(() => { (window as unknown as { qaAddPcPhases: string[] }).qaAddPcPhases.length = 0; });
      await primary.click();
    };
    const askedOnce = async (page: Page, mode: "new" | "join"): Promise<void> => {
      const seen = await page.evaluate(() => (window as unknown as { qaAddPcPhases: string[] }).qaAddPcPhases);
      assert.ok(!seen.includes("confirm"), `${mode}: one press is the consent, no "Pair with {name}?" step (phases ${seen.join(" -> ")})`);
      assert.equal(seen.at(-1), "compare", `${mode}: the press reached the comparison (phases ${seen.join(" -> ")})`);
      assert.equal(await page.locator(`[role=dialog][data-add-pc-mode="${mode}"]`).getByRole("button", { name: "Pair", exact: true }).count(), 0, `${mode}: no second Pair button`);
    };
    const hosted = async (options: { width: number; height: number; theme: "dark" | "light" }) => {
      if (!browser) throw new Error("no browser");
      const mobile = options.width < 600;
      // the worker would fetch past these routes; the shell runs without one
      const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, colorScheme: options.theme, deviceScaleFactor: mobile ? 3 : 1, isMobile: mobile, hasTouch: mobile, serviceWorkers: "block" });
      contexts.push(context);
      const bridge = new Bridge();
      await bridgeRelay(context, bridge);
      await context.route(/^https:\/\/app\.ovis\.sh\//, whileOpen(context, async (route) => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) });
      }));
      await context.route(/^https:\/\/account\.ovis\.sh\//, async (route) => {
        const request = route.request();
        const cors = { "access-control-allow-origin": APP, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
        if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
        const body = request.postDataBuffer();
        const answer = await fake.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(body === null ? {} : { body }) }));
        // a redirect fulfilled here is followed on the network, past these routes (to the real app.ovis.sh): the sign-in's
        // way back is a new navigation instead, which the app.ovis.sh route serves
        const location = answer.headers.get("location");
        if (answer.status === 302 && location !== null && location.startsWith(`${APP}/`)) {
          await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=${location.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">` });
          accountSeen.dispatchEvent(new CustomEvent("request", { detail: `${request.method()} ${new URL(request.url()).pathname}` }));
          return;
        }
        await route.fulfill({ status: answer.status, headers: { ...Object.fromEntries(answer.headers), ...cors }, body: Buffer.from(await answer.arrayBuffer()) });
        accountSeen.dispatchEvent(new CustomEvent("request", { detail: `${request.method()} ${new URL(request.url()).pathname}` }));
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") consoleLines.push(`${options.width}: ${message.text()}`); });
      await page.addInitScript((theme) => {
        if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
      }, options.theme);
      csp.push(await watchCsp(page));
      return { context, page, bridge, errors };
    };
    const setTheme = async (page: Page, theme: "dark" | "light"): Promise<void> => {
      await page.evaluate((theme) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as object, theme }));
      }, theme);
      await page.emulateMedia({ colorScheme: theme });
      await page.reload();
      await page.waitForFunction((theme) => document.documentElement.dataset["theme"] === theme, theme);
    };
    const front = (page: Page) => page.locator('main.relay-add-screen[data-account-state="signed-in"]');
    const pcLink = (page: Page, name: string) => front(page).locator(".relay-add-saved-pc", { hasText: name });
    // signed out with nothing saved here, the front page is Connect a PC: the connect tabs (the desktop's Add a connection
    // order), the relay's sign-in inside the first
    const signInScreen = async (page: Page): Promise<void> => {
      await page.getByRole("heading", { name: "Connect a PC" }).waitFor();
      assert.deepEqual(await page.locator(".connect-start-tabs > button").evaluateAll((tabs) => tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-pressed")])),
        [["Ovis relay", "true"], ["Tailscale", "false"], ["SSH", "false"]], "the three tabs, Ovis relay chosen");
      assert.equal(await page.locator('[data-tab-panel="relay"]').getByRole("button", { name: "Continue with GitHub" }).count(), 1, "the sign-in is inside the relay tab");
      assert.equal(await page.getByRole("heading", { name: /Sign in to your Ovis account/ }).count(), 0, "no sign-in screen first");
      assert.equal(await page.getByRole("button", { name: "Start without signing in" }).count(), 0);
      assert.equal(await page.locator(".relay-shell-pcs, input").count(), 0, "no code field on the relay tab");
    };
    // Tailscale and SSH (behind Add by address): a PC's address in one field with Connect, no sign-in
    const addressTabs = async (page: Page): Promise<void> => {
      for (const tab of ["tailscale", "ssh"] as const) {
        await page.locator(`.connect-start-tabs > [data-tab="${tab}"]`).click();
        const panel = page.locator(`[data-tab-panel="${tab}"]`);
        await panel.waitFor();
        // a browser has no SSH: its tab is Add by address alone, a text link to the field
        if (tab === "ssh") {
          assert.equal(await panel.locator("input").count(), 0, "ssh: no field before Add by address");
          await panel.getByRole("button", { name: "Add by address", exact: true }).click();
        }
        assert.equal(await panel.locator("input").count(), 1, `${tab}: one address field`);
        assert.equal(await panel.getByRole("button", { name: "Connect", exact: true }).count(), 1, `${tab}: Connect`);
        assert.equal(await panel.locator(".account-provider").count(), 0, `${tab}: no sign-in`);
      }
      await page.locator('.connect-start-tabs > [data-tab="relay"]').click();
    };

    try {
      for (const [width, height] of [[390, 844], [1440, 900]] as const) {
        for (const theme of ["dark", "light"] as const) {
          const { context, page } = await hosted({ width, height, theme });
          await page.goto(`${APP}/`);
          await signInScreen(page);
          assert.equal(await page.getByRole("button", { name: /Continue without an account/ }).count(), 0);
          await capture(page, `signin-${width}-${theme}`);
          await addressTabs(page);
          await closeMarked(context);
        }
      }
      log9("connect tabs: Connect a PC, Ovis relay (chosen, Continue with GitHub inside) / Tailscale / SSH (one address field + Connect each); no sign-in screen first, no Start without signing in");

      const pc1 = await accountPc("Desk PC");
      const A = await hosted({ width: 1440, height: 900, theme: "dark" });
      const a = A.page;
      await a.goto(`${APP}/`);
      await signInScreen(a);
      assert.equal(await a.locator('[data-view="my-pcs"], .relay-add-saved-pc').count(), 0, "no list of PCs before a pairing");

      await a.goto(encodeOffer(pc1.offer, APP));
      await state(a, "confirm").waitFor();
      await a.getByRole("button", { name: "Pair", exact: true }).click();
      await pairedStraightIn(a);
      await inApp(a);
      await a.goto(`${APP}/`);
      // signed out with a PC saved here, the front page is My PCs; the sign-in is on its Add a PC, which a wide screen keeps
      // open beside the list (no Add PC button there)
      await a.locator('main.relay-add-screen[data-account-state="signed-out"] [data-view="my-pcs"]').waitFor();
      assert.equal(await a.locator(".relay-add-saved-pc").getAttribute("href"), `/s/${pc1.id}/`, "My PCs lists the PC this device paired, by its page");
      assert.equal(await a.locator('[data-view="my-pcs"]').getByRole("button", { name: "Continue with GitHub" }).count(), 0, "no sign-in on My PCs itself");
      assert.equal(await a.locator('[data-action="add-pc"]').count(), 0, "at 1440 Add a PC stands open beside My PCs, with no Add PC button");
      await capture(a, "local-1440-dark");
      await a.getByRole("heading", { name: "Add PC" }).waitFor();
      assert.equal(await a.locator('[data-tab-panel="relay"]').getByRole("button", { name: "Continue with GitHub" }).count(), 1, "Add PC's relay tab holds the sign-in");
      log9(`local: paired Desk PC ${pc1.id} by QR through the Bun relay, opened it, back on / (the tab's launch is past, so it stays) -> My PCs lists Desk PC at /s/${pc1.id}/, Add a PC beside it at 1440 holding the sign-in`);

      // the sign-in's return opens the PC this device paired, as a launch does: no list of PCs first. Opening it lists it in
      // the account, as Open on its row did
      assert.deepEqual(fake.pcs(ACCT), [], "the directory is empty before the PC is opened");
      const listed = accountRequest(`PUT /v1/pcs/${pc1.id}`, "the shell listed Desk PC in the account");
      await a.getByRole("button", { name: "Continue with GitHub" }).click();
      await inApp(a);
      assert.equal(new URL(a.url()).pathname, `/s/${pc1.id}/`, "the sign-in's return opened Desk PC");
      await listed;
      log9(`account: GitHub sign-in at the fake service -> back on / -> straight into Desk PC (/s/${pc1.id}/), no list first -> PUT /v1/pcs/${pc1.id}`);
      await until(async () => pc1.joined() && (await saved(a, pc1.id))?.enrollment === "complete", "Desk PC joined the account and this device recorded completion", 75_000);
      await pc1.mailbox.pull();
      const seenDesk = fake.pcs(ACCT).find((entry) => entry.server_id === pc1.id);
      assert.ok(seenDesk, "Desk PC is listed in the account");
      seenDesk.last_seen_at = new Date(Date.now() - 5 * 60_000).toISOString();
      const seenFirst = pc1.lastSeen();
      assert.equal(seenFirst, seenDesk.last_seen_at, "Desk PC's last_seen_at is five minutes ago");
      // signed in, the front page is My PCs, listing Desk PC
      await a.goto(`${APP}/`);
      await pcLink(a, "Desk PC").waitFor();
      await capture(a, "front-signed-in-1440-dark");
      // the old control page's address lands on the app as its bare address does: the hash dropped, the front page drawn
      await a.goto(`${APP}/#overview`);
      await pcLink(a, "Desk PC").waitFor();
      await a.waitForFunction(() => location.hash === "" && location.pathname === "/");
      // so does a load of its own, as a link or bookmark opened from elsewhere (the address set without a hashchange)
      await a.evaluate(() => { history.replaceState(null, "", "/#overview"); });
      await a.reload();
      await pcLink(a, "Desk PC").waitFor();
      await a.waitForFunction(() => location.hash === "" && location.pathname === "/");
      log9(`account: PC joined ${ACCT}, mailbox pull -> last_seen_at ${seenFirst}; / lists Desk PC; /#overview lands on the same front page at /`);

      await relay!.stop();
      relay = null;
      await pc1.mailbox.pull();
      const seenDown = pc1.lastSeen();
      assert.ok(seenDown !== null && Date.parse(seenDown) > Date.parse(seenFirst), `last_seen_at moved on with the relay down (${seenFirst} -> ${seenDown})`);
      assert.deepEqual(A.errors, [], "no page error with the relay gone");
      await capture(a, "relay-stopped-1440-dark");
      await pcLink(a, "Desk PC").click();
      await state(a, "relay-unreachable").waitFor();
      await a.getByRole("heading", { name: "Could not reach this machine" }).waitFor();
      await capture(a, "relay-stopped-open-1440-dark");
      const back = pc1.resync();
      await restartRelay();
      await bounded(back, "Desk PC reconnected to the restarted relay", 45_000);
      await a.getByRole("button", { name: "Try again" }).click();
      await inApp(a);
      log9(`relay stopped: PC pulled again (last_seen_at ${seenDown}), no page error; Desk PC on Add a PC -> relay-unreachable "Could not reach this machine"; relay back -> Try again -> app`);

      const pc2 = await accountPc("Mac mini");
      const own = fake.issueToken(ACCT);
      const put = await fake.fetch(new Request(`${ACCOUNT_SERVICE}/v1/pcs/${pc2.id}`, {
        method: "PUT", headers: { authorization: `Bearer ${own}`, "content-type": "application/json" },
        body: JSON.stringify({ label: "Mac mini", public_key: Buffer.from(pc2.offer.server_public_key, "base64").toString("hex"), relay: RELAY }),
      }));
      assert.equal(put.status, 200, `Mac mini listed itself: ${await put.text()}`);
      assert.equal((await pc2.local("/api/relay/link", { headers: { "x-ovis-local-only": "1" } })).status, 200);
      // #27 (the owner's word): My PCs also lists the account's PCs this device can open (Mac mini listed its key and relay,
      // so its own page joins it), once each
      await a.goto(`${APP}/`);
      await pcLink(a, "Desk PC").waitFor();
      // the account's read landing draws its row: waited for, not timed
      await pcLink(a, "Mac mini").waitFor();
      assert.equal(await pcLink(a, "Mac mini").count(), 1, "the front page lists an account PC this device can open, once");
      assert.equal(await pcLink(a, "Mac mini").locator(".phone-pc-tag").textContent(), "Relay", "tagged as a relay PC");
      await a.goto(`${APP}/#add`);
      // from the front page that is a same-document hash change: the load draws My PCs, as a PC's More opens it
      await a.reload();
      await a.locator('[data-view="my-pcs"] .relay-add-back').waitFor();
      // a PC this device is not let into yet is On like any other: its own page asks for the approval
      await pcLink(a, "Mac mini").locator(".relay-add-saved-note", { hasText: /^On$/ }).waitFor();
      assert.equal(await front(a).getByText("Needs approval").count(), 0, "My PCs never says Needs approval");
      const sheetNew = await joinFromFront(a, "Mac mini", pc2.id, "new");
      await settledSheet(a);
      await capture(a, "sheet-new-1440-dark");
      await pressOnce(a, sheetNew.getByRole("button", { name: "Ask to join" }));
      const typed = a.getByRole("textbox", { name: "Number on Mac mini" });
      await typed.waitFor();
      await askedOnce(a, "new");
      await until(async () => (await pc2.pairings()).length === 1, "Mac mini's own screen shows the comparison");
      const [asked] = await pc2.pairings();
      await settledSheet(a);
      await capture(a, "sheet-typed-1440-dark");
      await typed.fill(asked!.digits);
      await a.locator("[role=dialog]").getByRole("button", { name: "Add this PC" }).click();
      await a.getByText("Approve this device on Mac mini within 90 seconds to finish.").waitFor();
      assert.equal((await pc2.local("/api/relay/pairing", { body: { id: asked!.id, decision: "approve" } })).status, 200);
      await pairedStraightIn(a);
      await inApp(a);
      await until(async () => pc2.joined() && (await saved(a, pc2.id))?.enrollment === "complete", "Mac mini joined the account and this device recorded completion", 75_000);
      await pc2.mailbox.pull();
      await a.goto(`${APP}/`);
      await pcLink(a, "Mac mini").waitFor();
      // Mac mini is this device's own PC now, which it can forget: the ⋮ menu's Forget PCs puts Forget on its row
      assert.equal(await pcLink(a, "Mac mini").count(), 1, "Mac mini is listed once");
      await front(a).locator('[data-action="account-menu"]').click();
      await a.locator('.row-menu [data-item="forget-pcs"], .row-sheet [data-item="forget-pcs"]').click();
      await front(a).locator("li.my-pc", { hasText: "Mac mini" }).locator('[data-action="forget-pc"]').waitFor();
      await front(a).locator('[data-action="forget-done"]').click();
      await front(a).locator("li.my-pc", { hasText: "Mac mini" }).locator("a.relay-add-saved-pc").waitFor();
      log9(`new PC: Mac mini ${pc2.id} listed itself and opened its local-only window -> My PCs (/#add) notes it On -> its own page's sheet (new) -> Ask to join (no confirm step after it, no second Pair) -> typed the ${asked!.digits.length} digits its own screen listed -> approved on the PC -> app -> listed as this device's own`);

      await a.goto(`${APP}/s/${pc1.id}/`);
      await inApp(a);
      const desk = fake.pcs(ACCT).find((entry) => entry.server_id === pc1.id)!;
      desk.added_at = new Date(Date.now() - 11 * 60_000).toISOString();
      const B = await hosted({ width: 390, height: 844, theme: "dark" });
      const b = B.page;
      await b.goto(`${APP}/`);
      await signInScreen(b);
      // #16: the sign-in's launch goes to Desk PC (on, this device not in it yet) and asks to join at once, with no press:
      // one plain screen names the PC and shows the number, with no tabs, no list and no sheet
      // the launch asks the PC this browser opened last first: Desk PC, which the first device has open as a member
      await b.evaluate((id) => localStorage.setItem("ovis-last-pc", id), pc1.id);
      await b.getByRole("button", { name: "Continue with GitHub" }).click();
      const wait = b.locator('[data-approval-wait="pc"]');
      await wait.waitFor({ timeout: 45_000 });
      assert.equal(new URL(b.url()).pathname, `/s/${pc1.id}/`, "the plain wait is on Desk PC's own page");
      await wait.getByRole("heading", { name: "Desk PC" }).waitFor();
      const digits = wait.locator(".relay-shell-digits");
      await digits.waitFor();
      assert.equal(await b.locator(".connect-start-tabs, [data-add-pc-phase], .relay-add-saved-pc").count(), 0, "no tabs, sheet or list while it waits");
      await wait.getByText("Type this number on Desk PC").waitFor();
      await capture(b, "approval-wait-390-dark");
      const shown = (await digits.getAttribute("aria-label"))!.replace(/ /g, "");
      const prompt = a.getByTestId("account-approval");
      await prompt.waitFor();
      assert.deepEqual(await pc1.pairings(), [], "the PC's own windows are shown no prompt for an account join");
      await capture(a, "member-approval-1440-dark");
      await prompt.getByRole("radio", { name: shown.split("").join(" ") }).click();
      await prompt.getByRole("button", { name: "Approve" }).click();
      await pairedStraightIn(b);
      await inApp(b);
      await until(async () => (await pc1.pairings()).length === 0 && pc1.joined() && (await saved(b, pc1.id))?.enrollment === "complete", "Desk PC settled and this device recorded completion after the member's approval", 75_000);
      log9(`account join: Desk PC added 11 min ago, its window closed -> second device (390) signed in -> its launch went to Desk PC and asked to join by itself (plain wait, no tabs, sheet or list) -> showed ${shown.length} digits; the first device (another member, in Desk PC's app) got the prompt with 3 choices and picked them; Desk PC's own GET /api/relay/pairings = []; -> app`);

      // the signed-in front page (My PCs) at both widths and themes, and the pairing dialog a code typed in its Add a PC's
      // relay tab opens (a code that does not read: no lookup goes out), whose Escape closes it and leaves no sheet entry
      for (const [page, width] of [[a, 1440], [b, 390]] as const) {
        for (const theme of ["dark", "light"] as const) {
          await page.goto(`${APP}/`);
          await setTheme(page, theme);
          await pcLink(page, "Desk PC").waitFor();
          await capture(page, `front-${width}-${theme}`);
          // a wide screen keeps Add a PC open beside My PCs; a phone opens it from Add PC
          const desk = width >= 1024;
          if (desk) assert.equal(await front(page).locator('[data-view="add-pc"]').count(), 1, "Add a PC stands open beside My PCs at 1440");
          else await front(page).locator('[data-action="add-pc"]').click();
          // the code is one line that opens its field in place, where it is looked up: a code that does not read says so
          // there and stays to correct (no lookup goes out for it), and Cancel closes the field
          await front(page).locator('[data-tab-panel="relay"] [data-action="add-code"]').click();
          const codeField = front(page).locator('[data-code-form] input[name="code"]');
          await codeField.pressSequentially("ab3de");
          assert.equal(await codeField.inputValue(), "AB3DE-", `the field puts the dash in after five characters (${width}px)`);
          await front(page).locator('[data-code-form] button[type="submit"]').click();
          await front(page).locator('[data-code-form] [role="alert"]').waitFor();
          assert.equal(await codeField.inputValue(), "AB3DE-", `a code that does not read stays in its field to correct (${width}px)`);
          await capture(page, `code-field-${width}-${theme}`);
          await front(page).locator("[data-code-form]").getByRole("button", { name: "Cancel", exact: true }).click();
          await front(page).locator("[data-code-form]").waitFor({ state: "detached" });
          // back to My PCs: on a phone Add a PC's Back (and with it goes its own history entry); beside it at 1440 there is none
          if (!desk) await front(page).locator('[data-view="add-pc"] .relay-add-back').click();
          await pcLink(page, "Desk PC").waitFor();
          await page.waitForFunction(() => !Object.keys(history.state ?? {}).includes("ovis:sheet"));
          // the account is in the ⋮ menu at the top of My PCs: who is signed in, Manage account and Sign out, after
          // Forget PCs (Desk PC is this device's own); a row carries no Forget of its own
          assert.equal(await front(page).locator('[data-action="manage-account"]').count(), 0, "no Manage account link on My PCs");
          assert.equal(await front(page).locator('[data-action="forget-pc"]').count(), 0, `no row carries Forget (${width}px)`);
          await front(page).locator('[data-action="account-menu"]').click();
          const menu = page.locator(".row-menu, .row-sheet");
          await menu.getByText("Signed in with GitHub").waitFor();
          assert.deepEqual(await menu.locator("[data-item]").evaluateAll((items) => items.map((item) => item.getAttribute("data-item"))), ["forget-pcs", "manage-account", "sign-out"], `the account menu holds Forget PCs, Manage account and Sign out (${width}px)`);
          await capture(page, `account-menu-${width}-${theme}`);
          await page.keyboard.press("Escape");
          await menu.waitFor({ state: "detached" });
          // a phone's menu is a sheet with a history entry: its Escape goes back, and the next goto must not cut that short
          await page.waitForFunction(() => !Object.keys(history.state ?? {}).includes("ovis:sheet"));
          // Forget PCs: Forget in the chevron's place on Desk PC, whose row opens nothing, until Done
          await front(page).locator('[data-action="account-menu"]').click();
          await menu.locator('[data-item="forget-pcs"]').click();
          await menu.waitFor({ state: "detached" });
          await front(page).locator("li.my-pc", { hasText: "Desk PC" }).locator('[data-action="forget-pc"]').waitFor();
          assert.equal(await front(page).locator("li.my-pc", { hasText: "Desk PC" }).locator("a.relay-add-saved-pc, .relay-shell-pc-glyph").count(), 0, `Desk PC opens nothing while PCs are being forgotten (${width}px)`);
          await capture(page, `forget-pcs-${width}-${theme}`);
          await front(page).locator('[data-action="forget-done"]').click();
          await front(page).locator("li.my-pc", { hasText: "Desk PC" }).locator("a.relay-add-saved-pc").waitFor();
          await page.waitForFunction(() => !Object.keys(history.state ?? {}).includes("ovis:sheet"));
        }
      }
      // a short desktop window with more PCs than it can hold: each pane scrolls on its own under a mouse wheel, so Pair
      // under an opened code field and the last PC stay within reach of a pointer
      const extra = Array.from({ length: 14 }, (_, index) => ({ server_id: (index + 16).toString(16).repeat(16), server_public_key: "qa-extra-key", name: `QA PC ${index + 1}` }));
      await a.setViewportSize({ width: 1024, height: 400 });
      await seed(a, extra);
      await a.goto(`${APP}/`);
      await pcLink(a, "Desk PC").waitFor();
      await pcLink(a, "QA PC 14").waitFor();
      const listPane = front(a).locator('[data-view="my-pcs"]');
      assert.ok(await listPane.evaluate((pane) => pane.scrollHeight > pane.clientHeight + 100), "My PCs is taller than the 1024x400 window, so its own pane has to scroll");
      await front(a).locator('[data-tab-panel="relay"] [data-action="add-code"]').click();
      const reachable = async (pane: Locator, target: Locator, what: string): Promise<void> => {
        const box = await pane.boundingBox();
        assert.ok(box !== null, `${what}: its pane is drawn`);
        await a.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 120));
        await a.mouse.wheel(0, 4_000);
        await a.waitForFunction((element) => { const rect = element!.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }, await target.elementHandle(), { timeout: 5_000 })
          .catch(() => assert.fail(`${what} is out of reach at 1024x400: the wheel does not bring it into the window`));
        await target.click({ trial: true });
      };
      await reachable(front(a).locator('[data-view="add-pc"]'), front(a).locator('[data-code-form] button[type="submit"]'), "Pair under the opened code field");
      await reachable(listPane, front(a).locator(".relay-add-saved-pc").last(), "the last PC of 16 in My PCs");
      assert.ok(await listPane.evaluate((pane) => pane.scrollTop > 0), "the wheel scrolled My PCs' own pane");
      await capture(a, "short-window-1024x400");
      await a.evaluate(async (ids) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ovis-relay", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        await new Promise<void>((resolve, reject) => { const tx = db.transaction("devices", "readwrite"); for (const id of ids) tx.objectStore("devices").delete(id); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
        db.close();
      }, extra.map((pc) => pc.server_id));
      await a.setViewportSize({ width: 1440, height: 900 });
      assert.deepEqual([...A.errors, ...B.errors], [], "no page error on either device");
      log9("front page: My PCs, its Add a PC's code field (a code that does not read stays to correct, Cancel closes it), the account menu (Forget PCs first) and Forget PCs' edit state at 1440 and 390, dark and light; at 1024x400 with 16 PCs My PCs scrolls on its own, and Pair and the last PC are reached with the wheel; page errors on both devices: none");
      keep("task-9-account.txt", `# relay-shell-browser-qa (n): the sign-in screen and Add a PC on ${APP} (routed to ${origin}), account service ${ACCOUNT_SERVICE} (shared/account-service-fake.ts), PCs on the Bun relay as ${RELAY}\n${lines.join("\n")}\n`);
    } finally {
      keep("task-9-console.txt", `${consoleLines.join("\n")}\n`);
      for (const context of contexts) await closeMarked(context).catch(() => undefined);
      for (const pc of pcs9) await pc.stop();
    }
  }

  try {
    await startPcRelay();
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    const identity = await serverOffer();
    const ID = identity.server_id;
    const scope = scopeOf(ID);

    // The terminal's own preference read must reach the PC, not the static shell host.
    {
      const workspace = await workspaceCreate({ cwd: stateDir, label: "relay-transport-parity" });
      const { context, page } = await open({ width: 1440, height: 900 });
      try {
        const preference = deferred<boolean>();
        const nativeApi: string[] = [];
        page.on("request", (request) => {
          if (new URL(request.url()).origin === origin && new URL(request.url()).pathname === "/api/herdr-ui") nativeApi.push(request.url());
        });
        await page.exposeFunction("qaHerdrUi", (value: boolean) => preference.resolve(value));
        await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
        await page.addInitScript(() => {
          const json = Response.prototype.json;
          Response.prototype.json = async function () {
            const body: unknown = await json.call(this);
            if (typeof body === "object" && body !== null && "copy_on_select" in body && typeof body.copy_on_select === "boolean") {
              const report = Reflect.get(window, "qaHerdrUi");
              await report(body.copy_on_select);
            }
            return body;
          };
        });
        await herdrRpc("pane.send_text", { pane_id: workspace.root_pane.pane_id, text: "printf '\\033[2J\\033[HRELAY_COPY_ON_SELECT\\n'\n" });
        const url = new URL(offerUrl(await serverOffer()));
        url.searchParams.set("pane", workspace.root_pane.pane_id);
        url.searchParams.set("view", "terminal");
        await page.goto(url.href);
        await page.getByRole("button", { name: "Pair", exact: true }).click();
        await pairedStraightIn(page);
        await inApp(page);
        assert.equal(await bounded(preference.promise, "the app consumed the PC's /api/herdr-ui answer"), true);
        assert.deepEqual(nativeApi, [], "/api/herdr-ui never went to the static shell host");
        const terminal = page.locator(".terminal-stack[data-pane-content] .xterm-screen");
        await terminal.waitFor();
        const box = await terminal.boundingBox();
        assert.ok(box);
        await shot(page, "transport-parity");
        await page.evaluate(() => navigator.clipboard.writeText(""));
        await page.mouse.move(box.x + 2, box.y + 8);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 8, box.y + box.height - 8, { steps: 8 });
        await page.mouse.up();
        await page.locator(".terminal-banner", { hasText: "copied to clipboard" }).waitFor();
        assert.match(await page.evaluate(() => navigator.clipboard.readText()), /RELAY_COPY_ON_SELECT/);
        const receipt = "transport parity: app consumed copy_on_select=true from the PC over the relay; zero shell-host /api/herdr-ui requests; terminal drag copied nonempty text";
        keep("fix-transport-parity.txt", `${receipt}\n`);
        note(receipt);
      } finally {
        const paired = await saved(page, ID);
        if (paired?.device_id) devices.revoke(paired.device_id);
        await closeMarked(context);
        await workspaceClose(workspace.workspace.workspace_id);
      }
    }

    // A PC's files, folders and names stay on the phone (#2599): a file opened in the app, in a tab
    // of its own and as a raw file, a link followed in that tab, and a reload of each, while the
    // shell host hears of nothing but the PC's id in the path. Only the page's fragment, which no
    // request carries, says what is open.
    {
      const folder = mkdtempSync(join(tmpdir(), "ovis-relay-private-folder-"));
      writeFileSync(join(folder, "private-notes.md"), "# Private notes\n\nSee [the other notes](other-notes.md).\n");
      writeFileSync(join(folder, "other-notes.md"), "# Other notes\n");
      const workspace = await workspaceCreate({ cwd: folder, label: "Private Plans" });
      const pane = workspace.root_pane.pane_id;
      const { context, page } = await open({ width: 1440, height: 900 });
      const from = hostRequests.length;
      try {
        await pairFrom(page, await serverOffer());
        await pairedStraightIn(page);
        await inApp(page);
        await page.locator(`.workspace-group[data-workspace=${JSON.stringify(workspace.workspace.workspace_id)}] .pane-select`).first().click();
        await page.locator(".header-files-button").click();
        await page.locator(".dir-browser-item.is-file", { hasText: "private-notes.md" }).click();
        await page.getByRole("heading", { name: "Private notes", exact: true }).waitFor();
        const raw = await page.getByRole("link", { name: "Open raw file", exact: true }).first().getAttribute("href");
        assert.ok(raw);
        const opened = context.waitForEvent("page");
        await page.getByRole("link", { name: "Open in a new tab", exact: true }).first().click();
        const reader = await opened;
        await reader.locator(".file-reader").waitFor();
        await reader.getByRole("heading", { name: "Private notes", exact: true }).waitFor();
        await shot(reader, "file-reader");
        await reader.getByRole("button", { name: /the other notes/ }).click();
        await reader.getByRole("heading", { name: "Other notes", exact: true }).waitFor();
        await reader.reload();
        await reader.getByRole("heading", { name: "Other notes", exact: true }).waitFor();
        const rawTab = await context.newPage();
        await rawTab.goto(new URL(raw, scope).href);
        await rawTab.locator(".file-reader").waitFor();
        await rawTab.waitForFunction(() => document.title.startsWith("private-notes.md"));
        await page.reload();
        await inApp(page);
        await page.getByRole("heading", { name: "Private notes", exact: true }).waitFor();
        const addresses = [page.url(), reader.url(), rawTab.url()];
        const seen = hostRequests.slice(from);
        const named = [folder, "private-notes", "other-notes", "private-plans", "Private Plans", pane];
        const leaked = seen.filter((line) => {
          const url = new URL(line.split(" ")[1] ?? "/", origin);
          const referer = /referer=(\S+)/.exec(line)?.[1];
          if (referer && new URL(referer).search !== "") return true;
          let decoded = line;
          try { decoded = decodeURIComponent(line.replace(/\+/g, " ")); } catch { /* left as it came */ }
          return named.some((part) => decoded.includes(part)) || ["read", "file", "machine", "ws", "pane", "cwd", "name"].some((key) => url.searchParams.has(key));
        });
        keep("task-16-file-paths.txt", `# requests the shell host received while a PC file was opened in the app, in its own tab, as a raw file, and reloaded (${seen.length})\n# folder: ${folder}\n# page addresses after: ${addresses.join("  ")}\n# leaked: ${leaked.length}\n${seen.join("\n")}\n`);
        assert.deepEqual(leaked, [], "no request to the shell host names the PC's file, folder, workspace or pane");
        for (const address of addresses) assert.equal(new URL(address).search, "", `the page's query names nothing: ${address}`);
        note(`file paths: app viewer, its own tab, a followed link, a raw tab and reloads -> ${seen.length} shell-host requests, none naming the file, folder, workspace or pane; addresses keep it in the fragment`);
      } finally {
        const paired = await saved(page, ID);
        if (paired?.device_id) devices.revoke(paired.device_id);
        await closeMarked(context);
        await workspaceClose(workspace.workspace.workspace_id);
        rmSync(folder, { recursive: true, force: true });
      }
    }

    for (const [device, width, height] of [["mobile", 390, 844], ["desktop", 1440, 900]] as const) {
      for (const theme of ["light", "dark"] as const) {
        const { context, page } = await open({ width, height, theme });
        const response = await page.goto(`${origin}/`);
        assert.equal(response?.headers()["content-security-policy"], shellContentSecurityPolicy(Object.values(REGIONAL_APPS)), "the front page carries the shell policy");
        assert.equal(await page.evaluate(() => document.documentElement.dataset["theme"]), theme);
        await state(page, "empty").waitFor();
        await page.getByRole("heading", { name: "Connect a PC" }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Back" }).count(), 0, "the front page offers no Back");
        assert.deepEqual(await page.locator(".connect-start-tabs > button").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab"))), ["relay", "tailscale", "ssh"], "the front page is Connect a PC's three tabs");
        assert.deepEqual(await page.locator('[data-tab-panel="relay"] button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-action"))), ["add-code"], "a browser has no scanner, so its code; a relay with no accounts offers no sign-in");
        assert.equal(await page.locator('[data-view="my-pcs"], .relay-add-saved-pc').count(), 0, "no list with nothing saved");
        await shot(page, `empty-${device}-${theme}`);
        await closeMarked(context);
      }
    }
    note("empty: front page without a saved PC (Connect a PC's tabs) at 390 and 1440, light and dark");

    // (b) a damaged offer: the damaged screen, and not one request beyond this origin, not one socket
    {
      const { context, page, bridge } = await open();
      const requests: string[] = [];
      page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
      const before = `${scope}#offer=abc`;
      await page.goto(before);
      await state(page, "bad-offer").waitFor();
      await page.getByRole("heading", { name: "This pairing link is damaged" }).waitFor();
      const after = await page.evaluate(() => location.href);
      assert.equal(after, scope, "the fragment left the address bar");
      const foreign = requests.filter((line) => !line.includes(` ${origin}/`));
      assert.deepEqual(foreign, [], "every request stayed on the shell's origin");
      assert.deepEqual(bridge.sockets, [], "no relay socket for a damaged offer");
      await shot(page, "bad-offer");
      keep("task-16-bad-offer-requests.txt", `# every request the page made while showing the damaged-offer screen (${requests.length}); relay sockets: ${bridge.sockets.length}\n# origin: ${origin}\n${requests.join("\n")}\n`);
      keep("task-16-fragment.txt", `# the address before boot and after it\nbefore: ${before}\nafter:  ${after}\n`);
      note(`bad-offer: ${requests.length} requests, all on ${origin}; 0 relay sockets; address after boot ${after}`);
      await closeMarked(context);
    }

    {
      const { context, page, bridge } = await open({ mode: "hold" });
      await page.addInitScript(() => {
        const json = Response.prototype.json;
        Response.prototype.json = async function () {
          const body: unknown = await json.call(this);
          if (typeof body === "object" && body !== null && "phase" in body && "sessions" in body && "relay" in body) {
            const counted = window as unknown as { qaRelayStatuses?: number };
            counted.qaRelayStatuses = (counted.qaRelayStatuses ?? 0) + 1;
          }
          return body;
        };
      });
      const relayStatuses = (): Promise<number> => page.evaluate(() => (window as unknown as { qaRelayStatuses?: number }).qaRelayStatuses ?? 0);
      const offer = await serverOffer();
      await page.goto(offerUrl(offer));
      await state(page, "confirm").waitFor();
      await shot(page, "confirm");
      await page.getByRole("button", { name: "Pair", exact: true }).click();
      await state(page, "connecting").waitFor();
      await page.getByRole("heading", { name: "Connecting to Desk PC…" }).waitFor();
      await shot(page, "connecting");
      const socket = await bounded(bridge.next(), "the shell's relay socket");
      assert.ok(socket.url.startsWith(`${RELAY}/v1/ws?server_id=${ID}&role=client&v=1`), socket.url);
      bridge.release.resolve();
      await bounded(socket.assigned, "the relay assigned the connection");
      await bounded(socket.pcAnswered, "the PC answered through the relay");
      await pairedStraightIn(page);
      await inApp(page);
      await pcConnections(1, "the earlier pages' connections closed");
      assert.equal(service.status().sessions, 1, "the PC counts one relay session");
      const paired = devices.list(null).filter((device) => device.via_relay);
      assert.equal(paired.length, 1, "the PC enrolled one relay device");
      assert.equal((await saved(page, ID))?.device_id, paired[0]!.id, "the phone saved the device id the PC gave it");
      await shot(page, "paired");
      note(`connecting -> paired: real Noise + mux through the relay; PC sessions=${service.status().sessions}; device ${paired[0]!.id} enrolled via relay`);
      const socketsBeforeRename = bridge.sockets.length;
      const renamed = await fetch(`${base}/api/devices/${paired[0]!.id}`, {
        method: "PATCH", headers: { origin: base, "content-type": "application/json", "x-herdr-machine": "1" },
        body: JSON.stringify({ label: "Renamed QA phone" }),
      });
      assert.equal(renamed.status, 200);
      assert.equal((await renamed.json() as { label: string }).label, "Renamed QA phone");
      const statusesBefore = await relayStatuses();
      await page.keyboard.press("ControlOrMeta+Shift+Comma");
      await openSettingsPage(page, "Devices and PCs");
      await page.getByRole("button", { name: "Rename Renamed QA phone", exact: true }).waitFor();
      // the hosted shell offers no relay at all (a relayed phone can neither pair nor reset there:
      // relayOffered in components/ConnectPhoneDialog.tsx): no Ovis relay group in More settings, checked once the page consumed the relay status the group would follow,
      // plus two frames for its render
      await page.waitForFunction((seen) => ((window as unknown as { qaRelayStatuses?: number }).qaRelayStatuses ?? 0) > seen, statusesBefore);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const settings = page.locator(".settings-dialog");
      assert.equal(await settings.locator('[data-section="devices"]').count(), 1, "the shell's Devices and PCs lists the devices");
      assert.equal(await settings.locator('[data-section="relay"]').count(), 0, "the hosted shell's Devices and PCs has no Ovis relay group");
      assert.equal(await settings.getByRole("switch", { name: "Ovis relay", exact: true }).count(), 0, "no relay switch under the shell");
      note(`settings: Phone & devices in the shell lists the phone and has no relay group (relay statuses consumed: ${await relayStatuses()})`);
      await inApp(page);
      assert.equal(service.status().sessions, 1, "renaming keeps the admitted PC session");
      assert.equal(bridge.sockets.length, socketsBeforeRename, "renaming never reconnects the carrier");
      assert.equal((await saved(page, ID))?.device_id, paired[0]!.id, "renaming keeps the paired identity");
      await shot(page, "renamed");
      note("rename: real PATCH /api/devices/:id -> app stays mounted, one admitted session, same carrier and saved device; no identity-changed");
      // revoked on the PC: the session ends with auth_revoked, the app gives way to the screen, the key is gone
      devices.revoke(paired[0]!.id);
      await state(page, "revoked").waitFor();
      await page.getByRole("heading", { name: "This device was removed from Desk PC" }).waitFor();
      assert.equal(await page.locator(".app").count(), 0, "the app is unmounted once the PC turned the phone away");
      assert.equal(await saved(page, ID), null, "the revoked phone forgot its key");
      assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0, "no retry on a revocation");
      await shot(page, "revoked");
      await page.goto(scope);
      await state(page, "empty").waitFor();
      note("revoked: devices.revoke on the PC -> auth_revoked -> app unmounted, key deleted, next visit asks for a QR code");
      await closeMarked(context);
    }

    {
      const { context, page, bridge } = await open({ clock: true, theme: "light" });
      await pairFrom(page, await serverOffer());
      await pairedStraightIn(page);
      await inApp(page);
      await bounded(bridge.next(), "the pairing socket");
      // Unload the paired app before stopping the PC, so it cannot race this visit with a reconnect.
      await page.goto("about:blank");
      await stopPcRelay();
      await page.goto(scope);
      await state(page, "connecting").waitFor();
      const socket = await bounded(bridge.next(), "the shell's relay socket");
      await bounded(socket.answeredRelay, "the page took the relay's assignment with the PC away");
      await page.clock.runFor(PC_ANSWER_MS - 1);
      assert.equal(await state(page, "connecting").count(), 1, "still connecting 1 ms before the PC's deadline");
      await page.clock.runFor(1);
      await state(page, "pc-offline").waitFor();
      await page.getByRole("heading", { name: "Machine offline" }).waitFor();
      assert.notEqual(await saved(page, ID), null, "an offline PC keeps the phone's key");
      await shot(page, "pc-offline");
      await startPcRelay();
      await page.getByRole("button", { name: "Try again" }).click();
      await state(page, "connecting").waitFor();
      await inApp(page);
      note(`pc-offline: relay up, PC relay stopped -> assigned, silence, pc-offline at ${PC_ANSWER_MS} ms; PC relay started again -> Try again -> app`);
      await closeMarked(context);
    }

    {
      const { context, page, bridge } = await open({ clock: true, mode: "silent" });
      await pairFrom(page, await serverOffer());
      await bounded(bridge.next(), "the shell's relay socket");
      await page.clock.runFor(ASSIGNMENT_MS - 1);
      assert.equal(await state(page, "connecting").count(), 1, "still connecting 1 ms before the relay's deadline");
      await page.clock.runFor(1);
      await state(page, "relay-unreachable").waitFor();
      await page.getByRole("heading", { name: "Could not reach this machine" }).waitFor();
      assert.equal(await page.locator(".relay-shell-detail").count(), 0, "a silent relay has no close code to show");
      await shot(page, "relay-silent");
      note(`relay-unreachable (silent): socket accepted, nothing assigned -> relay-unreachable at ${ASSIGNMENT_MS} ms, not pc-offline`);
      await closeMarked(context);
    }
    {
      // the offer first: a PC whose relay is gone gives none (409 relay_offline), and its code outlives the relay
      const offer = await serverOffer();
      await relay!.stop();
      relay = null;
      const { context, page, bridge } = await open({ mode: "hold" });
      await pairFrom(page, offer);
      bridge.release.resolve();
      await state(page, "relay-unreachable").waitFor();
      await page.getByRole("heading", { name: "Could not reach this machine" }).waitFor();
      assert.equal(bridge.sockets.length, 1);
      await shot(page, "relay-unreachable");
      await restartRelay();
      await page.getByRole("button", { name: "Try again" }).click();
      await state(page, "connecting").waitFor();
      await pairedStraightIn(page);
      await inApp(page);
      assert.equal(bridge.sockets.length, 2, "Try again opened one more socket");
      note("relay-unreachable (stopped): connection refused -> relay-unreachable; relay restarted, PC reconnected, Try again -> app");
      await closeMarked(context);
    }

    {
      const { context, page } = await open();
      const fresh = await serverOffer();
      const expired = devices.startPairing(Date.now() - 11 * 60_000).code;
      const enrolled = devices.list(null).length;
      await pairFrom(page, { ...fresh, code: expired });
      await state(page, "code-expired").waitFor();
      await page.getByRole("heading", { name: "That pairing code no longer works" }).waitFor();
      assert.equal(devices.list(null).length, enrolled, "an expired code enrolls nothing");
      assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0, "no retry on a dead code");
      await shot(page, "code-expired");
      note("code-expired: startPairing(now - 11 min) -> PAIR refused with auth_failed -> code-expired, nothing enrolled");
      await closeMarked(context);
    }

    {
      const { context, page, bridge } = await open({ theme: "light" });
      await page.goto(scope);
      await state(page, "empty").waitFor();
      await seed(page, [{ server_id: ID, server_public_key: "not-the-offer's-key", name: "Desk PC" }]);
      const offer = await serverOffer();
      await page.goto(offerUrl(offer));
      await state(page, "confirm").waitFor();
      await page.getByRole("button", { name: "Pair", exact: true }).click();
      await state(page, "identity-changed").waitFor();
      await page.getByRole("heading", { name: "Desk PC has a new identity" }).waitFor();
      assert.deepEqual(bridge.sockets, [], "a changed identity is refused before any socket opens");
      await shot(page, "identity-changed");
      await page.getByRole("button", { name: "Forget this PC" }).click();
      await state(page, "forgotten").waitFor();
      await page.getByRole("heading", { name: "This phone forgot Desk PC" }).waitFor();
      assert.equal(await saved(page, ID), null, "forgetting removed the saved key");
      assert.deepEqual(bridge.sockets, [], "forgetting never pairs with the link whose key failed the check");
      assert.equal(await page.getByRole("button", { name: "Pair", exact: true }).count(), 0, "no Pair from that link");
      await shot(page, "forgotten");
      await pairFrom(page, await serverOffer());
      await pairedStraightIn(page);
      await inApp(page);
      assert.equal(bridge.sockets.length, 1, "the new QR code pairs over one socket");
      note("identity-changed: stale key refused with 0 sockets; Forget this PC -> forgotten, key gone, 0 sockets; a new QR code -> paired -> app");
      await closeMarked(context);
    }

    // (g2) a forged link: this PC's id with another key (an attacker's link). Refused before any
    // socket, every time it is opened, and the key saved from the PC's own pairing is left alone
    {
      const { context, page, bridge } = await open({ theme: "light" });
      const forged: RelayOffer = { ...(await serverOffer()), server_public_key: exportPublicKey(generateKeyPair().publicKey) };
      const refused = async (attempt: string, from = 0): Promise<void> => {
        await state(page, "identity-changed").waitFor();
        await page.getByRole("heading", { name: "This link is not Desk PC's" }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Pair", exact: true }).count(), 0, `no Pair on a forged link (${attempt})`);
        assert.equal(await page.getByRole("button", { name: "Forget this PC" }).count(), 0, `nothing to forget on a forged link (${attempt})`);
        assert.deepEqual(bridge.sockets.slice(from), [], `a forged link opens no socket (${attempt})`);
      };
      await page.goto(offerUrl(forged));
      await refused("opened");
      assert.equal(await saved(page, ID), null, "a forged link saves no key");
      await shot(page, "forged");
      await page.evaluate((hash) => { location.hash = hash; }, new URL(offerUrl(forged)).hash);
      await page.waitForFunction(() => location.hash === "");
      await refused("pasted again");
      await seed(page, [{ server_id: ID, server_public_key: identity.server_public_key, name: "Desk PC" }]);
      await page.goto(`${origin}/`);
      await state(page, "list").waitFor();
      await page.locator('[data-connection]:not([data-connection="checking"])').first().waitFor();
      const listed = bridge.sockets.length;
      await page.goto(offerUrl(forged));
      await refused("with the PC's key saved", listed);
      assert.notEqual(await saved(page, ID), null, "the key saved from the PC's own pairing stays");
      // a key saved from a forged link by an earlier build: this PC's page warns instead of connecting, and Forget removes it
      await seed(page, [{ server_id: ID, server_public_key: forged.server_public_key, name: "Desk PC", device_id: "forged-device" }]);
      await page.goto(scope);
      await state(page, "identity-changed").waitFor();
      await page.getByRole("heading", { name: "Desk PC has a new identity" }).waitFor();
      assert.deepEqual(bridge.sockets.slice(listed), [], "a forged saved key never connects");
      await page.getByRole("button", { name: "Forget this PC" }).click();
      await state(page, "forgotten").waitFor();
      assert.equal(await saved(page, ID), null, "Forget removed the forged saved key");
      note("forged link: PC id with another key -> identity-changed (own words), no Pair, no Forget, 0 sockets, nothing saved; pasted again -> the same; the PC's own saved key untouched; a forged saved key -> identity-changed, 0 sockets, Forget removes it");
      await closeMarked(context);
    }

    {
      const pc = await scriptedPc("refuse", "Old PC");
      try {
        const { context, page } = await open();
        await pairFrom(page, pc.offer);
        await state(page, "needs-update").waitFor();
        await page.getByRole("heading", { name: "Update needed" }).waitFor();
        await shot(page, "needs-update");
        note("needs-update: SESSION_ERROR unsupported_version after a real handshake -> needs-update");
        await closeMarked(context);
      } finally { pc.stop(); }
    }

    {
      const pc = await scriptedPc("stall", "Busy PC");
      try {
        const { context, page, bridge } = await open({ clock: true });
        await pairFrom(page, pc.offer);
        const socket = await bounded(bridge.next(), "the shell's relay socket");
        await bounded(socket.answeredPc, "the page took the scripted PC's handshake answer");
        await page.clock.runFor(ADMISSION_MS - 1);
        assert.equal(await state(page, "connecting").count(), 1, "still connecting 1 ms before the admission deadline");
        await page.clock.runFor(1);
        await state(page, "pc-unresponsive").waitFor();
        await page.getByRole("heading", { name: "Could not reach this machine" }).waitFor();
        await shot(page, "pc-unresponsive");
        note(`pc-unresponsive: handshake answered, HELLO never -> pc-unresponsive at ${ADMISSION_MS} ms, not pc-offline`);
        await closeMarked(context);
      } finally { pc.stop(); }
    }

    {
      const { context, page } = await open({ width: 1440, height: 900 });
      await page.goto(`${origin}/`);
      await state(page, "empty").waitFor();
      await seed(page, [{ server_id: ID, server_public_key: identity.server_public_key, name: "Desk PC" }, { server_id: OTHER_ID, server_public_key: exportPublicKey(OTHER_KEY), name: "Laptop" }]);
      await page.reload();
      await state(page, "list").waitFor();
      const rows = page.locator(".relay-shell-pc");
      assert.equal(await rows.count(), 2);
      // the list is in IndexedDB key order: the saved PCs' ids, not when they were saved
      const laptop = rows.filter({ hasText: "Laptop" });
      assert.equal(await laptop.getAttribute("href"), `/s/${OTHER_ID}/`);
      await shot(page, "list");
      await laptop.click();
      await page.waitForURL(scopeOf(OTHER_ID));
      await state(page, "connecting").waitFor();
      note("list: two saved PCs listed; a row opens /s/<id>/, which starts connecting by itself");
      await closeMarked(context);
    }

    {
      const { context, page } = await open();
      const response = await page.goto(scope);
      assert.equal(response?.headers()["content-security-policy"], shellContentSecurityPolicy(Object.values(REGIONAL_APPS)));
      await state(page, "empty").waitFor();
      const facts = await page.evaluate(async (id) => {
        const registration = await navigator.serviceWorker.ready;
        const manifestLink = document.querySelector('link[rel="manifest"]') as HTMLLinkElement;
        const manifest = await (await fetch(manifestLink.href)).json() as Record<string, string>;
        const worker = await fetch(`/s/${id}/sw.js`);
        return {
          scope: new URL(registration.scope).pathname,
          script: new URL(registration.active?.scriptURL ?? registration.installing?.scriptURL ?? "").pathname,
          manifestHref: new URL(manifestLink.href).pathname,
          manifest: { id: manifest["id"], start_url: manifest["start_url"], scope: manifest["scope"] },
          workerType: worker.headers.get("content-type"),
          meta: document.querySelector('meta[name="ovis-shell"]')?.getAttribute("content") ?? null,
        };
      }, ID);
      assert.deepEqual(facts, {
        scope: `/s/${ID}/`, script: `/s/${ID}/sw.js`, manifestHref: `/s/${ID}/manifest.webmanifest`,
        manifest: { id: "./", start_url: "./", scope: "./" }, workerType: "text/javascript; charset=utf-8", meta: "relay",
      });
      keep("task-16-scope.txt", `# a PC's page in the hosted shell: what the browser registered and read\n${JSON.stringify(facts, null, 2)}\n`);
      note(`scope: worker ${facts.script} at ${facts.scope}; manifest ${facts.manifestHref} with id/start_url/scope ./`);
      await closeMarked(context);
    }

    // (l) push alerts: two PCs paired in one shell origin, each subscribed in its own scope, each
    // PC's test push reaching only its own device's (fake) push service
    const push: string[] = [];
    const say = (line: string): void => { push.push(line); note(line); };
    const pushOf = (server: typeof app) => server.context.services.core.push;
    const pushA = pushOf(app);
    const pushB = pushOf(app2);
    {
      synced2 = deferred<void>();
      const started2 = await fetch(`${base2}/api/relay/start`, { method: "POST", headers: { origin: base2, "x-herdr-update": "1" } });
      assert.equal(started2.status, 200, `second PC relay start: ${await started2.text()}`);
      await bounded(synced2.promise, "the second PC's control socket synced with the relay");
      const offerB2 = await fetch(`${base2}/api/relay/offer`, { method: "POST", headers: { origin: base2, "x-herdr-update": "1" } });
      const offerB = { ...decodeOffer((JSON.parse(await offerB2.text()) as { url: string }).url)!, name: "Laptop" };
      const offerA = await serverOffer();
      const A = offerA.server_id;
      const B = offerB.server_id;
      assert.notEqual(A, B);
      const fakeA = await startFakePushService();
      const fakeB = await startFakePushService();
      fakes.push(fakeA, fakeB);
      const { context, page: pageA } = await open({ width: 1440, height: 900 });
      await context.grantPermissions(["notifications"], { origin });
      await fakePushManager(context, { [A]: fakeA.subscription, [B]: fakeB.subscription });
      const requests: string[] = [];
      context.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
      const registered = (server: ReturnType<typeof pushOf>, fake: FakePushService, owner: string | null) =>
        server.status({ endpoint: fake.subscription.endpoint, keys: fake.subscription.keys }, owner);

      const subscribedTo = (server: ReturnType<typeof pushOf>, fake: FakePushService): Promise<void> => {
        const done = deferred<void>();
        const subscribe = server.subscribe.bind(server);
        server.subscribe = (subscription, ...rest) => { subscribe(subscription, ...rest); if (subscription.endpoint === fake.subscription.endpoint) done.resolve(); };
        return done.promise;
      };
      const subscribedA = subscribedTo(pushA, fakeA);
      const subscribedB = subscribedTo(pushB, fakeB);
      await pairFrom(pageA, offerA);
      await pairedStraightIn(pageA);
      await inApp(pageA);
      const pageB = await context.newPage();
      csp.push(await watchCsp(pageB));
      await pairFrom(pageB, offerB);
      await pairedStraightIn(pageB);
      await inApp(pageB);
      const deviceA = (await saved(pageA, A))!.device_id!;
      const deviceB = (await saved(pageB, B))!.device_id!;
      assert.ok(devices.list(null).some((device) => device.id === deviceA && device.via_relay), "PC A enrolled the phone via the relay");
      assert.ok(app2.context.services.devices.list(null).some((device) => device.id === deviceB && device.via_relay), "PC B enrolled the phone via the relay");
      await bounded(subscribedA, "PC A registered the phone's subscription over the relay");
      await bounded(subscribedB, "PC B registered the phone's subscription over the relay");
      assert.notEqual(registered(pushA, fakeA, deviceA), null, "PC A holds the phone's subscription for its relay device");
      assert.notEqual(registered(pushB, fakeB, deviceB), null, "PC B holds the phone's subscription for its relay device");
      assert.equal(registered(pushA, fakeB, deviceA), null, "PC A never got PC B's subscription");
      assert.equal(registered(pushB, fakeA, deviceB), null, "PC B never got PC A's subscription");
      const scopes = await pageA.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((registration) => new URL(registration.scope).pathname).sort());
      assert.deepEqual(scopes, [`/s/${A}/`, `/s/${B}/`].sort(), "one worker per PC scope");
      say(`push: two PCs paired in one shell origin ${origin}; workers ${scopes.join(", ")}`);
      say(`push: PC A ${A} holds ${fakeA.subscription.endpoint} for relay device ${deviceA}; PC B ${B} holds ${fakeB.subscription.endpoint} for relay device ${deviceB}; neither holds the other's`);

      for (const [page, scope, fake, other, server, name] of [[pageA, scopeOf(A), fakeA, fakeB, pushA, "A"], [pageB, scopeOf(B), fakeB, fakeA, pushB, "B"]] as const) {
        const before = other.received.length;
        await page.goto(`${scope}?settings=alerts`);
        await page.locator(".app").waitFor();
        await page.getByRole("button", { name: "Send test", exact: true }).click();
        const received = await fake.waitFor((push) => push.payload.body === "Alerts are on for this device", `PC ${name}'s test push`, 20_000);
        await page.getByTestId("push-health-hint").getByText("Test notification sent.", { exact: false }).waitFor();
        assert.ok(received.vapidValid, `PC ${name}'s push carries a valid VAPID signature`);
        assert.equal(received.vapidKey, server.publicKey(), `PC ${name}'s push is signed with PC ${name}'s own VAPID key`);
        assert.equal(other.received.length, before, `PC ${name}'s test push reached no other device`);
        say(`push: PC ${name} Send test -> its fake push service decrypted (RFC 8291 aes128gcm) ${JSON.stringify(received.payload)}; urgency ${received.urgency}; VAPID valid, k = PC ${name}'s key ${received.vapidKey.slice(0, 16)}…`);
      }
      assert.equal(fakeA.received.length, 1);
      assert.equal(fakeB.received.length, 1);
      assert.notEqual(pushA.publicKey(), pushB.publicKey(), "each PC its own VAPID key");
      const direct = requests.filter((line) => line.includes(`127.0.0.1:${app.port}`) || line.includes(`127.0.0.1:${app2.port}`));
      assert.deepEqual(direct, [], "the page never reached either PC except through the relay");
      say(`push: fake A received ${fakeA.received.length}, fake B received ${fakeB.received.length}; ${requests.length} page requests, none to either PC's own address (${base}, ${base2})`);
      keep("task-18-push.txt", `# relay-shell-browser-qa (l): push alerts over the relay, two PCs in one shell origin\n${push.join("\n")}\n`);

      const pending: string[] = [];
      const tell = (line: string): void => { pending.push(line); note(line); };
      const worker = context.serviceWorkers().find((candidate) => candidate.url() === `${scopeOf(A)}sw.js`);
      assert.ok(worker, "PC A's worker is running");
      const fakeA2 = await startFakePushService();
      const fakeA3 = await startFakePushService();
      fakes.push(fakeA2, fakeA3);
      await closeMarked(pageA);
      await closeMarked(pageB);
      assert.equal(context.pages().length, 0);
      const registrations = new Map<string, number>();
      const firstOf = new Map<string, ReturnType<typeof deferred<void>>>([[fakeA2.subscription.endpoint, deferred<void>()], [fakeA3.subscription.endpoint, deferred<void>()]]);
      const removedOf = new Map<string, ReturnType<typeof deferred<void>>>([[fakeA.subscription.endpoint, deferred<void>()], [fakeA2.subscription.endpoint, deferred<void>()]]);
      const statusOf = new Map<string, ReturnType<typeof deferred<void>>>([[fakeA2.subscription.endpoint, deferred<void>()]]);
      const subscribe = pushA.subscribe.bind(pushA);
      const unsubscribe = pushA.unsubscribe.bind(pushA);
      const status = pushA.status.bind(pushA);
      pushA.subscribe = (subscription, ...rest) => {
        registrations.set(subscription.endpoint, (registrations.get(subscription.endpoint) ?? 0) + 1);
        firstOf.get(subscription.endpoint)?.resolve();
        subscribe(subscription, ...rest);
      };
      pushA.unsubscribe = (endpoint) => { removedOf.get(endpoint)?.resolve(); unsubscribe(endpoint); };
      pushA.status = (subscription, owner) => { statusOf.get(subscription.endpoint)?.resolve(); return status(subscription, owner); };
      const countOf = (fake: FakePushService): number => registrations.get(fake.subscription.endpoint) ?? 0;
      const rotate = (fresh: FakePushService, old: FakePushService) => worker.evaluate(async ({ fresh, old }) => {
        const as = (json: { endpoint: string }) => ({ endpoint: json.endpoint, options: { applicationServerKey: null }, toJSON: () => json });
        const event = new ExtendableEvent("pushsubscriptionchange");
        const waits: Promise<unknown>[] = [];
        Object.defineProperties(event, {
          newSubscription: { value: as(fresh) }, oldSubscription: { value: as({ endpoint: old }) },
          waitUntil: { value: (work: Promise<unknown>) => { waits.push(work); } },
        });
        const windows = (await (self as unknown as ServiceWorkerGlobalScope).clients.matchAll({ type: "window", includeUncontrolled: true })).length;
        self.dispatchEvent(event);
        await Promise.all(waits);
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ovis-relay", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        const record = await new Promise<unknown>((resolve) => { const request = db.transaction("pending-push").objectStore("pending-push").getAll(); request.onsuccess = () => resolve(request.result); });
        db.close();
        return { windows, record };
      }, { fresh: { endpoint: fresh.subscription.endpoint, expirationTime: null, keys: fresh.subscription.keys }, old: old.subscription.endpoint });
      const browserHolds = (fake: FakePushService) => context.addInitScript(({ id, json }) => { localStorage.setItem(`qa-push-json:${id}`, JSON.stringify(json)); }, { id: A, json: fake.subscription });
      const pendingCleared = (page: Page) => page.waitForFunction(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ovis-relay", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        const count = await new Promise<number>((resolve) => { const request = db.transaction("pending-push").objectStore("pending-push").count(); request.onsuccess = () => resolve(request.result); });
        db.close();
        return count === 0;
      }, undefined, { polling: 100, timeout: 20_000 });

      const first = await rotate(fakeA2, fakeA);
      assert.equal(first.windows, 0, "no window client was open");
      assert.deepEqual(first.record, [{ server_id: A, subscription: { endpoint: fakeA2.subscription.endpoint, expirationTime: null, keys: fakeA2.subscription.keys }, old_endpoint: fakeA.subscription.endpoint }]);
      assert.equal(countOf(fakeA2), 0, "the worker could not and did not reach the PC");
      tell(`pending (permission granted): pushsubscriptionchange in PC A's worker (${scopeOf(A)}sw.js) with ${first.windows} window clients -> IndexedDB ovis-relay/pending-push = ${JSON.stringify(first.record)}`);
      await browserHolds(fakeA2);
      const granted = await context.newPage();
      csp.push(await watchCsp(granted));
      await granted.goto(scopeOf(A));
      await inApp(granted);
      assert.equal(await granted.evaluate(() => Notification.permission), "granted", "notification permission stays granted for this start");
      await bounded(firstOf.get(fakeA2.subscription.endpoint)!.promise, "the start registered the kept subscription");
      await bounded(removedOf.get(fakeA.subscription.endpoint)!.promise, "the start dropped the old endpoint");
      await bounded(statusOf.get(fakeA2.subscription.endpoint)!.promise, "the app's load-time registration finished and asked after the subscription");
      await pendingCleared(granted);
      assert.equal(countOf(fakeA2), 1, "one start, with alerts allowed, registered the kept subscription exactly once");
      assert.notEqual(registered(pushA, fakeA2, deviceA), null, "PC A holds the new subscription for the relay device");
      assert.equal(registered(pushA, fakeA, deviceA), null, "PC A dropped the old one");
      assert.equal(registered(pushB, fakeA2, deviceB), null, "PC B never heard of PC A's new subscription");
      assert.notEqual(registered(pushB, fakeB, deviceB), null, "PC B keeps its own subscription");
      tell(`pending (permission granted): next start of ${scopeOf(A)} with Notification.permission "granted" and the browser holding ${fakeA2.subscription.endpoint} -> POST /api/push/subscribe once and DELETE ${fakeA.subscription.endpoint} over the relay, owner ${deviceA}; the app's load-time registration finished (POST /api/push/status reached PC A) with registrations of the kept subscription = ${countOf(fakeA2)}; record cleared; PC B untouched`);
      await closeMarked(granted);

      const second = await rotate(fakeA3, fakeA2);
      assert.equal(second.windows, 0, "no window client was open");
      assert.equal(countOf(fakeA3), 0);
      tell(`pending (permission cleared): second rotation with ${second.windows} window clients -> record ${JSON.stringify(second.record)}`);
      await browserHolds(fakeA3);
      await context.clearPermissions();
      const boot = await context.newPage();
      csp.push(await watchCsp(boot));
      await boot.goto(scopeOf(A));
      await inApp(boot);
      await bounded(firstOf.get(fakeA3.subscription.endpoint)!.promise, "the next start registered the kept subscription");
      await bounded(removedOf.get(fakeA2.subscription.endpoint)!.promise, "the next start dropped the old endpoint");
      await pendingCleared(boot);
      assert.notEqual(registered(pushA, fakeA3, deviceA), null, "PC A holds the newest subscription for the relay device");
      assert.equal(registered(pushA, fakeA2, deviceA), null, "PC A dropped the one before");
      assert.equal(registered(pushB, fakeA3, deviceB), null, "PC B never heard of it");
      tell(`pending (permission cleared): next start -> POST /api/push/subscribe ${fakeA3.subscription.endpoint} and DELETE ${fakeA2.subscription.endpoint} over the relay, owner ${deviceA}; record cleared`);
      await boot.reload();
      await inApp(boot);
      await pcConnections(1, "the reloaded page's earlier connection closed");
      assert.equal(service.status().sessions, 1, "the PC counts the reloaded relay session");
      const answered = await pushA.sendTest(fakeA3.subscription.endpoint);
      assert.ok(answered?.ok, "the new subscription receives PC A's pushes");
      await fakeA3.waitFor((push) => push.payload.body === "Alerts are on for this device", "a push to the new subscription", 20_000);
      assert.equal(countOf(fakeA3), 1, "registered exactly once across two starts");
      assert.equal(countOf(fakeA2), 1, "the earlier one was not registered again");
      tell(`pending (permission cleared): second start registered nothing more; registrations A2 = ${countOf(fakeA2)}, A3 = ${countOf(fakeA3)}; a push to A3 reached its fake (VAPID valid ${fakeA3.received[0]!.vapidValid})`);
      keep("task-18-pending.txt", `# relay-shell-browser-qa (m): a subscription rotated with no window open, registered on the next start once\n${pending.join("\n")}\n`);
      await closeMarked(context);
    }

    {
      const shot19 = async (page: Page, name: string): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `task-19-${name}.png`) }); };
      /** `floor`: the oldest client it says it supports in WELCOME (server/relay/client-floor.ts), this checkout's servers only */
      const skewPc = async (version: string, updates?: UpdateService, floor?: string) => {
        const dir = mkdtempSync(join(tmpdir(), "ovis-relay-skew-qa-"));
        const ready = deferred<void>();
        const pcRelay = new RelayService({ stateDir: dir, relay: RELAY, serverVersion: version, ...(floor ? { minSupportedClient: floor } : {}), connect: (url) => {
          const socket = new WebSocket(relayUrl(url));
          socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) ready.resolve(); });
          return socket;
        } });
        const pc = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: "", tailscaleOwner: null, sidecar: false, relay: pcRelay, ...(updates ? { updates } : {}) });
        const at = `http://127.0.0.1:${pc.port}`;
        const post = (path: string) => fetch(`${at}/api/relay${path}`, { method: "POST", headers: { origin: at, "x-herdr-update": "1" } });
        assert.equal((await post("/start")).status, 200);
        await bounded(ready.promise, `the PC reporting ${version} synced with the relay`);
        const offer = decodeOffer((JSON.parse(await (await post("/offer")).text()) as { url: string }).url);
        if (!offer) throw new Error("the skew PC gave no offer");
        return { offer: { ...offer, name: `PC ${version}` }, devices: pc.context.services.devices, stop: async () => { await pcRelay.shutdown(); pc.stop(); rmSync(dir, { recursive: true, force: true }); } };
      };
      const { below, newer } = relayShellQaVersions(shellVersion, MIN_SERVER_VERSION);
      const fakeUpdates = () => {
        const requests: UpdateRequest[] = [];
        const installed = deferred<void>();
        let phase: UpdateStatus["phase"] = "idle";
        const service: UpdateService = {
          status: () => ({ managed: true, auto_update: false, phase, current_revision: "a".repeat(40), latest_revision: "b".repeat(40),
            current_version: below, latest_version: MIN_SERVER_VERSION, available: true, checked_at: new Date().toISOString(),
            blocked_reason: null, error: null, step: phase === "building" ? "build" : null, revision_bound_install: true }),
          notes: () => noUpdateNotes(), installed: () => noInstalledNotes(),
          request: (request) => { requests.push(request); if (request.command === "install") { phase = "building"; installed.resolve(); } },
        };
        return { service, requests, installed: installed.promise };
      };
      const lines: string[] = [`# shell ${shellVersion} (package.json), MIN_SERVER_VERSION ${MIN_SERVER_VERSION}`];

      {
        const updates = fakeUpdates();
        const pc = await skewPc(below, updates.service);
        try {
          const { context, page } = await open();
          await pairFrom(page, pc.offer);
          await state(page, "pc-outdated").waitFor();
          await page.getByRole("heading", { name: `Update Ovis on PC ${below}` }).waitFor();
          assert.equal(await page.locator(".app").count(), 0, "no app for a PC below the minimum");
          assert.equal(await page.locator(".relay-shell-command").count(), 0, "a managed PC shows no steps by hand");
          assert.deepEqual(updates.requests, [], "nothing is installed before the tap");
          await page.getByRole("button", { name: "Update now" }).click();
          await bounded(updates.installed, "the PC's update service received the install");
          assert.equal(updates.requests.length, 1, "one install of the release on offer, no check first");
          const [asked] = updates.requests as { command?: string; expected_revision?: string; install_id?: string }[];
          assert.deepEqual([asked?.command, asked?.expected_revision], ["install", "b".repeat(40)], "one install of the release on offer, no check first");
          assert.match(asked?.install_id ?? "", INSTALL_ID, "the install carries the id its 202 gave");
          await page.locator(".relay-shell-detail", { hasText: "Step 4 of 5: Building the app" }).waitFor();
          await page.getByRole("status").filter({ hasText: "Step 4 of 5: Building the app" }).waitFor({ state: "attached" });
          await shot19(page, "update");
          note(`pc-outdated (managed): WELCOME ${below} < ${MIN_SERVER_VERSION} -> update screen; Update now -> POST /api/updates/install over the relay -> fake service recorded ${JSON.stringify(updates.requests)}; progress from GET /api/updates`);
          await closeMarked(context);
        } finally { await pc.stop(); }
      }

      {
        const pc = await skewPc(below);
        try {
          const { context, page, bridge } = await open();
          await pairFrom(page, pc.offer);
          await state(page, "pc-outdated").waitFor();
          await page.locator(".relay-shell-command").first().waitFor();
          assert.equal(await page.getByRole("button", { name: "Update now" }).count(), 0, "no Update button for an unmanaged install");
          assert.match(await page.locator(".relay-shell-command").first().innerText(), /curl -fsSL https:\/\/ovis\.sh\/install\.sh \| sh/);
          assert.match(await page.locator(".relay-shell-command").nth(1).innerText(), /herdr plugin install devswha\/ovis/);
          await shot19(page, "instructions");
          note(`pc-outdated (unmanaged): WELCOME ${below}, GET /api/updates managed=false -> installer one-liner and plugin steps, no Update button`);
          const enrolled = pc.devices.list(null).map((device) => device.id);
          assert.equal(enrolled.length, 1, "the pairing enrolled one device");
          await bounded(bridge.next(), "the pairing socket");
          await page.getByRole("button", { name: "Try again" }).click();
          await bounded(bridge.next(), "Try again opened a new relay socket");
          await page.locator('main[data-relay-state="pc-outdated"] .relay-shell-command, main[data-relay-state="code-expired"]').first().waitFor();
          assert.equal(await state(page, "code-expired").count(), 0, "Try again never re-sends the spent pairing code");
          assert.equal(await state(page, "pc-outdated").count(), 1, "Try again lands on the instructions again while the PC is still old");
          assert.deepEqual(pc.devices.list(null).map((device) => device.id), enrolled, "the same device, still enrolled, signed in again");
          const retried = (await saved(page, pc.offer.server_id))?.device_id;
          assert.equal(retried, enrolled[0], "the phone kept the device id it was given");
          await shot19(page, "retry");
          keep("task-19-retry.txt", `# unmanaged PC at ${below}: instructions -> Try again\nsockets: ${bridge.sockets.length}\nstate after retry: pc-outdated (code-expired count 0)\nenrolled devices before: ${JSON.stringify(enrolled)}\nenrolled devices after: ${JSON.stringify(pc.devices.list(null).map((device) => device.id))}\nphone's saved device_id: ${retried}\n`);
          note(`pc-outdated retry: Try again -> AUTH with the saved key -> instructions again; device ${enrolled[0]} still enrolled, no code-expired`);
          await closeMarked(context);
        } finally { await pc.stop(); }
      }

      {
        const pc = await skewPc(newer);
        try {
          const { context, page } = await open();
          const loads: string[] = [];
          page.on("load", () => loads.push(page.url()));
          await pairFrom(page, pc.offer);
          await pairedStraightIn(page);
          await inApp(page);
          lines.push(`server ${newer}: paired, then straight to the app across the reload`);
          assert.equal(loads.length, 2, `the pairing load and exactly one reload (loads: ${JSON.stringify(loads)})`);
          await page.reload();
          await inApp(page);
          assert.equal(loads.length, 3, `a later visit on the same stale shell connects without reloading again (loads: ${JSON.stringify(loads)})`);
          lines.push(`server ${newer} (newer than shell ${shellVersion}): paired, reloaded once (service worker update), then the app; page loads ${loads.length} = pairing + one automatic reload + one manual reload; no loop`);
          note(`server-newer: ${newer} > shell ${shellVersion} -> one reload -> app; a manual reload connects without another`);
          await closeMarked(context);
        } finally { await pc.stop(); }
      }
      {
        const { context, page } = await open();
        const loads: string[] = [];
        page.on("load", () => loads.push(page.url()));
        await pairFrom(page, await serverOffer("Same PC"));
        await pairedStraightIn(page);
        await inApp(page);
        assert.equal(loads.length, 1, `no reload for a server at the shell's own version (loads: ${JSON.stringify(loads)})`);
        lines.push(`server ${shellVersion} (the shell's own version): paired -> app, ${loads.length} page load, no reload, no update screen`);
        note(`same version: ${shellVersion} -> app directly`);
        await closeMarked(context);
      }
      if (resolve(tree.dir) === resolve(repo)) {
        // the phone app's own copy of the client: what the app sets at document start (lib/appShell.ts)
        const bundled = (context: BrowserContext) => context.addInitScript(() => {
          Object.defineProperty(window, "__ovisAppShell", { value: { bundled: true, platform: "android", appVersion: "1.1.0", build: 15 } });
        });
        {
          const pc = await skewPc(newer, undefined, newer);
          try {
            const { context, page } = await open({ theme: "light" });
            await bundled(context);
            const loads: string[] = [];
            page.on("load", () => loads.push(page.url()));
            await pairFrom(page, pc.offer);
            await state(page, "app-outdated").waitFor();
            await page.getByRole("heading", { name: "Update the app" }).waitFor();
            await page.getByText(`PC ${newer} needs a newer version of this app.`).waitFor();
            const store = page.getByRole("link", { name: "Open the store" });
            assert.equal(await store.getAttribute("href"), "https://play.google.com/store/apps/details?id=sh.ovis.app", "the store page of the app's platform");
            assert.equal(await page.locator(".app").count(), 0, "no app for a PC that no longer supports this copy");
            assert.equal(loads.length, 1, `the app's own copy never reloads for a newer PC (loads: ${JSON.stringify(loads)})`);
            assert.equal(pc.devices.list(null).length, 1, "the pairing itself was made: the updated app opens the PC by it");
            await shot19(page, "app-outdated-en");
            await page.evaluate(() => sessionStorage.setItem("qa-language", "ko"));
            await page.reload();
            await state(page, "app-outdated").waitFor();
            await page.getByRole("heading", { name: "앱을 업데이트하세요" }).waitFor();
            await page.getByRole("link", { name: "스토어 열기" }).waitFor();
            assert.equal(await page.locator(".app").count(), 0, "opened again, the PC is still held behind the update");
            await shot19(page, "app-outdated-ko");
            assert.equal(loads.length, 2, `only the reload this test made (loads: ${JSON.stringify(loads)})`);
            await page.evaluate(() => sessionStorage.removeItem("qa-language"));
            lines.push(`server ${newer} with floor ${newer}, the app's own copy at ${shellVersion}: paired, then Update the app (store link, Back), no app and no reload; again after a reload, in Korean`);
            note(`app-outdated: WELCOME min_supported_client ${newer} > the app's own copy ${shellVersion} -> Update the app with the Google Play page; no app, no reload`);

            const other = await skewPc(newer);
            try {
              await page.getByRole("button", { name: "뒤로" }).click();
              await state(page, "app-outdated").waitFor({ state: "detached" });
              const before = loads.length;
              await pairFrom(page, other.offer);
              await pairedStraightIn(page);
              await inApp(page);
              assert.equal(loads.length, before + 1, `a newer PC that still supports this copy opens with no reload (loads: ${JSON.stringify(loads)})`);
              lines.push(`server ${newer} with the default floor, the same app copy: paired -> app, no reload`);
              note(`app copy, newer PC: ${newer} > ${shellVersion} with the floor below it -> the app opens in this copy, no reload`);
            } finally { await other.stop(); }
            await closeMarked(context);
          } finally { await pc.stop(); }
        }
        {
          const { context, page } = await open();
          const offer = await serverOffer("Same PC");
          await pairFrom(page, offer);
          await pairedStraightIn(page);
          const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
          assert.equal(scope, scopeOf(offer.server_id), "the hosted page registered its PC's worker");
          await page.reload();
          await inApp(page);
          assert.ok(await page.evaluate(() => navigator.serviceWorker.controller !== null), "the hosted page is now served by its worker");
          assert.ok((await page.evaluate(() => caches.keys())).length > 0, "the worker kept caches");
          const marker = `kept-${randomBytes(4).toString("hex")}`;
          await page.evaluate((marker) => localStorage.setItem("qa-retire-marker", marker), marker);
          await bundled(context);
          // the app opens the PC's page anew, a navigation: a page that is itself a reload never reloads (lib/shellMode.ts)
          await page.goto("about:blank");
          const loads: string[] = [];
          page.on("load", () => loads.push(page.url()));
          await page.goto(scopeOf(offer.server_id));
          await inApp(page);
          for (const deadline = Date.now() + 20_000; loads.length < 2;) {
            if (Date.now() > deadline) throw new Error(`the page a worker served did not load again from the app (loads: ${JSON.stringify(loads)})`);
            await Bun.sleep(50);
          }
          await inApp(page);
          const after = await page.evaluate(async () => ({
            registrations: (await navigator.serviceWorker.getRegistrations()).length,
            controlled: navigator.serviceWorker.controller !== null,
            marker: localStorage.getItem("qa-retire-marker"),
          }));
          assert.deepEqual(after, { registrations: 0, controlled: false, marker }, "no worker; web storage kept, the value written before it untouched");
          assert.ok((await saved(page, offer.server_id))?.device_id, "the pairing in IndexedDB stays");
          await page.reload();
          await inApp(page);
          assert.equal(loads.length, 3, `once gone, a later load loads once (loads: ${JSON.stringify(loads)})`);
          assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0, "the app's own copy registers none");
          const left = await page.evaluate(async () => (await caches.keys()).filter((name) => name !== "ovis-files-v1"));
          assert.deepEqual(left, [], "no worker's cache is left");
          lines.push("the app's own copy over a hosted page's worker: unregistered, caches deleted, the page loaded once more without it; pairing and settings kept; none registered after");
          note("app copy: the hosted page's worker and caches removed on its first load, one more load from the app, the pairing kept, no worker registered again");
          await closeMarked(context);
        }
      } else note("the app's own copy: skipped against another server tree");
      keep("task-19-prev.txt", `${lines.join("\n")}\n`);
    }

    if (resolve(tree.dir) === resolve(repo)) await accountQa();
    else note("account: skipped against another server tree");

    assertCspClean(csp, "the hosted shell under the enforced shell policy");
    note(`csp: ${csp.length} watched pages, every one served the policy, no violation`);
    keep("task-16-states.txt", `# relay-shell-browser-qa: dist-shell at ${origin} (scripts/pages-static.ts), PC ${base} (createServer, relay ${RELAY} bridged to the Bun relay)\n${report.join("\n")}\n`);
    console.log(report.join("\n"));
  } finally {
    if (browser) await closeMarked(browser);
    site.stop(true);
    await service.shutdown();
    await service2.shutdown();
    app.stop();
    app2.stop();
    for (const fake of fakes) fake.stop();
    await relay?.stop();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(stateDir2, { recursive: true, force: true });
    rmSync(shellDir, { recursive: true, force: true });
  }
}

if (import.meta.main) await relayShellQa(await relayServerTree());
