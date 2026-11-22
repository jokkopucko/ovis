import { useCallback, useEffect, useState } from "react";

import { AccessGate } from "./AccessGate.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { ChunkFailureNotice } from "./UpdateControls.tsx";
import { fetchBridgeHealth } from "../lib/api.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { readerFromSearch, readerHref, resolveFromDocument, type ReaderTarget } from "../lib/fileReader.ts";
import { pageSearch } from "../lib/pageQuery.ts";
import type { AccessRefusal } from "../../shared/protocol.ts";

const close = (): void => {};

export function FileReader({ target }: { target: ReaderTarget }) {
  const t = useT();
  const [path, setPath] = useState(target.path);
  // the same gate as the app's: a tab opened from a bookmark or another browser signs in here, and
  // the document is read once the server has set its cookie
  const [locked, setLocked] = useState<boolean | null>(null);
  const [lockReason, setLockReason] = useState<AccessRefusal | null>(null);
  useEffect(() => {
    let alive = true;
    const probe = async (): Promise<void> => {
      try {
        const health = await fetchBridgeHealth();
        if (!alive) return;
        setLocked(health.auth.required && !health.auth.authenticated);
        setLockReason(health.auth.reason ?? null);
      } catch { if (alive) setLocked(false); }
    };
    void probe();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onPop = (): void => {
      const next = readerFromSearch(pageSearch());
      if (next !== null) setPath(next.path);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    document.title = `${path.split("/").pop() || path} · Ovis`;
  }, [path]);

  const open = useCallback((linked: string) => {
    const next = resolveFromDocument(path, linked);
    window.history.pushState(null, "", readerHref(target.machine, next));
    setPath(next);
  }, [path, target.machine]);

  if (locked === null) return <main className="file-reader"><p className="file-viewer-note" role="status">{t("Opening…")}</p></main>;
  if (locked) return <AccessGate reason={lockReason} initialCode="" consumePairCode={() => ""} pairingUnconfirmed={false} onUnlocked={() => setLocked(false)} />;
  return <div className="file-reader-frame">
    <ChunkFailureNotice />
    <MachineContext.Provider value={target.machine}>
      <OpenFileContext.Provider value={open}>
        <FileViewer key={path} page path={path} paneId={null} onClose={close} onOpen={open} />
      </OpenFileContext.Provider>
    </MachineContext.Provider>
  </div>;
}
