import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

type Viewer = {
  send(frame: ClientMessage): void;
  wait(test: (frame: ServerMessage) => boolean, what: string): Promise<ServerMessage>;
};

export async function checkWindowsFitDemotion(owner: Viewer, connect: () => Promise<Viewer>, pane: string): Promise<string> {
  owner.send({ type: "role", mode: "observe" });
  await owner.wait(f => f.type === "role-ack" && f.mode === "observe", "demotion");
  owner.send({ type: "resize", pane_id: pane, cols: 29, rows: 11 });
  await owner.wait(f => f.type === "error" && f.code === "read_only", "retired controller cannot resize");
  // Leave the demoted socket open: its disconnect would release the slot even if its demotion did not.
  const successor = await connect();
  const cols = 66, rows = 23;
  successor.send({ type: "attach", pane_id: pane, cols, rows, windows_fit: true });
  const grant = await successor.wait(f => "pane_id" in f && f.pane_id === pane && (
    (f.type === "pane-geometry" && f.fixed === false && f.windows_fit === true && f.cols === cols && f.rows === rows)
    || (f.type === "error" && f.code === "attach_held")
  ), "ordinary controller grant after demotion");
  if (grant.type === "error") throw new Error("The demoted viewer still holds the control slot");
  return `${cols}x${rows}`;
}
