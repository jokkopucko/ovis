import assert from "node:assert/strict";
import type { Page, WebSocket } from "playwright-core";

export async function checkTerminalFileInput(page: Page, socket: WebSocket): Promise<void> {
  const input = (): Promise<string> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("No terminal input arrived")); }, 10_000);
    const listener = ({ payload }: { payload: string | Buffer }): void => {
      const frame = JSON.parse(String(payload));
      if (frame.type !== "input") return;
      clearTimeout(timer);
      off();
      resolve(frame.text);
    };
    const off = (): void => { socket.off("framesent", listener); };
    socket.on("framesent", listener);
  });
  await page.locator(".conn-live").waitFor();
  const host = page.locator(".pane-frame.is-current .pane-terminal");
  const path = "/Users/test/Downloads/monthly-report.json";
  const unbracket = (text: string): string => text.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
  const dropped = input();
  await host.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, path);
  assert.equal(unbracket(await dropped), path);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  await page.evaluate((text) => navigator.clipboard.writeText(text), path);
  await host.locator(".xterm-helper-textarea").focus();
  const pasted = input();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+v" : "Control+v");
  assert.equal(unbracket(await pasted), path);

  for (const eventType of ["drop", "paste"] as const) {
    const uploaded = page.waitForResponse((response) => response.url().endsWith("/api/pane/image") && response.request().method() === "POST");
    const fileInput = input();
    await host.evaluate((element, type) => {
      const data = new DataTransfer();
      data.items.add(new File(['{"month":"2026-09"}'], "monthly-report.json", { type: "application/json" }));
      const event = type === "drop"
        ? new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data })
        : new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
      element.querySelector(".xterm-helper-textarea")!.dispatchEvent(event);
    }, eventType);
    const response = await uploaded;
    assert.equal(response.status(), 200);
    const body: { path: string } = await response.json();
    assert.equal(unbracket(await fileInput), `'${body.path.replaceAll("'", "'\\''")}' `, "file input pastes only the quoted path, with no Enter");
    assert.match(body.path, /monthly-report-.*\.json$/);
  }
  console.log("PASS terminal path drop, native path paste and JSON file drop/paste");

  // A raster is named after its bytes (a PNG the browser calls image/jpeg from its name), and
  // text dressed as a PNG is refused with its reason and puts nothing into the terminal.
  const dropFile = (base64: string, name: string, type: string): Promise<void> => host.evaluate((element, file) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0))], file.name, { type: file.type }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, { base64, name, type });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const rasterUploaded = page.waitForResponse((response) => response.url().endsWith("/api/pane/image") && response.request().postDataJSON().name === "photo.jpg");
  const rasterInput = input();
  await dropFile(png, "photo.jpg", "image/jpeg");
  const raster = await rasterUploaded;
  assert.equal(raster.status(), 200);
  const rasterPath = ((await raster.json()) as { path: string }).path;
  assert.match(rasterPath, /paste-[^/\\]*\.png$/, "a PNG declared JPEG is stored as .png");
  assert.equal(unbracket(await rasterInput), `'${rasterPath.replaceAll("'", "'\\''")}' `);

  const forgedUploaded = page.waitForResponse((response) => response.url().endsWith("/api/pane/image") && response.request().postDataJSON().name === "forged.png");
  const forgedInputs: string[] = [];
  const forgedListener = ({ payload }: { payload: string | Buffer }): void => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "input") forgedInputs.push(frame.text);
  };
  socket.on("framesent", forgedListener);
  await dropFile(btoa("just some text, not an image"), "forged.png", "image/png");
  const forged = await forgedUploaded;
  assert.equal(forged.status(), 400);
  const refusal = await forged.text();
  assert.deepEqual(JSON.parse(refusal), { error: { code: "invalid_image", message: "file does not contain a supported raster image" } });
  assert.ok(!refusal.includes("just some text") && !refusal.includes("forged"), "the refusal echoes neither the content nor the name");
  await page.locator(".terminal-banner", { hasText: "file does not contain a supported raster image" }).waitFor();
  const afterRefusal = input();
  await host.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, path);
  assert.equal(unbracket(await afterRefusal), path, "the next input is the next drop, not a refused file's path");
  socket.off("framesent", forgedListener);
  assert.deepEqual(forgedInputs.map(unbracket), [path], "a refused raster sends no terminal input");
  console.log("PASS a mislabeled raster is stored by its bytes and a forged raster is refused with no terminal input");
}
