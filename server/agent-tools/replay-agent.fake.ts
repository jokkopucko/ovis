/**
 * An ACP agent that replays a recorded real agent's side (fixtures/*.jsonl, one message per line): its
 * `initialize` and `session/new` answers, then on every prompt each recorded permission request in turn,
 * the next only once the client answered the last, and the recorded end of the turn. A prompt that says
 * `widen` instead switches the session to `acceptEdits` the way an agent reports it. What the client
 * sent on `session/new` and each answer it gave go to <log>, one JSON line each.
 *
 *   bun replay-agent.fake.ts <fixture> <log>
 */
import { appendFileSync, readFileSync } from "node:fs";

const [fixture, log] = process.argv.slice(2);
if (!fixture || !log) throw new Error("usage: bun replay-agent.fake.ts <fixture> <log>");
const recorded = readFileSync(fixture, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);
const [initialized, opened] = recorded.filter(m => "result" in m);
const asks = recorded.filter(m => m.method === "session/request_permission");
const ended = recorded.filter(m => "result" in m).at(-1)!;
const sessionId: string = opened!.result.sessionId;

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const note = (row: object) => appendFileSync(log, `${JSON.stringify(row)}\n`);
const waiting = new Map<string, (answer: unknown) => void>();
let asked = 0;

async function turn(id: unknown, text: string) {
  if (text.includes("widen")) {
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "acceptEdits" } } });
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  for (const ask of asks) {
    const ours = `replay-${++asked}`;
    const answered = new Promise(resolve => waiting.set(ours, resolve));
    send({ id: ours, method: ask.method, params: { ...ask.params, sessionId } });
    note({ answered: ask.params.toolCall.toolCallId, answer: await answered });
  }
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all asked" } } } });
  send({ id, result: ended.result });
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line) as Record<string, any>;
    if (message.method === "initialize") send({ id: message.id, result: initialized!.result });
    else if (message.method === "session/new") { note({ sessionNew: message.params }); send({ id: message.id, result: opened!.result }); }
    else if (message.method === "session/prompt") void turn(message.id, JSON.stringify(message.params.prompt));
    else if (message.method === undefined && waiting.has(String(message.id))) { waiting.get(String(message.id))!(message.result ?? message.error); waiting.delete(String(message.id)); }
    else if (message.id !== undefined && message.method !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}
