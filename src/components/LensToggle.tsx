import { MessageCircle, Monitor, SquareTerminal } from "lucide-react";
import type { PaneView } from "../lib/actions.ts";
import { useT } from "../lib/i18n.ts";

export function LensToggle({ view, peek, terminalAttach, title, onToggle, thread = false, round = false }: {
  view: PaneView;
  peek: boolean;
  terminalAttach: boolean;
  title: (label: string) => string;
  onToggle: () => void;
  thread?: boolean;
  round?: boolean;
}) {
  const t = useT();
  const shown: PaneView = peek ? "terminal" : view;
  const toTerminal = shown === "chat";
  const label = thread ? t(toTerminal ? "Show the terminal" : "Show the chat") : t(toTerminal ? "Switch to terminal" : "Switch to chat");
  const TerminalGlyph = thread ? Monitor : SquareTerminal;
  // a Windows PC's live terminal is not there yet: the button says so, as the wide switch's pill does
  const soon = toTerminal && !terminalAttach;
  return (
    <button type="button" className={`icon-button${round ? " inbox-round" : thread ? "" : " is-outlined"} lens-toggle`} data-view={shown}
      aria-label={soon ? `${label} · ${t("soon")}` : label}
      title={soon ? t("Live terminal: coming to Windows PCs once herdr can attach there") : title(label)}
      onClick={onToggle}>
      {toTerminal ? <TerminalGlyph aria-hidden="true" /> : <MessageCircle aria-hidden="true" />}
    </button>
  );
}
