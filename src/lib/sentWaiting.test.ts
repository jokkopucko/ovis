import { describe, expect, it } from "bun:test";

import { clearMachineWaitingSends, currentWaitingSends, dismissWaitingSend, forgetMachineWaitingSends, forgetWaitingBaseline, forgetWaitingSends, expireWaitingSends, markUnanswered, observeWaitingClock, pruneWaitingSends, rememberWaitingSend, restingSince, settleWaitingSends, stampedBaseline, WAITING_SEND_MS, WAITING_STUCK_MS, waitingBaseline, waitingKey } from "./sentWaiting.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";
import type { Machine } from "../../shared/machines.ts";
import { paneLifetimes } from "./paneLifetime.ts";

const user = (text: string, at = 2): ConversationTurn => ({ role: "user", ts: new Date(at).toISOString(), parts: [{ kind: "text", text }] });
const assistant = (text: string): ConversationTurn => ({ ...user(text), role: "assistant" });

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
      settleWaitingSends(key, [user("earlier", 1000)], 1500);
      rememberWaitingSend(key, "repeat", 3000, waitingBaseline(key));
      settleWaitingSends(key, [user("earlier", 1000), user("repeat", 2037)], 3200);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["repeat"]);
      settleWaitingSends(key, [user("earlier", 1000), user("repeat", 2037), user("repeat", 3500)], 3600);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps a send waiting past an identical turn another device wrote just before it, though the chat read its turns long after the newest", () => {
    const key = waitingKey("local", "other-device");
    const pc = Date.parse("2026-11-05T10:00:00Z");
    try {
      const earlier = user("earlier", pc + 37);
      settleWaitingSends(key, [earlier], pc + 12_100, true);
      observeWaitingClock(key, new Date(pc + 10_037).toISOString(), 100);
      rememberWaitingSend(key, "repeat", pc + 14_500, waitingBaseline(key, 2_500));
      settleWaitingSends(key, [earlier, user("repeat", pc + 11_037)], pc + 15_000, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["repeat"]);
      settleWaitingSends(key, [earlier, user("repeat", pc + 11_037), user("repeat", pc + 12_800)], pc + 15_200, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("bounds an idle chat's send by its last read, a 304 from a bridge upgraded since its turns were read too", () => {
    const key = waitingKey("local", "idle-chat");
    const pc = Date.parse("2026-11-05T10:00:00Z");
    try {
      const earlier = user("earlier", pc + 37);
      settleWaitingSends(key, [earlier], pc + 602_100, true);
      observeWaitingClock(key, undefined, 0);
      observeWaitingClock(key, new Date(pc + 1_200_000).toISOString(), 600_050);
      rememberWaitingSend(key, "same words", pc + 1_207_000, waitingBaseline(key, 605_000));
      settleWaitingSends(key, [earlier, user("same words", pc + 1_204_700)], pc + 1_207_300, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["same words"]);
      settleWaitingSends(key, [earlier, user("same words", pc + 1_204_700), user("same words", pc + 1_205_200)], pc + 1_207_500, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps the clock of the answer that arrived last, though an older read's body was parsed after it", () => {
    const key = waitingKey("local", "late-body");
    const pc = Date.parse("2026-11-05T10:00:00Z");
    try {
      settleWaitingSends(key, [], pc, true);
      observeWaitingClock(key, new Date(pc).toISOString(), 300);
      observeWaitingClock(key, new Date(pc + 10_000).toISOString(), 200);
      rememberWaitingSend(key, "after the correction", pc + 500, waitingBaseline(key, 500));
      settleWaitingSends(key, [user("after the correction", pc + 301)], pc + 700, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("counts a sleep the monotonic clock missed: another device's identical turn during it is not this send's", () => {
    const key = waitingKey("local", "slept");
    const pc = Date.parse("2026-11-05T10:00:00Z");
    try {
      settleWaitingSends(key, [], pc, true);
      observeWaitingClock(key, new Date(pc).toISOString(), 1_000, pc);
      rememberWaitingSend(key, "repeat", pc + 3_600_000, waitingBaseline(key, 2_000, pc + 3_600_000));
      settleWaitingSends(key, [user("repeat", pc + 3_590_000)], pc + 3_600_300, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["repeat"]);
      settleWaitingSends(key, [user("repeat", pc + 3_590_000), user("repeat", pc + 3_600_200)], pc + 3_600_500, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("allows for the two clocks drifting apart since the chat's last read", () => {
    const key = waitingKey("local", "clock-drift");
    const pc = Date.parse("2026-11-05T10:00:00Z");
    try {
      const earlier = user("earlier", pc + 37);
      settleWaitingSends(key, [earlier], pc + 600_000, true);
      observeWaitingClock(key, new Date(pc + 600_000).toISOString(), 0);
      rememberWaitingSend(key, "an hour later", pc + 4_200_000, waitingBaseline(key, 3_600_000));
      settleWaitingSends(key, [earlier, user("an hour later", pc + 4_199_900)], pc + 4_200_300, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("settles an immediate send by the PC's stamp though the PC's clock was set back since the chat's last read", () => {
    const key = waitingKey("local", "pc-set-back");
    const pc = Date.parse("2026-11-05T10:00:00Z");
    try {
      const earlier = user("earlier", pc + 37);
      settleWaitingSends(key, [earlier], pc + 10_100, true);
      observeWaitingClock(key, new Date(pc + 10_037).toISOString(), 100);
      const sent = stampedBaseline(waitingBaseline(key, 2_100), new Date(pc - 17_963).toISOString(), pc + 12_100);
      rememberWaitingSend(key, "after the correction", pc + 12_100, sent);
      settleWaitingSends(key, [earlier, user("after the correction", pc - 17_800)], pc + 12_400, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps an immediate send past an identical turn written just before it an hour after the chat's last read", () => {
    const key = waitingKey("local", "stamped-late");
    const pc = Date.parse("2026-11-05T10:00:00Z");
    try {
      const earlier = user("earlier", pc + 37);
      settleWaitingSends(key, [earlier], pc + 600_000, true);
      observeWaitingClock(key, new Date(pc + 600_000).toISOString(), 0);
      const sent = stampedBaseline(waitingBaseline(key, 3_600_000), new Date(pc + 4_199_037).toISOString(), pc + 4_200_000);
      rememberWaitingSend(key, "repeat", pc + 4_200_000, sent);
      settleWaitingSends(key, [earlier, user("repeat", pc + 4_198_037)], pc + 4_200_300, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["repeat"]);
      settleWaitingSends(key, [earlier, user("repeat", pc + 4_198_037), user("repeat", pc + 4_199_237)], pc + 4_200_500, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("settles a send by its own turn though this browser's wall clock stepped since the chat's read", () => {
    const key = waitingKey("local", "clock-step");
    const pc = Date.parse("2026-11-05T10:00:00Z");
    try {
      const earlier = user("earlier", pc + 37);
      settleWaitingSends(key, [earlier], pc + 10_100, true);
      observeWaitingClock(key, new Date(pc + 10_037).toISOString(), 100);
      rememberWaitingSend(key, "after the step", pc + 13_500, waitingBaseline(key, 2_500));
      settleWaitingSends(key, [earlier, user("after the step", pc + 12_600)], pc + 13_700, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("bounds an empty chat's read by the PC's clock too: another device's identical first message is not this send's", () => {
    const key = waitingKey("local", "other-device-empty");
    const pc = Date.parse("2026-11-05T10:00:00Z");
    try {
      settleWaitingSends(key, [], pc + 60_100, true);
      observeWaitingClock(key, new Date(pc + 37).toISOString(), 0);
      rememberWaitingSend(key, "first", pc + 68_000, waitingBaseline(key, 7_963));
      settleWaitingSends(key, [user("first", pc + 5_037)], pc + 68_500, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["first"]);
      settleWaitingSends(key, [user("first", pc + 5_037), user("first", pc + 8_300)], pc + 68_900, true);
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

  const readAt = (key: string, turns: ConversationTurn[], at: number) => {
    observeWaitingClock(key, new Date(at).toISOString(), 0, at);
    settleWaitingSends(key, turns, at, true);
  };

  it("says a send unanswered a minute on, the agent at rest and the chat read since, and keeps it", () => {
    const key = waitingKey("local", "unanswered");
    const earlier = user("earlier", 500);
    try {
      readAt(key, [earlier], 900);
      rememberWaitingSend(key, "the turn the agent failed before writing it", 1_000);
      markUnanswered(key, 1_000 + WAITING_SEND_MS);
      expect(currentWaitingSends(key).map((send) => send.unanswered)).toEqual([undefined]);
      restingSince(key, 1_000 + WAITING_SEND_MS);
      markUnanswered(key, 1_000 + WAITING_SEND_MS + 1);
      expect(currentWaitingSends(key).map((send) => send.unanswered)).toEqual([undefined]);
      readAt(key, [earlier], 1_000 + WAITING_SEND_MS + 2);
      markUnanswered(key, 1_000 + WAITING_SEND_MS + 3);
      expect(currentWaitingSends(key).map((send) => [send.text, send.unanswered])).toEqual([["the turn the agent failed before writing it", true]]);
      readAt(key, [earlier, user("the turn the agent failed before writing it", 1_000 + WAITING_SEND_MS + 5)], 1_000 + WAITING_SEND_MS + 10);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("counts an unchanged read (a 304) as a read since the agent came to rest", async () => {
    const key = waitingKey("local", "unchanged-read");
    try {
      readAt(key, [user("earlier", 500)], 900);
      rememberWaitingSend(key, "never recorded", 1_000);
      restingSince(key, 1_000 + WAITING_SEND_MS);
      observeWaitingClock(key, new Date(1_000 + WAITING_SEND_MS + 5).toISOString(), 0, Date.now(), true);
      await Promise.resolve();
      expect(currentWaitingSends(key).map((send) => send.unanswered)).toEqual([true]);
    } finally { forgetWaitingSends(key); }
  });

  it("judges a send by the turns of the read that came at rest, once the chat holds them, not by the read before", async () => {
    const key = waitingKey("local", "production-order");
    try {
      readAt(key, [user("earlier", 500)], 900);
      rememberWaitingSend(key, "the turn", 1_000);
      restingSince(key, 1_500);
      observeWaitingClock(key, new Date(1_000 + WAITING_SEND_MS).toISOString(), 0, 1_000 + WAITING_SEND_MS);
      await Promise.resolve();
      expect(currentWaitingSends(key).map((send) => send.unanswered)).toEqual([undefined]);
      settleWaitingSends(key, [user("earlier", 500), user("the turn, reworded", 2_000)], 1_000 + WAITING_SEND_MS, true);
      await Promise.resolve();
      expect(currentWaitingSends(key)).toEqual([]);
      rememberWaitingSend(key, "another", 1_000 + WAITING_SEND_MS + 1);
      restingSince(key, null);
      restingSince(key, 1_000 + 2 * WAITING_SEND_MS);
      settleWaitingSends(key, [user("earlier", 500), user("the turn, reworded", 2_000)], 1_000 + 3 * WAITING_SEND_MS, true);
      markUnanswered(key, 1_000 + 3 * WAITING_SEND_MS);
      expect(currentWaitingSends(key).map((send) => send.unanswered)).toEqual([undefined]);
    } finally { forgetWaitingSends(key); }
  });

  it("takes no other send's own turn for the one an earlier send never got", () => {
    const key = waitingKey("local", "claimed");
    try {
      readAt(key, [user("earlier", 500)], 900);
      rememberWaitingSend(key, "failed first", 1_000);
      rememberWaitingSend(key, "answered second", 1_100);
      restingSince(key, 1_500);
      readAt(key, [user("earlier", 500), user("answered second", 1_200)], 1_000 + WAITING_SEND_MS);
      markUnanswered(key, 1_000 + WAITING_SEND_MS + 1);
      expect(currentWaitingSends(key).map((send) => [send.text, send.unanswered])).toEqual([["failed first", true]]);
    } finally { forgetWaitingSends(key); }
  });

  it("gives the same words sent again after one went unanswered their own turn, and keeps the first said unanswered", () => {
    const key = waitingKey("local", "resent");
    const earlier = assistant("earlier");
    try {
      readAt(key, [earlier], 900);
      rememberWaitingSend(key, "fix the bug", 1_000, waitingBaseline(key, 0, 1_000));
      restingSince(key, 1_500);
      readAt(key, [earlier], 1_000 + WAITING_SEND_MS);
      markUnanswered(key, 1_000 + WAITING_SEND_MS + 1);
      const again = 1_000 + 2 * WAITING_SEND_MS;
      restingSince(key, null);
      rememberWaitingSend(key, "fix the bug", again, waitingBaseline(key, 0, again));
      const answered = [earlier, user("fix the bug", again + 100), { ...user("fixed", again + 200), role: "assistant" as const }];
      readAt(key, answered, again + 300);
      expect(currentWaitingSends(key).map((send) => [send.at, send.unanswered])).toEqual([[1_000, true]]);
      restingSince(key, again + 400);
      readAt(key, answered, again + WAITING_SEND_MS + 500);
      markUnanswered(key, again + WAITING_SEND_MS + 501);
      expect(currentWaitingSends(key).map((send) => [send.at, send.unanswered])).toEqual([[1_000, true]]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps a send on its way while the agent rests, past the long while, until a read says what became of it", () => {
    const key = waitingKey("local", "reopened");
    try {
      readAt(key, [assistant("earlier")], 900);
      rememberWaitingSend(key, "sent, then the chat was closed", 1_000);
      const reopened = 1_000 + WAITING_STUCK_MS + 5 * 60_000;
      restingSince(key, reopened);
      markUnanswered(key, reopened);
      expireWaitingSends(key, reopened);
      expect(currentWaitingSends(key).map((send) => send.unanswered)).toEqual([undefined]);
      readAt(key, [assistant("earlier")], reopened + 1);
      markUnanswered(key, reopened + 2);
      expect(currentWaitingSends(key).map((send) => [send.text, send.unanswered])).toEqual([["sent, then the chat was closed", true]]);
    } finally { forgetWaitingSends(key); }
  });

  it("lets a send go, not unanswered, when the agent wrote a turn for it the chat does not match", () => {
    for (const written of [user("the turn, as the agent rewrote it", 2_000), { ...user("the turn"), ts: null }]) {
      const key = waitingKey("local", "rewritten");
      try {
        readAt(key, [user("earlier", 500)], 900);
        rememberWaitingSend(key, "the turn", 1_000);
        restingSince(key, 1_500);
        readAt(key, [user("earlier", 500), written], 1_000 + WAITING_SEND_MS);
        markUnanswered(key, 1_000 + WAITING_SEND_MS + 1);
        expect(currentWaitingSends(key)).toEqual([]);
      } finally { forgetWaitingSends(key); }
    }
  });

  it("lets a send still on its way go after a long while, the agent never at rest", () => {
    const key = waitingKey("local", "stuck");
    try {
      rememberWaitingSend(key, "sent while it works", 1_000);
      expireWaitingSends(key, 1_000 + WAITING_STUCK_MS - 1);
      expect(currentWaitingSends(key)).toHaveLength(1);
      expireWaitingSends(key, 1_000 + WAITING_STUCK_MS);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  const unanswered = (api: typeof import("./sentWaiting.ts"), machine: string, key: string, text: string, at: number) => {
    paneLifetimes.observe([{ id: machine, snapshot: { panes: [], herdr_lifetime: `${machine}-herdr` } } as unknown as Machine], (item) => item.pane_id);
    api.settleWaitingSends(key, [], at - 1, true);
    api.rememberWaitingSend(key, text, at);
    api.restingSince(key, at + 1);
    api.observeWaitingClock(key, new Date(at + WAITING_SEND_MS).toISOString(), 0, at + WAITING_SEND_MS);
    api.settleWaitingSends(key, [], at + WAITING_SEND_MS, true);
    api.markUnanswered(key, at + WAITING_SEND_MS + 1);
  };

  it("keeps an unanswered send through a lost connection, and lets it go once the user dismisses it", async () => {
    const machine = "unanswered-pc";
    const key = waitingKey(machine, "kept");
    try {
      unanswered(await import("./sentWaiting.ts"), machine, key, "first", 1_000);
      rememberWaitingSend(key, "second", 1_000 + WAITING_SEND_MS);
      clearMachineWaitingSends(machine);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["first"]);
      dismissWaitingSend(key, currentWaitingSends(key)[0]!.id);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("reads this tab's unanswered sends back after a reload, under the herdr they were kept under only", async () => {
    const items = new Map<string, string>();
    const store = { getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => { items.set(name, value); }, removeItem: (name: string) => { items.delete(name); } };
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: store });
    const load = (page: string): Promise<typeof import("./sentWaiting.ts")> => import(`./sentWaiting.ts?${page}`);
    try {
      const before = await load("before-reload");
      const now = Date.now();
      const same = before.waitingKey("reload-same", "w1:p1");
      const replaced = before.waitingKey("reload-replaced", "w1:p1");
      unanswered(before, "reload-same", same, "lost on reload before", now - WAITING_SEND_MS);
      unanswered(before, "reload-replaced", replaced, "said to another herdr's pane", now - WAITING_SEND_MS);
      before.rememberWaitingSend(same, "still on its way", now);
      paneLifetimes.observe([{ id: "reload-replaced", snapshot: { panes: [], herdr_lifetime: "a-new-herdr" } } as unknown as Machine], (item) => item.pane_id);
      const after = await load("after-reload");
      expect(after.currentWaitingSends(same).map((send) => [send.text, send.unanswered])).toEqual([["lost on reload before", true]]);
      expect(after.currentWaitingSends(replaced)).toEqual([]);
      after.dismissWaitingSend(same, after.currentWaitingSends(same)[0]!.id);
      expect(items.size).toBe(0);
    } finally { Reflect.deleteProperty(globalThis, "sessionStorage"); }
  });

  const openTab = () => {
    const items = new Map<string, string>();
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => { items.set(name, value); }, removeItem: (name: string) => { items.delete(name); } } });
    return { items, load: (page: string): Promise<typeof import("./sentWaiting.ts")> => import(`./sentWaiting.ts?${page}`) };
  };
  const readOn = (api: typeof import("./sentWaiting.ts"), key: string, turns: ConversationTurn[], at: number) => {
    api.observeWaitingClock(key, new Date(at).toISOString(), 0, at);
    api.settleWaitingSends(key, turns, at, true);
  };

  it("matches an unanswered send after a reload to no turn it would not have taken before", async () => {
    const tab = openTab();
    try {
      const before = await tab.load("kept-turns-before");
      paneLifetimes.observe([{ id: "kept-turns", snapshot: { panes: [], herdr_lifetime: "kept-turns-herdr" } } as unknown as Machine], (item) => item.pane_id);
      const sent = Date.now() - 10 * WAITING_SEND_MS;
      const taken = before.waitingKey("kept-turns", "taken");
      const takenTurns = [assistant("earlier"), user("yes", sent + 200)];
      readOn(before, taken, [assistant("earlier")], sent - 50);
      before.rememberWaitingSend(taken, "yes", sent, before.waitingBaseline(taken, 0, sent));
      before.rememberWaitingSend(taken, "yes", sent + 100, before.waitingBaseline(taken, 0, sent + 100));
      before.restingSince(taken, sent + 300);
      readOn(before, taken, takenTurns, sent + WAITING_SEND_MS + 100);
      before.markUnanswered(taken, sent + WAITING_SEND_MS + 101);
      const held = before.waitingKey("kept-turns", "held");
      const heldTurns = [user("go", sent + 3_000), assistant("ok")];
      readOn(before, held, heldTurns, sent);
      before.rememberWaitingSend(held, "go", sent + 10, before.waitingBaseline(held, 0, sent + 10));
      before.restingSince(held, sent + 20);
      readOn(before, held, heldTurns, sent + WAITING_SEND_MS + 100);
      before.markUnanswered(held, sent + WAITING_SEND_MS + 101);
      const after = await tab.load("kept-turns-after");
      after.currentWaitingSends(taken);
      after.currentWaitingSends(held);
      readOn(after, taken, takenTurns, sent + WAITING_SEND_MS + 500);
      readOn(after, held, heldTurns, sent + WAITING_SEND_MS + 500);
      expect(after.currentWaitingSends(taken).map((send) => [send.text, send.unanswered])).toEqual([["yes", true]]);
      expect(after.currentWaitingSends(held).map((send) => [send.text, send.unanswered])).toEqual([["go", true]]);
    } finally { Reflect.deleteProperty(globalThis, "sessionStorage"); }
  });

  it("keeps the sends read back after a reload through a lost connection, before the page knows the PC's herdr", async () => {
    const tab = openTab();
    const machine = "kept-offline";
    try {
      const before = await tab.load("kept-offline-before");
      const key = before.waitingKey(machine, "w1:p1");
      unanswered(before, machine, key, "said before the reload", Date.now() - WAITING_SEND_MS);
      const kept = new Map(tab.items);
      paneLifetimes.observe([{ id: machine, snapshot: { panes: [] } } as unknown as Machine], (item) => item.pane_id);
      for (const [name, value] of kept) tab.items.set(name, value);
      const after = await tab.load("kept-offline-after");
      expect(after.currentWaitingSends(key)).toEqual([]);
      after.settleWaitingSends(key, [], Date.now(), true);
      after.clearMachineWaitingSends(machine);
      paneLifetimes.observe([{ id: machine, snapshot: { panes: [], herdr_lifetime: `${machine}-herdr` } } as unknown as Machine], (item) => item.pane_id);
      expect(after.currentWaitingSends(key).map((send) => [send.text, send.unanswered])).toEqual([["said before the reload", true]]);
    } finally { Reflect.deleteProperty(globalThis, "sessionStorage"); }
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
      settleWaitingSends(key, [user("earlier", 1_000), user("next", 2_000)], 2_700, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("settles a whole-second turn for a send made before the chat's first read on the turn itself when nothing was written after it", () => {
    const key = waitingKey("local", "whole-seconds-first-read");
    const second = Date.parse("2026-10-29T10:00:02Z");
    try {
      rememberWaitingSend(key, "next", second + 500, waitingBaseline(key));
      settleWaitingSends(key, [user("earlier", second - 60_000), user("next", second)], second + 800, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps a send made before the chat's first read waiting past a same-second turn with an undated turn after it", () => {
    const key = waitingKey("local", "whole-seconds-first-read-undated");
    const second = Date.parse("2026-10-29T10:00:02Z");
    try {
      rememberWaitingSend(key, "next", second + 500, waitingBaseline(key));
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
      settleWaitingSends(key, [user("next", second), sameSecond], second + 800, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["next"]);
      settleWaitingSends(key, [user("next", second), sameSecond, later], second + 1_400, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps a new send waiting before the first read when only an older identical turn of the same second is there", () => {
    const key = waitingKey("local", "unread-second-send");
    const second = Date.parse("2026-10-29T10:00:02Z");
    const older = [user("repeat", second), { ...assistant("ok"), ts: new Date(second).toISOString() }];
    try {
      rememberWaitingSend(key, "repeat", second + 700, waitingBaseline(key));
      settleWaitingSends(key, older, second + 800, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["repeat"]);
      settleWaitingSends(key, [...older, user("repeat", second), { ...assistant("ok"), ts: new Date(second + 1_000).toISOString() }], second + 1_400, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("keeps a send the PC stamped before the chat's first read waiting past an older identical turn of the stamp's second", () => {
    const key = waitingKey("local", "unread-second-stamped");
    const second = Date.parse("2026-10-29T10:00:02Z");
    const older = [user("repeat", second), { ...assistant("ok"), ts: new Date(second).toISOString() }];
    try {
      rememberWaitingSend(key, "repeat", second + 700, stampedBaseline(waitingBaseline(key), new Date(second + 700).toISOString(), second + 700));
      settleWaitingSends(key, older, second + 800, true);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["repeat"]);
      settleWaitingSends(key, [...older, user("repeat", second), { ...assistant("ok"), ts: new Date(second + 1_000).toISOString() }], second + 1_400, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { forgetWaitingSends(key); }
  });

  it("settles a stamped send after the chat's read by its own whole-second turn though the answer began in that second", () => {
    const key = waitingKey("local", "read-second-stamped");
    const second = Date.parse("2026-10-29T10:00:02Z");
    const earlier = user("earlier", second - 60_000);
    try {
      settleWaitingSends(key, [earlier], second, true);
      // stamped at 02.400, written at 02.600 and answered from 02.800: Grok keeps both as 02
      rememberWaitingSend(key, "next", second + 400, stampedBaseline(waitingBaseline(key), new Date(second + 400).toISOString(), second + 400));
      settleWaitingSends(key, [earlier, user("next", second), { ...assistant("ok"), ts: new Date(second).toISOString() }], second + 900, true);
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

  it("connection cleanup clears that PC's waiting copies while retaining loaded transcript baselines", () => {
    const here = waitingKey("cleanup-PC", "cleanup-owner"), other = waitingKey("cleanup-PC", "cleanup-sibling"), away = waitingKey("cleanup-away", "cleanup-owner");
    const keys = [here, other, away];
    paneLifetimes.observe(["cleanup-PC", "cleanup-away"].map((id) => ({ id, snapshot: { panes: [], herdr_lifetime: `${id}-herdr` } } as unknown as Machine)));
    try {
      for (const key of keys) {
        settleWaitingSends(key, [user("earlier", 1)], 10, true);
        rememberWaitingSend(key, "next", 20, waitingBaseline(key));
      }
      const baselines = keys.map((key) => waitingBaseline(key));
      clearMachineWaitingSends("cleanup-PC");
      expect(keys.map((key) => currentWaitingSends(key).length)).toEqual([0, 0, 1]);
      for (const [index, key] of keys.entries()) expect(waitingBaseline(key)).toEqual(baselines[index]!);
      // A replaced Herdr must still forget those baselines before its pane IDs are reused.
      forgetMachineWaitingSends("cleanup-PC");
      expect(keys.map((key) => waitingBaseline(key) === null)).toEqual([true, true, false]);
    } finally { for (const key of keys) forgetWaitingSends(key); }
  });

  it("prunes only panes proved closed by a connected PC's fresh snapshot", () => {
    const keys = [waitingKey("local", "closed"), waitingKey("local", "active"), waitingKey("local", "sibling"), waitingKey("remote", "closed"), waitingKey("local", "not-listed-yet")];
    const roster = (state: Machine["state"], snapshot: Machine["snapshot"]) => [{ id: "local", state, snapshot } as Machine];
    const snapshot = { panes: [{ pane_id: "active" }, { pane_id: "sibling" }] } as Machine["snapshot"];
    try {
      for (const key of keys) {
        settleWaitingSends(key, [user("earlier", 1)], 10, true);
        rememberWaitingSend(key, "next", 20, waitingBaseline(key));
      }
      const baselines = keys.map((key) => waitingBaseline(key));
      pruneWaitingSends(roster("connected", { panes: [{ pane_id: "closed" }, { pane_id: "active" }, { pane_id: "sibling" }] } as Machine["snapshot"]));
      expect(waitingBaseline(keys[4]!)).toEqual(baselines[4]!);
      for (const machines of [[], roster("disconnected", snapshot), roster("connecting", snapshot), roster("reconnecting", snapshot), roster("error", snapshot), roster("connected", null)]) {
        pruneWaitingSends(machines);
        expect(keys.map((key) => waitingBaseline(key))).toEqual(baselines);
        expect(keys.map((key) => currentWaitingSends(key).length)).toEqual([1, 1, 1, 1, 1]);
      }
      pruneWaitingSends(roster("connected", snapshot));
      expect(keys.map((key) => currentWaitingSends(key).length)).toEqual([0, 1, 1, 1, 1]);
      expect(waitingBaseline(keys[0]!)).toBeNull();
      for (const index of [1, 2, 3, 4]) expect(waitingBaseline(keys[index]!)).toEqual(baselines[index]!);
      pruneWaitingSends(roster("connected", { panes: [...snapshot!.panes, { pane_id: "not-listed-yet" }] } as Machine["snapshot"]));
      pruneWaitingSends(roster("connected", snapshot));
      expect(waitingBaseline(keys[4]!)).toBeNull();
      expect(currentWaitingSends(keys[4]!)).toEqual([]);
    } finally { for (const key of keys) forgetWaitingSends(key); }
  });

  it("forgets roster closure evidence when a PC's Herdr is retired", () => {
    const key = waitingKey("retired-PC", "reused");
    const roster = (panes: { pane_id: string }[]) => [{ id: "retired-PC", state: "connected", snapshot: { panes } } as Machine];
    try {
      pruneWaitingSends(roster([{ pane_id: "reused" }]));
      forgetMachineWaitingSends("retired-PC");
      settleWaitingSends(key, [user("new lifetime", 1)], 10, true);
      const baseline = waitingBaseline(key);
      pruneWaitingSends(roster([]));
      expect(waitingBaseline(key)).toEqual(baseline);
    } finally { forgetMachineWaitingSends("retired-PC"); }
  });

  it("a bridge that names no herdr loses its baselines with the connection: a replacement could reuse its pane ids", () => {
    const key = waitingKey("unnamed-PC", "reused");
    paneLifetimes.observe([{ id: "unnamed-PC", snapshot: { panes: [] } } as unknown as Machine]);
    try {
      settleWaitingSends(key, [], 10, true);
      clearMachineWaitingSends("unnamed-PC");
      expect(waitingBaseline(key)).toBeNull();
    } finally { forgetMachineWaitingSends("unnamed-PC"); }
  });

  it("does not prune by a roster read from a herdr the page already left", () => {
    const key = waitingKey("moved-PC", "new-pane");
    const roster = (lifetime: string, panes: { pane_id: string }[]) => [{ id: "moved-PC", state: "connected", snapshot: { panes, herdr_lifetime: lifetime } } as unknown as Machine];
    try {
      paneLifetimes.observe(roster("moved-a", []));
      paneLifetimes.observe(roster("moved-b", [{ pane_id: "new-pane" }]));
      pruneWaitingSends(roster("moved-b", [{ pane_id: "new-pane" }]));
      rememberWaitingSend(key, "still mine", Date.now());
      const stale = roster("moved-a", []);
      paneLifetimes.observe(stale);
      pruneWaitingSends(stale);
      expect(currentWaitingSends(key).map((send) => send.text)).toEqual(["still mine"]);
    } finally { forgetMachineWaitingSends("moved-PC"); }
  });

  it("keeps a chat's baseline while it remounts empty before its read", () => {
    const key = waitingKey("local", "remounted");
    try {
      settleWaitingSends(key, [user("earlier", 1_000)], 3_000, true);
      const baseline = waitingBaseline(key);
      settleWaitingSends(key, [], 9_000, false);
      settleWaitingSends(key, [user("earlier", 1_000)], 9_100, true);
      expect(waitingBaseline(key)).toEqual(baseline);
    } finally { forgetWaitingSends(key); }
  });

  it("forgets a replaced transcript's baseline before the next send", () => {
    const key = waitingKey("local", "replaced"), sibling = waitingKey("local", "retained-sibling");
    const turn = user("repeat", 10_000);
    try {
      for (const pane of [key, sibling]) settleWaitingSends(pane, [turn], 3_000, true);
      const retained = waitingBaseline(sibling);
      forgetWaitingBaseline(key);
      expect(waitingBaseline(key)).toBeNull();
      expect(waitingBaseline(sibling)).toEqual(retained);
      rememberWaitingSend(key, "repeat", 3_100, waitingBaseline(key));
      settleWaitingSends(key, [turn], 3_200, true);
      expect(currentWaitingSends(key)).toEqual([]);
    } finally { for (const pane of [key, sibling]) forgetWaitingSends(pane); }
  });

  it("records no baseline for a chat that has not read its transcript", () => {
    const key = waitingKey("local", "unread");
    try {
      settleWaitingSends(key, [], 1_000, false);
      expect(waitingBaseline(key)).toBeNull();
    } finally { forgetWaitingSends(key); }
  });
});
