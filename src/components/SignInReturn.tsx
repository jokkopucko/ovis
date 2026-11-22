import { useEffect, useState } from "react";

/** How long the callback tab waits for the Ovis tab that started the sign-in before saying it is gone. */
const HAND_OVER_MS = 5_000;

import { carriesReturn, handOverReturn } from "../lib/account/ownWindow.ts";
import { useT } from "../lib/i18n.ts";

/** The page the provider's return lands on in this PC's own window (lib/account/ownWindow.ts): it only hands the return over. */
export function SignInReturn({ params }: { readonly params: string }) {
  const t = useT();
  const [taken, setTaken] = useState(false);
  const [unanswered, setUnanswered] = useState(false);
  useEffect(() => {
    const stop = handOverReturn(params, () => {
      setTaken(true);
      window.close();
    });
    const timer = setTimeout(() => setUnanswered(true), HAND_OVER_MS);
    return () => { stop(); clearTimeout(timer); };
  }, [params]);
  return (
    <main className="app-crash">
      <div className="app-crash-card" role="status">
        <p>{!carriesReturn(params) ? t("Nothing to finish here. Close this tab and go back to Ovis.") : taken ? t("Signed in. Close this tab and go back to Ovis.") : unanswered ? t("The Ovis tab that started this sign-in is gone. Close this tab and sign in again there.") : t("Finishing the sign-in in the Ovis tab that started it…")}</p>
      </div>
    </main>
  );
}
