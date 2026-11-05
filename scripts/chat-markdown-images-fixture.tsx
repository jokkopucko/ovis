/** Browser fixture for pane-relative images and manual lookup recovery. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatMarkdownImages } from "../src/components/ChatMarkdownImages.tsx";
import { Markdown } from "../src/components/Markdown.tsx";
import { ImageLightbox } from "../src/components/ImageLightbox.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";
import { MachineContext } from "../src/lib/machineContext.tsx";
import type { GalleryImage } from "../src/lib/imageViewer.ts";
import "../src/styles.css";
import "../src/components/ChatView.css";

declare global { interface Window { imageQa: { update: (text: string) => void; reopen: () => void } } }
function Fixture() {
  const [text, setText] = useState("First answer: ![Diagram](./out/diagram.svg)");
  const [image, setImage] = useState<GalleryImage | null>(null);
  // a new key mounts the answer again, as reopening the chat or scrolling its row back in does
  const [mount, setMount] = useState(0);
  window.imageQa = { update: setText, reopen: () => setMount((value) => value + 1) };
  return <SettingsProvider><MachineContext.Provider value="fixture-pc">
    <ChatMarkdownImages key={mount} paneId="w1:p1" cwd="/repo" connected onOpen={setImage}>
      <Markdown>{text}</Markdown>
    </ChatMarkdownImages>
    {image && <ImageLightbox images={[image]} index={0} onClose={() => setImage(null)} />}
  </MachineContext.Provider></SettingsProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
