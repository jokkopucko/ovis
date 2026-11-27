import { afterEach, describe, expect, test } from "bun:test";

import { downloadLeavesApp, fileSaveRoute, imageFile, pcFile, SAVE_MAX_BYTES, SAVE_PLUGIN, saveInApp, saveRoute, shareFile } from "./saveImage.ts";
import { nativeTransport, setTransport, type Transport } from "./transport.ts";

const saved = new Map(["navigator", "Capacitor", "isSecureContext"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

afterEach(() => {
  setTransport(nativeTransport);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

type NativeCall = (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;

/** A plugin by name, or by name and the methods the app announces for it. */
type Plugin = string | { name: string; methods: string[] };

function environment(navigator: Record<string, unknown>, platform?: string, plugins: Plugin[] = [], nativePromise?: NativeCall): void {
  Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true, writable: true });
  if (platform === undefined) Reflect.deleteProperty(globalThis, "Capacitor");
  else Object.defineProperty(globalThis, "Capacitor", {
    value: { isNativePlatform: () => true, getPlatform: () => platform, PluginHeaders: plugins.map((plugin) => typeof plugin === "string" ? { name: plugin } : { name: plugin.name, methods: plugin.methods.map((name) => ({ name })) }), nativePromise },
    configurable: true,
    writable: true,
  });
}

describe("saveRoute", () => {
  test("is the Android app when it has the save plugin", () => {
    environment({}, "android", [SAVE_PLUGIN]);
    expect(saveRoute()).toBe("app");
  });

  test("is the share sheet where a link would leave the app or do nothing", () => {
    environment({ standalone: true });
    expect(saveRoute()).toBe("share");
    environment({}, "ios");
    expect(saveRoute()).toBe("share");
    environment({}, "android");
    expect(saveRoute()).toBe("share");
  });

  test("is the download link in a browser tab", () => {
    environment({ standalone: false });
    expect(saveRoute()).toBe("link");
  });
});

describe("fileSaveRoute", () => {
  test("is the Android app when its save plugin can save any file", () => {
    environment({}, "android", [{ name: SAVE_PLUGIN, methods: ["saveImage", "saveFile"] }]);
    expect(fileSaveRoute()).toBe("app");
  });

  test("asks for a newer Android app where the app saves only pictures, or nothing", () => {
    // its WebView drops a download link without a word, and it has no share sheet
    environment({}, "android", [{ name: SAVE_PLUGIN, methods: ["saveImage"] }]);
    expect(fileSaveRoute()).toBe("update");
    environment({}, "android");
    expect(fileSaveRoute()).toBe("update");
  });

  test("is the share sheet where a link would load the file over the app", () => {
    Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
    const webShare = { share: async () => {}, canShare: () => true };
    environment({ ...webShare, standalone: true });
    expect(fileSaveRoute()).toBe("share");
    environment(webShare, "ios", [SAVE_PLUGIN]);
    expect(fileSaveRoute()).toBe("share");
  });

  test.each([
    ["the PC is on plain LAN HTTP", false, { share: async () => {}, canShare: (): boolean => true }],
    ["Web Share is missing", true, { canShare: (): boolean => true }],
    ["file sharing support is missing", true, { share: async () => {} }],
  ] as const)("uses the download link in the iOS app when %s", (_reason, secure, navigator) => {
    Object.defineProperty(globalThis, "isSecureContext", { value: secure, configurable: true });
    environment(navigator, "ios");
    expect(fileSaveRoute()).toBe("link");
  });

  test("is the download link in a browser tab", () => {
    environment({ standalone: false });
    expect(fileSaveRoute()).toBe("link");
  });
});

describe("pcFile", () => {
  test("reads any PC file through the transport, under its name and the type the PC gave it", async () => {
    const asked: string[] = [];
    setTransport({ ...nativeTransport, kind: "relay", fetch: async (input) => {
      asked.push(String(input));
      return new Response("# notes", { headers: { "content-type": "application/octet-stream" } });
    } });
    const file = await pcFile("/api/fs/file?path=%2Fprivate%2Ftmp%2Fnotes.md", "notes.md", "text/markdown");
    expect(asked).toEqual(["/api/fs/file?path=%2Fprivate%2Ftmp%2Fnotes.md"]);
    expect([file.name, file.type, await file.text()]).toEqual(["notes.md", "text/markdown", "# notes"]);
  });

  test("fails on a refused read", async () => {
    setTransport({ ...nativeTransport, fetch: async () => new Response("no", { status: 403 }) });
    await expect(pcFile("/api/fs/file?path=%2Fx", "x", "text/plain")).rejects.toThrow("HTTP 403");
  });

  test.each([SAVE_MAX_BYTES, SAVE_MAX_BYTES + 1])("bounds a file response without Content-Length (%i bytes)", async (size) => {
    let remaining = size;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) { controller.close(); return; }
        const length = Math.min(chunk.byteLength, remaining);
        remaining -= length;
        controller.enqueue(chunk.subarray(0, length));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    setTransport({ ...nativeTransport, fetch: async () => new Response(body) });
    const file = pcFile("/api/fs/file?path=%2Fx", "x", "");
    if (size === SAVE_MAX_BYTES) {
      expect((await file).size).toBe(size);
    } else {
      await expect(file).rejects.toMatchObject({ name: "FileSaveTooLargeError" });
      expect(cancelled).toBe(true);
    }
  });

  test("saves a complete range response and never saves a truncated range", async () => {
    const src = "/api/fs/file?path=%2Fx";
    let total = 3;
    setTransport({ ...nativeTransport, fetch: async (_input, init) =>
      new Headers(init?.headers).has("range")
        ? new Response("abc", { status: 206, headers: { "content-range": `bytes 0-2/${total}` } })
        : new Response("abc"),
    });
    expect(await (await pcFile(src, "x", "")).text()).toBe("abc");
    total = 4;
    await expect(pcFile(src, "x", "")).rejects.toThrow();
  });
});

describe("saveInApp", () => {
  test("hands any file to the app's saveFile", async () => {
    const calls: [string, string, unknown][] = [];
    environment({}, "android", [{ name: SAVE_PLUGIN, methods: ["saveFile"] }], async (plugin, method, options) => {
      calls.push([plugin, method, options?.type]);
      return { saved: "downloads" };
    });
    expect(await saveInApp(new File(["%PDF"], "report.pdf", { type: "application/pdf" }), "saveFile")).toBe("saved");
    expect(calls).toEqual([[SAVE_PLUGIN, "saveFile", "application/pdf"]]);
  });

  test("hands the app the file's name, type and exact bytes", async () => {
    const calls: [string, string, Record<string, unknown> | undefined][] = [];
    environment({}, "android", [SAVE_PLUGIN], async (plugin, method, options) => {
      calls.push([plugin, method, options]);
      return { saved: "downloads" };
    });
    const bytes = Uint8Array.from({ length: 0x8000 * 2 + 7 }, (_, at) => at % 256);
    expect(await saveInApp(new File([bytes], "shot.png", { type: "image/png" }))).toBe("saved");
    expect(calls.map(([plugin, method, options]) => [plugin, method, options?.name, options?.type])).toEqual([[SAVE_PLUGIN, "saveImage", "shot.png", "image/png"]]);
    expect(Uint8Array.from(atob(String(calls[0]![2]!.data)), (char) => char.charCodeAt(0))).toEqual(bytes);
  });

  test("is shared when the app opened the share sheet, and failed when it refused", async () => {
    const file = new File(["png"], "shot.png", { type: "image/png" });
    environment({}, "android", [SAVE_PLUGIN], async () => ({ saved: "shared" }));
    expect(await saveInApp(file)).toBe("shared");
    environment({}, "android", [SAVE_PLUGIN], () => Promise.reject(new Error("Only a picture can be saved.")));
    expect(await saveInApp(file)).toBe("failed");
  });

  test("fails a picture over the app's limit without handing it over", async () => {
    let calls = 0;
    environment({}, "android", [SAVE_PLUGIN], async () => { calls++; return { saved: "downloads" }; });
    expect(await saveInApp(new File([new Uint8Array(SAVE_MAX_BYTES + 1)], "huge.png", { type: "image/png" }))).toBe("failed");
    expect(calls).toBe(0);
  });
});

describe("downloadLeavesApp", () => {
  test("is true in a home-screen web app and in the iOS app", () => {
    environment({ standalone: true });
    expect(downloadLeavesApp()).toBe(true);
    environment({}, "ios");
    expect(downloadLeavesApp()).toBe(true);
  });

  test("is false in a browser tab and in the Android app", () => {
    environment({ standalone: false });
    expect(downloadLeavesApp()).toBe(false);
    environment({});
    expect(downloadLeavesApp()).toBe(false);
    environment({}, "android");
    expect(downloadLeavesApp()).toBe(false);
  });
});

describe("imageFile", () => {
  test("reads a PC's picture through the transport, keeping its image type", async () => {
    // Given a relay PC, whose pictures the page shows from blob: URLs its CSP lets no fetch read
    const asked: string[] = [];
    const relay: Transport = { ...nativeTransport, kind: "relay", fetch: async (input) => {
      asked.push(String(input));
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    } };
    setTransport(relay);
    const file = await imageFile("/api/fs/file?path=%2Fshot.png", "shot.png", null);
    expect(asked).toEqual(["/api/fs/file?path=%2Fshot.png"]);
    expect([file.name, file.type, file.size]).toEqual(["shot.png", "image/png", 4]);
  });

  test("refuses a picture that is neither a PC path nor drawn", async () => {
    await expect(imageFile("data:image/png;base64,iVBORw0KGgo=", "inline.png", null)).rejects.toThrow("picture not shown");
  });
});

describe("shareFile", () => {
  const file = new File(["png"], "shot.png", { type: "image/png" });

  test("hands the file itself to the share sheet", async () => {
    const shared: ShareData[] = [];
    environment({ canShare: () => true, share: async (data: ShareData) => { shared.push(data); } });
    expect(await shareFile(file)).toBe("shared");
    expect(shared).toEqual([{ files: [file] }]);
  });

  test("a dismissed sheet is a cancel, not a failure", async () => {
    environment({ canShare: () => true, share: () => Promise.reject(new DOMException("dismissed", "AbortError")) });
    expect(await shareFile(file)).toBe("cancelled");
  });

  test("fails without a share sheet that takes files, or when it refuses", async () => {
    environment({});
    expect(await shareFile(file)).toBe("failed");
    environment({ canShare: () => false, share: async () => {} });
    expect(await shareFile(file)).toBe("failed");
    environment({ canShare: () => true, share: () => Promise.reject(new DOMException("no gesture", "NotAllowedError")) });
    expect(await shareFile(file)).toBe("failed");
  });
});
