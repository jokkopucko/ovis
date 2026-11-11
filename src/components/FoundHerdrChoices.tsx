import type { FoundHerdrSession, FoundOvis, SshTarget } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";
import { machineErrorText } from "../lib/userError.ts";

export type HerdrChoice = Pick<SshTarget, "session" | "herdr_socket" | "start_new_herdr" | "own_ovis">;

// the server's words for a choice it asks afresh (server/machines.ts): any other words beside a choice say why what was
// chosen failed (gone, refused, not answering, its session stopped), and the choice is offered after that failure
const FRESH_CHOICE = new Set(["Choose this PC's Ovis server or a running herdr session.", "A herdr session is already running on this PC. Choose it, or start a new one."]);

/** A fresh choice to make (this PC's Ovis or running herdr sessions were found), not one offered because what was chosen failed */
export function asksChoice(error: string | null | undefined, sessions: readonly FoundHerdrSession[], ownOvis: readonly FoundOvis[]): boolean {
  return (!error || FRESH_CHOICE.has(error)) && (ownOvis.length > 0 || sessions.length > 0);
}

/** The same choice on a saved PC's card and on a first setup that has no card yet. */
/** `error`: the server's words beside the choice; when they say why what was chosen failed, the card says so */
export function FoundHerdrChoices({ sessions, ownOvis = [], error, busy, onChoose }: { sessions: FoundHerdrSession[]; ownOvis?: FoundOvis[]; error?: string | null; busy: boolean; onChoose(choice: HerdrChoice): void }) {
  const t = useT();
  // a question is drawn as one (is-setup), with this PC's Ovis as its main answer; a choice offered after a failure is
  // drawn as that failure, headed by why, with no main answer
  const question = asksChoice(error, sessions, ownOvis);
  const reason = !question && error ? machineErrorText(error, t) : null;
  return <div className={`machine-action${question ? " is-setup" : ""}`} role="status">
    {reason !== null && <p className="machine-action-text"><strong>{reason}</strong></p>}
    {/* the PC's own Ovis, where its sessions are, is the first answer; the herdr sessions running beside it, which it
        does not serve, follow under their own line, and starting a new herdr comes last */}
    {ownOvis.length > 0 && <p className="machine-action-text">{reason === null ? <strong>{t("Ovis on this PC (herdr-core)")}</strong> : <span>{t("Ovis on this PC (herdr-core)")}</span>}</p>}
    {ownOvis.map((found) => <div className="machine-own-address" key={found.socket_path}>
      <code>{found.socket_path}</code>
      <button type="button" className={question ? "btn btn-primary" : "btn"} disabled={busy} onClick={() => onChoose({ own_ovis: found.socket_path, herdr_socket: undefined, start_new_herdr: undefined })}>{t("Use Ovis on this PC (herdr-core)")}</button>
    </div>)}
    {/* none listed and no reason: the session chosen for this PC stopped, and no other one runs there */}
    {ownOvis.length ? sessions.length > 0 && <p className="machine-action-text"><span>{t("Or a herdr session running on this PC")}</span></p> : reason !== null ? null : sessions.length ? <p className="machine-action-text"><strong>{t("A herdr session is already running on this PC")}</strong><span>{t("Choose the session to use, or start a new herdr here.")}</span></p>
      : <p className="machine-action-text"><strong>{t("The chosen herdr session is no longer running")}</strong><span>{t("Start it on that PC and reconnect, or start a new herdr here.")}</span></p>}
    {sessions.map((found) => <div className="machine-own-address" key={found.socket_path}>
      <span>{found.session ?? t("Default session")}</span>
      <code>{found.socket_path}</code>
      <button type="button" className="btn" disabled={busy} onClick={() => onChoose({ session: found.session, herdr_socket: found.socket_path, start_new_herdr: undefined, own_ovis: undefined })}>{t("Use {label}", { label: found.session ?? t("Default session") })}</button>
    </div>)}
    <button type="button" className="btn" disabled={busy} onClick={() => onChoose({ herdr_socket: undefined, start_new_herdr: true, own_ovis: undefined })}>{t("Start a new herdr here")}</button>
  </div>;
}
