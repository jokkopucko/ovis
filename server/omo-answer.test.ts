import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsedByPublicPrompt, type ParsedPrompt } from "./dialogs/shared.ts";
import { answerOmoPending, omoAnswerOf } from "./omo-answer.ts";
import { openOmoAsks } from "./omo-questions.ts";
import { parseInteractivePrompt } from "./prompt.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/omo-pending-5.1.30-${name}`, import.meta.url), "utf8");

/** The card OmO 5.1.30's widget shows for its one pending question (several picks), or the first of two, bound to the call. */
function card(count: "one" | "two", path = "/s/session.jsonl"): ParsedPrompt {
  const open = openOmoAsks(fixture(`${count}.jsonl`)).map((ask) => ({ ...ask, id: `${path}\0${ask.id}` }));
  const prompt = parseInteractivePrompt("pi", fixture(`${count}-wide.txt`), null, false, open);
  return parsedByPublicPrompt.get(prompt!)!;
}

const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * OmO's terminal control socket as senpi 2026.11.19-5 serves it (docs/rpc.md, "terminal control"): the 32-byte secret
 * first, then one JSON request a line, each answered by a `response` with its id. It holds `sessionFile` and answers an
 * `extension_ui_response` with `reply`, or not at all (null).
 */
function omoSocket(sessionFile: string, reply: Record<string, unknown> | null = { success: true, disposition: "applied" }) {
  const root = mkdtempSync(join(tmpdir(), "omo-answer-"));
  roots.push(root);
  const path = join(root, "t-0123456789abcdef.sock");
  const secret = Buffer.alloc(32, 7);
  writeFileSync(`${path}.secret`, secret, { mode: 0o600 });
  const frames: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let authed = false;
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!authed) {
        if (buffered.length < 32) return;
        if (!buffered.subarray(0, 32).equals(secret)) return void socket.destroy();
        authed = true;
        buffered = buffered.subarray(32);
      }
      for (let end = buffered.indexOf(10); end >= 0; end = buffered.indexOf(10)) {
        const frame = JSON.parse(buffered.subarray(0, end).toString("utf8")) as Record<string, unknown>;
        buffered = buffered.subarray(end + 1);
        frames.push(frame);
        const answer = frame["type"] === "get_state" ? { success: true, data: { sessionFile } } : reply;
        if (answer === null) continue;
        socket.write(`${JSON.stringify({ id: frame["id"], type: "response", command: frame["type"], ...answer })}\n`);
      }
    });
  });
  servers.push(server);
  return { path, frames, listening: new Promise<void>((resolve) => server.listen(path, resolve)) };
}

describe("an OmO question that does not wait, answered on its control socket", () => {
  test("binds only a call that asks one question, under the key OmO files its answer", () => {
    expect(card("one").omoData).toEqual({ key: "q1", labels: card("one").options.map((option) => option.label) });
    expect(card("two").omoData).toBeUndefined();
  });

  test("files an option, the user's own words, or several picks as OmO takes them", () => {
    const labels = ["PostgreSQL", "SQLite"];
    expect(omoAnswerOf(labels, false, { pane_id: "p", prompt_id: "c", option_index: 1 })).toEqual({ selected: ["SQLite"] });
    expect(omoAnswerOf(labels, false, { pane_id: "p", prompt_id: "c", custom_text: " Neither " })).toEqual({ selected: [], text: "Neither" });
    expect(omoAnswerOf(labels, true, { pane_id: "p", prompt_id: "c", option_indices: [0, 1] })).toEqual({ selected: labels });
    for (const body of [{ option_index: 2 }, { option_indices: [0] }, { custom_text: "  " }, { step_next: true }, {}]) {
      expect(omoAnswerOf(labels, false, { pane_id: "p", prompt_id: "c", ...body }), JSON.stringify(body)).toBeNull();
    }
  });

  test("answers the call by its id on the socket of the session it was read from", async () => {
    const omo = omoSocket("/s/session.jsonl");
    await omo.listening;
    const shown = card("one");
    const call = shown.omoQuestion!.call.split("\0")[1];
    expect(await answerOmoPending(omo.path, shown, { pane_id: "p", prompt_id: shown.id, option_indices: [0, 2] }, () => true, Date.now() + 4_000)).toBe("sent");
    expect(omo.frames.map(({ id: _, ...frame }) => frame)).toEqual([
      { type: "get_state" },
      { type: "extension_ui_response", uiRequestId: call, answers: { q1: { selected: [shown.omoData!.labels[0]!, shown.omoData!.labels[2]!] } } },
    ]);
  });

  test("leaves the answer to the keys where the socket holds another session, OmO refused it unapplied, or the send was called off", async () => {
    // the fixture's one question takes several picks
    const body = { pane_id: "p", prompt_id: "c", option_indices: [0] };
    const other = omoSocket("/s/other.jsonl");
    const unapplied = omoSocket("/s/session.jsonl", { success: false, error: "invalid_response" });
    const older = omoSocket("/s/session.jsonl", { success: false, error: "unsupported" });
    const calledOff = omoSocket("/s/session.jsonl");
    await Promise.all([other.listening, unapplied.listening, older.listening, calledOff.listening]);
    expect(await answerOmoPending(other.path, card("one"), body, () => true, Date.now() + 4_000)).toBeNull();
    expect(other.frames.map((frame) => frame["type"])).toEqual(["get_state"]);
    expect(await answerOmoPending(unapplied.path, card("one"), body, () => true, Date.now() + 4_000)).toBeNull();
    expect(await answerOmoPending(older.path, card("one"), body, () => true, Date.now() + 4_000)).toBeNull();
    expect(await answerOmoPending(calledOff.path, card("one"), body, () => false, Date.now() + 4_000)).toBeNull();
    expect(calledOff.frames.map((frame) => frame["type"])).toEqual(["get_state"]);
    expect(await answerOmoPending(null, card("one"), body, () => true, Date.now() + 4_000)).toBeNull();
  });

  test("types no key where OmO waits on no such question, or answers in a way that may mean it applied the answer", async () => {
    const body = { pane_id: "p", prompt_id: "c", option_indices: [0] };
    // answered meanwhile, or by this very answer sent before an acknowledgment that was lost
    const unclear = omoSocket("/s/session.jsonl", { disposition: "applied" });
    await unclear.listening;
    const closed = card("one", "/s/closed.jsonl");
    const answeredHere = omoSocket("/s/closed.jsonl", { success: false, error: "unknown_request", disposition: "unknown" });
    await answeredHere.listening;
    expect(await answerOmoPending(answeredHere.path, closed, body, () => true, Date.now() + 4_000)).toBe("gone");
    // a later request that finds no socket types no key for that call either
    expect(await answerOmoPending(null, closed, body, () => true, Date.now() + 4_000)).toBe("gone");
    expect(await answerOmoPending(unclear.path, card("one"), body, () => true, Date.now() + 4_000)).toBe("gone");
  });
  test("waits for OmO's word only within the answer's time, then types no key for that call, also without a socket", async () => {
    const body = { pane_id: "p", prompt_id: "c", option_indices: [0] };
    const shown = card("one", "/s/silent.jsonl");
    const silentHere = omoSocket("/s/silent.jsonl", null);
    await silentHere.listening;
    const started = Date.now();
    expect(await answerOmoPending(silentHere.path, shown, body, () => true, started + 300)).toBe("gone");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(silentHere.frames.map((frame) => frame["type"])).toEqual(["get_state", "extension_ui_response"]);
    expect(await answerOmoPending(null, shown, body, () => true, Date.now() + 4_000)).toBe("gone");
    const refusing = omoSocket("/s/silent.jsonl", { success: false, error: "invalid_response" });
    await refusing.listening;
    expect(await answerOmoPending(refusing.path, shown, body, () => true, Date.now() + 4_000)).toBe("gone");
  });
});
