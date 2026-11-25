import { Fragment, useContext, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, FileText, Send } from "lucide-react";

import "./PromptCard.css";

import { ApiError } from "../lib/api.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import type { InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import { blocksStepNavigation, focusFollowsAnswer, pressOrigin, sendsChecksWithText, type TypedAnswer } from "../lib/promptAnswer.ts";
import { approvalScope, optionName, promptWords, type ApprovalScope } from "../lib/promptText.ts";
import { dismissKeyboardOn } from "../lib/keyboard.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { InlineMarkdown, Markdown } from "./Markdown.tsx";

function scopeCue(t: Translate, scope: ApprovalScope): string {
  switch (scope) {
    case "once": return t("This time only");
    case "always": return t("Keep allowing");
    case "deny": return t("Deny");
  }
}

export interface PromptCardProps {
  paneId: string;
  prompt: InteractivePrompt;
  onPromptChanged(): void;
  onTextChange?(text: string, cardGone?: boolean): void;
  initialText?: string;
  onAnswered(toMessageBox: boolean): void;
  answered?: boolean;
  /** an option picked by a typed message, sent only on Confirm */
  typedAnswer?: TypedAnswer | null;
  onTypedAnswerDone?(): void;
  stale?: boolean;
  screenWords?: string | null;
  context?: string | null;
  /** this device may only watch: the PC refuses its answers, so the card offers none and sends none, and says why */
  watching?: boolean;
}

export function PromptCard({ paneId, prompt, onPromptChanged, onTextChange, initialText, onAnswered, answered = false, typedAnswer = null, onTypedAnswerDone, stale = false, screenWords = null, context = null, watching = false }: PromptCardProps) {
  const t = useT();
  const { answerPanePrompt } = useMachineApi();
  const [selected, setSelected] = useState<Set<number>>(() => {
    if (prompt.default_option_indices && prompt.default_option_indices.length > 0) {
      return new Set(prompt.default_option_indices);
    }
    if (prompt.default_option_index !== undefined && prompt.default_option_index !== null) {
      return new Set([prompt.default_option_index]);
    }
    return new Set();
  });
  const [custom, setCustom] = useState(() => initialText ?? prompt.default_custom_text ?? "");
  const [sending, setPending] = useState(false);
  const pending = sending || answered;
  const held = pending || watching;
  const watchReason = watching ? t("This device can only watch.") : undefined;
  const watchReasonId = useId();
  const watchDescribed = watching ? watchReasonId : undefined;
  const describedBy = (...ids: (string | undefined)[]): string | undefined => ids.filter((id) => id !== undefined).join(" ") || undefined;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [error, setError] = useState<(UserError & { retry?: Omit<PromptAnswer, "pane_id" | "prompt_id"> }) | null>(null);
  const [foldedByUser, setFoldedByUser] = useState(false);
  const folded = foldedByUser && typedAnswer?.option_index === undefined;
  const cardRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  // the control Enter or Space last went down on: the click that follows on it is that key's
  const keyed = useRef<EventTarget | null>(null);
  // and the button a pointer last went down on, with what it was: a click can misname its pointer
  const down = useRef<{ target: EventTarget; pointerType: string } | null>(null);
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
    return () => { shown.current = false; };
  }, []);

  useEffect(() => {
    confirmRef.current?.scrollIntoView({ block: "nearest" });
  }, [typedAnswer]);

  useEffect(() => {
    const node = cardRef.current;
    return node === null ? undefined : dismissKeyboardOn(node, { atTopOnly: true });
  }, []);

  const answer = async (choice: Omit<PromptAnswer, "pane_id" | "prompt_id">, press?: { nativeEvent: Event; currentTarget: EventTarget }): Promise<boolean> => {
    if (pendingRef.current || watching) return false;
    pendingRef.current = true;
    // Native OpenCode multiselect fields and pi-ask's take checks and a custom entry in one answer.
    if (sendsChecksWithText(prompt) && (choice.option_indices !== undefined || choice.custom_text !== undefined)) {
      choice = {
        option_indices: [...selected].sort((a, b) => a - b),
        ...(custom.trim() ? { custom_text: custom.trim() } : {}),
      };
    }
    // read now: the pressed button is disabled while the answer is on its way, and loses the focus
    const fromCard = cardRef.current?.contains(document.activeElement) === true;
    const click = press?.nativeEvent as Partial<PointerEvent> | undefined;
    const origin = pressOrigin(press === undefined ? undefined : { pointerType: click?.pointerType, downType: down.current?.target === press.currentTarget ? down.current.pointerType : undefined, detail: click?.detail, keyed: keyed.current === press.currentTarget });
    keyed.current = null;
    down.current = null;
    const coarse = window.matchMedia?.("(pointer: coarse)").matches === true;
    setPending(true);
    setError(null);
    onTextChange?.("");
    try {
      await answerPanePrompt({ pane_id: paneId, prompt_id: prompt.id, ...choice });
      if (!shown.current) return false;
      const card = cardRef.current;
      const active = document.activeElement;
      onAnswered(focusFollowsAnswer({ fromCard, origin, coarse, cardMounted: card !== null, inCard: card?.contains(active) === true, onPage: active === null || active === document.body }));
    } catch (cause) {
      onTextChange?.(custom, !shown.current);
      if (!shown.current) return false;
      if (cause instanceof ApiError && cause.code === "reply_unconfirmed") {
        setError({ message: t("OpenCode did not confirm the answer. Check the question before sending again."), detail: null });
        onPromptChanged();
      } else if (cause instanceof ApiError && ((cause.status === 409 && cause.code === "prompt_changed") || (cause.status === 400 && cause.code === "invalid_answer"))) {
        setError({ message: t("The question on screen changed; check it and answer again."), detail: null });
        onPromptChanged();
      } else {
        setError({ ...userErrorMessage(cause), retry: choice });
      }
    }
    pendingRef.current = answered;
    setPending(false);
    return true;
  };

  const dropRetry = (): void => setError((current) => current?.retry === undefined ? current : { ...current, retry: undefined });

  const toggle = (index: number): void => {
    dropRetry();
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };

  const customLabelId = useId();
  const contextId = useId();

  const scopeIdBase = useId();
  // Claude renders the menu's own pick as "Redis (Recommended)": a tag reads better than the suffix (optionName)
  const labelOf = (option: string | InteractivePrompt["options"][number]): { text: string; recommended: boolean } => optionName(prompt, option);
  const hasChoices = prompt.options.some((_, index) => index !== prompt.custom_option_index);
  const words = promptWords(prompt, t);
  const markdown = prompt.text_format === "markdown";
  const openFile = useContext(OpenFileContext);
  const planFile = prompt.plan_file;
  const navigationBlocked = blocksStepNavigation(prompt, selected, custom);
  const stepsHeld = navigationBlocked || typedAnswer?.option_index !== undefined;

  return (
    <section className={`prompt-card${folded ? " is-folded" : ""}`} ref={cardRef} role="region" aria-label={t("Agent is asking")} aria-describedby={context ? contextId : undefined}
      onKeyDown={(event) => { down.current = null; keyed.current = event.key === "Enter" || event.key === " " ? event.target : null; }}
      onPointerDown={(event) => {
        keyed.current = null;
        const button = (event.target as Element).closest("button");
        down.current = button === null ? null : { target: button, pointerType: event.pointerType };
      }}>
      {context && <p id={contextId} className="visually-hidden">{context}</p>}
      <header className="prompt-card-header">
        {prompt.can_step_back && (
          <button
            type="button"
            className="btn btn-ghost prompt-card-back"
            disabled={held || stepsHeld}
            aria-label={t("Back")}
            aria-describedby={watchDescribed}
            title={watchReason ?? t("Back")}
            onClick={(event) => void answer({ step_back: true, draft: { option_indices: [...selected], custom_text: custom } }, event)}
          >
            <ArrowLeft aria-hidden="true" />
            <span>{t("Back")}</span>
          </button>
        )}
        <span className="visually-hidden">{t("input needed")}</span>
        <h2>{words.title}</h2>
        {/* on to the next question, this one left unanswered, as the agent's own key does (omo's Tab, Codex's →) */}
        {prompt.can_step_next && (
          <button
            type="button"
            className="btn btn-ghost prompt-card-next"
            disabled={held || navigationBlocked || typedAnswer?.option_index !== undefined}
            aria-label={t("Next question")}
            aria-describedby={watchDescribed}
            title={watchReason ?? t("Next question")}
            onClick={(event) => void answer({ step_next: true, draft: { option_indices: [...selected], custom_text: custom } }, event)}
          >
            <span>{t("Next")}</span>
            <ArrowRight aria-hidden="true" />
          </button>
        )}
        {planFile && openFile && (
          <button type="button" className="btn btn-ghost prompt-card-plan-file" onClick={() => openFile(planFile)}>
            <FileText aria-hidden="true" />{t("View plan")}
          </button>
        )}
        {/* in the header from its first render, clipped while empty (never display: none): a live region
            that appears together with its words is not read; one that is there and gets them is, and
            drawing it on one line in the header adds no row at rest and moves no option when the words arrive */}
        <p className={`prompt-card-status${pending || stale ? "" : " is-empty"}`} role="status" title={pending && stale ? `${t("Sending your answer…")} · ${t("Not updated: the question on screen may have changed.")}` : stale ? t("Not updated: the question on screen may have changed.") : pending ? t("Sending your answer…") : undefined}>{pending && t("Sending your answer…")}{pending && stale && " · "}{stale && t("Not updated: the question on screen may have changed.")}</p>
        <button type="button" className="prompt-card-fold" disabled={typedAnswer?.option_index !== undefined} aria-expanded={!folded} aria-label={t(folded ? "Expand question" : "Collapse question")} title={t(folded ? "Expand question" : "Collapse question")} onClick={() => setFoldedByUser(!folded)}>
          {folded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>
      </header>
      {prompt.steps && (
        <ol className="prompt-card-steps" aria-label={t("Questions")}>
          {prompt.steps.map((step, index) => {
            const isClickable = !step.current && (step.can_navigate || step.answered && prompt.can_step_back && !prompt.steps!.some((other) => other.can_navigate));
            return (
              <li
                key={index}
                className={`prompt-card-step${step.answered ? " is-answered" : ""}${step.current ? " is-current" : ""}${isClickable ? " is-clickable" : ""}`}
                aria-current={step.current ? "step" : undefined}
              >
                {isClickable ? (
                  <button
                    type="button"
                    className="prompt-card-step-button"
                    disabled={held || stepsHeld}
                    aria-label={words.step(index)}
                    aria-describedby={watchDescribed}
                    title={watchReason ?? (step.can_navigate ? words.step(index) : t("Back"))}
                    onClick={(event) => void answer({ step_index: index, draft: { option_indices: [...selected], custom_text: custom } }, event)}
                  >
                    <span className="prompt-card-step-mark" aria-hidden="true">{step.answered ? <Check /> : index + 1}</span>
                    <span className="prompt-card-step-label">{words.step(index)}</span>
                    {step.answered && <span className="visually-hidden">{t("(answered)")}</span>}
                  </button>
                ) : (
                  <>
                    <span className="prompt-card-step-mark" aria-hidden="true">{step.answered ? <Check /> : index + 1}</span>
                    <span className="prompt-card-step-label">{words.step(index)}</span>
                    {step.answered && <span className="visually-hidden">{t("(answered)")}</span>}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {/* why nothing on the card can be pressed here, for a touch screen too, where no title shows */}
      {watching && <p id={watchReasonId} className="prompt-card-hint">{watchReason}</p>}
      {navigationBlocked && <p className="prompt-card-hint">{t("Submit or clear edits before switching questions.")}</p>}
      {screenWords !== null && (
        <div className="prompt-card-words">
          <p className="prompt-card-words-text">{screenWords}</p>
          <p className="prompt-card-hint">{t("From the terminal, until the agent saves this turn")}</p>
        </div>
      )}
      {/* a Claude approval's heading is its question too: said once */}
      {prompt.question !== prompt.title && (markdown
        ? <Markdown className="prompt-card-question">{words.question}</Markdown>
        : <p className="prompt-card-question">{words.question}</p>)}
      {prompt.queued && (
        <p className="prompt-card-hint">
          {prompt.queued === "open"
            ? t("Codex keeps working meanwhile. Answer here; the question holds the terminal's input until it is answered or closed.")
            : t("Codex keeps working meanwhile. Answer here; the message box still talks to Codex.")}
        </p>
      )}
      {prompt.answers && (
        <dl className="prompt-card-answers">
          {prompt.answers.map((item, index) => {
            const answer = item.answer === null ? null : labelOf(item.answer);
            return (
              <div key={index} className="prompt-card-answer">
                {item.question !== null && <dt>{item.question}</dt>}
                <dd className={answer === null ? "is-empty" : undefined}>
                  {answer === null ? t("Not answered") : <>{answer.text}{answer.recommended && <> <span className="prompt-card-tag">{t("Recommended")}</span></>}</>}
                </dd>
                {item.note !== undefined && <dd className="prompt-card-answer-note">{t("Note: {note}", { note: item.note })}</dd>}
              </div>
            );
          })}
        </dl>
      )}
      {words.body !== null && words.body.length > 0 && <pre className={`prompt-card-body${words.body.includes("\n") ? "" : " is-line"}`}>{words.body}</pre>}
      {hasChoices && (
        /* busy on the options alone, never on the card: a live region inside an aria-busy subtree is not
           read (Chromium), and the status line below has to be */
        <div className={`prompt-card-options${watching ? " is-unavailable" : ""}`} role={prompt.multi_select ? "group" : undefined} aria-label={prompt.multi_select ? words.question : undefined} aria-busy={pending}>
          {prompt.options.map((option, index) => {
            if (index === prompt.custom_option_index) return null;
            const { text, recommended } = labelOf({ ...option, label: words.label(index) });
            const description = words.description(index);
            // The same words, as text, are the option's description: in a hidden span beside the option
            // (inside it they would join its name), which its aria-describedby names
            const scope = approvalScope(prompt, index);
            const scopeId = scope === null ? undefined : `${scopeIdBase}-${index}`;
            const scopeText = scope === null ? null : <span id={scopeId} className="visually-hidden">{scopeCue(t, scope)}</span>;
            const content = (
              <span className="prompt-card-option-text">
                <span className="prompt-card-option-label">{markdown ? <InlineMarkdown>{text}</InlineMarkdown> : text}{recommended && <> <span className="prompt-card-tag">{t("Recommended")}</span></>}{scope !== null && <span className="prompt-card-tag prompt-card-scope" data-scope={scopeCue(t, scope)} aria-hidden="true" />}</span>
                {description !== null && <span className="prompt-card-option-description">{markdown ? <InlineMarkdown>{description}</InlineMarkdown> : description}</span>}
              </span>
            );
            const number = <span className="prompt-card-number"><span aria-hidden="true">{index + 1}</span><span className="visually-hidden">{index + 1}.</span></span>;
            const described = option.description !== null ? " has-description" : "";
            // Claude draws an option's preview for the one under its cursor only, beside its menu (#1212)
            const shown = prompt.option_preview?.option_index === index ? prompt.option_preview : null;
            const preview = shown !== null && (
              <div className="prompt-card-option-preview" role="group" aria-label={t("Preview of {option}", { option: text })}>
                <pre>{shown.text}</pre>
                {shown.hidden_lines !== undefined && <p className="prompt-card-hint">{t("{n} more lines Claude left out", { n: shown.hidden_lines })}</p>}
              </div>
            );
            if (prompt.multi_select) {
              const checked = selected.has(index);
              return (
                <Fragment key={index}>
                  <label className={`prompt-card-option${described}${checked ? " is-checked" : ""}`} title={watchReason}>
                    <input type="checkbox" checked={checked} disabled={held} aria-describedby={describedBy(scopeId, watchDescribed)} onChange={() => toggle(index)} />
                    {number} {content}
                  </label>
                  {scopeText}
                  {preview}
                </Fragment>
              );
            }
            const isSelected = prompt.default_option_index === index;
            return (
              <Fragment key={index}>
                <button type="button" className={`prompt-card-option${described}${typedAnswer?.option_index === index ? " is-typed" : ""}${isSelected ? " is-selected" : ""}`} disabled={held} aria-describedby={describedBy(scopeId, watchDescribed)} title={watchReason} onClick={(event) => void answer({ option_index: index }, event)}>
                  {number} {content}
                </button>
                {scopeText}
                {preview}
              </Fragment>
            );
          })}
        </div>
      )}
      {prompt.multi_select && (
        <button type="button" className={`btn${selected.size > 0 ? " btn-primary" : ""} prompt-card-submit`} disabled={held || (selected.size === 0 && !prompt.optional && !(sendsChecksWithText(prompt) && custom.trim()))} aria-describedby={watchDescribed} title={watchReason} onClick={(event) => void answer({ option_indices: [...selected].sort((a, b) => a - b) }, event)}>
          {selected.size > 0 ? t("Submit ({n})", { n: selected.size }) : t("Submit")}
        </button>
      )}
      {prompt.custom_option_index !== null && (
        <div className="prompt-card-custom">
          {hasChoices && <span className="prompt-card-custom-label" id={customLabelId}>{sendsChecksWithText(prompt) ? t("Custom answer") : t("Or type your own answer")}</span>}
          <div className="prompt-card-custom-row">
            <input className="input" value={custom} disabled={held} title={watchReason} aria-describedby={watchDescribed} placeholder={prompt.options[prompt.custom_option_index] !== undefined ? words.label(prompt.custom_option_index) : t("Type an answer")} aria-label={hasChoices ? undefined : t("Custom answer")} aria-labelledby={hasChoices ? customLabelId : undefined} onChange={(event) => {
              const next = event.currentTarget.value;
              setCustom(next);
              onTextChange?.(next);
              dropRetry();
            }} onKeyDown={(event) => {
              // an IME's Enter commits the candidate; WebKit can send it after compositionend, as key code 229
              if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && custom.trim().length > 0) void answer({ custom_text: custom.trim() });
            }} />
            <button type="button" className={`btn${custom.trim().length > 0 ? " btn-primary" : ""}`} disabled={held || custom.trim().length === 0} aria-describedby={watchDescribed} title={watchReason} onClick={(event) => void answer({ custom_text: custom.trim() }, event)}>
              <Send aria-hidden="true" /> {t("Send")}
            </button>
          </div>
        </div>
      )}
      {prompt.optional && !prompt.multi_select && (
        <button type="button" className="btn prompt-card-skip" disabled={held} aria-describedby={watchDescribed} title={watchReason} onClick={(event) => void answer({ custom_text: "" }, event)}>
          {t("Skip question")}
        </button>
      )}
      {typedAnswer?.option_index !== undefined && (
        <div className="prompt-card-confirm" role="alert" ref={confirmRef}>
          <span className="prompt-card-confirm-text">{t("Send {answer}?", { answer: `${typedAnswer.option_index + 1}. ${words.label(typedAnswer.option_index)}` })}</span>
          <span className="prompt-card-confirm-actions">
            <button type="button" className="btn btn-primary" disabled={held} aria-describedby={watchDescribed} title={watchReason} onClick={(event) => void answer(typedAnswer, event).then((current) => { if (current) onTypedAnswerDone?.(); })}>{t("Confirm")}</button>
            <button type="button" className="btn" disabled={pending} onClick={() => onTypedAnswerDone?.()}>{t("Cancel")}</button>
          </span>
        </div>
      )}
      {error !== null && (
        <div className="prompt-card-error" role="alert">
          <span className="prompt-card-error-text">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</span>
          {error.retry !== undefined && (
            <button type="button" className="btn prompt-card-retry" disabled={held} aria-describedby={watchDescribed} title={watchReason} onClick={(event) => void answer(error.retry!, event)}>{t("Retry")}</button>
          )}
        </div>
      )}
    </section>
  );
}
