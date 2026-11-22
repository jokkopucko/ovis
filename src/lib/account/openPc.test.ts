import { describe, expect, it } from "bun:test";
import { MuxProtocolError } from "../../../shared/relay-mux.ts";
import { nextOpenStep, openRefusalOf } from "./openPc.ts";

describe("opening a PC with the account's sign-in", () => {
  it("T34: a held sign-in waits on the PC's own hold, whatever kind it is", () => {
    expect(nextOpenStep({ code: "held", hold: { reason: "join_hold", until: "2026-11-20T04:00:10.000Z" } }, false)).toEqual({ kind: "wait", hold: { reason: "join_hold", until: "2026-11-20T04:00:10.000Z" } });
    expect(nextOpenStep({ code: "held", hold: { reason: "catching_up" } }, true)).toEqual({ kind: "wait", hold: { reason: "catching_up" } });
  });

  it("G5: a key the PC does not list is tried once more, then the QR or digits path is offered", () => {
    expect(nextOpenStep({ code: "not_listed" }, false)).toEqual({ kind: "retry" });
    expect(nextOpenStep({ code: "not_listed" }, true)).toEqual({ kind: "pair" });
  });

  it("T34: a refusal by the PC's final guard offers the QR or digits path at once, with no retry", () => {
    expect(nextOpenStep({ code: "admission" }, false)).toEqual({ kind: "pair" });
  });
});

describe("reading a PC's refusal of the account sign-in", () => {
  const refused = (code: string, hold?: unknown) => Object.assign(new MuxProtocolError(code as never, "refused"), hold === undefined ? {} : { hold });

  it("T34: held, not_listed and admission become the app's refusals, held with its hold", () => {
    expect(openRefusalOf(refused("held", { reason: "catching_up" }))).toEqual({ code: "held", hold: { reason: "catching_up" } });
    expect(openRefusalOf(refused("not_listed"))).toEqual({ code: "not_listed" });
    expect(openRefusalOf(refused("admission"))).toEqual({ code: "admission" });
  });

  it("G5: any other failure, or a held one without its hold, is not an account refusal and keeps today's handling", () => {
    expect(openRefusalOf(refused("auth_failed"))).toBeNull();
    expect(openRefusalOf(refused("held"))).toBeNull();
    expect(openRefusalOf(new Error("offline"))).toBeNull();
  });
});
