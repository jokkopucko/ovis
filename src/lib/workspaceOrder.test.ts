import { describe, expect, spyOn, test } from "bun:test";
import type { WorkspaceMoved } from "../../shared/protocol.ts";
import { SnapshotRequests } from "./snapshotRequests.ts";
import { movedTabOrder } from "./tabOrder.ts";
import { placeBlock, ReorderCoordinator, workspaceMoves, worktreeGroups, type OrderRosterEntry, type RosterSource, type WorkspaceMove } from "./workspaceOrder.ts";

const start = ["X", "A", "a1", "a2", "a3", "B", "b1", "C"];

/** herdr's answer to each move, as live-recorded on 0.9.3: boundaries before removal, one workspace at a time */
function replay(order: readonly string[], next: readonly string[]): string[] {
  return workspaceMoves(order, next).reduce<string[]>((current, move) => movedTabOrder(current, move.workspaceId, move.insertIndex) ?? current, [...order]);
}

function space(id: string, repoKey?: string, linked = false) {
  return { workspace_id: id, worktree: repoKey === undefined ? null : { is_linked_worktree: linked, repo_key: repoKey } };
}

function shape(ordered: ReturnType<typeof space>[]): [string, string[]][] {
  return worktreeGroups(ordered).map(({ workspace, children }) => [workspace.workspace_id, children.map((child) => child.workspace_id)]);
}

describe("worktreeGroups", () => {
  test("a worktree hangs under its repository's workspace", () => {
    expect(shape([space("A", "a"), space("B", "b"), space("a1", "a", true)])).toEqual([["A", ["a1"]], ["B", []]]);
  });

  test("with the main checkout open twice, a worktree takes the nearest one before it", () => {
    const ordered = [space("A", "a"), space("a1", "a", true), space("T", "t"), space("plain"), space("A2", "a"), space("a2", "a", true), space("a3", "a", true)];
    expect(shape(ordered)).toEqual([["A", ["a1"]], ["T", []], ["plain", []], ["A2", ["a2", "a3"]]]);
  });

  test("a worktree before every workspace of its repository takes the first one", () => {
    expect(shape([space("a1", "a", true), space("A", "a"), space("A2", "a")])).toEqual([["A", ["a1"]], ["A2", []]]);
  });

  test("a worktree whose repository is not open stays at the top level", () => {
    expect(shape([space("x1", "x", true), space("B", "b")])).toEqual([["x1", []], ["B", []]]);
  });
});

describe("workspaceMoves", () => {
  test("a worktree moved down one place lands past its sibling", () => {
    const next = placeBlock(start, ["a1"], ["a2"], "after");
    expect(next).toEqual(["X", "A", "a2", "a1", "a3", "B", "b1", "C"]);
    expect(workspaceMoves(start, next)).toEqual([{ workspaceId: "a1", insertIndex: 4 }]);
  });

  test("a worktree moved up one place lands before its sibling", () => {
    const next = placeBlock(start, ["a3"], ["a2"], "before");
    expect(next).toEqual(["X", "A", "a1", "a3", "a2", "B", "b1", "C"]);
    expect(workspaceMoves(start, next)).toHaveLength(1);
    expect(replay(start, next)).toEqual(next);
  });

  test("a repository's group moves with its worktrees", () => {
    const down = placeBlock(start, ["A", "a1", "a2", "a3"], ["B", "b1"], "after");
    expect(down).toEqual(["X", "B", "b1", "A", "a1", "a2", "a3", "C"]);
    expect(replay(start, down)).toEqual(down);
    expect(workspaceMoves(start, down)).toHaveLength(2);
    const up = placeBlock(start, ["A", "a1", "a2", "a3"], ["X"], "before");
    expect(workspaceMoves(start, up)).toEqual([{ workspaceId: "X", insertIndex: 5 }]);
    expect(replay(start, up)).toEqual(up);
  });

  test("the last place is the boundary after every workspace", () => {
    const next = placeBlock(start, ["X"], ["C"], "after");
    expect(workspaceMoves(start, next)).toEqual([{ workspaceId: "X", insertIndex: 8 }]);
  });

  test("an unchanged order needs no move", () => {
    expect(workspaceMoves(start, start)).toEqual([]);
  });
});

type Step = { step: WorkspaceMove; resolve(receipt: WorkspaceMoved): void; reject(error: unknown): void };
function mover() {
  const calls: Step[] = [];
  let woken: (() => void) | null = null;
  const move = (step: WorkspaceMove) => new Promise<WorkspaceMoved>((resolve, reject) => { calls.push({ step, resolve, reject }); woken?.(); });
  const next = async (): Promise<Step> => {
    while (calls.length === 0) await new Promise<void>((resolve) => { woken = resolve; });
    return calls.shift()!;
  };
  return { move, next, waiting: () => calls.length };
}
type Ask = { id: string; signal: AbortSignal; resolve(answer: { machines: OrderRosterEntry[]; boot_id: string } | null): void };
function verifier() {
  const asks: Ask[] = [];
  let woken: (() => void) | null = null;
  const verify = (id: string, signal: AbortSignal) => new Promise<{ machines: OrderRosterEntry[]; boot_id: string } | null>((resolve) => { asks.push({ id, signal, resolve }); woken?.(); });
  const next = async (): Promise<Ask> => {
    while (asks.length === 0) await new Promise<void>((resolve) => { woken = resolve; });
    return asks.shift()!;
  };
  return { verify, next, count: () => asks.length };
}
const entry = (id: string, ids: readonly string[], epoch?: string, seq?: number, extra: Record<string, unknown> = {}): OrderRosterEntry =>
  ({ id, snapshot: { workspaces: ids.map((workspace_id) => ({ workspace_id })), ...(epoch === undefined ? {} : { order_epoch: epoch, read_seq: seq }) }, ...extra });
const event: RosterSource = { kind: "event" };
const O = ["a", "b", "c"];
const A = ["b", "c", "a"];
const B = ["c", "a", "b"];
function commits(coordinator: ReorderCoordinator, id: string, ids: () => readonly string[]) {
  const seen: string[][] = [];
  coordinator.subscribe(() => { seen.push(coordinator.order(id, ids())); });
  return seen;
}
async function dragged(coordinator: ReorderCoordinator, moves: ReturnType<typeof mover>, receipt: WorkspaceMoved, id = "local") {
  const done = coordinator.reorder(id, O, A, moves.move);
  expect(coordinator.order(id, O)).toEqual(A);
  (await moves.next()).resolve(receipt);
  await done;
}
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
/** a proof endpoint that, like the demo's and a remote PC's, answers at most once per second and refuses with null */
function interval() {
  let last = -Infinity;
  const proof = {
    clock: 0, boot: "E1", ids: O, requests: [] as string[],
    verify: async () => {
      const allowed = proof.clock - last >= 1000;
      proof.requests.push(`${proof.clock}:${proof.boot}:${allowed ? "start" : "refused"}`);
      if (!allowed) return null;
      last = proof.clock;
      return { boot_id: proof.boot, machines: [entry("remote", proof.ids, proof.boot, 1)] };
    },
  };
  return proof;
}

describe("ReorderCoordinator", () => {
  test.each([false, true])("applies a queued drag after a restart even with an older proof and another drag (%s)", async (thirdDrag) => {
    const checks = verifier(), moves = mover();
    const coordinator = new ReorderCoordinator({ verify: checks.verify });
    const reversed = ["c", "b", "a"];
    coordinator.roster([entry("remote", O, "E1", 0)], event);
    const first = coordinator.reorder("remote", O, reversed, moves.move);
    const step = await moves.next();
    let serverOrder = B;
    let movedSeq = 1;
    const move = async ({ workspaceId, insertIndex }: WorkspaceMove) => {
      serverOrder = movedTabOrder(serverOrder, workspaceId, insertIndex) ?? serverOrder;
      return { ok: true as const, order_epoch: "E2", moved_seq: ++movedSeq };
    };
    const queued = coordinator.reorder("remote", reversed, A, move);
    coordinator.roster([entry("remote", A, "E2", 0)], event);
    step.resolve({ ok: true, order_epoch: "E1", moved_seq: 1 });
    (await moves.next()).reject(new Error("second move refused"));
    await first;
    await drain();
    expect(checks.count()).toBe(1);
    const check = await checks.next();
    const third = thirdDrag ? coordinator.reorder("remote", A, O, move) : null;
    coordinator.roster([entry("remote", B, "E2", 1)], event);
    coordinator.roster([entry("remote", A, "E1", 1)], event);
    check.resolve({ boot_id: "E2", machines: [entry("remote", A, "E2", 0)] });
    await queued;
    await third;
    expect(serverOrder).toEqual(thirdDrag ? O : A);
    expect(movedSeq).toBe(thirdDrag ? 3 : 2);
  });

  test.each([0, 1])("applies a queued drag despite an old-boot read before verification (seq %i)", async (seq) => {
    const moves = mover();
    let serverOrder = B;
    const coordinator = new ReorderCoordinator({
      verify: async () => ({ boot_id: "E2", machines: [] }),
    });
    const reversed = ["c", "b", "a"];
    const oldOrder = ["a", "c", "b"];
    const target = seq === 0 ? A : oldOrder;
    coordinator.roster([entry("remote", O, "E1", 0)], event);
    const first = coordinator.reorder("remote", O, reversed, moves.move);
    const step = await moves.next();
    let movedSeq = 0;
    const queued = coordinator.reorder("remote", reversed, target, async ({ workspaceId, insertIndex }) => {
      serverOrder = movedTabOrder(serverOrder, workspaceId, insertIndex) ?? serverOrder;
      return { ok: true, order_epoch: "E2", moved_seq: ++movedSeq };
    });
    coordinator.roster([entry("remote", B, "E2", 0)], { kind: "load", started: coordinator.loadStarted() });
    step.resolve({ ok: true, order_epoch: "E1", moved_seq: 1 });
    const second = await moves.next();
    coordinator.roster([entry("remote", seq === 0 ? O : oldOrder, "E1", seq)], event);
    second.reject(new Error("second move refused"));
    await first;
    const outcome = await Promise.race([queued.then(() => "applied"), drain().then(() => "pending")]);
    expect({ outcome, serverOrder }).toEqual({ outcome: "applied", serverOrder: target });
  });

  test("uses a newer proven snapshot when another drag follows a failed batch", async () => {
    const checks = verifier(), moves = mover();
    const coordinator = new ReorderCoordinator({ verify: checks.verify });
    const reversed = ["c", "b", "a"];
    coordinator.roster([entry("remote", O, "E1", 0)], event);
    const first = coordinator.reorder("remote", O, reversed, moves.move).catch((error: unknown) => error);
    (await moves.next()).resolve({ ok: true, order_epoch: "E1", moved_seq: 1 });
    const step = await moves.next();
    coordinator.roster([entry("remote", A, "E2", 0)], event);
    (await checks.next()).resolve({ boot_id: "E2", machines: [entry("remote", B, "E2", 1)] });
    await drain();
    step.reject(new Error("move refused"));
    expect(await first).toBeInstanceOf(Error);
    const displayed = coordinator.order("remote", O);
    expect(displayed).toEqual(B);
    let serverOrder = B;
    await coordinator.reorder("remote", displayed, A, async ({ workspaceId, insertIndex }) => {
      serverOrder = movedTabOrder(serverOrder, workspaceId, insertIndex) ?? serverOrder;
      return { ok: true, order_epoch: "E2", moved_seq: 2 };
    });
    expect(serverOrder).toEqual(A);
  });

  test.each([false, true])("recovers a queued drag from a qualified same-boot snapshot (from roster: %s)", async (fromRoster) => {
    const checks = verifier(), moves = mover();
    const coordinator = new ReorderCoordinator({ verify: checks.verify });
    const reversed = ["c", "b", "a"];
    coordinator.roster([entry("remote", O, "E1", 0)], event);
    const first = coordinator.reorder("remote", O, reversed, moves.move);
    (await moves.next()).resolve({ ok: true, order_epoch: "E1", moved_seq: 1 });
    const second = await moves.next();
    let serverOrder = B;
    const queued = coordinator.reorder("remote", reversed, A, async ({ workspaceId, insertIndex }) => {
      serverOrder = movedTabOrder(serverOrder, workspaceId, insertIndex) ?? serverOrder;
      return { ok: true, order_epoch: "E1", moved_seq: 2 };
    });
    const result = queued.then(() => "applied", () => "rejected");
    coordinator.roster([entry("remote", O, "old-boot", 0)], event);
    const check = await checks.next();
    if (fromRoster) {
      second.reject(new Error("second move refused"));
      await first;
      await drain();
      coordinator.roster([entry("remote", B, "E1", 1)], event);
      check.resolve(null);
    } else {
      check.resolve({ boot_id: "E1", machines: [entry("remote", B, "E1", 1)] });
      await drain();
      expect(coordinator.order("remote", O)).toEqual(A);
      second.reject(new Error("second move refused"));
      await first;
    }
    expect(await Promise.race([result, drain().then(() => "pending")])).toBe("applied");
    expect(serverOrder).toEqual(A);
  });

  test("uses the recovered workspace set for drags queued before a close", async () => {
    const checks = verifier(), moves = mover();
    const coordinator = new ReorderCoordinator({ verify: checks.verify });
    const initial = [..."abcde"], desired = [..."cdabe"];
    coordinator.roster([entry("remote", initial, "E1", 0)], event);
    const first = coordinator.reorder("remote", initial, desired, moves.move);
    const step = await moves.next();
    let serverOrder = [..."bcde"];
    const move = async ({ workspaceId, insertIndex }: WorkspaceMove) => {
      serverOrder = movedTabOrder(serverOrder, workspaceId, insertIndex) ?? serverOrder;
      return { ok: true as const, order_epoch: "E2", moved_seq: 1 };
    };
    const queued = coordinator.reorder("remote", desired, initial, move);
    coordinator.roster([entry("remote", [..."bcdae"], "E2", 0)], event);
    step.resolve({ ok: true, order_epoch: "E1", moved_seq: 1 });
    (await moves.next()).reject(new Error("second move refused"));
    await first;
    const proof = await checks.next();
    const third = coordinator.reorder("remote", initial, [..."abdce"], move);
    coordinator.roster([entry("remote", [..."bcde"], "E2", 0)], event);
    proof.resolve({ boot_id: "E2", machines: [entry("remote", [..."bcdae"], "E2", 0)] });
    await queued;
    await third;
    expect(serverOrder).toEqual([..."bdce"]);
  });
  test("a pre-move read delivered after confirmation stays fenced", async () => {
    const now = spyOn(Date, "now").mockReturnValue(10_000);
    const monotonic = spyOn(performance, "now").mockReturnValue(10_000);
    try {
      const coordinator = new ReorderCoordinator();
      coordinator.roster([entry("local", O, "E", 0)], { kind: "load", started: coordinator.loadStarted() });
      const seen = commits(coordinator, "local", () => O);
      const moves = mover();
      await dragged(coordinator, moves, { ok: true, order_epoch: "E", moved_seq: 1 });
      for (const clock of [10_000, 20_000, 10_000, 1_000]) {
        now.mockReturnValue(clock); monotonic.mockReturnValue(clock);
        coordinator.roster([entry("local", O, "E", 0)], event);
        coordinator.roster([entry("local", O, "E", 0)], { kind: "load", started: coordinator.loadStarted() });
        expect(coordinator.order("local", O)).toEqual(A);
      }
      expect(coordinator.state("local")).toMatchObject({ held: true, floors: { E: 1 } });
      coordinator.roster([entry("local", A, "E", 1)], event);
      expect(coordinator.state("local").held).toBe(false);
      expect(seen.some((order) => order.join() === O.join())).toBe(false);
      expect(now).not.toHaveBeenCalled();
      expect(monotonic).not.toHaveBeenCalled();
    } finally { now.mockRestore(); monotonic.mockRestore(); }
  });

  test("a remote opening snapshot cannot acquire freshness on arrival", async () => {
    const coordinator = new ReorderCoordinator();
    const moves = mover();
    await dragged(coordinator, moves, { ok: true, order_epoch: "R", moved_seq: 4 }, "remote");
    coordinator.roster([entry("remote", O, "R", 3)], event);
    expect(coordinator.order("remote", O)).toEqual(A);
    expect(coordinator.state("remote").held).toBe(true);
    coordinator.roster([entry("remote", A, "R", 4)], event);
    expect(coordinator.state("remote").held).toBe(false);
  });

  test("stale cache status patches and another PC cannot release", async () => {
    const coordinator = new ReorderCoordinator();
    const moves = mover();
    await dragged(coordinator, moves, { ok: true, order_epoch: "E", moved_seq: 1 });
    coordinator.roster([entry("other", B, "F", 9), entry("local", O, "E", 0, { state: "connected" })], event);
    expect(coordinator.order("local", O)).toEqual(A);
    expect(coordinator.state("local").held).toBe(true);
    expect(coordinator.order("local", ["a", "b", "d"])).toEqual(["b", "a", "d"]);
    coordinator.roster([entry("local", ["a", "b", "d"], "E", 1)], event);
    expect(coordinator.order("local", ["a", "b", "d"])).toEqual(["a", "b", "d"]);
  });

  test("a later authoritative order lifts the fence without an echo of the settled order", async () => {
    const coordinator = new ReorderCoordinator();
    const seen = commits(coordinator, "local", () => O);
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E", moved_seq: 1 });
    coordinator.roster([entry("local", B, "E", 2)], event);
    expect(coordinator.order("local", O)).toEqual(B);
    expect(coordinator.state("local").held).toBe(false);
    expect(seen.at(-1)).toEqual(B);
  });

  test("releasing a hold retains the acknowledged move floor", async () => {
    const coordinator = new ReorderCoordinator();
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E", moved_seq: 1 });
    coordinator.roster([entry("local", A, "E", 1)], event);
    expect(coordinator.state("local")).toMatchObject({ held: false, floors: { E: 1 } });
    coordinator.roster([entry("local", O, "E", 0)], event);
    coordinator.roster([entry("local", [...O, "d"], "E", 0)], { kind: "load", started: coordinator.loadStarted() });
    expect(coordinator.order("local", [...O, "d"])).toEqual([...A, "d"]);
    coordinator.roster([entry("local", B, "E", 1)], event);
    expect(coordinator.order("local", O)).toEqual(B);
  });

  test("fresh HTTP before stale websocket never regresses the cache or order", async () => {
    const coordinator = new ReorderCoordinator();
    const seen = commits(coordinator, "local", () => O);
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E", moved_seq: 1 });
    coordinator.roster([entry("local", B, "E", 1)], { kind: "load", started: coordinator.loadStarted() });
    coordinator.roster([entry("local", O, "E", 0)], event);
    expect(coordinator.order("local", O)).toEqual(B);
    expect(coordinator.state("local").floors).toEqual({ E: 1 });
    expect(seen.some((order) => order.join() === O.join())).toBe(false);
  });

  test("only the newest generation applies its order; an older one's end replaces nothing", async () => {
    const coordinator = new ReorderCoordinator();
    const moves = mover();
    const first = coordinator.reorder("local", O, A, moves.move);
    const second = coordinator.reorder("local", A, B, moves.move);
    expect(coordinator.state("local").pending).toBe(2);
    expect(coordinator.order("local", O)).toEqual(B);
    (await moves.next()).resolve({ ok: true, order_epoch: "E", moved_seq: 1 });
    await first;
    expect(coordinator.order("local", O)).toEqual(B);
    expect(coordinator.state("local").pending).toBe(1);
    const step = await moves.next();
    expect(step.step.workspaceId).toBeDefined();
    step.resolve({ ok: true, order_epoch: "E", moved_seq: 2 });
    while (moves.waiting() === 0 && coordinator.state("local").pending > 0) {
      const more = await Promise.race([moves.next(), second.then(() => null)]);
      if (!more) break;
      more.resolve({ ok: true, order_epoch: "E", moved_seq: 3 });
    }
    await second;
    expect(coordinator.state("local")).toMatchObject({ pending: 0, held: true });
    coordinator.roster([entry("local", A, "E", 1)], event);
    expect(coordinator.order("local", O)).toEqual(B);
  });

  test("an older generation's failure rolls nothing back; the newest one's failure does", async () => {
    const coordinator = new ReorderCoordinator();
    coordinator.roster([entry("local", O, "E", 0)], event);
    const moves = mover();
    const first = coordinator.reorder("local", O, A, moves.move);
    const second = coordinator.reorder("local", A, B, moves.move);
    (await moves.next()).reject(new Error("first failed"));
    await first;
    expect(coordinator.order("local", O)).toEqual(B);
    const step = await moves.next();
    step.reject(new Error("second failed"));
    await expect(second).rejects.toThrow("second failed");
    expect(coordinator.state("local")).toMatchObject({ pending: 0, held: false });
    expect(coordinator.order("local", O)).toEqual(O);
  });

  test("a partial failure keeps its acknowledged floor and the next batch starts from a qualified roster", async () => {
    const coordinator = new ReorderCoordinator();
    coordinator.roster([entry("local", ["w", "x", "y", "z"], "E", 0)], event);
    const moves = mover();
    const target = ["z", "y", "x", "w"];
    const first = coordinator.reorder("local", ["w", "x", "y", "z"], target, moves.move);
    (await moves.next()).resolve({ ok: true, order_epoch: "E", moved_seq: 1 });
    const later = coordinator.reorder("local", target, ["y", "z", "x", "w"], moves.move);
    (await moves.next()).reject(new Error("herdr refused"));
    await first;
    expect(coordinator.state("local").floors).toEqual({ E: 1 });
    expect(coordinator.order("local", target)).toEqual(["y", "z", "x", "w"]);
    coordinator.roster([entry("local", ["w", "x", "y", "z"], "E", 0)], event);
    expect(moves.waiting()).toBe(0);
    coordinator.roster([entry("local", ["z", "w", "x", "y"], "E", 1)], event);
    const step = await moves.next();
    expect(step.step).toBeDefined();
    step.resolve({ ok: true, order_epoch: "E", moved_seq: 2 });
    for (;;) {
      const more = await Promise.race([moves.next(), later.then(() => null)]);
      if (!more) break;
      more.resolve({ ok: true, order_epoch: "E", moved_seq: 3 });
    }
    await later;
    expect(coordinator.order("local", target)).toEqual(["y", "z", "x", "w"]);
  });

  test("an older server's receipt falls back to a load started after the moves settled", async () => {
    const settled: string[] = [];
    const coordinator = new ReorderCoordinator({ onSettled: (id) => settled.push(id) });
    const early = coordinator.loadStarted();
    await dragged(coordinator, mover(), { ok: true });
    expect(settled).toEqual(["local"]);
    coordinator.roster([entry("local", O)], { kind: "load", started: early });
    coordinator.roster([entry("local", O)], event);
    expect(coordinator.order("local", O)).toEqual(A);
    coordinator.roster([entry("local", B)], { kind: "load", started: coordinator.loadStarted() });
    expect(coordinator.order("local", O)).toEqual(B);
    expect(coordinator.state("local").held).toBe(false);
  });

  test("a server that stops sending evidence cannot lift an acknowledged floor through the fallback", async () => {
    const coordinator = new ReorderCoordinator();
    coordinator.roster([entry("local", O, "E", 0)], event);
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E", moved_seq: 1 });
    coordinator.roster([entry("local", A, "E", 1)], event);
    expect(coordinator.state("local")).toMatchObject({ held: false, floors: { E: 1 } });
    const moves = mover();
    const done = coordinator.reorder("local", A, B, moves.move);
    (await moves.next()).resolve({ ok: true });
    await done;
    coordinator.roster([entry("local", O)], { kind: "load", started: coordinator.loadStarted() });
    expect(coordinator.order("local", O)).toEqual(B);
    expect(coordinator.state("local")).toMatchObject({ held: true, floors: { E: 1 } });
    coordinator.roster([entry("local", A, "E", 2)], event);
    expect(coordinator.order("local", O)).toEqual(B);
    coordinator.roster([entry("local", A, "E", 2)], { kind: "load", started: coordinator.loadStarted() });
    expect(coordinator.order("local", O)).toEqual(A);
    expect(coordinator.state("local")).toMatchObject({ held: false, floors: { E: 1 } });
  });

  test("evidence that disappears before an earlier hold releases still needs a post-settlement load", async () => {
    const coordinator = new ReorderCoordinator();
    coordinator.roster([entry("local", O, "E", 0)], event);
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E", moved_seq: 1 });
    const moves = mover();
    const done = coordinator.reorder("local", A, B, moves.move);
    (await moves.next()).resolve({ ok: true });
    await done;
    coordinator.roster([entry("local", A, "E", 1)], event);
    expect(coordinator.order("local", O)).toEqual(B);
    expect(coordinator.state("local")).toMatchObject({ held: true, floors: { E: 1 } });
    coordinator.roster([entry("local", A)], { kind: "load", started: coordinator.loadStarted() });
    expect(coordinator.order("local", O)).toEqual(B);
    coordinator.roster([entry("local", B, "E", 1)], { kind: "load", started: coordinator.loadStarted() });
    expect(coordinator.order("local", O)).toEqual(B);
    expect(coordinator.state("local")).toMatchObject({ held: false, floors: { E: 1 } });
  });

  test("a PC that leaves the roster settles a batch waiting for its roster, and keeps its floor", async () => {
    const coordinator = new ReorderCoordinator();
    const start = ["w", "x", "y", "z"];
    const target = ["z", "y", "x", "w"];
    coordinator.roster([{ id: "local", snapshot: null }, entry("remote", start, "E", 0)], event);
    const moves = mover();
    const first = coordinator.reorder("remote", start, target, moves.move);
    (await moves.next()).resolve({ ok: true, order_epoch: "E", moved_seq: 1 });
    const later = coordinator.reorder("remote", target, ["y", "z", "x", "w"], moves.move);
    const refused = later.then(() => null, (error: unknown) => error);
    (await moves.next()).reject(new Error("herdr refused"));
    await first;
    coordinator.roster([{ id: "local", snapshot: null }, { id: "remote", snapshot: null }], event);
    expect(coordinator.state("remote")).toMatchObject({ pending: 1, held: true });
    coordinator.roster([{ id: "local", snapshot: null }], event);
    expect(coordinator.state("remote")).toMatchObject({ pending: 0, held: false, floors: { E: 1 } });
    expect(await refused).toBeInstanceOf(Error);
    expect(moves.waiting()).toBe(0);
    expect(coordinator.state("remote")).toMatchObject({ pending: 0, held: false, floors: { E: 1 } });
  });

  test("a Sidebar remount or PC switch keeps the hold: it lives in the coordinator", async () => {
    const coordinator = new ReorderCoordinator();
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E", moved_seq: 1 });
    coordinator.roster([{ id: "local", snapshot: null }, entry("other", B, "F", 0)], event);
    expect(coordinator.order("other", B)).toEqual(B);
    expect(coordinator.order("local", O)).toEqual(A);
  });

  test("a proven source-server restart drops the old fence", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    const seen = commits(coordinator, "local", () => O);
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E1", moved_seq: 1 });
    coordinator.roster([entry("local", O, "E2", 0)], event);
    const ask = await asks.next();
    expect(ask.id).toBe("local");
    ask.resolve({ machines: [entry("local", B, "E2", 0)], boot_id: "E2" });
    await flush();
    expect(coordinator.state("local")).toMatchObject({ held: false, retired: ["E1"], guard: { epoch: "E2", version: 1 }, floors: {} });
    expect(coordinator.order("local", O)).toEqual(B);
    coordinator.roster([entry("local", O, "E1", 5)], event);
    expect(coordinator.order("local", O)).toEqual(B);
    expect(seen.some((order) => order.join() === O.join())).toBe(false);
  });

  test("post-receipt restart retires only on correlated verification", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E2", moved_seq: 1 });
    coordinator.roster([entry("local", O, "E3", 0, { source_boot_id: "E3" })], event);
    expect(coordinator.state("local")).toMatchObject({ held: true, retired: [], checking: true });
    (await asks.next()).resolve({ machines: [entry("local", B, "E3", 0)], boot_id: "E3" });
    await flush();
    expect(coordinator.state("local")).toMatchObject({ retired: ["E2"], guard: { epoch: "E3" } });
    expect(coordinator.order("local", O)).toEqual(B);
  });

  test("a restarted server's roster that arrived before the move's receipt is verified once the receipt lands", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    const moves = mover();
    const done = coordinator.reorder("local", O, A, moves.move);
    const step = await moves.next();
    coordinator.roster([entry("local", A, "E2", 0)], event);
    expect(asks.count()).toBe(0);
    step.resolve({ ok: true, order_epoch: "E1", moved_seq: 1 });
    await done;
    expect(coordinator.state("local")).toMatchObject({ held: true, checking: true });
    const ask = await asks.next();
    expect(ask.id).toBe("local");
    ask.resolve({ machines: [entry("local", B, "E2", 0)], boot_id: "E2" });
    await flush();
    expect(coordinator.state("local")).toMatchObject({ retired: ["E1"], guard: { epoch: "E2" } });
    expect(coordinator.order("local", O)).toEqual(B);
  });

  test("a roster read before the move was sent asks no verification when its receipt lands", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    coordinator.roster([entry("local", O, "E1", 0)], event);
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E2", moved_seq: 1 });
    expect(asks.count()).toBe(0);
    expect(coordinator.state("local")).toMatchObject({ checking: false, floors: { E2: 1 } });
  });

  test("a restarted roster that arrived mid-batch is verified once the batch settles, also after a later step fails", async () => {
    const asks = verifier();
    const settled: string[] = [];
    const coordinator = new ReorderCoordinator({ verify: asks.verify, onSettled: (id) => settled.push(id) });
    const moves = mover();
    const done = coordinator.reorder("local", O, ["c", "b", "a"], moves.move);
    const failed = done.then(() => null, (error: unknown) => error);
    const first = await moves.next();
    coordinator.roster([entry("local", A, "E2", 0)], event);
    first.resolve({ ok: true, order_epoch: "E1", moved_seq: 1 });
    const second = await moves.next();
    expect(asks.count()).toBe(0);
    second.reject(new Error("herdr refused"));
    expect(await failed).toBeInstanceOf(Error);
    expect(settled).toEqual(["local"]);
    (await asks.next()).resolve({ machines: [entry("local", B, "E2", 0)], boot_id: "E2" });
    await flush();
    expect(coordinator.state("local")).toMatchObject({ held: false, retired: ["E1"], guard: { epoch: "E2" } });
    expect(coordinator.order("local", O)).toEqual(B);
  });

  test("a PC that left before its move's receipt asks no verification", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    const moves = mover();
    const done = coordinator.reorder("local", O, A, moves.move);
    const step = await moves.next();
    coordinator.roster([entry("local", A, "E2", 0)], event);
    coordinator.roster([], event);
    step.resolve({ ok: true, order_epoch: "E1", moved_seq: 1 });
    await done;
    await flush();
    expect(asks.count()).toBe(0);
    expect(coordinator.state("local")).toMatchObject({ held: false, checking: false });
  });

  test("an event repeating the roster read before the move asks no verification when its receipt lands", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    coordinator.roster([entry("local", O, "E1", 0)], event);
    const moves = mover();
    const done = coordinator.reorder("local", O, A, moves.move);
    const step = await moves.next();
    coordinator.roster([entry("local", O, "E1", 0)], event);
    step.resolve({ ok: true, order_epoch: "E2", moved_seq: 1 });
    await done;
    await flush();
    expect(asks.count()).toBe(0);
    expect(coordinator.state("local")).toMatchObject({ checking: false, floors: { E2: 1 } });
  });

  test("a roster read before a chained batch's move was sent spends no verification the next restart needs", async () => {
    const proof = interval();
    const coordinator = new ReorderCoordinator({ verify: proof.verify });
    const moves = mover();
    coordinator.roster([entry("remote", O, "E1", 0)], event);
    const first = coordinator.reorder("remote", O, A, moves.move);
    const step = await moves.next();
    const second = coordinator.reorder("remote", A, B, moves.move);
    coordinator.roster([entry("remote", A, "E1", 1)], event);
    step.resolve({ ok: true, order_epoch: "E1", moved_seq: 1 });
    proof.boot = "E2"; proof.ids = B;
    await first;
    (await moves.next()).resolve({ ok: true, order_epoch: "E2", moved_seq: 1 });
    await second;
    proof.clock = 1; proof.boot = "E3"; proof.ids = O;
    coordinator.roster([entry("remote", O, "E3", 1)], event);
    await flush();
    expect(proof.requests).toEqual(["1:E3:start"]);
    expect(coordinator.order("remote", O)).toEqual(O);
  });

  test("a failed step does not repeat a verification already answered for the same roster", async () => {
    const proof = interval();
    const coordinator = new ReorderCoordinator({ verify: proof.verify });
    const moves = mover();
    coordinator.roster([entry("remote", O, "E1", 0)], event);
    const done = coordinator.reorder("remote", O, ["c", "b", "a"], moves.move).catch((error: unknown) => error);
    (await moves.next()).resolve({ ok: true, order_epoch: "E1", moved_seq: 1 });
    const second = await moves.next();
    coordinator.roster([entry("remote", A, "unseen-old", 0)], event);
    await flush();
    proof.clock = 1100;
    second.reject(new Error("herdr refused"));
    expect(await done).toBeInstanceOf(Error);
    proof.clock = 1101; proof.boot = "E2"; proof.ids = B;
    coordinator.roster([entry("remote", B, "E2", 1)], event);
    await flush();
    expect(proof.requests).toEqual(["0:E1:start", "1101:E2:start"]);
    expect(coordinator.order("remote", O)).toEqual(B);
  });

  test("a delayed older read of the server lifetime read before the move spends no verification", async () => {
    const proof = interval();
    const coordinator = new ReorderCoordinator({ verify: proof.verify });
    const moves = mover();
    coordinator.roster([entry("remote", O, "before", 5)], { kind: "load", started: coordinator.loadStarted() });
    const done = coordinator.reorder("remote", O, A, moves.move);
    const step = await moves.next();
    coordinator.roster([entry("remote", O, "before", 4)], event);
    proof.boot = "moved"; proof.ids = A;
    step.resolve({ ok: true, order_epoch: "moved", moved_seq: 1 });
    await done;
    proof.clock = 1; proof.boot = "restart"; proof.ids = B;
    coordinator.roster([entry("remote", B, "restart", 1)], event);
    await flush();
    expect(proof.requests).toEqual(["1:restart:start"]);
    expect(coordinator.order("remote", O)).toEqual(B);
  });

  test("a later read of a server lifetime a verification already answered for asks no second one", async () => {
    const proof = interval();
    const reading = Promise.withResolvers<void>();
    let calls = 0;
    const coordinator = new ReorderCoordinator({ verify: async () => {
      if (++calls === 1) await reading.promise;
      return proof.verify();
    } });
    const moves = mover();
    coordinator.roster([entry("remote", O, "E1", 0)], event);
    const done = coordinator.reorder("remote", O, ["c", "b", "a"], moves.move).catch((error: unknown) => error);
    const first = await moves.next();
    proof.ids = movedTabOrder(O, first.step.workspaceId, first.step.insertIndex)!;
    first.resolve({ ok: true, order_epoch: "E1", moved_seq: 1 });
    const second = await moves.next();
    coordinator.roster([entry("remote", O, "earlier", 4)], event);
    coordinator.roster([entry("remote", A, "earlier", 5)], event);
    reading.resolve();
    await drain();
    proof.clock = 1100;
    second.reject(new Error("herdr refused"));
    expect(await done).toBeInstanceOf(Error);
    await drain();
    proof.clock = 1101; proof.boot = "restart"; proof.ids = B;
    coordinator.roster([entry("remote", B, "restart", 1)], event);
    await drain();
    expect(proof.requests).toEqual(["0:E1:start", "1101:restart:start"]);
    expect(coordinator.order("remote", O)).toEqual(B);
  });

  test("passive older boot proof never retires a newer receipt epoch", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E2", moved_seq: 1 });
    coordinator.roster([entry("local", O, "E1", 7, { source_boot_id: "E1" })], event);
    (await asks.next()).resolve({ machines: [entry("local", A, "E2", 1)], boot_id: "E2" });
    await flush();
    expect(coordinator.state("local")).toMatchObject({ held: true, retired: [], floors: { E2: 1 } });
    expect(coordinator.order("local", O)).toEqual(A);
  });

  test("old proof SSE cannot invalidate retirement protection after immediate load", async () => {
    const asks = verifier();
    const requests = new SnapshotRequests();
    let answerLoad: (value: OrderRosterEntry[]) => void = () => {};
    const coordinator = new ReorderCoordinator({ verify: asks.verify, onSettled: () => {
      const started = coordinator.loadStarted();
      void requests.read(() => new Promise<OrderRosterEntry[]>((resolve) => { answerLoad = resolve; }), (roster) => coordinator.roster(roster, { kind: "load", started }));
    } });
    const seen = commits(coordinator, "local", () => O);
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E2", moved_seq: 1 });
    requests.invalidate();
    coordinator.roster([entry("local", O, "E1", 3, { source_boot_id: "E1" })], event);
    answerLoad([entry("local", O, "E1", 3)]);
    await flush();
    (await asks.next()).resolve(null);
    await flush();
    expect(coordinator.state("local")).toMatchObject({ held: true, retired: [], floors: { E2: 1 } });
    expect(seen.some((order) => order.join() === O.join())).toBe(false);
  });

  test("new receipt invalidates pending boot validation", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    const moves = mover();
    await dragged(coordinator, moves, { ok: true, order_epoch: "E2", moved_seq: 1 });
    coordinator.roster([entry("local", O, "E3", 0)], event);
    const ask = await asks.next();
    const again = coordinator.reorder("local", A, B, moves.move);
    expect(ask.signal.aborted).toBe(true);
    ask.resolve({ machines: [], boot_id: "E3" });
    await flush();
    expect(coordinator.state("local").retired).toEqual([]);
    (await moves.next()).resolve({ ok: true, order_epoch: "E2", moved_seq: 2 });
    await again;
    expect(coordinator.state("local")).toMatchObject({ floors: { E2: 2 }, held: true });
    expect(coordinator.order("local", O)).toEqual(B);
  });

  test("superseded validation grants no retirement", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    const moves = mover();
    await dragged(coordinator, moves, { ok: true, order_epoch: "E2", moved_seq: 1 });
    coordinator.roster([entry("local", O, "E3", 0)], event);
    const stale = await asks.next();
    coordinator.roster([entry("local", O, "E3", 1)], event);
    expect(asks.count()).toBe(0);
    const again = coordinator.reorder("local", A, B, moves.move);
    (await moves.next()).resolve({ ok: true, order_epoch: "E2", moved_seq: 2 });
    await again;
    coordinator.roster([entry("local", O, "E3", 1)], event);
    const current = await asks.next();
    stale.resolve({ machines: [], boot_id: "E3" });
    await flush();
    expect(coordinator.state("local").retired).toEqual([]);
    current.resolve({ machines: [], boot_id: "E2" });
    await flush();
    expect(coordinator.state("local")).toMatchObject({ retired: [], floors: { E2: 2 }, held: true });
  });

  test("another PC cannot retire this floor", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E2", moved_seq: 1 });
    await dragged(coordinator, mover(), { ok: true, order_epoch: "R1", moved_seq: 1 }, "remote");
    coordinator.roster([{ id: "local", snapshot: null }, entry("remote", O, "R2", 0)], event);
    const ask = await asks.next();
    expect(ask.id).toBe("remote");
    ask.resolve({ machines: [entry("local", O, "E3", 0)], boot_id: "R2" });
    await flush();
    expect(coordinator.state("remote").retired).toEqual(["R1"]);
    expect(coordinator.state("local")).toMatchObject({ retired: [], floors: { E2: 1 }, held: true });
    expect(coordinator.order("local", O)).toEqual(A);
  });

  test("failed verification can retry successfully", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E2", moved_seq: 1 });
    coordinator.roster([entry("local", O, "E3", 0)], event);
    (await asks.next()).resolve(null);
    await flush();
    expect(coordinator.state("local")).toMatchObject({ retired: [], held: true, checking: false });
    coordinator.roster([entry("local", B, "E3", 0)], { kind: "load", started: coordinator.loadStarted() });
    (await asks.next()).resolve({ machines: [entry("local", B, "E3", 0)], boot_id: "E3" });
    await flush();
    expect(coordinator.state("local").retired).toEqual(["E2"]);
    expect(coordinator.order("local", O)).toEqual(B);
  });

  test("proof-only answer waits for matching snapshot", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E2", moved_seq: 1 });
    coordinator.roster([entry("local", O, "E3", 0)], event);
    (await asks.next()).resolve({ machines: [entry("local", O, "E1", 9)], boot_id: "E3" });
    await flush();
    expect(coordinator.state("local")).toMatchObject({ retired: ["E2"], guard: { epoch: "E3" } });
    expect(coordinator.order("local", O)).toEqual(A);
    coordinator.roster([entry("local", O, "E1", 9)], event);
    expect(coordinator.order("local", O)).toEqual(A);
    coordinator.roster([entry("local", B, "E3", 0)], event);
    expect(coordinator.order("local", O)).toEqual(B);
  });

  test("proof-only successor can verify a second restart without a floor", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    const seen = commits(coordinator, "local", () => O);
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E2", moved_seq: 1 });
    coordinator.roster([entry("local", O, "E3", 0)], event);
    (await asks.next()).resolve({ machines: [], boot_id: "E3" });
    await flush();
    expect(coordinator.state("local")).toMatchObject({ floors: {}, guard: { epoch: "E3", version: 1 } });
    coordinator.roster([entry("local", O, "E4", 0)], event);
    (await asks.next()).resolve({ machines: [], boot_id: "E4" });
    await flush();
    expect(coordinator.state("local")).toMatchObject({ retired: ["E2", "E3"], guard: { epoch: "E4", version: 2 } });
    coordinator.roster([entry("local", B, "E4", 0)], event);
    expect(coordinator.order("local", O)).toEqual(B);
    expect(seen.some((order) => order.join() === O.join())).toBe(false);
  });

  test("accepted epoch guard survives its first full snapshot", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E2", moved_seq: 1 });
    coordinator.roster([entry("local", O, "E3", 0)], event);
    (await asks.next()).resolve({ machines: [entry("local", B, "E3", 0)], boot_id: "E3" });
    await flush();
    coordinator.roster([entry("local", B, "E3", 1)], event);
    expect(coordinator.state("local").guard).toEqual({ epoch: "E3", version: 1 });
    coordinator.roster([entry("local", A, "E5", 0)], event);
    (await asks.next()).resolve({ machines: [entry("local", A, "E5", 0)], boot_id: "E5" });
    await flush();
    expect(coordinator.state("local").guard).toEqual({ epoch: "E5", version: 2 });
    expect(coordinator.order("local", O)).toEqual(A);
  });

  test("unseen retired-era GET and SSE cannot restore pre-move order", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    const seen = commits(coordinator, "local", () => O);
    await dragged(coordinator, mover(), { ok: true, order_epoch: "E2", moved_seq: 1 });
    coordinator.roster([entry("local", B, "E3", 0)], event);
    (await asks.next()).resolve({ machines: [entry("local", B, "E3", 0)], boot_id: "E3" });
    await flush();
    coordinator.roster([entry("local", O, "E1", 4)], { kind: "load", started: coordinator.loadStarted() });
    const ask = await asks.next();
    coordinator.roster([entry("local", O, "E1", 4)], event);
    ask.resolve({ machines: [entry("local", O, "E1", 4)], boot_id: "E3" });
    await flush();
    expect(coordinator.order("local", O)).toEqual(B);
    expect(coordinator.state("local")).toMatchObject({ guard: { epoch: "E3", version: 1 }, retired: ["E2"] });
    expect(seen.some((order) => order.join() === O.join())).toBe(false);
  });

  test("a receipt or answer naming a retired epoch never brings it back", async () => {
    const asks = verifier();
    const coordinator = new ReorderCoordinator({ verify: asks.verify });
    const moves = mover();
    await dragged(coordinator, moves, { ok: true, order_epoch: "E2", moved_seq: 1 });
    coordinator.roster([entry("local", O, "E3", 0)], event);
    (await asks.next()).resolve({ machines: [], boot_id: "E3" });
    await flush();
    coordinator.roster([entry("local", O, "E2", 9)], event);
    expect(asks.count()).toBe(0);
    expect(coordinator.order("local", O)).toEqual(A);
    coordinator.roster([entry("local", O, "E5", 0)], event);
    (await asks.next()).resolve({ machines: [entry("local", O, "E2", 9)], boot_id: "E2" });
    await flush();
    expect(coordinator.state("local")).toMatchObject({ guard: { epoch: "E3", version: 1 }, retired: ["E2"] });
    const late = coordinator.reorder("local", A, B, moves.move);
    (await moves.next()).resolve({ ok: true, order_epoch: "E2", moved_seq: 10 });
    await late;
    expect(coordinator.state("local").floors).toEqual({});
  });
});
