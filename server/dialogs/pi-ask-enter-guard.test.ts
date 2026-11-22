// A typed answer's Enter is asked about once more right before herdr writes it: a question this server already knows has
// ended takes no key, even when the Enter left the route's last read behind (#3999). Pi's ask card, with herdr's client faked.
import { expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fixtures from "../fixtures/pi-ask-2.13.9.json";
import * as herdr from "../herdr/client.ts";
import * as piAsk from "../pi-ask-bridge.ts";
import { handlePromptRequest, promptWaitEnded } from "../prompt.ts";

async function withPi(run: (pane: {
  id: string;
  screen: string;
  sent: string[];
  echo: boolean;
  realEnter: boolean;
  answer(): Promise<number>;
}) => Promise<void>) {
  const id = `pi-ask-${randomUUID()}`;
  let moves = 0;
  const pane = {
    id, screen: fixtures.single, sent: [] as string[], echo: true, realEnter: false,
    answer: async () => {
      const url = new URL(`http://localhost/api/pane/prompt?pane_id=${id}`);
      const read = (await handlePromptRequest(new Request(url), url))!;
      expect(read.status).toBe(200);
      const { prompt } = await read.json() as { prompt: { id: string } | null };
      expect(prompt).not.toBeNull();
      const answerUrl = new URL("http://localhost/api/pane/prompt/answer");
      const answer = (await handlePromptRequest(new Request(answerUrl, {
        method: "POST", body: JSON.stringify({ pane_id: id, prompt_id: prompt!.id, custom_text: "typed answer" }),
      }), answerUrl))!;
      return answer.status;
    },
  };
  const originalSend = herdr.paneSendKeys;
  const sent = (key: string) => {
    pane.sent.push(key);
    if (key === "down") pane.screen = ++moves === 1 ? fixtures["single-second"] : fixtures["single-custom-empty"];
    if (pane.echo && key === "text:typed answer") pane.screen = fixtures["single-custom-empty"].replace(/(^❯ 3\.).*$/m, "$1 typed answer");
  };
  spyOn(piAsk, "piAskActivity").mockResolvedValue("absent");
  spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [{ pane_id: id, agent: "pi", agent_status: "blocked", terminal_id: id, focused: false }], layouts: [] } as never);
  spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: pane.screen }) as never);
  spyOn(herdr, "paneGet").mockResolvedValue({ pane_id: id, scroll: { offset_from_bottom: 0 } } as never);
  spyOn(herdr, "paneProcessInfo").mockResolvedValue({ foreground_processes: [{ pid: 2147483646, argv: ["pi"] }] } as never);
  spyOn(herdr, "agentGet").mockResolvedValue({} as never);
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text) => { sent(`text:${text}`); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (paneId, keys, _socket, guard) => {
    if (pane.realEnter && keys.includes("enter")) return originalSend(paneId, keys, "/unused/fake.sock", guard);
    if (guard && !guard()) throw new herdr.HerdrError("cancelled", "key withheld");
    for (const key of keys) sent(key);
  });
  try { await run(pane); } finally { promptWaitEnded(id); mock.restore(); }
}

const editKeys = ["down", "down", "ctrl+u", "text:typed answer"];

test("sends no Enter that is still connecting to herdr when the question it answers ends (#3999)", async () => {
  await withPi(async pane => {
    pane.realEnter = true;
    const connecting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    spyOn(Bun, "connect").mockImplementation((async (options: {
      socket: { data: (socket: unknown, bytes: Buffer) => void };
    }) => {
      connecting.resolve();
      await release.promise;
      const socket = {
        end() {},
        write(bytes: Uint8Array) {
          const frame = JSON.parse(Buffer.from(bytes).toString()) as { id: string; method: string; params: { keys: string[] } };
          expect(frame.method).toBe("pane.send_keys");
          pane.sent.push(...frame.params.keys.map(key => `${key} into ${pane.screen}`));
          queueMicrotask(() => options.socket.data(socket, Buffer.from(JSON.stringify({ id: frame.id, result: {} }) + "\n")));
          return bytes.byteLength;
        },
      };
      return socket;
    }) as never);
    const answer = pane.answer();
    await Promise.race([connecting.promise, answer.then(status => { throw new Error(`answer ended before Enter connected: ${status}`); })]);
    expect(pane.sent).toEqual(editKeys);
    pane.screen = "> main composer";
    promptWaitEnded(pane.id);
    release.resolve();
    expect([await answer, pane.sent]).toEqual([409, editKeys]);
  });
});
