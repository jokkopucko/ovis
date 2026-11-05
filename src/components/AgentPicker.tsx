import { forwardRef, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ChevronDown, Plus, Terminal } from "lucide-react";

import type { AgentKind } from "../../shared/protocol.ts";
import { nativeModalOver } from "../lib/useFocusTrap.ts";
import { AgentMark } from "./AgentMark.tsx";
import "./AgentPicker.css";

/** The shell entry is a program name like the agents beside it, so it stays in English. */
const SHELL_LABEL = "Shell";

const LAST_AGENT_KEY = "ovis:new-session-agent";

/** The agent the last creation dialog started; "" is a plain shell. */
export function rememberedAgent(): string {
  try {
    return window.localStorage.getItem(LAST_AGENT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberAgent(kind: string): void {
  try {
    window.localStorage.setItem(LAST_AGENT_KEY, kind);
  } catch {
    /* private mode: the choice simply is not remembered */
  }
}

export interface AgentPickerProps {
  agents: AgentKind[];
  /** the chosen kind; "" is a plain shell */
  value: string;
  /** whether a plain shell leads the list (the default); false lists the agents alone, so `agents` holds at least one */
  shell?: boolean;
  disabled?: boolean;
  labelledBy: string;
  /** a word beside an agent's row on what its launch takes (NewSessionDialog: model, effort); rows without one say nothing */
  hints?: Readonly<Record<string, string>>;
  /** a last row that picks no agent but opens the setup of one this PC does not have yet */
  addAgent?: { label: string; onSelect: () => void };
  onChange: (kind: string) => void;
}

function OptionMark({ kind }: { kind: string }) {
  return kind ? <AgentMark agent={kind} size={16} /> : <span className="agent-picker-shell"><Terminal aria-hidden="true" /></span>;
}

/**
 * A select whose rows carry each agent's mark: a native <option> cannot hold an icon.
 * The marks are the inline SVGs the sidebar already renders, so the list costs nothing extra.
 */
export const AgentPicker = forwardRef<HTMLButtonElement, AgentPickerProps>(function AgentPicker({ agents, value, shell = true, disabled, labelledBy, hints = {}, addAgent, onChange }, ref) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<CSSProperties>({});
  const options: AgentKind[] = shell ? [{ kind: "", label: SHELL_LABEL }, ...agents] : agents;
  const selectedIndex = Math.max(0, options.findIndex((option) => option.kind === value));
  const selected = options[selectedIndex]!;
  // the Add row comes after the agents, at index options.length, and is never the value
  const addIndex = addAgent ? options.length : null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onMove = (event: Event): void => {
      // Only an ancestor's scroll can move the anchor; text inputs scroll too.
      if (event.type === "resize" || (event.target instanceof Node && rootRef.current !== null && event.target.contains(rootRef.current))) setOpen(false);
    };
    // The open list takes Escape wherever the focus is in its own dialog (Safari leaves it off a
    // button a click opened): it closes the list, not the dialog, which leaves this Escape to the
    // list. An overlay opened over the dialog (the palette, a native modal) keeps its own Escape.
    const onEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const root = rootRef.current;
      if (!root || nativeModalOver(root)) return;
      const surface = root.closest<HTMLElement>("[role='dialog'], dialog") ?? root;
      const active = document.activeElement;
      if (active && active !== document.body && !surface.contains(active)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onEscape, true);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("keydown", onEscape, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const option = document.getElementById(`${listId}-${active}`);
    const menu = option?.parentElement;
    if (!option || !menu) return;
    // Scroll only the list; moving its modal would close the anchored picker.
    const optionBounds = option.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    if (optionBounds.top < menuBounds.top) menu.scrollTop -= menuBounds.top - optionBounds.top;
    else if (optionBounds.bottom > menuBounds.bottom) menu.scrollTop += optionBounds.bottom - menuBounds.bottom;
  }, [open, active, listId]);

  const show = (): void => {
    // fixed to the trigger, so the modal body's scroll box does not clip the list
    const rect = rootRef.current!.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 16;
    const up = below < 160 && rect.top > below;
    const room = up ? rect.top - 16 : below;
    setPlace({
      left: rect.left,
      width: rect.width,
      maxHeight: Math.min(320, room),
      ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
    setActive(selectedIndex);
    setOpen(true);
  };

  const choose = (index: number): void => {
    setOpen(false);
    if (index === addIndex) addAgent!.onSelect();
    // the Add row can go while the list is open (the device turned into a watching one): its index is then no row
    else if (options[index] !== undefined) onChange(options[index].kind);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const last = addIndex ?? options.length - 1;
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        show();
      }
      return;
    }
    if (event.key === "Tab") {
      // a select-only combobox takes the row it is on as focus moves on, as a native select does;
      // leaving the Add row opens nothing
      if (active === addIndex) setOpen(false);
      else choose(active);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(last, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : last);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
    }
  };

  return (
    <div className="agent-picker" ref={rootRef}>
      <button
        ref={ref}
        type="button"
        className="select agent-picker-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={labelledBy}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <OptionMark kind={selected.kind} />
        <span className="agent-picker-label">{selected.label}</span>
        <ChevronDown className="agent-picker-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div id={listId} className="menu agent-picker-menu" role="listbox" aria-labelledby={labelledBy} style={place}>
          {options.map((option, index) => (
            <div
              id={`${listId}-${index}`}
              key={option.kind || "shell"}
              className="menu-item"
              role="option"
              aria-selected={index === selectedIndex}
              aria-label={option.kind !== "" && hints[option.kind] !== undefined ? `${option.label}: ${hints[option.kind]}` : undefined}
              data-active={index === active || undefined}
              onPointerEnter={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <OptionMark kind={option.kind} />
              <span className="menu-item-main">{option.label}</span>
              {option.kind !== "" && hints[option.kind] !== undefined && <span className="menu-item-hint">{hints[option.kind]}</span>}
            </div>
          ))}
          {addAgent && addIndex !== null && (
            <div
              id={`${listId}-${addIndex}`}
              className="menu-item agent-picker-add"
              role="option"
              aria-selected={false}
              data-active={active === addIndex || undefined}
              onPointerEnter={() => setActive(addIndex)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(addIndex)}
            >
              <span className="agent-picker-shell"><Plus aria-hidden="true" /></span>
              <span className="menu-item-main">{addAgent.label}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
