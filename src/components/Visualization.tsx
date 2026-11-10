import { useContext, useId } from "react";
import { visualizationName, visualizationTitle, type VisualizationReference } from "../../shared/visualization.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { useT } from "../lib/i18n.ts";
import "./Visualization.css";

/**
 * A Codex visualization reference in a chat answer: a card with the file's own name, the reference's title under
 * it, and **Open preview**, which opens the file in the file viewer (an HTML file there is its Page view) as the
 * person has the viewer set: its dialog, which holds the focus while it is open, or with Show beside the pane its
 * panel beside the pane, where the rest of the app stays in reach. The card itself looks nothing up and draws no
 * frame: the page's script runs only in the viewer the person opened, until it is closed. An inline frame was left
 * out for what the Page renderer's sandbox was measured not to hold (WebRTC reaches other hosts, a script takes
 * the keyboard focus).
 */
export function Visualization({ path, title }: VisualizationReference) {
  const t = useT();
  const open = useContext(OpenFileContext);
  const name = visualizationName(path), second = visualizationTitle({ path, title });
  const named = useId();
  return <div className="markdown-visualization">
    <div className="markdown-visualization-text">
      <span id={named} className="markdown-visualization-name">{name}</span>
      {/* the hidden break is for a copy alone: the rich text of a selection (lib/markdownClipboard.ts) keeps no
          line for a span, so the name and the title would run together there; the page draws them as two rows */}
      {second !== null && <><br hidden /><span className="markdown-visualization-title">{second}</span></>}
    </div>
    {/* several cards have the same words on their button: each says which file it opens */}
    {open && <button type="button" className="btn btn-ghost" aria-describedby={named} onClick={() => open(path)}>{t("Open preview")}</button>}
  </div>;
}
