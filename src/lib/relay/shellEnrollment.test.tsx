import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ACCOUNT_FEATURE, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayPcTable } from "../../components/RelayPcTable.tsx";
import { ReadyCheckpoint, RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { myPcs } from "../account/myPcs.ts";
import { memoryAccountStore } from "../account/store.ts";
import { SettingsProvider } from "../settings.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import { dashboardModel, dashboardPcs } from "./dashboard.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";
import { RelayTransport } from "./transport.ts";

async function until(holds: () => boolean | Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (await holds()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  throw new Error("Enrollment did not reach the expected state");
}

describe("account pairing completion", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  const transports: RelayTransport[] = [];
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  afterEach(() => { jest.useRealTimers(); for (const transport of transports.splice(0)) transport.close(); setTransport(nativeTransport); browser.dispose(); });

  /** `code`: a link with a pairing code, opened by navigation (no sheet). `outdatedFirst`: the PC answers once as a version too old, and Try again reaches it updated. */
  async function pairing(introduction?: () => Response, options: { readonly code?: string; readonly outdatedFirst?: boolean } = {}) {
    const identity = generateKeyPair();
    const offer = { v: 1 as const, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh", name: "Desk", ...(options.code === undefined ? {} : { code: options.code }) };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: "https://account.ovis.sh", account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    const key = await accountStore.key();
    const devices = new Map<string, RelayDevice>([[offer.server_id, { ...offer, device_id: "12".repeat(8), private_key: key.private_key, public_spki: key.public_spki, label: "Phone" }]]);
    const store: RelayDeviceStore = {
      get: async (id) => devices.get(id), list: async () => [...devices.values()], remove: async (id) => { devices.delete(id); },
      update: async (id, change) => { const device = change(devices.get(id)); devices.set(id, device); return device; },
    };
    const enrollment = Promise.withResolvers<Response>();
    let enrolls = 0, linked = false, apps = 0, opens = 0;
    let response = enrollment.promise;
    class Admitted extends RelayTransport {
      closed = false;
      override close() { this.closed = true; super.close(); }
      readonly version = options.outdatedFirst && opens++ === 0 ? "0.1.0" : "1.0.0";
      override get server() { return { version: this.version, relayProtocol: RELAY_PROTOCOL, features: [ACCOUNT_FEATURE] }; }
      override async renew() {}
      override async fetch(path: string) {
        if (this.closed) throw new TypeError("Enrollment connection was closed");
        switch (path) {
          case "/api/account/status": return Response.json({ account: linked ? "acct-test" : null, unlinked: [], removals: [], enrolling: true });
          case "/api/account/link": linked = true; return Response.json({});
          case "/api/account/enroll": enrolls++; return response;
          case "/api/account/introduction": return introduction?.() ?? Response.json({ pcs: [{ ...offer, server_id: deriveServerId(other.publicKey), server_public_key: exportPublicKey(other.publicKey) }] });
          default: throw new TypeError(`Unexpected PC request: ${path}`);
        }
      }
    }
    const other = generateKeyPair();
    let props: RelayShellProps | undefined;
    const kinds: string[] = [];
    const render = (node: ReactNode): void => {
      if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell element");
      if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { props = node.props; kinds.push(node.props.state.kind); return; }
      render(node.props.children);
    };
    const current = (): RelayShellProps => { if (!props) throw new TypeError("Shell not rendered"); return props; };
    if (options.code === undefined) browser.sessionStore.set("ovis-add-pc-sheet", JSON.stringify({ mode: "new", server_id: offer.server_id }));
    const mountAt = (entryUrl: string) => mountRelayShell({
      container: Object.create(null), entryUrl, shellVersion: "1.0.0", store, accountStore,
      accountService: "https://account.ovis.sh", accountFetch: async () => Response.json({ pcs: [] }),
      createRoot: () => ({ render, unmount() {} }), renderApp: () => { apps++; return { render() {}, unmount() {} }; },
      pendingPush: { get: async () => undefined, clear: async () => {} }, navigate() {}, checkPc: async () => ({ kind: "offline", reason: "relay" }),
      open: async () => { const opened = new Admitted(offer); transports.push(opened); return opened; },
    });
    await mountAt(encodeOffer(offer, "https://app.ovis.sh"));
    await until(() => { const state = current().state; return state.kind === "confirm" && state.account !== "checking"; });
    current().onPair();
    if (options.outdatedFirst) {
      await until(() => { const state = current().state; return state.kind === "outdated" && state.update.phase === "manual"; });
      current().onRetry();
    }
    await until(() => enrolls > 0);
    const rows = async () => myPcs([], await store.list(), { now: Date.now(), accountKey: key.public_spki, account: "acct-test" });
    const dashboard = async () => dashboardPcs(await rows(), await store.list());
    const pcPage = `https://app.ovis.sh/s/${offer.server_id}/`;
    return { current, enrollment, rows, dashboard, mountAt, pcPage, kinds, enrolls: () => enrolls, apps: () => apps, retrySuccess: () => { response = Promise.resolve(Response.json({ results: [] })); } };
  }

  it("enters the PC as soon as a sheet join is admitted, with no Ready screen, and finishes the account's part behind it", async () => {
    const run = await pairing();
    expect(run.apps()).toBe(1);
    expect(run.kinds).not.toContain("ready");
    expect((await run.rows())[0]?.enrollment).toBe("pending");
    run.enrollment.resolve(Response.json({ results: [] }));
    await until(async () => (await run.rows())[0]?.enrollment === "complete");
    expect(run.apps()).toBe(1);
    expect(run.kinds).not.toContain("ready");
  });

  it("opens a saved PC that is still joining the account without stopping at Ready", async () => {
    const run = await pairing();
    expect((await run.rows())[0]?.enrollment).toBe("pending");
    await run.mountAt(run.pcPage);
    await until(() => run.apps() === 2);
    expect(run.kinds).not.toContain("ready");
  });

  it("completes a successful enrollment when there are no peer PCs to introduce", async () => {
    const clock = spyOn(Date, "now");
    try {
      const run = await pairing(() => {
        clock.mockReturnValue(Date.now() + 60_001);
        return Response.json({ pcs: [] });
      });
      run.enrollment.resolve(Response.json({ results: [] }));
      await until(async () => (await run.rows())[0]?.enrollment !== "pending");
      expect((await run.rows())[0]?.enrollment).toBe("complete");
      expect(run.kinds).not.toContain("ready");
    } finally { clock.mockRestore(); }
  });

  it.each(["rejection", "timeout"] as const)("records a %s on the row behind the open PC, then stops the next open at Ready with Try again", async (failure) => {
    const run = await pairing();
    if (failure === "timeout") run.enrollment.reject(new DOMException("private enrollment diagnostic", "TimeoutError"));
    else run.enrollment.resolve(Response.json({ error: { code: "account_unavailable", message: "private enrollment diagnostic" } }, { status: 503 }));
    await until(async () => (await run.rows())[0]?.enrollment === "failed");
    expect((await run.rows())[0]).toMatchObject({ paired: true, linked: false, enrollment: "failed" });
    expect(run.apps()).toBe(1);
    expect(run.kinds).not.toContain("ready");
    // the next open of the PC's own page: the enrollment is tried again, and its failure stays on screen before the app
    await run.mountAt(run.pcPage);
    await until(() => { const state = run.current().state; return state.kind === "ready" && state.enrollment === "failed"; });
    const state = run.current().state;
    expect(JSON.stringify(state)).not.toContain("private enrollment diagnostic");
    expect(renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ReadyCheckpoint, { open() {}, cancel() {}, retry() {}, ...(state.kind === "ready" ? { state } : {}) }) }))).toContain("Try again");
    expect(run.apps()).toBe(1);
    run.retrySuccess();
    run.current().onRetry();
    await until(() => { const current = run.current().state; return current.kind === "ready" && typeof current.enrollment === "object" && current.enrollment.state === "complete"; });
    expect(run.apps()).toBe(1);
    run.current().onOpenPc?.();
    expect(run.apps()).toBe(2);
  });

  // how the shell tells the account side whether an introduction can come: only a member's approval of a pairing made
  // without a code hands one over, so only that pairing is kept looking for it
  it.each([
    ["a sheet join without a code keeps looking for a minute", {}, 21],
    ["a link with a code looks once", { code: "123456" }, 1],
    ["a join without a code still keeps looking after the outdated PC's Try again", { outdatedFirst: true }, 21],
  ] as const)("looks for the introduction as the pairing was made: %s", async (_what, options, reads) => {
    let introductions = 0;
    const run = await pairing(() => { introductions++; return Response.json({ pcs: [] }); }, options);
    jest.useFakeTimers();
    run.enrollment.resolve(Response.json({ results: [] }));
    // the enrollment signs and reads between its waits, which no faked clock runs: each turn lets that work land
    for (let turn = 0; (await run.rows())[0]?.enrollment === "pending" && turn < 5_000; turn++) {
      if (introductions > 0 && jest.getTimerCount() > 0) jest.advanceTimersByTime(3_000);
      await crypto.subtle.digest("SHA-256", new Uint8Array(1));
    }
    expect((await run.rows())[0]?.enrollment).toBe("complete");
    expect(introductions).toBe(reads);
    expect(run.apps()).toBe(1);
  });

  it("tells a failed dashboard row to Open it to try again, and that Open retries the enrollment", async () => {
    const run = await pairing();
    run.enrollment.resolve(Response.json({ error: { code: "account_unavailable" } }, { status: 503 }));
    await until(async () => (await run.rows())[0]?.enrollment === "failed");
    const model = dashboardModel(await run.dashboard(), { label: "Phone", now: Date.now() }, "wss://relay.ovis.sh");
    const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayPcTable, { rows: model.rows, onSelect() {}, onOpenSheet() {} }) }));
    const action = /<a[^>]*href="([^"]+)"[^>]*data-pc-action="open"[^>]*>([^<]+)<\/a>/.exec(html);
    const line = /data-pc-enrollment="">([^<]+)</.exec(html)?.[1];
    expect(action?.[2]).toBe("Open");
    expect(line).toBe("Account setup is incomplete. Open it to try again.");
    // Open is a link to the PC's own page, which retries the saved failed enrollment as it opens
    const before = run.enrolls();
    run.retrySuccess();
    await run.mountAt(new URL(action?.[1] ?? "/", "https://app.ovis.sh").href);
    await until(() => run.enrolls() > before);
    await until(async () => (await run.rows())[0]?.enrollment === "complete");
  });
});
