import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { MessageSquarePlus, MessageSquareQuote, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { chatSelectionClipboardPayload } from "../lib/markdownClipboard.ts";
import { replyComments, type ReplyComment } from "../lib/replyComments.ts";
import "./ReplyComments.css";

/**
 * The selected text, as a copy carries it, when the selection lies in the words of one agent reply
 * in `root`: never across a work block, the reply's copy row, a user message, another pane or a field.
 */
export function replySelectionText(selection: Selection | null, root: Element): string | null {
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const element = (node: Node): Element | null => node instanceof Element ? node : node.parentElement;
  const start = element(range.startContainer), end = element(range.endContainer);
  if (start === null || end === null || !root.contains(start) || !root.contains(end)) return null;
  if (start.closest("input, textarea, [contenteditable=true]") !== null) return null;
  const turn = start.closest(".chat-turn-agent");
  if (turn === null || turn !== end.closest(".chat-turn-agent")) return null;
  // every part of the reply the range touches is its words: a work block, a skill or goal line or the meta row is not
  for (const child of turn.children) if (range.intersectsNode(child) && !child.classList.contains("markdown")) return null;
  const text = chatSelectionClipboardPayload(selection, root)?.text ?? selection.toString();
  return text.trim() === "" ? null : text;
}

const EDGE = 8;
/** below a touch selection: clear of its handles, while the system's own menu stands above it */
const HANDLE_ROOM = 28;
const OFFER_W = 132;
const OFFER_H = 36;
const FORM_W = 360;
/** a frame narrower than this docks the form along its bottom edge, where a phone's keyboard meets it */
const DOCK_BELOW = 560;

interface Placed { quote: string; left: number; top: number }

/**
 * The Comment action over a chat (#511). It floats over the transcript, so a selection in progress
 * never moves what is under it (#1922); with a mouse it stands where the button was released, on a
 * touch screen below the selection. Its form saves the comment for the composer's next message.
 */
export function ReplyCommentAction({ scroller, storageKey }: { scroller: RefObject<HTMLDivElement | null>; storageKey: string }) {
  const t = useT();
  const layer = useRef<HTMLDivElement>(null);
  const [offer, setOffer] = useState<Placed | null>(null);
  const [form, setForm] = useState<(Placed & { docked: boolean }) | null>(null);
  const [comment, setComment] = useState("");
  const pointer = useRef<{ x: number; y: number; touch: boolean } | null>(null);
  const dragging = useRef(false);
  // a press on the action: a touch that clears the selection on its way down still comments on it
  const pressing = useRef(false);
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
    {offer !== null && form === null && <button type="button" className="reply-comment-offer" style={{ left: offer.left, top: offer.top }}
      // a mouse press keeps the selection; a touch's is read from the offer it showed
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={() => { pressing.current = true; }}
      onPointerCancel={() => { pressing.current = false; }}
      onClick={() => open(offer)}>
      <MessageSquarePlus aria-hidden="true" />{t("Comment")}
    </button>}
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
  const label = waiting
    ? count === 1 ? t("1 comment waiting") : t("{count} comments waiting", { count })
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
