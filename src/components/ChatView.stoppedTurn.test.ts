import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { endsWithTurn, stoppedTurn } from "../lib/compose.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";

// ChatView's own send effects and turn selection, run in a small hook host: rendering the whole
// chat needs a socket, a transcript reader and a layout this record does not depend on.
const source = readFileSync(join(import.meta.dir, "ChatView.tsx"), "utf8");
const sentEffect = source.match(/useEffect\(\(\) => \{\s*if \(seenSent\.current === sentKey\) return;[\s\S]*?\}, \[sentKey, agentStatus\]\);/)?.[0];
const unsentEffect = source.match(/useEffect\(\(\) => \{\s*if \(seenUnsent\.current === unsentKey\) return;[\s\S]*?\}, \[unsentKey\]\);/)?.[0];
const selection = source.match(/const stopped = useMemo\(\(\) => stoppedTurn\(turns, restored\)[\s\S]*?const shownTurns = useMemo\([^\n]*\n/)?.[0];
if (!sentEffect || !unsentEffect || !selection) throw new Error("ChatView's send effects or turn selection moved");
const body = new Bun.Transpiler({ loader: "ts" }).transformSync(`
  const { turns, restored, sentKey, unsentKey } = props;
  const agentStatus = "idle", pendingRows = [], goingCancel = null;
  const seenSent = useRef(0), seenUnsent = useRef(0), heldPage = useRef(turns), lastStopped = useRef(null);
  const [cancelledAtSend, setCancelledAtSend] = useState(null);
  const [, setSentOver] = useState(null);
  ${sentEffect}
  ${unsentEffect}
  ${selection}
  heldPage.current = turns;
  props.capture(shownTurns);
  return null;
`);
type Props = { turns: ConversationTurn[]; restored: string | null; sentKey: number; unsentKey: number; capture: (shown: ConversationTurn[]) => void };
const Harness = new Function("useState", "useEffect", "useMemo", "useRef", "stoppedTurn", "endsWithTurn", `return function Harness(props) { ${body} }`)(
  useState, useEffect, useMemo, useRef, stoppedTurn, endsWithTurn) as (props: Props) => null;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const earlier: ConversationTurn = { role: "assistant", ts: "2026-10-31T23:59:00Z", parts: [{ kind: "text", text: "earlier" }] };
const stopped: ConversationTurn = { role: "user", ts: "2026-11-01T00:00:00Z", parts: [{ kind: "text", text: "stopped message" }] };
const page = [earlier, stopped];

async function host() {
  let shown: ConversationTurn[] = [];
  let tree: ReactTestRenderer | undefined;
  const capture = (value: ConversationTurn[]) => { shown = value; };
  const render = async (props: Omit<Props, "capture">) => {
    await act(() => { if (tree) tree.update(createElement(Harness, { ...props, capture })); else tree = create(createElement(Harness, { ...props, capture })); });
    return shown;
  };
  return { render, unmount: () => act(() => tree?.unmount()) };
}

it("shows the stopped turn again once its copy leaves the box after a send refused with nothing typed", async () => {
  const chat = await host();
  expect(await chat.render({ turns: page, restored: "stopped message", sentKey: 0, unsentKey: 0 })).toEqual([earlier]);
  // the composer bumps sentKey before the bridge answers; it refuses, nothing was typed
  await chat.render({ turns: page, restored: "stopped message", sentKey: 1, unsentKey: 0 });
  expect(await chat.render({ turns: page, restored: "stopped message", sentKey: 1, unsentKey: 1 })).toEqual([earlier]);
  // the user clears the copy in the terminal: the turn is the transcript's last again, and shown
  expect(await chat.render({ turns: page, restored: null, sentKey: 1, unsentKey: 1 })).toEqual(page);
  await chat.unmount();
});

it("keeps the stopped turn out after a send that went, while it is still the last turn", async () => {
  const chat = await host();
  await chat.render({ turns: page, restored: "stopped message", sentKey: 0, unsentKey: 0 });
  await chat.render({ turns: page, restored: "stopped message", sentKey: 1, unsentKey: 0 });
  // the send emptied the box before its own turn reached the transcript
  expect(await chat.render({ turns: page, restored: null, sentKey: 1, unsentKey: 0 })).toEqual([earlier]);
  await chat.unmount();
});
