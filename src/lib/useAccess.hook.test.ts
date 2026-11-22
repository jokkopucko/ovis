import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { BridgeHealth } from "../../shared/machines.ts";
import type { SecuritySummary } from "../../shared/protocol.ts";
import { useAccessState } from "./useAccess.ts";

type Hook = ReturnType<typeof useAccessState>;
const FACTS: SecuritySummary = { token_configured: true, pairing_gate: "closed", bind_scope: "loopback", observed_ingress: "direct", public_exposure: "unknown" };
const health = (security?: SecuritySummary): BridgeHealth => ({ ok: true, auth: { required: false, authenticated: true }, bridge_protocol: 1, ...(security ? { security } : {}) });

function mount() {
  const out: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  const reads: Promise<void>[] = [];
  const fetchHealth = () => new Promise<Response>((resolve, reject) => { out.push({ resolve, reject }); });
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetchHealth, { preconnect: globalThis.fetch.preconnect }));
  let hook: Hook | null = null;
  function Probe() { hook = useAccessState(); return null; }
  let renderer: ReactTestRenderer | null = null;
  act(() => { renderer = create(createElement(Probe)); });
  const live = (): Hook => { if (hook === null) throw new Error("not rendered"); return hook; };
  return {
    read: (): number => { reads.push(live().readBridgeHealth()); return reads.length - 1; },
    answer: async (read: number, body: BridgeHealth) => { await act(async () => { out[read]!.resolve(Response.json(body)); await reads[read]; }); },
    fail: async (read: number) => { await act(async () => { out[read]!.reject(new TypeError("Failed to fetch")); await reads[read]; }); },
    facts: () => live().security,
    access: live,
    unmount: () => act(() => { renderer!.unmount(); }),
  };
}

describe("access state", () => {
  const mounted: { unmount: () => void }[] = [];
  const at = () => { const probe = mount(); mounted.push(probe); return probe; };
  beforeAll(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
  afterEach(() => { for (const probe of mounted.splice(0)) probe.unmount(); mock.restore(); });

  describe("pairing links", () => {
    for (const outcome of ["success", "failure"] as const) {
      it(`consumes an address code before a ${outcome}, including another attempt before React renders`, async () => {
        const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
        Object.defineProperty(globalThis, "window", { configurable: true, value: {
          location: { href: "https://ovis.example/?pair=123456" },
          history: { state: null, replaceState() {} },
        } });
        try {
          const page = at();
          expect(page.access().pairCode).toBe("123456");
          act(() => {
            const consume = page.access().consumePairCode;
            expect(consume()).toBe("123456");
            expect(consume()).toBe("");
          });
          if (outcome === "success") act(() => page.access().onPaired());
          await page.answer(page.read(), { ...health(), auth: { required: true, authenticated: false } });
          expect(page.access().locked).toBe(true);
          expect(page.access().pairCode).toBe("");
          expect(page.access().pairingUnconfirmed).toBe(outcome === "success");
          expect(page.access().consumePairCode()).toBe("");
        } finally {
          if (saved) Object.defineProperty(globalThis, "window", saved);
          else Reflect.deleteProperty(globalThis, "window");
        }
      });
    }

    it("does not blame cookies for a later sign-out after pairing was confirmed", async () => {
      const page = at();
      act(() => page.access().onPaired());
      await page.answer(page.read(), health());
      await page.answer(page.read(), { ...health(), auth: { required: true, authenticated: false } });
      expect(page.access().pairingUnconfirmed).toBe(false);
    });
  });

  it("never shows an older answer's facts once a newer read has failed", async () => {
    const page = at();
    const older = page.read();
    const newer = page.read();
    await page.fail(newer);
    expect(page.facts()).toEqual({ state: "error" });
    await page.answer(older, health(FACTS));
    expect(page.facts()).toEqual({ state: "error" });
  });

  it("drops the facts on screen when a read fails while a newer one is still out", async () => {
    const page = at();
    const first = page.read();
    await page.answer(first, health(FACTS));
    expect(page.facts()).toEqual({ state: "known", summary: FACTS });
    const failing = page.read();
    const pending = page.read();
    await page.fail(failing);
    expect(page.facts()).toEqual({ state: "error" });
    await page.answer(pending, health(FACTS));
    expect(page.facts()).toEqual({ state: "known", summary: FACTS });
  });

  it("reads an answer without facts as an older server, never as fine", async () => {
    const page = at();
    expect(page.facts()).toEqual({ state: "loading" });
    await page.answer(page.read(), health());
    expect(page.facts()).toEqual({ state: "absent" });
  });
});
