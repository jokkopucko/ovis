import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiError, PaneFindResponse } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { HerdrError, herdrRpc, herdrSocketPath, paneRead, paneScroll, paneScrollInfo, workspaceClose, workspaceCreate } from "./herdr/client.ts";

describe("POST /api/pane/find", () => {
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  let workspaceId: string;
  let paneId: string;
  const marker = "find_needle_contract";
  const post = (body: unknown) => fetch(`http://localhost:${server.port}/api/pane/find`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "herdr-find-contract-"));
    server = createServer({ port: 0, stateDir, registerBridge: false });
    const created = await workspaceCreate({ cwd: stateDir, label: "ovis-test-find" });
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
    // The sentinel is assembled at runtime, so the echoed command
    // cannot satisfy the wait.
    const ready = herdrRpc("pane.wait_for_output", {
      pane_id: paneId, source: "visible", match: { type: "substring", value: "find_ready_contract" }, timeout_ms: 10000,
    }, undefined, 12000);
    await herdrRpc("pane.send_input", {
      pane_id: paneId,
      text: "printf 'log: find_%s tail\\n' needle_contract; seq 1 150; printf 'log: find_%s tail\\n' needle_contract; seq 151 320; printf 'wide_%s%s%sZ\\n' '界' 'e' '́'; printf 'wrap_%0900d_tail\\n' 0; printf 'hard_%s\\nhard_%s\\n' tail head; for n in $(seq 1 1500); do printf 'crowd_%s ' needle; done; printf '\\nfind_%s\\n' ready_contract; exec cat",
      keys: ["enter"],
    });
    await ready;
  }, 15000);

  afterAll(async () => {
    server?.stop();
    if (workspaceId) await workspaceClose(workspaceId);
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it("finds history above the viewport and scrolls to its native match", async () => {
    await paneScroll(paneId, 0);
    const response = await post({ pane_id: paneId, query: marker, direction: "backward" });
    expect(response.status).toBe(200);
    const result: PaneFindResponse = await response.json();
    expect(result.total).toBe(2);
    expect(result.current).toBe(2);
    expect(result.match).not.toBeNull();
    expect(result.matches).toHaveLength(2);
    expect(result.matches).toContainEqual(result.match!);
    expect(result.scroll).toEqual(await paneScrollInfo(paneId));
    expect((await paneScrollInfo(paneId))?.offset_from_bottom).toBeGreaterThan(100);
    expect((await paneRead({ paneId })).text).toContain(marker);
  });

  it("returns native ranges and viewport mapping without scrolling when jump is false", async () => {
    await paneScroll(paneId, 0);
    const before = await paneScrollInfo(paneId);
    const response = await post({ pane_id: paneId, query: marker, direction: "backward", jump: false });
    expect(response.status).toBe(200);
    const result: PaneFindResponse = await response.json();
    expect(result.total).toBe(2);
    expect(result.matches).toHaveLength(2);
    expect(result.matches).toContainEqual(result.match!);
    expect(result.scroll).toEqual(before);
    expect(await paneScrollInfo(paneId)).toEqual(before);
  });

  it("returns inclusive native cell ranges for wide, combining and softly wrapped text", async () => {
    const wideResponse = await post({ pane_id: paneId, query: "界éZ", direction: "backward", jump: false });
    expect(wideResponse.status).toBe(200);
    const wide: PaneFindResponse = await wideResponse.json();
    expect(wide.total).toBe(1);
    expect(wide.match?.start.row).toBe(wide.match?.end.row);
    expect(wide.match!.end.col - wide.match!.start.col).toBe(3);
    expect(wide.matches).toEqual([wide.match!]);
    const wrapResponse = await post({ pane_id: paneId, query: `wrap_${"0".repeat(900)}_tail`, direction: "backward", jump: false });
    expect(wrapResponse.status).toBe(200);
    const wrapped: PaneFindResponse = await wrapResponse.json();
    expect(wrapped.total).toBe(1);
    expect(wrapped.match!.end.row).toBeGreaterThan(wrapped.match!.start.row);
    const hardResponse = await post({ pane_id: paneId, query: "hard_tailhard_head", direction: "backward", jump: false });
    expect(hardResponse.status).toBe(200);
    expect(await hardResponse.json()).toMatchObject({ total: 0, matches: [] });
  });

  it("keeps the native match window bounded while reporting the exact total", async () => {
    const response = await post({ pane_id: paneId, query: "crowd_needle", direction: "backward", jump: false });
    expect(response.status).toBe(200);
    const result: PaneFindResponse = await response.json();
    expect(result.total).toBe(1500);
    expect(result.matches).toHaveLength(1024);
    expect(result.matches).toContainEqual(result.match!);
  });

  it("uses the previous native range for forward navigation and wraps backward", async () => {
    await paneScroll(paneId, 0);
    const first: PaneFindResponse = await (await post({ pane_id: paneId, query: marker, direction: "backward" })).json();
    const next: PaneFindResponse = await (await post({
      pane_id: paneId, query: marker, direction: "forward", previous: first.match, content_revision: first.content_revision,
    })).json();
    expect(next.current).toBe(1);
    expect(next.match?.start.row).toBeLessThan(first.match?.start.row ?? 0);
    const previous: PaneFindResponse = await (await post({
      pane_id: paneId, query: marker, direction: "backward", previous: next.match, content_revision: next.content_revision,
    })).json();
    expect(previous.current).toBe(2);
    expect(previous.match).toEqual(first.match);
  });

  it("returns no match without moving the viewport", async () => {
    const before = await paneScrollInfo(paneId);
    const response = await post({ pane_id: paneId, query: "absent_find_contract", direction: "forward" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 0, current: null, match: null });
    expect(await paneScrollInfo(paneId)).toEqual(before);
  });

  it("treats query punctuation as literal text", async () => {
    const response = await post({ pane_id: paneId, query: "[", direction: "forward" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 0, match: null });
  });

  it("rejects malformed queries with the shared error envelope", async () => {
    for (const query of ["", 17, null, {}, "x".repeat(1025)]) {
      const response = await post({ pane_id: paneId, query, direction: "forward" });
      expect(response.status).toBe(400);
      expect((await response.json() as ApiError).error.code).toBe("invalid_query");
    }
  });

  it("rejects unknown panes without falling back to the focused pane", async () => {
    const response = await post({ pane_id: "w999999:p999999", query: marker, direction: "backward" });
    expect(response.status).toBe(404);
    expect((await response.json() as ApiError).error.code).toBe("pane_not_found");
  });

  it("validates navigation state before passing it to herdr", async () => {
    for (const patch of [
      { direction: "sideways" },
      { previous: { start: { row: -1, col: 0 }, end: { row: 0, col: 0 } }, content_revision: 0 },
      { previous: { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } } },
      { content_revision: 0.5 },
      { jump: "false" },
      { jump: null },
      { jump: 0 },
    ]) {
      expect((await post({ pane_id: paneId, query: marker, direction: "forward", ...patch })).status).toBe(400);
    }
  });

  for (const direction of ["forward", "backward"] as const) {
    it(`refuses stale previous ranges when navigating ${direction} after unrelated output`, async () => {
      await paneScroll(paneId, 0);
      const first: PaneFindResponse = await (await post({ pane_id: paneId, query: marker, direction: "backward" })).json();
      expect(first.match?.start.col).toBeGreaterThan(0);
      const value = `find_navigation_${direction}`;
      const output = herdrRpc("pane.wait_for_output", {
        pane_id: paneId, source: "detection", match: { type: "substring", value }, timeout_ms: 10000,
      }, undefined, 12000);
      await herdrRpc("pane.send_input", { pane_id: paneId, text: `${value}\n` });
      await output;
      const afterOutput = await paneScrollInfo(paneId);
      expect(afterOutput?.offset_from_bottom).toBeGreaterThan(0);
      const response = await post({
        pane_id: paneId, query: marker, direction, previous: first.match, content_revision: first.content_revision,
      });
      expect(response.status).toBe(409);
      expect((await response.json() as ApiError).error.code).toBe("stale_content");
      const afterResponse = await paneScrollInfo(paneId);
      // The substring receipt can precede cat's remaining output. History growth
      // raises both bottom-relative offsets without moving the viewport's top row.
      expect(afterResponse && afterResponse.max_offset_from_bottom - afterResponse.offset_from_bottom)
        .toBe(afterOutput && afterOutput.max_offset_from_bottom - afterOutput.offset_from_bottom);
      expect(afterResponse?.viewport_rows).toBe(afterOutput?.viewport_rows);
    });
  }

  it("refuses a no-jump match window if another client moved the viewport while reading it", async () => {
    await paneScroll(paneId, 0);
    const realSocket = herdrSocketPath();
    const oldSocket = process.env.HERDR_SOCKET;
    const proxyPath = join(stateDir, "find-scroll-race.sock");
    let moved = false;
    let searchRevision: number | undefined;
    const proxy = Bun.listen({
      unix: proxyPath,
      data: "",
      socket: {
        data(connection, chunk) {
          connection.data += new TextDecoder().decode(chunk);
          if (!connection.data.includes("\n")) return;
          const request = JSON.parse(connection.data) as { id: string; method: string; params: Record<string, unknown> };
          connection.data = "";
          void (async () => {
            try {
              const result = await herdrRpc<{ content_revision?: number }>(request.method, request.params, realSocket);
              if (!moved && request.method === "pane.copy_search" && request.params.pane_id === paneId) {
                moved = true;
                searchRevision = result.content_revision;
                await paneScroll(paneId, 10, realSocket);
              }
              connection.write(`${JSON.stringify({ id: request.id, result })}\n`);
            } catch (error) {
              connection.write(`${JSON.stringify({ id: request.id, error: {
                code: error instanceof HerdrError ? error.code : "test_proxy_error",
                message: error instanceof Error ? error.message : String(error),
              } })}\n`);
            } finally { connection.end(); }
          })();
        },
      },
    });
    try {
      process.env.HERDR_SOCKET = proxyPath;
      const response = await post({ pane_id: paneId, query: marker, direction: "backward", jump: false });
      expect(response.status).toBe(409);
      expect((await response.json() as ApiError).error.code).toBe("stale_content");
      expect(moved).toBe(true);
      expect((await paneScrollInfo(paneId, realSocket))?.offset_from_bottom).toBe(10);
      const motion = await herdrRpc<{ content_revision: number }>("pane.copy_motion", {
        pane_id: paneId, cursor: { row: 0, col: 0 }, motion: "line_end", content_revision: searchRevision,
      }, realSocket);
      expect(motion.content_revision).toBe(searchRevision!);
    } finally {
      if (oldSocket === undefined) delete process.env.HERDR_SOCKET;
      else process.env.HERDR_SOCKET = oldSocket;
      proxy.stop(true);
    }
  });

  it.each([
    ["pane.copy_search", "match", true], ["pane.scroll", "match", true], ["pane.copy_search", "no match", true],
    ["pane.copy_search", "match", false], ["pane.copy_search", "no match", false],
  ] as const)("refuses a %s result (%s, jump=%s) invalidated meanwhile instead of claiming it", async (changeAt, kind, jump) => {
    await paneScroll(paneId, 0);
    const realSocket = herdrSocketPath();
    const oldSocket = process.env.HERDR_SOCKET;
    const proxyPath = join(stateDir, "find-race.sock");
    let changed = false;
    const proxy = Bun.listen({
      unix: proxyPath,
      socket: {
        data(connection, chunk) {
          connection.data += new TextDecoder().decode(chunk);
          if (!connection.data.includes("\n")) return;
          const request = JSON.parse(connection.data) as { id: string; method: string; params: Record<string, unknown> };
          connection.data = "";
          void (async () => {
            try {
              const change = async () => {
                changed = true;
                const value = `find_race_changed_${changeAt}_${kind}_${jump}`;
                const output = herdrRpc("pane.wait_for_output", {
                  pane_id: paneId, source: "detection", match: { type: "substring", value }, timeout_ms: 10000,
                }, realSocket, 12000);
                await herdrRpc("pane.send_input", { pane_id: paneId, text: `${value}\n` }, realSocket);
                await output;
              };
              const inject = !changed && request.method === changeAt && request.params.pane_id === paneId;
              if (inject && changeAt === "pane.scroll") await change();
              const result = await herdrRpc(request.method, request.params, realSocket);
              if (inject && changeAt === "pane.copy_search") await change();
              connection.write(`${JSON.stringify({ id: request.id, result })}\n`);
            } catch (error) {
              connection.write(`${JSON.stringify({ id: request.id, error: {
                code: error instanceof HerdrError ? error.code : "test_proxy_error",
                message: error instanceof Error ? error.message : String(error),
              } })}\n`);
            } finally { connection.end(); }
          })();
        },
      },
      data: "",
    });
    try {
      process.env.HERDR_SOCKET = proxyPath;
      const response = await post({ pane_id: paneId, query: kind === "match" ? marker : "find_race_absent_text", direction: "backward", jump });
      expect(response.status).toBe(409);
      expect((await response.json() as ApiError).error.code).toBe("stale_content");
      expect(changed).toBe(true);
      if (changeAt === "pane.copy_search") expect((await paneScrollInfo(paneId, realSocket))?.offset_from_bottom).toBe(0);
    } finally {
      if (oldSocket === undefined) delete process.env.HERDR_SOCKET;
      else process.env.HERDR_SOCKET = oldSocket;
      proxy.stop(true);
    }
  });
});
