import { expect, test } from "bun:test";
import { FrameType } from "../../shared/relay-mux.ts";
import { bounded, deferred } from "../relay/test-helpers.ts";
import { keyProofPc, provingDevice } from "./key-proof.test-helpers.ts";

test("T5/T71: a relay pass that stops admitting new devices during the screen wait prevents admission", async () => {
  const made = await keyProofPc(true);
  try {
    let refuses = false;
    const outcome = deferred<"refused" | "authenticated">();
    const paired = await provingDevice(made, await made.offerCode(), { refuseNewDevice: () => {
      if (refuses) outcome.resolve("refused");
      return refuses;
    } });
    await paired.pending;
    paired.link.onFrame = (frame) => { if (frame.type === FrameType.AUTH_OK) outcome.resolve("authenticated"); };
    const prompt = made.screen.keyConfirm();
    if (prompt === undefined) throw new Error("Expected the screen approval prompt");

    refuses = true;
    made.screen.approve(prompt.id);
    const decided = await bounded(outcome.promise);
    await paired.link.flush();

    expect(made.stored().find((row) => row.relay_public_key === paired.device.spki)).toBeUndefined();
    expect(paired.link.frames.map((frame) => frame.type)).not.toContain(FrameType.AUTH_OK);
    expect(decided).toBe("refused");
  } finally {
    await made.close();
  }
});
