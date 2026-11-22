import { expect, it } from "bun:test";
import { join } from "node:path";
import { finishHerdrIdentity } from "../finishes.ts";
import { adapterAddress, isNamedPipe, pipeIdentity } from "./pipe.ts";

it("listens in the state folder outside Windows", () => {
  expect(adapterAddress("/home/a/.local/state/ovis", "linux")).toBe(join("/home/a/.local/state/ovis", "herdr-core.sock"));
  expect(adapterAddress("/Users/a/state", "darwin")).toBe(join("/Users/a/state", "herdr-core.sock"));
});

it("names one pipe per state folder on Windows, whatever case the path is written in", () => {
  const pipe = adapterAddress("C:\\Users\\a\\AppData\\Roaming\\Ovis\\server", "win32");
  expect(pipe).toMatch(/^\\\\\.\\pipe\\ovis-herdr-core-[0-9a-f]{32}$/);
  expect(isNamedPipe(pipe)).toBe(true);
  expect(adapterAddress("c:\\users\\A\\appdata\\roaming\\ovis\\SERVER", "win32")).toBe(pipe);
  expect(adapterAddress("C:\\Users\\a\\AppData\\Roaming\\Ovis\\server\\", "win32")).toBe(pipe);
  expect(adapterAddress("C:\\Users\\b\\AppData\\Roaming\\Ovis\\server", "win32")).not.toBe(pipe);
});

it("never reads a named pipe for the finish identity: the read would wait on the adapter for good", () => {
  const pipe = adapterAddress("C:\\state", "win32");
  expect(finishHerdrIdentity(pipe, "win32")).toBe(pipeIdentity(pipe));
  expect(pipeIdentity(pipe)).toStartWith(`${pipe}#`);
  const next = Bun.spawnSync([process.execPath, "-e", `import { pipeIdentity } from ${JSON.stringify(import.meta.dir + "/pipe.ts")}; console.log(pipeIdentity(${JSON.stringify(pipe)}))`]);
  expect(next.stdout.toString().trim()).toStartWith(`${pipe}#`);
  expect(next.stdout.toString().trim()).not.toBe(pipeIdentity(pipe));
  expect(isNamedPipe("C:\\Users\\a\\AppData\\Roaming\\herdr\\herdr.sock")).toBe(false);
});
