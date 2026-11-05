import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { MessageSquarePlus, MessageSquareQuote, Quote, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { quoteFits, quoteIntoComposer } from "../lib/chatQuote.ts";
import { composerDraftKey, composerDrafts } from "../lib/composerDraft.ts";
import { chatSelectionClipboardPayload } from "../lib/markdownClipboard.ts";
import { replyComments, type ReplyComment } from "../lib/replyComments.ts";
import "./ReplyComments.css";

/**
 * Where a selection running past a reply's last word into nothing more is read up to: a triple-click
 * ends at the start of what follows the words (the copy row, a work block), a drag past the last
 * word at the reply's end, over its copy row and time. `cut`: the text after the words a selection
 * of the whole carries (the copy row's labels where they are selectable, the time), to take off the
 * end of what it reads. Null: the range is read as it is (no words before, nothing past them, or
 * more than the copy row past them: a work block, another part of the reply).
 */
function wordsEnd(range: Range, turn: Element): { range: Range; cut: string[] } | null {
  const words = [...turn.children].filter((child) => child.classList.contains("markdown") && range.intersectsNode(child)).at(-1);
  if (words === undefined || range.comparePoint(words, words.childNodes.length) !== 0) return null;
  const tail = document.createRange();
  tail.setStart(words, words.childNodes.length);
  tail.setEnd(range.endContainer, range.endOffset);
  if (tail.collapsed) return null;
  // the copy row's buttons take no words; at the reply's end its time may be taken too. A work block's
  // title is a button as well, and is words of the turn: never passed over
  const meta = turn.querySelector(":scope > .chat-turn-meta");
  const atEnd = range.endContainer === turn && range.endOffset >= turn.childNodes.length;
  const cut: string[] = [];
  // from the first node after the words to the range's end: never the words themselves
  let last: Node = words;
  while (last.lastChild !== null) last = last.lastChild;
  const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
  walker.currentNode = last;
  for (let node = walker.nextNode() as Text | null; node !== null && tail.comparePoint(node, 0) <= 0; node = walker.nextNode() as Text | null) {
    const taken = node.data.slice(0, node === tail.endContainer ? tail.endOffset : node.length);
    if (taken.trim() === "") continue;
    // anything taken past the words but the copy row (a work block's title, selectable or not) is more than nothing
    const copyRow = meta?.contains(node) === true && (atEnd || node.parentElement?.closest("button, [role=button]") != null);
    if (!copyRow) return null;
    // what a copy of the selection carries: selectable and drawn (a mouse's copy row hides its MD and TXT)
    if (selectable(node.parentElement) && drawn(node.parentElement)) cut.push(taken);
  }
  const trimmed = range.cloneRange();
  trimmed.setEnd(words, words.childNodes.length);
  return { range: trimmed, cut };
}

/** Drawn on the page: a copy of the selection leaves out what is not (`display: none`, hidden). */
function drawn(element: Element | null): boolean {
  return element !== null && element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
}

/** `user-select: none` is not inherited as a computed value (a label inside a button reads `auto`): each ancestor is asked. */
function selectable(element: Element | null): boolean {
  for (let at = element; at !== null; at = at.parentElement) if (getComputedStyle(at).userSelect === "none") return false;
  return true;
}

/**
 * The selected text, as a copy carries it, when the selection lies in the words of one agent reply
 * in `root`: never across a work block, the reply's copy row, a user message, another pane or a field.
 * One running past the reply's last word into nothing more (wordsEnd) is read up to it: the copy's
 * text, its line breaks and a tool file's path as written kept, without what was taken past the words.
 */
export function replySelectionText(selection: Selection | null, root: Element): string | null {
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const selected = selection.getRangeAt(0);
  const element = (node: Node): Element | null => node instanceof Element ? node : node.parentElement;
  const start = element(selected.startContainer), end = element(selected.endContainer);
  if (start === null || end === null || !root.contains(start) || !root.contains(end)) return null;
  if (start.closest("input, textarea, [contenteditable=true]") !== null) return null;
  const turn = start.closest(".chat-turn-agent");
  if (turn === null || turn !== end.closest(".chat-turn-agent")) return null;
  const past = wordsEnd(selected, turn);
  const range = past?.range ?? selected;
  // every part of the reply the range touches is its words: a work block, a skill or goal line or the meta row is not
  for (const child of turn.children) if (range.intersectsNode(child) && !child.classList.contains("markdown")) return null;
  let text = chatSelectionClipboardPayload(selection, root)?.text ?? selection.toString();
  // the copy row's text comes last in the copy, in order: taken off its end, and nothing once one is not there
  for (const piece of (past?.cut ?? []).reverse()) {
    text = text.trimEnd();
    if (!text.endsWith(piece.trim())) break;
    text = text.slice(0, text.length - piece.trim().length);
  }
  return text.trim() === "" ? null : text;
}

const EDGE = 8;
/** below a touch selection: clear of its handles, while the system's own menu stands above it */
const HANDLE_ROOM = 28;
const OFFER_W = 148;
const OFFER_H = 36;
const FORM_W = 360;
/** a frame narrower than this docks the form along its bottom edge, where a phone's keyboard meets it */
const DOCK_BELOW = 560;

interface Placed { quote: string; left: number; top: number }

/**
 * The actions on a selection in a chat's reply. It floats over the transcript, so a selection in
 * progress never moves what is under it (#1922); with a mouse it stands where the button was
 * released, on a touch screen below the selection. Quote, first, puts the words in the composer as a
 * `> ` quote (lib/chatQuote.ts); Comment (#511) opens a form that saves a comment for the next message.
 */
export function ReplyCommentAction({ scroller, storageKey, paneKey }: { scroller: RefObject<HTMLDivElement | null>; storageKey: string; paneKey: string | null }) {
  const t = useT();
  const layer = useRef<HTMLDivElement>(null);
  const [offer, setOffer] = useState<Placed | null>(null);
  const [form, setForm] = useState<(Placed & { docked: boolean }) | null>(null);
  const [comment, setComment] = useState("");
  const pointer = useRef<{ x: number; y: number; touch: boolean } | null>(null);
  const dragging = useRef(false);
  // a press on the action: a touch that clears the selection on its way down still comments on it
  const pressing = useRef(false);
  const quoteNote = useId();
  const formOpen = useRef(false);
  formOpen.current = form !== null;

  const place = useCallback(() => {
    if (formOpen.current) return;
    const root = scroller.current, host = layer.current;
    const selection = getSelection();
    const quote = root === null || host === null ? null : replySelectionText(selection, root);
    if (quote === null || selection === null || host === null || dragging.current) {
      if (!pressing.current) setOffer(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
    const last = rects.at(-1) ?? range.getBoundingClientRect();
    const first = rects[0] ?? last;
    const box = host.getBoundingClientRect();
    const touch = pointer.current?.touch ?? matchMedia("(pointer: coarse)").matches;
    const mouse = !touch && pointer.current !== null ? pointer.current : null;
    let top = mouse !== null ? mouse.y + EDGE : last.bottom + (touch ? HANDLE_ROOM : EDGE);
    if (top + OFFER_H > box.bottom - EDGE) top = first.top - OFFER_H - (touch ? HANDLE_ROOM : EDGE);
    const x = mouse !== null ? mouse.x : last.right;
    const left = Math.min(Math.max(x - box.left - OFFER_W / 2, EDGE), Math.max(box.width - OFFER_W - EDGE, EDGE));
    setOffer({ quote, left, top: Math.min(Math.max(top - box.top, EDGE), Math.max(box.height - OFFER_H - EDGE, EDGE)) });
  }, [scroller]);

  // on the document, the scroller looked up as each event comes: the chat's timeline can arrive after this mounts
  useEffect(() => {
    const inChat = (target: EventTarget | null): boolean => target instanceof Node && scroller.current?.contains(target) === true;
    const down = (event: PointerEvent) => {
      if (!inChat(event.target)) return;
      dragging.current = event.pointerType === "mouse" && event.button === 0;
      pointer.current = null;
    };
    const up = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY, touch: event.pointerType !== "mouse" };
      if (!dragging.current) return;
      dragging.current = false;
      // the selection a click leaves is settled only after the up: read it then
      requestAnimationFrame(place);
    };
    // scroll does not bubble: caught on its way down, only the chat's own
    const scrolled = (event: Event) => { if (event.target === scroller.current) place(); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up);
    document.addEventListener("selectionchange", place);
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("selectionchange", place);
      document.removeEventListener("scroll", scrolled, { capture: true });
    };
  }, [scroller, place]);

  const open = (placed: Placed) => {
    pressing.current = false;
    const host = layer.current;
    const width = host?.clientWidth ?? 0;
    const height = host?.clientHeight ?? 0;
    const docked = width < DOCK_BELOW;
    const left = docked ? EDGE : Math.min(placed.left, Math.max(width - FORM_W - EDGE, EDGE));
    setOffer(null);
    setComment("");
    setForm({ ...placed, left, top: Math.min(placed.top, Math.max(height - 220, EDGE)), docked });
  };
  const quote = (placed: Placed) => {
    pressing.current = false;
    if (paneKey === null || !quoteFits(composerDrafts.read(composerDraftKey(paneKey)).text, placed.quote)) return;
    setOffer(null);
    // cleared before the composer takes the keyboard: clearing after would take its caret too
    getSelection()?.removeAllRanges();
    quoteIntoComposer(paneKey, placed.quote);
  };
  // the draft, read again as it changes (a send settling, another tab): whether the quote fits follows it
  const draft = useSyncExternalStore(composerDrafts.subscribe, () => paneKey === null ? "" : composerDrafts.read(composerDraftKey(paneKey)).text);
  // a secret prompt stands in the composer's place (paneKey null): Comment alone, which waits for the next message
  const fits = offer !== null && paneKey !== null && quoteFits(draft, offer.quote);
  const close = () => { setForm(null); setComment(""); };
  const save = () => {
    if (form === null || comment.trim() === "") return;
    if (!replyComments.add(storageKey, form.quote, comment)) return;
    getSelection()?.removeAllRanges();
    close();
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); }
    else if (event.key === "Escape" && comment === "") { event.preventDefault(); close(); }
  };

  return <div className="reply-comment-layer" ref={layer}>
    {/* outside the pill, on the chat's far side from it (at the foot, over the jump control's room); drawn first, so the pill stays over it */}
    {offer !== null && form === null && paneKey !== null && !fits && <p id={quoteNote} className={`selection-note${offer.top < (layer.current?.clientHeight ?? 0) / 2 ? " is-below" : ""}`} role="status">{t("Too long to quote: shorten the message or the selection.")}</p>}
    {offer !== null && form === null && <div className="selection-offer" role="group" aria-label={t("Selection")} style={{ left: offer.left, top: offer.top }}
      // a mouse press keeps the selection; a touch's is read from the offer it showed
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={() => { pressing.current = true; }}
      onPointerCancel={() => { pressing.current = false; }}>
      {/* too long, it stays focusable and says why in words, for a touch or a keyboard that has no hover */}
      {paneKey !== null && <button type="button" className="selection-quote" aria-disabled={!fits || undefined}
        aria-describedby={fits ? undefined : quoteNote} title={fits ? t("Quote it in your message") : undefined} onClick={() => quote(offer)}>
        <Quote aria-hidden="true" />{t("Quote")}
      </button>}
      <button type="button" className="reply-comment-offer" aria-label={t("Comment")} title={t("Comment")} onClick={() => open(offer)}>
        <MessageSquarePlus aria-hidden="true" />
      </button>
    </div>}
    {form !== null && <ReplyCommentForm form={form} comment={comment} onComment={setComment} onKeyDown={keyDown} onSave={save} onCancel={close} />}
  </div>;
}

function ReplyCommentForm({ form, comment, onComment, onKeyDown, onSave, onCancel }: {
  form: Placed & { docked: boolean }; comment: string; onComment: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void; onSave: () => void; onCancel: () => void;
}) {
  const t = useT();
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { field.current?.focus({ preventScroll: true }); }, []);
  return <form className={`reply-comment-form${form.docked ? " is-docked" : ""}`} style={form.docked ? undefined : { left: form.left, top: form.top }}
    aria-label={t("Comment on the reply")} onSubmit={(event) => { event.preventDefault(); onSave(); }}>
    <blockquote className="reply-comment-quote">{form.quote}</blockquote>
    <textarea ref={field} className="reply-comment-field" rows={2} value={comment} placeholder={t("Add a comment")}
      aria-label={t("Comment")} onChange={(event) => onComment(event.target.value)} onKeyDown={onKeyDown} />
    <div className="reply-comment-actions">
      <button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>
      <button type="submit" className="btn btn-primary" disabled={comment.trim() === ""}>{t("Save")}</button>
    </div>
  </form>;
}

/**
 * The comments waiting for the pane's next message, as one chip over the input card: it opens their
 * list, where each can be removed, and its X removes them all. `waiting`: the message in the box
 * goes without them (a slash command, an answer to the agent's question).
 */
export function ReplyCommentsChip({ comments, storageKey, waiting }: { comments: readonly ReplyComment[]; storageKey: string; waiting: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!(event.target instanceof Node && root.current?.contains(event.target))) setOpen(false); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  if (comments.length === 0) return null;
  const count = comments.length;
  // a note on a diff line is no comment on the reply: then the chip counts comments alone
  const onReply = comments.every((item) => item.source === undefined);
  const label = waiting
    ? count === 1 ? t("1 comment waiting") : t("{count} comments waiting", { count })
    : !onReply ? count === 1 ? t("1 comment") : t("{count} comments", { count })
    : count === 1 ? t("1 comment on the reply") : t("{count} comments on the reply", { count });
  return <div className="composer-quick reply-comments" ref={root}>
    <div className={`reply-comments-chip${waiting ? " is-waiting" : ""}`}>
      <button type="button" className="reply-comments-open" aria-expanded={open}
        title={waiting ? t("They go with your next message, not with this one") : t("They go first in your next message, each as a quote")}
        onClick={() => setOpen((value) => !value)}>
        <MessageSquareQuote aria-hidden="true" /><span>{label}</span>
      </button>
      <button type="button" className="reply-comments-clear" aria-label={t("Remove all comments")} title={t("Remove all comments")}
        onClick={() => { setOpen(false); replyComments.clear(storageKey); }}>
        <X aria-hidden="true" />
      </button>
    </div>
    {open && <div className="reply-comments-list" role="dialog" aria-label={t("Comments on the reply")}>
      <ol>
        {comments.map((item) => <li key={item.id}>
          <blockquote className="reply-comment-quote">{item.quote}</blockquote>
          <p>{item.comment}</p>
          <button type="button" className="reply-comments-remove" aria-label={t("Remove comment")} title={t("Remove comment")}
            onClick={() => replyComments.remove(storageKey, item.id)}>
            <X aria-hidden="true" />
          </button>
        </li>)}
      </ol>
    </div>}
  </div>;
}

/** The pane's waiting comments, read again whenever any tab changes them. */
export function useReplyComments(storageKey: string): readonly ReplyComment[] {
  return useSyncExternalStore(replyComments.subscribe, () => replyComments.read(storageKey));
}
