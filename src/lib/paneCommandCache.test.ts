import { describe, expect, setSystemTime, test } from "bun:test";

import type { SlashCommand } from "../../shared/protocol.ts";
import { observePaneSessions, paneSessionEvents, paneSessionsMoving } from "./api.ts";
import { cachedPaneCommands, invalidatePaneCommands, onPaneCommandsInvalidated, paneCommandsNow } from "./paneCommandCache.ts";

describe("cachedPaneCommands", () => {
  test("answers once a minute per PC, pane and agent, and asks again for another agent in the same pane", async () => {
    const fetched: string[] = [];
    const fetchCommands = async (pane: string): Promise<SlashCommand[]> => {
      fetched.push(pane);
      return [{ name: `cmd-${fetched.length}`, description: "", source: "builtin" }];
    };
    const first = await cachedPaneCommands("w1:p1", "local", "omo", fetchCommands);
    expect(await cachedPaneCommands("w1:p1", "local", "omo", fetchCommands)).toBe(first);
    expect(fetched).toEqual(["w1:p1"]);

    const other = await cachedPaneCommands("w1:p1", "local", "pi", fetchCommands);
    expect(other).not.toBe(first);
    expect(fetched).toEqual(["w1:p1", "w1:p1"]);
    expect(await cachedPaneCommands("w1:p1", "local", "omo", fetchCommands)).toBe(first);

    await cachedPaneCommands("w1:p1", "studio", "omo", fetchCommands);
    await cachedPaneCommands("w1:p2", "local", "omo", fetchCommands);
    expect(fetched).toEqual(["w1:p1", "w1:p1", "w1:p1", "w1:p2"]);
  });

  test("a pane with no agent named lists no commands, and asks nothing (a new tab's chat mounts before the roster names its agent)", async () => {
    let asked = 0;
    const fetchCommands = async (): Promise<SlashCommand[]> => { asked += 1; return [{ name: "help", description: "", source: "builtin" }]; };
    expect(await cachedPaneCommands("w0:p1", "local", null, fetchCommands)).toEqual([]);
    expect(await cachedPaneCommands("w0:p1", "local", undefined, fetchCommands)).toEqual([]);
    expect(asked).toBe(0);
    expect(await cachedPaneCommands("w0:p1", "local", "claude", fetchCommands)).toHaveLength(1);
    expect(asked).toBe(1);
  });

  test("an invalidated pane asks again for every agent, tells its listeners, and leaves other panes cached", async () => {
    const fetched: string[] = [];
    const fetchCommands = async (pane: string): Promise<SlashCommand[]> => {
      fetched.push(pane);
      return [{ name: `cmd-${fetched.length}`, description: "", source: "builtin" }];
    };
    const omo = await cachedPaneCommands("w2:p1", "local", "omo", fetchCommands);
    const pi = await cachedPaneCommands("w2:p1", "local", "pi", fetchCommands);
    const other = await cachedPaneCommands("w2:p2", "local", "omo", fetchCommands);
    const told: string[] = [];
    const stop = onPaneCommandsInvalidated((paneId, machineId) => { told.push(`${machineId}/${paneId}`); });
    invalidatePaneCommands("w2:p1", "local");
    expect(told).toEqual(["local/w2:p1"]);
    expect(await cachedPaneCommands("w2:p1", "local", "omo", fetchCommands)).not.toBe(omo);
    expect(await cachedPaneCommands("w2:p1", "local", "pi", fetchCommands)).not.toBe(pi);
    expect(await cachedPaneCommands("w2:p2", "local", "omo", fetchCommands)).toBe(other);
    expect(fetched).toEqual(["w2:p1", "w2:p1", "w2:p2", "w2:p1", "w2:p1"]);
    stop();
    invalidatePaneCommands("w2:p1", "local");
    expect(told).toEqual(["local/w2:p1"]);
  });

  test("a read begun before an invalidation is answered but never kept over the read begun after it", async () => {
    const resolvers: ((commands: SlashCommand[]) => void)[] = [];
    const fetchCommands = (): Promise<SlashCommand[]> => new Promise((resolve) => { resolvers.push(resolve); });
    const stale = cachedPaneCommands("w3:p1", "local", "omo", fetchCommands);
    invalidatePaneCommands("w3:p1", "local");
    const fresh = cachedPaneCommands("w3:p1", "local", "omo", fetchCommands);
    expect(resolvers.length).toBe(2);
    const freshRows: SlashCommand[] = [{ name: "fresh", description: "", source: "builtin" }];
    resolvers[1]!(freshRows);
    expect(await fresh).toBe(freshRows);
    const staleRows: SlashCommand[] = [{ name: "stale", description: "", source: "builtin" }];
    resolvers[0]!(staleRows);
    expect(await stale).toBe(staleRows);
    // the list the catalog change made is what the pane keeps for the next minute
    expect(await cachedPaneCommands("w3:p1", "local", "omo", fetchCommands)).toBe(freshRows);
    expect(resolvers.length).toBe(2);
  });

  test("the components of a pane that mount together share one read, and a call after an invalidation starts a fresh one", async () => {
    const resolvers: ((commands: SlashCommand[]) => void)[] = [];
    const fetchCommands = (): Promise<SlashCommand[]> => new Promise((resolve) => { resolvers.push(resolve); });
    // the terminal, the chat, its skill chips and the composer
    const mounted = [1, 2, 3, 4].map(() => cachedPaneCommands("w4:p1", "local", "claude", fetchCommands));
    expect(resolvers.length).toBe(1);
    invalidatePaneCommands("w4:p1", "local");
    const fresh = [1, 2].map(() => cachedPaneCommands("w4:p1", "local", "claude", fetchCommands));
    expect(resolvers.length).toBe(2);
    const freshRows: SlashCommand[] = [{ name: "fresh", description: "", source: "builtin" }];
    resolvers[1]!(freshRows);
    for (const read of fresh) expect(await read).toBe(freshRows);
    const staleRows: SlashCommand[] = [{ name: "stale", description: "", source: "builtin" }];
    resolvers[0]!(staleRows);
    for (const read of mounted) expect(await read).toBe(staleRows);
    expect(paneCommandsNow("w4:p1", "local", "claude")).toBe(freshRows);
  });

  test("paneCommandsNow serves the last list at any age while a new read is on its way, until an invalidation", async () => {
    const rows: SlashCommand[] = [{ name: "review", description: "", source: "skill" }];
    try {
      await cachedPaneCommands("w5:p1", "local", "claude", async () => rows);
      expect(paneCommandsNow("w5:p1", "local", "pi")).toBeNull();
      expect(paneCommandsNow("w5:p1", "studio", "claude")).toBeNull();
      setSystemTime(new Date(Date.now() + 61_000));
      // a chat opened again a minute later draws its skill chips with the list it has, while it asks again
      let answer!: (commands: SlashCommand[]) => void;
      const fresh = cachedPaneCommands("w5:p1", "local", "claude", () => new Promise((resolve) => { answer = resolve; }));
      expect(paneCommandsNow("w5:p1", "local", "claude")).toBe(rows);
      const freshRows: SlashCommand[] = [{ name: "deploy", description: "", source: "skill" }];
      answer(freshRows);
      expect(await fresh).toBe(freshRows);
      expect(paneCommandsNow("w5:p1", "local", "claude")).toBe(freshRows);
      invalidatePaneCommands("w5:p1", "local");
      expect(paneCommandsNow("w5:p1", "local", "claude")).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test("the same pane's agent in another session or folder asks for its own list, not the one on its way (#2593)", async () => {
    const roster = (session: string, cwd: string, foreground_cwd?: string) => observePaneSessions([{ id: "local", snapshot: { panes: [{ pane_id: "w6:p1", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: session }, cwd, foreground_cwd }] } }], paneSessionEvents());
    const resolvers: ((commands: SlashCommand[]) => void)[] = [];
    const fetchCommands = (): Promise<SlashCommand[]> => new Promise((resolve) => { resolvers.push(resolve); });
    try {
      roster("a", "/repo/a");
      const inA = cachedPaneCommands("w6:p1", "local", "claude", fetchCommands);
      // claude started again in project B while project A's read is on its way
      roster("b", "/repo/b");
      const inB = cachedPaneCommands("w6:p1", "local", "claude", fetchCommands);
      expect(resolvers.length).toBe(2);
      const rowsB: SlashCommand[] = [{ name: "skill-of-b", description: "", source: "skill" }];
      const rowsA: SlashCommand[] = [{ name: "skill-of-a", description: "", source: "skill" }];
      resolvers[1]!(rowsB);
      expect(await inB).toBe(rowsB);
      // A's answer comes last, but the pane is on B: it is not what the pane keeps
      resolvers[0]!(rowsA);
      expect(await inA).toBe(rowsA);
      expect(paneCommandsNow("w6:p1", "local", "claude")).toBe(rowsB);
      expect(await cachedPaneCommands("w6:p1", "local", "claude", fetchCommands)).toBe(rowsB);
      expect(resolvers.length).toBe(2);
      // the same session read from another folder is another list too
      roster("b", "/repo/c");
      expect(paneCommandsNow("w6:p1", "local", "claude")).toBeNull();
      const inC = cachedPaneCommands("w6:p1", "local", "claude", fetchCommands);
      expect(resolvers.length).toBe(3);
      const rowsC: SlashCommand[] = [{ name: "skill-of-c", description: "", source: "skill" }];
      resolvers[2]!(rowsC);
      expect(await inC).toBe(rowsC);
      expect(paneCommandsNow("w6:p1", "local", "claude")).toBe(rowsC);
      // the server lists the foreground folder's commands: a change of it alone is another list
      roster("b", "/repo/c", "/repo/d");
      void cachedPaneCommands("w6:p1", "local", "claude", fetchCommands);
      expect(resolvers.length).toBe(4);
      const rowsD: SlashCommand[] = [{ name: "skill-of-d", description: "", source: "skill" }];
      resolvers[3]!(rowsD);
      expect(await cachedPaneCommands("w6:p1", "local", "claude", fetchCommands)).toBe(rowsD);
      expect(paneCommandsNow("w6:p1", "local", "claude")).toBe(rowsD);
      // herdr said a pane of the PC changed: the kept list stays drawn, but until the roster names the
      // sessions a read joins none begun before and is not kept
      paneSessionsMoving("local");
      expect(paneCommandsNow("w6:p1", "local", "claude")).toBe(rowsD);
      roster("b", "/repo/c", "/repo/e");
      const before = cachedPaneCommands("w6:p1", "local", "claude", fetchCommands);
      paneSessionsMoving("local");
      const during = cachedPaneCommands("w6:p1", "local", "claude", fetchCommands);
      expect(resolvers.length).toBe(6);
      resolvers[4]!(rowsA); resolvers[5]!(rowsB);
      expect(await before).toBe(rowsA);
      expect(await during).toBe(rowsB);
      expect(paneCommandsNow("w6:p1", "local", "claude")).toBeNull();
      roster("b", "/repo/c", "/repo/d");
      expect(paneCommandsNow("w6:p1", "local", "claude")).toBe(rowsD);
    } finally {
      observePaneSessions([{ id: "local", snapshot: { panes: [] } }], paneSessionEvents());
    }
  });
});
