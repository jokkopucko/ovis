import { expect, it } from "bun:test";
import { AttachOutputTail, AttachStartupProbes } from "./attach-output.ts";

const teardown = "\x1b[?1049l\x1b[?25h\x1b[0 q";
const diagnostic = "herdr: server shut down: terminal attach taken over\r\n";

it("drops only the confirmed trailing diagnostic across every read boundary, keeping terminal modes", () => {
  const output = "pane output" + teardown + diagnostic;
  for (let cut = 1; cut < output.length; cut++) {
    const tail = new AttachOutputTail();
    expect(tail.push(output.slice(0, cut)) + tail.push(output.slice(cut)) + tail.flush(true)).toBe("pane output" + teardown);
  }
  const tail = new AttachOutputTail();
  expect([...output].map((byte) => tail.push(byte)).join("") + tail.flush(true)).toBe("pane output" + teardown);
});

it("preserves ordinary pane output, incomplete diagnostics and diagnostics without a takeover exit", () => {
  for (const output of [diagnostic, teardown + diagnostic + "more output", teardown + "herdr: another error", teardown + diagnostic, teardown + diagnostic + "\n".repeat(1000)]) {
    const tail = new AttachOutputTail();
    expect(tail.push(output) + tail.flush()).toBe(output);
  }
  const tail = new AttachOutputTail();
  expect(tail.push(teardown + "herdr: server shut down: term") + tail.flush(true)).toBe(teardown + "herdr: server shut down: term");
});

const PREAMBLE = /^(?:\x1b\[(?:\?[\d;]+[hl]|\d* q))*(?:\x1b(?:\[(?:\?[\d;]*|\d+ ?| )?)?)?$/;

function feed(probes: AttachStartupProbes, reads: string[]): { output: string; replies: string } {
  let output = "";
  let replies = "";
  for (const read of reads) {
    const before = output;
    const taken = probes.take(read, (text) => PREAMBLE.test(before + text));
    output += taken.output;
    replies += taken.replies;
  }
  return { output: output + probes.flush(), replies };
}

it("answers herdr's startup probes and keeps them out of the output across every read boundary", () => {
  const input = "\x1b[?1049h\x1b[?1016$p\x1b[cpane\x1b[?1049l";
  for (let cut = 1; cut < input.length; cut++) {
    expect(feed(new AttachStartupProbes(), [input.slice(0, cut), input.slice(cut)]))
      .toEqual({ output: "\x1b[?1049hpane\x1b[?1049l", replies: "\x1b[?1016;4$y\x1b[?1;2c" });
  }
});

it("leaves everything from the first real output on alone, in the same read too", () => {
  for (const input of ["pane\x1b[c", "\x1b[?1049hpane\x1b[?1016$p", "\x1b[?1004h\x1b[0c", "text\x1b[?10"]) {
    expect(feed(new AttachStartupProbes(), [input])).toEqual({ output: input, replies: "" });
  }
});

it("returns a held start that never became a probe", () => {
  const probes = new AttachStartupProbes();
  expect(probes.take("\x1b[?1049h\x1b[?10", (text) => PREAMBLE.test(text))).toEqual({ output: "\x1b[?1049h", replies: "" });
  expect(probes.flush() + probes.flush()).toBe("\x1b[?10");
});
