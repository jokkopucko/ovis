import { afterEach, describe, expect, it } from "bun:test";

import type { Machine } from "../../shared/machines.ts";
import { MAX_TAB_LABEL_LENGTH } from "../../shared/preferences.ts";
import { autoTabLabel } from "./tabName.ts";
import { forgetTabLabelsForTests, currentTabLabels, shownTabLabels, firstPromptOf, learnFromConversation, learnFromSend, learnTabLabel, setTabLabelLearning, setTabLabels, settleTabLabels, shortTabLabel } from "./tabLabels.ts";

afterEach(forgetTabLabelsForTests);

type Pc = Pick<Machine, "id" | "state" | "snapshot">;
const pc = (id: string, panes: { pane_id: string; terminal_id: string }[], state: Machine["state"] = "connected"): Pc =>
  ({ id, state, snapshot: { panes } } as unknown as Pc);

describe("tab labels from the first message", () => {
  it("keeps a few words of the first line that names something, never the message", () => {
    expect(shortTabLabel("\n  \n  Fix   the\tlogin  \nand more")).toBe("Fix the login");
    expect(shortTabLabel("Fix the login redirect after the session expires")).toBe("Fix the login redirect…");
    expect(shortTabLabel("  \n ")).toBeNull();
    // a slash command, a path or a code fence names nothing: the next line does, or none
    expect(shortTabLabel("/review\nCheck the parser")).toBe("Check the parser");
    expect(shortTabLabel("~/dev/api/main.ts\n```ts\nconst x = 1")).toBe("const x = 1");
    expect(shortTabLabel("/compact")).toBeNull();
    for (const text of ["a".repeat(500), "👩‍💻".repeat(30), "로그인".repeat(40)]) expect(shortTabLabel(text)!.length).toBeLessThanOrEqual(MAX_TAB_LABEL_LENGTH);
  });

  it("leaves attached files' mentions out, an upload's path with spaces included (#2637)", () => {
    const upload = "@/Users/example/Library/Mobile Documents/com~apple~CloudDocs/app/.ovis/paste-20261104-101500-0a1b2c3d.png";
    expect(shortTabLabel(`${upload} Why does the login button overlap?`)).toBe("Why does the login\u2026");
    expect(shortTabLabel(`${upload} @/tmp/shots/b.png @C:\\shots\\c.png Fix the footer`)).toBe("Fix the footer");
    expect(shortTabLabel(`/review ${upload} the footer`)).toBeNull();
    expect(shortTabLabel(`${upload}\nCheck the footer`)).toBe("Check the footer");
    expect(shortTabLabel(upload)).toBeNull();
    // a file named in the message, not attached, says something
    expect(shortTabLabel("Fix @src/app.ts")).toBe("Fix @src/app.ts");
    // an upload's name in the words after another mention is the user's, not the path's
    expect(shortTabLabel("@/tmp/a.png Why paste-20261104-101500-0a1b2c3d.png")).toBe("Why paste-20261104-10150\u2026");
    expect(shortTabLabel("@/tmp/a.png Please inspect /tmp/paste-20261104-101500-0a1b2c3d.png first")).toBe("Please inspect\u2026");
    // nor in a relative path shaped like an upload's (#2682)
    expect(shortTabLabel("@/tmp/a.png Please review docs/paste-20261104-101500-0a1b2c3d.png for me")).toBe("Please review\u2026");
    // a folder whose name holds " @" or " ~" is still the upload's path
    for (const folder of ["Company @ Work", "Company ~ Work"]) expect(shortTabLabel(`@/Users/me/${folder}/.ovis/paste-20261104-101500-0a1b2c3d.png Fix footer`)).toBe("Fix footer");
    // an OVIS_PASTE_DIR with spaces too, and the words before another mention stay
    for (const upload of ["@/My Uploads/paste-20261104-101500-0a1b2c3d.png", "@C:\\My Uploads\\paste-20261104-101500-0a1b2c3d.png", "@/Users/me/John.Doe Files/paste-20261104-101500-0a1b2c3d.png", "@/tmp/v1.2 build/paste-20261104-101500-0a1b2c3d.png"]) expect(shortTabLabel(`${upload} Fix footer`)).toBe("Fix footer");
    expect(shortTabLabel("@/tmp/a.png check @other docs/.ovis/paste-20261104-101500-0a1b2c3d.png now")).toBe("check @other\u2026");
  });

  it("drops a label an earlier version learned from an attachment, and learns the pane's again", () => {
    const panes = [{ pane_id: "w1:p1", terminal_id: "term_a" }];
    setTabLabels({ "w1:p1|term_a": "See @/Users/example/Library/\u2026" });
    learnTabLabel("local", "w1:p1", "@/Users/example/Library/Mobile Documents/.ovis/paste-20261104-101500-0a1b2c3d.png Fix footer");
    settleTabLabels([pc("local", panes)]);
    expect(currentTabLabels()).toEqual({ "w1:p1|term_a": "Fix footer" });
  });

  it("counts a wide character as two columns, and never splits one", () => {
    expect(shortTabLabel("로그인리다이렉트를고쳐주세요세션이만료된뒤에도계속")).toBe("로그인리다이렉트를고쳐주…");
    expect(shortTabLabel("로그인 리다이렉트를 고쳐 주세요")).toBe("로그인 리다이렉트를…");
    expect(shortTabLabel("👩‍💻".repeat(30))).toBe(`${"👩‍💻".repeat(12)}…`);
  });

  it("keys a label to the pane and its terminal once the pane is seen, and learns it once", () => {
    learnTabLabel("local", "w1:p1", "Fix the login");
    learnTabLabel("local", "w1:p1", "Something later");
    expect(currentTabLabels()).toEqual({});
    settleTabLabels([pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p1|term_a": "Fix the login" });
    learnTabLabel("local", "w1:p1", "Another");
    settleTabLabels([pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p1|term_a": "Fix the login" });
  });

  it("never shows an old pane's label on a pane that reuses its id after a restart, and learns the new one's", () => {
    const before = [pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }])];
    const after = [pc("local", [{ pane_id: "w1:p1", terminal_id: "term_b" }])];
    learnTabLabel("local", "w1:p1", "Old session");
    settleTabLabels(before);
    expect(currentTabLabels()).toEqual({ "w1:p1|term_a": "Old session" });
    // herdr restarted: w1:p1 is back, on another terminal. The old label was seen, so it leaves
    settleTabLabels(after);
    expect(currentTabLabels()).toEqual({});
    expect(autoTabLabel({ label: "1", number: 1 }, after[0]!.snapshot!.panes, "local", { "w1:p1|term_a": "Old session" })).toBeNull();
    learnTabLabel("local", "w1:p1", "New session");
    settleTabLabels(after);
    expect(currentTabLabels()).toEqual({ "w1:p1|term_b": "New session" });
  });

  it("drops a label only after seeing its pane and then a connected PC without it", () => {
    // another browser shared it before this page's roster has the pane: it stays
    setTabLabels({ "w1:p9|term_z": "Just shared", "w1:p2|term_b": "Here" });
    settleTabLabels([pc("local", [{ pane_id: "w1:p2", terminal_id: "term_b" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p9|term_z": "Just shared", "w1:p2|term_b": "Here" });
    // the roster catches up, then the pane closes
    settleTabLabels([pc("local", [{ pane_id: "w1:p2", terminal_id: "term_b" }, { pane_id: "w1:p9", terminal_id: "term_z" }])]);
    settleTabLabels([pc("local", [{ pane_id: "w1:p2", terminal_id: "term_b" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p2|term_b": "Here" });
    // a PC that is away drops none
    settleTabLabels([pc("local", [], "disconnected")]);
    expect(currentTabLabels()).toEqual({ "w1:p2|term_b": "Here" });
  });

  it("drops a label seen gone again when a save brings it back, and an old terminal's label blocks no new one", () => {
    const open = [pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }])];
    learnTabLabel("local", "w1:p1", "Closing soon");
    settleTabLabels(open);
    settleTabLabels([pc("local", [])]);
    expect(currentTabLabels()).toEqual({});
    // the answer to the save that carried it lands after the pane closed
    setTabLabels({ "w1:p1|term_a": "Closing soon" });
    settleTabLabels([pc("local", [])]);
    expect(currentTabLabels()).toEqual({});
    // after a reload, an old label of a reused pane id was never seen here: it stays, unseen, and the new terminal learns its own
    setTabLabels({ "w1:p2|term_old": "Old" });
    learnTabLabel("local", "w1:p2", "New");
    settleTabLabels([pc("local", [{ pane_id: "w1:p2", terminal_id: "term_new" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p2|term_old": "Old", "w1:p2|term_new": "New" });
  });

  it("turning the setting off deletes this page's own labels, so none comes back when it is on again, nor with a send", () => {
    const panes = [pc("local", [{ pane_id: "w8:p1", terminal_id: "term_s" }])];
    const user = (text: string) => ({ role: "user" as const, ts: null, parts: [{ kind: "text" as const, text }] });
    learnFromConversation("local", "w8:p1", { source: "codex-transcript", cursor: null, turns: [user("Read before off")] });
    settleTabLabels(panes);
    expect(shownTabLabels()).toEqual({ "w8:p1|term_s": "Read before off" });
    learnFromConversation("local", "w8:p1", { source: "codex-transcript", cursor: null, turns: [user("Pending before off")] });
    setTabLabelLearning(false, false);
    expect(shownTabLabels()).toEqual({});
    setTabLabelLearning(true, false);
    settleTabLabels(panes);
    learnFromSend("local", "w8:p1", "codex", "Sent after on");
    settleTabLabels(panes);
    expect(shownTabLabels()).toEqual({});
    expect(currentTabLabels()).toEqual({});
  });

  it("learns nothing while the setting is off", () => {
    setTabLabelLearning(false, false);
    learnTabLabel("local", "w1:p1", "Fix it");
    setTabLabelLearning(true, false);
    settleTabLabels([pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }])]);
    expect(currentTabLabels()).toEqual({});
  });

  it("a watching device shows the labels and learns none", () => {
    setTabLabels({ "w1:p1|term_a": "Shared" });
    setTabLabelLearning(true, true);
    learnTabLabel("local", "w1:p2", "Mine");
    settleTabLabels([pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }, { pane_id: "w1:p2", terminal_id: "term_b" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p1|term_a": "Shared" });
  });

  it("keeps a label read from a transcript this page's own, and shares it with the user's first send", () => {
    const panes = [pc("local", [{ pane_id: "w7:p1", terminal_id: "term_q" }, { pane_id: "w7:p2", terminal_id: "term_r" }])];
    const user = (text: string) => ({ role: "user" as const, ts: null, parts: [{ kind: "text" as const, text }] });
    learnFromConversation("local", "w7:p1", { source: "codex-transcript", cursor: "c:4", turns: [user("A later message")] });
    learnFromConversation("local", "w7:p1", { source: "codex-transcript", cursor: null, turns: [user("The first one")] });
    settleTabLabels(panes);
    // shown here, shared nowhere: reading a pane writes nothing
    expect(shownTabLabels()).toEqual({ "w7:p1|term_q": "The first one" });
    expect(currentTabLabels()).toEqual({});
    // the user's send shares the label the transcript gave, not the text sent
    learnFromSend("local", "w7:p1", "codex", "Typed in Chat");
    expect(currentTabLabels()).toEqual({ "w7:p1|term_q": "The first one" });
    // a pane with no transcript: the send itself names it, shared
    learnFromConversation("local", "w7:p2", { source: "scrollback", turns: [] });
    learnFromSend("local", "w7:p2", "codex", "Sent to a shell agent");
    settleTabLabels(panes);
    expect(currentTabLabels()).toEqual({ "w7:p1|term_q": "The first one", "w7:p2|term_r": "Sent to a shell agent" });
    expect(shownTabLabels()).toEqual(currentTabLabels());
  });

  it("never labels a shell pane from a line sent to it", () => {
    learnFromConversation("local", "w1:p1", { source: "scrollback", turns: [] });
    learnFromConversation("local", "w1:p2", { source: "scrollback", turns: [] });
    learnFromSend("local", "w1:p1", null, "ls -la");
    learnFromSend("local", "w1:p2", "codex", "Fix the parser");
    settleTabLabels([pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }, { pane_id: "w1:p2", terminal_id: "term_b" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p2|term_b": "Fix the parser" });
  });

  it("finds the first message with words in turns read from the beginning", () => {
    expect(firstPromptOf([
      { role: "user", ts: null, parts: [{ kind: "image", media_type: "image/png", ref: "r" }] },
      { role: "assistant", ts: null, parts: [{ kind: "text", text: "Hi" }] },
      { role: "user", ts: null, parts: [{ kind: "text", text: "Fix it" }, { kind: "text", text: "now" }] },
    ])).toBe("Fix it\nnow");
    expect(firstPromptOf([{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Hi" }] }])).toBeNull();
  });
});
