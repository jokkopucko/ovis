import { expect, it } from "bun:test";
import { MuxProtocolError } from "../shared/relay-mux.ts";
import { accountPcFailure } from "./machines.ts";
import { RelayPcRefused } from "./relay-pc.ts";

const shown = { shown: true, aborted: false };

it("tells a member's Deny from nobody answering in time, once the request was shown", () => {
  expect(accountPcFailure(new MuxProtocolError("auth_failed", "refused"), shown).failure).toBe("declined");
  // the PC closed the comparison at its deadline (session.ts close("timeout")): nobody decided, so nothing is remembered
  expect(accountPcFailure(new MuxProtocolError("timeout", "timed out"), shown).failure).toBe("unanswered");
  expect(accountPcFailure(new Error("Relay connection lost", { cause: new MuxProtocolError("timeout", "timed out") }), shown).failure).toBe("unanswered");
});

it("keeps the failures before the request was shown as they were", () => {
  expect(accountPcFailure(new MuxProtocolError("timeout", "timed out"), { shown: false, aborted: false }).failure).toBe("offline");
  expect(accountPcFailure(new MuxProtocolError("auth_failed", "refused"), { shown: true, aborted: true }).failure).toBe("cancelled");
});

it("says what a refusal before the request was shown needs, never that the PC may be out of the account the directory lists it in", () => {
  // a PC of the account with no device paired at it has nobody to approve another PC (session.ts accountJoin), the
  // most common refusal: it is in the account, so checking that and trying again changes nothing
  const refused = accountPcFailure(new RelayPcRefused("That PC did not accept this PC.", { cause: new MuxProtocolError("auth_failed", "refused") }), { shown: false, aborted: false });
  expect(refused.failure).toBe("refused");
  expect(refused.message).toBe("That PC did not take the request. Only a device of your account that is paired with that PC can let another PC in there.");
});
