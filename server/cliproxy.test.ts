import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CLIProxyLogin } from "../shared/protocol.ts";
import { requiresAuth } from "./auth.ts";
import { CLIProxyService } from "./cliproxy.ts";
import { startFakeCLIProxy } from "./cliproxy.fake.ts";
import { CLIProxyRoutes } from "./cliproxy-routes.ts";
import { createServer } from "./index.ts";
import { FRESH_MS, UsageService, type UsageContext } from "./usage.ts";

const KEY = "test-management-secret-not-in-responses";
let dir: string;
let fake: ReturnType<typeof startFakeCLIProxy>;
let service: CLIProxyService;
let routes: CLIProxyRoutes;
const call = (path = "", init: RequestInit = {}) => routes.handle(new Request(`http://localhost/api/cliproxy${path}`, init));
const send = (path: string, body: unknown) => call(path, { method: path ? "POST" : "PUT", body: JSON.stringify(body) });
const configure = (key = KEY) => send("", { url: fake.server.url.origin, management_key: key });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cliproxy-test-"));
  fake = startFakeCLIProxy(KEY); service = new CLIProxyService(dir); routes = new CLIProxyRoutes(service);
});
afterEach(() => { fake.server.stop(true); rmSync(dir, { recursive: true, force: true }); });

describe("CLIProxyAPI v8", () => {
  it.each([
    ["invalid JSON", `garbage ${KEY}`],
    ["invalid fields", JSON.stringify({ url: 42, management_key: KEY })],
    ["invalid URL", JSON.stringify({ url: "not-a-url", management_key: KEY })],
    ["unreadable file", null],
  ])("treats the hub as unconfigured when configuration has %s", async (_name, content) => {
    const path = join(dir, "cliproxy.json");
    if (content === null) mkdirSync(path);
    else writeFileSync(path, content);
    const restored = new CLIProxyService(dir);
    const response = await new CLIProxyRoutes(restored).handle(new Request("http://localhost/api/cliproxy"));
    const status = await response.json();
    expect(response.status).toBe(200);
    expect(status).toMatchObject({ configured: false, ok: false, problem: expect.any(String) });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(await restored.report()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("starts the web UI and allows removal when hub configuration is corrupt", async () => {
    writeFileSync(join(dir, "cliproxy.json"), "garbage");
    const app = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: dir,
      machines: false, registerBridge: false, terminalAttach: false, sidecar: false,
    });
    try {
      const origin = `http://127.0.0.1:${app.port}`;
      expect((await fetch(`${origin}/api/health?scope=bridge`)).status).toBe(200);
      const status = await fetch(`${origin}/api/cliproxy`);
      expect(await status.json()).toMatchObject({ configured: false, ok: false, problem: expect.any(String) });
      const removed = await fetch(`${origin}/api/cliproxy`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ configured: false, problem: null });
      expect(new CLIProxyService(dir).status()).toMatchObject({ configured: false, problem: null });
    } finally { app.stop(); }
  });

  it("checks saved and reloaded connections without fetching provider usage", async () => {
    await configure();
    expect(await (await call()).json()).toMatchObject({ configured: true, ok: true });
    const restored = new CLIProxyRoutes(new CLIProxyService(dir));
    const response = await restored.handle(new Request("http://localhost/api/cliproxy"));
    expect(await response.json()).toMatchObject({ configured: true, ok: true });
    expect(fake.calls.map((entry) => entry.path)).toEqual(["/credentials", "/credentials"]);
  });

  it("reports separate email accounts using existing windows when configured", async () => {
    await configure();
    const report = await service.report();
    expect(report.map((entry) => [entry.key, entry.account, entry.windows[0]?.used_percent])).toEqual([
      ["claude:cliproxy:claude-a.json", "claude-a@example.test", 25],
      ["codex:cliproxy:codex-b.json", "codex-b@example.test", 32],
    ]);
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => entry.body)).toEqual([
      expect.objectContaining({ auth_index: "a", header: expect.objectContaining({ authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" }) }),
      expect.objectContaining({ auth_index: "b", header: expect.objectContaining({ authorization: "Bearer $TOKEN$", "chatgpt-account-id": "workspace-b" }) }),
    ]);
  });

  it("names why an account could not be read: the provider's error or limit, or the Hub setting it aside or failing", async () => {
    await configure();
    fake.files.push({ name: "claude-c.json", provider: "claude", email: "claude-c@example.test", status: "error", disabled: false, unavailable: true, auth_index: "c", id_token: null });
    fake.answers.set("a", { status_code: 529, body: JSON.stringify({ type: "error", error: { type: "overloaded_error" } }) });
    fake.answers.set("b", { status_code: 429, body: "{}" });
    const rows = async () => Object.fromEntries((await service.report()).map((entry) => [entry.key, [entry.problem, entry.failure ?? null]]));
    expect(await rows()).toEqual({
      "claude:cliproxy:claude-a.json": ["failed", "upstream"],
      "codex:cliproxy:codex-b.json": ["rate_limited", null],
      "claude:cliproxy:claude-c.json": ["failed", "hub"],
    });
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["a", "b"]);
    // an answer the Hub itself could not give is the Hub's failure, not the provider's
    fake.answers.set("a", { status_code: 0, body: "" });
    service.invalidate();
    expect((await rows())["claude:cliproxy:claude-a.json"]).toEqual(["failed", "hub"]);
  });

  it("keeps an account's last numbers through a later 429 or failure", async () => {
    await configure();
    const start = Date.now();
    try {
      setSystemTime(start);
      const first = (await service.report()).find((entry) => entry.key === "claude:cliproxy:claude-a.json")!;
      expect(first).toMatchObject({ problem: null, windows: [{ used_percent: 25 }, { used_percent: 55 }] });
      fake.answers.set("a", { status_code: 429, body: "{}" });
      setSystemTime(start + FRESH_MS);
      const limited = (await service.report()).find((entry) => entry.key === "claude:cliproxy:claude-a.json");
      expect(limited).toMatchObject({ problem: "rate_limited", windows: first.windows, checked_at: first.checked_at });
      fake.answers.set("a", { status_code: 503, body: "{}" });
      setSystemTime(start + 2 * FRESH_MS);
      const failed = (await service.report()).find((entry) => entry.key === "claude:cliproxy:claude-a.json");
      expect(failed).toMatchObject({ problem: "failed", failure: "upstream", windows: first.windows, checked_at: first.checked_at });
    } finally { setSystemTime(); }
  });

  it("lists no account turned off in the Hub, hidden or not, until it is turned on again", async () => {
    await configure();
    const keys = async () => (await service.report()).map((entry) => entry.key);
    const reads = () => fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index);
    expect(await keys()).toEqual(["claude:cliproxy:claude-a.json", "codex:cliproxy:codex-b.json"]);
    // hidden, its last row is kept; turned off, not even that is listed
    const hidden = new Set(["claude:cliproxy:claude-a.json"]);
    service.skipAccounts(() => hidden);
    service.hiddenChanged();
    service.invalidate();
    expect(await keys()).toEqual(["claude:cliproxy:claude-a.json", "codex:cliproxy:codex-b.json"]);
    fake.files[0]!.disabled = true;
    service.invalidate();
    expect(await keys()).toEqual(["codex:cliproxy:codex-b.json"]);
    hidden.clear();
    service.hiddenChanged();
    service.invalidate();
    expect(await keys()).toEqual(["codex:cliproxy:codex-b.json"]);
    fake.files[0]!.disabled = false;
    service.invalidate();
    expect(await keys()).toEqual(["claude:cliproxy:claude-a.json", "codex:cliproxy:codex-b.json"]);
    expect(reads()).toEqual(["a", "b", "b", "b", "b", "a", "b"]);
  });

  it("asks the hub nothing for hidden accounts and keeps their last rows, until one is shown again", async () => {
    await configure();
    const ctx: UsageContext = { home: dir, env: {}, platform: "linux", fetch, now: Date.now, keychain: async () => ({ status: "missing" }), run: async () => null, has: () => true };
    const usage = new UsageService(ctx, [], (refresh, skipped) => service.report(refresh, skipped));
    let skipped = new Set<string>();
    usage.skipAccounts(() => skipped);
    const asked = () => fake.calls.filter((entry) => entry.path === "/requests/api-call").length;
    const start = Date.now();
    try {
      const first = await usage.report();
      expect(asked()).toBe(2);
      skipped = new Set(first.providers.map((entry) => entry.key));
      setSystemTime(start + FRESH_MS);
      const hidden = await usage.report(true);
      expect(asked()).toBe(2);
      expect(hidden.providers).toEqual(first.providers);
      skipped = new Set(["claude:cliproxy:claude-a.json"]);
      await usage.report();
      expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["a", "b", "b"]);
    } finally { setSystemTime(); }
  });

  it("reads only the Hub account shown again, keeping the other accounts' fresh rows", async () => {
    await configure();
    const hidden = new Set(["claude:cliproxy:claude-a.json"]);
    const first = await service.report(false, hidden);
    const reads = () => fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index);
    // a hidden account is listed but never read, not even by a fresh server (#3423)
    expect(reads()).toEqual(["b"]);
    const shown = await service.report();
    expect(reads()).toEqual(["b", "a"]);
    expect(shown[1]).toBe(first[1]);
  });

  it("keeps every Hub row when the read after an account is shown again fails", async () => {
    await configure();
    const first = await service.report(false, new Set(["claude:cliproxy:claude-a.json"]));
    fake.setKey("another-key");
    const shown = await service.report();
    expect(shown).toEqual(first);
  });

  it("reads an account shown again at the next report when the Hub could not be read the first time", async () => {
    await configure();
    const reads = () => fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index);
    await service.report(false, new Set(["claude:cliproxy:claude-a.json"]));
    fake.setDown(true);
    await service.report();
    fake.setDown(false);
    await service.report();
    // Then: a fresh server does not read the hidden account; the retry reads only the account shown again
    expect(reads()).toEqual(["b", "a"]);
  });

  it("does not read an account shown again a second time at the scheduled read that follows", async () => {
    await configure();
    const start = Date.now();
    const reads = () => fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index);
    try {
      setSystemTime(start);
      await service.report(false, new Set(["claude:cliproxy:claude-a.json"]));
      setSystemTime(start + FRESH_MS - 1000);
      await service.report();
      setSystemTime(start + FRESH_MS);
      await service.report();
      expect(reads()).toEqual(["b", "a", "b"]);
    } finally { setSystemTime(); }
  });

  it.each([1, 50])("never asks the Hub for a hidden account that signs in again after %i searches without it", async (searches) => {
    await configure();
    await service.report();
    const hidden = new Set(["claude:cliproxy:claude-a.json"]);
    service.skipAccounts(() => hidden);
    const alice = fake.files.splice(0, 1);
    for (let round = 0; round < searches; round++) {
      service.invalidate();
      await service.report(false, hidden);
    }
    fake.files.unshift(...alice);
    service.invalidate();
    const back = await service.report(false, hidden);
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index))
      .toEqual(["a", "b", ...Array.from({ length: searches + 1 }, () => "b")]);
    expect(back.map((entry) => [entry.key, entry.checked_at])).toEqual([["claude:cliproxy:claude-a.json", null], ["codex:cliproxy:codex-b.json", expect.any(String)]]);
  });

  it("never reads a hidden filename's account on a fresh server, whoever signs in under it first", async () => {
    await configure();
    const hidden = new Set(["claude:cliproxy:claude-a.json"]);
    service.skipAccounts(() => hidden);
    fake.files[0]!.email = "bob@example.test";
    await service.report(false, hidden);
    fake.files[0]!.email = "claude-a@example.test";
    service.invalidate();
    await service.report(false, hidden);
    // Then: neither is read, as nothing says which of them was hidden
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["b", "b"]);
  });

  it("never reads a hidden account that moves to another file name on the Hub", async () => {
    await configure();
    await service.report();
    const hidden = new Set(["claude:cliproxy:claude-a.json"]);
    service.skipAccounts(() => hidden);
    await service.report(false, hidden);
    Object.assign(fake.files[0]!, { name: "claude-moved.json", auth_index: "m" });
    service.invalidate();
    const moved = await service.report(false, hidden);
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["a", "b", "b"]);
    expect(moved.find((entry) => entry.key === "claude:cliproxy:claude-moved.json")?.checked_at).toBeNull();
  });

  it("keeps a hidden Hub account unread after a restart, under whatever file name it has moved to (#3427)", async () => {
    await configure();
    await service.report();
    const hidden = new Set(["claude:cliproxy:claude-a.json"]);
    service.skipAccounts(() => hidden);
    await service.report(false, hidden);
    Object.assign(fake.files[0]!, { name: "new.json", auth_index: "m" });
    const restarted = new CLIProxyService(dir);
    restarted.skipAccounts(() => hidden);
    const after = await restarted.report(false, hidden);
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["a", "b", "b"]);
    expect(after.find((entry) => entry.key === "claude:cliproxy:new.json")?.checked_at).toBeNull();
  });

  describe("remembering a hidden Hub account without a report in between (#3427)", () => {
    const reads = (hub = fake) => hub.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index);
    const restart = async (hidden: ReadonlySet<string>) => {
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      return restarted.report(false, hidden);
    };
    const moveAlice = () => Object.assign(fake.files[0]!, { name: "new.json", auth_index: "m" });

    it("saves the account as soon as it is hidden", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      moveAlice();
      await restart(hidden);
      expect(reads()).toEqual(["a", "b", "b"]);
    });

    it("keeps it through a removed Hub and a restart, for the next Hub", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      service.remove();
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      await new CLIProxyRoutes(restarted).handle(new Request("http://localhost/api/cliproxy", { method: "PUT", body: JSON.stringify({ url: fake.server.url.origin, management_key: KEY }) }));
      moveAlice();
      await restarted.report(false, hidden);
      expect(reads()).toEqual(["a", "b", "b"]);
    });

    it("forgets nothing while the hidden list could not be read whole", async () => {
      await configure();
      await service.report();
      let hidden = new Set(["claude:cliproxy:claude-a.json"]);
      let whole = true;
      service.skipAccounts(() => hidden, () => whole);
      service.hiddenChanged();
      whole = false;
      hidden = new Set();
      service.hiddenChanged();
      whole = true;
      hidden = new Set(["claude:cliproxy:claude-a.json"]);
      moveAlice();
      await restart(hidden);
      expect(reads()).toEqual(["a", "b", "b"]);
    });

    it("checks the saved list against the keys hidden at start, not one hidden after it (#3437)", async () => {
      fake.files.push({ ...fake.files[0]!, name: "claude-c.json", email: "claude-c@example.test", auth_index: "c" });
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      hidden.add("codex:cliproxy:codex-b.json");
      restarted.hiddenChanged();
      await restarted.report(false, hidden);
      expect(reads().slice(3)).toEqual(["c"]);
    });

    it("checks the keys hidden at start only once they were read whole (#3437)", async () => {
      fake.files.push({ ...fake.files[0]!, name: "claude-c.json", email: "claude-c@example.test", auth_index: "c" });
      await configure();
      await service.report();
      let hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      hidden = new Set(["claude:cliproxy:claude-a.json", "codex:cliproxy:codex-b.json"]);
      let readable = true;
      const restarted = new CLIProxyService(dir);
      let first = true;
      restarted.skipAccounts(() => {
        if (first) { first = false; readable = false; return new Set(["claude:cliproxy:claude-a.json"]); }
        readable = true;
        return hidden;
      }, () => readable);
      restarted.hiddenChanged();
      await restarted.report(false, hidden);
      // Bob's key is neither covered nor known: no Hub account is read at all
      expect(reads().slice(3)).toEqual([]);
    });

    it("checks the saved list only on a sync that read the hidden list whole (#3437)", async () => {
      fake.files.push({ ...fake.files[0]!, name: "claude-c.json", email: "claude-c@example.test", auth_index: "c" });
      await configure();
      await service.report();
      service.skipAccounts(() => new Set(["claude:cliproxy:claude-a.json"]));
      service.hiddenChanged();
      let readable = false;
      const restarted = new CLIProxyService(dir);
      const hidden = () => new Set(readable ? ["claude:cliproxy:claude-a.json", "codex:cliproxy:codex-b.json"] : ["claude:cliproxy:claude-a.json"]);
      restarted.skipAccounts(hidden, () => readable);
      restarted.hiddenChanged();
      readable = true;
      Object.assign(fake.files[1]!, { name: "codex-moved.json", auth_index: "m" });
      await restarted.report(false, hidden());
      expect(reads().slice(3)).toEqual([]);
    });

    it("reads no Hub account while the hidden list is read only in part, blind or not (#3437)", async () => {
      fake.files.push({ ...fake.files[0]!, name: "claude-c.json", email: "claude-c@example.test", auth_index: "c" });
      await configure();
      await service.report();
      service.skipAccounts(() => new Set(["claude:cliproxy:claude-a.json"]));
      service.hiddenChanged();
      const restarted = new CLIProxyService(dir);
      const partial = new Set(["claude:cliproxy:claude-a.json"]);
      restarted.skipAccounts(() => partial, () => false);
      restarted.hiddenChanged();
      Object.assign(fake.files[1]!, { name: "codex-moved.json", auth_index: "m" });
      await restarted.report(false, partial);
      expect(reads().slice(3)).toEqual([]);
    });

    it("decides a report's reads from the hidden list as it was when the report began (#3437)", async () => {
      fake.files.push({ ...fake.files[0]!, name: "claude-c.json", email: "claude-c@example.test", auth_index: "c" });
      await configure();
      await service.report();
      service.skipAccounts(() => new Set(["claude:cliproxy:claude-a.json"]));
      service.hiddenChanged();
      let readable = false;
      const restarted = new CLIProxyService(dir);
      const hidden = () => new Set(readable ? ["claude:cliproxy:claude-a.json", "codex:cliproxy:codex-b.json"] : ["claude:cliproxy:claude-a.json"]);
      restarted.skipAccounts(hidden, () => readable);
      restarted.hiddenChanged();
      Object.assign(fake.files[1]!, { name: "codex-moved.json", auth_index: "m" });
      const held = fake.holdCredentials();
      const report = restarted.report(false, hidden());
      await held.arrived;
      readable = true;
      restarted.status();
      held.release();
      await report;
      expect(reads().slice(3)).toEqual([]);
    });

    it("reads nothing for a report begun blind, though blind clears while the Hub answers (#3437)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["codex:cliproxy:codex-b.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      writeFileSync(join(dir, "cliproxy-hidden.json"), "{broken");
      Object.assign(fake.files[1]!, { name: "codex-moved.json", auth_index: "m" });
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      const held = fake.holdCredentials();
      const report = restarted.report(false, new Set(hidden));
      await held.arrived;
      hidden.delete("codex:cliproxy:codex-b.json");
      restarted.hiddenChanged();
      held.release();
      await report;
      expect(reads().slice(2)).toEqual([]);
    });

    it("keeps a hidden account unread when it is shown again while the Hub answers (#3437)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      moveAlice();
      service.invalidate();
      const held = fake.holdCredentials();
      const report = service.report(false, new Set(hidden));
      await held.arrived;
      hidden.delete("claude:cliproxy:claude-a.json");
      service.hiddenChanged();
      held.release();
      await report;
      expect(reads().slice(2)).toEqual(["b"]);
    });

    it("keeps an account unread when it is hidden while the Hub answers (#3437)", async () => {
      await configure();
      await service.report();
      const hidden = new Set<string>();
      service.skipAccounts(() => hidden);
      service.invalidate();
      const held = fake.holdCredentials();
      const report = service.report(false, new Set(hidden));
      await held.arrived;
      hidden.add("claude:cliproxy:claude-a.json");
      service.hiddenChanged();
      held.release();
      await report;
      expect(reads().slice(2)).toEqual(["b"]);
    });

    it("reads again at the next report once a list read only in part is whole (#3437)", async () => {
      fake.files.push({ ...fake.files[0]!, name: "claude-c.json", email: "claude-c@example.test", auth_index: "c" });
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      let readable = false;
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden, () => readable);
      await restarted.report(false, hidden);
      expect(reads().slice(3)).toEqual([]);
      readable = true;
      await restarted.report(false, hidden);
      expect(reads().slice(3).sort()).toEqual(["b", "c"]);
    });

    it("keeps the way out of a start that found a lost save, through a restart (#3437)", async () => {
      fake.files.push({ ...fake.files[0]!, name: "claude-c.json", email: "claude-c@example.test", auth_index: "c" });
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      hidden.add("codex:cliproxy:codex-b.json");
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      await new CLIProxyRoutes(restarted).handle(new Request("http://localhost/api/cliproxy", { method: "PUT", body: JSON.stringify({ url: fake.server.url.origin, management_key: KEY }) }));
      // a restart before any report keeps that way out: the shown account is read, the hidden ones are not
      await restart(hidden);
      expect(reads().slice(3)).toEqual(["c"]);
    });

    it("keeps what the saved list covers through a start and a first sync that read the hidden list in part (#3437)", async () => {
      fake.files.push({ ...fake.files[0]!, name: "claude-c.json", email: "claude-c@example.test", auth_index: "c" });
      await configure();
      const hidden = new Set(["claude:cliproxy:claude-a.json", "codex:cliproxy:codex-b.json"]);
      service.skipAccounts(() => hidden);
      await service.report(false, hidden);
      service.hiddenChanged();
      const partial = new CLIProxyService(dir);
      partial.skipAccounts(() => new Set(["claude:cliproxy:claude-a.json"]), () => false);
      partial.hiddenChanged();
      const before = reads().length;
      await restart(hidden);
      expect(reads().slice(before)).toEqual(["c"]);
    });

    it("knows a shown account hidden after a Hub sign-in, wherever its credential moves (#3444)", async () => {
      await configure();
      await service.report();
      service.invalidate();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      moveAlice();
      await service.report(false, hidden);
      expect(reads()).toEqual(["a", "b", "b"]);
    });

    it("forgets which account a key was shown as once the key holds another (#3444)", async () => {
      await configure();
      await service.report();
      let hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      fake.files.push({ ...fake.files[0]!, name: "alice-new.json", auth_index: "m" });
      Object.assign(fake.files[0]!, { email: "bob@example.test", auth_index: "x" });
      service.invalidate();
      await service.report(false, hidden);
      hidden = new Set();
      service.hiddenChanged();
      hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.hiddenChanged();
      const before = reads().length;
      service.invalidate();
      await service.report(false, hidden);
      expect(reads().slice(before).sort()).toEqual(["b", "m"]);
    });

    it("keeps a shown account known by its email when its auth index changes under the same key (#3444)", async () => {
      await configure();
      await service.report();
      service.invalidate();
      let hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      fake.files[0]!.auth_index = "n";
      await service.report(false, hidden);
      hidden = new Set();
      service.hiddenChanged();
      hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.hiddenChanged();
      const before = reads().length;
      moveAlice();
      service.invalidate();
      await service.report(false, hidden);
      expect(reads().slice(before)).toEqual(["b"]);
    });

    it("never takes another email under a shown key's auth index for the account it was shown as (#3444)", async () => {
      await configure();
      await service.report();
      service.invalidate();
      let hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      fake.files.push({ ...fake.files[0]!, email: "bob@example.test" });
      moveAlice();
      await service.report(false, hidden);
      hidden = new Set();
      service.hiddenChanged();
      hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.hiddenChanged();
      const accounts = (service as unknown as { hiddenAccounts: Map<string, readonly string[]> }).hiddenAccounts;
      expect(accounts.get("claude:cliproxy:claude-a.json")).toBeUndefined();
    });

    it("keeps a shown Codex account known by its email whatever its workspace (#3444)", async () => {
      await configure();
      await service.report();
      service.invalidate();
      let hidden = new Set(["codex:cliproxy:codex-b.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      Object.assign(fake.files[1]!, { auth_index: "c", id_token: { chatgpt_account_id: "workspace-c" } });
      let before = reads().length;
      await service.report(false, hidden);
      expect(reads().slice(before)).toEqual(["a"]);
      hidden = new Set();
      service.hiddenChanged();
      hidden = new Set(["codex:cliproxy:codex-b.json"]);
      service.hiddenChanged();
      Object.assign(fake.files[1]!, { name: "codex-n.json", auth_index: "n" });
      before = reads().length;
      service.invalidate();
      await service.report(false, hidden);
      expect(reads().slice(before)).toEqual(["a"]);
    });

    it("keeps a hidden account unread when its email changes after it moved (#3444)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      moveAlice();
      service.invalidate();
      await service.report(false, hidden);
      fake.files[0]!.email = "alice-renamed@example.test";
      const before = reads().length;
      service.invalidate();
      await service.report(false, hidden);
      expect(reads().slice(before)).toEqual(["b"]);
    });

    it("learns a hidden account's new auth index from its kept row (#3449)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      fake.files[0]!.auth_index = "m";
      service.invalidate();
      await service.report(false, hidden);
      fake.files[0]!.email = "alice-renamed@example.test";
      const before = reads().length;
      service.invalidate();
      await service.report(false, hidden);
      expect(reads().slice(before)).toEqual(["b"]);
    });

    it("keeps what a kept row taught through showing and hiding the account again (#3449)", async () => {
      await configure();
      await service.report();
      let hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      fake.files[0]!.auth_index = "m";
      service.invalidate();
      await service.report(false, hidden);
      hidden = new Set();
      service.hiddenChanged();
      hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.hiddenChanged();
      fake.files[0]!.email = "alice-renamed@example.test";
      const before = reads().length;
      service.invalidate();
      await service.report(false, hidden);
      expect(reads().slice(before)).toEqual(["b"]);
    });

    it("keeps every listed row of a hidden account unread past the identity cap (#3453)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      for (let at = 0; at < 32; at++) fake.files.push({ ...fake.files[0]!, name: `alice-${at}.json`, auth_index: `m${at}` });
      service.invalidate();
      await service.report(false, hidden);
      fake.files[2]!.email = "alice-renamed@example.test";
      const before = reads().length;
      service.invalidate();
      await service.report(false, hidden);
      expect(reads().slice(before)).toEqual(["b"]);
    });

    it("reads no Hub account after a restart when what was learned of a hidden account could not be saved (#3453)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      fake.files[0]!.auth_index = "x".repeat(70 * 1024);
      service.invalidate();
      await service.report(false, hidden);
      Object.assign(fake.files[0]!, { name: "new.json", email: "alice-renamed@example.test" });
      const before = reads().length;
      await restart(hidden);
      expect(reads().slice(before)).toEqual([]);
    });

    it("stays blind after a restart that could not save a hidden account whole, whoever takes its file name (#3453)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      fake.files[0]!.auth_index = "x".repeat(70 * 1024);
      service.invalidate();
      await service.report(false, hidden);
      Object.assign(fake.files[0]!, { name: "new.json", email: "alice-renamed@example.test" });
      fake.files.push({ ...fake.files[0]!, name: "claude-a.json", email: "bob@example.test", auth_index: "z" });
      const before = reads().length;
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      await restarted.report(false, hidden);
      // Bob under her file name is not taken for her: nothing is read at the next report either
      restarted.invalidate();
      await restarted.report(false, hidden);
      expect(reads().slice(before)).toEqual([]);
    });

    it("reads no Hub account after a restart when even the hidden keys do not fit a saved list (#3453)", async () => {
      const long = [0, 1, 2].map((at) => `${at}${"l".repeat(25000)}.json`);
      for (const [at, name] of long.entries()) fake.files.push({ ...fake.files[0]!, name, email: `long-${at}@example.test`, auth_index: `l${at}` });
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      for (const name of long) hidden.add(`claude:cliproxy:${name}`);
      expect(() => service.hiddenChanged()).toThrow();
      fake.files[0]!.auth_index = "n";
      service.invalidate();
      await service.report(false, hidden);
      fake.files[0]!.email = "alice-renamed@example.test";
      const before = reads().length;
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      await restarted.report(false, hidden);
      restarted.invalidate();
      await restarted.report(false, hidden);
      expect(reads().slice(before)).toEqual([]);
    });

    it("forgets a partial mark once its key is shown again, whether or not its account was kept (#3453)", async () => {
      await configure();
      await service.report();
      let hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      const path = join(dir, "cliproxy-hidden.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), accounts: {}, blind: true, partial: ["claude:cliproxy:claude-a.json"] }));
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      hidden = new Set();
      restarted.hiddenChanged();
      expect(JSON.parse(readFileSync(path, "utf8")).partial).toBeUndefined();
    });

    it("widens a hidden account listed under thousands of files in time linear in them (#3453)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      for (let at = 0; at < 10000; at++) fake.files.push({ name: `c${at}`, provider: "claude", email: "claude-a@example.test", auth_index: `i${at}` } as (typeof fake.files)[number]);
      const started = performance.now();
      for (let at = 0; at < 2; at++) { service.invalidate(); await service.report(false, hidden); }
      expect(reads().slice(2)).toEqual(["b", "b"]);
      // time is what is tested (the work is synchronous, so no test timeout can fire): widening each row against the whole
      // account took about 14 s here, linear takes well under 1 s
      expect(performance.now() - started).toBeLessThan(5000);
    });

    it("reads no Hub account after a restart when a hidden account is listed under more files than a saved list holds (#3449, #3453)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      for (let at = 0; at < 1200; at++) fake.files.push({ ...fake.files[0]!, name: `alice-${at}.json`, auth_index: `alice-${at}-${"x".repeat(60)}` });
      service.invalidate();
      await service.report(false, hidden);
      // what is saved stays a list the next start reads (#3449), and blind (#3453): no older list knowing less of her is used
      const before = reads().length;
      await restart(hidden);
      expect(reads().slice(before)).toEqual([]);
    });

    const listManyHidden = async () => {
      const names = [0, 1, 2, 3].map((at) => `acct${at}`);
      for (const name of names) fake.files.push({ ...fake.files[0]!, name: `${name}.json`, email: `${name}@example.test`, auth_index: name });
      await configure();
      await service.report();
      const hidden = new Set(names.map((name) => `claude:cliproxy:${name}.json`));
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      const copies = names.flatMap((name) => Array.from({ length: 31 }, (_, at) => ({ ...fake.files[0]!, name: `${name}-${at}.json`, email: `${name}@example.test`, auth_index: `${name}-${at}-${"x".repeat(600)}` })));
      fake.files.push(...copies);
      service.invalidate();
      await service.report(false, hidden);
      return { hidden, copies };
    };

    it("never saves a hidden list a restart would refuse, however many hidden accounts grow (#3449)", async () => {
      const { hidden } = await listManyHidden();
      // a list the next start reads, blind: the listed identities do not fit, and the older list knows less (#3453)
      const before = reads().length;
      await restart(hidden);
      expect(reads().slice(before)).toEqual([]);
    });

    it("saves the hidden list again once identities no listed row carries can be dropped (#3449)", async () => {
      const { hidden, copies } = await listManyHidden();
      fake.files.splice(2, 4 + copies.length);
      for (let at = 0; at < 2; at++) { service.invalidate(); await service.report(false, hidden); }
      expect(service.hiddenUnsaved()).toBe(false);
      const before = reads().length;
      await restart(hidden);
      expect(reads().slice(before).sort()).toEqual(["a", "b"]);
    });

    it("learns no kept row's identity from a report an invalidation overtook (#3449)", async () => {
      await configure();
      await service.report();
      let hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      fake.files[0]!.auth_index = "m";
      const held = fake.holdCredentials();
      service.invalidate();
      const report = service.report(false, hidden);
      await held.arrived;
      service.invalidate();
      held.release();
      expect(await report).toEqual([]);
      hidden = new Set();
      service.hiddenChanged();
      hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.hiddenChanged();
      const accounts = (service as unknown as { hiddenAccounts: Map<string, readonly string[]> }).hiddenAccounts;
      expect(accounts.get("claude:cliproxy:claude-a.json")).not.toContain("index:claude:m");
    });

    it("never forgets an identity a listed row of a hidden account still carries (#3449)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      for (const index of ["m", "n", "o", "p", "q"]) fake.files.push({ ...fake.files[0]!, name: `alice-${index}.json`, auth_index: index });
      service.invalidate();
      await service.report(false, hidden);
      fake.files[0]!.email = "alice-renamed@example.test";
      const before = reads().length;
      service.invalidate();
      await service.report(false, hidden);
      expect(reads().slice(before)).toEqual(["b"]);
    });

    it("never gives a hidden account known by its workspace alone the email of another at its old index (#3449)", async () => {
      delete (fake.files[1] as { email?: string }).email;
      await configure();
      await service.report();
      const hidden = new Set(["codex:cliproxy:codex-b.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      const carol = { ...fake.files[1]!, name: "carol.json", email: "carol@example.test", id_token: { chatgpt_account_id: "workspace-carol" } };
      Object.assign(fake.files[1]!, { name: "codex-moved.json", auth_index: "m" });
      fake.files.push(carol);
      service.invalidate();
      await service.report(false, hidden);
      carol.auth_index = "n";
      const before = reads().length;
      service.invalidate();
      await service.report(false, hidden);
      expect(reads().slice(before).sort()).toEqual(["a", "n"]);
    });

    it("never gives a shown key known by its workspace alone the email of another listed under it hidden (#3449)", async () => {
      delete (fake.files[1] as { email?: string }).email;
      await configure();
      await service.report();
      service.invalidate();
      let hidden = new Set(["codex:cliproxy:codex-b.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      fake.files[1]!.email = "carol@example.test";
      await service.report(false, hidden);
      hidden = new Set();
      service.hiddenChanged();
      hidden = new Set(["codex:cliproxy:codex-b.json"]);
      service.hiddenChanged();
      Object.assign(fake.files[1]!, { name: "carol.json", auth_index: "n" });
      const before = reads().length;
      service.invalidate();
      await service.report(false, hidden);
      expect(reads().slice(before).sort()).toEqual(["a", "n"]);
    });

    it("never widens a hidden account known by its email from a row without it (#3449)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      const bob = { ...fake.files[0]!, name: "bob.json", id_token: { chatgpt_account_id: "workspace-bob" } };
      delete (bob as { email?: string }).email;
      moveAlice();
      fake.files.push(bob);
      service.invalidate();
      await service.report(false, hidden);
      bob.auth_index = "n";
      const before = reads().length;
      service.invalidate();
      await service.report(false, hidden);
      expect(reads().slice(before).sort()).toEqual(["b", "n"]);
    });

    it("never gives an account shown by its auth index alone the email of one first listed hidden (#3444)", async () => {
      delete (fake.files[0] as { email?: string }).email;
      await configure();
      await service.report();
      service.invalidate();
      let hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      fake.files[0]!.email = "bob@example.test";
      await service.report(false, hidden);
      hidden = new Set();
      service.hiddenChanged();
      hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.hiddenChanged();
      Object.assign(fake.files[0]!, { name: "bob.json", auth_index: "m" });
      const before = reads().length;
      service.invalidate();
      await service.report(false, hidden);
      expect(reads().slice(before).sort()).toEqual(["b", "m"]);
    });

    it("learns no shown identity from a report a Hub change overtook (#3444)", async () => {
      await configure();
      await service.report();
      const known = () => [...(service as unknown as { shownIdentities: Map<string, unknown> }).shownIdentities.keys()].sort();
      expect(known()).toEqual(["claude:cliproxy:claude-a.json", "codex:cliproxy:codex-b.json"]);
      for (const name of ["gone-1", "gone-2"]) {
        fake.files.push({ ...fake.files[0]!, name: `${name}.json`, email: `${name}@example.test`, auth_index: name, disabled: true });
        const read = fake.holdRead();
        service.invalidate();
        const report = service.report();
        await read.arrived;
        service.invalidate();
        read.release();
        expect(await report).toEqual([]);
        fake.files.pop();
      }
      expect(known()).toEqual(["claude:cliproxy:claude-a.json", "codex:cliproxy:codex-b.json"]);
    });

    it("saves it at the next change after a save failed", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      rmSync(join(dir, "cliproxy-hidden.json"), { force: true });
      mkdirSync(join(dir, "cliproxy-hidden.json"));
      expect(() => service.hiddenChanged()).toThrow();
      rmSync(join(dir, "cliproxy-hidden.json"), { recursive: true });
      service.hiddenChanged();
      moveAlice();
      await restart(hidden);
      expect(reads()).toEqual(["a", "b", "b"]);
    });

    it("keeps it unread after a restart when only its auth index is the same (#3428)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      Object.assign(fake.files[0]!, { name: "new.json", email: "alice-renamed@example.test" });
      await restart(hidden);
      expect(reads()).toEqual(["a", "b", "b"]);
    });

    it("reads no Hub account after a restart when a hide could not be saved (#3428)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      chmodSync(dir, 0o500);
      try { expect(() => service.hiddenChanged()).toThrow(); }
      finally { chmodSync(dir, 0o700); }
      moveAlice();
      await restart(hidden);
      expect(reads()).toEqual(["a", "b"]);
    });

    const damage: [string, (path: string) => void][] = [
      ["bytes that are not JSON", (path) => writeFileSync(path, "{broken")],
      ["JSON that is not the list", (path) => writeFileSync(path, "[]")],
      ["a directory in its place", (path) => { rmSync(path); mkdirSync(path); }],
      ["a symlink to a copy of it", (path) => { writeFileSync(`${path}.copy`, readFileSync(path)); rmSync(path); symlinkSync(`${path}.copy`, path); }],
      ["over 64 KiB", (path) => writeFileSync(path, readFileSync(path, "utf8") + " ".repeat(64 * 1024))],
    ];
    it.each(damage)("reads no Hub account after a restart while the saved list has %s (#3428)", async (_name, spoil) => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      spoil(join(dir, "cliproxy-hidden.json"));
      moveAlice();
      await restart(hidden);
      expect(reads()).toEqual(["a", "b"]);
    });

    it("reads the Hub again once no account it cannot tell is hidden (#3428)", async () => {
      await configure();
      await service.report();
      let hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      writeFileSync(join(dir, "cliproxy-hidden.json"), "{broken");
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      await restarted.report(false, hidden);
      hidden = new Set();
      restarted.hiddenChanged();
      await restart(hidden);
      expect(reads()).toEqual(["a", "b", "a", "b"]);
    });

    it("reads no Hub account after a restart while the saved list is damaged and the hidden list is read only in part (#3428)", async () => {
      await configure();
      await service.report();
      service.skipAccounts(() => new Set(["claude:cliproxy:claude-a.json"]));
      service.hiddenChanged();
      writeFileSync(join(dir, "cliproxy-hidden.json"), "{broken");
      moveAlice();
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => new Set(), () => false);
      await restarted.report(false, new Set());
      expect(reads()).toEqual(["a", "b"]);
      expect(restarted.status()).toMatchObject({ ok: false, problem: expect.any(String) });
    });

    it("says why it reads no Hub account, and reads again once each hidden key names a listed account (#3428)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      writeFileSync(join(dir, "cliproxy-hidden.json"), "{broken");
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      await restarted.report(false, hidden);
      expect(restarted.status()).toMatchObject({ ok: false, problem: expect.any(String) });
      restarted.hiddenChanged();
      expect(restarted.status()).toMatchObject({ ok: true, problem: null });
      moveAlice();
      await restart(hidden);
      expect(reads()).toEqual(["a", "b", "b"]);
    });

    it("reads again, the hidden keys by their file names, once the Hub is saved again while a hidden account is gone from its list (#3428)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      writeFileSync(join(dir, "cliproxy-hidden.json"), "{broken");
      fake.files.splice(0, 1);
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      await restarted.report(false, hidden);
      restarted.hiddenChanged();
      expect(reads()).toEqual(["a", "b"]);
      expect(restarted.status().problem).toEqual(expect.any(String));
      await new CLIProxyRoutes(restarted).handle(new Request("http://localhost/api/cliproxy", { method: "PUT", body: JSON.stringify({ url: fake.server.url.origin, management_key: KEY }) }));
      await restart(hidden);
      expect(reads()).toEqual(["a", "b", "b"]);
    });

    it("stays blind when the Hub is saved again while the hidden list is read only in part (#3428)", async () => {
      await configure();
      await service.report();
      service.skipAccounts(() => new Set(["claude:cliproxy:claude-a.json"]));
      service.hiddenChanged();
      writeFileSync(join(dir, "cliproxy-hidden.json"), "{broken");
      moveAlice();
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => new Set(), () => false);
      await restarted.report(false, new Set());
      await new CLIProxyRoutes(restarted).handle(new Request("http://localhost/api/cliproxy", { method: "PUT", body: JSON.stringify({ url: fake.server.url.origin, management_key: KEY }) }));
      expect(restarted.status()).toMatchObject({ ok: false, problem: expect.any(String) });
      const again = new CLIProxyService(dir);
      again.skipAccounts(() => new Set(), () => false);
      await again.report(false, new Set());
      expect(reads()).toEqual(["a", "b"]);
    });

    it("refuses saving the Hub again as the way out while that way out cannot be saved (#3428)", async () => {
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      rmSync(join(dir, "cliproxy-hidden.json"));
      mkdirSync(join(dir, "cliproxy-hidden.json"));
      fake.files.splice(0, 1);
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      await restarted.report(false, hidden);
      const response = await new CLIProxyRoutes(restarted).handle(new Request("http://localhost/api/cliproxy", { method: "PUT", body: JSON.stringify({ url: fake.server.url.origin, management_key: KEY }) }));
      expect(response.status).toBe(500);
      expect(restarted.status()).toMatchObject({ ok: false, problem: expect.any(String) });
      expect(reads()).toEqual(["a", "b"]);
    });

    it("refuses a retried hide while which account it is still cannot be saved (#3428)", async () => {
      mkdirSync(join(dir, "cliproxy-hidden.json"));
      const app = createServer({ port: 0, hostname: "127.0.0.1", token: "t", stateDir: dir, tailscaleOwner: null, machines: false, registerBridge: false, terminalAttach: false, sidecar: false });
      try {
        const hide = () => fetch(`http://127.0.0.1:${app.port}/api/preferences`, { method: "PUT", headers: { "content-type": "application/json", "x-herdr-machine": "1", authorization: "Bearer t" }, body: JSON.stringify({ settings: { usageHidden: ["claude:cliproxy:claude-a.json"] } }) });
        expect((await hide()).status).toBe(500);
        expect((await hide()).status).toBe(500);
        rmSync(join(dir, "cliproxy-hidden.json"), { recursive: true });
        expect((await hide()).status).toBe(200);
      } finally { app.stop(); }
    });

    it("writes the list and the Hub configuration through a fresh private file, never through a link left at a guessable name (#3428)", async () => {
      const elsewhere = join(dir, "elsewhere");
      writeFileSync(elsewhere, "", { mode: 0o644 });
      for (const name of ["cliproxy.json", "cliproxy-hidden.json"]) symlinkSync(elsewhere, join(dir, `${name}.${process.pid}.tmp`));
      await configure();
      await service.report();
      const hidden = new Set(["claude:cliproxy:claude-a.json"]);
      service.skipAccounts(() => hidden);
      service.hiddenChanged();
      expect(readFileSync(elsewhere, "utf8")).toBe("");
      for (const name of ["cliproxy.json", "cliproxy-hidden.json"]) {
        expect(lstatSync(join(dir, name)).isSymbolicLink()).toBe(false);
        expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
      }
    });
  });

  it("keeps a hidden account unread on another Hub after a restart, and reads another account there", async () => {
    await configure();
    await service.report();
    const hidden = new Set(["claude:cliproxy:claude-a.json"]);
    service.skipAccounts(() => hidden);
    await service.report(false, hidden);
    const other = startFakeCLIProxy(KEY);
    try {
      other.files.push({ ...other.files[0]!, name: "alice-here.json", auth_index: "m" });
      other.files[0]!.email = "bob@example.test";
      await send("", { url: other.server.url.origin, management_key: KEY });
      const restarted = new CLIProxyService(dir);
      restarted.skipAccounts(() => hidden);
      await restarted.report(false, hidden);
      expect(other.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index).sort()).toEqual(["a", "b"]);
    } finally { other.server.stop(true); }
  });

  it("keeps hidden accounts unread across an invalidate, as after a Hub sign-in or a saved configuration", async () => {
    await configure();
    const first = await service.report();
    const hidden = new Set(first.map((entry) => entry.key));
    await service.report(false, hidden);
    service.invalidate();
    const after = await service.report(false, hidden);
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").length).toBe(2);
    expect(after).toEqual(first);
  });

  it("keeps an account hidden since the last report unread across a Hub sign-in", async () => {
    await configure();
    let hidden = new Set<string>();
    service.skipAccounts(() => hidden);
    await service.report(false, hidden);
    hidden = new Set(["claude:cliproxy:claude-a.json"]);
    service.invalidate();
    await service.report(false, hidden);
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["a", "b", "b"]);
  });

  it("keeps a hidden account's row unread when the Hub cannot be read right after a sign-in", async () => {
    await configure();
    const hidden = new Set(["claude:cliproxy:claude-a.json"]);
    service.skipAccounts(() => hidden);
    const first = await service.report(false, hidden);
    service.invalidate();
    fake.setDown(true);
    await service.report(false, hidden);
    fake.setDown(false);
    const after = await service.report(false, hidden);
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["b", "b"]);
    expect(after[0]).toEqual(first[0]);
  });

  it("keeps the row of an account hidden after the report's snapshot when the Hub cannot be read", async () => {
    await configure();
    await service.report();
    let hidden = new Set<string>();
    service.skipAccounts(() => hidden);
    hidden = new Set(["claude:cliproxy:claude-a.json"]);
    service.invalidate();
    fake.setDown(true);
    await service.report(false, new Set());
    fake.setDown(false);
    await service.report(false, hidden);
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["a", "b", "b"]);
  });

  it("never asks the Hub for a hidden file that names no account", async () => {
    Reflect.deleteProperty(fake.files[0]!, "email");
    await configure();
    const hidden = new Set((await service.report()).map((entry) => entry.key));
    service.skipAccounts(() => hidden);
    await service.report(false, hidden);
    service.invalidate();
    await service.report(false, hidden);
    // Then: with no account to tell it by, the hidden key alone keeps it unread (#3423)
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["a", "b"]);
  });

  it("drops hidden rows when the Hub URL changes", async () => {
    await configure();
    const hidden = new Set((await service.report()).map((entry) => entry.key));
    await service.report(false, hidden);
    const other = startFakeCLIProxy(KEY);
    other.files.forEach((file) => { file.email = `other-${file.email}`; });
    try {
      await send("", { url: other.server.url.origin, management_key: KEY });
      const after = await service.report(false, hidden);
      expect(after.map((entry) => [entry.account, entry.windows[0]?.used_percent])).toEqual([
        ["other-claude-a@example.test", 25],
        ["other-codex-b@example.test", 32],
      ]);
    } finally { other.server.stop(true); }
  });

  it("reads a hidden Hub file anew once it names another account under the same name", async () => {
    await configure();
    const hidden = new Set((await service.report()).map((entry) => entry.key));
    await service.report(false, hidden);
    fake.files[0]!.email = "bob@example.test";
    service.invalidate();
    const after = await service.report(false, hidden);
    expect(after.map((entry) => [entry.key, entry.account])).toEqual([
      ["claude:cliproxy:claude-a.json", "bob@example.test"],
      ["codex:cliproxy:codex-b.json", "codex-b@example.test"],
    ]);
  });

  it("persists the key privately without returning it when saved or reloaded", async () => {
    const saved = await configure();
    const restored = new CLIProxyService(dir);
    expect(await saved.text()).not.toContain(KEY);
    expect(restored.status().configured).toBe(true);
    expect(JSON.stringify(restored.status())).not.toContain(KEY);
    expect(statSync(join(dir, "cliproxy.json")).mode & 0o777).toBe(0o600);
  });

  it("stops retrying a wrong key when status and usage are requested again", async () => {
    await configure("wrong-secret");
    const responses = await Promise.all([call(), call(), service.report(true)]);
    expect(fake.calls).toHaveLength(1);
    expect(service.status().problem).toContain("rejected");
    for (const response of responses) expect(response instanceof Response ? await response.text() : JSON.stringify(response)).not.toMatch(/wrong-secret|test-management-secret-not-in-responses/);
  });

  it("stops queued upstream requests when a saved key has been revoked", async () => {
    await configure();
    fake.setKey("replacement-management-key");
    const before = fake.calls.length;
    const responses = await Promise.allSettled(Array.from({ length: 8 }, () => service.call("/credentials")));
    expect(responses.every((response) => response.status === "rejected")).toBe(true);
    expect(fake.calls.length - before).toBe(1);
  });

  it("redacts a key when a successful proxy response quotes it", async () => {
    const file = fake.files[0];
    if (!file) throw new Error("fixture needs a credential");
    file.email = KEY;
    await configure();
    const report = await service.report();
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(report[0]?.account).toBe("[redacted]");
  });

  it("keeps the saved key on its server when a URL change supplies an invalid replacement", async () => {
    await configure();
    const other = startFakeCLIProxy(KEY);
    try {
      const responses = await Promise.all([true, "   ", 12].map((management_key) => send("", { url: other.server.url.origin, management_key })));
      expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
      expect(other.calls).toEqual([]);
      expect(service.status().url).toBe(fake.server.url.origin);
    } finally { other.server.stop(true); }
  });

  it("keeps local usage when the proxy cannot be reached", async () => {
    const ctx: UsageContext = { home: dir, env: {}, platform: "linux", fetch, now: Date.now, keychain: async () => ({ status: "missing" }), run: async () => null, has: () => true };
    await configure();
    fake.server.stop(true);
    await service.save({ url: fake.server.url.origin, management_key: KEY });
    const local = { id: "claude", signIns: async () => [{ source: "fixture", token: "local-token", expiresAt: null }], read: async () => ({ plan: "max", windows: [] }) } as const;
    const report = await new UsageService(ctx, [local], () => service.report()).report();
    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]?.plan).toBe("max");
    expect(service.status().problem).toContain("Could not reach");
  });

  it("adds an account when a pending login receives its redirect", async () => {
    await configure();
    const login: CLIProxyLogin = await (await send("/login", { provider: "claude" })).json();
    expect(await (await call(`/login?state=${login.state}`)).json()).toEqual({ status: "wait" });
    const response = await send("/callback", { provider: "claude", state: login.state, redirect_url: `http://localhost/callback?code=test-code&state=${login.state}` });
    expect(response.status).toBe(200);
    expect(await (await call(`/login?state=${login.state}`)).json()).toEqual({ status: "ok" });
    expect((await service.report()).map((entry) => entry.account)).toContain(`${login.state}@example.test`);
  });

  it("rejects mismatched callback state when a login belongs to another provider", async () => {
    await configure();
    const login: CLIProxyLogin = await (await send("/login", { provider: "codex" })).json();
    const response = await send("/callback", { provider: "claude", state: login.state, redirect_url: `http://localhost/?state=${login.state}&code=x` });
    expect(response.status).toBe(400);
    expect(fake.calls.some((entry) => entry.path === "/oauth/callback")).toBe(false);
  });

  it("cancels the upstream session when the user cancels", async () => {
    await configure();
    const login: CLIProxyLogin = await (await send("/login", { provider: "claude" })).json();
    const response = await call(`/login?state=${login.state}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(fake.sessions.has(login.state)).toBe(false);
  });

  it("removes saved configuration when requested and remains removed after restart", async () => {
    await configure();
    await call("", { method: "DELETE" });
    expect(new CLIProxyService(dir).status().configured).toBe(false);
    expect(await service.report()).toEqual([]);
  });

  it("requires app authentication for every proxy endpoint", () => {
    for (const path of ["", "/login", "/callback"]) expect(requiresAuth(`/api/cliproxy${path}`)).toBe(true);
  });
});
