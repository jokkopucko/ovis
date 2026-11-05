import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AGENT_CATALOG, catalogRow } from "../../shared/agent-catalog.ts";
import { useAgentSetup } from "./useAgentSetup.ts";

// A tile's install watch: the catalog answer that settles as the tile goes away (the guide closed,
// Look again) tells the tile nothing, so it neither sets the guide's state nor reads again.
describe("an install watch that outlives its tile", () => {
  let renderer: ReactTestRenderer | undefined;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    if (previous) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("calls no onRow for an answer that arrives after the tile is gone", async () => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    const agent = catalogRow(AGENT_CATALOG.find((entry) => entry.id === "claude")!, "linux", { installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null });
    // the answer is already on its way: aborting the read no longer stops it
    const answer = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => answer.promise, { preconnect: globalThis.fetch.preconnect }));
    const rows: string[] = [];
    function Tile() {
      useAgentSetup({ agent, initial: { kind: "installing", tab: { workspace_id: "w1", pane_id: "w1:p1", command: "curl -fsSL https://claude.ai/install.sh | bash", shell: "posix" } }, onRow: (row) => rows.push(row.id) });
      return null;
    }
    try {
      await act(async () => { renderer = create(createElement(Tile)); });
      expect(fetch).toHaveBeenCalledTimes(1);
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
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
