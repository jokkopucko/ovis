/** Owned, synthetic visualization fixture: no user session or files are read. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "../src/components/Markdown.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";
import { OpenFileContext } from "../src/lib/filePaths.ts";
import { chatSelectionClipboardPayload } from "../src/lib/markdownClipboard.ts";
import "../src/styles.css";
import "../src/components/ChatView.css";

declare global { interface Window { visualizationQa: { update: (value: string) => void; opened: string[]; copied: () => { text: string; html: string | null } | null } } }
function Fixture() {
  const [text, setText] = useState("Loading fixture");
  const [opened] = useState<string[]>([]);
  // `copied`: what the chat puts on the clipboard for the current selection in the answer (ChatTimeline's copy handler)
  window.visualizationQa = { update: setText, opened, copied: () => chatSelectionClipboardPayload(getSelection()!, document.getElementById("answer")!) };
  return <SettingsProvider><OpenFileContext.Provider value={(path) => { opened.push(path); }}>
    {/* an answer asks for references to be drawn; every other Markdown (a prompt card, a file's preview) keeps them as text */}
    <main id="answer" style={{ maxWidth: 960, margin: "auto", padding: 16 }}><Markdown visualizations>{text}</Markdown></main>
    <aside id="elsewhere" style={{ maxWidth: 960, margin: "auto", padding: 16, overflowWrap: "anywhere" }}><Markdown>{text}</Markdown></aside>
  </OpenFileContext.Provider></SettingsProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
