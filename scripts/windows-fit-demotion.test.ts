import { expect, it } from "bun:test";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { checkWindowsFitDemotion } from "./windows-fit-demotion.ts";

it("rejects a demotion QA pass when the old viewer still holds the control slot", async () => {
  const pane = "p", received: ServerMessage[] = [];
  const viewer = {
    send(frame: ClientMessage) {
      if (frame.type === "role") received.push({ type: "role-ack", mode: "observe" });
      if (frame.type === "resize") received.push({ type: "error", code: "read_only", message: "read only" });
    },
    async wait(test: (frame: ServerMessage) => boolean) {
      const next = received.shift();
      if (!next || !test(next)) throw new Error("Unexpected QA wait");
      return next;
    },
  };
  const connect = async () => ({
    send(frame: ClientMessage) {
      if (frame.type === "attach") received.push({ type: "error", code: "attach_held", pane_id: pane, message: "still held" });
    },
    wait: viewer.wait,
  });

  await expect(checkWindowsFitDemotion(viewer, connect, pane)).rejects.toThrow("still holds");
});
