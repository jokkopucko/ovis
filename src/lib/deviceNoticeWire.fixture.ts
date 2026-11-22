import type { DeviceNotice } from "../../shared/account-devices-api.ts";
import type { ServerFeature, ServerMessage } from "../../shared/protocol.ts";

export const DEVICE_NOTICE_FEATURE = "account-opens-all/1";
export const NOTICE_SNAPSHOT = { version: "test", protocol: 22, workspaces: [], panes: [], agents: [], tabs: [], layouts: [], herdr_lifetime: "new" };

export const deviceNotice = (changes: Partial<DeviceNotice> = {}): DeviceNotice => ({
  seq: 1, id: "a".repeat(32), at: "2026-11-20T04:00:00.000Z", kind: "admit", how: "list",
  key: "k".repeat(43), no: 4, row: null, label: "Test phone", by: null, account: "acct",
  open: true, method: "github", two_step: "set", ...changes,
});

export class DeviceNoticeWire extends EventTarget {
  readyState = 0;
  readonly sent: { type: string; seq?: number }[] = [];
  constructor(readonly url: string) { super(); }
  send(message: string) { this.sent.push(JSON.parse(message)); }
  close() { this.readyState = 3; this.dispatchEvent(new CloseEvent("close", { code: 1000 })); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  read(message: ServerMessage) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
  snapshot(features: readonly ServerFeature[] = [DEVICE_NOTICE_FEATURE]) {
    this.read({ type: "snapshot", snapshot: NOTICE_SNAPSHOT, features: [...features] });
  }
  seen() { return this.sent.filter((message) => message.type === "notice-seen"); }
}
