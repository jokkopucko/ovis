/**
 * What the app does when a PC refuses its account sign-in (device table T34, G5; Track D's AUTH refusals): a held
 * sign-in waits on that PC's own hold; a key the PC does not list is tried once more, since the refusal starts the
 * PC's read, then the QR or digits path is offered; a refusal by the PC's final guard offers that path at once.
 */
import type { HoldState } from "../../../shared/account-devices-api.ts";
import { MuxProtocolError } from "../../../shared/relay-mux.ts";

export type OpenRefusal = { readonly code: "held"; readonly hold: HoldState } | { readonly code: "not_listed" } | { readonly code: "admission" };
export type OpenStep = { readonly kind: "wait"; readonly hold: HoldState } | { readonly kind: "retry" } | { readonly kind: "pair" };

export function nextOpenStep(refusal: OpenRefusal, triedAgain: boolean): OpenStep {
  switch (refusal.code) {
    case "held": return { kind: "wait", hold: refusal.hold };
    case "not_listed": return triedAgain ? { kind: "pair" } : { kind: "retry" };
    case "admission": return { kind: "pair" };
  }
}

/**
 * The account refusal a relay sign-in failed with, or null for any other failure (today's handling stays). The relay
 * parser checked the hold state when it read the frame (Track D, S2-25); a held refusal without one is not trusted.
 */
export function openRefusalOf(error: unknown): OpenRefusal | null {
  if (!(error instanceof MuxProtocolError)) return null;
  const code: string = error.code;
  if (code === "not_listed" || code === "admission") return { code };
  const hold: unknown = (error as { hold?: unknown }).hold;
  if (code !== "held" || typeof hold !== "object" || hold === null || typeof (hold as { reason?: unknown }).reason !== "string") return null;
  return { code, hold: hold as HoldState };
}
