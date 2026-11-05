import { useCallback, useEffect, useRef, useState } from "react";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { fetchHealth, type HealthInfo } from "./api.ts";
import { applyHealthRead, healthFreshness, machineHealth, type HealthBook } from "./healthPresentation.ts";
import { sameData } from "./useMachineRoster.ts";

export function useLocalHealth() {
  // this PC's health reads (lib/healthPresentation.ts): its newest answer is what its herdr can do,
  // the failed reads since then only change what the header says
  const healthBook = useRef<HealthBook<HealthInfo>>(new Map());
  const healthReads = useRef(0);
  const [localHealth, setLocalHealth] = useState<{ confirmed: HealthInfo | null; failures: number }>({ confirmed: null, failures: 0 });
  const health = localHealth.confirmed;
  const localFreshness = healthFreshness(localHealth);
  // what the app says about this PC beyond its herdr's capabilities: kept through one failed read, as the header's details are
  const shownHealth = localFreshness === "unavailable" ? null : health;

  const readLocalHealth = useCallback(async () => {
    const read = ++healthReads.current;
    const answer = await fetchHealth().then((value) => ({ ok: true, value }) as const, () => ({ ok: false }) as const);
    const book = applyHealthRead(healthBook.current, "local", read, answer);
    if (book === healthBook.current) return;
    healthBook.current = book;
    const { confirmed, failures } = machineHealth(book, "local");
    setLocalHealth((previous) => sameData(previous, { confirmed, failures }) ? previous : { confirmed, failures });
  }, []);

  // a runtime switch, from this page or any other device: snapshots of a runtime this page left may come back
  // (herdr's TUI names no runtime in its health: it is herdr's)
  const localRuntime = health?.herdr ? health.herdr.runtime ?? "herdr" : null;
  const seenRuntime = useRef<string | null>(null);
  useEffect(() => {
    if (localRuntime === null) return;
    if (seenRuntime.current !== null && seenRuntime.current !== localRuntime) paneLifetimes.runtimeChanged(LOCAL_MACHINE);
    seenRuntime.current = localRuntime;
  }, [localRuntime]);
  return { localHealth, health, localFreshness, shownHealth, readLocalHealth };
}
