import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";

import { FileViewer } from "./FileViewer.tsx";
import { openPage, type Page } from "../lib/page.fixture.ts";
import type { FileInfo } from "../../shared/files.ts";
import { MAX_INLINE_IMAGE_BYTES } from "../lib/markdownImages.ts";
import { RelayResourceTooLargeError } from "../lib/relay/resources.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport, type Transport } from "../lib/transport.ts";

let page: Page;

beforeEach(() => {
  page = openPage("http://localhost/s/shell/");
  Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
});

afterEach(async () => {
  await page.close();
  setTransport(nativeTransport);
});

function relayPc(info: FileInfo, expected: number, body: () => Response = () => new Response("hello\n", { status: 206, headers: { "content-range": "bytes 0-5/6" } }), refusal: () => Error = () => new RelayResourceTooLargeError()): { transport: Transport; refused: Promise<string[]> } {
  const paths: string[] = [];
  let done: (paths: string[]) => void = () => {};
  const refused = new Promise<string[]>((resolve) => { done = resolve; });
  const transport: Transport = {
    ...nativeTransport,
    kind: "relay",
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("/api/fs/stat")) return Response.json(info);
      return body();
    },
    resourceUrl: (path) => {
      paths.push(path);
      if (paths.length >= expected) done(paths);
      return Promise.reject(refusal());
    },
  };
  return { transport, refused };
}

const shown = (): string => page.container.textContent ?? "";

async function open(info: FileInfo, expected: number, body?: () => Response, refusal?: () => Error): Promise<string[]> {
  const pc = relayPc(info, expected, body, refusal);
  setTransport(pc.transport);
  await page.render(createElement(SettingsProvider, { children: createElement(FileViewer, { path: info.path, paneId: null, onClose() {}, page: true }) }));
  const paths = await pc.refused;
  for (let previous = "", round = 0; previous !== page.container.innerHTML && round < 50; round++) {
    previous = page.container.innerHTML;
    await act(async () => { await Promise.resolve(); });
  }
  return paths;
}

test("a refused relay download leaves a loaded text preview in the body", async () => {
  const paths = await open({ path: "/w/a.txt", name: "a.txt", size: 6, modified: "2026-10-31T00:00:00Z", mime: "text/plain", kind: "text" }, 1);
  expect(paths).toEqual([expect.stringContaining("download=1")]);
  expect(page.container.querySelectorAll(".file-viewer-text")).toHaveLength(1);
  expect(shown()).not.toContain("Too large to open on the phone");
});

test("an image too large to show inline is offered as a download, not fetched for the body", async () => {
  const size = MAX_INLINE_IMAGE_BYTES + 1;
  const paths = await open({ path: "/w/big.png", name: "big.png", size, modified: "2026-10-31T00:00:00Z", mime: "image/png", kind: "image" }, 1);
  expect(paths).toEqual([expect.stringContaining("download=1")]);
  expect(shown()).toContain("download it to view");
  expect(shown()).not.toContain("Too large to open on the phone");
});

test("a text preview whose PC went away after its stat says the PC is unreachable, not that the file is unreadable", async () => {
  const away = () => Response.json({ error: { code: "machine_offline", message: "PC is offline" } }, { status: 502 });
  await open({ path: "/w/a.txt", name: "a.txt", size: 6, modified: "2026-10-31T00:00:00Z", mime: "text/plain", kind: "text" }, 1, away);
  expect(shown()).toContain("That PC is not reachable right now.");
  expect(shown()).not.toContain("The file could not be opened.");
});

test("a video whose relay transfer dropped does not point at a download link that has no address", async () => {
  await open({ path: "/w/clip.mp4", name: "clip.mp4", size: 6, modified: "2026-10-31T00:00:00Z", mime: "video/mp4", kind: "video" }, 1, undefined, () => new Error("relay channel closed"));
  expect(shown()).toContain("The file could not be opened.");
  expect(shown()).not.toContain("Download it or open the raw file.");
});
