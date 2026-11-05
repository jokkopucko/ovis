import { describe, expect, it } from "bun:test";

// the module fills in only what is missing: each built-in is taken away first, as an older Safari
// lacks it, and Bun's own put back afterwards so later test files see the real ones
const owners: [object, string][] = [[Promise, "withResolvers"], [AbortSignal, "any"]];
const native = owners.map(([owner, name]) => [owner, name, Object.getOwnPropertyDescriptor(owner, name)] as const);
for (const [owner, name] of owners) delete (owner as Record<string, unknown>)[name];
// Bun's randomUUID cannot be deleted: a crypto with getRandomValues alone stands in, as on
// plain http
const host = globalThis as { crypto: Crypto };
const nativeCrypto = host.crypto;
const plainCrypto = { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) } as Crypto;
Object.defineProperty(globalThis, "crypto", { value: plainCrypto, configurable: true, writable: true });
await import("./builtins.ts");
const filled = { withResolvers: Promise.withResolvers, any: AbortSignal.any, randomUUID: plainCrypto.randomUUID.bind(plainCrypto) };
Object.defineProperty(globalThis, "crypto", { value: nativeCrypto, configurable: true, writable: true });
for (const [owner, name, descriptor] of native) {
  delete (owner as Record<string, unknown>)[name];
  if (descriptor) Object.defineProperty(owner, name, descriptor);
}

describe("builtins for browsers older than the app's calls", () => {
  it("fills every built-in in, not left to the host's own", () => {
    expect(filled.withResolvers).not.toBe(Promise.withResolvers);
    expect(filled.any).not.toBe(AbortSignal.any);
  });

  it("Promise.withResolvers settles the promise it returns", async () => {
    const yes = filled.withResolvers.call(Promise) as ReturnType<typeof Promise.withResolvers<number>>;
    yes.resolve(3);
    expect(await yes.promise).toBe(3);
    const no = filled.withResolvers.call(Promise) as ReturnType<typeof Promise.withResolvers<number>>;
    no.reject(new Error("refused"));
    await expect(no.promise).rejects.toThrow("refused");
  });

  it("AbortSignal.any aborts with the first reason given, or at once when one already has", () => {
    const first = new AbortController(), second = new AbortController();
    const joined = filled.any([first.signal, second.signal]);
    expect(joined.aborted).toBe(false);
    second.abort("second");
    first.abort("first");
    expect(joined.aborted).toBe(true);
    expect(joined.reason).toBe("second");
    expect(filled.any([AbortSignal.abort("done")]).reason).toBe("done");
  });

  it("crypto.randomUUID answers a version 4 UUID", () => {
    const id = filled.randomUUID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(filled.randomUUID()).not.toBe(id);
  });
});
