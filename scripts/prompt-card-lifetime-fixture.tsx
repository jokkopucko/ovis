import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { ChatView } from "../src/components/ChatView.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";
import { composerDraftKey, composerDrafts } from "../src/lib/composerDraft.ts";
import type { AgentStatus } from "../shared/protocol.ts";

interface Props { mounted: boolean; connected: boolean; agentStatus: AgentStatus; agentSession: string }
const PANE = "w1:p1";
const controls = window as unknown as { setChat?: (next: Partial<Props>) => void; composerDraft?: () => string };
controls.composerDraft = () => composerDrafts.read(composerDraftKey(PANE)).text;

// A real ChatView whose props the browser script steers: unmounted for the Terminal lens, the
// socket down and up, herdr's status and session for the pane.
function Fixture() {
  const [props, setProps] = useState<Props>({ mounted: true, connected: true, agentStatus: (new URLSearchParams(location.search).get("status") ?? "blocked") as AgentStatus, agentSession: "session-a" });
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  controls.setChat = (next) => setProps((current) => ({ ...current, ...next }));
  return <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <div style={{ flex: 1, minHeight: 0 }}>
      {props.mounted && <ChatView paneId={PANE} refreshKey={0} connected={props.connected} ended={false} agent="claude" agentStatus={props.agentStatus} agentSession={props.agentSession} promptDock={dock} />}
    </div>
    <div ref={setDock} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<SettingsProvider><Fixture /></SettingsProvider>);
