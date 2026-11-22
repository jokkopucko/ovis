import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, User, X } from "lucide-react";

import "./CommandPalette.css";
import "./ConversationSearch.css";

import type { ConversationSearchMatch } from "../../shared/conversation-search.ts";
import { MAX_SEARCH_QUERY } from "../../shared/conversation-search.ts";
import { ApiError, routeMissing } from "../lib/api.ts";
import { formatChatTimestamp } from "../lib/chatTimestamp.ts";
import { currentLocale, useT } from "../lib/i18n.ts";
import { useLocalDay } from "../lib/localDay.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { AgentMark } from "./AgentMark.tsx";

const MIN_QUERY = 2;
const TYPING_MS = 250;
const MAX_RESULTS = 200;

export type RevealResult = "shown" | "missing" | "failed";

interface Search {
  query: string;
  matches: ConversationSearchMatch[];
  state: "searching" | "done" | "capped" | "failed" | "unsupported" | "changed";
}

interface ConversationSearchProps {
  paneId: string;
  agent: string | null;
  historyId: string | undefined;
  title?: string | null;
  onClose: () => void;
  onPick: (match: ConversationSearchMatch) => Promise<RevealResult>;
}

/**
 * The Codex app's Find in chat searches the same parts on its server; this lists the matches instead
 * of stepping through them, and marks nothing in the chat.
 */
export function ConversationSearch({ paneId, agent, historyId, title = null, onClose, onPick }: ConversationSearchProps) {
  const t = useT();
  const today = useLocalDay();
  const { searchPaneConversation } = useMachineApi();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<Search | null>(null);
  const [active, setActive] = useState(0);
  const [retry, setRetry] = useState(0);
  const [picking, setPicking] = useState<{ index: number; result: RevealResult | null } | null>(null);
  const pickSerial = useRef(0);
  const surface = useFocusTrap<HTMLElement>(true, { initialFocus: inputRef });
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });

  useLayoutEffect(() => {
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [onClose]);

  useEffect(() => {
    const words = query.trim();
    setActive(0);
    setPicking(null);
    pickSerial.current += 1;
    if (words.length < MIN_QUERY) { setSearch(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => void (async () => {
      const matches: ConversationSearchMatch[] = [];
      let before: string | undefined;
      let history = historyId;
      setSearch({ query: words, matches, state: "searching" });
      try {
        for (;;) {
          const answer = await searchPaneConversation(paneId, words, { before, historyId: history, signal: controller.signal });
          if (controller.signal.aborted) return;
          matches.push(...answer.matches);
          history = answer.history_id ?? history;
          const state = matches.length > MAX_RESULTS || (matches.length === MAX_RESULTS && answer.cursor !== null) ? "capped" : answer.cursor === null ? "done" : "searching";
          setSearch({ query: words, matches: matches.slice(0, MAX_RESULTS), state });
          if (state !== "searching" || answer.cursor === null) return;
          before = answer.cursor;
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        const state = routeMissing(cause) ? "unsupported" : cause instanceof ApiError && cause.status === 409 ? "changed" : "failed";
        setSearch({ query: words, matches: matches.slice(0, MAX_RESULTS), state });
      }
    })(), TYPING_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, paneId, historyId, retry, searchPaneConversation]);

  const matches = search?.matches ?? [];
  const pick = (index: number): void => {
    const match = matches[index];
    if (match === undefined || (picking !== null && picking.result === null)) return;
    setActive(index);
    setPicking({ index, result: null });
    const serial = ++pickSerial.current;
    void onPick(match).then((result) => {
      if (pickSerial.current !== serial) return;
      if (result === "shown") onClose();
      else setPicking({ index, result });
    });
  };
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    // the IME's own Enter and arrows pick a candidate
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowDown" && matches.length > 0) {
      event.preventDefault();
      setActive((index) => (index + 1) % matches.length);
    } else if (event.key === "ArrowUp" && matches.length > 0) {
      event.preventDefault();
      setActive((index) => (index - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter" && matches.length > 0) {
      event.preventDefault();
      pick(Math.min(active, matches.length - 1));
    }
  };
  useLayoutEffect(() => {
    document.getElementById(`conversation-search-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const status = search === null ? (query.trim().length > 0 ? t("Type at least {n} characters.", { n: MIN_QUERY }) : t("Finds a word in what you wrote and in the answers, earlier messages included."))
    : search.state === "unsupported" ? t("This PC's bridge cannot search conversations yet. Update it to search here.")
    : search.state === "changed" ? t("The conversation was replaced while it was searched.")
    : search.state === "failed" ? t("Couldn't search the conversation.")
    : search.state === "searching" ? t("Searching earlier messages…")
    : search.state === "capped" ? t("Showing the newest {n} matches.", { n: MAX_RESULTS })
    : matches.length === 0 ? t("No message or answer holds this.")
    : t("Searched the whole conversation.");
  const paneName = title !== null && title.trim() !== "" && title.trim() !== paneId ? title.trim() : null;
  const pickLine = picking === null ? null
    : picking.result === null ? t("Loading earlier messages…")
    : picking.result === "missing" ? t("This message is no longer in the conversation.")
    : t("Couldn't load the earlier messages.");
  const listShows = pickLine === null && matches.length === 0;
  const footerLine = listShows ? "" : pickLine ?? status;
  const canRetry = search !== null && (search.state === "failed" || search.state === "changed");

  return createPortal(
    <div className="modal-scrim palette-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={surface} className="menu command-palette conversation-search" role="dialog" aria-modal="true" aria-label={t("Search conversation")}>
        <div className="palette-search">
          <input ref={inputRef} className="input" type="search" value={query} maxLength={MAX_SEARCH_QUERY} placeholder={paneName === null ? t("Search messages and answers…") : t("Search in {pane}…", { pane: paneName })} aria-label={t("Search conversation")}
            aria-controls="conversation-search-results" aria-activedescendant={matches.length > 0 ? `conversation-search-${Math.min(active, matches.length - 1)}` : undefined}
            onKeyDown={onInputKeyDown} onChange={(event) => setQuery(event.target.value)} />
          <button type="button" className="icon-button" aria-label={t("Close search")} title={t("Close search")} onClick={onClose}><X /></button>
        </div>
        <div className="palette-results" id="conversation-search-results" role="listbox" aria-label={t("Matching messages")}>
          {matches.map((match, index) => {
            const stamp = formatChatTimestamp(match.ts, today, currentLocale(), t);
            const opening = picking?.index === index && picking.result === null;
            return (
              <button key={`${match.turn}|${index}`} id={`conversation-search-${index}`} type="button" role="option" className="menu-item conversation-search-row" aria-selected={active === index} aria-busy={opening || undefined}
                onMouseMove={() => setActive(index)} onClick={() => pick(index)}>
                <span className="conversation-search-who">{match.role === "user" ? <User aria-label={t("You")} /> : <AgentMark agent={agent ?? "agent"} size={16} />}</span>
                <span className="menu-item-main">
                  <span className="conversation-search-snippet">{match.before}<mark>{match.match}</mark>{match.after}</span>
                  {stamp !== null && <span className="palette-row-subtitle" title={stamp.full}>{stamp.label}</span>}
                </span>
                {opening && <LoaderCircle className="conversation-search-busy" aria-hidden="true" />}
              </button>
            );
          })}
          {matches.length === 0 && <p className="palette-empty">{status}</p>}
        </div>
        {/* with no match the list says it; the line under it tells a pick and the search's progress.
            With nothing to tell and no retry the band takes no room (the input stays at the top), but
            stays mounted: the dialog's one live region is there before the first status, so each one
            is announced, the list's own included */}
        <footer className={`palette-footer conversation-search-footer${footerLine === "" && !canRetry ? " is-empty" : ""}`}>
          <p className={`conversation-search-status${listShows ? " visually-hidden" : ""}`} role="status">{pickLine ?? status}</p>
          {canRetry && <button type="button" className="btn" onClick={() => setRetry((count) => count + 1)}>{t("Try again")}</button>}
        </footer>
      </section>
    </div>,
    document.body,
  );
}
