import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { HerdrPane } from "../../shared/protocol.ts";
import * as conversation from "../conversation.ts";
import * as herdr from "../herdr/client.ts";
import * as native from "../opencode-native.ts";
import * as prompt from "../prompt.ts";
import { createSubmitText } from "./composer.ts";

afterEach(() => mock.restore());

const PROMPT = "Enter passphrase for key '/tmp/key': ";

/**
 * A chat message naming an OpenCode @skill, sent at once (not queued) to an idle OpenCode pane: its skill is typed key by
 * key. `race` changes the pane while it is typed: `masked` puts a masked prompt on the autocomplete read the skill key is
 * decided on, `live` puts one on the live screen while the scrolled viewport still shows the row, `first` shows one
 * before the first key, `wrapped` shows one wrapped at a width this send has no attachment to tell, `wide` the same with
 * wide (two-column) characters in the wrapped row. Returns what was written, how the send ended and whether its OpenCode
 * watch was let go.
 */
async function send(race: "masked" | "live" | "first" | "wrapped" | "wide") {
  const pane = { pane_id: "p", terminal_id: "t", agent: "opencode", agent_status: "idle" } as HerdrPane;
  spyOn(herdr, "paneGet").mockImplementation(async () => pane);
  spyOn(conversation, "paneProcessRoots").mockImplementation(async () => ({ omo: null, processes: undefined }) as Awaited<ReturnType<typeof conversation.paneProcessRoots>>);
  spyOn(prompt, "prepareCommandSend").mockReturnValue({} as ReturnType<typeof prompt.prepareCommandSend>);
  spyOn(prompt, "bindCommandProcess").mockImplementation(() => {});
  spyOn(prompt, "noteSubmitted").mockImplementation(() => {});
  spyOn(native, "openCodeSkillsToType").mockImplementation(async (_pane, sent) => ({ sent, skills: ["effect"] }));
  let cancelled = false;
  spyOn(native, "startOpenCodeWatch").mockReturnValue({ cancel: () => { cancelled = true; }, commit: () => {} } as unknown as ReturnType<typeof native.startOpenCodeWatch>);
  const selected = readFileSync(join(import.meta.dir, "../fixtures/opencode-autocomplete-2.0.32-ansi-first-selected.ansi"), "utf8");
  let live = race === "first" ? PROMPT : race === "wrapped" ? "Enter passphrase for key\n'/tmp/key':"
    : race === "wide" ? "Enter passphrase for key '/tmp/한글키\n.pem':" : "";
  let visible = 0;
  spyOn(herdr, "paneRead").mockImplementation(async (options) => {
    if (options.source !== "visible") return { text: live } as Awaited<ReturnType<typeof herdr.paneRead>>;
    // the second read is the one right before the skill key
    if (++visible === 2 && race === "live") live = PROMPT;
    return { text: race === "masked" && visible >= 2 ? `${selected}\n${PROMPT}` : selected } as Awaited<ReturnType<typeof herdr.paneRead>>;
  });
  const writes: string[] = [];
  spyOn(herdr, "agentPrompt").mockImplementation(async (_pane, text) => { writes.push(`prompt:${text}`); });
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, data, _wait, allowed) => { if (allowed?.() !== false) writes.push(data); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys, _wait, allowed) => { if (allowed?.() !== false) writes.push(keys.join("+")); });
  const submit = createSubmitText({ options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
    SUBMIT_DEADLINE_MS: 45_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0 });
  const error = await submit("p", "@effect", "@effect", Date.now(), false, () => {}).then(() => null, (failure: unknown) => failure as herdr.HerdrError);
  return { writes, code: error?.code ?? null, cancelled };
}

it("sends no skill-accept key when its autocomplete read shows a masked prompt", async () => {
  const { writes, code } = await send("masked");
  expect(writes).toEqual(["@effect"]);
  // part of the message was typed: the user is told to check the terminal
  expect(code).toBe("submit_partial");
});

it("sends no skill-accept key while the live screen shows a masked prompt behind a scrolled viewport", async () => {
  const { writes, code } = await send("live");
  expect(writes).toEqual(["@effect"]);
  expect(code).toBe("submit_partial");
});

it("types nothing of a skill message into a masked prompt already on the screen", async () => {
  const { writes, code, cancelled } = await send("first");
  expect(writes).toEqual([]);
  expect(code).toBe("agent_blocked");
  expect(cancelled).toBe(true);
});

it("types nothing into a masked prompt wrapped at a width the send cannot tell", async () => {
  const { writes, code } = await send("wrapped");
  expect(writes).toEqual([]);
  expect(code).toBe("agent_blocked");
});

it("types nothing into a masked prompt whose wrapped row holds wide characters", async () => {
  const { writes, code } = await send("wide");
  expect(writes).toEqual([]);
  expect(code).toBe("agent_blocked");
});
