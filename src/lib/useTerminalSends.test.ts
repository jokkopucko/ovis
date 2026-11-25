import { expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useTerminalSends, type TerminalSendsDeps } from "./useTerminalSends.ts";
import type { SubmitDelivery, SubmitResult } from "./ws.ts";

it.each([
  ["immediate", "sent", false, 1],
  ["queue", "sent", false, 0],
  ["hold", "sent", false, 0],
  ["immediate", "offline", false, 0],
  ["immediate", "sent", true, 0],
  ["immediate", "refused", false, 0],
] as const)("only interrupts a pending Stop on a dispatched immediate submission (%s, %s, held=%s)", async (
  delivery: SubmitDelivery, outcome: "sent" | "offline" | "refused", held: boolean, expected: number,
) => {
  const onImmediateSubmit = mock(() => {});
  const submit = mock((...args: Parameters<NonNullable<TerminalSendsDeps["socketRef"]["current"]>["submit"]>): Promise<SubmitResult> | null =>
    outcome === "offline" ? null : Promise.resolve().then(() => {
      if (outcome === "refused") return { ok: false, code: "agent_only_unsupported", message: "Nothing was sent" };
      args[12]?.();
      return { ok: false, code: "agent_blocked", message: "The agent still has work" };
    }));
  const pane = `stop-test-${delivery}`;
  const f = () => {};
  const deps = {
    machineId: "local",
    onChatSuggestion: f,
    onImmediateSubmit,
    paneRef: { current: pane },
    draftHeldForRef: { current: held ? pane : null },
    heldRef: { current: false },
    pendingEpochRef: { current: 1 },
    pendingSubmissionsRef: { current: new Set() },
    redrawGreeting: f,
    releaseRef: { current: f },
    secretRef: { current: null },
    sessionRef: { current: { epoch: 1 } },
    setChatSent: f,
    setChatUnsent: f,
    socketRef: { current: { submit } },
    submitRetention: null,
    termRef: { current: { modes: { bracketedPasteMode: false }, scrollToBottom: f } },
  } as unknown as TerminalSendsDeps;
  let send!: ReturnType<typeof useTerminalSends>["submitComposerMessage"];
  function Probe() {
    send = useTerminalSends(deps).submitComposerMessage;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const result = send("Follow up", delivery);
  expect(onImmediateSubmit).not.toHaveBeenCalled();
  await result;
  expect(onImmediateSubmit).toHaveBeenCalledTimes(expected);
  expect(submit).toHaveBeenCalledTimes(held ? 0 : 1);
});
