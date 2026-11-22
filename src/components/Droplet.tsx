import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import { flickVelocity, onDroplet, type PressSample, type QueuedDroplet } from "../lib/droplet.ts";
import { useT } from "../lib/i18n.ts";
import { STATUS_WORD } from "../lib/status.ts";
import { AgentMark } from "./AgentMark.tsx";
import "./Droplet.css";

const REVEAL_MS = 560;
export const DROPLET_HOLD_MS = 3600;
const EXIT_MS = 820;
const DISMISS_DRAG_PX = -18;
const DISMISS_VELOCITY = -0.42;
const TAP_SLOP_PX = 6;

type Phase = "in" | "out";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function Droplet({ onOpen }: { onOpen: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const [current, setCurrent] = useState<QueuedDroplet | null>(null);
  const [phase, setPhase] = useState<Phase>("in");
  const [drag, setDrag] = useState(0);
  const [top, setTop] = useState<number | null>(null);
  const [fit, setFit] = useState<number | null>(null);
  const probe = useRef<HTMLDivElement | null>(null);
  const card = useRef<HTMLButtonElement | null>(null);
  const pending = useRef<QueuedDroplet | null>(null);
  const currentRef = useRef(current); currentRef.current = current;
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const holdTimer = useRef<number | null>(null);
  const exitTimer = useRef<number | null>(null);
  // a press that dragged ends in a click on a mouse: that click is not a tap
  const dragged = useRef(false);
  const press = useRef<{ id: number; y: number; samples: PressSample[]; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const header = document.querySelector<HTMLElement>(".app-header");
    const measure = () => {
      const safeTop = Number.parseFloat(getComputedStyle(probe.current!).paddingTop) || 0;
      setTop(Math.max(safeTop, header?.getBoundingClientRect().bottom ?? 0) + 12);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (header) observer.observe(header);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, []);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const measure = () => setFit(Math.ceil(element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [current]);

  const clearHold = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  const leave = useCallback(() => {
    if (!currentRef.current || phaseRef.current === "out") return;
    clearHold();
    setPhase("out");
    phaseRef.current = "out";
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null;
      const next = pending.current;
      pending.current = null;
      setDrag(0);
      setCurrent(next);
      setPhase("in");
      phaseRef.current = "in";
    }, reducedMotion() ? 160 : EXIT_MS);
  }, []);

  const hold = useCallback((ms: number) => {
    clearHold();
    holdTimer.current = window.setTimeout(leave, ms);
  }, [leave]);

  useEffect(() => onDroplet((notice) => {
    if (!currentRef.current) {
      setCurrent(notice);
      setPhase("in");
      phaseRef.current = "in";
      return;
    }
    pending.current = notice;
    leave();
  }), [leave]);

  useEffect(() => {
    if (!current || phase !== "in") return;
    hold(REVEAL_MS + DROPLET_HOLD_MS);
  }, [current, phase, hold]);

  useEffect(() => () => {
    clearHold();
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // a right-click ends in no click: holding for it would leave the card up for good
    if (phaseRef.current === "out" || event.button !== 0) return;
    dragged.current = false;
    press.current = { id: event.pointerId, y: event.clientY, samples: [{ y: event.clientY, t: event.timeStamp }], moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearHold();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.id !== event.pointerId) return;
    const dy = event.clientY - p.y;
    if (Math.abs(dy) > TAP_SLOP_PX) p.moved = true;
    p.samples.push({ y: event.clientY, t: event.timeStamp });
    setDrag(Math.max(-120, Math.min(24, dy < 0 ? dy : dy * 0.35)));
  };
  const endPress = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const p = press.current;
    if (!p || p.id !== event.pointerId) return;
    press.current = null;
    const dy = event.clientY - p.y;
    const velocity = flickVelocity(p.samples, event.clientY, event.timeStamp);
    if (!cancelled && !p.moved) return;
    dragged.current = true;
    if (!cancelled && (dy <= DISMISS_DRAG_PX || velocity <= DISMISS_VELOCITY)) {
      leave();
      return;
    }
    setDrag(0);
    hold(DROPLET_HOLD_MS);
  };

  if (!current) return <div ref={probe} className="droplet-probe" aria-hidden="true" />;
  const what = t({ blocked: STATUS_WORD.blocked, done: STATUS_WORD.done, ended: "terminal ended" }[current.kind]);
  const detail = current.machine ? `${current.machine} · ${what}` : what;
  return (
    <div className="droplet" role="status" aria-live="polite" data-phase={phase} data-kind={current.kind} data-dragging={drag !== 0 ? "" : undefined} style={{ "--droplet-drag": `${drag}px`, "--droplet-top": `${top ?? 12}px`, ...(fit === null ? {} : { "--droplet-fit": `${fit}px` }), visibility: top === null ? "hidden" : "visible" } as CSSProperties} key={current.id}>
      <div ref={probe} className="droplet-probe" aria-hidden="true" />
      <svg className="droplet-defs" width="0" height="0" aria-hidden="true" focusable="false">
        <filter id="droplet-goo" x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="blur" />
          <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" />
        </filter>
      </svg>
      <div className="droplet-goo" aria-hidden="true">
        <span className="droplet-blob" />
      </div>
      <button
        type="button"
        ref={card}
        className="droplet-card"
        aria-label={`${current.title}, ${detail}. ${t("Open pane")}`}
        onClick={() => {
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          if (phaseRef.current === "out") return;
          onOpen(current.machineId, current.paneId);
          leave();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endPress(event, false)}
        onPointerCancel={(event) => endPress(event, true)}
      >
        <span className="droplet-mark">{current.agent ? <AgentMark agent={current.agent} size={22} /> : <span className="droplet-mark-blank" />}</span>
        <span className="droplet-text">
          <span className="droplet-title">{current.title}</span>
          <span className="droplet-detail">{detail}</span>
        </span>
        <span className="droplet-dot" aria-hidden="true" />
      </button>
      <button type="button" className="droplet-close" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={leave}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
