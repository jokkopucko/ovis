import { expect, test } from "bun:test";
import type { RelayStatus } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { failureText, statusText } from "./RelayPanel.tsx";

const t = ((text: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text)) as Parameters<typeof statusText>[0];
const base: RelayStatus = { phase: "online", relay: "wss://relay.ovis.sh", app: "https://app.ovis.sh", sessions: 0, blocked: null, error: null };

test("the relay row says when Ovis's relay needs an account, and nothing new otherwise", () => {
  expect(statusText(t, base)).toBe("Online. No phone connected.");
  expect(statusText(t, { ...base, pass: { state: "ok", relay: "ok", enforce_at: null, refused: false } })).toBe("Online. No phone connected.");
  expect(statusText(t, { ...base, phase: "error", error: "The Ovis relay needs a signed-in account (relay pass required).", pass: { state: "no_account", relay: null, enforce_at: null, refused: true } }))
    .toBe("The Ovis relay needs an Ovis account. Sign in, or connect over the same Wi-Fi or Tailscale.");
  expect(statusText(t, { ...base, phase: "error", pass: { state: "limit", relay: null, enforce_at: null, refused: true } })).toStartWith("This account has as many PCs");
  expect(statusText(t, { ...base, phase: "error", pass: { state: "unavailable", relay: null, enforce_at: null, refused: true } })).toBe("Cannot reach the Ovis account service for a relay pass. Retrying.");
  expect(statusText(t, { ...base, pass: { state: "no_account", relay: "missing", enforce_at: "2027-01-01T00:00:00.000Z", refused: false } })).toStartWith("Online. Sign in to keep using the Ovis relay after ");
  expect(statusText(t, { ...base, phase: "error", error: "Relay connection lost; reconnecting.", pass: { state: "no_account", relay: null, enforce_at: null, refused: false } })).toBe("Error: Relay connection lost; reconnecting.");
  expect(statusText(t, { ...base, phase: "error", error: "Relay connection lost; reconnecting.", pass: { state: "unavailable", relay: null, enforce_at: null, refused: false } })).toBe("Error: Relay connection lost; reconnecting.");
  expect(statusText(t, { ...base, phase: "error", pass: { state: "not_listed", relay: null, enforce_at: null, refused: true } })).toStartWith("Add this PC to your Ovis account");
  expect(statusText(t, { ...base, phase: "error", error: "x", pass: { state: "ok", relay: null, enforce_at: null, refused: true } })).toBe("Error: x");
  expect(statusText(t, { ...base, pass: { state: "ok", relay: "missing", enforce_at: "2027-01-01T00:00:00.000Z", refused: false } })).toBe("Online. No phone connected.");
  expect(statusText(t, { ...base, phase: "error", error: "Relay connection lost; reconnecting.", pass: { state: "ok", relay: "ok", enforce_at: null, refused: false } })).toBe("Error: Relay connection lost; reconnecting.");
});

test("a machine's refusal to make a pairing code is said in words, and any other refusal keeps the server's own", () => {
  // a machine makes no code that names no account
  expect(failureText(new ApiError("/api/relay/offer", 409, "machine profile", "machine_profile"))).toBe("Run ovis add on this machine, then scan its QR code with a signed-in device.");
  expect(failureText(new ApiError("/api/relay/offer", 409, "This PC is already in an Ovis account.", "in_account"))).toBe("This PC is already in an Ovis account.");
});
