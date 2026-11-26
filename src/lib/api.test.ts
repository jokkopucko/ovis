import { afterEach, expect, it, jest } from "bun:test";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import { NOTICE_VERSION } from "../../shared/telemetry-notice.ts";
import { AttachmentTooLargeError, ApiError, cancelUsageLogin, changeTelemetry, errorFrom, fetchAgentCatalog, fetchAgentKinds, fetchPaneSummaries, fetchTelemetry, SUMMARY_REQUEST_MS, movePaneBeside, requestRelay, swapPaneWith, uploadPaneImage, verifySourceBoot } from "./api.ts";
import { movingHerdrFocusOn } from "./followFocus.ts";
import { setCurrentLanguage } from "./i18n.ts";
import { DEFAULT_SETTINGS, telemetrySettingsSnapshot } from "./settings.ts";

const realFetch = globalThis.fetch;
it.each([
  ["en", "This PC is in an account. Add PCs from your account.", "That PC is in an account. Add it from that account."],
  ["ko", "이 PC는 계정에 연결돼 있어요. 계정에서 PC를 추가하세요.", "그 PC는 계정에 연결돼 있어요. 그 계정에서 추가하세요."],
  ["ja", "この PC はアカウントに接続されています。PC はアカウントから追加してください。", "その PC はアカウントに接続されています。そのアカウントから追加してください。"],
  ["zh", "这台 PC 已连接到账号。请从你的账号添加 PC。", "那台 PC 已连接到账号。请从对应的账号添加。"],
] as const)("code-based PC add refusals name the right PC in %s", async (language, source, target) => {
  setCurrentLanguage(language);
  try {
    for (const [code, detail] of [["pc_add_source_bound", source], ["pc_add_target_bound", target]] as const) {
      const failure = await errorFrom("/api/machines/relay", Response.json({ error: { code, message: "Server fallback" } }, { status: 409 }));
      expect(failure).toMatchObject({ status: 409, code, detail });
    }
  } finally { setCurrentLanguage("en"); }
});
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

it("asks the pane's PC to move it beside another pane, holding that PC's focus frames until it answers", async () => {
  const response = Promise.withResolvers<Response>();
  const sent: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    return response.promise;
  }) as typeof fetch;
  const pending = movePaneBeside("source", "target", "up", "office");
  try {
    expect(movingHerdrFocusOn("office")).toBe(true);
    expect(movingHerdrFocusOn("local")).toBe(false);
  } finally {
    response.resolve(Response.json({ ok: true, changed: true, reason: null }));
  }
  expect(await pending).toEqual({ ok: true, changed: true, reason: null });
  expect(sent).toEqual([{ url: "/api/machines/office/pane/move", body: { pane_id: "source", target_pane_id: "target", side: "up" } }]);
  expect(movingHerdrFocusOn("office")).toBe(false);
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

it("uploads an iPhone's HEIC or JPEG photo as the JPEG the browser drew, scaled to 2048 a side and never up", async () => {
  const bodies: { content_type: string; name: string; data_base64: string }[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, path: "/work/.ovis/paste-20261123-212127-ee17a8b2.jpg" });
  }) as typeof fetch;
  const drawn: number[][] = [], encoded: unknown[][] = [], revoked: string[] = [];
  const sizes: [number, number][] = [[8064, 6048], [4032, 3024], [1024, 768]];
  const saved = { Image: globalThis.Image, document: globalThis.document, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  Object.assign(globalThis, {
    // a browser's image has no size until it is decoded
    Image: class { src = ""; naturalWidth = 0; naturalHeight = 0; async decode() { [this.naturalWidth, this.naturalHeight] = sizes.shift() ?? [0, 0]; } },
    document: { createElement: () => ({
      width: 0, height: 0,
      getContext() { return { drawImage: (_image: unknown, ...box: number[]) => drawn.push(box) }; },
      toBlob(resolve: (blob: Blob) => void, ...format: unknown[]) { encoded.push(format); resolve(new Blob(["jpeg"], { type: "image/jpeg" })); },
    }) },
  });
  URL.createObjectURL = () => "blob:photo";
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  const stillHeic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]);
  try {
    const paths = [
      await uploadPaneImage("p1", new File([stillHeic], "IMG_0001.HEIC", { type: "image/heic" })),
      await uploadPaneImage("p1", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "IMG_3718.jpeg", { type: "image/jpeg" })),
      await uploadPaneImage("p1", new File([stillHeic], "IMG_0002.HEIC", { type: "image/heic" })),
    ];
    expect(paths).toEqual(Array(3).fill("/work/.ovis/paste-20261123-212127-ee17a8b2.jpg"));
  } finally {
    Object.assign(globalThis, { Image: saved.Image, document: saved.document });
    URL.createObjectURL = saved.createObjectURL;
    URL.revokeObjectURL = saved.revokeObjectURL;
  }
  expect(drawn).toEqual([[0, 0, 2048, 1536], [0, 0, 2048, 1536], [0, 0, 1024, 768]]);
  expect(encoded).toEqual(Array(3).fill(["image/jpeg", 0.85]));
  expect(revoked).toEqual(["blob:photo", "blob:photo", "blob:photo"]);
  expect(bodies.map(({ content_type, name, data_base64 }) => [content_type, name, atob(data_base64)])).toEqual([["image/jpeg", "IMG_0001.jpg", "jpeg"], ["image/jpeg", "IMG_3718.jpg", "jpeg"], ["image/jpeg", "IMG_0002.jpg", "jpeg"]]);
});

it("falls back to the original HEIC file without encoding a blank JPEG when canvas 2D context is unavailable", async () => {
  const bodies: { content_type: string; name: string; data_base64: string }[] = [];
  let toBlobCalls = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, path: "/work/.ovis/IMG_0001.heic" });
  }) as typeof fetch;
  const saved = { Image: globalThis.Image, document: globalThis.document, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  Object.assign(globalThis, {
    Image: class { src = ""; naturalWidth = 0; naturalHeight = 0; async decode() { this.naturalWidth = 1000; this.naturalHeight = 800; } },
    document: { createElement: () => ({
      width: 0, height: 0,
      getContext() { return null; },
      toBlob(resolve: (blob: Blob) => void) { toBlobCalls += 1; resolve(new Blob(["blank-jpeg"], { type: "image/jpeg" })); },
    }) },
  });
  URL.createObjectURL = () => "blob:photo";
  URL.revokeObjectURL = () => {};
  const stillHeic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]);
  try {
    expect(await uploadPaneImage("p1", new File([stillHeic], "IMG_0001.HEIC", { type: "image/heic" }))).toBe("/work/.ovis/IMG_0001.heic");
  } finally {
    Object.assign(globalThis, { Image: saved.Image, document: saved.document });
    URL.createObjectURL = saved.createObjectURL;
    URL.revokeObjectURL = saved.revokeObjectURL;
  }
  expect(toBlobCalls).toBe(0);
  expect(bodies.map(({ content_type, name, data_base64 }) => [content_type, name, Array.from(Uint8Array.from(atob(data_base64), (c) => c.charCodeAt(0)))])).toEqual([["image/heic", "IMG_0001.HEIC", Array.from(stillHeic)]]);
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

it("gives up a summary request a stalled PC holds after SUMMARY_REQUEST_MS, as a failed request", async () => {
  jest.useFakeTimers();
  try {
    const requests = heldFetch();
    const answer = fetchPaneSummaries("stalled-pc", ["w1:p1"]).catch((error: unknown) => error);
    jest.advanceTimersByTime(SUMMARY_REQUEST_MS - 1);
    expect(requests[0]!.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(await answer).toMatchObject({ name: "AbortError" });
  } finally { jest.useRealTimers(); }
});

it("asks a PC for its panes' summaries, and answers null each time a bridge has no summary route", async () => {
  const requests: string[] = [];
  const summaries = { server_time: "2026-11-12T10:00:00.000Z", summaries: { "w1:p1": null } };
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    if (url.startsWith("/api/machines/old-pc/")) return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
    if (url.startsWith("/api/machines/broken-pc/")) return Response.json({ error: { code: "summary_failed", message: "Could not read" } }, { status: 500 });
    return Response.json(summaries);
  }) as typeof fetch;

  expect(await fetchPaneSummaries("summary-pc", ["w1:p1", "w2:p3"])).toEqual(summaries);
  expect(await fetchPaneSummaries("old-pc", ["w1:p1"])).toBeNull();
  expect(await fetchPaneSummaries("old-pc", ["w1:p1"])).toBeNull();
  const error = await fetchPaneSummaries("broken-pc", ["w1:p1"]).catch((failure: unknown) => failure);
  expect(error).toMatchObject({ status: 500, code: "summary_failed" });
  expect(requests).toEqual([
    "/api/machines/summary-pc/pane/summary?pane_id=w1%3Ap1&pane_id=w2%3Ap3",
    "/api/machines/old-pc/pane/summary?pane_id=w1%3Ap1",
    "/api/machines/old-pc/pane/summary?pane_id=w1%3Ap1",
    "/api/machines/broken-pc/pane/summary?pane_id=w1%3Ap1",
  ]);
});

/**
 * An older browser the build still targets (safari14): Safari 16.0 to 17.3 has AbortSignal.timeout
 * but not AbortSignal.any, and Safari 14 and 15 have neither.
 */
function withoutAbortSignalStatics(...names: ("any" | "timeout")[]): void {
  for (const name of names) Object.defineProperty(AbortSignal, name, { value: undefined, configurable: true });
}

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

it("ends a relay start that never answers after 20 s, so Turn on can be pressed again", async () => {
  withoutAbortSignalStatics("any", "timeout");
  jest.useFakeTimers();
  const requests = heldFetch();

  const stalled = requestRelay("start").catch((error: unknown) => error);
  jest.advanceTimersByTime(19_999);
  expect(requests[0]!.signal.aborted).toBe(false);
  jest.advanceTimersByTime(1);
  // the deadline's own words, not the abort the browser answered with
  expect(await stalled).toMatchObject({ name: "TimeoutError", message: "No answer" });

  // a stop may take the server longer: it is waited for
  void requestRelay("stop").catch(() => undefined);
  jest.advanceTimersByTime(60_000);
  expect(requests[1]!.signal.aborted).toBe(false);
});

it("ends an agent catalog read that never answers after 30 s, so Check again can try again", async () => {
  withoutAbortSignalStatics("any", "timeout");
  jest.useFakeTimers();
  const requests = heldFetch();

  const stalled = fetchAgentCatalog("local", new AbortController().signal).catch((error: unknown) => error);
  jest.advanceTimersByTime(29_999);
  expect(requests[0]!.signal.aborted).toBe(false);
  jest.advanceTimersByTime(1);
  expect(await stalled).toMatchObject({ name: "AbortError" });

  const caller = new AbortController();
  const cancelled = fetchAgentCatalog("local", caller.signal).catch((error: unknown) => error);
  caller.abort();
  expect(await cancelled).toMatchObject({ name: "AbortError" });
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
