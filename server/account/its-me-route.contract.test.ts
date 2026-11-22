import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { DeviceNotice } from "../../shared/account-devices-api.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import { ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import * as herdr from "../herdr/client.ts";
import { privateStateFs } from "../private-state.ts";
import { relayConnection, relayDevice } from "../relay/test-helpers.ts";
import { keyOf } from "./account-devices.test-helpers.ts";
import { DeviceJournal, JOURNAL_FILE } from "./device-journal.ts";
import { ITS_ME_MIN_AGE_MS } from "./join-hold.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";

test("S2P-11, T53: It's me ends the hold and replays the original admission's close to an offline observer", async () => {
  const closes: (() => void)[] = [];
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({
    panes: [], agents: [], workspaces: [], tabs: [], layouts: [], version: "fixture", protocol: 22,
  });
  try {
    const { fixture, member: sayer, service, serverId } = await createListedPc(close => closes.push(close));
    now += 2 * ITS_ME_MIN_AGE_MS;
    const { devices, accountMailbox, core } = fixture.app.context.services;
    const observer = await relayDevice(fixture);
    const connect = async (device: typeof sayer) => {
      const link = await relayConnection(fixture, { serverId, websocket: core.socketHandlers });
      await link.auth(device, [ACCOUNT_OPENS_ALL_FEATURE]);
      return link;
    };
    const key = keyOf("k-held");
    const id = accountDeviceId(serverId, key);
    service.registerDevice(ACCOUNT, key, "New phone");
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const notice = devices.openNotices().find(entry => entry.row === id);
    if (!notice) throw new Error("Missing the new phone's admission notice");
    expect(devices.sessionRow(id)).toBeNull();
    const before = await connect(observer);
    const observing = before.openSocket();
    await observing.opened;
    const initial = await observing.until(message => message.type === "device-notice-replay");
    if (initial.type !== "device-notice-replay") throw new Error("Missing initial observer replay");
    expect(initial.replay.notices.find(entry => entry.id === notice.id)).toMatchObject({ open: true });
    observing.send({ type: "notice-seen", seq: notice.seq });
    observing.send({ type: "ping", id: 1 });
    await observing.until(message => message.type === "pong" && message.id === 1);
    before.stop();
    await before.closed;

    const socket = (await connect(sayer)).openSocket();
    await socket.opened;

    const writes: (readonly DeviceNotice[])[] = [];
    const rename = privateStateFs.renameSync;
    const journalPath = join(fixture.stateDir, JOURNAL_FILE);
    const record = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (to === journalPath) writes.push(DeviceJournal.open(fixture.stateDir).replay(observer.id, entry => entry.row === id).notices);
    });
    try {
      socket.send({ type: "notice-answer", id: notice.id, answer: "its_me" });
      socket.send({ type: "ping", id: 2 });
      await socket.until(message => message.type === "pong" && message.id === 2);
    } finally {
      record.mockRestore();
    }

    expect({
      refusal: socket.messages.find(message => message.type === "error"),
      confirmed: socket.messages.some(message => message.type === "device-notice" && message.notice.kind === "confirm" && message.notice.how === "its_me" && message.notice.row === id),
      session: devices.sessionRow(id),
      open: devices.openNotices().some(entry => entry.id === notice.id),
    }).toMatchObject({ refusal: undefined, confirmed: true, session: { role: "drive", key }, open: false });

    const reconnected = (await connect(observer)).openSocket();
    await reconnected.opened;
    const replay = await reconnected.until(message => message.type === "device-notice-replay");
    if (replay.type !== "device-notice-replay") throw new Error("Missing reconnect replay");
    expect(replay.replay.cut).toBe(0);
    const replayed = replay.replay.notices.filter(entry => entry.row === id);
    expect(replayed).toMatchObject([
      { kind: "confirm", how: "its_me", open: false },
      { id: notice.id, kind: "admit", open: false },
    ]);
    expect(replayed.find(entry => entry.id === notice.id)?.seq).toBeGreaterThan(notice.seq);
    expect(writes).toEqual([replayed]);
  } finally {
    clock.mockRestore();
    snapshot.mockRestore();
    for (const close of closes) close();
  }
});

test("T53: an It's me the PC cannot record answers notice_decision_failed and the same connection keeps answering", async () => {
  const closes: (() => void)[] = [];
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({
    panes: [], agents: [], workspaces: [], tabs: [], layouts: [], version: "fixture", protocol: 22,
  });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { fixture, member: sayer, service, serverId } = await createListedPc(close => closes.push(close));
    now += 2 * ITS_ME_MIN_AGE_MS;
    const { devices, accountMailbox, core } = fixture.app.context.services;
    const key = keyOf("k-held");
    service.registerDevice(ACCOUNT, key, "New phone");
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const notice = devices.openNotices().find(entry => entry.row === accountDeviceId(serverId, key));
    if (!notice) throw new Error("Missing the new phone's admission notice");
    const failing = spyOn(devices, "itsMe").mockImplementation(() => { throw new Error("EIO"); });
    const link = await relayConnection(fixture, { serverId, websocket: core.socketHandlers });
    await link.auth(sayer, [ACCOUNT_OPENS_ALL_FEATURE]);
    const socket = link.openSocket();
    await socket.opened;
    socket.send({ type: "notice-answer", id: notice.id, answer: "its_me" });
    socket.send({ type: "ping", id: 7 });
    await socket.until(message => message.type === "pong" && message.id === 7);
    expect({
      called: failing.mock.calls.length,
      error: socket.messages.find(message => message.type === "error")?.code,
      open: devices.openNotices().some(entry => entry.id === notice.id),
    }).toEqual({ called: 1, error: "notice_decision_failed", open: true });
    failing.mockRestore();
  } finally {
    logged.mockRestore();
    clock.mockRestore();
    snapshot.mockRestore();
    for (const close of closes) close();
  }
});
