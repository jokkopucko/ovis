import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { browserStorage as storage, finishHints, FIRST_HINTS_KEY, hintsPending } from "../lib/firstHints.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import "./FirstStartHints.css";

const WATCH_AT_FIRST = 600;
const WATCH_AFTER_INPUT = 60;

const ANCHORS = [".view-switch", ".agents-sidebar > .agent-section-toggle", ".machine-new-row"] as const;

const visible = (selector: string): HTMLElement | null => {
  const node = document.querySelector<HTMLElement>(selector);
  const box = node?.getBoundingClientRect();
  return node && box && box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight ? node : null;
};

interface Place { top: number; left: number; side: "right" | "below"; arrow: number }

function placeBy(anchor: HTMLElement, width: number, height: number): Place {
  const box = anchor.getBoundingClientRect();
  const gap = 12;
  const clamp = (value: number, max: number) => Math.max(gap, Math.min(value, max - gap));
  if (box.left < window.innerWidth / 3) {
    const top = clamp(box.top + box.height / 2 - height / 2, window.innerHeight - height);
    return { side: "right", left: box.right + gap, top, arrow: box.top + box.height / 2 - top };
  }
  const left = clamp(box.left + box.width / 2 - width / 2, window.innerWidth - width);
  return { side: "below", top: box.bottom + gap, left, arrow: box.left + box.width / 2 - left };
}

export function FirstStartHints({ active }: { active: boolean }) {
  const t = useT();
  const [pending, setPending] = useState(() => { const store = storage(); return store !== null && hintsPending(store); });
  const [step, setStep] = useState(0);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [card, setCard] = useState<HTMLElement | null>(null);
  const refocus = useRef(false);
  const hints = [
    { title: t("Chat or Terminal"), text: t("Same agent, two views.") },
    { title: t("Waiting agents first"), text: t("From every workspace.") },
    { title: t("Start another agent"), text: t("Pick a folder to start in.") },
  ];
  // where the sidebar is drawn beside the pane: up to 768px it is a closed drawer (MachineSidebar.tsx DRAWER_QUERY)
  const wide = useMediaQuery("(min-width: 769px)");
  const shown = active && pending && wide;
  const finish = (): void => {
    const store = storage();
    if (store !== null) finishHints(store);
    setPending(false);
  };
  usePhoneSheetBack(finish, shown && anchor !== null);
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => { if (event.key === FIRST_HINTS_KEY || event.key === null) { const store = storage(); setPending(store !== null && hintsPending(store)); } };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!shown || anchor !== null) return;
    const locate = (): boolean => {
      if (step === 0 && visible(ANCHORS[0]) === null) return false;
      for (let index = step; index < ANCHORS.length; index++) {
        const node = visible(ANCHORS[index]!);
        if (node !== null) { if (index !== step) setStep(index); setAnchor(node); return true; }
      }
      finish();
      return true;
    };
    if (locate()) return;
    let frame = 0;
    let looks = 0;
    const observer = new MutationObserver(() => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (locate()) stop();
        else if (--looks === 0) observer.disconnect();
      });
    });
    const watch = (budget: number): void => {
      if (looks === 0) observer.observe(document.body, { childList: true, subtree: true });
      looks = Math.max(looks, budget);
    };
    const rewatch = (): void => watch(WATCH_AFTER_INPUT);
    const stop = (): void => {
      observer.disconnect();
      document.removeEventListener("pointerup", rewatch, true);
      document.removeEventListener("keyup", rewatch, true);
    };
    watch(WATCH_AT_FIRST);
    document.addEventListener("pointerup", rewatch, true);
    document.addEventListener("keyup", rewatch, true);
    return () => { stop(); cancelAnimationFrame(frame); };
  }, [shown, step, anchor]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!shown || anchor === null || card === null) return;
    const measure = (): void => {
      // a replaced anchor measures nothing: the hint waits for the new one rather than go to the corner
      const box = anchor.getBoundingClientRect();
      if (!anchor.isConnected || box.width === 0 || box.height === 0) { setAnchor(null); setPlace(null); return; }
      setPlace(placeBy(anchor, card.offsetWidth, card.offsetHeight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    observer.observe(card);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [shown, anchor, card]);

  // once placed (a card still hidden while it is measured cannot take the focus)
  useLayoutEffect(() => {
    if (place === null || card === null || !refocus.current) return;
    refocus.current = false;
    card.querySelector<HTMLButtonElement>(".btn-primary")?.focus();
  }, [place, card]);

  if (!shown || anchor === null) return null;
  const hint = hints[step]!;
  const last = step === hints.length - 1;
  const next = (): void => {
    if (last) { finish(); return; }
    refocus.current = card?.contains(document.activeElement) === true;
    setAnchor(null); setPlace(null); setStep(step + 1);
  };
  return createPortal(
    <section ref={setCard} className={`first-hint is-${place?.side ?? "below"}`} role="dialog" aria-modal="false" aria-labelledby="first-hint-title"
      style={place === null ? { visibility: "hidden" } : { top: place.top, left: place.left, "--first-hint-arrow": `${Math.round(place.arrow)}px` } as CSSProperties}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); finish(); } }}>
      <h2 id="first-hint-title" className="first-hint-title">{hint.title}</h2>
      <p className="first-hint-text">{hint.text}</p>
      <div className="first-hint-foot">
        <span className="first-hint-count">{step + 1}/{hints.length}</span>
        <button type="button" className="btn btn-primary" onClick={next}>{last ? t("Done") : t("Next")}</button>
      </div>
      <button type="button" className="icon-button first-hint-close" aria-label={t("Close")} title={t("Close")} onClick={finish}><X aria-hidden="true" /></button>
    </section>,
    document.body,
  );
}
