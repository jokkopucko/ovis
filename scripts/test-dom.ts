/**
 * react-dom decides at load whether it runs in a browser (whether `input` events exist, among others), and
 * the app's components load it before any test can open a page (src/lib/page.fixture.ts). So whenever
 * react-dom's client loads in a test process without a window, it loads with a happy-dom document in place,
 * removed again as soon as it has loaded: a text field's onChange then follows its input events whatever
 * file loads react-dom first, and no other test sees a window. Processes that never load react-dom pay nothing.
 */
import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { runInThisContext } from "node:vm";

function openDocument(): () => void {
  if (typeof globalThis.window !== "undefined") return () => {};
  const { Window } = require("happy-dom") as typeof import("happy-dom");
  const window = new Window();
  Object.assign(globalThis, { window, document: window.document });
  return () => {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
    void window.happyDOM.close();
  };
}

plugin({
  name: "react-dom loads in a document",
  setup(build) {
    build.onLoad({ filter: /[\\/]react-dom[\\/]cjs[\\/]react-dom-client\.(development|production)\.js$/ }, ({ path }) => {
      // evaluated here, as Node would wrap a CommonJS file, so the document is in place exactly while it loads
      const load = runInThisContext(`(function (exports, require, module, __filename, __dirname) {${readFileSync(path, "utf8")}\n})`, { filename: path }) as
        (exports: object, require: NodeJS.Require, module: { exports: object }, filename: string, dirname: string) => void;
      const module = { exports: {} };
      const close = openDocument();
      try {
        load(module.exports, createRequire(path), module, path, dirname(path));
      } finally {
        close();
      }
      return { exports: module.exports as Record<string, unknown>, loader: "object" };
    });
  },
});
