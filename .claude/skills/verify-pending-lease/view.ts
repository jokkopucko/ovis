// The words /statechart puts on PendingLease.tla's states and steps. Page A sends the queued message.
type Vars = Record<string, any>;

const pageName = (c: string): string => `page ${c.toUpperCase()}`;
const names = (set: string[]): string => (set.length ? set.map(pageName).join(" and ") : "nobody");
const ROW: Record<string, string> = {
  asked: "asked for, not listed yet", queued: "waits for the agent's turn", held: "held for Send now", sending: "being sent",
  uncertain: "may have been typed", review: "may have been typed, kept for review", sent: "sent", lost: "may have been typed",
};

export const title = "A pending message and the pages attached to its pane";

export function state(v: Vars): string {
  const parts: string[] = [];
  const row = (m: "Q" | "F"): string => (v.st[m] === "uncertain" && v.fl[m] ? "being sent, its page gone" : ROW[v.st[m]]);
  if (v.st.Q !== "none") parts.push(`A's message ${row("Q")}`);
  if (v.st.F !== "none") parts.push(`${pageName(v.page)}'s first message ${row("F")}`);
  if (v.typedAfterLoss) parts.push("typed after its page left");
  if (v.firstWithoutPage) parts.push("first message typed without its page");
  if (["asked", "queued"].includes(v.st.F) && !v.pageOk) parts.push("its page has left since it asked");
  if (v.pastes.Q > 1 || v.pastes.F > 1 || v.enters.Q > 1 || v.enters.F > 1) parts.push("typed twice");
  if (v.turnWait) parts.push("the queue waits for a turn's end the agent tells");
  if (v.behindTurn) parts.push("the queue typed before that turn's end was told");
  parts.push(`${names(v.members)} attached`);
  return parts.join("; ");
}

const added = (from: string[], to: string[]): string => pageName(to.find((c) => !from.includes(c)) ?? "?");
const removed = (from: string[], to: string[]): string => pageName(from.find((c) => !to.includes(c)) ?? "?");
const changed = (from: Record<string, string>, to: Record<string, string>): string =>
  pageName(Object.keys(to).find((c) => from[c] !== to[c]) ?? "?");
const message = (v: Vars, m: string): string => (m === "Q" ? "A's message" : `${pageName(v.page)}'s first message`);

export function step(action: string, from: Vars, to: Vars): string | null {
  const m = from.lane.m !== "none" ? from.lane.m : to.lane.m;
  const what = m && m !== "none" ? message(from, m) : "the message";
  switch (action) {
    case "Attach": return `${added(from.members, to.members)} opens the pane${from.att ? "" : to.ready ? " (its terminal is ready)" : " (its terminal starts)"}`;
    case "Detach": return `${removed(from.members, to.members)} leaves the pane`;
    case "CloseAttachment": return "the pane's terminal ends";
    case "Took": return "the terminal is ready for input";
    case "Ended": return to.held && !from.held ? "the terminal's attach stops: another bridge has it" : "the terminal's attach stops";
    case "Restart": return "the terminal's attach starts again";
    case "Observe": return `${changed(from.mode, to.mode)} switches to watching only`;
    case "Interact": return `${changed(from.mode, to.mode)} may type again`;
    case "Close": return `${changed(from.conn, to.conn)} disconnects`;
    case "Revoke": return `${changed(from.conn, to.conn)} has its device revoked`;
    case "Submit": return to.req.kind === "queue" ? "page A queues a message" : "page A sends a message to hold";
    case "SendNow": return `${pageName(to.req.c)} presses Send now on ${message(from, to.req.m)}`;
    case "FirstListed": return `${message(from, "F")} is listed: ${to.st.F === "queued" ? "it waits for the agent's turn" : "held"}`;
    case "RequestRuns": return `${pageName(to.lane.by)}'s request gets its turn`;
    case "AcceptRefused": return "the message is refused";
    case "AcceptEnqueue": return to.st.Q === "queued" ? "the message is accepted and waits" : "the message is accepted and held";
    case "AcceptHeld": return "the message is accepted, and held: its page lost the pane meanwhile";
    case "AcceptTypeNow": return "the agent is at rest: the message is typed at once";
    case "SteerRefused": return "Send now is refused";
    case "SteerClaim": return `Send now starts for ${what}`;
    case "DrainPick": return `the agent's turn ends: the queue takes up ${what}`;
    case "DrainSkips": return `the queue leaves ${what}: it no longer waits`;
    case "DrainClaim": return `the automatic send of ${what} starts`;
    case "DrainClaimNoLease": return `the automatic send of ${what} cannot start`;
    case "RefusedForNow": return `the send of ${what} is put off: the agent is busy or waits for an answer`;
    case "TypeNowWaits": return "the agent works again: the message waits";
    case "RefusedForGood": return `the send of ${what} is refused`;
    case "RefusedHoldPane": return `the send of ${what} is refused, and the pane's messages are held`;
    case "LeaseFailed": return `the send of ${what} stops: its page may no longer type`;
    case "Paste": return `${what} is pasted into the terminal`;
    case "DataUnsent": return `the agent's own server takes nothing of ${what}: it is typed as before`;
    case "SubmitAsData": return `${what} is sent as data`;
    case "DataBusy": return `the agent's own server says a turn runs: ${what} waits behind that turn's end`;
    case "DataUnanswered": return to.lane.m === "none" ? `no answer comes for ${what}: it is kept, not confirmed` : `no answer comes for ${what}, and it is typed instead`;
    case "SentAsTurn": return `${what} is sent as a turn: the queue waits for that turn's own end`;
    case "TurnOver": return "the agent tells that turn's end, or can no longer tell it: the queue goes on";
    case "FailedAfterPaste": return `the send of ${what} fails after it was typed`;
    case "Enter": return `Enter is pressed for ${what}`;
    case "LaterKey": return `a follow-up key is pressed for ${what}`;
    case "Sent": return `${what} is sent`;
    case "SentUnconfirmed": return `${what} is not confirmed: kept for review`;
    default: return null;
  }
}
