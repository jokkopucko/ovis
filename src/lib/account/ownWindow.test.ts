import { describe, expect, it } from "bun:test";
import { handOverReturn, ownWindowBridge, ownWindowRedirect } from "./ownWindow.ts";

const page = (origin: string) => { const url = new URL(origin); return { protocol: url.protocol, hostname: url.hostname, port: url.port }; };

describe("which window signs in through the loopback redirect", () => {
  it("is only the PC's own window, on exactly 127.0.0.1 and the port the PC reports", () => {
    expect(ownWindowRedirect({ own_window: { port: 7317 } }, page("http://127.0.0.1:7317"))).toBe("http://127.0.0.1:7317/callback");
    expect(ownWindowRedirect({}, page("http://127.0.0.1:7317"))).toBeNull();
    for (const elsewhere of ["http://localhost:7317", "http://[::1]:7317", "http://127.0.0.1:7318", "https://127.0.0.1:7317", "http://100.64.0.9:7317"]) {
      expect(ownWindowRedirect({ own_window: { port: 7317 } }, page(elsewhere))).toBeNull();
    }
  });
});

describe("the return from the provider's tab", () => {
  it("reaches the window whose sign-in it names, and only that one", async () => {
    const service = "https://account.test";
    const signIn = `${service}/v1/signin/google?state=mine&code_challenge=x`;
    const mine = ownWindowBridge(service, "http://127.0.0.1:7317/callback", null, new AbortController().signal, () => {});
    const otherWaits = new AbortController();
    const otherBridge = ownWindowBridge(service, "http://127.0.0.1:7317/callback", null, otherWaits.signal, () => {});
    const waiting = otherBridge.open(`${service}/v1/signin/google?state=theirs`).catch(() => "ended");
    const taken = Promise.withResolvers<void>();
    const back = mine.open(signIn);
    const stop = handOverReturn("?code=c1&state=mine", taken.resolve);
    expect(await back).toBe("?code=c1&state=mine");
    await taken.promise;
    stop();
    otherWaits.abort();
    expect(await waiting).toBe("ended");
  });

  it("offers the sign-in page as a link when the browser blocked the tab, and ends the wait when cancelled", async () => {
    const offered: string[] = [];
    const cancel = new AbortController();
    const bridge = ownWindowBridge("https://account.test", "http://127.0.0.1:7317/callback", null, cancel.signal, (url) => offered.push(url));
    const waiting = bridge.open("https://account.test/v1/signin/google?state=s1");
    expect(offered).toEqual(["https://account.test/v1/signin/google?state=s1"]);
    cancel.abort();
    await expect(waiting).rejects.toBeDefined();
  });
});
