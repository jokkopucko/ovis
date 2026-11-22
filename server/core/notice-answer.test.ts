import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { DeviceJournal, JOURNAL_FILE } from "../account/device-journal.ts";
import { PcAccountState } from "../account/pc-binding.ts";
import { RemovalEvidence } from "../account/removal-evidence.ts";
import { SafetyLog } from "../account/safety-log.ts";
import { DeviceStore } from "../devices.ts";
import { caughtUp, relayConnection, relayFixture } from "../relay/test-helpers.ts";
import { connectionData, type Client } from "./connections.ts";
import { createSocket } from "./socket.ts";

const ACCOUNT = "acct_1";
const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Key { keys: CryptoKeyPair; spki: string }

function pc() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-notice-answer-"));
  dirs.push(dir);
  const log = SafetyLog.open(dir);
  const devices = new DeviceStore(dir, null, null, { safety: log, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, log), journal: DeviceJournal.open(dir, () => log.ensureFile()) });
  return { dir, devices };
}

async function member(devices: DeviceStore): Promise<Key & { id: string }> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = await exportAccountKey(keys.publicKey);
  const id = devices.pairRelay(devices.startPairing().code, "Phone", spki)!.device.id;
  devices.linkAccountKey(id, spki, spki, ACCOUNT);
  return { keys, spki, id };
}

const block = (target: string, by: Key) =>
  signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, target_no: 9, signer_no: 1, signer: by.spki, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey);

async function signIn(devices: DeviceStore, row: Key & { id: string }) {
  const serverId = "0123456789abcdef0123456789abcdef";
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const message = Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(serverId)]);
  const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, row.keys.privateKey, message)).toString("base64url");
  return devices.matchRelay(row.id, nonce, signature, serverId);
}

function noticeSocket(devices: DeviceStore, deviceId: string, submit = (value: unknown) => devices.applyBlock(value, "session")) {
  const handler = createSocket({
    clients: new Set(), present: new Set(), stopped: () => false, admit: () => true, setRole() {},
    watchable: () => false, terminalHistory: () => false, terminalModes: () => false, watchPane() {}, unwatchPane() {},
    end() {}, holdPending() {}, attachments: new Map(), clientSnapshot: async () => { throw new Error("Snapshot not used"); },
    herdrLifetime: () => undefined, browserSnapshot: (snapshot) => snapshot, countVisit() {}, drainOutput() {}, frames: {} as never,
    accountEnabled: true,
    notices: { replay: (id) => devices.noticeReplay(id), seen: (id, seq) => devices.noticeSeen(id, seq), block: submit, decide: (id) => devices.decideNotice(id), itsMe: () => false,
      open: id => devices.openNotices().find(entry => entry.id === id), mayAnswer: (caller, id) => devices.mayAnswerNotice(caller, id) },
  });
  const replies: ServerMessage[] = [];
  const client: Client = {
    data: connectionData({ deviceId, readOnly: false }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0,
    send: (raw) => { replies.push(JSON.parse(String(raw))); return 1; }, close() {},
  };
  return { send: (frame: unknown) => handler.message(client, JSON.stringify(frame)), replies };
}

describe("blocks and freezes on the PC (P16, P21, T51)", () => {
  test("T51: a notice rewrite failure keeps the notice open and reports the committed block", async () => {
    const { dir, devices } = pc();
    const signer = await member(devices);
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const spki = await exportAccountKey(keys.publicKey);
    // The notice itself must name the account. A pre-link pairing notice grants no authority to decide it.
    const target = { ...devices.addAccountDevice({ id: "2222222222222222", key: spki, label: "Target", role: "drive", account: ACCOUNT, addedBy: signer.id }), spki };
    const notice = devices.openNotices().find((entry) => entry.row === target.id);
    if (!notice) throw new Error("Missing target admission notice");
    const record = await block(target.spki, signer);
    const socket = noticeSocket(devices, signer.id, async (value) => {
      const receipt = await devices.applyBlock(value, "session");
      const path = join(dir, JOURNAL_FILE);
      renameSync(path, `${path}.saved`);
      mkdirSync(path);
      return receipt;
    });

    await socket.send({ type: "notice-answer", id: notice.id, answer: "not_me", blocks: [record] });
    await socket.send({ type: "ping", id: 51 });

    expect(socket.replies).toContainEqual({ type: "notice-answer-result", id: notice.id, receipts: [{ outcome: "applied", id: record.id, n: 1 }] });
    expect(socket.replies).toContainEqual(expect.objectContaining({ type: "error", code: "notice_decision_failed" }));
    expect(socket.replies).toContainEqual({ type: "pong", id: 51 });
    expect(devices.openNotices().some((entry) => entry.id === notice.id)).toBe(true);
    expect(devices.failsClosed).toBe(true);
    expect(await signIn(devices, signer)).toBeNull();
  });

  test("T51: a non-string notice ID neither applies blocks nor sends a result", async () => {
    const { devices } = pc();
    const signer = await member(devices);
    const target = await member(devices);
    const record = await block(target.spki, signer);
    const socket = noticeSocket(devices, signer.id);

    await socket.send({ type: "notice-answer", id: 51, answer: "not_me", blocks: [record] });

    expect(socket.replies).toEqual([]);
    expect(devices.has(target.id)).toBe(true);
  });

  test("T51: flag off sends no reply bytes for an empty notice answer", async () => {
    const fixture = relayFixture(false, { accountOpensAll: false });
    fixtures.push(fixture);
    const socket = new WebSocket(`ws://127.0.0.1:${fixture.app.port}/ws`);
    try {
      const replies = await new Promise<string[]>((resolve, reject) => {
        const received: string[] = [];
        let sent = false;
        socket.onerror = () => reject(new Error("Could not open the events socket"));
        socket.onclose = () => reject(new Error("Events socket closed before the sentinel"));
        socket.onmessage = (event) => {
          const raw = String(event.data);
          const frame: { type: string; id?: number } = JSON.parse(raw);
          if (!sent) {
            if (frame.type !== "snapshot" && frame.type !== "error") return;
            sent = true;
            socket.send(JSON.stringify({ type: "notice-answer", id: "gate", answer: "not_me", blocks: [] }));
            socket.send(JSON.stringify({ type: "ping", id: 51 }));
          } else if (frame.type === "pong" && frame.id === 51) resolve(received);
          else received.push(raw);
        };
      });
      expect(replies).toEqual([]);
    } finally {
      socket.close();
    }
  });

  test("T51: the block reaches the PC over its records route and the notice answer, and an old app's call is unchanged", async () => {
    const f = relayFixture(false, { accountOpensAll: true });
    fixtures.push(f);
    const devices = f.app.context.services.devices;
    const [older, target, another] = [await member(devices), await member(devices), await member(devices)];
    const link = await relayConnection(f);
    caughtUp(f);
    await link.auth({ keys: older.keys, publicKey: older.spki, id: older.id });
    const post = async (body: unknown) => {
      const request = link.open("/api/account/records", { method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" });
      void request.stream.sendBody(new Response(JSON.stringify(body)).body!).catch(() => {});
      const response = await request.response;
      return await response.json() as { results: unknown[]; receipts?: unknown[] };
    };
    // an old app sends no block: the answer is today's shape
    expect(Object.keys(await post({ records: [] })).sort()).toEqual(["results"]);
    const record = await block(target.spki, older);
    expect(await post({ records: [record] })).toEqual({ results: [], receipts: [{ outcome: "applied", id: record.id, n: 1 }] });
    expect(devices.has(target.id)).toBe(false);

    // the notice's own PC: "Not me" over the events socket answers with the receipts, the same block again included
    const notMe = await block(another.spki, older);
    const socket = new WebSocket(`ws://127.0.0.1:${f.app.port}/ws`);
    const result = new Promise<{ id: string; receipts: unknown[] }>((resolve) => {
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as { type: string; id: string; receipts: unknown[] };
        if (frame.type === "features") socket.send(JSON.stringify({ type: "notice-answer", id: "n1", answer: "not_me", blocks: [notMe, record] }));
        if (frame.type === "notice-answer-result") resolve(frame);
      };
    });
    expect(await result).toEqual({ type: "notice-answer-result", id: "n1", receipts: [{ outcome: "applied", id: notMe.id, n: 2 }, { outcome: "applied", id: record.id, n: 1 }] } as never);
    socket.close();
    expect(devices.has(another.id)).toBe(false);
  });
});
