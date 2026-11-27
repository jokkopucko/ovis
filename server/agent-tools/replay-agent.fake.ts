/**
 * An ACP agent that replays a recorded real agent's side (fixtures/*.jsonl, one message per line): its
 * `initialize` and `session/new` answers, then on every prompt each recorded permission request in turn,
 * the next only once the client answered the last, and the recorded end of the turn. A prompt that says
 * `widen` instead switches the session to `acceptEdits`; `enable allow all` updates only that
 * config selector. What the client
 * sent on `session/new`, each prompt and each answer go to <log>, one JSON line each.
 *
 *   bun replay-agent.fake.ts <fixture> <log> [scenario]
 */
import { appendFileSync, readFileSync } from "node:fs";

const [fixture, log, scenario] = process.argv.slice(2);
if (!fixture || !log) throw new Error("usage: bun replay-agent.fake.ts <fixture> <log> [scenario]");
const { startMode, openingAllowAll, updatedMode, updatedAllowAll, refuseSetMode }: {
  readonly startMode?: string; readonly openingAllowAll?: "on" | "off";
  readonly updatedMode?: string; readonly updatedAllowAll?: "on" | "off"; readonly refuseSetMode?: boolean;
} = scenario ? JSON.parse(readFileSync(scenario, "utf8")) : {};
const recorded = readFileSync(fixture, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);
const [initialized, opened] = recorded.filter(m => "result" in m);
const asks = recorded.filter(m => m.method === "session/request_permission");
/** Requests of the agent's own (Qwen Code's `craft/drainMidTurnQueue`): asked again in each turn, and the turn ends only once answered. */
const extensions = recorded.filter(m => m.method !== undefined && m.id !== undefined && m.method !== "session/request_permission");
const ended = recorded.filter(m => "result" in m).at(-1)!;
const sessionId: string = opened!.result.sessionId;

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const note = (row: object) => appendFileSync(log, `${JSON.stringify(row)}\n`);
const waiting = new Map<string, (answer: unknown) => void>();
let asked = 0;
const allowAllOption = (currentValue: "on" | "off") => ({ type: "select", id: "allow_all", category: "permissions", currentValue });
const updateAllowAll = (value: "on" | "off") => send({
  method: "session/update", params: { sessionId, update: { sessionUpdate: "config_option_update", configOptions: [allowAllOption(value)] } },
});
const updateMode = (currentModeId: string) => send({
  method: "session/update", params: { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId } },
});

async function turn(id: unknown, text: string) {
  if (text.includes("widen")) {
    updateMode("acceptEdits");
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  if (text.includes("enable allow all")) {
    updateAllowAll("on");
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  for (const ask of asks) {
    const ours = `replay-${++asked}`;
    const answered = new Promise(resolve => waiting.set(ours, resolve));
    send({ id: ours, method: ask.method, params: { ...ask.params, sessionId } });
    note({ answered: ask.params.toolCall.toolCallId, answer: await answered });
  }
  for (const request of extensions) {
    const ours = `replay-${++asked}`;
    const answered = new Promise(resolve => waiting.set(ours, resolve));
    send({ id: ours, method: request.method, params: { ...request.params, sessionId } });
    note({ extension: request.method, answer: await answered });
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
    else if (message.method === "session/new") {
      note({ sessionNew: message.params });
      const result = opened!.result;
      if (startMode !== undefined) {
        result.modes.currentModeId = startMode;
        const mode = result.configOptions?.find((option: { category?: string }) => option.category === "mode");
        if (mode) mode.currentValue = startMode;
      }
      if (openingAllowAll !== undefined) {
        result.configOptions = (result.configOptions ?? []).filter((option: { id: string }) => option.id !== "allow_all");
        result.configOptions.push(allowAllOption(openingAllowAll));
      }
      send({ id: message.id, result });
      if (updatedMode !== undefined) updateMode(updatedMode);
      if (updatedAllowAll !== undefined) updateAllowAll(updatedAllowAll);
    }
    else if (message.method === "fixture/barrier") send({ id: message.id, result: {} });
    else if (message.method === "session/set_mode") {
      // as Kimi Code 2.8.1 answers it: the mode's update, then an empty result
      note({ setMode: message.params.modeId });
      if (refuseSetMode) send({ id: message.id, error: { code: -32603, message: "Internal error" } });
      else {
        updateMode(message.params.modeId);
        send({ id: message.id, result: {} });
      }
    }
    else if (message.method === "session/prompt") {
      const prompt = JSON.stringify(message.params.prompt);
      note({ prompt });
      void turn(message.id, prompt);
    }
    else if (message.method === undefined && waiting.has(String(message.id))) { waiting.get(String(message.id))!(message.result ?? message.error); waiting.delete(String(message.id)); }
    else if (message.id !== undefined && message.method !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}
