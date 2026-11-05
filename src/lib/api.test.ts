import { afterEach, expect, it, jest } from "bun:test";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import { NOTICE_VERSION } from "../../shared/telemetry.ts";
import { AttachmentTooLargeError, ApiError, cancelUsageLogin, changeTelemetry, fetchAgentKinds, fetchTelemetry, swapPaneWith, uploadPaneImage, verifySourceBoot } from "./api.ts";
import { movingHerdrFocusOn } from "./followFocus.ts";
import { DEFAULT_SETTINGS, telemetrySettingsSnapshot } from "./settings.ts";

const realFetch = globalThis.fetch;
const abortSignalStatics = Object.getOwnPropertyDescriptors(AbortSignal);
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.defineProperties(AbortSignal, { any: abortSignalStatics.any!, timeout: abortSignalStatics.timeout! });
  jest.useRealTimers();
});

it("reports a refused cancellation instead of allowing a terminal handoff", async () => {
  globalThis.fetch = (async (_url: string) => Response.json({ error: { code: "login_not_found", message: "Not found" } }, { status: 404 })) as typeof fetch;
  await expect(cancelUsageLogin("fixture-login")).rejects.toMatchObject({ status: 404, code: "login_not_found" });
});

it("suppresses this PC's focus frames until an explicit swap answers, including refusals", async () => {
  for (const changed of [true, false]) {
    const response = Promise.withResolvers<Response>();
    globalThis.fetch = (async (_url: string) => response.promise) as typeof fetch;
    const pending = swapPaneWith("source", "target", "office");
    try {
      expect(movingHerdrFocusOn("office")).toBe(true);
      expect(movingHerdrFocusOn("local")).toBe(false);
    } finally {
      response.resolve(Response.json({ ok: true, changed, reason: changed ? null : "same_pane", target_pane_id: "target" }));
      await pending;
    }
    expect(movingHerdrFocusOn("office")).toBe(false);
  }
});

it("offers installed Copilot in agent menus while filtering missing and unsupported agents", async () => {
  const agents = [
    { kind: "copilot", label: "GitHub Copilot", installed: true },
    { kind: "hermes", label: "Hermes", installed: false },
    { kind: "unknown", label: "Unknown", installed: true },
    { kind: "claude", label: "Claude Code" },
  ];
  globalThis.fetch = (async (_url: string) => Response.json({ agents })) as typeof fetch;

  expect(await fetchAgentKinds()).toEqual([agents[0]!, agents[3]!]);
  agents[0]!.installed = false;
  expect(await fetchAgentKinds()).toEqual([agents[3]!]);
});

it("offers Copilot from an older remote bridge without installation metadata", async () => {
  const requests: string[] = [];
  const copilot = { kind: "copilot", label: "GitHub Copilot" };
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return Response.json({ agents: [copilot, { kind: "hermes", label: "Hermes", installed: false }] });
  }) as typeof fetch;

  expect(await fetchAgentKinds("remote-pc")).toEqual([copilot]);
  expect(requests).toEqual(["/api/machines/remote-pc/agents"]);
});

it("refuses a file over the attachment limit before any of it is sent, and sends one at the limit", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return Response.json({ ok: true, path: "/work/.ovis/site.zip" });
  }) as typeof fetch;

  const over = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "site.zip", { type: "application/zip" });
  const refused = await uploadPaneImage("p1", over).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(AttachmentTooLargeError);
  expect(refused).toMatchObject({ fileName: "site.zip", size: MAX_ATTACHMENT_BYTES + 1 });
  expect(requests).toEqual([]);

  const atLimit = new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], "site.zip", { type: "application/zip" });
  expect(await uploadPaneImage("p1", atLimit)).toBe("/work/.ovis/site.zip");
  expect(requests).toEqual(["/api/pane/image"]);
});

it("refuses a 40 MiB file in the browser with the 32 MB limit named, before upload (regression: 8 MB limit on main)", async () => {
  globalThis.fetch = (async (): Promise<Response> => { throw new Error("must not upload"); }) as unknown as typeof fetch;
  const refused = await uploadPaneImage("p1", new File([new Uint8Array(40 * 1024 * 1024)], "big.zip", { type: "application/zip" })).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(AttachmentTooLargeError);
  expect((refused as Error).message).toContain("32 MB");
  expect(MAX_ATTACHMENT_BYTES).toBe(32 * 1024 * 1024);
});

it("posts the full safe telemetry snapshot and current notice version", async () => {
  const settings = telemetrySettingsSnapshot({
    ...DEFAULT_SETTINGS,
    terminalFontFamily: "Private Font Name",
    chatFontFamily: "Private Chat Font",
    usageHidden: ["account-identifier"],
  });
  const change = { notice_seen: true as const, notice_version: NOTICE_VERSION, settings };
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requestUrl = url;
    requestInit = init;
    return Response.json({ enabled: true, blocked_by_env: false, notice_seen: true, next: null });
  }) as typeof fetch;

  await changeTelemetry(change);

  expect(requestUrl).toBe("/api/telemetry");
  expect(requestInit?.method).toBe("POST");
  expect(new Headers(requestInit?.headers).get("content-type")).toBe("application/json");
  expect(new Headers(requestInit?.headers).get("x-herdr-update")).toBe("1");
  expect(new Headers(requestInit?.headers).get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  expect(body).toEqual(change);
  expect(body).not.toHaveProperty("changed_settings");
  expect(Object.keys(body.settings as object)).toHaveLength(50);
  expect(body.settings).toHaveProperty("darkTheme", "codex");
  expect(body.settings).toHaveProperty("lightTheme", "codex");
  expect(body.settings).toHaveProperty("statusIndicators", "classic");
  expect(body.settings).not.toHaveProperty("terminalFontFamily");
  expect(body.settings).not.toHaveProperty("chatFontFamily");
  expect(body.settings).not.toHaveProperty("usageHidden");
  expect((body.settings as Record<string, unknown>).terminalFontCustom).toBe(true);
  expect((body.settings as Record<string, unknown>).usageHiddenCount).toBe(1);
});

it("preserves telemetry API errors", async () => {
  globalThis.fetch = (async (_url: string) => Response.json({ error: { code: "telemetry_failed", message: "Could not save" } }, { status: 500 })) as typeof fetch;

  const error = await changeTelemetry({ enabled: false }).catch((failure: unknown) => failure);

  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 500, code: "telemetry_failed", detail: "Could not save" });
});

it("treats a missing telemetry route as unavailable for reads and an API error for writes", async () => {
  globalThis.fetch = (async (_url: string) => Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 })) as typeof fetch;

  expect(await fetchTelemetry()).toBeNull();
  const error = await changeTelemetry({ enabled: true }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 404, code: "not_found" });
});

/**
 * An older browser the build still targets (safari14): Safari 16.0 to 17.3 has AbortSignal.timeout
 * but not AbortSignal.any, and Safari 14 and 15 have neither.
 */
function withoutAbortSignalStatics(...names: ("any" | "timeout")[]): void {
  for (const name of names) Object.defineProperty(AbortSignal, name, { value: undefined, configurable: true });
}

/** a fetch that answers only when told, and fails as a browser does once its signal ends */
function heldFetch() {
  const requests: { url: string; signal: AbortSignal; answer: (response: Response) => void }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init!.signal!;
    requests.push({ url, signal, answer: resolve });
    const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  })) as typeof fetch;
  return requests;
}

it("proves a PC's source boot on a browser without AbortSignal.any, and lets go of the caller's signal after", async () => {
  withoutAbortSignalStatics("any");
  const requests = heldFetch();
  const caller = new AbortController();

  const proof = verifySourceBoot("pc 2", caller.signal);
  expect(requests.map((request) => request.url)).toEqual(["/api/machines?verify_source_boot=pc%202"]);
  requests[0]!.answer(Response.json({ machines: [], verified_source_boot: { machine_id: "pc 2", boot_id: "boot-b" } }));
  expect(await proof).toEqual({ machines: [], boot_id: "boot-b" });

  // the coordinator aborts a check it replaced; one that already answered must not be ended by it
  caller.abort();
  expect(requests[0]!.signal.aborted).toBe(false);
});

it("ends a source boot check when the caller aborts it or after 20 s, without AbortSignal.any or AbortSignal.timeout", async () => {
  withoutAbortSignalStatics("any", "timeout");
  jest.useFakeTimers();
  const requests = heldFetch();

  const caller = new AbortController();
  const cancelled = verifySourceBoot("pc-2", caller.signal).catch((error: unknown) => error);
  caller.abort();
  expect(await cancelled).toMatchObject({ name: "AbortError" });

  const before = new AbortController();
  before.abort();
  expect(await verifySourceBoot("pc-2", before.signal).catch((error: unknown) => error)).toMatchObject({ name: "AbortError" });
  expect(requests[1]!.signal.aborted).toBe(true);

  const slow = verifySourceBoot("pc-2", new AbortController().signal).catch((error: unknown) => error);
  jest.advanceTimersByTime(19_999);
  expect(requests[2]!.signal.aborted).toBe(false);
  jest.advanceTimersByTime(1);
  expect(await slow).toMatchObject({ name: "AbortError" });
});

it("offers Letta Code in the agent menus where it is installed, and from an older bridge that does not say", async () => {
  const requests: string[] = [];
  const letta = { kind: "letta", label: "Letta Code", installed: true };
  const unsaid = { kind: "letta", label: "letta" };
  let agents: object[] = [letta, { kind: "someagent", label: "someagent", installed: true }];
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return Response.json({ agents });
  }) as typeof fetch;

  expect(await fetchAgentKinds()).toEqual([letta]);
  agents = [{ ...letta, installed: false }];
  expect(await fetchAgentKinds()).toEqual([]);
  agents = [unsaid];
  expect(await fetchAgentKinds("remote-pc")).toEqual([unsaid]);
  expect(requests).toEqual(["/api/agents", "/api/agents", "/api/machines/remote-pc/agents"]);
});
