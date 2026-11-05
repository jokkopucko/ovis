import { describe, expect, it } from "bun:test";

import { currentWaitingSends, expireWaitingSends, forgetMachineWaitingSends, forgetWaitingSends, rememberWaitingSend, settleWaitingSends, WAITING_SEND_MS, waitingBaseline, waitingKey } from "./sentWaiting.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";
import type { Machine } from "../../shared/machines.ts";
import { paneLifetimes } from "./paneLifetime.ts";

const user = (text: string, at = 2): ConversationTurn => ({ role: "user", ts: new Date(at).toISOString(), parts: [{ kind: "text", text }] });
const assistant = (text: string): ConversationTurn => ({ ...user(text), role: "assistant" });

// through the store, as ChatView settles it: a send the chat had shown no turns for
let probes = 0;
function transcriptHolds(send: { text: string; at: number }, turns: readonly ConversationTurn[]): boolean {
  const key = waitingKey("local", `probe-${++probes}`);
  try {
    rememberWaitingSend(key, send.text, send.at);
    settleWaitingSends(key, turns, send.at + 1);
    return currentWaitingSends(key).length === 0;
  } finally { forgetWaitingSends(key); }
}
const waitingText = (send: { text: string; at: number } | null, turns: readonly ConversationTurn[]): string | null =>
  send === null || transcriptHolds(send, turns) ? null : send.text;

describe("waitingText", () => {
  const send = { pane: "p1", text: "还有发消息提示：未确认。重新发送前请检查终端。", at: 1 };

  it("keeps a sent message in view until the transcript has it", () => {
    // Claude writes the user turn only when its next turn starts: until then the chat shows nothing
    expect(waitingText(send, [assistant("earlier")])).toBe(send.text);
    expect(waitingText(send, [assistant("earlier"), user(send.text)])).toBeNull();
  });

  it("reads the copy the terminal writes as the same message", () => {
    // a space closing a final @mention (server/core/composer.ts closeMention), CRLF line ends,
    // and whitespace around the message or at the ends of its lines
    expect(transcriptHolds({ ...send, text: "ask @alice" }, [user("ask @alice ")])).toBe(true);
    expect(transcriptHolds({ ...send, text: "one\ntwo" }, [user("one  \r\ntwo")])).toBe(true);
    expect(transcriptHolds(send, [user(`  ${send.text}  `)])).toBe(true);
  });

  it("does not take a message that differs only in its spaces for this one", () => {
    expect(transcriptHolds({ ...send, text: "change a b to c" }, [user("change ab to c")])).toBe(false);
    expect(transcriptHolds({ ...send, text: "rename user id" }, [user("renameuserid")])).toBe(false);
  });

  it("does not take another turn's words for it", () => {
    expect(transcriptHolds(send, [user("还有发消息提示")])).toBe(false);
    expect(transcriptHolds(send, [assistant(send.text)])).toBe(false);
  });

  it("says nothing for an empty message or no message", () => {
    expect(waitingText(null, [])).toBeNull();
    expect(waitingText({ ...send, text: "   " }, [])).toBeNull();
    expect(waitingText({ ...send, text: "x" }, [])).toBe("x");
  });

  it("keeps a repeated message waiting when only an earlier matching user turn exists", () => {
    const repeated = { ...send, at: Date.parse("2026-10-29T10:00:01Z") };
    const earlier = { ...user(send.text), ts: "2026-10-29T10:00:00Z" };
    expect(waitingText(repeated, [earlier])).toBe(send.text);
  });

  it("does not settle pending yes from yes, please proceed with the changes", () => {
    expect(waitingText({ ...send, text: "yes" }, [user("yes, please proceed with the changes")])).toBe("yes");
  });

  it("does not settle an unmarked shortened copy", () => {
    const text = "Please review the complete implementation and report the remaining issues";
    expect(transcriptHolds({ ...send, text }, [user("Please review the complete implementation")])).toBe(false);
  });

  it("does not take an ellipsized opening for the whole message: the transcript keeps user turns whole", () => {
    const text = "Please inspect the deployment configuration and then apply safe changes";
    expect(transcriptHolds({ ...send, text }, [user("Please inspect the deployment configuration…")])).toBe(false);
    expect(transcriptHolds({ ...send, text }, [user("Please inspect the deployment configuration...")])).toBe(false);
  });

  it("gives a command no waiting line: Claude writes it as a command, never as this user turn", () => {
    const key = waitingKey("local", "commands");
    try {
      for (const command of ["/cost", "  /model sonnet", "! ls"]) rememberWaitingSend(key, command, 1);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("settles a send from a browser whose clock runs ahead of the PC, by the turns the chat held when it was sent", () => {
    const key = waitingKey("local", "clock-ahead");
    const pc = Date.parse("2026-10-29T10:00:00Z");
    try {
      const earlier = user("earlier", pc);
      // the phone's clock is a minute ahead of the PC that writes the transcript
      settleWaitingSends(key, [earlier], pc + 60_000 + 200);
      rememberWaitingSend(key, "hello", pc + 60_000 + 500, waitingBaseline(key));
      settleWaitingSends(key, [earlier, user("hello", pc + 800)], pc + 60_000 + 900);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps a repeated send waiting past the identical turn the chat held when it was sent, whatever the browser's clock", () => {
    const key = waitingKey("local", "clock-behind");
    const pc = Date.parse("2026-10-29T10:00:00Z");
    try {
      const earlier = user("repeat", pc);
      // a browser clock a minute behind would take the old turn for the new one
      settleWaitingSends(key, [earlier], pc - 60_000 + 200);
      rememberWaitingSend(key, "repeat", pc - 60_000 + 500, waitingBaseline(key));
      settleWaitingSends(key, [earlier], pc - 60_000 + 700);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["repeat"]);
      settleWaitingSends(key, [earlier, user("repeat", pc + 5_000)]);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps a second send's own waiting line without overwriting the first", () => {
    const key = waitingKey("local", "two-sends");
    try {
      rememberWaitingSend(key, "first message", 1);
      rememberWaitingSend(key, "second message", 2);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["first message", "second message"]);
      const firstTurn = user("first message", 3);
      settleWaitingSends(key, [firstTurn]);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["second message"]);
      settleWaitingSends(key, [firstTurn, user("second message", 4)]);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("one turn settles only one of two identical sends, even across refreshes", () => {
    const key = waitingKey("local", "identical-sends");
    try {
      rememberWaitingSend(key, "repeat", 1);
      rememberWaitingSend(key, "repeat", 1);
      const original = currentWaitingSends(key);
      const firstTurn = user("repeat", 3);
      settleWaitingSends(key, [firstTurn]);
      expect(currentWaitingSends(key)).toEqual([original[1]!]);
      settleWaitingSends(key, [firstTurn]);
      expect(currentWaitingSends(key)).toEqual([original[1]!]);
      settleWaitingSends(key, [firstTurn, user("repeat", 4)]);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps a send with no transcript turn and settles it when its delayed turn appears", () => {
    const key = waitingKey("local", "delayed-send");
    try {
      rememberWaitingSend(key, "delayed", 1);
      const before = currentWaitingSends(key);
      settleWaitingSends(key, []);
      expect(currentWaitingSends(key)).toBe(before);
      expect(currentWaitingSends(key)).toHaveLength(1);
      settleWaitingSends(key, [user("delayed", 10_000)]);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("never treats an undated or invalidly dated turn as evidence for a new send", () => {
    expect(transcriptHolds(send, [{ ...user(send.text), ts: null }])).toBe(false);
    expect(transcriptHolds(send, [{ ...user(send.text), ts: "invalid" }])).toBe(false);
    expect(transcriptHolds({ ...send, text: "Please review the complete implementation and report issues", at: 10 }, [user("Please review the complete implementation…", 9)])).toBe(false);
  });

  it("keeps a send waiting past an identical turn written before it that the chat had not shown yet", () => {
    const key = waitingKey("local", "refresh-lag");
    try {
      // the chat last showed a turn at 1000, read at 1500; "repeat" was written at 2037 and sent again at 3000
      settleWaitingSends(key, [user("earlier", 1000)], 1500);
      rememberWaitingSend(key, "repeat", 3000, waitingBaseline(key));
      settleWaitingSends(key, [user("earlier", 1000), user("repeat", 2037)], 3200);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["repeat"]);
      settleWaitingSends(key, [user("earlier", 1000), user("repeat", 2037), user("repeat", 3500)], 3600);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("waits for the text that was typed: paste markers the composer strips are not part of it", () => {
    const key = waitingKey("local", "paste-markers");
    try {
      rememberWaitingSend(key, "\u001b[200~/cost\u001b[201~", 1);
      expect(currentWaitingSends(key)).toEqual([]);
      rememberWaitingSend(key, "hello\u001b[201~", 1);
      settleWaitingSends(key, [user("hello", 2)]);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("stops saying a send is on its way once its turn has not come for a minute", () => {
    const key = waitingKey("local", "expired");
    try {
      rememberWaitingSend(key, "interrupted in the terminal", 1_000);
      expireWaitingSends(key, 1_000 + WAITING_SEND_MS - 1);
      expect(currentWaitingSends(key)).toHaveLength(1);
      expireWaitingSends(key, 1_000 + WAITING_SEND_MS);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("lets a replaced herdr's waiting sends go: the new herdr gives the same pane ids to other panes", () => {
    const roster = (lifetime: string) => [{ id: "local", snapshot: { panes: [], herdr_lifetime: lifetime } } as unknown as Machine];
    const key = waitingKey("local", "w1:p1");
    try {
      paneLifetimes.observe(roster("waiting-herdr-a"), (item) => item.pane_id);
      rememberWaitingSend(key, "deploy it", Date.now());
      paneLifetimes.observe(roster("waiting-herdr-b"), (item) => item.pane_id);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("bounds an unshown earlier turn by the newest turn the chat showed, the agent's included", () => {
    const key = waitingKey("local", "assistant-latest");
    try {
      // the chat showed a user turn at 1000 and the agent's answer at 100000, read at 101000;
      // "yes" was typed in the terminal at 150123, then sent from Chat at 151123
      const shownTurns = [user("earlier", 1_000), { ...assistant("answer"), ts: new Date(100_000).toISOString() }];
      settleWaitingSends(key, shownTurns, 101_000, true);
      rememberWaitingSend(key, "yes", 151_123, waitingBaseline(key));
      settleWaitingSends(key, [...shownTurns, user("yes", 150_123)], 152_000, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["yes"]);
      settleWaitingSends(key, [...shownTurns, user("yes", 150_123), user("yes", 151_500)], 153_000, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("settles the first message of an empty chat whatever the browser's clock says", () => {
    const key = waitingKey("local", "empty-chat");
    const pc = Date.parse("2026-10-29T10:00:00Z");
    try {
      // the chat has loaded and holds no turns; the phone runs a minute ahead of the PC
      settleWaitingSends(key, [], pc + 60_000, true);
      rememberWaitingSend(key, "first", pc + 60_500, waitingBaseline(key));
      settleWaitingSends(key, [user("first", pc + 900)], pc + 61_000, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps the time the chat first showed its turns: settling again for the waiting list is no new read", () => {
    const key = waitingKey("local", "unchanged-read");
    try {
      settleWaitingSends(key, [user("earlier", 1_000)], 1_500, true);
      rememberWaitingSend(key, "first follow-up", 3_000, waitingBaseline(key));
      // the waiting list changed, the transcript did not
      settleWaitingSends(key, [user("earlier", 1_000)], 3_200, true);
      rememberWaitingSend(key, "repeat", 3_300, waitingBaseline(key));
      settleWaitingSends(key, [user("earlier", 1_000), user("repeat", 2_037)], 3_400, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["first follow-up", "repeat"]);
    } finally { forgetWaitingSends(key); }
  });

  it("settles a send by its own turn when the transcript keeps whole seconds", () => {
    const key = waitingKey("local", "whole-seconds");
    try {
      settleWaitingSends(key, [user("earlier", 1_000)], 1_500, true);
      rememberWaitingSend(key, "next", 2_500, waitingBaseline(key));
      // written at 2600, kept as 2000
      settleWaitingSends(key, [user("earlier", 1_000), user("next", 2_000)], 2_700, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("settles a whole-second turn for a send made before the chat's first read on the turn itself when nothing was written after it", () => {
    const key = waitingKey("local", "whole-seconds-first-read");
    const second = Date.parse("2026-10-29T10:00:02Z");
    try {
      rememberWaitingSend(key, "next", second + 500, waitingBaseline(key));
      // the agent took it and has written nothing since: no later turn ever comes to settle it
      settleWaitingSends(key, [user("earlier", second - 60_000), user("next", second)], second + 800, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps a send made before the chat's first read waiting past a same-second turn with an undated turn after it", () => {
    const key = waitingKey("local", "whole-seconds-first-read-undated");
    const second = Date.parse("2026-10-29T10:00:02Z");
    try {
      rememberWaitingSend(key, "next", second + 500, waitingBaseline(key));
      // an answer with no time is still an answer: the user turn before it may be an older message's
      settleWaitingSends(key, [user("next", second), { ...assistant("ok"), ts: null }], second + 800, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["next"]);
    } finally { forgetWaitingSends(key); }
  });

  it("settles a whole-second turn for a send made before the chat's first read once a turn after it is in a later second", () => {
    const key = waitingKey("local", "whole-seconds-first-read-answered");
    const second = Date.parse("2026-10-29T10:00:02Z");
    const sameSecond = { ...assistant("done"), ts: new Date(second).toISOString() };
    const later = { ...assistant("more"), ts: new Date(second + 1_000).toISOString() };
    try {
      rememberWaitingSend(key, "next", second + 500, waitingBaseline(key));
      // answered within its own second: an older message of that second, answered before the send, reads the same
      settleWaitingSends(key, [user("next", second), sameSecond], second + 800, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["next"]);
      settleWaitingSends(key, [user("next", second), sameSecond, later], second + 1_400, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps a new send waiting before the first read when only an older identical turn of the same second is there", () => {
    const key = waitingKey("local", "unread-second-send");
    const second = Date.parse("2026-10-29T10:00:02Z");
    // "repeat" came from the terminal at 02.100 and was answered before this browser sent it again at 02.700
    const older = [user("repeat", second), { ...assistant("ok"), ts: new Date(second).toISOString() }];
    try {
      rememberWaitingSend(key, "repeat", second + 700, waitingBaseline(key));
      settleWaitingSends(key, older, second + 800, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["repeat"]);
      settleWaitingSends(key, [...older, user("repeat", second), { ...assistant("ok"), ts: new Date(second + 1_000).toISOString() }], second + 1_400, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("drops every waiting send of a PC whose connection went, and only that PC's", () => {
    const here = waitingKey("local", "w1:p1"), other = waitingKey("local", "w2:p1"), away = waitingKey("remote", "w1:p1");
    try {
      for (const key of [here, other, away]) rememberWaitingSend(key, "deploy it", Date.now());
      forgetMachineWaitingSends("local");
      expect([currentWaitingSends(here), currentWaitingSends(other), currentWaitingSends(away).length]).toEqual([[], [], 1]);
    } finally { for (const key of [here, other, away]) forgetWaitingSends(key); }
  });

  it("records no baseline for a chat that has not read its transcript", () => {
    const key = waitingKey("local", "unread");
    try {
      settleWaitingSends(key, [], 1_000, false);
      expect(waitingBaseline(key)).toBeNull();
    } finally { forgetWaitingSends(key); }
  });
});
