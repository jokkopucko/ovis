import { afterEach, describe, expect, test } from "bun:test";

import { downloadLeavesApp, imageFile, SAVE_MAX_BYTES, SAVE_PLUGIN, saveInApp, saveRoute, shareFile } from "./saveImage.ts";
import { nativeTransport, setTransport, type Transport } from "./transport.ts";

const saved = new Map(["navigator", "Capacitor"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

afterEach(() => {
  setTransport(nativeTransport);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

type NativeCall = (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;

function environment(navigator: Record<string, unknown>, platform?: string, plugins: string[] = [], nativePromise?: NativeCall): void {
  Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true, writable: true });
  if (platform === undefined) Reflect.deleteProperty(globalThis, "Capacitor");
  else Object.defineProperty(globalThis, "Capacitor", {
    value: { isNativePlatform: () => true, getPlatform: () => platform, PluginHeaders: plugins.map((name) => ({ name })), nativePromise },
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

describe("saveInApp", () => {
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
