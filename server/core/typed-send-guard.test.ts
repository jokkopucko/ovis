import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "../herdr/client.ts";
import { createSubmitText } from "./composer.ts";

afterEach(() => mock.restore());

const submitter = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
  SUBMIT_DEADLINE_MS: 1000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

function senderLeavesWhileConnecting(during: "text" | "enter") {
  let watching = false;
  const authorize = () => { if (watching) throw new client.HerdrError("read_only", "this connection can only watch"); };
  const written: unknown[] = [];
  const write = (what: unknown, guard?: () => boolean) => {
    if (guard && !guard()) throw new client.HerdrError("cancelled", "herdr was not written to");
    written.push(what);
  };
  spyOn(client, "paneSendText").mockImplementation(async (_pane, text, _socketPath, guard) => {
    if (during === "text") watching = true;
    write(text, guard);
  });
  spyOn(client, "paneSendKeys").mockImplementation(async (_pane, keys, _socketPath, guard) => {
    if (during === "enter") watching = true;
    write(keys, guard);
  });
  return { authorize, written };
}

const failure = (sent: Promise<void>) => sent.then(() => null, (error: unknown) => error as client.HerdrError);

it("types an input line and its Enter with a guard asked right before each write", async () => {
  const typed = spyOn(client, "paneSendText").mockResolvedValue();
  const keys = spyOn(client, "paneSendKeys").mockResolvedValue();
  await submitter()("w:p1", "2", "2", Date.now(), true);
  expect(typed).toHaveBeenCalledWith("w:p1", "2", undefined, expect.any(Function));
  expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"], undefined, expect.any(Function));
});

it("types nothing of an input line whose sender may no longer type once herdr is reached", async () => {
  const { authorize, written } = senderLeavesWhileConnecting("text");
  const failed = await failure(submitter()("w:p1", "2", "2", Date.now(), true, authorize));
  expect(failed?.code).toBe("read_only");
  expect(written).toEqual([]);
});

it("presses no Enter for a sender that may no longer type once herdr is reached for it", async () => {
  const { authorize, written } = senderLeavesWhileConnecting("enter");
  const failed = await failure(submitter()("w:p1", "2", "2", Date.now(), true, authorize));
  expect(failed?.code).toBe("read_only");
  expect(written).toEqual(["2"]);
});
