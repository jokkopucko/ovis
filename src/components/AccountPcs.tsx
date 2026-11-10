// the list's rows are the relay shell's (.relay-shell-pc*), also in Settings, where RelayShell.tsx is not loaded
import "./RelayShell.css";
import "./AccountPcs.css";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

import type { MyPc, MyPcState } from "../lib/account/myPcs.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { ConnectionLine } from "./ConnectionLine.tsx";
import { StatusDot, type StatusDotState } from "./StatusDot.tsx";

export const PROVIDER_NAMES: Record<AccountProvider, string> = { github: "GitHub", google: "Google", apple: "Apple" };

/**
 * The providers' own marks, as their brand rules ask for a sign-in button: GitHub's and Apple's in
 * one colour (currentColor), Google's "G" always in its four colours, never recoloured.
 */
export function ProviderMark({ provider }: { readonly provider: AccountProvider }) {
  if (provider === "google") {
    return (
      <svg className="account-provider-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
    );
  }
  return provider === "github" ? (
    <svg className="account-provider-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  ) : (
    <svg className="account-provider-mark" viewBox="0 0 17 20" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M14.04 10.63c-.02-2.33 1.9-3.45 1.99-3.5-1.08-1.59-2.77-1.8-3.37-1.83-1.43-.15-2.8.85-3.53.85-.73 0-1.85-.83-3.05-.81-1.57.02-3.02.92-3.83 2.33-1.63 2.83-.42 7.02 1.17 9.32.78 1.13 1.7 2.39 2.91 2.35 1.17-.05 1.61-.76 3.02-.76 1.41 0 1.81.76 3.04.73 1.26-.02 2.05-1.14 2.82-2.28.89-1.31 1.25-2.58 1.27-2.64-.03-.01-2.43-.93-2.45-3.69ZM11.73 3.79c.64-.78 1.08-1.86.96-2.94-.93.04-2.06.62-2.72 1.4-.6.69-1.12 1.79-.98 2.85 1.04.08 2.1-.53 2.74-1.31Z" />
    </svg>
  );
}

const PROVIDERS: readonly AccountProvider[] = ["github", "google", "apple"];

function providerLabel(provider: AccountProvider, t: ReturnType<typeof useT>): string {
  switch (provider) {
    case "github": return t("Continue with GitHub");
    case "google": return t("Continue with Google");
    case "apple": return t("Continue with Apple");
  }
}

/**
 * Sign in with GitHub, Google or Apple: equal neutral outlined buttons at 44px with the brand mark
 * at a fixed --space-4 inset and the label centered. When a sign-in is under way, the tapped
 * button swaps its brand mark for a spinner in the same 18px slot, keeps its box and disables peers.
 */
export function AccountSignIn({
  onSignIn,
  error,
  providers = ["github"],
  busy = false,
  busyProvider = null,
  failedProvider = null,
}: {
  readonly onSignIn: (provider: AccountProvider) => void;
  readonly error: string | null;
  readonly providers?: readonly AccountProvider[];
  readonly busy?: boolean;
  readonly busyProvider?: AccountProvider | null;
  readonly failedProvider?: AccountProvider | null;
}) {
  const t = useT();
  const [lastProvider, setLastProvider] = useState<AccountProvider | null>(null);
  const groupBusy = busy && (busyProvider === null || !providers.includes(busyProvider));
  const preferredRetry = busyProvider ?? failedProvider ?? lastProvider;
  const retryProvider = preferredRetry && providers.includes(preferredRetry) ? preferredRetry : providers[0] ?? "github";
  return (
    <div className="account-sign-in" {...(groupBusy ? { "aria-busy": "true" } : {})}>
      <div className="account-providers">
        {PROVIDERS.filter((provider) => providers.includes(provider)).map((provider) => {
          const isBusy = busy && busyProvider === provider;
          return (
            <button
              key={provider}
              type="button"
              className="btn account-provider"
              data-provider={provider}
              aria-busy={isBusy ? "true" : undefined}
              disabled={busy}
              onClick={() => {
                if (!busy) {
                  setLastProvider(provider);
                  onSignIn(provider);
                }
              }}
            >
              {isBusy
                ? <span className="boot-spinner account-provider-mark account-provider-spinner" aria-hidden="true" />
                : <ProviderMark provider={provider} />}
              {providerLabel(provider, t)}
            </button>
          );
        })}
      </div>
      {error !== null && (
        <div className="account-error-block" role="alert">
          <p className="account-error">{error} {t("The PCs this device is paired with still work.")}</p>
          <button
            type="button"
            className="btn account-error-retry"
            data-action="retry-signin"
            disabled={busy}
            onClick={() => { if (!busy) onSignIn(retryProvider); }}
          >
            {t("Try again")}
          </button>
        </div>
      )}
    </div>
  );
}

/** One line at the sign-in column's foot: what the account service sees. */
export function AccountFinePrint() {
  const t = useT();
  return <p className="account-fineprint">{t("The account only lists your PCs. Sessions stay end-to-end encrypted.")}</p>;
}

/** A PC's state in a word or two, as the dashboard's rows and counts say it beside its dot. */
export function pcStateWord(state: MyPcState, t: ReturnType<typeof useT>): string {
  switch (state) {
    case "paired": return t("Ready");
    case "needs-approval": return t("Needs approval");
    case "offline": return t("Offline");
    case "needs-update": return t("Update Ovis on it");
  }
}

export function accountPcStateText(pc: MyPc, t: ReturnType<typeof useT>): string {
  switch (pc.state) {
    // a pairing from before the account: removing this device through the account does not reach it yet
    case "paired": return pc.linked ? pcStateWord("paired", t) : t("Ready · not in the account yet");
    case "offline": return t("Offline · {when}", { when: lastSeen(pc.last_seen_at) });
    default: return pcStateWord(pc.state, t);
  }
}

/**
 * A PC of the account in a PC's own Settings list. That page holds no relay pairing, so it cannot
 * tell whether a listed PC still waits for an approval: it says the PC is in the account, and keeps
 * only what the directory itself knows (offline, an update needed).
 */
export function listedPcStateText(pc: MyPc, t: ReturnType<typeof useT>): string {
  return pc.state === "needs-approval" && !pc.paired ? t("In your account") : accountPcStateText(pc, t);
}

function statusDotOf(state: MyPcState): StatusDotState {
  switch (state) {
    case "paired": return "ready";
    case "needs-approval":
    case "needs-update": return "needs-you";
    case "offline": return "offline";
  }
}

/** How a saved PC answered the latest check (pcStatus.ts): its way and round trip, or why it did not. */
export function PcStatusLine({ status, lastSeenAt = null }: { readonly status: PcStatus; readonly lastSeenAt?: string | null }) {
  const t = useT();
  if (status.kind === "answered") return <ConnectionLine state={{ kind: "answered", route: status.route, ...(status.relay === undefined ? {} : { relay: status.relay }), rttMs: status.rttMs }} />;
  if (status.kind === "checking") return <ConnectionLine state={{ kind: "checking" }} />;
  return <ConnectionLine state={{ kind: "offline", text: lastSeenAt === null ? t("Offline") : t("Offline · {when}", { when: lastSeen(lastSeenAt) }) }}
    reason={status.reason === "pc" ? t("The PC is off, or Ovis is not running on it.") : t("The relay did not answer. Check this device's network.")} />;
}

/** Check now, beside a list of PCs: probes each saved one again. */
export function CheckPcsButton({ status, onCheck }: { readonly status: ReadonlyMap<string, PcStatus>; readonly onCheck: () => void }) {
  const t = useT();
  const checking = [...status.values()].some((one) => one.kind === "checking");
  return (
    <div className="relay-shell-check">
      <button
        type="button"
        className="btn btn-ghost relay-shell-check-btn"
        aria-busy={checking ? "true" : undefined}
        onClick={onCheck}
        disabled={checking}
      >
        {checking ? t("Checking…") : t("Check now")}
      </button>
    </div>
  );
}

/** The account's PCs: a paired one opens and says how it answered the latest check; the others say what they wait for. */
export function AccountPcList({ pcs, onJoin, status }: { readonly pcs: readonly MyPc[]; readonly onJoin?: (pc: MyPc) => void; readonly status?: ReadonlyMap<string, PcStatus> }) {
  const t = useT();
  return (
    <ul className="relay-shell-pcs">
      {pcs.map((pc) => {
        const pcStatus = status?.get(pc.server_id);
        const body = (
          <span className="account-pc-text">
            <span className="relay-shell-pc-name">{pc.name}</span>
            {pc.paired && pcStatus
              ? <PcStatusLine status={pcStatus} lastSeenAt={pc.last_seen_at} />
              : <span className="account-pc-state"><StatusDot state={statusDotOf(pc.state)} size="inline" />{accountPcStateText(pc, t)}</span>}
          </span>
        );
        return (
          <li key={pc.server_id} data-pc-state={pc.state}>
            {pc.paired
              ? <a className="relay-shell-pc" href={serverScopePath(pc.server_id)}>{body}<ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" /></a>
              : pc.join && onJoin
                ? <button type="button" className="relay-shell-pc account-pc-join" onClick={() => onJoin(pc)}>{body}<ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" /></button>
                : <div className="relay-shell-pc account-pc-waiting">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}
