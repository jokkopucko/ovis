/**
 * The design gate: measures the ideal-state checks on the demo build and fails on violations.
 *
 *   bun scripts/design-gate-qa.ts [--surfaces <id,id>] [--checks <name,name>] [--baseline <report.json>]
 *     [--allow <allowlist.json>] [--layout-out <layout.json>] [--layout-baseline <layout.json>] [--workers <n>] --out <dir>
 *
 * Builds the demo app from this checkout (scripts/demo-build.ts) into a temporary directory, serves
 * it on 127.0.0.1 (a free port) and visits every SURFACE at 1440x900 and 390x844, light and dark,
 * each in a fresh browser context (Korean, the theme preset in ovis:settings; the phone with touch).
 * On each visit it runs the CHECKS and writes <out>/shots/<surface>--<viewport>--<theme>.png and
 * <out>/report.json: { generatedAt, commit, surfaces, failures[], counts }. A failure is
 * { check, surface, viewport, theme, key, detail }; its key (a short class path of the element plus
 * its trimmed text, digits as #) stays the same from run to run, so two reports can be compared.
 *
 * Exit code: with --baseline, 0 when every failure is in the baseline report (NEW and RESOLVED are
 * printed); without it, 0 only when every failure's {check, key} is in --allow, a JSON array of
 * { check, key, reason } whose reason names the owner's decision or the documented exception.
 * A surface whose staging fails is a `stage` failure: the gate cannot vouch for what it never saw.
 *
 * The focus check walks the desktop visits (the 390px visit is a touch context; its focus is not walked). It starts
 * at the focused control (a dialog's first) and presses Tab until focus comes back to a
 * control it already visited, measuring every stop; past FOCUS_CEILING presses it reports `focus-walk-incomplete`.
 * It also measures each focus indicator (outline or box-shadow ring) against the background next
 * to it and reports a `focus-contrast` failure under 3:1. The target check passes a control smaller than the
 * target size when its effective hit area does (a ::before or ::after expander, scripts/design-gate-checks.ts);
 * each visit lists those in `effectiveTargets`. The layout check ("자리는 그대로") records where the
 * fixed controls sit on each visit (LAYOUT_ANCHORS, plus every drawn control of the current composer by order) as
 * {"<surface>|<viewport>|<theme>": {"<anchor>": {x, y, w, h}}} in <out>/layout.json and --layout-out; with
 * --layout-baseline every anchor whose top-left moved more than 2px, or that is missing or new, prints
 * `MOVED <anchor> <surface> <viewport> <theme> <dx> <dy>` (`missing` / `added` for the offsets), then
 * `MOVED: <n>`, and any MOVED line makes the exit code 1. A baseline visit the run did not make has every anchor
 * missing, unless --surfaces narrowed the run and did not ask for it.
 *
 * Terminal text is measured for contrast as it is drawn: the demo draws every pane with libghostty, whose
 * DOM rows (.ghostty-row spans) lie over xterm's hidden ones, so a dim (SGR 2) span is read with its own
 * color over the terminal's viewport. Text drawn transparent (xterm's screen reader rows) is not shown and
 * not measured. Exceptions built in: a terminal's text is left out of font and overlap (its grid is the
 * program's); KaTeX places its glyph boxes over each other by design and is left
 * out of overlap; the boot spinner (#root > [role=status]) is stepped and still under reduced motion
 * (scripts/boot-loading-demo-regression.ts) and is left out of motion.
 *
 * Nothing waits a set time: every step waits for a selector or an app state, with a deadline.
 * All files and HTTP traffic stay in the disposable loopback app; no herdr session is opened.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { CHATS } from "../site/demo/fixtures.ts";
import { KO } from "../src/lib/i18n.ko.ts";
import type { ConversationTurn } from "../shared/protocol.ts";
import { appFaces } from "./app-faces.ts";
import { chromePath } from "./chrome-path.ts";
import { moves, ringOwner, targetVerdict, walkFocus, type FocusStop, type Layout, type Rect, type RingRead } from "./design-gate-checks.ts";
import { buildDemoApp } from "./demo-build.ts";
import { sheetRisen } from "./settings-page.ts";
import { openMoreGroup } from "./header-more.ts";

const repo = join(import.meta.dir, "..");
const PREFIX = "/herdr-web-ui/demo/app/";
const CHECKS = ["contrast", "target", "name", "focus", "trunc", "motion", "overflow", "font", "pcload", "layout"] as const;
type Check = (typeof CHECKS)[number];
type Theme = "light" | "dark";
type Viewport = "1440" | "390";

interface Failure { check: string; surface: string; viewport: Viewport; theme: Theme; key: string; detail: string }
interface Hit { check: string; key: string; detail: string }
/** A focus stop's failure, or the wrapper that draws its ring (null: the control itself). */
type FocusVerdict = Hit | { ringOn: string | null };
interface Visit { surface: string; viewport: Viewport; theme: Theme; shot: string; steps: string[]; pageErrors: string[]; stageError?: string; effectiveTargets?: string[]; focusRings?: string[] }
interface AllowEntry { check: string; key: string; reason: string }
/** The controls that keep their place ("자리는 그대로"): name and selector, the first drawn match (a second is `<name> #2`). */
const LAYOUT_ANCHORS: [string, string][] = [
  ["tab-more", ".header-tabs .tab-strip-more"],
  ["view-switch", ".app-header .view-switch"],
  ["files-button", ".app-header .header-files-button"],
  ["more-button", ".app-header .header-more-button"],
  ["drawer-toggle", ".app-header .drawer-toggle"],
  ["header-title", ".app-header .context-title"],
  ["new-workspace", ".header-side .new-workspace-button"],
  ["sidebar-toggle", ".header-side .sidebar-toggle"],
  ["settings-gear", ".sidebar-footer-settings"],
  ["status-bar", ".status-bar"],
];
/** The current pane's composer: every drawn control in it, named `composer-<index> <class>` in document order, so a control added, removed or reordered changes the names. */
const COMPOSER = ".pane-frame.is-current .composer";
const LAYOUT_TOLERANCE = 2;
const FOCUS_CEILING = 200;

const args = process.argv.slice(2);
const option = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
};
const list = (flag: string): string[] | undefined => option(flag)?.split(",").map((item) => item.trim()).filter(Boolean);
const outArg = option("--out");
if (!outArg) throw new Error("Usage: bun scripts/design-gate-qa.ts [--surfaces <id,id>] [--checks <name,name>] [--baseline <report.json>] [--allow <allowlist.json>] [--layout-out <layout.json>] [--layout-baseline <layout.json>] [--workers <n>] --out <dir>");
const OUT = resolve(outArg);
const baselinePath = option("--baseline");
const allowPath = option("--allow");
const workers = Number(option("--workers") ?? 6);
// "6x" or 0 would start no worker: no visit measured, no failure found, and a passing exit
if (!Number.isInteger(workers) || workers < 1) throw new Error(`--workers ${option("--workers")}: a whole number of 1 or more`);
// hidden: makes every chat turn's text #999 on #aaa, to prove the contrast check and the baseline diff can fail
const SELF_TEST = args.includes("--self-test");
// hidden: shifts the tab strip's More button and the composer status row's buttons (the context ring) 10px right,
// to prove the layout check and its baseline diff can fail
const SELF_TEST_LAYOUT = args.includes("--self-test-layout");
const layoutOutPath = option("--layout-out");
const layoutBaselinePath = option("--layout-baseline");
const checks = new Set<Check>((list("--checks") ?? [...CHECKS]).map((name) => {
  if (!(CHECKS as readonly string[]).includes(name)) throw new Error(`--checks ${name}: one of ${CHECKS.join(", ")}`);
  return name as Check;
}));
if ((layoutOutPath || layoutBaselinePath || SELF_TEST_LAYOUT) && !checks.has("layout")) throw new Error("--layout-out, --layout-baseline and --self-test-layout need the layout check");

const label = (text: string): string => KO[text] ?? text;
const minutes = (n: number): number => n * 60_000;

/** Turns stamped a few minutes apart, ending now; every assistant turn finished. */
function restamp(turns: ConversationTurn[]): ConversationTurn[] {
  const now = Date.now();
  turns.forEach((turn, index) => {
    const at = now - minutes((turns.length - index) * 4 + 3);
    turn.ts = new Date(at).toISOString();
    if (turn.role === "assistant") {
      turn.end_ts = new Date(at + 110_000).toISOString();
      const last = turn.parts.at(-1);
      if (last?.kind === "text") last.phase = "final_answer";
    }
  });
  return turns;
}

/** A long finished transcript: user and assistant text, folded tool calls, a compaction card. */
const LONG = restamp(["api", "flaky", "cli", "hermes", "omp"].flatMap((name) => structuredClone(CHATS[name]?.turns ?? [])));

const MARKDOWN_TURNS = restamp([
  { role: "user", ts: null, parts: [{ kind: "text", text: "`cli-tools.toml` 계획을 표와 코드로 정리해 줘." }] },
  { role: "assistant", ts: null, parts: [{ kind: "text", text: [
    "## 결과 요약", "", "`cli-tools.toml` 계획을 정리했습니다. 아래 표는 플래그별 기본값입니다.", "",
    "| 플래그 | 기본값 | 설명 |", "|---|---|---|", "| `--retries` | 3 | 업로드 재시도 횟수 |", "| `--timeout` | 30s | 요청 제한 시간 |", "| `--verbose` | false | 자세한 로그를 남긴다 |", "",
    "### 적용 순서", "", "1. 설정 파일을 읽는다", "2. 명령줄 플래그가 파일의 값을 덮어쓴다", "3. 환경 변수 `CLI_TOOLS_CONFIG`가 파일 경로를 바꾼다", "",
    "- 파일은 **프로젝트 루트**에서 먼저 찾는다", "- 없으면 `~/.config/cli-tools.toml`", "  - 둘 다 없으면 기본값으로 돈다", "",
    "```toml", "[publish]", "retries = 3", "timeout = \"30s\"", "```", "",
    "```ts", "export function load(path = \"cli-tools.toml\"): Config {", "  return parse(readFileSync(path, \"utf8\"));", "}", "```", "",
    "재시도 대기 시간은 지수 백오프 $t_n = t_0 \\cdot 2^{n}$ 으로 늘어나고, 전체 상한은", "", "$$", "T = \\sum_{n=0}^{k} t_0 \\cdot 2^{n} = t_0 \\,(2^{k+1} - 1)", "$$", "",
    "> 4xx 응답은 서버가 의도적으로 거절한 것이므로 다시 시도하지 않는다.", "", "- [x] 설계 검토", "- [ ] 구현과 테스트",
  ].join("\n") }] },
]);

const QUESTION_PROMPT = {
  id: "gate-question", agent: "claude", kind: "question", title: "저장소 선택", question: "멱등성 키를 어디에 저장할까요?", body: null,
  options: [
    { label: "Postgres 테이블", description: "결제와 같은 데이터베이스에 두고 한 트랜잭션으로 처리합니다" },
    { label: "Redis (TTL 24시간)", description: "빠르지만 재시작하면 사라질 수 있습니다" },
    { label: "직접 입력", description: null },
  ],
  multi_select: false, custom_option_index: 2,
};

const DOCS = {
  root: "/home/demo/.herdr/worktrees/checkout-api",
  listed: ["docs/plans/rollout-plan.md", "HANDOFF.md", "docs/review/report-2026-11-04.md", "README.md"],
  text: { "HANDOFF.md": [
    "# HANDOFF", "", "결제 API 멱등성 작업을 넘깁니다. 아래 순서대로 확인하세요.", "", "## 바뀐 것", "",
    "- `POST /payments`가 `Idempotency-Key`를 저장하고 같은 키에는 첫 응답을 돌려줍니다.", "- 재생된 요청은 `payments_idempotent_replays_total` 지표로 셉니다.", "",
    "## 남은 일", "", "1. 키 만료 정책(24시간) 확정", "2. 운영 대시보드에 지표 패널 추가", "", "```bash", "bun test payments", "```", "", "> 4xx 응답은 절대 다시 시도하지 않습니다.",
  ].join("\n") },
};

const ACCOUNT = { service: "https://account.ovis.sh", providers: { providers: ["github", "google", "apple"], device: ["github", "google"], device_page: [] } };

const RUNNING_VERSION = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;
const OFFERED_VERSION = RUNNING_VERSION.replace(/(\d+)$/, (n) => String(Number(n) + 1));
const UPDATE_NOTES = {
  revision: "0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e", omitted: 0,
  releases: [{
    version: OFFERED_VERSION, date: "2026-11-08",
    notes: "### Fixed\n- Arrow keys and Space move the cursor in a terminal's input line again.\n- The sidebar opens in Safari.\n\n### Improved\n- Push alerts name the pane in their title.",
    summary: { ko: { fixed: ["터미널 입력줄에서 화살표·스페이스 키가 다시 커서를 움직입니다", "Safari에서 사이드바가 열립니다"], improved: ["푸시 알림 제목에 창 이름이 들어갑니다"] }, en: { fixed: ["Arrow keys and Space move the cursor in a terminal's input line again", "The sidebar opens in Safari"], improved: ["Push alerts name the pane in their title"] } },
  }],
};
/** An update on offer to the build being served: its revision is the build's own (build.json). */
const updateStage = (): Record<string, unknown> => ({
  updates: {
    managed: true, auto_update: false, phase: "idle", current_revision: (JSON.parse(readFileSync(join(app, "build.json"), "utf8")) as { revision: string }).revision, latest_revision: UPDATE_NOTES.revision,
    current_version: RUNNING_VERSION, latest_version: OFFERED_VERSION, available: true, checked_at: new Date().toISOString(), blocked_reason: null, error: null, revision_bound_install: true, channel: "stable",
  },
  updateNotes: UPDATE_NOTES,
});

const MOVE_PLAN = {
  revision: "plan-1", ready: false,
  workspaces: [
    { workspace_id: "w1C", name: "checkout-api", tabs: [{ tab_id: "w1C:t1", name: "1", root: { pane: "w1C:p1" } }] },
    { workspace_id: "w1D", name: "web-dashboard", tabs: [{ tab_id: "w1D:t1", name: "1", root: { pane: "w1D:p1" } }] },
    { workspace_id: "w1E", name: "infra", tabs: [{ tab_id: "w1E:t1", name: "1", root: { pane: "w1E:p1" } }] },
    { workspace_id: "w1G", name: "release", tabs: [{ tab_id: "w1G:t1", name: "1", root: { split: "right", ratio: 0.5, first: { pane: "w1G:p1" }, second: { pane: "w1G:p2" } } }] },
  ],
  panes: [
    { pane_id: "w1C:p1", cwd: "/home/demo/checkout-api", name: null, verdict: { kind: "resume", agent: "claude", session_id: "6b1f0f2a-demo", argv: ["claude", "--resume", "6b1f0f2a-demo"], ended: false } },
    { pane_id: "w1D:p1", cwd: "/home/demo/web-dashboard", name: null, verdict: { kind: "busy", reason: "agent_waiting", agent: "codex", command: null } },
    { pane_id: "w1E:p1", cwd: "/home/demo/infra", name: null, verdict: { kind: "fresh", agent: "pi" } },
    { pane_id: "w1G:p1", cwd: "/home/demo/release", name: null, verdict: { kind: "busy", reason: "command_running", agent: null, command: "bun test --watch" } },
    { pane_id: "w1G:p2", cwd: "/home/demo/release", name: null, verdict: { kind: "shell" } },
  ],
};

const minutesAgo = (n: number): number => Date.now() - minutes(n);
const UNSENT_STORAGE = {
  "ovis:unsent:gate-unsent-1": JSON.stringify({ machine_id: "local", pane_id: "w1C:p1", pane_title: "checkout-api", kind: "message", text: "재시도 예산을 업로드 클라이언트에 추가해 줘. 4xx는 다시 시도하지 말고 테스트도 같이.", at: minutesAgo(42) }),
  "ovis:unsent:gate-unsent-2": JSON.stringify({ machine_id: "local", pane_id: "w1G:p1", pane_title: "release", kind: "line", text: "git push origin release/0.5.1 --tags", at: minutesAgo(55) }),
  "ovis:unsent:gate-unsent-3": JSON.stringify({ machine_id: "local", pane_id: "w1D:p1", pane_title: "web-dashboard", kind: "held", text: "y", at: minutesAgo(58) }),
};

const TAB_LABELS = ["api", "web", "docs", "deploy", "review", "tests", "release-notes", "migrations", "infra", "billing", "search", "mobile", "analytics", "onboarding"];

/** Holds the demo's 4500 ms turn-ending timer (the api pane stays mid-turn; no finished-turn alert lands over a visit). */
const HOLD_DEMO_TURN = `<script>(() => { const later = window.setTimeout; window.__laterTimeout = later; window.setTimeout = (callback, ms, ...rest) => ms === 4500 ? 0 : later(callback, ms, ...rest); })();</script>`;
const RELEASE_TIMERS = `<script>if (window.__laterTimeout) window.setTimeout = window.__laterTimeout;</script>`;
/** Over the demo's fetch, per `window.__gateStage` (set by each visit's init script): a pane's conversation, a question prompt, Files' Documents, an account service. */
const STAGE_HOOKS = `<script>(() => {
  const stage = window.__gateStage || {};
  const demo = window.fetch;
  const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  if (stage.account) {
    const meta = document.createElement("meta");
    meta.name = "ovis-pc-account-service";
    meta.content = stage.account.service;
    document.head.appendChild(meta);
  }
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const pane = url.searchParams.get("pane_id") || "";
    if (stage.account && url.origin === new URL(stage.account.service).origin) {
      if (url.pathname === "/v1/providers") return json(stage.account.providers);
      if (url.pathname === "/v1/pcs") return json({ pcs: [] });
      if (url.pathname === "/v1/identities") return json({ identities: [] });
      if (url.pathname === "/v1/admissions") return json({ admissions: [] });
      return json({ error: { code: "not_found", message: "no such route in the gate's account service" } }, 404);
    }
    if (url.pathname === "/api/pane/conversation" && stage.turns && stage.turns[pane]) {
      const chat = stage.turns[pane];
      return json(Object.assign({ source: chat.source, history_id: "gate-" + pane, cursor: null, turns: url.searchParams.has("before") ? [] : chat.turns }, chat.metadata ? { metadata: chat.metadata } : {}));
    }
    if (url.pathname === "/api/pane/prompt" && stage.prompt && stage.prompt.pane === pane) return json({ prompt: stage.prompt.prompt, outcomes: [] });
    if (url.pathname === "/api/updates" && stage.updates) return json(stage.updates);
    if (url.pathname === "/api/updates/notes" && stage.updateNotes) return json(stage.updateNotes);
    if (url.pathname === "/api/runtime/move" && stage.move) {
      const method = ((init && init.method) || (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "POST") return Promise.resolve(new Response(null, { status: 202 }));
      if (method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      return json({ available: true, plan: stage.move.plan, status: { state: "idle" } });
    }
    if (stage.docs) {
      const root = stage.docs.root;
      if (url.pathname.endsWith("/pane/docs")) {
        return json({ root, truncated: false, documents: stage.docs.listed.map((path, index) => ({ path, size: 400 + index, modified: new Date(Date.now() - (index * 30 + 5) * 60000 - (index > 2 ? 72 * 3600000 : 0)).toISOString() })) });
      }
      const asked = url.searchParams.get("path") || "";
      if (asked.startsWith(root + "/") && asked.endsWith(".md")) {
        const name = asked.slice(asked.lastIndexOf("/") + 1);
        const text = stage.docs.text[name] || ("# " + name + "\\n\\nOpened from Documents.\\n");
        if (url.pathname.endsWith("/fs/stat")) return json({ path: asked, name, kind: "text", mime: "text/markdown", size: text.length, modified: new Date().toISOString() });
        if (url.pathname.endsWith("/fs/file")) return Promise.resolve(new Response(text, { headers: { "content-type": "text/markdown" } }));
      }
    }
    return demo(input, init);
  };
})();</script>`;

interface Env { phone: boolean; steps: string[]; press: (locator: Locator) => Promise<void> }
interface Surface {
  id: string;
  /** Only at this width: the state does not exist at the other. */
  only?: "desktop" | "phone";
  pane?: string;
  /** No pane in the address: the app as a first run draws it. */
  plain?: boolean;
  query?: string;
  /** The lens the pane opens in (chat by default). */
  view?: "chat" | "terminal";
  /** What the page's fetch answers instead of the demo (STAGE_HOOKS); a function when it needs the build. */
  stage?: Record<string, unknown> | (() => Record<string, unknown>);
  storage?: Record<string, string>;
  /** Fields of ovis:settings beside the language and theme, stored before the app loads. */
  settings?: Record<string, unknown>;
  run?: (page: Page, env: Env) => Promise<void>;
}

const current = (page: Page): Locator => page.locator(".pane-frame.is-current");
/** Finite animations finished, then two frames drawn; infinite ones (spinners) are left running. */
async function settle(page: Page): Promise<void> {
  // a tap leaves its control :active (drawn pressed, at 0.55 opacity) for a moment: what is measured is the control at rest
  await page.waitForFunction(() => document.querySelector(":active:not(html, body)") === null, undefined, { timeout: 5_000 }).catch(() => undefined);
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || !Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)), undefined, { timeout: 5_000 }).catch(() => undefined);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}
async function openDrawer(page: Page, env: Env): Promise<void> {
  await env.press(page.locator(".drawer-toggle"));
  await page.locator("#workspace-drawer.is-open").waitFor({ state: "visible" });
  await page.locator("#workspace-drawer .machine-list").first().waitFor({ state: "visible" });
  await settle(page);
  env.steps.push("opened the workspace drawer");
}
async function openFiles(page: Page, env: Env): Promise<void> {
  if (env.phone) {
    await env.press(page.locator(".header-more-button"));
    await env.press(page.getByText(label("Browse files"), { exact: true }));
  } else {
    await env.press(page.locator(".header-files-button"));
  }
  await page.locator(".files-dialog").waitFor();
  await settle(page);
  await env.press(page.locator(".files-dialog-tabs").getByRole("button", { name: label("Documents"), exact: true }));
  await page.locator(".md-docs .md-docs-item").first().waitFor();
  await settle(page);
  env.steps.push("Files opened on its Documents tab");
}
async function settingsPage(page: Page, env: Env): Promise<void> {
  await page.locator(".settings-dialog").waitFor();
  await sheetRisen(page);
  await page.locator(".settings-dialog [role='tabpanel']").first().waitFor({ state: "visible" });
  await page.waitForFunction((loading) => ![...document.querySelectorAll(".settings-body [role='status']")].some((node) => node.textContent?.trim() === loading), label("Loading…"));
  await settle(page);
  env.steps.push("Settings opened by the deep link on its page");
}
const menuRoot = (page: Page): Locator => page.locator(".row-menu, .row-sheet").last();
const menuItem = (page: Page, text: string): Locator => menuRoot(page).locator('[role="menuitem"], button').filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first();
async function openRuntimeMove(page: Page, env: Env): Promise<void> {
  await settingsPage(page, env);
  const open = page.locator('.settings-dialog [data-section="runtime"]').getByRole("button", { name: label("Move…"), exact: true });
  await open.waitFor();
  await env.press(open);
  await page.locator('.runtime-move[data-view="plan"]').waitFor();
  await settle(page);
}
const pcLoad = (on: boolean): Surface => ({
  id: on ? "pc-load-on" : "pc-load-off", pane: panes.api, storage: { "ovis:pc-load": String(on) },
  run: async (page, env) => {
    if (env.phone) { await openDrawer(page, env); return; }
    await page.locator(".status-bar").waitFor({ state: "visible" });
    // the load line comes with the demo's first /api/system answer; its absence is the pcload check's to report
    if (on) await page.locator(".status-bar-load").waitFor({ state: "visible", timeout: 10_000 }).catch(() => env.steps.push("(no .status-bar-load within 10 s)"));
    await settle(page);
  },
});

const SETTINGS_PAGES = ["appearance", "chat", "terminal", "alerts", "agents", "shortcuts", "devices", "experimental", "about"] as const;

const SURFACES: Surface[] = [
  {
    id: "main-chat", pane: panes.flaky, stage: { turns: { [panes.flaky]: { source: "claude-transcript", turns: LONG } } },
    run: async (page, env) => {
      await current(page).locator(".chat-turn").first().waitFor();
      await current(page).locator(".work-block").first().waitFor();
      env.steps.push(`the Claude pane's conversation replaced by ${LONG.length} finished turns`);
    },
  },
  {
    // the model pill with its context ring: the ring is a button in the composer's status row, outside its control groups
    id: "composer-context", pane: panes.flaky,
    stage: { turns: { [panes.flaky]: { source: "claude-transcript", turns: LONG, metadata: { model: "claude-opus-4-1", reasoning_effort: "high", context: { used: 132_000, window: 200_000 } } } } },
    run: async (page, env) => {
      await current(page).locator(".chat-turn").first().waitFor();
      await current(page).locator(".composer-status .composer-context").waitFor();
      await settle(page);
      env.steps.push("the conversation answer names a model and 132k of a 200k context: the composer draws its context ring");
    },
  },
  {
    id: "approval-card", pane: panes.web,
    run: async (page) => { await page.locator(".prompt-card").waitFor(); },
  },
  {
    id: "question-card", pane: panes.web, stage: { prompt: { pane: panes.web, prompt: QUESTION_PROMPT } },
    run: async (page) => { await page.locator(".prompt-card").getByText(QUESTION_PROMPT.question, { exact: true }).waitFor(); },
  },
  {
    id: "composer-typing", pane: panes.flaky, stage: { turns: { [panes.flaky]: { source: "claude-transcript", turns: LONG } } },
    run: async (page, env) => {
      await current(page).locator(".chat-turn").first().waitFor();
      await page.getByRole("textbox", { name: label("Message"), exact: true }).fill("업로드 클라이언트에 재시도 예산을 추가해 줘.\n4xx는 절대 다시 시도하지 말고, 테스트도 같이 써 줘.");
      await page.waitForFunction(() => Object.keys(localStorage).some((key) => key.startsWith("ovis:composer-draft:")));
      env.steps.push("two Korean lines typed in the message box, not sent");
    },
  },
  {
    id: "chat-empty", pane: panes.flaky,
    run: async (page, env) => {
      const pane = await page.evaluate(async () => {
        const response = await fetch("/api/workspace/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/home/demo/new-project", agent: { kind: "claude" } }) });
        return ((await response.json()) as { pane_id: string }).pane_id;
      });
      await page.evaluate((id) => localStorage.setItem(`ovis:view:${id}`, "chat"), pane);
      const row = page.locator(`.pane-select[title^="${pane} —"]`).first();
      await row.waitFor({ state: "attached" });
      await row.evaluate((node: HTMLElement) => node.click());
      await page.locator(`.pane-select[title^="${pane} —"][aria-current="true"]`).first().waitFor({ state: "attached" });
      await current(page).locator(".terminal-stack.is-chat").waitFor();
      await current(page).locator(".composer-greeting").waitFor();
      await current(page).locator('.composer-status[data-status="idle"]').waitFor({ state: "attached" });
      // a desktop lifts the greeting and the composer to the pane's middle; a phone keeps them docked
      if (!env.phone) await page.waitForFunction(() => {
        const greeting = document.querySelector(".pane-frame.is-current .composer-greeting")?.getBoundingClientRect();
        const box = document.querySelector(".pane-frame.is-current .composer")?.getBoundingClientRect();
        const stack = document.querySelector(".pane-frame.is-current .terminal-stack")?.getBoundingClientRect();
        return !!greeting && !!box && !!stack && Math.abs((greeting.top + box.bottom) / 2 - (stack.top + stack.bottom) / 2) <= 2;
      }, undefined, { timeout: 8_000 });
      env.steps.push(`a new workspace (${pane}) selected: its greeting over the composer`);
    },
  },
  {
    id: "markdown-rich", pane: panes.omp, stage: { turns: { [panes.omp]: { source: "claude-transcript", turns: MARKDOWN_TURNS } } },
    run: async (page) => {
      await current(page).locator("table").first().waitFor();
      await current(page).locator(".katex").first().waitFor();
    },
  },
  {
    id: "file-viewer", pane: panes.web, stage: { docs: DOCS },
    run: async (page, env) => {
      await openFiles(page, env);
      await env.press(page.locator(".md-docs .md-docs-item", { hasText: "HANDOFF.md" }));
      await page.locator('section.file-viewer[aria-label="HANDOFF.md"]').waitFor();
      await page.getByText("결제 API 멱등성 작업을 넘깁니다", { exact: false }).waitFor();
      await settle(page);
    },
  },
  { id: "files-documents", pane: panes.web, stage: { docs: DOCS }, run: openFiles },
  {
    id: "command-palette", pane: panes.flaky,
    run: async (page) => {
      await page.keyboard.press("ControlOrMeta+Shift+K");
      await page.getByRole("dialog", { name: label("Command palette") }).waitFor();
      await sheetRisen(page, ".command-palette");
      await settle(page);
    },
  },
  {
    id: "new-workspace", pane: panes.api, query: "&new=workspace&demo_devices=empty",
    run: async (page) => { await page.locator(".agent-picker-trigger").waitFor(); await settle(page); },
  },
  ...SETTINGS_PAGES.map((id): Surface => ({ id: `settings-${id}`, pane: panes.api, query: `&settings=${id}`, run: settingsPage })),
  {
    id: "sidebar", only: "desktop", pane: panes.api,
    run: async (page) => { await page.locator(".sidebar-shell").first().waitFor({ state: "visible" }); await settle(page); },
  },
  { id: "drawer-open", only: "phone", pane: panes.api, run: openDrawer },
  {
    id: "held-messages", pane: panes.web,
    storage: {
      // kept under the demo's herdr: with no record they would be an earlier release's and go to Recover unsent text
      "ovis:pane-lifetime:local": "demo-local",
      [`ovis:queue:${panes.web}`]: JSON.stringify({ version: 1, messages: [{ id: "gate-q1", text: "끝나면 /metrics 응답 예시도 README에 넣어 줘." }, { id: "gate-q2", text: "그리고 재생 카운터에 대한 테스트를 하나 더." }] }),
    },
    run: async (page, env) => {
      const toggle = page.locator(".composer-queue-toggle");
      await toggle.waitFor();
      await env.press(toggle);
      await page.locator('.composer-queue-toggle[aria-expanded="true"]').waitFor();
      await settle(page);
      env.steps.push("two held messages under the approval card, unfolded");
    },
  },
  {
    id: "split-panes", only: "desktop", pane: panes.api,
    run: async (page, env) => {
      await current(page).locator(".chat-turn, .work-block").first().waitFor();
      const status = await page.evaluate(async (pane) => (await fetch("/api/pane/split", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: pane, direction: "right", focus: true }) })).status, panes.api);
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>(".pane-frame")].filter((frame) => {
        const box = frame.getBoundingClientRect();
        return !frame.classList.contains("is-hidden") && box.width > 0 && box.height > 0 && getComputedStyle(frame).visibility !== "hidden";
      }).length >= 2);
      await page.locator(".pane-frame .xterm").first().waitFor({ state: "attached" });
      await settle(page);
      env.steps.push(`POST /api/pane/split -> ${status}: two panes side by side`);
    },
  },
  {
    id: "account-sign-in", pane: panes.api, query: "&settings=devices&section=account", stage: { account: ACCOUNT },
    run: async (page, env) => {
      await settingsPage(page, env);
      const group = page.locator('.settings-dialog [data-section="account"]');
      await group.locator(".account-sign-in").waitFor();
      await group.evaluate((node) => node.scrollIntoView({ block: "center" }));
      await settle(page);
    },
  },
  {
    id: "welcome", plain: true, storage: { "ovis:setup-guide": JSON.stringify({ status: "open", state: { step: "welcome" } }) },
    run: async (page) => { await page.locator(".setup-welcome").waitFor(); await settle(page); },
  },
  {
    id: "offline", pane: panes.flaky, query: "&demo_connection=switch",
    run: async (page) => {
      await page.evaluate(() => (window as unknown as { herdrDemoLoseConnection(): void }).herdrDemoLoseConnection());
      await page.locator('.conn-reconnecting, [data-state="reconnecting"], .context-connection').first().waitFor({ state: "attached" });
      await settle(page);
    },
  },
  pcLoad(true),
  pcLoad(false),
  {
    id: "terminal-view", pane: panes.flaky, view: "terminal",
    run: async (page, env) => {
      // Claude's screen ends on a dim (SGR 2) hint line; libghostty draws it as DOM rows over xterm's hidden ones
      await page.waitForFunction(() => [...document.querySelectorAll(".pane-frame.is-current .ghostty-row, .pane-frame.is-current .xterm-rows > div")].some((row) => row.textContent?.includes("for shortcuts")));
      await settle(page);
      env.steps.push("the Claude pane in the Terminal lens, its dim hint line drawn");
    },
  },
  {
    id: "setup-guide", plain: true, storage: { "ovis:setup-guide": JSON.stringify({ status: "open", state: { step: "setup" } }) },
    run: async (page) => {
      await page.locator(".setup-guide .setup-tile").first().waitFor();
      await settle(page);
    },
  },
  {
    id: "agent-setup", pane: panes.api, query: "&new=workspace&demo_devices=empty",
    run: async (page, env) => {
      await env.press(page.locator(".agent-picker-trigger"));
      const options = page.getByRole("option");
      await options.last().waitFor();
      await options.last().scrollIntoViewIfNeeded();
      await env.press(options.last());
      await page.locator(".add-agent .setup-tile").first().waitFor();
      await settle(page);
      env.steps.push("New workspace's agent picker: Add another agent");
    },
  },
  {
    id: "skill-menu", pane: panes.flaky, stage: { turns: { [panes.flaky]: { source: "claude-transcript", turns: LONG } } },
    run: async (page) => {
      await current(page).locator(".chat-turn").first().waitFor();
      await page.getByRole("textbox", { name: label("Message"), exact: true }).fill("/");
      await current(page).locator(".composer-menu [role='option']").first().waitFor();
      await settle(page);
    },
  },
  {
    id: "tab-more", pane: panes.api,
    run: async (page, env) => {
      await current(page).locator(".composer").first().waitFor();
      const workspace = panes.api.split(":")[0]!;
      for (const name of TAB_LABELS) {
        const status = await page.evaluate(async ([id, tab]) => (await fetch("/api/tab/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: id, label: tab }) })).status, [workspace, name] as const);
        if (status !== 200) throw new Error(`POST /api/tab/create ${name} answered ${status}`);
      }
      if (env.phone) {
        // a phone has no tab row: the header's tab list button opens every tab of the workspace
        await env.press(page.getByRole("button", { name: /의 탭$/ }).first());
        await menuRoot(page).getByText(/^mobile/).first().waitFor();
      } else {
        const more = page.locator(".header-tabs .tab-strip-more");
        await more.waitFor();
        await env.press(more);
        await menuRoot(page).waitFor();
      }
      await settle(page);
      env.steps.push(`${TAB_LABELS.length} tabs added; ${env.phone ? "the tab list" : "the More tabs list"} open`);
    },
  },
  {
    id: "update-notice", pane: panes.api, query: "&demo_runtime=both", stage: updateStage,
    run: async (page) => { await page.locator(".update-notice.is-line").first().waitFor(); await settle(page); },
  },
  {
    id: "runtime-move", pane: panes.api, query: "&demo_runtime=both&settings=about&section=runtime", stage: { move: { plan: MOVE_PLAN } },
    run: openRuntimeMove,
  },
  {
    id: "view-only", pane: panes.api, query: "&demo_security=watch",
    run: async (page, env) => {
      // the View only pill is in the status bar, which a phone hides: there the sidebar shows the watching state
      if (env.phone) await openDrawer(page, env);
      else { await page.locator(".status-bar-watch").first().waitFor(); await settle(page); }
    },
  },
  {
    id: "unsent-text", pane: panes.api, storage: UNSENT_STORAGE,
    run: async (page, env) => {
      await current(page).locator(".composer").first().waitFor();
      if (env.phone) await env.press(page.locator(".header-more-button"));
      else {
        const button = page.locator(".header-tabs .tab-strip-item.is-active .tab-strip-menu").first();
        await button.waitFor({ state: "attached" });
        await button.evaluate((node: HTMLElement) => node.click());
      }
      await menuRoot(page).waitFor();
      // a phone's More holds the pane's actions under Pane and tab… (G-143)
      if (env.phone) await openMoreGroup(page, "pane");
      await settle(page);
      await env.press(menuItem(page, label("Recover unsent text")));
      await page.locator(".unsent-modal").waitFor();
      await settle(page);
    },
  },
];

/**
 * IS-100's 130% pass: Settings > Appearance's interface size, stored as whole px, so 18px over the comfortable
 * density's 14px (--ui-scale 1.29) is the nearest to 130%. Each visit waits for the app to draw that scale.
 */
const UI_130_PX = 18;
const at130 = (id: string, baseId: string): Surface => {
  const base = SURFACES.find((surface) => surface.id === baseId);
  if (!base) throw new Error(`no surface ${baseId} to draw at 130%`);
  return {
    ...base, id, settings: { ...base.settings, uiFontSize: UI_130_PX },
    run: async (page, env) => {
      const scale = String(UI_130_PX / 14);
      await page.waitForFunction((want) => getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim() === want, scale);
      env.steps.push(`interface size ${UI_130_PX}px: --ui-scale ${scale}`);
      await base.run?.(page, env);
    },
  };
};
SURFACES.push(at130("ui-130-main", "main-chat"), at130("ui-130-settings-appearance", "settings-appearance"), at130("ui-130-approval", "approval-card"));

interface GateRuntime {
  measure(options: { checks: string[]; surface: string; desktop: boolean }): { hits: Hit[]; effective: string[] };
  focusStart(): void;
  focusNow(): FocusStop<FocusVerdict>;
  focusEnd(): void;
  motion(): Hit[];
  layout(options: { anchors: [string, string][]; composer: string }): Record<string, Rect>;
}
type GateWindow = Window & { __gate: GateRuntime };

/** Installed in every page by an init script: the measurements, in the page's own terms. */
function gateRuntime(): void {
  type RGBA = [number, number, number, number];
  type Box = { l: number; t: number; r: number; b: number };
  const INTERACTIVE = 'a[href], button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
  const OVERLAY = '.modal-scrim, [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [popover], #workspace-drawer.is-open';
  const MODAL = '.modal-scrim, [aria-modal="true"]';
  const BOOT = "#root > [role='status']";
  // a terminal's text: xterm's own rows, or libghostty's rows drawn over them (lib/ghostty/overlay.ts)
  const TERMINAL = ".xterm, .ghostty-layer";
  let canvas: HTMLCanvasElement | null = null;
  const colors = new Map<string, RGBA>();
  let styles = new Map<Element, CSSStyleDeclaration>();
  const style = (el: Element): CSSStyleDeclaration => {
    let found = styles.get(el);
    if (!found) { found = getComputedStyle(el); styles.set(el, found); }
    return found;
  };
  const rgba = (value: string): RGBA => {
    const known = colors.get(value);
    if (known) return known;
    let parsed: RGBA;
    const plain = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(value);
    if (plain) {
      const alpha = plain[4] === undefined ? 1 : Number(plain[4]) / (plain[5] ? 100 : 1);
      parsed = [Number(plain[1]), Number(plain[2]), Number(plain[3]), alpha];
    } else {
      // oklch(), color(srgb …), color-mix() results: the canvas converts any CSS color
      canvas ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 });
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0, 0, 0, 0)";
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      parsed = [r!, g!, b!, a! / 255];
    }
    colors.set(value, parsed);
    return parsed;
  };
  const over = (top: RGBA, under: RGBA): RGBA => [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])).concat(1) as RGBA;
  const luminance = (color: RGBA): number => {
    const [r, g, b] = color.slice(0, 3).map((channel) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: RGBA, b: RGBA): number => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

  const part = (el: Element): string => {
    const classes = [...el.classList].filter((name) => !/^(?:is|has)-/.test(name) && !/\d{3,}/.test(name)).slice(0, 2);
    return el.tagName.toLowerCase() + classes.map((name) => `.${name}`).join("") + (el.id && !/\d/.test(el.id) ? `#${el.id}` : "");
  };
  const path = (el: Element): string => {
    const parts: string[] = [];
    for (let node: Element | null = el; node && node !== document.body && parts.length < 4; node = node.parentElement) parts.unshift(part(node));
    return parts.join(">");
  };
  const ownText = (el: Element): string => [...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join("").replace(/\s+/g, " ").trim();
  const words = (el: Element): string => (ownText(el) || (el as HTMLElement).innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
  const keyOf = (el: Element): string => { const text = words(el).replace(/\d+/g, "#").slice(0, 40); return text ? `${path(el)} "${text}"` : path(el); };

  /** The opacity the element is drawn with, its ancestors' included. */
  const opacity = (el: Element): number => { let value = 1; for (let node: Element | null = el; node; node = node.parentElement) value *= Number(style(node).opacity); return value; };
  /** `box` cut to the viewport and to every ancestor that clips it (`from` included); null when nothing of it is left. */
  const clip = (from: Element | null, box: Box): Box | null => {
    let { l, t, r, b } = box;
    l = Math.max(l, 0); t = Math.max(t, 0); r = Math.min(r, innerWidth); b = Math.min(b, innerHeight);
    for (let node = from; node && node !== document.documentElement; node = node.parentElement) {
      const s = style(node);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") {
        const edge = node.getBoundingClientRect();
        if (s.overflowX !== "visible") { l = Math.max(l, edge.left); r = Math.min(r, edge.right); }
        if (s.overflowY !== "visible") { t = Math.max(t, edge.top); b = Math.min(b, edge.bottom); }
      }
      if (s.position === "fixed") break;
    }
    return r - l > 0.5 && b - t > 0.5 ? { l, t, r, b } : null;
  };
  /** The topmost modal layer: while one is open, what lies under it is not what a user sees. */
  const modalRoot = (): Element | null => {
    const open = [...document.querySelectorAll(MODAL)].filter((node) => node.getClientRects().length > 0 && style(node).visibility !== "hidden");
    const top = open.at(-1);
    return top ? (top.closest(".modal-scrim") ?? top) : null;
  };
  let modal: Element | null = null;
  const drawn = (el: Element): boolean => {
    if (modal && !modal.contains(el)) return false;
    if (el.closest("[inert]")) return false;
    const s = style(el);
    return s.display !== "none" && s.visibility === "visible" && opacity(el) > 0.01 && el.getClientRects().length > 0;
  };
  const elementBox = (el: Element): Box | null => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return clip(el.parentElement, { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom });
  };
  /** The element's own text, one box per line it is drawn on, clipped as drawn: a wrapped span is its lines, not their bounding box. */
  const textBoxes = (el: Element): Box[] => {
    const range = document.createRange();
    const boxes: Box[] = [];
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !(node.textContent ?? "").trim()) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const box = rect.width > 0 && rect.height > 0 ? clip(el, { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom }) : null;
        if (box) boxes.push(box);
      }
    }
    return boxes;
  };
  /** The color behind the element's text: its ancestors' backgrounds composited down to the first opaque one; null over an image or gradient. */
  const backdrop = (el: Element): { color: RGBA; layer: Element | null } | null => {
    const layers: RGBA[] = [];
    let layer: Element | null = null;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const s = style(node);
      if (s.backgroundImage !== "none") return null;
      // a terminal's rows are drawn over its viewport, a sibling of theirs, not an ancestor
      const viewport = node.matches(".pane-terminal") ? node.querySelector(".xterm-viewport") : null;
      const color = viewport && rgba(s.backgroundColor)[3] < 0.999 ? rgba(style(viewport).backgroundColor) : rgba(s.backgroundColor);
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 0.999) { layer = node; break; }
    }
    let base: RGBA = layer ? layers.pop()! : rgba(style(document.documentElement).backgroundColor);
    if (base[3] < 0.999) base = over(base, [255, 255, 255, 1]);
    for (const color of layers.reverse()) base = over(color, base);
    return { color: base, layer };
  };
  const visibleText = (el: Element): string => el instanceof HTMLElement ? el.innerText.replace(/\s+/g, " ").trim() : (el.textContent ?? "").trim();
  const hasName = (el: Element): boolean => {
    if ((el.getAttribute("aria-label") ?? "").trim()) return true;
    if ((el.getAttribute("title") ?? "").trim()) return true;
    const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    if (ids.some((id) => (document.getElementById(id)?.textContent ?? "").trim())) return true;
    if ("labels" in el && [...((el as HTMLInputElement).labels ?? [])].some((node) => node.textContent?.trim())) return true;
    if ([...el.querySelectorAll("img[alt]")].some((img) => img.getAttribute("alt")?.trim())) return true;
    return [...el.querySelectorAll("svg title, svg[aria-label]")].some((node) => (node.textContent || node.getAttribute("aria-label") || "").trim());
  };

  const measure = ({ checks, surface, desktop }: { checks: string[]; surface: string; desktop: boolean }): { hits: Hit[]; effective: string[] } => {
    styles = new Map();
    modal = modalRoot();
    const hits: Hit[] = [];
    const effective: string[] = [];
    const seen = new Map<string, number>();
    const hit = (check: string, el: Element | null, detail: string, key = el ? keyOf(el) : "document"): void => {
      const id = `${check}|${key}`;
      const count = (seen.get(id) ?? 0) + 1;
      seen.set(id, count);
      hits.push({ check, key: count > 1 ? `${key} #${count}` : key, detail });
    };
    const want = new Set(checks);
    const all = [...document.body.querySelectorAll("*")];
    const texts: { el: Element; boxes: Box[] }[] = [];
    for (const el of all) {
      if (!ownText(el) || el.closest("script, style, noscript, " + BOOT) || !drawn(el)) continue;
      const boxes = textBoxes(el);
      if (boxes.length) texts.push({ el, boxes });
    }

    if (want.has("contrast") || want.has("font")) {
      for (const { el, boxes } of texts) {
        // a terminal stays mounted under the chat lens: its rows count only where the terminal is what the point hits
        if (el.closest(TERMINAL)) {
          const [box] = boxes;
          const top = box ? document.elementFromPoint((box.l + box.r) / 2, (box.t + box.b) / 2) : null;
          const pane = el.closest(".pane-terminal");
          if (!top || !pane?.contains(top)) continue;
        }
        const s = style(el);
        const size = Number.parseFloat(s.fontSize);
        if (want.has("font") && size < 11 && !el.closest(TERMINAL)) hit("font", el, `font-size ${s.fontSize}`);
        // text drawn transparent is not shown (xterm's screen reader rows)
        if (!want.has("contrast") || rgba(s.color)[3] === 0 || el.closest(":disabled, [aria-disabled='true']")) continue;
        const behind = backdrop(el);
        if (!behind) continue;
        let fade = 1;
        for (let node: Element | null = el; node && node !== behind.layer; node = node.parentElement) fade *= Number(style(node).opacity);
        const ink = rgba(s.color);
        const shown = over([ink[0], ink[1], ink[2], ink[3] * fade], behind.color);
        const value = ratio(shown, behind.color);
        const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
        const need = large ? 3 : 4.5;
        let faded: Element | null = null;
        for (let node: Element | null = el; node && !faded; node = node.parentElement) if (Number(style(node).opacity) < 1) faded = node;
        const through = faded ? `, opacity ${fade.toFixed(2)} from ${path(faded)}` : "";
        if (value < need) hit("contrast", el, `${value.toFixed(2)}:1 < ${need}:1 (${s.color} on rgb(${behind.color.slice(0, 3).map(Math.round).join(", ")}), ${s.fontSize}/${s.fontWeight}${through})`);
      }
    }

    if (want.has("font")) {
      const chromeWeights = new Set(texts.filter(({ el }) => !el.closest(`${TERMINAL}, .markdown, .chat-turn, pre, code, svg`)).map(({ el }) => style(el).fontWeight));
      if (chromeWeights.size > 3) hit("font", null, `chrome has ${chromeWeights.size} weights: ${[...chromeWeights].join(", ")}`, "chrome-weights");
    }

    const controls = all.filter((el) => el.matches(INTERACTIVE) && drawn(el) && elementBox(el) !== null);
    if (want.has("target")) {
      const min = desktop ? 24 : 44;
      const verdict = (window as unknown as { __gateTargetVerdict: typeof targetVerdict }).__gateTargetVerdict;
      const owner = (el: Element) => (x: number, y: number): boolean => { const top = document.elementFromPoint(x, y); return top !== null && el.contains(top); };
      for (const el of controls) {
        // a link or an inline file button in a sentence (WCAG 2.5.8's inline exception)
        if (el.matches("a[href]") || style(el).display === "inline") {
          const prose = el.closest("p, li");
          if (prose && visibleText(prose).length > visibleText(el).length) continue;
        }
        const rect = el.getBoundingClientRect();
        const { method, hits: points } = verdict({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, min, owner(el));
        const size = `${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`;
        if (method === "effective") effective.push(`${keyOf(el)} :: box ${size}, effective ${min}x${min} (5/5 points)`);
        if (method === null) hit("target", el, `${size} < ${min}x${min} (effective ${min}x${min}: ${points}/5 points)`);
      }
    }
    if (want.has("name")) {
      for (const el of controls) {
        const textless = el.matches("input, select, textarea") ? !(el.matches('input[type="submit"], input[type="button"], input[type="reset"]') && (el as HTMLInputElement).value.trim()) : !visibleText(el);
        if (textless && !hasName(el)) hit("name", el, "no visible text, aria-label, aria-labelledby text or title");
      }
    }
    if (want.has("trunc")) {
      for (const el of all) {
        if (el.matches("input, textarea") || !drawn(el)) continue;
        const s = style(el);
        if (s.textOverflow !== "ellipsis" || el.scrollWidth <= el.clientWidth + 1 || !elementBox(el)) continue;
        const full = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!full) continue;
        const named = (node: Element | null): boolean => !!node && [node.getAttribute("title"), node.getAttribute("aria-label")].some((value) => (value ?? "").replace(/\s+/g, " ").includes(full));
        const described = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).some((id) => (document.getElementById(id)?.textContent ?? "").replace(/\s+/g, " ").includes(full));
        if (!named(el) && !named(el.closest("[title], [aria-label]")) && !described) hit("trunc", el, `clipped ${el.scrollWidth - el.clientWidth}px with no full text in title, aria-label or aria-describedby`);
      }
    }
    if (want.has("overflow")) {
      const page = document.scrollingElement ?? document.documentElement;
      if (page.scrollWidth > innerWidth + 1) hit("overflow", null, `the page scrolls sideways: scrollWidth ${page.scrollWidth} > ${innerWidth}`);
      const boxes = texts.filter(({ el }) => !el.closest(`${TERMINAL}, .katex`));
      // an overlay (a dialog, a menu, the drawer) or a fixed or sticky bar covers what scrolls under it on purpose
      const layers = new Map<Element, Element | null>();
      const layer = (el: Element): Element | null => {
        if (layers.has(el)) return layers.get(el)!;
        let found: Element | null = el.closest(OVERLAY);
        for (let node: Element | null = el; node && node !== found; node = node.parentElement) {
          if (/^(?:fixed|sticky)$/.test(style(node).position)) { found = node; break; }
        }
        layers.set(el, found);
        return found;
      };
      const overlap = (a: Box, b: Box): [number, number] => [Math.min(a.r, b.r) - Math.max(a.l, b.l), Math.min(a.b, b.b) - Math.max(a.t, b.t)];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i]!, b = boxes[j]!;
          if (a.el.contains(b.el) || b.el.contains(a.el) || layer(a.el) !== layer(b.el)) continue;
          const worst = a.boxes.flatMap((x) => b.boxes.map((y) => overlap(x, y))).find(([dx, dy]) => dx > 2 && dy > 2);
          if (!worst) continue;
          const [first, second] = [keyOf(a.el), keyOf(b.el)].sort();
          hit("overflow", a.el, `text boxes overlap ${worst[0].toFixed(1)}x${worst[1].toFixed(1)}px`, `overlap ${first} | ${second}`);
        }
      }
    }
    if (want.has("pcload") && surface.startsWith("pc-load-")) {
      for (const el of document.querySelectorAll(".sidebar-shell *, #workspace-drawer *")) {
        if (/CPU|메모리|디스크/.test(ownText(el)) && el.getClientRects().length > 0) hit("pcload", el, "PC load shown in the sidebar or the drawer");
      }
      if (surface === "pc-load-on" && desktop) {
        const bar = document.querySelector(".status-bar")?.textContent ?? "";
        if (!/CPU \d+%/.test(bar)) hit("pcload", null, `status bar shows no "CPU <n>%": ${bar.replace(/\s+/g, " ").trim().slice(0, 80) || "(no status bar)"}`, "status-bar");
      }
    }
    return { hits, effective };
  };

  let sentinel: HTMLElement | null = null;
  const focusIds = new WeakMap<Element, number>();
  let focusCount = 0;
  const focusStart = (): void => {
    styles = new Map();
    const root = modalRoot();
    const first = root?.querySelector<HTMLElement>(INTERACTIVE);
    if (root && first) { first.focus(); return; }
    // the sequential focus starting point before everything: the first Tab lands on the first stop
    sentinel = Object.assign(document.createElement("div"), { tabIndex: -1 });
    sentinel.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.prepend(sentinel);
    sentinel.focus();
  };
  /** The color in a computed box-shadow layer (it may nest parentheses: color-mix(in srgb, rgb(…) 50%, …)). */
  const shadowColor = (layer: string): { color: string; rest: string } | null => {
    const start = layer.search(/[a-z-]+\(/i);
    if (start < 0) return null;
    let depth = 0;
    for (let at = layer.indexOf("(", start); at < layer.length; at += 1) {
      if (layer[at] === "(") depth += 1;
      else if (layer[at] === ")" && (depth -= 1) === 0) return { color: layer.slice(start, at + 1), rest: layer.slice(0, start) + layer.slice(at + 1) };
    }
    return null;
  };
  /** The computed box-shadow's layers, split on the commas between them, not those inside a color. */
  const shadowLayers = (value: string): string[] => {
    const layers: string[] = [];
    let depth = 0, from = 0;
    for (let at = 0; at < value.length; at += 1) {
      if (value[at] === "(") depth += 1;
      else if (value[at] === ")") depth -= 1;
      else if (value[at] === "," && depth === 0) { layers.push(value.slice(from, at)); from = at + 1; }
    }
    layers.push(value.slice(from));
    return layers.map((layer) => layer.trim()).filter(Boolean);
  };
  type RingSnap = { read: RingRead; outlined: boolean; outlineStyle: string; outlineWidth: string; outlineColor: string; outlineOffset: string; boxShadow: string; borderColor: string; borderWidth: string; borderStyle: string };
  const ringSnap = (node: Element): RingSnap => {
    const s = getComputedStyle(node);
    const border = [s.borderTopStyle, s.borderTopWidth, s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor].join(" ");
    return {
      read: { outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} ${s.outlineOffset}`, boxShadow: s.boxShadow, border },
      outlined: s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) >= 1 && rgba(s.outlineColor)[3] > 0,
      outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor, outlineOffset: s.outlineOffset,
      boxShadow: s.boxShadow, borderColor: s.borderTopColor, borderWidth: s.borderTopWidth, borderStyle: s.borderTopStyle,
    };
  };
  /** The ancestors that may draw a focused control's ring: up to 3 ancestors short of the dialog or app root; a terminal's hidden input also its terminal and pane frame. */
  const ringWrappers = (el: Element): Element[] => {
    const found: Element[] = [];
    for (let node = el.parentElement; node && found.length < 3; node = node.parentElement) {
      if (node === document.body || node.id === "root" || node.matches('.app, .modal-scrim, [role="dialog"], [aria-modal="true"]')) break;
      found.push(node);
    }
    if (el.matches(".xterm-helper-textarea")) for (const frame of [el.closest(".xterm"), el.closest(".pane-frame")]) if (frame && !found.includes(frame)) found.push(frame);
    return found;
  };
  /**
   * The ring `parts` of `node` against the background next to it (WCAG 1.4.11, 3:1): a ring drawn outside is read
   * over the parent's background, an inset one (or an outline pulled inside) over the node's own. "none" when the
   * parts draw nothing, "ok" at 3:1 or more, else the failing ratio.
   */
  const ringVerdict = (node: Element, snap: RingSnap, parts: readonly (keyof RingRead)[]): "ok" | "none" | string => {
    const marks: { color: RGBA; inside: boolean; what: string }[] = [];
    if (parts.includes("outline") && snap.outlined) marks.push({ color: rgba(snap.outlineColor), inside: Number.parseFloat(snap.outlineOffset) + Number.parseFloat(snap.outlineWidth) <= 0, what: `outline ${snap.outlineColor}` });
    if (parts.includes("boxShadow") && snap.boxShadow !== "none") {
      for (const layer of shadowLayers(snap.boxShadow)) {
        const found = shadowColor(layer);
        if (!found) continue;
        const lengths = found.rest.replace(/\binset\b/, "").trim().split(/\s+/).map(Number.parseFloat).filter(Number.isFinite);
        const [, , blur = 0, spread = 0] = lengths;
        const color = rgba(found.color);
        if (color[3] > 0 && (blur > 0 || spread > 0)) marks.push({ color, inside: /\binset\b/.test(layer), what: `box-shadow ${found.color}` });
      }
    }
    if (parts.includes("border") && snap.borderStyle !== "none" && Number.parseFloat(snap.borderWidth) >= 1 && rgba(snap.borderColor)[3] > 0) marks.push({ color: rgba(snap.borderColor), inside: false, what: `border ${snap.borderColor}` });
    if (!marks.length) return "none";
    const fade = opacity(node);
    let best: { value: number; what: string; behind: RGBA } | null = null;
    for (const mark of marks) {
      const behind = backdrop(mark.inside ? node : node.parentElement ?? node);
      if (!behind) continue;
      const value = ratio(over([mark.color[0], mark.color[1], mark.color[2], mark.color[3] * fade], behind.color), behind.color);
      if (!best || value > best.value) best = { value, what: mark.what, behind: behind.color };
    }
    return best && best.value < 3 ? `${best.value.toFixed(2)}:1 < 3:1 (${best.what} on rgb(${best.behind.slice(0, 3).map(Math.round).join(", ")}))` : "ok";
  };
  const focusNow = (): FocusStop<FocusVerdict> => {
    styles = new Map();
    const el = document.activeElement;
    if (!el || el === document.body || el === sentinel) return { id: null };
    let id = focusIds.get(el);
    if (id === undefined) { id = focusCount += 1; focusIds.set(el, id); }
    const own = ringSnap(el);
    // a box-shadow counts only where a layer draws (a transparent or zero-size one is no ring): undrawn, the wrappers are read
    const shadowDrawn = own.boxShadow !== "none" && ringVerdict(el, own, ["boxShadow"]) !== "none";
    const selfDrawn = (own.outlined || shadowDrawn) && opacity(el) > 0.01;
    // the control's own border counts as its ring too, unless the control is not drawn (a terminal's hidden input)
    const wrappers = selfDrawn ? [] : [...(opacity(el) > 0.01 ? [el] : []), ...ringWrappers(el)].filter((node): node is HTMLElement => node instanceof HTMLElement);
    if (wrappers.length && el instanceof HTMLElement) {
      // read focused and blurred with transitions off (a border easing to its accent reads unchanged mid-way), then
      // put focus back where Tab left it
      const saved = wrappers.map((node) => [node.style.getPropertyValue("transition"), node.style.getPropertyPriority("transition")] as const);
      for (const node of wrappers) node.style.setProperty("transition", "none", "important");
      const focused = wrappers.map(ringSnap);
      el.blur();
      const blurred = wrappers.map(ringSnap);
      el.focus({ preventScroll: true });
      wrappers.forEach((node, index) => node.style.setProperty("transition", saved[index]![0], saved[index]![1]));
      styles = new Map();
      const owner = (window as unknown as { __gateRingOwner: typeof ringOwner }).__gateRingOwner(selfDrawn, focused.map((read, index) => ({
        focused: read.read, blurred: blurred[index]!.read,
        drawn: { outline: read.outlined, boxShadow: read.boxShadow !== "none", border: read.borderStyle !== "none" && Number.parseFloat(read.borderWidth) >= 1 && rgba(read.borderColor)[3] > 0 },
      })));
      if (owner.on === "ancestor") {
        const ring = wrappers[owner.index]!;
        const ringOn = ring === el ? `self ${owner.changed.join(", ")}` : `ancestor ${path(ring)}`;
        const verdict = ringVerdict(ring, focused[owner.index]!, owner.changed);
        if (verdict === "none") return { id, verdict: { check: "focus", key: keyOf(el), detail: `focused with no outline or box-shadow; ${ringOn} changes ${owner.changed.join(", ")} but draws nothing` } };
        if (verdict !== "ok") return { id, verdict: { check: "focus-contrast", key: keyOf(el), detail: `${verdict} (ringOn: ${ringOn})` } };
        return { id, verdict: { ringOn: `${keyOf(el)} :: ringOn: ${ringOn}` } };
      }
    }
    if (!own.outlined && !shadowDrawn) return { id, verdict: { check: "focus", key: keyOf(el), detail: `focused with no outline or box-shadow (outline ${own.outlineStyle} ${own.outlineWidth}, box-shadow ${own.boxShadow})` } };
    const verdict = ringVerdict(el, own, ["outline", "boxShadow"]);
    if (verdict !== "ok" && verdict !== "none") return { id, verdict: { check: "focus-contrast", key: keyOf(el), detail: verdict } };
    return { id, verdict: { ringOn: null } };
  };
  const focusEnd = (): void => { sentinel?.remove(); sentinel = null; };

  const motion = (): Hit[] => {
    styles = new Map();
    modal = null;
    const hits: Hit[] = [];
    const seen = new Set<string>();
    const add = (el: Element, detail: string): void => {
      const key = keyOf(el);
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ check: "motion", key, detail });
    };
    for (const animation of document.getAnimations()) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (!(animation instanceof CSSAnimation) || animation.playState !== "running" || !target || target.closest(BOOT) || !drawn(target)) continue;
      add(target, `CSS animation "${animation.animationName}" runs under reduced motion`);
    }
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest(BOOT) || !drawn(el) || !elementBox(el)) continue;
      const s = style(el);
      const properties = s.transitionProperty.split(",").map((value) => value.trim());
      const durations = s.transitionDuration.split(",").map((value) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 0.001 : 1));
      const moving = properties.flatMap((property, index) => {
        const seconds = durations[index % durations.length] ?? 0;
        return /^(?:all|transform|opacity|translate|scale|rotate)$/.test(property) && seconds > 0.01 ? [`${property} ${seconds}s`] : [];
      });
      if (moving.length) add(el, `transition ${moving.join(", ")} under reduced motion`);
    }
    return hits;
  };

  const layout = ({ anchors, composer }: { anchors: [string, string][]; composer: string }): Record<string, Rect> => {
    styles = new Map();
    const shown = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style(el).visibility === "visible";
    };
    const rect = (el: Element): Rect => {
      const box = el.getBoundingClientRect();
      const round = (n: number): number => Math.round(n * 10) / 10;
      return { x: round(box.left), y: round(box.top), w: round(box.width), h: round(box.height) };
    };
    const found: Record<string, Rect> = {};
    for (const [name, selector] of anchors) {
      [...document.querySelectorAll(selector)].filter(shown).forEach((el, index) => { found[index ? `${name} #${index + 1}` : name] = rect(el); });
    }
    // every control of the composer root (the context ring and the suggestion menu sit outside .composer-controls)
    [...document.querySelectorAll(`${composer} :is(${INTERACTIVE})`)].filter(shown).forEach((el, index) => {
      const kind = [...el.classList].find((name) => !/^(?:is|has)-/.test(name) && !/\d{3,}/.test(name) && !["icon-button", "composer-action", "btn", "btn-ghost"].includes(name))
        ?? `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""}`;
      found[`composer-${index} ${kind}`] = rect(el);
    });
    return found;
  };

  (window as unknown as { __gate: GateRuntime }).__gate = { measure, focusStart, focusNow, focusEnd, motion, layout };
}

const SELF_TEST_CSS = ".pane-frame.is-current .chat-turn, .pane-frame.is-current .chat-turn * { color: #999 !important; background: #aaa !important; }";
const SELF_TEST_LAYOUT_CSS = ".header-tabs .tab-strip-more, .pane-frame.is-current .composer .composer-status button { translate: 10px 0 !important; }";

async function visit(browser: Browser, origin: string, surface: Surface, viewport: Viewport, theme: Theme): Promise<{ visit: Visit; failures: Failure[]; anchors: Record<string, Rect> | null }> {
  const phone = viewport === "390";
  const shot = join(OUT, "shots", `${surface.id}--${viewport}--${theme}.png`);
  const result: Visit = { surface: surface.id, viewport, theme, shot, steps: [], pageErrors: [] };
  const failures: Failure[] = [];
  let anchors: Record<string, Rect> | null = null;
  const add = (hit: Hit): void => { failures.push({ ...hit, surface: surface.id, viewport, theme }); };
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 1, colorScheme: theme, locale: "ko-KR", serviceWorkers: "block",
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  try {
    await context.addInitScript(([settings, stage, storage]) => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings);
      for (const [key, value] of Object.entries(storage)) if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      (window as unknown as { __gateStage: unknown }).__gateStage = stage;
    }, [JSON.stringify({ ...surface.settings, language: "ko", theme }), (typeof surface.stage === "function" ? surface.stage() : surface.stage) ?? {}, surface.storage ?? {}] as const);
    await context.addInitScript({ content: `window.__gateTargetVerdict = ${targetVerdict.toString()}; window.__gateRingOwner = ${ringOwner.toString()};` });
    await context.addInitScript(gateRuntime);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => result.pageErrors.push(error.message.split("\n")[0]!));
    const env: Env = { phone, steps: result.steps, press: (locator) => phone ? locator.tap() : locator.click() };
    try {
      const url = surface.plain ? `${origin}${PREFIX}` : `${origin}${PREFIX}?pane=${encodeURIComponent(surface.pane ?? panes.api)}&view=${surface.view ?? "chat"}${surface.query ?? ""}`;
      await page.goto(url);
      await page.locator(surface.plain ? ".setup-guide, .setup-welcome, .conn-live" : ".conn-live").first().waitFor({ state: "attached", timeout: 20_000 });
      await appFaces(page, "가나다");
      await surface.run?.(page, env);
      if (SELF_TEST) await page.addStyleTag({ content: SELF_TEST_CSS });
      if (SELF_TEST_LAYOUT) await page.addStyleTag({ content: SELF_TEST_LAYOUT_CSS });
      await settle(page);
    } catch (error) {
      result.stageError = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      add({ check: "stage", key: "stage", detail: result.stageError });
    }
    await page.screenshot({ path: shot, animations: "disabled" });
    if (result.stageError) return { visit: result, failures, anchors };
    // what the screenshot set going (a fade it finished, a frame it asked for) has landed before anything is measured
    await settle(page);

    const statics = [...checks].filter((check) => check !== "focus" && check !== "motion" && check !== "layout");
    const measured = await page.evaluate((options) => (window as unknown as GateWindow).__gate.measure(options), { checks: statics, surface: surface.id, desktop: !phone });
    for (const hit of measured.hits) add(hit);
    if (checks.has("target")) result.effectiveTargets = measured.effective;
    // before focus moves anything: the controls where the visit left them
    if (checks.has("layout")) anchors = await page.evaluate((options) => (window as unknown as GateWindow).__gate.layout(options), { anchors: LAYOUT_ANCHORS, composer: COMPOSER });

    if (checks.has("focus") && !phone) {
      await page.evaluate(() => (window as unknown as GateWindow).__gate.focusStart());
      const focusNow = (): Promise<FocusStop<FocusVerdict>> => page.evaluate(() => (window as unknown as GateWindow).__gate.focusNow());
      const walk = await walkFocus({
        current: focusNow,
        tab: async () => {
          await page.keyboard.press("Tab");
          // a control that fades in on focus (the tab's menu button) is judged once its fade is done
          await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || !Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)), undefined, { timeout: 2_000 }).catch(() => undefined);
          return focusNow();
        },
      }, FOCUS_CEILING);
      await page.evaluate(() => (window as unknown as GateWindow).__gate.focusEnd());
      const reported = new Set<string>();
      const rings: string[] = [];
      for (const now of walk.verdicts.values()) {
        if ("ringOn" in now) { if (now.ringOn) rings.push(now.ringOn); continue; }
        if (reported.has(`${now.check}|${now.key}`)) continue;
        reported.add(`${now.check}|${now.key}`);
        add(now);
      }
      result.focusRings = rings;
      if (!walk.complete) add({ check: "focus", key: "focus-walk-incomplete", detail: `Tab did not come back to a visited control in ${FOCUS_CEILING} presses (${walk.verdicts.size} controls seen)` });
    }
    if (checks.has("motion")) {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      for (const hit of await page.evaluate(() => (window as unknown as GateWindow).__gate.motion())) add(hit);
    }
    return { visit: result, failures, anchors };
  } finally {
    await context.close();
  }
}

const identity = (failure: Failure): string => `${failure.check}|${failure.surface}|${failure.viewport}|${failure.theme}|${failure.key}`;
const line = (failure: Failure): string => `${failure.check} ${failure.surface} ${failure.viewport} ${failure.theme} :: ${failure.key} :: ${failure.detail}`;

const picked = list("--surfaces");
for (const id of picked ?? []) if (!SURFACES.some((surface) => surface.id === id)) throw new Error(`--surfaces ${id}: one of ${SURFACES.map((surface) => surface.id).join(", ")}`);
const surfaces = picked ? SURFACES.filter((surface) => picked.includes(surface.id)) : SURFACES;
const allow: AllowEntry[] = allowPath ? JSON.parse(readFileSync(allowPath, "utf8")) as AllowEntry[] : [];
for (const entry of allow) if (!entry.check || !entry.key || !entry.reason?.trim()) throw new Error(`--allow: every entry needs check, key and a reason (${JSON.stringify(entry)})`);
const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, "utf8")) as { failures: Failure[] } : null;
const layoutBaseline = layoutBaselinePath ? JSON.parse(readFileSync(layoutBaselinePath, "utf8")) as Layout : null;

const app = mkdtempSync(join(tmpdir(), "ovis-design-gate-"));
let server: ReturnType<typeof Bun.serve> | null = null;
let browser: Browser | null = null;
const cleanup = async (): Promise<void> => {
  await browser?.close().catch(() => undefined);
  browser = null;
  await server?.stop(true);
  server = null;
  rmSync(app, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });

let exitCode = 1;
try {
  mkdirSync(join(OUT, "shots"), { recursive: true });
  const started = Date.now();
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `${HOLD_DEMO_TURN}<script src="./demo-transport.js"></script>${RELEASE_TIMERS}\n    ${STAGE_HOOKS}\n    <script type="module"`));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    // the icons the app links from the site's root (the welcome screen's mark)
    const rootAsset = /^\/(?:icons\/[\w.-]+|favicon\.(?:ico|png)|apple-touch-icon\.png|manifest\.webmanifest)$/.test(path);
    if (!path.startsWith(PREFIX) && !rootAsset) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(rootAsset ? path.slice(1) : path.slice(PREFIX.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  console.log(`built and serving the demo in ${((Date.now() - started) / 1000).toFixed(1)}s; ${surfaces.length} surfaces, checks: ${[...checks].join(", ")}${SELF_TEST ? " (self-test)" : ""}`);

  const jobs = surfaces.flatMap((surface) => (["1440", "390"] as const)
    .filter((viewport) => surface.only === undefined || surface.only === (viewport === "1440" ? "desktop" : "phone"))
    .flatMap((viewport) => (["light", "dark"] as const).map((theme) => ({ surface, viewport, theme }))));
  const visits: Visit[] = new Array(jobs.length);
  const failures: Failure[][] = new Array(jobs.length);
  const layout: Layout = {};
  let next = 0;
  const own = browser;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, jobs.length)) }, async () => {
    for (let at = next++; at < jobs.length; at = next++) {
      const job = jobs[at]!;
      const done = await visit(own, origin, job.surface, job.viewport, job.theme);
      visits[at] = done.visit;
      failures[at] = done.failures;
      if (done.anchors) layout[`${job.surface.id}|${job.viewport}|${job.theme}`] = done.anchors;
      console.log(`${done.visit.stageError ? "STAGE-FAIL" : "visited   "} ${job.surface.id} ${job.viewport} ${job.theme}: ${done.failures.length} failures${done.visit.stageError ? ` (${done.visit.stageError})` : ""}`);
    }
  }));
  const found = failures.flat().sort((a, b) => identity(a).localeCompare(identity(b)));
  const counts: Record<string, number> = Object.fromEntries([...CHECKS, "focus-contrast", "stage"].map((check) => [check, found.filter((failure) => failure.check === check).length]));
  const sortedLayout: Layout = Object.fromEntries(Object.keys(layout).sort().map((key) => [key, layout[key]!]));
  const requested = new Set(jobs.map((job) => `${job.surface.id}|${job.viewport}|${job.theme}`));
  const moved = layoutBaseline ? moves(layoutBaseline, sortedLayout, { requested, narrowed: picked !== undefined, tolerance: LAYOUT_TOLERANCE }) : [];
  counts.layout = moved.length;
  const commit = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: repo }).stdout.toString().trim();
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), commit, selfTest: SELF_TEST, selfTestLayout: SELF_TEST_LAYOUT, checks: [...checks], surfaces: visits, failures: found, counts, moved }, null, 2)}\n`);
  if (checks.has("layout")) {
    const text = `${JSON.stringify(sortedLayout, null, 2)}\n`;
    writeFileSync(join(OUT, "layout.json"), text);
    if (layoutOutPath) { mkdirSync(dirname(resolve(layoutOutPath)), { recursive: true }); writeFileSync(resolve(layoutOutPath), text); }
  }

  console.log(`\n${visits.length} visits in ${((Date.now() - started) / 1000).toFixed(0)}s; report: ${join(OUT, "report.json")}`);
  console.log(`counts: ${Object.entries(counts).map(([check, count]) => `${check}=${count}`).join(" ")}`);
  if (baseline) {
    // only what this run looked at: a narrower run does not resolve what it never visited
    const looked = new Set(visits.map((entry) => `${entry.surface}|${entry.viewport}|${entry.theme}`));
    // focus-contrast is measured by the focus check
    const inScope = (failure: Failure): boolean => looked.has(`${failure.surface}|${failure.viewport}|${failure.theme}`) && (failure.check === "stage" || checks.has((failure.check === "focus-contrast" ? "focus" : failure.check) as Check));
    const before = new Set(baseline.failures.filter(inScope).map(identity));
    const now = new Set(found.map(identity));
    const added = found.filter((failure) => !before.has(identity(failure)));
    const resolved = baseline.failures.filter((failure) => inScope(failure) && !now.has(identity(failure)));
    console.log(`\nNEW: ${added.length}`);
    for (const failure of added) console.log(`  ${line(failure)}`);
    console.log(`RESOLVED: ${resolved.length}`);
    for (const failure of resolved) console.log(`  ${line(failure)}`);
    exitCode = added.length === 0 ? 0 : 1;
  } else {
    const allowed = new Set(allow.map((entry) => `${entry.check}|${entry.key}`));
    const open = found.filter((failure) => !allowed.has(`${failure.check}|${failure.key}`));
    console.log(`\nFAILURES: ${open.length}${allow.length ? ` (${found.length - open.length} allowed)` : ""}`);
    for (const failure of open) console.log(`  ${line(failure)}`);
    exitCode = open.length === 0 ? 0 : 1;
  }
  if (layoutBaseline) {
    console.log("");
    for (const entry of moved) console.log(entry);
    console.log(`MOVED: ${moved.length}`);
    if (moved.length) exitCode = 1;
  }
} finally {
  await cleanup();
}
process.exit(exitCode);
