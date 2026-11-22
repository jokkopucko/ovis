import { expect, it } from "bun:test";
import { ApiError } from "./api.ts";
import { fileFailure } from "./fileFailure.ts";
import { relayResourceBlob } from "./relay/resources.ts";

it("keeps HTTP categories through both API and relay blob failures", async () => {
  for (const [status, kind] of [[401, "signed-out"], [403, "forbidden"], [404, "missing"], [429, "limited"], [500, "server"], [504, "slow"]] as const) {
    expect(fileFailure(new ApiError("/api/fs/file", status, "refused", null))).toBe(kind);
    const failure = await relayResourceBlob(new Response(null, { status })).then(() => null, (reason: unknown) => reason);
    expect(fileFailure(failure)).toBe(kind);
  }
});

it("uses a machine failure code ahead of the generic gateway status", () => {
  expect(fileFailure(new ApiError("/api/fs/stat", 502, "away", "machine_offline"))).toBe("offline");
  expect(fileFailure(new ApiError("/api/fs/stat", 502, "slow", "machine_timeout"))).toBe("slow");
});

it("distinguishes a failed network request and timeout from an unreadable file", () => {
  expect(fileFailure(new TypeError("Failed to fetch"))).toBe("offline");
  expect(fileFailure(new DOMException("aborted", "AbortError"))).toBe("slow");
  expect(fileFailure(new Error("decoder failed"))).toBe("unreadable");
});

it("does not blame the PC for an uncoded gateway failure: the request may have failed in transit", async () => {
  for (const status of [502, 503]) {
    expect(fileFailure(new ApiError("/api/fs/file", status, "Bad Gateway", null))).toBe("unreadable");
    const failure = await relayResourceBlob(new Response(null, { status })).then(() => null, (reason: unknown) => reason);
    expect(fileFailure(failure)).toBe("unreadable");
  }
  expect(fileFailure(new ApiError("/api/fs/file", 502, "bad answer", "remote_response_invalid"))).toBe("server");
});
