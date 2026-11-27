import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { createPortal, flushSync } from "react-dom";
import { ChevronDown, ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, CircleSlash, type LucideProps } from "lucide-react";

import { legacyEditText } from "../../shared/edit-output.ts";
import { AnimatedHeight } from "./AnimatedHeight.tsx";
import { Markdown, ReservedImage } from "./Markdown.tsx";
import { ChatRowMemoryContext, useChatRowToggle, useRowFocus } from "../lib/chatRowState.tsx";
import { useWholeOutput as useScopedOutput } from "../lib/useWholeOutput.ts";
import type { GalleryImage } from "../lib/imageViewer.ts";
import { toolGalleryImage } from "../lib/chatImages.ts";
import { formatWorkDuration, todoGroups, visibleWorkParts, workFailed, workSummary, type TodoAttempt, type TodoGroup, type ToolPart as ToolPartType } from "../lib/workBlocks.ts";
import { phaseRows, planRows, taskRows, todoRows, type ChecklistRow } from "../lib/checklist.ts";
import { isTodoTool, parseTodoAnswer, todoCallSummary, todoSnapshot, type TodoItem, type TodoStatus } from "../lib/todos.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { askedQuestions } from "../../shared/askQuestions.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { foldToolOutput } from "../../shared/markdown.ts";
import { toolPathLabel } from "../lib/workspacePath.ts";
import { linkFilePaths } from "./FilePathLink.tsx";
import { patchText } from "../../shared/patch.ts";
import { workRowLabel } from "../lib/workRowLabel.ts";
import { toolDisplayName } from "../lib/toolVerbs.ts";
import { machinePath } from "../../shared/machines.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { lineDiff } from "../lib/diff.ts";
import { formatTokens } from "../lib/compose.ts";
import { taskCallItems } from "../lib/omoTasks.ts";
import { sendUserFileCall } from "../lib/sendUserFile.ts";
import { LINE_IMAGES_SHOWN, LINE_IMAGES_SHOWN_TOUCH, lineImages, linePictures, previewPlace, workImages, type WorkImage } from "../lib/workImages.ts";
import type { ConversationPart } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { useResourceUrl } from "../lib/useResourceUrl.ts";

export const ChatPaneContext = createContext<string | null>(null);
export const ChatHistoryContext = createContext("");
/**
 * The viewer is held by ChatView, not by the row: a virtualized row unmounts once it scrolls out of
 * the render window (the transcript follows new output while the viewer is open), and it must not
 * take the open viewer with it.
 */
export const ImageViewerContext = createContext<(images: GalleryImage[], index: number) => void>(() => {});
export const ToolPathRootContext = createContext<string | null>(null);

function ChecklistView({ rows }: { rows: ChecklistRow[] }) {
  return <ul className="chat-checklist">{rows.map((row, index) => (
    <li key={index} className={row.heading ? "chat-checklist-phase" : row.done ? "is-done" : row.active ? "is-active" : undefined}>
      {!row.heading && <span className="chat-checklist-box" aria-hidden="true">{row.done ? "✓" : "•"}</span>}{row.label}
    </li>
  ))}</ul>;
}

const TODO_ICONS: Record<TodoStatus, ComponentType<LucideProps>> = {
  completed: CircleCheck, in_progress: CircleDot, pending: Circle, blocked: CircleAlert, dropped: CircleSlash,
};
const TODO_LABELS: Record<TodoStatus, string> = {
  completed: "done", in_progress: "in progress", pending: "to do", blocked: "blocked", dropped: "dropped",
};

function TodoList({ items }: { items: TodoItem[] }) {
  const groups: { phase: string | null; items: TodoItem[] }[] = [];
  for (const item of items) {
    const group = groups[groups.length - 1];
    if (group && group.phase === item.phase) group.items.push(item); else groups.push({ phase: item.phase, items: [item] });
  }
  return <div className="todo-list">{groups.map((group, index) => (
    <div key={index} className="todo-group">
      {group.phase !== null && <p className="todo-phase">{group.phase}</p>}
      <ul>{group.items.map((item, row) => {
        const Icon = TODO_ICONS[item.status];
        return <li key={row} className={`todo-item is-${item.status}`}>
          <Icon className="todo-icon" aria-hidden="true" />
          <span className="todo-label">{item.label}<span className="sr-only"> ({TODO_LABELS[item.status]})</span>{item.note && <span className="todo-note">{item.note}</span>}</span>
        </li>;
      })}</ul>
    </div>
  ))}</div>;
}

function ompEditLineClass(line: string): string | undefined {
  if (line.startsWith("+-") || line.startsWith("-") || /^(CUT|REM)\b/.test(line)) return "chat-diff-del";
  if (line.startsWith("+")) return "chat-diff-add";
  if (/^(PUT|MV)/.test(line) || line.startsWith("[")) return "chat-diff-head";
  return undefined;
}

function ToolFile({ path, suffix }: { path: string; suffix?: string }) {
  const t = useT();
  const open = useContext(OpenFileContext);
  const shown = toolPathLabel(path, useContext(ToolPathRootContext));
  if (open === null) return <p className="chat-tool-file" title={path}><span data-raw-path={path}>{shown}</span>{suffix}</p>;
  return <p className="chat-tool-file"><button type="button" className="chat-tool-file-link" title={t("Open {path}", { path })} data-raw-path={path} onClick={() => open(path)}>{shown}</button>{suffix}</p>;
}

function EditDiff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  return <pre className="chat-diff">{lines.map((line, index) =>
    <span key={index} className={line.kind === "add" ? "chat-diff-add" : line.kind === "del" ? "chat-diff-del" : undefined}>{line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}{line.text}{"\n"}</span>)}</pre>;
}

function PatchView({ patch }: { patch: string }) {
  const sections: Array<{ file: string | null; action: string; lines: string[] }> = [];
  for (const line of patch.split("\n")) {
    const file = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (file !== null) { sections.push({ file: file[2]!.trim(), action: file[1]!, lines: [] }); continue; }
    if (/^\*\*\* (Begin|End) Patch/.test(line)) continue;
    if (sections.length === 0) sections.push({ file: null, action: "", lines: [] });
    sections.at(-1)!.lines.push(line);
  }
  for (const section of sections) while (section.lines.at(-1)?.trim() === "") section.lines.pop();
  const lineClass = (line: string): string | undefined =>
    line.startsWith("@@") || line.startsWith("*** Move to:") ? "chat-diff-head" : line.startsWith("+") ? "chat-diff-add" : line.startsWith("-") ? "chat-diff-del" : undefined;
  return <div className="chat-tool-io">{sections.map((section, index) => <div key={index}>
    {section.file !== null && <ToolFile path={section.file} suffix={section.action === "Update" ? undefined : ` (${section.action.toLowerCase()})`} />}
    {section.lines.length > 0 && <pre className="chat-diff">{section.lines.map((line, at) => <span key={at} className={lineClass(line)}>{line}{"\n"}</span>)}</pre>}
  </div>)}</div>;
}

function ToolInputView({ part }: { part: ToolPartType }) {
  const open = useContext(OpenFileContext);
  const t = useT();
  if (part.edits?.length) return <div className="chat-tool-io">{part.edits.map((edit, index) => <div key={index}>
    <ToolFile path={edit.path} /><EditDiff before={edit.before} after={edit.after} />
  </div>)}</div>;
  if (part.arguments_omitted) return <pre className="chat-tool-io">{t("Arguments omitted (too large)")}</pre>;
  const after = isTodoTool(part.name) ? parseTodoAnswer(part.output) ?? todoSnapshot(part) : null;
  if (after !== null && after.length > 0) return <TodoList items={after} />;
  const patch = patchText(part.input);
  if (patch !== null) return <PatchView patch={patch} />;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(part.input) as Record<string, unknown>; }
  catch { return <pre className="chat-tool-io">{part.input}</pre>; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return <pre className="chat-tool-io">{part.input}</pre>;
  const asked = askedQuestions(part.name, parsed);
  if (asked !== null) return <ol className="chat-ask-questions">{asked.map((question, index) => <li key={index} className="chat-ask-question">
    {question.header !== null && <p className="chat-ask-header">{question.header}</p>}
    <p className="chat-ask-text">{question.question}</p>
    {question.multi && <p className="chat-ask-meta">{t("More than one could be picked")}</p>}
    {question.options.length > 0 && <ol className="chat-ask-options">{question.options.map((option, at) => <li key={at}>
      <p className="chat-ask-label">{option.label}{question.recommended === at && <> <span className="chat-ask-meta">({t("Recommended")})</span></>}</p>
      {option.description !== null && <p className="chat-ask-description">{option.description}</p>}
      {option.preview !== null && <pre className="chat-ask-preview">{option.preview}</pre>}
    </li>)}</ol>}
  </li>)}</ol>;
  const spawned = part.name === "task" ? taskCallItems(parsed) : null;
  if (spawned !== null) return <ol className="chat-task-calls">{spawned.map((item, index) => <li key={index} className="chat-task-call">
    <p className="chat-task-call-head"><span className="chat-task-call-title">{item.title}</span>{item.agent !== null && <span className="chat-task-call-agent">{item.agent}</span>}</p>
    {item.prompt.length > 0 && <pre className="chat-tool-io chat-task-call-prompt">{item.prompt}</pre>}
  </li>)}</ol>;
  const str = (key: string): string | undefined => typeof parsed[key] === "string" ? parsed[key] : undefined;
  const command = str("command") ?? str("cmd");
  if (command !== undefined) return <div className="chat-tool-io"><pre>{linkFilePaths(command, open)}</pre>{(str("cwd") ?? str("description")) !== undefined && <p className="chat-tool-io-meta">{str("cwd") ?? str("description")}</p>}</div>;
  const oldString = str("old_string");
  const newString = str("new_string");
  if (oldString !== undefined || newString !== undefined) return <div className="chat-tool-io">{str("file_path") !== undefined && <ToolFile path={str("file_path")!} />}<EditDiff before={oldString ?? ""} after={newString ?? ""} /></div>;
  if (Array.isArray(parsed["edits"]) && parsed["edits"].every((item) => item !== null && typeof item === "object")) {
    const edits = parsed["edits"] as Array<Record<string, unknown>>;
    return <div className="chat-tool-io">{str("file_path") !== undefined && <ToolFile path={str("file_path")!} />}{edits.map((item, index) =>
      <EditDiff key={index} before={typeof item["old_string"] === "string" ? item["old_string"] : ""} after={typeof item["new_string"] === "string" ? item["new_string"] : ""} />)}</div>;
  }
  const sendUserFile = sendUserFileCall(parsed);
  if (sendUserFile !== null) return <div className="chat-tool-io">
    {sendUserFile.caption.length > 0 && <p className="chat-tool-io-meta">{sendUserFile.caption}</p>}
    {sendUserFile.files.map((file, index) => <ToolFile key={`${index}:${file}`} path={file} />)}
  </div>;
  const editScript = str("input");
  if (editScript !== undefined) return <pre className="chat-tool-io chat-diff">{editScript.split("\n").map((line, index) => <span key={index} className={ompEditLineClass(line)}>{line}{"\n"}</span>)}</pre>;
  const content = str("content");
  if (content !== undefined) return <div className="chat-tool-io">{(str("file_path") ?? str("path")) !== undefined && <ToolFile path={(str("file_path") ?? str("path"))!} />}<pre>{content}</pre></div>;
  const path = str("file_path") ?? str("path");
  if (path !== undefined) return <div className="chat-tool-io"><ToolFile path={path} suffix={str("pattern") !== undefined ? ` — /${str("pattern")}/` : undefined} /></div>;
  for (const [key, toRows] of [["list", phaseRows], ["todos", todoRows], ["plan", planRows], ["tasks", taskRows]] as const) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      const rows = toRows(value);
      if (rows.length > 0) return <ChecklistView rows={rows} />;
    }
  }
  return <pre className="chat-tool-io">{part.input}</pre>;
}

function RawToolInput({ part }: { part: ToolPartType }) {
  const t = useT();
  return <section className="chat-tool-output"><h4>{t("Input")}</h4>
    <pre className="chat-tool-io">{part.arguments_omitted ? t("Arguments omitted (too large)") : indentedJson(part.input)}</pre>
  </section>;
}

function indentedJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function useWholeOutput(ref: string | undefined): { text: string | null; state: "idle" | "loading" | "failed"; load: () => void } {
  const paneId = useContext(ChatPaneContext);
  const machineId = useMachineId();
  const history = useContext(ChatHistoryContext);
  const url = ref === undefined || paneId === null ? null : machinePath(machineId, `pane/conversation/tool-output?${new URLSearchParams({ pane_id: paneId, ref }).toString()}`);
  const memory = useContext(ChatRowMemoryContext);
  const saved = ref === undefined ? undefined : memory?.outputs.get(ref);
  const result = useScopedOutput(saved === undefined ? url : null, history);
  useLayoutEffect(() => {
    if (ref !== undefined && result.text !== null && memory && memory.outputs.get(ref) !== result.text) {
      memory.outputs.set(ref, result.text);
    }
  }, [ref, memory, result.text]);
  return saved === undefined ? result : { text: saved, state: "idle", load: result.load };
}

function ImageThumb({ image, onOpen }: { image: GalleryImage; onOpen: () => void }) {
  const t = useT();
  // the focus is placed on the thumbnail before the viewer opens, so the viewer's focus trap
  // records it as the opener and gives the focus back here on close (Safari does not focus a
  // clicked button on its own)
  return <button type="button" className="chat-user-image" title={t("Open image")} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onOpen(); }}>
    <ReservedImage src={image.src} alt={image.name} slot />
  </button>;
}

export function ImageGallery({ images, className }: { images: GalleryImage[]; className: string }) {
  const openViewer = useContext(ImageViewerContext);
  return <div className={className}>
    {images.map((image, index) => <ImageThumb key={image.src} image={image} onOpen={() => openViewer(images, index)} />)}
  </div>;
}

/** Images a tool returned (pi reads a picture into the result), shown whole in the opened row. */
function ToolImages({ paneId, part }: { paneId: string; part: ToolPartType }) {
  const t = useT();
  const machineId = useMachineId();
  const images = workImages([part]);
  if (images.length === 0) return null;
  return <ImageGallery images={images.map((image) => toolGalleryImage(machineId, paneId, image, t))} className="chat-tool-images" />;
}

function LinePreview({ image, tool, place, anchor }: { image: GalleryImage; tool: string; place: string; anchor: HTMLElement }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const own = box.current;
    if (own === null) return;
    const place = () => {
      const target = anchor.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      setAt(!anchor.isConnected || target.bottom < 0 || target.top > viewport.height ? null : previewPlace(target, own.getBoundingClientRect(), viewport));
    };
    place();
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [anchor]);
  return createPortal(<div ref={box} className="work-image-preview" aria-hidden="true" style={at === null ? { visibility: "hidden" } : { left: at.left, top: at.top }}>
    <ReservedImage src={image.src} alt="" slot />
    <div className="work-image-preview-bar"><span className="work-image-preview-tool">{tool}</span><span>{place}</span></div>
  </div>, document.body);
}

function LineThumb({ image, onOpen, onHover, onFocused, onFailed }: {
  image: GalleryImage; onOpen: (target: HTMLElement) => void; onHover: (anchor: HTMLElement | null) => void; onFocused: (target: HTMLElement) => void; onFailed: () => void;
}) {
  const src = useResourceUrl(image.src);
  return <button type="button" className="work-image" aria-label={image.name}
    onClick={(event) => onOpen(event.currentTarget)}
    onPointerEnter={(event) => { if (event.pointerType !== "touch") onHover(event.currentTarget); }}
    onPointerLeave={() => onHover(null)}
    onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) onFocused(event.currentTarget); }}
    onBlur={() => onHover(null)}>
    <img src={src ?? undefined} alt="" loading="lazy" onError={onFailed} />
  </button>;
}

function LineImages({ paneId, images }: { paneId: string; images: readonly WorkImage[] }) {
  const t = useT();
  const machineId = useMachineId();
  const openViewer = useContext(ImageViewerContext);
  const touch = useMediaQuery("(pointer: coarse)");
  const [preview, setPreview] = useState<{ src: string; anchor: HTMLElement } | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const entries = useMemo(() => images.map((image) => ({ image: toolGalleryImage(machineId, paneId, image, t), tool: toolDisplayName(image.part.name) })), [images, machineId, paneId, t]);
  const usable = entries.filter((entry) => !failed.has(entry.image.src));
  if (usable.length === 0) return null;
  const gallery = usable.map((entry) => entry.image);
  const { hidden, shown } = lineImages(usable, touch ? LINE_IMAGES_SHOWN_TOUCH : LINE_IMAGES_SHOWN);
  const open = (index: number, target: HTMLElement) => { setPreview(null); target.focus({ preventScroll: true }); openViewer(gallery, index); };
  // a thumbnail takes back only its own preview: leaving one must not close the next one's
  const hide = (src: string) => setPreview((current) => current?.src === src ? null : current);
  const at = preview === null ? -1 : usable.findIndex((entry) => entry.image.src === preview.src);
  const previewed = at >= hidden ? usable[at] : undefined;
  return <div className="work-images" role="group" aria-label={t("Pictures from this work")}>
    {hidden > 0 && <button type="button" className="work-image is-more" aria-label={t("All {count} pictures", { count: usable.length })} onClick={(event) => open(0, event.currentTarget)}>+{hidden}</button>}
    {shown.map(({ image }, offset) => <LineThumb key={image.src} image={image}
      onOpen={(target) => open(hidden + offset, target)}
      onHover={(anchor) => anchor === null ? hide(image.src) : setPreview({ src: image.src, anchor })}
      onFocused={(target) => setPreview({ src: image.src, anchor: target })}
      onFailed={() => { hide(image.src); setFailed((current) => new Set(current).add(image.src)); }} />)}
    {preview !== null && previewed !== undefined && <LinePreview image={previewed.image} tool={previewed.tool} anchor={preview.anchor}
      place={t("{n} of {count}", { n: at + 1, count: usable.length })} />}
  </div>;
}

function ToolOutputText({ stateKey, output, whole }: { stateKey: string; output: string; whole: boolean }) {
  const t = useT();
  const openFile = useContext(OpenFileContext);
  const fold = useMemo(() => foldToolOutput(output), [output]);
  const [chosen, setExpanded] = useChatRowToggle(stateKey, false);
  const expanded = chosen === true;
  const folded = fold !== null && !expanded;
  // where the browser can find hidden text (hidden=until-found), a folded output's tail stays in the
  // page, drawn as nothing: its find reaches it and unfolds the output; elsewhere only the head is drawn
  // (rendered without a page, as to static markup, nothing is found)
  const findable = folded && typeof HTMLElement !== "undefined" && "onbeforematch" in HTMLElement.prototype;
  const tail = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = tail.current;
    if (node === null) return;
    // React writes `hidden` only as true or false
    node.setAttribute("hidden", "until-found");
    // unfolded before the browser scrolls to the match, so it lands where the unfolded text puts it
    const found = () => flushSync(() => setExpanded(true));
    node.addEventListener("beforematch", found);
    return () => node.removeEventListener("beforematch", found);
  }, [folded, setExpanded]);
  const box = useRef<HTMLPreElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const folding = useRef(false);
  // an unfold from the keyboard (a click with no pointer press: detail 0); a pointer's leaves the focus where it was
  const revealing = useRef(false);
  useLayoutEffect(() => {
    const node = box.current;
    const view = node?.closest(".chat-view");
    if (folding.current) {
      folding.current = false;
      const atEnd = view instanceof HTMLElement && view.scrollHeight - view.clientHeight - view.scrollTop <= 1;
      if (node && view && !atEnd && node.getBoundingClientRect().top < view.getBoundingClientRect().top) node.scrollIntoView({ block: "start" });
    }
    if (revealing.current) {
      revealing.current = false;
      const button = more.current;
      if (node && view && button && button.getBoundingClientRect().top >= view.getBoundingClientRect().bottom) node.focus({ preventScroll: false });
    }
  }, [expanded]);
  return <>
    {/* the head of a folded output links its paths as the whole text finds them: a path the fold cuts stays text */}
    <pre ref={box} tabIndex={-1} className={`chat-tool-io chat-tool-result${whole ? " is-whole" : ""}`}>{linkFilePaths(output, openFile, folded ? fold.head.length : output.length)}{folded && findable && <span ref={tail} className="chat-tool-result-tail">{output.slice(fold.head.length)}</span>}</pre>
    {fold !== null && <button ref={more} type="button" className="markdown-code-more chat-tool-result-more" aria-expanded={expanded}
      onClick={(event) => { folding.current = expanded; revealing.current = !expanded && event.detail === 0; setExpanded(!expanded); }}>
      {expanded ? t("Show less") : fold.lines !== null ? t("Show all {n} lines", { n: fold.lines }) : t("Show all {size} characters", { size: formatTokens(output.length) })}
    </button>}
  </>;
}

function WorkRow({ paneId, part, stateKey, state }: { paneId: string; part: ToolPartType; stateKey: string; state?: TodoAttempt["state"] }) {
  const t = useT();
  const [chosen, setOpen] = useChatRowToggle(stateKey, false);
  const open = chosen === true;
  const focus = useRowFocus<HTMLButtonElement>(stateKey);
  const attempt = state !== undefined;
  const whole = useWholeOutput(part.output_ref);
  const summary = part.arguments_omitted ? t("Arguments omitted (too large)") : todoCallSummary(part) ?? part.summary;
  const { verb, narration } = useMemo(() => workRowLabel({ name: part.name, input: part.input }, summary), [part.name, part.input, summary]);
  const name = toolDisplayName(part.name);
  const renamed = narration || verb !== null || name !== part.name;
  const legacy = useMemo(() => legacyEditText(part.edits), [part.edits]);
  const raw = whole.text ?? part.output;
  const clippedEdit = legacy && raw.endsWith("\n… trimmed") && legacy.startsWith(raw.slice(0, -"\n… trimmed".length));
  const output = raw === legacy || clippedEdit || (!attempt && isTodoTool(part.name) && parseTodoAnswer(part.output) !== null) ? ""
    : legacy && raw.startsWith(`${legacy}\n`) ? raw.slice(legacy.length + 1) : raw;
  const canLoad = part.output_ref !== undefined && whole.text === null && (!clippedEdit || (part.output_size ?? 0) > legacy.length + 1);
  const stateWord = state === undefined || part.error ? null
    : state === "ok" ? t("succeeded") : state === "pending" ? t("pending") : state === "error" ? t("failed") : t("outcome not recorded");
  const images = useMemo(() => linePictures([part]), [part]);
  return <div className={`work-row${part.error ? " is-error" : ""}`}>
    <div className="work-row-line">
      <button type="button" className="work-row-head" aria-expanded={open} title={renamed ? (summary.length > 0 ? `${part.name} · ${summary}` : part.name) : undefined} onClick={() => setOpen(!open)} {...focus}>
        <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
        {!narration && (verb !== null ? <span className="work-row-name is-verb">{t(verb)}</span> : <span className="work-row-name">{name}</span>)}
        {/* the spaces are for a screen reader: the row is read as words, not "Ranbun test" */}
        {!narration && part.error && verb === null && <>{" "}<span className="work-row-failed">{t("failed")}</span></>}
        {summary.length > 0 && summary !== part.name && <>{" "}<span className="work-row-summary">{summary}</span></>}
        {/* after a verb, or the agent's own sentence, the word follows it: "Ran pnpm test failed", not "Ran failed pnpm test" */}
        {part.error && (narration || verb !== null) && <>{" "}<span className="work-row-failed">{t("failed")}</span></>}
        {stateWord !== null && <>{" "}<span className={state === "error" ? "work-row-failed" : `work-row-state is-${state}`}>{stateWord}</span></>}
      </button>
      {/* opened, the row shows its pictures larger in its detail */}
      {!open && <LineImages paneId={paneId} images={images} />}
    </div>
    {open && <div className="work-row-detail">{(verb !== null || name !== part.name) && <p className="work-row-tool">{part.name}</p>}{attempt ? <RawToolInput part={part} /> : <ToolInputView part={part} />}<ToolImages paneId={paneId} part={part} />{(output.length > 0 || (clippedEdit && canLoad)) && <section className="chat-tool-output"><h4>{t(part.error ? "Error" : "Output")}</h4>{/* each whole output folds on its own, whatever the preview or an earlier one was: another element, another key */}
      {output.length > 0 && <ToolOutputText key={whole.text !== null ? `whole:${part.output_ref ?? ""}` : "preview"} stateKey={`${stateKey}:${whole.text !== null ? `whole:${part.output_ref ?? ""}` : "output"}`} output={output} whole={whole.text !== null} />}
      {canLoad && <button type="button" className="btn btn-ghost chat-tool-more" disabled={whole.state === "loading"} onClick={whole.load}>
        {t(whole.state === "loading" ? "Loading the whole output…" : whole.state === "failed" ? "Couldn't load the whole output — retry" : "Show the whole output ({size} characters)", { size: formatTokens(part.output_size ?? 0) })}
      </button>}</section>}</div>}
  </div>;
}

function TodoGroupRow({ paneId, group, stateKeyOf }: { paneId: string; group: TodoGroup; stateKeyOf: (part: ToolPartType) => string }) {
  const t = useT();
  const memory = useContext(ChatRowMemoryContext);
  const groupKey = `todo-group:${group.id}`;
  const [chosen, setOpen] = useChatRowToggle(groupKey, group.attempts.some((attempt) => memory?.toggles.get(stateKeyOf(attempt.part)) === true));
  const focus = useRowFocus<HTMLButtonElement>(groupKey, group.attempts.map((attempt) => stateKeyOf(attempt.part)));
  useLayoutEffect(() => { if (chosen === true && memory !== null && !memory.toggles.has(groupKey)) memory.toggles.set(groupKey, true); }, [chosen, memory, groupKey]);
  const open = chosen === true;
  const { current } = group;
  const items = current?.items ?? null;
  const done = items?.filter((item) => item.status === "completed").length ?? 0;
  const status = current === null ? t("no update completed")
    : items === null ? t("latest list unreadable")
      : current.state === "ok" ? t("{done}/{total} done", { done, total: items.length })
        : t("{done}/{total} done, outcome not recorded", { done, total: items.length });
  const caption = current === null ? t("No update has completed, so there is no current list.")
    : items === null ? t(current.state === "ok" ? "The latest successful update's list can't be read. An earlier list is not shown in its place." : "The latest update's list can't be read. An earlier list is not shown in its place.")
      : current.state === "ok" ? t("Current list") : t("Latest list. The transcript does not record whether this update succeeded.");
  return <div className="work-row work-todo-group" data-todo-group={group.id}>
    <button type="button" className="work-row-head" aria-expanded={open} onClick={() => setOpen(!open)} {...focus}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <span className="work-row-name is-verb">{t("Plan")}</span>
      {" "}<span className="work-row-summary">{t("{n} updates", { n: group.attempts.length })} · {status}</span>
      {/* the counts beside it are never the part a narrow row cuts */}
      {group.pending > 0 && <>{" "}<span className="work-row-state is-pending">{t("{n} pending", { n: group.pending })}</span></>}
      {group.failed > 0 && <>{" "}<span className="work-row-failed">{t("{n} failed", { n: group.failed })}</span></>}
    </button>
    {open && <div className="work-row-detail work-todo-detail">
      <p className="work-todo-caption">{caption}</p>
      {items !== null && (items.length > 0 ? <TodoList items={items} /> : <p className="work-todo-caption">{t("The list is empty.")}</p>)}
      <section className="work-todo-attempts" aria-label={t("Every update, in order")}>
        <h4>{t("Every update, in order")}</h4>
        {group.attempts.map((attempt) => <WorkRow key={stateKeyOf(attempt.part)} stateKey={stateKeyOf(attempt.part)} paneId={paneId} part={attempt.part} state={attempt.state} />)}
      </section>
    </div>}
  </div>;
}

function ThinkingRow({ text, stateKey, defaultOpen }: { text: string; stateKey: string; defaultOpen: boolean }) {
  const t = useT();
  const [chosen, setOpen] = useChatRowToggle(stateKey, null);
  const open = chosen ?? defaultOpen;
  return <div className="work-row work-row-thinking">
    <button type="button" className="work-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <span className="work-row-name">{t("thinking")}</span>
    </button>
    {open && <div className="work-row-detail work-thinking-text">{text}</div>}
  </div>;
}

export function PendingWorkHead({ title, className = "", reserved = false }: { title: string; className?: string; reserved?: boolean }) {
  return <div className={`work-block is-live is-pending ${className}`} role="status" aria-hidden={reserved || undefined}>
    <div className="work-block-head"><span className="work-row-caret" aria-hidden="true" /><span className="work-block-title">{title}</span></div>
  </div>;
}

interface TurnWork {
  at: ReadonlyMap<ConversationPart, number>;
  groups: ReadonlyMap<ToolPartType, TodoGroup>;
  grouped: ReadonlySet<ConversationPart>;
}

export function turnWork(parts: ConversationPart[], rowKey: string): TurnWork {
  const groups = todoGroups(parts, rowKey);
  return {
    at: new Map(parts.map((part, index) => [part, index])),
    groups,
    grouped: new Set([...groups.values()].flatMap((group) => group.attempts.slice(1).map((attempt) => attempt.part))),
  };
}

function useElapsed(startTs: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startTs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startTs]);
  return startTs === null ? null : formatWorkDuration(startTs, new Date(now).toISOString());
}

export function WorkBlockView({ paneId, parts, work, memoryKey, duration, startedAt = null, live, waiting, defaultOpen, showThinking, expandThinking, pendingHead }: { paneId: string; parts: ConversationPart[]; work: TurnWork; memoryKey: string; duration: string | null; startedAt?: string | null; live: boolean; waiting: boolean; defaultOpen: boolean; showThinking: boolean; expandThinking: boolean; pendingHead: boolean }) {
  const t = useT();
  const [chosenOpen, setOpen] = useChatRowToggle(memoryKey, null);
  const elapsed = useElapsed(live && !waiting ? startedAt : null);
  const open = chosenOpen ?? defaultOpen;
  // reading or working inside the block is a choice to keep it: the fold at the end of the turn
  // must not take the rows from under the reader's focus or close the row they opened
  const keepOpen = () => { if (chosenOpen === null) setOpen(true); };
  const { at, groups, grouped } = work;
  const toolKey = (part: ConversationPart) => `tool:${at.get(part)}`;
  const images = useMemo(() => linePictures(parts), [parts]);
  const visible = visibleWorkParts(parts, showThinking);
  if (visible.length === 0) return live && !waiting && pendingHead ? <PendingWorkHead title={t("Working…")} /> : null;
  const summary = workSummary(parts);
  const failed = workFailed(parts);
  const title = waiting ? t("Needs you") : live ? t("Working…") : duration !== null ? t("Worked for {duration}", { duration }) : t("Worked");
  return <section className={`work-block${live ? " is-live" : ""}${waiting ? " is-waiting" : ""}${open ? "" : " is-folded"}`}>
    <div className="work-block-line">
      <button type="button" className="work-block-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
        <span className="work-block-title">{title}</span>
        {elapsed !== null && <span className="work-block-elapsed">· {elapsed}</span>}
        {summary.length > 0 && <span className="work-block-summary">· {summary}</span>}
        {/* its own span: the counts before it are cut on a narrow screen, a failure never is */}
        {failed > 0 && <span className="work-block-failed">· {t("{n} failed", { n: failed })}</span>}
      </button>
      {/* folded, the block's line carries its tools' pictures the browser keeps (linePictures); opened, each row carries its own */}
      {!open && <LineImages paneId={paneId} images={images} />}
    </div>
    {/* the rows open and fold at the block's measured height; folded and settled, they are not drawn */}
    <AnimatedHeight open={open} animateContent={false}>
      <div className="work-block-rows" onFocus={keepOpen} onPointerDown={keepOpen}>{visible.map((part) =>
        part.kind === "thinking" ? <ThinkingRow key={`thinking:${at.get(part)}`} stateKey={`thinking:${at.get(part)}`} text={part.text} defaultOpen={expandThinking} />
          : part.kind === "text" ? <div key={`text:${at.get(part)}`} className="work-narration"><Markdown>{part.text}</Markdown></div>
            : part.kind === "tool" ? groups.has(part) ? <TodoGroupRow key={groups.get(part)!.id} paneId={paneId} group={groups.get(part)!} stateKeyOf={toolKey} />
              : grouped.has(part) ? null : <WorkRow key={toolKey(part)} stateKey={toolKey(part)} paneId={paneId} part={part} /> : null)}
      </div>
    </AnimatedHeight>
  </section>;
}