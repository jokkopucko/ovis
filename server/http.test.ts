import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { HerdrError, herdrFault } from "./herdr/client.ts";
import { errorResponse, layoutResponse, requestFault, requestIdContext, wordHerdrFailures } from "./http.ts";
import { createServer } from "./index.ts";

describe("errorResponse", () => {
  it("answers a 500 with a fixed message and a correlation id, never the exception's own", async () => {
    const secret = "ENOENT: no such file or directory, open '/home/someone/.config/herdr-web-ui/devices.json'";
    const response = errorResponse(new Error(secret));
    expect(response.status).toBe(500);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("ENOENT");
    expect(body.error.message).not.toContain("/home/");
    expect(body.error.message).toMatch(/^internal error \([0-9a-f]{12}\)$/);
    expect(errorResponse(new Error(secret)).status).toBe(500);
    const second = await errorResponse(new Error(secret)).json() as { error: { message: string } };
    expect(second.error.message).not.toBe(body.error.message);
  });

  it("keeps an authored HerdrError message as it is", async () => {
    const connect = await errorResponse(new HerdrError("connect_failed", "herdr is not answering")).json() as { error: { code: string; message: string } };
    expect(errorResponse(new HerdrError("connect_failed", "herdr is not answering")).status).toBe(502);
    expect(connect.error).toEqual({ code: "connect_failed", message: "herdr is not answering" });
    expect(errorResponse(new HerdrError("pane_not_found", "no such pane")).status).toBe(404);
  });
});

describe("pane find HTTP validation", () => {
  const request = { pane_id: "w1:p1", query: "needle", direction: "forward" };
  const previous = { start: { row: 0, col: 0 }, end: { row: 0xffffffff, col: 0xffff } };
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  const find = spyOn(herdr, "paneFind").mockImplementation(async () => {
    throw new HerdrError("stale_content", "search content changed");
  });
  const post = (patch: Record<string, unknown>) => fetch(`http://127.0.0.1:${server.port}/api/pane/find`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, ...patch }),
  });
  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "herdr-find-http-"));
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  });
  afterEach(() => find.mockClear());
  afterAll(() => {
    server.stop();
    find.mockRestore();
    rmSync(stateDir, { recursive: true, force: true });
  });

  for (const patch of [
    {}, { jump: false }, { jump: true }, { content_revision: 0 },
    { previous, content_revision: Number.MAX_SAFE_INTEGER, jump: false },
    { previous: { ...previous, extra: "discard" }, content_revision: 0 },
  ]) {
    it(`forwards validated optional fields for ${JSON.stringify(patch)}`, async () => {
      const expected = { ...request, ...patch, ...("previous" in patch ? { previous } : {}) };
      const response = await post(patch);
      expect(find).toHaveBeenCalledTimes(1);
      expect(find).toHaveBeenCalledWith(expected);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "stale_content", message: "search content changed" } });
    });
  }

  for (const [patch, code] of [
    [{ jump: null }, "invalid_jump"], [{ jump: 0 }, "invalid_jump"], [{ jump: "false" }, "invalid_jump"],
    [{ content_revision: null }, "invalid_revision"], [{ content_revision: -1 }, "invalid_revision"],
    [{ content_revision: 0.5 }, "invalid_revision"], [{ content_revision: Number.MAX_SAFE_INTEGER + 1 }, "invalid_revision"],
    [{ previous: null, content_revision: 0 }, "invalid_previous"],
    [{ previous: [], content_revision: 0 }, "invalid_previous"],
    [{ previous: {}, content_revision: 0 }, "invalid_previous"],
    [{ previous }, "invalid_previous"], [{ previous, content_revision: "0" }, "invalid_previous"],
    ...[
      { row: -1, col: 0 }, { row: 0.5, col: 0 }, { row: 0x100000000, col: 0 },
      { row: 0, col: -1 }, { row: 0, col: 0.5 }, { row: 0, col: 0x10000 },
      { row: "0", col: 0 }, { row: 0, col: null },
    ].flatMap((point): [Record<string, unknown>, string][] => [
      [{ previous: { ...previous, start: point }, content_revision: 0 }, "invalid_previous"],
      [{ previous: { ...previous, end: point }, content_revision: 0 }, "invalid_previous"],
    ]),
  ] satisfies [Record<string, unknown>, string][]) {
    it(`rejects ${JSON.stringify(patch)} before calling herdr`, async () => {
      const response = await post(patch);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(find).not.toHaveBeenCalled();
    });
  }
});

describe("a failed herdr call's answer", () => {
  const failed = () => new HerdrError("connect_failed", "herdr's own words", false, true);
  it("is the error's own envelope with no view, byte for byte", async () => {
    const response = errorResponse(failed());
    expect([response.status, await response.text(), response.headers.get("cache-control")]).toEqual([502, '{"error":{"code":"connect_failed","message":"herdr\'s own words"}}', null]);
  });
  it("is the view's words, never stored, for a failed call inside a request that words them", async () => {
    const view = () => ({ code: "worded", message: "the view's words" });
    await requestIdContext.run({ id: "r", route: "" }, async () => {
      wordHerdrFailures(view, (reason) => `worded ${reason}`);
      const worded = errorResponse(failed());
      expect([worded.status, await worded.json(), worded.headers.get("cache-control")]).toEqual([502, { error: view() }, "no-store"]);
      expect(await errorResponse(new HerdrError("read_only", "this device can only watch")).json()).toEqual({ error: { code: "read_only", message: "this device can only watch" } });
      expect(requestFault(failed(), "unused")).toEqual(view());
      const layout = layoutResponse({ ok: true, changed: false, reason: "herdr's reason" });
      expect([await layout.json(), layout.headers.get("cache-control")]).toEqual([{ ok: true, changed: false, reason: "worded herdr's reason" }, "no-store"]);
    });
    expect(herdrFault(failed(), undefined)).toEqual({ code: "connect_failed", message: "herdr's own words" });
    const plain = layoutResponse({ ok: true, changed: false, reason: "herdr's reason" });
    expect([await plain.text(), plain.headers.get("cache-control")]).toEqual(['{"ok":true,"changed":false,"reason":"herdr\'s reason"}', null]);
  });
});
