import { useCallback, useEffect, useRef, useState } from "react";
import type { InstalledNotes, UpdateNotes, UpdateRequest, UpdateStatus } from "../../shared/update.ts";
import { ApiError, fetchInstalledNotes, fetchUpdateNotes, fetchUpdateStatus, requestUpdate } from "./api.ts";
import { installedUpdate, notesOffer, notesRetryDelay, notesUnboundDelay, offeredNotes, reloadReason } from "./updateNotes.ts";
import { usePageVisible } from "./visibility.ts";
import { lazyChunkFailed, onLazyChunkFailure } from "./lazyChunk.ts";

declare const __APP_REVISION__: string | null;

export function useUpdates(enabled: boolean) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // the component's own lifetime, not the poll's: a page hidden while the request is on its way
  // (a phone app sent to the background) stops the poll, and the answer must still land, or
  // the buttons stay disabled until the next sign-in
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [chunkFailed, setChunkFailed] = useState(lazyChunkFailed);
  useEffect(() => {
    let asked = 0;
    const stop = onLazyChunkFailure(() => {
      setChunkFailed(true);
      if (!enabled || Date.now() - asked < 5000) return;
      asked = Date.now();
      setRefresh(value => value + 1);
    });
    setChunkFailed(lazyChunkFailed());
    return stop;
  }, [enabled]);
  const visible = usePageVisible();
  useEffect(() => {
    if (!enabled) { setStatus(null); setPending(false); setError(null); setErrorCode(null); return; }
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      let delay = 2000;
      try {
        const next = await fetchUpdateStatus();
        if (!stopped) setStatus((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        if (next.phase === "idle" && !next.available) delay = 30_000;
      } catch {}
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [enabled, refresh, visible]);

  const [fetched, setFetched] = useState<UpdateNotes | null>(null);
  const offer = enabled ? notesOffer(status) : null;
  const revision = offer === null ? null : status?.latest_revision ?? null;
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) { setFetched(null); settled.current = null; return; }
    if (!offer || !visible || settled.current === offer) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      const again = (delay: number | null) => {
        if (delay === null) settled.current = offer;
        else timer = setTimeout(() => load(attempt + 1), delay);
      };
      fetchUpdateNotes().then((next) => {
        if (!live) return;
        if (next.revision !== revision) { again(notesUnboundDelay(attempt)); return; }
        settled.current = offer;
        setFetched(next);
      }, (error: unknown) => {
        if (live) again(notesRetryDelay(error, attempt));
      });
    };
    load(0);
    return () => { live = false; clearTimeout(timer); };
  }, [enabled, offer, revision, visible]);
  const notes = offeredNotes(status, fetched);

  const [brought, setBrought] = useState<InstalledNotes | null>(null);
  const running = enabled && status?.managed ? status.current_revision : null;
  const answered = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) { setBrought(null); answered.current = null; return; }
    if (!running || !visible || answered.current === running) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      const again = (delay: number | null) => {
        if (delay === null) answered.current = running;
        else timer = setTimeout(() => load(attempt + 1), delay);
      };
      fetchInstalledNotes().then((next) => {
        if (!live) return;
        // an answer for another commit, or for none, is not this release's: a bridge that
        // restarted between the two requests, or one still run by the supervisor that installed
        // it, which hands over to the release's own within seconds. A supervisor older than the
        // question never names a commit, so the asking ends, after about a minute.
        if (next.revision !== running) { again(notesUnboundDelay(attempt)); return; }
        answered.current = running;
        setBrought(next);
      }, (error: unknown) => {
        if (live) again(notesRetryDelay(error, attempt));
      });
    };
    load(0);
    return () => { live = false; clearTimeout(timer); };
  }, [enabled, running, visible]);
  const installed = installedUpdate(status, brought);

  const request = useCallback(async (next: UpdateRequest) => {
    setPending(true); setError(null); setErrorCode(null);
    try {
      await requestUpdate(next);
      if (mounted.current) {
        setStatus(previous => previous ? { ...previous, phase: "checking", error: null } : previous);
        setRefresh(value => value + 1);
      }
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : String(err));
        setErrorCode(err instanceof ApiError ? err.code : null);
      }
    } finally { if (mounted.current) setPending(false); }
  }, []);
  const failure = updateFailure(errorCode, status);
  const busy = pending || status?.phase === "checking" || status?.phase === "building" || status?.phase === "restarting";
  const reload = reloadReason(typeof __APP_REVISION__ === "string" ? __APP_REVISION__ : null, status, busy, chunkFailed);
  const needsReload = reload !== null;
  return { status, error, busy, needsReload, reload, notes, installed, request, failure, offered: offeredRevision(status) };
}

/**
 * The revision an Update button may install: the offer's, where the server installs exactly the
 * revision it is sent. A server that cannot (`revision_bound_install` absent: an older supervisor
 * runs it) is sent no install at all, never one without a revision.
 */
export function offeredRevision(status: UpdateStatus | null): string | null {
  if (!status?.managed || !status.available || status.blocked_reason || !status.latest_revision) return null;
  return status.revision_bound_install === true ? status.latest_revision : null;
}

export function updateFailure(requestCode: string | null, status: UpdateStatus | null): "offer-changed" | "restart" | null {
  if (requestCode === "update_offer_changed" || (status?.phase === "error" && status.error_code === "update_offer_changed")) return "offer-changed";
  if (requestCode === "update_restart_required" && status?.revision_bound_install !== true) return "restart";
  if (status?.managed && status.available && !status.blocked_reason && status.latest_revision && status.revision_bound_install !== true) return "restart";
  return null;
}

export type UpdatesModel = ReturnType<typeof useUpdates>;
