import { useRef, useState } from "react";
import { ArrowUp, Copy, Pencil, X } from "lucide-react";
import type { PendingMessageView } from "../lib/pendingMessages.ts";
import { copyText } from "../lib/clipboard.ts";
import { openCodeRefusalNote, submitNote } from "../lib/compose.ts";
import { useT, type Vars } from "../lib/i18n.ts";
import "./PendingMessages.css";

interface Props {
  messages: PendingMessageView[];
  active?: boolean;
  connected: boolean;
  /** the pane's agent, which names the input a refusal is about */
  agent?: string | null;
  blocked: boolean;
  /** a terminal command's peek has the pane: the rows stay, taking no input */
  inert?: boolean;
  unsaved: boolean;
  isBusy: (id: string) => boolean;
  onSendNow: (id: string) => Promise<void>;
  onEdit: (id: string) => Promise<void>;
  onDiscard: (id: string) => Promise<void>;
}

/**
 * What a row says of its state. A held message waits for Send now only while this connection
 * holds it on the bridge: a copy restored from storage (another tab's live hold, or one from before
 * a reload) is reviewed first, since the tab that held it may still send it.
 */
export function pendingStatus(message: Pick<PendingMessageView, "state" | "error" | "serverOwned">, busy: boolean, t: (text: string, vars?: Vars) => string): string {
  if (busy) return t("Sending…");
  if (message.state === "queued") return t("Next turn");
  if (message.error?.code === "pi_transcript_pending") return t("Sent to Pi · waiting for transcript");
  if (message.error?.code === "transcript_unconfirmed" || message.error?.code === "pi_transcript_target_changed") return t("Sent to Pi · transcript confirmation unavailable");
  if (message.state === "held" && !message.error && message.serverOwned) return t("Waits for Send now");
  if (message.state === "uncertain") {
    // #511: a paste left in the terminal's input line says where it is
    if (message.error?.code === "pasted_not_sent") return submitNote(message.error.code, message.error.message);
    return (message.error ? openCodeRefusalNote(message.error.code, message.error.message, t) : null)
      ?? t("Not confirmed. Check the terminal before sending again.");
  }
  return t("Held message — review and send");
}

/** Pending text is separate from the transcript; Send now acts on its ID, never on its text. */
export function PendingMessages({ messages, active = true, connected, agent, blocked, inert = false, unsaved, isBusy, onSendNow, onEdit, onDiscard }: Props) {
  const t = useT();
  const activeRef = useRef(active);
  activeRef.current = active;
  const rootRef = useRef<HTMLOListElement | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const restoreFocus = (keyboard: boolean, target: HTMLButtonElement, stack: Element | null, owner: string | null): void => {
    const root = rootRef.current;
    if (!activeRef.current || !keyboard || target.isConnected || !stack?.isConnected || stack.getAttribute("data-pane-owner") !== owner) return;
    const next = root?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?? stack.querySelector<HTMLTextAreaElement>(".composer-text");
    next?.focus({ preventScroll: true });
  };
  return <ol ref={rootRef} className="pending-messages" aria-label={t("Queued messages")} inert={inert || undefined}>
    {unsaved && <li className="pending-message-note" role="status">{t("Queue could not be saved. Keep this tab open or copy the messages before reloading.")}</li>}
    {messages.map((message) => {
      const busy = isBusy(message.id) || message.state === "sending";
      const uncertain = message.state === "uncertain";
      const sent = message.error?.code === "pi_transcript_pending" || message.error?.code === "transcript_unconfirmed" || message.error?.code === "pi_transcript_target_changed";
      const status = pendingStatus(message, busy, t);
      return <li key={message.id} className="pending-message" data-state={message.state}>
        <div className="pending-message-bubble" aria-busy={busy || undefined}>{message.text}</div>
        <div className="pending-message-meta">
          <span className="pending-message-note" role="status">{status}</span>
          {!uncertain && !sent && <button type="button" className="icon-button pending-message-action pending-message-send"
            aria-label={`${t("Send now")}: ${message.text}`} aria-busy={busy || undefined} title={t("Send now")}
            disabled={!connected || blocked || busy} onClick={(event) => {
              const target = event.currentTarget, keyboard = event.detail === 0, stack = target.closest(".terminal-stack"), owner = stack?.getAttribute("data-pane-owner") ?? null;
              void onSendNow(message.id).finally(() => restoreFocus(keyboard, target, stack, owner));
            }}><ArrowUp aria-hidden="true" /><span>{t("Send now")}</span></button>}
          {!uncertain && !sent && message.serverOwned && <button type="button" className="icon-button pending-message-action"
            aria-label={`${t("Edit queued message")}: ${message.text}`} title={t("Edit queued message")}
            disabled={busy || message.resendInFlight || message.serverOwned && !connected} onClick={(event) => {
              const target = event.currentTarget, stack = target.closest(".terminal-stack"), owner = stack?.getAttribute("data-pane-owner");
              void onEdit(message.id).then(() => {
                if (activeRef.current && !target.isConnected && stack?.isConnected && stack.getAttribute("data-pane-owner") === owner)
                  stack.querySelector<HTMLTextAreaElement>(".composer-text")?.focus({ preventScroll: true });
              });
            }}><Pencil aria-hidden="true" /></button>}
          {(uncertain || sent) && <button type="button" className="icon-button pending-message-action" aria-label={copied === message.id ? t("Copied") : t("Copy message")}
            title={t("Copy message")} onClick={(event) => {
              const text = event.currentTarget.closest(".pending-message")?.querySelector<HTMLElement>(".pending-message-bubble");
              void copyText(message.text, text).then((ok) => { if (ok) setCopied(message.id); });
            }}><Copy aria-hidden="true" /></button>}
          {(!sent || message.error?.code !== "pi_transcript_pending") && <button type="button" className="icon-button pending-message-action" aria-label={uncertain || sent ? t("Discard saved copy") : t("Discard")}
            title={uncertain || sent ? t("Discard saved copy") : t("Discard")} disabled={busy || message.serverOwned && !connected}
            onClick={(event) => {
              const target = event.currentTarget, keyboard = event.detail === 0, stack = target.closest(".terminal-stack"), owner = stack?.getAttribute("data-pane-owner") ?? null;
              void onDiscard(message.id).finally(() => restoreFocus(keyboard, target, stack, owner));
            }}><X aria-hidden="true" /></button>}
        </div>
        {message.error && !uncertain && !sent && <p className="pending-message-note" role="status">{message.error.code === "still_open" ? message.error.message
          : (message.error.code === "input_draft" || message.error.code === "held_input" || message.error.code === "not_transmitted" || message.error.code === "capabilities_unknown" || message.error.code === "rewind_dialog_open" || message.error.code === "first_message_unattended" || message.error.code === "first_message_launch_ended" || message.error.code === "pending_target_changed") ? submitNote(message.error.code, message.error.message, agent) : t("Not sent: {message}", { message: message.error.message })}</p>}
      </li>;
    })}
  </ol>;
}
