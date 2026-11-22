// Run by browserBroker.test.ts as an Electron main process: the built-in browser and its agents' socket, steered by lines on stdin.
import { app, BrowserWindow } from "electron";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { BrowserBroker } from "./browserBroker.ts";
import { BrowserTabs } from "./browserTabs.ts";

const root = process.env["OVIS_TEST_ROOT"]!;
const port = Number(process.env["OVIS_TEST_PORT"]);
app.setPath("userData", join(root, "user-data"));

void app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 700 });
  const tabs = new BrowserTabs(() => window, { blocked: ["b.localhost"], ovis: [] }, join(root, "downloads"), () => {});
  const broker = new BrowserBroker(() => tabs, join(root, "tokens"), join(root, "socket", "broker.sock"));
  await broker.start();
  createInterface({ input: process.stdin }).on("line", (line) => {
    const [command, id] = line.split(" ");
    if (command === "hold") tabs.hold(Number(id), true);
    if (command === "stop") broker.stop();
    if (command === "quit") app.quit();
    console.log(`DONE ${line}`);
  });
  console.log(`READY ${port}`);
});
