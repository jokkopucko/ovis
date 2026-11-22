// allow: SIZE_OK - selection anchoring and end following share one scroll-owner state machine.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";

import { ChatRowMemoryContext, chatRowMemory, type ChatRowMemory } from "../lib/chatRowState.tsx";
import { dropPendingListScroll, listEndPadded } from "../lib/followScroll.ts";
import { chatSelectionClipboardPayload } from "../lib/markdownClipboard.ts";
import { usePageVisible } from "../lib/visibility.ts";
// ChatTimeline.css is imported by ChatView: the frame and the loading state need it before this chunk

const FOOTER_KEY = "\u0000footer";

/**
 * A point in the held words: a live range, which moves with them as the transcript changes, and
 * the node and offset it was made at. Text rewritten around it (an answer streaming into the same
 * paragraph) or the node taken away moves a live range elsewhere, and the point is then lost.
 */
interface Mark { readonly range: Range; readonly node: Node; readonly offset: number }

function markAt(node: Node, offset: number): Mark {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  return { range, node, offset };
}

function startMark(range: Range): Mark {
  return markAt(range.startContainer, range.startOffset);
}

function pointMark(x: number, y: number, target: Node | null, within: Node): Mark | null {
  const caret = document.caretRangeFromPoint?.(x, y) ?? null;
  if (caret !== null && within.contains(caret.startContainer)) return startMark(caret);
  // Firefox's own name for it
  const position = document.caretPositionFromPoint?.(x, y) ?? null;
  if (position !== null && within.contains(position.offsetNode)) return markAt(position.offsetNode, position.offset);
  return target === null || !within.contains(target) ? null : markAt(target, 0);
}

function markY(mark: Mark, scroller: HTMLElement): number | null {
  const { range, node, offset } = mark;
  if (!node.isConnected || range.startContainer !== node || range.startOffset !== offset) return null;
  const rect = [...range.getClientRects()].find((box) => box.height > 0)
    ?? (node instanceof Element ? node : node.parentElement)?.getBoundingClientRect();
  return rect === undefined ? null : rect.top - scroller.getBoundingClientRect().top;
}

export interface ChatTimelineRow {
  readonly key: string;
  readonly beforeUser: boolean;
}

export interface ChatTimelineProps<Row extends ChatTimelineRow> {
  rows: readonly Row[];
  scope: string;
  source: string | undefined;
  scroller: RefObject<HTMLDivElement | null>;
  listRef: RefObject<LegendListRef | null>;
  following: RefObject<boolean>;
  manualLayout: RefObject<boolean>;
  selecting: RefObject<boolean>;
  memories: Map<string, ChatRowMemory>;
  header: ReactNode;
  footer: ReactNode;
  label: string;
  onScroll: (listCorrected?: boolean) => void;
  onFollowed: (top: number) => void;
  onOpen: () => void;
  renderRow: (row: Row, index: number) => ReactNode;
}

export function ChatTimeline<Row extends ChatTimelineRow>(given: ChatTimelineProps<Row>) {
  const visible = usePageVisible();
  const drawn = useRef(given);
  if (visible) drawn.current = given;
  const { rows, scope, source, scroller, listRef, following, manualLayout, selecting, memories, header, footer, label, onScroll, onFollowed, onOpen, renderRow } = drawn.current;
  const [selectionKeys, setSelectionKeys] = useState<string[]>([]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useLayoutEffect(() => {
    setSelectionKeys([]);
    setFocusKey(null);
  }, [scope]);
  const rowKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const positions = useMemo(() => new Map(rowKeys.map((key, index) => [key, index])), [rowKeys]);
  const pinned = useMemo(() => [...new Set(focusKey === null ? selectionKeys : [...selectionKeys, focusKey])], [selectionKeys, focusKey]);
  const extraData = useMemo(() => ({ renderRow }), [renderRow]);
  const heardTop = useRef<number | null>(null);
  const attachList = useCallback((instance: LegendListRef | null) => {
    listRef.current = instance;
    const node = instance?.getScrollableNode();
    scroller.current = node instanceof HTMLDivElement ? node : null;
    heardTop.current = scroller.current?.scrollTop ?? null;
  }, [listRef, scroller]);

  useLayoutEffect(() => {
    manualLayout.current = false;
    for (const key of memories.keys()) if (!positions.has(key)) memories.delete(key);
  }, [rows, memories, positions, manualLayout]);

  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const rowFor = (value: Node | null): string | null => {
      const element = value instanceof Element ? value : value?.parentElement;
      const row = element?.closest<HTMLElement>("[data-chat-row]");
      return row && node.contains(row) ? row.dataset.chatRow ?? null : null;
    };
    const selectionChanged = () => {
      const selection = getSelection();
      let first = rowKeys.length, last = -1;
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        for (const row of node.querySelectorAll<HTMLElement>("[data-chat-row]")) {
          const index = positions.get(row.dataset.chatRow ?? "");
          if (index !== undefined && range.intersectsNode(row)) {
            first = Math.min(first, index); last = Math.max(last, index);
          }
        }
      }
      const keys = last >= first ? rowKeys.slice(first, last + 1) : [];
      const footer = node.querySelector(".chat-virtual-footer");
      const inFooter = selection !== null && !selection.isCollapsed && selection.rangeCount > 0 && footer !== null && selection.getRangeAt(0).intersectsNode(footer);
      selectedKeys.current = inFooter ? [...keys, FOOTER_KEY] : keys;
      selectionMark.current = selectedKeys.current.length > 0 && selection !== null ? startMark(selection.getRangeAt(0)) : null;
      held.current();
      setSelectionKeys((previous) => previous.length === keys.length && previous.every((key, index) => key === keys[index]) ? previous : keys);
    };
    const focusChanged = () => setFocusKey(rowFor(document.activeElement));
    const focusOut = () => queueMicrotask(focusChanged);
    const interaction = (event: Event) => {
      const control = event.target instanceof Element ? event.target.closest("summary, .work-block-head, .work-row-head, .chat-tool-more, .chat-tool-result-more") : null;
      if (control === null || control.closest(".work-block.is-pending")) return;
      const details = control.matches("summary") ? control.parentElement : null;
      if (control.matches(".chat-tool-more") || control.getAttribute("aria-expanded") === "false" || (details instanceof HTMLDetailsElement && !details.open)) {
        manualLayout.current = false;
        onOpen();
      } else if (following.current) {
        manualLayout.current = true;
        dropPendingListScroll(listRef.current);
      }
    };
    const pressed = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      pressing.current = rowFor(event.target as Node | null) ?? "";
      pressMark.current = pointMark(event.clientX, event.clientY, event.target as Node | null, node);
      held.current();
    };
    const released = () => {
      if (pressing.current === null) return;
      pressing.current = null;
      held.current();
    };
    const moved = (event: PointerEvent) => { if (event.pointerType === "mouse" && (event.buttons & 1) === 0) released(); };
    document.addEventListener("selectionchange", selectionChanged);
    node.addEventListener("pointerdown", pressed, true);
    document.addEventListener("pointerup", released, true);
    document.addEventListener("pointercancel", released, true);
    document.addEventListener("pointermove", moved, { capture: true, passive: true });
    window.addEventListener("blur", released);
    node.addEventListener("focusin", focusChanged);
    node.addEventListener("focusout", focusOut);
    node.addEventListener("click", interaction, true);
    const copy = (event: ClipboardEvent) => {
      const selection = getSelection();
      if (event.defaultPrevented || !event.clipboardData || !selection) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable=true]")) return;
      const payload = chatSelectionClipboardPayload(selection, node);
      if (!payload) return;
      event.clipboardData.setData("text/plain", payload.text);
      if (payload.html !== null) event.clipboardData.setData("text/html", payload.html);
      event.preventDefault();
    };
    document.addEventListener("copy", copy);
    return () => {
      document.removeEventListener("selectionchange", selectionChanged);
      node.removeEventListener("pointerdown", pressed, true);
      document.removeEventListener("pointerup", released, true);
      document.removeEventListener("pointercancel", released, true);
      document.removeEventListener("pointermove", moved, { capture: true });
      window.removeEventListener("blur", released);
      node.removeEventListener("focusin", focusChanged);
      node.removeEventListener("focusout", focusOut);
      node.removeEventListener("click", interaction, true);
      document.removeEventListener("copy", copy);
    };
  }, [scroller, listRef, positions, rowKeys, onOpen, following, manualLayout]);

  // The list measures inside a ResizeObserver callback and draws its new total in the microtask React
  // queues for it; this follow runs in a microtask queued after that one, once per batch of measurements,
  // and puts the view at the end: the scroller's, or the list's measured one while the list pads
  // the transcript to hold rows in place (listEndPadded). The list's own scroll to the end lands a frame later or more: on a slow device the
  // next change comes first, and the reader never catches up (#2624, #2647). A scroll the chat has
  // not heard yet (its event comes later in the frame) is read first, as that event would read it:
  // a reader who left the end is not pulled back.
  const followQueued = useRef(false);
  const correction = useRef<{ readonly top: number; readonly applied: boolean } | null>(null);
  const scrolled = useRef(onScroll);
  scrolled.current = onScroll;
  const heard = useCallback((listCorrected = false) => {
    heardTop.current = scroller.current?.scrollTop ?? null;
    scrolled.current(listCorrected);
  }, [scroller]);
  const followMeasured = useCallback((change?: "measure" | "adjust") => {
    const top = scroller.current?.scrollTop;
    // Item measurements report before the list applies their adjustment; scrollAdjust reports
    // the offset written by the list, including a later adjustment outside the measurement batch.
    if (top !== undefined && (change === "adjust" || (change === "measure" && correction.current === null))) {
      correction.current = { top, applied: change === "adjust" };
    }
    if (followQueued.current) return;
    followQueued.current = true;
    queueMicrotask(() => {
      followQueued.current = false;
      const pending = correction.current;
      correction.current = null;
      const node = scroller.current, list = listRef.current;
      if (node === null || list === null || !following.current || manualLayout.current || selecting.current) return;
      if (node.scrollTop !== heardTop.current) {
        const listCorrected = pending !== null && (pending.applied ? node.scrollTop === pending.top : node.scrollTop !== pending.top);
        heard(listCorrected);
        if (!following.current || manualLayout.current || selecting.current) return;
      }
      const measured = list.getState().contentLength;
      const end = Math.max(0, (listEndPadded(node) ? measured : Math.max(measured, node.scrollHeight)) - node.clientHeight);
      if (Math.abs(node.scrollTop - end) <= 1) return;
      node.scrollTop = end;
      heardTop.current = node.scrollTop;
      onFollowed(node.scrollTop);
    });
  }, [scroller, listRef, following, manualLayout, selecting, heard, onFollowed]);

  const pressing = useRef<string | null>(null);
  const selectedKeys = useRef<readonly string[]>([]);
  const pressMark = useRef<Mark | null>(null);
  const selectionMark = useRef<Mark | null>(null);
  const anchor = useRef<{ key: string; mark: Mark; y: number; top: number } | null>(null);
  const room = useRef<string | null>(null);
  // @legendapp/list 3.3.5 puts a row's shrink off to the next frame (scheduleWebShrinkMeasurement):
  // a block folding above the held words inside their own row is heard only by watching that row.
  const observer = useRef<ResizeObserver | null>(null);
  const heldRow = useRef<Element | null>(null);
  // the list moved the view to hold its rows in place (maintainVisibleContentPosition) since the hold
  // last looked: its own measurement of a fold the hold has already put back, a frame late
  const listAdjusted = useRef(false);
  const watchHeld = useCallback(() => {
    const node = anchor.current?.mark.node;
    const row = node === undefined ? null : (node instanceof Element ? node : node.parentElement)?.closest("[data-chat-row]") ?? null;
    if (row === heldRow.current) return;
    if (heldRow.current !== null) observer.current?.unobserve(heldRow.current);
    heldRow.current = row;
    if (row !== null) observer.current?.observe(row);
  }, []);
  const markTop = useCallback((mark: Mark): number | null => {
    const node = scroller.current;
    return node === null ? null : markY(mark, node);
  }, [scroller]);
  const keep = useCallback(() => {
    const node = scroller.current, held = anchor.current;
    const adjusted = listAdjusted.current;
    listAdjusted.current = false;
    // A reader away from the end has nothing followed under them: the list holds the rows they
    // read in place itself (maintainVisibleContentPosition), and a second move would undo it.
    if (node === null || held === null || !following.current) return;
    let y = markTop(held.mark);
    if (y === null) {
      const selection = getSelection();
      const mark = selection !== null && !selection.isCollapsed && selection.rangeCount > 0 ? startMark(selection.getRangeAt(0)) : null;
      y = mark === null ? null : markTop(mark);
      anchor.current = mark === null || y === null ? null : { key: held.key, mark, y, top: node.scrollTop };
      watchHeld();
      return;
    }
    // Two scrolls are the layout's own: the browser keeping the view inside a transcript that got shorter
    // below the words (the view was past its new end and is at it now), and the list's, in the frame
    // it pads its end to hold rows in place (listEndPadded).
    const max = node.scrollHeight - node.clientHeight;
    const moved = y - held.y, scrolled = node.scrollTop - held.top;
    // less than a pixel either way: kept until it adds up, the view scrolls in whole pixels
    if (Math.abs(moved) < 1 && Math.abs(scrolled) < 1) return;
    if (Math.abs(moved) < 1) { held.top = node.scrollTop; return; }
    const clamped = held.top > max + 1 && Math.abs(node.scrollTop - max) <= 1;
    const back = clamped || adjusted || listEndPadded(node) ? moved : moved + scrolled;
    if (Math.abs(back) < 1) { held.y = y - back; held.top = node.scrollTop; return; }
    // In whole pixels: the view lands on them, and a fraction set reads back as one pixel now and
    // as the next one by the scroll event, which the chat would take for the reader leaving the end.
    const target = Math.round(node.scrollTop + back);
    const short = target - max;
    const content = node.querySelector<HTMLElement>(".chat-transcript-virtual");
    if (short > 0 && content !== null) {
      // the list sets its own min-height inline: it is given back when the hold ends
      room.current ??= content.style.minHeight;
      content.style.minHeight = `${content.offsetHeight + Math.ceil(short)}px`;
    }
    node.scrollTop = target;
    // The view lands on whole pixels: the words' place stays where it was aimed, so what the rounding
    // leaves adds up with the next move instead of being taken as their place. A view that could not
    // go as far (at its top) leaves them where it stopped.
    held.y = Math.abs(node.scrollTop - target) < 1 ? y - back : markTop(held.mark) ?? y;
    held.top = node.scrollTop;
    onFollowed(node.scrollTop);
  }, [scroller, markTop, following, onFollowed, watchHeld]);
  const keepQueued = useRef(false);
  const keepMeasured = useCallback(() => {
    if (keepQueued.current) return;
    keepQueued.current = true;
    queueMicrotask(() => { keepQueued.current = false; keep(); });
  }, [keep]);
  const hold = useCallback(() => {
    const keys = selectedKeys.current;
    const next = pressing.current !== null || keys.length > 0;
    if (next) {
      if (!selecting.current) dropPendingListScroll(listRef.current);
      selecting.current = true;
      const current = anchor.current;
      const stays = current !== null && keys.includes(current.key);
      const key = pressing.current ?? (stays ? current.key : keys[0] ?? "");
      const mark = pressing.current !== null ? pressMark.current : stays ? current.mark : selectionMark.current;
      if (mark !== (current?.mark ?? null)) {
        const y = mark === null ? null : markTop(mark), node = scroller.current;
        anchor.current = mark === null || y === null || node === null ? null : { key, mark, y, top: node.scrollTop };
        watchHeld();
      }
      return;
    }
    if (!selecting.current) return;
    selecting.current = false;
    anchor.current = null;
    watchHeld();
    const content = scroller.current?.querySelector<HTMLElement>(".chat-transcript-virtual");
    if (content && room.current !== null) content.style.minHeight = room.current;
    room.current = null;
    followMeasured();
  }, [selecting, listRef, scroller, markTop, followMeasured, watchHeld]);
  const held = useRef(hold);
  held.current = hold;
  useLayoutEffect(() => { if (anchor.current !== null) keep(); }, [rows, header, footer, keep]);
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const scrolled = () => { if (anchor.current !== null) keep(); };
    const resized = new ResizeObserver(scrolled);
    const content = node.querySelector<HTMLElement>(".chat-transcript-virtual");
    if (content !== null) resized.observe(content);
    observer.current = resized;
    node.addEventListener("scroll", scrolled, { passive: true });
    // the list's adjust scrolls in its own frame callback; the hold looks once it has
    const unlisten = listRef.current?.getState().listen("scrollAdjust", () => {
      if (anchor.current !== null) {
        listAdjusted.current = true;
        keepMeasured();
      } else if (following.current && !manualLayout.current && !selecting.current) followMeasured("adjust");
    });
    return () => {
      unlisten?.();
      resized.disconnect();
      observer.current = null;
      heldRow.current = null;
      node.removeEventListener("scroll", scrolled);
      selecting.current = false;
      anchor.current = null;
    };
  }, [scroller, listRef, keep, keepMeasured, markTop, following, manualLayout, selecting, followMeasured]);

  // The footer (a sent message's bubble, the Working line) is no row: no item size change reports
  // its growth, and a scroll to the end asked for before the list measured it stops short of it,
  // under the composer.
  const footerRef = useCallback((box: HTMLDivElement) => {
    let height = box.offsetHeight;
    const observer = new ResizeObserver(() => {
      const grew = box.offsetHeight > height;
      height = box.offsetHeight;
      const node = scroller.current;
      if (selecting.current) { keep(); return; }
      if (!grew || node === null || !following.current || manualLayout.current) return;
      dropPendingListScroll(listRef.current);
      node.scrollTop = node.scrollHeight;
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [scroller, listRef, following, manualLayout, selecting, keep]);

  useLayoutEffect(() => {
    const transcript = scroller.current?.querySelector<HTMLElement>(".chat-transcript");
    if (transcript) {
      if (source === undefined) delete transcript.dataset.conversationSource;
      else transcript.dataset.conversationSource = source;
    }
  }, [source, scroller]);

  const rendered = useCallback(({ item, index }: { item: Row; index: number }) => {
    return <ChatRowMemoryContext.Provider value={chatRowMemory(memories, item.key)}>
      <div data-chat-row={item.key} className={item.beforeUser ? "chat-virtual-row is-before-user" : "chat-virtual-row"}>{renderRow(item, index)}</div>
    </ChatRowMemoryContext.Provider>;
  }, [memories, renderRow]);

  return <LegendList
    ref={attachList}
    className="chat-view chat-view-virtual"
    contentContainerClassName="chat-transcript chat-transcript-virtual"
    role="log"
    aria-live="polite"
    aria-label={label}
    data-conversation-source={source}
    data-chat-virtual=""
    data-chat-pinned={pinned.length}
    dataKey={scope}
    data={rows}
    extraData={extraData}
    keyExtractor={(row) => row.key}
    renderItem={rendered}
    estimatedItemSize={120}
    drawDistance={400}
    recycleItems={false}
    initialScrollAtEnd
    maintainVisibleContentPosition
    alwaysRender={{ keys: pinned }}
    ListHeaderComponent={<div className="chat-virtual-header">{header}</div>}
    ListFooterComponent={<div ref={footerRef} className="chat-virtual-footer">{footer}</div>}
    onScroll={() => heard()}
    onLoad={() => { if (following.current) listRef.current?.scrollToEnd({ animated: false }); }}
    onItemSizeChanged={() => {
      if (selecting.current) keepMeasured();
      else if (following.current && !manualLayout.current) followMeasured("measure");
    }}
  />;
}
