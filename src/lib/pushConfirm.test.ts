import { describe, expect, it } from "bun:test";

import { ApiError } from "./api.ts";
import { confirmation, recordConfirmation, recordTestFailure } from "./pushConfirm.ts";

const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

describe("the confirmation push's outcome", () => {
  it("is kept for the subscription it went to, and is no answer for another", () => {
    const storage = memory();
    expect(confirmation("https://push.example/1", storage)).toBeNull();
    recordConfirmation("https://push.example/1", false, storage);
    expect(confirmation("https://push.example/1", storage)).toBe(false);
    expect(confirmation("https://push.example/2", storage)).toBeNull();
    expect(confirmation(null, storage)).toBeNull();
    recordConfirmation("https://push.example/1", true, storage);
    expect(confirmation("https://push.example/1", storage)).toBe(true);
  });

  it("keeps a Send test's failure only when the PC answered that it could not push", () => {
    const storage = memory();
    recordConfirmation("https://push.example/1", true, storage);
    for (const unanswered of [new TypeError("Failed to fetch"), new ApiError("/api/push/test", 503, "restarting", "unavailable"), new ApiError("/api/push/test", 502, "Bad Gateway", null), new ApiError("/api/push/test", 401, "signed out", "unauthorized"), new ApiError("/api/push/test", 500, "internal error", "internal_error"), new ApiError("/api/push/test", 403, "read only", "read_only")]) {
      recordTestFailure("https://push.example/1", unanswered, storage);
      expect(confirmation("https://push.example/1", storage)).toBe(true);
    }
    for (const [status, code] of [[502, "push_failed"], [410, "subscription_gone"], [404, "subscription_not_found"]] as const) {
      recordConfirmation("https://push.example/1", true, storage);
      recordTestFailure("https://push.example/1", new ApiError("/api/push/test", status, "failed", code), storage);
      expect(confirmation("https://push.example/1", storage)).toBe(false);
    }
  });

  it("is none where storage refuses", () => {
    const refusing = { getItem: (): string | null => { throw new Error("denied"); }, setItem: (): void => { throw new Error("denied"); } };
    expect(() => recordConfirmation("https://push.example/1", true, refusing)).not.toThrow();
    expect(confirmation("https://push.example/1", refusing)).toBeNull();
    expect(confirmation("https://push.example/1", null)).toBeNull();
  });
});
