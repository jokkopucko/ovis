import { describe, expect, it } from "bun:test";
import type { NoticeAnswer } from "../../../shared/account-devices-api.ts";
import type { ServerMessage } from "../../../shared/protocol.ts";
import { answerOnPc, notMeTransports, recordsOnPc, type AnswerSocket } from "./noticeAnswer.ts";

class FakeSocket implements AnswerSocket {
  readonly sent: NoticeAnswer[] = [];
  offers = true;
  private readonly handlers = new Set<(message: ServerMessage) => void>();
  on(handler: (message: ServerMessage) => void) { this.handlers.add(handler); return () => { this.handlers.delete(handler); }; }
  sendNotice(message: NoticeAnswer) { if (!this.offers) return false; this.sent.push(message); return true; }
  receive(message: unknown) { for (const handler of [...this.handlers]) handler(message as ServerMessage); }
}

const answer = { type: "notice-answer", id: "n1", answer: "not_me", blocks: [] } as unknown as NoticeAnswer;

describe("Not me on the notice's own PC", () => {
  it("T60: sends the answer and takes that PC's receipts for this notice only", async () => {
    const pc = new FakeSocket();
    const receipts = answerOnPc(pc, answer, 1000);
    expect(pc.sent).toEqual([answer]);
    pc.receive({ type: "notice-answer-result", id: "other", receipts: [{ outcome: "applied", id: "x", n: 1 }] });
    pc.receive({ type: "notice-answer-result", id: "n1", receipts: [{ outcome: "applied", id: "b", n: 2 }] });
    expect(await receipts).toEqual([{ outcome: "applied", id: "b", n: 2 }]);
  });

  it("T60, T65: a PC that does not offer it, or never answers, is not reached and is retried", async () => {
    const off = new FakeSocket();
    off.offers = false;
    await expect(answerOnPc(off, answer, 1000)).rejects.toThrow();
    await expect(answerOnPc(new FakeSocket(), answer, 1)).rejects.toThrow();
  });
});

describe("Not me on the account's other PCs", () => {
  it("T60: hands the blocks to the PC's records route and takes the receipts it answers", async () => {
    const asked: { path: string; body: unknown }[] = [];
    const post = async (path: string, body: unknown) => { asked.push({ path, body }); return Response.json({ results: [], receipts: [{ outcome: "already_applied", id: "b" }] }); };
    expect(await recordsOnPc(post, [{ id: "b" } as never])).toEqual([{ outcome: "already_applied", id: "b" }]);
    expect(asked).toEqual([{ path: "/api/account/records", body: { records: [{ id: "b" }] } }]);
  });

  it("G5, T65: a PC that answers without receipts (release off or older) or fails is not reached, and is retried", async () => {
    await expect(recordsOnPc(async () => Response.json({ results: [] }), [{ id: "b" } as never])).rejects.toThrow();
    await expect(recordsOnPc(async () => new Response("", { status: 502 }), [{ id: "b" } as never])).rejects.toThrow();
  });
});

describe("where Not me goes", () => {
  it("T60: only the notice's own PC's socket answer counts; every other PC's records route only delivers", async () => {
    const desk = new FakeSocket();
    const posted: string[] = [];
    const sends = notMeTransports({ id: "n1" } as never, "desk", ["desk", "home"], {
      socket: (pc) => pc === "desk" ? desk : undefined,
      post: (pc) => async (path) => { posted.push(`${pc} ${path}`); return Response.json({ results: [], receipts: [{ outcome: "applied", id: "b", n: 1 }] }); },
      timeoutMs: 1000,
    });
    expect([...sends.pcs.keys()]).toEqual(["desk"]);
    expect([...sends.relayed.keys()]).toEqual(["home"]);
    const own = sends.pcs.get("desk")!([{ id: "b" } as never]);
    desk.receive({ type: "notice-answer-result", id: "n1", receipts: [{ outcome: "applied", id: "b", n: 2 }] });
    expect(await own).toEqual([{ outcome: "applied", id: "b", n: 2 }]);
    expect(desk.sent[0]).toMatchObject({ type: "notice-answer", id: "n1", answer: "not_me", blocks: [{ id: "b" }] });
    expect(await sends.relayed.get("home")!([{ id: "b" } as never])).toEqual([{ outcome: "applied", id: "b", n: 1 }]);
    expect(posted).toEqual(["home /api/account/records"]);
  });
});

describe("a PC's own relay channel (relay-hub ruling on T60)", () => {
  it("T60: a PC this device reaches on its own relay channel is a counted route; only the rest go through the proxy", async () => {
    const sends = notMeTransports({ id: "n1" } as never, "desk", ["desk", "home", "lab"], {
      socket: () => new FakeSocket(),
      post: () => async () => Response.json({ results: [], receipts: [] }),
      channel: (pc) => pc === "home" ? async () => Response.json({ results: [], receipts: [{ outcome: "applied", id: "b", n: 1 }] }) : undefined,
      timeoutMs: 1000,
    });
    expect([...sends.pcs.keys()].sort()).toEqual(["desk", "home"]);
    expect([...sends.relayed.keys()]).toEqual(["lab"]);
    expect(await sends.pcs.get("home")!([{ id: "b" } as never])).toEqual([{ outcome: "applied", id: "b", n: 1 }]);
  });
});
