import { describe, expect, it } from "bun:test";
import { procLink, stillIn } from "./pane-proof.ts";

describe.skipIf(process.platform !== "linux")("a call's caller stays a process of its pane", () => {
  it("is in the pane while the pane's root, born when proved, is among its parents, and out once it is not", () => {
    const parent = procLink(process.ppid);
    if (!parent) throw new Error("missing proof fixture parent");
    const peer = { pid: process.pid, alive: () => true, close: () => {} };
    expect(stillIn(peer, { pane: "t1", created_ms: 1, root: parent.pid, birth: parent.birth })).toBe(true);
    expect(stillIn(peer, { pane: "t1", created_ms: 1, root: parent.pid, birth: "another-birth" })).toBe(false);
    expect(stillIn({ ...peer, alive: () => false }, { pane: "t1", created_ms: 1, root: parent.pid, birth: parent.birth })).toBe(false);
  });
});
