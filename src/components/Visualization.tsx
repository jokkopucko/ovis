import { useContext } from "react";
import { visualizationName, visualizationTitle, type VisualizationReference } from "../../shared/visualization.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { useT } from "../lib/i18n.ts";
import "./Visualization.css";

/**
 * A Codex visualization reference in a chat answer: a card with the file's own name, the reference's title under
 * it, and **Open preview**, which opens the file in the file viewer (an HTML file there is its Page view). The card
 * itself looks nothing up and draws no frame: the page's script runs only in the viewer the person opened, which
 * holds the focus while it is open and stops when it is closed. An inline frame was left out for what the Page
 * renderer's sandbox was measured not to hold (WebRTC reaches other hosts, a script takes the keyboard focus).
 */
export function Visualization({ path, title }: VisualizationReference) {
  const t = useT();
  const open = useContext(OpenFileContext);
  const name = visualizationName(path), second = visualizationTitle({ path, title });
  return <div className="markdown-visualization">
    <div className="markdown-visualization-text">
      <span className="markdown-visualization-name">{name}</span>
      {second !== null && <span className="markdown-visualization-title">{second}</span>}
    </div>
    {open && <button type="button" className="btn btn-ghost" onClick={() => open(path)}>{t("Open preview")}</button>}
  </div>;
}
