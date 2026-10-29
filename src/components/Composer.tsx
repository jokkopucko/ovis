import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { ArrowUp, FileText, Folder, FolderGit2, GitBranch, LoaderCircle, MessageSquarePlus, Minimize2, Package, Plus, Puzzle, Square, TriangleAlert, UserRound, X, type LucideIcon } from "lucide-react";

import "./Composer.css";

import type { AgentStatus, ClientRole, ConversationMetadata, PlanSummary, SlashCommand } from "../../shared/protocol.ts";
import { skillSyntax } from "../../shared/skill-syntax.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { composerDrafts } from "../lib/composerDraft.ts";
import { commentsWait, messageWithComments, replyComments, replyCommentsKey, type ReplyComment } from "../lib/replyComments.ts";
import { ReplyCommentsChip, useReplyComments } from "./ReplyComments.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import {
  agentDisplayLabel,
  atSkillCommands,
  atSkillReplacement,
  briefDescription,
  COMMAND_GROUPS,
  commandGroup,
  commandsForTrigger,
  composerModelDraw,
  composerSendShown,
  composerStatusCompact,
  composerStatusHint,
  composerStatusWord,
  contextLeftPercent,
  type DraftRefusal,
  draftSendNote,
  formatTokens,
  imageMention,
  insertLeadingMention,
  MAX_COMPOSER_CHARS,
  rankSlashCommands,
  slashCommandReplacement,
  submitNote,
  terminalCommand,
  typedTerminalCommand,
} from "../lib/compose.ts";
import { compactCommandText } from "../lib/compactContext.ts";
import { composerStrip } from "../lib/composerStrip.ts";
import { composerLabelDraw } from "../lib/composerLabelFit.ts";
import { composerFull, formatChars, pasteOverflow } from "../lib/composerLength.ts";
import { normalizeComposerImageFile } from "../lib/composerImageMime.ts";
import { paneStatus } from "../lib/status.ts";
import { modelLabel } from "../lib/modelName.ts";
import { useFacesArrived } from "../lib/fontFaces.ts";
import { activeTrigger, applyCompletion, type ActiveTrigger } from "../lib/mentions.ts";
import { resolveComposerMenuActiveItemId } from "../lib/composerMenuHighlight.ts";
import { quickReplyButtons, useSettings } from "../lib/settings.ts";
import { composerUsage, formatPercent, formatResetIn, HIGH_PERCENT, meterPercent, meterText, providerForAgent, statusWindows, usageName, useUsage, windowLabel } from "../lib/usage.ts";
import { AgentMark } from "./AgentMark.tsx";
import { BackgroundTasks } from "./BackgroundTasks.tsx";
import { MicButton, VoiceRecordingPill, useDictation } from "./VoiceInput.tsx";
import { usePaneCommands } from "../lib/usePaneCommands.ts";
import { useT } from "../lib/i18n.ts";
import { offersRetry, userFailure, type UserFailure } from "../lib/userError.ts";
import { AttachmentTooLargeError } from "../lib/api.ts";
import { modalOpen } from "../lib/focus.ts";

export interface ComposerProps {
  connected: boolean;
  /** the socket has been connected on this page before: not connected, the offline sentence says Reconnecting
   *  (`connectedBefore`), else Connecting (omitted, as the fixtures do, a wait reads as the first connection) */
  connectedBefore?: boolean;
  paneId: string;
  /** false: appearing must not take the keyboard (App switched to this pane on its own) */
  autoFocus?: boolean;
  active?: boolean;
  agent: string | null;
  agentStatus?: AgentStatus;
  /** an OmO pane's running background tasks: the status line opens their list */
  backgroundTasks?: number;
  /** the plan the pane's agent keeps, as far as it got: the same chip opens its steps */
  plan?: PlanSummary | null;
  /** the pane's turn ended on work still running in the background: its word is BG, not DONE (lib/status.ts paneStatus) */
  backgroundWait?: boolean;
  metadata?: ConversationMetadata | null;
  /** replaces the placeholder: how a message answers the agent's waiting prompt */
  answerHint?: string | null;
  /** a typed pick waiting in the card above for Confirm: Enter in the empty box confirms it, Escape cancels it */
  waitingAnswer?: { confirm(): Promise<boolean | string>; cancel(): void } | null;
  /** what the agent suggests typing next (Claude's grey input text): the placeholder, taken with Tab */
  suggestion?: string | null;
  /** a cancelled send the agent put back in its input box: the empty box takes it again, for editing and resending */
  restored?: string | null;
  /** an empty chat's greeting: it stands over the composer's column and takes no row of its own */
  greeting?: ReactNode;
  /** the pane's notices over the input card (PaneTerminal builds them): rows of its own, above the replies */
  notices?: ReactNode;
  /** the connection's confirmed role; PaneTerminal mounts no composer for observers */
  role?: ClientRole;
  /** a terminal command's peek has the pane: the composer stays, with its draft, but takes no input */
  inert?: boolean;
  /** opens the folder's earlier sessions instead of submitting /resume */
  onOpenHistory?: () => void;
  /** opens the New tab dialog on this pane's workspace, to start another agent with its model, effort, skills
   * and first message (NewSessionDialog); none: the pane has no workspace to add a tab to */
  onOpenNewSession?: () => void;
  /** the pane's working folder, named in the strip tucked under the card; nothing is drawn for it while absent */
  cwd?: string | null;
  /** the pane's branch, beside the folder in that strip; nothing is drawn for it while absent */
  branch?: string | null;
  /** the workspace is a linked worktree of this repository: the strip names the repository in the folder's
   * place (the checkout folder is the branch again, with dashes) and says it is a worktree; null: not one */
  worktreeRepo?: string | null;
  /** true: sent, clear the box; a string: keep the text and say why; a DraftRefusal: the same, and the
   * note offers to send again with `clearDraft`, which clears that draft from the terminal first, or,
   * where it named none, with `sendAnyway`; a promise settles to any of them */
  onSend: (text: string, clearDraft?: string, sendAnyway?: boolean, agentOnly?: boolean) => boolean | string | DraftRefusal | Promise<boolean | string | DraftRefusal>;
  onAbort: () => void;
  onUploadImage: (file: File) => Promise<string>;
}

const UPLOADS_AT_ONCE = 3;
/** files one paste, pick or drop takes; the rest are left out with a note */
const ATTACH_LIMIT = 100;
/**
 * Any file can be attached (an icon, a PDF, a log): the server stores it beside the pane
 * and the message mentions its path. These image types also get a thumbnail.
 */
const PREVIEW_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] as const;
const SLASH_USAGE_KEY = "ovis:slash-usage";
/** How long a Send tapped mid-composition waits for the keyboard to commit the word (as in TerminalInput). */
const COMMIT_WAIT_MS = 300;
export const SOURCE_LABEL: Record<SlashCommand["source"], string> = {
  builtin: "Built in",
  user: "User",
  project: "Project",
  skill: "Skills",
  plugin: "Plugins",
};
/** Where a skill comes from, as a row's icon: yours in the accent (Composer.css), the rest dimmed like any icon. */
const ORIGIN_ICON: Record<NonNullable<SlashCommand["origin"]>, LucideIcon> = { user: UserRound, project: FolderGit2, bundled: Package, plugin: Puzzle };

let attachmentSequence = 0;

type Attachment = {
  id: number;
  file: File;
  previewUrl: string;
  path: string | null;
  state: "uploading" | "ready" | "error" | "no-room";
  /** for "no-room": how many characters the message must lose for the path to fit */
  missing?: number;
  /** what the pick this file came in with left out, repeated beside an upload error of the batch */
  leftOut: string | null;
};

/** an upload that failed: its tile, and the failure's parts for the note over the box */
type UploadFailure = { attachment: Attachment; failure: UserFailure };

function readSlashUsage(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SLASH_USAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
  } catch {
    return {};
  }
}

/**
 * What is left of the context, as a ring filled by what is used (as Codex's app shows it):
 * red when little is left. The number is on hover, and on a tap beside the ring (a touch
 * screen has no hover). A window the transcript does not name draws no ring. Whether the number
 * is open is the composer's to keep: its text takes room in the row the model label is fitted to.
 */
function ContextRing({ context, shown, readOnly = false, onToggle, onCompact }: { context: NonNullable<ConversationMetadata["context"]>; shown: boolean; readOnly?: boolean; onToggle: () => void; onCompact?: (() => void) | undefined }) {
  const t = useT();
  const left = contextLeftPercent(context);
  if (left === null || context.window === null) return null;
  const label = t("Context {percent}% left", { percent: left });
  const detail = t("{used} of {window} tokens", { used: formatTokens(context.used), window: formatTokens(context.window) });
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  if (readOnly) return <span className={`composer-context composer-context-readonly${left <= 20 ? " is-low" : ""}`}>
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle className="composer-context-track" cx="8" cy="8" r={radius} />
      <circle className="composer-context-used" cx="8" cy="8" r={radius}
        strokeDasharray={`${circumference * (100 - left) / 100} ${circumference}`} transform="rotate(-90 8 8)" />
    </svg>
    <span className="visually-hidden">{label} · {detail}</span>
  </span>;
  return (
    <>
    <button
      type="button"
      className={`composer-context${left <= 20 ? " is-low" : ""}`}
      aria-label={`${label} · ${detail}`}
      title={`${label} · ${detail}`}
      aria-expanded={shown}
      onClick={onToggle}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="composer-context-track" cx="8" cy="8" r={radius} />
        <circle className="composer-context-used" cx="8" cy="8" r={radius}
          strokeDasharray={`${circumference * (100 - left) / 100} ${circumference}`} transform="rotate(-90 8 8)" />
      </svg>
      {shown && <span className="composer-context-text">{label}</span>}
    </button>
    {shown && onCompact && <button type="button" className="composer-compact" title={t("Compact context")} aria-label={t("Compact context")} onClick={onCompact}>
      <Minimize2 aria-hidden="true" />
    </button>}
    </>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const refresh = () => setMatches(media.matches);
    refresh();
    media.addEventListener("change", refresh);
    return () => media.removeEventListener("change", refresh);
  }, [query]);
  return matches;
}

/** Chat-style input surface with pane-local drafts, command/file completion, and image mentions. */
export function Composer({
  connected,
  connectedBefore = false,
  paneId,
  autoFocus = true,
  active = true,
  agent,
  agentStatus,
  backgroundTasks = 0,
  plan = null,
  backgroundWait = false,
  metadata,
  answerHint = null,
  waitingAnswer = null,
  suggestion = null,
  restored = null,
  greeting = null,
  notices = null,
  role = "interact",
  inert = false,
  onOpenHistory,
  onOpenNewSession,
  cwd = null,
  branch = null,
  worktreeRepo = null,
  onSend,
  onAbort,
  onUploadImage,
}: ComposerProps) {
  const t = useT();
  const activeRef = useRef(active);
  activeRef.current = active;
  const machineId = useMachineId();
  const { fetchPaneFiles } = useMachineApi();
  const { settings, resolvedLanguage } = useSettings();
  const mobile = useMediaQuery("(max-width: 640px), (pointer: coarse)");
  const usageEnabled = settings.showUsage && !mobile && machineId === "local" && providerForAgent(agent) !== null;
  const { report: usageReport } = useUsage(usageEnabled);
  const usage = usageEnabled && usageReport !== null ? composerUsage(usageReport.providers, agent, settings.usageOrder, settings.usageHidden) : undefined;
  const usageWindows = usage === undefined ? [] : statusWindows(usage);
  const usageLimit = usageWindows[0];
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const measurementRef = useRef<HTMLTextAreaElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const hintRef = useRef<HTMLSpanElement | null>(null);
  /** the card's own width: a narrow one shows the task chip's count */
  const [cardWidth, setCardWidth] = useState(0);
  const [contextShown, setContextShown] = useState(false);
  const composingRef = useRef(false);
  // the chat lens's input surface takes the keyboard when it appears (a pane switch remounts
  // it), as the grid does in the terminal lens: a pane picked from the drawer is typed into
  // and once the user picks the pane App had switched to on its own
  useEffect(() => {
    if (autoFocus && !modalOpen()) textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef<Attachment[]>([]);
  const removedAttachments = useRef(new Set<number>());
  const fileRequest = useRef(0);
  const draftKey = `ovis:composer-draft:${paneStorageId(machineId, paneId)}`;
  const { text, sending } = useSyncExternalStore(composerDrafts.subscribe, () => composerDrafts.read(draftKey));
  const setText = useCallback((value: string | ((previous: string) => string)) => composerDrafts.set(draftKey, value), [draftKey]);
  // comments on the agent's replies (#511) go first in the next message, unless it is a slash command or an answer
  const commentsKey = replyCommentsKey(paneStorageId(machineId, paneId));
  const comments = useReplyComments(commentsKey);
  const commentsHeld = comments.length > 0 && commentsWait(text, answerHint !== null);
  const carried: readonly ReplyComment[] = commentsHeld ? [] : comments;
  const mounted = useRef(true);
  const [caret, setCaret] = useState(text.length);
  const textRef = useRef(text);
  const caretRef = useRef(caret);
  /** the restored text the box was filled with: only that fill is ever cleared, never the user's own typing */
  const filledFrom = useRef<string | null>(null);
  const commands = usePaneCommands(paneId, agent);
  const [files, setFiles] = useState<string[]>([]);
  /** the file list could not be read: said in the menu, never drawn as "no matches" */
  const [filesFailed, setFilesFailed] = useState(false);
  /**
   * what the last settled attachment did, for assistive tech (the tiles say it on screen); each
   * settlement gets its own id, so a repeat of the same words is a new node and is read again
   */
  const [announcement, setAnnouncement] = useState<{ id: number; text: string } | null>(null);
  const announce = useCallback((text: string) => setAnnouncement((previous) => ({ id: (previous?.id ?? 0) + 1, text })), []);
  const [slashUsage, setSlashUsage] = useState<Record<string, number>>(readSlashUsage);
  // the highlight lives in the refs below: a move redraws the menu, also when it lands on an index it held before
  const [, redrawMenu] = useState(0);
  const highlightedItemId = useRef<string | null>(null);
  const highlightedSearchKey = useRef<string | null>(null);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string | DraftRefusal | UploadFailure | null>(null);
  // shown only when chosen in Settings → Quick replies: a button beside the box was one more thing to read
  const quickOpen = settings.showQuickReplies;
  const quickReplies = quickReplyButtons(settings);
  /** the box's width: its text rewraps when the lane does (Settings → Chat width, a resized pane), and the automatic height with it */
  const [boxWidth, setBoxWidth] = useState(0);

  attachmentsRef.current = attachments;
  textRef.current = text;
  caretRef.current = caret;
  const syntax = skillSyntax(agent);
  /** the pane's `@` skills (OpenCode v2), listed with the files; a pane without them keeps the file menu alone */
  const atSkills = useMemo(() => atSkillCommands(commands), [commands]);
  const trigger = useMemo(() => activeTrigger(text, caret, { skills: syntax.skillTriggers.includes("$"), namespaced: syntax.namespaced, atSkills: atSkills.length > 0 }), [atSkills, syntax, caret, text]);
  /** /resume retains the session picker instead of being sent to the terminal. */
  const terminalTyped = useMemo(() => typedTerminalCommand(commands, text), [commands, text]);
  const uploading = attachments.some((attachment) => attachment.state === "uploading");
  /** a finished upload whose path waits for the message to be shortened: Send waits with it */
  const roomless = attachments.find((attachment) => attachment.state === "no-room");
  const agentLabel = agentDisplayLabel(agent);
  // the agent's suggestion stands in the empty box as it does in its own input, until anything is typed
  const offered = connected && answerHint === null && suggestion !== null ? suggestion : null;
  const offlineSentence = t(connectedBefore ? "Reconnecting…" : "Connecting…");
  const placeholder = !connected
    ? offlineSentence
    : answerHint ?? offered ?? t("Message {agent}…", { agent: agentLabel });

  // A cancelled send the agent put back in its input box fills an empty box again — without
  // focus, which would raise a phone's keyboard. When it is gone, only the untouched fill is
  // cleared: text the user typed or edited over it is their own and stays.
  useEffect(() => {
    if (restored !== null) {
      if (restored === filledFrom.current || textRef.current.trim() !== "" || sending) return;
      setText(restored);
      textRef.current = restored;
      caretRef.current = restored.length;
      setCaret(restored.length);
      filledFrom.current = restored;
      return;
    }
    if (filledFrom.current === null) return;
    if (textRef.current === filledFrom.current) {
      setText("");
      textRef.current = "";
      caretRef.current = 0;
      setCaret(0);
    }
    filledFrom.current = null;
  }, [restored]);

  useEffect(() => {
    const request = ++fileRequest.current;
    if (trigger?.kind !== "file") {
      setFiles([]);
      setFilesFailed(false);
      return;
    }
    const timer = window.setTimeout(() => {
      void fetchPaneFiles(paneId, trigger.query, 20)
        .then((next) => {
          if (request === fileRequest.current) { setFiles(next); setFilesFailed(false); }
        })
        .catch(() => {
          if (request === fileRequest.current) { setFiles([]); setFilesFailed(true); }
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [paneId, trigger?.kind, trigger?.query]);

  const searchKey = trigger === null ? null : `${trigger.kind}:${trigger.prefix ?? ""}:${trigger.query}`;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // files not yet sent and paths not yet placed go with the pane
      uploadQueue.current = [];
      waitingMentions.current = [];
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.previewUrl);
    };
  }, []);

  // The app's faces swap in after the first paint (fonts/fonts.css, font-display: swap) and are
  // not as wide as the fallback they replace. No box changes size for that, so nothing else
  // would measure again: each face's arrival (lib/fontFaces.ts) renders the composer once more, which sizes the message
  // box (below) and fits the model label (fitStatus) with the face that is drawn.
  const facesLoaded = useFacesArrived();

  const sizeTextarea = useCallback(() => {
    const element = textareaRef.current;
    const measurement = measurementRef.current;
    if (!element || !measurement) return;
    // Measuring the live field at auto height enlarges the transcript and clamps its scroll.
    element.style.height = `${measurement.scrollHeight}px`;
  }, []);

  // A suggestion or prompt hint changes only the placeholder of a populated draft.
  useLayoutEffect(sizeTextarea, [sizeTextarea, text, text.length === 0 ? placeholder : null, boxWidth, facesLoaded]);

  // SettingsProvider writes --chat-scale in a passive effect. Measure on the next frame,
  // after that CSS is applied, so a draft rewraps without waiting for another keystroke.
  useEffect(() => {
    const frame = requestAnimationFrame(sizeTextarea);
    return () => cancelAnimationFrame(frame);
  // the UI language orders Noto's CJK families in an interface font (lib/typography.ts)
  }, [sizeTextarea, settings.chatFontSize, settings.chatFontFamily, settings.uiFontFamily, resolvedLanguage, settings.density]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setBoxWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * Two things the controls row asks of the layout itself, since what fits depends on the
   * model's name, the mic, the chip and the language, not on a width.
   * - The model label: measured with everything drawn, then drawn as composerModelDraw says
   *   (the effort word steps out first); measured again without it, a name cut to its floor steps
   *   out whole with its mark (composerLabelDraw), so the ring after it is drawn whole. Stepping
   *   out is CSS on the mark's attribute, so the label is still read. Drawn content changes fit
   *   the row again: opening the context number takes room from the label without changing
   *   the card's size.
   * - The sentence is never cut. Where it does not fit beside the model it wraps to a line of its
   *   own (CSS); there it is marked, so it takes the whole line and drops the dot that separated
   *   it from the model. The sentence alone wraps: the rest stays one row (.composer-status-meta),
   *   so beside a sentence too the label is measured clipped and steps out, not onto more lines.
   */
  const fitStatus = useCallback((): void => {
    const status = statusRef.current;
    if (!status) return;
    // Fitting temporarily exposes hidden labels and unwraps hints. Keep those measurement
    // layouts from moving the focused textarea before the final attributes are restored.
    const surface = surfaceRef.current;
    const rows = surface?.style.gridTemplateRows ?? "";
    if (surface) surface.style.gridTemplateRows = getComputedStyle(surface).gridTemplateRows;
    try {
      status.removeAttribute("data-model");
      status.removeAttribute("data-hint-alone");
      status.removeAttribute("data-meta-empty");
      const clipped = (selector: string): boolean => {
        const item = status.querySelector<HTMLElement>(selector);
        return item !== null && item.scrollWidth > item.clientWidth;
      };
      const first = composerModelDraw({
        modelClipped: clipped(".composer-model"),
        effortClipped: clipped(".composer-reasoning"),
      });
      if (first !== "full") status.setAttribute("data-model", first);
      // with the level stepped out the row is laid out again: a name still cut to its floor (its
      // min-width, in px once computed) takes the mark and the hairlines out with it
      const model = status.querySelector<HTMLElement>(".composer-model");
      const draw = model === null ? first : composerLabelDraw(first, {
        modelClipped: model.scrollWidth > model.clientWidth,
        modelWidth: model.clientWidth,
        modelFloor: parseFloat(getComputedStyle(model).minWidth) || 0,
      });
      if (draw !== first) status.setAttribute("data-model", draw);
      const hint = hintRef.current;
      if (!hint) return;
      // with the label stepped out and no ring, the row beside the sentence draws nothing: it gives
      // up its box, or it would keep an empty line over the sentence
      const meta = status.querySelector<HTMLElement>(".composer-status-meta")?.getBoundingClientRect();
      if (!meta || meta.width <= 1) status.setAttribute("data-meta-empty", "");
      const line = hint.getBoundingClientRect();
      const beside = meta !== undefined && meta.width > 1 && meta.bottom > line.top && meta.top < line.top + line.height / 2 && meta.right <= line.left + 1;
      if (!beside) status.setAttribute("data-hint-alone", "");
    } finally {
      if (surface) surface.style.gridTemplateRows = rows;
    }
  }, []);

  // SettingsProvider applies typography in a passive effect. Fit after those CSS tokens land,
  // even when the card's total width stays the same, without fitting on streaming renders.
  useEffect(() => {
    const frame = requestAnimationFrame(fitStatus);
    return () => cancelAnimationFrame(frame);
  }, [fitStatus, settings.uiFontSize, settings.uiFontFamily,
    settings.chatFontSize, settings.chatFontFamily, settings.density]);

  // the card's own width decides, not the window's: a sidebar or a narrow lane shrinks the card
  // in a wide window. Measured before the first paint, so a phone never draws the words first.
  // A resize fits the row on the next frame: marking it inside the observer's own callback can
  // change the card's height there, which the browser reports as a ResizeObserver loop
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let frame = 0;
    let width = Math.round(surface.getBoundingClientRect().width);
    setCardWidth(width);
    const observer = new ResizeObserver(() => {
      const next = Math.round(surface.getBoundingClientRect().width);
      if (next === width) return;
      width = next;
      setCardWidth(width);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitStatus);
    });
    observer.observe(surface);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  const filteredCommands = useMemo(
    () => (trigger?.kind === "slash"
      ? rankSlashCommands(commandsForTrigger(commands, agent, trigger), trigger.query, slashUsage, trigger.start > 0 && text[trigger.start - 1] !== "\n")
      : []),
    [agent, commands, slashUsage, text, trigger],
  );
  // a typed query lists the matches in rank order, whatever their source (a plugin command whose
  // word starts with it must not sit under a built-in that only has its letters scattered);
  // the source then rides on each row. Only a bare `/` or `$` lists by group.
  const groupedBySource = trigger?.kind === "slash" && trigger.query === "";
  const orderedCommands = useMemo(
    () => groupedBySource ? COMMAND_GROUPS.flatMap((group) => filteredCommands.filter((command) => commandGroup(command) === group)) : filteredCommands,
    [filteredCommands, groupedBySource],
  );
  // the `@` skills the typed mention names, before the files: a path never names one (prefixOnly)
  const atChoices = useMemo(
    () => (trigger?.kind === "file" ? rankSlashCommands(atSkills, trigger.query, slashUsage, true) : []),
    [atSkills, slashUsage, trigger],
  );
  const choices: readonly (SlashCommand | string)[] = trigger?.kind === "slash" ? orderedCommands : [...atChoices, ...files];
  const menuOpen = !menuDismissed && trigger !== null && choices.length > 0;
  // a failed listing opens the menu on its one line, which no key picks; beside listed skills it is a line of theirs
  const filesFailedShown = !menuDismissed && trigger?.kind === "file" && filesFailed && files.length === 0 && !menuOpen;
  // clamped as the list is drawn, not by an effect after it: a Tab or Enter typed before that
  // effect's render found no row at the old index and did nothing
  const choiceIds = choices.map((choice) => typeof choice === "string" ? `file:${choice}` : `${choice.source}:${choice.name}`);
  const activeItemId = resolveComposerMenuActiveItemId({
    items: choiceIds.map((id) => ({ id })),
    highlightedItemId: searchKey === null ? null : highlightedItemId.current,
    currentSearchKey: searchKey,
    highlightedSearchKey: highlightedSearchKey.current,
  });
  const selectedIndex = activeItemId === null ? 0 : choiceIds.indexOf(activeItemId);
  if (activeItemId !== null && searchKey !== null) {
    highlightedItemId.current = activeItemId;
    highlightedSearchKey.current = searchKey;
  } else {
    highlightedItemId.current = null;
    highlightedSearchKey.current = searchKey;
  }

  // dictation lands at the caret without taking focus (a phone's keyboard stays as it was). An inert
  // box (under a peek) is no dictation target: Mod+Shift+Space and the Escape that cancels a
  // recording stay the terminal's
  const dictation = useDictation({
    mode: "chat",
    active: active && !inert,
    connected,
    phone: mobile,
    polish: settings.voicePolishChat,
    keywords: () => [...(agent ? [agentLabel] : []), ...commands.map((command) => command.name)],
    box: textareaRef,
    read: () => textRef.current,
    // a dictation that does not fit is refused whole: cutting would drop the draft after the caret
    maxLength: MAX_COMPOSER_CHARS,
    write: (value, at) => {
      textRef.current = value;
      caretRef.current = at;
      setText(value);
      setCaret(at);
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (element) element.selectionStart = element.selectionEnd = at;
      });
    },
    onNote: setNote,
  });

  /** the note for a paste the box cut, held across the change event that follows it */
  const pasteCutNote = useRef<string | null>(null);

  // the box clamps at its cap without a word: the cap is said once, as it is reached, through the
  // polite region (the status line shows it; a line that appears with its words is not announced)
  const wasFull = useRef(false);
  useEffect(() => {
    const full = composerFull(text.length, MAX_COMPOSER_CHARS);
    if (full && !wasFull.current) announce(t("{max}-character limit", { max: formatChars(MAX_COMPOSER_CHARS) }));
    wasFull.current = full;
  }, [announce, t, text]);

  const setTextAndCaret = useCallback((nextText: string, nextCaret: number) => {
    const limitedText = nextText.slice(0, MAX_COMPOSER_CHARS);
    const clampedCaret = Math.min(nextCaret, MAX_COMPOSER_CHARS);
    textRef.current = limitedText;
    caretRef.current = clampedCaret;
    // committed now and the caret placed in the same task: a placement deferred to the next frame
    // would land on whatever was typed or selected meanwhile, behind a key typed right after a completion
    flushSync(() => {
      setText(limitedText);
      setCaret(clampedCaret);
      setMenuDismissed(false);
    });
    const element = textareaRef.current;
    if (!element) return;
    element.selectionStart = element.selectionEnd = clampedCaret;
    if (activeRef.current) element.focus();
  }, []);

  // an upload finishes while the user may be typing: its mention goes to the start (insertLeadingMention),
  // and the caret and selection only move along with the text they sit in, without taking focus
  /** 0 once inserted; otherwise how many characters short the message is, and nothing changed */
  const insertMentionAtStart = useCallback((mention: string, earlier: readonly string[]): number => {
    const element = textareaRef.current;
    const currentText = textRef.current;
    const selectionIsCurrent = element?.value === currentText;
    const start = selectionIsCurrent ? (element.selectionStart ?? caretRef.current) : caretRef.current;
    const end = selectionIsCurrent ? (element.selectionEnd ?? start) : start;
    const direction = selectionIsCurrent ? (element.selectionDirection ?? undefined) : undefined;
    const next = insertLeadingMention(currentText, mention, earlier);
    if (next.missing !== undefined) return next.missing;
    const moved = (position: number) => (position >= next.at ? position + next.length : position);
    textRef.current = next.text;
    caretRef.current = moved(start);
    flushSync(() => {
      setText(next.text);
      setCaret(moved(start));
    });
    if (element) element.setSelectionRange(moved(start), moved(end), direction);
    return 0;
  }, []);

  // one queue for the whole box: a pick made while another uploads waits its turn
  const uploadQueue = useRef<Attachment[]>([]);
  const uploadsRunning = useRef(0);
  /** paths placed so far, by attachment id: ids follow pick order */
  const placedMentions = useRef(new Map<number, string>());
  /** finished uploads whose paths wait for a /command or an IME composition to end, or for room */
  const waitingMentions = useRef<{ id: number; path: string; name: string }[]>([]);

  const placeWaitingMentions = useCallback(() => {
    if (waitingMentions.current.length === 0) return;
    if (composingRef.current || /^\/\S*$/u.test(textRef.current)) return;
    const waiting = waitingMentions.current.sort((a, b) => a.id - b.id);
    waitingMentions.current = [];
    const attached: string[] = [];
    for (const [index, { id, path, name }] of waiting.entries()) {
      if (removedAttachments.current.has(id)) continue;
      const mention = imageMention(path);
      const earlier = [...placedMentions.current].filter(([placed]) => placed < id).map(([, placed]) => placed);
      // no room for the whole path: this attachment and the ones picked after it stay waiting, in
      // their order, Send stays off, and the next edit of the text tries again (the effect below);
      // a cut path would name a file that is not there, so the tile says how much to cut instead
      const missing = insertMentionAtStart(mention, earlier);
      if (missing > 0) {
        waitingMentions.current.push(...waiting.slice(index));
        setAttachments((current) => current.map((item) => (item.id === id ? { ...item, state: "no-room", missing } : item)));
        break;
      }
      placedMentions.current.set(id, mention);
      setAttachments((current) => current.map((item) => (item.id === id ? { ...item, path, state: "ready" } : item)));
      attached.push(t("{name} attached", { name }));
    }
    if (attached.length > 0) announce(attached.join(" "));
  }, [announce, insertMentionAtStart, t]);

  // whatever wrote the text (typing, a completion, dictation, a cleared draft), a waiting path tries
  // again in the next frame, after that write's own caret placement has landed
  useEffect(() => {
    if (waitingMentions.current.length === 0) return;
    const frame = requestAnimationFrame(placeWaitingMentions);
    return () => cancelAnimationFrame(frame);
  }, [placeWaitingMentions, text]);

  const selectCompletion = useCallback(
    (choice: SlashCommand | string, currentTrigger: ActiveTrigger) => {
      const replacement = typeof choice === "string" ? `@${choice} `
        : currentTrigger.kind === "slash" ? slashCommandReplacement(choice, agent, currentTrigger) : atSkillReplacement(choice);
      const completed = applyCompletion(text, currentTrigger, replacement);
      setTextAndCaret(completed.text, completed.caret);
      setMenuDismissed(true);
      if (typeof choice !== "string") {
        if (terminalCommand(choice) && choice.name === "resume") onOpenHistory?.();
        const name = choice.name;
        setSlashUsage((current) => {
          const next = { ...current, [name]: (current[name] ?? 0) + 1 };
          try {
            window.localStorage.setItem(SLASH_USAGE_KEY, JSON.stringify(next));
          } catch {
            // Completion still works when storage is unavailable.
          }
          return next;
        });
      }
    },
    [agent, onOpenHistory, setTextAndCaret, text],
  );

  const pumpUploads = useCallback(() => {
    // a few at a time: each upload holds its file as base64 until it is sent
    while (mounted.current && uploadsRunning.current < UPLOADS_AT_ONCE && uploadQueue.current.length > 0) {
      const attachment = uploadQueue.current.shift()!;
      if (removedAttachments.current.has(attachment.id)) continue;
      uploadsRunning.current += 1;
      void onUploadImage(attachment.file)
        .then(
          (path) => {
            if (!mounted.current || removedAttachments.current.has(attachment.id)) return;
            waitingMentions.current.push({ id: attachment.id, path, name: attachment.file.name });
            placeWaitingMentions();
          },
          (error: unknown) => {
            if (!mounted.current || removedAttachments.current.has(attachment.id)) return;
            setAttachments((current) =>
              current.map((item) => (item.id === attachment.id ? { ...item, state: "error" } : item)),
            );
            // the size limit's own sentence is already plain and is the note; anything else is one line
            // naming what failed and the cause it knows, the rest behind Details
            if (error instanceof AttachmentTooLargeError) {
              setNote(attachment.leftOut ? `${error.message} ${attachment.leftOut}` : error.message);
              return;
            }
            const failure = userFailure(error);
            setNote({ attachment, failure });
          },
        )
        .finally(() => {
          uploadsRunning.current -= 1;
          pumpUploads();
        });
    }
  }, [onUploadImage, placeWaitingMentions]);

  const uploadImages = useCallback(
    (incoming: readonly File[]) => {
      const images = incoming.slice(0, ATTACH_LIMIT);
      if (images.length === 0) return;

      // the files left out of this pick: told now, and again beside an upload error of this batch
      const leftOut = images.length < incoming.length
        ? t("Only the first {count} of {total} files were taken.", { count: images.length, total: incoming.length })
        : null;
      const added = images.map<Attachment>((file) => {
        const uploadFile = normalizeComposerImageFile(file);
        return {
          id: ++attachmentSequence,
          file: uploadFile,
          previewUrl: (PREVIEW_TYPES as readonly string[]).includes(uploadFile.type)
            ? URL.createObjectURL(uploadFile)
            : "",
          path: null,
          state: "uploading",
          leftOut,
        };
      });
      setAttachments((current) => [...current, ...added]);
      setNote(leftOut);
      uploadQueue.current.push(...added);
      pumpUploads();
    },
    [pumpUploads, t],
  );

  /** Try again on a failed upload: the tile uploads once more, its note gone */
  const retryUpload = useCallback((attachment: Attachment) => {
    setNote(null);
    setAttachments((current) => current.map((item) => (item.id === attachment.id ? { ...item, state: "uploading" } : item)));
    uploadQueue.current.push(attachment);
    pumpUploads();
  }, [pumpUploads]);

  const removeAttachment = useCallback((attachment: Attachment) => {
    removedAttachments.current.add(attachment.id);
    placedMentions.current.delete(attachment.id);
    URL.revokeObjectURL(attachment.previewUrl);
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    // the note about this tile's failed upload goes with the tile
    setNote((current) => typeof current === "object" && current !== null && "failure" in current && current.attachment.id === attachment.id ? null : current);
    if (attachment.path) {
      const mention = imageMention(attachment.path);
      setText((current) => {
        const next = current.replace(mention, "");
        textRef.current = next;
        caretRef.current = Math.min(caretRef.current, next.length);
        return next;
      });
    } else {
      // removing a path that had no room leaves the text as it was, so the paths waiting behind it
      // would wait for the next edit: try them now
      placeWaitingMentions();
    }
  }, [placeWaitingMentions]);

  /** `clearDraft`: the terminal draft a DraftRefusal named, which the user asked to clear and send over;
   * `sendAnyway`: the user saw the box a DraftRefusal showed and sends over it. */
  const send = useCallback((clearDraft?: string, sendAnyway = false): boolean => {
    if (composingRef.current) return false;
    if (role === "observe" || !connected || uploading || roomless || sending || (text.trim().length === 0 && carried.length === 0)) return false;
    if (terminalTyped?.name === "resume" && onOpenHistory) { setMenuDismissed(true); onOpenHistory(); return true; }
    const message = carried.length > 0 ? messageWithComments(carried, text) : text;
    if (message.length > MAX_COMPOSER_CHARS) { setNote(t("Too long with the comments: remove a comment or shorten the message.")); return false; }
    const sentComments = carried;
    const sent = text;
    const sentAttachments = attachments;
    let sendId: number | undefined;
    const settle = (result: boolean | string | DraftRefusal): void => {
      // a send for a pane another herdr has replaced since leaves the new pane's box alone (#1608)
      const acknowledged = result === true ? composerDrafts.settle(draftKey, sent, sendId) : null;
      // the comments it carried are sent: any written meanwhile wait for the next message
      if (result === true && sentComments.length > 0) replyComments.removeSent(commentsKey, sentComments);
      if (!mounted.current) return;
      if (typeof result !== "boolean") setNote(result);
      if (acknowledged === null) return;
      // only what was sent leaves the box: text added after it stays exactly as typed. Changed
      // inside while on its way, the whole edit stays, and the note says it was not sent
      const { text: rest, edited } = acknowledged;
      setCaret(rest.length);
      textRef.current = rest;
      caretRef.current = rest.length;
      setNote(edited ? t("Sent as it was. Your changes made while it was sending stayed here and were not sent.") : null);
      for (const attachment of sentAttachments) { URL.revokeObjectURL(attachment.previewUrl); placedMentions.current.delete(attachment.id); }
      setAttachments((current) => current.filter((attachment) => !sentAttachments.includes(attachment)));
    };
    if (!composerDrafts.begin(draftKey, sent)) return false;
    sendId = composerDrafts.sendOf(draftKey);
    // a polish landing before the acknowledgement would count as an edit and keep the sent message here
    dictation.forget();
    try {
      // a message with comments goes only to an agent: a shell would read `> quote` as a redirect
      const result = sentComments.length > 0 ? onSend(message, clearDraft, sendAnyway, true) : onSend(message, clearDraft, sendAnyway);
      if (!(result instanceof Promise)) { settle(result); composerDrafts.end(draftKey, sendId); return true; }
      void result.then(settle).catch(() => { if (mounted.current) setNote(t("Not confirmed. Check the terminal before sending again.")); }).finally(() => composerDrafts.end(draftKey, sendId));
    } catch {
      composerDrafts.end(draftKey, sendId);
      if (mounted.current) setNote(t("Not confirmed. Check the terminal before sending again."));
    }
    return true;
  }, [attachments, carried, commentsKey, connected, dictation.forget, draftKey, onOpenHistory, onSend, role, roomless, sending, t, terminalTyped, text, uploading]);
  const sendRef = useRef(send);
  sendRef.current = send;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  // A Send tapped while the keyboard still composes the last word (Gboard composes every word,
  // CJK IMEs an open syllable) finishes that word and sends once it commits. The button keeps
  // focus (above), so nothing in the tap commits the word: a blur does (Chrome ends the
  // composition on a focus change and fires compositionend at once), and the refocus inside the
  // same gesture keeps the keyboard up. A keyboard that still does not commit by the tap's
  // deadline gets the tap withdrawn with a note, so a later commit never sends on its own.
  const commitWait = useRef<{ timer: ReturnType<typeof setTimeout> | null; deadline: number } | null>(null);
  const clearCommitWait = useCallback(() => {
    if (commitWait.current?.timer != null) clearTimeout(commitWait.current.timer);
    commitWait.current = null;
  }, []);
  useEffect(() => clearCommitWait, [clearCommitWait]);
  // a drop withdraws the tap: a quick reconnect inside the wait must not send it after all
  useEffect(() => {
    if (connected || commitWait.current === null) return;
    clearCommitWait();
    setNote(t("Not sent: the terminal is disconnected."));
  }, [clearCommitWait, connected, t]);
  const awaitCommit = useCallback((current: { timer: ReturnType<typeof setTimeout> | null; deadline: number }) => {
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = null;
    const left = current.deadline - Date.now();
    if (left <= 0) { commitWait.current = null; setNote(t("Finish the word, then send.")); return; }
    setNote(t("Finishing the word…"));
    current.timer = setTimeout(() => {
      if (commitWait.current !== current) return;
      commitWait.current = null;
      setNote(t("Finish the word, then send."));
    }, left);
  }, [t]);
  const sendTapped = useCallback(() => {
    // only a tap on a live connection waits for the commit: the wait ends with that connection
    if (!composingRef.current || !connected) { clearCommitWait(); send(); return; }
    clearCommitWait();
    const tapped = { timer: null, deadline: Date.now() + COMMIT_WAIT_MS };
    commitWait.current = tapped;
    const element = textareaRef.current;
    if (element !== null && document.activeElement === element) {
      element.blur();
      element.focus({ preventScroll: true });
    }
    // committed inside the tap (Chrome, Gboard): compositionend already queued the send, no note
    if (composingRef.current && commitWait.current === tapped) awaitCommit(tapped);
  }, [awaitCommit, clearCommitWait, connected, send]);
  /** The committed word's send, a tick after compositionend, for a tap still waiting. */
  const sendCommitted = useCallback(() => {
    const current = commitWait.current;
    if (current === null) return;
    // a new composition after the commit: wait out what is left of the tap's window, no more
    if (composingRef.current) { awaitCommit(current); return; }
    clearCommitWait();
    setNote(null);
    // a send that cannot go out (offline, uploading) says so instead of leaving the tap without a word
    if (!sendRef.current() && textRef.current.trim().length > 0) {
      setNote(connectedRef.current ? t("Not sent. Send it again.") : t("Not sent: the terminal is disconnected."));
    }
  }, [awaitCommit, clearCommitWait, t]);

  /**
   * A quick reply, or a typed pick's Confirm, follows the same delivery policy as Send, and leaves the box alone.
   * `draft`: Send it's terminal draft. Its note, with the draft and its buttons, stays until the send is confirmed,
   * and one that did not go names the draft (draftSendNote).
   */
  const sendBeside = useCallback((deliver: () => ReturnType<typeof onSend>, draft?: string) => {
    if (!connected || sending) return;
    if (draft === undefined) setNote(null);
    const settle = (result: boolean | string | DraftRefusal): void => {
      if (!mounted.current) return;
      // false sent nothing: Send it's note stays as it was
      if (draft !== undefined) { if (result === true) setNote(null); else if (result !== false) setNote(draftSendNote(result, draft)); return; }
      // a quick reply is not the box's text, so its note offers no send over a draft
      if (typeof result !== "boolean") setNote(typeof result === "string" ? result : "plain" in result && result.plain === true ? result.note : submitNote("input_draft", result.note));
    };
    const unconfirmed = (): void => {
      const note = t("Not confirmed. Check the terminal before sending again.");
      if (mounted.current) setNote(draft === undefined ? note : draftSendNote(note, draft));
    };
    if (!composerDrafts.begin(draftKey)) return;
    const sendId = composerDrafts.sendOf(draftKey);
    try {
      const result = deliver();
      if (!(result instanceof Promise)) { settle(result); composerDrafts.end(draftKey, sendId); return; }
      void result.then(settle).catch(unconfirmed).finally(() => composerDrafts.end(draftKey, sendId));
    } catch {
      composerDrafts.end(draftKey, sendId);
      unconfirmed();
    }
  }, [connected, draftKey, sending]);
  const sendQuick = useCallback((reply: string) => sendBeside(() => onSend(reply)), [onSend, sendBeside]);
  /** Send it: the terminal draft a DraftRefusal named goes as it is, as Clear it and send with the draft for the message. */
  const sendDraft = useCallback((draft: string) => sendBeside(() => onSend(draft, draft), draft), [onSend, sendBeside]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // an IME keeps its keys; WebKit can send the committing Enter after compositionend, as key code 229
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (menuOpen && trigger) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          const nextIndex = (selectedIndex + direction + choices.length) % choices.length;
          redrawMenu((count) => count + 1);
          highlightedItemId.current = choiceIds[nextIndex] ?? null;
          highlightedSearchKey.current = searchKey;
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const choice = choices[selectedIndex];
          if (choice !== undefined) selectCompletion(choice, trigger);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setMenuDismissed(true);
          return;
        }
      }
      if (event.key === "Escape" && trigger && !menuDismissed) {
        setMenuDismissed(true);
        return;
      }
      // a draft puts Send where Stop was: Escape is then the Stop the agent's own input has
      if (event.key === "Escape" && connected && agentStatus === "working" && textRef.current.trim().length > 0) {
        event.preventDefault();
        onAbort();
        return;
      }
      // Tab takes the suggestion into the empty box, as in Claude's own input
      if (event.key === "Tab" && !event.shiftKey && offered !== null && textRef.current === "") {
        event.preventDefault();
        setTextAndCaret(offered, offered.length);
        return;
      }
      const shouldSend = event.key === "Enter" && (settings.enterSends
        ? !event.shiftKey && !event.metaKey && !event.ctrlKey
        : (event.metaKey || event.ctrlKey) && !event.shiftKey);
      // a typed pick waits in the card above: the empty box's Enter is its Confirm and Escape its
      // Cancel, so the keyboard alone answers, as it does in the agent's own menu. A held Enter's
      // repeats confirm nothing: its first press was the pick
      if (waitingAnswer !== null && textRef.current === "") {
        if (event.key === "Escape") {
          event.preventDefault();
          waitingAnswer.cancel();
          return;
        }
        if (shouldSend) {
          event.preventDefault();
          if (!event.repeat) sendBeside(waitingAnswer.confirm);
          return;
        }
      }
      if (!shouldSend) return;
      event.preventDefault();
      send();
    },
    [agentStatus, choices, connected, menuDismissed, menuOpen, offered, onAbort, selectCompletion, selectedIndex, send, sendBeside, setTextAndCaret, settings.enterSends, trigger, waitingAnswer],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const box = event.currentTarget;
      const over = pasteOverflow(box.value, box.selectionStart, box.selectionEnd, event.clipboardData.getData("text"), MAX_COMPOSER_CHARS);
      if (over > 0) {
        // the box cuts the paste itself; the change event it fires would clear a note, so this one is kept for it
        const cut = t("{count} characters of the paste did not fit: a message holds {max}.", { count: formatChars(over), max: formatChars(MAX_COMPOSER_CHARS) });
        pasteCutNote.current = cut;
        setNote(cut);
        setTimeout(() => { pasteCutNote.current = null; }, 0);
      }
      const images = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (images.length === 0) return;
      event.preventDefault();
      void uploadImages(images);
    },
    [t, uploadImages],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      void uploadImages(Array.from(event.dataTransfer.files));
    },
    [uploadImages],
  );

  const isWorking = agentStatus === "working";
  // an explicit click sends /compact the way a typed message goes; only where the agent lists it, never while it works
  const compactText = compactCommandText(commands);
  const compactNow = compactText !== null && connected && !sending && !isWorking && agentStatus !== "blocked" ? () => sendQuick(compactText) : undefined;
  // what the status line says; what may be sent, queued or stopped goes by the agent's own status
  const shownStatus = paneStatus({ agent_status: agentStatus, ...(backgroundWait ? { background_wait: true as const } : {}) });
  const statusCompact = composerStatusCompact(cardWidth);
  const sendShown = sending || carried.length > 0 || composerSendShown({ working: isWorking, text });
  const hint = composerStatusHint({ uploading, connected, text, noRoom: roomless !== undefined });
  const model = metadata?.model ? modelLabel(metadata.model) : null;
  const modelShown = Boolean(metadata?.model || metadata?.reasoning_effort);
  const usageDetail = usageWindows.map((window) => {
    const reset = formatResetIn(window.resets_at, Date.now());
    return `${windowLabel(window)} ${meterText(window, settings.usageCount)}${reset ? ` · ${t("Resets in {time}", { time: reset })}` : ""}`;
  }).join("\n");
  const usageCaption = usageLimit === undefined ? "" : `${usageLimit.kind === "session" ? "5h" : windowLabel(usageLimit)} ${formatPercent(meterPercent(usageLimit, settings.usageCount))}`;
  const usageAccessible = usage === undefined ? "" : `${t("Subscription usage")}: ${usageName(usage)}, ${usageDetail.replaceAll("\n", ", ")}`;
  const hintText = hint === null ? null
    : hint === "no-room" ? t("{max}-character limit · {count} over", { max: formatChars(MAX_COMPOSER_CHARS), count: formatChars(roomless?.missing ?? 0) })
    : hint === "near-limit" ? composerFull(text.length, MAX_COMPOSER_CHARS) ? t("{max}-character limit", { max: formatChars(MAX_COMPOSER_CHARS) }) : t("{count} characters left", { count: MAX_COMPOSER_CHARS - text.length })
    : hint === "uploading" ? t("Uploading file…") : offlineSentence;
  /** an upload's failure as one line: what failed and the cause it knows, then what the pick left out */
  const noteLine = note === null ? null : typeof note === "string" ? note : "failure" in note
    ? [note.failure.cause === null ? t("{name} could not be attached", { name: note.attachment.file.name }) : t("{name} could not be attached: {reason}", { name: note.attachment.file.name, reason: note.failure.cause }), note.attachment.leftOut].filter((part) => part !== null).join(" ")
    : note.note;
  /** the strip under the card: the folder and the branch the caller knows; none, or a phone's screen, no strip */
  const strip = mobile ? null : composerStrip({ cwd, branch, repo: worktreeRepo });
  const worktree = worktreeRepo !== null;
  // Fit only changes to drawn content. Streaming context usage is a fixed-size ring unless
  // its number is open on desktop; transcript/status refreshes need no measurement layout.
  useLayoutEffect(fitStatus, [fitStatus, agent, metadata?.model, metadata?.reasoning_effort,
    metadata?.context?.window, contextShown && !mobile && metadata?.context ? contextLeftPercent(metadata.context) : null,
    contextShown, mobile, usageCaption, usage?.problem, hintText, dictation.shown, backgroundTasks,
    plan?.done, plan?.total, plan?.current, statusCompact, compactNow !== undefined, facesLoaded, t]);
  const menuId = `composer-menu-${paneId}`;
  // the suggestions' own close, for a pointer or a phone, which has no Escape: it does what Escape does, and the
  // text and the focus stay in the box (a press never takes the focus; a key on it hands it back)
  const menuClose = (
    <button type="button" className="composer-menu-close" aria-label={t("Close suggestions")} title={t("Close suggestions")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => { setMenuDismissed(true); if (event.detail === 0) textareaRef.current?.focus({ preventScroll: true }); }}>
      <X aria-hidden="true" />
    </button>
  );
  // the arrow keys move the selection, not the focus (it stays in the box), so the browser does not scroll to it
  useEffect(() => {
    if (menuOpen) document.getElementById(`${menuId}-${selectedIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [menuOpen, menuId, selectedIndex, choices]);

  return (
    <div className={`composer${notices ? " has-notices" : ""}`} role="group" aria-label={t("Message composer")} data-dictating={dictation.voice.state !== "idle" ? "" : undefined} inert={inert || undefined}>
      {greeting}
      {notices}
      {/* no Tab key on a phone: the suggestion can be a chip there that fills the box, when Settings asks for it */}
      {settings.suggestionChip && offered !== null && text === "" && (
        <div className="composer-quick composer-suggestion-row">
          <button type="button" className="composer-quick-reply composer-suggestion" title={t("Use the suggestion")} onClick={() => setTextAndCaret(offered, offered.length)}>
            <span aria-hidden="true">↹ </span>{offered}
          </button>
        </div>
      )}

      {quickOpen && quickReplies.length > 0 && (
        <div className="composer-quick" role="group" aria-label={t("Quick replies")}>
          {quickReplies.map((reply, index) => (
            <button
              key={`${index}:${reply}`}
              type="button"
              className="composer-quick-reply"
              title={t("Send “{reply}”", { reply })}
              disabled={!connected || sending}
              onClick={() => sendQuick(reply)}
            >
              {reply}
            </button>
          ))}
        </div>
      )}

      <ReplyCommentsChip comments={comments} storageKey={commentsKey} waiting={commentsHeld} />

      {/* why the message in the box did not go: on the box's top edge, read with it, its one way on beside it */}
      {note !== null && noteLine !== null && (
        <div className="composer-note" role="alert">
          <TriangleAlert className="composer-note-icon" aria-hidden="true" />
          <div className="composer-note-text">
            {noteLine}
            {typeof note === "object" && "failure" in note && (note.failure.advice !== null || note.failure.detail !== null) && <details className="composer-note-details">
              <summary>{t("Details")}</summary>
              {note.failure.advice !== null && <p>{note.failure.advice}</p>}
              {note.failure.detail !== null && <code>{note.failure.detail}</code>}
            </details>}
          </div>
          {/* the draft named above, never what has replaced it since: the server checks; a box it could
              not tell empty, sent over only in the same Claude terminal the refusal was for */}
          {typeof note === "object" && ("failure" in note
            ? offersRetry(note.failure) && <button type="button" className="composer-note-action" disabled={!connected} onClick={() => retryUpload(note.attachment)}>{t("Try again")}</button>
            : <div className="composer-note-actions">
              {"draft" in note && <button type="button" className="composer-note-action" disabled={!connected || sending} onClick={() => sendDraft(note.draft)}>{t("Send it")}</button>}
              <button type="button" className="composer-note-action" disabled={!connected || uploading || roomless !== undefined || sending || text.trim().length === 0}
                onClick={() => "draft" in note ? send(note.draft) : send(undefined, true)}>{"draft" in note ? t("Clear it and send") : t("Send anyway")}</button>
            </div>)}
        </div>
      )}

      <div
        ref={surfaceRef}
        className={`composer-surface${dragging ? " is-dragging" : ""}`}
        data-compact={statusCompact ? "" : undefined}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        {menuOpen && trigger && (
          <div className="menu composer-menu">
            {menuClose}
            <div id={menuId} className="composer-menu-list" role="listbox" aria-label={t(trigger.kind === "slash" ? "Slash commands" : atSkills.length > 0 ? "Skills and files" : "Files")}>
            {(() => {
                // a row says what a command does in one sentence (the full text is the row's
                // tooltip), and a skill's icon says where it comes from: yours, this project's,
                // one that came with the agent, or one of its plugins'; a command that runs in the
                // terminal carries a Terminal badge wherever it is listed
                const groupLabel = (group: ReturnType<typeof commandGroup>): string => {
                  switch (group) {
                    case "skill-user": return t("Your skills");
                    case "skill-project": return t("Project skills");
                    case "skill-bundled": return t("Built-in skills");
                    case "skill-plugin": return t("Plugin skills");
                    case "terminal": return t("Terminal commands");
                    default: return t(SOURCE_LABEL[group]);
                  }
                };
                const ownerLabel = (origin: NonNullable<SlashCommand["origin"]>): string => {
                  switch (origin) {
                    case "user": return t("Your skill");
                    case "project": return t("Project skill");
                    case "bundled": return t("Built-in skill");
                    case "plugin": return t("Plugin skill");
                  }
                };
                const row = (command: SlashCommand, index: number, prefix: string, withSource: boolean) => {
                  const description = briefDescription(command.description);
                  const owner = command.origin === undefined ? null : ownerLabel(command.origin);
                  const Owner = command.origin === undefined ? null : ORIGIN_ICON[command.origin];
                  return (
                    <button
                      id={`${menuId}-${index}`}
                      key={`${command.source}:${command.name}`}
                      type="button"
                      className="menu-item"
                      role="option"
                      aria-selected={index === selectedIndex}
                      data-origin={command.origin}
                      data-terminal={terminalCommand(command) ? "" : undefined}
                      title={command.description.trim() !== "" ? command.description : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectCompletion(command, trigger)}
                    >
                      {Owner !== null && <Owner aria-hidden="true" />}
                      <span className="menu-item-main">{prefix}{command.name}</span>
                      {terminalCommand(command) && <span className="badge composer-menu-badge">{t("Terminal")}</span>}
                      {owner !== null && <span className="visually-hidden">{owner}</span>}
                      <span className="menu-item-hint">{withSource && owner === null ? `${t(SOURCE_LABEL[command.source])}${description ? " · " : ""}` : ""}{description}</span>
                    </button>
                  );
                };
                if (trigger.kind === "file") {
                  // the pane's `@` skills first, under their own heading, then the files (or the line saying they could not be read)
                  return <>
                    {atChoices.length > 0 && (
                      <div className="composer-menu-group">
                        <div className="menu-heading">{t("Skills")}</div>
                        {atChoices.map((command, index) => row(command, index, "@", false))}
                      </div>
                    )}
                    {(files.length > 0 || filesFailed) && (
                      <div className="composer-menu-group">
                        <div className="menu-heading">{t("Files")}</div>
                        {files.map((file, index) => (
                          <button
                            id={`${menuId}-${atChoices.length + index}`}
                            key={file}
                            type="button"
                            className="menu-item"
                            role="option"
                            aria-selected={atChoices.length + index === selectedIndex}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => selectCompletion(file, trigger)}
                          >
                            <span className="menu-item-main">{file}</span>
                          </button>
                        ))}
                        {filesFailed && files.length === 0 && <p className="chat-inline-state chat-inline-error">{t("Couldn't load suggestions. Keep typing to try again.")}</p>}
                      </div>
                    )}
                  </>;
                }
                const slashPrefix = (command: SlashCommand): string => syntax.skillTriggers.includes(trigger.prefix ?? "/") ? trigger.prefix ?? command.trigger ?? "/" : command.trigger ?? "/";
                if (!groupedBySource) return <div className="composer-menu-group">{orderedCommands.map((command, index) => row(command, index, slashPrefix(command), true))}</div>;
                return COMMAND_GROUPS.map((group) => {
                  const rows = orderedCommands.filter((command) => commandGroup(command) === group);
                  if (rows.length === 0) return null;
                  return (
                    <div className="composer-menu-group" key={group}>
                      <div className="menu-heading">{groupLabel(group)}</div>
                      {rows.map((command) => row(command, orderedCommands.indexOf(command), slashPrefix(command), false))}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}

        {filesFailedShown && (
          <div className="menu composer-menu">
            {menuClose}
            <div className="composer-menu-group">
              <div className="menu-heading">{t("Files")}</div>
              <p className="chat-inline-state chat-inline-error">{t("Couldn't load suggestions. Keep typing to try again.")}</p>
            </div>
          </div>
        )}

        {/* mounted before anything settles: a live region that appears with its text is not read */}
        <p className="visually-hidden" role="alert">{filesFailedShown ? t("Couldn't load suggestions. Keep typing to try again.") : null}</p>
        <p className="visually-hidden" aria-live="polite">{announcement && <span key={announcement.id}>{announcement.text}</span>}</p>

        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label={t("Attached files")}>
            {attachments.map((attachment) => (
              <div className={`composer-attachment is-${attachment.state}`} key={attachment.id}>
                {attachment.previewUrl ? <img src={attachment.previewUrl} alt={attachment.file.name} />
                  : <span className="composer-attachment-file" title={attachment.file.name}><FileText aria-hidden="true" /><span>{attachment.file.name}</span></span>}
                <span className="composer-attachment-state">
                  {/* a tile that failed or has no room shows the glyph alone: the line above or below the box
                      already says what happened, once */}
                  {attachment.state === "no-room" || attachment.state === "error"
                    ? <><TriangleAlert aria-hidden="true" /><span className="visually-hidden">{t(attachment.state === "error" ? "Failed" : "No room")}</span></>
                    : t(attachment.state === "uploading" ? "Uploading" : "Attached")}
                </span>
                <button type="button" aria-label={t("Remove {file}", { file: attachment.file.name })} onClick={() => removeAttachment(attachment)}>
                  <X aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => {
          composingRef.current = false;
          const waiting = commitWait.current;
          if (waiting !== null) {
            if (waiting.timer !== null) clearTimeout(waiting.timer);
            waiting.timer = null;
            // WebKit updates the value with an input event after compositionend: send the committed word
            setTimeout(sendCommitted);
          }
          // after the input that commits the candidate, which WebKit sends after compositionend, and
          // in a frame, after the caret of dictation held through the composition has landed
          setTimeout(() => requestAnimationFrame(() => { if (mounted.current) placeWaitingMentions(); }), 0);
        }}
          className="composer-text"
          rows={1}
          maxLength={MAX_COMPOSER_CHARS}
          value={text}
          placeholder={placeholder}
          aria-label={t("Message")}
          aria-controls={menuOpen ? menuId : undefined}
          aria-expanded={menuOpen}
          aria-activedescendant={menuOpen ? `${menuId}-${selectedIndex}` : undefined}
          // most of what is typed to an agent is prose: a phone keyboard's corrections, suggestions
          // and sentence capitals stay on here (the terminal input line keeps them off)
          spellCheck
          autoCapitalize="sentences"
          autoCorrect="on"
          // stays editable while the socket reconnects (sending waits for it): a phone's
          // dictation keyboard opens its own app and comes back, the socket may drop meanwhile,
          // and a disabled box would lose its focus and the dictated text with it
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          onClick={(event) => {
            setCaret(event.currentTarget.selectionStart);
            setMenuDismissed(false);
          }}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setMenuDismissed(false);
            setNote((current) => typeof current === "object" && current !== null && "failure" in current ? current : pasteCutNote.current);
          }}
        />
        <textarea
          ref={measurementRef}
          className="composer-measure"
          rows={1}
          value={text}
          placeholder={placeholder}
          readOnly
          tabIndex={-1}
          aria-hidden="true"
        />

        <div className="composer-controls composer-controls-left">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const picked = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void uploadImages(picked);
            }}
          />
          <button
            type="button"
            className="icon-button composer-attach"
            aria-label={t("Attach files")}
            title={t("Attach files")}
            disabled={!connected || uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus aria-hidden="true" />
          </button>
          {dictation.shown && <MicButton dictation={dictation} />}
          {/* only once this device turned it on (Settings → Chat → Composer; the composer's row stays minimal, and
              the tab menu opens the same dialog), and in a mouse-driven window only, like the usage glance: a phone's
              card has no row to spare beside the mic and the tasks chip, and its tab menu carries New tab with agent… already */}
          {onOpenNewSession && settings.composerNewTabButton && role !== "observe" && !mobile && (
            <button
              type="button"
              className="icon-button composer-new-session"
              aria-label={t("New tab with an agent…")}
              title={t("New tab with an agent…")}
              onClick={onOpenNewSession}
            >
              <MessageSquarePlus aria-hidden="true" />
            </button>
          )}
          <BackgroundTasks paneId={paneId} count={backgroundTasks} omo={agent === "omo"} subagents={agent === "claude" || agent === "opencode"} plan={plan} />
        </div>
        {/* between the two control groups of the card's last row. The agent's name, its separator and the
            state word are read, not drawn: the mark and the header name the agent, and Stop, the live row and
            the prompt card say the state. All state words stay available to assistive tech only.
            Where the model label does not fit, it steps out and is still read (fitStatus marks data-model) */}
        <div ref={statusRef} className="composer-status" role="status" data-status={shownStatus}
          data-offline={connected ? undefined : ""} data-hint={hint ?? undefined}>
          {/* everything but the sentence: one row that never wraps, also where the sentence takes a line of its own */}
          <span className="composer-status-meta">
            <span className="composer-agent-label visually-hidden">{agentLabel}</span>
            <span className="composer-status-separator visually-hidden" aria-hidden="true">·</span>
            <strong className="visually-hidden">{t(composerStatusWord(shownStatus))}</strong>
            {/* the mark, the model, the level and the context ring as one quiet pill. It only shows: no role,
                no focus, nothing to press but the ring inside it. A pane that names no model draws no pill
                (.is-bare): the mark, a level if it has one, and the ring stand in the row as they are */}
            <span className={`composer-pill${metadata?.model ? "" : " is-bare"}`}>
              {agent && <AgentMark agent={agent} size={14} />}
              {modelShown && <span className="composer-model-info" aria-label={t("Model and reasoning")}>
                {/* a name only for an id modelLabel can name for certain; any other id is drawn as received, in the identifier face */}
                <span className={`composer-model${model ? model.named ? "" : " is-id" : " is-none"}`} title={metadata?.model ?? t("Model not available")}>{model?.text ?? t("Model —")}</span>
                {/* behind a name the id as received is still read; a touch cannot reach the title */}
                {model?.named && <span className="composer-model-id visually-hidden">{metadata?.model}</span>}
                {/* no level recorded: nothing is drawn for it, no dot and no dash; the sentence is still read */}
                <span className={`composer-reasoning${metadata?.reasoning_effort ? "" : " visually-hidden"}`} title={metadata?.reasoning_effort ? t("Reasoning effort: {effort}", { effort: metadata.reasoning_effort }) : t("Reasoning effort not available")}>
                  <span className="composer-reasoning-full visually-hidden">{t("Reasoning {effort}", { effort: metadata?.reasoning_effort ?? "—" })}</span>
                  {metadata?.reasoning_effort && <>
                    <span className="composer-reasoning-dot" aria-hidden="true">·</span>
                    <span className="composer-reasoning-short" aria-hidden="true">{metadata.reasoning_effort}</span>
                  </>}
                </span>
              </span>}
              {metadata?.context && <ContextRing context={metadata.context} shown={contextShown} readOnly={mobile} onToggle={() => setContextShown((open) => !open)} onCompact={compactNow} />}
              {usage !== undefined && usage.problem === null && usageLimit !== undefined && <span
                className={`composer-usage${usageLimit.used_percent >= HIGH_PERCENT ? " is-high" : ""}${usage.problem ? " has-problem" : ""}`}
                title={`${usageName(usage)}\n${usageDetail}`}
              >
                <span aria-hidden="true">{usageCaption}</span>
                <span className="visually-hidden">{usageAccessible}</span>
              </span>}
            </span>
            {/* the chip is a button in the left controls; its count is still said here, where a change is announced */}
            {backgroundTasks > 0 && <span className="composer-task-count visually-hidden">{t(backgroundTasks === 1 ? "{n} background task" : "{n} background tasks", { n: backgroundTasks })}</span>}
          </span>
          {hintText !== null && (
            <span ref={hintRef} className={`composer-status-hint${hint === "no-room" ? " is-over" : ""}`} title={hintText}>
              <span className="composer-status-hint-dot" aria-hidden="true">· </span>{hintText}
            </span>
          )}
        </div>
        <div className="composer-controls composer-controls-right">
          {!sendShown ? (
            <button
              type="button"
              className="composer-action composer-stop"
              aria-label={t("Stop agent")}
              title={t("Stop agent")}
              disabled={!connected}
              onClick={onAbort}
            >
              <Square aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="composer-action composer-send"
              aria-label={t("Send message")}
              title={sending ? t("Sending…") : t("Send message")}
              aria-busy={sending || undefined}
              disabled={!connected || uploading || roomless !== undefined || sending || (text.trim().length === 0 && carried.length === 0)}
              // focus stays in the text box: leaving it closes the soft keyboard and moves the button
              // out from under the tap before the click lands
              onPointerDown={(event) => event.preventDefault()}
              onClick={sendTapped}
            >
              {sending ? <LoaderCircle className="composer-send-progress" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
            </button>
          )}
        </div>
      </div>
      {/* the strip tucked under the card (t3code's composer context strip): the pane's working folder and its
          branch, each drawn only when the caller passes it. It only names them; nothing in it is pressed */}
      {strip !== null && (
        <div className="composer-strip">
          {strip.folder !== null && <span className="composer-strip-item composer-strip-folder" title={strip.path ?? undefined}>
            {worktree ? <FolderGit2 aria-hidden="true" /> : <Folder aria-hidden="true" />}
            <span className="visually-hidden">{t("Working folder")}: </span>
            <span className="composer-strip-text">{strip.folder}</span>
            {worktree && <span className="composer-strip-kind">{t("Worktree")}</span>}
          </span>}
          {strip.branch !== null && <span className="composer-strip-item composer-strip-branch" title={strip.branch}>
            <GitBranch aria-hidden="true" />
            <span className="visually-hidden">{t("Branch")}: </span>
            <span className="composer-strip-text">{strip.branch}</span>
          </span>}
        </div>
      )}
      {/* above the whole composer: inside the surface it would cover the text being dictated */}
      {dictation.shown && <VoiceRecordingPill dictation={dictation} align="start" />}
    </div>
  );
}
