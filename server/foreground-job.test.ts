import { describe, expect, it } from "bun:test";
import { jobProcessesBelow } from "./foreground-job.ts";

/** `ownGroup`: the shell's job control puts the child in a group of its own. */
async function job(ownGroup: boolean): Promise<{ leader: number; child: number; stop: () => void }> {
  const child = "(exec -a claude bash -c 'echo $$; read -r line' <&3)";
  const shell = Bun.spawn(["bash", "-c", `${ownGroup ? "set -m; " : ""}exec 3<&0; ${child} & wait`], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = shell.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the child ended early: ${text}`);
    text += new TextDecoder().decode(value);
  }
  const pid = Number(text.trim());
  return { leader: shell.pid, child: pid, stop: () => { for (const each of [pid, shell.pid]) { try { process.kill(each, "SIGKILL"); } catch { } } } };
}

// the kernel itself, on the platforms whose terminals have a foreground job (#3009)
describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("the processes below a terminal's foreground process", () => {
  it("reads a child in the same job with its arguments", async () => {
    const running = await job(false);
    try {
      expect((await jobProcessesBelow(running.leader))?.find((entry) => entry.pid === running.child)?.argv).toEqual(["claude", "-c", "echo $$; read -r line"]);
    } finally { running.stop(); }
  });

  it("leaves out a child that runs in a process group of its own: the terminal's keyboard does not reach it", async () => {
    const running = await job(true);
    try {
      expect((await jobProcessesBelow(running.leader))?.map((entry) => entry.pid)).not.toContain(running.child);
    } finally { running.stop(); }
  });

  it("reads nothing for a process that runs no longer", async () => {
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    expect(await jobProcessesBelow(gone.pid)).toBeNull();
  });
});
