import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { MessageSquarePlus, MessageSquareQuote, Quote, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { quoteFits, quoteIntoComposer } from "../lib/chatQuote.ts";
import { composerDraftKey, composerDrafts } from "../lib/composerDraft.ts";
import { chatSelectionClipboardPayload } from "../lib/markdownClipboard.ts";
import { replyComments, type ReplyComment } from "../lib/replyComments.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import "./ReplyComments.css";

/**
 * Where a selection running past a reply's last word into nothing more is read up to: a triple-click
 * ends at the start of what follows the words (the copy row, a work block), a drag past the last
 * word at the reply's end, over its copy row and time.
 */
function wordsEnd(range: Range, turn: Element): { range: Range; cut: string[] } | null {
  const words = [...turn.children].filter((child) => child.classList.contains("markdown") && range.intersectsNode(child)).at(-1);
  if (words === undefined || range.comparePoint(words, words.childNodes.length) !== 0) return null;
  const tail = document.createRange();
  tail.setStart(words, words.childNodes.length);
  tail.setEnd(range.endContainer, range.endOffset);
  if (tail.collapsed) return null;
  const meta = turn.querySelector(":scope > .chat-turn-meta");
  const atEnd = range.endContainer === turn && range.endOffset >= turn.childNodes.length;
  const cut: string[] = [];
  let last: Node = words;
  while (last.lastChild !== null) last = last.lastChild;
  const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
  walker.currentNode = last;
  for (let node = walker.nextNode() as Text | null; node !== null && tail.comparePoint(node, 0) <= 0; node = walker.nextNode() as Text | null) {
    const taken = node.data.slice(0, node === tail.endContainer ? tail.endOffset : node.length);
    if (taken.trim() === "") continue;
    const copyRow = meta?.contains(node) === true && (atEnd || node.parentElement?.closest("button, [role=button]") != null);
    if (!copyRow) return null;
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
  for (const child of turn.children) if (range.intersectsNode(child) && !child.classList.contains("markdown")) return null;
  let text = chatSelectionClipboardPayload(selection, root)?.text ?? selection.toString();
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
const DOCK_BELOW = 560;

interface Placed { quote: string; left: number; top: number }

const replyCommentDrafts = new Map<string, string>();

function replyCommentDraftKey(storageKey: string, quote: string): string {
  return `${storageKey}\n${quote}`;
}

function readReplyCommentDraft(storageKey: string, quote: string): string {
  const key = replyCommentDraftKey(storageKey, quote);
  const mem = replyCommentDrafts.get(key);
  if (mem !== undefined) return mem;
  try {
    return window.sessionStorage?.getItem(`ovis:reply-comment-draft:${key}`) ?? "";
  } catch {
    return "";
  }
}

function writeReplyCommentDraft(storageKey: string, quote: string, text: string): void {
  const key = replyCommentDraftKey(storageKey, quote);
  if (text === "") {
    replyCommentDrafts.delete(key);
    try { window.sessionStorage?.removeItem(`ovis:reply-comment-draft:${key}`); } catch {}
    return;
  }
  replyCommentDrafts.set(key, text);
  try { window.sessionStorage?.setItem(`ovis:reply-comment-draft:${key}`, text); } catch {}
}

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
    const composer = host.closest(".pane-frame")?.querySelector(".composer")?.getBoundingClientRect();
    const bottom = composer !== undefined && composer.height > 0 ? Math.min(box.bottom, composer.top) : box.bottom;
    const height = Math.max(OFFER_H, host.querySelector<HTMLElement>(".selection-offer")?.offsetHeight ?? 0);
    let top = mouse !== null ? mouse.y + EDGE : last.bottom + (touch ? HANDLE_ROOM : EDGE);
    if (top + height > bottom - EDGE) top = first.top - height - (touch ? HANDLE_ROOM : EDGE);
    const x = mouse !== null ? mouse.x : last.right;
    const left = Math.min(Math.max(x - box.left - OFFER_W / 2, EDGE), Math.max(box.width - OFFER_W - EDGE, EDGE));
    setOffer({ quote, left, top: Math.min(Math.max(top - box.top, EDGE), Math.max(bottom - box.top - height - EDGE, EDGE)) });
  }, [scroller]);
  const offerShown = offer !== null;
  useLayoutEffect(() => { if (offerShown) place(); }, [offerShown, place]);

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
    setComment(readReplyCommentDraft(storageKey, placed.quote));
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
  const draft = useSyncExternalStore(composerDrafts.subscribe, () => paneKey === null ? "" : composerDrafts.read(composerDraftKey(paneKey)).text);
  // a secret prompt stands in the composer's place (paneKey null): Comment alone, which waits for the next message
  const fits = offer !== null && paneKey !== null && quoteFits(draft, offer.quote);
  const updateComment = (value: string) => {
    setComment(value);
    if (form !== null) writeReplyCommentDraft(storageKey, form.quote, value);
  };
  const close = () => {
    if (form !== null) writeReplyCommentDraft(storageKey, form.quote, comment);
    formOpen.current = false;
    setForm(null);
    setComment("");
    requestAnimationFrame(() => {
      place();
      layer.current?.querySelector<HTMLElement>(".reply-comment-offer")?.focus({ preventScroll: true });
    });
  };
  const save = () => {
    if (form === null || comment.trim() === "") return;
    if (!replyComments.add(storageKey, form.quote, comment)) return;
    writeReplyCommentDraft(storageKey, form.quote, "");
    getSelection()?.removeAllRanges();
    formOpen.current = false;
    setForm(null);
    setComment("");
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  };

  return <div className="reply-comment-layer" ref={layer}>
    {offer !== null && form === null && paneKey !== null && !fits && <p id={quoteNote} className={`selection-note${offer.top < (layer.current?.clientHeight ?? 0) / 2 ? " is-below" : ""}`} role="status">{t("Too long to quote: shorten the message or the selection.")}</p>}
    {offer !== null && form === null && <div className="selection-offer" role="group" aria-label={t("Selection")} style={{ left: offer.left, top: offer.top }}
      // a mouse press keeps the selection; a touch's is read from the offer it showed
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={() => { pressing.current = true; }}
      onPointerCancel={() => { pressing.current = false; }}>
      {paneKey !== null && <button type="button" className="selection-quote" aria-disabled={!fits || undefined}
        aria-describedby={fits ? undefined : quoteNote} title={fits ? t("Quote it in your message") : undefined} onClick={() => quote(offer)}>
        <Quote aria-hidden="true" />{t("Quote")}
      </button>}
      <button type="button" className="reply-comment-offer" aria-label={t("Comment")} title={t("Comment")} onClick={() => open(offer)}>
        <MessageSquarePlus aria-hidden="true" />
      </button>
    </div>}
    {form !== null && <ReplyCommentForm form={form} comment={comment} onComment={updateComment} onKeyDown={keyDown} onSave={save} onCancel={close} />}
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

export function ReplyCommentsChip({ comments, storageKey, waiting }: { comments: readonly ReplyComment[]; storageKey: string; waiting: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listed = comments.length > 0;
  usePhoneSheetBack(() => setOpen(false), open && listed);
  useEffect(() => { if (!listed) setOpen(false); }, [listed]);
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

export function useReplyComments(storageKey: string): readonly ReplyComment[] {
  return useSyncExternalStore(replyComments.subscribe, () => replyComments.read(storageKey));
}
