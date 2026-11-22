import { describe, expect, it } from "bun:test";
import { noInstalledNotes, noUpdateNotes, readUpdateIpcRequest, unmanagedUpdateStatus, type UpdateCommand, type UpdateRequest, type UpdateStatus, INSTALL_ID } from "../shared/update.ts";
import { connectUpdater, handleUpdateRequest } from "./update-api.ts";

// Messages go as they would over Node's: copied, one at a time, to whoever listens.
const A = "a".repeat(40), B = "b".repeat(40);
const offer = (latest: string): UpdateStatus => ({ ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true,
  latest_revision: latest, latest_version: "9.9.9", current_revision: "c".repeat(40) });

function supervisor(handle: (message: unknown) => void) {
  let toBridge: (message: unknown) => void = () => {};
  const received: unknown[] = [];
  const channel = {
    send: (message: unknown) => { const copy = structuredClone(message); received.push(copy); handle(copy); },
    onMessage: (listener: (message: unknown) => void) => { toBridge = listener; },
  };
  const bridge = connectUpdater(channel);
  return { bridge, received, tell: (status: UpdateStatus) => toBridge(structuredClone({ type: "update-status", status, notes: noUpdateNotes(), installed: noInstalledNotes() })) };
}

function olderSupervisor() {
  const commands: UpdateCommand[] = [];
  const ends = supervisor((message) => {
    const value = message as { type?: string; command?: string } | null;
    if (value?.type === "update-command" && (value.command === "check" || value.command === "install")) commands.push(value.command);
  });
  return { ...ends, commands };
}

function currentSupervisor() {
  const requests: UpdateRequest[] = [];
  const ends = supervisor((message) => { const request = readUpdateIpcRequest(message); if (request) requests.push(request); });
  return { ...ends, requests, tell: (status: UpdateStatus) => ends.tell({ ...status, revision_bound_install: true }) };
}

const post = async (bridge: ReturnType<typeof connectUpdater>, revision: string) => {
  const response = await handleUpdateRequest(new Request("http://127.0.0.1/api/updates/install", {
    method: "POST", headers: { "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ expected_revision: revision }),
  }), "/api/updates/install", bridge);
  return { status: response.status, code: ((await response.json()) as { error?: { code?: string } }).error?.code ?? null };
};

describe("the update IPC between the bridge and its supervisor", () => {
  it("an older supervisor exposes no capability and receives no install", async () => {
    const older = olderSupervisor();
    older.tell(offer(A));
    expect(older.bridge.status().revision_bound_install).toBeUndefined();
    expect(await post(older.bridge, A)).toEqual({ status: 409, code: "update_restart_required" });
    // even a request past the HTTP gate goes as a message the older supervisor does not know
    older.bridge.request({ command: "install", expected_revision: A });
    expect(older.received.at(-1)).toEqual({ type: "update-install-revision", expected_revision: A });
    expect(older.commands).toEqual([]);
    older.bridge.request({ command: "check" });
    expect(older.commands).toEqual(["check"]);
  });

  it("this supervisor receives the exact revision, and refuses an unbound install", async () => {
    const current = currentSupervisor();
    current.tell(offer(A));
    expect(current.bridge.status().revision_bound_install).toBe(true);
    expect(await post(current.bridge, A)).toEqual({ status: 202, code: null });
    expect(current.requests).toEqual([{ command: "install", expected_revision: A, install_id: expect.stringMatching(INSTALL_ID) }]);
    // what an older bridge sends for its Update: no revision, so no install
    expect(readUpdateIpcRequest({ type: "update-command", command: "install" })).toBeNull();
    expect(readUpdateIpcRequest({ type: "update-command", command: "check" })).toEqual({ command: "check" });
    // a cancel goes as a type of its own, which an older supervisor ignores
    // naming the install it stops; one that names none, or not an id, is no cancel
    expect(readUpdateIpcRequest({ type: "update-cancel-v2", install_id: "11111111-2222-4333-8444-555555555555" })).toEqual({ command: "cancel", install_id: "11111111-2222-4333-8444-555555555555" });
    for (const install_id of [undefined, "", "x", 7]) expect(readUpdateIpcRequest({ type: "update-cancel-v2", install_id })).toBeNull();
    // the name a supervisor that cancels without an id might know: never read as a cancel
    expect(readUpdateIpcRequest({ type: "update-cancel", install_id: "11111111-2222-4333-8444-555555555555" })).toBeNull();
  });

  it("reads only a full lowercase commit id, and nothing from a message out of shape", () => {
    for (const message of [null, undefined, "update-install-revision", 7, [], {}, { type: "update-install-revision" },
      { type: "update-install-revision", expected_revision: A.slice(1) }, { type: "update-install-revision", expected_revision: `${"a".repeat(64)}a` },
      { type: "update-install-revision", expected_revision: A.toUpperCase() }, { type: "update-install-revision", expected_revision: `${A} ` },
      { type: "update-install-revision", expected_revision: 1 }, { type: "update-install-revision", expected_revision: "x".repeat(100_000) },
      { type: "update-command", command: "install", expected_revision: A }, { type: "update-command", command: "build" }]) {
      expect(readUpdateIpcRequest(message)).toBeNull();
    }
    expect(readUpdateIpcRequest({ type: "update-install-revision", expected_revision: "d".repeat(64) })).toEqual({ command: "install", expected_revision: "d".repeat(64) });
  });

  it("two tabs offered A and then B: A never installs B", async () => {
    const current = currentSupervisor();
    current.tell(offer(A));
    current.tell(offer(B));
    expect(await post(current.bridge, A)).toEqual({ status: 409, code: "update_offer_changed" });
    expect(current.requests).toEqual([]);
    expect(await post(current.bridge, B)).toEqual({ status: 202, code: null });
    expect(current.requests).toEqual([{ command: "install", expected_revision: B, install_id: expect.stringMatching(INSTALL_ID) }]);
    const older = olderSupervisor();
    older.tell(offer(A));
    older.tell(offer(B));
    for (const revision of [A, B]) expect(await post(older.bridge, revision)).toEqual({ status: 409, code: "update_restart_required" });
    expect(older.commands).toEqual([]);
  });
});
