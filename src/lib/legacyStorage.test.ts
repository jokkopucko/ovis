import { describe, expect, it } from "bun:test";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number { return this.items.size; }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  setItem(key: string, value: string): void { this.items.set(key, value); }
  removeItem(key: string): void { this.items.delete(key); }
  clear(): void { this.items.clear(); }
}

const host = globalThis as { window?: unknown };
const previousWindow = host.window;
host.window = { localStorage: new MemoryStorage(), sessionStorage: new MemoryStorage() };
const { adoptLegacyStorage, adoptLegacyStores } = await import("./legacyStorage.ts");
if (previousWindow === undefined) delete host.window; else host.window = previousWindow;

describe("browser storage from before the rename", () => {
  it("moves every app key to its new name and leaves other sites' keys alone", () => {
    const storage = new MemoryStorage();
    storage.setItem("herdr-web-ui:settings", "{\"theme\":\"day\"}");
    storage.setItem("herdr-web-ui:composer-draft:local:w1:p1", "half a message");
    storage.setItem("other-app:key", "theirs");
    adoptLegacyStorage(storage);
    expect(storage.getItem("ovis:settings")).toBe("{\"theme\":\"day\"}");
    expect(storage.getItem("ovis:composer-draft:local:w1:p1")).toBe("half a message");
    expect(storage.getItem("other-app:key")).toBe("theirs");
    expect(storage.getItem("herdr-web-ui:settings")).toBeNull();
    expect(storage.length).toBe(3);
  });

  it("keeps what the app already saved under the new name", () => {
    const storage = new MemoryStorage();
    storage.setItem("herdr-web-ui:settings", "old");
    storage.setItem("ovis:settings", "new");
    adoptLegacyStorage(storage);
    expect(storage.getItem("ovis:settings")).toBe("new");
    // gone, so a draft cleared under the new name never comes back from the old one
    expect(storage.getItem("herdr-web-ui:settings")).toBeNull();
  });

  it("moves what storage there is where a WebView has local storage turned off", () => {
    const session = new MemoryStorage();
    session.setItem("herdr-web-ui:selection", "w1:p1");
    expect(() => adoptLegacyStores({ localStorage: null, sessionStorage: session })).not.toThrow();
    expect(session.getItem("ovis:selection")).toBe("w1:p1");
  });
});
