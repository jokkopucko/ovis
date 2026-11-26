import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { Composer } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { ApiError, uploadPaneImage } from "../lib/api.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";

const pane = "upload-failure-pane", draftKey = `ovis:composer-draft:${pane}`;
const browserGlobals = ["requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
let page: Page;

beforeEach(() => {
  page = openPage("https://ovis.test/");
  for (const [key, value] of Object.entries({ languages: ["en"], userAgent: "test", maxTouchPoints: 0 })) {
    Object.defineProperty(page.window.navigator, key, { configurable: true, value });
  }
  for (const key of browserGlobals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: page.window.ResizeObserver });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false, composerPasteSend: false }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue([]);
  spyOn(usageModule, "useUsage").mockReturnValue({ report: null } as ReturnType<typeof usageModule.useUsage>);
  spyOn(facesModule, "useFacesArrived").mockReturnValue(0);
  spyOn(voiceModule, "useDictation").mockReturnValue({ shown: false, voice: { state: "idle" }, forget() {} } as unknown as ReturnType<typeof voiceModule.useDictation>);
  composerDrafts.set(draftKey, "");
});

afterEach(async () => {
  await page.close();
  composerDrafts.set(draftKey, "");
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

const note = () => [...(page.container.querySelector('[class="composer-note-text"]')?.childNodes ?? [])]
  .filter((node) => node.nodeType === 3).map((node) => node.textContent).join("") || null;
const details = () => [...page.container.querySelectorAll("code")].map((node) => node.textContent);

async function attach(files: File[]): Promise<void> {
  const input = page.one<HTMLInputElement>('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new page.window.Event("change", { bubbles: true }) as unknown as Event); });
}

it("posts non-images named .jpe and .jfif as ordinary attachments", async () => {
  const requests: { name: string; content_type: string; data_base64: string }[] = [];
  const capture: typeof fetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ path: "/work/.ovis/meeting-notes" });
  }, { preconnect: globalThis.fetch.preconnect });
  spyOn(globalThis, "fetch").mockImplementation(capture);
  await page.render(<Composer paneId={pane} agent="claude" agentStatus="idle" connected autoFocus={false} onSend={() => true} onAbort={() => {}} onUploadImage={(file) => uploadPaneImage(pane, file)} />);
  const names = ["notes.jpe", "notes.jfif"];
  const files = names.map((name) => new File(["meeting notes"], name, { type: "application/octet-stream" }));
  await attach(files);
  expect(requests.map(({ name, content_type, data_base64 }) => [name, content_type, atob(data_base64)]).sort()).toEqual(
    names.map((name) => [name, "application/octet-stream", "meeting notes"]).sort(),
  );
});

it.each([
  ["the connection's own words", new TypeError("Relay request failed"), "IMG_4242.jpg could not be attached: Relay request failed", []],
  ["the HTTP status of an answer with no words", new ApiError("/api/pane/image", 502, "", null), "IMG_4242.jpg could not be attached: HTTP 502", []],
  ["a known cause, keeping the server's words in Details,", new ApiError("/api/pane/image", 404, "gone", null), "IMG_4242.jpg could not be attached: It no longer exists on the PC", ["gone"]],
  ["a known cause with no advice, keeping the server's words in Details,", new ApiError("/api/pane/image", 400, "ENOSPC: no space left on device", null), "IMG_4242.jpg could not be attached: PC disk is full", ["ENOSPC: no space left on device"]],
  ["a known cause of an answer with no words, leaving its HTTP status out of Details,", new ApiError("/api/pane/image", 404, "", null), "IMG_4242.jpg could not be attached: It no longer exists on the PC", []],
])("puts %s on the line of an upload that failed", async (_name, error, said, detail) => {
  const upload = async (): Promise<string> => { throw error; };
  await page.render(<Composer paneId={pane} agent="claude" agentStatus="idle" connected autoFocus={false} onSend={() => true} onAbort={() => {}} onUploadImage={upload} />);
  const photo = new File(["jpeg"], "IMG_4242.jpg", { type: "image/jpeg" });
  await attach([photo]);
  expect(note()).toBe(said);
  expect(details()).toEqual(detail);
});

it.each([
  ["Bad Gateway"],
  ["Upstream TLS permission denied"],
])("shows HTTP status and keeps Try again for an empty HTTP/1.1 502 response (%s)", async (statusText) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 502, statusText })) as unknown as typeof fetch;
  try {
    await page.render(<Composer paneId={pane} agent="claude" agentStatus="idle" connected autoFocus={false} onSend={() => true} onAbort={() => {}} onUploadImage={(file) => uploadPaneImage(pane, file)} />);
    const photo = new File(["jpeg"], "IMG_4242.jpg", { type: "image/jpeg" });
    await attach([photo]);
    expect(note()).toBe("IMG_4242.jpg could not be attached: HTTP 502");
    expect(details()).toEqual([]);
    expect([...page.container.querySelectorAll("button")].filter((node) => node.textContent === "Try again").length).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

it.each([
  ["LF newlines", ["Upload failed", ...Array.from({ length: 60 }, (_, i) => `diagnostic line ${i + 1}`)].join("\n")],
  ["Unicode line separators", `Upload failed${"\u2028".repeat(60)}tail`],
])("caps a diagnostic with %s on the note line and keeps the full message in Details", async (_label, full) => {
  const upload = async (): Promise<string> => { throw new ApiError("/api/pane/image", 502, full, null); };
  await page.render(<Composer paneId={pane} agent="claude" agentStatus="idle" connected autoFocus={false} onSend={() => true} onAbort={() => {}} onUploadImage={upload} />);
  const photo = new File(["jpeg"], "IMG_4242.jpg", { type: "image/jpeg" });
  await attach([photo]);
  expect(note()).toBe("IMG_4242.jpg could not be attached: Upload failed");
  expect(details()).toEqual([full]);
});
