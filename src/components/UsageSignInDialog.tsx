/**
 * Signs Claude Code or Codex in from the browser. The server runs the agent's own login on the PC in a
 * terminal of its own that no herdr pane shows (server/usage-login.ts), and this dialog follows it: it shows the page to open
 * (and Codex's one-time code), takes the code Claude's page shows and types it into the login, and says
 * how it ended. The CLI writes its own credentials; the code lives only in the input until it is sent.
 * Open terminal stops it and starts the same sign-in in a terminal tab instead; closing the dialog stops it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, ExternalLink, SquareTerminal, X } from "lucide-react";

import type { UsageLoginPrompt, UsageLoginRequest } from "../../shared/usage-login.ts";
import { ApiError, cancelUsageLogin, fetchUsageLoginAccounts, fetchUsageLoginPrompt, followUsageLogin, sendUsageLoginCode, startUsageLogin } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { followedOutcome, type SignInOutcome } from "../lib/signInOutcome.ts";
import { PROVIDER_NAME } from "../lib/usage.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import "./UsageAccountDialog.css";

/** how often the dialog looks at the login's screen while it waits for the user */
const PROMPT_POLL_MS = 1000;
/** Codex's device code lives 15 minutes; a login still open past this is left to its terminal */
const FOLLOW_MS = 16 * 60_000;
/** reads of the login's screen that may fail in a row (a herdr busy for a moment) before the dialog hands over */
const READ_FAILURES_MAX = 3;

type Phase =
  | { kind: "starting" }
  | { kind: "confirm" }
  | { kind: "following"; login: string }
  | { kind: "ended"; outcome: SignInOutcome }
  | { kind: "failed"; message: string }
  /** handing over to a terminal tab: the private sign-in stopped, the visible one starting */
  | { kind: "handing-over" };

export function UsageSignInDialog({ request, onOpenTerminal, onSignedIn, onClose }: {
  /** a first sign-in in the agent's own home, or signing an account in again */
  readonly request: Extract<UsageLoginRequest, { provider: "claude" | "codex" }>;
  /** shows the login's terminal tab (Settings closes) */
  readonly onOpenTerminal: (paneId: string) => void;
  /** the login ended with a new sign-in on the PC */
  readonly onSignedIn?: () => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const provider = request.provider;
  const [replace, setReplace] = useState(false);
  const again = "account" in request || replace;
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [prompt, setPrompt] = useState<UsageLoginPrompt | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const before = useRef<readonly (string | null)[] | null>(null);
  const following = useRef<string | null>(null);
  const cancelling = useRef<Promise<void> | null>(null);
  const signedInRef = useRef(onSignedIn);
  signedInRef.current = onSignedIn;
  const codeInput = useRef<HTMLInputElement>(null);
  // the code was sent, and the CLI has shown something else since: the follow loop reads these
  const sentRef = useRef(false);
  const answered = useRef(false);
  const surface = useFocusTrap<HTMLDivElement>(true);
  const title = t("Sign in to {provider}", { provider: provider === "claude" ? "Claude Code" : PROVIDER_NAME[provider] });

  // starts the login (again with `replace` once the user confirmed), after noting the sign-ins it may add to
  useEffect(() => {
    if (phase.kind !== "starting") return;
    const controller = new AbortController();
    void (async () => {
      try {
        before.current ??= (await fetchUsageLoginAccounts(provider, controller.signal)).accounts;
        const started = await followUsageLogin(replace && "default" in request ? { ...request, replace: true } : request, controller.signal);
        if (controller.signal.aborted) { void cancelUsageLogin(started.login_id).catch(() => undefined); return; }
        following.current = started.login_id;
        setPhase({ kind: "following", login: started.login_id });
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.code === "account_confirmation_required") setPhase({ kind: "confirm" });
        // a CLI the browser cannot follow (an old Claude Code without `auth login`, a Codex without a device code)
        else if (cause instanceof ApiError && cause.code === "follow_unsupported") setPhase({ kind: "failed", message: t("This version signs in only in its terminal. Open it to finish.") });
        else setPhase({ kind: "failed", message: cause instanceof ApiError ? cause.detail : t("Could not start account sign-in") });
      }
    })();
    return () => controller.abort();
  }, [phase.kind, provider, replace, request, t]);

  // follows the login's screen until its CLI exits, then reads the sign-ins again
  const login = phase.kind === "following" ? phase.login : null;
  useEffect(() => {
    if (login === null) return;
    const controller = new AbortController();
    const until = Date.now() + FOLLOW_MS;
    let timer: number | undefined;
    let failures = 0;
    const look = async (): Promise<void> => {
      try {
        const next = await fetchUsageLoginPrompt(login, controller.signal);
        if (controller.signal.aborted) return;
        // a sent code the CLI moved on from; a prompt that comes back after that asks for the code again
        if (!next.wants_code) answered.current = true;
        else if (answered.current && sentRef.current) { sentRef.current = false; setSent(false); setCodeError(t("The sign-in asked for the code again. Paste it once more.")); }
        setPrompt(next);
        if (next.ended) {
          // the account the server found in this login's own home; the lists before and after only for a server too old to say
          const after = next.succeeded === undefined ? (await fetchUsageLoginAccounts(provider, controller.signal)).accounts : [];
          window.dispatchEvent(new Event("herdr-usage-changed"));
          const outcome = followedOutcome(next, before.current ?? [], after, again);
          following.current = null;
          setPhase({ kind: "ended", outcome });
          if (outcome.kind === "signed-in") signedInRef.current?.();
          return;
        }
        // a whole round read: only that clears the failures, so failed account reads after the end still count
        failures = 0;
      } catch (cause) {
        if (controller.signal.aborted) return;
        failures += 1;
        if (failures >= READ_FAILURES_MAX || (cause instanceof ApiError && cause.status === 404)) {
          setPhase({ kind: "failed", message: cause instanceof ApiError ? cause.detail : t("Could not follow the sign-in. Choose Open terminal to try there.") });
          return;
        }
      }
      if (Date.now() > until) { setPhase({ kind: "failed", message: t("The sign-in is taking too long. Choose Open terminal to try there.") }); return; }
      timer = window.setTimeout(() => void look(), PROMPT_POLL_MS);
    };
    void look();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [login, provider, again, t]);

  useLayoutEffect(() => {
    (surface.current?.querySelector<HTMLElement>(".account-step-content input, .account-step-content a, .account-step-content button") ?? surface.current)?.focus();
  }, [phase.kind, prompt?.url, prompt?.wants_code, surface]);

  const sendCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // a form inside another (Add account's): its submit is this one's alone
    event.stopPropagation();
    const input = codeInput.current;
    if (login === null || input === null || sending) return;
    setSending(true); setCodeError(null);
    // the code is read from the input once and sent; nothing keeps it after
    void sendUsageLoginCode({ login, code: input.value }).then(() => { input.value = ""; answered.current = false; sentRef.current = true; setSent(true); })
      .catch((cause: unknown) => setCodeError(cause instanceof ApiError ? cause.detail : t("Could not send the code")))
      .finally(() => setSending(false));
  };
  const copyCode = async (code: string): Promise<void> => {
    if (await copyText(code, null)) setCopied(true);
  };
  // the private sign-in still running, if any: closing the dialog in any way stops it
  const stopFollowing = (): Promise<void> => {
    if (cancelling.current !== null) return cancelling.current;
    const running = following.current;
    if (running === null) return Promise.resolve();
    cancelling.current = cancelUsageLogin(running).then(() => {
      if (following.current === running) following.current = null;
    }).finally(() => { cancelling.current = null; });
    return cancelling.current;
  };
  useEffect(() => {
    // the page itself going (a closed tab, a reload) stops it too: no dialog could reach it after
    const leaving = (): void => { void stopFollowing().catch(() => undefined); };
    window.addEventListener("pagehide", leaving);
    return () => { window.removeEventListener("pagehide", leaving); leaving(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = (): void => { void stopFollowing().catch(() => undefined); onClose(); };
  // Open terminal: the private sign-in stops and the same one starts in a terminal tab, which any device that
  // reads this PC's terminals can see; the user chose it
  const toTerminal = (): void => {
    setPhase({ kind: "handing-over" });
    // the tab takes the same home: it starts once the private sign-in has let go of it
    void stopFollowing().then(() => startUsageLogin(replace && "default" in request ? { ...request, replace: true } : request))
      .then((started) => onOpenTerminal(started.pane_id))
      .catch((cause: unknown) => setPhase({ kind: "failed", message: cause instanceof ApiError ? cause.detail : t("Could not start account sign-in") }));
  };
  const terminalOffered = phase.kind === "following" || phase.kind === "failed";

  let body;
  switch (phase.kind) {
    case "starting":
      body = <p className="settings-hint" role="status">{t("Starting the sign-in on this PC…")}</p>;
      break;
    case "confirm":
      body = <div className="account-auth-form">
        <p className="settings-hint">{t("{agent} is already signed in on this PC. Continuing may replace that sign-in.", { agent: provider === "claude" ? "Claude Code" : PROVIDER_NAME[provider] })}</p>
        <button type="button" className="btn" onClick={() => { setReplace(true); setPhase({ kind: "starting" }); }}>{t("Continue")}</button>
      </div>;
      break;
    case "following":
      body = prompt === null || prompt.url === null
        ? <p className="settings-hint" role="status">{t("Waiting for {provider} to show its sign-in page…", { provider: PROVIDER_NAME[provider] })}</p>
        : <div className="account-auth-form usage-sign-in-steps">
          <p className="settings-hint">{prompt.user_code !== null ? t("1. Open the sign-in page and sign in.") : t("Open the sign-in page and sign in.")}</p>
          <a className="btn usage-sign-in-open" href={prompt.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />{t("Open sign-in page")}</a>
          <span className="settings-hint usage-sign-in-host">{new URL(prompt.url).host}</span>
          {prompt.user_code !== null && <>
            <p className="settings-hint">{t("2. Enter this one-time code there:")}</p>
            <span className="usage-sign-in-code">
              <code>{prompt.user_code}</code>
              <button type="button" className="btn btn-ghost" aria-label={t("Copy the code")} onClick={() => void copyCode(prompt.user_code!)}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button>
            </span>
            <p className="settings-hint" role="status">{t("Waiting for the page to approve it…")}</p>
          </>}
          {prompt.wants_code && !sent && <form className="usage-sign-in-paste" onSubmit={sendCode}>
            <label className="settings-label" htmlFor="usage-sign-in-code">{t("Paste the code the page shows")}</label>
            <input ref={codeInput} className="input" id="usage-sign-in-code" name="code" autoComplete="off" spellCheck={false} required maxLength={2048} pattern="[A-Za-z0-9._~#\-]+" disabled={sending} />
            {codeError && <p className="settings-hint account-error" role="alert">{codeError}</p>}
            <button type="submit" className="btn" disabled={sending}>{sending ? t("Sending…") : t("Send code")}</button>
          </form>}
          {(sent || (prompt.user_code === null && !prompt.wants_code)) && <p className="settings-hint" role="status">{t("Finishing the sign-in…")}</p>}
        </div>;
      break;
    case "ended":
      body = <p className={`settings-hint${phase.outcome.kind === "not-signed-in" ? " account-error" : ""}`} role={phase.outcome.kind === "not-signed-in" ? "alert" : "status"}>
        {phase.outcome.kind === "signed-in" ? (phase.outcome.account !== null ? t("Signed in as {account}.", { account: phase.outcome.account }) : t("Signed in."))
          : phase.outcome.kind === "finished" ? t("The sign-in finished.") : t("The sign-in ended without signing in. Try again, or sign in from a terminal.")}
      </p>;
      break;
    case "handing-over":
      body = <p className="settings-hint" role="status">{t("Starting the sign-in on this PC…")}</p>;
      break;
    case "failed":
      body = <p className="settings-hint account-error" role="alert">{phase.message}</p>;
      break;
    default: { const unexpected: never = phase; throw new Error(String(unexpected)); }
  }

  return createPortal(<div className="modal-scrim" onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
    <div ref={surface} className="modal usage-account-dialog usage-sign-in-dialog" role="dialog" aria-modal="true" aria-labelledby="usage-sign-in-title" tabIndex={-1}>
      <div className="modal-header">
        <h2 className="modal-title" id="usage-sign-in-title">{title}</h2>
        <button className="icon-button" type="button" aria-label={t("Close")} onClick={close}><X size={18} aria-hidden="true" /></button>
      </div>
      <div className="modal-body">
        <div className="account-step-content">{body}</div>
        <div className="usage-sign-in-footer">
          {terminalOffered && <button type="button" className="btn btn-ghost" onClick={toTerminal}><SquareTerminal aria-hidden="true" />{t("Open terminal")}</button>}
          {(phase.kind === "ended" || phase.kind === "failed") && <button type="button" className="btn" onClick={close}>{t("Done")}</button>}
        </div>
      </div>
    </div>
  </div>, document.body);
}
