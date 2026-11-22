import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type { HerdrPane, PanePromptResponse } from "../shared/protocol.ts";
import * as client from "./herdr/client.ts";
import * as conversation from "./conversation.ts";
import * as service from "./opencode-service.ts";
import { handlePromptRequest, noteSubmitted, OpenCodePromptState, prepareCommandSend } from "./prompt.ts";

afterEach(() => mock.restore());

it("keeps a native OpenCode question when an outcome screen read fails", async () => {
  const pane: HerdrPane = { pane_id: "opencode-outcome-read-failure", terminal_id: "terminal",
    workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0,
    agent: "opencode", agent_status: "blocked",
    agent_session: { agent: "opencode", kind: "id", source: "herdr:opencode", value: "ses_fixture" } };
  let now = 40_000;
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const screen = spyOn(client, "paneRead").mockRejectedValue(new Error("fixture screen unavailable"));
  spyOn(conversation, "readCommandTranscript").mockResolvedValue(null);
  spyOn(service, "openCodeService").mockResolvedValue({ config: { baseUrl: "http://127.0.0.1:1234", port: 1234, pid: 123, password: "fixture" }, version: "2.0.32" });
  spyOn(service, "listPendingQuestionForms").mockResolvedValue([{
    id: "form_fixture", sessionID: "ses_fixture", title: "Fixture question", metadata: { kind: "question" },
    fields: [{ key: "choice", type: "select", required: true, options: [{ value: "yes", label: "Fixture option" }] }],
  }]);
  const sent = prepareCommandSend(pane, "/myext");
  if (!sent) throw new Error("fixture command was not recorded");
  noteSubmitted(pane.pane_id, sent.text, sent);
  now++;
  const url = new URL(`http://localhost/api/pane/prompt?pane_id=${pane.pane_id}`);
  const response = await handlePromptRequest(new Request(url), url, { openCodeState: new OpenCodePromptState() });
  expect(response?.status).toBe(200);
  const body = await response?.json() as PanePromptResponse;
  expect(body.prompt).toMatchObject({ kind: "question", options: [{ label: "Fixture option" }] });
  expect(body.outcomes).toMatchObject([{ state: "accepted", evidence: [] }]);
  expect(body.outcomes?.[0]?.preview).toBeUndefined();
  expect(screen).toHaveBeenCalledTimes(1);
});
