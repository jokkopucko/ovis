import { expect, test } from "bun:test";

import { isMouseReport, isTerminalReply, sightingFacts, typingGuards } from "./input-guard.ts";

const attach = (...members: string[]) => ({ clients: new Set(members), ready: true, process: {}, kind: "pty" as const, cols: 80 });
const typedThen = (origin: ReturnType<typeof attach> | undefined, current: ReturnType<typeof attach> | undefined, client: string): boolean =>
  typingGuards.herdrTyping(sightingFacts({ attachment: origin, process: origin?.process, claim: undefined, member: origin !== undefined },
    { attachment: current, claim: undefined }, client));

test("typing taken with no attach is refused once someone attaches meanwhile", () => {
  expect(typedThen(undefined, undefined, "a")).toBe(true);
  expect(typedThen(undefined, attach("b"), "a")).toBe(false);
  // attaching yourself meanwhile is a new attach too: what was typed before it takes none of it
  expect(typedThen(undefined, attach("a"), "a")).toBe(false);
});

test("a click or a wheel is told from typing, so a queued one keeps the attach input path", () => {
  expect(isMouseReport("\x1b[<0;5;3M")).toBe(true);
  expect(isMouseReport("\x1b[<0;5;3M\x1b[<0;5;3m")).toBe(true);
  expect(isMouseReport("\x1b[<65;120;40M")).toBe(true);
  // the default encoding: CSI M and three bytes, a byte may be any character
  expect(isMouseReport("\x1b[M #!")).toBe(true);
  expect(isMouseReport("\x1b[M\x60;;\x1b[M\x61;;")).toBe(true);
  for (const text of ["", "a", "\x1b[A", "\x1b[<0;5;3", "\x1b[<0;5;3Mx", "x\x1b[<0;5;3M", "\x1b[M #", "\x1b[1;5A"]) {
    expect(isMouseReport(text)).toBe(false);
  }
});

test("the terminal's own answers are told from typing, so queued ones go to the attach that asked (#2816)", () => {
  expect(isTerminalReply("\x1b[I")).toBe(true);
  expect(isTerminalReply("\x1b[O")).toBe(true);
  expect(isTerminalReply("\x1b]11;rgb:1818/1616/1313\x07")).toBe(true);
  expect(isTerminalReply("\x1b[6;17;8t")).toBe(true);
  expect(isTerminalReply("\x1b[I\x1b]10;rgb:d8d8/d0d0/c3c3\x1b\\\x1b]12;rgb:f0f0/a8a8/3030\x1b\\\x1b[?1;2c")).toBe(true);
  for (const text of ["", "I", "\x1b[A", "\x1b[1;2A", "\x1bOB", "\x1b]11;?\x1b\\", "\x1b[Ix", "x\x1b[I", "\x1b]13;rgb:0/0/0\x07", "\x1b]11;hello\rworld\x07"]) {
    expect(isTerminalReply(text)).toBe(false);
  }
});

test("typing taken into an attach goes only into that attach, while it still has the typist", () => {
  const origin = attach("a");
  expect(typedThen(origin, origin, "a")).toBe(true);
  expect(typedThen(origin, undefined, "a")).toBe(false);
  expect(typedThen(origin, attach("a"), "a")).toBe(false);
  origin.clients.delete("a");
  expect(typedThen(origin, origin, "a")).toBe(false);
});

type Attachment = { clients: Set<unknown>; ready: boolean; held?: boolean; process: object; kind: "pty" | "mirror"; cols: number };
type Scenario = {
  label: string;
  message: { pane_id: string };
  attachments: Map<string, Attachment>;
  client: { data: { attached: Map<string, object> } };
  attachment: Attachment | undefined;
  origin: Attachment | undefined;
  pty: object | undefined;
  attachmentPty: object | undefined;
  claim: object | undefined;
  facts: ReturnType<typeof sightingFacts>;
};

function originalSameAttachment<Client, A extends { clients: { has(client: Client): boolean } }>(origin: A | undefined, current: A | undefined, client: Client): boolean {
  return origin ? current === origin && origin.clients.has(client) : current === undefined;
}

function* scenarios(): Generator<Scenario> {
  const states = [undefined, false, true];
  for (const seenOne of [false, true])
  for (const memberThen of seenOne ? [false, true] : [false])
  for (const now of seenOne ? ["none", "seen", "other"] as const : ["none", "other"] as const)
  for (const memberNow of [false, true])
  for (const replaced of [false, true])
  for (const ready of [false, true])
  for (const held of states)
  for (const otherHeld of now === "other" ? states : [undefined])
  for (const otherMember of now === "other" ? [false, true] : [false])
  for (const claimThen of [undefined, {}])
  for (const claimNow of claimThen ? ["none", "same", "other"] as const : ["none", "other"] as const) {
    const client = { data: { attached: new Map<string, object>() } };
    const paneId = "w1:p1";
    const before = {};
    const seen: Attachment | undefined = seenOne ? { clients: new Set(memberThen ? [client] : []), ready: true, process: before, kind: "pty", cols: 80 } : undefined;
    const origin = seen?.clients.has(client) ? seen : undefined;
    const pty = origin?.process as object | undefined;
    const attachmentPty = seen?.process;
    const sighting = { attachment: seen, process: seen?.process, claim: claimThen, member: seen?.clients.has(client) === true };
    if (seen) {
      seen.clients = new Set(memberNow ? [client] : []);
      seen.ready = ready;
      seen.held = held;
      if (replaced) seen.process = {};
    }
    const other: Attachment = { clients: new Set(otherMember ? [client] : []), ready: true, held: otherHeld, process: {}, kind: "pty", cols: 80 };
    const current = now === "seen" ? seen : now === "other" ? other : undefined;
    const attachments = new Map<string, Attachment>(current ? [[paneId, current]] : []);
    const claimed = claimNow === "same" ? claimThen : claimNow === "other" ? {} : undefined;
    if (claimed) client.data.attached.set(paneId, claimed);
    yield {
      label: JSON.stringify({ seenOne, memberThen, now, memberNow, replaced, ready, held, otherHeld, otherMember, claimThen: !!claimThen, claimNow }),
      message: { pane_id: paneId }, attachments, client, attachment: seen, origin, pty, attachmentPty, claim: claimThen,
      facts: sightingFacts(sighting, { attachment: current, claim: client.data.attached.get(paneId) }, client),
    };
  }
}

test("each typing guard answers every state as the check it replaced", () => {
  let checked = 0;
  for (const s of scenarios()) {
    const { message, attachments, client, origin, pty, claim, facts } = s;
    const verdicts: Record<string, [boolean, boolean]> = {
      herdrTyping: [typingGuards.herdrTyping(facts), client.data.attached.get(message.pane_id) === claim
        && originalSameAttachment(origin, attachments.get(message.pane_id), client)],
      herdrTypingTurn: [!typingGuards.herdrTyping(facts), client.data.attached.get(message.pane_id) !== claim
        || !originalSameAttachment(origin, attachments.get(message.pane_id), client)],
      keys: [typingGuards.keys(facts), !attachments.get(message.pane_id)?.held
        && (!origin || (attachments.get(message.pane_id) === origin && origin.process === pty && origin.ready
          && client.data.attached.get(message.pane_id) === claim && origin.clients.has(client)))],
    };
    // queued typing and a secret are taken only in an attach the client is in
    if (s.attachment && origin) {
      const attachment = s.attachment;
      const pty = s.attachmentPty;
      verdicts["queuedTyping"] = [typingGuards.queuedTyping(facts), attachments.get(message.pane_id) === attachment && attachment.process === pty
        && client.data.attached.get(message.pane_id) === claim && attachment.clients.has(client) && attachment.ready && !attachment.held];
      verdicts["queuedTypingTurn"] = [!typingGuards.queuedTyping(facts), attachments.get(message.pane_id) !== attachment || attachment.process !== pty
        || client.data.attached.get(message.pane_id) !== claim
        || !attachment.clients.has(client) || !attachment.ready || !!attachment.held];
      verdicts["mirrorSecret"] = [typingGuards.mirrorSecret(facts), attachments.get(message.pane_id) === attachment
        && attachment.process === pty && client.data.attached.get(message.pane_id) === claim && attachment.clients.has(client)];
    }
    // a pending lease is taken on any attachment; one that is held fails before the rest is asked
    if (s.attachment) {
      const lease = { attachment: s.attachment, pty: s.attachmentPty };
      const owner = client;
      const paneId = message.pane_id;
      const attachment = attachments.get(paneId);
      verdicts["pendingHeld"] = [facts.currentHeld, !!attachment?.held];
      if (!attachment?.held) {
        verdicts["pendingLease"] = [typingGuards.pendingLease(facts), !(attachment !== lease.attachment || attachment.process !== lease.pty
          || !owner.data.attached.has(paneId) || !attachment.clients.has(owner) || !attachment.ready)];
      }
    }
    for (const [check, [guard, oracle]] of Object.entries(verdicts)) {
      if (guard !== oracle) throw new Error(`${check} differs for ${s.label}: guard ${guard}, original ${oracle}`);
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(10_000);
});

test("each fact is the expression it stands for in the input paths' ordered checks", () => {
  for (const s of scenarios()) {
    const { message, attachments, client, claim, facts } = s;
    const current = attachments.get(message.pane_id);
    expect(facts.attached).toBe(current !== undefined);
    expect(facts.origin).toBe(s.origin !== undefined);
    expect(facts.sameAttachment).toBe(current === s.attachment);
    if (s.attachment) expect(facts.samePty).toBe(s.attachment.process === s.attachmentPty);
    expect(facts.sameClaim).toBe(client.data.attached.get(message.pane_id) === claim);
    expect(facts.claimed).toBe(client.data.attached.has(message.pane_id));
    expect(facts.member).toBe(!!s.attachment?.clients.has(client));
    expect(facts.ready).toBe(!!s.attachment?.ready);
    expect(facts.held).toBe(!!s.attachment?.held);
    expect(facts.currentHeld).toBe(!!current?.held);
  }
});

test("a sighting with no attachment is no origin, and a mirrored one says so with its grid", () => {
  const none = sightingFacts({ attachment: undefined, process: undefined, claim: undefined, member: false }, { attachment: undefined, claim: undefined }, "a");
  expect(none).toMatchObject({ attached: false, origin: false, sameAttachment: true, member: false, ready: false, mirror: false, cols: undefined });
  expect(typingGuards.herdrTyping(none)).toBe(true);
  const mirror = { clients: new Set(["a"]), ready: true, process: {}, kind: "mirror" as const, cols: 120 };
  const seen = sightingFacts({ attachment: mirror, process: mirror.process, claim: undefined, member: true }, { attachment: mirror, claim: undefined }, "a");
  expect(seen).toMatchObject({ mirror: true, cols: 120 });
  mirror.cols = 90;
  expect(sightingFacts({ attachment: mirror, process: mirror.process, claim: undefined, member: true }, { attachment: mirror, claim: undefined }, "a").cols).toBe(90);
});
