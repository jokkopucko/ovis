import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/relay-ios-sim.sh's cleanup, with no Mac: ssh, scp, tailscale and bun are stubs on PATH.
 * The remote half reports BUILT and then stays blocked (WebDriverAgent never says it is ready),
 * the WDA deadline fires, and cleanup must still stop that remote half, run eamac's cleanup, stop
 * the local stack, turn the serve ports off and say so, within a bound.
 */
const script = join(import.meta.dir, "relay-ios-sim.sh");
/** The whole run's bound: the WDA deadline (2 s) and at most two stop graces (2 s each), with room. */
const RUN_BOUND_MS = 30_000;

const stubs: Record<string, string> = {
  tailscale: `#!/usr/bin/env bash
state="$STUB/serve"; touch "$state"
case "$*" in
  "status --json") printf '{"Self":{"DNSName":"host.test."}}\\n';;
  "serve status --json") printf '{"TCP":{'; first=1; while read -r p; do [ -n "$p" ] || continue; [ $first = 1 ] || printf ','; printf '"%s":{}' "$p"; first=0; done <"$state"; printf '}}\\n';;
  serve\\ --bg\\ --https=*) p="\${3#--https=}"; echo "$p" >>"$state";;
  serve\\ --https=*\\ off) p="\${2#--https=}"; grep -vx "$p" "$state" >"$state.next"; mv "$state.next" "$state";;
  *) echo "tailscale $*" >>"$STUB/unexpected";;
esac
`,
  bun: `#!/usr/bin/env bash
case "$1" in
  -e) echo $((40000 + RANDOM % 20000));;
  run) ;;
  *stack.ts) echo $$ >"$STUB/stack.pid"; printf 'OFFER %s/s/0123456789abcdef0123456789abcdef/#offer=x\\n' "$APP_URL" >>"$EVENTS"; exec tail -f /dev/null;;
  *) echo "bun $*" >>"$STUB/unexpected";;
esac
`,
  ssh: `#!/usr/bin/env bash
case "$*" in
  *mktemp*) echo "$STUB/remote";;
  *remote.sh*)
    echo $$ >"$STUB/remote.pid"
    printf 'BUILT STUB-UDID\\n'
    [ "\${STUB_IGNORE_TERM:-}" = 1 ] && trap '' TERM
    # blocked as the real half is on wda.ready: alive, reading nothing, saying nothing more
    exec tail -f /dev/null;;
  *"bash -s --"*) cat >"$STUB/remote-cleanup.sh"; echo "eamac cleanup ran" >>"$STUB/log"; echo "eamac: $STUB/remote removed";;
  *) echo "ssh $*" >>"$STUB/unexpected";;
esac
`,
  scp: "#!/usr/bin/env bash\nexit 0\n",
};

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

let stub = "";
afterEach(() => {
  for (const name of ["remote.pid", "stack.pid"]) {
    const file = join(stub, name);
    if (existsSync(file)) { const pid = Number(readFileSync(file, "utf8")); if (alive(pid)) process.kill(pid, "SIGKILL"); }
  }
  rmSync(stub, { recursive: true, force: true });
});

async function run(ignoreTerm: boolean) {
  stub = mkdtempSync(join(tmpdir(), "relay-ios-sim-test-"));
  for (const [name, body] of Object.entries(stubs)) { writeFileSync(join(stub, name), body); chmodSync(join(stub, name), 0o755); }
  const child = Bun.spawn(["bash", script], {
    env: { ...process.env, PATH: `${stub}:${process.env["PATH"]}`, STUB: stub, STUB_IGNORE_TERM: ignoreTerm ? "1" : "",
      RELAY_IOS_SIM_WDA_SECONDS: "2", RELAY_IOS_SIM_STOP_SECONDS: "2", RELAY_IOS_SIM_BUILD_SECONDS: "10", UI_EVIDENCE_DIR: "" },
    stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const guard = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, RUN_BOUND_MS);
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(guard));
  return { stderr, code, timedOut };
}

describe.skipIf(process.platform === "win32")("relay-ios-sim.sh cleanup", () => {
  for (const ignoreTerm of [false, true]) {
    it(`finishes every step when eamac's half never reports WebDriverAgent ready${ignoreTerm ? " and ignores TERM" : ""}`, async () => {
      const { stderr, code, timedOut } = await run(ignoreTerm);
      expect(timedOut, `cleanup did not end within ${RUN_BOUND_MS / 1000} s:\n${stderr}`).toBe(false);
      expect(code).not.toBe(0);
      expect(stderr).toContain("no WDA within 2 s");
      expect(readFileSync(join(stub, "log"), "utf8")).toContain("eamac cleanup ran");
      const remoteCleanup = readFileSync(join(stub, "remote-cleanup.sh"), "utf8");
      expect(remoteCleanup).toContain('pkill -f "$r/remote.sh"');
      expect(remoteCleanup).toContain('rm -rf "$r"');
      expect(alive(Number(readFileSync(join(stub, "remote.pid"), "utf8"))), "the ssh carrying eamac's half was stopped").toBe(false);
      expect(alive(Number(readFileSync(join(stub, "stack.pid"), "utf8"))), "the local stack was stopped").toBe(false);
      expect(stderr).toContain("local stack stopped");
      expect(stderr).toMatch(/tailscale serve :\d+ off[\s\S]*tailscale serve :\d+ off/);
      expect(readFileSync(join(stub, "serve"), "utf8").trim()).toBe("");
      expect(stderr).toContain(`cleanup complete (exit ${code})`);
      expect(existsSync(join(stub, "unexpected")) ? readFileSync(join(stub, "unexpected"), "utf8") : "").toBe("");
    }, RUN_BOUND_MS + 5_000);
  }
});
