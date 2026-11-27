import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { AGENT_CATALOG, catalogRow } from "../../shared/agent-catalog.ts";
import { openPage, type Page } from "./page.fixture.ts";
import { useAgentSetup } from "./useAgentSetup.ts";

describe("an install watch that outlives its tile", () => {
  let page: Page;

  afterEach(async () => {
    await page.close();
  });

  it("calls no onRow for an answer that arrives after the tile is gone", async () => {
    page = openPage();
    const agent = catalogRow(AGENT_CATALOG.find((entry) => entry.id === "claude")!, "linux", { installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null });
    const answer = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => answer.promise, { preconnect: globalThis.fetch.preconnect }));
    const rows: string[] = [];
    function Tile() {
      useAgentSetup({ agent, initial: { kind: "installing", tab: { workspace_id: "w1", pane_id: "w1:p1", command: "curl -fsSL https://claude.ai/install.sh | bash", shell: "posix" } }, onRow: (row) => rows.push(row.id) });
      return null;
    }
    try {
      await page.render(createElement(Tile));
      expect(fetch).toHaveBeenCalledTimes(1);
      await page.render(null);
      await act(async () => {
        answer.resolve(new Response(JSON.stringify({ agents: [{ id: "claude", installed: true, version: "2.1.312" }] }), { headers: { "content-type": "application/json" } }));
        await answer.promise;
      });
      expect(rows).toEqual([]);
    } finally {
      fetch.mockRestore();
    }
  });
});
