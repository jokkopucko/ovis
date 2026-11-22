import "./StatusDot.css";

export type StatusDotState = "ready" | "needs-you" | "offline" | "updating" | "checking" | "failed";

export type StatusDotSize = "glyph" | "inline";

export function StatusDot({ state, size = "glyph" }: { readonly state: StatusDotState; readonly size?: StatusDotSize }) {
  return (
    <svg className="status-dot" data-state={state} data-size={size} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      {state === "checking"
        ? <path className="status-dot-line" d="M7 1.75a5.25 5.25 0 1 1-5.25 5.25" fill="none" stroke="currentColor" />
        : <circle className="status-dot-line" cx="7" cy="7" r="5.25" fill={state === "ready" ? "currentColor" : "none"} stroke="currentColor" />}
      {state === "needs-you" && <path className="status-dot-fill" d="M7 1.75a5.25 5.25 0 0 0 0 10.5z" fill="currentColor" stroke="none" />}
      {state === "updating" && <path className="status-dot-mark" d="M7 10V4M4.5 6.5 7 4l2.5 2.5" fill="none" stroke="currentColor" />}
      {state === "failed" && <path className="status-dot-mark" d="M5 5l4 4M9 5l-4 4" fill="none" stroke="currentColor" />}
    </svg>
  );
}
