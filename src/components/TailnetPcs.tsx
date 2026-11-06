import { useEffect, useState } from "react";

import { addTailnetPc, ApiError, findTailnetPcs, type TailnetPc } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { codeFailureText, typedCodeFailure } from "./codeFailureText.ts";

/**
 * Connect a device → PCs on your Tailscale: other PCs of this PC's own Tailscale login whose Ovis lets this PC in
 * as its owner, each added through the relay with one tap (server/tailnet-pcs.ts). Nothing shows while none is found.
 */
export function TailnetPcs() {
  const t = useT();
  const [pcs, setPcs] = useState<readonly TailnetPc[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ error: boolean; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    findTailnetPcs().then(({ pcs: found }) => { if (live) setPcs(found); }, () => { if (live) setPcs([]); });
    return () => { live = false; };
  }, []);
  const add = async (pc: TailnetPc) => {
    setBusy(pc.url);
    setResult(null);
    try {
      const { machine } = await addTailnetPc(pc.url);
      setPcs((current) => current.filter((other) => other.url !== pc.url));
      setResult({ error: false, text: t("{name} was added. Its workspaces join the sidebar.", { name: machine.name }) });
    } catch (error) {
      const failure = error instanceof ApiError ? typedCodeFailure(error.code) : null;
      setResult({ error: true, text: failure !== null ? codeFailureText(t, failure) : error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  };
  if (pcs.length === 0 && result === null) return null;
  return (
    <div className="connect-way-item tailnet-pcs" data-testid="tailnet-pcs">
      {pcs.length > 0 && <p className="settings-label">{t("PCs on your Tailscale")}</p>}
      {pcs.map((pc) => (
        <div key={pc.url} className="tailnet-pc">
          <span className="tailnet-pc-name">
            {pc.name}
            {pc.relay !== "online" && <span className="settings-hint">{t("Turn the relay on on that PC first.")}</span>}
          </span>
          <button type="button" className="btn btn-primary" disabled={busy !== null || pc.relay !== "online"} aria-busy={busy === pc.url || undefined}
            aria-label={t("Add {name} through the relay", { name: pc.name })} onClick={() => void add(pc)}>{t("Add PC")}</button>
        </div>
      ))}
      {result && <p className="settings-hint" role={result.error ? "alert" : "status"}>{result.text}</p>}
    </div>
  );
}
