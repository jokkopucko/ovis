import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { act } from "react";

import { FileViewer } from "./FileViewer.tsx";
import type { FileInfo } from "../../shared/files.ts";
import { PREVIEW_BUDGET_MS } from "../lib/markdownPreview.ts";
import { relayResourceUrl } from "../lib/relay/resources.ts";
import { SAVE_MAX_BYTES, SAVE_PLUGIN } from "../lib/saveImage.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport, type Transport } from "../lib/transport.ts";

// Download in the file viewer inside the Android app, whose WebView drops a download link without a
// word: the viewer reads the file through the transport and hands it to the app, which saves it to
// Downloads (app/android/.../SaveImagePlugin.java saveFile).
const globals = ["Capacitor", "isSecureContext"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let page: Page;

beforeEach(() => {
  page = openPage();
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, writable: true, value: true });
  Object.defineProperty(page.window, "isSecureContext", { configurable: true, value: true });
});

afterEach(async () => {
  await page.close();
  setTransport(nativeTransport);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const TEXT = "# notes\n";
const NOTES: FileInfo = { path: "/private/tmp/claude/notes.md", name: "notes.md", size: TEXT.length, modified: "2026-11-17T00:00:00Z", mime: "text/markdown; charset=utf-8", kind: "text" };

/** The Android app around the page, its save plugin announcing `methods`; every call it gets lands in `calls`. */
function androidApp(methods: string[]): { method: string; options: Record<string, unknown> }[] {
  const calls: { method: string; options: Record<string, unknown> }[] = [];
  Object.defineProperty(globalThis, "Capacitor", {
    value: {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      PluginHeaders: [{ name: SAVE_PLUGIN, methods: methods.map((name) => ({ name })) }],
      nativePromise: async (_plugin: string, method: string, options: Record<string, unknown>) => { calls.push({ method, options }); return { saved: "downloads" }; },
    },
    configurable: true,
    writable: true,
  });
  return calls;
}

const shown = (): string => page.container.textContent ?? "";
const drawn = (): string => page.container.innerHTML;

/**
 * Lets the page come to rest: nothing left to draw, and the viewer done opening. A Markdown preview is parsed
 * in a worker (lib/markdownPreview.ts) whose answer can land after a quiet turn of the page, so "Opening…" is
 * waited out too, past the viewer's own budget for that worker (after it, the viewer shows the source).
 */
async function settle(): Promise<void> {
  const deadline = performance.now() + 2 * PREVIEW_BUDGET_MS;
  for (let previous = ""; (previous !== drawn() || shown().includes("Opening…")) && performance.now() < deadline;) {
    previous = drawn();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

/** A home-screen web app: the page's navigator says standalone and offers the share sheet. */
function homeScreen(share: (data: { files: File[] }) => Promise<void>): void {
  for (const [key, value] of Object.entries({ standalone: true, canShare: () => true, share })) Object.defineProperty(page.window.navigator, key, { configurable: true, value });
}

/** Opens `info` on a PC whose file route answers TEXT; the file reads it asked for land in `reads`. */
async function open(
  info: FileInfo,
  transport: Partial<Pick<Transport, "kind" | "resourceUrl">> = {},
  fileResponse: (init?: RequestInit) => Response = () => new Response(TEXT, { headers: { "content-type": "application/octet-stream" } }),
): Promise<string[]> {
  const reads: string[] = [];
  setTransport({
    ...nativeTransport,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.includes("/api/fs/stat")) return Response.json(info);
      reads.push(url);
      return fileResponse(init);
    },
    resourceUrl: async (path) => path,
    ...transport,
  });
  await page.render(createElement(SettingsProvider, { children: createElement(FileViewer, { path: info.path, paneId: null, onClose() {}, page: true }) }));
  await settle();
  return reads;
}

async function download(): Promise<void> {
  const button = page.container.querySelectorAll<HTMLButtonElement>('button[aria-label="Download"]')[0];
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
  await settle();
}

test("in the Android app, Download saves the file's own bytes to Downloads under its name and type", async () => {
  // Given the app, which can save any file, and a Markdown file in the PC's /private/tmp
  const calls = androidApp(["saveImage", "saveFile"]);
  const reads = await open(NOTES);
  const before = reads.length;
  // When Download is tapped
  await download();
  // Then the file was read in full (not the download route) and handed to the app's saveFile
  expect(reads.slice(before)).toEqual([expect.not.stringContaining("download=1")]);
  expect(calls.map(({ method, options }) => [method, options["name"], options["type"], atob(String(options["data"]))])).toEqual([["saveFile", "notes.md", "text/markdown", TEXT]]);
  // and the viewer says where it went
  expect(shown()).toContain("Saved to Downloads.");
});

test("in an Android app that saves only pictures, Download asks for a newer app instead of doing nothing", async () => {
  const calls = androidApp(["saveImage"]);
  const reads = await open(NOTES);
  const before = reads.length;
  await download();
  expect(shown()).toContain("Update the Ovis app to download files.");
  expect(reads.length).toBe(before);
  expect(calls).toEqual([]);
});

test("in the Android app, a file past what the app takes says to download it on the PC", async () => {
  const calls = androidApp(["saveImage", "saveFile"]);
  await open({ ...NOTES, path: "/w/big.bin", name: "big.bin", size: SAVE_MAX_BYTES + 1, mime: "application/octet-stream", kind: "binary" });
  await download();
  expect(shown()).toContain("Too large to save on the phone - download on the PC");
  expect(calls).toEqual([]);
});

test("in a browser tab, Download stays a download link", async () => {
  await open(NOTES);
  expect(page.container.querySelectorAll('a[aria-label="Download"]')).toHaveLength(1);
  expect(page.container.querySelectorAll('button[aria-label="Download"]')).toHaveLength(0);
});

test("in a home-screen app, Download hands the file, read before the tap, to the share sheet", async () => {
  // Given a home-screen web app, where a download link would load the file over the app
  const shared: File[] = [];
  homeScreen(async ({ files }) => { shared.push(...files); });
  const reads = await open(NOTES);
  // the file was read as soon as it was known: the sheet opens only within the tap
  expect(reads).toContainEqual(expect.not.stringContaining("download=1"));
  const before = reads.length;
  await download();
  expect(reads.length).toBe(before);
  expect(await Promise.all(shared.map(async (file) => [file.name, file.type, await file.text()]))).toEqual([["notes.md", "text/markdown", TEXT]]);
});

test("in a home-screen app, Download shares the text shown when two reads return different versions", async () => {
  const current = "# new version\n";
  const stale = "# old version\n";
  const shared: File[] = [];
  homeScreen(async ({ files }) => { shared.push(...files); });
  let firstRead = true;
  await open({ ...NOTES, size: current.length }, {}, () => {
    const response = new Response(firstRead ? current : stale);
    firstRead = false;
    return response;
  });
  expect(shown()).toContain("new version");
  await download();
  expect(await shared[0]?.text()).toBe(current);
});

test("a home-screen relay download does not read the same file as a download-link blob", async () => {
  homeScreen(async () => {});
  const reads = await open(NOTES, { kind: "relay", resourceUrl(this: Transport, path, signal) {
    return relayResourceUrl(this, "0123456789abcdef0123456789abcdef", path, signal);
  } });
  expect(reads.filter((path) => path.includes("download=1"))).toEqual([]);
  expect(reads.filter((path) => path.startsWith("/api/fs/file"))).toHaveLength(1); // one read for preview and share
});

test("a home-screen share can recover from a failed prefetch without reopening the viewer", async () => {
  const shared: File[] = [];
  homeScreen(async ({ files }) => { shared.push(...files); });
  let offline = true;
  await open(NOTES, {}, (init) =>
    new Headers(init?.headers).get("range") === `bytes=0-${SAVE_MAX_BYTES}` && offline
      ? new Response(null, { status: 503 })
      : new Response(TEXT));
  offline = false;
  await download();
  await download();
  expect(await shared[0]?.text()).toBe(TEXT);
});

test("in the Android app, an empty file says it could not be saved, not that it is too large", async () => {
  const calls = androidApp(["saveImage", "saveFile"]);
  await open({ ...NOTES, size: 0 });
  await download();
  expect(shown()).toContain("Couldn't save the file.");
  expect(shown()).not.toContain("Too large");
  expect(calls).toEqual([]);
});
